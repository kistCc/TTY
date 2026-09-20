import { net } from 'electron';

interface RequestOptions {
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/// 原样返回响应体。有道的网页接口回的是密文，不是 JSON，得先拿到文本再解密。
export function requestText(url: string, options: RequestOptions): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = net.request({
      url,
      method: options.method,
    });

    for (const [key, value] of Object.entries(options.headers)) {
      req.setHeader(key, value);
    }

    req.on('response', (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk) => { chunks.push(Buffer.from(chunk)); });
      response.on('end', () => {
        // 整体拼好再按 UTF-8 解：一块一块 toString 会把跨块的中文字切成两半，变成乱码
        const data = Buffer.concat(chunks).toString('utf-8');
        const status = response.statusCode;
        if (status >= 400) { reject(new Error(httpErrorMessage(status, data))); return; }
        resolve(data);
      });
      response.on('error', reject);
    });

    // 连不上（服务没开、断网、代理不通）时给一句人话，原始错误附在括号里方便排查
    req.on('error', (err) => reject(new Error(`连不上翻译服务（${err?.message || err}）`)));
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export async function request(url: string, options: RequestOptions): Promise<any> {
  const data = await requestText(url, options);
  try {
    return JSON.parse(data);
  } catch {
    // 不把响应原文塞进报错：多半是代理或网关的 HTML 页，显示出来就是一堆乱码
    throw new Error('翻译服务返回的内容无法识别（可能是网络代理拦截了请求）');
  }
}

/// 出错时给人看的一句话：各家 JSON 报错里的 message（"Invalid API key" 这种很有用）；
/// 拿不到就只报状态码，绝不把 HTML 页面或二进制内容原样显示出来。
function httpErrorMessage(status: number, body: string): string {
  let detail = '';
  try {
    const j = JSON.parse(body);
    const m = j?.error?.message ?? j?.message ?? (typeof j?.error === 'string' ? j.error : '');
    if (typeof m === 'string') detail = m;
  } catch {}
  const hint = status === 401 || status === 403 ? '（API Key 无效或没有权限）'
    : status === 429 ? '（请求太频繁或额度用完）'
    : status >= 500 ? '（翻译服务暂时不可用）' : '';
  return `HTTP ${status}${hint}${detail ? `：${detail.slice(0, 120)}` : ''}`;
}
