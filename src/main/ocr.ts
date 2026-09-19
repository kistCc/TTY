import { execFile } from 'child_process';
import { ensureNative, debugLogVerbose } from './native';

export interface TextBlock {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
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
      return kt === bt || (bt.length >= 4 && (kt.includes(bt) || bt.includes(kt)));
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
