import { test } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import { BADGE_COLORS, DesktopBadge, badgeState, renderBadgePng, withTrayDot, type BadgeState } from '../desktop/badge.js';
import { unreadChats } from '../ui/src/shell/badgeCount.js';

/** B-67: the taskbar badge of the desktop app, tested without Electron (no window, no focus). */

function decodePng(buf: Buffer) {
  assert.deepEqual([...buf.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 'PNG signature');
  let o = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (o < buf.length) {
    const len = buf.readUInt32BE(o);
    const type = buf.toString('latin1', o + 4, o + 8);
    const data = buf.subarray(o + 8, o + 8 + len);
    assert.equal(buf.readUInt32BE(o + 8 + len), zlib.crc32(buf.subarray(o + 4, o + 8 + len)) >>> 0, `CRC of ${type}`);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      assert.deepEqual([data[8], data[9]], [8, 6], '8-bit RGBA');
    }
    if (type === 'IDAT') idat.push(data);
    o += 12 + len;
  }
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = (x: number, y: number) => {
    const i = y * (width * 4 + 1) + 1 + x * 4;
    assert.equal(raw[y * (width * 4 + 1)], 0, 'filter 0');
    return [raw[i], raw[i + 1], raw[i + 2], raw[i + 3]];
  };
  return { width, height, px };
}

const near = (a: number[], b: readonly number[], tol = 8) => a.slice(0, 3).every((v, i) => Math.abs(v - b[i]) <= tol);

test('badge text: plain Dutch for screen readers and the tray, a short label for the round badge', () => {
  assert.deepEqual(badgeState({ waiting: 3, unread: 0 }), { waiting: 3, unread: 0, count: 3, text: '3 wachten op jou', label: '3' });
  assert.equal(badgeState({ waiting: 1 }).text, '1 wacht op jou');
  assert.equal(badgeState({ waiting: 2, unread: 1 }).text, '2 wachten op jou, 1 ongelezen chat');
  assert.equal(badgeState({ unread: 4 }).text, '4 ongelezen chats');
  assert.equal(badgeState({ waiting: 7, unread: 5 }).label, '9+');
  assert.deepEqual(badgeState(null), { waiting: 0, unread: 0, count: 0, text: '', label: '' });
  // Counts come over IPC: anything odd is treated as nothing, and they are capped.
  assert.equal(badgeState({ waiting: -4, unread: NaN }).count, 0);
  assert.equal(badgeState({ waiting: '3' as any, unread: { x: 1 } as any }).count, 3);
  assert.equal(badgeState({ waiting: 1e9 }).waiting, 9999);
});

test("badge text in the owner's language: whole sentences with the language's own plural forms", () => {
  assert.equal(badgeState({ waiting: 2, unread: 1 }, 'de').text, '2 warten auf dich, 1 ungelesener Chat');
  assert.equal(badgeState({ unread: 5 }, 'pl').text, '5 nieprzeczytanych czatów', 'Polish "many"');
  assert.equal(badgeState({ unread: 3 }, 'pl').text, '3 nieprzeczytane czaty', 'Polish "few"');
  assert.equal(badgeState({ waiting: 3, unread: 2 }, 'ar').text, '3 بانتظارك، 2 دردشتان غير مقروءتان', 'Arabic: dual form and Arabic comma');
  assert.equal(badgeState({ waiting: 2 }, 'nl').text, '2 wachten op jou');
  // The controller asks the language each time: a change shows at once.
  let lang = 'nl';
  const seen: string[] = [];
  const b = new DesktopBadge({ platform: 'win32', setOverlay: (_i, d) => seen.push(d), setBadgeCount: () => {}, setTray: () => {}, lang: () => lang }, 0);
  b.report({ waiting: 1, unread: 0 });
  assert.equal(b.state.text, '1 wacht op jou');
  lang = 'de';
  assert.equal(b.state.text, '1 wartet auf dich');
  b.stop();
});

test('badge image: a valid PNG, round and see-through outside, the number readable in the middle', () => {
  for (const size of [16, 24, 32]) {
    const img = decodePng(renderBadgePng('3', size));
    assert.deepEqual([img.width, img.height], [size, size]);
    assert.equal(img.px(0, 0)[3], 0, 'corners are transparent');
    assert.equal(img.px(size - 1, size - 1)[3], 0);
  }
  const big = decodePng(renderBadgePng('1', 32));
  // Left of the "1": the badge colour, fully opaque.
  const fill = big.px(7, 16);
  assert.ok(near(fill, BADGE_COLORS.fill) && fill[3] === 255, `fill ${fill}`);
  // The glyph is drawn in the dark text colour.
  const dark = (img: ReturnType<typeof decodePng>) => {
    let n = 0;
    for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) if (img.px(x, y)[3] === 255 && near(img.px(x, y), BADGE_COLORS.text, 40)) n++;
    return n;
  };
  const one = dark(big);
  const eight = dark(decodePng(renderBadgePng('8', 32)));
  assert.ok(one > 15, `the "1" is drawn (${one} px)`);
  assert.ok(eight > one, 'an "8" has more ink than a "1"');
  assert.notDeepEqual(renderBadgePng('9+', 32), renderBadgePng('9', 32));
});

test('tray icon: a dot in the top right corner, the rest of the icon untouched (premultiplied BGRA)', () => {
  const w = 16;
  const base = Buffer.alloc(w * w * 4);
  for (let i = 0; i < base.length; i += 4) base.set([0x30, 0x20, 0x10, 0xff], i); // opaque dark (B, G, R, A)
  const out = withTrayDot(base, w, w);
  const at = (x: number, y: number) => [...out.subarray((y * w + x) * 4, (y * w + x) * 4 + 4)];
  const c = at(12, 3);
  assert.ok(Math.abs(c[2] - BADGE_COLORS.fill[0]) < 12 && Math.abs(c[0] - BADGE_COLORS.fill[2]) < 12, `dot colour (BGRA) ${c}`);
  assert.deepEqual(at(2, 13), [0x30, 0x20, 0x10, 0xff], 'away from the dot nothing changes');
  assert.deepEqual([...base.subarray(0, 4)], [0x30, 0x20, 0x10, 0xff], 'the input is not modified');
  // On a transparent icon the dot is opaque in its middle and nothing else appears.
  const clear = withTrayDot(Buffer.alloc(w * w * 4), w, w);
  assert.equal(clear[(3 * w + 12) * 4 + 3], 255);
  assert.equal(clear[(13 * w + 2) * 4 + 3], 0);
});

function fakeTarget(platform: NodeJS.Platform) {
  const calls: { overlay: { n: number; text: string }[]; count: number[]; tray: BadgeState[] } = { overlay: [], count: [], tray: [] };
  return {
    calls,
    target: {
      platform,
      setOverlay: (imgs: { size: number; png: Buffer }[] | null, text: string) => {
        if (imgs) assert.deepEqual(imgs.map((i) => i.size), [16, 24, 32]);
        calls.overlay.push({ n: imgs ? imgs.length : 0, text });
      },
      setBadgeCount: (n: number) => calls.count.push(n),
      setTray: (s: BadgeState) => calls.tray.push(s),
    },
  };
}
const tick = (ms = 40) => new Promise((r) => setTimeout(r, ms));

test('badge controller (Windows): debounced, only on change, cleared at 0, re-applied when the window shows again', async () => {
  const { calls, target } = fakeTarget('win32');
  const b = new DesktopBadge(target, 10);
  for (let i = 0; i < 5; i++) b.report({ waiting: 2, unread: 1 });
  await tick();
  assert.deepEqual(calls.overlay, [{ n: 3, text: '2 wachten op jou, 1 ongelezen chat' }], 'five reports, one update');
  assert.equal(calls.tray.at(-1)!.text, '2 wachten op jou, 1 ongelezen chat');
  b.report({ waiting: 2, unread: 1 });
  await tick();
  assert.equal(calls.overlay.length, 1, 'unchanged: nothing sent');
  b.refresh();
  await tick();
  assert.equal(calls.overlay.length, 2, 'refresh puts the overlay back');
  b.report({ waiting: 0, unread: 0 });
  await tick();
  assert.deepEqual(calls.overlay.at(-1), { n: 0, text: '' }, 'cleared at 0');
  assert.equal(calls.tray.at(-1)!.count, 0);
  assert.equal(calls.count.length, 0, 'no dock count on Windows');
  b.stop();
});

test('badge controller (macOS/Linux): dock count; without a window the pending approvals are used', async () => {
  const { calls, target } = fakeTarget('darwin');
  const b = new DesktopBadge(target, 10);
  b.setFallbackWaiting(2);
  await tick();
  assert.deepEqual(calls.count, [2], 'started hidden: approvals from the database');
  b.report({ waiting: 1, unread: 3 });
  await tick();
  assert.deepEqual(calls.count, [2, 4], 'the window’s own count wins');
  b.setFallbackWaiting(5);
  await tick();
  assert.deepEqual(calls.count, [2, 4], 'while the window reports, the fallback is not used');
  b.report(null);
  await tick();
  assert.deepEqual(calls.count, [2, 4, 5], 'window gone: back to the fallback');
  assert.equal(calls.overlay.length, 0);
  b.stop();
});

test('unread chats for the badge: latest chat per bot, not archived, not rooms, not when an approval already counts', () => {
  const agents = [
    { id: 'a', archived: false },
    { id: 'b', archived: false },
    { id: 'c', archived: true },
    { id: 'd', archived: false },
  ];
  const T = (agent_id: string, updated_at: string, extra: any = {}) => ({ agent_id, room_id: null, kind: 'chat' as const, archived: false, updated_at, ...extra });
  const threads = [
    T('a', '2026-11-07T10:00:00Z', { unread: true }),
    T('a', '2026-11-06T10:00:00Z', { unread: false }), // older chat of the same bot: ignored
    T('b', '2026-11-07T09:00:00Z', { unread: true }),
    T('c', '2026-11-07T09:00:00Z', { unread: true }), // archived bot
    T('d', '2026-11-07T09:00:00Z', { unread: true, room_id: 'r1' }), // a group chat
  ];
  const isUnread = (t: any) => !!t.unread;
  assert.equal(unreadChats(agents, threads, [], isUnread), 2);
  assert.equal(unreadChats(agents, threads, [{ agent_id: 'b' }], isUnread), 1, 'b is already counted as waiting');
  assert.equal(unreadChats(agents, [T('a', '2026-11-07T11:00:00Z', { unread: false }), ...threads], [], isUnread), 1, 'the latest chat decides');
});
