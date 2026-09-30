import { execFile } from 'child_process';
import { ensureNative, debugLog } from './native';
import { InkInfo, InkToken, RGB, summarizeTokens, sameInk } from './ink';

export interface TextBlock extends InkInfo {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /// 字重：平均笔画宽度（原图像素，原生程序量的），0 表示量不出来
  weight?: number;
  /// 原生程序在像素上确认过：它和左边那块之间是一大段空白（两个并排按钮、表格的两格），
  /// 不是漏认了字。聚行、并段都不许把它和左边接起来。
  gapBefore?: boolean;
  /// 原文下面有下划线伸出框外时，擦原文要擦到这里（和 y 同一套坐标）
  eraseBottom?: number;
  /// 从这一块里拿掉的图标所在的位置（▲、放大镜、下拉箭头…），擦原文时不许碰
  icons?: { x: number; y: number; width: number; height: number }[];
  /// 并行、并段之后：这一行/这一段由哪些原始块组成（擦原文只擦这些，不按外框圈）
  members?: TextBlock[];
}

/// 原生程序吐出来的一块：在 TextBlock 之外还带着每个词的量色结果
interface RawBlock extends TextBlock { tokens?: InkToken[] }

/// 图标被 Vision 当成了字：▲ 认成 4 或 A、放大镜认成 Q、下拉箭头认成 v、铃铛认成 f。
/// 判据只看位置：一两个字符的"词"，和两边的距离明显大于这一行正常的词距
/// （行首、行尾那一侧不算）。正文里的 a、I 这类单字母词，词距是正常的，不会被当成图标。
/// 拿掉的图标从文字里删掉、字框缩回去，位置记在 icons 里，擦原文时不碰它。
/// 图标在一行中间时（“14. ▲ Is your…”）从那里拆成两块。
export function stripIcons(raw: RawBlock): RawBlock[] {
  const toks = (raw.tokens || []).filter(t => t.w !== undefined && t.w > 0 && t.x !== undefined).sort((a, b) => a.s - b.s);
  if (toks.length < 2) return [raw];
  const gaps = toks.slice(1).map((t, i) => t.x! - (toks[i].x! + toks[i].w!));
  const isIcon = toks.map((t, i) => {
    // 正常词距：这一行里除了它两边以外的空当取中位数；没有别的空当就按 0.3 个字高算
    const others = gaps.filter((_, k) => k !== i - 1 && k !== i).sort((a, b) => a - b);
    const wordGap = others.length ? Math.max(1, others[Math.floor((others.length - 1) / 2)]) : raw.height * 0.3;
    const wide = (g: number) => g > Math.max(raw.height * 0.45, wordGap * 1.8);
    const w = raw.text.slice(t.s, t.e).trim();
    if (!w || w.length > 2 || /^[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]{2}$/.test(w)) return false;
    // 编号（“1.”“2)”）、单独的数字金额不当图标
    if (/^\d[.)]$/.test(w)) return false;
    // 英文单字母词后面跟着小写词（两端对齐把空格拉宽了）："A client connects…"、"I think…"
    if (/^(?:A|I|a)$/.test(w) && i < toks.length - 1 && /^\p{Ll}/u.test(raw.text.slice(toks[i + 1].s, toks[i + 1].e))) return false;
    const left = i === 0 ? true : wide(gaps[i - 1]);
    const right = i === toks.length - 1 ? true : wide(gaps[i]);
    // 至少一边真的空得很开（不能只靠"在行首/行尾"）
    const reallyApart = (i > 0 && wide(gaps[i - 1])) || (i < toks.length - 1 && wide(gaps[i]));
    return left && right && reallyApart;
  });
  if (!isIcon.some(Boolean) || isIcon.every(Boolean)) return [raw];
  const icons = toks.filter((_, i) => isIcon[i]).map(t => ({ x: t.x!, y: raw.y, width: t.w!, height: raw.height }));
  // 剩下的词按图标断成几段
  const runs: InkToken[][] = [];
  let cur: InkToken[] = [];
  toks.forEach((t, i) => { if (isIcon[i]) { if (cur.length) runs.push(cur); cur = []; } else cur.push(t); });
  if (cur.length) runs.push(cur);
  return runs.map((seg, k) => {
    const s0 = seg[0].s, e0 = seg[seg.length - 1].e;
    const x = seg[0].x!, right = Math.max(...seg.map(t => t.x! + t.w!));
    return {
      ...raw,
      text: raw.text.slice(s0, e0).trim(),
      x, width: right - x,
      gapBefore: k > 0 ? true : raw.gapBefore,
      icons: [...(raw.icons || []), ...icons],
      tokens: seg.map(t => ({ ...t, s: t.s - s0, e: t.e - s0 })),
    };
  });
}

/// 行首的图标常被认成一个字母（HN 每条前面的 ▲ 认成 A 或 4，GitHub 标签页前的图标认成 i、I）。
/// 光看一处分不出是图标还是单字母词，Vision 给的词框又把空白算进去，看不出间距。
/// 但图标是成排成列出现的：同一个 x 上连着好几行、或者同一行好几项，开头都是一个单字符
/// （编号后面紧跟的也算：“14. ▲ Is…”）。凑够 3 处就当图标拿掉。
export function stripRepeatedIcons(raws: RawBlock[]): RawBlock[] {
  type Cand = { raw: RawBlock; k: number; x: number; cy: number; h: number };
  const cands: Cand[] = [];
  for (const raw of raws) {
    const toks = (raw.tokens || []).filter(t => t.x !== undefined && t.w !== undefined).sort((a, b) => a.s - b.s);
    if (toks.length < 2) continue;
    const word = (i: number) => raw.text.slice(toks[i].s, toks[i].e);
    // 单个字符；或两个字符以内、不是正经词的（“三、”“1›”“*A”）——图标常被认成这些
    const single = (w: string) => (w.length === 1 && !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(w))
      || (w.length <= 2 && /[^\p{L}\p{N}]/u.test(w) && /[\p{L}\p{N}]/u.test(w) && !/^[\p{L}\p{N}][.)]$/u.test(w));
    let k = -1;
    if (single(word(0))) k = 0;
    else if (/^\d{1,3}[.)]$/.test(word(0)) && toks.length >= 3 && single(word(1))) k = 1;
    if (k < 0) continue;
    cands.push({ raw, k, x: toks[k].x!, cy: raw.y + raw.height / 2, h: raw.height });
  }
  const hit = new Set<Cand>();
  for (const c of cands) {
    const col = cands.filter(o => Math.abs(o.x - c.x) <= c.h * 0.6 && Math.abs(o.h - c.h) <= c.h * 0.5);
    const row = cands.filter(o => Math.abs(o.cy - c.cy) <= c.h * 0.4);
    if (col.length >= 3 || row.length >= 3) hit.add(c);
  }
  if (!hit.size) return raws;
  const byRaw = new Map([...hit].map(c => [c.raw, c]));
  return raws.flatMap(raw => {
    const c = byRaw.get(raw);
    if (!c) return [raw];
    const toks = (raw.tokens || []).filter(t => t.x !== undefined && t.w !== undefined).sort((a, b) => a.s - b.s);
    const icon = toks[c.k];
    const iconRect = { x: icon.x!, y: raw.y, width: icon.w!, height: raw.height };
    const pieces = [toks.slice(0, c.k), toks.slice(c.k + 1)].filter(seg => seg.length);
    return pieces.map((seg, n) => {
      const s0 = seg[0].s, e0 = seg[seg.length - 1].e;
      const x = seg[0].x!, right = Math.max(...seg.map(t => t.x! + t.w!));
      return {
        ...raw, text: raw.text.slice(s0, e0).trim(), x, width: right - x,
        gapBefore: n > 0 || c.k === 0 ? true : raw.gapBefore,
        icons: [...(raw.icons || []), iconRect],
        tokens: seg.map(t => ({ ...t, s: t.s - s0, e: t.e - s0 })),
      };
    });
  });
}

/// 按字形认出来的图标（不靠间距）：
/// - 行尾单独一个 v、V、⌄、-、_、≥、› 之类：下拉箭头、展开箭头（“Health Topics v”，v 还会被翻成“五”）
/// - 行中单独的 v 后面紧跟大写开头的词：一排菜单每项后面的下拉箭头（“Platform v Solutions v Pricing”），在这里拆开
/// - 行首单独一个字母（A、I、O 这些真能单独成词的除外），后面是大写开头的词：放大镜认成 Q、别的图标认成 T、J
/// - 行首单独一个汉字、后面是外文：菜单图标 ≡ 认成“三”
export function stripGlyphIcons(raw: RawBlock): RawBlock[] {
  const toks = (raw.tokens || []).filter(t => t.x !== undefined && t.w !== undefined).sort((a, b) => a.s - b.s);
  if (toks.length < 2) return [raw];
  const word = (i: number) => raw.text.slice(toks[i].s, toks[i].e);
  const hasWord = (i: number) => /\p{L}{2}/u.test(word(i));
  const drop = new Set<number>(), split = new Set<number>();
  const last = toks.length - 1;
  const w0 = word(0), w1 = word(1);
  if ((/^[\u4e00-\u9fff]$/.test(w0) && /[A-Za-z]/.test(w1))
    || (/^[B-HJ-NP-Zb-hj-np-z]$/.test(w0) && /^\p{Lu}/u.test(w1))
    || (/^[^\p{L}\p{N}\s"'“‘(\[$#@]$/u.test(w0) && hasWord(1))
    // 两个字符、夹着符号的（“文A”图标认成“*A”），后面是数字或大写词
    || (/^(?:[^\p{L}\p{N}\s]\p{L}|\p{L}[^\p{L}\p{N}\s.,:;!?'’)])$/u.test(w0) && /^[\p{Lu}\d]/u.test(w1))) drop.add(0);
  if (/^[vVY⌄∨˅›»>≥_\-–•·:⋮]$/.test(word(last)) && toks.slice(0, last).some((_, i) => hasWord(i))) drop.add(last);
  // 链接后面的外链图标 ↗、下拉的 ▾、分支图标常被认成 7 ^ ' z ~ & | [Z f®。
  // "Windows 7"、"Chapter 7"、"Step 7" 这种真数字不动
  if (/^(?:[7^'’z~&|]|\[[A-Za-z]|f®)$/.test(word(last)) && last > 0 && hasWord(last - 1)
    && !(word(last) === '7' && /^(?:Windows|iOS|Android|Java|Python|PHP|Chapter|Part|Step|Version|Level|Day|Week|Page|Vol\.?|No\.?|Section|Episode|Season)$/i.test(word(last - 1)))) drop.add(last);
  // 行首单独一个 "("、后面没有配对的 ")"：Cookie 图标 🍪 被认成了括号
  if (word(0) === '(' && hasWord(1) && !raw.text.slice(toks[1].s).includes(')')) drop.add(0);
  // 外链图标 ↗ 常被认成 L、1、J、[：真字母 L、数字 1 的宽度不到字框高的一半，图标差不多是个正方形（0.8 左右）
  if (/^[L1J\[]$/.test(word(last)) && last > 0 && hasWord(last - 1) && toks[last].w! >= raw.height * 0.6) drop.add(last);
  // 行首、行尾一两个字符的"词"，颜色和挨着的词明显不同：彩色图标（✨ 认成 *†、红色直播图标认成 O、
  // Docker 的闪光认成 *+、Thunderbird 的收件箱图标认成 &3）。纯数字（编号、计数）和两个字母的词（AI、Go）不算
  const iconish = (w: string) => w.length <= 2 && !/^\d+$/.test(w) && !/^\p{L}\p{L}$/u.test(w)
    // 标点、括号、编号（"1)"）、能单独成词的字母（a、A、I）、中日韩单字都是真字
    && !/^[.,:;!?()\[\]{}"'“”‘’]$/.test(w) && !/^\d[.)]$/.test(w) && !/^[a-zAI]$/.test(w)
    && !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(w);
  const colorOff = (i: number, j: number) => toks[i].n >= 20 && toks[j].n >= 20 && !sameInk(toks[i].c, toks[j].c);
  // 行首可能连着两个图标（BBC 的"≡ 🔍"认成"三Q"、后面红色直播图标认成"O"）：前一个拿掉了再看下一个
  for (let i = 0; i <= 1 && i < last; i++) {
    if (i > 0 && !drop.has(i - 1)) break;
    const w = word(i);
    // 汉字 + 拉丁字母（≡🔍 认成"三Q"、文A 认成"本A"），后面是外文词
    const cjkLatin = /^[一-鿿][A-Za-z]$/.test(w) && /[A-Za-z]{2}/.test(word(i + 1));
    // 放大镜认成 O、Q、C，后面是"搜索"
    const lens = /^[OQCo○◯]$/.test(w) && /^(?:Search|Buscar|Suche|Rechercher|Cerca|Pesquisar|Zoeken|Szukaj|Поиск|検索|搜索|검색)/i.test(word(i + 1));
    // 语言图标 文A 认成 XA、ХА，后面是语言名
    const langIcon = /^[\p{L}\p{S}]?[AА]$/u.test(w) && w.length === 2 && /^(?:English|Español|Deutsch|Français|Italiano|Português|日本語|中文|한국어|Language|Languages|\d+)/i.test(word(i + 1));
    // 行首单独的小写 i 后面跟大写开头的词：ⓘ 信息图标、logo 图形
    const infoI = w === 'i' && /^\p{Lu}/u.test(word(i + 1));
    if (cjkLatin || lens || langIcon || infoI || (iconish(w) && hasWord(i + 1) && colorOff(i, i + 1))) drop.add(i);
  }
  if (!drop.has(last) && last > 0 && iconish(word(last)) && hasWord(last - 1) && colorOff(last, last - 1)) drop.add(last);
  for (let i = 1; i < last; i++) {
    if (/^[vV⌄∨˅]$/.test(word(i)) && hasWord(i - 1) && /^\p{Lu}/u.test(word(i + 1))) { drop.add(i); split.add(i + 1); }
    // 行中间单独一个箭头、圆点、等号之类（头像、描述图标常被认成 → • =）：拿掉，并从这里拆开
    else if (/^[→•·▪▸►≡]$/.test(word(i)) && /[\p{L}\p{N}]/u.test(word(i - 1)) && /[\p{L}\p{N}]/u.test(word(i + 1))) { drop.add(i); split.add(i + 1); }
  }
  if (!drop.size) return [raw];
  const icons = [...drop].map(i => ({ x: toks[i].x!, y: raw.y, width: toks[i].w!, height: raw.height }));
  const runs: InkToken[][] = [];
  let cur: InkToken[] = [];
  toks.forEach((t, i) => {
    if (split.has(i) && cur.length) { runs.push(cur); cur = []; }
    if (drop.has(i)) return;
    cur.push(t);
  });
  if (cur.length) runs.push(cur);
  return runs.map((seg, k) => {
    const s0 = seg[0].s, e0 = seg[seg.length - 1].e;
    const x = seg[0].x!, right = Math.max(...seg.map(t => t.x! + t.w!));
    return {
      ...raw, text: raw.text.slice(s0, e0).trim(), x, width: right - x,
      gapBefore: k > 0 || drop.has(0) ? true : raw.gapBefore,
      icons: [...(raw.icons || []), ...icons],
      tokens: seg.map(t => ({ ...t, s: t.s - s0, e: t.e - s0 })),
    };
  });
}

/// 字框收到第一个词到最后一个词的实际范围。Vision 的行框常把行首的单选圈、列表圆点、
/// 展开三角一起框进去（这些没被认成字，stripIcons 管不到），按框擦就把它们擦掉了。
/// 多出来超过小半个字高的部分记进 icons，擦的时候绕开。
function fitToTokens(raw: RawBlock): RawBlock {
  const toks = (raw.tokens || []).filter(t => t.w !== undefined && t.w > 0 && t.x !== undefined);
  if (!toks.length) return raw;
  const x0 = Math.min(...toks.map(t => t.x!)), x1 = Math.max(...toks.map(t => t.x! + t.w!));
  const slack = raw.height * 0.35;
  const icons = [...(raw.icons || [])];
  let x = raw.x, right = raw.x + raw.width;
  if (x0 - raw.x > slack) { icons.push({ x: raw.x, y: raw.y, width: x0 - raw.x, height: raw.height }); x = x0; }
  if (right - x1 > slack) { icons.push({ x: x1, y: raw.y, width: right - x1, height: raw.height }); right = x1; }
  if (x === raw.x && right === raw.x + raw.width) return raw;
  return { ...raw, x, width: right - x, icons };
}

/// Vision 有时把一排隔得挺开的东西认成一行（"Products ⌄ Enterprise ⌄ Why IPinfo? ⌄ Pricing"）。
/// 词和词之间空出一个半字高以上，就是两样东西：按词的位置拆成几块，各自翻译、各自画。
export function splitWideGaps(raw: RawBlock): RawBlock[] {
  const toks = (raw.tokens || []).filter(t => t.w !== undefined && t.w > 0 && t.x !== undefined).sort((a, b) => a.s - b.s);
  if (toks.length < 2) return [raw];
  const gaps = toks.slice(1).map((t, i) => t.x! - (toks[i].x! + toks[i].w!));
  // 词距的基准取这一块里最小的空当（普通空格）。菜单、标签页一个挨一个排在一行时，
  // 项与项之间只空一个字高左右，远大于词距，但不到以前 1.6 倍字高的门槛（“Edit View history”）。
  // 最多按 0.35 个字高算：一整行全是菜单项时（“Download Docs Handbook Community”），
  // 最小的空当本身就是菜单间距，不能拿它当词距
  const wordGap = Math.min(raw.height * 0.35, gaps.length ? Math.max(1, Math.min(...gaps)) : Infinity);
  const starts = [0];
  for (let i = 1; i < toks.length; i++) {
    const gap = gaps[i - 1];
    const next = raw.text.slice(toks[i].s, toks[i].e);
    // 后面那段小写开头就是句子没断，只是空格被拉宽了（两端对齐），不切
    // 全大写、字距拉开的标签（"GETTING STARTED"、"NEW TO DOCKER"）词与词之间本来就空得宽，要空出 1.3 倍字高才算两项
    const prevWord = raw.text.slice(toks[i - 1].s, toks[i - 1].e);
    const capsPair = /^[A-Z]{2,}$/.test(prevWord) && /^[A-Z]{2,}$/.test(next) && !/[a-z]/.test(raw.text);
    const itemGap = gap > raw.height * (capsPair ? 1.3 : 0.8) && gap > wordGap * 2.8 && !/^[a-z]/.test(next);
    // 相邻两个词颜色差得很远、中间又空了半个字高以上：蓝色标题后面跟着标签、灰色域名，是并排的几样东西
    const a = toks[i - 1], b = toks[i];
    const colorGap = a.n > 0 && b.n > 0 && a.c && b.c
      && Math.abs(a.c[0] - b.c[0]) + Math.abs(a.c[1] - b.c[1]) + Math.abs(a.c[2] - b.c[2]) > 150 && gap > raw.height * 0.5;
    // 行首单独一个数字、后面空了大半个字高（投票数、排名、评论数挨着"authored by…"）：数字是另一样东西
    const leadCount = i === 1 && /^\d{1,6}$/.test(raw.text.slice(toks[0].s, toks[0].e).trim()) && gap > raw.height * 0.8 && gap > wordGap * 2.8;
    if (gap > raw.height * 1.6 || itemGap || colorGap || leadCount) starts.push(i);
  }
  if (starts.length === 1) return [raw];
  return starts.map((a, k) => {
    const b = k + 1 < starts.length ? starts[k + 1] : toks.length;
    const seg = toks.slice(a, b);
    const s0 = seg[0].s, e0 = seg[seg.length - 1].e;
    const x = seg[0].x!, right = Math.max(...seg.map(t => t.x! + t.w!));
    return {
      ...raw,
      text: raw.text.slice(s0, e0).trim(),
      x, width: right - x,
      gapBefore: k > 0 ? true : raw.gapBefore,
      tokens: seg.map(t => ({ ...t, s: t.s - s0, e: t.e - s0 })),
    };
  });
}

/// 每个词的颜色整理成整块的主色 + 色段，原始的词列表不再往下传
function withInk(raw: RawBlock): TextBlock {
  const { tokens, ...block } = raw;
  const info = summarizeTokens(block.text, tokens, block.bg as RGB | undefined);
  return { ...block, ...info };
}

export interface WindowRect { x: number; y: number; width: number; height: number; }

/// 屏幕上可见的普通窗口，从前到后，全局坐标（点）。要在截图那一刻取，
/// 版面重建时用它保证不同窗口里的字不会被并到一起。拿不到就当没有窗口信息。
export async function listWindows(): Promise<WindowRect[]> {
  const { binaryPath, error } = await ensureNative('ocr-macos');
  if (error) return [];
  return new Promise(resolve => {
    execFile(binaryPath, ['--windows', String(process.pid)], { timeout: 3000 }, (err, stdout) => {
      try { resolve(err ? [] : JSON.parse(stdout.trim())); } catch { resolve([]); }
    });
  });
}

/// 去掉骑在两片重叠带上、被认了两次的块。判据是"框压在一起 + 文字一样"，
/// 两条都满足才算重复——同样的短词在页面别处再出现一次，位置对不上，不会误删。
function dedupeStripeOverlap(blocks: TextBlock[]): TextBlock[] {
  const norm = (t: string) => t.replace(/\s+/g, ' ').trim().toLowerCase();
  const kept: TextBlock[] = [];
  for (const b of blocks) {
    const bt = norm(b.text);
    const dupIdx = kept.findIndex(k => {
      const ix = Math.min(k.x + k.width, b.x + b.width) - Math.max(k.x, b.x);
      const iy = Math.min(k.y + k.height, b.y + b.height) - Math.max(k.y, b.y);
      if (ix <= 0 || iy <= 0) return false;
      const smaller = Math.min(k.width * k.height, b.width * b.height);
      if (smaller <= 0 || (ix * iy) / smaller < 0.5) return false;
      const kt = norm(k.text);
      // 骑缝那一行两片各认一遍，常常只差在边上一两个字（被别的窗口切掉的位置不同），
      // 所以按"词大多相同"判，不要求一字不差
      return kt === bt || (bt.length >= 4 && (kt.includes(bt) || bt.includes(kt))) || textSimilarity(kt, bt) >= 0.8;
    });
    if (dupIdx < 0) { kept.push(b); continue; }
    // 留认得更全的那个：先看置信度，再看谁的字多
    const k = kept[dupIdx];
    const better = b.confidence > k.confidence + 0.02 ? b
      : k.confidence > b.confidence + 0.02 ? k
      : (norm(b.text).length > norm(k.text).length ? b : k);
    kept[dupIdx] = better;
  }
  return kept;
}

/// 最近一次 OCR 原生程序在 stderr 里说的话（分格、重认了几片、耗时），测试脚本看
export let lastOcrInfo = '';

/// 高屏会在原生程序里按横条分片识别（见 scripts/ocr-macos.m），骑缝的行两片都会认到，
/// 这里统一去重。
export function performOCR(imagePath: string, targetLang = ''): Promise<TextBlock[]> {
  return new Promise(async (resolve, reject) => {
    const { binaryPath, error } = await ensureNative('ocr-macos');
    if (error) { reject(new Error(error)); return; }

    // Vision 偶尔会卡死不返回（同一张图下次又正常）：25 秒没结果就结束进程重试一次，再不行就报错，不许一直挂着
    const run = (attempt: number) => execFile(binaryPath, targetLang ? [imagePath, targetLang] : [imagePath],
      { maxBuffer: 10 * 1024 * 1024, timeout: 25000, killSignal: 'SIGKILL' }, (err, stdout, stderr) => {
      if (err) {
        if ((err as any).killed && attempt === 0) { debugLog('OCR 超时，重试一次'); run(1); return; }
        reject(new Error(`OCR 失败: ${(err as any).killed ? '识别超时' : (stderr || err.message).toString().trim().slice(0, 200)}`));
        return;
      }
      lastOcrInfo = (stderr || '').toString().trim().replace(/\n/g, ' | ');
      if (lastOcrInfo) debugLog(`OCR: ${lastOcrInfo}`);
      try {
        resolve(dedupeStripeOverlap(stripRepeatedIcons(JSON.parse(stdout.trim()) as RawBlock[]).flatMap(stripIcons).flatMap(stripGlyphIcons).flatMap(splitWideGaps).flatMap(stripGlyphIcons).map(fitToTokens).map(withInk)));
      } catch {
        reject(new Error('OCR 输出解析失败'));
      }
    });
    run(0);
  });
}

export function textSimilarity(a: string, b: string): number {
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
