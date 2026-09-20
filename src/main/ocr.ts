import { execFile } from 'child_process';
import { ensureNative, debugLogVerbose } from './native';

export interface TextBlock {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
  /// 字重：平均笔画宽度（原图像素，原生程序量的），0 表示量不出来
  weight?: number;
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

/// 高屏会在原生程序里按横条分片识别（见 scripts/ocr-macos.m），骑缝的行两片都会认到，
/// 这里统一去重。
export function performOCR(imagePath: string): Promise<TextBlock[]> {
  return new Promise(async (resolve, reject) => {
    const { binaryPath, error } = await ensureNative('ocr-macos');
    if (error) { reject(new Error(error)); return; }

    execFile(binaryPath, [imagePath], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`OCR 失败: ${(stderr || err.message).toString().trim().slice(0, 200)}`));
        return;
      }
      if (stderr) debugLogVerbose(`OCR 分片: ${stderr.toString().trim().replace(/\n/g, ' | ')}`);
      try {
        resolve(dedupeStripeOverlap(JSON.parse(stdout.trim()) as TextBlock[]));
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
