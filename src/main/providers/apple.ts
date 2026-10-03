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
  en: '英语', 'zh-Hans': '简体中文', 'zh-Hant': '繁体中文', ja: '日语', ko: '韩语', es: '西班牙语', de: '德语', fr: '法语',
  it: '意大利语', pt: '葡萄牙语', ru: '俄语', nl: '荷兰语', id: '印尼语', vi: '越南语', tr: '土耳其语', pl: '波兰语',
};

interface AppleOutput { translations: string[]; missing: string[]; errors: string[] }

/// 一次翻译最多等多久。系统翻译服务（translationd）闲置后第一次被叫起来，偶尔会收下请求却一直不回；
/// 正常冷启动整页也就几秒，等到 30 秒还没回就是卡住了：杀掉重来一次，还不行再报错
const RUN_TIMEOUT_MS = 30_000;
const TIMEOUT_MSG = `系统翻译超时（${RUN_TIMEOUT_MS / 1000} 秒没有回应）`;

function run(binaryPath: string, input: string, timeout = RUN_TIMEOUT_MS): Promise<AppleOutput> {
  return new Promise((resolve, reject) => {
    const child = execFile(binaryPath, [], { maxBuffer: 64 * 1024 * 1024, timeout }, (err: any, stdout, stderr) => {
      if (err?.killed) { reject(new Error(TIMEOUT_MSG)); return; }
      try {
        resolve(JSON.parse(stdout.toString()));
      } catch {
        reject(new Error(`系统翻译出错：${(stderr || err?.message || '没有输出').toString().trim().slice(0, 200)}`));
      }
    });
    child.stdin?.end(input);
  });
}

async function runRetry(binaryPath: string, input: string): Promise<AppleOutput> {
  try {
    return await run(binaryPath, input);
  } catch (e: any) {
    if (e?.message !== TIMEOUT_MSG) throw e;
    console.warn('[Apple] 系统翻译卡住了，重来一次');
    return run(binaryPath, input);
  }
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
  const target = APPLE_LANG[targetLang] ?? targetLang;
  // 'best'：高质量档（更慢）；默认 'fast' 普通档
  const strategy = (_config as any)?.strategy === 'best' ? 'best' : 'fast';
  const out = await runRetry(binaryPath, JSON.stringify({ target, texts, strategy }));
  if (out.errors?.length) console.error('[Apple] 翻译出错:', out.errors.join('; '));
  const translations = texts.map((_, i) => out.translations?.[i] ?? '');
  if (out.missing?.length) {
    // 一对语言两头都要装，只报源语言的话，目标语言没装时用户会找错
    const name = (l: string) => LANG_NAME[l] || l;
    const pairs = out.missing.map(l => `${name(l)} → ${name(target)}`).join('、');
    console.warn(`[Apple] 缺语言包：${pairs}`);
    if (translations.every(t => !t)) {
      throw new Error(`请先在「系统设置 → 通用 → 语言与地区 → 翻译语言」下载：${pairs}（两种语言都要下载）`);
    }
  }
  if (translations.every(t => !t) && out.errors?.length) throw new Error(`系统翻译出错：${out.errors[0]}`);
  return translations;
}

let warming = false;

/// 提前叫醒系统翻译服务（不翻译）。按下截屏、打开输入框时调用，不等结果、出错也不管：
/// 服务闲置会自己退出，冷启动要等一会儿，趁识字、打字的时间先把它叫起来。
export function warmApple(targetLang: string) {
  if (warming) return;
  warming = true;
  ensureNative('translate-macos')
    .then(({ binaryPath, error }) => error ? undefined :
      run(binaryPath, JSON.stringify({ target: APPLE_LANG[targetLang] ?? targetLang, texts: [], warm: true }), 10_000))
    .catch(() => {})
    .finally(() => { warming = false; });
}
