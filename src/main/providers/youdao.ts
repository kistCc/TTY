import * as crypto from 'crypto';
import { ProviderConfig } from '../config';
import { requestText } from '../http';
import { mapBatchesConcurrent } from '../batch';

const DICT_URL = 'https://dict.youdao.com';
const TRANSLATE_URL = 'https://fanyi.youdao.com';

const CLIENT = 'fanyideskweb';
const PRODUCT = 'webfanyi';
const APP_VERSION = '1.0.0';
const VENDOR = 'web';
const POINT_PARAM = 'client,mysticTime,product';
const KEY_FROM = 'fanyi.web';
/// 取密钥这一步的签名用的固定 key，有道网页端写死在前端脚本里。
const KEY_GETTER_KEY = 'asdjnjfenknafdfsdfsd';

/// 网页接口按行保留原文换行结构，所以一批文本可以用换行拼成一次请求发出去，
/// 回来再按行拆开。行数对不上时退回逐条翻译，宁可慢也不能让整屏译文串位。
const BATCH_SIZE = 20;
/// 一次请求最多拼多少字符。整段翻译之后一条就是一整段，光按条数切会拼出超长请求。
const BATCH_MAX_CHARS = 1200;
const MAX_CONCURRENCY = 4;
/// 密钥有时效，缓存一段时间就重取；请求失败时也会立刻作废重来。
const KEY_TTL_MS = 10 * 60 * 1000;

// 有道网页翻译接受的语言代码
const YOUDAO_LANG_MAP: Record<string, string> = {
  'zh-CN': 'zh-CHS',
  'zh-TW': 'zh-CHT',
  'en': 'en',
  'ja': 'ja',
  'ko': 'ko',
  'fr': 'fr',
  'de': 'de',
  'es': 'es',
  'pt': 'pt',
  'it': 'it',
  'ru': 'ru',
  'ar': 'ar',
  'th': 'th',
  'nl': 'nl',
  'id': 'id',
  'vi': 'vi',
};

const headers: Record<string, string> = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
    '(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Referer': TRANSLATE_URL,
  'Cookie': 'OUTFOX_SEARCH_USER_ID=1796239350@10.110.96.157;',
};

interface YoudaoKey {
  secretKey: string;
  aesKey: string;
  aesIv: string;
}

let cachedKey: (YoudaoKey & { fetchedAt: number }) | null = null;

function md5Hex(text: string): string {
  return crypto.createHash('md5').update(text, 'utf-8').digest('hex');
}

function md5Bytes(text: string): Buffer {
  return crypto.createHash('md5').update(text, 'utf-8').digest();
}

function generateSign(timestamp: string, key: string): string {
  return md5Hex(`client=${CLIENT}&mysticTime=${timestamp}&product=${PRODUCT}&key=${key}`);
}

function generalParams(
  timestamp: string,
  keyid: string,
  sign: string
): Record<string, string> {
  return {
    client: CLIENT,
    product: PRODUCT,
    appVersion: APP_VERSION,
    vendor: VENDOR,
    pointParam: POINT_PARAM,
    keyfrom: KEY_FROM,
    keyid,
    sign,
    mysticTime: timestamp,
  };
}

async function fetchKey(): Promise<YoudaoKey> {
  const timestamp = String(Date.now());
  const params = new URLSearchParams(
    generalParams(timestamp, 'webfanyi-key-getter', generateSign(timestamp, KEY_GETTER_KEY))
  );

  const raw = await requestText(`${DICT_URL}/webtranslate/key?${params}`, {
    method: 'GET',
    headers,
  });

  let parsed: { code: number; msg?: string; data?: YoudaoKey };
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('有道密钥响应无法解析（可能是网络代理拦截了请求）');
  }
  if (parsed.code !== 0 || !parsed.data?.secretKey) {
    throw new Error(`有道密钥获取失败: code=${parsed.code} ${parsed.msg || ''}`);
  }
  return parsed.data;
}

async function getKey(): Promise<YoudaoKey> {
  const cached = cachedKey;
  if (cached && Date.now() - cached.fetchedAt < KEY_TTL_MS) return cached;
  const key = await fetchKey();
  cachedKey = { ...key, fetchedAt: Date.now() };
  return key;
}

/// 有道回的是 URL-safe base64 的 AES-128-CBC 密文，
/// 密钥和 IV 分别是 aesKey / aesIv 的 MD5 原始字节。
function decryptResponse(encrypted: string, aesKey: string, aesIv: string): string {
  const standardBase64 = encrypted.trim().replace(/-/g, '+').replace(/_/g, '/');
  const decipher = crypto.createDecipheriv('aes-128-cbc', md5Bytes(aesKey), md5Bytes(aesIv));
  return Buffer.concat([
    decipher.update(Buffer.from(standardBase64, 'base64')),
    decipher.final(),
  ]).toString('utf-8');
}

interface YoudaoTranslateResponse {
  code: number;
  type?: string;
  translateResult?: { src: string; tgt: string }[][];
}

interface TranslateOutcome {
  /// 译文（有道自己把换行留在 tgt 里，这里原样拼接）
  text: string;
  /// 接口回显的原文，用来核对合并批次有没有对错行
  src: string;
}

async function translateOne(text: string, targetLang: string): Promise<TranslateOutcome> {
  const key = await getKey();
  const timestamp = String(Date.now());

  const body = new URLSearchParams({
    ...generalParams(timestamp, 'webfanyi', generateSign(timestamp, key.secretKey)),
    i: text,
    from: 'auto',
    to: targetLang,
    dictResult: 'false',
  });

  const raw = await requestText(`${DICT_URL}/webtranslate`, {
    method: 'POST',
    headers: { ...headers, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  // 出错时有道回的是明文 JSON（{"code":50,...}）或网页，不是密文。拿去解密只会得到一串乱码，
  // 以前这串乱码还被原样塞进报错显示出来。先认出明文错误，解密失败也只报一句人话。
  const trimmed = raw.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('<')) {
    let code = '';
    try { code = String(JSON.parse(trimmed).code ?? ''); } catch {}
    cachedKey = null;
    throw new Error(`有道翻译接口返回错误${code ? `（code=${code}）` : ''}，请稍后再试`);
  }
  let response: YoudaoTranslateResponse;
  try {
    response = JSON.parse(decryptResponse(raw, key.aesKey, key.aesIv));
  } catch {
    cachedKey = null; // 多半是密钥过期，下次重新取
    throw new Error('有道翻译响应解密失败，请稍后再试');
  }
  if (response.code !== 0 || !response.translateResult) {
    throw new Error(`有道翻译失败: code=${response.code}`);
  }

  // translateResult 按句分组，组内再按片段切开。换行由有道自己留在 tgt 里，
  // 这里只管顺序拼接，不要再补分隔符，否则多行文本会多出空行。
  const flat = response.translateResult.flat();
  return {
    text: flat.map(item => item.tgt).join(''),
    src: flat.map(item => item.src).join(''),
  };
}

function normalize(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export async function translateWithYoudao(
  texts: string[],
  targetLang: string,
  _config: ProviderConfig
): Promise<string[]> {
  const to = YOUDAO_LANG_MAP[targetLang];
  if (!to) throw new Error(`有道翻译不支持的目标语言: ${targetLang}`);

  const batched = await mapBatchesConcurrent<string>(
    texts, BATCH_SIZE, MAX_CONCURRENCY,
    async (batch) => {
      if (batch.length === 1) return [(await translateOne(batch[0], to)).text];

      // 拼成一次请求前先把块内换行压平，否则一个块占多行，回来按行拆就对不上了。
      const sent = batch.map(text => text.replace(/\s*\n\s*/g, ' '));
      const outcome = await translateOne(sent.join('\n'), to);
      const lines = outcome.text.split('\n');
      const echoed = outcome.src.split('\n');

      // 只比行数不够：有道偶尔会把两行并成一句或把一句拆成两行，行数照样对得上，
      // 译文却整体错位一格。拿接口回显的原文逐行核对，对不上就别用这一批。
      const aligned =
        lines.length === batch.length &&
        echoed.length === batch.length &&
        echoed.every((line, i) => normalize(line) === normalize(sent[i]));
      if (aligned) return lines;

      console.warn(
        `[Youdao] 合并批次对不上（发出 ${batch.length} 行，回来 ${lines.length} 行/${echoed.length} 段原文），改为逐条翻译`
      );
      // 逐条重翻时一条失败不能把整批拖下水，否则那一批全部退回原文。
      const one: string[] = [];
      for (const text of batch) {
        try { one.push((await translateOne(text, to)).text); }
        catch (e) { console.error('[Youdao] 单条翻译失败:', e); one.push(''); }
      }
      return one;
    },
    (err, batch) => {
      // 密钥过期会让在途的请求一起失败，作废后下一批自然会重新取。
      cachedKey = null;
      console.error(`[Youdao] 翻译失败（${batch.length} 条）:`, err?.message || err);
    },
    BATCH_MAX_CHARS
  );

  return batched.flat();
}
