import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type AppHandle } from '../server/app.js';
import type { FetchResult, Fetcher } from '../server/modules/skills/fetch.js';
import { FEATURED, normalizeServer } from '../server/modules/mcp/registry.js';
import { isComplete, mergeStable, refreshLabel } from '../ui/src/modules/skills/merge.js';

/**
 * B-01/B-12: the marketplace's first view is fast even when every source is slow, fills in without moving cards,
 * persists for the next start (stale-while-revalidate) and shows at least 40 apps without searching. Sources are
 * simulated (recorded registry records in tests/fixtures/market, a delayed GitHub search and skill directory) with network delays; no test
 * here touches the network.
 */

const FX = path.resolve('tests/fixtures/market');
const FEATURED_FX: Record<string, any> = JSON.parse(fs.readFileSync(path.join(FX, 'registry-featured.json'), 'utf8'));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const ok = (url: string, body: Buffer | object, headers: Record<string, string> = {}): FetchResult => ({ status: 200, contentType: 'application/json', url, body: Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body)), headers });
const status = (url: string, s: number, headers: Record<string, string> = {}): FetchResult => ({ status: s, contentType: '', url, body: Buffer.alloc(0), headers });

/** A network that does not answer at all until the test opens it (then the normal delays apply). */
function held() {
  let open!: () => void;
  const until = new Promise<void>((r) => (open = r));
  return { until, open };
}

/** GitHub's repository search, the skill directory and ClawHub, each answering after `ms` (and nothing before `hold`). Counts calls. */
function slowOpen(ms: number, hold?: Promise<void>) {
  const calls: string[] = [];
  const f: Fetcher = async (url) => {
    calls.push(url);
    await hold;
    await sleep(ms);
    if (url.startsWith('https://api.github.com/search/repositories?')) {
      return ok(url, { total_count: 1, items: [{ full_name: 'acme/skills', name: 'skills', description: 'Skills voor een test.', stargazers_count: 7, license: { spdx_id: 'MIT' }, pushed_at: '2026-11-01T00:00:00Z', created_at: '2026-01-01T00:00:00Z' }] });
    }
    if (/^https:\/\/skills\.sh\/api\/skills\/(all-time|trending)\/0$/.test(url)) return ok(url, { skills: [{ source: 'acme/skills', skillId: 'a', name: 'a', installs: 5 }], total: 1, hasMore: false, page: 0 });
    if (url.startsWith('https://clawhub.ai/api/v1/skills?')) return ok(url, { items: [{ ownerHandle: 'acme', slug: 'b', displayName: 'b', summary: 'Skill b.', stats: { stars: 3, downloads: 40 }, createdAt: 1790000000000, updatedAt: 1794000000000, latestVersion: { version: '1.0.0', license: 'MIT' } }], nextCursor: null });
    return status(url, 404);
  };
  return { f, calls };
}

/** The MCP Registry from the recorded records, delayed per server (and nothing before `hold`). */
function slowRegistry(delay: (name: string) => number, hold?: Promise<void>) {
  const calls: string[] = [];
  const f: Fetcher = async (url) => {
    calls.push(url);
    const m = /\/v0\.1\/servers\/([^/]+)\/versions\/latest$/.exec(url);
    const name = m ? decodeURIComponent(m[1]) : '';
    await hold;
    await sleep(delay(name));
    return FEATURED_FX[name] ? ok(url, FEATURED_FX[name]) : status(url, 404);
  };
  return { f, calls };
}

/** Make a cache entry look `ms` older (as if TeamBot last fetched it that long ago); the data stays. */
function ageCache(cacheDir: string, key: string, ms: number) {
  const h = crypto.createHash('sha256').update(key).digest('hex').slice(0, 40);
  const file = path.join(cacheDir, h.slice(0, 2), `${h}.meta.json`);
  const m = JSON.parse(fs.readFileSync(file, 'utf8'));
  fs.writeFileSync(file, JSON.stringify({ ...m, fetchedAt: m.fetchedAt - ms }));
}

interface Booted {
  app: AppHandle;
  get(p: string): Promise<{ ms: number; body: any }>;
}
async function boot(dir: string): Promise<Booted> {
  const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
  const token = app.ctx.auth.ensureLocalOwner();
  return {
    app,
    async get(p: string) {
      const t0 = performance.now();
      // A server that waits for a held network fails here instead of hanging the suite.
      const res = await fetch(`${app.url}/api${p}`, { headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(30_000) });
      const body: any = await res.json();
      if (!res.ok) throw new Error(`${p} -> ${res.status}: ${body.error}`);
      return { ms: performance.now() - t0, body };
    },
  };
}

/**
 * A time bound that holds on a busy machine. `npm test` runs every test file at once. Load only ever adds time, so an
 * answer over its bound is asked for again (the same request in the same state, at most 3 tries) and the fastest
 * counts: a real slowdown fails every try, a moment of load does not. That an answer did not wait for a slow source is
 * proven by the contents of the FIRST answer (`pending`, `refreshing`), never by a retry.
 */
async function within(bound: number, what: string, first: { ms: number }, again: () => Promise<{ ms: number }>) {
  const tries = [first.ms];
  while (tries.length < 3 && Math.min(...tries) >= bound) tries.push((await again()).ms);
  const shown = tries.map((t) => Math.round(t)).join(' / ');
  if (tries.length > 1) console.log(`  ${what}: busy machine, ${tries.length} tries: ${shown} ms`);
  assert.ok(Math.min(...tries) < bound, `${what} within ${bound} ms (tries: ${shown} ms)`);
}

/**
 * The next start: the last snapshot, while every check of it is due and the network is HELD (no answer at all until
 * the test opens it). The request gets a 20 s deadline instead of the page's 1.2 s, so an answer that waited (for the
 * network or for the deadline) would take at least 20 s, whatever the load: well under that proves it did not.
 */
const HELD_DEADLINE = 'budget=20000';
/**
 * The snapshot answer itself is disk work: every cached record is read, right after the test rewrote them to look
 * old (~150–260 ms alone for the 49 apps). With the whole suite running it was measured on the owner's PC at
 * 0.2–3 s for one try (best of the tries up to 2.2 s), so the former 1 s bound failed now and then. This bound only
 * catches a gross slowdown, still far below the 20 s that waiting would take; that it did not wait is proven by the
 * held network and the 20 s deadline above, not by the clock. The measured times are logged for every run.
 */
const SNAPSHOT_MS = 8000;

/** Same timing as the page (ui/src/modules/skills/marketParts.tsx). */
const POLL_MS = 300;
const POLL_BUDGET_MS = 1500;

/** What the page does: ask again (waiting for the next source) while sources load, merging into what is shown. */
async function fillUntilDone(b: Booted, p: string, first: any, idOf: (i: any) => string, maxMs = 20_000) {
  const t0 = performance.now();
  let shown = first.items;
  let last = first;
  let firstItemsAt = first.items.length ? 0 : -1;
  const orders: string[][] = [shown.map(idOf)];
  while ((last.pending?.length || last.refreshing?.length) && performance.now() - t0 < maxMs) {
    await sleep(POLL_MS);
    last = (await b.get(`${p}${p.includes('?') ? '&' : '?'}budget=${POLL_BUDGET_MS}&early=1`)).body;
    shown = mergeStable(shown, last.items, idOf, isComplete(last));
    orders.push(shown.map(idOf));
    if (firstItemsAt < 0 && shown.length) firstItemsAt = performance.now() - t0;
  }
  // Cards already on screen never move: every earlier order is a prefix of the next one.
  for (let i = 1; i < orders.length; i++) assert.deepEqual(orders[i].slice(0, orders[i - 1].length), orders[i - 1], 'cards keep their place while the list fills in');
  return { shown, last, firstItemsAt };
}

test('merge helpers: cards keep their place, new ones at the end; only a complete answer removes cards', () => {
  const id = (x: { id: string }) => x.id;
  const a = [{ id: '1', v: 1 }, { id: '2', v: 1 }];
  assert.deepEqual(mergeStable(a, [{ id: '3', v: 1 }, { id: '1', v: 2 }], id, false), [{ id: '1', v: 2 }, { id: '2', v: 1 }, { id: '3', v: 1 }]);
  assert.deepEqual(mergeStable(a, [{ id: '1', v: 2 }], id, true).map(id), ['1'], 'gone after a complete answer');
  assert.equal(isComplete({ items: [1], total: 1 }), true);
  assert.equal(isComplete({ items: [1], total: 5 }), false, 'cut off by the server limit');
  assert.equal(isComplete({ items: [], pending: ['x'] }), false);
  assert.equal(refreshLabel({ pending: [], refreshing: [] }), '');
  assert.equal(refreshLabel({ pending: ['a'], refreshing: [] }, { ready: 4, total: 13, noun: 'collecties' }), 'Bijwerken… 4 van 13 collecties binnen');
  assert.equal(refreshLabel({ pending: [], refreshing: ['a'] }), 'Bijwerken…');
});

test('skills, open search with slow sources: the three sources are asked side by side, and what was seen comes back without waiting', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-speed-'));
  const b = await boot(dir);
  try {
    // GitHub's search, the skill directory and ClawHub each take 1.5 s.
    const slow = slowOpen(1500);
    b.app.ctx.services.skills.setFetcher(slow.f);
    const first = await b.get('/skills/web/search');
    console.log(`  open search, three sources of 1.5 s: first answer ${Math.round(first.ms)} ms, ${first.body.github.items.length} repository, ${first.body.directory.items.length} + ${first.body.clawhub.items.length} skills`);
    assert.deepEqual([first.body.github.items.length, first.body.directory.items.length, first.body.clawhub.items.length], [1, 1, 1]);
    assert.equal(slow.calls.length, 3, 'one request per source');
    assert.ok(first.ms >= 1400, 'the first view of a search waits for its sources');
    // Side by side: one after the other would take 4.5 s. (Another order is another search: every source again.)
    await within(2900, 'open search: three slow sources side by side', first, () => b.get('/skills/web/search?sort=trending'));

    // The same search again while the network does not answer at all: from the cache, no request.
    const net = held();
    const stuck = slowOpen(0, net.until);
    b.app.ctx.services.skills.setFetcher(stuck.f);
    const again = await b.get('/skills/web/search');
    await within(SNAPSHOT_MS, 'open search: seen before', again, () => b.get('/skills/web/search'));
    assert.deepEqual([again.body.github.items.length, again.body.directory.items.length, again.body.clawhub.items.length, stuck.calls.length], [1, 1, 1, 0]);
    net.open();

    // Offline: the same, also after the hour the answers are kept for.
    for (const key of ['ghsearch:stars::1', 'skillssh-list:all-time:0', 'clawhub-list:stars:1']) ageCache(path.join(dir, 'cache', 'market-skills'), key, 2 * 3600_000);
    process.env.TEAMBOT_OFFLINE = '1';
    const off = await b.get('/skills/web/search');
    await within(SNAPSHOT_MS, 'open search offline', off, () => b.get('/skills/web/search'));
    assert.deepEqual([off.body.github.items.length, off.body.github.stale, off.body.directory.items.length, off.body.clawhub.items.length, off.body.clawhub.stale, off.body.offline], [1, true, 1, 1, true, true]);
    assert.equal(stuck.calls.length, 0, 'offline: never fetches');
  } finally {
    delete process.env.TEAMBOT_OFFLINE;
    await b.app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('apps: at least 40 recommended apps without searching, fast first view with slow servers, TeamBot fill-in when nothing is in yet', async () => {
  // The recorded records are usable: every featured server normalises, and each has an icon or gets a monogram.
  const usable = FEATURED.map((n) => FEATURED_FX[n] && normalizeServer(FEATURED_FX[n], true)).filter(Boolean);
  assert.ok(FEATURED.length >= 45, `hand-picked list has room to spare (${FEATURED.length})`);
  assert.equal(usable.length, FEATURED.length, 'every featured server is in the recorded fixture');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-speed-'));
  let b = await boot(dir);
  try {
    // A mix of fast and slow registry answers (100 ms … 3 s), like a busy registry.
    const delays = new Map(FEATURED.map((n, i) => [n, [100, 300, 700, 3000][i % 4]]));
    const reg = slowRegistry((n) => delays.get(n) ?? 100);
    b.app.ctx.services.mcp.setRegistryFetcher(reg.f);
    const first = await b.get('/mcp/registry/servers');
    console.log(`  apps cold: first answer ${Math.round(first.ms)} ms, ${first.body.items.length} cards, ${first.body.pending.length} pending`);
    // The deadline (1.2 s) plus the answer itself; asked again, the 3 s servers are still on their way.
    await within(2000, 'apps cold: first view', first, () => b.get('/mcp/registry/servers'));
    assert.ok(first.body.items.length >= 30, 'the fast answers are in the first view');
    assert.ok(first.body.pending.length > 0, 'the slow ones follow');
    const filled = await fillUntilDone(b, '/mcp/registry/servers', first.body, (i) => i.name);
    console.log(`  apps cold: ${filled.shown.length} recommended apps without searching after the polls`);
    assert.ok(filled.shown.length >= 40, `at least 40 apps without searching (${filled.shown.length})`);
    assert.ok(filled.shown.every((i: any) => i.icon === null || /^\/mcp\/registry\/icon\?name=/.test(i.icon)), 'an icon through TeamBot, or the monogram');
    assert.equal(reg.calls.filter((u) => u.includes('/servers/')).length, FEATURED.length, 'each record fetched once');

    // Next start: everything from the snapshot at once, even when the registry hangs.
    await b.app.close();
    b = await boot(dir);
    const net = held();
    const slow = slowRegistry(() => 300, net.until);
    b.app.ctx.services.mcp.setRegistryFetcher(slow.f);
    for (const n of FEATURED) ageCache(path.join(dir, 'cache', 'mcp-registry'), `server:${n}@latest`, 2 * 3600_000);
    const warm = await b.get(`/mcp/registry/servers?${HELD_DEADLINE}`);
    console.log(`  apps next start (copies 2 h old, registry held, 20 s deadline): first answer ${Math.round(warm.ms)} ms, ${warm.body.items.length} cards, refreshing ${warm.body.refreshing.length}`);
    await within(SNAPSHOT_MS, 'apps warm: snapshot', warm, () => b.get(`/mcp/registry/servers?${HELD_DEADLINE}`));
    assert.deepEqual(warm.body.items.map((i: any) => i.name), filled.last.items.map((i: any) => i.name), 'the same cards, in the same order');
    assert.equal(warm.body.refreshing.length, FEATURED.length, 'checked in the background');
    assert.equal(warm.body.starter.length, 0);
    assert.ok(slow.calls.length >= FEATURED.length, 'the checks did start (and are held)');
    net.open();
    const checked = await fillUntilDone(b, '/mcp/registry/servers', warm.body, (i) => i.name);
    assert.equal(checked.shown.length, warm.body.items.length);
  } finally {
    await b.app.close();
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }

  // Nothing in yet and every server slow: TeamBot's own connectors fill the first view.
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-speed-'));
  const c = await boot(dir2);
  try {
    c.app.ctx.services.mcp.setRegistryFetcher(slowRegistry(() => 2000).f);
    const r = await c.get('/mcp/registry/servers');
    await within(2000, 'apps, nothing in yet: first view', r, () => c.get('/mcp/registry/servers'));
    assert.equal(r.body.items.length, 0);
    assert.equal(r.body.pending.length, FEATURED.length);
    assert.equal(r.body.starter.length, 6);
    assert.ok(r.body.starterTotal >= 10, 'TeamBot’s own connectors');
    const filled = await fillUntilDone(c, '/mcp/registry/servers', r.body, (i) => i.name);
    assert.ok(filled.shown.length >= 40);
  } finally {
    await c.app.close();
    fs.rmSync(dir2, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});
