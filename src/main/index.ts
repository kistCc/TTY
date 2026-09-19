import { app, screen, systemPreferences, dialog } from 'electron';
import * as nodePath from 'path';

// 必须在任何代码读取 userData 之前执行：应用名和配置目录一起设为 TTY。
// 旧目录 ~/Library/Application Support/screen-translator 的配置由 migrateConfig() 迁移。
app.setName('TTY');
app.setPath('userData', nodePath.join(app.getPath('appData'), 'TTY'));
import { takeScreenshot } from './screenshot';
import { performOCR, performOCRSplit, TextBlock } from './ocr';
import { getAccessibilityText, AXTextBlock } from './accessibility';
import { translate } from './translator';
import { getConfig, saveConfig, migrateConfig, applyLoginItem } from './config';
import { debugLog, debugLogVerbose } from './native';
import { joinParts as joinLines } from './text-join';
import { t } from './i18n';
import { ensureOverlayWindow, showOverlay, hideOverlay, isOverlayVisible, showLoading, hideLoading, showCancelled, setDismissCallback, discardCurrentScreenshot } from './overlay';
import { createTray, openSettings, setTranslateCallback, setHideCallback, setClearCacheCallback, setSelectionTranslateCallback, setClipboardTranslateCallback, setOverlayVisibleFn, updateTrayMenu } from './tray';
import { startHotkeyMonitor, stopHotkeyMonitor, restartWithHotkeys, sendHotkeyState, setHotkeyPermissionDeniedHandler, setHotkeyRegisterFailedHandler, setTextCallback, setClipCallback, getHotkeyBackend } from './hotkey';
import { showSelectionTranslate, showClipboardTranslate, hideQuick } from './quick';
import { showSelection, cancelSelection, isSelectionActive } from './selection';
import { showRegionOverlay, closeAllRegionOverlays } from './region-overlay';
import * as fs from 'fs';
import * as crypto from 'crypto';

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
const FREE_PROVIDERS = ['google', 'youdao', 'ollama'];

// Tray app: don't quit when all windows are closed
app.on('window-all-closed', () => {
  // Do nothing — keep running in tray
});

// Translation cache: text hash → translated blocks (only saved manually via Shift+S)
const translationCache = new Map<string, { blocks: any[] }>();
const MAX_CACHE_SIZE = 5;
let pendingCacheKey: string | null = null;
let pendingCacheBlocks: any[] | null = null;

function toggleTranslate() {
  if (isOverlayVisible()) {
    hideOverlay();
    sendHotkeyState('HIDDEN');
    pendingCacheKey = null;
    pendingCacheBlocks = null;
    updateTrayMenu();
    return;
  }
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
  setClipCallback(() => { showClipboardTranslate(); });
  setSelectionTranslateCallback(() => { showSelectionTranslate(); });
  setClipboardTranslateCallback(() => { showClipboardTranslate(); });
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
          translationCache.set(pendingCacheKey, { blocks: pendingCacheBlocks });
          console.log(`[cache] Saved (Shift+S), hash: ${pendingCacheKey}`);
        } else {
          console.log(`[cache] Already cached, hash: ${pendingCacheKey}`);
        }
        // Don't hide overlay — just show brief toast
        showLoading(t('cached'));
        setTimeout(() => hideLoading(), 800);
      }
    },
    // onCancel — ESC or re-trigger during translating
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
    // onRegion — toggle: if selection is open, close it; otherwise start region translate
    () => {
      // Already in selection mode — close it (toggle off)
      if (isSelectionActive()) {
        cancelSelection();
        isRegionProcessing = false;
        return;
      }
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
      clip: getConfig().clipKey,
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

  try {
    // Capture frontmost app PID before showing any UI (for AX to query the right app)
    const { execSync } = require('child_process');
    let frontPid = 0;
    try {
      const pidStr = execSync("osascript -e 'tell application \"System Events\" to unix id of first process whose frontmost is true'", { timeout: 1000 }).toString().trim();
      frontPid = parseInt(pidStr, 10) || 0;
    } catch {}

    // Detect which display the cursor is on — translate that screen, not always primary
    const cursorPoint = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(cursorPoint);
    const scaleFactor = display.scaleFactor;

    // Screenshot — hide any UI first so it doesn't get captured
    hideQuick();
    hideLoading();
    // 等浮层真正从屏幕上消失再截屏。100ms 够一帧合成，再长就是白等。
    await new Promise(r => setTimeout(r, 100));
    const screenshotPath = await takeScreenshot(display.bounds);
    try {
      debugLog(`截图 ${screenshotPath} ${fs.statSync(screenshotPath).size} 字节, 显示器 ${display.bounds.width}x${display.bounds.height} @${scaleFactor}x`);
    } catch (e) { debugLog(`截图失败: ${e}`); }
    showLoading(t('processing', { n: 15 }));
    if (isCancelled) { if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; }; cleanup(screenshotPath); return; }

    showLoading(t('detecting', { n: 25 }));
    const [ocrBlocks, axBlocks] = await Promise.all([
      performOCRSplit(screenshotPath), // split large images into quadrants for better accuracy
      getAccessibilityText(frontPid),
    ]);
    showLoading(t('analyzing', { n: 40 }));
    if (isCancelled) { if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; }; cleanup(screenshotPath); return; }

    const textBlocks = refineWithAccessibility(ocrBlocks, axBlocks, scaleFactor, display.bounds);
    console.log(`[detect] OCR: ${ocrBlocks.length}, AX: ${axBlocks.length}, refined: ${textBlocks.length}`);
    debugLog(`识别：OCR ${ocrBlocks.length} 块, AX ${axBlocks.length} 块, 合并后 ${textBlocks.length} 块`);
    if (ocrBlocks.length) debugLog(`OCR 头几条: ${ocrBlocks.slice(0, 5).map(b => b.text).join(' | ')}`);
    for (const b of ocrBlocks) {
      debugLogVerbose(`  原始块 ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} c=${b.confidence.toFixed(2)} | ${b.text}`);
    }

    if (textBlocks.length === 0) {
      debugLog('一个文本块都没有，结束');
      if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; }
      hideLoading(); cleanup(screenshotPath); return;
    }

    // Convert OCR physical pixel coords → CSS pixels using exact scaleFactor
    const cssBlocks = textBlocks.map(b => ({
      ...b,
      x: b.x / scaleFactor,
      y: b.y / scaleFactor,
      width: b.width / scaleFactor,
      height: b.height / scaleFactor,
    }));

    // Cache by text content
    const textKey = cssBlocks.map(b => b.text).sort().join('|');
    const hash = crypto.createHash('md5').update(textKey).digest('hex');

    if (translationCache.has(hash)) {
      console.log('[cache] HIT');
      if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; }
      hideLoading();
      const cachedBlocks = translationCache.get(hash)!.blocks;
      pendingCacheKey = hash;
      pendingCacheBlocks = cachedBlocks;
      showOverlay({ screenshotPath, blocks: cachedBlocks, displayBounds: display.bounds });
      sendHotkeyState('SHOWN');
      updateTrayMenu();
      return;
    }

    // Filter
    const targetLang = config.targetLanguage || 'zh-CN';
    const blocksToTranslate = filterForeignBlocks(cssBlocks, targetLang);
    console.log(`[filter] ${blocksToTranslate.length} blocks to translate`);
    debugLog(`过滤后剩 ${blocksToTranslate.length} 块要翻译（目标语言 ${targetLang}）`);
    if (blocksToTranslate.length === 0) {
      if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; }
      hideLoading(); cleanup(screenshotPath); return;
    }

    const paragraphs = groupIntoParagraphs(dropDuplicateBoxes(dropLowConfidenceOverlaps(dropUndersizedBoxes(dropOversizedBoxes(blocksToTranslate)))), display.bounds.width);
    if (paragraphs.length !== blocksToTranslate.length) {
      debugLog(`按版面并段：${blocksToTranslate.length} 行 → ${paragraphs.length} 段`);
    }

    // Translate
    console.log(`[translate] ${paragraphs.length} blocks via ${config.provider}...`);
    let tp = 45;
    activeProgressTimer = setInterval(() => {
      if (tp < 95) {
        const speed = tp < 85 ? (85 - tp) * 0.08 : (95 - tp) * 0.02;
        tp += Math.max(0.3, speed);
        showLoading(t('translatingPct', { n: Math.floor(tp) }));
      }
    }, 400);
    const texts = paragraphs.map(b => b.text);
    const translations = await translate(texts, targetLang, config);
    debugLog(`翻译回来 ${translations.length} 条`);
    paragraphs.forEach((b, i) => debugLog(
      `  [${i}] ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} ${b.lineCount}行\n` +
      `      原: ${b.text}\n      译: ${translations[i] ?? ''}`
    ));
    if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; }
    if (isCancelled) { cleanup(screenshotPath); return; }

    // 没翻出来的段落（接口失败、返回空）一个都别画：照原文画上去就是"英文盖英文"，
    // 字号还不一定对；擦掉又只剩一片空白。干脆原样留着，看着是没翻，至少不是坏的。
    const failed = paragraphs.filter((_, i) => !translations[i]);
    if (failed.length) debugLog(`有 ${failed.length} 段没翻出来，保持原文不动`);
    const translatedBlocks = paragraphs
      .map((block, i) => ({ ...block, translated: translations[i] || '' }))
      .filter(b => b.translated);

    // Store pending cache — only saved if user presses Shift+S
    pendingCacheKey = hash;
    pendingCacheBlocks = translatedBlocks;

    // Show — instant because window is pre-created
    // Don't cleanup screenshotPath here — renderer needs the file for background
    debugLog(`显示浮层，${translatedBlocks.length} 块`);
    // eraseRects 是并段之前的原始块：先按它们把原文全部擦掉，再画译文。
    // 否则没并进任何段落的碎块会把英文留在屏幕上。
    showOverlay({
      screenshotPath,
      blocks: translatedBlocks,
      eraseRects: cssBlocks
        .filter(r => !failed.some(f => rectOverlapRatio(f, r) > 0.5))
        .map(b => ({ x: b.x, y: b.y, width: b.width, height: b.height })),
      displayBounds: display.bounds,
    });
    sendHotkeyState('SHOWN');
    updateTrayMenu();
  } catch (err: any) {
    if (activeProgressTimer) { clearInterval(activeProgressTimer); activeProgressTimer = null; };
    console.error('Translation failed:', err);
    debugLog(`翻译流程抛错: ${err?.stack || err?.message || err}`);
    const msg = err?.message || String(err);
    showLoading(t('error', { msg: msg.slice(0, 80) }));
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

function filterForeignBlocks(blocks: TextBlock[], targetLang: string): TextBlock[] {
  const targetPrefix = targetLang.split('-')[0];

  return blocks.filter(block => {
    const text = block.text.trim();
    if (!text) return false;
    // 只挡掉 OCR 基本没看清的；宁可多翻一块，也别把英文留在屏幕上
    if (block.confidence < 0.05) return false;


    if (/^[\d\s.,:;!?@#$%^&*()\-+=<>{}[\]|/\\~`'"•●○◆★☆✓✗→←↑↓©®™℃°…]+$/.test(text)) return false;
    if (/^https?:\/\//.test(text)) return false;
    if (/^\.\w{1,4}$/.test(text)) return false;
    if (/^[0-9a-f]{6,}$/i.test(text)) return false;
    if (/^[\d.]+[KMGTkmgt]?[Bb]?\/s?$/.test(text)) return false;
    // 单个字母、单个符号翻了也没意义；两个字母以上一律翻
    if (!/[a-zA-Z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{2}/.test(text)) return false;

    if (targetPrefix === 'zh') {
      const chineseChars = text.match(/[\u4e00-\u9fff]/g)?.length || 0;
      return chineseChars / text.length < 0.5;
    }
    if (targetPrefix === 'ja') {
      const jpChars = text.match(/[\u3040-\u30ff\u4e00-\u9fff]/g)?.length || 0;
      return jpChars / text.length < 0.5;
    }
    if (targetPrefix === 'ko') {
      const koChars = text.match(/[\uac00-\ud7af]/g)?.length || 0;
      return koChars / text.length < 0.5;
    }
    const latinChars = text.match(/[a-zA-Z]/g)?.length || 0;
    if (['en', 'fr', 'de', 'es', 'pt', 'it'].includes(targetPrefix)) {
      return latinChars / text.length < 0.5;
    }
    return true;
  });
}

/// 一段话的每一行分别送去翻译，翻译器看不到上下文，"Plan usage limits" 会被当成
/// 祈使句译成"规划使用限制"；断句还常常跨行，译文就更乱。所以翻译前先按版面把
/// 连续的行并成段：整段一次翻译，再整段贴回去。
/// 同一段的判定：行距不超过一行高、左边缘对齐、字号接近、水平范围有重叠。
export interface ParagraphBlock extends TextBlock {
  /// 段内代表行高，渲染时按它定字号
  lineHeight: number;
  /// 段内原有几行，1 就是普通单行块
  lineCount: number;
}

function groupIntoParagraphs(blocks: TextBlock[], screenWidth: number): ParagraphBlock[] {
  const out: ParagraphBlock[] = [];
  for (const column of splitIntoColumns(blocks, screenWidth)) {
    const lines = clusterIntoLines(column, screenWidth);
    for (const l of lines) {
      debugLogVerbose(`  行 ${Math.round(l.x)},${Math.round(l.y)} ${Math.round(l.width)}x${Math.round(l.height)} | ${l.text}`);
    }
    out.push(...dropSwallowed(groupLinesIntoParagraphs(lines)));
  }
  return out;
}

/// 先按"竖直空白带"把整屏切成几栏，再分别聚行并段。
///
/// 空白带 = 从屏幕顶到底都没有任何文字盖到的一段 x 区间。并排的两个窗口、
/// 分栏排版的正文之间一定留着这样一条带子；而一行中间漏掉几个词只是这一行上的
/// 空当，别的行会把那段 x 盖住，不会形成带子。
///
/// 这条比"两块之间的空当有多宽"可靠得多：实测同一行里漏词造成的空当（49px）
/// 和隔壁窗口的间距（51px）差不多宽，光看空当根本分不开，分完栏就一点都不含糊。
function splitIntoColumns(blocks: TextBlock[], screenWidth: number): TextBlock[][] {
  if (blocks.length < 8 || screenWidth <= 0) return [blocks];
  const BUCKET = 4;
  const n = Math.ceil(screenWidth / BUCKET) + 1;
  const covered = new Uint8Array(n);
  for (const b of blocks) {
    const from = Math.max(0, Math.floor(b.x / BUCKET));
    const to = Math.min(n - 1, Math.ceil((b.x + b.width) / BUCKET));
    for (let i = from; i <= to; i++) covered[i] = 1;
  }

  // 太窄的空白带不算分栏（可能只是段落缩进凑巧对齐）
  const minGutter = Math.max(24, screenWidth * 0.012);
  const cuts: number[] = [];
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const isBlank = i < n && !covered[i];
    if (isBlank) { if (runStart < 0) runStart = i; continue; }
    if (runStart >= 0) {
      // 贴着屏幕左右边缘的空白是页边距，不是栏与栏之间的带子
      const touchesEdge = runStart === 0 || i >= n;
      if (!touchesEdge && (i - runStart) * BUCKET >= minGutter) cuts.push(((runStart + i) / 2) * BUCKET);
      runStart = -1;
    }
  }
  if (!cuts.length) return [blocks];

  const columns: TextBlock[][] = Array.from({ length: cuts.length + 1 }, () => []);
  for (const b of blocks) {
    const center = b.x + b.width / 2;
    let k = 0;
    while (k < cuts.length && center > cuts[k]) k++;
    columns[k].push(b);
  }
  const kept = columns.filter(c => c.length);
  if (kept.length > 1) debugLogVerbose(`  分栏：${kept.length} 栏，切点 ${cuts.map(c => Math.round(c)).join(', ')}`);
  return kept;
}

/// 象限重叠处偶尔会多出一小块（"are only" 这种半截），它整个落在某个段落的框里，
/// 画上去就是一团压在段落上的字。被大块几乎整个包住的小块直接丢掉。
/// 只丢"几乎完全被包住"的，普通的相邻、部分交叠一律保留——上一版按交叠面积丢，
/// 结果把同一段里的行也丢了，整段少了半截。
function dropSwallowed(paragraphs: ParagraphBlock[]): ParagraphBlock[] {
  const norm = (s: string) => s.replace(/\s+/g, ' ').trim().toLowerCase();
  return paragraphs.filter((b, i) =>
    !paragraphs.some((other, j) => {
      if (i === j) return false;
      const bArea = b.width * b.height;
      const otherArea = other.width * other.height;
      if (otherArea <= bArea) return false;
      // 内容判据：这一块的文字整句都在另一段里出现过，画上去只是把那段盖住一遍
      const bText = norm(b.text);
      if (bText.length >= 12 && norm(other.text).includes(bText)) return true;
      // 几何判据：只针对"整个落在多行段落里的小块"。这类要么是碎片，要么是 OCR
      // 吐出的跨行大框，留着只会压在段落上。
      if (b.lineCount > 2 || other.lineCount < 2) return false;
      const ix = Math.max(0, Math.min(b.x + b.width, other.x + other.width) - Math.max(b.x, other.x));
      const iy = Math.max(0, Math.min(b.y + b.height, other.y + other.height) - Math.max(b.y, other.y));
      return bArea > 0 && (ix * iy) / bArea > 0.6;
    })
  );
}

/// 第一步：把块并成"行"。OCR 会把一行切成好几段（短语之间的空当稍大就会切开），
/// 这些块垂直中心几乎一样，先只按中心聚成行，行内再按 x 从左到右串起来。
///
/// 一定要先聚行、再按 x 排序：块到达的顺序是按垂直中心排的，行内前后乱序，
/// 拿"新块到当前行右边界"的距离去判断远近会算出假的大间隔，一行就散成一堆碎块。
function clusterIntoLines(blocks: TextBlock[], screenWidth: number): TextBlock[] {
  const sorted = [...blocks].sort((a, b) => (a.y + a.height / 2) - (b.y + b.height / 2));
  const rows: TextBlock[][] = [];
  // 容差要用整屏行高的中位数封顶。直接拿两个框里高的那个算，只要 OCR 吐出一个
  // 跨两行的高框，容差就大过一整行行距，隔壁行会被吸进同一行，左右一串就是
  // "their vertical center, L he ter, soreandrome tot size" 这种乱码。
  const medianH = medianHeight(blocks);

  for (const b of sorted) {
    const center = b.y + b.height / 2;
    const row = rows[rows.length - 1];
    if (row) {
      const refCenter = row[0].y + row[0].height / 2;
      const ref = Math.min(Math.max(row[0].height, b.height), medianH * 1.2);
      if (Math.abs(center - refCenter) < ref * 0.55) { row.push(b); continue; }
    }
    rows.push([b]);
  }

  // 行内按 x 串起来；空当特别大的地方断开——那通常是另一栏、另一个窗口，
  // 不是同一句话。普通短语之间的空当只有几十像素，这个阈值放得宽一些。
  const lines: TextBlock[] = [];
  for (const row of rows) {
    const parts = [...row].sort((a, b) => a.x - b.x);
    let segment: TextBlock[] = [];
    const flushSegment = () => {
      if (!segment.length) return;
      lines.push(mergeParts(segment));
      segment = [];
    };
    for (const part of parts) {
      const prev = segment[segment.length - 1];
      if (prev) {
        // 空当明显超过一个词距就断开：那通常是另一栏、另一个窗口，不是同一句话。
        // 阈值不能太窄：OCR 经常漏掉行中间的一两个词（"content. [If you] reasonably
        // object..."），留下的空当有三四个字高，按 2.5 倍判就把一行劈成两半了。
        const gap = part.x - (prev.x + prev.width);
        const limit = Math.max(prev.height, part.height) * 4;
        if (gap > limit) flushSegment();
      }
      segment.push(part);
    }
    flushSegment();
  }
  return lines;
}

function mergeParts(parts: TextBlock[]): TextBlock {
  const x = Math.min(...parts.map(b => b.x));
  const y = Math.min(...parts.map(b => b.y));
  const right = Math.max(...parts.map(b => b.x + b.width));
  const bottom = Math.max(...parts.map(b => b.y + b.height));
  // 行高别让个别偏高的框（带下划线的词、带括号的词）顶上去：一行的高度一旦
  // 虚高，后面按"字号接近"判同段时，正常高度的下一行就会被判成不同段。
  const cap = medianHeight(parts) * 1.4;
  return {
    text: joinLines(parts.map(b => b.text)),
    confidence: Math.min(...parts.map(b => b.confidence)),
    x, y, width: right - x, height: Math.min(bottom - y, cap),
  };
}

/// 段内代表行高取中位数。取最大值的话，只要有一个框被 OCR 画高了，
/// 整段字号就会被顶上去，画出来是一坨压在别的段落上的大字。
function medianHeight(lines: TextBlock[]): number {
  const hs = lines.map(b => b.height).sort((a, b) => a - b);
  return hs[Math.floor(hs.length / 2)];
}

/// 第二步：把行并成"段"。行距不超过一行高、左边缘对齐、字号接近就算同一段。
function groupLinesIntoParagraphs(lines: TextBlock[]): ParagraphBlock[] {
  const sorted = [...lines].sort((a, b) => (a.y - b.y) || (a.x - b.x));
  // 同一时刻允许有好几个没写完的段。整屏上左边是正文、右边是另一个窗口，
  // 两边的行按 y 交替到达；只留一个"当前段"的话，右边来一行就把左边的段截断，
  // 正文第一行会被单独剩下。每来一行先找一个最贴合的段接上去，找不到才另起一段。
  const groups: TextBlock[][] = [];

  for (const line of sorted) {
    let bestIdx = -1;
    let bestPitch = Infinity;
    for (let i = 0; i < groups.length; i++) {
      const last = groups[i][groups[i].length - 1];
      // 用"行距"（两行中心的距离）判断，不用"框之间的空当"。密排正文里字框几乎贴着，
      // 空当本来就接近 0，空一行也才多出半个字高——按空当判会把标题和下一段吸进上一段。
      // 行距则很干脆：同段约等于一倍行高，空一行直接翻倍。
      const pitch = (line.y + line.height / 2) - (last.y + last.height / 2);
      if (pitch < 0 || pitch > Math.max(last.height, line.height) * 1.45) continue;
      // 行距接近 0 = 本来就是同一条视觉行（行内被断开的两段），无条件接上，
      // 不看左边缘也不看字号——否则它们会各自成段，然后在同一个位置互相压着画。
      const sameVisualLine = pitch < Math.min(last.height, line.height) * 0.5;
      if (sameVisualLine) { if (pitch < bestPitch) { bestPitch = pitch; bestIdx = i; } continue; }
      if (line.height > last.height * 1.5 || line.height < last.height * 0.66) continue;
      // 左边缘对齐是"同一段"的常见特征，但密排正文里 OCR 常把一行的开头单独切走，
      // 剩下的那块就从半路开始，左边缘对不上，整段被拆得七零八落、还互相压着画。
      // 所以左边缘对不上时再看"横向是否落在同一栏"：两行的横向区间大幅重叠也算同段。
      // 分栏、分窗口的文字横向不重叠，不会被误并。
      const overlapX = Math.min(line.x + line.width, last.x + last.width) - Math.max(line.x, last.x);
      const sameColumn = overlapX > Math.min(line.width, last.width) * 0.6;
      if (Math.abs(line.x - last.x) > last.height * 1.5 && !sameColumn) continue;
      if (pitch < bestPitch) { bestPitch = pitch; bestIdx = i; }
    }
    if (bestIdx >= 0) groups[bestIdx].push(line);
    else groups.push([line]);
  }

  return groups.map(group => {
    const x = Math.min(...group.map(b => b.x));
    const y = Math.min(...group.map(b => b.y));
    const right = Math.max(...group.map(b => b.x + b.width));
    const bottom = Math.max(...group.map(b => b.y + b.height));
    return {
      text: joinLines(group.map(b => b.text)),
      confidence: Math.min(...group.map(b => b.confidence)),
      x, y, width: right - x, height: bottom - y,
      lineHeight: medianHeight(group),
      lineCount: group.length,
    };
  });
}


/// Vision 偶尔会把一行只认出半个字高——框高只有整屏行高中位数的一半，
/// 认出来的字也跟着缺一半：reflow it, measure it, or translate it ... 会变成
/// "ret low 1t. measure lt. or translate lt as a sınole unıt ratner tan quessına"。
/// 这种半高框翻出来必然是乱码，贴上去比留着原文更难看，直接丢掉。
/// 阈值取整屏行高中位数的 0.6 倍：正常的小字号说明文字不会小到正文的六成以下，
/// 真掉了一两块小字也比贴一行乱码强。渲染层还另有一个字号下限兜底。
function dropUndersizedBoxes(blocks: TextBlock[]): TextBlock[] {
  if (blocks.length < 6) return blocks;
  const median = medianHeight(blocks);
  return blocks.filter(b => b.height >= median * 0.6);
}

/// OCR 对同一片像素偶尔会多吐一个"糊在一起"的框：字是错的、高度跨了两行，
/// 置信度也明显低于旁边的正常块（实测 0.5 对 1.0）。它和正常块叠在一起，
/// 一行串下来就是 "their vertical center, L he ter, soreandrome tot size" 这种乱码。
/// 判据：置信度偏低，而且压在一个高置信度的块上——正常版面里文字框互不重叠，
/// 所以不会误伤真正认得出的低置信度文字（那种一般是孤立的小字）。
function dropLowConfidenceOverlaps(blocks: TextBlock[]): TextBlock[] {
  return blocks.filter(b => {
    if (b.confidence >= 0.7) return true;
    const bArea = b.width * b.height;
    if (bArea <= 0) return true;
    return !blocks.some(other => {
      if (other === b || other.confidence < 0.9) return false;
      const ix = Math.max(0, Math.min(b.x + b.width, other.x + other.width) - Math.max(b.x, other.x));
      const iy = Math.max(0, Math.min(b.y + b.height, other.y + other.height) - Math.max(b.y, other.y));
      return ix > 0 && iy > 0 && (ix * iy) / bArea > 0.2;
    });
  });
}

/// OCR 有时会对同一片像素给出好几个互相重叠的框：一个把两三行糊在一起、还认错不少字，
/// 旁边又有每行各自的正常框。两种都留着，串起来就是
/// "their vertical center, L he ter, soreandrome tot size" 这样的乱码。
/// 判据：一个框六成以上的面积被"更可信的框"盖住，就丢掉它。
/// 更可信 = 置信度更高，或者置信度相当但明显更矮（更像单行，而不是糊在一起的复合框）。
/// 正常版面里文字框互不重叠，所以这条不会误伤。
function dropDuplicateBoxes(blocks: TextBlock[]): TextBlock[] {
  if (blocks.length < 2) return blocks;
  return blocks.filter(b => {
    const bArea = b.width * b.height;
    if (bArea <= 0) return true;
    let covered = 0;
    for (const other of blocks) {
      if (other === b) continue;
      const ix = Math.max(0, Math.min(b.x + b.width, other.x + other.width) - Math.max(b.x, other.x));
      const iy = Math.max(0, Math.min(b.y + b.height, other.y + other.height) - Math.max(b.y, other.y));
      if (ix <= 0 || iy <= 0) continue;
      const better = other.confidence > b.confidence + 0.02
        || (Math.abs(other.confidence - b.confidence) <= 0.02 && other.height < b.height * 0.8);
      if (better) covered += ix * iy;
    }
    return covered / bArea < 0.6;
  });
}

/// OCR 偶尔会给一整段吐一个跨好几行的大框，里面的文字是几行糊在一起的，
/// 常常还认错字。这种框和正常行块压在一起，翻出来就是一团盖住段落的乱码。
/// 判据：框高明显超出整屏行高的常态，而且和别的块重叠——正常的大标题不会
/// 压在别的文字上，所以不会被误伤。
function dropOversizedBoxes(blocks: TextBlock[]): TextBlock[] {
  if (blocks.length < 4) return blocks;
  const heights = blocks.map(b => b.height).sort((a, b) => a - b);
  const median = heights[Math.floor(heights.length / 2)];
  const limit = median * 1.7;

  return blocks.filter(b => {
    if (b.height <= limit) return true;
    const bText = b.text.replace(/\s+/g, ' ').trim();
    return !blocks.some(other => {
      if (other === b) return false;
      if (rectOverlapRatio(b, other) > 0.5) return true;
      // 内容判据：这个大框把别的块的整句都吞了进去，说明它是几行糊在一起的复合框
      const otherText = other.text.replace(/\s+/g, ' ').trim();
      return otherText.length >= 12 && bText.includes(otherText);
    });
  });
}

function rectOverlapRatio(a: {x:number,y:number,width:number,height:number}, b: {x:number,y:number,width:number,height:number}): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const bArea = b.width * b.height;
  return bArea > 0 ? (ix * iy) / bArea : 0;
}


function refineWithAccessibility(
  ocrBlocks: TextBlock[],
  axBlocks: AXTextBlock[],
  scaleFactor: number,
  displayOffset: { x: number; y: number } = { x: 0, y: 0 }
): TextBlock[] {
  // Strip SF Symbols / Private Use Area chars (macOS system icons rendered as glyphs)
  // U+E000-U+F8FF (BMP PUA) and U+F0000-U+10FFFD (supplementary PUAs)
  const stripIconChars = (s: string): string => {
    return s
      .replace(/[\uE000-\uF8FF]/g, '')
      .replace(/[\uDB80-\uDBFF][\uDC00-\uDFFF]/g, '') // surrogate pairs in PUA-A/B
      .replace(/^[\s\-_·•●○◆★☆▶◀▲▼■□+<>←→×✕✓✗]+/, '') // leading icon-like symbols
      .trim();
  };

  // Filter garbled OCR blocks (icons misread as text)
  const cleanOcr = ocrBlocks.flatMap(ocr => {
    let text = ocr.text.trim();

    // Reject icon-shaped blocks (small + square OR small + thin)
    const r = ocr.width / Math.max(ocr.height, 1);
    const isSmall = ocr.width < 50 * scaleFactor && ocr.height < 50 * scaleFactor;
    if (isSmall && r > 0.4 && r < 2.5) return []; // square-ish icon
    if (ocr.width < 30 * scaleFactor && ocr.height < 30 * scaleFactor) return []; // tiny

    // Has SF Symbols PUA chars → likely icon glyph mixed with text
    const hasPUA = /[\uE000-\uF8FF]/.test(text);
    if (hasPUA) {
      text = stripIconChars(text);
      if (text.length < 2) return []; // pure icon
    }

    // Garbled short text with icon-like symbols
    if (text.length <= 4 && /[+<>←→×✕✓✗■□●○◆★☆▶◀▲▼]/.test(text)) return [];

    // Strip leading icon symbols even on long text (e.g. "▶ Settings")
    const stripped = stripIconChars(text);
    if (stripped !== text && stripped.length >= 2) text = stripped;

    return [{ ...ocr, text }];
  });

  if (axBlocks.length === 0) return cleanOcr;

  // Convert AX global CSS coords → display-relative physical pixels (matching OCR space)
  const axPhysical = axBlocks.map(b => ({
    text: b.text,
    x: (b.x - displayOffset.x) * scaleFactor,
    y: (b.y - displayOffset.y) * scaleFactor,
    width: b.width * scaleFactor,
    height: b.height * scaleFactor,
  }));

  const matchedAx = new Set<number>();

  const refined = cleanOcr.map(ocr => {
    let bestMatch: typeof axPhysical[0] | null = null;
    let bestScore = 0;
    let bestIdx = -1;

    for (let i = 0; i < axPhysical.length; i++) {
      const ax = axPhysical[i];
      const score = textSimilarity(ocr.text, ax.text);
      if (score > bestScore && score > 0.6) {
        bestScore = score;
        bestMatch = ax;
        bestIdx = i;
      }
    }

    if (bestMatch && bestIdx >= 0) {
      matchedAx.add(bestIdx);
      return {
        ...ocr,
        text: bestMatch.text, // AX text is clean — no icon glyphs
        x: bestMatch.x,
        y: bestMatch.y,
        width: bestMatch.width,
        height: bestMatch.height,
      };
    }
    return ocr;
  });

  // Add unmatched AX blocks — these are UI elements OCR missed or merged with icons
  for (let i = 0; i < axPhysical.length; i++) {
    if (matchedAx.has(i)) continue;
    const ax = axPhysical[i];
    const text = ax.text.trim();
    if (text.length < 2) continue;
    // Skip if it overlaps significantly with any existing OCR block
    const overlaps = refined.some(r => rectOverlapRatio(r, ax) > 0.3);
    if (!overlaps) {
      refined.push({
        text,
        x: ax.x,
        y: ax.y,
        width: ax.width,
        height: ax.height,
        confidence: 0.8,
      });
    }
  }

  return refined;
}

function textSimilarity(a: string, b: string): number {
  const la = a.trim().toLowerCase();
  const lb = b.trim().toLowerCase();
  if (!la || !lb) return 0;
  if (la === lb) return 1;
  // 光看"谁包含谁"会让 "Usage" 冒充 "Usage limits"，AX 就把另一个元素的文本和坐标
  // 套到这一块上，译文贴到别处去。短的那个至少要占长的一多半才算同一个元素。
  if (la.includes(lb) || lb.includes(la)) {
    const ratio = Math.min(la.length, lb.length) / Math.max(la.length, lb.length);
    return ratio >= 0.6 ? 0.6 + ratio * 0.3 : ratio * 0.5;
  }
  const wordsA = new Set(la.split(/\s+/));
  const wordsB = new Set(lb.split(/\s+/));
  let overlap = 0;
  for (const w of wordsA) { if (wordsB.has(w)) overlap++; }
  return overlap / Math.max(wordsA.size, wordsB.size);
}

async function handleRegionTranslate() {
  const config = getConfig();
  isRegionProcessing = true;
  try {
    const selection = await showSelection();
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
    const ocrBlocks = await performOCR(screenshotPath);
    if (ocrBlocks.length === 0) {
      hideLoading();
      cleanup(screenshotPath);
      return;
    }

    // OCR returns physical pixels; convert to CSS pixels relative to region
    const cssBlocks = ocrBlocks.map(b => ({
      ...b,
      x: b.x / scaleFactor,
      y: b.y / scaleFactor,
      width: b.width / scaleFactor,
      height: b.height / scaleFactor,
    }));

    const targetLang = config.targetLanguage || 'zh-CN';
    const blocksToTranslate = filterForeignBlocks(cssBlocks, targetLang);
    if (blocksToTranslate.length === 0) {
      hideLoading();
      cleanup(screenshotPath);
      return;
    }

    showLoading(t('translatingPct', { n: 70 }));
    const paragraphs = groupIntoParagraphs(blocksToTranslate, selection.width);
    const texts = paragraphs.map(b => b.text);
    const translations = await translate(texts, targetLang, config);

    // 没翻出来的段落（接口失败、返回空）一个都别画：照原文画上去就是"英文盖英文"，
    // 字号还不一定对；擦掉又只剩一片空白。干脆原样留着，看着是没翻，至少不是坏的。
    const failed = paragraphs.filter((_, i) => !translations[i]);
    if (failed.length) debugLog(`有 ${failed.length} 段没翻出来，保持原文不动`);
    const translatedBlocks = paragraphs
      .map((block, i) => ({ ...block, translated: translations[i] || '' }))
      .filter(b => b.translated);

    hideLoading();
    showRegionOverlay({
      screenshotPath,
      blocks: translatedBlocks,
      regionX: selection.x,
      regionY: selection.y,
      regionWidth: selection.width,
      regionHeight: selection.height,
    });
  } catch (err: any) {
    console.error('[region] Translation failed:', err);
    const msg = err?.message || String(err);
    showLoading(t('error', { msg: msg.slice(0, 80) }));
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
