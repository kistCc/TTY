import { BrowserWindow, screen, ipcMain, app, clipboard, nativeImage } from 'electron';
import { t } from './i18n';
import * as path from 'path';
import * as fs from 'fs';

let overlayWin: BrowserWindow | null = null;
let loadingWin: BrowserWindow | null = null;
let currentScreenshotPath: string | null = null;

export interface OverlayBlock {
  text: string;
  translated: string;
  x: number; // CSS pixels
  y: number;
  width: number;
  height: number;
}

export interface OverlayData {
  screenshotPath: string; // file path, not data URL
  blocks: OverlayBlock[];
  /// 并段之前的原始文本块，用来把原文擦干净（碎块不并段也不能留着英文）
  eraseRects?: Array<{ x: number; y: number; width: number; height: number }>;
  displayBounds?: { x: number; y: number; width: number; height: number };
}

let dismissCallback: (() => void) | null = null;
export function setDismissCallback(cb: () => void) { dismissCallback = cb; }

// 点一下浮层就让它拿到键盘焦点。浮层是 showInactive() 弹出来的（不抢焦点，
// 免得打断用户手上的事），代价是它一直不是 key window，⌘C 根本到不了它手里——
// 所以点击时补一次 focus，这也正是 Snipaste 贴图的手感：点一下，然后就能复制。
ipcMain.on('sticker-focus', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) win.focus();
});

// 贴图复制：整张浮层（连同译文）进剪贴板，像 Snipaste 的贴图那样可以直接粘到别处。
// 两个浮层（全屏 / 选区）共用这一对通道。
ipcMain.on('sticker-copy-image', (_e, dataUrl: string) => {
  try {
    const img = nativeImage.createFromDataURL(dataUrl);
    if (img.isEmpty()) { console.log('[sticker] 贴图为空，没有复制'); return; }
    clipboard.writeImage(img);
    console.log(`[sticker] 已复制贴图 ${img.getSize().width}×${img.getSize().height}`);
  } catch (e) {
    console.log('[sticker] 复制贴图失败:', e);
  }
});

ipcMain.on('sticker-copy-text', (_e, text: string) => {
  if (typeof text !== 'string' || !text) return;
  clipboard.writeText(text);
  console.log(`[sticker] 已复制译文 ${text.length} 字`);
});

ipcMain.on('dismiss-overlay', () => {
  if (dismissCallback) dismissCallback();
  else hideOverlay();
});

ipcMain.on('overlay-move-by', (_e, { dx, dy }: { dx: number; dy: number }) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    const [x, y] = overlayWin.getPosition();
    overlayWin.setPosition(Math.round(x + dx), Math.round(y + dy));
  }
});

ipcMain.on('overlay-resize-by', (_e, { delta }: { delta: number }) => {
  if (overlayWin && !overlayWin.isDestroyed()) {
    const [w, h] = overlayWin.getSize();
    const [x, y] = overlayWin.getPosition();
    const scale = 1 + delta * 0.02;
    const newW = Math.max(200, Math.round(w * scale));
    const newH = Math.max(120, Math.round(h * scale));
    const newX = Math.round(x + (w - newW) / 2);
    const newY = Math.round(y + (h - newH) / 2);
    overlayWin.setBounds({ x: newX, y: newY, width: newW, height: newH });
  }
});

ipcMain.on('overlay-resize-edge', (_e, { mode, dx, dy }: { mode: string; dx: number; dy: number }) => {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const [x, y] = overlayWin.getPosition();
  const [w, h] = overlayWin.getSize();
  let newX = x, newY = y, newW = w, newH = h;
  if (mode.includes('e')) newW = w + dx;
  if (mode.includes('s')) newH = h + dy;
  if (mode.includes('w')) { newX = x + dx; newW = w - dx; }
  if (mode.includes('n')) { newY = y + dy; newH = h - dy; }
  if (newW < 200 || newH < 120) return;
  overlayWin.setBounds({ x: Math.round(newX), y: Math.round(newY), width: Math.round(newW), height: Math.round(newH) });
});

function getTargetDisplay() {
  return screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
}

/// 顶部提示条的页面。一定要带 charset=utf-8 并整体 URL 编码：不带编码时中文按 Latin-1 解，
/// "缓存已清空"、报错信息全成乱码；不编码的话报错里带 # 会被当成锚点截断，带 < 会把页面弄坏。
function noticePage(text: string, bg: string): string {
  const esc = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const html = `<html><head><meta charset="utf-8"></head><body style="margin:0;background:transparent;display:flex;justify-content:center;align-items:center;height:100vh;"><div id="msg" style="background:${bg};color:white;padding:12px 24px;border-radius:10px;font-size:14px;font-family:-apple-system,'PingFang SC',sans-serif;white-space:nowrap;">${esc}</div></body></html>`;
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
}

/// 提示条宽度跟着字数走：中文约 14px 一个字，报错信息比进度提示长得多，固定 240 会被截掉。
function noticeWidth(text: string): number {
  let w = 0;
  for (const ch of text) w += ch.charCodeAt(0) > 0x2e80 ? 14 : 8;
  return Math.min(760, Math.max(240, w + 64));
}

export function showLoading(progress?: string) {
  const text = progress || t('translating');
  if (loadingWin && !loadingWin.isDestroyed()) {
    const b = loadingWin.getBounds();
    const w = noticeWidth(text);
    if (w !== b.width) loadingWin.setBounds({ x: b.x + Math.round((b.width - w) / 2), y: b.y, width: w, height: b.height });
    loadingWin.webContents.executeJavaScript(
      `document.getElementById('msg').textContent = ${JSON.stringify(text)}`
    ).catch(() => {});
    return;
  }

  const d = getTargetDisplay();
  // Top centre, just under the menu bar, so it does not cover the text being translated.
  const wa = d.workArea;
  const w = noticeWidth(text);
  loadingWin = new BrowserWindow({
    width: w, height: 56,
    x: wa.x + Math.floor(wa.width / 2 - w / 2),
    y: wa.y + 16,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, resizable: false, movable: false, focusable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  loadingWin.setIgnoreMouseEvents(true);
  loadingWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  loadingWin.setAlwaysOnTop(true, 'screen-saver');
  loadingWin.loadURL(noticePage(text, 'rgba(0,0,0,0.8)'));
  loadingWin.showInactive();
}

export function hideLoading() {
  if (loadingWin && !loadingWin.isDestroyed()) { loadingWin.destroy(); loadingWin = null; }
}

export function showCancelled() {
  hideLoading(); hideOverlay();
  const d = getTargetDisplay();
  const wa = d.workArea;
  const toast = new BrowserWindow({
    width: 200, height: 50,
    x: wa.x + Math.floor(wa.width / 2 - 100),
    y: wa.y + 16,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, focusable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  toast.setIgnoreMouseEvents(true);
  toast.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  toast.setAlwaysOnTop(true, 'screen-saver');
  toast.loadURL(noticePage(t('cancelled'), 'rgba(0,0,0,0.7)'));
  toast.showInactive();
  setTimeout(() => { if (!toast.isDestroyed()) toast.destroy(); }, 1500);
}

// Pre-create the overlay window so it's instantly ready
// bounds: optional display bounds to create the overlay on (defaults to primary display)
export function ensureOverlayWindow(bounds?: { x: number; y: number; width: number; height: number }): BrowserWindow {
  if (overlayWin && !overlayWin.isDestroyed()) {
    if (bounds) overlayWin.setBounds(bounds);
    return overlayWin;
  }

  const { x, y, width, height } = bounds || screen.getPrimaryDisplay().bounds;

  overlayWin = new BrowserWindow({
    x, y, width, height,
    minWidth: 200, minHeight: 120,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, resizable: true, movable: true, focusable: true,
    show: false, enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false, // Allow loading local file:// images
    },
  });

  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setAlwaysOnTop(true, 'screen-saver');
  overlayWin.setBounds({ x, y, width, height });
  overlayWin.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'overlay.html'));

  return overlayWin;
}

export function showOverlay(data: OverlayData) {
  // Clean up previous screenshot
  if (currentScreenshotPath) {
    try { fs.unlinkSync(currentScreenshotPath); } catch {}
  }
  currentScreenshotPath = data.screenshotPath;

  const win = ensureOverlayWindow(data.displayBounds);
  console.log(`[overlay] Sending ${data.blocks.length} blocks`);

  // Read screenshot file and convert to data URL for reliable access from asar context
  let screenshotDataUrl = '';
  try {
    const buf = fs.readFileSync(data.screenshotPath);
    screenshotDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  } catch (err) {
    console.error('[overlay] Failed to read screenshot:', err);
  }

  const send = () => {
    // 每次都把浮层拉回整屏：用户拖过、缩放过之后，窗口会记着上次的位置和大小，
    // 下一次全屏翻译就会盖不满，露出底下窗口的边。
    if (data.displayBounds) win.setBounds(data.displayBounds);
    win.webContents.send('show-translation', { ...data, screenshotDataUrl });
    win.showInactive();
    hideLoading();
    console.log('[overlay] Shown');
  };

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }
}

export function hideOverlay() {
  hideLoading();
  // 浮层一关就删掉截图：整屏截图里可能有聊天记录、密码框之类的内容，不该留在硬盘上。
  // 渲染层拿到的是 data URL，不依赖这个文件。
  discardCurrentScreenshot();
  if (overlayWin && !overlayWin.isDestroyed()) {
    overlayWin.destroy();
    overlayWin = null;
    console.log('[overlay] Destroyed');
    // Pre-create a fresh window for next use
    setTimeout(() => ensureOverlayWindow(), 500);
  }
}

/// 删掉当前这张全屏截图（如果还在）。退出应用时也会调一次。
export function discardCurrentScreenshot() {
  if (!currentScreenshotPath) return;
  try {
    fs.unlinkSync(currentScreenshotPath);
    console.log('[overlay] 已删除截图:', currentScreenshotPath);
  } catch {}
  currentScreenshotPath = null;
}

export function isOverlayVisible(): boolean {
  return overlayWin !== null && !overlayWin.isDestroyed() && overlayWin.isVisible();
}
