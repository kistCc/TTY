import { execFile } from 'child_process';
import { ensureNative } from './native';
import { TextBlock } from './ocr';

export interface AXTextBlock extends TextBlock {
  role: string;
}

export function getAccessibilityText(pid?: number): Promise<AXTextBlock[]> {
  return new Promise(async (resolve) => {
    const { binaryPath, error } = await ensureNative('axtext-macos');
    if (error) { resolve([]); return; }

    const args = pid ? [String(pid)] : [];
    execFile(binaryPath, args, { maxBuffer: 10 * 1024 * 1024, timeout: 5000 }, (err, stdout, stderr) => {
      if (err) {
        console.log('[ax] 取文本失败，回落到纯 OCR:', (stderr || '').toString().trim().slice(0, 200));
        resolve([]);
        return;
      }
      try {
        resolve(JSON.parse(stdout.trim()) as AXTextBlock[]);
      } catch {
        resolve([]);
      }
    });
  });
}
