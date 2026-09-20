import { BrowserWindow, screen, clipboard, ipcMain, app, shell } from 'electron';
import * as path from 'path';
import { getConfig } from './config';
import { translate } from './translator';
import { getSelection } from './selection-text';
import { isChineseUI, readableError } from './i18n';

// 两条取词通道，各自一个快捷键，互不回落——按了哪个键就翻哪来的文本，
// 不会出现"我明明选中了，翻的却是上次复制的东西"这种事：
//
//   划词翻译（showSelectionTranslate）：读辅助功能接口里的选区，需要辅助功能权限
//   复制翻译（showClipboardTranslate）：读剪贴板，不需要任何权限
//
// 两条都和截图那条链路完全分开——不截屏、不做 OCR，一次请求就出结果。

/// 卡片本身的宽度之外再留一圈，给 CSS 阴影用（系统阴影在透明窗上会露出直角）。
const SHADOW_PAD = 12;
const WIN_WIDTH = 400 + SHADOW_PAD * 2;
const MIN_HEIGHT = 130;
const MAX_HEIGHT = 540;
/// 超过这个长度就不是「取词」了，截断后再发，免得一次请求拖很久。
const MAX_TEXT_LENGTH = 3000;

let quickWin: BrowserWindow | null = null;
/// 每次请求一个序号：翻译回来时如果窗口已经在显示别的内容，就丢弃这个结果。
let requestSeq = 0;

ipcMain.on('quick-close', () => hideQuick());

ipcMain.on('quick-open-ax', () => {
  // 辅助功能面板，用户勾上 TTY 之后划词才拿得到选区
  shell.openExternal('x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility');
});

ipcMain.on('quick-copy', (_e, text: string) => {
  if (typeof text === 'string' && text) clipboard.writeText(text);
});

ipcMain.on('quick-height', (_e, height: number) => {
  if (!quickWin || quickWin.isDestroyed()) return;
  const h = Math.round(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height)));
  const b = quickWin.getBounds();
  if (Math.abs(b.height - h) < 2) return;

  const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const y = Math.max(wa.y + 4, Math.min(b.y, wa.y + wa.height - h - 4));
  quickWin.setBounds({ x: b.x, y: Math.round(y), width: b.width, height: h });
});

function ensureQuickWindow(): BrowserWindow {
  if (quickWin && !quickWin.isDestroyed()) return quickWin;

  quickWin = new BrowserWindow({
    width: WIN_WIDTH,
    height: MIN_HEIGHT,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'quick-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  quickWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  quickWin.setAlwaysOnTop(true, 'screen-saver');
  quickWin.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'quick.html'));

  // 点到窗口外面就收起来，和 macOS 上其它取词工具一致。
  quickWin.on('blur', () => hideQuick());

  return quickWin;
}

/// 把窗口放到鼠标附近，并保证整个窗口留在当前这块屏幕的可用区域内。
function positionNearCursor(win: BrowserWindow, height: number) {
  const cursor = screen.getCursorScreenPoint();
  const wa = screen.getDisplayNearestPoint(cursor).workArea;

  let x = cursor.x + 16;
  let y = cursor.y + 20;
  if (x + WIN_WIDTH > wa.x + wa.width) x = cursor.x - WIN_WIDTH - 16;
  if (y + height > wa.y + wa.height) y = cursor.y - height - 20;

  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width - WIN_WIDTH - 8));
  y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - height - 8));

  win.setBounds({ x: Math.round(x), y: Math.round(y), width: WIN_WIDTH, height });
}

function ratioOf(text: string, re: RegExp): number {
  const stripped = text.replace(/\s/g, '');
  if (!stripped) return 0;
  return (stripped.match(re)?.length || 0) / stripped.length;
}

/// 目标语言就是设置里的那个，除非文本本身已经是目标语言——那时候反过来译，
/// 这样「复制一段中文查英文说法」也能用同一个快捷键。
function pickTargetLang(text: string, configured: string): string {
  const prefix = configured.split('-')[0];
  const isCJKTarget = ['zh', 'ja', 'ko'].includes(prefix);

  if (prefix === 'zh' && ratioOf(text, /[一-鿿]/g) > 0.4) return 'en';
  if (prefix === 'ja' && ratioOf(text, /[぀-ヿ]/g) > 0.2) return 'en';
  if (prefix === 'ko' && ratioOf(text, /[가-힯]/g) > 0.4) return 'en';
  if (!isCJKTarget && ratioOf(text, /[a-zA-Z]/g) > 0.6) {
    return isChineseUI() ? 'zh-CN' : configured;
  }
  return configured;
}

/// 划词翻译：只认此刻选中的文本，取不到就直说，不会偷偷改用剪贴板。
export async function showSelectionTranslate() {
  // 必须赶在窗口显示之前问——窗口一显示就抢走了焦点，选区也就无从查起。
  let text = '';
  let denied = false;
  try {
    const sel = await getSelection();
    text = sel.text;
    denied = sel.denied;
  } catch {}
  console.log(`[quick] 划词：${text.length} 字${denied ? '（没权限）' : ''}`);

  // 只有两条路都因为没权限而失败时才提示；真的没选中就老实说没选中
  runQuick(text, 'selection', { needsAX: denied });
}

/// 复制翻译：只认剪贴板，跟选区和辅助功能权限都没关系。
export function showClipboardTranslate() {
  const text = (clipboard.readText() || '').trim();
  console.log(`[quick] 剪贴板：${text.length} 字`);
  runQuick(text, 'clipboard', {});
}

async function runQuick(
  text: string,
  from: 'selection' | 'clipboard',
  opts: { needsAX?: boolean }
) {
  const win = ensureQuickWindow();
  const lang = isChineseUI() ? 'zh' : 'en';

  if (!text) {
    const id = ++requestSeq;
    send(win, 'quick-show', { id, text: '', lang, empty: true, from, needsAX: opts.needsAX });
    positionNearCursor(win, MIN_HEIGHT);
    win.show();
    return;
  }

  const config = getConfig();
  const body = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
  const targetLang = pickTargetLang(body, config.targetLanguage || 'zh-CN');

  const id = ++requestSeq;
  send(win, 'quick-show', { id, text: body, lang, targetLang, provider: config.provider, from });
  positionNearCursor(win, MIN_HEIGHT);
  win.show();

  try {
    const [translated] = await translate([body], targetLang, config);
    if (id !== requestSeq) return; // 期间又按了一次，这个结果已经过期
    if (!translated) { send(win, 'quick-result', { id, error: '没有翻译出来，请稍后再试或换一个翻译服务' }); return; }
    send(win, 'quick-result', { id, translated });
  } catch (err: any) {
    if (id !== requestSeq) return;
    send(win, 'quick-result', { id, error: readableError(err) });
  }
}

function send(win: BrowserWindow, channel: string, payload: any) {
  if (win.isDestroyed()) return;
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    });
  } else {
    win.webContents.send(channel, payload);
  }
}

export function hideQuick() {
  if (quickWin && !quickWin.isDestroyed() && quickWin.isVisible()) {
    requestSeq++; // 让在途结果作废，避免窗口关掉后又被内容唤醒
    quickWin.hide();
  }
}

export function isQuickVisible(): boolean {
  return quickWin !== null && !quickWin.isDestroyed() && quickWin.isVisible();
}
