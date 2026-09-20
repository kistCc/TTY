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
      batch.forEach(t => params.append('text', t));
      params.append('target_lang', deeplLang);
      const data = await request(`${baseUrl}/v2/translate`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Authorization': `DeepL-Auth-Key ${config.apiKey}`,
        },
        body: params.toString(),
      });
      if (data.translations && Array.isArray(data.translations)) {
        return data.translations.map((t: { text: string }) => t.text);
      }
      throw new Error('Unexpected DeepL response');
    },
    (err, batch) => console.error(`[DeepL] Batch failed (${batch.length} texts):`, err?.message || err),
    BATCH_MAX_CHARS
  );
  return batched.flat();
}
