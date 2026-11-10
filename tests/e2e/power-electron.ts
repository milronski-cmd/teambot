// Electron side of tests/e2e/power-check.mjs (A-76). Runs the real desktop code (desktop/power.ts) with Electron's
// real powerSaveBlocker and TeamBot's server in a TEMPORARY data folder. No window and no tray icon; nothing is shown,
// focused or clicked. The computer is kept awake for a few seconds at most and released again.
import { app } from 'electron';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../../server/app.js';
import { attachPowerBlocker } from '../../desktop/power.js';

const dir = process.env.TB_POWER_DIR!;
const out = (o: any) => process.stdout.write('@@' + JSON.stringify(o) + '\n');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(dir, 'electron'));

/** Windows lists who keeps the system awake; needs no window, may need admin rights (then: unknown). */
function powerRequests(): string | null {
  if (process.platform !== 'win32') return null;
  try {
    return execFileSync('powercfg', ['/requests'], { encoding: 'utf8', timeout: 10_000, windowsHide: true });
  } catch {
    return null;
  }
}

app.whenReady().then(async () => {
  let code = 0;
  const check = (name: string, ok: boolean, detail = '') => {
    if (!ok) code = 1;
    out({ check: name, ok, detail });
  };
  const handle = await createApp({ dataDir: path.join(dir, 'data'), mode: 'desktop', host: '127.0.0.1', port: 0, quiet: true });
  let trayRefresh = 0;
  const power = attachPowerBlocker(handle, () => trayRefresh++);
  try {
    const ctx = handle.ctx;
    const owner = ctx.auth.owner() || (ctx.auth.ensureLocalOwner(), ctx.auth.owner())!;
    let s = ctx.services.power.state();
    check('desktop-app: optie beschikbaar, standaard uit', s.available === true && s.enabled === false, JSON.stringify(s));
    // A routine that starts in 10 minutes (the owner's TeamBot), option still off: nothing held.
    const agent = ctx.store.createAgent(owner.id, { name: 'Nachtwacht' });
    const now = Date.now();
    ctx.store.insert('routines', { id: 'rt_live', user_id: owner.id, agent_id: agent.id, name: 'Ochtendnieuws', prompt: 'x', status: 'active', schedule: { kind: 'none' }, timezone: 'Europe/Amsterdam', options: {}, next_run_at: new Date(now + 10 * 60_000).toISOString(), created_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() });
    ctx.services.power.evaluate();
    check('optie uit: powerSaveBlocker niet actief', !power.held());
    // Switched on (as Settings › Algemeen does): Electron holds the blocker, the tray shows why.
    ctx.store.setSetting(owner.id, 'keepAwake', true);
    s = ctx.services.power.evaluate();
    await sleep(200);
    check('optie aan + routine binnen 30 min: powerSaveBlocker actief', power.held() && s.active, JSON.stringify(s));
    check('systeemvak krijgt de reden', /Ochtendnieuws/.test(String(power.reason())) && trayRefresh > 0, String(power.reason()));
    const req = powerRequests();
    if (req !== null) check('Windows ziet het verzoek (powercfg /requests)', /electron|teambot/i.test(req), req.replace(/\s+/g, ' ').slice(0, 300));
    else out({ note: 'powercfg /requests niet leesbaar (rechten); Electron meldt isStarted = ' + power.held() });
    // Nothing due any more: released.
    ctx.store.exec('UPDATE routines SET next_run_at = ? WHERE id = ?', new Date(now + 20 * 3600_000).toISOString(), 'rt_live');
    ctx.services.power.evaluate();
    await sleep(200);
    check('niets meer te doen: losgelaten', !power.held() && power.reason() === null);
    // Turned on again and then the app quits: released.
    ctx.store.exec('UPDATE routines SET next_run_at = ? WHERE id = ?', new Date(now + 5 * 60_000).toISOString(), 'rt_live');
    ctx.services.power.evaluate();
    check('weer actief', power.held());
  } catch (e: any) {
    check('onverwachte fout', false, String(e?.stack || e));
  } finally {
    power.dispose();
    check('afsluiten laat het los', !power.held());
    await handle.close().catch(() => {});
    app.exit(code);
  }
});
