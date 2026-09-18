/// 把 OCR 切出来的片段接成一句话。
///
/// 象限重叠处同一行会被识别两次，两条文本首尾常常是重的
/// （"...usage credits. Credits" + "Credits never expire..."），直接拼会拼出
/// "信用使用信用" 这种车轱辘话；而有时两条是互补的左右半句，丢掉任何一条
/// 都会让送去翻译的原文缺一截。所以统一走这里：先找首尾重叠，接不上再按空格拼。
export function joinParts(parts: string[]): string {
  return parts.reduce((acc, part) => appendPart(acc, part.trim()), '');
}

export function appendPart(acc: string, part: string): string {
  if (!part) return acc;
  if (!acc) return part;
  if (acc.endsWith(part) || acc.includes(part)) return acc;
  // 反过来也要认：同一行里 OCR 有时既给整行、又给其中一小段。先拼进来的是
  // 小段、后来的是整行时，直接用整行替换，否则那一小段会在句子里重复出现，
  // 拼出"使彼得斯开始升级"这种没人看得懂的东西。
  if (part.includes(acc)) return part;

  const max = Math.min(acc.length, part.length);
  for (let n = max; n >= 4; n--) {
    if (acc.slice(-n) === part.slice(0, n)) return acc + part.slice(n);
  }

  if (/[A-Za-z]-$/.test(acc)) return acc.slice(0, -1) + part;
  const cjkTail = /[一-鿿぀-ヿ가-힯]$/.test(acc);
  const cjkHead = /^[一-鿿぀-ヿ가-힯]/.test(part);
  return acc + (cjkTail && cjkHead ? '' : ' ') + part;
}
