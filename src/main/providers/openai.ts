import { ProviderConfig } from '../config';
import { request } from '../http';
import { mapBatchesConcurrent, alignedOrOneByOne } from '../batch';

const BATCH_SIZE = 20;
/// 整段翻译之后一条就是一整段；按字数再切一刀，免得一批的译文超过模型的输出上限被截断
const BATCH_MAX_CHARS = 6000;
// 各家 OpenAI 兼容接口的并发上限差别很大，3 路是个保守又明显更快的取值。
const MAX_CONCURRENCY = 3;

export async function translateWithOpenAI(
  texts: string[],
  targetLang: string,
  config: ProviderConfig
): Promise<string[]> {
  if (!config.apiKey) throw new Error('OpenAI API key not configured');

  const batched = await mapBatchesConcurrent<string>(
    texts, BATCH_SIZE, MAX_CONCURRENCY,
    (batch) => translateBatch(batch, targetLang, config),
    (err, batch) => console.error(`[OpenAI] Batch failed (${batch.length} texts):`, err?.message || err),
    BATCH_MAX_CHARS
  );
  return batched.flat();
}

async function translateBatch(
  texts: string[],
  targetLang: string,
  config: ProviderConfig
): Promise<string[]> {
  const input = JSON.stringify(texts);
  const prompt = `Translate this JSON array of UI texts to ${targetLang}. Rules:
- Return ONLY a JSON array of the same length
- Keep proper nouns, brand names, URLs, numbers unchanged
- Tokens like XQZ0, XQZ1 are placeholders for product names: copy them exactly, do not translate, drop or reorder their text
- Translate naturally for UI context
- No explanation, no markdown, just the JSON array

${input}`;

  const baseUrl = config.baseUrl || 'https://api.openai.com/v1';
  const data = await request(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || 'gpt-4o-mini',
      messages: [
        { role: 'system', content: 'You are a UI translator. Output only a valid JSON array.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 8192,
    }),
  });

  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    console.error('[OpenAI] Empty response:', JSON.stringify(data).slice(0, 300));
    return texts.map(() => ''); // 没有内容 = 没翻出来，交给调用方保留原文
  }
  return alignedOrOneByOne(content, texts, async t => (await translateBatch([t], targetLang, config))[0]);
}
