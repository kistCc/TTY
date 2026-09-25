const canvas = document.getElementById('result');
const ctx = canvas.getContext('2d');

const MIN_FONT_RATIO = 0.6;
const FONT_HEIGHT_RATIO = 0.75;
const BLUR_RATIO = 0.15;
const ERASE_PAD = 2;
/// 段落译文的行距：字号的多少倍
const PARAGRAPH_LINE_GAP = 1.28;

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
    const scaleY = img.height / window.innerHeight;

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
    const maxLineH = medianLineH ? medianLineH * 1.8 : Infinity;
    // 同样也要兜一个下限。OCR 偶尔把一行只认出半个字高，照它定字号就是一行
    // 小得看不清的字挤在正文中间。字号仍然跟着原文走（标题还是比正文大），
    // 只是限制在整屏行高的一个合理区间里。
    const minLineH = medianLineH ? medianLineH * 0.6 : 0;
    const sortedWeight = px.map(p => p.block.weight || 0).filter(w => w > 0).sort((a, b) => a - b);
    const medianWeight = sortedWeight.length ? sortedWeight[Math.floor(sortedWeight.length / 2)] : 0;

    // 先按"并段之前的原始块"把原文统统擦掉。没并进任何段落的碎块不会画译文，
    // 不擦的话它那块英文就留在屏幕上了。
    const cleanCtxForErase = clean.getContext('2d');
    (data.eraseRects || []).forEach(r => {
      const x = Math.round(r.x * scaleX);
      const y = Math.round(r.y * scaleY);
      const w = Math.round(r.width * scaleX);
      const h = Math.round(r.height * scaleY);
      const bg = sampleEdgeColor(cleanCtxForErase, x, y, w, h);
      ctx.fillStyle = `rgb(${bg.r},${bg.g},${bg.b})`;
      ctx.fillRect(x - ERASE_PAD, y - ERASE_PAD, w + ERASE_PAD * 2, h + ERASE_PAD * 2);
    });

    px.forEach((p, i) => {
      const { block, x, y, w, h } = p;
      // Use the row's representative height for font sizing — same row → same font size
      const { rowH, rowCenter } = rowMetrics[i];

      const isParagraph = p.lineCount > 1;
      // rowH 取的是整行里最高的那个框，用来让同一行的块字号一致。但密排正文里
      // OCR 会把一行切成好几块、高度参差不齐，一个偏高的框就会把同行别的块的
      // 字号顶上去，画出一串压在别人身上的大字。谁都不许比自己那个框大太多。
      const baseH = isParagraph ? p.lineH : Math.min(rowH, p.lineH * 1.25);
      // 原文是粗体才画粗体：笔画明显比这一屏的普通文字粗（1.25 倍以上）。
      // 以前按"行高超过 44 像素"判断，字大一点的正文也被画成粗体。
      const isBold = medianWeight > 0 && (block.weight || 0) > medianWeight * 1.25;
      const weight = isBold ? 'bold' : 'normal';
      const fontFamily = '-apple-system, "PingFang SC", "Hiragino Sans GB", sans-serif';
      const clampedH = Math.min(Math.max(baseH, minLineH), maxLineH);
      let originalFontSize = Math.round(clampedH * FONT_HEIGHT_RATIO);

      // 按"面积/字数"再估一次字号，取小的那个。
      //
      // 框高不总等于一行高：OCR 经常把两三行糊进一个框，照框高定字号就画出一坨
      // 两三倍大的字压在别人身上。但不管几行，"原文塞满这个框"这件事是成立的：
      // 一个字大约占 0.5f 宽、1.3f 高，所以 宽×高 ≈ 0.65·f²·字数，反解出 f。
      // 这个估计跟框里到底有几行无关，糊成一团的框会自动被压回正常字号；
      // 而标题那种"框大字少"的，估出来的 f 反而更大，取小之后不受影响。
      const srcLen = (block.text || '').replace(/\s+/g, ' ').trim().length;
      if (srcLen >= 8 && w > 0 && h > 0) {
        const fitted = Math.round(Math.sqrt((w * h) / (0.65 * srcLen)));
        if (fitted > 0) originalFontSize = Math.min(originalFontSize, fitted);
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
        while (fontSize > minFontSize && ctx.measureText(block.translated).width > w) {
          fontSize--;
          ctx.font = `${weight} ${fontSize}px ${fontFamily}`;
        }
      }

      // Erase original text with sampled background color
      const cleanCtx = clean.getContext('2d');
      const bgColor = sampleEdgeColor(cleanCtx, x, y, w, h);
      ctx.fillStyle = `rgb(${bgColor.r},${bgColor.g},${bgColor.b})`;
      ctx.fillRect(x - ERASE_PAD, y - ERASE_PAD, w + ERASE_PAD * 2, h + ERASE_PAD * 2);

      // Draw translated text
      // 字色跟原文走：原文是什么颜色就画什么颜色，链接之类的色段单独上色。
      // 量出来的颜色和底色太接近（量错了、或者本来就是很淡的字）时，退回按底色深浅选黑白。
      const fallbackColor = bgColor.brightness > 128
        ? (bgColor.brightness > 200 ? '#1a1a1a' : '#000000')
        : (bgColor.brightness < 50 ? '#e0e0e0' : '#ffffff');
      const baseColor = block.ink && contrastRatio(block.ink, bgColor) >= 2.2 ? rgbCss(block.ink) : fallbackColor;
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
        drawColoredLine(ctx, block.translated, 0, x, rowCenter, w, style);
      }
    });

    originalCanvas = clean;
    translatedCanvas = document.createElement('canvas');
    translatedCanvas.width = canvas.width;
    translatedCanvas.height = canvas.height;
    translatedCanvas.getContext('2d').drawImage(canvas, 0, 0);
  };

  img.src = data.screenshotDataUrl || `file://${screenshotPath}`;
});

// Edge-aware window drag + resize + double-click dismiss
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
document.addEventListener('mousedown', (e) => {
  if (e.button !== 0) return;
  // 点一下就拿焦点，否则 ⌘C 收不到（浮层是 showInactive 弹出来的）
  if (window.api.focusWindow) window.api.focusWindow();
  drag = { x: e.screenX, y: e.screenY, mode: getEdgeMode(e) };
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
  } else {
    document.body.style.cursor = modeToCursor(getEdgeMode(e));
  }
});
document.addEventListener('mouseup', () => { drag = null; });
document.addEventListener('dblclick', () => {
  window.api.dismiss();
});

// Pinch-to-zoom: macOS trackpad pinch arrives as wheel event with ctrlKey
document.addEventListener('wheel', (e) => {
  if (!e.ctrlKey) return;
  e.preventDefault();
  window.api.resizeBy(-e.deltaY);
}, { passive: false });


// ---------------------------------------------------------------------------
// 贴图复制（Snipaste 那种手感）：点一下浮层让它拿到焦点，⌘C 就把整张贴图
// 连同译文一起放进剪贴板，可以直接粘到微信、备忘录、文档里。
// ⇧⌘C 则复制纯译文——有时候要的是字，不是图。
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
  if (!(e.metaKey || e.ctrlKey)) return;
  if (e.key.toLowerCase() !== 'c') return;
  e.preventDefault();

  if (e.shiftKey) {
    const text = collectTranslations();
    if (!text) { showToast('没有可复制的译文'); return; }
    window.api.copyText(text);
    showToast('已复制译文');
    return;
  }

  try {
    window.api.copyImage(canvas.toDataURL('image/png'));
    showToast('已复制贴图');
  } catch (err) {
    showToast('复制失败');
  }
});

window.api.onClear(() => {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  originalCanvas = null;
  translatedCanvas = null;
  showingOriginal = false;
});

// ---------------------------------------------------------------------------
// 按住空格看原文，松开回到译文。浮层要先点一下拿到焦点（和 ⌘C 一样）。
// ---------------------------------------------------------------------------

function showOriginal(on) {
  if (!originalCanvas || !translatedCanvas || on === showingOriginal) return;
  showingOriginal = on;
  ctx.drawImage(on ? originalCanvas : translatedCanvas, 0, 0);
}

document.addEventListener('keydown', (e) => {
  if (e.code !== 'Space' || e.metaKey || e.ctrlKey || e.altKey) return;
  e.preventDefault();
  if (!e.repeat) showOriginal(true);
});
document.addEventListener('keyup', (e) => {
  if (e.code === 'Space') showOriginal(false);
});
// 按着空格切走了（⌘Tab、点了别的窗口），收不到松开，回来时别一直停在原文
window.addEventListener('blur', () => showOriginal(false));


/// 按框宽折行。中日韩逐字可断，拉丁词按空格断；一个词比整行还长时硬断。
/// 每行记下它在原文里从第几个字开始，上色时按这个下标对到色段上。
function wrapLines(ctx, text, maxWidth) {
  text = String(text);
  const lines = [];
  const re = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|[^\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+|\s+/g;
  let start = -1;   // 当前行第一个字的下标
  let end = -1;     // 当前行最后一个非空白字符之后的下标
  for (let m; (m = re.exec(text)); ) {
    const token = m[0];
    if (/^\s+$/.test(token)) continue;
    if (start < 0) { start = m.index; end = m.index + token.length; continue; }
    const candidate = text.slice(start, m.index + token.length);
    if (ctx.measureText(candidate).width > maxWidth) {
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
    for (let k = i; k < j; k++) result[sorted[k].idx] = { rowH: maxH, rowCenter };
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
