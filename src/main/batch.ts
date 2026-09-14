/// 把一串文本切成批次并发送出去，同时在途的批次不超过 concurrency 个。
///
/// 之前每个 provider 都是 `for (...) await` 串行发批次：一屏几十上百个文本块
/// 要排成四五轮往返，代理链路上每轮都是一两秒。批次之间没有任何依赖，排队纯属浪费。
export async function mapBatchesConcurrent<T>(
  texts: string[],
  batchSize: number,
  concurrency: number,
  handler: (batch: string[]) => Promise<T[]>,
  onBatchError?: (err: any, batch: string[]) => void
): Promise<T[][]> {
  const batches: string[][] = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    batches.push(texts.slice(i, i + batchSize));
  }

  // 按下标回填，结果顺序和输入顺序始终一致，与完成先后无关。
  const out: T[][] = new Array(batches.length);
  let cursor = 0;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= batches.length) return;
      try {
        out[i] = await handler(batches[i]);
      } catch (err) {
        onBatchError?.(err, batches[i]);
        out[i] = batches[i] as unknown as T[];
      }
    }
  };

  const workers = Math.max(1, Math.min(concurrency, batches.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}
