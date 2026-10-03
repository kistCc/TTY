import { BrowserWindow, ipcMain, app, screen } from 'electron';
import { spawn, ChildProcess } from 'child_process';
import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { ensureNative, debugLog } from './native';
import { recognizeImage, translateRecognized, TranslationCache, Recognized } from './pipeline';
import { getConfig } from './config';
import { showSelection } from './selection';
import { warmApple } from './providers/apple';

// 实时翻译：框选一块区域，在它上面盖一个透明、鼠标穿透的窗口。
// 截图程序（scripts/live-macos.swift）反复截这块区域（排除 TTY 自己的窗口），画面变了才交一帧；
// 这里对每一帧走和区域翻译同一条识别流程，译文按段缓存（同一段只翻一次），画在透明窗口上，
// 只盖住原文所在的地方，其余地方透明，下面的画面照常可见、可点。
// 区域里一滚动、一拖动，译文立刻藏起来，停下 150 毫秒后重新截图识别。
// （思路参考 SwiftyCrow 的区域实时翻译）

let helper: ChildProcess | null = null;
let win: BrowserWindow | null = null;
let active = false;
let starting = false;
/// 正在识别一帧
let busy = false;
/// 区域里正在滚动、拖动
let interacting = false;
/// 每次区域变化、交互、停止都加一：之前还没做完的识别、翻译结果作废
let gen = 0;
/// 拖动把手、关闭按钮所在的窄条（点）。放在框选区域外面，不压住区域里的字：
/// 平时在区域上方；区域贴着屏幕顶、上面放不下时放在下方
const BAR = 22;
let barTop = true;
/// 最新一帧的识别结果（还有段没翻完时，翻完后用它重画）
let latest: { rec: Recognized; dataUrl: string; gen: number } | null = null;
/// 同一时间只有一批翻译在路上，免得滚动时同一段重复请求
let translating = false;
const cache: TranslationCache = new Map();
let onChange: (() => void) | null = null;

export function isLiveActive(): boolean {
  return active || starting;
}

/// 框选完、窗口已经开着（不含正在框选）
export function isLiveRunning(): boolean {
  return active;
}

/// 状态变了（开、关）时通知菜单栏刷新
export function setLiveChangeCallback(cb: () => void) {
  onChange = cb;
}

function send(cmd: Record<string, any>) {
  try { helper?.stdin?.write(JSON.stringify(cmd) + '\n'); } catch {}
}

/// 要截的区域 = 窗口去掉把手那条
function regionOf(w: BrowserWindow) {
  const b = w.getContentBounds();
  return { x: b.x, y: barTop ? b.y + BAR : b.y, w: b.width, h: b.height - BAR };
}

/// 实时翻译键：没开就开始框选，开着就关掉
export async function toggleLive() {
  if (starting) return;
  if (active) { stopLive(); return; }
  starting = true;
  onChange?.();
  try {
    const config = getConfig();
    if (config.provider === 'apple') warmApple(config.targetLanguage || 'zh-CN');
    const sel = await showSelection();
    if (!sel) return;
    try { fs.unlinkSync(sel.screenshotPath); } catch {}
    const { binaryPath, error } = await ensureNative('live-macos');
    if (error) { console.error(`[live] ${error}`); return; }
    createWindow(sel.x, sel.y, sel.width, sel.height);
    startHelper(binaryPath);
    active = true;
    debugLog(`=== 实时翻译开始 ${Math.round(sel.x)},${Math.round(sel.y)} ${Math.round(sel.width)}x${Math.round(sel.height)} ===`);
  } finally {
    starting = false;
    onChange?.();
  }
}

/// 全屏、区域翻译截屏时先把实时翻译窗口藏起来，免得把它画的译文也截进去
export function setLiveHidden(hidden: boolean) {
  if (!win || win.isDestroyed()) return;
  if (hidden) win.setOpacity(0);
  else win.setOpacity(1);
}

export function stopLive() {
  if (!active && !win && !helper) return;
  active = false;
  gen++;
  latest = null;
  busy = false;
  interacting = false;
  send({ cmd: 'quit' });
  const h = helper;
  helper = null;
  setTimeout(() => { try { h?.kill(); } catch {} }, 500);
  if (win && !win.isDestroyed()) win.destroy();
  win = null;
  debugLog('=== 实时翻译结束 ===');
  onChange?.();
}

function createWindow(x: number, y: number, width: number, height: number) {
  const work = screen.getDisplayNearestPoint({ x: Math.round(x), y: Math.round(y) }).workArea;
  barTop = y - BAR >= work.y;
  win = new BrowserWindow({
    x: Math.round(x), y: Math.round(barTop ? y - BAR : y), width: Math.round(width), height: Math.round(height + BAR),
    minWidth: 80, minHeight: 40 + BAR,
    frame: false,
    transparent: true,
    hasShadow: false,
    resizable: true,
    movable: true,
    focusable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'live-preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      backgroundThrottling: false,
    },
  });
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  // 中间鼠标穿透（点、滚都落到下面的软件上）；鼠标事件照样转给页面，页面发现鼠标在边缘、按钮上时再关掉穿透
  win.setIgnoreMouseEvents(true, { forward: true });
  win.loadFile(path.join(app.getAppPath(), 'src', 'renderer', 'overlay.html'), { query: { live: '1', bar: barTop ? 'top' : 'bottom' } });
  win.once('ready-to-show', () => win?.showInactive());
  const moved = () => {
    if (!win || win.isDestroyed()) return;
    gen++;
    latest = null;
    win.webContents.send('clear');
    send({ cmd: 'rect', ...regionOf(win) });
  };
  win.on('move', moved);
  win.on('resize', moved);
  win.on('closed', () => { if (active) stopLive(); });
}

function startHelper(binaryPath: string) {
  helper = spawn(binaryPath, [], { stdio: ['pipe', 'pipe', 'pipe'] });
  const proc = helper;
  const rl = readline.createInterface({ input: proc.stdout! });
  rl.on('line', (line) => {
    let msg: any;
    try { msg = JSON.parse(line); } catch { return; }
    if (proc !== helper) return;
    if (msg.type === 'frame') onFrame(msg);
    else if (msg.type === 'interact') onInteract(!!msg.on);
    else if (msg.type === 'error') debugLog(`[live] ${msg.msg}`);
  });
  proc.stderr?.on('data', (d) => debugLog(`[live] ${String(d).trim()}`));
  proc.on('exit', (code) => {
    if (proc !== helper) return;
    helper = null;
    if (active) {
      console.error(`[live] 截图程序退出了（${code}）`);
      stopLive();
    }
  });
  if (win) send({ cmd: 'start', ...regionOf(win), pid: process.pid });
}

function onInteract(on: boolean) {
  if (!active || !win || win.isDestroyed()) return;
  interacting = on;
  if (on) {
    // 同一个事件里就藏起来，不等识别：滚动时绝不能让旧译文盖在挪走了的原文上
    gen++;
    latest = null;
    win.webContents.send('clear');
  } else if (!busy) {
    send({ cmd: 'want' });
  }
}

async function onFrame(f: { path: string; w: number; h: number; scale: number; seq: number; rw: number }) {
  const drop = () => { try { fs.unlinkSync(f.path); } catch {} };
  if (!active || !win || interacting || busy) { drop(); if (active && !interacting && !busy) send({ cmd: 'want' }); return; }
  busy = true;
  const myGen = gen;
  const config = getConfig();
  const targetLang = config.targetLanguage || 'zh-CN';
  try {
    const t0 = Date.now();
    const rec = await recognizeImage(f.path, f.scale, f.rw, targetLang);
    const dataUrl = `data:image/png;base64,${fs.readFileSync(f.path).toString('base64')}`;
    debugLog(`[live] 第 ${f.seq} 帧识别 ${Date.now() - t0}ms，${rec.paragraphs.length} 段`);
    if (myGen !== gen || !active) return;
    latest = { rec, dataUrl, gen: myGen };
    // 先用缓存里有的译文马上画；没翻过的段原文不动，翻完再画一次
    await render(latest, true);
    translatePending();
  } catch (e: any) {
    debugLog(`[live] 识别出错：${e?.message || e}`);
  } finally {
    drop();
    busy = false;
    if (active && !interacting) send({ cmd: 'want' });
  }
}

async function render(item: { rec: Recognized; dataUrl: string; gen: number }, cachedOnly: boolean) {
  if (!win || win.isDestroyed() || item.gen !== gen) return;
  const config = getConfig();
  const out = await translateRecognized(item.rec, config.targetLanguage || 'zh-CN', config, { cache, cachedOnly });
  if (!win || win.isDestroyed() || item.gen !== gen || latest !== item) return;
  win.webContents.send('show-translation', {
    screenshotPath: '', screenshotDataUrl: item.dataUrl,
    blocks: out.blocks, eraseRects: out.eraseRects, keepRects: out.keepRects, live: true,
  });
}

/// 最新一帧里还有没翻过的段：发一批去翻，翻完存进缓存，再按最新一帧重画。
/// 翻译期间又来了新帧，翻完后接着补新帧里没翻过的
async function translatePending() {
  if (translating || !latest) return;
  const item = latest;
  const config = getConfig();
  const targetLang = config.targetLanguage || 'zh-CN';
  translating = true;
  try {
    const before = cache.size;
    await translateRecognized(item.rec, targetLang, config, { cache });
    if (cache.size !== before && latest === item) await render(item, true);
  } catch (e: any) {
    debugLog(`[live] 翻译出错：${e?.message || e}`);
  } finally {
    translating = false;
  }
  if (latest && latest !== item) translatePending();
}

// 窗口上的按钮和边缘：页面告诉主进程鼠标在不在可操作的地方，在就关掉穿透
ipcMain.on('live-pass-through', (event, on: boolean) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  win.setIgnoreMouseEvents(on, { forward: true });
});
ipcMain.on('live-close', (event) => {
  if (win && event.sender === win.webContents) stopLive();
});
ipcMain.on('live-move-by', (event, { dx, dy }: { dx: number; dy: number }) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
});
ipcMain.on('live-resize-edge', (event, { mode, dx, dy }: { mode: string; dx: number; dy: number }) => {
  if (!win || win.isDestroyed() || event.sender !== win.webContents) return;
  const b = win.getBounds();
  let { x, y, width, height } = b;
  if (mode.includes('e')) width += dx;
  if (mode.includes('s')) height += dy;
  if (mode.includes('w')) { x += dx; width -= dx; }
  if (mode.includes('n')) { y += dy; height -= dy; }
  if (width < 80 || height < 40 + BAR) return;
  win.setBounds({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
});

app.on('will-quit', () => { if (active) stopLive(); });
