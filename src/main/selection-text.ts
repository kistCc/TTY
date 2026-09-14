import { execFile } from 'child_process';
import { clipboard, nativeImage } from 'electron';
import * as fs from 'fs';
import { nativePaths } from './native';

// 取当前选中的文本（划词翻译用）。
//
// 策略顺序照搬 Easydict / SelectedTextKit 的实测结论：
//
//   1. 辅助功能接口读 AXSelectedText —— 不碰剪贴板，最干净。
//      但读它的是 axtext-macos 这个子进程，而 macOS 的辅助功能权限是按可执行文件授的：
//      app 包里这个没签名的小程序系统不认，AX 接口对它直接关闭（err -25204），
//      哪怕 TTY 主进程本身已经在辅助功能列表里打过勾。
//
//   2. 点那个应用「编辑」菜单里的拷贝项。比模拟按键靠谱：菜单项走 UI 动作，
//      不受应用忽略合成键盘事件的影响；而且**它是灰的就等于确实没选中**，
//      这个信号比"剪贴板没变化"确定得多，可以直接短路，不必再试别的。
//
//   3. 找不到拷贝菜单项时，才让 System Events 代按 ⌘C（带静音，见下）。
//
// 2 和 3 都要借剪贴板，用完原样还回去。

const AX_TIMEOUT_MS = 700;
const OSASCRIPT_TIMEOUT_MS = 2500;
/// 拷贝之后等剪贴板的上限。SelectedTextKit 实测大多数应用 0.1s 内就有结果，
/// 它取 0.2s（Safari 0.4s）；这里放宽到 0.4s，多出来的是子进程启动的开销。
const POLL_MAX_MS = 400;

export interface SelectionResult {
  text: string;
  /// 两条路都因为没权限而失败——这时候该提示用户去授权，而不是说"没有选中文本"
  denied: boolean;
}

/// 剪贴板备份。Electron 读不到完整的 NSPasteboardItem，退而求其次把常见类型都存下来，
/// 至少不会出现"划一次词，剪贴板里的图片没了"。
interface PasteboardBackup {
  text: string;
  html: string;
  rtf: string;
  image: Electron.NativeImage;
  empty: boolean;
}

export async function getSelection(): Promise<SelectionResult> {
  const ax = await tryAccessibility();
  if (ax.text) return { text: ax.text, denied: false };

  // AX 明确报了没权限才动剪贴板；它只是没读到选区的话，说明用户确实没选中
  if (!ax.denied) return { text: '', denied: false };

  return tryCopy();
}

function tryAccessibility(): Promise<{ text: string; denied: boolean }> {
  return new Promise((resolve) => {
    const binaryPath = getBinaryPath();
    if (!fs.existsSync(binaryPath)) { resolve({ text: '', denied: true }); return; }

    execFile(
      binaryPath, ['--selection'],
      { maxBuffer: 1024 * 1024, timeout: AX_TIMEOUT_MS },
      (error, stdout, stderr) => {
        const text = (stdout || '').trim();
        if (text) { resolve({ text, denied: false }); return; }
        // 子进程自己报的信任状态最准，主进程的 isTrustedAccessibilityClient 管不到它
        const denied = /trusted=0/.test(stderr || '') || !!(error && (error as any).killed);
        resolve({ text: '', denied });
      }
    );
  });
}

async function tryCopy(): Promise<SelectionResult> {
  const backup = backupPasteboard();
  const beforeCount = await pasteboardCount();

  // 先走菜单项
  const menu = await runOsascript(SCRIPT_MENU_COPY);
  if (menu.output === 'disabled') {
    // 拷贝菜单项是灰的——这个应用明确告诉我们当前没有可拷贝的选区
    console.log('[selection] 拷贝菜单项是灰的，确实没有选中文本');
    return { text: '', denied: false };
  }
  if (menu.output === 'ok') {
    const got = await collect(beforeCount, backup);
    if (got !== null) return { text: got, denied: false };
  }
  if (!menu.ok && menu.permissionIssue) {
    return { text: '', denied: true };
  }

  // 菜单项找不到（或点了没反应）才退到模拟按键
  console.log('[selection] 菜单栏拷贝没拿到，改用模拟 ⌘C');
  const key = await runOsascript(SCRIPT_KEYSTROKE_COPY);
  if (!key.ok) {
    return { text: '', denied: key.permissionIssue };
  }
  const got = await collect(beforeCount, backup);
  if (got !== null) return { text: got, denied: false };

  console.log('[selection] 两种拷贝都没让剪贴板出现内容，判定为没有选中文本');
  return { text: '', denied: false };
}

/// 等剪贴板出现内容，拿走，然后把备份放回去。
/// 返回 null 表示没等到（调用方继续试下一招）。
async function collect(beforeCount: number, backup: PasteboardBackup): Promise<string | null> {
  const result = await waitPasteboard(beforeCount);

  if (!result.gotContent) {
    // 没拿到内容，但只要剪贴板被动过就得还原：对空选区执行拷贝时，
    // 有些应用会直接把剪贴板清空，不还原用户原来的内容就没了。
    if (result.changed) restorePasteboard(backup);
    return null;
  }

  const got = (clipboard.readText() || '').trim();
  restorePasteboard(backup);
  return got || null;
}

function backupPasteboard(): PasteboardBackup {
  let image: Electron.NativeImage;
  try { image = clipboard.readImage(); } catch { image = nativeImage.createEmpty(); }
  const text = safeRead(() => clipboard.readText());
  const html = safeRead(() => clipboard.readHTML());
  const rtf = safeRead(() => clipboard.readRTF());
  return { text, html, rtf, image, empty: !text && !html && !rtf && image.isEmpty() };
}

function restorePasteboard(backup: PasteboardBackup) {
  // 原来就是空的就别写了，写一次反而多一次变更
  if (backup.empty) return;
  setTimeout(() => {
    try {
      const data: any = {};
      if (backup.text) data.text = backup.text;
      if (backup.html) data.html = backup.html;
      if (backup.rtf) data.rtf = backup.rtf;
      if (!backup.image.isEmpty()) data.image = backup.image;
      if (Object.keys(data).length) clipboard.write(data);
    } catch (e) {
      console.log('[selection] 恢复剪贴板失败:', e);
    }
  }, 40);
}

function safeRead(fn: () => string): string {
  try { return fn() || ''; } catch { return ''; }
}

/// 剪贴板的变更计数。每写入一次就加一，和内容是否相同无关——
/// 比较内容会在"选中的词恰好和剪贴板里已有内容相同"时误判成没选中。
function pasteboardCount(): Promise<number> {
  return new Promise((resolve) => {
    const binaryPath = getBinaryPath();
    if (!fs.existsSync(binaryPath)) { resolve(-1); return; }
    execFile(binaryPath, ['--pbcount'], { timeout: 500 }, (_e, stdout) => {
      const n = parseInt((stdout || '').trim(), 10);
      resolve(Number.isFinite(n) ? n : -1);
    });
  });
}

/// 在原生那边轮询等剪贴板出现有效文本，一次子进程调用搞定。
function waitPasteboard(beforeCount: number): Promise<{ gotContent: boolean; changed: boolean }> {
  return new Promise((resolve) => {
    const binaryPath = getBinaryPath();
    if (binaryPath === '' || beforeCount < 0 || !fs.existsSync(binaryPath)) {
      resolve({ gotContent: false, changed: false });
      return;
    }
    execFile(
      binaryPath, ['--pbwait', String(beforeCount), String(POLL_MAX_MS)],
      { timeout: POLL_MAX_MS + 600 },
      (error, stdout) => {
        const now = parseInt((stdout || '').trim(), 10);
        const changed = Number.isFinite(now) && now !== beforeCount;
        resolve({ gotContent: !error, changed });
      }
    );
  });
}

const SCRIPT_KEYSTROKE_COPY = `
set oldVolume to alert volume of (get volume settings)
set volume alert volume 0
tell application "System Events" to keystroke "c" using command down
delay 0.05
set volume alert volume oldVolume
return "ok"
`;

/// 按快捷键属性找拷贝菜单项（⌘ + C，没有别的修饰键），不认菜单名——
/// 那东西跟着系统语言变，写死「编辑 / Edit」迟早出错。
const SCRIPT_MENU_COPY = `
tell application "System Events"
  set p to first application process whose frontmost is true
  set mb to menu bar 1 of p
  repeat with i from 2 to (count of menu bar items of mb)
    try
      set m to menu 1 of menu bar item i of mb
      repeat with mi in menu items of m
        try
          if (value of attribute "AXMenuItemCmdChar" of mi) is "C" and (value of attribute "AXMenuItemCmdModifiers" of mi) is 0 then
            if enabled of mi then
              click mi
              return "ok"
            else
              return "disabled"
            end if
          end if
        end try
      end repeat
    end try
  end repeat
end tell
return "none"
`;

function runOsascript(script: string): Promise<{ ok: boolean; output: string; permissionIssue: boolean }> {
  return new Promise((resolve) => {
    execFile('osascript', ['-e', script], { timeout: OSASCRIPT_TIMEOUT_MS }, (error, stdout, stderr) => {
      if (error) {
        const msg = (stderr || (error as any).message || '').toString();
        // -1743 = 没有「自动化」权限；-25211 = 辅助功能被关
        const permissionIssue = /-1743|-25211|not allowed|assistive/i.test(msg);
        console.log('[selection] osascript 失败:', msg.trim().slice(0, 160));
        resolve({ ok: false, output: '', permissionIssue });
        return;
      }
      resolve({ ok: true, output: (stdout || '').trim(), permissionIssue: false });
    });
  });
}

function getBinaryPath(): string {
  return nativePaths('axtext-macos').binaryPath;
}
