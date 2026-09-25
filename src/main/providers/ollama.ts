import { ProviderConfig } from '../config';
import { request } from '../http';
import { mapBatchesConcurrent, alignedOrOneByOne } from '../batch';

/// 本地模型一次吃不下一整屏，和别家一样分批；本机算力有限，一批一批来，不并发。
const BATCH_SIZE = 20;
const BATCH_MAX_CHARS = 4000;

export async function translateWithOllama(
  texts: string[],
  targetLang: string,
  config: ProviderConfig
): Promise<string[]> {
  const batched = await mapBatchesConcurrent<string>(
    texts, BATCH_SIZE, 1,
    (batch) => translateBatch(batch, targetLang, config),
    (err, batch) => console.error(`[Ollama] Batch failed (${batch.length} texts):`, err?.message || err),
    BATCH_MAX_CHARS
  );
  return batched.flat();
}

async function translateBatch(
  texts: string[],
  targetLang: string,
  config: ProviderConfig
): Promise<string[]> {
  const baseUrl = config.baseUrl || 'http://localhost:11434';
  const model = config.model || 'qwen2.5';

  const numbered = texts.map((t, i) => `${i + 1}. ${t}`).join('\n');
  const prompt = `Translate the following texts to ${targetLang}. Return ONLY a JSON array of translated strings in the same order, no explanation. Keep proper nouns, brand names, URLs and numbers unchanged. Tokens like XQZ0, XQZ1 are placeholders for product names: copy them exactly. Tags like <c1>...</c1> mark highlighted words: keep every tag pair exactly once, around the translation of the words it wraps.\n\n${numbered}`;

  const data = await request(`${baseUrl}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      stream: false,
      messages: [
        { role: 'system', content: 'You are a precise translator. Output only valid JSON.' },
        { role: 'user', content: prompt },
      ],
    }),
  });

  const content = data.message?.content?.trim() || '';
  return alignedOrOneByOne(content, texts, async t => (await translateBatch([t], targetLang, config))[0]);
}
