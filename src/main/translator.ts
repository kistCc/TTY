import { Config } from './config';
import { translateWithOpenAI } from './providers/openai';
import { translateWithClaude } from './providers/claude';
import { translateWithDeepL } from './providers/deepl';
import { translateWithOllama } from './providers/ollama';
import { translateWithGoogle } from './providers/google';
import { translateWithYoudao } from './providers/youdao';

/// 产品名被硬翻出来最难看：Claude 成了"克劳德"、Claude Code 成了"克劳德代码"。
/// 整块文本就是一个产品名时直接原样留着，连请求都不用发。
/// 只认这张表里的名字——除了公司和产品名，其余英文一律要翻。
const KEEP_AS_IS = new Set([
  'claude', 'claude code', 'cowork', 'anthropic', 'chatgpt', 'openai', 'gemini',
  'github', 'gitlab', 'notion', 'slack', 'figma', 'xcode', 'vs code', 'visual studio code',
  'safari', 'chrome', 'firefox', 'finder', 'spotlight', 'siri',
  'macos', 'ios', 'ipados', 'windows', 'linux', 'android',
  'python', 'javascript', 'typescript', 'node.js', 'npm', 'json', 'html', 'css',
  'deepl', 'ollama', 'google', 'youdao', 'tty', 'wi-fi', 'wifi', 'bluetooth',
]);

function keepAsIs(text: string): boolean {
  const t = text.trim().replace(/[.:,;!?]+$/, '');
  if (!t) return true;
  return KEEP_AS_IS.has(t.toLowerCase());
}


/// 句内的产品名换成 XQZ0 这种占位符再发。实测有道会把 ⟦0⟧、{0}、[0]、<0> 这类
/// 括号占位符删掉或改掉（"Claude" 就此消失、被译成"你"），而字母+数字的生造词
/// 它会当专有名词原样带回来。
const BRAND_PATTERNS = [
  /\bClaude Code\b/g, /\bClaude\b/g, /\bChatGPT\b/g, /\bAnthropic\b/g, /\bOpenAI\b/g,
  /\bGitHub\b/g, /\bmacOS\b/g, /\biOS\b/g, /\bTTY\b/g, /\bCowork\b/g,
];

function maskBrands(text: string): { text: string; brands: string[] } {
  const brands: string[] = [];
  let masked = text;
  for (const re of BRAND_PATTERNS) {
    masked = masked.replace(re, (hit) => {
      brands.push(hit);
      return `XQZ${brands.length - 1}`;
    });
  }
  return { text: masked, brands };
}

function unmaskBrands(text: string, brands: string[]): string {
  if (!brands.length) return text;
  return text.replace(/XQZ(\d+)/gi, (whole, n) => brands[Number(n)] ?? whole);
}

export async function translate(
  texts: string[],
  targetLang: string,
  config: Config
): Promise<string[]> {
  if (texts.length === 0) return [];

  // 一屏里重复的文本很多——同名按钮、重复的标签、多处出现的菜单项。只把去重后的
  // 集合发出去，回来再按原顺序摊开，通常能省掉两三成的请求量。
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!seen.has(text)) { seen.add(text); unique.push(text); }
  }
  if (unique.length < texts.length) {
    console.log(`[translate] 去重：${texts.length} → ${unique.length} 条`);
  }

  // 产品名这类不用翻的挑出去，剩下的才发出去
  const needTranslate = unique.filter(text => !keepAsIs(text));
  // 句子里夹着的产品名（"the summer Claude Code promo…"）换成占位符再发，
  // 翻译服务照抄不动，回来按原样还回去，就不会有"克劳德代码"了。
  const masked = needTranslate.map(maskBrands);
  const translatedList = needTranslate.length
    ? await translateUnique(masked.map(m => m.text), targetLang, config)
    : [];
  const resultOf = new Map<string, string>();
  needTranslate.forEach((text, i) => {
    resultOf.set(text, unmaskBrands(translatedList[i] ?? text, masked[i].brands));
  });

  return texts.map(text => resultOf.get(text) ?? text);
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
