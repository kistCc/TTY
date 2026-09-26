import * as crypto from 'crypto';
import { performOCR, performDocLayout, assignDocParagraphs, TextBlock, WindowRect } from './ocr';
import { translateWithInk, inkSupported } from './translator';
import { debugLog, debugLogVerbose } from './native';
import {
  ParagraphBlock, filterForeignBlocks, toCss, eraseRectOf, withTranslation, groupIntoParagraphs,
  dropIconBlocks, dropUndersizedBoxes, dropLowConfidenceOverlaps, dropDuplicateBoxes, dropOversizedBoxes,
  normalizeOcrText, stripTrailingIcon, looksLikeLogo, medianHeight, mergeCutLines, spreadCode, isCodeLine,
} from './layout';

// 一张截图从识别到可以画的数据。全屏翻译、区域翻译、测试脚本走的都是这一条路，
// 区别只在截图从哪来、浮层画在哪。

export interface Recognized {
  /// OCR 出来的全部块（CSS 像素）
  cssBlocks: TextBlock[];
  /// 过滤后要翻译的块
  toTranslate: TextBlock[];
  /// 要翻译的块并成的段落
  paragraphs: ParagraphBlock[];
  /// 按文字内容算的指纹，全屏翻译的缓存用
  hash: string;
}

export interface Rendered {
  /// 翻好的段落（带译文），浮层按它们画
  blocks: any[];
  /// 要擦掉的原文框
  eraseRects: Array<{ x: number; y: number; width: number; height: number }>;
  /// 其余不擦的字：擦除往外扩时不许碰到它们（终端里行挨着行，扩一点就吃掉下一行的上半截）
  keepRects: Array<{ x: number; y: number; width: number; height: number }>;
  failed: number;
}

export async function recognizeImage(
  imagePath: string, scaleFactor: number, cssWidth: number, targetLang: string, windows: WindowRect[] = [],
): Promise<Recognized> {
  // 先认字，认完再看段落（文档识别）。两个同时跑会抢同一块神经网络引擎，实测两边都变慢好几倍。
  // 段落只是提示，最多给它 0.7 秒，超时就杀掉不用（内容很杂的屏幕它要好几秒，不值得等；
  // 大标题折行另有按版面的判断兜底）
  const rawBlocks = await performOCR(imagePath, targetLang.split('-')[0]);
  const docLines = await performDocLayout(imagePath, 700);
  const ocrBlocks = assignDocParagraphs(rawBlocks, docLines);
  debugLog(`识别：OCR ${ocrBlocks.length} 块，文档识别 ${docLines.length} 行`);
  if (ocrBlocks.length) debugLog(`OCR 头几条: ${ocrBlocks.slice(0, 5).map(b => b.text).join(' | ')}`);
  for (const b of ocrBlocks) {
    debugLogVerbose(`  原始块 ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} c=${b.confidence.toFixed(2)} w=${(b.weight || 0).toFixed(3)} | ${b.text}`);
  }
  const cssBlocks = mergeCutLines(dropIconBlocks(ocrBlocks, scaleFactor)
    .map(b => toCss(b, scaleFactor))
    .map(b => stripTrailingIcon({ ...b, text: normalizeOcrText(b.text) })));
  const hash = crypto.createHash('md5').update(cssBlocks.map(b => b.text).sort().join('|')).digest('hex');
  const medH = cssBlocks.length ? medianHeight(cssBlocks) : 0;
  const code = spreadCode(cssBlocks, b => isCodeLine(b.text));
  const toTranslate = filterForeignBlocks(cssBlocks, targetLang).filter(b => !looksLikeLogo(b, medH) && !code.has(b));
  debugLog(`过滤后剩 ${toTranslate.length} 块要翻译（目标语言 ${targetLang}）`);
  const paragraphs = toTranslate.length
    ? groupIntoParagraphs(dropDuplicateBoxes(dropLowConfidenceOverlaps(dropUndersizedBoxes(dropOversizedBoxes(toTranslate)))), cssWidth, windows)
    : [];
  if (paragraphs.length !== toTranslate.length) debugLog(`按版面并段：${toTranslate.length} 行 → ${paragraphs.length} 段`);
  return { cssBlocks, toTranslate, paragraphs, hash };
}

export async function translateRecognized(rec: Recognized, targetLang: string, config: any): Promise<Rendered> {
  const { paragraphs } = rec;
  const inkOn = inkSupported(config.provider);
  const results = await translateWithInk(paragraphs, targetLang, config, inkOn);
  const translations = results.map(r => r.text);
  debugLog(`翻译回来 ${translations.length} 条（保持颜色：${inkOn ? '开' : '关，当前翻译服务保不住颜色标记'}）`);
  paragraphs.forEach((b, i) => debugLog(
    `  [${i}] ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} ${b.lineCount}行` +
    `${b.ink ? ` 主色 ${b.ink.join(',')}` : ''}${b.runs?.length ? ` 色段 ${b.runs.map(r => `「${r.text}」${r.ink.join(',')}${r.underline ? '_' : ''}`).join(' ')}` : ''}\n` +
    `      原: ${b.text}\n      译: ${translations[i] ?? ''}` +
    `${results[i]?.spans.length ? `\n      上色: ${results[i].spans.map(s => `「${translations[i].slice(s.start, s.end)}」`).join(' ')}` : ''}`
  ));

  // 没翻出来的段落（接口失败、返回空）一个都别画：照原文画上去就是"英文盖英文"，
  // 字号还不一定对；擦掉又只剩一片空白。干脆原样留着，看着是没翻，至少不是坏的。
  const failed = paragraphs.filter((_, i) => !translations[i]);
  if (failed.length) debugLog(`有 ${failed.length} 段没翻出来，保持原文不动`);
  // 译文和原文一样（文件名、本来就是中文、专名）的不画也不擦：擦了重画只会把原来的字画走样
  const same = (a: string, b: string) => a.replace(/[\s，,。.；;：:！!？?]/g, '') === b.replace(/[\s，,。.；;：:！!？?]/g, '');
  const blocks = paragraphs
    .map((block, i) => withTranslation(block, results[i], inkOn))
    .filter(b => b.translated && !same(b.translated, b.text));

  // 擦除只擦"会画上译文"的那些原文：块的中心落在某个翻好的段落里。
  // 不翻的（中文、数字、网址、代码）、没翻出来的，像素一点不动。
  const inside = (r: TextBlock, p: any) => {
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    return cx >= p.x && cx <= p.x + p.width && cy >= p.y && cy <= p.y + p.height;
  };
  const erased = rec.toTranslate.filter(r => blocks.some(p => inside(r, p)));
  const eraseRects = erased.map(eraseRectOf);
  const keepRects = rec.cssBlocks.filter(b => !erased.includes(b)).map(b => ({ x: b.x, y: b.y, width: b.width, height: b.height }));
  return { blocks, eraseRects, keepRects, failed: failed.length };
}
