import { BrowserWindow, screen, clipboard, ipcMain, app } from 'electron';
import * as path from 'path';
import { getConfig, saveConfig } from './config';
import { translate } from './translator';
import { pickTargetLang } from './quick';
import { isChineseUI, readableError } from './i18n';
import { focusSticker } from './overlay';
import { rememberFrontApp, restoreFrontApp, forgetFrontApp } from './front-app';

// 输入翻译：按快捷键在鼠标旁弹出一个输入框，直接打字，回车翻译（⇧回车换行）。
// 中文翻成英文，外文翻成设置里的目标语言（和划词翻译同一套判断）。
// 不截屏、不做 OCR，一次请求就出结果。

/// 卡片本身的宽度之外再留一圈，给 CSS 阴影用（系统阴影在透明窗上会露出直角）。
const SHADOW_PAD = 12;
const WIN_WIDTH = 400 + SHADOW_PAD * 2;
const MIN_HEIGHT = 150;
const MAX_HEIGHT = 560;
const MAX_TEXT_LENGTH = 3000;

let inputWin: BrowserWindow | null = null;
/// 每次请求一个序号：改了文字重新翻译时，旧的结果回来就丢掉
let requestSeq = 0;

ipcMain.on('input-close', () => hideInput(true));

ipcMain.on('input-copy', (_e, text: string) => {
  if (typeof text === 'string' && text) clipboard.writeText(text);
});

ipcMain.on('input-height', (_e, height: number) => {
  if (!inputWin || inputWin.isDestroyed()) return;
  const h = Math.round(Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, height)));
  const b = inputWin.getBounds();
  if (Math.abs(b.height - h) < 2) return;
  const wa = screen.getDisplayNearestPoint({ x: b.x, y: b.y }).workArea;
  const y = Math.max(wa.y + 4, Math.min(b.y, wa.y + wa.height - h - 4));
  inputWin.setBounds({ x: b.x, y: Math.round(y), width: b.width, height: h });
});

/// 下拉里能选的语言，和设置里「目标语言」的列表一致
const TARGETS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es'];

/// 顶上下拉选了哪种语言：记进配置，下次打开还是它
ipcMain.on('input-set-target', (_e, target: string) => {
  const value = target === 'auto' || TARGETS.includes(target) ? target : 'auto';
  saveConfig({ inputTargetLang: value });
});

ipcMain.on('input-translate', async (_e, payload: { text: string; target?: string }) => {
  const win = inputWin;
  if (!win || win.isDestroyed()) return;
  const text = String(payload?.text || '').trim();
  if (!text) return;

  const config = getConfig();
  const body = text.length > MAX_TEXT_LENGTH ? text.slice(0, MAX_TEXT_LENGTH) : text;
  const configured = config.targetLanguage || 'zh-CN';
  const chosen = payload?.target && TARGETS.includes(payload.target) ? payload.target : 'auto';
  // 自动：中文翻英文，外文翻设置的目标语言；选了语言就固定翻成它
  const targetLang = chosen === 'auto' ? pickTargetLang(body, configured) : chosen;
  const id = ++requestSeq;
  send(win, 'input-pending', { id, source: sourceLabel(body, configured, targetLang), targetLang });

  try {
    const [translated] = await translate([body], targetLang, config);
    if (id !== requestSeq) return;
    if (!translated) { send(win, 'input-result', { id, error: '没有翻译出来，请稍后再试或换一个翻译服务' }); return; }
    send(win, 'input-result', { id, translated });
  } catch (err: any) {
    if (id !== requestSeq) return;
    send(win, 'input-result', { id, error: readableError(err) });
  }
});

/// 顶上显示的"从什么语言"：大部分是汉字写简体中文，大部分是英文字母写 English，
/// 其它说不准的写"自动识别"（原文是什么语言由翻译服务自己判断）
function sourceLabel(text: string, _configured: string, _target: string): string {
  const letters = text.replace(/\s/g, '');
  if (!letters) return 'auto';
  const han = (letters.match(/[\u4e00-\u9fff]/g) || []).length;
  const latin = (letters.match(/[A-Za-z]/g) || []).length;
  if (han / letters.length > 0.4) return 'zh-CN';
  return latin / letters.length > 0.6 ? 'en' : 'auto';
}

function ensureInputWindow(): BrowserWindow {
  if (inputWin && !inputWin.isDestroyed()) return inputWin;

  inputWin = new BrowserWindow({
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
      preload: path.join(__dirname, '..', 'preload', 'input-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  inputWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  inputWin.setAlwaysOnTop(true, 'screen-saver');
  inputWin.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'input.html'));

  // 点到窗口外面就收起来，和划词小窗一致。这时焦点已经在用户点的地方，不用还
  inputWin.on('blur', () => hideInput(false));

  return inputWin;
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

export function showInputTranslate() {
  if (isInputVisible()) { focusSticker(inputWin!); return; }
  rememberFrontApp();
  const win = ensureInputWindow();
  requestSeq++;
  const saved = getConfig().inputTargetLang;
  send(win, 'input-show', { lang: isChineseUI() ? 'zh' : 'en', chosen: saved && TARGETS.includes(saved) ? saved : 'auto' });
  positionNearCursor(win, MIN_HEIGHT);
  win.show();
  // 要打字，所以一定要拿到键盘焦点
  focusSticker(win);
}

function send(win: BrowserWindow, channel: string, payload: any) {
  if (win.isDestroyed()) return;
  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', () => { if (!win.isDestroyed()) win.webContents.send(channel, payload); });
  } else {
    win.webContents.send(channel, payload);
  }
}

/// restoreFocus：按关闭键、点 × 关掉时把前台还给原来的软件；点到别处收起时不用
export function hideInput(restoreFocus = false) {
  if (!inputWin || inputWin.isDestroyed() || !inputWin.isVisible()) return;
  requestSeq++;
  inputWin.hide();
  if (restoreFocus) restoreFrontApp(); else forgetFrontApp();
}

export function isInputVisible(): boolean {
  return inputWin !== null && !inputWin.isDestroyed() && inputWin.isVisible();
}
