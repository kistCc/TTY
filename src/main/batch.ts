/// 把一串文本切成批次并发送出去，同时在途的批次不超过 concurrency 个。
///
/// 之前每个 provider 都是 `for (...) await` 串行发批次：一屏几十上百个文本块
/// 要排成四五轮往返，代理链路上每轮都是一两秒。批次之间没有任何依赖，排队纯属浪费。
export async function mapBatchesConcurrent<T>(
  texts: string[],
  batchSize: number,
  concurrency: number,
  handler: (batch: string[]) => Promise<T[]>,
  onBatchError?: (err: any, batch: string[]) => void,
  maxChars?: number
): Promise<T[][]> {
  // 批次不能只按"条数"切。改成整段翻译之后，一条就是一整段（三四百字），
  // 20 条拼起来能有七八千字，接口直接不返回，整批退回原文——屏幕上就留下一片
  // 没翻译的英文。所以再加一道字符预算，哪个先到按哪个切；
  // 单独一条就超预算的，自己单独成一批。
  const batches: string[][] = [];
  let cur: string[] = [];
  let curChars = 0;
  for (const text of texts) {
    const len = text.length + 1;
    const full = cur.length >= batchSize || (maxChars !== undefined && cur.length > 0 && curChars + len > maxChars);
    if (full) { batches.push(cur); cur = []; curChars = 0; }
    cur.push(text);
    curChars += len;
  }
  if (cur.length) batches.push(cur);

  // 按下标回填，结果顺序和输入顺序始终一致，与完成先后无关。
  const out: T[][] = new Array(batches.length);
  let cursor = 0;
  let failures = 0;
  let lastErr: any = null;

  const worker = async () => {
    for (;;) {
      const i = cursor++;
      if (i >= batches.length) return;
      try {
        out[i] = await handler(batches[i]);
      } catch (err) {
        failures++;
        lastErr = err;
        onBatchError?.(err, batches[i]);
        // 失败的那一批一律返回空串，不返回原文：调用方把空串当"没翻出来"，原文原样留在屏幕上；
        // 返回原文的话会被当成译文擦掉重画一遍英文。
        out[i] = batches[i].map(() => '') as unknown as T[];
      }
    }
  };

  const workers = Math.max(1, Math.min(concurrency, batches.length));
  await Promise.all(Array.from({ length: workers }, worker));
  // 全部失败（Key 不对、网络不通）就把错误抛出去让界面提示；只坏了几批则照常返回，坏的那几批是空串
  if (batches.length && failures === batches.length) throw lastErr;
  return out;
}

/// 大模型类翻译服务（OpenAI / Claude / Ollama）回的 JSON 数组，条数对得上才用。
///
/// 条数对不上时，不能在末尾补空、截掉多的，也不能按换行拆：只要中间少了或多了一条，
/// 后面每一条都会错位一格，译文贴到别的段落上。和有道一样，对不上就逐条重翻（translateOne），
/// 宁可慢也不能串位。
export async function alignedOrOneByOne(
  content: string,
  texts: string[],
  translateOne: (text: string) => Promise<string>
): Promise<string[]> {
  const m = content.match(/\[[\s\S]*\]/);
  try {
    const arr = m ? JSON.parse(m[0]) : null;
    if (Array.isArray(arr) && arr.length === texts.length) return arr.map(x => (x == null ? '' : String(x)));
    if (Array.isArray(arr) && texts.length === 1 && arr.length > 0) return [String(arr[0])];
  } catch {}
  if (texts.length === 1) return [''];
  return Promise.all(texts.map(t => translateOne(t).catch(() => '')));
}
