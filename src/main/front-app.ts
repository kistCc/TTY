import { execFile, execFileSync } from 'child_process';

/// TTY 的窗口（框选、输入翻译）会把 TTY 拉到前台。窗口关掉后 macOS 不会自己切回去，
/// 接着打字就打空了——所以打开前记下原来在前台的软件，关掉时把前台还给它。
/// 用 lsappinfo 查、用 open -b 切回去，都不需要额外的系统权限。
let previousApp = '';

export function rememberFrontApp() {
  previousApp = '';
  try {
    const asn = execFileSync('lsappinfo', ['front'], { timeout: 1000 }).toString().trim();
    const info = execFileSync('lsappinfo', ['info', '-only', 'bundleid', asn], { timeout: 1000 }).toString();
    // 输出形如 bundleID="com.apple.TextEdit"（不同系统版本也见过 "CFBundleIdentifier"="…"）
    const m = info.match(/(?:bundleID|"CFBundleIdentifier")\s*=\s*"([^"]+)"/);
    if (m && m[1] !== 'com.screen-translator.app') previousApp = m[1];
  } catch {}
}

export function restoreFrontApp() {
  const id = previousApp;
  previousApp = '';
  if (id) execFile('open', ['-b', id], () => {});
}

/// 不还了（用户自己点到别的软件去了，焦点已经不在 TTY）
export function forgetFrontApp() {
  previousApp = '';
}
