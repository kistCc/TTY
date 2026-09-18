import { execFile } from 'child_process';
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

/// 整屏识别。
///
/// 这里原本把截图切成 2x2 带重叠的象限分别 OCR，想借小图提高精度；代价是
/// 一行文字会被边界从中间撕开，左右两半分属不同块，后面无论怎么拼都在猜，
/// 常常把半句话送去翻译。行结构比那点精度重要得多，所以整屏识别。
export async function performOCRSplit(imagePath: string): Promise<TextBlock[]> {
  return performOCR(imagePath);
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

