import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BrowserManager, DEFAULT_BROWSER_LIMITS } from '../server/modules/browser/browser.js';

/**
 * A team of many bots shares a few browsers. A full house is no reason to refuse a bot (seen 20 nov 2026: with 17
 * bots at work "alle drie de bot-browsers staan vol" and the bot gave up): the browser nobody is using is closed
 * first, else the bot waits for one, and only then hears it could not get one.
 */
function house(busy: Set<string>, n: number, o: { viewers?: string[]; users?: Record<string, string> } = {}) {
  const m = new BrowserManager({ findBrowser: async () => null, isBusy: (s) => busy.has(s.key) });
  const closed: string[] = [];
  for (let i = 1; i <= n; i++) {
    const key = `b${i}`;
    m.sessions.set(key, { key, closed: false, closing: false, viewers: new Set(o.viewers?.includes(key) ? ['owner'] : []), lastUsed: 1000 * i, opts: { userId: o.users?.[key] || 'u1' } } as any);
  }
  (m as any).close = async (key: string) => {
    closed.push(key);
    m.sessions.get(key)!.closed = true;
  };
  const room = (waitMs: number, userId = 'u1', max = 3) => (m as any).makeRoom(userId, { ...DEFAULT_BROWSER_LIMITS, maxPerUser: max, maxTotal: max, waitMs }) as Promise<void>;
  return { m, closed, room };
}

test('bot-browsers: under the maximum nothing is closed', async () => {
  const h = house(new Set(), 2);
  await h.room(0);
  assert.deepEqual(h.closed, []);
});

test('bot-browsers: a full house closes the browser that is unused longest, never one in use or one being watched', async () => {
  const h = house(new Set(['b1']), 3, { viewers: ['b2'] });
  await h.room(0);
  assert.deepEqual(h.closed, ['b3'], 'b1 is at work, the owner watches b2');
  const oldest = house(new Set(), 3);
  await oldest.room(0);
  assert.deepEqual(oldest.closed, ['b1'], 'the longest unused one');
});

test('bot-browsers: all in use: the bot waits for one to come free, and hears it plainly when none does', async () => {
  const busy = new Set(['b1', 'b2', 'b3']);
  const h = house(busy, 3);
  await assert.rejects(h.room(0), /Alle 3 bot-browsers zijn in gebruik door collega's/);
  assert.deepEqual(h.closed, []);
  setTimeout(() => busy.delete('b2'), 120);
  const t0 = Date.now();
  await h.room(5000);
  assert.deepEqual(h.closed, ['b2']);
  assert.ok(Date.now() - t0 < 4000, 'as soon as one is free, not after the whole wait');
});

test('bot-browsers: the maximum follows the memory of the computer, with a floor and a ceiling', () => {
  assert.ok(DEFAULT_BROWSER_LIMITS.maxPerUser >= 4 && DEFAULT_BROWSER_LIMITS.maxPerUser <= 16);
  assert.equal(DEFAULT_BROWSER_LIMITS.maxTotal, DEFAULT_BROWSER_LIMITS.maxPerUser);
  assert.ok(DEFAULT_BROWSER_LIMITS.waitMs >= 60_000);
});
