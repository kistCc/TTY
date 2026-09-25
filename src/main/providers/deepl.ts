import { ProviderConfig } from '../config';
import { request } from '../http';
import { mapBatchesConcurrent } from '../batch';

const BATCH_SIZE = 50;
const MAX_CONCURRENCY = 3;
const BATCH_MAX_CHARS = 30000;

// DeepL language code mapping
const DEEPL_LANG_MAP: Record<string, string> = {
  'zh-CN': 'ZH-HANS',
  'zh-TW': 'ZH-HANT',
  'en': 'EN',
  'ja': 'JA',
  'ko': 'KO',
  'fr': 'FR',
  'de': 'DE',
  'es': 'ES',
  'pt': 'PT-BR',
  'it': 'IT',
  'ru': 'RU',
};

export async function translateWithDeepL(
  texts: string[],
  targetLang: string,
  config: ProviderConfig
): Promise<string[]> {
  if (!config.apiKey) throw new Error('DeepL API key not configured');

  const deeplLang = DEEPL_LANG_MAP[targetLang] || targetLang.toUpperCase();

  // DeepL Free vs Pro endpoint
  const isFree = config.apiKey.endsWith(':fx');
  const baseUrl = isFree
    ? 'https://api-free.deepl.com'
    : 'https://api.deepl.com';

  // DeepL 一次请求最多 50 条、正文最多 128KB。以前整屏一次发出去，条数一多整屏失败；
  // 改成和别家一样分批并发，一批失败只影响那一批。
  const batched = await mapBatchesConcurrent<string>(
    texts, BATCH_SIZE, MAX_CONCURRENCY,
    async (batch) => {
      const params = new URLSearchParams();
      // 带颜色标记（<c1>…</c1>）的请求要开 XML 模式，DeepL 才会原样保留标签；
      // XML 模式下正文里的 & < > 得先转义，只留我们自己的标签
      const tagged = batch.some(t => /<\/?c\d+>/.test(t));
      const escape = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/&lt;(\/?c\d+)&gt;/g, '<$1>');
      batch.forEach(t => params.append('text', tagged ? escape(t) : t));
      params.append('target_lang', deeplLang);
      if (tagged) params.append('tag_handling', 'xml');
      const data = await request(`${baseUrl}/v2/translate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `DeepL-Auth-Key ${config.apiKey}`,
        },
        body: params.toString(),
      });
      if (data.translations && Array.isArray(data.translations)) {
        const unescape = (t: string) => t.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
        return data.translations.map((t: { text: string }) => (tagged ? unescape(t.text) : t.text));
      }
      throw new Error('Unexpected DeepL response');
    },
    (err, batch) => console.error(`[DeepL] Batch failed (${batch.length} texts):`, err?.message || err),
    BATCH_MAX_CHARS
  );
  return batched.flat();
}
