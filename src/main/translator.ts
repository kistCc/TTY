import { Config } from './config';
import { translateWithOpenAI } from './providers/openai';
import { translateWithClaude } from './providers/claude';
import { translateWithDeepL } from './providers/deepl';
import { translateWithOllama } from './providers/ollama';
import { translateWithGoogle } from './providers/google';
import { translateWithYoudao } from './providers/youdao';

export async function translate(
  texts: string[],
  targetLang: string,
  config: Config
): Promise<string[]> {
  if (texts.length === 0) return [];

  // 一屏里重复的文本很多——同名按钮、重复的标签、多处出现的菜单项。只把去重后的
  // 集合发出去，回来再按原顺序摊开，通常能省掉两三成的请求量。
  const slotOf = new Map<string, number>();
  const unique: string[] = [];
  for (const text of texts) {
    if (!slotOf.has(text)) {
      slotOf.set(text, unique.length);
      unique.push(text);
    }
  }
  if (unique.length < texts.length) {
    console.log(`[translate] 去重：${texts.length} → ${unique.length} 条`);
  }

  const translated = await translateUnique(unique, targetLang, config);
  return texts.map(text => translated[slotOf.get(text)!] ?? text);
}

async function translateUnique(
  texts: string[],
  targetLang: string,
  config: Config
): Promise<string[]> {
  const provider = config.provider;
  const providerConfig = config.providers[provider] || {};

  switch (provider) {
    case 'google':
      return translateWithGoogle(texts, targetLang, providerConfig);
    case 'youdao':
      return translateWithYoudao(texts, targetLang, providerConfig);
    case 'openai':
      return translateWithOpenAI(texts, targetLang, providerConfig);
    case 'claude':
      return translateWithClaude(texts, targetLang, providerConfig);
    case 'deepl':
      return translateWithDeepL(texts, targetLang, providerConfig);
    case 'ollama':
      return translateWithOllama(texts, targetLang, providerConfig);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
