import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('input', {
  onShow: (cb: (data: any) => void) => ipcRenderer.on('input-show', (_e, d) => cb(d)),
  onPending: (cb: (data: any) => void) => ipcRenderer.on('input-pending', (_e, d) => cb(d)),
  onResult: (cb: (data: any) => void) => ipcRenderer.on('input-result', (_e, d) => cb(d)),
  translate: (text: string) => ipcRenderer.send('input-translate', text),
  close: () => ipcRenderer.send('input-close'),
  copy: (text: string) => ipcRenderer.send('input-copy', text),
  reportHeight: (height: number) => ipcRenderer.send('input-height', height),
});

// 快捷键设置（renderer/keys.js 用它按设置匹配按键）
contextBridge.exposeInMainWorld('ttyConfig', {
  keys: () => ipcRenderer.sendSync('tty-keys'),
});
