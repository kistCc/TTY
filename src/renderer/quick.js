const routeEl = document.getElementById('route');
const sourceEl = document.getElementById('source');
const resultEl = document.getElementById('result');
const copyBtn = document.getElementById('copy');
const tipEl = document.getElementById('tip');
const cardEl = document.getElementById('card');
const axhintEl = document.getElementById('axhint');
const axtextEl = document.getElementById('axtext');
const axopenEl = document.getElementById('axopen');

const I18N = {
  zh: {
    translating: '翻译中', copy: '复制译文', copied: '已复制',
    emptySelection: '没有选中文本', emptyClipboard: '剪贴板是空的',
    tip: '⎋ 关闭', failed: '翻译失败：',
    fromClipboard: '剪贴板', fromSelection: '划词',
    axHint: '划词取词被系统挡住了，需要在「隐私与安全性」里给 TTY 授权', axOpen: '去开启',
  },
  en: {
    translating: 'Translating', copy: 'Copy', copied: 'Copied',
    emptySelection: 'Nothing selected', emptyClipboard: 'Clipboard is empty',
    tip: '⎋ to close', failed: 'Failed: ',
    fromClipboard: 'clipboard', fromSelection: 'selection',
    axHint: 'Selection capture is blocked — grant TTY permission in Privacy & Security', axOpen: 'Open Settings',
  },
};

const LANG_NAME = {
  'zh-CN': '简体中文', 'zh-TW': '繁體中文', en: 'English', ja: '日本語',
  ko: '한국어', fr: 'Français', de: 'Deutsch', es: 'Español',
};

let lang = 'zh';
let currentId = 0;
let currentTranslation = '';

function s(key) { return I18N[lang][key]; }

/// 内容变了就把实际高度报回主进程，让窗口贴着内容长。
function syncHeight() {
  requestAnimationFrame(() => {
    // 加上 body 上下的阴影余量，窗口才刚好包住卡片
    window.quick.reportHeight(cardEl.getBoundingClientRect().height + 24);
  });
}

function setCopyState(enabled, labelKey) {
  copyBtn.disabled = !enabled;
  copyBtn.textContent = s(labelKey);
}

window.quick.onShow((data) => {
  currentId = data.id;
  currentTranslation = '';
  lang = data.lang === 'en' ? 'en' : 'zh';
  tipEl.textContent = s('tip');

  axhintEl.classList.toggle('show', !!data.needsAX);
  if (data.needsAX) {
    axtextEl.textContent = s('axHint');
    axopenEl.textContent = s('axOpen');
  }

  if (data.empty) {
    routeEl.textContent = data.from === 'clipboard' ? s('fromClipboard') : s('fromSelection');
    sourceEl.style.display = 'none';
    resultEl.className = 'pending';
    resultEl.textContent = s(data.from === 'clipboard' ? 'emptyClipboard' : 'emptySelection');
    setCopyState(false, 'copy');
    syncHeight();
    return;
  }

  sourceEl.style.display = '';
  sourceEl.textContent = data.text;
  sourceEl.scrollTop = 0;
  // 只在回落到剪贴板时标注来源——取到选区是常态，不必每次都说
  // 两条通道各有快捷键，标一下这次翻的是哪来的文本
  const route = LANG_NAME[data.targetLang] || data.targetLang || '';
  const src = data.from === 'clipboard' ? s('fromClipboard') : s('fromSelection');
  routeEl.textContent = `${route} · ${src}`;
  resultEl.className = 'pending dots';
  resultEl.textContent = s('translating');
  setCopyState(false, 'copy');
  syncHeight();
});

window.quick.onResult((data) => {
  if (data.id !== currentId) return;

  if (data.error) {
    resultEl.className = 'error';
    resultEl.textContent = s('failed') + data.error;
    setCopyState(false, 'copy');
  } else {
    currentTranslation = data.translated;
    resultEl.className = '';
    resultEl.textContent = data.translated;
    resultEl.scrollTop = 0;
    setCopyState(true, 'copy');
  }
  syncHeight();
});

copyBtn.addEventListener('click', () => {
  if (!currentTranslation) return;
  window.quick.copy(currentTranslation);
  setCopyState(false, 'copied');
  setTimeout(() => { if (currentTranslation) setCopyState(true, 'copy'); }, 1200);
});

axopenEl.addEventListener('click', () => window.quick.openAccessibility());

document.getElementById('close').addEventListener('click', () => window.quick.close());

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); window.quick.close(); }
  // ⌘C 在没选中任何文字时直接复制译文，省一次点击
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'c') {
    if (!window.getSelection().toString() && currentTranslation) {
      e.preventDefault();
      window.quick.copy(currentTranslation);
      setCopyState(false, 'copied');
      setTimeout(() => { if (currentTranslation) setCopyState(true, 'copy'); }, 1200);
    }
  }
});
