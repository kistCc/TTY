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

function dedupeBlocks(blocks: TextBlock[]): TextBlock[] {
  const kept: TextBlock[] = [];
  for (const b of blocks) {
    const duplicate = kept.find(k => {
      const ix = Math.max(0, Math.min(k.x + k.width, b.x + b.width) - Math.max(k.x, b.x));
      const iy = Math.max(0, Math.min(k.y + k.height, b.y + b.height) - Math.max(k.y, b.y));
      const overlap = ix * iy;
      const bArea = b.width * b.height;
      const kArea = k.width * k.height;
      return overlap / Math.min(bArea, kArea) > 0.5 && k.text === b.text;
    });
    if (!duplicate) kept.push(b);
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

