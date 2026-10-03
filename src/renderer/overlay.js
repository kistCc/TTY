const canvas = document.getElementById('result');
const ctx = canvas.getContext('2d');
/// 实时翻译窗口（live.ts 加载时带 ?live=1）：透明、鼠标穿透，只在原文所在的地方盖上译文
const LIVE = new URLSearchParams(location.search).get('live') === '1';
/// 实时翻译窗口比框选区域多一条放把手、关闭按钮的窄条（见 live.ts 的 BAR），默认在上方
const LIVE_BAR = LIVE ? 22 : 0;
const LIVE_BAR_TOP = new URLSearchParams(location.search).get('bar') !== 'bottom';

const MIN_FONT_RATIO = 0.6;
const FONT_HEIGHT_RATIO = 0.75;
const BLUR_RATIO = 0.15;
const ERASE_PAD = 2;
/// 段落译文的行距：字号的多少倍
const PARAGRAPH_LINE_GAP = 1.28;

// ---------------------------------------------------------------------------
// 边框：贴图就是屏幕截图，不加边和底下的画面长得一模一样，分不出来。
// 没选中时是一圈灰色细线（一深一浅两层，白底黑底都看得见）；
// 拿到键盘焦点（按键对它有效）时换成淡紫色，带一点柔光。
// 边框画在窗口里面（inset），透明窗口外面画的东西会被裁掉。
// ---------------------------------------------------------------------------
(function () {
  const style = document.createElement('style');
  style.textContent = `
    #focusRing {
      position: fixed; inset: 0; pointer-events: none; z-index: 10;
      box-shadow: inset 0 0 0 1px rgba(0, 0, 0, 0.28), inset 0 0 0 2px rgba(255, 255, 255, 0.35);
      transition: box-shadow 0.12s ease;
    }
    #focusRing.on {
      box-shadow: inset 0 0 0 1.5px rgba(203, 166, 247, 0.9), inset 0 0 8px rgba(203, 166, 247, 0.35);
    }`;
  document.head.appendChild(style);
  const ring = document.createElement('div');
  ring.id = 'focusRing';
  document.body.appendChild(ring);
  const sync = () => ring.classList.toggle('on', document.hasFocus());
  window.addEventListener('focus', sync);
  window.addEventListener('blur', sync);
  sync();
})();

/// 按住空格看原文用：干净的原图、画好译文的那一版
let originalCanvas = null;
let translatedCanvas = null;
let showingOriginal = false;

window.api.onShowTranslation((data) => {
  const { screenshotPath, blocks } = data;
  stickerBlocks = blocks || [];
  originalCanvas = null;
  translatedCanvas = null;
  showingOriginal = false;

  const img = new Image();
  img.onload = () => {
    canvas.width = img.width;
    canvas.height = img.height;
    ctx.drawImage(img, 0, 0);

    const clean = document.createElement('canvas');
    clean.width = img.width;
    clean.height = img.height;
    clean.getContext('2d').drawImage(img, 0, 0);

    const scaleX = img.width / window.innerWidth;
    const scaleY = img.height / (window.innerHeight - LIVE_BAR);

    // Pre-compute pixel-space coords + cluster blocks into rows for font normalization
    const px = blocks.map(b => ({
      block: b,
      x: Math.round(b.x * scaleX),
      y: Math.round(b.y * scaleY),
      w: Math.round(b.width * scaleX),
      h: Math.round(b.height * scaleY),
      lineH: Math.round((b.lineHeight || b.height) * scaleY),
      lineCount: b.lineCount || 1,
    }));
    const rowMetrics = clusterRowsAndGetHeights(px);

    // OCR 偶尔会吐出一个跨好几行的大框，照它的高度定字号就是一坨大字压在别人身上。
    // 用整屏行高的中位数兜一个上限，异常的框会被压回正常字号。
    const sortedLineH = px.map(p => p.lineH).filter(h => h > 0).sort((a, b) => a - b);
    const medianLineH = sortedLineH.length ? sortedLineH[Math.floor(sortedLineH.length / 2)] : 0;
    const maxLineH = medianLineH ? medianLineH * 5 : Infinity;
    // 同样也要兜一个下限。OCR 偶尔把一行只认出半个字高，照它定字号就是一行
    // 小得看不清的字挤在正文中间。字号仍然跟着原文走（标题还是比正文大），
    // 只是限制在整屏行高的一个合理区间里。
    const minLineH = medianLineH ? medianLineH * 0.45 : 0;
    const sortedWeight = px.map(p => p.block.weight || 0).filter(w => w > 0).sort((a, b) => a - b);
    const medianWeight = sortedWeight.length ? sortedWeight[Math.floor(sortedWeight.length / 2)] : 0;

    // 先把要画译文的原文擦掉（主进程只给了"会画上译文"的那些原文框）。
    // 擦除只在这里做一次：段落框里行与行之间本来就是干净的底，不用再整块涂一遍，
    // 涂了反而会在渐变背景上留下一块块方块。
    const cleanCtxForErase = clean.getContext('2d');
    const keep = (data.keepRects || []).map(r => ({ x0: r.x * scaleX, y0: r.y * scaleY, x1: (r.x + r.width) * scaleX, y1: (r.y + r.height) * scaleY }));
    eraseGuards = [];
    (data.eraseRects || []).forEach(r => {
      eraseText(ctx, cleanCtxForErase, r.x * scaleX, r.y * scaleY, r.width * scaleX, r.height * scaleY, keep, { underline: !!r.underline, cjk: !!r.cjk });
    });
    // 字框左端压着一个保留下来的图标（单选圈、▲、色块、面包屑 ›）：译文从图标右边起笔，宽度相应缩短
    for (const p of px) {
      let shift = 0;
      for (const g of eraseGuards) {
        if (g.left > p.x + 4 || g.right <= p.x) continue;
        if (g.y1 < p.y || g.y0 > p.y + p.lineH) continue;
        shift = Math.max(shift, g.right + Math.round(p.lineH * 0.15) - p.x);
      }
      if (shift > 0 && shift < p.w * 0.4) { p.x += shift; p.w -= shift; }
    }

    px.forEach((p, i) => {
      const { block, x, y, w, h } = p;
      // 同一行的块字号取这一行的中位数：菜单栏里 Tools（没下伸）和 Developers（有下伸）
      // 框高不同，各算各的会一大一小
      const { rowCenter, rowEm } = rowMetrics[i];

      const isParagraph = p.lineCount > 1;
      // rowH 取的是整行里最高的那个框，用来让同一行的块字号一致。但密排正文里
      // OCR 会把一行切成好几块、高度参差不齐，一个偏高的框就会把同行别的块的
      // 字号顶上去，画出一串压在别人身上的大字。谁都不许比自己那个框大太多。
      const baseH = p.lineH;
      // 原文是粗体才画粗体：笔画明显比这一屏的普通文字粗（1.25 倍以上）。
      // 以前按"行高超过 44 像素"判断，字大一点的正文也被画成粗体。
      const isBold = medianWeight > 0 && (block.weight || 0) > medianWeight * 1.25;
      const weight = isBold ? 'bold' : 'normal';
      const fontFamily = '-apple-system, "PingFang SC", "Hiragino Sans GB", sans-serif';
      const clampedH = Math.min(Math.max(baseH, minLineH), maxLineH);
      const ownEm = emFromBox(block.text, clampedH);
      // 同一行向中位字号看齐只许往小里收（最多到 0.8 倍），不许往大里放：放大会把短标签画得比原文大一截
      let originalFontSize = Math.round(isParagraph || !rowEm ? ownEm : Math.min(Math.max(rowEm, ownEm * 0.8), ownEm));

      // 按"面积/字数"再估一次字号，取小的那个：OCR 偶尔把两三行糊进一个框，
      // 照框高定字号就是一坨大字压在别人身上。拉丁字母平均宽约 0.5em、框高约 0.85em，
      // 所以 宽×高 ≈ 0.42·em²·字数，反解出 em。标题那种"框大字少"的估出来反而更大，取小之后不受影响。
      const srcLen = (block.text || '').replace(/\s+/g, ' ').trim().length;
      if (srcLen >= 8 && w > 0 && h > 0) {
        const fitted = Math.round(Math.sqrt((w * h) / (0.42 * srcLen)));
        if (fitted > 0) originalFontSize = Math.min(originalFontSize, fitted);
      }
      // 汉字比拉丁字母"显大"：同样字号下，汉字笔画高约 0.88 个字号，大写字母只有 0.7 个字号左右，
      // 再加上 OCR 框比字母高出一截，照框推出来的字号画汉字，实测比原文大四成（考题 3 中位 1.42 倍）。
      // 原文是拉丁/西里尔字母、译文是中日韩文字时按实测比例缩回去，让汉字高度约等于原文大写字母高的 1.05 倍。
      const srcCJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(block.text || '');
      const dstCJK = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(block.translated || '');
      if (!srcCJK && dstCJK) {
        const allCaps = !/[a-z\u0430-\u044f]/.test(block.text || '');
        // 多行段落、全大写标签实测还要再小一点（考题 3 修后 2：中位 1.20、1.17）
        const k = (allCaps ? 0.63 : 0.75) * (isParagraph ? 0.88 : 1);
        originalFontSize = Math.max(8, Math.round(originalFontSize * k));
      }
      // 单行：直接在原图上量这段字的大写字母高度定字号（框被旁边的图标、单选圈撑高时，按框高推会偏大）
      if (!isParagraph && !srcCJK && dstCJK) {
        const cap = measureCapHeight(clean.getContext('2d'), x, y, w, h, block.text || '');
        if (cap && cap >= h * 0.3 && cap <= h * 1.1) originalFontSize = Math.max(8, Math.round(cap * 1.12));
      }
      // 兜底：译文汉字不许比原文实测字高大 1.25 倍以上（汉字字身约 0.88 个字号，所以字号 ≤ 字高 × 1.42）。
      // 框被撑高（重音符、上下行糊在一起、日文注音）时，前面按框高推的字号会偏大一截
      if (dstCJK) {
        const lh = isParagraph ? p.lineH : h;
        const band = measureCapHeight(clean.getContext('2d'), x, y, w, lh, block.text || '');
        if (band && band >= lh * 0.3 && band <= lh * 1.1) originalFontSize = Math.min(originalFontSize, Math.max(8, Math.round(band * 1.42)));
      }
      const minFontSize = Math.max(10, Math.floor(originalFontSize * MIN_FONT_RATIO));
      let fontSize = originalFontSize;
      let wrapped = null;
      if (isParagraph) {
        // 整段译文要在原来那块地方里排得下：先按框宽折行，放不下就缩字号再试
        fontSize = fitParagraph(ctx, block.translated, w, h, weight, fontFamily, originalFontSize, minFontSize);
        ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
        wrapped = wrapLines(ctx, block.translated, w);
      } else {
        ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
        // 放不下时先往右边的空地伸（同一行右边没有别的字、也不是不许动的地方），
        // 最多伸到原宽的两倍，还不够才缩字号。短标签（"(Top)" → "（顶部）"）不会被缩成一半大。
        if (ctx.measureText(block.translated).width > w) {
          const y0 = y, y1 = y + h;
          let limit = Math.min(canvas.width, x + w * 2);
          const others = keep.concat(px.filter((_, j) => j !== i).map(o => ({ x0: o.x, y0: o.y, x1: o.x + o.w, y1: o.y + o.h })));
          for (const r of others) {
            if (r.y1 <= y0 || r.y0 >= y1) continue;
            if (r.x0 >= x + w - 1 && r.x0 < limit) limit = r.x0;
          }
          const room = Math.max(w, limit - x - Math.round(h * 0.3));
          const need = ctx.measureText(block.translated).width;
          p.w = Math.min(room, Math.ceil(need));
        }
        const fitW = Math.max(w, p.w);
        while (fontSize > minFontSize && ctx.measureText(block.translated).width > fitW) {
          fontSize--;
          ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
        }
      }

      // 字底下的颜色（选字色、判断对比度用）
      const cleanCtx = clean.getContext('2d');
      const bgColor = sampleEdgeColor(cleanCtx, x, y, w, h);

      // Draw translated text
      // 字色跟原文走：原文是什么颜色就画什么颜色，链接之类的色段单独上色。
      // 量出来的颜色和底色太接近（量错了、或者本来就是很淡的字）时，退回按底色深浅选黑白。
      const fallbackColor = bgColor.brightness > 128
        ? (bgColor.brightness > 200 ? '#1a1a1a' : '#000000')
        : (bgColor.brightness < 50 ? '#e0e0e0' : '#ffffff');
      const baseColor = block.ink && contrastRatio(block.ink, bgColor) >= 1.5 ? rgbCss(block.ink) : fallbackColor;
      const spans = (block.spans || [])
        .filter(sp => contrastRatio(sp.ink, bgColor) >= 1.8)
        .map(sp => ({ start: sp.start, end: sp.end, color: rgbCss(sp.ink), underline: !!sp.underline }));
      const style = { base: baseColor, baseUnderline: !!block.underline, spans, fontSize };
      ctx.font = `${weight} ${fontSize}px ${fontFamily}`;

      if (isParagraph) {
        ctx.textBaseline = 'top';
        const lineGap = Math.round(fontSize * PARAGRAPH_LINE_GAP);
        const totalH = wrapped.length * lineGap;
        // 段落整体在原框里垂直居中，行数变少时不会挤在顶上
        let ty = y + Math.max(0, Math.round((h - totalH) / 2));
        for (const line of wrapped) {
          drawColoredLine(ctx, line.text, line.start, x, ty, w, style);
          ty += lineGap;
        }
      } else {
        ctx.textBaseline = 'middle';
        // Use row-shared center Y so same-row blocks render text at the same vertical position
        drawColoredLine(ctx, block.translated, 0, x, rowCenter, Math.max(w, p.w), style);
      }
    });

    // 实时翻译：只留原文所在的那几块（擦掉的原文、画上的译文），其余地方挖成透明，
    // 下面的画面（视频、动画、别的没变的东西）照常露出来，不是一张会过时的截图
    if (LIVE) {
      const pad = Math.round(4 * scaleX);
      const mask = document.createElement('canvas');
      mask.width = canvas.width;
      mask.height = canvas.height;
      const m = mask.getContext('2d');
      m.fillStyle = '#000';
      for (const r of data.eraseRects || []) m.fillRect(r.x * scaleX - pad, r.y * scaleY - pad, r.width * scaleX + pad * 2, r.height * scaleY + pad * 2);
      for (const p of px) m.fillRect(p.x - pad, p.y - pad, p.w + pad * 2, p.h + pad * 2);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      ctx.drawImage(mask, 0, 0);
      ctx.restore();
    }

    originalCanvas = clean;
    translatedCanvas = document.createElement('canvas');
    translatedCanvas.width = canvas.width;
    translatedCanvas.height = canvas.height;
    translatedCanvas.getContext('2d').drawImage(canvas, 0, 0);
    // 区域贴图等画好了才显示（全屏浮层没有这个接口）
    if (window.api.drawn) window.api.drawn();
  };

  img.src = data.screenshotDataUrl || `file://${screenshotPath}`;
});

// Edge-aware window drag + resize
const EDGE = 10;
function getEdgeMode(e) {
  const w = window.innerWidth, h = window.innerHeight;
  const n = e.clientY < EDGE, s = e.clientY > h - EDGE;
  const we = e.clientX < EDGE, ea = e.clientX > w - EDGE;
  return (n ? 'n' : '') + (s ? 's' : '') + (we ? 'w' : '') + (ea ? 'e' : '');
}
function modeToCursor(m) {
  if (m === 'nw' || m === 'se') return 'nwse-resize';
  if (m === 'ne' || m === 'sw') return 'nesw-resize';
  if (m === 'n' || m === 's') return 'ns-resize';
  if (m === 'e' || m === 'w') return 'ew-resize';
  return 'move';
}

let drag = null;

// 实时翻译窗口的控件：左上角拖动把手、右上角关闭按钮。鼠标移进窗口才显示。
// 窗口平时鼠标穿透（点、滚都落到下面的软件上），鼠标在边缘（改大小）、把手、按钮上时才自己接鼠标
let liveGrip = null, liveClose = null;
if (LIVE) {
  document.body.style.cursor = 'default';
  const css = document.createElement('style');
  css.textContent = `
    #result { top: ${LIVE_BAR_TOP ? LIVE_BAR : 0}px; height: calc(100% - ${LIVE_BAR}px); }
    #focusRing { ${LIVE_BAR_TOP ? 'top' : 'bottom'}: ${LIVE_BAR}px; }
    .liveCtl { position: fixed; ${LIVE_BAR_TOP ? 'top' : 'bottom'}: 1px; z-index: 20; height: 20px; min-width: 20px; padding: 0 6px;
      border-radius: 6px; background: rgba(30, 30, 46, 0.82); color: #cdd6f4;
      font: 600 11px/20px -apple-system, "PingFang SC", sans-serif; text-align: center;
      opacity: 0; transition: opacity 0.12s ease; user-select: none; }
    body.hover .liveCtl { opacity: 1; }
    #liveGrip { left: 4px; cursor: move; }
    #liveClose { right: 4px; cursor: pointer; }
    #liveClose:hover { background: rgba(243, 139, 168, 0.9); color: #1e1e2e; }
    #focusRing { box-shadow: inset 0 0 0 1px rgba(203, 166, 247, 0.55) !important; }`;
  document.head.appendChild(css);
  liveGrip = document.createElement('div');
  liveGrip.id = 'liveGrip'; liveGrip.className = 'liveCtl'; liveGrip.textContent = '⠿ 实时';
  liveClose = document.createElement('div');
  liveClose.id = 'liveClose'; liveClose.className = 'liveCtl'; liveClose.textContent = '✕';
  document.body.appendChild(liveGrip);
  document.body.appendChild(liveClose);
  liveClose.addEventListener('click', () => window.api.dismiss());
  let through = true;
  const setThrough = (on) => { if (on !== through) { through = on; window.api.passThrough(on); } };
  document.addEventListener('mousemove', (e) => {
    document.body.classList.add('hover');
    if (drag) return;
    const onCtl = e.target === liveGrip || e.target === liveClose;
    setThrough(!(onCtl || getEdgeMode(e) !== ''));
  });
  document.addEventListener('mouseleave', () => { document.body.classList.remove('hover'); if (!drag) setThrough(true); });
}

document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  if (LIVE && e.target === liveClose) return;
  // 实时翻译：只有把手能拖动窗口，边缘改大小；别的地方本来就穿透，到不了这里
  if (LIVE && e.target !== liveGrip && getEdgeMode(e) === '') return;
  // 点一下就拿焦点，否则 ⌘C 收不到（浮层是 showInactive 弹出来的）
  if (window.api.focusWindow) window.api.focusWindow();
  drag = { x: e.screenX, y: e.screenY, mode: LIVE && e.target === liveGrip ? '' : getEdgeMode(e) };
});
document.addEventListener('mousemove', (e) => {
  if (drag) {
    const dx = e.screenX - drag.x;
    const dy = e.screenY - drag.y;
    if (dx === 0 && dy === 0) return;
    if (drag.mode === '') {
      window.api.moveBy(dx, dy);
    } else {
      window.api.resizeEdge(drag.mode, dx, dy);
    }
    drag.x = e.screenX;
    drag.y = e.screenY;
  } else if (!LIVE) {
    document.body.style.cursor = modeToCursor(getEdgeMode(e));
  } else {
    const m = getEdgeMode(e);
    document.body.style.cursor = m ? modeToCursor(m) : '';
  }
});
document.addEventListener('mouseup', () => { drag = null; });

// Pinch-to-zoom: macOS trackpad pinch arrives as wheel event with ctrlKey
document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  window.api.resizeBy(-e.deltaY);
}, { passive: false });


// ---------------------------------------------------------------------------
// 贴图上的快捷键全部按设置走（Snipaste 那种手感：点一下贴图让它拿到焦点，再按键）：
// 关闭、复制整张贴图、复制译文、按住看原文。
// ---------------------------------------------------------------------------

let stickerBlocks = [];

const toastEl = document.getElementById('toast');
let toastTimer = null;
function showToast(msg, ms = 1800) {
  if (!toastEl) return;
  toastEl.textContent = msg;
  toastEl.classList.add('show');
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => toastEl.classList.remove('show'), ms);
}

function collectTranslations() {
  return stickerBlocks
    .map(b => (b && b.translated ? String(b.translated).trim() : ''))
    .filter(Boolean)
    .join('\n');
}

document.addEventListener('keydown', (e) => {
  const keys = window.ttyKeys.get();
  if (window.ttyKeys.match(e, keys.dismissKey)) {
    e.preventDefault();
    window.api.dismiss();
    return;
  }
  if (window.ttyKeys.match(e, keys.copyTextKey)) {
    e.preventDefault();
    const text = collectTranslations();
    if (!text) { showToast('没有可复制的译文'); return; }
    window.api.copyText(text);
    showToast('已复制译文');
    return;
  }
  if (window.ttyKeys.match(e, keys.copyImageKey)) {
    e.preventDefault();
    try {
      window.api.copyImage(canvas.toDataURL('image/png'));
      showToast('已复制贴图');
    } catch (err) {
      showToast('复制失败');
    }
    return;
  }
  if (window.ttyKeys.match(e, keys.peekKey)) {
    e.preventDefault();
    if (!e.repeat) showOriginal(true);
  }
});

window.api.onClear(() => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  originalCanvas = null;
  translatedCanvas = null;
  showingOriginal = false;
});

// 按住「看原文」键显示原文，松开回到译文
function showOriginal(on) {
  if (!originalCanvas || !translatedCanvas || on === showingOriginal) return;
  showingOriginal = on;
  ctx.drawImage(on ? originalCanvas : translatedCanvas, 0, 0);
}

document.addEventListener('keyup', (e) => {
  if (window.ttyKeys.isKeyOf(e, window.ttyKeys.get().peekKey)) showOriginal(false);
});
// 按着键切走了（⌘Tab、点了别的窗口），收不到松开，回来时别一直停在原文
window.addEventListener('blur', () => showOriginal(false));


/// 按框宽折行。中日韩逐字可断，拉丁词按空格断；一个词比整行还长时硬断。
/// 每行记下它在原文里从第几个字开始，上色时按这个下标对到色段上。
const NO_LINE_START = /^[。，、；：？！）」』】〉》”’.,;:?!)\]}…%]/;

function wrapLines(ctx, text, maxWidth) {
  text = String(text);
  const lines = [];
  const re = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|[\u3000-\u303f\uff00-\uffef]|[^\s\u3000-\u303f\uff00-\uffef\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+|\s+/g;
  let start = -1;   // 当前行第一个字的下标
  let end = -1;     // 当前行最后一个非空白字符之后的下标
  for (let m; (m = re.exec(text)); ) {
    const token = m[0];
    if (/^\s+$/.test(token)) continue;
    if (start < 0) { start = m.index; end = m.index + token.length; continue; }
    const candidate = text.slice(start, m.index + token.length);
    // 行首不许是标点（。，、）」…）：它跟着上一行走，宁可上一行略超一点
    if (ctx.measureText(candidate).width > maxWidth && !NO_LINE_START.test(token)) {
      lines.push({ text: text.slice(start, end), start });
      start = m.index;
    }
    end = m.index + token.length;
  }
  if (start >= 0) lines.push({ text: text.slice(start, end), start });
  return lines.length ? lines : [{ text, start: 0 }];
}

function wrapText(ctx, text, maxWidth) {
  return wrapLines(ctx, text, maxWidth).map(l => l.text);
}

function rgbCss(c) {
  return `rgb(${c[0]},${c[1]},${c[2]})`;
}

/// WCAG 对比度：1 是完全一样，21 是黑白
function contrastRatio(c, bg) {
  const lum = (r, g, b) => {
    const f = v => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const a = lum(c[0], c[1], c[2]);
  const b = lum(bg.r, bg.g, bg.b);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/// 画一行字，按色段分成几截分别上色。lineStart 是这一行在整段译文里的起始下标。
/// 一行太宽时整行横向压扁到 maxWidth（和 fillText 的 maxWidth 参数效果一样），
/// 分截画时每截按同一个比例压，拼起来不会错位。
function drawColoredLine(ctx, line, lineStart, x, y, maxWidth, style) {
  const full = ctx.measureText(line).width;
  const k = full > maxWidth && maxWidth > 0 ? maxWidth / full : 1;

  // 按下标切成同色的几截
  const segs = [];
  let i = 0;
  while (i < line.length) {
    const at = lineStart + i;
    const sp = style.spans.find(s => at >= s.start && at < s.end);
    let j = i + 1;
    while (j < line.length) {
      const sp2 = style.spans.find(s => lineStart + j >= s.start && lineStart + j < s.end);
      if (sp2 !== sp) break;
      j++;
    }
    segs.push({
      text: line.slice(i, j),
      color: sp ? sp.color : style.base,
      underline: sp ? sp.underline : style.baseUnderline,
    });
    i = j;
  }

  // 下划线的位置：从当前的对齐方式推出字的基线，线画在基线下面一点
  const baseline = ctx.textBaseline;
  ctx.textBaseline = 'alphabetic';
  const m = ctx.measureText('M');
  ctx.textBaseline = baseline;
  const asc = m.fontBoundingBoxAscent || style.fontSize * 0.8;
  const desc = m.fontBoundingBoxDescent || style.fontSize * 0.2;
  const baseY = baseline === 'top' ? y + asc : baseline === 'middle' ? y + (asc - desc) / 2 : y;
  const thick = Math.max(1, Math.round(style.fontSize / 15));
  const underY = Math.round(baseY + Math.max(1, style.fontSize * 0.1));

  let cx = x;
  for (const seg of segs) {
    const segW = ctx.measureText(seg.text).width * k;
    ctx.fillStyle = seg.color;
    if (k < 1) {
      ctx.save();
      ctx.translate(cx, y);
      ctx.scale(k, 1);
      ctx.fillText(seg.text, 0, 0);
      ctx.restore();
    } else {
      ctx.fillText(seg.text, cx, y);
    }
    if (seg.underline && seg.text.trim()) {
      // 线只划在字上，不划两头的空格
      const lead = ctx.measureText(seg.text.slice(0, seg.text.length - seg.text.trimStart().length)).width * k;
      const body = ctx.measureText(seg.text.trim()).width * k;
      ctx.fillRect(Math.round(cx + lead), underY, Math.round(body), thick);
    }
    cx += segW;
  }
}

/// 找一个能把整段塞进原框的字号：先按原字号试，排不下就一点点缩，缩到下限为止。
function fitParagraph(ctx, text, maxWidth, maxHeight, weight, fontFamily, startSize, minSize) {
  let size = startSize;
  while (size > minSize) {
    ctx.font = `${weight} ${size}px ${fontFamily}`;
    const lines = wrapText(ctx, text, maxWidth);
    if (lines.length * Math.round(size * PARAGRAPH_LINE_GAP) <= maxHeight) return size;
    size--;
  }
  return minSize;
}

function detectOriginalFontSize(originalText, boxWidth, boxHeight, weight, fontFamily) {
  return Math.round(boxHeight * FONT_HEIGHT_RATIO);
}

// Cluster blocks into rows by vertical-center alignment.
// Returns per-block { rowH, rowCenter } so same-row blocks share font size AND vertical center.
// rowH = max h in row (best approximates actual font size; shorter boxes lack descenders)
// rowCenter = mean center y of row (avoids vertical jitter between blocks with different h)
function clusterRowsAndGetHeights(items) {
  if (items.length === 0) return [];
  const result = new Array(items.length);
  // 多行段落不参与"同一行对齐"：它的高度是好几行，拿它当一行的基准，容差跟着放大，
  // 会把上下好几行别的块吸进同一"行"，画在同一条基线上互相压着。
  items.forEach((it, idx) => { if (it.lineCount > 1) result[idx] = { rowH: it.h, rowCenter: it.y + it.h / 2 }; });
  const sorted = items.map((it, idx) => ({ it, idx, center: it.y + it.h / 2 }))
                       .filter(e => e.it.lineCount <= 1)
                       .sort((a, b) => a.center - b.center);
  let i = 0;
  while (i < sorted.length) {
    const startCenter = sorted[i].center;
    const startH = sorted[i].it.h;
    // 至少 1px：块高被缩放成 0 时 tolerance 也会是 0，下面的循环一个都吃不进去，
    // j 永远等于 i，外层 while 就卡死了（而 rowCenter 还会算成 0/0）
    const tolerance = Math.max(1, startH * 0.4);
    let j = i;
    let maxH = startH;
    let centerSum = 0;
    // do-while：无论如何先把当前这个吃掉，保证 j 一定前进
    do {
      maxH = Math.max(maxH, sorted[j].it.h);
      centerSum += sorted[j].center;
      j++;
    } while (j < sorted.length && sorted[j].center - startCenter < tolerance);
    const rowCenter = centerSum / (j - i);
    const ems = [];
    for (let k = i; k < j; k++) ems.push(emFromBox(sorted[k].it.block.text, sorted[k].it.lineH));
    ems.sort((a, b) => a - b);
    const rowEm = ems[ems.length >> 1];
    for (let k = i; k < j; k++) result[sorted[k].idx] = { rowH: maxH, rowCenter, rowEm };
    i = j;
  }
  return result;
}

/// 擦除用的底色：取框边上一圈像素里**出现最多**的颜色。
/// 以前是框外 4 像素处 12 个点取平均——小按钮上的字，外面一圈有一半落在按钮外，
/// 白底蓝底一平均就擦出一块淡蓝。字形很少碰到自己框的边，边上最多的颜色就是字底下的底色。
function sampleEdgeColor(cleanCtx, x, y, w, h) {
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(canvas.width - 1, Math.round(x + w)), y1 = Math.min(canvas.height - 1, Math.round(y + h));
  if (x1 <= x0 || y1 <= y0) return { r: 255, g: 255, b: 255, brightness: 255 };
  const data = cleanCtx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data;
  const rowLen = x1 - x0 + 1;
  const buckets = new Map();
  const add = (px, py) => {
    const i = ((py - y0) * rowLen + (px - x0)) * 4;
    const key = (data[i] >> 4) << 8 | (data[i + 1] >> 4) << 4 | (data[i + 2] >> 4);
    const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
    e.n++; e.r += data[i]; e.g += data[i + 1]; e.b += data[i + 2];
    buckets.set(key, e);
  };
  for (let px = x0; px <= x1; px++) { add(px, y0); add(px, y1); }
  for (let py = y0 + 1; py < y1; py++) { add(x0, py); add(x1, py); }
  let best = null;
  for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
  const r = Math.round(best.r / best.n), g = Math.round(best.g / best.n), b = Math.round(best.b / best.n);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return { r, g, b, brightness };
}


/// 从 OCR 框高推原文字号（em）。Vision 的框只包住字形本身：
/// 没有下伸字母（g j p q y）的英文只有大写字母那么高，约 0.72em；带下伸的约 0.93em；
/// 中日韩字约 0.92em。以前一律按框高 × 0.75 画，没下伸的标题、按钮文字就被画成原来的一半大。
/// 原图上一段单行字的"大写字母高度"：从最上面有笔画的那一行量到基线（最后一行笔画稠密的行）。
/// 全是小写、又没有 b d f h k l t 这类出头字母的，量到的是 x 高度，按常见字体比例折回大写高度。
/// 量不出来返回 0。
function measureCapHeight(cleanCtx, x, y, w, h, text) {
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y - h * 0.15));
  const x1 = Math.min(canvas.width - 1, Math.round(x + w)), y1 = Math.min(canvas.height - 1, Math.round(y + h * 1.15));
  if (x1 - x0 < 3 || y1 - y0 < 4) return 0;
  const bgc = sampleEdgeColor(cleanCtx, x0, y0, x1 - x0, y1 - y0);
  const data = cleanCtx.getImageData(x0, y0, x1 - x0 + 1, y1 - y0 + 1).data;
  const W = x1 - x0 + 1, H = y1 - y0 + 1;
  const rows = new Array(H).fill(0);
  for (let j = 0; j < H; j++) for (let i = 0; i < W; i++) {
    const k = (j * W + i) * 4;
    if (Math.abs(data[k] - bgc.r) + Math.abs(data[k + 1] - bgc.g) + Math.abs(data[k + 2] - bgc.b) > 90) rows[j]++;
  }
  // 只量框中间这一行字：从中线往上、往下各走到第一段空白（连续 2 行没笔画）为止，别量进上下相邻的行
  const mid = Math.round((y + h / 2) - y0);
  let lo = mid, hi = mid, gap = 0;
  for (let j = mid; j >= 0; j--) { if (rows[j] < 1) { if (++gap >= 2) break; } else { gap = 0; lo = j; } }
  gap = 0;
  for (let j = mid; j < H; j++) { if (rows[j] < 1) { if (++gap >= 2) break; } else { gap = 0; hi = j; } }
  const band = rows.slice(lo, hi + 1);
  const max = Math.max(...band);
  if (max < 2) return 0;
  let top = -1, base = -1;
  for (let j = 0; j < band.length; j++) if (!(band[j] >= W * 0.7) && band[j] >= Math.max(2, max * 0.04)) { top = j; break; }
  // 几乎贯穿整行宽度的那一行是下划线（链接），不是字的基线，跳过
  const underline = (v) => v >= W * 0.7;
  const maxText = Math.max(...band.filter(v => !underline(v)), 0);
  for (let j = band.length - 1; j >= 0; j--) if (!underline(band[j]) && band[j] >= maxText * 0.3) { base = j; break; }
  if (top < 0 || base <= top) return 0;
  let cap = base - top + 1;
  if (!/[A-Z0-9bdfhkltА-ЯЁ\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(text)) cap *= 1.36;
  return cap;
}

function emFromBox(text, boxH) {
  const t = String(text || '');
  if (/[぀-ヿ一-鿿가-힯]/.test(t)) return boxH / 0.92;
  if (/[gjpqy,;]/.test(t)) return boxH / 0.93;
  return boxH / 0.72;
}

/// 擦除时保留下来的、贴在擦除框左边的图标（右边界、上下范围）。画译文时起笔点要让开它们
let eraseGuards = [];

/// 纯色底的擦除：只擦属于这段字的笔画，不整块涂色。
/// 擦除框里跟底色不同的像素按连通块分组（往框外多看一圈）：一大截伸在框外的块——单选圈、图例色块、
/// 投票三角、头像、输入框边框——不是这段字，只是框压到了它的边，原样留着（连外面 1 像素的抗锯齿边）；
/// 面积超过框一半的块是色块、按钮底，也留着。其余像素（字形和它周围的底）填底色。
/// 思路参考 comic-translate / manga-image-translator：按连通块判断哪些像素是字，再只擦字。
function fillSolidKeepingForeign(ctx, cleanCtx, x0, y0, x1, y1, c, opts = {}) {
  const W = canvas.width, H = canvas.height;
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  const E = Math.max(4, Math.round(Math.min(h, 40) * 0.6));
  const rx0 = Math.max(0, x0 - E), ry0 = Math.max(0, y0 - E);
  const rx1 = Math.min(W - 1, x1 + E), ry1 = Math.min(H - 1, y1 + E);
  const rw = rx1 - rx0 + 1, rh = ry1 - ry0 + 1;
  const src = cleanCtx.getImageData(rx0, ry0, rw, rh).data;
  const ink = new Uint8Array(rw * rh);
  for (let k = 0; k < rw * rh; k++) {
    const i = k * 4;
    if (Math.abs(src[i] - c[0]) + Math.abs(src[i + 1] - c[1]) + Math.abs(src[i + 2] - c[2]) > 48) ink[k] = 1;
  }
  const bx0 = x0 - rx0, by0 = y0 - ry0, bx1 = x1 - rx0, by1 = y1 - ry0;
  // 这段字的颜色：框中间一半高度里、和底色差得明显的像素，各通道取中位数
  const strong = (i) => Math.abs(src[i] - c[0]) + Math.abs(src[i + 1] - c[1]) + Math.abs(src[i + 2] - c[2]) > 90;
  const tr = [], tg = [], tb = [];
  for (let y = by0 + Math.floor(h / 4); y <= by1 - Math.floor(h / 4); y++) for (let x = bx0; x <= bx1; x++) {
    const i = (y * rw + x) * 4;
    if (strong(i)) { tr.push(src[i]); tg.push(src[i + 1]); tb.push(src[i + 2]); }
  }
  const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
  const textInk = tr.length ? [med(tr), med(tg), med(tb)] : null;
  const label = new Int32Array(rw * rh).fill(-1);
  const foreign = [];
  const stack = [];
  let n = 0;
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
    const k0 = y * rw + x;
    if (!ink[k0] || label[k0] >= 0) continue;
    let cin = 0, cout = 0, sn = 0, sr = 0, sg = 0, sb = 0;
    let cx0 = Infinity, cx1 = -1, cy0 = Infinity, cy1 = -1;
    label[k0] = n; stack.push(k0);
    while (stack.length) {
      const k = stack.pop();
      const px = k % rw, py = (k - px) / rw;
      if (px < cx0) cx0 = px; if (px > cx1) cx1 = px; if (py < cy0) cy0 = py; if (py > cy1) cy1 = py;
      if (px >= bx0 && px <= bx1 && py >= by0 && py <= by1) cin++; else cout++;
      const si = k * 4;
      if (strong(si)) { sn++; sr += src[si]; sg += src[si + 1]; sb += src[si + 2]; }
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const qx = px + dx, qy = py + dy;
        if (qx < 0 || qy < 0 || qx >= rw || qy >= rh) continue;
        const q = qy * rw + qx;
        if (ink[q] && label[q] < 0) { label[q] = n; stack.push(q); }
      }
    }
    // 一块就占了框的一半：色块、按钮底，留着
    // 框外的部分超过四分之一（字被框切掉一两像素的边不算），而且伸进框里的只是贴着框边的一小条：
    // 单选圈、三角、色块边、头像只是被框压到了边，留着。
    // 伸进框里很深的（字形连着下划线、标签胶囊的描边、上下相邻行）不留：框里的部分照擦，框外的本来就不动
    let keepIt = cin > w * h * 0.5;
    // 字下面一道又细又长、不连着字形的横条：选中标签的指示条、标签栏底线。不是这段字，留着。
    // 字自己带下划线（链接）的不留：浮层会按译文长度重画下划线
    if (!keepIt && !opts.underline && cy1 - cy0 + 1 <= Math.max(3, Math.round(h * 0.18))
      && cx1 - cx0 + 1 >= w * 0.5 && cy0 - by0 >= h * 0.55) keepIt = true;
    if (!keepIt && cout > Math.max(3, (cin + cout) * 0.25)) {
      const m = Math.max(4, Math.round(h * 0.2));
      let ix0 = Infinity, ix1 = -1, iy0 = Infinity, iy1 = -1;
      for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
        if (label[y * rw + x] !== n) continue;
        if (x < ix0) ix0 = x; if (x > ix1) ix1 = x; if (y < iy0) iy0 = y; if (y > iy1) iy1 = y;
      }
      const atLeft = ix1 - bx0 < m, atRight = bx1 - ix0 < m, atTop = iy1 - by0 < m, atBottom = by1 - iy0 < m;
      // 颜色和这段字明显不同（灰色单选圈、▲、彩色头像、黄色胶囊）：是图标，伸进来多深都整块留着。
      // 和字同色的（连着字的下划线、同色的邻行）才只留贴边的一小条
      const otherColor = textInk && sn > 0
        && Math.abs(sr / sn - textInk[0]) + Math.abs(sg / sn - textInk[1]) + Math.abs(sb / sn - textInk[2]) > 90;
      keepIt = otherColor || atLeft || atRight || atTop || atBottom;
      const guardLeft = (otherColor && ix0 - bx0 < m) || atLeft;
      // 贴着左边留下的图标：记下它的右边界，画译文时从它右边起笔，别压在图标上
      if (guardLeft && !atTop && !atBottom) eraseGuards.push({ left: x0, right: rx0 + ix1 + 1, y0: ry0 + iy0, y1: ry0 + iy1 });
    }
    foreign.push(keepIt);
    n++;
  }
  const keepPx = new Uint8Array(w * h);
  if (foreign.some(f => f)) {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const l = label[(y + by0) * rw + (x + bx0)];
      if (l < 0 || !foreign[l]) continue;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const xx = x + dx, yy = y + dy;
        if (xx >= 0 && yy >= 0 && xx < w && yy < h) keepPx[yy * w + xx] = 1;
      }
    }
  }
  const out = ctx.getImageData(x0, y0, w, h);
  const o = out.data;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = (y * w + x) * 4;
    if (keepPx[y * w + x]) {
      const s = ((y + by0) * rw + (x + bx0)) * 4;
      o[t] = src[s]; o[t + 1] = src[s + 1]; o[t + 2] = src[s + 2];
    } else { o[t] = c[0]; o[t + 1] = c[1]; o[t + 2] = c[2]; }
    o[t + 3] = 255;
  }
  ctx.putImageData(out, x0, y0);
}

/// 擦掉一块原文。
/// 1. 框按墨迹往外扩：Vision 的框常常比字形小一圈（大号字尤其明显），照框擦会留下字的边。
///    框外一行/一列里还有明显不同于底色的像素，就再往外扩一像素，最多扩出三分之一个框高。
/// 2. 取框外一圈的颜色。一圈都差不多（纯色底）→ 整块填这个颜色；
///    颜色有变化（渐变、花纹、图片）→ 按四边的颜色插值出"这里本来的底"，
///    只把和它差得远的像素（字的笔画，外扩 1 像素吃掉描边）换成插值，其余像素原样保留。
function eraseText(ctx, cleanCtx, fx, fy, fw, fh, keep = [], opts = {}) {
  const W = canvas.width, H = canvas.height;
  let x0 = Math.max(0, Math.floor(fx) - 1), y0 = Math.max(0, Math.floor(fy) - 1);
  let x1 = Math.min(W - 1, Math.ceil(fx + fw) + 1), y1 = Math.min(H - 1, Math.ceil(fy + fh) + 1);
  if (x1 - x0 < 2 || y1 - y0 < 2) return;
  const maxGrow = Math.max(2, Math.round((y1 - y0) * 0.35));
  // 横向最多扩 0.12 个字高：原生程序已经按真实笔画收过框，横向再多扩就会吃掉紧挨着的图标、单选圈、色块
  const maxGrowX = Math.max(1, Math.round((y1 - y0) * 0.12));
  let grownX0 = 0, grownX1 = 0;
  // 横向多取一段：框外漏掉的标点要往外找到一个字高开外
  const growH = Math.max(maxGrow, Math.round((y1 - y0) * 1.4));
  const lx = Math.max(0, x0 - growH), ly = Math.max(0, y0 - maxGrow);
  const lw = Math.min(W - 1, x1 + growH) - lx + 1, lh = Math.min(H - 1, y1 + maxGrow) - ly + 1;
  const src = cleanCtx.getImageData(lx, ly, lw, lh);
  const d = src.data;
  const at = (x, y) => ((y - ly) * lw + (x - lx)) * 4;
  const dist = (i, c) => Math.abs(d[i] - c[0]) + Math.abs(d[i + 1] - c[1]) + Math.abs(d[i + 2] - c[2]);
  const ringColor = () => {
    const e = sampleEdgeColor(cleanCtx, x0 - 1, y0 - 1, x1 - x0 + 2, y1 - y0 + 2);
    return [e.r, e.g, e.b];
  };
  // 一行（或一列）里有多少"字色"像素：跟底色差 90 以上
  const inkIn = (xa, ya, xb, yb, c) => {
    let n = 0, tot = 0;
    for (let y = ya; y <= yb; y++) for (let x = xa; x <= xb; x++) { tot++; if (dist(at(x, y), c) > 90) n++; }
    return tot ? n / tot : 0;
  };
  // 往外扩不许碰到不擦的字：上下左右各自的边界先按它们收好
  let minY = ly, maxY = ly + lh - 1, minX = lx, maxX = lx + lw - 1;
  for (const k of keep) {
    const overlapX = Math.min(x1, k.x1) - Math.max(x0, k.x0) > 0;
    const overlapY = Math.min(y1, k.y1) - Math.max(y0, k.y0) > 0;
    if (overlapX && k.y0 >= y1) maxY = Math.min(maxY, Math.floor(k.y0) - 1);
    if (overlapX && k.y1 <= y0) minY = Math.max(minY, Math.ceil(k.y1) + 1);
    if (overlapY && k.x0 >= x1) maxX = Math.min(maxX, Math.floor(k.x0) - 1);
    if (overlapY && k.x1 <= x0) minX = Math.max(minX, Math.ceil(k.x1) + 1);
  }
  let bg = ringColor();
  // 穿过文字框的横线/竖线（输入框边框、分隔线、标签栏底线）：几乎贯穿整行，而且在框两头外面还接着延伸。
  // 这种线不是这段字的一部分：往外扩时不扩进去，擦完再原样补回。文字自己的下划线到字两头就停，照常擦。
  const inkAt = (x, y) => x >= lx && y >= ly && x < lx + lw && y < ly + lh && dist(at(x, y), bg) > 90;
  // 只要有一头伸出框外就算（标题下的分隔线常常左端和标题对齐、只往右延伸）
  // 伸出去的那一截也得是细线：沿线连续好几个像素有颜色、上下（左右）没有——紧挨着的色块、按钮是一整块，不算
  const thinH = (x, y) => inkAt(x, y) && !(inkAt(x, y - 3) && inkAt(x, y + 3));
  const thinV = (x, y) => inkAt(x, y) && !(inkAt(x - 3, y) && inkAt(x + 3, y));
  const extH = (y, from, dir) => [3, 6, 10].every(k => thinH(from + k * dir, y));
  const extV = (x, from, dir) => [3, 6, 10].every(k => thinV(x, from + k * dir));
  const lineRow = (y) => inkIn(x0, y, x1, y, bg) > 0.85 && (extH(y, x0, -1) || extH(y, x1, 1));
  const lineCol = (x) => inkIn(x, y0, x, y1, bg) > 0.85 && (extV(x, y0, -1) || extV(x, y1, 1));
  // 往外连着 5 列都几乎填满（八成以上）的是实心色块、按钮、徽章，不是字的笔画（笔画只有几像素宽），扩到这里就停
  const solidAhead = (x, dir) => {
    for (let k = 0; k < 5; k++) {
      const xx = x + k * dir;
      if (xx < lx || xx >= lx + lw || inkIn(xx, y0, xx, y1, bg) <= 0.8) return false;
    }
    return true;
  };
  // 紧挨着框、没被框进来的一个小字形：Vision 常把句末的 」！＞、句点、®、引号漏在框外，
  // 不擦就孤零零留在译文旁边。颜色和这段字一样、前后都隔着空白的才算；
  // 拉丁文只收贴底的小点（. ,）和贴顶的小记号（® " '），面包屑 › 这类图标不碰；细高的 │ 是分隔线，不碰
  function absorbStrayGlyphs() {
    const Hh = y1 - y0 + 1;
    const rs = [], gs = [], bs = [];
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const i = at(x, y);
      if (dist(i, bg) > 90) { rs.push(d[i]); gs.push(d[i + 1]); bs.push(d[i + 2]); }
    }
    if (rs.length < 10) return;
    const med = (a) => a.sort((p, q) => p - q)[a.length >> 1];
    const ink = [med(rs), med(gs), med(bs)];
    const lo = Math.max(minX, lx), hi = Math.min(maxX, lx + lw - 1);
    const inRange = (x) => x >= lo && x <= hi;
    const colN = (x) => { let n = 0; for (let y = y0; y <= y1; y++) if (dist(at(x, y), bg) > 90) n++; return n; };
    const absorb = (dir) => {
      let x = (dir > 0 ? x1 : x0) + dir, blank = 0;
      while (inRange(x) && colN(x) === 0 && blank < Hh * 0.35) { x += dir; blank++; }
      if (!inRange(x) || colN(x) === 0) return;
      const xs = x;
      let top = Infinity, bot = -1, cn = 0, cr = 0, cg = 0, cb = 0;
      while (inRange(x) && colN(x) > 0) {
        for (let y = y0; y <= y1; y++) {
          const i = at(x, y);
          if (dist(i, bg) > 90) { if (y < top) top = y; if (y > bot) bot = y; cn++; cr += d[i]; cg += d[i + 1]; cb += d[i + 2]; }
        }
        x += dir;
        if (Math.abs(x - xs) > Hh * 0.7) return;
      }
      const xe = x - dir;
      let gap = 0;
      while (inRange(x) && colN(x) === 0 && gap < Hh * 0.25) { x += dir; gap++; }
      if (inRange(x) && gap < Hh * 0.25) return;
      const gw = Math.abs(xe - xs) + 1, gh = bot - top + 1;
      if (Math.abs(cr / cn - ink[0]) + Math.abs(cg / cn - ink[1]) + Math.abs(cb / cn - ink[2]) > 100) return;
      if (gh >= Hh * 0.75 && gw <= Hh * 0.15) return;
      const ok = opts.cjk
        ? gw <= Hh * 0.7 && gh <= Hh * 1.05
        : gw <= Hh * 0.35 && gh <= Hh * 0.4 && (top - y0 >= Hh * 0.5 || bot - y0 <= Hh * 0.5);
      if (!ok) return;
      // 不许碰保留的东西（图标、不翻的字）
      const gx0 = Math.min(xs, xe), gx1 = Math.max(xs, xe);
      if (keep.some(k => k.x0 <= gx1 + 1 && k.x1 >= gx0 - 1 && k.y0 <= bot && k.y1 >= top)) return;
      if (dir > 0) x1 = xe; else x0 = xe;
    };
    absorb(1);
    // 左边只在中日韩文里找（「、（）；拉丁文左边挨着的多半是图标（放大镜的柄）
    if (opts.cjk) absorb(-1);
  }
  for (let grown = 0; grown < maxGrow; grown++) {
    let changed = false;
    if (y1 + 1 <= maxY && !lineRow(y1 + 1) && inkIn(x0, y1 + 1, x1, y1 + 1, bg) > 0.02) { y1++; changed = true; }
    if (y0 - 1 >= minY && !lineRow(y0 - 1) && inkIn(x0, y0 - 1, x1, y0 - 1, bg) > 0.02) { y0--; changed = true; }
    if (grownX1 < maxGrowX && x1 + 1 <= maxX && !lineCol(x1 + 1) && !solidAhead(x1 + 1, 1) && inkIn(x1 + 1, y0, x1 + 1, y1, bg) > 0.06) { x1++; grownX1++; changed = true; }
    if (grownX0 < maxGrowX && x0 - 1 >= minX && !lineCol(x0 - 1) && !solidAhead(x0 - 1, -1) && inkIn(x0 - 1, y0, x0 - 1, y1, bg) > 0.06) { x0--; grownX0++; changed = true; }
    if (!changed) break;
  }
  absorbStrayGlyphs();
  x0 = Math.max(minX, x0 - 1); y0 = Math.max(minY, y0 - 1);
  x1 = Math.min(maxX, x1 + 1); y1 = Math.min(maxY, y1 + 1);
  // 框边上压着的横线（标题下的分隔线、输入框底边）：擦除范围收到线的里侧，留 2 像素，
  // 不然四边取色会取到线的颜色，插值出一片灰色渐变
  {
    const mid = (y0 + y1) / 2;
    const rows = [];
    for (let y = y0; y <= y1; y++) if (lineRow(y)) rows.push(y);
    const below = rows.filter(y => y > mid), above = rows.filter(y => y < mid);
    if (below.length) y1 = Math.max(Math.ceil(mid), Math.min(...below) - 2);
    if (above.length) y0 = Math.min(Math.floor(mid), Math.max(...above) + 2);
  }
  const w = x1 - x0 + 1, h = y1 - y0 + 1;
  // 框里还剩的横线、竖线记下来，擦完补回去
  const keepRows = [], keepCols = [];
  for (let y = y0; y <= y1; y++) if (lineRow(y)) keepRows.push(y);
  for (let x = x0; x <= x1; x++) if (lineCol(x)) keepCols.push(x);
  const restoreLines = () => {
    if (!keepRows.length && !keepCols.length) return;
    const img = ctx.getImageData(x0, y0, w, h);
    const q = img.data;
    const put = (x, y) => { const si = at(x, y), ti = ((y - y0) * w + (x - x0)) * 4; q[ti] = d[si]; q[ti + 1] = d[si + 1]; q[ti + 2] = d[si + 2]; q[ti + 3] = 255; };
    for (const y of keepRows) for (let x = x0; x <= x1; x++) put(x, y);
    for (const x of keepCols) for (let y = y0; y <= y1; y++) put(x, y);
    ctx.putImageData(img, x0, y0);
  };

  // 四条边（框外一像素，拿不到就用框边），每条边做个 5 点中值，别让一个噪点带偏
  const edge = (pts) => {
    const vals = pts.map(([x, y]) => { const i = at(x, y); return [d[i], d[i + 1], d[i + 2]]; });
    return vals.map((_, k) => {
      const win = vals.slice(Math.max(0, k - 2), k + 3);
      return [0, 1, 2].map(ch => win.map(v => v[ch]).sort((a, b) => a - b)[win.length >> 1]);
    });
  };
  const ex0 = Math.max(lx, x0 - 1), ex1 = Math.min(lx + lw - 1, x1 + 1);
  const ey0 = Math.max(ly, y0 - 1), ey1 = Math.min(ly + lh - 1, y1 + 1);
  const top = edge(Array.from({ length: w }, (_, i) => [x0 + i, ey0]));
  const bottom = edge(Array.from({ length: w }, (_, i) => [x0 + i, ey1]));
  const left = edge(Array.from({ length: h }, (_, j) => [ex0, y0 + j]));
  const right = edge(Array.from({ length: h }, (_, j) => [ex1, y0 + j]));

  // 一圈颜色的起伏：各通道极差都很小就是纯色底
  const ring = top.concat(bottom, left, right);
  const spread = [0, 1, 2].map(ch => {
    const v = ring.map(c => c[ch]).sort((a, b) => a - b);
    return v[Math.floor(v.length * 0.9)] - v[Math.floor(v.length * 0.1)];
  });
  // 纯色底：一圈里六成以上的像素都是同一个颜色。一圈里偶尔压到上下行的笔画、链接下划线，
  // 不该把它当成渐变——那样插值会把邻行的字色带进来，擦出一块发灰的方块。
  const mode = ringColor();
  const same = ring.filter(c => Math.abs(c[0] - mode[0]) + Math.abs(c[1] - mode[1]) + Math.abs(c[2] - mode[2]) <= 12).length;
  // 四周不是一个颜色时，再看框里面：除了字以外大部分是同一个颜色（标签胶囊、按钮底色），就用它填，
  // 不用四边插值——插值会把胶囊边、外面的底色带进来，抹出一道色带
  // 字压在徽章、标签胶囊里、擦除框又大过徽章时（NEW 徽章、蓝底标签），四周一圈是徽章外面的底色，
  // 照它填会把徽章擦掉。框里除了字以外大部分是另一个颜色，就用框里的颜色填
  let inner = null;
  {
    const buckets = new Map();
    let tot = 0;
    for (let yy = y0 + 1; yy < y1; yy++) for (let xx = x0 + 1; xx < x1; xx++) {
      const i = at(xx, yy); tot++;
      const key = (d[i] >> 4) << 8 | (d[i + 1] >> 4) << 4 | (d[i + 2] >> 4);
      const e = buckets.get(key) || { n: 0, r: 0, g: 0, b: 0 };
      e.n++; e.r += d[i]; e.g += d[i + 1]; e.b += d[i + 2]; buckets.set(key, e);
    }
    let best = null;
    for (const e of buckets.values()) if (!best || e.n > best.n) best = e;
    if (best && tot && best.n >= tot * 0.5) inner = [Math.round(best.r / best.n), Math.round(best.g / best.n), Math.round(best.b / best.n)];
    // 四周是纯色、框里也是同一个颜色（普通的字）：照旧用四周的颜色
    if (inner && (Math.max(...spread) <= 10 || same >= ring.length * 0.6)
      && Math.abs(inner[0] - mode[0]) + Math.abs(inner[1] - mode[1]) + Math.abs(inner[2] - mode[2]) <= 40) inner = null;
  }
  if (Math.max(...spread) <= 10 || same >= ring.length * 0.6 || inner) {
    const c = inner || mode;
    fillSolidKeepingForeign(ctx, cleanCtx, x0, y0, x1, y1, c, opts);
    restoreLines();
    return;
  }

  // 渐变底：四边插值（Coons 曲面），只换笔画像素
  const P00 = top[0], P10 = top[w - 1], P01 = bottom[0], P11 = bottom[w - 1];
  const out = ctx.getImageData(x0, y0, w, h);
  const o = out.data;
  const base = new Float32Array(w * h * 3);
  const mask = new Uint8Array(w * h);
  for (let j = 0; j < h; j++) {
    const v = h > 1 ? j / (h - 1) : 0;
    for (let i = 0; i < w; i++) {
      const u = w > 1 ? i / (w - 1) : 0;
      const k = j * w + i;
      for (let ch = 0; ch < 3; ch++) {
        const val = (1 - v) * top[i][ch] + v * bottom[i][ch] + (1 - u) * left[j][ch] + u * right[j][ch]
          - ((1 - u) * (1 - v) * P00[ch] + u * (1 - v) * P10[ch] + (1 - u) * v * P01[ch] + u * v * P11[ch]);
        base[k * 3 + ch] = val;
      }
      const si = at(x0 + i, y0 + j);
      const diff = Math.abs(d[si] - base[k * 3]) + Math.abs(d[si + 1] - base[k * 3 + 1]) + Math.abs(d[si + 2] - base[k * 3 + 2]);
      if (diff > 22) mask[k] = 1;
    }
  }
  // 笔画外扩 2 像素，把抗锯齿的描边一起换掉，不然会留一层淡淡的字影
  for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
    const k = j * w + i;
    let hit = mask[k] === 1;
    if (!hit) for (let dj = -2; dj <= 2 && !hit; dj++) for (let di = -2; di <= 2 && !hit; di++) {
      const ii = i + di, jj = j + dj;
      if (ii >= 0 && jj >= 0 && ii < w && jj < h && mask[jj * w + ii] === 1) hit = true;
    }
    if (!hit) continue;
    o[k * 4] = base[k * 3]; o[k * 4 + 1] = base[k * 3 + 1]; o[k * 4 + 2] = base[k * 3 + 2]; o[k * 4 + 3] = 255;
  }
  ctx.putImageData(out, x0, y0);
  restoreLines();
}
