import * as crypto from 'crypto';
import { performOCR, TextBlock, WindowRect } from './ocr';
import { translateWithInk, inkSupported } from './translator';
import { debugLog, debugLogVerbose } from './native';
import {
  ParagraphBlock, filterForeignBlocks, toCss, eraseRectOf, withTranslation, groupIntoParagraphs,
  dropIconBlocks, dropUndersizedBoxes, dropLowConfidenceOverlaps, dropDuplicateBoxes, dropOversizedBoxes,
  normalizeOcrText, stripTrailingIcon, looksLikeLogo, medianHeight, mergeCutLines, spreadCode, isCodeLine, isIdentifier,
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
  const ocrBlocks = await performOCR(imagePath, targetLang.split('-')[0]);
  debugLog(`识别：OCR ${ocrBlocks.length} 块`);
  if (ocrBlocks.length) debugLog(`OCR 头几条: ${ocrBlocks.slice(0, 5).map(b => b.text).join(' | ')}`);
  for (const b of ocrBlocks) {
    debugLogVerbose(`  原始块 ${Math.round(b.x)},${Math.round(b.y)} ${Math.round(b.width)}x${Math.round(b.height)} c=${b.confidence.toFixed(2)} w=${(b.weight || 0).toFixed(3)} | ${b.text}`);
  }
  const cssBlocks = mergeCutLines(dropIconBlocks(ocrBlocks, scaleFactor)
    .map(b => toCss(b, scaleFactor))
    .map(b => stripTrailingIcon({ ...b, text: normalizeOcrText(b.text) })));
  const hash = crypto.createHash('md5').update(cssBlocks.map(b => b.text).sort().join('|')).digest('hex');
  const medH = cssBlocks.length ? medianHeight(cssBlocks) : 0;
  const code = spreadCode(cssBlocks, b => isCodeLine(b.text) || isIdentifier(b.text));
  const toTranslate = filterForeignBlocks(cssBlocks, targetLang).filter(b => !looksLikeLogo(b, medH) && !code.has(b));
  debugLog(`过滤后剩 ${toTranslate.length} 块要翻译（目标语言 ${targetLang}）`);
  const paragraphs = toTranslate.length
    ? groupIntoParagraphs(dropDuplicateBoxes(dropLowConfidenceOverlaps(dropUndersizedBoxes(dropOversizedBoxes(toTranslate)))), cssWidth, windows)
    : [];
  if (paragraphs.length !== toTranslate.length) debugLog(`按版面并段：${toTranslate.length} 行 → ${paragraphs.length} 段`);
  return { cssBlocks, toTranslate, paragraphs, hash };
}

/// 去掉空白和标点后逐字相同
function sameText(a: string, b: string): boolean {
  const k = (t: string) => t.replace(/[\s，,。.；;：:！!？?]/g, '');
  return k(a) === k(b);
}

export async function translateRecognized(rec: Recognized, targetLang: string, config: any): Promise<Rendered> {
  const { paragraphs } = rec;
  const inkOn = inkSupported(config.provider);
  const results = await translateWithInk(paragraphs, targetLang, config, inkOn);
  // 纯汉字的日文（“非表示”“出典”）会被 Google 当成中文原样退回。这一页上有假名时，
  // 把"译文和原文一样、又带汉字"的几段指明按日文再翻一次。
  const kanaParas = paragraphs.filter(p => /[\u3040-\u30ff]/.test(p.text)).length;
  if (config.provider === 'google' && kanaParas >= 3) {
    const redo = paragraphs.map((p, i) => i).filter(i =>
      /[\u4e00-\u9fff]/.test(paragraphs[i].text) && results[i]?.text && sameText(results[i].text, paragraphs[i].text));
    if (redo.length) {
      const cfg = { ...config, providers: { ...config.providers, google: { ...(config.providers?.google || {}), from: 'ja' } } };
      const again = await translateWithInk(redo.map(i => paragraphs[i]), targetLang, cfg, inkOn);
      redo.forEach((i, k) => { if (again[k]?.text) results[i] = again[k]; });
      debugLog(`按日文重翻 ${redo.length} 段`);
    }
  }
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
  const same = sameText;
  const blocks = paragraphs
    .map((block, i) => withTranslation(block, results[i], inkOn))
    .filter(b => b.translated && !same(b.translated, b.text));

  // 擦除只擦"会画上译文"的那些原文：块的中心落在某个翻好的段落里。
  // 不翻的（中文、数字、网址、代码）、没翻出来的，像素一点不动。
  const inside = (r: TextBlock, p: any) => {
    const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
    return cx >= p.x && cx <= p.x + p.width && cy >= p.y && cy <= p.y + p.height;
  };
  // 只擦真正拼进了"要画译文的段"的那些原始块；外框只是兜底（老数据没有 members 时）
  const drawn = new Set(paragraphs.filter((p, i) => results[i]?.text && !same(results[i].text, p.text)).flatMap(p => p.members || []));
  const erased = drawn.size
    ? rec.toTranslate.filter(r => drawn.has(r))
    : rec.toTranslate.filter(r => blocks.some(p => inside(r, p)));
  const eraseRects = erased.map(eraseRectOf);
  const keepRects = rec.cssBlocks.filter(b => !erased.includes(b)).map(b => ({ x: b.x, y: b.y, width: b.width, height: b.height }))
    // 从字里拿掉的图标也不许擦
    // 图标四周多留 1.5 像素：量出来的范围不含抗锯齿的边，擦除会把单选圈、图标削掉一小截
    .concat(rec.cssBlocks.flatMap(b => b.icons || []).map(r => ({ x: r.x - 1.5, y: r.y - 1.5, width: r.width + 3, height: r.height + 3 })));
  return { blocks, eraseRects, keepRects, failed: failed.length };
}
