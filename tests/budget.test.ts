import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { BUDGET_TEXT, assertBudget, budgetText, isBudgetError, nextDay, spentToday } from '../server/agent/budget.js';
import { DONE_MS, moodFrom } from '../ui/src/lib/moodCore.js';
import { MOOD_LABELS, botSvg } from '../shared/botface.js';
import { classifyError } from '../server/modules/routines/engine.js';
import { isUsageLimit } from '../server/modules/routines/limits.js';
import { usdText } from '../server/core/i18n.js';

/**
 * The daily budget (acceptance round 6, B-70). A model call's cost is only known afterwards; the check before a run
 * alone let one long run go past the budget. Now: checked before every model call, with the previous call as the
 * estimate; reaching it is a limit with its own words, not "er ging iets mis".
 */

/** A paid mock engine: 10 input + 5 output tokens per call at these own prices = US$ 0,10 per model call. */
async function pricedBot(t: TestApp, data: any = {}) {
  const p = await t.api('POST', '/providers', { kind: 'mock', name: 'Prijsmodel', config: { prices: { '*': [6000, 8000] } } });
  const a = await t.agent({ provider_id: p.id, name: 'Prijsbot', ...data });
  const th = await t.api('POST', '/threads', { agentId: a.id });
  return { p, a, th };
}

const owner = (t: TestApp) => t.app.ctx.auth.owner()!.id;
const runsOf = (t: TestApp, threadId: string) => t.app.ctx.store.all<any>('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at', threadId).map((r) => ({ ...r, meta: JSON.parse(r.meta || '{}') }));

test('a long run stops between steps once the next step would not fit the daily budget, with what it did above (B-70)', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const { th } = await pricedBot(t);
    await t.api('PUT', '/settings', { dailyBudgetUsd: 0.25 });
    // Three steps with tools, then an answer: before, only the start was checked and the run spent US$ 0,40.
    t.script.push({ toolCalls: [{ name: 'list_files', args: {} }] }, { toolCalls: [{ name: 'list_files', args: {} }] }, { toolCalls: [{ name: 'list_files', args: {} }] }, { text: 'Klaar' });
    const before = t.requests.length;
    const msgs = await t.say(th.id, 'Doe drie stappen');
    assert.equal(t.requests.length - before, 2, 'two calls fit (US$ 0,20); the third would have made US$ 0,30');
    const spent = spentToday(t.app.ctx, owner(t));
    assert.ok(Math.abs(spent - 0.2) < 1e-9, `spent ${spent}`);
    assert.ok(spent <= 0.25, 'not past the budget');
    // The steps it did stay; below them one plain notice that it stopped halfway, with when and where to raise it.
    assert.equal(msgs.filter((m: any) => m.role === 'tool').length, 2, 'the tools of both steps ran');
    const stop = msgs.at(-1)!;
    assert.equal(stop.role, 'assistant');
    assert.equal(stop.status, 'error');
    assert.equal(stop.parts.budget.midRun, true);
    assert.equal(stop.parts.budget.limit, 0.25);
    assert.ok(Math.abs(stop.parts.budget.estimate - 0.1) < 1e-9);
    assert.match(stop.parts.error, /^Daglimiet van US\$\s?0,25 bereikt: vandaag is US\$\s?0,20 gebruikt en de volgende stap kost naar schatting US\$\s?0,10 \(zoveel kostte de vorige\)\./);
    assert.match(stop.parts.error, /Om 00:00 begint een nieuwe dag en werkt de bot weer\./);
    assert.match(stop.parts.error, /verhoog de limiet dan in Instellingen › Meer mogelijkheden › Kosten\./);
    assert.ok(!/er ging iets mis/i.test(stop.parts.error));
    // The run says it was the budget (the face and notifications read it), not a failure in the server log's sense.
    const run = runsOf(t, th.id).at(-1)!;
    assert.equal(run.status, 'error');
    assert.equal(run.meta.budget.midRun, true);
    assert.equal(run.meta.budget.resetAt, nextDay().toISOString());
    // The sidebar knows it from the conversation list too (before anything happened in a new session).
    const list = await t.api('GET', '/threads');
    assert.equal(list.find((x: any) => x.id === th.id).last.budgetUntil, nextDay().toISOString());
    // The error bubble is not sent to the model again.
    await t.api('PUT', '/settings', { dailyBudgetUsd: 0 });
    t.script.push({ text: 'Verder' });
    await t.api('POST', `/threads/${th.id}/retry`);
    await t.waitIdle(th.id);
    assert.ok(!t.requests.at(-1)!.messages.some((m: any) => m.role === 'assistant' && !m.content && !m.toolCalls?.length), 'no empty error bubble in the history');
  } finally {
    await t.close();
  }
});

test('the next message does not start when its estimate does not fit; a used-up budget says so plainly (B-70)', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const { th } = await pricedBot(t);
    await t.api('PUT', '/settings', { dailyBudgetUsd: 0.15 });
    t.script.push({ text: 'Eén' });
    await t.say(th.id, 'Bericht 1');
    assert.ok(Math.abs(spentToday(t.app.ctx, owner(t)) - 0.1) < 1e-9);
    // Message 2 would cost about what message 1 cost (US$ 0,10): 0,20 > 0,15, so it does not start (before: it ran,
    // and the day ended at US$ 0,20).
    const before = t.requests.length;
    const msgs = await t.say(th.id, 'Bericht 2');
    assert.equal(t.requests.length, before, 'no model call');
    assert.ok(Math.abs(spentToday(t.app.ctx, owner(t)) - 0.1) < 1e-9, 'still within the budget');
    const stop = msgs.at(-1)!;
    assert.equal(stop.parts.budget.midRun, undefined);
    assert.match(stop.parts.error, /de volgende stap kost naar schatting US\$\s?0,10/);
    // A budget that is used up (other features, another bot): the plain sentence, without an estimate.
    t.app.ctx.store.insert('usage_log', { user_id: owner(t), agent_id: null, provider_id: null, model: 'stem', input: 0, output: 0, cost: 0.05, created_at: new Date().toISOString() });
    const used = (await t.say(th.id, 'Bericht 3')).at(-1)!;
    assert.match(used.parts.error, /^Daglimiet van US\$\s?0,15 bereikt \(vandaag US\$\s?0,15 gebruikt\)\. Om 00:00 begint een nieuwe dag en werkt de bot weer\. Wil je vandaag verder, verhoog de limiet dan in Instellingen › Meer mogelijkheden › Kosten\.$/);
    assert.equal(used.parts.budget.estimate, undefined);
    // Instellingen › Meer mogelijkheden › Kosten: today against the budget that applies, from the same sum the runner checks.
    const u = await t.api('GET', '/usage?days=7');
    assert.ok(Math.abs(u.today.spent - 0.15) < 1e-9);
    assert.equal(u.today.limit, 0.15);
    assert.equal(u.today.byAdmin, false);
    // Raising the budget lets the bot go on at once.
    await t.api('PUT', '/settings', { dailyBudgetUsd: 1 });
    t.script.push({ text: 'Twee' });
    assert.equal((await t.say(th.id, 'Bericht 4')).at(-1)!.content, 'Twee');
  } finally {
    await t.close();
  }
});

test('a member whose budget is the admin cap is told to ask the admin; the stop is a limit in the notifications', async () => {
  const t = await startTestApp({ mode: 'server' });
  try {
    const m = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@test.local', password: 'wachtwoord123', role: 'member' });
    t.app.ctx.store.setSetting('', 'memberPolicy', { dailyBudgetUsd: 0.25 });
    t.app.ctx.store.insert('usage_log', { user_id: m.id, agent_id: null, provider_id: null, model: 'x', input: 0, output: 0, cost: 0.3, created_at: new Date().toISOString() });
    assert.throws(
      () => assertBudget(t.app.ctx, m.id),
      (e: any) => isBudgetError(e) && e.budget.byAdmin === true && /vraag de beheerder dan om een hoger dagbudget\./.test(e.message) && !/Instellingen › Meer mogelijkheden › Kosten/.test(e.message),
    );
    // A member with a lower budget of his own can raise that himself (up to the cap).
    t.app.ctx.store.setSetting(m.id, 'dailyBudgetUsd', 0.2);
    assert.throws(() => assertBudget(t.app.ctx, m.id), (e: any) => isBudgetError(e) && !e.budget.byAdmin && /Instellingen › Meer mogelijkheden › Kosten/.test(e.message));

    // The owner's paid bot stops at the budget: the notification says "heeft de daglimiet bereikt", not "liep vast".
    const { th } = await pricedBot(t);
    await t.api('PUT', '/settings', { dailyBudgetUsd: 0.1 });
    t.app.ctx.store.insert('usage_log', { user_id: owner(t), agent_id: null, provider_id: null, model: 'x', input: 0, output: 0, cost: 0.1, created_at: new Date().toISOString() });
    await t.say(th.id, 'hallo');
    let n: any;
    for (let i = 0; i < 40 && !n; i++) {
      n = t.app.ctx.store.one<any>("SELECT * FROM notifications WHERE user_id = ? AND kind = 'run' ORDER BY created_at DESC LIMIT 1", owner(t));
      if (!n) await new Promise((r) => setTimeout(r, 25));
    }
    assert.ok(n, 'a notification');
    assert.equal(n.title, 'Prijsbot heeft de daglimiet bereikt');
    assert.match(n.body, /^Daglimiet van/);
  } finally {
    await t.close();
  }
});

test('budget texts: whole sentences with the reset time; routines see our own budget, not an engine limit', () => {
  const resetAt = new Date(2026, 10, 9, 0, 0, 0).toISOString();
  assert.equal(budgetText({ limit: 2, spent: 2.1, resetAt }), `Daglimiet van ${usdText(2)} bereikt (vandaag ${usdText(2.1)} gebruikt). Om 00:00 begint een nieuwe dag en werkt de bot weer. Wil je vandaag verder, verhoog de limiet dan in Instellingen › Meer mogelijkheden › Kosten.`);
  const text = budgetText({ limit: 0.3, spent: 0.2, estimate: 0.2, resetAt, byAdmin: true });
  assert.match(text, /naar schatting/);
  assert.match(text, /vraag de beheerder/);
  for (const s of [text, 'Daglimiet van $1.00 bereikt']) {
    assert.ok(BUDGET_TEXT.test(s));
    assert.equal(classifyError(s), 'limit', 'never retried as a provider error');
    assert.equal(isUsageLimit(s), false, 'not waited for as an engine limit');
  }
});

test('the face: "daglimiet bereikt" until the new day, then ready again; a real failure stays "er ging iets mis"', () => {
  const now = Date.now();
  const base = { paused: false, waiting: false, working: false, failed: true, doneAt: 0 };
  assert.equal(moodFrom({ ...base, limitUntil: now + 3600_000 }, now), 'limit');
  assert.equal(moodFrom({ ...base, limitUntil: now - 1 }, now), 'idle', 'after midnight the bot is simply ready');
  assert.equal(moodFrom({ ...base }, now), 'error');
  assert.equal(moodFrom({ ...base, working: true, limitUntil: now + 1000 }, now), 'working', 'a new run wins');
  assert.equal(moodFrom({ ...base, failed: false, doneAt: now - DONE_MS / 2 }, now), 'done');
  assert.equal(MOOD_LABELS.limit, 'daglimiet bereikt');
  const svg = botSvg('x', { mood: 'limit', uid: 'limit1' });
  assert.ok(svg.startsWith('<svg') && svg.endsWith('</svg>') && !/NaN|undefined/.test(svg));
});

test('a group bot stopped by the daily budget shows "daglimiet bereikt" in the group, not "fout"', async () => {
  const t = await startTestApp();
  try {
    const { a } = await pricedBot(t);
    const r = await t.api('POST', '/rooms', { name: 'Fietsteam', agentIds: [a.id], mode: 'everyone' });
    await t.api('PUT', '/settings', { dailyBudgetUsd: 0.1 });
    t.app.ctx.store.insert('usage_log', { user_id: owner(t), agent_id: null, provider_id: null, model: 'x', input: 0, output: 0, cost: 0.1, created_at: new Date().toISOString() });
    await t.say(r.threadId, 'hallo team');
    let bot: any;
    for (let i = 0; i < 40 && bot?.state !== 'limit'; i++) {
      bot = (await t.api('GET', `/rooms/${r.room.id}`)).bots.find((b: any) => b.agentId === a.id);
      if (bot?.state !== 'limit') await new Promise((res) => setTimeout(res, 25));
    }
    assert.equal(bot.state, 'limit');
    assert.match(bot.stateDetail, /^Daglimiet van .* Om 00:00 begint een nieuwe dag/);
  } finally {
    await t.close();
  }
});
