// Dictate into any program with a global key combination (desktop app). The state machine and the paste step run
// here with fakes (recorder, focus probe, key watcher, clipboard, keys) — nothing is ever typed into a real program.
// Also: the key combination parser/settings and the in-process dictation service the shell uses.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { DictationMachine, HOLD_MS, MAX_MS, type InsertResult, type OverlayView } from '../desktop/dictation-machine.js';
import { insertText, type ClipSnapshot, type PasteResult } from '../desktop/dictation-insert.js';
import { dictationClipboard, PRIVATE_FORMATS, rawType } from '../desktop/dictation-clipboard.js';
import { DEFAULT_HOTKEY, parseHotkey } from '../server/modules/voice/hotkey.js';
import { sanitize } from '../server/modules/voice/settings.js';
import { startTestApp } from './helpers.js';
import { fakeStt, markInstalled } from './voice-fakes.js';

// ---------- a manual clock ----------
function clock() {
  let now = 0;
  let seq = 0;
  const timers = new Map<number, { at: number; fn: () => void }>();
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const id = ++seq;
      timers.set(id, { at: now + ms, fn });
      return id;
    },
    clearTimer: (id: unknown) => void timers.delete(id as number),
    async advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const next = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      now = end;
      await flush();
    },
  };
}
const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r));
};

function rig(o: { text?: string; password?: boolean; startError?: string; keyWatch?: boolean; insert?: InsertResult } = {}) {
  const c = clock();
  const log: string[] = [];
  const views: OverlayView[] = [];
  let release: (() => void) | null = null;
  let onText: ((t: string) => void) | null = null;
  const inserted: string[] = [];
  const m = new DictationMachine({
    recorder: {
      async start(t) {
        log.push('start');
        onText = t;
        if (o.startError) throw new Error(o.startError);
      },
      async stop() {
        log.push('stop');
        return o.text ?? 'Hallo, dit is een test.';
      },
      cancel: () => log.push('cancel'),
    },
    target: {
      probe: async () => ({ password: !!o.password }),
      insert: async (t) => {
        inserted.push(t);
        return o.insert ?? { ok: true, how: 'pasted' };
      },
    },
    keyWatch:
      o.keyWatch === false
        ? null
        : (fn) => {
            release = fn;
            return () => (release = null);
          },
    view: { show: (v) => views.push(v), hide: () => views.push({ phase: 'message', text: '(hidden)' }) },
    armEscape: (on) => log.push(on ? 'esc on' : 'esc off'),
    label: () => 'Ctrl+Alt+Spatie',
    now: c.now,
    setTimer: c.setTimer,
    clearTimer: c.clearTimer,
  });
  return { m, c, log, views, inserted, release: () => release?.(), text: (t: string) => onText?.(t), last: () => views[views.length - 1] };
}

test('hotkey: hold to talk — letting go finishes and the text is inserted; the pill shows live text', async () => {
  const r = rig();
  r.m.press();
  await flush();
  assert.equal(r.m.phase, 'recording');
  assert.deepEqual(r.log, ['start', 'esc on']);
  await r.c.advance(HOLD_MS + 50);
  assert.equal(r.m.mode, 'hold');
  r.text('Hallo, dit');
  assert.equal(r.last().text, 'Hallo, dit');
  assert.match(r.last().hint!, /loslaten = klaar/);
  // Windows repeats the hotkey while it is held: ignored.
  for (let i = 0; i < 10; i++) {
    await r.c.advance(33);
    r.m.press();
  }
  assert.equal(r.m.phase, 'recording');
  await r.c.advance(1500);
  r.release();
  await flush();
  assert.deepEqual(r.inserted, ['Hallo, dit is een test.']);
  assert.deepEqual(r.log, ['start', 'esc on', 'esc off', 'stop']);
  assert.equal(r.last().phase, 'done');
  await r.c.advance(1000);
  assert.equal(r.m.phase, 'idle');
});

test('hotkey: a short tap is hands-free — it records until you press again', async () => {
  const r = rig();
  r.m.press();
  await flush();
  await r.c.advance(120);
  r.release();
  await flush();
  assert.equal(r.m.mode, 'toggle');
  assert.equal(r.m.phase, 'recording');
  assert.match(r.last().hint!, /Ctrl\+Alt\+Spatie = klaar/);
  await r.c.advance(8000);
  assert.equal(r.m.phase, 'recording', 'keeps recording');
  r.m.press();
  await flush();
  assert.deepEqual(r.inserted, ['Hallo, dit is een test.']);
});

test('hotkey: Esc throws it away; password field refused; nothing heard; errors; maximum length', async () => {
  {
    const r = rig();
    r.m.press();
    await flush();
    r.m.escape();
    assert.equal(r.m.phase, 'idle');
    assert.ok(r.log.includes('cancel'));
    assert.ok(r.log.includes('esc off'));
    r.release();
    await flush();
    assert.deepEqual(r.inserted, [], 'nothing inserted after Esc');
  }
  {
    const r = rig({ password: true });
    r.m.press();
    await flush();
    assert.equal(r.m.phase, 'message');
    assert.match(r.last().text!, /Wachtwoordveld/);
    assert.ok(!r.log.includes('start'), 'the microphone is not even opened');
    await r.c.advance(3000);
    assert.equal(r.m.phase, 'idle');
  }
  {
    const r = rig({ text: '   ' });
    r.m.press();
    await flush();
    await r.c.advance(100);
    r.release();
    await flush();
    await r.c.advance(1000);
    r.m.press();
    await flush();
    assert.deepEqual(r.inserted, []);
    assert.match(r.last().text!, /Niets verstaan/);
  }
  {
    const r = rig({ startError: 'Het lokale spraakmodel is nog niet gedownload' });
    r.m.press();
    await flush();
    assert.equal(r.m.phase, 'message');
    assert.match(r.last().text!, /spraakmodel/);
    assert.ok(r.log.includes('cancel'));
  }
  {
    const r = rig();
    r.m.press();
    await flush();
    await r.c.advance(100);
    r.release();
    await flush();
    await r.c.advance(MAX_MS + 10);
    assert.deepEqual(r.inserted, ['Hallo, dit is een test.'], 'stops by itself at the maximum');
  }
  {
    // Could not paste: the pill says where the text is.
    const r = rig({ insert: { ok: false, how: 'clipboard', message: 'Dit programma draait als administrator; de tekst staat op het klembord (Ctrl+V).' } });
    r.m.press();
    await flush();
    await r.c.advance(400);
    r.release();
    await flush();
    assert.match(r.last().text!, /administrator/);
  }
});

test('hotkey: without a key watcher (not Windows) it toggles; a second tap while starting finishes right after', async () => {
  const r = rig({ keyWatch: false });
  r.m.press();
  await flush();
  assert.equal(r.m.mode, 'toggle');
  await r.c.advance(2000);
  r.m.press();
  await flush();
  assert.deepEqual(r.inserted, ['Hallo, dit is een test.']);

  const q = rig({ keyWatch: false });
  q.m.press();
  await q.c.advance(300);
  q.m.press(); // the microphone was still opening
  await flush();
  assert.deepEqual(q.inserted, ['Hallo, dit is een test.']);
});

// ---------- paste with the clipboard put back ----------
function clip(initial: { text?: string; restorable?: boolean; empty?: boolean }) {
  let text = initial.text ?? '';
  const calls: string[] = [];
  const snap: ClipSnapshot = { restorable: initial.restorable ?? true, empty: initial.empty ?? false, data: { text: initial.text } };
  return {
    calls,
    get text() {
      return text;
    },
    set text(v: string) {
      text = v;
    },
    api: {
      snapshot: async () => (calls.push('snapshot'), snap),
      writeText: async (t: string) => void (calls.push(`write:${t}`), (text = t)),
      readText: async () => text,
      restore: async (s: ClipSnapshot) => void (calls.push('restore'), (text = (s.data as any).text ?? '')),
    },
  };
}
const keys = (r: PasteResult, log: string[] = []) => ({
  paste: async () => (log.push('ctrl+v'), r),
  type: async (t: string) => (log.push(`type:${t}`), r),
});
const noSleep = async () => {};

test('insert: paste, then the old clipboard comes back (unless you copied something meanwhile)', async () => {
  const c = clip({ text: 'wat ik eerder kopieerde' });
  const log: string[] = [];
  const r = await insertText('Gedicteerde tekst.', { clipboard: c.api, keys: keys({ ok: true }, log), sleep: noSleep });
  assert.deepEqual(r, { ok: true, how: 'pasted' });
  assert.deepEqual(c.calls, ['snapshot', 'write:Gedicteerde tekst.', 'restore']);
  assert.deepEqual(log, ['ctrl+v']);
  assert.equal(c.text, 'wat ik eerder kopieerde');

  const c2 = clip({ text: 'oud' });
  await insertText('Nieuw.', { clipboard: c2.api, keys: { ...keys({ ok: true }), paste: async () => ((c2.text = 'iets anders gekopieerd'), { ok: true }) }, sleep: noSleep });
  assert.equal(c2.text, 'iets anders gekopieerd', 'not overwritten');
});

test('insert: password field refused (clipboard back at once); administrator window and copied files handled', async () => {
  const c = clip({ text: 'oud' });
  const r = await insertText('geheim', { clipboard: c.api, keys: keys({ ok: false, code: 'password' }), sleep: noSleep });
  assert.equal(r.how, 'refused');
  assert.match(r.message!, /wachtwoordveld/);
  assert.equal(c.text, 'oud', 'the dictated text is not left behind');

  const e = clip({ text: 'oud' });
  const r2 = await insertText('Tekst.', { clipboard: e.api, keys: keys({ ok: false, code: 'elevated' }), sleep: noSleep });
  assert.equal(r2.how, 'clipboard');
  assert.match(r2.message!, /administrator/);
  assert.equal(e.text, 'Tekst.', 'left on the clipboard to paste by hand');

  const f = clip({ restorable: false });
  const log: string[] = [];
  const r3 = await insertText('Tekst.', { clipboard: f.api, keys: keys({ ok: true }, log), sleep: noSleep });
  assert.equal(r3.how, 'typed');
  assert.deepEqual(log, ['type:Tekst.']);
  assert.ok(!f.calls.some((x) => x.startsWith('write:')), 'copied files stay on the clipboard');

  const n = clip({ text: 'oud' });
  const r4 = await insertText('Tekst.', { clipboard: n.api, keys: null, sleep: noSleep });
  assert.equal(r4.how, 'clipboard');
  assert.equal(n.text, 'Tekst.');
});

// ---------- the real clipboard adapter (Electron's API faked): out of clipboard history ----------
class FakeItem {
  constructor(public entries: Record<string, any>) {}
}
function electronFake(initial: Record<string, any>[]) {
  let items = initial;
  const writes: Record<string, any>[][] = [];
  let cleared = 0;
  return {
    writes,
    cleared: () => cleared,
    api: {
      has: async (t: string) => items.some((r) => t in r),
      read: async () => items.map((r) => ({ types: Object.keys(r), getType: async (t: string) => r[t] })),
      write: async (list: FakeItem[]) => void writes.push((items = list.map((i) => i.entries))),
      readText: async () => String(items[0]?.['text/plain'] ?? ''),
      clear: () => void ((items = []), cleared++),
    },
  };
}
async function assertPrivate(entries: Record<string, any>, what: string) {
  for (const f of PRIVATE_FORMATS) {
    const v = entries[rawType(f)];
    assert.ok(v instanceof Blob, `${what}: ${f} is written`);
    assert.deepEqual([...new Uint8Array(await v.arrayBuffer())], [0, 0, 0, 0], `${what}: ${f} = DWORD 0`);
  }
}

test('clipboard (Windows): dictated text and the clipboard put back stay out of clipboard history and the cloud clipboard', async () => {
  assert.deepEqual(PRIVATE_FORMATS, ['ExcludeClipboardContentFromMonitorProcessing', 'CanIncludeInClipboardHistory', 'CanUploadToCloudClipboard']);
  assert.equal(rawType('CanIncludeInClipboardHistory'), 'electron application/osclipboard;format="CanIncludeInClipboardHistory"');

  const f = electronFake([{ 'text/plain': 'wat ik eerder kopieerde', 'text/html': '<b>wat ik eerder kopieerde</b>' }]);
  const c = dictationClipboard(f.api, FakeItem, 'win32');
  let during: Record<string, any>[] = [];
  const r = await insertText('Gedicteerde tekst.', { clipboard: c, keys: { ...keys({ ok: true }), paste: async () => ((during = f.writes.at(-1)!), { ok: true }) }, sleep: noSleep });
  assert.deepEqual(r, { ok: true, how: 'pasted' });
  // The dictated text: one item, text + the three markers in ONE write (a second write would empty the clipboard).
  assert.equal(during.length, 1);
  assert.deepEqual(Object.keys(during[0]).sort(), ['text/plain', ...PRIVATE_FORMATS.map(rawType)].sort());
  assert.equal(during[0]['text/plain'], 'Gedicteerde tekst.');
  await assertPrivate(during[0], 'dictated text');
  // Put back as it was (text + layout), also without a new history entry.
  assert.equal(f.writes.length, 2, 'write, then restore');
  const back = f.writes[1];
  assert.equal(back.length, 1);
  assert.equal(back[0]['text/plain'], 'wat ik eerder kopieerde');
  assert.equal(back[0]['text/html'], '<b>wat ik eerder kopieerde</b>');
  await assertPrivate(back[0], 'clipboard put back');

  // Not pasted (administrator window): the text stays for Ctrl+V by hand, still out of the history.
  const a = electronFake([{ 'text/plain': 'oud' }]);
  await insertText('Tekst.', { clipboard: dictationClipboard(a.api, FakeItem, 'win32'), keys: keys({ ok: false, code: 'elevated' }), sleep: noSleep });
  assert.equal(a.writes.length, 1);
  assert.equal(a.writes[0][0]['text/plain'], 'Tekst.');
  await assertPrivate(a.writes[0][0], 'text left on the clipboard');

  // An empty clipboard is emptied again; copied files cannot be put back (the text is typed instead).
  const e = electronFake([]);
  const ce = dictationClipboard(e.api, FakeItem, 'win32');
  const empty = await ce.snapshot();
  assert.equal(empty.empty, true);
  await ce.restore(empty);
  assert.deepEqual([e.cleared(), e.writes.length], [1, 0]);
  const files = electronFake([{ [rawType('FileNameW')]: new Blob(['C:\\map\\bestand.txt']) }]);
  assert.equal((await dictationClipboard(files.api, FakeItem, 'win32').snapshot()).restorable, false);

  // Other systems: plain text, no Windows formats.
  const m = electronFake([]);
  await dictationClipboard(m.api, FakeItem, 'darwin').writeText('Tekst.');
  assert.deepEqual(m.writes, [[{ 'text/plain': 'Tekst.' }]]);
});

// ---------- key combination + settings ----------
test('hotkey combination: parsed, normalised, labelled in Dutch; reserved and unsafe ones refused', () => {
  assert.deepEqual(parseHotkey('Control+Alt+Space'), { accel: 'Control+Alt+Space', label: 'Ctrl+Alt+Spatie', vk: 0x20, mods: ['Control', 'Alt'] });
  assert.equal(parseHotkey('alt+ctrl+spatie')?.accel, 'Control+Alt+Space');
  assert.equal(parseHotkey('Ctrl+Shift+F9')?.vk, 0x78);
  assert.equal(parseHotkey('F8')?.label, 'F8');
  assert.equal(parseHotkey('Control+Alt+D')?.vk, 0x44);
  for (const bad of ['A', 'Shift+A', 'Alt+Space', 'Super+H', 'Control+V', 'Control+Escape', 'Control+Alt+Enter', 'Hyper+K', '', 'Control+Alt+Space+X', 42, null])
    assert.equal(parseHotkey(bad as any), null, String(bad));
  const s = sanitize({});
  assert.deepEqual(s.hotkey, { enabled: false, accelerator: DEFAULT_HOTKEY }, 'off until the owner turns it on');
  assert.deepEqual(sanitize({ hotkey: { enabled: true, accelerator: 'Alt+Space' } }).hotkey, { enabled: true, accelerator: DEFAULT_HOTKEY });
  assert.equal(sanitize({ hotkey: { enabled: 1, accelerator: 'ctrl+alt+d' } }).hotkey.accelerator, 'Control+Alt+D');
});

// ---------- the in-process dictation service the shell uses ----------
const stt = fakeStt((s) => `gedicteerd (${s.toFixed(1)} s)`);
after(() => stt.restore());

test('dictation service: PCM in, text out (local engine); clear reasons when it cannot', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    assert.throws(() => t.app.ctx.services.voice.openDictation(owner.id), /nog niet gedownload/);
    markInstalled(t.dir, 'parakeet-tdt-0.6b-v3');
    const d = t.app.ctx.services.voice.openDictation(owner.id);
    assert.equal(d.engine, 'local');
    const rate = 16000;
    const pcm = Buffer.alloc(3 * rate * 2);
    for (let i = 0; i < 3 * rate; i++) pcm.writeInt16LE(Math.round(9000 * Math.abs(Math.sin((Math.PI * 4 * i) / rate)) * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
    for (let o = 0; o < pcm.length; o += 3200) d.push(pcm.subarray(o, o + 3200));
    const r = await d.end();
    assert.match(r.text, /gedicteerd \(3\.0 s\)/);
    // Browser recognition cannot work outside the browser: the local engine is used when it is there.
    await t.api('PUT', '/voice/settings', { stt: { engine: 'browser' }, hotkey: { enabled: true } });
    assert.equal(t.app.ctx.services.voice.openDictation(owner.id).engine, 'local');
    // The settings page sees whether the desktop app has the hotkey (here: no shell → not available).
    const v = await t.api('GET', '/voice/settings');
    assert.equal(v.hotkey.available, false);
    assert.ok(v.hotkey.presets.some((p: any) => p.label === 'Ctrl+Alt+Spatie'));
    t.app.ctx.services.voiceHotkey = { status: () => ({ enabled: true, registered: true, label: 'Ctrl+Alt+Spatie' }) };
    const v2 = await t.api('GET', '/voice/settings');
    assert.equal(v2.hotkey.available, true);
    assert.equal(v2.hotkey.registered, true);
    assert.equal(v2.settings.hotkey.enabled, true);
  } finally {
    await t.close();
  }
});
