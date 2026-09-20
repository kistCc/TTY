
// Strings shown by the MAIN process (loading toast, tray menu, dialogs).
// The settings page has its own renderer-side i18n; this covers everything else.

const EN = {
  processing: 'Processing... {n}%',
  detecting: 'Detecting text... {n}%',
  analyzing: 'Analyzing... {n}%',
  translatingPct: 'Translating... {n}%',
  translating: 'Translating...',
  cancelled: 'Translation cancelled',
  cacheCleared: 'Cache cleared!',
  cached: 'Cached!',
  error: 'Error: {msg}',

  trayTranslate: 'Translate',
  traySelectionTranslate: 'Translate Selection',
  trayClipboardTranslate: 'Translate Clipboard',
  trayHide: 'Hide',
  trayClearCache: 'Clear Cache',
  traySettings: 'Settings',
  trayQuit: 'Quit',
  settingsTitle: 'TTY Settings',

  inputMonitoringTitle: 'Permission Required',
  inputMonitoringBody:
    'Your hotkey is a chord (two letter keys), which can only be detected by tapping the whole keyboard — that needs permission.\n\n'
    + 'Either grant it in System Settings → Privacy & Security → Input Monitoring, or open Settings and pick a normal shortcut like Option+Command+T, which needs no permission at all.',
  screenRecordingTitle: 'Screen Recording Permission',
  screenRecordingBody:
    'TTY needs Screen Recording permission to capture your screen.\n\n'
    + 'Without this permission, screenshots will only show the desktop wallpaper.\n\n'
    + 'Please grant permission in:\nSystem Settings → Privacy & Security → Screen Recording\n\nThen restart the app.',
  hotkeyUnavailableTitle: 'Hotkey Unavailable',
  hotkeyUnavailableBody:
    'macOS refused to register {keys}.\n\nAnother app already owns that shortcut. Open Settings from the tray icon and pick a different one.',
  inputMonitoringDeniedTitle: 'Input Monitoring Permission',
  inputMonitoringDeniedBody:
    'Global hotkeys are not working.\n\nThe keyboard monitor could not start because macOS denied Input Monitoring.\n\n'
    + 'System Settings → Privacy & Security → Input Monitoring → enable "TTY".\n\n'
    + 'If it is already enabled, select it, remove it with the minus button, add TTY again, then restart the app. (Unsigned apps lose this permission whenever the app bundle changes.)',
  btnOpenSettings: 'Open Settings',
  btnLater: 'Later',
  btnOK: 'OK',
};

type Key = keyof typeof EN;

const ZH: Record<Key, string> = {
  processing: '处理中… {n}%',
  detecting: '识别文字… {n}%',
  analyzing: '分析中… {n}%',
  translatingPct: '翻译中… {n}%',
  translating: '翻译中…',
  cancelled: '已取消翻译',
  cacheCleared: '缓存已清空',
  cached: '已缓存',
  error: '出错：{msg}',

  trayTranslate: '翻译屏幕',
  traySelectionTranslate: '划词翻译',
  trayClipboardTranslate: '复制翻译',
  trayHide: '关闭浮层',
  trayClearCache: '清空缓存',
  traySettings: '设置…',
  trayQuit: '退出',
  settingsTitle: 'TTY 设置',

  inputMonitoringTitle: '需要权限',
  inputMonitoringBody:
    '你设置的快捷键是「和弦」（两个字母键），只能靠监听整条键盘流来识别，这需要权限。\n\n'
    + '两个选择：在「系统设置 → 隐私与安全性 → 输入监控」里授权；或者打开设置改成 ⌥⌘T 这类普通组合键——那样完全不需要任何权限。',
  screenRecordingTitle: '需要屏幕录制权限',
  screenRecordingBody:
    'TTY 需要「屏幕录制」权限才能截屏。\n\n'
    + '没有这个权限，截到的只会是桌面壁纸。\n\n'
    + '请到：系统设置 → 隐私与安全性 → 屏幕录制\n\n开启后重启本应用。',
  hotkeyUnavailableTitle: '快捷键不可用',
  hotkeyUnavailableBody:
    'macOS 拒绝注册 {keys}。\n\n这个组合已经被别的应用占用了。请从菜单栏图标打开设置，换一个组合。',
  inputMonitoringDeniedTitle: '需要输入监控权限',
  inputMonitoringDeniedBody:
    '全局快捷键没能生效。\n\n键盘监听进程启动失败，因为 macOS 拒绝了「输入监控」权限。\n\n'
    + '系统设置 → 隐私与安全性 → 输入监控 → 打开「TTY」。\n\n'
    + '如果已经打开还是不行：选中它、用「−」删掉、重新添加，然后重启应用。（未签名的应用只要程序包变动过，这个权限就会失效。）',
  btnOpenSettings: '打开设置',
  btnLater: '稍后',
  btnOK: '好',
};

let cachedIsZh: boolean | null = null;

/// Chinese UI when the config says so, otherwise when the system locale is Chinese.
export function isChineseUI(): boolean {
  if (cachedIsZh !== null) return cachedIsZh;
  try {
    const { getConfig } = require('./config');
    const lang = getConfig().uiLanguage;
    if (lang === 'zh') { cachedIsZh = true; return true; }
    if (lang === 'en') { cachedIsZh = false; return false; }
  } catch {}
  // 不看 app.getLocale()：系统是中文时 Electron 也常返回 en-US。
  // 这是给中文用户做的构建，默认中文；只有 config.uiLanguage 明确写 'en' 才用英文。
  cachedIsZh = true;
  return cachedIsZh;
}

/// Forget the cached choice, so a language change in settings takes effect.
export function resetUILanguage() {
  cachedIsZh = null;
}

/// 报错显示前最后一道清洗：修复按错编码解出来的中文，去掉控制字符、解码失败留下的替换符和 HTML 标签，
/// 剩下的看起来不像人话（乱码占多数）就换成一句通用提示。
export function readableError(err: any): string {
  let msg = String(err?.message || err || '');
  // UTF-8 的中文被当成 Latin-1 解出来的典型乱码（"ç¼“å­˜"）：按 Latin-1 编回字节再按 UTF-8 解，能解干净就用解出来的
  if (/[\u00c2-\u00f4][\u0080-\u00bf]/.test(msg)) {
    const fixed = Buffer.from(msg, 'latin1').toString('utf-8');
    if (!fixed.includes('\ufffd')) msg = fixed;
  }
  msg = msg.replace(/<[^>]*>/g, ' ');
  msg = msg.replace(/[\u0000-\u001f\u007f-\u009f\ufffd]/g, ' ').replace(/\s+/g, ' ').trim();
  const readable = (msg.match(/[\p{L}\p{N}\p{P}\s]/gu) || []).length;
  if (!msg || readable < msg.length * 0.8) return '翻译服务返回了无法识别的内容，请稍后再试或换一个翻译服务';
  return msg.slice(0, 80);
}

export function t(key: Key, vars?: Record<string, string | number>): string {
  let s = (isChineseUI() ? ZH : EN)[key] ?? EN[key];
  if (vars) {
    for (const [k, v] of Object.entries(vars)) {
      s = s.split(`{${k}}`).join(String(v));
    }
  }
  return s;
}
