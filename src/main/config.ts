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

const DEFAULT_CONFIG: Config = {
  hotkey: 'alt+cmd+t',
  dismissKey: 'escape',
  cacheKey: 'shift+s',
  regionKey: 'alt+cmd+r',
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
  if (current.hotkeyMigratedV2) return current;

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

export function saveConfig(config: Partial<Config>): Config {
  const current = getConfig();
  const merged = { ...current, ...config };
  const configPath = getConfigPath();
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(merged, null, 2), 'utf-8');
  return merged;
}
