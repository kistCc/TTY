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
      let data = '';
      response.on('data', (chunk) => { data += chunk.toString(); });
      response.on('end', () => resolve(data));
      response.on('error', reject);
    });

    req.on('error', reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export async function request(url: string, options: RequestOptions): Promise<any> {
  const data = await requestText(url, options);
  try {
    return JSON.parse(data);
  } catch {
    throw new Error(`Invalid JSON response: ${data.slice(0, 200)}`);
  }
}
