// Bureaublad op afstand (parity 11.7): see and control the whole desktop from the paired phone or another PC.
// Everything here runs against a dry-run screen driver: nothing ever moves the real mouse or presses a real key, and no
// picture of the real desktop is taken (the "frames" are a few fixed bytes).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { startTestApp, type TestApp } from './helpers.js';
import { cleanSettings, cursorOn, driverCall, frameGeometry, frameQuality, ownerKeys, ownerPolicy, parseInput, toPhysical } from '../server/modules/remote-desktop/core.js';
import { indicatorView } from '../server/modules/remote-desktop/indicator.js';
import type { RemoteDesktopService } from '../server/modules/remote-desktop/service.js';
import { Adaptive, clampView, frameSide, fitRect, Gestures, keyInput, LEVELS, LONG_PRESS_MS, nextDelay, NO_ZOOM, panBy, SCROLL_STEP_PX, shownRect, toPicture, typedChange, zoomAt, type Box } from '../ui/src/modules/remote-desktop/logic.js';
import { describeAudit } from '../ui/src/shell/auditText.js';
import { SCREEN_PS1 } from '../server/modules/browser/screen.ps1.js';

const PRIMARY = { index: 0, x: 0, y: 0, w: 1920, h: 1080, primary: true, dpi: 144 };
const LEFT = { index: 1, x: -2560, y: -360, w: 2560, h: 1440, primary: false, dpi: 96 };

// ---------------------------------------------------------------- pure: server core

test('settings: off by default, only known idle choices', () => {
  const d = cleanSettings(undefined);
  assert.equal(d.enabled, false, 'remote desktop is off until the owner switches it on');
  assert.equal(d.control, true);
  assert.equal(d.idleMinutes, 10);
  assert.equal(cleanSettings({ idleMinutes: 7 }).idleMinutes, 10, 'not a choice → stays');
  assert.equal(cleanSettings({ idleMinutes: 30, enabled: 'yes' }).idleMinutes, 30);
  assert.equal(cleanSettings({ enabled: 'yes' }).enabled, false, 'only a real boolean switches');
});

test('frames: the whole monitor, long side clamped, never enlarged; quality 20-90', () => {
  const g = frameGeometry(PRIMARY, 1440);
  assert.deepEqual([g.x, g.y, g.w, g.h, g.shotW, g.shotH], [0, 0, 1920, 1080, 1440, 810]);
  assert.equal(frameGeometry(PRIMARY, 99999).shotW, 1920, 'never larger than the screen');
  assert.equal(frameGeometry(PRIMARY, 10).shotW, 320, 'not smaller than 320');
  assert.equal(frameGeometry(PRIMARY, 'x').shotW, 1440, 'nonsense → the default');
  const l = frameGeometry(LEFT, 1280);
  assert.deepEqual([l.x, l.y, l.shotW, l.shotH], [-2560, -360, 1280, 720], 'a monitor left of and above the main one');
  assert.equal(frameQuality(5), 20);
  assert.equal(frameQuality(150), 90);
  assert.equal(frameQuality(undefined), 55);
});

test('a point on the picture becomes the right physical pixel, also on a monitor with negative coordinates', () => {
  assert.deepEqual(toPhysical(PRIMARY, 0.5, 0.5), { x: 960, y: 540 });
  assert.deepEqual(toPhysical(PRIMARY, 1, 1), { x: 1919, y: 1079 }, 'the last pixel, not one beyond');
  assert.deepEqual(toPhysical(PRIMARY, -3, 7), { x: 0, y: 1079 }, 'clamped to the monitor');
  assert.deepEqual(toPhysical(LEFT, 0, 0), { x: -2560, y: -360 });
  assert.deepEqual(toPhysical(LEFT, 0.25, 0.5), { x: -1920, y: 360 });
  assert.throws(() => toPhysical(PRIMARY, 'a', 0), /getal/);
  const c = cursorOn(LEFT, { x: -1280, y: 360 })!;
  assert.ok(Math.abs(c.x - 0.5) < 0.001 && Math.abs(c.y - 0.5) < 0.001);
  assert.equal(cursorOn(PRIMARY, { x: -5, y: 10 }), null, 'the pointer on another monitor is not drawn');
});

test('input from the viewer is validated (untrusted)', () => {
  assert.deepEqual(parseInput({ type: 'click', x: 0.2, y: 0.3 }), { type: 'click', x: 0.2, y: 0.3, button: 'left', count: 1 });
  assert.equal((parseInput({ type: 'click', x: 0.2, y: 0.3, button: 'right', count: 9 }) as any).count, 3);
  assert.equal((parseInput({ type: 'click', x: 0.2, y: 0.3, button: 'evil' }) as any).button, 'left');
  assert.deepEqual(parseInput({ type: 'scroll', x: 0.5, y: 0.5, dy: 500 }), { type: 'scroll', x: 0.5, y: 0.5, dy: 30, dx: 0 });
  assert.throws(() => parseInput({ type: 'scroll', x: 0.5, y: 0.5 }), /scrold/);
  assert.equal((parseInput({ type: 'type', text: 'a\r\nb\u0007c' }) as any).text, 'a\nbc', 'no control characters except a new line');
  assert.throws(() => parseInput({ type: 'type', text: 'x'.repeat(2001) }), /2000/);
  assert.throws(() => parseInput({ type: 'shell', cmd: 'calc' }), /Onbekende/);
  assert.throws(() => parseInput({ type: 'click', x: null, y: 0 }), /getal/);
});

test('owner keys: Alt+Tab, the Windows key and Esc are fine; Ctrl+Alt+Del is not', () => {
  assert.deepEqual(ownerKeys('alt+tab').vks, [[0x12, 0x09]]);
  assert.deepEqual(ownerKeys('win').vks, [[0x5b]]);
  assert.deepEqual(ownerKeys('ctrl+c').vks, [[0x11, 0x43]]);
  assert.deepEqual(ownerKeys('esc alt+f4').names, [['esc'], ['alt', 'f4']]);
  assert.throws(() => ownerKeys('ctrl+alt+delete'), /Ctrl\+Alt\+Del/);
  assert.throws(() => ownerKeys('ctrl+alt+end'), /Ctrl\+Alt\+Del/);
  assert.throws(() => ownerKeys(Array(11).fill('a')), /10/);
  assert.throws(() => ownerKeys('hyper+x'), /Onbekende toets/);
});

test('driver requests carry the owner policy: whole screen, every app, TeamBot still blocked by the driver', () => {
  const p = ownerPolicy();
  assert.deepEqual(p, { allow: [], full: true, all: true, block: [], blockTitle: '', owner: true });
  const c = driverCall(parseInput({ type: 'click', x: 0.5, y: 0.5, button: 'right' }), LEFT);
  assert.equal(c.action, 'click');
  assert.deepEqual([c.payload.x, c.payload.y, c.payload.button], [-1280, 360, 'right']);
  assert.equal(c.payload.policy.owner, true);
  const k = driverCall(parseInput({ type: 'key', keys: 'alt+tab' }), PRIMARY);
  assert.deepEqual(k.payload.combos, [[0x12, 0x09]]);
  const d = driverCall(parseInput({ type: 'drag', x: 0, y: 0, x2: 1, y2: 1 }), PRIMARY);
  assert.deepEqual([d.payload.x, d.payload.y, d.payload.x2, d.payload.y2], [0, 0, 1919, 1079]);
  // the .NET driver: owner mode relaxes only the bot rules (keys, password fields); the hard blocks stay
  assert.match(SCREEN_PS1, /p\.Owner = B\(d, "owner"\)/);
  assert.match(SCREEN_PS1, /HardBlock = new string\[\] \{ "teambot", "electron", "consent", "credentialuibroker", "lockapp", "logonui"/);
  assert.match(SCREEN_PS1, /if \(p\.Owner\) \{\s*\/\/[^\n]*\n\s*if \(set\.Contains\(0x11\) && set\.Contains\(0x12\) && \(set\.Contains\(0x2E\) \|\| set\.Contains\(0x23\)\)\)/);
  assert.match(SCREEN_PS1, /Dit venster kun je op afstand niet bedienen/);
});

test('indicator on the PC: who watches or controls, and Stop', () => {
  assert.equal(indicatorView([]), null);
  const one = indicatorView([{ device: 'iPhone van Sanne', controlling: false }])!;
  assert.equal(one.title, 'iPhone van Sanne kijkt mee op deze computer');
  assert.equal(one.stop, 'Stop');
  assert.match(one.detail, /Stop zet het uit/);
  assert.equal(indicatorView([{ device: 'iPhone van Sanne', controlling: true }])!.title, 'iPhone van Sanne bedient deze computer');
  assert.equal(indicatorView([{ device: 'a', controlling: false }, { device: 'b', controlling: true }])!.title, '2 apparaten kijken mee op deze computer');
});

// ---------------------------------------------------------------- pure: the viewer

const BOX: Box = { cw: 400, ch: 800, iw: 1920, ih: 1080 };

test('view: the screen fits, zoom keeps the point under the fingers, panning stops at the edges', () => {
  const f = fitRect(BOX);
  assert.equal(f.w, 400);
  assert.equal(f.h, 225);
  assert.equal(f.y, (800 - 225) / 2);
  const mid = toPicture(BOX, NO_ZOOM, 200, 400)!;
  assert.ok(Math.abs(mid.x - 0.5) < 1e-9 && Math.abs(mid.y - 0.5) < 1e-9);
  assert.equal(toPicture(BOX, NO_ZOOM, 200, 100), null, 'above the picture is not the picture');
  const before = toPicture(BOX, NO_ZOOM, 150, 400)!;
  const z = zoomAt(BOX, NO_ZOOM, 4, 150, 400);
  assert.equal(z.z, 4);
  const after = toPicture(BOX, z, 150, 400)!;
  assert.ok(Math.abs(before.x - after.x) < 1e-9 && Math.abs(before.y - after.y) < 1e-9, 'the point under the fingers stays');
  const far = panBy(BOX, z, 10_000, 0);
  assert.equal(shownRect(BOX, far).x, 0, 'not beyond the left edge');
  assert.equal(zoomAt(BOX, NO_ZOOM, 0.2, 10, 10).z, 1, 'never smaller than the whole screen');
  assert.equal(zoomAt(BOX, NO_ZOOM, 100, 10, 10).z, 8);
  assert.deepEqual(clampView(BOX, { z: 1, tx: 50, ty: -40 }), { z: 1, tx: 0, ty: 0 }, 'at zoom 1 the picture stays centered');
});

test('gestures: tap = click, a quick second tap = double click on the same spot', () => {
  const g = new Gestures(() => false);
  assert.deepEqual(g.down(1, 100, 100, 0), []);
  assert.deepEqual(g.up(1, 102, 101, 80), [{ kind: 'click', x: 100, y: 100, count: 1 }]);
  g.down(1, 110, 108, 250);
  assert.deepEqual(g.up(1, 110, 108, 300), [{ kind: 'click', x: 100, y: 100, count: 2 }], 'second tap snaps onto the first');
  g.down(1, 110, 108, 1500);
  assert.deepEqual(g.up(1, 110, 108, 1550), [{ kind: 'click', x: 110, y: 108, count: 1 }], 'too late for a double click');
});

test('gestures: hold = right click; hold and drag = drag; quick drag drags, or pans when zoomed', () => {
  let zoomed = false;
  const g = new Gestures(() => zoomed);
  g.down(1, 50, 50, 0);
  assert.equal(g.pressDue(), LONG_PRESS_MS);
  assert.deepEqual(g.tick(LONG_PRESS_MS - 1), []);
  assert.deepEqual(g.tick(LONG_PRESS_MS), [{ kind: 'press', x: 50, y: 50 }]);
  assert.deepEqual(g.up(1, 52, 51, 700), [{ kind: 'right', x: 50, y: 50 }]);

  g.down(1, 50, 50, 1000);
  g.tick(1000 + LONG_PRESS_MS);
  assert.deepEqual(g.move(1, 150, 60, 1700), [{ kind: 'line', x: 50, y: 50, x2: 150, y2: 60 }]);
  assert.deepEqual(g.up(1, 200, 80, 1800), [{ kind: 'clear' }, { kind: 'drag', x: 50, y: 50, x2: 200, y2: 80 }]);

  g.down(1, 50, 50, 3000);
  assert.deepEqual(g.move(1, 55, 50, 3010), [], 'within the touch slop');
  assert.equal(g.move(1, 90, 50, 3050)[0].kind, 'line');
  assert.equal(g.up(1, 90, 50, 3100)[1].kind, 'drag');

  zoomed = true;
  g.down(1, 50, 50, 5000);
  assert.deepEqual(g.move(1, 80, 70, 5020), [{ kind: 'pan', dx: 30, dy: 20 }]);
  assert.deepEqual(g.move(1, 90, 70, 5040), [{ kind: 'pan', dx: 10, dy: 0 }]);
  assert.deepEqual(g.up(1, 90, 70, 5100), [], 'panning sends nothing to the computer');
});

test('gestures: two fingers together scroll (fingers up = scroll down), pinching zooms, a two-finger tap right-clicks', () => {
  const g = new Gestures(() => false);
  g.down(1, 100, 300, 0);
  g.down(2, 200, 300, 10);
  assert.deepEqual(g.move(1, 100, 290, 20), [], 'not decided yet');
  const outs = [];
  // both fingers up, reported one after the other in small steps (as a phone does)
  for (let y = 294; y >= 300 - SCROLL_STEP_PX * 2; y -= 6) outs.push(...g.move(1, 100, y, 30), ...g.move(2, 200, y, 30));
  const scroll = outs.filter((o) => o.kind === 'scroll');
  const total = scroll.reduce((n, o: any) => n + o.dy, 0);
  assert.ok(total >= 1, `scrolls down: ${JSON.stringify(outs)}`);
  assert.ok(scroll.every((o: any) => o.x === 150 && o.y === 300), 'at the point between the fingers where it began');
  g.up(1, 0, 0, 100);
  g.up(2, 0, 0, 110);

  g.down(1, 100, 300, 1000);
  g.down(2, 200, 300, 1010);
  const z = g.move(2, 300, 300, 1050);
  assert.equal(z[0].kind, 'zoom');
  assert.ok((z[0] as any).factor > 1.5, 'fingers apart = zoom in');
  g.up(1, 0, 0, 1100);
  assert.deepEqual(g.up(2, 0, 0, 1110), [], 'a pinch is no click');

  g.down(1, 100, 300, 2000);
  g.down(2, 140, 300, 2010);
  g.up(1, 100, 300, 2100);
  assert.deepEqual(g.up(2, 140, 300, 2120), [], 'the second finger up after the first is the end of it');
  // the right click came with the first finger up
  g.down(1, 100, 300, 3000);
  g.down(2, 140, 300, 3010);
  assert.deepEqual(g.up(1, 100, 300, 3100), [{ kind: 'right', x: 120, y: 300 }]);
  g.up(2, 140, 300, 3110);
});

test('adaptive quality: slow pictures step down, fast ones step up after a while; a fixed choice stays', () => {
  const a = new Adaptive();
  assert.equal(a.current().id, 'normal');
  let t = 0;
  for (let i = 0; i < 5; i++) a.record(1200, (t += 500));
  assert.equal(a.current().id, 'fast', 'slow connection → smaller picture');
  for (let i = 0; i < 20; i++) a.record(1500, (t += 400));
  assert.equal(a.current().id, 'saver');
  assert.equal(LEVELS.length - 1, a.level, 'never below the lowest');
  for (let i = 0; i < 200; i++) a.record(120, (t += 200));
  assert.equal(a.current().id, 'sharp', 'a fast connection gets the sharp picture back');
  const fixed = new Adaptive('saver');
  for (let i = 0; i < 50; i++) fixed.record(50, i * 300);
  assert.equal(fixed.current().id, 'saver');
  assert.equal(frameSide(LEVELS[1], 1920, 1080), 1440);
  assert.equal(frameSide(LEVELS[1], 5120, 1440), 2560, 'a super-wide screen keeps readable height');
  assert.equal(frameSide(LEVELS[3], 1920, 480), 1620, 'the small 4:1 bar screen: as tall as a normal one');
  assert.equal(nextDelay({ tookMs: 40, unchanged: 0, sinceInputMs: 100 }), 40, 'right after a tap: fast');
  assert.equal(nextDelay({ tookMs: 40, unchanged: 5, sinceInputMs: 60_000 }), 600, 'a still screen: ease off');
  assert.equal(nextDelay({ tookMs: 300, unchanged: 0, sinceInputMs: 60_000 }), 0);
});

test('typing on the phone: only what changed (autocorrect may replace a word)', () => {
  assert.deepEqual(typedChange('', 'hallo'), { backspaces: 0, text: 'hallo' });
  assert.deepEqual(typedChange('hallo', 'hall'), { backspaces: 1, text: '' });
  assert.deepEqual(typedChange('ik ga nar', 'ik ga naar '), { backspaces: 1, text: 'ar ' });
  assert.deepEqual(typedChange('😀a', '😀b'), { backspaces: 1, text: 'b' }, 'an emoji is one character');
});

test('a real keyboard (browser on another PC): text, combos, AltGr', () => {
  assert.deepEqual(keyInput({ key: 'a' }), { type: 'type', text: 'a' });
  assert.deepEqual(keyInput({ key: 'A', shiftKey: true }), { type: 'type', text: 'A' });
  assert.deepEqual(keyInput({ key: 'Enter' }), { type: 'key', keys: 'enter' });
  assert.deepEqual(keyInput({ key: 'Tab', shiftKey: true }), { type: 'key', keys: 'shift+tab' });
  assert.deepEqual(keyInput({ key: 'c', code: 'KeyC', ctrlKey: true }), { type: 'key', keys: 'ctrl+c' });
  assert.deepEqual(keyInput({ key: 'T', code: 'KeyT', ctrlKey: true, shiftKey: true }), { type: 'key', keys: 'ctrl+shift+t' });
  assert.deepEqual(keyInput({ key: 'Tab', altKey: true }), { type: 'key', keys: 'alt+tab' });
  assert.deepEqual(keyInput({ key: '@', code: 'Digit2', ctrlKey: true, altKey: true, altGraph: true }), { type: 'type', text: '@' });
  assert.deepEqual(keyInput({ key: 'F5' }), { type: 'key', keys: 'f5' });
  assert.equal(keyInput({ key: 'Control', ctrlKey: true }), null);
  // every combo the viewer makes is one the server accepts
  for (const k of ['ctrl+c', 'ctrl+shift+t', 'alt+tab', 'shift+tab', 'f5', 'enter']) assert.doesNotThrow(() => ownerKeys(k));
});

test('security log: every remote-desktop event is a plain sentence', () => {
  const rows = [
    ['remote_desktop.on', { control: true, idleMinutes: 10 }, /bureaublad op afstand aangezet/],
    ['remote_desktop.off', { source: 'stopknop', sessions: 1 }, /stopknop op het scherm/],
    ['remote_desktop.start', { device: 'iPhone van Sanne', kind: 'phone', view: false }, /geopend vanaf “iPhone van Sanne”/],
    ['remote_desktop.end', { device: 'phone', reason: 'idle', seconds: 600, inputs: 3 }, /vanaf je telefoon vanzelf gestopt omdat er niets gebeurde na 10 minuten/],
    ['remote_desktop.options', { control: false }, /alleen meekijken/],
  ] as const;
  for (const [kind, data, re] of rows) {
    const e = describeAudit({ id: 1, user_id: 'u', agent_id: null, kind, data, created_at: new Date().toISOString() }, {});
    assert.match(e.sentence, re, `${kind}: ${e.sentence}`);
    assert.ok(!e.generic, kind);
  }
});

// ---------------------------------------------------------------- integration (dry-run driver)

const JPEG_A = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]);
const JPEG_B = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 4, 5, 6, 0xff, 0xd9]);

function dryRun() {
  const calls: { action: string; input: any }[] = [];
  const st = { frame: JPEG_A, cursor: { x: 960, y: 540 }, fail: '' as string };
  const driver = {
    async call(action: string, input: any) {
      calls.push({ action, input });
      if (st.fail && action !== 'monitors' && action !== 'shot') throw new Error(st.fail);
      if (action === 'monitors') return { monitors: [PRIMARY, LEFT] };
      if (action === 'shot') {
        fs.writeFileSync(input.out, st.frame);
        return { cursor: st.cursor, windows: [], hidden: 0 };
      }
      return { ok: true };
    },
    kill() {
      calls.push({ action: 'kill', input: {} });
    },
  };
  return { calls, st, driver };
}

const svcOf = (t: TestApp): RemoteDesktopService => t.app.ctx.services.remoteDesktop._service;

async function call(t: TestApp, token: string | null, method: string, p: string, body?: any, headers: Record<string, string> = {}) {
  const res = await fetch(t.app.url + '/api' + p, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const buf = Buffer.from(await res.arrayBuffer());
  let json: any = null;
  try {
    json = JSON.parse(buf.toString('utf8'));
  } catch {
    json = null;
  }
  return { status: res.status, body: json, buf, headers: res.headers };
}

async function pairPhone(t: TestApp, name = 'iPhone van Sanne') {
  const ticket = await t.api('POST', '/mobile/pair', { baseUrl: 'http://192.168.1.5:4762' });
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const r = await call(t, null, 'POST', '/public/mobile/claim', { secret, name });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  return r.body.token as string;
}

async function setup(o: { indicator?: boolean } = {}) {
  const t = await startTestApp();
  const svc = svcOf(t);
  const fake = dryRun();
  svc.setDriver(fake.driver);
  const detach = o.indicator === false ? () => {} : svc.attachIndicator();
  const states: any[] = [];
  t.app.ctx.services.remoteDesktop.onState((s: any) => states.push(s));
  return { t, svc, fake, detach, states };
}

const audits = (t: TestApp, kind: string) => t.app.ctx.store.all<any>('SELECT data FROM audit WHERE kind = ? ORDER BY id', kind).map((r) => JSON.parse(r.data));

test('off by default; switching on only at the computer itself (phone: computer-only, other PC: refused)', async () => {
  const { t, fake } = await setup();
  try {
    const phone = await pairPhone(t);
    const st = await t.api('GET', '/remote-desktop');
    assert.equal(st.enabled, false);
    assert.equal(st.here, true, 'the desktop app on this computer');
    assert.equal(st.available, true);

    // the phone: COMPUTER_ONLY (server/modules/mobile/policy.ts), for every way of writing the path
    for (const p of ['/remote-desktop/switch', '/Remote-Desktop/Switch', '/remote-desktop/switch/']) {
      const r = await call(t, phone, 'PUT', p, { enabled: true });
      assert.equal(r.status, 403, `${p} → ${r.status}`);
      assert.equal(r.body.code, 'mobile_denied');
      assert.match(r.body.error, /computer/);
    }
    const ps = await call(t, phone, 'GET', '/remote-desktop');
    assert.equal(ps.status, 200);
    assert.equal(ps.body.here, false);
    // starting while off: refused with the way to switch it on
    const off = await call(t, phone, 'POST', '/remote-desktop/sessions', {});
    assert.equal(off.status, 409);
    assert.equal(off.body.code, 'remote_off');

    // a browser on another PC (forwarded / not loopback), even with the owner's own sign-in
    const far = await call(t, t.token, 'PUT', '/remote-desktop/switch', { enabled: true }, { 'x-forwarded-for': '192.168.1.20' });
    assert.equal(far.status, 403);
    assert.equal(far.body.code, 'remote_here_only');
    assert.equal(svcOf(t).settings().enabled, false);

    const on = await t.api('PUT', '/remote-desktop/switch', { enabled: true, idleMinutes: 15 });
    assert.equal(on.enabled, true);
    assert.equal(on.idleMinutes, 15);
    assert.deepEqual(audits(t, 'remote_desktop.on'), [{ control: true, idleMinutes: 15 }]);

    // switching OFF works from the phone
    const r = await call(t, phone, 'POST', '/remote-desktop/off', {});
    assert.equal(r.status, 200);
    assert.equal(r.body.enabled, false);
    assert.equal(audits(t, 'remote_desktop.off')[0].source, 'telefoon');
    assert.ok(!fake.calls.some((c) => ['click', 'type', 'key', 'drag', 'scroll', 'move'].includes(c.action)), 'no input at all');
  } finally {
    await t.close();
  }
});

test('without the on-screen indicator (no TeamBot app) it cannot be switched on and sessions stop', async () => {
  const { t, svc } = await setup({ indicator: false });
  try {
    const st = await t.api('GET', '/remote-desktop');
    assert.equal(st.available, false);
    assert.equal(st.unavailable, 'app');
    const r = await call(t, t.token, 'PUT', '/remote-desktop/switch', { enabled: true });
    assert.equal(r.status, 409);
    assert.match(r.body.error, /TeamBot-app/);

    const detach = svc.attachIndicator();
    await t.api('PUT', '/remote-desktop/switch', { enabled: true });
    const phone = await pairPhone(t);
    const s = await call(t, phone, 'POST', '/remote-desktop/sessions', {});
    assert.equal(s.status, 200);
    detach();
    const f = await call(t, phone, 'GET', `/remote-desktop/sessions/${s.body.id}/frame`);
    assert.equal(f.status, 410);
    assert.equal(f.body.code, 'remote_unavailable');
  } finally {
    await t.close();
  }
});

test('a session from the phone: monitors, frames (304 when unchanged), taps and keys become driver input', async () => {
  const { t, fake, states } = await setup();
  try {
    await t.api('PUT', '/remote-desktop/switch', { enabled: true });
    const phone = await pairPhone(t);
    const s = await call(t, phone, 'POST', '/remote-desktop/sessions', { monitor: 0 });
    assert.equal(s.status, 200, JSON.stringify(s.body));
    assert.deepEqual(s.body.monitors, [
      { index: 0, w: 1920, h: 1080, primary: true },
      { index: 1, w: 2560, h: 1440, primary: false },
    ]);
    const id = s.body.id;
    const start = audits(t, 'remote_desktop.start');
    assert.equal(start.length, 1);
    assert.equal(start[0].device, 'iPhone van Sanne');
    assert.equal(start[0].kind, 'phone');

    // the indicator on the PC knows at once
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(states.at(-1).sessions, [{ device: 'iPhone van Sanne', controlling: false }]);

    const f = await call(t, phone, 'GET', `/remote-desktop/sessions/${id}/frame?m=0&w=1280&q=50`);
    assert.equal(f.status, 200);
    assert.equal(f.headers.get('content-type'), 'image/jpeg');
    assert.deepEqual(f.buf, JPEG_A);
    assert.equal(f.headers.get('cache-control'), 'no-store');
    assert.equal(f.headers.get('x-tb-size'), '1280x720');
    assert.match(f.headers.get('x-tb-cursor') || '', /^0\.500\d+,0\.500\d+$/);
    const shot = fake.calls.find((c) => c.action === 'shot')!;
    assert.deepEqual(shot.input.area, { x: 0, y: 0, w: 1920, h: 1080 });
    assert.equal(shot.input.quality, 50);
    assert.equal(shot.input.policy.owner, true);
    assert.equal(shot.input.fast, true);
    assert.ok(!fs.existsSync(shot.input.out), 'the frame file is gone right after reading');
    assert.ok(shot.input.out.includes('remote-desktop'), 'frames only in the own data folder');

    const etag = f.headers.get('etag')!;
    const same = await call(t, phone, 'GET', `/remote-desktop/sessions/${id}/frame?m=0&w=1280&q=50`, undefined, { 'if-none-match': etag });
    assert.equal(same.status, 304, 'an unchanged screen costs no picture');
    fake.st.frame = JPEG_B;
    const changed = await call(t, phone, 'GET', `/remote-desktop/sessions/${id}/frame?m=1&w=1280&q=50`, undefined, { 'if-none-match': etag });
    assert.equal(changed.status, 200);
    assert.deepEqual(fake.calls.filter((c) => c.action === 'shot').at(-1)!.input.area, { x: -2560, y: -360, w: 2560, h: 1440 }, 'the other monitor');

    // input: a tap on the left monitor, a right click, a drag, scrolling, text and keys
    const send = (b: any) => call(t, phone, 'POST', `/remote-desktop/sessions/${id}/input`, b);
    assert.equal((await send({ type: 'click', x: 0.25, y: 0.5, monitor: 1 })).status, 200);
    assert.equal((await send({ type: 'click', x: 0.5, y: 0.5, button: 'right', monitor: 0 })).status, 200);
    assert.equal((await send({ type: 'drag', x: 0.1, y: 0.1, x2: 0.9, y2: 0.1, monitor: 0 })).status, 200);
    assert.equal((await send({ type: 'scroll', x: 0.5, y: 0.5, dy: 3, monitor: 0 })).status, 200);
    assert.equal((await send({ type: 'type', text: 'hallo', monitor: 0 })).status, 200);
    assert.equal((await send({ type: 'key', keys: 'alt+tab', monitor: 0 })).status, 200);
    const bad = await send({ type: 'key', keys: 'ctrl+alt+delete' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /Ctrl\+Alt\+Del/);
    const input = fake.calls.filter((c) => ['click', 'drag', 'scroll', 'type', 'key'].includes(c.action));
    assert.deepEqual(
      input.map((c) => [c.action, c.input.x, c.input.y, c.input.button ?? c.input.text ?? c.input.dy ?? null]),
      [
        ['click', -1920, 360, 'left'],
        ['click', 960, 540, 'right'],
        ['drag', 192, 108, null],
        ['scroll', 960, 540, 3],
        ['type', undefined, undefined, 'hallo'],
        ['key', undefined, undefined, null],
      ],
    );
    assert.deepEqual(input.at(-1)!.input.combos, [[0x12, 0x09]]);
    assert.ok(input.every((c) => c.input.policy?.owner === true), 'every input with the owner policy (TeamBot stays blocked in the driver)');

    // the driver refuses TeamBot's own window: the viewer gets that sentence
    fake.st.fail = 'Dit venster kun je op afstand niet bedienen (TeamBot zelf).';
    const refused = await send({ type: 'click', x: 0.5, y: 0.5 });
    assert.equal(refused.status, 409);
    assert.equal(refused.body.code, 'remote_refused');
    assert.match(refused.body.error, /TeamBot zelf/);
    fake.st.fail = '';

    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(states.at(-1).sessions, [{ device: 'iPhone van Sanne', controlling: true }], 'the indicator says it is being controlled');

    // "Alleen kijken": taps do nothing
    assert.equal((await call(t, phone, 'POST', `/remote-desktop/sessions/${id}/view`, { view: true })).body.view, true);
    const watch = await send({ type: 'click', x: 0.5, y: 0.5 });
    assert.equal(watch.status, 403);
    assert.equal(watch.body.code, 'remote_view_only');
    await call(t, phone, 'POST', `/remote-desktop/sessions/${id}/view`, { view: false });

    // the viewer ends it: one end entry with what happened
    assert.equal((await call(t, phone, 'DELETE', `/remote-desktop/sessions/${id}`)).body.ok, true);
    const end = audits(t, 'remote_desktop.end');
    assert.equal(end.length, 1);
    assert.equal(end[0].reason, 'ended');
    assert.equal(end[0].inputs, 6);
    const after = await call(t, phone, 'GET', `/remote-desktop/sessions/${id}/frame`);
    assert.equal(after.status, 410);
    assert.equal(after.body.code, 'remote_ended');
  } finally {
    await t.close();
  }
});

test('only the owner, and a session belongs to the sign-in that started it', async () => {
  const { t } = await setup();
  try {
    await t.api('PUT', '/remote-desktop/switch', { enabled: true });
    const phone = await pairPhone(t);
    const member = t.app.ctx.auth.createUser({ name: 'Lid', role: 'member' });
    const mtok = t.app.ctx.auth.createSession(member.id).token;
    for (const [m, p] of [
      ['GET', '/remote-desktop'],
      ['POST', '/remote-desktop/sessions'],
      ['POST', '/remote-desktop/off'],
    ]) {
      const r = await call(t, mtok, m, p, m === 'GET' ? undefined : {});
      assert.equal(r.status, 403, `${m} ${p} for a member → ${r.status}`);
    }
    const admin = t.app.ctx.auth.createUser({ name: 'Beheerder', role: 'admin' });
    const atok = t.app.ctx.auth.createSession(admin.id).token;
    assert.equal((await call(t, atok, 'POST', '/remote-desktop/sessions', {})).status, 403, 'an admin is not the owner of this computer');

    const s = await call(t, phone, 'POST', '/remote-desktop/sessions', {});
    const id = s.body.id;
    // the desktop's own sign-in (same owner, other session) cannot use the phone's session
    const other = await call(t, t.token, 'GET', `/remote-desktop/sessions/${id}/frame`);
    assert.equal(other.status, 404);
    assert.equal((await call(t, t.token, 'POST', `/remote-desktop/sessions/${id}/input`, { type: 'click', x: 0.5, y: 0.5 })).status, 404);
    // nor a member who learned the id
    assert.equal((await call(t, mtok, 'GET', `/remote-desktop/sessions/${id}/frame`)).status, 403);

    // a sign-in that is not an app, browser or phone (e.g. a future script token) is refused
    const script = t.app.ctx.auth.createSession(t.app.ctx.auth.owner()!.id, 'automation', 'script').token;
    assert.equal((await call(t, script, 'POST', '/remote-desktop/sessions', {})).status, 403);

    // signing the phone out ends its session at the next check
    const sessionId = t.app.ctx.store.one<any>("SELECT id FROM sessions WHERE kind = 'device'")!.id;
    t.app.ctx.auth.revokeSession(sessionId);
    svcOf(t).sweep();
    assert.equal(audits(t, 'remote_desktop.end').at(-1).reason, 'signed_out');
  } finally {
    await t.close();
  }
});

test('Stop on the PC ends every session and switches it off; the phone hears why', async () => {
  const { t, states } = await setup();
  try {
    await t.api('PUT', '/remote-desktop/switch', { enabled: true });
    const phone = await pairPhone(t);
    const a = await call(t, phone, 'POST', '/remote-desktop/sessions', {});
    const b = await call(t, t.token, 'POST', '/remote-desktop/sessions', {});
    assert.equal(b.status, 200);
    await new Promise((r) => setTimeout(r, 80));
    assert.equal(states.at(-1).sessions.length, 2);
    const r = t.app.ctx.services.remoteDesktop.stopFromComputer('stopknop');
    assert.deepEqual(r, { ended: 2, wasOn: true });
    assert.equal(svcOf(t).settings().enabled, false);
    const f = await call(t, phone, 'GET', `/remote-desktop/sessions/${a.body.id}/frame`);
    assert.equal(f.status, 410);
    assert.equal(f.body.code, 'remote_stopped_here');
    assert.match(f.body.error, /Gestopt op de computer/);
    const again = await call(t, phone, 'POST', '/remote-desktop/sessions', {});
    assert.equal(again.status, 409, 'and nobody gets back in until it is switched on at the computer');
    assert.deepEqual(audits(t, 'remote_desktop.off').at(-1), { source: 'stopknop', sessions: 2 });
    assert.deepEqual(audits(t, 'remote_desktop.end').map((e) => e.reason), ['stopped_here', 'stopped_here']);
    await new Promise((r) => setTimeout(r, 80));
    assert.deepEqual(states.at(-1), { enabled: false, sessions: [] }, 'the indicator disappears');
  } finally {
    await t.close();
  }
});

test('auto-stop: after the chosen minutes without input, and when the viewer is gone', async () => {
  const { t, svc } = await setup();
  try {
    await t.api('PUT', '/remote-desktop/switch', { enabled: true, idleMinutes: 5 });
    const phone = await pairPhone(t);
    let now = Date.now();
    svc.clock = () => now;
    const s = await call(t, phone, 'POST', '/remote-desktop/sessions', {});
    const id = s.body.id;
    const send = (b: any) => call(t, phone, 'POST', `/remote-desktop/sessions/${id}/input`, b);
    // frames alone (someone looking at the phone) do not count as activity; input and "I am still here" do
    now += 4 * 60_000;
    await call(t, phone, 'GET', `/remote-desktop/sessions/${id}/frame`);
    const idle = Number((await call(t, phone, 'GET', `/remote-desktop/sessions/${id}/frame`)).headers.get('x-tb-idle'));
    assert.ok(idle <= 60_000 && idle > 0, `a minute left: ${idle}`);
    const k = await call(t, phone, 'POST', `/remote-desktop/sessions/${id}/keepalive`, {});
    assert.equal(k.body.idleLeftMs, 5 * 60_000);
    now += 4 * 60_000;
    await send({ type: 'click', x: 0.5, y: 0.5 });
    now += 4 * 60_000;
    await call(t, phone, 'GET', `/remote-desktop/sessions/${id}/frame`);
    svc.sweep();
    assert.equal((await call(t, phone, 'GET', `/remote-desktop/sessions/${id}`)).status, 200, 'still on: input 4 minutes ago');
    now += 61_000;
    await call(t, phone, 'GET', `/remote-desktop/sessions/${id}/frame`);
    svc.sweep();
    const gone = await call(t, phone, 'GET', `/remote-desktop/sessions/${id}/frame`);
    assert.equal(gone.status, 410);
    assert.equal(gone.body.code, 'remote_idle');

    // a viewer that disappears (no frames, no input for a minute)
    const s2 = await call(t, phone, 'POST', '/remote-desktop/sessions', {});
    now += 61_000;
    svc.sweep();
    assert.equal((await call(t, phone, 'GET', `/remote-desktop/sessions/${s2.body.id}`)).body.code, 'remote_gone');
    assert.deepEqual(audits(t, 'remote_desktop.end').map((e) => e.reason), ['idle', 'gone']);
  } finally {
    await t.close();
  }
});

test('watch only at the computer: no input from anywhere, open sessions switch to watching', async () => {
  const { t, fake } = await setup();
  try {
    await t.api('PUT', '/remote-desktop/switch', { enabled: true });
    const phone = await pairPhone(t);
    const s = await call(t, phone, 'POST', '/remote-desktop/sessions', {});
    await t.api('PUT', '/remote-desktop/switch', { control: false });
    assert.deepEqual(audits(t, 'remote_desktop.options').at(-1), { control: false, idleMinutes: 10 });
    const r = await call(t, phone, 'POST', `/remote-desktop/sessions/${s.body.id}/input`, { type: 'key', keys: 'enter' });
    assert.equal(r.status, 403);
    assert.equal(r.body.code, 'remote_view_only');
    assert.equal((await call(t, phone, 'POST', `/remote-desktop/sessions/${s.body.id}/view`, { view: false })).body.view, true, 'the phone cannot undo the setting of the computer');
    // changing options is computer-only too
    assert.equal((await call(t, phone, 'PUT', '/remote-desktop/switch', { control: true })).status, 403);
    assert.ok(!fake.calls.some((c) => c.action === 'key'));
  } finally {
    await t.close();
  }
});

test('a bot working on the desktop waits as soon as the owner taps from a distance', async () => {
  const { t } = await setup();
  try {
    await t.api('PUT', '/remote-desktop/switch', { enabled: true });
    const a = await t.agent({ name: 'Ada' });
    const comp = t.app.ctx.services.computers._service;
    const got = comp.leases.acquire('desktop:host', { kind: 'bot', id: 'run_test', name: 'Ada', agentId: a.id }, { ttlMs: 60_000 });
    assert.equal(got.ok, true);
    const phone = await pairPhone(t);
    const s = await call(t, phone, 'POST', '/remote-desktop/sessions', {});
    // watching does not disturb the bot
    await call(t, phone, 'GET', `/remote-desktop/sessions/${s.body.id}/frame`);
    assert.equal(t.app.ctx.services.computers.lease.current('desktop:host').kind, 'bot');
    const st = await call(t, phone, 'GET', `/remote-desktop/sessions/${s.body.id}`);
    assert.equal(st.body.bot?.agentName, 'Ada');
    const r = await call(t, phone, 'POST', `/remote-desktop/sessions/${s.body.id}/input`, { type: 'click', x: 0.5, y: 0.5 });
    assert.equal(r.body.tookOverFrom, 'Ada');
    const now = t.app.ctx.services.computers.lease.current('desktop:host');
    assert.equal(now.kind, 'user', 'the owner has the desktop, the bot waits');
    assert.equal(now.sticky, true, 'until "Geef terug"');
  } finally {
    await t.close();
  }
});
