const providerSelect = document.getElementById('provider');
const freeHint = document.getElementById('freeHint');
const configFields = document.getElementById('configFields');
const presetRow = document.getElementById('presetRow');
const apiKeyRow = document.getElementById('apiKeyRow');
const baseUrlRow = document.getElementById('baseUrlRow');
const presetSelect = document.getElementById('preset');
const cfgModel = document.getElementById('cfgModel');
const cfgApiKey = document.getElementById('cfgApiKey');
const cfgBaseUrl = document.getElementById('cfgBaseUrl');

// --- i18n ---
const I18N = {
  en: {
    hotkeyTranslate: 'Full Screen', hotkeyRegion: 'Region',
    hotkeyDismiss: 'Dismiss', hotkeyCache: 'Cache',
    hotkeyText: 'Selection', hotkeyInput: 'Type to Translate',
    hotkeyCopyImage: 'Copy Sticker', hotkeyCopyText: 'Copy Text', hotkeyPeek: 'Hold for Original',
    startup: 'Startup', openAtLogin: 'Launch at login',
    sticker: 'Sticker', autoFocusSticker: 'Select sticker after translating',
    record: 'Record', stop: 'Stop',
    targetLang: 'Target Language', provider: 'Provider',
    preset: 'Preset', model: 'Model',
    googleHint: 'Free, no API key required. Powered by Google Translate.',
    youdaoHint: 'Free, no API key required. Powered by Youdao Translate.',
    switchLang: '中文',
    apiKey: 'API Key', baseUrl: 'Base URL', custom: 'Custom',
    apiKeyPh: 'your-api-key',
    provGoogle: 'Google Translate (Free)', provYoudao: 'Youdao Translate (Free)',
    provOpenAI: 'OpenAI Compatible',
    provClaude: 'Anthropic Compatible', provDeepL: 'DeepL',
    provOllama: 'Ollama (Local)',
  },
  zh: {
    hotkeyTranslate: '全屏翻译', hotkeyRegion: '选区翻译',
    hotkeyDismiss: '关闭浮层', hotkeyCache: '缓存',
    hotkeyText: '划词翻译', hotkeyInput: '输入翻译',
    hotkeyCopyImage: '复制贴图', hotkeyCopyText: '复制译文', hotkeyPeek: '看原文（按住）',
    startup: '启动', openAtLogin: '开机自启',
    sticker: '贴图', autoFocusSticker: '翻译后自动选中贴图',
    record: '录制', stop: '停止',
    targetLang: '目标语言', provider: '翻译服务',
    preset: '预设', model: '模型',
    googleHint: '免费，无需 API Key。由 Google 翻译提供支持。',
    youdaoHint: '免费，无需 API Key。由有道翻译提供支持。',
    switchLang: 'EN',
    apiKey: 'API Key', baseUrl: '接口地址', custom: '自定义',
    apiKeyPh: '在此粘贴你的 API Key',
    provGoogle: 'Google 翻译（免费）', provYoudao: '有道翻译（免费）',
    provOpenAI: 'OpenAI 兼容接口',
    provClaude: 'Anthropic 兼容接口', provDeepL: 'DeepL',
    provOllama: 'Ollama（本地）',
  },
};
let currentLang = 'zh';
function applyI18n() {
  document.querySelectorAll('[data-i18n]').forEach(el => {
    const t = I18N[currentLang][el.getAttribute('data-i18n')];
    if (t) el.textContent = t;
  });
  // placeholder 也跟着切换
  document.querySelectorAll('[data-i18n-ph]').forEach(el => {
    const t = I18N[currentLang][el.getAttribute('data-i18n-ph')];
    if (t) el.placeholder = t;
  });
  document.getElementById('langSwitch').textContent = I18N[currentLang].switchLang;
  document.querySelectorAll('.recordBtn').forEach(btn => {
    if (!btn.classList.contains('recording')) btn.textContent = I18N[currentLang].record;
  });
}
document.getElementById('langSwitch').addEventListener('click', () => {
  currentLang = currentLang === 'en' ? 'zh' : 'en';
  applyI18n();
  localStorage.setItem('settingsLang', currentLang);
  // 一并写进配置，让主进程的提示条、托盘菜单、对话框跟着切
  if (currentConfig) currentConfig.uiLanguage = currentLang;
  window.api.saveConfig({ uiLanguage: currentLang });
});
const savedLang = localStorage.getItem('settingsLang');
if (savedLang) currentLang = savedLang;
applyI18n();

// --- Provider presets ---
const PRESETS = {
  openai: [
    { value: '', label: 'Custom' },
    { value: 'openai', label: 'OpenAI', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
    { value: 'deepseek', label: 'DeepSeek', model: 'deepseek-chat', baseUrl: 'https://api.deepseek.com/v1' },
    { value: 'groq', label: 'Groq', model: 'llama-3.3-70b-versatile', baseUrl: 'https://api.groq.com/openai/v1' },
    { value: 'siliconflow', label: 'SiliconFlow', model: 'Qwen/Qwen2.5-72B-Instruct', baseUrl: 'https://api.siliconflow.cn/v1' },
  ],
  claude: [
    { value: '', label: 'Custom' },
    { value: 'anthropic', label: 'Anthropic', model: 'claude-sonnet-4-20250514', baseUrl: 'https://api.anthropic.com' },
    { value: 'minimax', label: 'MiniMax', model: 'MiniMax-M2.7', baseUrl: 'https://api.minimaxi.com/anthropic' },
  ],
};

// Provider field config: which fields to show
// 免费服务不需要任何配置项，选中时只显示一行说明
const FREE_PROVIDER_HINTS = { google: 'googleHint', youdao: 'youdaoHint' };

const PROVIDER_FIELDS = {
  google:  { preset: false, model: false, apiKey: false, baseUrl: false },
  youdao:  { preset: false, model: false, apiKey: false, baseUrl: false },
  openai:  { preset: true,  model: true,  apiKey: true,  baseUrl: true },
  claude:  { preset: true,  model: true,  apiKey: true,  baseUrl: true },
  deepl:   { preset: false, model: false, apiKey: true,  baseUrl: false },
  ollama:  { preset: false, model: true,  apiKey: false, baseUrl: true },
};

const PROVIDER_DEFAULTS = {
  openai: { model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
  claude: { model: 'claude-sonnet-4-20250514', baseUrl: 'https://api.anthropic.com' },
  deepl:  { model: '', baseUrl: '' },
  ollama: { model: 'qwen2.5', baseUrl: 'http://localhost:11434' },
};

function switchProvider(provider) {
  const fields = PROVIDER_FIELDS[provider] || PROVIDER_FIELDS.openai;

  const hintKey = FREE_PROVIDER_HINTS[provider];
  if (hintKey) {
    freeHint.setAttribute('data-i18n', hintKey);
    freeHint.textContent = I18N[currentLang][hintKey];
    freeHint.classList.remove('hidden');
    configFields.classList.add('hidden');
    return;
  }

  freeHint.classList.add('hidden');
  configFields.classList.remove('hidden');

  presetRow.classList.toggle('hidden', !fields.preset);
  apiKeyRow.classList.toggle('hidden', !fields.apiKey);
  baseUrlRow.classList.toggle('hidden', !fields.baseUrl);

  // Populate preset dropdown
  if (fields.preset && PRESETS[provider]) {
    presetSelect.innerHTML = '';
    PRESETS[provider].forEach(p => {
      const opt = document.createElement('option');
      opt.value = p.value;
      // 预设里只有 "Custom" 需要翻译，其余是厂商名，保持原文
      opt.textContent = p.value === '' ? I18N[currentLang].custom : p.label;
      presetSelect.appendChild(opt);
    });
  }

  // Load saved values for this provider
  const saved = currentConfig?.providers?.[provider] || {};
  cfgModel.value = saved.model || PROVIDER_DEFAULTS[provider]?.model || '';
  cfgApiKey.value = saved.apiKey || '';
  cfgBaseUrl.value = saved.baseUrl || PROVIDER_DEFAULTS[provider]?.baseUrl || '';
  cfgModel.placeholder = PROVIDER_DEFAULTS[provider]?.model || 'model';
  cfgBaseUrl.placeholder = PROVIDER_DEFAULTS[provider]?.baseUrl || 'base url';
}

providerSelect.addEventListener('change', () => {
  switchProvider(providerSelect.value);
  autoSave();
});

presetSelect.addEventListener('change', () => {
  const provider = providerSelect.value;
  const presets = PRESETS[provider];
  if (!presets) return;
  const p = presets.find(x => x.value === presetSelect.value);
  if (p && p.model) {
    cfgModel.value = p.model;
    cfgBaseUrl.value = p.baseUrl || '';
    autoSave();
  }
});

// --- 快捷键显示 ---
// 配置里存 'alt+cmd+t' 这种规范串（放在 dataset.value），输入框里按 macOS 习惯显示 ⌥⌘T。
const MOD_ORDER = ['ctrl', 'alt', 'shift', 'cmd'];
const MOD_SYMBOL = { ctrl: '\u2303', alt: '\u2325', shift: '\u21e7', cmd: '\u2318' };
const KEY_SYMBOL = {
  escape: '\u238b', enter: '\u21a9', tab: '\u21e5', delete: '\u232b', space: '\u2423',
};

function prettyHotkey(str) {
  if (!str) return '';
  const parts = String(str).toLowerCase().split('+').map(x => x.trim()).filter(Boolean);
  const mods = MOD_ORDER.filter(m => parts.includes(m)).map(m => MOD_SYMBOL[m]).join('');
  const keys = parts
    .filter(x => !MOD_ORDER.includes(x))
    .map(k => KEY_SYMBOL[k] || k.toUpperCase());
  return mods + keys.join(' ');
}

function hotkeyValue(id) {
  const el = document.getElementById(id);
  return (el && el.dataset.value) || '';
}

function setHotkeyField(id, value) {
  const el = document.getElementById(id);
  if (!el) return;
  el.dataset.value = value || '';
  el.value = prettyHotkey(value);
}

// --- Auto-save ---
let currentConfig = null;
let saveTimer = null;
function autoSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(doSave, 300);
}
async function doSave() {
  const provider = providerSelect.value;
  const config = {
    hotkey: hotkeyValue('hotkey') || 'alt+cmd+t',
    regionKey: hotkeyValue('regionKey') || 'alt+cmd+r',
    dismissKey: hotkeyValue('dismissKey') || 'escape',
    cacheKey: hotkeyValue('cacheKey') || 'shift+s',
    textKey: hotkeyValue('textKey') || 'alt+d',
    inputKey: hotkeyValue('inputKey') || 'alt+c',
    copyImageKey: hotkeyValue('copyImageKey') || 'cmd+c',
    copyTextKey: hotkeyValue('copyTextKey') || 'shift+cmd+c',
    peekKey: hotkeyValue('peekKey') || 'space',
    openAtLogin: document.getElementById('openAtLogin').checked,
    autoFocusSticker: document.getElementById('autoFocusSticker').checked,
    targetLanguage: document.getElementById('targetLanguage').value,
    provider,
    providers: currentConfig?.providers || {},
  };
  // Save current provider fields
  if (!FREE_PROVIDER_HINTS[provider]) {
    config.providers[provider] = {
      ...(config.providers[provider] || {}),
      model: cfgModel.value.trim() || undefined,
      apiKey: cfgApiKey.value.trim() || undefined,
      baseUrl: cfgBaseUrl.value.trim() || undefined,
    };
  }
  currentConfig = config;
  await window.api.saveConfig(config);
}
document.querySelectorAll('input:not([data-hotkey]), select').forEach(el => {
  el.addEventListener('change', autoSave);
  el.addEventListener('input', autoSave);
});

// --- Hotkey recording ---
const CODE_TO_NAME = {
  KeyA:'a',KeyB:'b',KeyC:'c',KeyD:'d',KeyE:'e',KeyF:'f',KeyG:'g',KeyH:'h',
  KeyI:'i',KeyJ:'j',KeyK:'k',KeyL:'l',KeyM:'m',KeyN:'n',KeyO:'o',KeyP:'p',
  KeyQ:'q',KeyR:'r',KeyS:'s',KeyT:'t',KeyU:'u',KeyV:'v',KeyW:'w',KeyX:'x',
  KeyY:'y',KeyZ:'z',
  Digit0:'0',Digit1:'1',Digit2:'2',Digit3:'3',Digit4:'4',
  Digit5:'5',Digit6:'6',Digit7:'7',Digit8:'8',Digit9:'9',
  F1:'f1',F2:'f2',F3:'f3',F4:'f4',F5:'f5',F6:'f6',
  F7:'f7',F8:'f8',F9:'f9',F10:'f10',F11:'f11',F12:'f12',
  Space:'space',Enter:'enter',Tab:'tab',Escape:'escape',Backspace:'delete',
  Comma:',',Period:'.',Slash:'/',Semicolon:';',BracketLeft:'[',BracketRight:']',
};
let activeRecordBtn = null, activeRecordInput = null;
const recordedKeys = new Set();
document.querySelectorAll('.recordBtn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (activeRecordBtn === btn) stopRecording();
    else { if (activeRecordBtn) stopRecording(); startRecording(btn); }
  });
});
function startRecording(btn) {
  activeRecordBtn = btn;
  activeRecordInput = document.getElementById(btn.getAttribute('data-target'));
  btn.textContent = I18N[currentLang].stop;
  btn.style.background = '#f38ba8'; btn.classList.add('recording');
  // 只改显示，不动 dataset.value：否则录到一半放弃会把 '...' 存进配置。
  activeRecordInput.value = '\u2026'; activeRecordInput.style.borderColor = '#f38ba8';
  recordedKeys.clear();
  document.addEventListener('keydown', onRecordKey);
}
function stopRecording() {
  if (!activeRecordBtn) return;
  activeRecordBtn.textContent = I18N[currentLang].record;
  activeRecordBtn.style.background = ''; activeRecordBtn.classList.remove('recording');
  if (activeRecordInput) {
    activeRecordInput.style.borderColor = '';
    activeRecordInput.value = prettyHotkey(activeRecordInput.dataset.value || '');
  }
  document.removeEventListener('keydown', onRecordKey);
  recordedKeys.clear(); activeRecordBtn = null; activeRecordInput = null;
  autoSave();
}
function onRecordKey(e) {
  e.preventDefault(); e.stopPropagation();
  // 收集所有按下的修饰键，⌥⌘T 这类多修饰键组合才录得下来。
  const mods = [];
  if (e.ctrlKey) mods.push('ctrl');
  if (e.altKey) mods.push('alt');
  if (e.shiftKey) mods.push('shift');
  if (e.metaKey) mods.push('cmd');
  const key = CODE_TO_NAME[e.code];
  if (!key) return;
  recordedKeys.add(key);
  const keys = Array.from(recordedKeys).slice(0, 2);
  const canonical = [...mods, ...keys].join('+');
  activeRecordInput.dataset.value = canonical;
  activeRecordInput.value = prettyHotkey(canonical);
  // 只有「单按 Shift + 一个键」时继续等第二个键（和弦）；其他情况直接结束。
  // 贴图、小窗里用的键（关闭、复制、看原文）不支持和弦，按下一个键就结束。
  const single = activeRecordInput.dataset.single === '1';
  if (single || keys.length >= 2 || !e.shiftKey || mods.length !== 1) stopRecording();
}
document.addEventListener('keyup', () => {
  if (activeRecordBtn && recordedKeys.size > 0) recordedKeys.clear();
});

// --- Load config ---
window.api.getConfig().then(config => {
  currentConfig = config;
  // 配置里的语言优先于 localStorage，保证和主进程一致
  if (config.uiLanguage && config.uiLanguage !== currentLang) {
    currentLang = config.uiLanguage;
    applyI18n();
  }
  setHotkeyField('hotkey', config.hotkey || 'alt+cmd+t');
  setHotkeyField('regionKey', config.regionKey || 'alt+cmd+r');
  setHotkeyField('dismissKey', config.dismissKey || 'escape');
  setHotkeyField('cacheKey', config.cacheKey || 'shift+s');
  setHotkeyField('textKey', config.textKey || 'alt+d');
  setHotkeyField('inputKey', config.inputKey || 'alt+c');
  setHotkeyField('copyImageKey', config.copyImageKey || 'cmd+c');
  setHotkeyField('copyTextKey', config.copyTextKey || 'shift+cmd+c');
  setHotkeyField('peekKey', config.peekKey || 'space');
  document.getElementById('openAtLogin').checked = !!config.openAtLogin;
  document.getElementById('autoFocusSticker').checked = config.autoFocusSticker !== false;
  document.getElementById('targetLanguage').value = config.targetLanguage || 'zh-CN';
  providerSelect.value = config.provider || 'google';
  switchProvider(providerSelect.value);
});
