import { execFile } from 'child_process';
import { nativeImage } from 'electron';
import * as path from 'path';
import * as os from 'os';
import * as fs from 'fs';
import { ensureNative } from './native';

export interface TextBlock {
  text: string;
  confidence: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/// 整屏识别，但按"横条"分片。
///
/// 这里原本切成 2x2 象限：小图确实能提高精度，但竖着那一刀会把一行文字从中间
/// 撕开，左右两半分属不同块，后面无论怎么拼都在猜，常常把半句话送去翻译。
/// 于是一度改回整屏一次识别——结果是密排的长页面上，Vision 会整片整片地漏字
/// （实测一页 76 行的等宽正文，中间连着三行一个框都没吐出来）。
///
/// 横条分片两头都占：文字是横向排列的，横着切只会切在行与行之间，永远不会把
/// 一行切成两半；每片又都比整屏小，精度跟着回来。片与片之间留一点重叠，
/// 骑在缝上的那一行两片都能认到，最后按内容去重。
const OCR_STRIPES = 3;
const OCR_OVERLAP = 0.06;
/// 小图本来就认得准，切了反而多花时间
const OCR_SPLIT_MIN_HEIGHT = 1200;

export async function performOCRSplit(imagePath: string): Promise<TextBlock[]> {
  let full: Electron.NativeImage;
  try {
    full = nativeImage.createFromPath(imagePath);
  } catch {
    return performOCR(imagePath);
  }
  const { width, height } = full.getSize();
  if (!width || !height || height < OCR_SPLIT_MIN_HEIGHT) return performOCR(imagePath);

  const band = Math.ceil(height / OCR_STRIPES);
  const pad = Math.round(band * OCR_OVERLAP);
  const temps: string[] = [];
  const jobs: Promise<TextBlock[]>[] = [];

  try {
    for (let i = 0; i < OCR_STRIPES; i++) {
      const top = Math.max(0, i * band - pad);
      const bottom = Math.min(height, (i + 1) * band + pad);
      if (bottom - top <= 0) continue;
      const piece = full.crop({ x: 0, y: top, width, height: bottom - top });
      const file = path.join(os.tmpdir(), `tty-ocr-${process.pid}-${Date.now()}-${i}.png`);
      fs.writeFileSync(file, piece.toPNG());
      temps.push(file);
      jobs.push(performOCR(file).then(blocks => blocks.map(b => ({ ...b, y: b.y + top }))));
    }
  } catch (err) {
    for (const f of temps) { try { fs.unlinkSync(f); } catch {} }
    console.error('[ocr] 切条失败，改为整屏识别:', err);
    return performOCR(imagePath);
  }

  try {
    const parts = await Promise.all(jobs);
    return dedupeStripeOverlap(parts.flat());
  } finally {
    for (const f of temps) { try { fs.unlinkSync(f); } catch {} }
  }
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

export function performOCR(imagePath: string): Promise<TextBlock[]> {
  return new Promise(async (resolve, reject) => {
    const { binaryPath, error } = await ensureNative('ocr-macos');
    if (error) { reject(new Error(error)); return; }

    execFile(binaryPath, [imagePath], { maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        reject(new Error(`OCR 失败: ${(stderr || err.message).toString().trim().slice(0, 200)}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as TextBlock[]);
      } catch {
        reject(new Error('OCR 输出解析失败'));
      }
    });
  });
}

