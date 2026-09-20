import { ProviderConfig } from '../config';
import { execSync } from 'child_process';
import { mapBatchesConcurrent } from '../batch';

const BATCH_SIZE = 20;
// Google 对单 IP 的免费接口有速率限制，4 路并发是实测下来既快又不触发 429 的档位。
const MAX_CONCURRENCY = 4;
/// 整段翻译之后一条就是一整段，20 段能有七八千字；Google 网页接口一次最多约 5000 字，
/// 超了整批失败。按字数再切一刀。
const BATCH_MAX_CHARS = 4500;
let proxyInitialized = false;

function getSystemProxy(): string | null {
  try {
    const output = execSync('scutil --proxy', { timeout: 3000 }).toString();
    const enabled = output.match(/HTTPSEnable\s*:\s*(\d)/);
    const host = output.match(/HTTPSProxy\s*:\s*(\S+)/);
    const port = output.match(/HTTPSPort\s*:\s*(\S+)/);
    if (enabled?.[1] === '1' && host && port) {
      return `http://${host[1]}:${port[1]}`;
    }
    // Fallback to HTTP proxy
    const hEnabled = output.match(/HTTPEnable\s*:\s*(\d)/);
    const hHost = output.match(/HTTPProxy\s*:\s*(\S+)/);
    const hPort = output.match(/HTTPPort\s*:\s*(\S+)/);
    if (hEnabled?.[1] === '1' && hHost && hPort) {
      return `http://${hHost[1]}:${hPort[1]}`;
    }
  } catch {}
  return null;
}

function ensureProxy() {
  if (proxyInitialized) return;
  proxyInitialized = true;

  let proxy = process.env.HTTPS_PROXY || process.env.HTTP_PROXY
            || process.env.https_proxy || process.env.http_proxy;

  if (!proxy) {
    const sysProxy = getSystemProxy();
    if (sysProxy) {
      proxy = sysProxy;
      console.log(`[Google] Using system proxy: ${proxy}`);
    }
  }

  if (!proxy) {
    console.log('[Google] No proxy found, using direct connection');
    return;
  }

  try {
    const { ProxyAgent, setGlobalDispatcher } = require('undici');
    setGlobalDispatcher(new ProxyAgent(proxy));
    console.log(`[Google] Proxy configured: ${proxy}`);
  } catch (err) {
    console.log('[Google] Failed to set proxy agent:', err);
  }
}

export async function translateWithGoogle(
  texts: string[],
  targetLang: string,
  _config: ProviderConfig
): Promise<string[]> {
  ensureProxy();
  const { default: translate } = await import('google-translate-api-x');

  const batched = await mapBatchesConcurrent<string>(
    texts, BATCH_SIZE, MAX_CONCURRENCY,
    async (batch) => {
      const res = await translate(batch, { to: targetLang } as any);
      const resAny = res as any;
      return Array.isArray(resAny) ? resAny.map((r: any) => r.text) : [resAny.text];
    },
    (err, batch) => {
      console.error(`[Google] Batch failed (${batch.length} texts):`, err?.message || err);
    },
    BATCH_MAX_CHARS
  );
  return batched.flat();
}
