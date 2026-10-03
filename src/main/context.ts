/// 短标签带上下文翻译。
///
/// 单独一个词送去翻，翻译服务不知道它是名词还是动词、是哪个领域的词：
/// 版本号前面的 "release" 被翻成"释放"，数字前面的 "Stars" 被翻成"星星"。
/// 同一行紧挨着它右边如果有一个数值（版本号、计数），就把两个拼成 "release: v1.12.0" 一起送去翻，
/// 回来只取冒号前面的那部分当这个标签的译文。数值本身不翻、不擦，还是原来的像素。
/// （思路来自 SwiftyCrow 的 OverlayTranslationPolicy.trailingContext）

interface Box { x: number; y: number; width: number; height: number; text: string }

/// 标签：一行、不超过 40 个字符、不超过 4 个词，而且得有字母（纯数字、纯符号的不算）
function isCompactLabel(text: string): boolean {
  const t = text.trim();
  if (!t || t.includes('\n') || t.length > 40) return false;
  if (!/\p{L}{2,}/u.test(t)) return false;
  return t.split(/\s+/).length <= 4;
}

/// 数值：版本号（v1.12.0、2.3.4-beta）、计数（128、3.2k、1,024）这类不是话的短串
function isValue(text: string): boolean {
  const t = text.trim();
  if (!t || t.length > 16 || !/\d/.test(t)) return false;
  if (/^v?\d+(?:\.\d+)+(?:[-+][\w.]+)?$/i.test(t)) return true;
  const letters = (t.match(/\p{L}/gu) || []).length;
  return letters <= 1;
}

function sameRow(a: Box, b: Box): boolean {
  if (a.height <= 0 || b.height <= 0) return false;
  const overlap = Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  if (overlap / Math.min(a.height, b.height) >= 0.45) return true;
  return Math.abs((a.y + a.height / 2) - (b.y + b.height / 2)) <= Math.max(a.height, b.height) * 0.65;
}

/// 给每个要翻译的段找它的上下文数值；没有的是 null。
/// paragraphs：要翻译的段；all：这张图上认出来的所有块（数值多半没进要翻译的段，得从这里找）
export function trailingContexts(paragraphs: Box[], all: Box[]): (string | null)[] {
  const values = all.filter(b => isValue(b.text));
  return paragraphs.map(p => {
    if (!isCompactLabel(p.text)) return null;
    const row = values.filter(v => v !== p && sameRow(p, v));
    // 一行里只有一个数字可能就是普通的一句话；标签以冒号结尾、或者只有一个词，才算明确的"标签 + 数值"。
    // 同一行有两个以上数值（徽章、分段控件一排）也算
    const explicit = /[:：]$/.test(p.text.trim()) || p.text.trim().split(/\s+/).length === 1;
    if (row.length < 2 && !explicit) return null;
    const h = (v: Box) => Math.max(p.height, v.height);
    const near = row
      .map(v => ({ v, gap: v.x - (p.x + p.width) }))
      .filter(({ v, gap }) => gap >= -h(v) * 0.1 && gap <= h(v) * 2)
      .sort((a, b) => a.gap - b.gap)[0];
    return near ? near.v.text.trim() : null;
  });
}

/// 带上下文送去翻的文本："Stars" + "128" → "Stars: 128"。标签自己带冒号的不再加
export function withContext(label: string, value: string): string {
  return `${label.trim().replace(/[:：]$/, '')}: ${value}`;
}

/// 从带上下文的译文里取出标签部分："星标：128" → "星标"。没有冒号（服务把顺序改了、把冒号吃了）返回 null，
/// 调用方改用不带上下文的译文，不去猜标签在哪里结束
export function labelFrom(translated: string, label: string): string | null {
  const i = translated.search(/[:：]/);
  if (i <= 0) return null;
  const head = translated.slice(0, i).trim();
  if (!head) return null;
  // 原标签带冒号的，译文也带上
  const colon = /[:：]$/.test(label.trim()) ? (/[㐀-鿿]/.test(head) ? '：' : ':') : '';
  return head + colon;
}
