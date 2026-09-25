import * as fs from 'fs';
import * as path from 'path';
import { app } from 'electron';

export interface ProviderConfig {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export interface Config {
  hotkey: string;
  /// Set once the legacy chord defaults have been migrated to permission-free
  /// combos. Keeps the migration from ever running twice over a real user choice.
  hotkeyMigratedV2?: boolean;
  dismissKey: string;
  cacheKey: string;
  regionKey: string;
  /// 划词翻译：翻译此刻选中的文本（需要辅助功能权限）。
  textKey: string;
  /// 复制翻译：翻译剪贴板里的文本（不需要任何权限）。
  clipKey: string;
  /// 贴图上复制整张贴图（贴图要先点一下拿到焦点）。
  copyImageKey: string;
  /// 贴图上复制译文；划词/复制翻译的小窗里也是这个键。
  copyTextKey: string;
  /// 贴图上按住显示原文，松开回到译文。
  peekKey: string;
  /// 首次启动弹过设置窗之后置为 true，之后启动只驻留菜单栏，不再弹窗。
  launchedBefore?: boolean;
  /// 登录时自动启动（静默，不显示任何窗口）。
  openAtLogin?: boolean;
  targetLanguage: string;
  /// 'zh' | 'en'; unset means follow the system locale.
  uiLanguage?: string;
  provider: string;
  providers: Record<string, ProviderConfig>;
}

// Defaults are deliberately simple combos (one key + modifiers). Those go through
// Electron's globalShortcut -> Carbon RegisterEventHotKey, which needs NO macOS
// permission. A chord like shift+z+x requires a CGEventTap, which is what forces
// the Input Monitoring prompt.
const LEGACY_CHORD_DEFAULTS = { hotkey: 'shift+z+x', regionKey: 'shift+z+c' };

// ⌥⌘C 是 macOS 上「拷贝样式」的标准快捷键，文本编辑、Pages、Word 这类应用会先把它
// 吃掉，全局热键就再也收不到。取词翻译改用 ⌥D——和 Easydict 的划词键一致。
const LEGACY_TEXT_KEY = 'alt+cmd+c';

const DEFAULT_CONFIG: Config = {
  hotkey: 'alt+cmd+t',
  dismissKey: 'escape',
  cacheKey: 'shift+s',
  regionKey: 'alt+cmd+r',
  textKey: 'alt+d',
  clipKey: 'alt+c',
  copyImageKey: 'cmd+c',
  copyTextKey: 'shift+cmd+c',
  peekKey: 'space',
  openAtLogin: false,
  targetLanguage: 'zh-CN',
  provider: 'google',
  providers: {
    openai: {
      apiKey: '',
      model: 'gpt-4o-mini',
      baseUrl: 'https://api.openai.com/v1',
    },
    claude: {
      apiKey: '',
      model: 'claude-sonnet-4-20250514',
      baseUrl: 'https://api.anthropic.com',
    },
    deepl: {
      apiKey: '',
    },
    ollama: {
      model: 'qwen2.5',
      baseUrl: 'http://localhost:11434',
    },
  },
};

function getConfigPath(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'config.json');
}

/// 改名前的配置目录。首次以 TTY 身份启动时把它搬过来，免得设置丢失。
function legacyConfigPath(): string {
  return path.join(app.getPath('appData'), 'screen-translator', 'config.json');
}

function adoptLegacyConfig() {
  const target = getConfigPath();
  if (fs.existsSync(target)) return;
  const legacy = legacyConfigPath();
  if (!fs.existsSync(legacy)) return;
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(legacy, target);
    console.log(`[config] 已从旧目录迁移配置: ${legacy} -> ${target}`);
  } catch (e) {
    console.log('[config] 迁移旧配置失败:', e);
  }
}

export function getConfig(): Config {
  const configPath = getConfigPath();
  try {
    if (fs.existsSync(configPath)) {
      const raw = fs.readFileSync(configPath, 'utf-8');
      const userConfig = JSON.parse(raw);
      return { ...DEFAULT_CONFIG, ...userConfig };
    }
  } catch {}
  return { ...DEFAULT_CONFIG };
}

/// One-time move off the old chord defaults, so an existing install stops needing
/// Input Monitoring. Only touches values that still exactly equal the old defaults —
/// a hotkey the user actually chose is left alone, chord or not.
export function migrateConfig(): Config {
  adoptLegacyConfig();
  const current = getConfig();

  // 取词键的迁移和上面那次和弦迁移是两码事：装过带 ⌥⌘C 那一版的人，
  // hotkeyMigratedV2 早就是 true 了，不单独判一次就永远换不掉。
  if (current.textKey === LEGACY_TEXT_KEY) {
    saveConfig({ textKey: DEFAULT_CONFIG.textKey });
    console.log(`[config] 取词快捷键 ⌥⌘C 与「拷贝样式」冲突，已改为 ${DEFAULT_CONFIG.textKey}`);
  }

  if (current.hotkeyMigratedV2) return getConfig();

  const changes: Partial<Config> = { hotkeyMigratedV2: true };
  if (current.hotkey === LEGACY_CHORD_DEFAULTS.hotkey) {
    changes.hotkey = DEFAULT_CONFIG.hotkey;
  }
  if (current.regionKey === LEGACY_CHORD_DEFAULTS.regionKey) {
    changes.regionKey = DEFAULT_CONFIG.regionKey;
  }
  const migrated = saveConfig(changes);
  if (changes.hotkey || changes.regionKey) {
    console.log(
      `[config] Migrated chord hotkeys to permission-free combos: ` +
      `${migrated.hotkey} (full screen), ${migrated.regionKey} (region)`
    );
  }
  return migrated;
}

/// 把「开机自启」写进 macOS 登录项。openAsHidden 保证开机启动时不抢焦点、不弹窗。
export function applyLoginItem(enabled?: boolean) {
  if (process.platform !== 'darwin') return;
  try {
    app.setLoginItemSettings({ openAtLogin: !!enabled, openAsHidden: true });
  } catch (e) {
    console.log('[login] 设置登录项失败:', e);
  }
}

export function saveConfig(config: Partial<Config>): Config {
  const current = getConfig();
  const merged = { ...current, ...config };
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}
