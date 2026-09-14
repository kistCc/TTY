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

export function showLoading(progress?: string) {
  const text = progress || t('translating');
  if (loadingWin && !loadingWin.isDestroyed()) {
    loadingWin.webContents.executeJavaScript(
      `document.getElementById('msg').textContent = ${JSON.stringify(text)}`
    ).catch(() => {});
    return;
  }

  const d = getTargetDisplay();
  // Top centre, just under the menu bar, so it does not cover the text being translated.
  const wa = d.workArea;
  loadingWin = new BrowserWindow({
    width: 240, height: 56,
    x: wa.x + Math.floor(wa.width / 2 - 120),
    y: wa.y + 16,
    frame: false, transparent: true, alwaysOnTop: true, skipTaskbar: true,
    hasShadow: false, resizable: false, movable: false, focusable: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  loadingWin.setIgnoreMouseEvents(true);
  loadingWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  loadingWin.setAlwaysOnTop(true, 'screen-saver');
  loadingWin.loadURL(`data:text/html,<html><body style="margin:0;background:transparent;display:flex;justify-content:center;align-items:center;height:100vh;"><div id="msg" style="background:rgba(0,0,0,0.8);color:white;padding:12px 24px;border-radius:10px;font-size:14px;font-family:-apple-system,sans-serif;white-space:nowrap;">${text}</div></body></html>`);
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
  toast.loadURL(`data:text/html,<html><body style="margin:0;background:transparent;display:flex;justify-content:center;align-items:center;height:100vh;"><div style="background:rgba(0,0,0,0.7);color:white;padding:12px 24px;border-radius:10px;font-size:14px;font-family:-apple-system,sans-serif;">${t('cancelled')}</div></body></html>`);
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
