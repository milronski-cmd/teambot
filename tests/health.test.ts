import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { StallMeter, type HealthSample, type StallEvent } from '../server/modules/health/meter.js';
import { healthVerdict, lastHour, WARMUP_MS } from '../server/modules/health/verdict.js';
import { createHealthModule } from '../server/modules/health/index.js';

// 17.1: the stall meter inside the server — event-loop delay, stalls over 100 ms and 1 s, memory, handles, runs —
// kept as a small rolling history in the data folder, shown as one coloured line in Instellingen.

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const busy = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* block the event loop, as a heavy synchronous job would */
  }
};

test('a block of the event loop is counted as a stall (over 100 ms and over 1 s), with the delay and the totals', async () => {
  const m = new StallMeter({ sampleMs: 60_000, heartbeatMs: 20, file: null });
  m.start();
  try {
    await sleep(150);
    let s = m.sample();
    assert.equal(s.stalls.over100ms, 0, 'an idle loop has no stalls');
    assert.ok(s.loop.p50 < 20, `idle delay is small (${s.loop.p50} ms)`);
    assert.ok(s.mem.rssMb > 10 && s.mem.heapUsedMb > 1, 'memory is measured');
    assert.ok(s.handles >= 1, 'handles are counted (at least the meter’s own timers)');

    busy(250);
    await sleep(60);
    busy(1100);
    await sleep(60);
    s = m.sample();
    assert.equal(s.stalls.over100ms, 2, 'both blocks count as a stall over 100 ms');
    assert.equal(s.stalls.over1s, 1, 'only the long one is over 1 s');
    assert.ok(s.stalls.longestMs >= 1000 && s.stalls.longestMs < 1400, `longest ≈ 1.1 s (${s.stalls.longestMs})`);
    assert.ok(s.stalls.totalMs >= 1250, `total ≈ 1.35 s (${s.stalls.totalMs})`);
    assert.ok(s.loop.max >= 1000, `the delay histogram saw it too (${s.loop.max})`);
    assert.ok(s.busy > 0.5, `the loop was busy most of the window (${s.busy})`);
    const total = m.sinceStart();
    assert.equal(total.stalls100, 2);
    assert.equal(total.stalls1s, 1);
    assert.equal(m.stalls().length, 2);
    assert.equal(m.history().length, 2, 'every sample is kept');
  } finally {
    await m.stop();
  }
});

test('a long gap without CPU use (computer asleep, process paused) is a pause, not a stall', async () => {
  const m = new StallMeter({ sampleMs: 60_000, heartbeatMs: 20, pauseMs: 400, file: null });
  m.start();
  try {
    await sleep(60);
    // Atomics.wait blocks the thread without using the CPU, like a suspended process.
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 600);
    await sleep(60);
    const s = m.sample();
    assert.equal(s.pauses, 1, 'counted as a pause');
    assert.equal(s.stalls.over100ms, 0, 'not as a stall');
    assert.equal(m.sinceStart().pauses, 1);
  } finally {
    await m.stop();
  }
});

test('the history is written to the data folder, survives a restart and stays bounded', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-health-'));
  const file = path.join(dir, 'health', 'samples.jsonl');
  try {
    const m = new StallMeter({ sampleMs: 60_000, heartbeatMs: 50, file, maxSamples: 10 });
    m.start();
    for (let i = 0; i < 40; i++) m.sample();
    await m.stop();
    assert.equal(m.history().length, 10, 'only the last samples stay in memory');
    const lines = fs.readFileSync(file, 'utf8').trim().split('\n');
    assert.ok(lines.length <= 13, `the file is compacted (${lines.length} lines)`);
    for (const l of lines) assert.doesNotThrow(() => JSON.parse(l));

    const again = new StallMeter({ sampleMs: 60_000, file, maxSamples: 10 });
    again.start();
    await again.stop();
    const h = again.history();
    assert.ok(h.length >= 1 && h.length <= 10, 'the history is read back after a restart');
    assert.equal(h.at(-1)!.at, m.history().at(-1)!.at, 'the newest sample is the last one written');

    // A damaged line (power cut while writing) is skipped, not fatal.
    fs.appendFileSync(file, '{"at": "2026-11-09T10:00');
    const third = new StallMeter({ file, maxSamples: 10 });
    third.start();
    await third.stop();
    assert.ok(third.history().length >= 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------- the colour of the line

const T0 = Date.parse('2026-11-09T08:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();
const sample = (atMs: number, o: { p99?: number; rss?: number; s100?: number; s1?: number; longest?: number } = {}): HealthSample => ({
  at: iso(atMs),
  boot: iso(T0),
  windowS: 60,
  loop: { p50: 1, p99: o.p99 ?? 3, max: o.longest ?? 5 },
  stalls: { over100ms: o.s100 ?? 0, over1s: o.s1 ?? 0, longestMs: o.longest ?? 0, totalMs: o.longest ?? 0 },
  pauses: 0,
  busy: 0.02,
  cpu: 0.5,
  mem: { rssMb: o.rss ?? 180, heapUsedMb: 60, heapTotalMb: 80, externalMb: 5 },
  handles: 12,
  handleKinds: { Timeout: 6 },
  runs: 0,
});
const stall = (atMs: number, ms: number): StallEvent => ({ at: iso(atMs), ms });
const verdict = (stalls: StallEvent[], o: { now?: number; rss?: number; p99?: number } = {}) => {
  const now = o.now ?? T0 + 3 * 3_600_000;
  return healthVerdict({ stalls, samples: [sample(now - 120_000, { p99: o.p99 })], live: sample(now, { rss: o.rss }), totals: { startedAt: iso(T0) }, nowMs: now });
};

test('green, orange and red: stalls over 1 s, many short ones, slow minutes and memory; start-up never counts', () => {
  const now = T0 + 3 * 3_600_000;
  assert.deepEqual(verdict([]), { level: 'ok', reasons: [] });
  assert.deepEqual(verdict([stall(now - 60_000, 1500)]), { level: 'warn', reasons: [{ code: 'stalls1s', n: 1, longestMs: 1500 }] });
  assert.equal(verdict([stall(now - 60_000, 1500), stall(now - 50_000, 1200), stall(now - 40_000, 1100)]).level, 'bad');
  assert.deepEqual(verdict([stall(now - 60_000, 6000)]).reasons, [
    { code: 'stalls1s', n: 1, longestMs: 6000 },
    { code: 'longStall', ms: 6000 },
  ]);
  assert.equal(verdict([stall(now - 60_000, 6000)]).level, 'bad', 'one stall of 6 s is red');
  const short = Array.from({ length: 25 }, (_, i) => stall(now - 30 * 60_000 + i * 1000, 150));
  assert.deepEqual(verdict(short), { level: 'warn', reasons: [{ code: 'stalls100', n: 25 }] });
  assert.equal(verdict(short.slice(0, 10)).level, 'ok', 'a few short hiccups are normal');
  // Older than an hour: forgotten.
  assert.equal(verdict([stall(now - 2 * 3_600_000, 3000)]).level, 'ok');
  // During the first two minutes after the start: reported in the numbers, never in the colour.
  assert.equal(healthVerdict({ stalls: [stall(T0 + 30_000, 2500)], samples: [], live: sample(T0 + 60_000), totals: { startedAt: iso(T0) }, nowMs: T0 + 60_000 }).level, 'ok');
  assert.equal(healthVerdict({ stalls: [stall(T0 + WARMUP_MS + 1000, 2500)], samples: [], live: sample(T0 + WARMUP_MS + 5000), totals: { startedAt: iso(T0) }, nowMs: T0 + WARMUP_MS + 5000 }).level, 'warn');
  assert.deepEqual(verdict([], { p99: 400 }), { level: 'warn', reasons: [{ code: 'slow', p99: 400 }] });
  assert.deepEqual(verdict([], { rss: 1800 }), { level: 'warn', reasons: [{ code: 'memory', mb: 1800 }] });
  assert.equal(verdict([], { rss: 3500 }).level, 'bad');
});

test('the last hour adds up the minutes and the open window', () => {
  const now = T0 + 3 * 3_600_000;
  const h = lastHour([sample(now - 2 * 3_600_000, { s100: 9 }), sample(now - 120_000, { s100: 2, s1: 1, longest: 1200, p99: 40, rss: 210 }), sample(now - 60_000, { s100: 1, longest: 300 })], sample(now, { rss: 230 }), now);
  assert.equal(h.minutes, 3);
  assert.equal(h.stalls100, 3, 'the sample of two hours ago is not in the last hour');
  assert.equal(h.stalls1s, 1);
  assert.equal(h.longestMs, 1200);
  assert.equal(h.totalStallMs, 1500);
  assert.equal(h.p99, 40);
  assert.equal(h.rssMaxMb, 230);
  assert.equal(h.cpuAvg, 0.5);
});

// ---------------------------------------------------------------- the module in a running TeamBot

test('GET /health: the line, the numbers behind it, the history, and the diagnostics file includes them', async () => {
  const health = createHealthModule({ sampleMs: 200, heartbeatMs: 20 });
  const t = await startTestApp({ modules: [health] });
  try {
    await sleep(500);
    const h = await t.api('GET', '/health');
    assert.equal(h.level, 'ok');
    assert.deepEqual(h.reasons, []);
    assert.ok(h.now.mem.rssMb > 10);
    assert.equal(typeof h.now.loop.p99, 'number');
    assert.equal(typeof h.now.handles, 'number');
    assert.equal(h.now.runs, 0);
    assert.equal(typeof h.sampleEverySeconds, 'number');
    assert.ok(h.lastHour.minutes >= 2, 'samples are taken on their own');
    assert.equal(h.sinceStart.stalls1s, 0);

    const hist = await t.api('GET', '/health/history');
    assert.ok(hist.samples.length >= 2);
    const later = await t.api('GET', `/health/history?after=${encodeURIComponent(hist.samples.at(-1).at)}`);
    assert.ok(later.samples.every((s: HealthSample) => s.at > hist.samples.at(-1).at), 'only newer samples after a time');
    assert.ok(fs.existsSync(path.join(t.dir, 'health', 'samples.jsonl')), 'the history lives in the data folder');

    const diag = await t.api('GET', '/admin/diagnostics');
    assert.equal(diag.health.level, 'ok');
    assert.ok(diag.health.samples.length >= 2, 'the diagnostics file has the last day of samples');
    assert.ok(Array.isArray(diag.health.stalls));
  } finally {
    await t.close();
  }
});
