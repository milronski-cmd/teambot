// Electron side of tests/e2e/remote-indicator-check.mjs: the real stop bar of remote desktop (desktop/remote-indicator.ts)
// with TeamBot's server in a TEMPORARY data folder and a dry-run screen driver. Nothing reaches the owner's desktop:
// the bar is made fully transparent and click-through when it shows, Stop is pressed inside the page (never with the
// mouse), and Windows notifications are recorded instead of shown.
import { app, BrowserWindow, Notification, screen } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { createApp } from '../../server/app.js';
import { tr } from '../../server/core/i18n.js';
import { RemoteIndicator } from '../../desktop/remote-indicator.js';

const dir = process.env.TEAMBOT_DATA!;
const out = (o: any) => process.stdout.write('@@' + JSON.stringify(o) + '\n');
const check = (name: string, ok: boolean, detail = '') => out({ check: name, ok, detail });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
app.setPath('userData', path.join(dir, 'electron'));
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.on('window-all-closed', () => {});

const shown: BrowserWindow[] = [];
const showInactive = BrowserWindow.prototype.showInactive;
BrowserWindow.prototype.showInactive = function (this: BrowserWindow) {
  shown.push(this);
  this.setOpacity(0);
  this.setIgnoreMouseEvents(true);
  return showInactive.call(this);
};
const toasts: { title: string; body: string }[] = [];
Notification.prototype.show = function (this: Notification) {
  toasts.push({ title: this.title, body: this.body });
};

async function until<T>(fn: () => T | Promise<T>, ms = 5000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(50);
  }
}

app.whenReady().then(async () => {
  let handle: Awaited<ReturnType<typeof createApp>> | null = null;
  try {
    handle = await createApp({ dataDir: path.join(dir, 'data'), port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
    handle.ctx.auth.ensureLocalOwner();
    const owner = handle.ctx.auth.owner()!;
    const rd = handle.ctx.services.remoteDesktop;
    const svc = rd._service;
    const input: string[] = [];
    svc.setDriver({
      async call(action: string, i: any) {
        if (action === 'monitors') return { monitors: [{ index: 0, x: 0, y: 0, w: 1920, h: 1080, primary: true, dpi: 96 }] };
        if (action === 'shot') {
          fs.writeFileSync(i.out, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
          return {};
        }
        input.push(action);
        return { ok: true };
      },
      kill() {},
    });

    check('zonder de balk kan het niet aan', svc.unavailable() === 'app');
    const bar = new RemoteIndicator(() => rd, () => 'nl', () => {}, (t, ...v) => tr('nl', t, ...v));
    bar.start();
    check('met de balk is het beschikbaar', svc.unavailable() === null);
    svc.configure(owner, { enabled: true });
    const auth = handle.ctx.auth.createSession(owner.id, 'device', 'Test-iPhone');
    const session = svc.start(owner, { id: auth.id, kind: 'device', name: 'Test-iPhone' }, { ip: '127.0.0.1' });

    const w = await until(() => shown.find((x) => !x.isDestroyed() && x.isVisible()) || null);
    check('de balk verschijnt zodra iemand meekijkt', !!w);
    if (!w) throw new Error('geen balk');
    const text = async () => w.webContents.executeJavaScript("[document.getElementById('who').textContent, document.getElementById('what').textContent, document.getElementById('stop').textContent, document.getElementById('stop').getAttribute('aria-label')]");
    const [who, what, stop, label] = (await until(async () => {
      const t = await text();
      return t[0] ? t : null;
    }))!;
    check('de balk zegt wie meekijkt', who === 'Test-iPhone kijkt mee op deze computer', who);
    check('met uitleg en een Stop-knop', /Stop zet het uit/.test(what) && stop === 'Stop' && /Test-iPhone/.test(label), `${what} | ${stop} | ${label}`);
    check('altijd bovenop, neemt geen focus', w.isAlwaysOnTop() && !w.isFocusable() && !w.isFocused());
    const wa = screen.getPrimaryDisplay().workArea;
    const b = w.getBounds();
    check('bovenaan in het midden van het hoofdscherm', Math.abs(b.x + b.width / 2 - (wa.x + wa.width / 2)) <= 2 && b.y === wa.y + 8, JSON.stringify(b));
    check('een Windows-melding bij de eerste sessie', toasts.some((t) => t.title === 'Test-iPhone kijkt mee op deze computer'), JSON.stringify(toasts));
    if (typeof (w as any).isContentProtected === 'function') check('niet in schermopnames', (w as any).isContentProtected() === true);

    // controlling: the text follows
    await svc.input(session, owner, { type: 'click', x: 0.5, y: 0.5 });
    const ctl = await until(async () => ((await text())[0] === 'Test-iPhone bedient deze computer' ? true : null));
    check('na een klik: "bedient deze computer"', !!ctl);

    // Stop, pressed in the page (as the owner's click would)
    await w.webContents.executeJavaScript("document.getElementById('stop').click()");
    const stopped = await until(() => (!svc.settings().enabled && !svc.state().sessions.length ? true : null));
    check('Stop beëindigt de sessie en zet het uit', !!stopped, JSON.stringify(svc.state()));
    check('met een melding dat het gestopt is', toasts.some((t) => t.title === 'Bureaublad op afstand gestopt'));
    const hidden = await until(() => (!w.isVisible() ? true : null));
    check('de balk verdwijnt', !!hidden);
    const audit = handle.ctx.store.all<any>("SELECT kind, data FROM audit WHERE kind = 'remote_desktop.off'").map((r) => JSON.parse(r.data));
    check('in het logboek: gestopt met de stopknop', audit.some((a) => a.source === 'stopknop'), JSON.stringify(audit));
    check('alleen de proef-schermhulp kreeg invoer', input.join(',') === 'click', input.join(','));

    bar.stop();
    check('zonder de balk weer niet beschikbaar', svc.unavailable() === 'app');
  } catch (e: any) {
    check('fout', false, String(e?.stack || e));
  } finally {
    await handle?.close().catch(() => {});
    out({ done: true });
    app.exit(0);
  }
});
