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

/// 菜单栏图标：32x32 的鹦鹉剪影，按 2x 载入，也就是 16pt。
const TRAY_ICON_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAERlWElmTU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAIKADAAQAAAABAAAAIAAAAACshmLzAAACXklEQVRYCe2WzUuVQRSHb5pmWZkIQQtLpaJAS0EJy0WL2gRtxKA2tar+gqJW7ULEIip0pxsFo437iCgILaIPihQkSRcVEYnRB5Wiz6/eV6Zp3nvPvV5pkT94mDNnzpz5eu/cSaWWtbwD/3gHCvM0fg15muEgbIY5+BiVFEunClKfg2nQoDE/sa9AJSyZisjcD/Ggbjkb+Ycom2Aj5F1HyegOKnsKTsFWuAwz8AEmoQOqIC8qIcsA+BO4g09tkr6FcXBjHlLX5BZUsGBlZ2wgfE+gyzp86yO/tn2VF6PjuAorPX9W1VKi98I3cFcnW2d/E07CMPjtP/DdA30/v7QiNjKUimuDw7AFtLpq8FeIK6hLeB/DW2iBTtACTNpGVB+EVuyvMFT/St+GaKQqyi5YHdUzFjrnUQgltvom6H8MWmEQDoBJ2uYHYB3Ij9N534U3oHO/DvvArBNE+kmtdZ33ISiGtRFZXfv60m+BdUA/7jx9TUq6BzSBelOGcFBj2P23N2kCuih02eSqcmvHpAnoQvlsTRKIM/dNmsAXkj4NJLa6nlkD08WdptH/uCx1rb42XWK3LWkHFPMKzNelk7QH+4VTz8lspNdLsKzYjdHf7aacRnQ66W03BnFiPSgeOfXY75baqWuwHRalGno/hzj5CPZ+KINekF/vv/fwDvQCku8MpDtOmjNLv333lXOb+k6n21lsDdYOutN1TBdAPvPNR+wf0qCxjmMcgSfQDTfgE8TST1N6DfdloLrfRep7VOZcaCIXQS+ZNQlZduHvh91O+w7sPtBuLEpF9Nar5//TPLtY4BGlHCFYAAAAAElFTkSuQmCC';

export function createTray() {
  // 按 2x 载入，Retina 上是 16pt 的清晰剪影；template image 由 macOS 自动适配明暗模式
  const icon = nativeImage.createFromBuffer(Buffer.from(TRAY_ICON_BASE64, 'base64'), { scaleFactor: 2 });
  icon.setTemplateImage(true);

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
