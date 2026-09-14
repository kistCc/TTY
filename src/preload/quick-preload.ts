import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('quick', {
  onShow: (cb: (data: any) => void) => ipcRenderer.on('quick-show', (_e, d) => cb(d)),
  onResult: (cb: (data: any) => void) => ipcRenderer.on('quick-result', (_e, d) => cb(d)),
  close: () => ipcRenderer.send('quick-close'),
  copy: (text: string) => ipcRenderer.send('quick-copy', text),
  reportHeight: (height: number) => ipcRenderer.send('quick-height', height),
  openAccessibility: () => ipcRenderer.send('quick-open-ax'),
});
