import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('api', {
  confirmSelection: (rect: { x: number; y: number; width: number; height: number }) => {
    ipcRenderer.send('selection-confirm', rect);
  },
  cancelSelection: () => {
    ipcRenderer.send('selection-cancel');
  },
  onBackground: (callback: (dataUrl: string) => void) => {
    ipcRenderer.on('selection-background', (_e, dataUrl) => callback(dataUrl));
  },
});

// 快捷键设置（renderer/keys.js 用它按设置匹配按键）
contextBridge.exposeInMainWorld('ttyConfig', {
  keys: () => ipcRenderer.sendSync('tty-keys'),
});
