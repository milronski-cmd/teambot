import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import {
  acpContext,
  claudeContextFromUsage,
  claudeContextWindow,
  codexContext,
  durationLabel,
  levelOf,
  mergeWindows,
  parseClaudeRateLimitEvent,
  parseClaudeUsageText,
  parseCodexRateLimits,
  parseOpencodeStats,
  worstWindow,
} from '../server/modules/usage/parse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => fs.readFileSync(path.join(here, 'fixtures', 'usage', n), 'utf8');
const FAKE_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');
const FAKE_CODEX = path.join(here, 'fixtures', 'cli-agents-fake-codex.mjs');
const NOW = Date.parse('2026-11-07T01:30:00Z');

// ---------------------------------------------------------------- parsers (recorded from the real CLIs)

test('claude rate_limit_event (recorded, Claude Code 2.1.319): weekly window, utilisation, reset, overage off', () => {
  const r = parseClaudeRateLimitEvent(JSON.parse(fx('claude-rate-limit-event.json')), NOW)!;
  assert.equal(r.windows.length, 1, 'top-level window is the same as the unified one');
  const w = r.windows[0];
  assert.equal(w.id, 'seven_day');
  assert.equal(w.label, 'Week · alle modellen');
  assert.equal(w.usedPercent, 44);
  assert.equal(w.resetsAt, 1794546000_000);
  assert.equal(w.level, 'ok', 'Claude\'s own "allowed_warning" at 44% is no limit warning');
  assert.equal(r.blocked, false);
  assert.match(r.note!, /Extra gebruik/);
  assert.equal(r.source, 'stream');
});

test('claude rate_limit_event rejected → limit and blocked; five_hour gets its own label', () => {
  const r = parseClaudeRateLimitEvent({ rate_limit_info: { status: 'rejected', resetsAt: 1794000000, rateLimitType: 'five_hour', utilization: 1 } }, NOW)!;
  assert.equal(r.windows[0].id, 'five_hour');
  assert.equal(r.windows[0].label, 'Sessie (5 uur)');
  assert.equal(r.windows[0].level, 'limit');
  assert.equal(r.blocked, true);
  assert.equal(parseClaudeRateLimitEvent({ type: 'rate_limit_event' }), null);
  assert.equal(parseClaudeRateLimitEvent({ rate_limit_info: { rateLimitType: 'seven_day_opus', utilization: 0.83 } }, NOW)!.windows[0].label, 'Week · Opus');
});

test('claude /usage text (recorded): all windows with reset in the stated zone, subscription billing', () => {
  const lines = fx('claude-usage-command.jsonl').trim().split('\n').map((l) => JSON.parse(l));
  const result = lines.find((l) => l.type === 'result');
  assert.equal(result.local_command, 'usage', 'answered by the local command (no model call)');
  assert.equal(result.total_cost_usd, 0);
  const r = parseClaudeUsageText(result.result, NOW, 'UTC')!;
  assert.equal(r.billing, 'subscription');
  assert.deepEqual(
    r.windows.map((w) => [w.id, w.label, w.usedPercent]),
    [
      ['seven_day', 'Week · alle modellen', 44],
      ['seven_day_fable', 'Week · Fable', 0],
    ],
  );
  assert.equal(new Date(r.windows[0].resetsAt!).toISOString(), '2026-11-13T04:59:00.000Z', '5:59am Europe/Amsterdam (zone from the text)');
  const s = parseClaudeUsageText('Current session: 100% used · resets 3:59pm (Europe/Amsterdam)\nCurrent week (Sonnet only): 81% used · resets Nov 13, 5:59am (Europe/Amsterdam)', NOW)!;
  assert.equal(s.windows[0].id, 'five_hour');
  assert.equal(s.windows[0].level, 'limit');
  assert.equal(new Date(s.windows[0].resetsAt!).toISOString(), '2026-11-07T14:59:00.000Z');
  assert.equal(s.windows[1].id, 'seven_day_sonnet');
  assert.equal(s.windows[1].level, 'warn');
  assert.equal(s.blocked, true);
  assert.equal(parseClaudeUsageText('Unknown skill: usage'), null, 'no numbers → nothing invented');
});

test('codex account/rateLimits/read (recorded, ChatGPT Go): 30-day window, plan; weekly/5h labels by duration', () => {
  const r = parseCodexRateLimits(JSON.parse(fx('codex-rate-limits.json')), NOW)!;
  assert.equal(r.plan, 'ChatGPT Go');
  assert.equal(r.billing, 'subscription');
  assert.equal(r.windows.length, 1, 'rateLimitsByLimitId and rateLimits are the same bucket');
  assert.deepEqual([r.windows[0].id, r.windows[0].label, r.windows[0].usedPercent, r.windows[0].resetsAt], ['codex:43200', '30 dagen', 30, 1796164474_000]);
  assert.equal(r.blocked, undefined);
  assert.equal(durationLabel(300), '5 uur');
  assert.equal(durationLabel(10080), 'Week');
  assert.equal(durationLabel(null), 'Limiet');
  const hit = parseCodexRateLimits({ ordinaryUsageAllowed: false, rateLimits: { limitId: 'codex', primary: { usedPercent: 100, windowDurationMins: 300, resetsAt: null }, rateLimitReachedType: 'rate_limit_reached', planType: 'plus' } }, NOW)!;
  assert.equal(hit.blocked, true);
  assert.equal(hit.windows[0].level, 'limit');
  assert.equal(hit.windows[0].resetsAt, null, 'unknown reset stays unknown');
});

test('opencode stats (recorded) and context fill parsers', () => {
  assert.deepEqual(parseOpencodeStats(JSON.parse(fx('opencode-stats.json'))), { input: 0, output: 0, cost: 0, sessions: 0 });
  assert.deepEqual(parseOpencodeStats({ sessions: 2, tokens: { input: 10, output: 5, reasoning: 1, cache: { read: 100, write: 3 } }, cost: 0.02 }), { input: 113, output: 6, cost: 0.02, sessions: 2 });
  const res = JSON.parse(fx('claude-result.json'));
  assert.equal(claudeContextWindow(res, 'claude-haiku-5-5'), 1_000_000, 'modelUsage.contextWindow');
  assert.equal(claudeContextFromUsage(res.usage), 2 + 3155 + 649 + 4);
  assert.equal(res.modelUsage['claude-haiku-5-5'].costBasis, 'list', 'total_cost_usd is a list-price value');
  assert.deepEqual(codexContext({ tokenUsage: { last: { totalTokens: 25000 }, modelContextWindow: 258400 } }), { used: 25000, window: 258400 });
  assert.deepEqual(acpContext({ sessionUpdate: 'usage_update', used: 1200, size: 128000 }), { used: 1200, window: 128000 });
  assert.equal(acpContext({ used: 0 }), null);
});

test('merge: newer report replaces a window; a passed reset clears the percentage; worst first', () => {
  const a = [{ id: 'five_hour', label: '5', usedPercent: 95, resetsAt: NOW + 1000, level: 'warn' as const, at: NOW - 5000 }];
  const b = [{ id: 'seven_day', label: 'w', usedPercent: 40, resetsAt: NOW + 86_400_000, level: 'ok' as const, at: NOW }];
  const m = mergeWindows(a, b, NOW);
  assert.equal(m.length, 2);
  assert.equal(worstWindow(m)!.id, 'five_hour');
  const later = mergeWindows(m, [], NOW + 2000);
  assert.equal(later.find((w) => w.id === 'five_hour')!.usedPercent, null, 'after the reset the old number is not shown as current');
  assert.equal(levelOf(79), 'ok');
  assert.equal(levelOf(80), 'warn');
  assert.equal(levelOf(null), 'unknown');
});

// ---------------------------------------------------------------- service + API (fake CLIs)

async function cliBot(t: TestApp, kind: string, config: any, agent: any = {}) {
  const p = await t.api('POST', '/providers', { kind, config });
  const a = await t.api('POST', '/agents', { name: 'CliBot', provider_id: p.id, model: '', access_mode: 'ask', ...agent });
  const th = await t.api('POST', '/threads', { agentId: a.id });
  return { p, a, th };
}

function notifications(t: TestApp) {
  const list: any[] = [];
  const off = t.app.ctx.events.subscribe((e) => e.type === 'notification' && e.data?.kind === 'limit' && list.push(e.data));
  return { list, off };
}

test('claude run: rate limit from the stream, list-price value next to cost 0, context ring, warn once', async () => {
  const t = await startTestApp();
  const n = notifications(t);
  try {
    const { p, a, th } = await cliBot(t, 'claude-code', { path: FAKE_CLAUDE });
    await t.say(th.id, 'Hallo');
    let lim = await t.api('GET', '/usage/limits');
    let e = lim.engines.find((x: any) => x.providerId === p.id);
    assert.equal(e.type, 'cli');
    assert.equal(e.billing, 'subscription', 'from claude auth status (claude.ai login)');
    assert.equal(e.windows[0].id, 'five_hour');
    assert.equal(e.windows[0].usedPercent, 20);
    assert.equal(e.spend.today.cost, 0, 'covered by the subscription');
    assert.equal(e.spend.today.value, 0.25, 'estimated value at list price from Claude Code');
    const ctxv = await t.api('GET', `/usage/context/${th.id}`);
    assert.equal(ctxv.kind, 'engine');
    assert.equal(ctxv.used, 10 + 4000 + 990 + 6);
    assert.equal(ctxv.window, 200000);
    assert.equal(ctxv.canCompact, true);
    assert.equal(n.list.length, 0, '20% → no notification');

    await t.say(th.id, 'SCENARIO:limitwarn');
    await t.say(th.id, 'SCENARIO:limitwarn nog een keer');
    lim = await t.api('GET', '/usage/limits');
    e = lim.engines.find((x: any) => x.providerId === p.id);
    assert.equal(e.windows[0].usedPercent, 91);
    assert.equal(e.worst.level, 'warn');
    assert.equal(n.list.filter((x) => x.level === 'warn').length, 1, 'one warning per window and period');
    assert.match(n.list[0].title, /91% van je limiet/);

    // "Nu samenvatten" on a Claude Code bot → Claude's own /compact on this chat's session.
    const c = await t.api('POST', `/threads/${th.id}/compact`, { agentId: a.id });
    assert.equal(c.compacted, true, JSON.stringify(c));
    const after = await t.api('GET', `/usage/context/${th.id}`);
    assert.equal(after.used, 9000, 'post_tokens from compact_boundary');
    assert.equal(after.window, 200000, 'window kept');
    assert.ok(t.app.ctx.store.messages(th.id).some((m) => m.role === 'event' && /samengevat/.test(m.content)));
  } finally {
    n.off();
    await t.close();
  }
});

test('claude limit hit: blocked with reset, one "bereikt" notification, "weer beschikbaar" when the reset passes', async () => {
  const t = await startTestApp();
  const n = notifications(t);
  try {
    const { p, th } = await cliBot(t, 'claude-code', { path: FAKE_CLAUDE });
    await t.say(th.id, 'SCENARIO:limithit');
    const e = (await t.api('GET', '/usage/limits')).engines.find((x: any) => x.providerId === p.id);
    assert.ok(e.blocked, 'blocked');
    assert.ok(e.blocked.until > Date.now() + 50 * 60_000, 'reset from the event (~1 h)');
    assert.ok(e.pausedUntil, 'the runner skips this engine until the reset');
    assert.equal(n.list.filter((x) => x.level === 'limit').length, 1);
    // The reset comes closer (as if time passed): the timer says it is available again, once.
    const svc = t.app.ctx.services.usage;
    svc.limitHit(t.app.ctx.auth.owner()!.id, p.id, Date.now() + 300);
    for (let i = 0; i < 60 && !n.list.some((x) => x.level === 'reset'); i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(n.list.filter((x) => x.level === 'reset').length, 1, 'reset notification');
    assert.equal(n.list.filter((x) => x.level === 'limit').length, 1, 'no second "bereikt"');
    assert.equal((await t.api('GET', `/usage/limits/${p.id}`)).blocked, null);
  } finally {
    n.off();
    await t.close();
  }
});

test('API 429: a short rate limit is shown but not notified; an unknown reset clears silently later', async () => {
  const t = await startTestApp();
  const n = notifications(t);
  try {
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ error: { message: 'Rate limit reached. Please try again in 20s.', status: 429 } });
    await t.say(th.id, 'hallo');
    let e = await t.api('GET', `/usage/limits/${t.providerId}`);
    assert.ok(e.blocked && e.blocked.until > Date.now(), 'blocked for ~20 s');
    assert.equal(n.list.length, 0, 'a 20-second rate limit is no news');
    const svc = t.app.ctx.services.usage;
    svc.state(t.providerId).blocked = null;
    svc.limitHit(t.app.ctx.auth.owner()!.id, t.providerId, null, 'quota exceeded');
    e = await t.api('GET', `/usage/limits/${t.providerId}`);
    assert.equal(e.blocked.until, null, 'reset unknown → shown as unknown');
    assert.ok(e.blocked.clearAt > Date.now() + 25 * 60_000, 'shown for the runner\'s own wait (30 min), not forever');
    assert.equal(n.list.filter((x) => x.level === 'limit').length, 1, 'an open-ended limit is notified');
    // The wait is over without word from the engine: the mark goes away, without claiming "weer beschikbaar".
    const st = svc.state(t.providerId);
    st.blocked.clearAt = Date.now() + 100;
    (svc as any).arm(st, t.app.ctx.providers.config(t.providerId));
    for (let i = 0; i < 40 && svc.state(t.providerId).blocked; i++) await new Promise((r) => setTimeout(r, 100));
    assert.equal(svc.state(t.providerId).blocked, null);
    assert.equal(n.list.filter((x) => x.level === 'reset').length, 0);
  } finally {
    n.off();
    await t.close();
  }
});

test('refresh: claude /usage (local command) and codex app-server rate limits, warn at 80%; alerts can be turned off', async () => {
  const t = await startTestApp();
  const n = notifications(t);
  try {
    const { p: pc } = await cliBot(t, 'claude-code', { path: FAKE_CLAUDE });
    const c = await t.api('POST', `/usage/limits/${pc.id}/refresh`);
    assert.deepEqual(
      c.windows.map((w: any) => [w.id, w.usedPercent]),
      [
        ['five_hour', 12],
        ['seven_day', 86],
      ],
    );
    assert.equal(c.source, 'usage-command');
    assert.ok(c.checkedAt);
    assert.equal(n.list.filter((x) => x.level === 'warn').length, 1, '86% weekly → warn');

    await t.api('PUT', '/usage/alerts', { enabled: false });
    const p2 = await t.api('POST', '/providers', { kind: 'codex-cli', config: { path: FAKE_CODEX } });
    const x = await t.api('POST', `/usage/limits/${p2.id}/refresh`);
    assert.equal(x.plan, 'ChatGPT Plus');
    assert.deepEqual(
      x.windows.map((w: any) => [w.label, w.usedPercent, w.level]),
      [
        ['5 uur', 42, 'ok'],
        ['Week', 97, 'warn'],
      ],
    );
    assert.equal(n.list.length, 1, 'alerts off → no new notification');
    assert.ok(!JSON.stringify(x).includes('geheim'), 'no account id or e-mail');
    assert.deepEqual((await t.api('GET', '/usage/limits')).alerts, { enabled: false, warnAt: 80 });
  } finally {
    n.off();
    await t.close();
  }
});

test('codex ask mode: live rate-limit update and context window from the app-server', async () => {
  const t = await startTestApp();
  try {
    const { p, th } = await cliBot(t, 'codex-cli', { path: FAKE_CODEX }, { access_mode: 'ask' });
    const sent = t.say(th.id, 'Maak een bestand');
    for (let i = 0; i < 100 && !t.app.ctx.store.all("SELECT 1 FROM approvals WHERE status = 'pending'").length; i++) await new Promise((r) => setTimeout(r, 50));
    const apr = t.app.ctx.store.one<any>("SELECT id FROM approvals WHERE status = 'pending'");
    await t.api('POST', `/approvals/${apr.id}`, { decision: 'deny' });
    await sent;
    const e = await t.api('GET', `/usage/limits/${p.id}`);
    assert.equal(e.windows.find((w: any) => w.label === '5 uur')?.usedPercent, 43);
    const c = await t.api('GET', `/usage/context/${th.id}`);
    // Codex can be compacted on request now (app-server thread/compact/start, see tests/cli-compaction.test.ts).
    assert.deepEqual([c.used, c.window, c.canCompact], [25000, 258400, true]);
    assert.match(c.compactNote, /Codex vat de sessie van dit gesprek samen/);
  } finally {
    await t.close();
  }
});

test('API bot: context ring = estimated history vs. the bot budget; status lists running bots and what waits', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ settings: { historyTokens: 1000 } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'x'.repeat(700));
    const c = await t.api('GET', `/usage/context/${th.id}`);
    assert.equal(c.kind, 'history');
    assert.equal(c.window, 1000);
    assert.equal(c.estimated, true);
    assert.ok(c.used > 200 && c.percent > 20, JSON.stringify(c));
    const lim = await t.api('GET', '/usage/limits');
    const e = lim.engines.find((x: any) => x.providerId === t.providerId);
    assert.equal(e.billing, 'paid');
    assert.equal(e.canRead, false);
    assert.deepEqual(e.windows, [], 'an API key has no subscription windows → nothing shown as if known');
    const s = await t.api('GET', '/usage/status');
    assert.deepEqual(s, { runs: [], approvals: [] });
    await assert.rejects(t.api('POST', `/usage/limits/${t.providerId}/refresh`), /geeft zijn limieten niet door/);
  } finally {
    await t.close();
  }
});

test('Nu bezig (0.4.5): a working bot with its step, and its own browser while it runs (for the live picture and Overnemen)', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const a = await t.agent({ name: 'Surfer' });
    const b = await t.agent({ name: 'Schrijver' });
    const ta = await t.api('POST', '/threads', { agentId: a.id });
    const tb = await t.api('POST', '/threads', { agentId: b.id });
    const ra = ctx.store.createRun({ thread_id: ta.id, agent_id: a.id, user_id: a.user_id, status: 'running' });
    const msg = ctx.store.createMessage({ thread_id: ta.id, role: 'assistant', author_type: 'agent', author_id: a.id, author_name: a.name, content: '', status: 'streaming', run_id: ra.id, parts: { toolCalls: [{ id: 'c1', name: 'browser_open', args: {}, status: 'running', summary: 'Opent bol.com' }] } } as any);
    assert.ok(msg.id);
    ctx.store.createRun({ thread_id: tb.id, agent_id: b.id, user_id: b.user_id, status: 'running' });
    // The browser module's view of each bot's computer (a running browser only for Surfer, the user has control).
    const real = ctx.services.computers;
    ctx.services.computers = {
      ...real,
      status: (id: string) => (id === a.id ? { browser: { running: true, url: 'https://www.bol.com/', title: 'bol.com', filling: false }, controller: { kind: 'user', name: 'Sanne', secret: 'x' } } : { browser: { running: false }, controller: null }),
    };
    const s = await t.api('GET', '/usage/status');
    const surfer = s.runs.find((r: any) => r.agentId === a.id);
    const writer = s.runs.find((r: any) => r.agentId === b.id);
    assert.equal(surfer.doing, 'Opent bol.com', 'the current step');
    assert.deepEqual(surfer.browser, { url: 'https://www.bol.com/', title: 'bol.com', controller: { kind: 'user', name: 'Sanne' }, filling: false }, 'only the page and who has control');
    assert.equal(writer.browser, null, 'no browser: no picture, no Overnemen');
    // The browser module throws: the overview still answers.
    ctx.services.computers = { ...real, status: () => { throw new Error('kapot'); } };
    assert.equal((await t.api('GET', '/usage/status')).runs.find((r: any) => r.agentId === a.id).browser, null);
    ctx.services.computers = real;
  } finally {
    await t.close();
  }
});
