import { execFile } from 'child_process';
import { ensureNative, debugLog, debugLogVerbose, nativePaths } from './native';
import * as fs from 'fs';
import { InkInfo, InkToken, RGB, summarizeTokens } from './ink';

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
  /// Vision 文档识别（macOS 26+）认为这一块属于第几段。拼段时用作提示：大标题折成两行时，
  /// 光看行距会拆开，文档识别知道它们是一句话。没有就是 undefined。
  docPara?: number;
}

/// 原生程序吐出来的一块：在 TextBlock 之外还带着每个词的量色结果
interface RawBlock extends TextBlock { tokens?: InkToken[] }

/// Vision 有时把一排隔得挺开的东西认成一行（"Products ⌄ Enterprise ⌄ Why IPinfo? ⌄ Pricing"）。
/// 词和词之间空出一个半字高以上，就是两样东西：按词的位置拆成几块，各自翻译、各自画。
function splitWideGaps(raw: RawBlock): RawBlock[] {
  const toks = (raw.tokens || []).filter(t => t.w !== undefined && t.w > 0 && t.x !== undefined).sort((a, b) => a.s - b.s);
  if (toks.length < 2) return [raw];
  const starts = [0];
  for (let i = 1; i < toks.length; i++) {
    const gap = toks[i].x! - (toks[i - 1].x! + toks[i - 1].w!);
    if (gap > raw.height * 1.6) starts.push(i);
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

/// 文档识别给的一行：段号 + 位置（原图像素）
export interface DocLine { p: number; x: number; y: number; w: number; h: number; t: string }

/// Vision 文档识别（macOS 26+）看哪些行是同一段。系统不支持、程序不在、超时，都当没有。
/// 只当拼段的提示用，所以宁可不要也别拖慢：超过 timeoutMs 就放弃。
export function performDocLayout(imagePath: string, timeoutMs = 4000): Promise<DocLine[]> {
  const { binaryPath } = nativePaths('layout-macos');
  if (!fs.existsSync(binaryPath)) return Promise.resolve([]);
  return new Promise(resolve => {
    const t0 = Date.now();
    execFile(binaryPath, [imagePath], { timeout: timeoutMs, maxBuffer: 10 * 1024 * 1024 }, (err, stdout) => {
      if (err) { debugLog(`文档识别没用上（${Date.now() - t0}ms）：${(err as any).killed ? '超时' : (err as any).code ?? err.message}`); resolve([]); return; }
      debugLog(`文档识别 ${Date.now() - t0}ms`);
      try { resolve(JSON.parse(stdout.trim())); } catch { resolve([]); }
    });
  });
}

/// 启动时先把文档识别跑一次（一张空白小图）。第一次用这个模型时系统要现场准备，
/// 实测要几十秒；放在截图翻译里会超时被丢掉，下次还得从头再来。启动时在后台跑完，
/// 之后每次半秒左右。不设超时，跑完删图。
export function warmUpDocLayout(pngPath: string) {
  const { binaryPath } = nativePaths('layout-macos');
  if (!fs.existsSync(binaryPath)) return;
  const t0 = Date.now();
  execFile(binaryPath, [pngPath], { maxBuffer: 1024 * 1024 }, (err) => {
    debugLog(`文档识别预热 ${err ? '失败' : '完成'}，${Date.now() - t0}ms`);
    try { fs.unlinkSync(pngPath); } catch {}
  });
}

/// 给 OCR 块标上文档识别的段号：块和某一行重叠超过自己面积一半就算那一段的
export function assignDocParagraphs(blocks: TextBlock[], lines: DocLine[]): TextBlock[] {
  if (!lines.length) return blocks;
  return blocks.map(b => {
    let best = -1, bestCover = 0.5;
    for (const l of lines) {
      const ix = Math.min(b.x + b.width, l.x + l.w) - Math.max(b.x, l.x);
      const iy = Math.min(b.y + b.height, l.y + l.h) - Math.max(b.y, l.y);
      if (ix <= 0 || iy <= 0) continue;
      const cover = (ix * iy) / Math.max(1, Math.min(b.width * b.height, l.w * l.h));
      if (cover > bestCover) { bestCover = cover; best = l.p; }
    }
    return best >= 0 ? { ...b, docPara: best } : b;
  });
}

/// 高屏会在原生程序里按横条分片识别（见 scripts/ocr-macos.m），骑缝的行两片都会认到，
/// 这里统一去重。
export function performOCR(imagePath: string, targetLang = ''): Promise<TextBlock[]> {
  return new Promise(async (resolve, reject) => {
    const { binaryPath, error } = await ensureNative('ocr-macos');
    if (error) { reject(new Error(error)); return; }

    execFile(binaryPath, targetLang ? [imagePath, targetLang] : [imagePath], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`OCR 失败: ${(stderr || err.message).toString().trim().slice(0, 200)}`));
        return;
      }
      lastOcrInfo = (stderr || '').toString().trim().replace(/\n/g, ' | ');
      if (lastOcrInfo) debugLog(`OCR: ${lastOcrInfo}`);
      try {
        resolve(dedupeStripeOverlap((JSON.parse(stdout.trim()) as RawBlock[]).flatMap(splitWideGaps).map(withInk)));
      } catch {
        reject(new Error('OCR 输出解析失败'));
      }
    });
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
