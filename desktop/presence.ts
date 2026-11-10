import { powerMonitor } from 'electron';
import type { AppHandle } from '../server/app.js';

/**
 * "Zit je achter de pc?" (0.4.4, P8): every few seconds, and right away when the screen locks or unlocks, tell the
 * server how long keyboard and mouse have been still and whether the screen is locked. The server decides from that
 * whether an alert also goes to the phone (server/modules/mobile/presence.ts). Only these two facts are passed on.
 */
export const PRESENCE_EVERY_MS = 5_000;

export function attachPresence(handle: AppHandle): () => void {
  let locked = false;
  const report = () => {
    try {
      const owner = handle.ctx.auth.owner();
      const svc = handle.ctx.services.mobile;
      if (!owner || typeof svc?.reportPresence !== 'function') return;
      svc.reportPresence(owner.id, { idleSeconds: powerMonitor.getSystemIdleTime(), locked });
    } catch {
      /* the server is stopping */
    }
  };
  const onLock = () => {
    locked = true;
    report();
  };
  const onUnlock = () => {
    locked = false;
    report();
  };
  powerMonitor.on('lock-screen', onLock);
  powerMonitor.on('unlock-screen', onUnlock);
  // Sleeping counts as away; waking up is reported on the next tick.
  powerMonitor.on('suspend', onLock);
  powerMonitor.on('resume', onUnlock);
  const timer = setInterval(report, PRESENCE_EVERY_MS);
  timer.unref?.();
  report();
  return () => {
    clearInterval(timer);
    powerMonitor.off('lock-screen', onLock);
    powerMonitor.off('unlock-screen', onUnlock);
    powerMonitor.off('suspend', onLock);
    powerMonitor.off('resume', onUnlock);
  };
}
