import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { COST_THRESHOLD_USD, WINDOW_THRESHOLD_PCT, fitWindows, median, reasonToShow, windowMs, windowShare } from '../server/modules/usage/estimate.js';
import { costAt, modelPrice } from '../server/modules/usage/prices.js';
import { estimateCost } from '../server/providers/pricing.js';
import { catalogInfo } from '../server/providers/models-dev.js';

const NOW = Date.parse('2026-11-09T12:00:00Z');

// ---------------------------------------------------------------- pure parts

test('estimate: median, window length from the id, share of a window', () => {
  assert.equal(median([]), null);
  assert.equal(median([5, 1, 3]), 3);
  assert.equal(median([4, 1, 3, 10]), 3.5);
  assert.equal(windowMs('five_hour'), 5 * 3600_000);
  assert.equal(windowMs('seven_day'), 7 * 86_400_000);
  assert.equal(windowMs('seven_day_opus'), 7 * 86_400_000);
  assert.equal(windowMs('codex:300'), 300 * 60_000);
  assert.equal(windowMs('overage'), null);
  // 40% of the window went with 20,000 tokens: a run of 5,000 tokens takes about 10%.
  assert.equal(windowShare({ usedPercent: 40 }, 20_000, 5_000), 10);
  assert.equal(windowShare({ usedPercent: null }, 20_000, 5_000), null, 'unknown fill: no guess');
  assert.equal(windowShare({ usedPercent: 0 }, 20_000, 5_000), null);
  assert.equal(windowShare({ usedPercent: 40 }, 0, 5_000), null, 'nothing logged in the window: no guess');
  // When the estimate is shown before starting.
  const base = { startAfter: null, important: false, usd: 0.1, windows: [{ share: 3 }] };
  assert.equal(reasonToShow(base), null, 'small work: nothing in the way');
  assert.equal(reasonToShow({ ...base, usd: COST_THRESHOLD_USD }), 'cost');
  assert.equal(reasonToShow({ ...base, windows: [{ share: WINDOW_THRESHOLD_PCT }] }), 'window');
  assert.equal(reasonToShow({ ...base, important: true }), 'important');
  assert.equal(reasonToShow({ ...base, important: true, startAfter: { at: 1 } }), 'nofit');
});

test('estimate: a run that does not fit offers the reset (+1 minute); the latest reset wins; a stale window is unknown', () => {
  const reset5h = NOW + 2 * 3600_000;
  const resetWeek = NOW + 3 * 86_400_000;
  const w = (id: string, usedPercent: number | null, resetsAt: number | null) => ({ id, label: id, usedPercent, resetsAt, level: 'ok' as const, at: NOW - 60_000 });
  // 90% used with 9,000 tokens in the window → a run of 2,000 tokens is ~20%, and only 10% is left.
  const a = fitWindows([w('five_hour', 90, reset5h), w('seven_day', 30, resetWeek)], () => 9_000, 2_000, NOW);
  const five = a.windows.find((x) => x.id === 'five_hour')!;
  assert.equal(five.share, 20);
  assert.equal(five.left, 10);
  assert.equal(five.fits, false);
  assert.equal(a.windows.find((x) => x.id === 'seven_day')!.fits, true);
  assert.deepEqual(a.startAfter, { at: reset5h + 60_000, windowId: 'five_hour', label: 'five_hour', known: true });

  // Both full: wait for the later (weekly) reset — waiting for the 5-hour reset alone would not help.
  const b = fitWindows([w('five_hour', 100, reset5h), w('seven_day', 100, resetWeek)], () => 9_000, 2_000, NOW);
  assert.equal(b.startAfter!.windowId, 'seven_day');
  assert.equal(b.startAfter!.at, resetWeek + 60_000);

  // A window whose reset has passed: fill unknown, never "does not fit".
  const c = fitWindows([w('five_hour', 95, NOW - 1000)], () => 9_000, 2_000, NOW);
  assert.equal(c.windows[0].fits, null);
  assert.equal(c.startAfter, null);

  // No earlier runs: a full window still does not fit.
  const d = fitWindows([w('five_hour', 100, reset5h)], () => 0, null, NOW);
  assert.equal(d.windows[0].fits, false);
  assert.equal(d.startAfter!.windowId, 'five_hour');
});

test('estimate: prices come through one function, the same numbers as estimateCost', () => {
  const p = modelPrice('anthropic', 'claude-sonnet-5-5')!;
  assert.deepEqual([p.input, p.output, p.cacheRead, p.source], [2, 10, 0.2, 'tabel'], "override where models.dev differs from Anthropic's price page");
  // Everything else comes from the models.dev catalogue: the same numbers as the catalogue row.
  const cat = catalogInfo('anthropic', 'claude-opus-5-5')!;
  const o = modelPrice('anthropic', 'claude-opus-5-5')!;
  assert.deepEqual([o.input, o.output, o.cacheRead, o.source, o.checked], [cat.p![0], cat.p![1], cat.cr, 'catalogus', cat.checked], 'models.dev price');
  assert.equal(modelPrice('bedrock', 'us.anthropic.claude-opus-5-5-v1:0')?.source, 'catalogus', "Bedrock's own catalogue entry");
  const t = { input: 100_000, output: 20_000, cacheRead: 40_000 };
  assert.equal(Math.round(costAt(p, t) * 1e6), Math.round(estimateCost('anthropic', 'claude-sonnet-5-5', t.input, t.output, t.cacheRead)! * 1e6));
  assert.equal(modelPrice('anthropic', 'no-such-model'), null, 'unknown stays unknown');
  assert.deepEqual(modelPrice('mock', 'x', { prices: { '*': [1, 2] } })?.source, 'eigen');
});

// ---------------------------------------------------------------- API

test('GET /usage/estimate: median of the bot\'s last runs times the price; shown when important or over the threshold', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Rekenaar' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    // Before any run: nothing to estimate on, only shown for important work.
    const none = await t.api('GET', `/usage/estimate?agentId=${a.id}`);
    assert.equal(none.basis.source, 'none');
    assert.equal(none.show, false);
    assert.equal((await t.api('GET', `/usage/estimate?agentId=${a.id}&important=1`)).reason, 'important');

    await t.say(th.id, 'een');
    await t.say(th.id, 'twee');
    const e0 = await t.api('GET', `/usage/estimate?agentId=${a.id}`);
    assert.equal(e0.estimated, true);
    assert.equal(e0.basis.source, 'bot');
    assert.equal(e0.basis.runs, 2);
    assert.deepEqual(e0.tokens, { input: 10, output: 5 });
    assert.equal(e0.cost.how, 'unknown', 'no price for the mock model: unknown, never a guess');

    // The owner's own price for this provider (USD per 1M tokens): 10 in × 6,000 + 5 out × 8,000 = $0.10 per run,
    // under the threshold: not shown unless important.
    await t.api('PATCH', `/providers/${t.providerId}`, { config: { prices: { '*': [6000, 8000] } } });
    const e1 = await t.api('GET', `/usage/estimate?agentId=${a.id}`);
    assert.equal(e1.cost.how, 'price');
    assert.ok(Math.abs(e1.cost.usd - 0.1) < 1e-9, String(e1.cost.usd));
    assert.equal(e1.show, false);
    const e2 = await t.api('GET', `/usage/estimate?agentId=${a.id}&important=1`);
    assert.equal(e2.show, true);
    assert.equal(e2.reason, 'important');

    // Someone else's bot: not found.
    await assert.rejects(t.api('GET', '/usage/estimate?agentId=agt_nope'), /404/);
  } finally {
    await t.close();
  }
});

test('GET /usage/estimate: a nearly full window offers "Start na de reset"; routine run-after waits until then', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Zwaar' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'een');
    await t.say(th.id, 'twee');
    const resetsAt = Date.now() + 2 * 3600_000;
    // 95% of the 5-hour window used; TeamBot logged 30 tokens in it, a run is 15 → ~47.5%, only 5% left.
    t.app.ctx.services.usage.report(t.providerId, { windows: [{ id: 'five_hour', label: 'Sessie (5 uur)', usedPercent: 95, resetsAt, level: 'warn', at: Date.now() }], source: 'stream', at: Date.now() });
    const e = await t.api('GET', `/usage/estimate?agentId=${a.id}`);
    const w = e.windows.find((x: any) => x.id === 'five_hour');
    assert.equal(w.share, 47.5);
    assert.equal(w.left, 5);
    assert.equal(w.fits, false);
    assert.equal(e.reason, 'nofit');
    assert.equal(e.startAfter.at, resetsAt + 60_000);

    // A routine of this bot: its own runs come first; none yet → the bot's runs.
    const r = await t.api('POST', '/routines', { name: 'Weekrapport', agent_id: a.id, prompt: 'maak het rapport', schedule: { kind: 'none' }, options: { important: true } });
    const er = await t.api('GET', `/usage/estimate?routineId=${r.id}`);
    assert.equal(er.basis.source, 'bot');
    assert.equal(er.important, true);
    assert.equal(er.startAfter.at, resetsAt + 60_000);

    // "Start na de reset": one waiting run, at that time; not twice; not in the past.
    const rr = await t.api('POST', `/routines/${r.id}/run-after`, { at: er.startAfter.at });
    assert.equal(rr.status, 'retrying');
    const row = t.app.ctx.store.one<any>('SELECT next_retry_at, trigger, meta FROM routine_runs WHERE id = ?', rr.id);
    assert.equal(Date.parse(row.next_retry_at), er.startAfter.at);
    assert.equal(row.trigger, 'manual');
    assert.ok(JSON.parse(row.meta).startAfter);
    await assert.rejects(t.api('POST', `/routines/${r.id}/run-after`, { at: er.startAfter.at }), /409/);
    await assert.rejects(t.api('POST', `/routines/${r.id}/run-after`, { at: Date.now() - 1000 }), /400/);
    // It can be cancelled like any waiting run.
    const c = await t.api('POST', `/routines/runs/${rr.id}/cancel`);
    assert.equal(c.status, 'cancelled');
  } finally {
    await t.close();
  }
});

test('POST /rooms/tasks/:id/start-after: the bot gets the task at the reset, as a one-time routine', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Schrijver' });
    const task = await t.api('POST', '/rooms/tasks', { title: 'Jaarverslag', ownerType: 'agent', ownerId: a.id, important: true, doneWhen: 'pdf in de map' });
    const at = Date.now() + 3 * 3600_000;
    const out = await t.api('POST', `/rooms/tasks/${task.id}/start-after`, { at });
    assert.equal(out.agentName, 'Schrijver');
    const r = await t.api('GET', `/routines/${out.routineId}`);
    assert.equal(r.agent_id, a.id);
    assert.equal(r.schedule.kind, 'once');
    assert.equal(r.status, 'active');
    assert.equal(r.options.important, true, 'an important task stays important');
    assert.match(r.prompt, /Jaarverslag/);
    assert.match(r.prompt, new RegExp(task.id));
    // Within a minute of the requested time (wall time in minutes), never later than a minute after it.
    const next = Date.parse(r.next_run_at);
    assert.ok(next <= at && at - next < 60_000, `${r.next_run_at} vs ${new Date(at).toISOString()}`);

    // A task without a bot, or a time in the past: refused with a plain reason.
    const loose = await t.api('POST', '/rooms/tasks', { title: 'Los' });
    await assert.rejects(t.api('POST', `/rooms/tasks/${loose.id}/start-after`, { at }), /400: Kies eerst welke van je bots/);
    await assert.rejects(t.api('POST', `/rooms/tasks/${task.id}/start-after`, { at: Date.now() - 1 }), /400/);
  } finally {
    await t.close();
  }
});
