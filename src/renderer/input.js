const cardEl = document.getElementById('card');
const routeEl = document.getElementById('route');
const textEl = document.getElementById('text');
const resultEl = document.getElementById('result');
const copyBtn = document.getElementById('copy');
const tipEl = document.getElementById('tip');
const targetEl = document.getElementById('target');

const I18N = {
  zh: {
    title: '输入翻译', auto: '自动识别', placeholder: '输入要翻译的文字…',
    keysHint: '回车翻译 · ⇧回车换行', autoHint: '中↔英 自动',
    pick: '翻成', autoOption: '自动（中↔英）', autoShort: '自动',
    translating: '翻译中', copy: '复制译文', copied: '已复制',
    close: '关闭', copyTip: '复制', failed: '翻译失败：',
  },
  en: {
    title: 'Type to Translate', auto: 'Auto', placeholder: 'Type text to translate…',
    keysHint: 'Return to translate · ⇧Return for new line', autoHint: 'auto direction',
    pick: 'To', autoOption: 'Auto (zh ↔ en)', autoShort: 'Auto',
    translating: 'Translating', copy: 'Copy', copied: 'Copied',
    close: 'close', copyTip: 'copy', failed: 'Failed: ',
  },
};

const LANG_NAME = {
  'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語',
  ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español',
};

/// 下拉里的语言，顺序和设置里「目标语言」一致
const TARGETS = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko', 'fr', 'de', 'es'];

let lang = 'zh';
let currentId = 0;
let currentTranslation = '';
/// 翻成哪种语言：'auto' 或语言代码（主进程记在配置里，下次打开还是它）
let chosen = 'auto';

function s(key) { return I18N[lang][key]; }
function langName(code) { return code === 'auto' ? s('auto') : (LANG_NAME[code] || code || ''); }

/// 内容变了就把实际高度报回主进程，让窗口贴着内容长。
function syncHeight() {
  requestAnimationFrame(() => window.input.reportHeight(cardEl.getBoundingClientRect().height + 24));
}

/// 输入框跟着内容长高（有上限，超过就滚动）
function autoGrow() {
  textEl.style.height = 'auto';
  textEl.style.height = Math.min(textEl.scrollHeight + 2, 160) + 'px';
  syncHeight();
}

function updateTip() {
  const keys = window.ttyKeys.get();
  const close = `${window.ttyKeys.pretty(keys.dismissKey)} ${s('close')}`;
  tipEl.textContent = currentTranslation ? `${window.ttyKeys.pretty(keys.copyTextKey)} ${s('copyTip')} · ${close}` : close;
}

/// 下拉的选项（界面语言可能变，每次打开都重建）
function buildTargets() {
  targetEl.innerHTML = '';
  for (const code of ['auto', ...TARGETS]) {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = code === 'auto' ? s('autoOption') : LANG_NAME[code];
    targetEl.appendChild(opt);
  }
  targetEl.value = chosen;
}

/// 右下角：自动时写「中↔英 自动」，选了语言写「→ 日本語」
function updateAutoHint() {
  document.getElementById('hintAuto').textContent = chosen === 'auto' ? s('autoHint') : `→ ${LANG_NAME[chosen]}`;
}

function requestTranslate() {
  if (textEl.value.trim()) window.input.translate(textEl.value, chosen);
}

function setCopyState(enabled, labelKey) {
  copyBtn.disabled = !enabled;
  copyBtn.textContent = s(labelKey);
}

function copyTranslation() {
  if (!currentTranslation) return;
  window.input.copy(currentTranslation);
  setCopyState(false, 'copied');
  setTimeout(() => { if (currentTranslation) setCopyState(true, 'copy'); }, 1200);
}

window.input.onShow((data) => {
  lang = data.lang === 'en' ? 'en' : 'zh';
  chosen = data.chosen || 'auto';
  currentId = 0;
  currentTranslation = '';
  document.getElementById('pickLabel').textContent = s('pick');
  buildTargets();
  routeEl.textContent = s('title');
  textEl.placeholder = s('placeholder');
  textEl.value = '';
  document.getElementById('hintKeys').textContent = s('keysHint');
  updateAutoHint();
  resultEl.className = '';
  resultEl.textContent = '';
  setCopyState(false, 'copy');
  updateTip();
  autoGrow();
  textEl.focus();
});

window.input.onPending((data) => {
  currentId = data.id;
  currentTranslation = '';
  routeEl.textContent = `${langName(data.source)} → ${langName(data.targetLang)}`;
  resultEl.className = 'show pending dots';
  resultEl.textContent = s('translating');
  setCopyState(false, 'copy');
  updateTip();
  syncHeight();
});

window.input.onResult((data) => {
  if (data.id !== currentId) return;
  if (data.error) {
    resultEl.className = 'show error';
    resultEl.textContent = s('failed') + data.error;
    setCopyState(false, 'copy');
  } else {
    currentTranslation = data.translated;
    resultEl.className = 'show';
    resultEl.textContent = data.translated;
    resultEl.scrollTop = 0;
    setCopyState(true, 'copy');
  }
  updateTip();
  syncHeight();
});

textEl.addEventListener('input', autoGrow);

// 输入法拼字期间让窗口降一层，候选框才不会被挡住（主进程 input.ts 里有说明）
textEl.addEventListener('compositionstart', () => window.input.setComposing(true));
textEl.addEventListener('compositionend', () => window.input.setComposing(false));

textEl.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  // 输入法还在选字时的回车是确认候选字，不是翻译
  if (e.isComposing || e.keyCode === 229) return;
  if (e.shiftKey) return; // ⇧回车换行，交给输入框自己处理
  e.preventDefault();
  requestTranslate();
});

// 换了语言：记住，输入框里有字就马上按新语言重翻；焦点回到输入框接着打字
targetEl.addEventListener('change', () => {
  chosen = targetEl.value;
  window.input.setTarget(chosen);
  updateAutoHint();
  requestTranslate();
  textEl.focus();
});

copyBtn.addEventListener('click', copyTranslation);
document.getElementById('close').addEventListener('click', () => window.input.close());

// 关闭：设置里的关闭键；复制译文：设置里的复制译文键
document.addEventListener('keydown', (e) => {
  const keys = window.ttyKeys.get();
  if (window.ttyKeys.match(e, keys.dismissKey)) { e.preventDefault(); window.input.close(); return; }
  // 输入框里选中了文字时，复制键照常复制选中的文字（默认 ⇧⌘C 不会和 ⌘C 冲突，但键可以改）
  if (window.ttyKeys.match(e, keys.copyTextKey) && currentTranslation) {
    const sel = textEl.selectionEnd - textEl.selectionStart;
    if (document.activeElement === textEl && sel > 0) return;
    e.preventDefault();
    copyTranslation();
  }
});

// 焦点边框
const syncFocus = () => cardEl.classList.toggle('focus', document.hasFocus());
window.addEventListener('focus', () => { syncFocus(); textEl.focus(); });
window.addEventListener('blur', syncFocus);
syncFocus();
