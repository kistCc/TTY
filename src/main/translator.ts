import { Config } from './config';
import { translateWithOpenAI } from './providers/openai';
import { translateWithClaude } from './providers/claude';
import { translateWithDeepL } from './providers/deepl';
import { translateWithOllama } from './providers/ollama';
import { translateWithGoogle } from './providers/google';
import { translateWithYoudao } from './providers/youdao';
import { translateWithApple } from './providers/apple';
import { InkRun, InkSpan, MarkerStyle, wrapRuns, unwrapRuns } from './ink';
import { debugLog } from './native';
import { uiTerm, BRAND_WORDS } from './glossary';

/// 产品名被硬翻出来最难看：Claude 成了"克劳德"、Claude Code 成了"克劳德代码"。
/// 整块文本就是一个产品名时直接原样留着，连请求都不用发。
/// 只认这张表里的名字——除了公司和产品名，其余英文一律要翻。
const KEEP_AS_IS = new Set([
  'claude', 'claude code', 'cowork', 'anthropic', 'chatgpt', 'openai', 'gemini',
  'github', 'gitlab', 'notion', 'slack', 'figma', 'xcode', 'vs code', 'visual studio code',
  'safari', 'chrome', 'firefox', 'finder', 'spotlight', 'siri',
  'macos', 'ios', 'ipados', 'windows', 'linux', 'android',
  'python', 'javascript', 'typescript', 'node.js', 'npm', 'json', 'html', 'css',
  'deepl', 'ollama', 'google', 'youdao', 'tty', 'wi-fi', 'wifi', 'bluetooth',
  'api', 'sdk', 'cli', 'ip', 'ipv4', 'ipv6', 'url', 'dns', 'vpn', 'http', 'https', 'ssl', 'tls', 'csv', 'pdf', 'asn',
]);

/// 品牌表里单独出现时意思两可的（Go 按钮、Zoom 缩放、Spring 春季…），整段出现时照常翻、全大写时也不遮
const AMBIGUOUS_ALONE_LIST = ['go', 'spring', 'express', 'spark', 'linear', 'unity', 'travis', 'rails', 'meta', 'zoom', 'swift', 'bun', 'node', 'remix', 'astro', 'apple', 'amazon', 'steam', 'julia', 'dart', 'parcel', 'wine'];
const AMBIGUOUS_ALONE = new Set(AMBIGUOUS_ALONE_LIST);
const KEEP_BRANDS = new Set(BRAND_WORDS.map(w => w.toLowerCase()).filter(w => !AMBIGUOUS_ALONE.has(w)));

function keepAsIs(text: string): boolean {
  const t = text.trim().replace(/[.:,;!?]+$/, '');
  if (!t) return true;
  return KEEP_AS_IS.has(t.toLowerCase()) || KEEP_BRANDS.has(t.toLowerCase());
}


/// 句内的产品名换成 XQZ0 这种占位符再发。实测有道会把 ⟦0⟧、{0}、[0]、<0> 这类
/// 括号占位符删掉或改掉（"Claude" 就此消失、被译成"你"），而字母+数字的生造词
/// 它会当专有名词原样带回来。
const BRAND_PATTERNS = [
  /\bClaude Code\b/g, /\bClaude\b/g, /\bChatGPT\b/g, /\bAnthropic\b/g, /\bOpenAI\b/g,
  /\bGitHub\b/g, /\bmacOS\b/g, /\biOS\b/g, /\bTTY\b/g, /\bCowork\b/g,
  // 技术缩写：有道会把 API 译成"应用程序编程接口"、句首单独的 IP 译成"知识产权"
  /\b(?:APIs?|SDKs?|CLI|IPv[46]|IP|URLs?|DNS|VPNs?|HTTPS?|SSL|TLS|JSON|CSV|PDF|ASN|CPU|GPU|RAM|SSD|USB|OCR)\b/g,
  // 大小写混写的专名：IPinfo、JavaScript、iPhone、YouTube
  /\b(?:[A-Z]{2,}[a-z]{2,}\w*|[A-Z][a-z]+[A-Z][a-z]+\w*|[a-z][A-Z][a-z]{2,}\w*)\b/g,
  // 句子里夹着的文件名："运行.command"、"README.md"
  /[\p{L}\p{N}_-]+(?:\.[\p{L}\p{N}_-]+)*\.(?:command|sh|zsh|js|ts|jsx|tsx|py|rb|rs|go|java|kt|php|swift|json|toml|ya?ml|xml|ini|conf|cfg|md|txt|log|dmg|zip|gz|tgz|app|png|jpe?g|pdf|html?|css|docx?|xlsx?|pptx?)\b/gu,
  // 句子里夹着的路径、域名、命令行选项、下划线名字、带括号的调用：
  // "/etc/hosts"、"docs/current/"、"Wikipedia.org/wiki/Hosts"、"--app"、"hello_world"、"route()"
  /(?<![\w/])(?:~|\.{1,2})?\/(?:[\w.-]+\/)+[\w.-]*/g,
  /\b[\w-]+\/(?:[\w.-]+\/)+[\w.-]*/g,
  /(?<![\w-])--?[a-z][\w-]+(?:=\S+)?/g,
  /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g,
  /\b[A-Za-z_][\w.]*\(\)/g,
  // 句子里夹着的地址、网址、邮箱、IP
  /\b(?:https?:\/\/|www\.)\S+[\w/]/g,
  /\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b/g,
  /\b\d{1,3}(?:\.\d{1,3}){3}\b/g,
  /\b[0-9a-f]{1,4}(?::[0-9a-f]{0,4}){2,7}\b/gi,
  // 句中首字母大写的产品名（Rust、React、Docker…）：前面紧挨着一个小写词，说明是普通句子里
  // 专门大写的名字；标题式大写（每个词都大写）前面是大写词，不遮，免得把标题里的普通词当品牌
  new RegExp(`(?<=\\b[a-z][a-z'’-]*[,;:]?\\s)(?:${BRAND_WORDS.map(w => w.replace(/\./g, '\\.')).join('|')})\\b`, 'g'),
  // 全大写标题里的产品名（“LEARN REACT”“JQUERY”）；单独出现意思两可的（GO、SPRING…）不遮
  new RegExp(`\\b(?:${BRAND_WORDS.filter(w => !AMBIGUOUS_ALONE_LIST.includes(w.toLowerCase())).map(w => w.toUpperCase().replace(/\./g, '\\.')).join('|')})\\b`, 'g'),
  // 标题里 "Using X"、"Chapter 6. X" 后面的产品名（Using Vite、Chapter 13. WINE）：
  // 这种位置几乎只会是工具名，连单独出现意思两可的（Parcel、Wine）也遮
  new RegExp(`(?<=\\b(?:Using|Chapter \\d+\\.)\\s)(?:${BRAND_WORDS.flatMap(w => [w, w.toUpperCase()]).map(w => w.replace(/\./g, '\\.')).join('|')})\\b`, 'g'),
  // arXiv 学科代码：cs.CL、stat.ML、astro-ph.GA（有道会把 CV 译成"简历"、吃掉 "(cs."）
  /\b(?:cs|math|stat|eess|econ|q-bio|q-fin|astro-ph|cond-mat|hep-[a-z]+|nucl-[a-z]+|physics|quant-ph|nlin|gr-qc|math-ph)\.[A-Z]{2}\b/g,
  // 末尾大写的产品名：IntelliJ
  /\b[A-Z][a-z]+[A-Z]\b/g,
  // 句子里夹着的命令："with bun install"、"run npm run dev"、"then cargo build --release"
  /\b(?:bun|bunx|npm|npx|pnpm|yarn|deno|cargo|pip3?|brew|git|docker|kubectl|conda|uv|poetry|gem|bundle|composer|php artisan|mix|dotnet|rustup|flutter|swift|terraform|helm)\s+(?:(?:run|exec|x)(?:\s+[a-z][\w:-]*)?|init|install|i|test|build|create|add|remove|rm|dev|start|serve|deploy|upgrade|update|publish|new|generate|login|link|pull|push|compile|fmt|lint|check|doctor|clone|commit|apply|plan|get|mod|tidy)\b(?:\s+(?:--?[\w-]+|[\w@./:-]*[./@:-][\w@./:-]*|[a-z][\w-]*(?=\s*(?:$|[→›,;.)]))))*/g,
  // 交易代码：BTC-USD、EUR-USD
  /\b[A-Z]{2,5}-(?:USD|EUR|GBP|JPY|CNY|USDT|BTC|ETH)\b/g,
];

/// 先遮整条的网址、域名（带路径），免得里面的一截被别的规则先遮走："Wikipedia.org/wiki/Hosts_(file)"
const LINK_PATTERNS = [
  /\b(?:https?:\/\/|www\.)\S+[\w/]/g,
  /\b[\w-]+(?:\.[\w-]+)*\.(?:org|com|net|io|dev|rs|edu|gov|app)(?:\/[^\s),;]*)?(?=[\s),;:!?]|$)/g,
];

/// 这一页上的专名：首字母大写的词（或两个连着的大写词），在句子中间（紧跟一个小写词后面）出现了两次以上。
/// 普通英文单词只有在句首才大写，句中还大写的多半是产品、公司、项目名（"using Svelte's"、"with Kotlin"），
/// 而这类名字很多本身就是普通单词（Svelte、Signal、Obsidian、Telegram），查词典分不出来，只能看它在这一页怎么用。
/// 月份、星期、语言名、界面词（句中的 "click Save"）不算。
const NOT_BRAND = new Set(['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october',
  'november', 'december', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday',
  'english', 'french', 'german', 'spanish', 'chinese', 'japanese', 'korean', 'russian', 'italian', 'portuguese', 'arabic',
  'internet', 'web', 'the', 'this', 'that', 'these', 'those', 'you', 'your', 'our', 'we', 'it', 'if', 'when', 'for', 'and',
  // 疑问词、句首常见词；界面、文档里常被首字母大写的普通词（"our Cookie Policy"、"Open Source"、"see Section 3"）
  'what', 'who', 'where', 'why', 'how', 'which', 'there', 'here', 'each', 'every', 'all', 'some', 'many', 'most', 'one',
  'cookie', 'cookies', 'policy', 'privacy', 'terms', 'open', 'source', 'developer', 'developers', 'level', 'pattern',
  'recognition', 'section', 'chapter', 'page', 'table', 'figure', 'step', 'part', 'note', 'warning', 'tip', 'example',
  'learn', 'read', 'more', 'see', 'get', 'start', 'next', 'previous', 'new', 'free', 'pro', 'plus', 'premium', 'team',
  'teams', 'account', 'settings', 'home', 'news', 'world', 'business', 'science', 'education', 'health', 'sports']);
const CLI_SUB = '(?:init|install|i|run|test|build|create|add|remove|rm|dev|start|serve|deploy|upgrade|update|publish|exec|x|new|generate|login|link|pull|push|compile|fmt|lint|check|doctor)';
function pageBrands(texts: string[]): string[] {
  const count = new Map<string, number>();
  const lower = new Map<string, number>();
  // 只看英文句子：德文名词本来就大写，法文、西文也有自己的大写习惯
  const english = (t: string) => /\b(?:the|and|of|to|is|are|with|for|your|you|this|that)\b/.test(t);
  // 整页是不是英文：四个词以上的段里，至少三成带英文虚词。德文页名词本来就大写，不能按这个规则找专名
  const longOnes = texts.filter(t => t.trim().split(/\s+/).length >= 4);
  if (!longOnes.length || longOnes.filter(english).length < longOnes.length * 0.3) return [];
  for (const raw of texts) {
    const t = raw.replace(/<\/?c\d+>/g, '');
    // 网址、路径、文件名里的小写（signal.org、/opt/homebrew）不算
    // 命令里的小写（"bun install"、"deno run"）也不算
    const noCmd = t.replace(new RegExp(`\\b[a-z][\\w-]*\\s+${CLI_SUB}\\b`, 'g'), ' ');
    for (const w of noCmd.match(/(?<![\w./@-])[a-z]{3,}(?![\w./@-])/g) || []) lower.set(w, (lower.get(w) || 0) + 1);
    for (const m of t.matchAll(/(?<=\b[a-z][a-z'’-]*[,;:]?\s)([A-Z][a-z]{2,}(?:\s[A-Z][a-z]{2,})?)(?=['’]s\b|\b)/g)) {
      const words = m[1].split(' ');
      // 两个词的整体算一次，第一个词单独也算一次（"Grafana Cloud" 和 "Grafana"）
      for (const cand of words.length > 1 ? [m[1], words[0]] : [m[1]]) {
        if (cand.split(' ').some(w => NOT_BRAND.has(w.toLowerCase()) || uiTerm(w, 'zh-CN'))) continue;
        // 普通名词的词尾（Troubleshooting、Application、Directives、Management）：产品名几乎不这样结尾
        if (!cand.includes(' ') && /(?:ing|tions?|ments?|ness|ity|ives|ances?|ences?)$/.test(cand)) continue;
        count.set(cand, (count.get(cand) || 0) + 1);
      }
    }
  }
  // 第二种：这个词在这一页上当句子主语介绍自己（"Bun is an all-in-one…"、"Tailwind CSS works by…"、"Proton Mail lets you…"），
  // 大写出现 3 次以上、一次小写都没有（命令里的 bun 不算）。普通词（Get、Cookie、Project）几乎不会这样用
  const caps = new Map<string, number>();
  const subject = new Set<string>();
  const VERB = '(?:is|are|was|has|have|lets|provides|makes|can|will|uses|runs|supports|works|helps|allows|offers|gives|includes|brings|enables|keeps|protects)';
  for (const raw of texts) {
    const t = raw.replace(/<\/?c\d+>/g, '');
    for (const w of t.match(/(?<![\w./@-])[A-Z][a-z]{2,}(?![\w@-])/g) || []) caps.set(w, (caps.get(w) || 0) + 1);
    for (const m of t.matchAll(new RegExp(`\\b([A-Z][a-z]{2,})(?:\\s[A-Z][A-Za-z]+)?(?:['’]s)?\\s${VERB}\\b`, 'g'))) subject.add(m[1]);
  }
  for (const w of subject) {
    if ((count.get(w) || 0) >= 2 || (caps.get(w) || 0) < 3 || (lower.get(w.toLowerCase()) || 0) > 0) continue;
    if (NOT_BRAND.has(w.toLowerCase()) || uiTerm(w, 'zh-CN') || /(?:ing|tions?|ments?|ness|ity|ives|ances?|ences?|s)$/.test(w)) continue;
    count.set(w, 2);
  }
  // 第三种：单独成段出现过（导航里的 "Thunderbird"、"Proton Mail"），大写 4 次以上、一次小写都没有，
  // 而且至少有一次在句子中间（"with Proton Mail"、"for Thunderbird 140"）
  const alone = new Set(texts.map(t => t.replace(/<\/?c\d+>/g, '').trim().replace(/[.:!?]+$/, ''))
    .flatMap(t => { const m = t.match(/^([A-Z][a-z]{2,})(?:\s[A-Z][a-z]+)?$/); return m ? [m[1]] : []; }));
  for (const w of alone) {
    if ((count.get(w) || 0) >= 2 || (count.get(w) || 0) < 1 || (caps.get(w) || 0) < 4 || (lower.get(w.toLowerCase()) || 0) > 0) continue;
    if (NOT_BRAND.has(w.toLowerCase()) || uiTerm(w, 'zh-CN') || /(?:ing|tions?|ments?|ness|ity|ives|ances?|ences?|s)$/.test(w)) continue;
    count.set(w, 2);
  }
  // 这一页上也常小写出现的是普通词做了标题（"see Troubleshooting"、"Application"），不算
  return [...count.entries()]
    .filter(([w, n]) => n >= 2 && (w.includes(' ') || (lower.get(w.toLowerCase()) || 0) * 2 < n))
    .map(([w]) => w).sort((a, b) => b.length - a.length);
}

/// 目标语言用的文字：外文句子里夹着这种字时要遮起来（见 maskTargetScript）
const TARGET_SCRIPT: Record<string, RegExp> = {
  zh: /[\u3400-\u4dbf\u4e00-\u9fff]/g,
  ja: /[\u3040-\u30ff\u3400-\u4dbf\u4e00-\u9fff]/g,
  ko: /[\uac00-\ud7af]/g,
};

/// Google 按"整句是什么语言"决定翻不翻：英文句子里夹着中文（文件路径、中文名词），
/// 它会把整句判成中文，目标又是中文，就原样返回。实测直接指定"源语言=英文"能翻出来，
/// 但会顺手把夹着的中文也改掉（"改动记录"变"记录记录"、"历史"变"history"）。
/// 所以主体是外文的段落里，把带目标文字的词整个换成占位符：Google 看到的是纯外文，
/// 语言判得对，翻完再原样换回去，中文一个字都不动。
/// 按空格切出"词"，整个词一起遮（"历史/TTY-1.4.0_快捷键修改前.dmg" 只遮汉字会被拆乱）；
/// 词两头的标点、颜色标签留在外面。
function maskTargetScript(text: string, targetLang: string, held: string[]): string {
  const script = TARGET_SCRIPT[targetLang.split('-')[0]];
  if (!script) return text;
  const plain = text.replace(/<\/?c\d+>/g, ' ');
  // 日文、韩文不按空格分词，整句会被当成一个"带汉字的词"整个遮住、原样退回
  if (targetLang.startsWith('zh') && /[\u3040-\u30ff\uac00-\ud7af]/.test(plain)) return text;
  const own = (plain.match(script) || []).length;
  const latin = (plain.match(/[A-Za-z]/g) || []).length;
  if (!own || latin <= own) return text;
  const single = new RegExp(script.source);
  return text.replace(/[^\s<>]+/g, (word) => {
    if (!single.test(word)) return word;
    const m = word.match(/^([("'“‘\[（「『]*)(.*?)([.,;:!?)"'”’\]，。、；：！？）」』]*)$/)!;
    if (!m[2]) return word;
    held.push(m[2]);
    return `${m[1]}XQZ${held.length - 1}${m[3]}`;
  });
}

function maskBrands(text: string, targetLang: string, provider: string, extra: RegExp[] = []): { text: string; brands: string[] } {
  const brands: string[] = [];
  // 先遮夹着的中文，再遮产品名：产品名的正则不会碰到占位符，换回来一遍就够
  // 有道也会把英文句子里夹的中文换成它自己的占位符 <e:1> 再也不换回来（"Terminal 概览"→"终端<e:1>"），一样先遮起来
  let masked = provider === 'google' || provider === 'youdao' || provider === 'apple' ? maskTargetScript(text, targetLang, brands) : text;
  for (const re of [...LINK_PATTERNS, ...extra, ...BRAND_PATTERNS]) {
    masked = masked.replace(re, (hit) => {
      brands.push(hit);
      return `XQZ${brands.length - 1}`;
    });
  }
  return { text: masked, brands };
}

function unmaskBrands(text: string, brands: string[]): string {
  if (!brands.length) return text;
  return text.replace(/XQZ(\d+)/gi, (whole, n) => brands[Number(n)] ?? whole);
}

export async function translate(
  texts: string[],
  targetLang: string,
  config: Config
): Promise<string[]> {
  if (texts.length === 0) return [];

  // 带 " | "、" · "、" • " 分隔的一行（"408 points by x 8 hours ago | hide | 154 comments"、"About | Help"）：
  // 有道会把第一个分隔符前面的整段丢掉，只剩"|隐藏| 154条评论"。按分隔符切开、一段一段翻，再用原来的分隔符接回去。
  // 颜色标签跨过分隔符的不切；任何一段没翻出来，整条就算没翻出来（保留原文，不画半截）
  const SEP = /(\s+[|·•]\s+)/;
  const balanced = (seg: string) => (seg.match(/<c\d+>/g) || []).length === (seg.match(/<\/c\d+>/g) || []).length;
  // 短标题里的破折号（"TimescaleDB Course – PostgreSQL for Time-Series Data"）有道也会丢前半句；长句里的破折号是插入语，不切
  // 只切标题样的：不以句号收尾、破折号后面大写或数字开头；OCR 常把 – 认成 -，带空格的 " - " 也算
  const DASH = /(\s+[–—-]\s+(?=[\p{Lu}\d]))/u;
  const titleLike = (t: string) => t.split(/\s+/).length <= 12 && !/[.!?。]\s*$/.test(t.replace(/<\/?c\d+>/g, ''));
  const pieces = texts.map(t => {
    const p = t.split(SEP.test(t) ? SEP : titleLike(t) ? DASH : SEP);
    return p.length > 1 && p.every((seg, i) => i % 2 === 1 || (seg.trim() && balanced(seg))) ? p : null;
  });
  if (pieces.some(Boolean)) {
    const flat: string[] = [];
    pieces.forEach((p, i) => { if (p) p.forEach((seg, j) => { if (j % 2 === 0) flat.push(seg); }); else flat.push(texts[i]); });
    const tr = await translate(flat, targetLang, config);
    let k = 0;
    return pieces.map((p, i) => {
      if (!p) return tr[k++] ?? '';
      const segs = p.map((seg, j) => (j % 2 === 0 ? tr[k++] ?? '' : seg));
      return segs.some((seg, j) => j % 2 === 0 && !seg) ? '' : segs.join('');
    });
  }

  // 一屏里重复的文本很多——同名按钮、重复的标签、多处出现的菜单项。只把去重后的
  // 集合发出去，回来再按原顺序摊开，通常能省掉两三成的请求量。
  const unique: string[] = [];
  const seen = new Set<string>();
  for (const text of texts) {
    if (!seen.has(text)) { seen.add(text); unique.push(text); }
  }
  if (unique.length < texts.length) {
    console.log(`[translate] 去重：${texts.length} → ${unique.length} 条`);
  }

  // 整段正好是界面词（Light、Fork、License…）的用固定译法，不交给引擎
  const glossed = new Map<string, string>();
  for (const text of unique) {
    const g = uiTerm(text.replace(/<\/?c\d+>/g, ''), targetLang);
    if (g) glossed.set(text, g);
  }
  // 产品名这类不用翻的挑出去，剩下的才发出去
  // 这一页自己的专名（见 pageBrands）：整段就是它的不翻，句子里的遮起来
  const brandsHere = pageBrands(unique);
  if (brandsHere.length) debugLog(`本页专名：${brandsHere.join('、')}`);
  const brandSet = new Set(brandsHere.map(w => w.toLowerCase()));
  const brandRes = brandsHere.map(w => new RegExp(`\\b${w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g'));
  const needTranslate = unique.filter(text => !keepAsIs(text) && !glossed.has(text)
    && !brandSet.has(text.replace(/<\/?c\d+>/g, '').trim().replace(/[.:,;!?]+$/, '').toLowerCase()));
  // 句子里夹着的产品名（"the summer Claude Code promo…"）换成占位符再发，
  // 翻译服务照抄不动，回来按原样还回去，就不会有"克劳德代码"了。
  const masked = needTranslate.map(t => maskBrands(t, targetLang, config.provider, brandRes));
  const translatedList = needTranslate.length
    ? await translateUnique(masked.map(m => m.text), targetLang, config)
    : [];
  // 哪家翻译服务都可能把占位符弄丢（改写、删掉、翻成别的），丢了产品名就跟着消失。
  // 丢了的那几条不带占位符原样重翻一次：产品名可能被音译，但至少不会凭空没了。
  const lost = needTranslate.map((_, i) => i).filter(i =>
    translatedList[i] && masked[i].brands.some((_, k) => !new RegExp(`XQZ${k}(?!\\d)`, 'i').test(translatedList[i])));
  if (lost.length) {
    const retried = await translateUnique(lost.map(i => needTranslate[i]), targetLang, config).catch(() => []);
    lost.forEach((i, j) => { if (retried[j]) { translatedList[i] = retried[j]; masked[i].brands = []; } });
  }
  const resultOf = new Map<string, string>();
  needTranslate.forEach((text, i) => {
    // 没拿到译文（服务少返回了几条、那一批失败）就是空串，调用方会保留原文，不会拿原文冒充译文
    resultOf.set(text, unmaskBrands(translatedList[i] ?? '', masked[i].brands));
  });

  return texts.map(text => glossed.get(text) ?? resultOf.get(text) ?? text);
}

/// 各家翻译服务用哪种颜色标记。
/// 实测（8 句带色段的英文 → 中文）：Google 用 XML 标签 12/12 原样带回、位置都对，
/// 字母数字标记虽然也回来了，但会把句子翻怪（"单击此处的 QXA1 QXB1"）。
const MARKER_STYLE: Record<string, MarkerStyle> = {
  openai: 'xml', claude: 'xml', ollama: 'xml', deepl: 'xml',
  google: 'xml', youdao: 'alnum',
};

/// 保持颜色要靠翻译服务把标记原样带回来。实测带不回来的服务在这里关掉，
/// 那时浮层按以前的办法画黑白字（按底色深浅选黑或白），不会只画一半颜色。
/// 有道：两种标记都试过，丢标记、挪位置，还会连累译文本身（"Archer-SQ" 被吞掉、
/// 仓库名被硬翻成"屏幕翻译器"），所以有道不开颜色。
const INK_UNSUPPORTED = new Set<string>(['youdao']);

export function inkSupported(provider: string): boolean {
  return !!MARKER_STYLE[provider] && !INK_UNSUPPORTED.has(provider);
}

/// 带颜色的翻译：段落里和主色不同的色段先用标记包起来再送去翻译，
/// 回来按标记找出色段在译文里的位置。标记丢了的色段不上色，译文本身不受影响。
export async function translateWithInk(
  items: { text: string; runs?: InkRun[] }[],
  targetLang: string,
  config: Config,
  inkOn: boolean
): Promise<{ text: string; spans: InkSpan[] }[]> {
  const style = MARKER_STYLE[config.provider];
  if (!inkOn || !style) {
    const out = await translate(items.map(i => i.text), targetLang, config);
    return out.map(text => ({ text, spans: [] }));
  }
  const wrapped = items.map(i => wrapRuns(i.text, i.runs, style));
  const out = await translate(wrapped.map(w => w.text), targetLang, config);
  return out.map((translated, i) => {
    if (!translated) return { text: '', spans: [] };
    const { text, spans, kept } = unwrapRuns(translated, wrapped[i].marks, style);
    if (kept < wrapped[i].marks.length) {
      debugLog(`  颜色标记 ${wrapped[i].marks.length} 个只回来 ${kept} 个：${translated}`);
    }
    return { text, spans };
  });
}

async function translateUnique(
  texts: string[],
  targetLang: string,
  config: Config
): Promise<string[]> {
  const provider = config.provider;
  const providerConfig = config.providers[provider] || {};

  switch (provider) {
    case 'google':
      return translateWithGoogle(texts, targetLang, providerConfig);
    case 'youdao':
      return translateWithYoudao(texts, targetLang, providerConfig);
    case 'apple':
      return translateWithApple(texts, targetLang, providerConfig);
    case 'openai':
      return translateWithOpenAI(texts, targetLang, providerConfig);
    case 'claude':
      return translateWithClaude(texts, targetLang, providerConfig);
    case 'deepl':
      return translateWithDeepL(texts, targetLang, providerConfig);
    case 'ollama':
      return translateWithOllama(texts, targetLang, providerConfig);
    default:
      throw new Error(`Unsupported provider: ${provider}`);
  }
}
