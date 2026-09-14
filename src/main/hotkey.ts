import { execFile, ChildProcess } from 'child_process';
import { globalShortcut } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import * as readline from 'readline';
import { ensureNativeSync } from './native';

// Two hotkey backends behind the same interface:
//
//   'global' — Electron globalShortcut, which on macOS goes through Carbon's
//              RegisterEventHotKey. The OS owns the registration, so it needs NO
//              permission, but it can only express "modifiers + exactly one key".
//
//   'native' — the hotkey-macos helper, which installs a CGEventTap over the whole
//              keystroke stream. That is the only way to detect chords like
//              Shift+Z+X, and it is why macOS demands Input Monitoring permission.
//
// 'global' serves any hotkey that is a simple combo; 'native' is used only for
// chords, so a default install needs no permission.

export type HotkeyBackend = 'global' | 'native';
export type HotkeyState = 'SHOWN' | 'HIDDEN' | 'TRANSLATING';

let hotkeyProcess: ChildProcess | null = null;
let shouldRestart = true;
let triggerFn: (() => void) | null = null;
let dismissFn: (() => void) | null = null;
let saveCacheFn: (() => void) | null = null;
let cancelFn: (() => void) | null = null;
let regionFn: (() => void) | null = null;
let textFn: (() => void) | null = null;
let clipFn: (() => void) | null = null;
let permissionDeniedFn: (() => void) | null = null;
let registerFailedFn: ((accelerators: string[]) => void) | null = null;
let currentArgs: string[] = [];
let restartDelay = 1000;
let permissionNotified = false;
const MAX_RESTART_DELAY = 15000;

let backend: HotkeyBackend = 'native';
let currentState: HotkeyState = 'HIDDEN';
let currentHotkeys: Hotkeys = {};
/// Accelerators registered only while the overlay is up / a translation is running.
let transientAccelerators: string[] = [];

export interface Hotkeys {
  trigger?: string;
  dismiss?: string;
  cache?: string;
  region?: string;
  text?: string;
  clip?: string;
}

export interface HotkeyConfig {
  /// All modifiers present, in canonical order. The native helper only understands
  /// one, so it uses the first; the global backend uses all of them.
  modifiers: string[];
  /// Non-modifier keys, as lowercase names from KEY_MAP.
  keys: string[];
  keycodes: number[];
}

/// Called when the native monitor cannot create a keyboard event tap, i.e. Input
/// Monitoring permission is missing. Fires at most once per healthy run.
export function setHotkeyPermissionDeniedHandler(cb: () => void) {
  permissionDeniedFn = cb;
}

/// Called when the global backend could not claim one or more accelerators —
/// almost always because another app already owns that combo.
export function setHotkeyRegisterFailedHandler(cb: (accelerators: string[]) => void) {
  registerFailedFn = cb;
}

/// 划词翻译（翻译选中的文本）。和截图那条链路无关，不参与 backend 的状态机。
export function setTextCallback(cb: () => void) {
  textFn = cb;
}

/// 复制翻译（翻译剪贴板里的文本）。同上，常驻注册。
export function setClipCallback(cb: () => void) {
  clipFn = cb;
}

export function getHotkeyBackend(): HotkeyBackend {
  return backend;
}

// Map key names to macOS keycodes (used by the native backend).
const KEY_MAP: Record<string, number> = {
  a: 0, s: 1, d: 2, f: 3, h: 4, g: 5, z: 6, x: 7, c: 8, v: 9,
  b: 11, q: 12, w: 13, e: 14, r: 15, y: 16, t: 17, '1': 18, '2': 19,
  '3': 20, '4': 21, '6': 22, '5': 23, '9': 25, '7': 26, '8': 28, '0': 29,
  o: 31, u: 32, i: 34, p: 35, l: 37, j: 38, k: 40, n: 45, m: 46,
  '/': 44, '.': 47, ',': 43, ';': 41, '\'': 39, '[': 33, ']': 30,
  space: 49, enter: 36, tab: 48, delete: 51, escape: 53,
  f1: 122, f2: 120, f3: 99, f4: 118, f5: 96, f6: 97, f7: 98, f8: 100,
  f9: 101, f10: 109, f11: 103, f12: 111,
};

const MODIFIERS = ['shift', 'cmd', 'alt', 'ctrl'];

/// Electron accelerator names for each modifier.
const ACCEL_MODIFIER: Record<string, string> = {
  shift: 'Shift', cmd: 'Command', alt: 'Alt', ctrl: 'Control',
};

/// Electron accelerator names for keys whose name differs from the key itself.
const ACCEL_KEY: Record<string, string> = {
  space: 'Space', enter: 'Return', tab: 'Tab', delete: 'Delete', escape: 'Escape',
};

export function parseHotkeyString(hotkey: string): HotkeyConfig {
  const parts = hotkey.toLowerCase().split('+').map(s => s.trim()).filter(Boolean);
  const modifiers: string[] = [];
  const keys: string[] = [];

  for (const part of parts) {
    if (MODIFIERS.includes(part)) {
      if (!modifiers.includes(part)) modifiers.push(part);
    } else if (KEY_MAP[part] !== undefined) {
      keys.push(part);
    }
  }

  // No usable key (empty or unparseable setting). Callers substitute this slot's
  // default; falling back to a chord here would drag the whole app onto the
  // CGEventTap backend and demand Input Monitoring for no reason.

  // Canonical modifier order, so equal combos compare equal.
  modifiers.sort((a, b) => MODIFIERS.indexOf(a) - MODIFIERS.indexOf(b));

  return { modifiers, keys, keycodes: keys.map(k => KEY_MAP[k]) };
}

function isFunctionKey(key: string): boolean {
  return /^f([1-9]|1[0-2])$/.test(key);
}

/// True when this combo is something RegisterEventHotKey can express: exactly one
/// key, plus at least one modifier (or a bare function key, which is safe to claim).
export function isSimpleCombo(cfg: HotkeyConfig): boolean {
  if (cfg.keys.length !== 1) return false;
  return cfg.modifiers.length > 0 || isFunctionKey(cfg.keys[0]);
}

export function toAccelerator(cfg: HotkeyConfig): string {
  const mods = cfg.modifiers.map(m => ACCEL_MODIFIER[m]);
  const key = cfg.keys[0];
  const accelKey = ACCEL_KEY[key] || (key.length === 1 ? key.toUpperCase() : key.toUpperCase());
  return [...mods, accelKey].join('+');
}

export function startHotkeyMonitor(
  onTrigger: () => void,
  onDismiss: () => void,
  onSaveCache: () => void,
  onCancel: () => void,
  onRegion: () => void,
  hotkeys?: Hotkeys
) {
  triggerFn = onTrigger;
  dismissFn = onDismiss;
  saveCacheFn = onSaveCache;
  cancelFn = onCancel;
  regionFn = onRegion;
  shouldRestart = true;
  currentHotkeys = hotkeys || {};
  currentState = 'HIDDEN';

  startBackend();
}

export function restartWithHotkeys(hotkeys: Hotkeys) {
  currentHotkeys = hotkeys;
  currentState = 'HIDDEN';
  teardownBackend();
  shouldRestart = true;
  startBackend();
}

export function stopHotkeyMonitor() {
  shouldRestart = false;
  teardownBackend();
}

function teardownBackend() {
  unregisterTransient();
  globalShortcut.unregisterAll();
  if (hotkeyProcess) {
    shouldRestart = false;
    hotkeyProcess.kill();
    hotkeyProcess = null;
  }
}

export const HOTKEY_DEFAULTS = {
  trigger: 'alt+cmd+t',
  region: 'alt+cmd+r',
  dismiss: 'escape',
  cache: 'shift+s',
  text: 'alt+d',
  clip: 'alt+c',
};

/// Parse a configured hotkey, falling back to this slot's default when the value
/// is missing or has no usable key.
export function parseSlot(value: string | undefined, fallback: string): HotkeyConfig {
  const cfg = parseHotkeyString(value || fallback);
  return cfg.keys.length > 0 ? cfg : parseHotkeyString(fallback);
}

function startBackend() {
  const trigger = parseSlot(currentHotkeys.trigger, HOTKEY_DEFAULTS.trigger);
  const region = parseSlot(currentHotkeys.region, HOTKEY_DEFAULTS.region);

  if (isSimpleCombo(trigger) && isSimpleCombo(region)) {
    backend = 'global';
    startGlobalBackend(trigger, region);
  } else {
    backend = 'native';
    console.log(
      '[hotkey] Chord hotkey configured, falling back to the CGEventTap helper ' +
      '(this is what needs Input Monitoring permission)'
    );
    currentArgs = buildArgs(currentHotkeys);
    launch();
  }

  // 这两个键走 globalShortcut，和上面选了哪个 backend 无关：它们翻译的是文本，
  // 不看浮层状态，所以常驻注册就够，也不需要输入监控权限。
  const taken = [toAccelerator(trigger), toAccelerator(region)];
  registerTextHotkey('划词翻译', currentHotkeys.text, HOTKEY_DEFAULTS.text, taken, () => textFn?.());
  registerTextHotkey('复制翻译', currentHotkeys.clip, HOTKEY_DEFAULTS.clip, taken, () => clipFn?.());
}

function registerTextHotkey(
  label: string,
  value: string | undefined,
  fallback: string,
  taken: string[],
  handler: () => void
) {
  const cfg = parseSlot(value, fallback);
  if (!isSimpleCombo(cfg)) {
    console.log(`[hotkey] ${label}快捷键必须是普通组合键（修饰键 + 一个键），已跳过`);
    return;
  }
  const accel = toAccelerator(cfg);
  if (taken.includes(accel)) {
    console.log(`[hotkey] ${label}快捷键 ${accel} 和已注册的键重了，已跳过`);
    return;
  }
  if (register(accel, handler)) {
    taken.push(accel);
    console.log(`[hotkey] ${accel} = ${label}`);
  } else {
    console.log(`[hotkey] ${label}快捷键 ${accel} 注册失败，可能已被其它应用占用`);
  }
}

// ---------------------------------------------------------------------------
// Global backend (no permission required)
// ---------------------------------------------------------------------------

function startGlobalBackend(trigger: HotkeyConfig, region: HotkeyConfig) {
  const failed: string[] = [];

  const triggerAccel = toAccelerator(trigger);
  const regionAccel = toAccelerator(region);

  // The native helper decides between TRIGGERED / DISMISS / CANCEL from its own
  // state. Here we do the same dispatch from the state Electron reports to us.
  if (!register(triggerAccel, () => {
    if (currentState === 'SHOWN') dismissFn?.();
    else if (currentState === 'TRANSLATING') cancelFn?.();
    else triggerFn?.();
  })) failed.push(triggerAccel);

  if (regionAccel !== triggerAccel) {
    if (!register(regionAccel, () => {
      if (currentState === 'HIDDEN') regionFn?.();
    })) failed.push(regionAccel);
  }

  console.log(`[hotkey] Backend: global (no permission needed). ${triggerAccel} = full screen, ${regionAccel} = region`);

  if (failed.length > 0) {
    console.log(`[hotkey] Could not register: ${failed.join(', ')} — another app likely owns them`);
    registerFailedFn?.(failed);
  }
}

function register(accelerator: string, cb: () => void): boolean {
  try {
    if (globalShortcut.isRegistered(accelerator)) globalShortcut.unregister(accelerator);
    return globalShortcut.register(accelerator, cb);
  } catch (e) {
    console.log(`[hotkey] register("${accelerator}") threw:`, e);
    return false;
  }
}

/// Escape and Shift+S must NOT be claimed globally all the time — that would eat
/// Escape system-wide and break typing a capital S. Claim them only while the
/// overlay is up (or a translation is running), exactly like the native helper,
/// which also only honours them in those states.
function syncTransient() {
  unregisterTransient();
  if (backend !== 'global') return;

  const dismiss = parseSlot(currentHotkeys.dismiss, HOTKEY_DEFAULTS.dismiss);
  const cache = parseSlot(currentHotkeys.cache, HOTKEY_DEFAULTS.cache);

  if (currentState === 'SHOWN') {
    if (dismiss.keys.length === 1 && register(toAccelerator(dismiss), () => dismissFn?.())) {
      transientAccelerators.push(toAccelerator(dismiss));
    }
    if (cache.keys.length === 1 && register(toAccelerator(cache), () => saveCacheFn?.())) {
      transientAccelerators.push(toAccelerator(cache));
    }
  } else if (currentState === 'TRANSLATING') {
    if (dismiss.keys.length === 1 && register(toAccelerator(dismiss), () => cancelFn?.())) {
      transientAccelerators.push(toAccelerator(dismiss));
    }
  }
}

function unregisterTransient() {
  for (const accel of transientAccelerators) {
    try { globalShortcut.unregister(accel); } catch {}
  }
  transientAccelerators = [];
}

// ---------------------------------------------------------------------------
// Native backend (CGEventTap helper — needs Input Monitoring)
// ---------------------------------------------------------------------------

function hotkeyToNativeArg(hotkey: string | undefined, fallback: string): string {
  const config = parseSlot(hotkey, fallback);
  // The helper's arg format carries a single modifier, so pass the first.
  const parts = [config.modifiers[0] || 'none', ...config.keycodes.map(String)];
  return parts.join(':');
}

function buildArgs(hotkeys?: Hotkeys): string[] {
  const t = hotkeyToNativeArg(hotkeys?.trigger, HOTKEY_DEFAULTS.trigger);
  const d = hotkeyToNativeArg(hotkeys?.dismiss, HOTKEY_DEFAULTS.dismiss);
  const c = hotkeyToNativeArg(hotkeys?.cache, HOTKEY_DEFAULTS.cache);
  const r = hotkeyToNativeArg(hotkeys?.region, HOTKEY_DEFAULTS.region);
  return ['-t', t, '-d', d, '-c', c, '-r', r];
}

function launch() {
  const { binaryPath, ok } = ensureNativeSync('hotkey-macos');
  if (!ok) return;

  console.log(`[hotkey] Launching with args: ${currentArgs.join(' ')}`);
  const startedAt = Date.now();
  hotkeyProcess = execFile(binaryPath, currentArgs, { maxBuffer: 1024 * 1024 });

  if (hotkeyProcess.stdout) {
    const rl = readline.createInterface({ input: hotkeyProcess.stdout });
    rl.on('line', (line) => {
      const cmd = line.trim();
      if (cmd === 'TRIGGERED' && triggerFn) triggerFn();
      else if (cmd === 'DISMISS' && dismissFn) dismissFn();
      else if (cmd === 'SAVE_CACHE' && saveCacheFn) saveCacheFn();
      else if (cmd === 'CANCEL' && cancelFn) cancelFn();
      else if (cmd === 'REGION' && regionFn) regionFn();
      else if (cmd === 'NO_PERMISSION') {
        // Event tap refused. Retrying every second forever would spin silently, so back
        // off and tell the user once; the loop keeps going so it recovers after they
        // grant the permission.
        console.log('[hotkey] Event tap refused - Input Monitoring permission missing');
        restartDelay = MAX_RESTART_DELAY;
        if (!permissionNotified) {
          permissionNotified = true;
          permissionDeniedFn?.();
        }
      }
    });
  }

  hotkeyProcess.stdin?.on('error', () => {});
  hotkeyProcess.stdout?.on('error', () => {});
  hotkeyProcess.on('error', () => {});

  hotkeyProcess.stderr?.on('data', (data: Buffer) => {
    console.log('[hotkey]', data.toString().trim());
  });

  hotkeyProcess.on('exit', (code) => {
    const lived = Date.now() - startedAt;
    console.log(`[hotkey] Exited (code ${code}) after ${lived}ms, relaunch in ${restartDelay}ms`);
    hotkeyProcess = null;
    if (lived > 5000) {
      // It ran fine for a while, so this was a normal restart, not a failing loop.
      restartDelay = 1000;
      permissionNotified = false;
    }
    if (shouldRestart) setTimeout(launch, restartDelay);
  });
}

// ---------------------------------------------------------------------------

/// Report the real state to whichever backend is running. Electron is the source of
/// truth: the native helper flips itself into "translating" the moment it emits
/// TRIGGERED, and the global backend needs this to know what the trigger key means.
export function sendHotkeyState(state: HotkeyState) {
  currentState = state;

  if (backend === 'global') {
    syncTransient();
    return;
  }

  if (hotkeyProcess?.stdin?.writable) {
    hotkeyProcess.stdin.write(state + '\n');
    console.log(`[hotkey] Sent state: ${state}`);
  } else {
    console.log(`[hotkey] Cannot send state (stdin not writable)`);
  }
}

