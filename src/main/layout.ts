import { TextBlock, WindowRect } from './ocr';
import { mergeInk } from './ink';
import { joinParts as joinLines } from './text-join';
import { debugLogVerbose } from './native';

// 版面重建：OCR 出来的块 → 过滤 → 聚行 → 并段。全屏翻译和区域翻译共用这一套，
// 测试脚本也直接调这里，所以这里不碰 Electron。
export function filterForeignBlocks(blocks: TextBlock[], targetLang: string): TextBlock[] {
  const targetPrefix = targetLang.split('-')[0];

  return blocks.filter(block => {
    const text = block.text.trim();
    if (!text) return false;
    // 只挡掉 OCR 基本没看清的；宁可多翻一块，也别把英文留在屏幕上
    if (block.confidence < 0.05) return false;


    if (/^[\d\s.,:;!?@#$%^&*()\-+=<>{}[\]|/\\~`'"•●○◆★☆✓✗→←↑↓©®™℃°…]+$/.test(text)) return false;
    if (isIdentifier(text) || isCodeLine(text)) return false;
    if (/^https?:\/\//.test(text)) return false;
    if (/^\.\w{1,4}$/.test(text)) return false;
    if (/^[0-9a-f]{6,}$/i.test(text)) return false;
    if (/^[\d.]+[KMGTkmgt]?[Bb]?\/s?$/.test(text)) return false;
    // 单个字母、单个符号翻了也没意义；两个字母以上一律翻
    if (!/[a-zA-Z\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]{2}/.test(text)) return false;

    if (targetPrefix === 'zh') {
      // 只和字母比，不算标点、数字、空格："终端Shell脚本 - 308字节" 是中文界面上的一行，不用翻
      const chineseChars = text.match(/[\u4e00-\u9fff]/g)?.length || 0;
      const latin = text.match(/[A-Za-z]/g)?.length || 0;
      return chineseChars < 2 || chineseChars / (chineseChars + latin) < 0.4;
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

/// OCR 给的是物理像素，浮层用 CSS 像素
export function toCss(b: TextBlock, scaleFactor: number): TextBlock {
  return {
    ...b,
    x: b.x / scaleFactor,
    y: b.y / scaleFactor,
    width: b.width / scaleFactor,
    height: b.height / scaleFactor,
    eraseBottom: b.eraseBottom !== undefined ? b.eraseBottom / scaleFactor : undefined,
  };
}

/// 擦原文的范围：框本身，框下面伸出去的下划线也要擦（最多伸出去半个框高，
/// 再远就不是这行字的下划线了）
export function eraseRectOf(b: TextBlock) {
  const bottom = b.y + b.height;
  const extra = b.eraseBottom && b.eraseBottom > bottom && b.eraseBottom <= bottom + b.height * 0.6 ? b.eraseBottom - bottom : 0;
  return { x: b.x, y: b.y, width: b.width, height: b.height + extra };
}

/// 段落配上译文。颜色关掉时把颜色信息整个拿掉，浮层就按以前的黑白字画。
export function withTranslation(block: ParagraphBlock, result: { text: string; spans: any[] } | undefined, inkOn: boolean) {
  const out: any = { ...block, translated: result?.text || '', spans: inkOn ? result?.spans || [] : [] };
  if (!inkOn) { delete out.ink; delete out.runs; delete out.underline; }
  delete out.eraseBottom;
  delete out.segs;
  return out;
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

export function groupIntoParagraphs(blocks: TextBlock[], screenWidth: number, windows: WindowRect[] = []): ParagraphBlock[] {
  const out: ParagraphBlock[] = [];
  for (const column of splitByWindow(blocks, windows).flatMap(w => splitIntoColumns(w, screenWidth))) {
    const lines = clusterIntoLines(column, screenWidth);
    for (const l of lines) {
      debugLogVerbose(`  行 ${Math.round(l.x)},${Math.round(l.y)} ${Math.round(l.width)}x${Math.round(l.height)} w=${(l.weight || 0).toFixed(3)} | ${l.text}`);
    }
    out.push(...dropSwallowed(groupLinesIntoParagraphs(lines)));
  }
  return out;
}

/// 截图那一刻的窗口换算到这块屏幕的 CSS 坐标（和 cssBlocks 同一套）
export function windowsOnDisplay(windows: WindowRect[], bounds: { x: number; y: number }): WindowRect[] {
  return windows.map(w => ({ ...w, x: w.x - bounds.x, y: w.y - bounds.y }));
}

/// 按窗口分组：每一块归给"从前往后第一个盖住它中心的窗口"，不在任何窗口里的
/// （菜单栏、桌面上的字）归一组。不同窗口的字不可能是同一句话——后面窗口的一行字
/// 一直伸到前面窗口的边上时，两窗之间的空白窄到分不出栏，只能靠这个。
function splitByWindow(blocks: TextBlock[], windows: WindowRect[]): TextBlock[][] {
  if (!windows.length) return [blocks];
  const groups = new Map<number, TextBlock[]>();
  for (const b of blocks) {
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
    const k = windows.findIndex(w => cx >= w.x && cx < w.x + w.width && cy >= w.y && cy < w.y + w.height);
    groups.set(k, [...(groups.get(k) || []), b]);
  }
  return [...groups.values()];
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
      const ix = Math.max(0, Math.min(b.x + b.width, other.x + other.width) - Math.max(b.x, other.x));
      const iy = Math.max(0, Math.min(b.y + b.height, other.y + other.height) - Math.max(b.y, other.y));
      // 内容判据：这一块的文字整句都在另一段里出现过，画上去只是把那段盖住一遍。
      // 得是压在同一个位置上：署名在信头和信尾各出现一次，那是两处正经内容，不是重复识别。
      const bText = norm(b.text);
      if (ix * iy > 0 && bText.length >= 12 && norm(other.text).includes(bText)) return true;
      // 几何判据：只针对"整个落在多行段落里的小块"。这类要么是碎片，要么是 OCR
      // 吐出的跨行大框，留着只会压在段落上。
      if (b.lineCount > 2 || other.lineCount < 2) return false;
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
        // 底色不一样就是两样东西（并排的两个按钮、标签和旁边的正文），挨得再近也不接
        const apart = differentBg(prev, part) && gap > Math.min(prev.height, part.height) * 0.3;
        if (gap > limit || part.gapBefore || apart) flushSegment();
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
    weight: lineWeight(parts),
    gapBefore: parts[0].gapBefore,
    docPara: parts.find(p => p.docPara !== undefined)?.docPara,
    ...mergeInk(parts),
  };
}

/// 一行的字重：各段按宽度加权平均，量不出来的段不算
function lineWeight(parts: TextBlock[]): number {
  let sum = 0, wsum = 0;
  for (const p of parts) if (p.weight) { sum += p.weight * p.width; wsum += p.width; }
  return wsum ? sum / wsum : 0;
}

/// 段内代表行高取中位数。取最大值的话，只要有一个框被 OCR 画高了，
/// 整段字号就会被顶上去，画出来是一坨压在别的段落上的大字。
export function medianHeight(lines: TextBlock[]): number {
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
  const margin = new Map(sorted.map(l => [l, rightMargin(l, sorted)]));
  const singlePitch = singleSpacingRatio(sorted);
  const pageH = sorted.length >= 4 ? medianHeight(sorted) : 0;

  for (const line of sorted) {
    let bestIdx = -1;
    let bestPitch = Infinity;
    for (let i = 0; i < groups.length; i++) {
      const last = groups[i][groups[i].length - 1];
      // 用"行距"（两行中心的距离）判断，不用"框之间的空当"。密排正文里字框几乎贴着，
      // 空当本来就接近 0，空一行也才多出半个字高——按空当判会把标题和下一段吸进上一段。
      // 行距则很干脆：同段约等于一倍行高，空一行直接翻倍。
      const pitch = (line.y + line.height / 2) - (last.y + last.height / 2);
      if (pitch < 0) continue;
      // 底色不同的两行不是同一段：弹窗正文和旁边的按钮、卡片里的字和卡片外的字
      if (differentBg(last, line)) continue;
      // Vision 的文档识别说它们在同一段里（大标题折成两行时行距很大，光看行距会拆开），
      // 字号接近、横向有重叠，就接上
      const docSame = line.docPara !== undefined && line.docPara === last.docPara
        && line.height < last.height * 1.5 && line.height > last.height * 0.66
        && Math.min(line.x + line.width, last.x + last.width) - Math.max(line.x, last.x) > 0
        && pitch < Math.max(last.height, line.height) * 2.2;
      if (docSame) { if (pitch < bestPitch) { bestPitch = pitch; bestIdx = i; } continue; }
      // 大标题折成两行：字比这一屏的正文大得多（1.8 倍以上）、两行左边缘对齐、字号相近，
      // 行距可以到字高的 1.9 倍（标题的行高按字号算，框高只有字号的七八成）
      const bigTitle = pageH > 0 && Math.min(last.height, line.height) >= pageH * 1.8
        && Math.abs(line.x - last.x) < Math.min(last.height, line.height) * 0.6
        && line.height < last.height * 1.3 && line.height > last.height * 0.77
        && pitch < Math.max(last.height, line.height) * 1.9
        && !(last.weight && line.weight && Math.max(last.weight, line.weight) > Math.min(last.weight, line.weight) * 1.25);
      if (bigTitle) { if (pitch < bestPitch) { bestPitch = pitch; bestIdx = i; } continue; }
      if (pitch > Math.max(last.height, line.height) * 1.45) continue;
      // 行距接近 0 = 本来就是同一条视觉行（行内被断开的两段），无条件接上，
      // 不看左边缘也不看字号——否则它们会各自成段，然后在同一个位置互相压着画。
      // 但隔得太远的不算：聚行时已经按"空当超过 4 倍字高"把它们劈开了（那是隔壁窗口、
      // 另一栏），这里再无条件接上就把刚劈开的又粘回去。
      const gapX = Math.max(line.x, last.x) - Math.min(line.x + line.width, last.x + last.width);
      const sameVisualLine = pitch < Math.min(last.height, line.height) * 0.5
        && gapX <= Math.max(last.height, line.height) * 4 && !line.gapBefore && !last.gapBefore;
      if (sameVisualLine) { if (pitch < bestPitch) { bestPitch = pitch; bestIdx = i; } continue; }
      if (line.height > last.height * 1.5 || line.height < last.height * 0.66) continue;
      if (endsShort(last, line, margin.get(last)!)) continue;
      // 段间距：行距明显大过这一页自己的单倍行距，就是两段之间多空出来的那一截
      if (singlePitch && pitch > singlePitch * 1.25 * Math.max(last.height, line.height)) continue;
      if (LIST_MARKER.test(line.text)) continue;
      // 字重不同不是同一段：粗体小标题后面紧跟正文、正文后面紧跟粗体标签。
      // 粗体的笔画大约是常规体的 1.5 倍，两者之间取 1.25 倍为界；量不出来的行不参与。
      if (last.weight && line.weight && Math.max(last.weight, line.weight) > Math.min(last.weight, line.weight) * 1.25) continue;
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
      weight: lineWeight(group),
      ...mergeInk(group),
    };
  });
}


/// 这一页的单倍行距（行距 ÷ 字高）。段落之间常常不空整行，只多出半行左右的段间距，
/// 拿固定倍数去卡分不开；但同一页里总有挨着排的行（段内的续行、信头、列表），
/// 它们的行距就是这一页的单倍行距。取上下相邻、字号相近、横向重叠的行对，
/// 行距比的低位数就是它。行对太少量不准，就不用这条。
function singleSpacingRatio(sorted: TextBlock[]): number {
  const ratios: number[] = [];
  sorted.forEach((line, i) => {
    for (let j = i - 1; j >= 0; j--) {
      const prev = sorted[j];
      const pitch = (line.y + line.height / 2) - (prev.y + prev.height / 2);
      const h = Math.max(prev.height, line.height);
      if (pitch < h * 0.5) continue;
      if (pitch > h * 3) break;
      const overlapX = Math.min(line.x + line.width, prev.x + prev.width) - Math.max(line.x, prev.x);
      if (overlapX <= 0 || prev.height > line.height * 1.25 || line.height > prev.height * 1.25) continue;
      ratios.push(pitch / h);
      break;
    }
  });
  if (ratios.length < 3) return 0;
  ratios.sort((a, b) => a - b);
  return ratios[Math.floor((ratios.length - 1) * 0.25)];
}

/// 以列表记号开头的行是新的一条，不接在上一行后面：编号、项目符号、带括号的序号。
/// 一条列表项自己折行时，续行不会以记号开头，照常并进来。
const LIST_MARKER = /^\s*(\d{1,3}[.)、]\s|[a-zA-Z][.)]\s|\(\d{1,3}\)\s?|[•·▪◦●○■□◆‣–—*-]\s|[①-⑳]|[一二三四五六七八九十]+、)/;

/// 排版常识：自动折行只在"下一个词放不下"时才发生，所以一段里除了最后一行都写到接近右边界。
/// 上一行右边空出来的地方明明放得下下一行的第一个词，却换行了——那是作者自己按的回车，
/// 这一段到此结束。设置页、FAQ、列表都是一行一条，靠这条才不会被并成一大段。
///
/// 词宽按下一行自己的平均字宽估，多留两个字的余量吸收比例字体的误差；
/// 中日韩文字不靠空格断词，任何一个字都能折行，第一个"词"就是一个字。
function endsShort(last: TextBlock, next: TextBlock, marginRight: number): boolean {
  const text = next.text.trim();
  if (!text) return false;
  const charW = next.width / text.length;
  const firstWord = /^[\u3000-\u9fff\uac00-\ud7af\uff00-\uffef]/.test(text) ? 1 : text.split(/\s+/)[0].length;
  const room = marginRight - (last.x + last.width);
  return room > (firstWord + 2) * charW;
}

/// 一行所在那块文字的右边界：同一缩进（左边缘相近、字号相近）的那些行里最靠右的一端。
/// 只看同缩进的行，引用块、缩进块才会按它们自己的右边界算，不会拿整栏最宽的正文来比。
/// 取最大值而不是高位数：设置页、列表里大多数行都是短标签，真正折到右边界的只有一两行，
/// 高位数会落在"普通说明文字的宽度"上而不是右边界。以前担心个别被拼宽的行把边界顶上去，
/// 现在不同窗口、不同栏的字已经先分开了，同一块文字里不会再有这种行。
function rightMargin(line: TextBlock, lines: TextBlock[]): number {
  const rights = lines
    .filter(o => Math.abs(o.x - line.x) <= line.height * 1.5
      && o.height < line.height * 1.5 && o.height > line.height * 0.66)
    .map(o => o.x + o.width)
    .sort((a, b) => a - b);
  return rights.length ? Math.max(line.x + line.width, rights[rights.length - 1]) : line.x + line.width;
}

/// Vision 偶尔会把一行只认出半个字高——框高只有整屏行高中位数的一半，
/// 认出来的字也跟着缺一半：reflow it, measure it, or translate it ... 会变成
/// "ret low 1t. measure lt. or translate lt as a sınole unıt ratner tan quessına"。
/// 这种半高框翻出来必然是乱码，贴上去比留着原文更难看，直接丢掉。
/// 阈值取整屏行高中位数的 0.6 倍：正常的小字号说明文字不会小到正文的六成以下，
/// 真掉了一两块小字也比贴一行乱码强。渲染层还另有一个字号下限兜底。
export function dropUndersizedBoxes(blocks: TextBlock[]): TextBlock[] {
  if (blocks.length < 6) return blocks;
  const median = medianHeight(blocks);
  return blocks.filter(b => b.height >= median * 0.6);
}

/// OCR 对同一片像素偶尔会多吐一个"糊在一起"的框：字是错的、高度跨了两行，
/// 置信度也明显低于旁边的正常块（实测 0.5 对 1.0）。它和正常块叠在一起，
/// 一行串下来就是 "their vertical center, L he ter, soreandrome tot size" 这种乱码。
/// 判据：置信度偏低，而且压在一个高置信度的块上——正常版面里文字框互不重叠，
/// 所以不会误伤真正认得出的低置信度文字（那种一般是孤立的小字）。
export function dropLowConfidenceOverlaps(blocks: TextBlock[]): TextBlock[] {
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
export function dropDuplicateBoxes(blocks: TextBlock[]): TextBlock[] {
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
export function dropOversizedBoxes(blocks: TextBlock[]): TextBlock[] {
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

export function rectOverlapRatio(a: {x:number,y:number,width:number,height:number}, b: {x:number,y:number,width:number,height:number}): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const bArea = b.width * b.height;
  return bArea > 0 ? (ix * iy) / bArea : 0;
}


/// 图标被 OCR 认成字的块：SF Symbols 的私用区字符、方方正正的小符号。去掉或剥掉图标部分。
/// 坐标是物理像素（OCR 原样输出），所以尺寸阈值要乘 scaleFactor。
export function dropIconBlocks(blocks: TextBlock[], scaleFactor: number): TextBlock[] {
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
  const cleanOcr = blocks.flatMap(ocr => {
    let text = ocr.text.trim();

    // Reject icon-shaped blocks (small + square OR small + thin)
    // 只看形状会把短的真词也当图标丢掉（折行剩下的 "sent."、按钮上的 "OK"）。
    // 图标被认成字时是符号或单个字、置信度也低；两个以上字母、认得有把握的就是字。
    const looksLikeWord = /\p{L}{2,}/u.test(text) && ocr.confidence >= 0.5;
    const r = ocr.width / Math.max(ocr.height, 1);
    const isSmall = ocr.width < 50 * scaleFactor && ocr.height < 50 * scaleFactor;
    if (!looksLikeWord && isSmall && r > 0.4 && r < 2.5) return []; // square-ish icon
    if (!looksLikeWord && ocr.width < 30 * scaleFactor && ocr.height < 30 * scaleFactor) return []; // tiny

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

  return cleanOcr;
}

/// 两块字底下的颜色差得开（按钮 vs 页面、卡片 vs 背景）。量不出底色的不算不同。
export function differentBg(a: TextBlock, b: TextBlock): boolean {
  if (!a.bg || !b.bg) return false;
  const [r1, g1, b1] = a.bg, [r2, g2, b2] = b.bg;
  return Math.hypot(r1 - r2, g1 - g2, b1 - b2) > 60;
}

// ---------------------------------------------------------------------------
// 文字清理和"不该翻"的判断
// ---------------------------------------------------------------------------

/// 西里尔字母里长得和拉丁字母一模一样的那些。Vision 开着自动判断语言时，
/// 偶尔把英文里的 A、P、I 认成西里尔的 А、Р、І（"IP geolocation АРІ"），
/// 翻译服务就当成俄文不翻了。
const HOMOGLYPH: Record<string, string> = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
  'У': 'Y', 'І': 'I', 'Ј': 'J', 'Ѕ': 'S',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's', 'ԁ': 'd',
};

/// OCR 文本的清理：
/// - 夹在英文里的西里尔形近字母换回拉丁字母（整块真是俄文的不动）
/// - IPv6、十六进制串里的字母 O 换回数字 0（"2620:1COO:FACE:BOOC::"）
export function normalizeOcrText(text: string): string {
  let t = text;
  const latin = (t.match(/[A-Za-z]/g) || []).length;
  const cyr = (t.match(/[\u0400-\u04ff]/g) || []).length;
  if (cyr && latin >= cyr) t = t.replace(/[\u0400-\u04ff]/g, ch => HOMOGLYPH[ch] ?? ch);
  t = t.replace(/\b[0-9A-Fa-fOo]{1,4}(?::[0-9A-Fa-fOo]{0,4}){2,7}\b:*/g, m => /\d/.test(m) ? m.replace(/[Oo]/g, '0') : m);
  return t;
}

/// 词尾的下拉箭头、"›" 被认成了字母："Products v"、"Resources v"、"GET STARTED >"。
/// 去掉它，框也按字数比例收回来一截，箭头本身就不会被擦掉。
export function stripTrailingIcon(b: TextBlock): TextBlock {
  const m = b.text.match(/^(.*\p{L}{2,}.*?)\s+(?:[vy~>›»⌄˅˄⌃∨•·]|>>|»»)$/u);
  if (!m) return b;
  const kept = m[1].trimEnd();
  const width = b.width * Math.min(1, (kept.length + 0.5) / b.text.length);
  return { ...b, text: kept, width };
}

/// 代码、命令、JSON 的一行。翻出来没有意义，还会把键名翻成中文。
export function isCodeLine(text: string): boolean {
  const t = text.trim();
  if (!t) return false;
  if (/^(\/\/|#!|```|<\/?[a-z][\w-]*[ >])/i.test(t)) return true;
  if (/^[{}\[\]();,:\s]+$/.test(t)) return true;
  // JSON / YAML：键加冒号。OCR 常把引号认丢，所以引号可有可无，但键名得像个标识符
  if (/^["'“”‘’]{0,3}[A-Za-z_$][\w$.-]*["'“”‘’]{0,3}\s*:\s*(["'“”{\[]|-?\d|true|false|null|t\}|\{|$)/.test(t)) return true;
  if (/^["'“”‘’]{1,3}[\w$ .-]+["'“”‘’]{1,3}\s*:/.test(t)) return true;
  // 面包屑路径："Macintosh HD › 用户 › yxy › Claude"
  if ((t.match(/\s[>›»]\s/g) || []).length >= 2) return true;
  // 命令行（含 "yxy@MacBook ~ % ls" 这种带提示符的）
  if (/^[$%>❯]\s*\S/.test(t)) return true;
  if (/^[\w.-]+@[\w.-]+(?::\S*)?\s*\S*\s*[%$#]\s/.test(t)) return true;
  if (/(?:^|\s)[~\/][^\s]*\s?[%$#]\s+\S/.test(t)) return true; // "MacBook ~% ls"：@ 被认成别的字也能认出提示符
  if (/^(?:\/[\w.\-\u4e00-\u9fff]+){2,}/.test(t) && !/\s\w+\s\w+\s\w+/.test(t)) return true; // 以路径开头的一行
  if (/^(?:git|npm|npx|pnpm|yarn|pip3?|python\d*|node|curl|wget|brew|cd|ls|sudo|docker|kubectl|cargo|go|swift|make|ssh|scp|chmod|mkdir|rm|cp|mv|cat|echo|export)\s+[-\w./:~$"']/.test(t)) return true;
  // 程序语句
  if (/^(?:export\s+)?(?:const|let|var|func|function|def|class|struct|enum|import|from|return|public|private|static|#include|using|package)\s+\S/.test(t)
    && /[=(){};:<>]/.test(t)) return true;
  if (/^[A-Za-z_$][\w$.]*\s*(?:=|\+=|=>|\()\s*\S.*[;{)]\s*$/.test(t)) return true;
  return false;
}

/// 整块就是一个"标识"：IP 地址、IPv6、AS 号、网址、邮箱、版本号、文件名、变量名。
export function isIdentifier(text: string): boolean {
  const t = text.trim().replace(/[.,;:]+$/, '');
  if (!t) return false;
  if (/^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d{1,2})?(?::\d+)?$/.test(t)) return true; // IPv4
  if (/^[0-9a-f]{0,4}(?::[0-9a-f]{0,4}){2,7}(?:\/\d+)?$/i.test(t) && /\d/.test(t)) return true; // IPv6
  if (/^AS\d{1,10}$/i.test(t)) return true;
  if (/^(?:https?|ftp|file|ssh|git):\/\/\S+$/i.test(t)) return true;
  if (/^(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/i.test(t) && /\.[a-z]{2,}(?:\/|$)/i.test(t) && !/\s/.test(t)) return true; // 域名、路径
  if (/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(t)) return true;
  if (/^v?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/.test(t)) return true;
  if (/^[.…]*[\p{L}\p{N}_ -]*\.(?:js|ts|tsx|jsx|py|swift|m|h|c|cpp|go|rs|rb|java|kt|json|ya?ml|toml|md|txt|csv|log|sh|command|zsh|bash|app|zip|dmg|pkg|tgz|gz|png|jpe?g|gif|svg|pdf|html?|css|docx?|xlsx?|pptx?)$/iu.test(t)) return true; // 文件名
  if (/^[.…]+[\p{L}\p{N}_-]+$/u.test(t)) return true; // 被截断的名字："...command"
  if (/^[a-z]+(?:_[a-z0-9]+)+$/.test(t)) return true; // snake_case
  if (/^[a-z]+(?:[A-Z][a-z0-9]+)+$/.test(t) && t.length >= 6) return true; // camelCase
  return false;
}

/// 品牌 logo 被当成了字：一个词、框特别高（比全屏常见行高高一倍以上）、Vision 自己也没把握。
/// 或者是 "IPinfo"、"GitHub" 这种大小写混写的专名单独成块。
export function looksLikeLogo(b: TextBlock, medianH: number): boolean {
  const t = b.text.trim();
  if (!t || /\s/.test(t)) return false;
  if (b.confidence <= 0.55 && medianH > 0 && b.height >= medianH * 2.2) return true;
  if (/^[A-Z]{2,}[a-z]{2,}$/.test(t) || /^[A-Z][a-z]+[A-Z][a-z]+$/.test(t) || /^[a-z][A-Z][a-z]{2,}$/.test(t)) return true;
  return false;
}

/// 代码块里夹着一两行没被认出来的（引号认歪了、只剩半截）：上下左右挨着的几行多数是代码、
/// 底色也一样，它也算代码。只看同一片底色里、上下三行以内、横向有重叠的邻居。
export function spreadCode(blocks: TextBlock[], isCode: (b: TextBlock) => boolean): Set<TextBlock> {
  const code = new Set(blocks.filter(isCode));
  if (!code.size) return code;
  for (const b of blocks) {
    if (code.has(b)) continue;
    const near = blocks.filter(o => o !== b
      && Math.abs((o.y + o.height / 2) - (b.y + b.height / 2)) < Math.max(o.height, b.height) * 3.5
      && Math.min(o.x + o.width, b.x + b.width) - Math.max(o.x, b.x) > 0
      && !differentBg(o, b));
    const n = near.filter(o => code.has(o)).length;
    if (near.length >= 2 && n * 3 >= near.length * 2) code.add(b);
  }
  return code;
}

/// 同一行被切成了两块、而且两块互相重叠（格子边上被认了两次，一块认到 "then open Settings to choo"，
/// 另一块认到 "Settings to choose a translation service."）：拼成一块，重叠的那几个词只留一份。
export function mergeCutLines(blocks: TextBlock[]): TextBlock[] {
  const out = [...blocks].sort((a, b) => a.x - b.x);
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i], b = out[j];
      const vy = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
      if (vy < Math.min(a.height, b.height) * 0.6) continue;
      const hx = a.x + a.width - b.x;
      if (hx <= Math.min(a.height, b.height) * 0.5 || b.x + b.width <= a.x + a.width) continue;
      // b 开头两个词在 a 的后半截里出现的位置，就是接缝
      const head = b.text.trim().split(/\s+/).slice(0, 2).join(' ');
      const est = Math.round(((b.x - a.x) / a.width) * a.text.length);
      let cut = head.length >= 3 ? a.text.indexOf(head, Math.max(0, est - 12)) : -1;
      if (cut < 0) {
        cut = a.text.lastIndexOf(' ', Math.min(a.text.length, est + 2));
        if (cut < 0) continue;
      }
      const merged: TextBlock = {
        ...a,
        text: a.text.slice(0, cut).trimEnd() + ' ' + b.text.trim(),
        width: b.x + b.width - a.x,
        y: Math.min(a.y, b.y),
        height: Math.max(a.y + a.height, b.y + b.height) - Math.min(a.y, b.y),
        confidence: Math.min(a.confidence, b.confidence),
      };
      out[i] = merged;
      out.splice(j, 1);
      j = i;
    }
  }
  return out;
}
