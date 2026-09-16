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

// Split an image into 2x2 overlapping quadrants, OCR each concurrently, merge results.
// Smaller regions give Vision OCR better accuracy than one huge image.
export async function performOCRSplit(imagePath: string): Promise<TextBlock[]> {
  const img = nativeImage.createFromPath(imagePath);
  const { width, height } = img.getSize();

  // For small images, just run normal OCR
  if (width < 1500 && height < 1500) {
    return performOCR(imagePath);
  }

  const overlap = 0.1; // 10% overlap to catch boundary text
  const halfW = Math.floor(width / 2);
  const halfH = Math.floor(height / 2);
  const ox = Math.round(width * overlap);
  const oy = Math.round(height * overlap);

  const quadrants = [
    { x: 0, y: 0, w: halfW + ox, h: halfH + oy },
    { x: halfW - ox, y: 0, w: halfW + ox, h: halfH + oy },
    { x: 0, y: halfH - oy, w: halfW + ox, h: halfH + oy },
    { x: halfW - ox, y: halfH - oy, w: halfW + ox, h: halfH + oy },
  ];

  const tmpDir = os.tmpdir();
  const results = await Promise.all(quadrants.map(async (q, i) => {
    const cropped = img.crop({ x: q.x, y: q.y, width: q.w, height: q.h });
    // JPEG 而非 PNG：这四张图只喂给 OCR，不会显示给用户，而全屏尺寸下 PNG 编码
    // 要几百毫秒，JPEG 只要几十毫秒。质量 92 对 Vision 的识别率没有可测的影响。
    const cropPath = path.join(tmpDir, `ocr-quad-${Date.now()}-${i}.jpg`);
    fs.writeFileSync(cropPath, cropped.toJPEG(92));
    const blocks = await performOCR(cropPath);
    try { fs.unlinkSync(cropPath); } catch {}
    // Offset coordinates back to full image space
    return blocks.map(b => ({ ...b, x: b.x + q.x, y: b.y + q.y }));
  }));

  // Merge and dedupe overlapping blocks at quadrant boundaries
  const all = results.flat();
  return dedupeBlocks(all);
}

/// 象限有 10% 重叠，同一段文字会被识别两次，而两次的断句往往不同
/// （一次断在 "Heads up: the summer..."，另一次断在 "...ended Sept 13"）。
/// 所以不能只在文本完全相同时去重，位置压在一起就得留一个，否则同一片区域
/// 会贴上两层译文。留的是"信息更全"的那块：文本更长，长度相当时取置信度更高的。
function dedupeBlocks(blocks: TextBlock[]): TextBlock[] {
  const kept: TextBlock[] = [];
  for (const b of blocks) {
    const idx = kept.findIndex(k => overlapRatio(k, b) > 0.5);
    if (idx < 0) { kept.push(b); continue; }
    if (isRicher(b, kept[idx])) kept[idx] = b;
  }
  return kept;
}

function overlapRatio(a: TextBlock, b: TextBlock): number {
  const ix = Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  const smaller = Math.min(a.width * a.height, b.width * b.height);
  return smaller > 0 ? (ix * iy) / smaller : 0;
}

function isRicher(candidate: TextBlock, current: TextBlock): boolean {
  const lc = candidate.text.trim().length;
  const ll = current.text.trim().length;
  if (lc !== ll) return lc > ll;
  return candidate.confidence > current.confidence;
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

