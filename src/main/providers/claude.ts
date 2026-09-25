import { ProviderConfig } from '../config';
import { request } from '../http';
import { mapBatchesConcurrent, alignedOrOneByOne } from '../batch';

const BATCH_SIZE = 20;
/// 整段翻译之后一条就是一整段；按字数再切一刀，免得一批的译文超过模型的输出上限被截断
const BATCH_MAX_CHARS = 6000;
const MAX_CONCURRENCY = 3;

export async function translateWithClaude(
  texts: string[],
  targetLang: string,
  config: ProviderConfig
): Promise<string[]> {
  if (!config.apiKey) throw new Error('Claude API key not configured');

  // 和 OpenAI 一样分批并发：以前一批一批串着发，一整屏要等好几轮，而且一批出错整屏都没了
  const batched = await mapBatchesConcurrent<string>(
    texts, BATCH_SIZE, MAX_CONCURRENCY,
    (batch) => translateBatch(batch, targetLang, config),
    (err, batch) => console.error(`[Claude] Batch failed (${batch.length} texts):`, err?.message || err),
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
- Tags like <c1>...</c1> mark highlighted words (links, colored text): keep every tag pair exactly once, around the translation of the words it wraps; never drop, add or renumber tags
- Translate naturally for UI context
- No explanation, no markdown, just the JSON array

${input}`;

  const baseUrl = (config.baseUrl || 'https://api.anthropic.com').replace(/\/+$/, '');
  const endpoint = `${baseUrl}/v1/messages`;

  const data = await request(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': config.apiKey!,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.model || 'claude-sonnet-4-20250514',
      max_tokens: 8192,
      messages: [{ role: 'user', content: prompt }],
      system: 'You are a UI translator. Output only a valid JSON array. No thinking, no explanation.',
    }),
  });

  // Extract text content (skip thinking blocks)
  let content = '';
  if (Array.isArray(data.content)) {
    for (const block of data.content) {
      if (block.type === 'text' && block.text) {
        content = block.text.trim();
        break;
      }
    }
    if (!content) {
      const first = data.content.find((b: any) => b.text);
      if (first) content = first.text.trim();
    }
  }

  if (!content) {
    console.error('[Claude] Empty response:', JSON.stringify(data).slice(0, 300));
    return texts.map(() => ''); // 没有内容 = 没翻出来，交给调用方保留原文
  }

  return alignedOrOneByOne(content, texts, async t => (await translateBatch([t], targetLang, config))[0]);
}
