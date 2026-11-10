// Bridge for the dictation pill (desktop/dictation-overlay.ts): commands in, microphone PCM and status out. Only this
// small window gets it; the main process checks every message comes from that window.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('tbDictation', {
  onCommand: (fn: (cmd: string, data: unknown) => void) => {
    ipcRenderer.on('dictation:cmd', (_e, cmd: string, data: unknown) => fn(cmd, data));
  },
  started: () => ipcRenderer.send('dictation:started'),
  stopped: () => ipcRenderer.send('dictation:stopped'),
  error: (msg: string) => ipcRenderer.send('dictation:error', String(msg).slice(0, 300)),
  pcm: (buf: ArrayBuffer, level: number) => ipcRenderer.send('dictation:pcm', buf, Number(level) || 0),
});
