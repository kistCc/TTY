import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  onShowTranslation: (callback: (data: any) => void) => {
    ipcRenderer.on('show-translation', (_event, data) => callback(data));
  },
  close: () => {
    ipcRenderer.send('region-overlay-close');
  },
  // 区域浮层和全屏浮层共用 overlay.js，它用的是 dismiss / onClear 这两个名字
  dismiss: () => {
    ipcRenderer.send('region-overlay-close');
  },
  onClear: (callback: () => void) => {
    ipcRenderer.on('clear', () => callback());
  },
  moveBy: (dx: number, dy: number) => {
    ipcRenderer.send('region-overlay-move-by', { dx, dy });
  },
  resizeBy: (delta: number) => {
    ipcRenderer.send('region-overlay-resize-by', { delta });
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
    ipcRenderer.send('region-overlay-resize-edge', { mode, dx, dy });
  },
});
