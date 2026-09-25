import { BrowserWindow, ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { focusSticker, stickerAutoFocus, returnFocusIfIdle } from './overlay';

const regionWindows = new Set<BrowserWindow>();

export interface RegionOverlayData {
  screenshotPath: string;
  blocks: Array<{ text: string; translated: string; x: number; y: number; width: number; height: number }>;
  /// 并段之前的原始块：渲染时先按它们把原文全擦掉，再画译文
  eraseRects?: Array<{ x: number; y: number; width: number; height: number }>;
  regionX: number;      // global screen coords
  regionY: number;
  regionWidth: number;  // CSS pixels
  regionHeight: number;
}

ipcMain.on('region-overlay-close', (event) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    regionWindows.delete(win);
    win.destroy();
    returnFocusIfIdle();
  }
});

ipcMain.on('region-overlay-move-by', (event, { dx, dy }: { dx: number; dy: number }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    const [x, y] = win.getPosition();
    win.setPosition(Math.round(x + dx), Math.round(y + dy));
  }
});

ipcMain.on('region-overlay-resize-by', (event, { delta }: { delta: number }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (win && !win.isDestroyed()) {
    const [w, h] = win.getSize();
    const [x, y] = win.getPosition();
    const scale = 1 + delta * 0.02;
    const newW = Math.max(80, Math.round(w * scale));
    const newH = Math.max(60, Math.round(h * scale));
    const newX = Math.round(x + (w - newW) / 2);
    const newY = Math.round(y + (h - newH) / 2);
    win.setBounds({ x: newX, y: newY, width: newW, height: newH });
  }
});

ipcMain.on('region-overlay-resize-edge', (event, { mode, dx, dy }: { mode: string; dx: number; dy: number }) => {
  const win = BrowserWindow.fromWebContents(event.sender);
  if (!win || win.isDestroyed()) return;
  const [x, y] = win.getPosition();
  const [w, h] = win.getSize();
  let newX = x, newY = y, newW = w, newH = h;
  if (mode.includes('e')) newW = w + dx;
  if (mode.includes('s')) newH = h + dy;
  if (mode.includes('w')) { newX = x + dx; newW = w - dx; }
  if (mode.includes('n')) { newY = y + dy; newH = h - dy; }
  if (newW < 80 || newH < 60) return;
  win.setBounds({ x: Math.round(newX), y: Math.round(newY), width: Math.round(newW), height: Math.round(newH) });
});

export function showRegionOverlay(data: RegionOverlayData) {
  // Min size to keep the titlebar usable
  const minW = Math.max(data.regionWidth, 120);
  const minH = Math.max(data.regionHeight, 80);

  const win = new BrowserWindow({
    x: Math.round(data.regionX),
    y: Math.round(data.regionY),
    width: Math.round(data.regionWidth),
    height: Math.round(data.regionHeight),
    minWidth: 80,
    minHeight: 60,
    frame: false,
    // 不透明：macOS 只给不透明窗口画系统阴影。贴图整个被截图盖满，本来也用不着透明
    transparent: false,
    backgroundColor: '#1e1e1e',
    alwaysOnTop: true,
    skipTaskbar: true,
    // 系统窗口阴影：贴图像一张浮在屏幕上的纸，没选中也能看出它在哪（Snipaste 也是这样）
    hasShadow: true,
    resizable: true,
    movable: true,
    focusable: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'region-overlay-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: false,
    },
  });

  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.setAlwaysOnTop(true, 'screen-saver');

  win.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'region-overlay.html'));

  let screenshotDataUrl = '';
  try {
    const buf = fs.readFileSync(data.screenshotPath);
    screenshotDataUrl = `data:image/png;base64,${buf.toString('base64')}`;
  } catch (err) {
    console.error('[region] Failed to read screenshot:', err);
  }

  // 等贴图画好再显示，免得先闪一下底色；万一渲染层没回话，800ms 后照样显示
  let shown = false;
  const reveal = () => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    // 自动选中：直接拿焦点；关掉时不抢焦点，点一下贴图才选中
    if (stickerAutoFocus()) { win.show(); focusSticker(win); }
    else win.showInactive();
    console.log('[region] Overlay shown');
  };
  const onDrawn = (event: Electron.IpcMainEvent) => {
    if (event.sender === win.webContents) { ipcMain.removeListener('sticker-drawn', onDrawn); reveal(); }
  };
  ipcMain.on('sticker-drawn', onDrawn);
  win.on('closed', () => ipcMain.removeListener('sticker-drawn', onDrawn));

  const send = () => {
    win.webContents.send('show-translation', {
      blocks: data.blocks,
      eraseRects: data.eraseRects,
      screenshotDataUrl,
      regionWidth: data.regionWidth,
      regionHeight: data.regionHeight,
    });
    setTimeout(reveal, 800);
  };

  if (win.webContents.isLoading()) {
    win.webContents.once('did-finish-load', send);
  } else {
    send();
  }

  regionWindows.add(win);
  win.on('closed', () => {
    regionWindows.delete(win);
    try { fs.unlinkSync(data.screenshotPath); } catch {}
  });
}

export function closeAllRegionOverlays() {
  for (const win of regionWindows) {
    if (!win.isDestroyed()) win.destroy();
  }
  regionWindows.clear();
}
