/// 字色：原文每个词是什么颜色、哪几个词和周围不一样（链接、高亮），
/// 以及把这些词在译文里找回来。
///
/// 流程：原生 OCR 给每个词量出字色 → 这里定出整块的主色、挑出颜色不同的词（色段）→
/// 并行并段时色段跟着走 → 翻译前用标记把色段包起来 → 译文里按标记找回位置 → 浮层按位置上色。

export type RGB = [number, number, number];

/// 原生程序给的一个词：[s, e) 是它在这块文字里的位置（UTF-16 下标），c 是字色，
/// n 是量色用到的像素数（0 = 量不出来），u = 1 表示词下面有下划线
export interface InkToken { s: number; e: number; c: RGB; n: number; u?: number; x?: number; w?: number }

/// 一段和主色不同的文字
export interface InkRun { text: string; ink: RGB; underline?: boolean }

/// 挂在文字块上的颜色信息
export interface InkInfo {
  /// 主色：这一块大部分字的颜色
  ink?: RGB;
  /// 字底下的底色（量主色时的参照）
  bg?: RGB;
  /// 主色的字整体带下划线（整块都是链接）
  underline?: boolean;
  /// 和主色不同的色段，按原文顺序
  runs?: InkRun[];
  /// 所有同色的片段（含主色的），按原文顺序。并段时要用：一行里彩色字比白字多时，
  /// 这一行自己的主色是彩色，并进白字的段落后，白字的那几截得重新变成"不同于主色"的色段
  segs?: InkRun[];
}

/// 译文里一段要上色的范围 [start, end)
export interface InkSpan { start: number; end: number; ink: RGB; underline?: boolean }

/// 量色太少的词不可信：一两个像素宽的标点、细小的符号，抗锯齿后颜色偏得厉害
const MIN_PIXELS = 20;

/// 单个拉丁字母、数字、符号（"I"、"a"、"-"）笔画太细，量出来的颜色常常偏，不拿来定色
function tooThin(text: string, t: InkToken): boolean {
  const w = text.slice(t.s, t.e);
  return w.length === 1 && !/[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(w);
}

function norm(v: number[]): number {
  return Math.sqrt(v[0] * v[0] + v[1] * v[1] + v[2] * v[2]);
}

export function colorDistance(a: RGB, b: RGB): number {
  return norm([a[0] - b[0], a[1] - b[1], a[2] - b[2]]);
}

/// sRGB → CIE Lab（D65）。Lab 空间里的距离和人眼看到的颜色差别基本成正比。
function toLab(c: RGB): [number, number, number] {
  const lin = (v: number) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const r = lin(c[0]), g = lin(c[1]), b = lin(c[2]);
  const x = (r * 0.4124 + g * 0.3576 + b * 0.1805) / 0.95047;
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const z = (r * 0.0193 + g * 0.1192 + b * 0.9505) / 1.08883;
  const f = (t: number) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  return [116 * f(y) - 16, 500 * (f(x) - f(y)), 200 * (f(y) - f(z))];
}

/// 两个字色算不算同一种颜色。
///
/// 在 Lab 空间里比：色相、饱和度（a、b）差一点就是另一种颜色（黑字里的红字、灰字里的绿字），
/// 明暗（L）只按一半算——同一种字色，细笔画会比粗笔画淡一些，不能因此拆成两种。
/// 不要按"离底色的方向"比：白底上所有深色都朝同一个方向，灰字和绿字会被当成一种。
export function sameInk(a: RGB, b: RGB, _bg?: RGB): boolean {
  const la = toLab(a), lb = toLab(b);
  const dL = (la[0] - lb[0]) / 2, da = la[1] - lb[1], db = la[2] - lb[2];
  return Math.sqrt(dL * dL + da * da + db * db) < 12;
}

/// 按词把原生程序的量色结果整理成 InkInfo：
/// 颜色相近的词归成一组，字数最多的那组是主色；其余的词连成色段。
export function summarizeTokens(text: string, tokens: InkToken[] | undefined, bg: RGB | undefined): InkInfo {
  const measured = (tokens || []).filter(t => t.n >= MIN_PIXELS && t.e > t.s && !tooThin(text, t));
  if (!measured.length) return {};

  // 颜色分组：每个词找一个颜色相同的组加进去，没有就另开一组
  const groups: { ink: RGB; chars: number; pixels: number; members: InkToken[] }[] = [];
  for (const t of measured) {
    let g = groups.find(g => sameInk(g.ink, t.c, bg));
    if (!g) { g = { ink: t.c, chars: 0, pixels: 0, members: [] }; groups.push(g); }
    g.members.push(t);
    g.chars += t.e - t.s;
    g.pixels += t.n;
  }
  // 组的颜色要取偏"浓"的词：细笔画被抗锯齿冲淡，浓的更接近真正的字色。但不取最浓的那一个——
  // 灰字里夹着几个加粗的白字时（明暗差得不多，归在同一组），最浓的是白字，整行会被画成白色。
  // 按离底色由远到近排好，取字数累计到四分之一的那个词
  if (bg) for (const g of groups) {
    const sorted = [...g.members].sort((a, b) => colorDistance(b.c, bg) - colorDistance(a.c, bg));
    let acc = 0;
    let pick = sorted[0];
    for (const t of sorted) {
      pick = t;
      acc += t.e - t.s;
      if (acc * 4 >= g.chars) break;
    }
    g.ink = pick.c;
  }
  const main = groups.reduce((a, b) => (b.chars > a.chars || (b.chars === a.chars && b.pixels > a.pixels) ? b : a));

  const mainChars = main.members.reduce((s, t) => s + (t.e - t.s), 0);
  const underlinedChars = main.members.filter(t => t.u).reduce((s, t) => s + (t.e - t.s), 0);
  const info: InkInfo = { ink: main.ink, bg, underline: mainChars > 0 && underlinedChars / mainChars >= 0.8 };

  // 按原文顺序，把相邻的、同一组的词连成片段（中间的空格、连字符一起带上）。
  // 非主色的片段就是色段
  const ordered = [...measured].sort((a, b) => a.s - b.s);
  const segs: InkRun[] = [];
  let cur: { s: number; e: number; group: typeof main; under: boolean } | null = null;
  const flush = () => {
    if (!cur) return;
    let s = cur.s;
    // 中日韩文是按词切的，"@" 这类符号可能落在词外面，往前带上
    while (s > 0 && /[@#$]/.test(text[s - 1])) s--;
    // 词是按空格切的，会带着句末的标点（"Archer-SQ/screen-translator,"），标点不算色段
    const runText = text.slice(s, cur.e).trim()
      .replace(/^[("'“‘\[（「『]+/, '')
      .replace(/[.,;:!?)"'”’\]，。、；：！？）」』]+$/, '');
    if (runText) segs.push({ text: runText, ink: cur.group.ink, underline: cur.under || undefined });
    cur = null;
  };
  for (const t of ordered) {
    const g = groups.find(g => g.members.includes(t))!;
    if (cur && cur.group === g) { cur.e = t.e; cur.under = cur.under && !!t.u; continue; }
    flush();
    cur = { s: t.s, e: t.e, group: g, under: !!t.u };
  }
  flush();
  info.segs = segs;
  const runs = segs.filter(r => r.ink !== main.ink);
  if (runs.length) info.runs = runs;
  return info;
}

/// 几块拼成一行、几行拼成一段时，颜色信息怎么合：
/// 把每块的同色片段摊开，字数最多的那种颜色是整段的主色，其余颜色的片段都是色段。
/// 不能按"每块的主色"合：一行里彩色路径比白字长时，这一行的主色是彩色，
/// 整行当一个色段并进白字段落，行里的白字也会被画成彩色。
export function mergeInk(parts: ({ text: string } & InkInfo)[]): InkInfo {
  const segs: InkRun[] = [];
  for (const p of parts) {
    if (p.segs?.length) segs.push(...p.segs);
    else if (p.ink) segs.push({ text: p.text.trim(), ink: p.ink, underline: p.underline });
  }
  const bg = parts.find(p => p.bg)?.bg;
  // 量不出字色的块也要把底色带下去：拼行、并段时靠底色区分按钮和旁边的正文
  if (!segs.length) return bg ? { bg } : {};
  const groups: { ink: RGB; chars: number; underChars: number }[] = [];
  for (const r of segs) {
    let g = groups.find(g => sameInk(g.ink, r.ink, bg));
    if (!g) { g = { ink: r.ink, chars: 0, underChars: 0 }; groups.push(g); }
    g.chars += r.text.length;
    if (r.underline) g.underChars += r.text.length;
  }
  const main = groups.reduce((a, b) => (b.chars > a.chars ? b : a));
  const info: InkInfo = { ink: main.ink, bg, underline: main.chars > 0 && main.underChars / main.chars >= 0.8, segs };
  const runs = segs.filter(r => !sameInk(r.ink, main.ink, bg));
  if (runs.length) info.runs = runs;
  return info;
}

// ---------------------------------------------------------------------------
// 翻译标记
// ---------------------------------------------------------------------------

/// 标记的写法。翻译服务各有脾气：大模型和 DeepL 认 XML 标签；
/// 有道会删掉各种括号，但会原样带回字母+数字的生造词（产品名占位符 XQZ0 就是这么活下来的）。
export type MarkerStyle = 'xml' | 'alnum';

function openTag(style: MarkerStyle, id: number): string {
  return style === 'xml' ? `<c${id}>` : `QXA${id}`;
}
function closeTag(style: MarkerStyle, id: number): string {
  return style === 'xml' ? `</c${id}>` : `QXB${id}`;
}

export interface WrappedText {
  text: string;
  /// 包进去的色段，下标 = 标记编号 - 1
  marks: InkRun[];
}

/// 把段落里的色段用标记包起来。色段在段落里按顺序找；找不到的（并行时被裁掉了一截）、
/// 和前面的色段重叠的，都不包。
export function wrapRuns(text: string, runs: InkRun[] | undefined, style: MarkerStyle): WrappedText {
  if (!runs?.length) return { text, marks: [] };
  const placed: { start: number; end: number; run: InkRun }[] = [];
  let cursor = 0;
  for (const run of runs) {
    if (!run.text) continue;
    let at = text.indexOf(run.text, cursor);
    if (at < 0) at = text.indexOf(run.text);
    if (at < 0) continue;
    const end = at + run.text.length;
    if (placed.some(p => at < p.end && end > p.start)) continue;
    placed.push({ start: at, end, run });
    cursor = end;
  }
  if (!placed.length) return { text, marks: [] };
  placed.sort((a, b) => a.start - b.start);
  let out = '';
  let pos = 0;
  const marks: InkRun[] = [];
  placed.forEach((p, i) => {
    const id = i + 1;
    // 字母数字标记要和两边的词隔开，否则翻译服务会把它和词粘成一个生词
    const pad = style === 'alnum' ? ' ' : '';
    // 紧贴着字的地方（中文原文没有空格）在标记外面也隔一个空格；挨着标点的不用
    const wordish = /[\p{L}\p{N}]/u;
    const before = style === 'alnum' && p.start > 0 && wordish.test(text[p.start - 1]) ? ' ' : '';
    const after = style === 'alnum' && p.end < text.length && wordish.test(text[p.end]) ? ' ' : '';
    out += text.slice(pos, p.start) + before + openTag(style, id) + pad + text.slice(p.start, p.end) + pad + closeTag(style, id) + after;
    pos = p.end;
    marks.push(p.run);
  });
  out += text.slice(pos);
  return { text: out, marks };
}

export interface UnwrappedText {
  text: string;
  spans: InkSpan[];
  /// 有几个色段的标记完好地回来了
  kept: number;
}

/// 从译文里取出标记：成对、按顺序出现的标记，中间那段就是色段在译文里的位置。
/// 残缺的标记（只剩一半、顺序颠倒、被拆开）一律删掉，那个色段就不上色。
/// 标记全丢了的时候，色段原文原样出现在译文里的（用户名、链接地址、专有名词），照样能上色。
export function unwrapRuns(translated: string, marks: InkRun[], style: MarkerStyle): UnwrappedText {
  if (!marks.length) return { text: translated, spans: [], kept: 0 };
  // 统一先找出所有标记的位置，再一次性删掉，下标才不会乱
  // 字母数字标记前后不要求词边界：翻译服务常把它和旁边的字粘在一起（"QXA1QXB1"、"hereQXB1"）
  const re = style === 'xml' ? /<\s*(\/?)\s*c\s*(\d+)\s*>/gi : /Q\s*X\s*([AB])\s*(\d+)/gi;
  const found: { at: number; len: number; id: number; open: boolean }[] = [];
  for (let m: RegExpExecArray | null; (m = re.exec(translated)); ) {
    const open = style === 'xml' ? m[1] !== '/' : m[1].toUpperCase() === 'A';
    found.push({ at: m.index, len: m[0].length, id: Number(m[2]), open });
  }

  // 删标记，同时记下每个标记删完后落在哪个位置
  let text = '';
  let pos = 0;
  const cleanAt: number[] = [];
  for (const f of found) {
    text += translated.slice(pos, f.at);
    cleanAt.push(text.length);
    pos = f.at + f.len;
  }
  text += translated.slice(pos);

  const spans: InkSpan[] = [];
  let kept = 0;
  marks.forEach((run, i) => {
    const id = i + 1;
    const opens = found.map((f, k) => ({ f, k })).filter(x => x.f.id === id && x.f.open);
    const closes = found.map((f, k) => ({ f, k })).filter(x => x.f.id === id && !x.f.open);
    if (opens.length !== 1 || closes.length !== 1 || closes[0].k < opens[0].k) return;
    let start = cleanAt[opens[0].k], end = cleanAt[closes[0].k];
    if (end <= start) return;
    kept++;
    spans.push({ start, end, ink: run.ink, underline: run.underline });
  });

  // 标记两边多出来的空格（字母数字标记是隔着空格插进去的）收掉
  if (style === 'alnum') text = collapseMarkerSpaces(text, cleanAt, spans);
  // 两个标记之间什么都没翻出来（"此处的 QXA1 QXB1"）的色段不算
  for (let i = spans.length - 1; i >= 0; i--) {
    if (!text.slice(spans[i].start, spans[i].end).trim()) { spans.splice(i, 1); kept--; }
  }

  // 丢了标记的色段：原文原样出现在译文里就按原样的位置上色
  marks.forEach((run, i) => {
    const t = run.text.trim();
    if (t.length < 3) return;
    const covered = spans.some(s => s.ink === run.ink && text.slice(s.start, s.end).includes(t));
    if (covered) return;
    const at = text.indexOf(t);
    if (at < 0) return;
    if (spans.some(s => at < s.end && at + t.length > s.start)) return;
    spans.push({ start: at, end: at + t.length, ink: run.ink, underline: run.underline });
  });

  spans.sort((a, b) => a.start - b.start);
  return { text, spans, kept };
}

/// 删掉标记后，标记所在位置两边的空格：两边都是拉丁字母/数字时留一个（词和词之间本来就该有），
/// 否则全删（中文和中文之间、中文和标点之间不该冒出空格）。只动标记位置上的空格，
/// 译文里别处的空格原样保留。色段的下标跟着挪。
function collapseMarkerSpaces(text: string, positions: number[], spans: InkSpan[]): string {
  const drop = new Array(text.length).fill(false);
  const word = /[A-Za-z0-9]/;
  for (const p of positions) {
    let a = p - 1;
    while (a >= 0 && text[a] === ' ') a--;
    let b = p;
    while (b < text.length && text[b] === ' ') b++;
    if (b - a - 1 <= 0) continue;
    const keepOne = a >= 0 && b < text.length && word.test(text[a]) && word.test(text[b]);
    for (let i = a + 1; i < b; i++) drop[i] = true;
    if (keepOne) drop[a + 1] = false;
  }
  const map: number[] = [];
  let n = 0;
  let out = '';
  for (let i = 0; i <= text.length; i++) {
    map.push(n);
    if (i < text.length && !drop[i]) { out += text[i]; n++; }
  }
  for (const s of spans) { s.start = map[s.start]; s.end = map[s.end]; }
  for (const s of spans) {
    while (s.start < s.end && out[s.start] === ' ') s.start++;
    while (s.end > s.start && out[s.end - 1] === ' ') s.end--;
  }
  const lead = out.length - out.trimStart().length;
  if (lead) for (const s of spans) { s.start = Math.max(0, s.start - lead); s.end = Math.max(0, s.end - lead); }
  return out.trim();
}

/// 不靠标记找色段（有道这种带不回标记的服务用）：整句先照常翻；每个色段的原文再单独翻一次，
/// 拿这个短译文到整句译文里找位置。原文原样出现在译文里的（产品名、网址、代码）直接按原样找。
/// 找不到、或者整句里出现了好几处又分不清是哪一处的，那个色段就不上色——宁可少上色，不能上错。
/// （思路来自 SwiftyCrow 的 TranslationStyleMapper：先找原样出现的，找不到再用单独翻的短译文去对）
export function placeRuns(
  source: string, translated: string, runs: InkRun[] | undefined, snippet: (run: InkRun) => string | undefined,
): InkSpan[] {
  if (!runs?.length || !translated) return [];
  const spans: InkSpan[] = [];
  const free = (a: number, b: number) => !spans.some(s => a < s.end && b > s.start);
  let srcCursor = 0;
  for (const run of runs) {
    const raw = run.text.trim();
    if (!raw) continue;
    let srcAt = source.indexOf(raw, srcCursor);
    if (srcAt < 0) srcAt = source.indexOf(raw);
    if (srcAt < 0) continue;
    srcCursor = srcAt + raw.length;
    // 色段在原文里的相对位置（0~1），译文里有几处候选时挑相对位置最近的
    const rel = (srcAt + raw.length / 2) / Math.max(1, source.length);
    const cands = [raw, ...variants(snippet(run) || '')].filter((c, i, a) => c && a.indexOf(c) === i);
    let placed = false;
    // 空格不算：有道整句里写 "Tauri 1.0博客文章"，单独翻出来是 "Tauri 1.0 博客文章"
    const { flat, at: flatAt } = squeeze(translated);
    for (const cand of cands) {
      const c = cand.replace(/\s+/g, '');
      // 太短的（一个汉字、一两个字母）到处都能撞上，不拿来找
      if ([...c].length < (/[\u3400-\u9fff]/.test(c) ? 2 : 3)) continue;
      const hits: { start: number; end: number }[] = [];
      for (let k = flat.indexOf(c); k >= 0; k = flat.indexOf(c, k + 1)) {
        const start = flatAt[k], end = flatAt[k + c.length - 1] + 1;
        if (free(start, end)) hits.push({ start, end });
      }
      if (!hits.length) continue;
      const dist = (h: { start: number; end: number }) => Math.abs((h.start + h.end) / 2 / translated.length - rel);
      hits.sort((a, b) => dist(a) - dist(b));
      // 好几处：相对位置最近的那处要比第二近的明显更近，否则分不清，不上色
      if (hits.length > 1 && dist(hits[1]) - dist(hits[0]) < 0.25) break;
      spans.push({ start: hits[0].start, end: hits[0].end, ink: run.ink, underline: run.underline });
      placed = true;
      break;
    }
    if (!placed) continue;
  }
  return spans.sort((a, b) => a.start - b.start);
}

/// 去掉空白后的文字，和每个字在原串里的下标
function squeeze(s: string): { flat: string; at: number[] } {
  let flat = '';
  const at: number[] = [];
  for (let i = 0; i < s.length; i++) if (!/\s/.test(s[i])) { flat += s[i]; at.push(i); }
  return { flat, at };
}

/// 单独翻出来的短译文常比句子里的多出虚字（"在这里"↔"这里"、"的文档"↔"文档"），
/// 依次去掉两头的标点和虚字再试
function variants(s: string): string[] {
  const out: string[] = [];
  let t = s.trim();
  if (!t) return out;
  out.push(t);
  t = t.replace(/^[\s"'“‘「『（(【\[]+|[\s"'”’」』）)】\]。.,，、；;：:！!？?]+$/g, '');
  out.push(t);
  const t2 = t.replace(/^(?:在|的|了|是|把|被|对|于|和|与|将)/, '').replace(/(?:的|了|吗|呢)$/, '');
  if (t2 !== t) out.push(t2);
  return out;
}
