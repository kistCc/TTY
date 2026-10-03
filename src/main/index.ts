import { app, screen, systemPreferences, dialog, ipcMain } from 'electron';
import * as nodePath from 'path';

// 必须在任何代码读取 userData 之前执行：应用名和配置目录一起设为 TTY。
// 旧目录 ~/Library/Application Support/screen-translator 的配置由 migrateConfig() 迁移。
app.setName('TTY');
app.setPath('userData', nodePath.join(app.getPath('appData'), 'TTY'));
import { takeScreenshot } from './screenshot';
import { listWindows } from './ocr';
import { recognizeImage, translateRecognized } from './pipeline';
import { warmApple } from './providers/apple';
import { windowsOnDisplay } from './layout';
import { getConfig, saveConfig, migrateConfig, applyLoginItem } from './config';
import { debugLog, debugLogVerbose } from './native';
import { t, readableError } from './i18n';
import { ensureOverlayWindow, showOverlay, hideOverlay, isOverlayVisible, showLoading, hideLoading, showCancelled, setDismissCallback, discardCurrentScreenshot } from './overlay';
import { createTray, openSettings, setTranslateCallback, setHideCallback, setClearCacheCallback, setSelectionTranslateCallback, setInputTranslateCallback, setOverlayVisibleFn, updateTrayMenu, setLiveCallbacks } from './tray';
import { startHotkeyMonitor, stopHotkeyMonitor, restartWithHotkeys, sendHotkeyState, setHotkeyPermissionDeniedHandler, setHotkeyRegisterFailedHandler, setTextCallback, setInputCallback, setLiveCallback, setLiveDismiss, getHotkeyBackend } from './hotkey';
import { showSelectionTranslate, hideQuick } from './quick';
import { showInputTranslate, hideInput } from './input';
import { showSelection, cancelSelection, isSelectionActive } from './selection';
import { showRegionOverlay, closeAllRegionOverlays } from './region-overlay';
import { toggleLive, isLiveActive, isLiveRunning, stopLive, setLiveChangeCallback, setLiveHidden } from './live';
import * as fs from 'fs';

let isProcessing = false;
let isRegionProcessing = false;
let isCancelled = false;
let lastTriggerTime = 0;
let lastRegionTriggerTime = 0;
let activeProgressTimer: ReturnType<typeof setInterval> | null = null;
// Must not exceed COOLDOWN in scripts/hotkey-macos.m (1.0s), or a press the native
// monitor accepted can be dropped here and the two state machines drift apart.
const DEBOUNCE_MS = 1000;

/// 这几档不需要 API Key，启动时别拿"没填 Key"当理由弹设置窗。
const FREE_PROVIDERS = ['google', 'youdao', 'apple', 'ollama'];

// Tray app: don't quit when all windows are closed
app.on('window-all-closed', () => {
  // Do nothing — keep running in tray
});

// Translation cache: text hash → translated blocks (only saved manually via Shift+S)
const translationCache = new Map<string, { blocks: any[]; eraseRects?: any[]; keepRects?: any[] }>();
const MAX_CACHE_SIZE = 5;
let pendingCacheKey: string | null = null;
let pendingCacheBlocks: any[] | null = null;
let pendingCacheErase: any[] | undefined;
let pendingCacheKeep: any[] | undefined;

/// 全屏翻译键只管"开始翻译"。浮层已经开着时什么都不做——关浮层只认设置里的关闭键。
function toggleTranslate() {
  if (isOverlayVisible()) return;
  const now = Date.now();
  if (isProcessing || isRegionProcessing || now - lastTriggerTime < DEBOUNCE_MS) {
    // The native monitor already flipped itself into "translating" when it emitted
    // TRIGGERED. If we drop the press, push the real state back so the next press is
    // read as TRIGGERED rather than CANCEL.
    sendHotkeyState(isProcessing || isRegionProcessing ? 'TRANSLATING' : 'HIDDEN');
    return;
  }
  lastTriggerTime = now;
  handleTranslate();
}

app.whenReady().then(() => {
  // Hide dock icon — pure tray app, prevents Space switching
  app.dock?.hide();


  // Move any existing install off the old chord hotkeys before anything reads them,
  // so the permission-free backend can be used.
  migrateConfig();

  if (process.platform === 'darwin') {
    // Only the CGEventTap backend needs this. With simple combos the hotkeys go
    // through Carbon and no permission is involved, so don't nag about it.
    const needsInputMonitoring = !usingPermissionFreeHotkeys();
    if (needsInputMonitoring) {
      const trusted = systemPreferences.isTrustedAccessibilityClient(true);
      console.log(`Accessibility trusted: ${trusted}`);
      if (!trusted) {
        dialog.showMessageBoxSync({
          type: 'warning',
          title: t('inputMonitoringTitle'),
          message: t('inputMonitoringBody'),
          buttons: [t('btnOK')],
        });
      }
    }

    // Check Screen Recording permission
    const hasScreenAccess = systemPreferences.getMediaAccessStatus('screen');
    console.log(`Screen Recording: ${hasScreenAccess}`);
    if (hasScreenAccess !== 'granted') {
      dialog.showMessageBoxSync({
        type: 'warning',
        title: t('screenRecordingTitle'),
        message: t('screenRecordingBody'),
        buttons: [t('btnOpenSettings'), t('btnLater')],
      });
      // Try to open the settings pane
      const { exec } = require('child_process');
      exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"');
    }
  }

  // 贴图、小窗、框选窗口里的按键按设置匹配。用同步 IPC，每次按键都读最新的设置，
  // 在设置页改完不用重开窗口
  ipcMain.on('tty-keys', (event) => {
    const c = getConfig();
    event.returnValue = {
      dismissKey: c.dismissKey, copyImageKey: c.copyImageKey,
      copyTextKey: c.copyTextKey, peekKey: c.peekKey,
    };
  });

  createTray();
  ensureOverlayWindow(); // Pre-create for instant display

  const dismissOverlay = () => {
    if (isOverlayVisible()) {
      hideOverlay();
      sendHotkeyState('HIDDEN');
      pendingCacheKey = null;
      pendingCacheBlocks = null;
      isProcessing = false;
      updateTrayMenu();
    }
  };
  setDismissCallback(dismissOverlay);

  // 只有真正第一次启动才弹设置窗，让用户知道应用装好了；之后启动一律只驻留菜单栏。
  const bootConfig = getConfig();
  applyLoginItem(bootConfig.openAtLogin);
  if (!bootConfig.launchedBefore) {
    saveConfig({ launchedBefore: true });
    setTimeout(() => openSettings(), 500);
  }
  setTranslateCallback(() => {
    const now = Date.now();
    if (isProcessing || isRegionProcessing || isOverlayVisible() || now - lastTriggerTime < DEBOUNCE_MS) return;
    lastTriggerTime = now;
    handleTranslate().then(() => updateTrayMenu());
  });
  setHideCallback(() => {
    hideOverlay();
    sendHotkeyState('HIDDEN');
    updateTrayMenu();
  });
  setOverlayVisibleFn(isOverlayVisible);
  setTextCallback(() => { showSelectionTranslate(); });
  setInputCallback(() => { showInputTranslate(); });
  setSelectionTranslateCallback(() => { showSelectionTranslate(); });
  setInputTranslateCallback(() => { showInputTranslate(); });
  // 实时翻译：框选窗口和区域翻译共用，正在截屏翻译、正在框选时不开
  const liveToggle = () => {
    if (!isLiveActive() && (isProcessing || isRegionProcessing || isSelectionActive())) return;
    toggleLive().catch(e => console.error('[live]', e));
  };
  setLiveCallback(liveToggle);
  setLiveCallbacks(liveToggle, isLiveActive);
  // 实时翻译开着时，设置里的关闭键也能关它
  setLiveChangeCallback(() => { updateTrayMenu(); setLiveDismiss(isLiveRunning() ? stopLive : null); });
  setClearCacheCallback(() => {
    translationCache.clear();
    console.log('[cache] Cleared by user');
    showLoading(t('cacheCleared'));
    setTimeout(() => hideLoading(), 800);
  });

  setHotkeyRegisterFailedHandler((accelerators) => {
    dialog.showMessageBoxSync({
      type: 'warning',
      title: t('hotkeyUnavailableTitle'),
      message: t('hotkeyUnavailableBody', { keys: accelerators.join(', ') }),
      buttons: [t('btnOK')],
    });
  });

  setHotkeyPermissionDeniedHandler(() => {
    const { exec } = require('child_process');
    const choice = dialog.showMessageBoxSync({
      type: 'warning',
      title: t('inputMonitoringDeniedTitle'),
      message: t('inputMonitoringDeniedBody'),
      buttons: [t('btnOpenSettings'), t('btnLater')],
      defaultId: 0,
    });
    if (choice === 0) {
      exec('open "x-apple.systempreferences:com.apple.preference.security?Privacy_ListenEvent"');
    }
  });

  startHotkeyMonitor(
    // onTrigger
    () => { toggleTranslate(); },
    // onDismiss — overlay visible: close it; also cancel any in-progress selection
    () => {
      cancelSelection();
      if (isOverlayVisible()) {
        hideOverlay();
        sendHotkeyState('HIDDEN');
        pendingCacheKey = null;
        pendingCacheBlocks = null;
        isProcessing = false;
        isRegionProcessing = false;
        updateTrayMenu();
      }
    },
    // onSaveCache — save but keep overlay visible
    () => {
      if (isOverlayVisible() && pendingCacheKey && pendingCacheBlocks) {
        if (!translationCache.has(pendingCacheKey)) {
          if (translationCache.size >= MAX_CACHE_SIZE) {
            const firstKey = translationCache.keys().next().value;
            if (firstKey) translationCache.delete(firstKey);
          }
          translationCache.set(pendingCacheKey, { blocks: pendingCacheBlocks, eraseRects: pendingCacheErase, keepRects: pendingCacheKeep });
          console.log(`[cache] Saved (Shift+S), hash: ${pendingCacheKey}`);
        } else {
          console.log(`[cache] Already cached, hash: ${pendingCacheKey}`);
        }
        // Don't hide overlay — just show brief toast
        showLoading(t('cached'));
        setTimeout(() => hideLoading(), 800);
      }
    },
    // onCancel — 正在翻译时按了关闭键
    () => {
      cancelSelection();
      if (isProcessing) {
        isCancelled = true;
        if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; }
        showCancelled();
        isProcessing = false;
        isRegionProcessing = false;
        sendHotkeyState('HIDDEN');
        updateTrayMenu();
      }
      if (isRegionProcessing) {
        isRegionProcessing = false;
        hideLoading();
      }
    },
    // onRegion — 开始区域翻译。已经在框选时什么都不做：取消框选只认设置里的关闭键
    () => {
      if (isSelectionActive()) return;
      const now = Date.now();
      if (isProcessing || isRegionProcessing || now - lastRegionTriggerTime < DEBOUNCE_MS) return;
      lastRegionTriggerTime = now;
      handleRegionTranslate();
    },
    {
      trigger: getConfig().hotkey,
      dismiss: getConfig().dismissKey,
      cache: getConfig().cacheKey,
      region: getConfig().regionKey,
      text: getConfig().textKey,
      input: getConfig().inputKey,
      live: getConfig().liveKey,
    }
  );

  const config = getConfig();
  console.log(
    `TTY started. Hotkey: ${config.hotkey} ` +
    `(backend: ${getHotkeyBackend()}${getHotkeyBackend() === 'global' ? ', no permission needed' : ', needs Input Monitoring'})`
  );
  // 免费的几档不需要 API Key；只有选了要付费的服务却没填 Key 时才弹设置窗。
  const providerConf = config.providers[config.provider];
  if (!providerConf?.apiKey && !FREE_PROVIDERS.includes(config.provider)) {
    openSettings();
  }

  // Settings via tray icon only (dock is hidden)
});

async function handleTranslate() {
  debugLog('=== 全屏翻译开始 ===');
  isProcessing = true;
  isCancelled = false;
  sendHotkeyState('TRANSLATING');
  const config = getConfig();
  if (config.provider === 'apple') warmApple(config.targetLanguage || 'zh-CN');

  try {
    // Detect which display the cursor is on — translate that screen, not always primary
    const cursorPoint = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPoint);
    const scaleFactor = display.scaleFactor;

    // Screenshot — hide any UI first so it doesn't get captured
    hideQuick();
    hideInput();
    hideLoading();
    setLiveHidden(true);
    // 等浮层真正从屏幕上消失再截屏。100ms 够一帧合成，再长就是白等。
    await new Promise(r => setTimeout(r, 100));
    const [screenshotPath, windows] = await Promise.all([takeScreenshot(display.bounds), listWindows()])
      .finally(() => setLiveHidden(false));
    debugLogVerbose(`窗口 ${windows.length} 个: ${windows.map(w => `${Math.round(w.x)},${Math.round(w.y)} ${Math.round(w.width)}x${Math.round(w.height)}`).join(' | ')}`);
    try {
      debugLog(`截图 ${screenshotPath} ${fs.statSync(screenshotPath).size} 字节, 显示器 ${display.bounds.width}x${display.bounds.height} @${scaleFactor}x`);
    } catch (e) { debugLog(`截图失败: ${e}`); }
    showLoading(t('processing', { n: 15 }));
    if (isCancelled) { if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; }; cleanup(screenshotPath); return; }

    showLoading(t('detecting', { n: 25 }));
    const targetLang = config.targetLanguage || 'zh-CN';
    const rec = await recognizeImage(screenshotPath, scaleFactor, display.bounds.width, targetLang, windowsOnDisplay(windows, display.bounds));
    showLoading(t('analyzing', { n: 40 }));
    if (isCancelled) { if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; }; cleanup(screenshotPath); return; }

    if (rec.cssBlocks.length === 0) {
      debugLog('一个文本块都没有，结束');
      if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; }
      hideLoading(); cleanup(screenshotPath); return;
    }

    const hash = rec.hash;
    if (translationCache.has(hash)) {
      console.log('[cache] HIT');
      if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; }
      hideLoading();
      const cached = translationCache.get(hash)!;
      pendingCacheKey = hash;
      pendingCacheBlocks = cached.blocks;
      pendingCacheErase = cached.eraseRects;
      pendingCacheKeep = cached.keepRects;
      showOverlay({ screenshotPath, blocks: cached.blocks, eraseRects: cached.eraseRects, keepRects: cached.keepRects, displayBounds: display.bounds });
      sendHotkeyState('SHOWN');
      updateTrayMenu();
      return;
    }

    if (rec.paragraphs.length === 0) {
      if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; }
      hideLoading(); cleanup(screenshotPath); return;
    }

    // Translate
    console.log(`[translate] ${rec.paragraphs.length} blocks via ${config.provider}...`);
    let tp = 45;
    activeProgressTimer = setInterval(() => {
      if (tp < 95) {
        const speed = tp < 85 ? (85 - tp) * 0.08 : (95 - tp) * 0.02;
        tp += Math.max(0.3, speed);
        showLoading(t('translatingPct', { n: Math.floor(tp) }));
      }
    }, 400);
    const { blocks: translatedBlocks, eraseRects, keepRects } = await translateRecognized(rec, targetLang, config);
    if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; }
    if (isCancelled) { cleanup(screenshotPath); return; }

    // Store pending cache — only saved if user presses Shift+S
    pendingCacheKey = hash;
    pendingCacheBlocks = translatedBlocks;
    pendingCacheErase = eraseRects;
    pendingCacheKeep = keepRects;

    // Don't cleanup screenshotPath here — renderer needs the file for background
    debugLog(`显示浮层，${translatedBlocks.length} 块`);
    showOverlay({ screenshotPath, blocks: translatedBlocks, eraseRects, keepRects, displayBounds: display.bounds });
    sendHotkeyState('SHOWN');
    updateTrayMenu();
  } catch (err: any) {
    if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; };
    console.error('Translation failed:', err);
    debugLog(`翻译流程抛错: ${err?.stack || err?.message || err}`);
    showLoading(t('error', { msg: readableError(err) }));
    setTimeout(() => hideLoading(), 3000);
  } finally {
    if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; };
    isProcessing = false;
    // Every exit path that did not end with an overlay on screen must clear the native
    // monitor's state, or the next press is read as CANCEL: no text found, everything
    // filtered out, cancelled, or any thrown error.
    if (!isOverlayVisible()) sendHotkeyState('HIDDEN');
  }
}

/// True when both triggers are simple combos, i.e. the permission-free Carbon path
/// can serve them and no CGEventTap is needed.
function usingPermissionFreeHotkeys(): boolean {
  const { parseSlot, isSimpleCombo, HOTKEY_DEFAULTS } = require('./hotkey');
  const c = getConfig();
  return isSimpleCombo(parseSlot(c.hotkey, HOTKEY_DEFAULTS.trigger))
    && isSimpleCombo(parseSlot(c.regionKey, HOTKEY_DEFAULTS.region));
}


async function handleRegionTranslate() {
  const config = getConfig();
  if (config.provider === 'apple') warmApple(config.targetLanguage || 'zh-CN');
  isRegionProcessing = true;
  try {
    // 实时翻译开着时先把它藏起来、等一帧合成，框选用的那张截图里才不会带着它的译文
    if (isLiveActive()) { setLiveHidden(true); await new Promise(r => setTimeout(r, 80)); }
    const selection = await showSelection().finally(() => setLiveHidden(false));
    if (!selection) { isRegionProcessing = false; return; } // user cancelled

    isCancelled = false;
    showLoading(t('translatingPct', { n: 20 }));

    // Crop the pre-captured frozen screenshot to the selection region
    // (the user sees the frozen image in the selection window, so we must use the same pixels)
    const scaleFactor = screen.getDisplayNearestPoint({ x: selection.x, y: selection.y }).scaleFactor;
    const { nativeImage } = require('electron');
    const fullImg = nativeImage.createFromPath(selection.screenshotPath);
    const localX = selection.x - selection.displayBounds.x; // CSS pixels within display
    const localY = selection.y - selection.displayBounds.y;
    const cropped = fullImg.crop({
      x: Math.round(localX * scaleFactor),
      y: Math.round(localY * scaleFactor),
      width: Math.round(selection.width * scaleFactor),
      height: Math.round(selection.height * scaleFactor),
    });
    const os = require('os');
    const screenshotPath = require('path').join(os.tmpdir(), `region-${Date.now()}.png`);
    fs.writeFileSync(screenshotPath, cropped.toPNG());
    cleanup(selection.screenshotPath); // discard full display screenshot

    showLoading(t('translatingPct', { n: 40 }));
    const targetLang = config.targetLanguage || 'zh-CN';
    const rec = await recognizeImage(screenshotPath, scaleFactor, selection.width, targetLang);
    if (rec.paragraphs.length === 0) {
      hideLoading();
      cleanup(screenshotPath);
      return;
    }

    showLoading(t('translatingPct', { n: 70 }));
    const { blocks: translatedBlocks, eraseRects, keepRects } = await translateRecognized(rec, targetLang, config);

    hideLoading();
    showRegionOverlay({
      screenshotPath,
      blocks: translatedBlocks,
      eraseRects,
      keepRects,
      regionX: selection.x,
      regionY: selection.y,
      regionWidth: selection.width,
      regionHeight: selection.height,
    });
  } catch (err: any) {
    console.error('[region] Translation failed:', err);
    showLoading(t('error', { msg: readableError(err) }));
    setTimeout(() => hideLoading(), 3000);
  } finally {
    isRegionProcessing = false;
  }
}

function cleanup(filepath: string) {
  try { fs.unlinkSync(filepath); } catch {}
}

app.on('will-quit', () => {
  stopHotkeyMonitor();
  // 退出时兜底：别把最后一张整屏截图留在 /var/folders 里
  discardCurrentScreenshot();
});
