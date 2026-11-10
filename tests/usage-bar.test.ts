// The always-visible usage bar (package E of 0.4): the windows of Claude and Codex from recorded CLI output, the free
// sources (dots) other modules report, the weekly reserve mark, usage per bot, a read soon after a run, and the limit
// notifications (once at 80%, once at the limit, per window and period).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';
import { parseClaudeRateLimitEvent, parseClaudeUsageText, parseCodexRateLimits, type LimitReport, type LimitWindow } from '../server/modules/usage/parse.js';
import { blockedUntil, cleanReserve, cleanSource, effectiveSource, sortWindows, toMs, weekStart } from '../server/modules/usage/bar.js';
import { barTone, effectiveStatus, engineName, percentText, resetLong, resetShort, sharedWith, sourceSentence, sourceShort, windowName, windowSentence } from '../ui/src/modules/usage/bar.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const fx = (n: string) => fs.readFileSync(path.join(here, 'fixtures', 'usage', n), 'utf8');
const FAKE_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');
const FAKE_CODEX = path.join(here, 'fixtures', 'cli-agents-fake-codex.mjs');
const FAKE_ACP = path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs');
const RECORDED_AT = Date.parse('2026-11-07T01:30:00Z');

/** A recorded report moved to "now", so the recorded numbers stay current whatever day the test runs. */
function rebase(r: LimitReport): LimitReport {
  const shift = Date.now() - RECORDED_AT;
  return { ...r, at: Date.now(), windows: r.windows.map((w) => ({ ...w, at: Date.now(), resetsAt: w.resetsAt ? w.resetsAt + shift : null })) };
}
const win = (id: string, usedPercent: number | null, resetsAt: number | null, level: LimitWindow['level'] = usedPercent === null ? 'unknown' : usedPercent >= 100 ? 'limit' : usedPercent >= 80 ? 'warn' : 'ok'): LimitWindow => ({ id, label: id, usedPercent, resetsAt, level, at: Date.now() });

function events(t: TestApp, type: string) {
  const list: any[] = [];
  const off = t.app.ctx.events.subscribe((e) => e.type === type && list.push(e));
  return { list, off };
}
const until = async (f: () => boolean, ms = 6000) => {
  for (let i = 0; i < ms / 50 && !f(); i++) await new Promise((r) => setTimeout(r, 50));
  return f();
};

// ---------------------------------------------------------------- pure helpers

test('server helpers: window order, blocked until (all full windows reset), sources, reserve, week start', () => {
  const ids = sortWindows([win('seven_day_opus', 1, null), win('codex:10080', 1, null), win('seven_day', 1, null), win('codex:300', 1, null), win('five_hour', 1, null), win('spark:300', 1, null)]).map((w) => w.id);
  // By length (equal lengths by id; one engine never has both kinds), another limit of the same account last.
  assert.deepEqual(ids, ['codex:300', 'five_hour', 'codex:10080', 'seven_day', 'seven_day_opus', 'spark:300']);
  const now = Date.now();
  // Both windows full: available only after the week resets too. Refused without numbers: the earliest reset.
  assert.equal(blockedUntil([win('five_hour', 100, now + 3600e3), win('seven_day', 100, now + 3 * 864e5)]).until, now + 3 * 864e5);
  assert.equal(blockedUntil([win('five_hour', 100, now + 3600e3), win('seven_day', 90, now + 3 * 864e5, 'limit')]).until, now + 3600e3);
  assert.equal(blockedUntil([win('codex:300', 60, now + 600e3, 'limit'), win('codex:10080', 70, now + 864e5, 'limit')]).until, now + 600e3);
  assert.deepEqual(blockedUntil([]), { until: null });

  assert.equal(cleanSource({ id: 'bad id!', label: 'X', status: 'available' }), null, 'id with spaces');
  assert.equal(cleanSource({ id: 'groq', label: '  ', status: 'available' }), null, 'no label');
  const s = cleanSource({ id: 'groq', label: 'Groq', status: 'limited', resetsAt: '2026-11-09T13:18:00Z', usedPercent: 140, estimated: true, note: 'x'.repeat(500), providerId: 'prv_1' })!;
  assert.equal(s.userId, '*', 'no user = everybody');
  assert.equal(s.resetsAt, Date.parse('2026-11-09T13:18:00Z'));
  assert.equal(s.usedPercent, 100);
  assert.equal(s.note!.length, 200);
  assert.equal(cleanSource({ id: 'k', label: 'Kilo', status: 'weird' })!.status, 'unknown');
  assert.equal(toMs(1794546000), 1794546000_000, 'epoch seconds');
  assert.equal(toMs(1794546000_000), 1794546000_000, 'epoch ms');
  assert.equal(toMs('nonsense'), null);
  assert.equal(effectiveSource({ status: 'limited' as const, resetsAt: now - 1 }, now).status, 'available', 'reset passed');
  assert.equal(effectiveSource({ status: 'limited' as const, resetsAt: now + 1000 }, now).status, 'limited');

  assert.equal(cleanReserve({ atPercent: 0 }), null);
  assert.deepEqual({ ...cleanReserve({ atPercent: 85, active: true })!, at: 0 }, { userId: '*', providerId: null, windowId: 'seven_day', atPercent: 85, active: true, at: 0 });

  const mon = weekStart(new Date('2026-11-12T15:00:00'));
  assert.equal(mon.getDay(), 1, 'Monday');
  assert.equal(mon.getDate(), 9);
  assert.equal(weekStart(new Date('2026-11-15T23:00:00')).getDate(), 9, 'Sunday belongs to the week that started on Monday');
  assert.equal(weekStart(new Date('2026-11-09T00:30:00')).getDate(), 9);
});

test('ui helpers: green / orange from 80% / red at the limit; short names; resets; sentences never colour alone', () => {
  assert.equal(barTone({ usedPercent: 79, level: 'ok' }), 'ok');
  assert.equal(barTone({ usedPercent: 80, level: 'warn' }), 'warn');
  assert.equal(barTone({ usedPercent: 80, level: 'ok' }), 'warn', 'orange from 80% whatever the engine said');
  assert.equal(barTone({ usedPercent: 100, level: 'limit' }), 'danger');
  assert.equal(barTone({ usedPercent: 40, level: 'limit' }), 'danger', 'the engine refused');
  assert.equal(barTone({ usedPercent: null, level: 'unknown' }), 'unknown');

  assert.deepEqual(
    ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_fable', 'codex:300', 'codex:10080', 'codex:43200'].map((id) => windowName({ id, label: '?' })),
    ['5 uur', 'Week', 'Opus-week', 'Fable-week', '5 uur', 'Week', '30 dagen'],
  );
  assert.equal(windowName({ id: 'spark:300', label: 'Spark · 5 uur' }), 'Spark · 5 uur', 'else the server label');
  assert.equal(engineName({ family: 'claude', name: 'Claude Code' }, [{ family: 'claude' }, { family: 'codex' }]), 'Claude');
  assert.equal(engineName({ family: 'claude', name: 'Claude werk' }, [{ family: 'claude' }, { family: 'claude' }]), 'Claude werk', 'two accounts: their own names');
  assert.equal(percentText({ usedPercent: 44.4 }), '44%');
  assert.equal(percentText({ usedPercent: 44, estimated: true }), '≈ 44%');
  assert.equal(percentText({ usedPercent: null }), '–');

  const now = new Date('2026-11-09T10:00:00').getTime();
  assert.equal(resetShort(new Date('2026-11-09T15:59:00').getTime(), now, 'nl-NL'), '15:59');
  assert.equal(resetShort(new Date('2026-11-13T05:59:00').getTime(), now, 'nl-NL'), 'vr 05:59');
  assert.equal(resetShort(new Date('2026-11-20T05:59:00').getTime(), now, 'nl-NL'), '20 nov');
  assert.equal(resetLong(new Date('2026-11-10T05:59:00').getTime(), now, 'nl-NL'), 'morgen 05:59');
  const w = { id: 'seven_day', label: 'Week · alle modellen', usedPercent: 83, resetsAt: new Date('2026-11-13T05:59:00').getTime(), level: 'warn' as const };
  assert.equal(windowSentence('Claude', w, now), 'Claude week: bijna op, 83% gebruikt, reset vr 13 nov 05:59.');
  assert.equal(windowSentence('Claude', { ...w, usedPercent: 100, level: 'limit' }, now), 'Claude week: limiet bereikt, weer beschikbaar vr 13 nov 05:59.');
  assert.equal(windowSentence('Codex', { ...w, id: 'codex:300', usedPercent: null, level: 'unknown' }, now), 'Codex 5 uur: nog niet gemeld.');
  assert.match(windowSentence('Claude', { ...w, usedPercent: 50, level: 'ok', estimated: true }, now), /Schatting\.$/);

  const oc = { label: 'OpenCode', status: 'limited' as const, resetsAt: new Date('2026-11-09T13:18:00').getTime(), estimated: true };
  assert.equal(sourceShort(oc, now), 'op tot ≈ 13:18');
  assert.equal(sourceSentence(oc, now), 'OpenCode: op tot vandaag 13:18. Schatting.');
  assert.equal(sourceShort({ ...oc, status: 'available', resetsAt: null }, now), '', 'available: the dot alone (screen readers get "beschikbaar")');
  assert.equal(sourceSentence({ ...oc, status: 'available', resetsAt: null }, now), 'OpenCode: beschikbaar.');
  assert.equal(effectiveStatus(oc, oc.resetsAt + 1), 'available', 'after the reset');
  assert.equal(sourceShort({ label: 'Ollama', status: 'offline', resetsAt: null }, now), 'niet bereikbaar');
  assert.equal(sharedWith(['claude', 'codex'], 'nl-NL'), 'Claude en ChatGPT');
  assert.equal(sharedWith(['claude'], 'en-GB'), 'Claude');
  assert.equal(sharedWith(['other'], 'nl-NL'), '');
});

// ---------------------------------------------------------------- the bar with recorded CLI output

test('bar: real Claude and Codex windows from recorded output, in order, with plan; nothing for an API key', async () => {
  const t = await startTestApp();
  try {
    const svc = t.app.ctx.services.usage;
    const claude = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const codex = await t.api('POST', '/providers', { kind: 'codex-cli', config: { path: FAKE_CODEX } });
    // Before any number: the engines are there, honestly "not yet reported"; the mock API key is no bar.
    let bar = await t.api('GET', '/usage/bar');
    assert.deepEqual(bar.engines.map((e: any) => [e.family, e.windows.length]), [['claude', 0], ['codex', 0]]);
    assert.ok(!bar.engines.some((e: any) => e.providerId === t.providerId));

    // Recorded: Claude Code 2.1.319 /usage (local command) and a stream rate_limit_event; Codex 0.167 app-server.
    const usageText = fx('claude-usage-command.jsonl').trim().split('\n').map((l) => JSON.parse(l)).find((l) => l.type === 'result').result;
    svc.report(claude.id, rebase(parseClaudeUsageText(usageText, RECORDED_AT, 'UTC')!));
    svc.report(claude.id, rebase(parseClaudeRateLimitEvent({ rate_limit_info: { status: 'allowed', resetsAt: RECORDED_AT / 1000 + 4 * 3600, rateLimitType: 'five_hour', utilization: 0.12 } }, RECORDED_AT)!));
    svc.report(claude.id, rebase(parseClaudeRateLimitEvent({ rate_limit_info: { status: 'allowed', resetsAt: RECORDED_AT / 1000 + 6 * 864e2, rateLimitType: 'seven_day_opus', utilization: 0.83 } }, RECORDED_AT)!));
    svc.report(codex.id, rebase(parseCodexRateLimits(JSON.parse(fx('codex-rate-limits.json')), RECORDED_AT)!));

    bar = await t.api('GET', '/usage/bar');
    const [c, x] = bar.engines;
    assert.deepEqual(
      c.windows.map((w: any) => [w.id, w.usedPercent, w.level]),
      [
        ['five_hour', 12, 'ok'],
        ['seven_day', 44, 'ok'],
        ['seven_day_fable', 0, 'ok'],
        ['seven_day_opus', 83, 'warn'],
      ],
      '5 hours, week, then the model weeks (Opus when reported)',
    );
    assert.ok(c.windows.every((w: any) => w.resetsAt > Date.now() && w.estimated === false), 'exact numbers from Claude itself');
    assert.equal(c.blocked, null);
    assert.equal(x.plan, 'ChatGPT Go');
    assert.deepEqual(x.windows.map((w: any) => [w.id, w.usedPercent]), [['codex:43200', 30]]);
    assert.ok(x.canRead && c.canRead);

    // A Codex logged in with an API key reports no windows: no bar for it.
    svc.state(codex.id).windows = [];
    svc.state(codex.id).billing = 'api';
    bar = await t.api('GET', '/usage/bar');
    assert.deepEqual(bar.engines.map((e: any) => e.family), ['claude']);
  } finally {
    await t.close();
  }
});

test('notifications: once at 80% and once at the limit per window and period; a week report does not lift a full 5-hour window', async () => {
  const t = await startTestApp();
  const n = events(t, 'notification');
  try {
    const svc = t.app.ctx.services.usage;
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const R1 = Date.now() + 3 * 3600e3;
    const say = (ws: LimitWindow[]) => svc.report(p.id, { windows: ws, source: 'stream', at: Date.now() });
    const of = (level: string) => n.list.filter((e) => e.data.kind === 'limit' && e.data.level === level).length;
    say([win('five_hour', 79, R1)]);
    assert.equal(of('warn'), 0);
    say([win('five_hour', 81, R1)]);
    say([win('five_hour', 85, R1)]);
    say([win('five_hour', 92, R1)]);
    assert.equal(of('warn'), 1, 'one warning at 80% for this window and period');
    assert.equal(n.list[0].data.link, '#/m/usage/', 'opens the usage page');
    say([win('five_hour', 100, R1)]);
    say([win('five_hour', 100, R1)]);
    assert.equal(of('limit'), 1, 'one "bereikt" at the limit');
    // Claude's stream names one window per request: a week at 50% must not say the engine works again.
    say([win('seven_day', 50, Date.now() + 4 * 864e5)]);
    let bar = await t.api('GET', '/usage/bar');
    assert.ok(bar.engines[0].blocked, 'still blocked by the full 5-hour window');
    assert.equal(bar.engines[0].blocked.until, R1);
    assert.equal(bar.engines[0].blocked.estimated, false, 'the reset is Claude\'s own');
    assert.equal(of('reset'), 0);
    // The week fills up too: available only after both reset.
    const R2 = Date.now() + 4 * 864e5;
    say([win('seven_day', 100, R2)]);
    bar = await t.api('GET', '/usage/bar');
    assert.equal(bar.engines[0].blocked.until, R2);
    assert.equal(of('limit'), 1, 'still one "bereikt" for this block');
    // A new 5-hour period (reset moved on) and the week back below: again one warning at 80%, after "weer beschikbaar".
    say([win('seven_day', 60, R2), win('five_hour', 82, R1 + 5 * 3600e3)]);
    assert.equal(of('reset'), 1);
    assert.equal(of('warn'), 2, 'a new period warns again, once');
    say([win('five_hour', 88, R1 + 5 * 3600e3)]);
    assert.equal(of('warn'), 2);
  } finally {
    n.off();
    await t.close();
  }
});

// ---------------------------------------------------------------- free sources and the reserve

test('free sources: dots from OpenCode and Ollama, reportSource for other modules, "schatting" for a reset from an error text', async () => {
  const t = await startTestApp();
  const ev = events(t, 'usage.updated');
  try {
    const svc = t.app.ctx.services.usage;
    const owner = t.app.ctx.auth.owner()!.id;
    svc.probeLocal = async () => false;
    const oc = await t.api('POST', '/providers', { kind: 'opencode', config: { path: FAKE_ACP } });
    const ol = await t.api('POST', '/providers', { kind: 'ollama', base_url: 'http://127.0.0.1:9/v1' });
    let bar = await t.api('GET', '/usage/bar');
    assert.deepEqual(bar.engines, [], 'free engines are dots, not bars');
    const dot = (id: string) => bar.sources.find((s: any) => s.providerId === id);
    assert.equal(dot(oc.id).status, 'available');
    assert.equal(dot(oc.id).kind, 'free');
    assert.match(dot(oc.id).note, /OpenCode meldt geen tegoed/);
    assert.equal(dot(ol.id).kind, 'local');
    assert.equal(dot(ol.id).status, 'unknown', 'first look: not checked yet');
    assert.ok(await until(() => ev.list.some((e) => e.data?.providerId === ol.id)), 'the check tells the UI');
    bar = await t.api('GET', '/usage/bar');
    assert.equal(dot(ol.id).status, 'offline', 'Ollama not running → "niet bereikbaar", never a fake "beschikbaar"');
    assert.deepEqual(bar.sources.map((s: any) => s.kind), ['free', 'local'], 'online free sources first');
    // A free service that stopped (added before it did; a new one cannot be added) is never "beschikbaar".
    const gh = await t.api('POST', '/providers', { kind: 'groq', apiKey: 'gsk_test' });
    t.app.ctx.store.exec("UPDATE providers SET kind = 'github' WHERE id = ?", gh.id);
    bar = await t.api('GET', '/usage/bar');
    assert.deepEqual([dot(gh.id).status, dot(gh.id).note], ['offline', 'Gestopt op 30 juli 2026. Kies een andere gratis bron.']);
    await t.api('DELETE', `/providers/${gh.id}`);

    // The free limit of OpenCode, reset from its error text: "op tot …" as an estimate.
    const reset = Date.now() + 3 * 3600e3;
    svc.limitHit(owner, oc.id, reset, 'Free usage limit reached. Try again in 3 hours.');
    bar = await t.api('GET', '/usage/bar');
    assert.deepEqual([dot(oc.id).status, dot(oc.id).resetsAt, dot(oc.id).estimated], ['limited', reset, true]);

    // Another module (the free-model chain) reports a source of its own, for everybody, and one for a provider.
    ev.list.length = 0;
    const v = svc.reportSource({ id: 'kilo', label: 'Kilo', status: 'low', usedPercent: 92, estimated: true, note: '200 per uur, telt TeamBot zelf.' });
    assert.equal(v.status, 'low');
    svc.reportSource({ id: 'kilo', label: 'Kilo', status: 'low', usedPercent: 92, estimated: true, note: '200 per uur, telt TeamBot zelf.' });
    assert.equal(ev.list.filter((e) => e.data?.sourceId === 'kilo').length, 1, 'the same report twice: the UI is told once');
    assert.equal(ev.list[0].userId, '*');
    assert.equal(svc.reportSource({ id: '', label: 'x', status: 'available' }), null);
    bar = await t.api('GET', '/usage/bar');
    assert.deepEqual(bar.sources.find((s: any) => s.id === 'kilo') && [bar.sources.find((s: any) => s.id === 'kilo').usedPercent, bar.sources.find((s: any) => s.id === 'kilo').origin], [92, 'reported']);
    // A newer limit TeamBot saw itself beats an older report about the same provider …
    await new Promise((r) => setTimeout(r, 5));
    const older = Date.now() - 60_000;
    svc.reportSource({ id: 'opencode-zen', label: 'OpenCode gratis', status: 'available', providerId: oc.id, userId: owner });
    (svc as any).reportedMap().get(`${owner}|opencode-zen`).at = older;
    bar = await t.api('GET', '/usage/bar');
    assert.equal(dot(oc.id).status, 'limited');
    // … and a newer report replaces the derived dot.
    svc.reportSource({ id: 'opencode-zen', label: 'OpenCode gratis', status: 'limited', resetsAt: reset + 60_000, providerId: oc.id, userId: owner, estimated: false });
    bar = await t.api('GET', '/usage/bar');
    assert.equal(bar.sources.filter((s: any) => s.providerId === oc.id).length, 1, 'one dot per provider');
    assert.deepEqual([dot(oc.id).label, dot(oc.id).resetsAt, dot(oc.id).estimated], ['OpenCode gratis', reset + 60_000, false]);

    // Remembered across a restart; a reported source of a deleted provider disappears; clearSource removes one.
    (svc as any).reported = null;
    bar = await t.api('GET', '/usage/bar');
    assert.ok(bar.sources.some((s: any) => s.id === 'kilo'));
    await t.api('DELETE', `/providers/${oc.id}`);
    bar = await t.api('GET', '/usage/bar');
    assert.ok(!bar.sources.some((s: any) => s.id === 'opencode-zen' || s.providerId === oc.id));
    assert.equal(svc.clearSource('kilo'), true);
    bar = await t.api('GET', '/usage/bar');
    assert.ok(!bar.sources.some((s: any) => s.id === 'kilo'));
  } finally {
    ev.off();
    await t.close();
  }
});

test('weekly reserve: the mark of Gratis doorschakelen on the Claude and Codex weeks, "nu actief" when in force; a reported reserve wins', async () => {
  const t = await startTestApp();
  try {
    const svc = t.app.ctx.services.usage;
    const c = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const x = await t.api('POST', '/providers', { kind: 'codex-cli', config: { path: FAKE_CODEX } });
    svc.report(c.id, { windows: [win('five_hour', 20, Date.now() + 3600e3), win('seven_day', 87, Date.now() + 2 * 864e5)], source: 'usage-command', at: Date.now() });
    svc.report(x.id, { windows: [win('codex:10080', 70, Date.now() + 2 * 864e5)], source: 'app-server', at: Date.now() });
    const marks = async () => {
      const bar = await t.api('GET', '/usage/bar');
      const claude = bar.engines.find((e: any) => e.family === 'claude');
      const codex = bar.engines.find((e: any) => e.family === 'codex');
      const at = (w: any) => [w.reserveAt, w.reserveActive];
      return { week: at(claude.windows.find((w: any) => w.id === 'seven_day')), five: claude.windows.find((w: any) => w.id === 'five_hour').reserveAt, codex: at(codex.windows.find((w: any) => w.id === 'codex:10080')) };
    };
    // Nothing reported: the reserve the runner really uses (Instellingen › Gratis doorschakelen, 85% by default).
    assert.deepEqual(await marks(), { week: [85, true], five: null, codex: [85, false] }, 'the default chain reserve on both weeks, in force on Claude at 87%');
    await t.api('PUT', '/engine-chain/settings', { weeklyReserve: 90 });
    assert.deepEqual(await marks(), { week: [90, false], five: null, codex: [90, false] }, 'follows the owner\'s threshold');
    await t.api('PUT', '/engine-chain/settings', { weeklyReserve: 0 });
    assert.deepEqual(await marks(), { week: [null, false], five: null, codex: [null, false] }, 'reserve off: no mark');
    // Another module may still report its own reserve (Claude only when it names no provider).
    assert.equal(svc.reportReserve({ atPercent: 120 }), null);
    svc.reportReserve({ atPercent: 80, active: true });
    assert.deepEqual(await marks(), { week: [80, true], five: null, codex: [null, false] });
    assert.equal(svc.clearReserve(), true);
    assert.deepEqual((await marks()).week, [null, false]);
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- live after a run

test('live: after a Claude run the bar has every window within the wait (one read), not when the run already told them all', async () => {
  const t = await startTestApp();
  const ev = events(t, 'usage.spend');
  try {
    const svc = t.app.ctx.services.usage;
    svc.afterRunDelayMs = 50;
    svc.minReadGapMs = 0;
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const a = await t.api('POST', '/agents', { name: 'Claudia', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'Hallo');
    // The stream told the 5-hour window (20%); the read after the run adds the week from /usage (86%).
    assert.ok(await until(() => !!svc.state(p.id).checkedAt), 'read after the run');
    let bar = await t.api('GET', '/usage/bar');
    assert.deepEqual(
      bar.engines[0].windows.map((w: any) => [w.id, w.usedPercent]),
      [
        ['five_hour', 12],
        ['seven_day', 86],
      ],
    );
    assert.ok(ev.list.some((e) => e.data.agentId === a.id), 'usage per bot is told to reload');

    // The run's own report covers every window known: no extra read.
    const st = svc.state(p.id);
    st.windows = st.windows.filter((w: LimitWindow) => w.id === 'five_hour');
    const checked = st.checkedAt;
    await t.say(th.id, 'Nog een keer');
    await new Promise((r) => setTimeout(r, 400));
    assert.equal(svc.state(p.id).checkedAt, checked, 'nothing to ask');

    // At most one read per minute because of runs: the next one waits for the gap.
    svc.minReadGapMs = 60_000;
    svc.state(p.id).windows.push(win('seven_day', 86, Date.now() + 864e5));
    await t.say(th.id, 'En nog een');
    const pending = (svc as any).soon.get(p.id);
    assert.ok(pending, 'a read is planned');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(svc.state(p.id).checkedAt, checked, 'not before the minute is over');
    bar = await t.api('GET', '/usage/bar');
    assert.equal(bar.engines[0].reading, false);
  } finally {
    ev.off();
    await t.close();
  }
});

// ---------------------------------------------------------------- usage per bot

test('usage per bot: today and this week, engines and who pays; work without a bot and a deleted bot; per team', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!.id;
    const c = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const a = await t.agent({ name: 'Ada' });
    const b = await t.agent({ name: 'Bram' });
    const log = (agent: string | null, provider: string | null, tokens: number, cost: number, value: number | null, at: Date) =>
      t.app.ctx.store.insert('usage_log', { user_id: owner, agent_id: agent, provider_id: provider, model: 'm', input: tokens, output: 0, cost, value, created_at: at.toISOString() });
    const now = new Date();
    const week = weekStart(now);
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);
    log(a.id, t.providerId, 1000, 0.02, null, now);
    log(a.id, c.id, 500, 0, 0.3, now);
    log(b.id, t.providerId, 300, 0.01, null, now);
    log(null, null, 50, 0, null, now);
    log('agt_weg', t.providerId, 10, 0, null, now);
    log(a.id, t.providerId, 9999, 1, null, new Date(week.getTime() - 3600e3)); // last week: not counted
    const earlier = today.getTime() > week.getTime(); // on a Monday "this week" is today
    if (earlier) log(b.id, t.providerId, 4000, 0.05, null, new Date(week.getTime() + 60e3));

    const r = await t.api('GET', '/usage/breakdown');
    assert.equal(r.by, 'bot');
    assert.equal(r.since.week, week.toISOString());
    const row = (name: string | null, kind = 'bot') => r.rows.find((x: any) => x.kind === kind && (kind !== 'bot' || x.name === name));
    assert.deepEqual([row('Ada').today.tokens, row('Ada').today.calls, row('Ada').week.tokens], [1500, 2, 1500], 'last week is not counted');
    assert.equal(row('Ada').today.cost, 0.02);
    assert.equal(row('Ada').today.value, 0.3, 'the value of subscription work');
    assert.deepEqual(
      row('Ada').engines.map((e: any) => [e.providerId, e.billing]),
      [
        [t.providerId, 'paid'],
        [c.id, 'subscription'],
      ],
    );
    assert.equal(row('Bram').today.tokens, 300);
    assert.equal(row('Bram').week.tokens, earlier ? 4300 : 300);
    assert.equal(row(null, 'none').today.tokens, 50, 'memory upkeep, voice … without a bot');
    assert.equal(row(null, 'deleted').name, null);
    assert.equal(r.total.today.tokens, 1500 + 300 + 50 + 10);
    if (earlier) assert.equal(r.rows[0].name, 'Bram', 'most used this week first');
    // Per team (package B2): a row per team with its bots in `children`, work without a team (no bot, deleted) last.
    const byTeam = await t.api('GET', '/usage/breakdown?by=team');
    assert.equal(byTeam.by, 'team');
    assert.deepEqual(byTeam.groupings, ['bot', 'team']);
    assert.deepEqual(byTeam.rows.map((x: any) => x.kind), ['team', 'none']);
    assert.deepEqual(byTeam.rows[0].children.map((x: any) => x.name).sort(), ['Ada', 'Bram']);
    assert.equal(byTeam.rows[0].today.tokens, 1800);
    assert.equal(byTeam.rows[1].today.tokens, 60);
    assert.equal(byTeam.total.today.tokens, r.total.today.tokens);
  } finally {
    await t.close();
  }
});
