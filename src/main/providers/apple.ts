import { execFile } from 'child_process';
import { ProviderConfig } from '../config';
import { ensureNative } from '../native';

/// TTY 的语言代码 → Apple 翻译用的语言代码
const APPLE_LANG: Record<string, string> = {
  'zh-CN': 'zh-Hans',
  'zh-TW': 'zh-Hant',
};

/// 缺语言包时报给用户看的名字
const LANG_NAME: Record<string, string> = {
  en: '英语', 'zh-Hans': '简体中文', ja: '日语', ko: '韩语', es: '西班牙语', de: '德语', fr: '法语',
  it: '意大利语', pt: '葡萄牙语', ru: '俄语', nl: '荷兰语', id: '印尼语', vi: '越南语', tr: '土耳其语', pl: '波兰语',
};

interface AppleOutput { translations: string[]; missing: string[]; errors: string[] }

function run(binaryPath: string, input: string): Promise<AppleOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(binaryPath, [], { maxBuffer: 64 * 1024 * 1024, timeout: 120000 }, (err, stdout, stderr) => {
      try {
        resolve(JSON.parse(stdout.toString()));
      } catch {
        reject(new Error(`系统翻译出错：${(stderr || err?.message || '没有输出').toString().trim().slice(0, 200)}`));
      }
    });
    child.stdin?.end(input);
  });
}

/// macOS 自带的翻译（离线）。翻不了的段交空串，调用方保留原文。
/// 一段都没翻成、又是因为语言包没装，才报错，提示去系统设置下载。
export async function translateWithApple(
  texts: string[],
  targetLang: string,
  _config: ProviderConfig
): Promise<string[]> {
  const { binaryPath, error } = await ensureNative('translate-macos');
  if (error) throw new Error(`系统翻译不可用：${error}`);
  const out = await run(binaryPath, JSON.stringify({ target: APPLE_LANG[targetLang] ?? targetLang, texts, strategy: 'fast' }));
  if (out.errors?.length) console.error('[Apple] 翻译出错:', out.errors.join('; '));
  const translations = texts.map((_, i) => out.translations?.[i] ?? '');
  if (out.missing?.length) {
    const names = out.missing.map(l => LANG_NAME[l] || l).join('、');
    console.warn(`[Apple] 缺语言包：${names}`);
    if (translations.every(t => !t)) {
      throw new Error(`请先在「系统设置 → 通用 → 语言与地区 → 翻译语言」下载：${names}`);
    }
  }
  if (translations.every(t => !t) && out.errors?.length) throw new Error(`系统翻译出错：${out.errors[0]}`);
  return translations;
}
