const canvas = document.getElementById('result');
const ctx = canvas.getContext('2d');

const MIN_FONT_RATIO = 0.6;
const FONT_HEIGHT_RATIO = 0.75;
const BLUR_RATIO = 0.15;
const ERASE_PAD = 2;
/// 段落译文的行距：字号的多少倍
const PARAGRAPH_LINE_GAP = 1.28;

window.api.onShowTranslation((data) => {
  const { screenshotPath, blocks } = data;
  stickerBlocks = blocks || [];

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
        wrapped = wrapText(ctx, block.translated, w);
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
      const textColor = bgColor.brightness > 128
        ? (bgColor.brightness > 200 ? '#1a1a1a' : '#000000')
        : (bgColor.brightness < 50 ? '#e0e0e0' : '#ffffff');
      ctx.fillStyle = textColor;
      ctx.font = `${weight} ${fontSize}px ${fontFamily}`;

      if (isParagraph) {
        ctx.textBaseline = 'top';
        const lineGap = Math.round(fontSize * PARAGRAPH_LINE_GAP);
        const totalH = wrapped.length * lineGap;
        // 段落整体在原框里垂直居中，行数变少时不会挤在顶上
        let ty = y + Math.max(0, Math.round((h - totalH) / 2));
        for (const line of wrapped) {
          ctx.fillText(line, x, ty, w);
          ty += lineGap;
        }
      } else {
        ctx.textBaseline = 'middle';
        // Use row-shared center Y so same-row blocks render text at the same vertical position
        ctx.fillText(block.translated, x, rowCenter, w);
      }
    });
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
});


/// 按框宽折行。中日韩逐字可断，拉丁词按空格断；一个词比整行还长时硬断。
function wrapText(ctx, text, maxWidth) {
  const lines = [];
  let current = '';
  const tokens = String(text).match(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]|[^\s\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]+|\s+/g) || [];
  for (const token of tokens) {
    if (/^\s+$/.test(token)) {
      if (current) current += ' ';
      continue;
    }
    const candidate = current + token;
    if (current && ctx.measureText(candidate).width > maxWidth) {
      lines.push(current.trimEnd());
      current = token;
    } else {
      current = candidate;
    }
  }
  if (current.trim()) lines.push(current.trimEnd());
  return lines.length ? lines : [String(text)];
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

function sampleEdgeColor(cleanCtx, x, y, w, h) {
  const m = 4;
  const points = [
    [x - m, y], [x - m, y + h/2], [x - m, y + h],
    [x + w + m, y], [x + w + m, y + h/2], [x + w + m, y + h],
    [x, y - m], [x + w/2, y - m], [x + w, y - m],
    [x, y + h + m], [x + w/2, y + h + m], [x + w, y + h + m],
  ];
  let sr = 0, sg = 0, sb = 0, n = 0;
  for (const [px, py] of points) {
    const cx = Math.max(0, Math.min(Math.round(px), canvas.width - 1));
    const cy = Math.max(0, Math.min(Math.round(py), canvas.height - 1));
    const p = cleanCtx.getImageData(cx, cy, 1, 1).data;
    sr += p[0]; sg += p[1]; sb += p[2]; n++;
  }
  const r = Math.round(sr / n), g = Math.round(sg / n), b = Math.round(sb / n);
  const brightness = (r * 299 + g * 587 + b * 114) / 1000;
  return { r, g, b, brightness };
}
