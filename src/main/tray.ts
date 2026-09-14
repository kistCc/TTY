import { Tray, Menu, nativeImage, BrowserWindow, ipcMain, app } from 'electron';
import { getConfig, saveConfig, applyLoginItem } from './config';
import { t, resetUILanguage } from './i18n';
import * as path from 'path';

let tray: Tray | null = null;
let settingsWin: BrowserWindow | null = null;

let onTranslateCallback: (() => void) | null = null;
let onHideCallback: (() => void) | null = null;
let onClearCacheCallback: (() => void) | null = null;
let onSelectionTranslateCallback: (() => void) | null = null;
let onClipboardTranslateCallback: (() => void) | null = null;
let isOverlayVisibleFn: (() => boolean) | null = null;

export function setTranslateCallback(cb: () => void) {
  onTranslateCallback = cb;
}

export function setHideCallback(cb: () => void) {
  onHideCallback = cb;
}

export function setClearCacheCallback(cb: () => void) {
  onClearCacheCallback = cb;
}

export function setSelectionTranslateCallback(cb: () => void) {
  onSelectionTranslateCallback = cb;
}

export function setClipboardTranslateCallback(cb: () => void) {
  onClipboardTranslateCallback = cb;
}

export function setOverlayVisibleFn(fn: () => boolean) {
  isOverlayVisibleFn = fn;
}

const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAABL0lEQVR4nIXTzSpFURQH8N+5xEgMCIUXUJRiYOIpGBl5BOUZlBGlEE8gA+Q1KFMDBkquyRXK9zkG1mW33Ztdu/X9X+u/1zm0PkWi92Ig83W2qQO1kFM4xh1ecYVtjP5XXGAE96hwiwXsoYELLKGrFUBztPko/sB++EawgTJiR61AmuNP4C2Sn7GDE+yG7y1A5nKAIm5vjF4l9x2bif6ByVoGUIuEVQziM/zvEXvFU1A9wHneHfr8PmCZyDKmOsNh5KWr1RFyOitOKVRYTOnmFFKg/DTp3YTegSoFKENe4iU6VBlAgXpCqW33rUh4SZJLPGAooSCdoEjsnrC7/T5U4Xsr920o/hSvxOh13x/PY9gNrKfd8+ICy5F8jZmIDWMc/f91nsUp1jAWvvy3/bO1Lz7oVlfqu2r9AAAAAElFTkSuQmCC';

export function createTray() {
  const icon = nativeImage.createFromDataURL(`data:image/png;base64,${TRAY_ICON_BASE64}`);
  icon.setTemplateImage(true);
  // 牡丹鹦鹉剪影，template image 由 macOS 自动适配明暗模式

  tray = new Tray(icon);
  tray.setToolTip('TTY');

  updateTrayMenu();

  ipcMain.handle('get-config', () => getConfig());
  ipcMain.handle('save-config', (_event, config) => {
    const result = saveConfig(config);
    if (config.uiLanguage) { resetUILanguage(); updateTrayMenu(); }
    if (config.hotkey || config.dismissKey || config.cacheKey || config.regionKey || config.textKey || config.clipKey) {
      const { restartWithHotkeys } = require('./hotkey');
      restartWithHotkeys({
        trigger: result.hotkey,
        dismiss: result.dismissKey,
        cache: result.cacheKey,
        region: result.regionKey,
        text: result.textKey,
        clip: result.clipKey,
      });
    }
    if (Object.prototype.hasOwnProperty.call(config, 'openAtLogin')) {
      applyLoginItem(result.openAtLogin);
    }
    return result;
  });
  ipcMain.handle('resize-settings', (_event, contentHeight: number) => {
    if (settingsWin && !settingsWin.isDestroyed()) {
      const titleBarHeight = 28;
      const bounds = settingsWin.getBounds();
      settingsWin.setBounds(
        { x: bounds.x, y: bounds.y, width: bounds.width, height: contentHeight + titleBarHeight },
        true // animate on macOS
      );
    }
  });
}

export function updateTrayMenu() {
  if (!tray) return;
  const overlayVisible = isOverlayVisibleFn ? isOverlayVisibleFn() : false;

  const emptyIcon = nativeImage.createEmpty();
  const contextMenu = Menu.buildFromTemplate([
    {
      label: t('trayTranslate'),
      icon: emptyIcon,
      enabled: !overlayVisible,
      click: () => {
        if (onTranslateCallback) onTranslateCallback();
        setTimeout(() => updateTrayMenu(), 1000);
      },
    },
    {
      label: t('traySelectionTranslate'),
      icon: emptyIcon,
      click: () => { if (onSelectionTranslateCallback) onSelectionTranslateCallback(); },
    },
    {
      label: t('trayClipboardTranslate'),
      icon: emptyIcon,
      click: () => { if (onClipboardTranslateCallback) onClipboardTranslateCallback(); },
    },
    {
      label: t('trayHide'),
      icon: emptyIcon,
      enabled: overlayVisible,
      click: () => {
        if (onHideCallback) onHideCallback();
        setTimeout(() => updateTrayMenu(), 300);
      },
    },
    { type: 'separator' },
    {
      label: t('trayClearCache'),
      icon: emptyIcon,
      click: () => {
        if (onClearCacheCallback) onClearCacheCallback();
      },
    },
    {
      label: t('traySettings'),
      icon: emptyIcon,
      click: openSettings,
    },
    {
      label: t('trayQuit'),
      icon: emptyIcon,
      click: () => { app.quit(); },
    },
  ]);
  tray.setContextMenu(contextMenu);
}

export function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }

  settingsWin = new BrowserWindow({
    width: 480,
    height: 560,
    resizable: true,
    minimizable: false,
    title: t('settingsTitle'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'settings-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  settingsWin.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'settings.html'));

  settingsWin.on('closed', () => {
    settingsWin = null;
  });
}
