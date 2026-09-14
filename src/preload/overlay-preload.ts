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
  resizeEdge: (mode: string, dx: number, dy: number) => {
    ipcRenderer.send('overlay-resize-edge', { mode, dx, dy });
  },
});
