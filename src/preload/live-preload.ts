import { contextBridge, ipcRenderer } from 'electron';

// 实时翻译窗口：和贴图共用 overlay.html / overlay.js，接口名一样，接到实时翻译自己的处理上。
// 窗口拿不到键盘焦点（不抢正在用的软件的焦点），所以复制、看原文这类按键在这里不起作用。
contextBridge.exposeInMainWorld('api', {
  onShowTranslation: (callback: (data: any) => void) => {
    ipcRenderer.on('show-translation', (_event, data) => callback(data));
  },
  onClear: (callback: () => void) => {
    ipcRenderer.on('clear', () => callback());
  },
  dismiss: () => ipcRenderer.send('live-close'),
  moveBy: (dx: number, dy: number) => ipcRenderer.send('live-move-by', { dx, dy }),
  resizeBy: (_delta: number) => {},
  resizeEdge: (mode: string, dx: number, dy: number) => ipcRenderer.send('live-resize-edge', { mode, dx, dy }),
  copyImage: (_dataUrl: string) => {},
  copyText: (_text: string) => {},
  /// true：鼠标穿透到下面的软件；false：窗口自己接鼠标（在边缘、按钮上时）
  passThrough: (on: boolean) => ipcRenderer.send('live-pass-through', on),
});

contextBridge.exposeInMainWorld('ttyConfig', {
  keys: () => ipcRenderer.sendSync('tty-keys'),
});
