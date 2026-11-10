import { powerSaveBlocker } from 'electron';
import type { AppHandle } from '../server/app.js';

/**
 * "Houd de pc wakker terwijl routines of taken lopen" (A-76): the server's power module decides when and why; this
 * holds Electron's powerSaveBlocker ("prevent-app-suspension": no sleep, the screen may still turn off) for exactly
 * that time. `onChange` refreshes the tray, which shows "Pc blijft wakker: …" while it is held.
 */
export function attachPowerBlocker(handle: AppHandle, onChange: () => void): { reason(): string | null; held(): boolean; dispose(): void } {
  let id: number | null = null;
  let why: string | null = null;
  const svc = handle.ctx.services.power;
  if (!svc?.attach) return { reason: () => null, held: () => false, dispose() {} };
  const detach = svc.attach({
    set(active: boolean, reason: string | null) {
      if (active && id === null) id = powerSaveBlocker.start('prevent-app-suspension');
      if (!active && id !== null) {
        if (powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
        id = null;
      }
      why = active ? reason : null;
      onChange();
    },
  });
  return {
    reason: () => why,
    /** Electron really holds the blocker now (for the live check). */
    held: () => id !== null && powerSaveBlocker.isStarted(id),
    dispose() {
      detach();
      if (id !== null && powerSaveBlocker.isStarted(id)) powerSaveBlocker.stop(id);
      id = null;
    },
  };
}
