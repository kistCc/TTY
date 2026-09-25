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
    emptySelection: '没有选中文本',
    tip: '关闭', failed: '翻译失败：',
    fromSelection: '划词',
    axHint: '划词取词被系统挡住了，需要在「隐私与安全性」里给 TTY 授权', axOpen: '去开启',
  },
  en: {
    translating: 'Translating', copy: 'Copy', copied: 'Copied',
    emptySelection: 'Nothing selected',
    tip: 'to close', failed: 'Failed: ',
    fromSelection: 'selection',
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
  // 提示里写的是设置里的关闭键
  tipEl.textContent = `${window.ttyKeys.pretty(window.ttyKeys.get().dismissKey)} ${s('tip')}`;

  axhintEl.classList.toggle('show', !!data.needsAX);
  if (data.needsAX) {
    axtextEl.textContent = s('axHint');
    axopenEl.textContent = s('axOpen');
  }

  if (data.empty) {
    routeEl.textContent = s('fromSelection');
    sourceEl.style.display = 'none';
    resultEl.className = 'pending';
    resultEl.textContent = s('emptySelection');
    setCopyState(false, 'copy');
    syncHeight();
    return;
  }

  sourceEl.style.display = '';
  sourceEl.textContent = data.text;
  sourceEl.scrollTop = 0;
  const route = LANG_NAME[data.targetLang] || data.targetLang || '';
  routeEl.textContent = `${route} · ${s('fromSelection')}`;
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

// 关闭：设置里的关闭键；复制译文：设置里的复制译文键
document.addEventListener('keydown', (e) => {
  const keys = window.ttyKeys.get();
  if (window.ttyKeys.match(e, keys.dismissKey)) { e.preventDefault(); window.quick.close(); return; }
  if (window.ttyKeys.match(e, keys.copyTextKey) && currentTranslation) {
    e.preventDefault();
    window.quick.copy(currentTranslation);
    setCopyState(false, 'copied');
    setTimeout(() => { if (currentTranslation) setCopyState(true, 'copy'); }, 1200);
  }
});
