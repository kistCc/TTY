import { BrowserWindow, screen, ipcMain, app } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { takeScreenshot } from './screenshot';
import { execFile, execFileSync } from 'child_process';

/// 框选前在前台的应用（bundle id）。框选窗口会把 TTY 拉到前台，框完关掉后
/// macOS 不会自己切回去，接着打字就打空了——框完要把前台还给它。
/// 用 lsappinfo 查、用 open -b 切回去，都不需要额外的系统权限。
let previousApp = '';

function rememberFrontApp() {
  previousApp = '';
  try {
    const asn = execFileSync('lsappinfo', ['front'], { timeout: 1000 }).toString().trim();
    const info = execFileSync('lsappinfo', ['info', '-only', 'bundleid', asn], { timeout: 1000 }).toString();
    // 输出形如 bundleID="com.apple.TextEdit"（不同系统版本也见过 "CFBundleIdentifier"="…"）
    const m = info.match(/(?:bundleID|"CFBundleIdentifier")\s*=\s*"([^"]+)"/);
    if (m && m[1] !== 'com.screen-translator.app') previousApp = m[1];
  } catch {}
}

function restoreFrontApp() {
  const id = previousApp;
  previousApp = '';
  if (id) execFile('open', ['-b', id], () => {});
}

let selectionWin: BrowserWindow | null = null;
// resolve function is set BEFORE any await, so cancelSelection can always resolve the promise
let pendingResolve: ((value: SelectionRect | null) => void) | null = null;

export function isSelectionActive(): boolean {
  return pendingResolve !== null || (selectionWin !== null && !selectionWin.isDestroyed());
}

export interface SelectionRect {
  x: number;
  y: number;
  width: number;
  height: number;
  displayBounds: { x: number; y: number; width: number; height: number };
  screenshotPath: string;
}

export function showSelection(): Promise<SelectionRect | null> {
  // Already active — should not happen (caller checks), but guard anyway
  if (isSelectionActive()) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    // Set resolve IMMEDIATELY — before any async work — so cancelSelection always works
    pendingResolve = resolve;
    rememberFrontApp();

    doSelection(resolve).catch((err) => {
      console.error('[selection] Error:', err);
      cleanupAll();
      resolve(null);
    });
  });
}

async function doSelection(resolve: (value: SelectionRect | null) => void) {
  const cursorPoint = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursorPoint);
  const { x, y, width, height } = display.bounds;

  const screenshotPath = await takeScreenshot(display.bounds);

  // If cancelled during screenshot
  if (!pendingResolve) return;

  const dataUrl = `data:image/png;base64,${fs.readFileSync(screenshotPath).toString('base64')}`;

  // If cancelled during file read
  if (!pendingResolve) {
    try { fs.unlinkSync(screenshotPath); } catch {}
    return;
  }

  if (selectionWin && !selectionWin.isDestroyed()) {
    selectionWin.destroy();
  }

  selectionWin = new BrowserWindow({
    x, y, width, height,
    frame: false,
    transparent: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    resizable: false,
    movable: false,
    focusable: true,
    show: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'selection-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  selectionWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  selectionWin.setAlwaysOnTop(true, 'screen-saver');
  selectionWin.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'selection.html'));

  const onConfirm = (_e: any, rect: { x: number; y: number; width: number; height: number }) => {
    cleanupListeners();
    if (selectionWin && !selectionWin.isDestroyed()) { selectionWin.destroy(); }
    selectionWin = null;
    restoreFrontApp();
    pendingResolve = null;
    resolve({
      x: display.bounds.x + rect.x,
      y: display.bounds.y + rect.y,
      width: rect.width,
      height: rect.height,
      displayBounds: display.bounds,
      screenshotPath,
    });
  };

  const onCancel = () => {
    cleanupListeners();
    if (selectionWin && !selectionWin.isDestroyed()) { selectionWin.destroy(); }
    selectionWin = null;
    restoreFrontApp();
    pendingResolve = null;
    try { fs.unlinkSync(screenshotPath); } catch {}
    resolve(null);
  };

  const cleanupListeners = () => {
    ipcMain.removeListener('selection-confirm', onConfirm);
    ipcMain.removeListener('selection-cancel', onCancel);
  };

  ipcMain.once('selection-confirm', onConfirm);
  ipcMain.once('selection-cancel', onCancel);

  selectionWin.webContents.once('did-finish-load', () => {
    if (selectionWin && !selectionWin.isDestroyed()) {
      selectionWin.webContents.send('selection-background', dataUrl);
      selectionWin.show();
      selectionWin.focus();
    }
  });
}

function cleanupAll() {
  if (selectionWin && !selectionWin.isDestroyed()) {
    selectionWin.destroy();
    restoreFrontApp();
  }
  selectionWin = null;
  pendingResolve = null;
}

export function cancelSelection() {
  const resolve = pendingResolve;
  // Clean up window and state first
  cleanupAll();
  // Resolve the pending promise so caller unblocks
  if (resolve) {
    resolve(null);
  }
}
