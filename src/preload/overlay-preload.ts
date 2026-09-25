import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  onShowTranslation: (callback: (data: any) => void) => {
    ipcRenderer.on('show-translation', (_event, data) => callback(data));
  },
  onClear: (callback: () => void) => {
    ipcRenderer.on('clear', () => callback());
  },
  dismiss: () => {
    ipcRenderer.send('dismiss-overlay');
  },
  moveBy: (dx: number, dy: number) => {
    ipcRenderer.send('overlay-move-by', { dx, dy });
  },
  resizeBy: (delta: number) => {
    ipcRenderer.send('overlay-resize-by', { delta });
  },
  focusWindow: () => {
    ipcRenderer.send('sticker-focus');
  },
  copyImage: (dataUrl: string) => {
    ipcRenderer.send('sticker-copy-image', dataUrl);
  },
  copyText: (text: string) => {
    ipcRenderer.send('sticker-copy-text', text);
  },
  resizeEdge: (mode: string, dx: number, dy: number) => {
    ipcRenderer.send('overlay-resize-edge', { mode, dx, dy });
  },
});

// 快捷键设置（renderer/keys.js 用它按设置匹配按键）
contextBridge.exposeInMainWorld('ttyConfig', {
  keys: () => ipcRenderer.sendSync('tty-keys'),
});
