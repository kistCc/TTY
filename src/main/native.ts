import { execFile, execFileSync } from 'child_process';
import * as path from 'path';
import * as fs from 'fs';

// 三个原生小程序（OCR / 全局热键 / 辅助功能取词）的编译参数只在这里写一份。
//
// 调用方不要各自拼 clang 命令：app 装好之后，只要源码的 mtime 看起来比二进制新
// （复制、解包都可能造成），运行时就会照着这份参数重编一次。参数但凡漏一个
// framework，链接就失败，整条功能跟着断，用户看到的还是 clang 的原始报错。

export type NativeTool = 'ocr-macos' | 'hotkey-macos' | 'axtext-macos';

/// 排查用：GUI 应用的 console.log 看不见，把关键节点写到 ~/Developer/TTY/tty-debug.log。
///
/// 默认什么都不做——只有那个文件已经存在时才往里追加。要排查时先
/// `touch ~/Developer/TTY/tty-debug.log`，不排查就删掉它，不会平白在仓库里堆东西。
export function debugLog(msg: string) {
  try {
    const os = require('os');
    const logPath = path.join(os.homedir(), 'Developer', 'TTY', 'tty-debug.log');
    if (!fs.existsSync(logPath)) return;
    fs.appendFileSync(logPath, `[${new Date().toISOString()}] ${msg}\n`);
  } catch {}
}

/// 版面问题（段落被拆开、译文互相压着）光看最后的段落列表看不出原因，
/// 得看 OCR 原始框和聚出来的行。这一路输出很长，所以单独一个开关：
/// `touch ~/Developer/TTY/tty-debug-ocr.log` 打开，删掉就关。
export function debugLogVerbose(msg: string) {
  try {
    const os = require('os');
    if (!fs.existsSync(path.join(os.homedir(), 'Developer', 'TTY', 'tty-debug-ocr.log'))) return;
    debugLog(msg);
  } catch {}
}

/// 每个程序需要链接的 framework。改这里就够了，package.json 的 build:native
/// 是同样参数的一份预编译，两边必须一致。
const FRAMEWORKS: Record<NativeTool, string[]> = {
  'ocr-macos': ['Foundation', 'Vision', 'CoreImage', 'AppKit'],
  'hotkey-macos': ['Foundation', 'Carbon', 'AppKit'],
  'axtext-macos': ['Foundation', 'AppKit', 'ApplicationServices'],
};

export function buildArgs(tool: NativeTool, sourcePath: string, binaryPath: string): string[] {
  const args = ['-O2', sourcePath, '-o', binaryPath];
  for (const fw of FRAMEWORKS[tool]) args.push('-framework', fw);
  args.push('-fobjc-arc');
  return args;
}

/// 找到某个原生程序：开发时在仓库的 scripts/ 下，打包后在 app 的 Resources/scripts/ 下。
export function nativePaths(tool: NativeTool): { binaryPath: string; sourcePath: string } {
  const devPath = path.join(__dirname, '..', '..', 'scripts', tool);
  if (fs.existsSync(devPath) || fs.existsSync(devPath + '.m')) {
    return { binaryPath: devPath, sourcePath: devPath + '.m' };
  }
  const prodPath = path.join(process.resourcesPath, 'scripts', tool);
  return { binaryPath: prodPath, sourcePath: prodPath + '.m' };
}

/// 二进制是不是可以直接用（存在，且不比源码旧）
export function isBinaryFresh(binaryPath: string, sourcePath: string): boolean {
  if (!fs.existsSync(binaryPath)) return false;
  if (!fs.existsSync(sourcePath)) return true; // 没源码可比，有什么用什么
  try {
    return fs.statSync(binaryPath).mtimeMs >= fs.statSync(sourcePath).mtimeMs;
  } catch {
    return true;
  }
}

/// 确保某个原生程序可用，必要时现场编译。
///
/// 编译失败但旧二进制还在的话就继续用旧的：一次编译失败不该让整个功能瘫掉。
export function ensureNative(tool: NativeTool): Promise<{ binaryPath: string; error?: string }> {
  const { binaryPath, sourcePath } = nativePaths(tool);

  if (isBinaryFresh(binaryPath, sourcePath)) {
    return Promise.resolve({ binaryPath });
  }
  if (!fs.existsSync(sourcePath)) {
    return Promise.resolve({ binaryPath, error: `找不到 ${tool} 的源码，也没有可用的程序` });
  }

  return new Promise((resolve) => {
    execFile('clang', buildArgs(tool, sourcePath, binaryPath), (err, _out, stderr) => {
      if (!err) { resolve({ binaryPath }); return; }

      const detail = (stderr || err.message || '').toString().trim();
      console.log(`[native] 编译 ${tool} 失败：${detail.slice(0, 300)}`);

      if (fs.existsSync(binaryPath)) {
        console.log(`[native] 沿用已有的 ${tool}`);
        resolve({ binaryPath });
        return;
      }
      resolve({ binaryPath, error: `${tool} 编译失败` });
    });
  });
}

/// 同步版本，给启动路径上那些不方便等的地方用。
export function ensureNativeSync(tool: NativeTool): { binaryPath: string; ok: boolean } {
  const { binaryPath, sourcePath } = nativePaths(tool);
  if (isBinaryFresh(binaryPath, sourcePath)) return { binaryPath, ok: true };
  if (!fs.existsSync(sourcePath)) return { binaryPath, ok: fs.existsSync(binaryPath) };
  try {
    execFileSync('clang', buildArgs(tool, sourcePath, binaryPath));
    return { binaryPath, ok: true };
  } catch (e: any) {
    console.log(`[native] 编译 ${tool} 失败：${(e?.stderr || e?.message || '').toString().slice(0, 300)}`);
    return { binaryPath, ok: fs.existsSync(binaryPath) };
  }
}
