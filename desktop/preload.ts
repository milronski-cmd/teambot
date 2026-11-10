// Minimal bridge. The UI works identically in a normal browser; this only adds desktop niceties (info, external
// links, app updates). Every handler in the main process checks that the call comes from the TeamBot UI itself.
import { contextBridge, ipcRenderer } from 'electron';

contextBridge.exposeInMainWorld('teambotDesktop', {
  isDesktop: true,
  /** The shell shows Windows notifications itself (with buttons), so the page does not add web notifications. */
  nativeNotifications: true,
  /** Bring the main window to the front, optionally at a route (#/t/…). */
  show: (hash?: string) => ipcRenderer.invoke('teambot:show', hash),
  /** Floating status window: off / auto (while something runs or waits) / always. */
  statusWindow: {
    get: () => ipcRenderer.invoke('teambot:status:get'),
    set: (mode: 'off' | 'auto' | 'always') => ipcRenderer.invoke('teambot:status:set', mode),
    hide: () => ipcRenderer.invoke('teambot:status:hide'),
  },
  info: () => ipcRenderer.invoke('teambot:info'),
  /** Start TeamBot again (a staged backup restore is put in place at the next start). */
  restart: () => ipcRenderer.invoke('teambot:restart'),
  /** What waits for the owner (taskbar overlay / dock count / tray). The page sends it debounced, only on change. */
  setBadge: (counts: { waiting: number; unread: number }) => ipcRenderer.send('teambot:badge', counts),
  openExternal: (url: string) => ipcRenderer.invoke('teambot:openExternal', url),
  /** Open a bot's werkplek (its own folder) in Explorer / Finder. */
  openWerkplek: (agentId: string) => ipcRenderer.invoke('teambot:openWerkplek', agentId),
  /** Picture-in-picture window with a bot's live screen ("browser" or "desktop"). */
  pip: (agentId: string, kind: 'browser' | 'desktop' = 'browser') => ipcRenderer.invoke('teambot:pip', agentId, kind),
  // The update status, "Nu bijwerken" and the settings go through the server (/api/app-update), also on the phone.
  update: {
    /** "Terug naar versie x": reinstall the previous version and put the backup from right before the update back. */
    rollback: () => ipcRenderer.invoke('teambot:update:rollback'),
  },
});
