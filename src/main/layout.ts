import { TextBlock, WindowRect } from './ocr';
import { mergeInk } from './ink';
import { joinParts as joinLines } from './text-join';
import { debugLogVerbose } from './native';

// 版面重建：OCR 出来的块 → 过滤 → 聚行 → 并段。全屏翻译和区域翻译共用这一套，
// 测试脚本也直接调这里，所以这里不碰 Electron。
export function filterForeignBlocks(blocks: TextBlock[], targetLang: string): TextBlock[] {
  const targetPrefix = targetLang.split('-')[0];
  const KANA = /[\u3040-\u30ff]/g, HAN = /[\u4e00-\u9fff]/g, HANGUL = /[\uac00-\ud7af]/g, LATIN = /[A-Za-z]/g;
  const count = (t: string, re: RegExp) => (t.match(re) || []).length;
  // 这一屏是不是日文页面：有好几块带假名。日文里只有汉字的短词（"政治"、"経済"）单看分不出是中文还是日文，
  // 在日文页面上就当日文送去翻；真是中文的话翻译回来和原文一样，后面会被丢掉，不会画
  const kanaBlocks = blocks.filter(b => count(b.text, KANA) >= 2).length;
  const japanesePage = kanaBlocks >= 3 && kanaBlocks >= blocks.length * 0.1;
  // 这一屏是不是中文页面（中文版的 Stripe、Meta 登录页）：带汉字、不带假名的块占四成以上。
  // 中文界面里夹着英文产品名、按钮名（"使用 Payment Link"、"API 和 SDK"、"Cookie 政策"）是正常写法，不用翻，
  // 送去翻只会把中文改坏（"收费链接"、"市场和SDKY"）
  const lettered = blocks.filter(b => /\p{L}{2}/u.test(b.text));
  const chinesePage = !japanesePage && lettered.length >= 5
    && lettered.filter(b => count(b.text, HAN) >= 2 && !count(b.text, KANA)).length >= lettered.length * 0.4;

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
    // 任何文字的字母都算（俄文、希腊文、阿拉伯文……以前只认拉丁字母，俄文整页被当成不用翻）
    if (!/\p{L}{2}/u.test(text)) return false;

    const han = count(text, HAN), kana = count(text, KANA), hangul = count(text, HANGUL), latin = count(text, LATIN);
    // 其他文字的字母（西里尔、希腊、阿拉伯、泰文……）一律算外文，和拉丁字母同等对待
    const other = (text.match(/\p{L}/gu) || []).length - han - kana - hangul - latin - count(text, /[\u3400-\u4dbf]/g);
    if (targetPrefix === 'zh') {
      // 只和字母比，不算标点、数字、空格："终端Shell脚本 - 308字节" 是中文界面上的一行，不用翻。
      // 假名、谚文是外文（日文、韩文），和拉丁字母一样算
      const foreign = latin + kana + hangul + other;
      // 中文里不会出现假名、谚文：有两个以上就是日文、韩文，不管汉字占多少
      if (kana + hangul >= 2) return true;
      if (chinesePage && han >= 1) return false;
      if (han < 2) return foreign >= 2;
      if (japanesePage && kana + latin + hangul === 0) return true;
      return han / (han + foreign) < 0.4;
    }
    if (targetPrefix === 'ja') {
      // 有假名就是日文；只有汉字、页面上又没有日文，就是中文，要翻
      if (kana) return (kana + han) / (kana + han + latin + hangul + other) < 0.4;
      if (han && !japanesePage) return true;
      return han / Math.max(1, han + latin + hangul + other) < 0.4;
    }
    if (targetPrefix === 'ko') {
      return hangul / Math.max(1, hangul + han + kana + latin + other) < 0.4;
    }
    if (['en', 'fr', 'de', 'es', 'pt', 'it'].includes(targetPrefix)) {
      return latin / text.length < 0.5;
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
    icons: b.icons?.map(r => ({ x: r.x / scaleFactor, y: r.y / scaleFactor, width: r.width / scaleFactor, height: r.height / scaleFactor })),
  };
}

/// 擦原文的范围：框本身，框下面伸出去的下划线也要擦（最多伸出去半个框高，
/// 再远就不是这行字的下划线了）
export function eraseRectOf(b: TextBlock) {
  const bottom = b.y + b.height;
  const extra = b.eraseBottom && b.eraseBottom > bottom && b.eraseBottom <= bottom + b.height * 0.6 ? b.eraseBottom - bottom : 0;
  // underline：带下划线的字，擦的时候字下面那道线也算字的一部分（浮层会按下划线重画）；
  // cjk：中日韩文（至少两个字；"English、" 那种把下拉箭头认成顿号的不算），擦的时候把紧挨着框、没被框进来的标点（」！＞）一起擦
  return { x: b.x, y: b.y, width: b.width, height: b.height + extra,
    underline: !!(b.underline || extra), cjk: (String(b.text || '').match(/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/g) || []).length >= 2 };
}

/// 段落配上译文。颜色关掉时把颜色信息整个拿掉，浮层就按以前的黑白字画。
export function withTranslation(block: ParagraphBlock, result: { text: string; spans: any[] } | undefined, inkOn: boolean) {
  const out: any = { ...block, translated: result?.text || '', spans: inkOn ? result?.spans || [] : [] };
  // 色段没找到、又比主色的字还长时，翻译那边改了主色（见 translateWithSnippets）
  if (inkOn && (result as any)?.ink) out.ink = (result as any).ink;
  if (!inkOn) { delete out.ink; delete out.runs; delete out.underline; }
  delete out.eraseBottom;
  delete out.segs;
  delete out.members;
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
        // 菜单项：空了一个字高以上，一边只有一两个词、右边大写开头，是并排的两项，不是一句话
        const words = (t: string) => t.trim().split(/\s+/).length;
        const segText = segment.map(b => b.text).join(' ');
        const menuItems = gap > Math.max(prev.height, part.height) * 1.0
          && (words(segText) <= 2 || words(part.text) <= 2) && !/^[a-z]/.test(part.text.trim());
        if (menuItems) part.gapBefore = true;
        // 字色差得很远（蓝色链接标题和后面灰色的域名、作者）又空了半个字高以上：是并排的两样东西
        const inkDiff = prev.ink && part.ink
          ? Math.abs(prev.ink[0] - part.ink[0]) + Math.abs(prev.ink[1] - part.ink[1]) + Math.abs(prev.ink[2] - part.ink[2]) : 0;
        if (inkDiff > 150 && gap > Math.max(prev.height, part.height) * 0.5) part.gapBefore = true;
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
    members: parts.flatMap(p => p.members || [p]),
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
  const downPitch = new Map(sorted.map(l => [l, nextLinePitch(l, sorted)]));
  // 找"条与条之间"的行距时看远一点（OCR 框偏矮时，1.9 倍字高够不着下一条）
  const upPitch = new Map(sorted.map(l => [l, prevLinePitch(l, sorted, 2.8)]));
  const downPitchFar = new Map(sorted.map(l => [l, nextLinePitch(l, sorted, 2.8)]));
  const bodyEm = sorted.length ? [...sorted.map(emOf)].sort((a, b) => a - b)[Math.floor(sorted.length / 2)] : 0;

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
      // 行距按字号（em）比，不按框高比：框高取决于这一行有没有 g、p、y 这类下伸字母，
      // 全是大写或没有下伸的一行（标题、按钮）框只有字号的七成，按框高算会把正常行距当成段间距
      const emMax = Math.max(emOf(last), emOf(line));
      const emMin = Math.min(emOf(last), emOf(line));
      // 上一行停在词中间或逗号上、下一行小写开头：一定是同一句话折了行
      // 以虚词（and、the、of…）收尾的行也一定没说完，下一行大写开头也照样接上
      const lastWords = last.text.trim().split(/\s+/).length;
      const continues = (/[\p{L},;\-–—]$/u.test(last.text.trim()) && /^\p{Ll}/u.test(line.text.trim()) && !/[\u3040-\u30ff\u3400-\u9fff]$/.test(last.text.trim()))
        || /[,\-–]$/.test(last.text.trim())
        // 中日文任何字后都能折行：上一行没以句末标点收尾、下一行也是中日文，就是同一句
        // 标题常以」』、・结尾；韩文有空格，不按词数卡
        || (/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af」』）)、・…]$/.test(last.text.trim()) && /^[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af「『（(]/.test(line.text.trim())
          && (lastWords === 1 || /[\uac00-\ud7af]/.test(last.text)) && last.text.trim().length >= 12
          // 韩文标题以 -다/-요/-까 收尾就是一句完了（不带句号）
          && !/[다요까죠네]$/.test(last.text.trim()))
        || /\b(and|or|the|a|an|of|to|in|on|for|with|by|from|at|as|their|its|his|her|our|your|is|are|was|were|be|that|which)$/i.test(last.text.trim())
        // 介词收尾也没说完，但一个词单独成行的（菜单里的 "About"）不算
        || (lastWords >= 2 && /\b(between|about|into|onto|than|like|without|within|via|using|through|across|toward|towards|among|versus|vs\.?)$/i.test(last.text.trim()));
      // 网页正文的行高一般是字号的 1.4–1.8 倍（维基 1.6），上限放到 1.9 倍；
      // 段与段之间多出来的段距交给下面"和本段已有行距一致"那条去分。
      if (pitch > emMin * 1.9) continue;
      // 行距接近 0 = 本来就是同一条视觉行（行内被断开的两段），无条件接上，
      // 不看左边缘也不看字号——否则它们会各自成段，然后在同一个位置互相压着画。
      // 但隔得太远的不算：聚行时已经按"空当超过 4 倍字高"把它们劈开了（那是隔壁窗口、
      // 另一栏），这里再无条件接上就把刚劈开的又粘回去。
      const gapX = Math.max(line.x, last.x) - Math.min(line.x + line.width, last.x + last.width);
      const sameVisualLine = pitch < Math.min(last.height, line.height) * 0.5
        && gapX <= Math.max(last.height, line.height) * 4 && !line.gapBefore && !last.gapBefore;
      if (sameVisualLine) { if (pitch < bestPitch) { bestPitch = pitch; bestIdx = i; } continue; }
      // 不能跳行：两行之间夹着别的行（横向和新行重叠），就不是同一段
      const lc = last.y + last.height / 2, nc = line.y + line.height / 2;
      if (sorted.some(o => o !== last && o !== line
        && (o.y + o.height / 2) > lc + 2 && (o.y + o.height / 2) < nc - 2
        && Math.min(o.x + o.width, line.x + line.width) - Math.max(o.x, line.x) > 0)) continue;
      // 上下两行字色差得很远（蓝色链接标题和下面灰色的作者行、日期行）：不是同一段，句子像没说完也不接
      // 下一行起头比上一行靠右一截（前面有头像、图标、缩进）：新的一段。正常折行下一行从同一个左边起头；
      // OCR 把行首切走的情况在聚行时已经接回来了，这里看到的是整行
      // 居中排版（Cookie 说明、信息框、提示条）每行起头本来就不同：两行中心对齐的不算
      const centered = Math.abs((line.x + line.width / 2) - (last.x + last.width / 2)) < emMin;
      if (line.x - last.x > emMin * 1.2 && !centered) continue;
      // 行首有图标（目录的 ›、列表的 •、展开箭头）：新的一条。条目折行时第二行前面没有图标，照样接上
      if (leadIcon(line)) continue;
      // 光颜色不同不算（正文里某一行链接多，主色就成了蓝色），还得字号或粗细也明显不同
      const inkGap = last.ink && line.ink ? Math.abs(last.ink[0] - line.ink[0]) + Math.abs(last.ink[1] - line.ink[1]) + Math.abs(last.ink[2] - line.ink[2]) : 0;
      // 颜色差一截、下一行又往右缩进了半个字以上（蓝色标题下面前面有头像的灰色"via 某某 几小时前"）：两样东西。
      // 正文折行的下一行从同一个左边起头，链接再多也不缩进
      if (inkGap > 100 && line.x - last.x > emMin * 0.6 && !centered) continue;
      const weightRatio = last.weight && line.weight ? Math.max(last.weight, line.weight) / Math.min(last.weight, line.weight) : 1;
      if (inkGap > 150 && (emMax > emMin * 1.12 || weightRatio > 1.2)) continue;
      // 颜色差一截、粗细也差一截（粗体彩色标题和下面细体灰字）：两样东西，句子像没说完也不接
      if (inkGap > 100 && weightRatio > 1.25) continue;
      // 容差放宽到 1.6：带上标引用（[1][2]）的行框会被撑高一半，字号其实一样
      // 但只有句子明显没说完时才放这么宽；否则 1.3 倍：HN 的标题和下面的小字只差 1.4 倍，是两段
      // 但一条目录项折成两三行时，条内的行距明显比条与条之间紧（德文维基 "Absorption von / Lichtenergie"：
      // 19 像素 vs 27 像素）。德文名词大写，靠"下一行小写开头"认不出来，靠行距能认出来
      // 上下两边都得有邻行、而且这一对比上下两边都明显紧，才算条内折行：均匀排的菜单、目录一条挨一条不会被误并
      const upP = upPitch.get(last) || 0, downP = downPitchFar.get(line) || 0;
      const tightItem = upP > 0 && downP > 0 && pitch < Math.min(upP, downP) * 0.85;
      // 条内行距紧的多行目录项，OCR 给的框高常常差很多（13.5 vs 22 像素），字号容差放宽
      const emTol = tightItem ? 2.0 : continues ? 1.6 : 1.35;
      if (emOf(line) > emOf(last) * emTol || emOf(line) < emOf(last) / emTol) continue;
      if (!continues && endsShort(last, line, margin.get(last)!)) continue;
      // 短条目：目录、菜单、侧栏里一条一行，整片都窄，右边界判断不出来。
      // 正常折行的正文一行远不止 5 个词；拉丁文字才用这条（中日韩不按空格分词）。
      // 下一行也短才算：下一行是长句时，上一行多半是标题折了行（“Huge crowds greet / Pope in Paris for…”）
      // 字号明显大于正文的是标题，标题折行常常每行只有几个词，不按短条目切
      if (!continues && !tightItem && isLatin(last.text) && lastWords <= 5 && line.text.trim().split(/\s+/).length <= 5
        && Math.min(emOf(last), emOf(line)) < bodyEm * 1.3) continue;
      // 段间距：本段已经有两行以上时，新行的行距要和本段自己的行距一致——
      // 段落之间只多出小半行，按固定倍数卡不住，按本段自己的节奏一比就出来了。
      // 句子明显没说完（上面 continues）时不看节奏：段落最后一行几乎总是以句号收尾，
      // 行框被上标、括号撑高带来的行距误差也就不会把一句话切开
      const g = groups[i];
      const tol = 1.12;
      if (continues) { /* 同一句话，照接 */ } else if (g.length >= 2) {
        const ps = g.slice(1).map((l, k) => (l.y + l.height / 2) - (g[k].y + g[k].height / 2)).sort((a, b) => a - b);
        const ownPitch = ps[Math.floor(ps.length / 2)];
        if (ownPitch > 0 && pitch > ownPitch * tol + 2) continue;
      } else {
        // 本段只有一行时，拿"新行和它下一行"的行距当参照：新行如果是下一段的开头，
        // 它和自己段里下一行的行距就是那一段的节奏，这里明显更宽就是段距
        const down = downPitch.get(line);
        if (down && pitch > down * tol + 2) continue;
        if (!down && singlePitch && pitch > Math.max(singlePitch * 1.25, 1.75) * emMin) continue;
      }
      if (LIST_MARKER.test(line.text)) continue;
      // 字重不同不是同一段：粗体小标题后面紧跟正文、正文后面紧跟粗体标签。
      // 粗体的笔画大约是常规体的 1.5 倍，两者之间取 1.25 倍为界；量不出来的行不参与。
      // 句子没说完时不看字重（首句开头的粗体词）；但只有两三个词的粗体小标签（“Next topic”）后面跟链接，照样分开
      if (!(continues && lastWords > 5) && last.weight && line.weight && Math.max(last.weight, line.weight) > Math.min(last.weight, line.weight) * 1.25) continue;
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
      members: group.flatMap(l => l.members || [l]),
      ...mergeInk(group),
    };
  });
}


/// 这一行最左边那块的左侧紧挨着一个识别时拿掉的图标（›、•、▸）。
/// 字框本身多出来的空白也记在 icons 里，但它和字是贴着的（空当 0），不算
function leadIcon(l: TextBlock): boolean {
  const parts = l.members || [l];
  const first = parts.reduce((a, b) => (a.x <= b.x ? a : b));
  const em = emOf(l);
  return !!first.icons?.some(ic => ic.x + ic.width < first.x - 2 && first.x - (ic.x + ic.width) < em * 1.5
    && ic.y < first.y + first.height && ic.y + ic.height > first.y);
}

function isLatin(t: string): boolean {
  return /\p{L}/u.test(t) && !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(t);
}

/// 一行到它正下方下一行（横向重叠、字号相近、底色一样）的行距，找不到返回 0
/// 往上一行的行距（同一栏、字号相近），没有就是 0
function prevLinePitch(line: TextBlock, sorted: TextBlock[], maxEm = 1.9): number {
  const cy = line.y + line.height / 2;
  let best = 0;
  for (const o of sorted) {
    const p = cy - (o.y + o.height / 2);
    if (p < emOf(line) * 0.5 || p > emOf(line) * maxEm) continue;
    const overlapX = Math.min(line.x + line.width, o.x + o.width) - Math.max(line.x, o.x);
    if (overlapX <= 0 || differentBg(line, o)) continue;
    if (emOf(o) > emOf(line) * 1.6 || emOf(o) < emOf(line) * 0.62) continue;
    if (!best || p < best) best = p;
  }
  return best;
}

function nextLinePitch(line: TextBlock, sorted: TextBlock[], maxEm = 1.9): number {
  const cy = line.y + line.height / 2;
  let best = 0;
  for (const o of sorted) {
    const p = o.y + o.height / 2 - cy;
    if (p < emOf(line) * 0.5 || p > emOf(line) * maxEm) continue;
    const overlapX = Math.min(line.x + line.width, o.x + o.width) - Math.max(line.x, o.x);
    if (overlapX <= 0 || differentBg(line, o)) continue;
    if (emOf(o) > emOf(line) * 1.6 || emOf(o) < emOf(line) * 0.62) continue;
    if (!best || p < best) best = p;
  }
  return best;
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
      const h = Math.max(emOf(prev), emOf(line));
      if (pitch < h * 0.5) continue;
      if (pitch > h * 3) break;
      const overlapX = Math.min(line.x + line.width, prev.x + prev.width) - Math.max(line.x, prev.x);
      if (overlapX <= 0 || emOf(prev) > emOf(line) * 1.25 || emOf(line) > emOf(prev) * 1.25) continue;
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
  // 只看上下几行之内的：正文旁边有浮动的图框、信息框时，折行宽度是一段一段变的，
  // 拿整栏最宽的一行（比如框上方跨满全宽的那行）来比，框旁边的每一行都会被判成"提前换行"
  const cy = line.y + line.height / 2;
  const rights = lines
    .filter(o => Math.abs(o.y + o.height / 2 - cy) <= line.height * 15)
    .filter(o => Math.abs(o.x - line.x) <= line.height * 1.2
      && o.height < line.height * 1.5 && o.height > line.height * 0.66)
    .map(o => o.x + o.width)
    .sort((a, b) => a - b);
  // 取第二宽的：挡掉个别跨满全宽的行（框上方那行、提示行），又不会被一串短条目带短
  const edge = rights.length >= 3 ? rights[rights.length - 2] : rights[rights.length - 1];
  return rights.length ? Math.max(line.x + line.width, edge) : line.x + line.width;
}

/// Vision 偶尔会把一行只认出半个字高——框高只有整屏行高中位数的一半，
/// 认出来的字也跟着缺一半：reflow it, measure it, or translate it ... 会变成
/// "ret low 1t. measure lt. or translate lt as a sınole unıt ratner tan quessına"。
/// 这种半高框翻出来必然是乱码，贴上去比留着原文更难看，直接丢掉。
/// 判据：同一行上紧挨着一个比它高得多（1.67 倍以上）的块——同一行的字本来一样高。
export function dropUndersizedBoxes(blocks: TextBlock[]): TextBlock[] {
  // 只和同一行、挨着的块比：以前拿整屏行高中位数比，大字多的页面（博客、营销页）上
  // 一排正常的小号导航会被整排当成"半高框"丢掉
  return blocks.filter(b => !blocks.some(o => {
    if (o === b || o.height * 0.6 <= b.height) return false;
    const oc = o.y + o.height / 2, bc = b.y + b.height / 2;
    if (Math.abs(oc - bc) > o.height * 0.5) return false;
    const gap = Math.max(o.x, b.x) - Math.min(o.x + o.width, b.x + b.width);
    // 认坏的半截框要么认得没把握，要么和整行紧贴着；
    // 离得远、认得有把握的是正常的小字（大号 logo 旁边的导航、侧栏目录挨着带上标的正文）
    return gap < o.height * 3 && (b.confidence < 0.9 || gap < o.height * 0.5);
  }));
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
      // 内容判据：这个大框把压在它身上的别的块的整句都吞了进去，说明它是几行糊在一起的复合框。
      // 得真的压在一起：页面别处（目录、面包屑）出现同一句话，不算
      const otherText = other.text.replace(/\s+/g, ' ').trim();
      return otherText.length >= 12 && bText.includes(otherText) && rectOverlapRatio(b, other) > 0;
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
  // Vision 常把 AI 认成 Al（I 和小写 l 同形）：“AI development”→“Al development”→被翻成“铝开发”。
  // 现在网页上 AI 远比人名 Al 常见；带连字符的（Al-Kindi 这类阿拉伯人名）不动
  t = t.replace(/\bAl(s?)\b(?!-)/g, 'AI$1').replace(/([a-z])Al\b(?!-)/g, '$1AI');
  // OCR 在文件名、网址的点后面插空格："hello. py"、"www. apache . org"、"httpd. conf"：合回去，
  // 不然翻译把它当成两句话（"hello。Py"）。只认常见的扩展名、顶级域名（全小写）
  t = t.replace(/\b([\w-]+)\s?\.\s(?=(?:py|js|ts|jsx|tsx|html?|css|json|conf|cfg|md|txt|rb|rs|go|sh|yml|yaml|toml|xml|php|java|kt|org|com|net|io|dev|edu|gov)\b)/g, '$1.')
    .replace(/\bwww\.\s(?=[a-z])/g, 'www.');
  t = t.replace(/\b[0-9A-Fa-fOo]{1,4}(?::[0-9A-Fa-fOo]{0,4}){2,7}\b:*/g, m => /\d/.test(m) ? m.replace(/[Oo]/g, '0') : m);
  return t;
}

/// 词尾单独一个箭头符号（下拉的 ⌄、"›"、"GET STARTED >"）。只认符号本身：
/// 箭头被 Vision 认成字母（v、y）的情况分不清是不是真字母，不处理。
/// 去掉它，框也按字数比例收回来一截，箭头本身就不会被擦掉。
export function stripTrailingIcon(b: TextBlock): TextBlock {
  const m = b.text.match(/^(.*\p{L}{2,}.*?)\s+(?:[>›»⌄˅˄⌃∨•·]|>>|»»)$/u);
  if (!m) return b;
  const kept = m[1].trimEnd();
  const width = b.width * Math.min(1, (kept.length + 0.5) / b.text.length);
  return { ...b, text: kept, width };
}

/// 代码、命令、JSON 的一行。翻出来没有意义，还会把键名翻成中文。
export function isCodeLine(text: string): boolean {
  // Vision 常把代码里的 < > 认成 ‹ ›（U+2039/203A），先换回来
  const t = text.trim().replace(/‹/g, '<').replace(/›/g, '>');
  if (!t) return false;
  // Python 导入、装饰器："from flask import Flask"、"import numpy as np"、"@app.route("/")"
  if (/^from\s+[\w.]+\s+import\s+[\w*]/.test(t) || /^import\s+[\w.]+(?:\s+as\s+\w+)?(?:\s*,\s*[\w.]+)*;?$/.test(t)) return true;
  if (/^@[a-z_][\w.]*\s*\(/.test(t.replace(/\.\s+/g, '.'))) return true;
  // 模板语法：Svelte/Handlebars 的 {#if …}、{@html …}、{/each}（OCR 常把 { 认成 ¿ ¡ ｛ 、）
  if (/^[{｛¿¡、]\s?[#@:\/][a-z]+\b/.test(t)) return true;
  // 半截的标签：<script lang="ts">、</style>、/script>
  if (/^<\/?[a-z][\w-]*(?:\s[^<>]*)?>$/i.test(t) || /^\/[a-z]+>$/.test(t)) return true;
  // 交互式解释器提示符：irb(main):001:0>、pry(main)>
  if (/^\w+\(\w+\)\s?(?::\s?\d+)*\s?[>*]/.test(t)) return true;
  // 一串符号（装饰图案、ASCII 画、被认坏的图标行）：字母和汉字不到四成
  { const vis = t.replace(/\s/g, ''); const letters = (vis.match(/[\p{L}]/gu) || []).length;
    if (vis.length >= 8 && letters < vis.length * 0.4 && !/\p{L}{4,}/u.test(t)) return true; }
  // CSS 数值一行："2em;"、"16px;"、"#fff;"
  if (/^(?:-?[\d.]+(?:px|em|rem|%|vh|vw|s|ms)?|#[0-9a-f]{3,8})\s*;$/i.test(t)) return true;
  // 小写工具名 + 常见子命令："bun init"、"deno run main.ts"、"npx create-x"（最多五个词）
  if (/^[a-z][\w-]*\s+(?:init|install|i|run|test|build|create|add|remove|rm|dev|start|serve|deploy|upgrade|update|publish|exec|x|new|generate|login|link|pull|push|compile|fmt|lint|check|doctor)(?:\s+[\w@./:=-]+){0,3}$/.test(t)
    && !/^(?:please|then|and|or|to|we|you|they|it|i)\s/i.test(t)) return true;
  // 小写命令后面紧跟命令行选项："nginx -s reload"、"systemctl --user start x"
  if (/^[a-z][\w.-]*\s+-{1,2}[a-zA-Z][\w-]*(?:\s|=|$)/.test(t) && !/\s\p{Ll}+\s\p{Ll}+\s\p{Ll}+\s\p{Ll}+\s\p{Ll}+/u.test(t)) return true;
  if (/^(\/\/|#!|```|<\/?[a-z][\w-]*[ >])/i.test(t)) return true;
  if (/^[{}\[\]();,:\s]+$/.test(t)) return true;
  // JSON / YAML：键加冒号。OCR 常把引号认丢，所以引号可有可无，但键名得像个标识符
  // 不带引号、大写开头的一个词加冒号（"Imports: 44"、"Version: 2"）是界面标签，不算
  if (/^["'“”‘’]{0,3}[A-Za-z_$][\w$.-]*["'“”‘’]{0,3}\s*:\s*(["'“”{\[]|-?\d|true|false|null|t\}|\{|$)/.test(t)
    && !/^[A-Z][a-z]+\s*:\s*(?:-?[\d,.]+|$)/.test(t)) return true;
  if (/^["'“”‘’]{1,3}[\w$ .-]+["'“”‘’]{1,3}\s*:/.test(t)) return true;
  // CSS 声明、行内样式："grid: auto-flow / 1fr 1fr;"、"color: red;"
  if (/^[a-z-]+\s*:\s*[^;:]+;\s*$/.test(t)) return true;
  // 命令行（含 "yxy@MacBook ~ % ls" 这种带提示符的）
  if (/^[$%>❯›»▸]\s*\S/.test(t) && /^[$%>❯›»▸]\s*(?:[a-z][\w.-]*)(?:\s|$)/.test(t)) return true; // 提示符后面跟着小写命令名
  if (/^[\w.-]+@[\w.-]+(?::\S*)?\s*\S*\s*[%$#]\s/.test(t)) return true;
  if (/(?:^|\s)[~\/][^\s]*\s?[%$#]\s+\S/.test(t)) return true; // "MacBook ~% ls"：@ 被认成别的字也能认出提示符
  if (/^(?:\/[\w.\-\u4e00-\u9fff]+){2,}/.test(t) && !/\s\w+\s\w+\s\w+/.test(t)) return true; // 以路径开头的一行
  // 命令名后面跟的是普通词（"npm package manager"、"git is a …"）是一句话，不是命令
  if (/^(?:git|npm|npx|pnpm|yarn|pip3?|python\d*|node|curl|wget|brew|cd|ls|sudo|docker|kubectl|cargo|go|swift|make|ssh|scp|chmod|mkdir|rm|cp|mv|cat|echo|export)\s+[-\w./:~$"']/.test(t)
    && !/^\S+\s+(?:is|are|was|and|or|the|a|an|to|for|with|package|packages|manager|repository|repositories|version|versions|commands?|registry|projects?|users?|team|docs|documentation|website|community|book|basics|tutorial|guide)\b/i.test(t)) return true;
  // SQL：关键字开头，后面跟着 FROM/INTO/SET/TABLE/WHERE/VALUES 之类（“SELECT * FROM weather;”）
  if (/^(?:SELECT|INSERT|UPDATE|DELETE|CREATE|DROP|ALTER|WITH|GRANT)\b/i.test(t)
    && /\b(?:FROM|INTO|SET|TABLE|WHERE|VALUES|AS|INDEX|VIEW|ON)\b/.test(t)) return true;
  // 交互式提示符：Python 的 >>> 和 ...，Jupyter 的 In [1]:
  if (/^(?:>>>|\.\.\.)\s/.test(t) || /^In \[\d*\]:/.test(t)) return true;
  // 配置行：key = "值" / key = 1.0 / key = [ / key = {（Cargo.toml、ini、shell 变量）
  if (/^[A-Za-z_][\w.-]*\s*=\s*(?:["'\[{]|\d|true\b|false\b)/.test(t) && !/\s\w+\s\w+\s\w+\s\w+/.test(t.replace(/"[^"]*"/g, ''))) return true;
  // 命令行选项：“-a, --all”“--color=auto”
  if (/^-{1,2}[A-Za-z][\w-]*(?:[=,]\S*)?(?:,?\s+-{1,2}[A-Za-z][\w-]*(?:=\S*)?)*$/.test(t)) return true;
  // 语句：以 ; { } 结尾，又带括号、:: 或 = （“setup() {”“use serde::{Deserialize};”“return { count: ref(0) }”）
  if (/[;{}]\s*$/.test(t) && /[()]|::|=|=>/.test(t) && !/\s\p{Ll}+\s\p{Ll}+\s\p{Ll}+\s\p{Ll}+\s/u.test(t)) return true;
  // 方法调用、属性访问：“message.toLowerCase();”“r.headers['content-type']”
  if (/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\s*(?:\(|\[)/.test(t)) return true;
  // 属性、注解、预处理：#[derive(...)]、@Override、#include
  if (/^#\[[\w:]+|^@[A-Z]\w+(?:\(|$)|^#(?:include|define|if|ifdef|pragma)\b/.test(t)) return true;
  // 一行里有成对的 HTML 标签：“<button>I'm a button</button>”
  if (/<([a-z][\w-]*)\b[^>]*>.*<\/\1>/i.test(t)) return true;
  // 数据行：整行被引号、花括号、方括号包着（程序输出的 JSON、字符串）
  if (/^['"{\[(].*['"}\])],?$/.test(t) && /[:,=]/.test(t) && t.length >= 6 && (/^\{/.test(t) || /['"]/.test(t))) return true;
  // 表格输出的分隔线：“----+------”
  if (/^[-+=|\s]{4,}$/.test(t) && /[-=]{3}/.test(t)) return true;
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
  // "Node.js"、"Next.js"、"Vue.js"：大写开头的 .js/.ts 是产品名，不是域名（交给翻译那边的专名表保留）
  if (/^(?:www\.)?[\w-]+(?:\.[\w-]+)+(?:\/\S*)?$/i.test(t) && /\.[a-z]{2,}(?:\/|$)/i.test(t) && !/\s/.test(t)
    && !/^[A-Z][\w-]*\.(?:js|ts)$/.test(t)) return true; // 域名、路径
  if (/^[\w.+-]+@[\w-]+(?:\.[\w-]+)+$/.test(t)) return true;
  if (/^v?\d+(?:\.\d+){1,3}(?:[-+][\w.-]+)?$/.test(t)) return true;
  if (!/^[A-Z][\w-]*\.(?:js|ts)$/.test(t) && /^[.…]*[\p{L}\p{N}_ -]*\.(?:js|ts|tsx|jsx|py|swift|m|h|c|cpp|go|rs|rb|java|kt|json|ya?ml|toml|md|txt|csv|log|sh|command|zsh|bash|app|zip|dmg|pkg|tgz|gz|png|jpe?g|gif|svg|pdf|html?|css|docx?|xlsx?|pptx?)$/iu.test(t)) return true; // 文件名
  if (/^[.…]+[\p{L}\p{N}_-]+$/u.test(t)) return true; // 被截断的名字："...command"
  if (/^\.[\w.-]+$/.test(t)) return true; // 点开头的文件、文件夹：.github、.editorconfig
  if (/^[\w.-]*\/[\w.\/-]+$/.test(t) && !/\s/.test(t)) return true; // 路径：src/main、.agents/skills
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
  // 大小写混写的专名（GitHub、WebAssembly）不再在这里扔掉：扔掉了分段就少一截（"Node.js with / WebAssembly"），
  // 翻译时专名规则会把它遮住、原样带回来，原样的不画也不擦
  return false;
}

/// 一列代码、文件名、CSS 属性名里夹着几个单看像普通单词的（"gap"、"height"、"build"、"test"）：
/// 上下挨着的几行有一半以上是代码或标识，它也算。
/// 投票时把"有点像标识"的也算上（带连字符的小写词 grid-template-rows、单个小写词），
/// 但它们自己不单独成立——单独一个 "sign-in" 按钮还是要翻。
export function spreadCode(blocks: TextBlock[], isCode: (b: TextBlock) => boolean): Set<TextBlock> {
  const kebab = (b: TextBlock) => /^[a-z][a-z0-9]*(?:-[a-z0-9*]+)+\s*[*A]?$/.test(b.text.trim().replace(/^[›>•·]\s*/, ''));
  const neighbors = (b: TextBlock) => blocks.filter(o => o !== b
    && Math.abs((o.y + o.height / 2) - (b.y + b.height / 2)) < Math.max(o.height, b.height) * 3.5
    && Math.min(o.x + o.width, b.x + b.width) - Math.max(o.x, b.x) > 0
    && !differentBg(o, b));
  const code = new Set(blocks.filter(isCode));
  // 语法高亮把一行代码按颜色切成好几块（from / flask / import / Flask），单看每块都不像代码。
  // 同一行、同底色、挨着的块拼回一整行再判断一次，是代码就整行都算
  const rows: TextBlock[][] = [];
  for (const b of [...blocks].sort((p, q) => (p.y - q.y) || (p.x - q.x))) {
    const cy = b.y + b.height / 2;
    const row = rows.find(r => {
      const last = r[r.length - 1];
      return Math.abs((last.y + last.height / 2) - cy) < Math.min(last.height, b.height) * 0.5
        && b.x - (last.x + last.width) < Math.max(last.height, b.height) * 2.5 && b.x >= last.x && !differentBg(last, b);
    });
    if (row) row.push(b); else rows.push([b]);
  }
  for (const r of rows) {
    if (r.length < 2) continue;
    const joined = r.map(b => b.text.trim()).join(' ');
    if (isCodeLine(joined) || isCodeLine(joined.replace(/\s*([.(),:=])\s*/g, '$1'))) r.forEach(b => code.add(b));
  }
  // 一列里好几个挨着的连字符小写词（grid-template-rows、hanging-punctuation）就是一列属性名/参数名
  for (const b of blocks) if (kebab(b) && neighbors(b).filter(kebab).length >= 2) code.add(b);
  if (!code.size) return code;
  // 代码框：底色和页面主底色不同的一整块（<pre> 块），里面有 2 行以上确定是代码时，整块都算代码
  // （psql 的输出、变量名、注释都跟着不翻）。框里的块按"同底色、上下挨着、横向重叠"连成一片。
  const bgKey = (b: TextBlock) => (b.bg || []).map(v => Math.round(v / 12)).join(',');
  const counts = new Map<string, number>();
  for (const b of blocks) counts.set(bgKey(b), (counts.get(bgKey(b)) || 0) + 1);
  const pageBg = [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const seen = new Set<TextBlock>();
  for (const seed of blocks) {
    if (seen.has(seed) || !seed.bg || bgKey(seed) === pageBg) continue;
    const region: TextBlock[] = [seed];
    seen.add(seed);
    for (let k = 0; k < region.length; k++) {
      const a = region[k];
      for (const o of blocks) {
        if (seen.has(o) || differentBg(a, o) || bgKey(o) === pageBg) continue;
        const gapY = Math.max(o.y, a.y) - Math.min(o.y + o.height, a.y + a.height);
        const overlapX = Math.min(o.x + o.width, a.x + a.width) - Math.max(o.x, a.x);
        const gapX = -overlapX;
        if (gapY < Math.max(a.height, o.height) * 1.6 && (overlapX > 0 || gapX < Math.max(a.height, o.height) * 3)) {
          region.push(o); seen.add(o);
        }
      }
    }
    // 确定是代码的行要占到四成以上（整片正文里夹两行代码的不算）；普通句子（5 个词以上、不带代码符号）不跟着算
    const strong = region.filter(b => code.has(b)).length;
    const prose = (b: TextBlock) => b.text.trim().split(/\s+/).length >= 5 && !/[{}();=<>\[\]]/.test(b.text);
    if (region.length >= 3 && strong >= 2 && strong >= region.length * 0.4) region.forEach(b => { if (!prose(b)) code.add(b); });
  }
  const likeId = (b: TextBlock) => code.has(b) || kebab(b);
  // 只往"像名字的条目"上传：一个词、没有空格、小写开头（build、src、gap、height）。
  // 界面上的菜单项、按钮大多大写开头或是几个词（Readme、Code of conduct、Go to file），照常翻；
  // 一段正文也不会因为挨着代码块被连累。一列里一个传一个，所以反复传到不再变化为止
  const short = (b: TextBlock) => /^[a-z][\w.*-]*$/.test(b.text.trim().replace(/^[›>•·]\s*/, '').replace(/\s+[*A]$/, ''));
  for (let changed = true; changed;) {
    changed = false;
    for (const b of blocks) {
      if (code.has(b) || !short(b)) continue;
      // 上一行以 and/or/the/of/with… 收尾：这是那句话折下来的最后一个词（"ES6 and / beyond"），不是代码
      if (blocks.some(o => o !== b && Math.abs(o.x - b.x) < b.height * 1.5 && b.y - (o.y + o.height) > -3 && b.y - (o.y + o.height) < b.height * 1.2
        && /\b(?:and|or|the|a|an|of|to|in|on|for|with|by|from|at|as|between|about|into|than|like|using)$/i.test(o.text.trim()))) continue;
      const near = neighbors(b);
      const strong = near.filter(o => code.has(o)).length;
      const votes = near.filter(likeId).length;
      if (near.length >= 2 && strong >= 1 && votes * 2 >= near.length) { code.add(b); changed = true; }
    }
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

/// 从 OCR 框高推这一行的字号（em）。Vision 的框只包住字形本身：
/// 带下伸字母（g j p q y）的英文约 0.93em，全是大写或没有下伸的约 0.72em，中日韩字约 0.92em。
/// 浮层画字用的是同一个换算（overlay.js 的 emFromBox）。
export function emOf(b: TextBlock): number {
  const t = b.text || '';
  if (/[\u3040-\u30ff\u4e00-\u9fff\uac00-\ud7af]/.test(t)) return b.height / 0.92;
  if (/[gjpqy,;]/.test(t)) return b.height / 0.93;
  return b.height / 0.72;
}
