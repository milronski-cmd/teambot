import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers.js';
import { classifyEngineError, fallbackList, resetTimeFrom } from '../server/agent/fallback.js';
import { ProviderError } from '../server/providers/common.js';

const FAKE_CLAUDE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-agents-fake-claude.mjs');
const events = (t: any, threadId: string) => t.app.ctx.store.messages(threadId).filter((m: any) => m.role === 'event');
const answers = (t: any, threadId: string) => t.app.ctx.store.messages(threadId).filter((m: any) => m.role === 'assistant');

test('engine errors are classified and reset times read from CLI/API messages', () => {
  assert.equal(classifyEngineError(new ProviderError('Too many requests', 429, true)), 'limit');
  assert.equal(classifyEngineError(new ProviderError('overloaded', 529, true)), 'outage');
  assert.equal(classifyEngineError(new ProviderError('bad key', 401)), 'auth');
  assert.equal(classifyEngineError(new Error('Gebruikslimiet van je Claude-abonnement of account bereikt. Probeer het later opnieuw. 5-hour limit reached ∙ resets 3pm')), 'limit');
  assert.equal(classifyEngineError(new Error("You've hit your usage limit. Try again in 2 hours 5 minutes.")), 'limit');
  assert.equal(classifyEngineError(new Error('De CLI is niet (meer) ingelogd. Log zelf in met: claude auth login')), 'auth');
  assert.equal(classifyEngineError(new Error('Claude Code is niet gevonden op deze computer.')), 'unavailable');
  assert.equal(classifyEngineError(new Error('Argument bevat ongeldige tekens')), 'other', 'ordinary errors never switch engines');
  const now = Date.parse('2026-11-07T10:00:00Z');
  assert.equal(resetTimeFrom('Claude AI usage limit reached|1762531200', now), 1762531200 * 1000);
  assert.equal(resetTimeFrom('try again in 2 hours 5 minutes', now), now + 2 * 3600_000 + 5 * 60_000);
  assert.equal(resetTimeFrom('retry after 90 seconds', now), now + 90_000);
  const clock = resetTimeFrom('limit reached ∙ resets 3pm', now)!;
  assert.ok(clock > now && clock - now <= 24 * 3600_000 && new Date(clock).getHours() === 15);
  assert.equal(resetTimeFrom('geen idee', now), null);
  assert.deepEqual(fallbackList({ settings: {}, fallback: { provider_id: 'p1', model: 'm' } } as any), [{ provider_id: 'p1', model: 'm' }], 'legacy single reserve still works');
});

test('ordered reserves (≥3): limit → outage → next engine, always announced; a limited engine is skipped until its reset', async () => {
  const t = await startTestApp();
  try {
    const r1 = await t.api('POST', '/providers', { kind: 'mock', name: 'Reserve A' });
    const r2 = await t.api('POST', '/providers', { kind: 'mock', name: 'Reserve B' });
    const r3 = await t.api('POST', '/providers', { kind: 'mock', name: 'Reserve C' });
    const a = await t.agent({ settings: { fallbacks: [{ provider_id: r1.id, model: 'mock-1' }, { provider_id: r2.id, model: 'mock-1' }, { provider_id: r3.id, model: 'mock-1' }] } });
    assert.equal(a.settings.fallbacks.length, 3);
    assert.equal(a.fallback.provider_id, r1.id, 'first reserve mirrored for older clients');
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ error: { message: 'Rate limit reached. Try again in 5 minutes.', status: 429 } }, { error: { message: 'Service unavailable', status: 503 } }, { text: 'antwoord van reserve B' });
    await t.say(th.id, 'hallo');
    const ans = answers(t, th.id);
    assert.equal(ans.at(-1).content, 'antwoord van reserve B');
    // Acceptance round 3: the switch stood twice in the chat (notice on the attempt + event) with "Gestopt" under it.
    assert.equal(ans.length, 1, 'empty failed attempts disappear; only the answer stays');
    const all = t.app.ctx.store.messages(th.id, { includeDeleted: true }).filter((m: any) => m.role === 'assistant');
    assert.equal(all.filter((m: any) => m.deleted).length, 2, 'the two empty attempts are hidden, not left as "Gestopt"');
    // Acceptance round 4: the open chat showed "Bericht verwijderd" for them; marked as switched, the UI hides them.
    assert.ok(all.filter((m: any) => m.deleted).every((m: any) => m.parts?.switched), 'removed attempts carry switched (no tombstone)');
    assert.ok(!all.some((m: any) => m.parts?.notice), 'the switch is never repeated as a notice on the attempt');
    const ev = events(t, th.id).map((m: any) => m.content);
    assert.equal(ev.filter((x: string) => /Overgeschakeld naar reserve/.test(x)).length, 2, 'one event per switch: ' + ev.join(' | '));
    assert.ok(ev.some((x: string) => /gebruikslimiet bereikt.*Overgeschakeld naar reserve: Reserve A/.test(x)), ev.join(' | '));
    assert.ok(ev.some((x: string) => /Reserve A.*overbelast.*Overgeschakeld naar reserve: Reserve B/.test(x)), ev.join(' | '));
    const run = t.app.ctx.store.run(ans.at(-1).run_id)!;
    assert.equal(run.status, 'done');
    assert.equal(run.meta?.engine?.provider_id, r2.id, 'the run says which reserve answers (chat header)');
    assert.equal(run.meta?.engine?.name, 'Reserve B');

    // Next turn: the main engine is still at its limit → starts on the first free reserve, and says so.
    t.script.push({ text: 'meteen op de reserve' });
    await t.say(th.id, 'nog een vraag');
    assert.equal(answers(t, th.id).at(-1).content, 'meteen op de reserve');
    assert.ok(events(t, th.id).some((m: any) => /zit nog tot ongeveer .* aan zijn gebruikslimiet; deze beurt draait op Reserve A/.test(m.content)));

    // After the reset the bot goes back to its main engine by itself.
    t.app.ctx.services.runner.limited.clear();
    t.script.push({ text: 'weer op het hoofdmodel' });
    const before = events(t, th.id).length;
    await t.say(th.id, 'en nu?');
    assert.equal(answers(t, th.id).at(-1).content, 'weer op het hoofdmodel');
    assert.equal(events(t, th.id).length, before, 'no switch, no notice');
    assert.equal(t.app.ctx.store.run(answers(t, th.id).at(-1).run_id)!.meta?.engine, undefined, 'main engine: no reserve on the run');
    // Ordinary errors (not limit/auth/outage) never switch.
    t.script.push({ error: { message: 'Ongeldig verzoek', status: 400 } });
    await t.say(th.id, 'fout');
    assert.equal(answers(t, th.id).at(-1).status, 'error');
  } finally {
    await t.close();
  }
});

test('reserves work for CLI engines: a logged-out Claude Code continues on the next engine', async () => {
  const t = await startTestApp();
  try {
    const cli = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const a = await t.api('POST', '/agents', { name: 'CliBot', provider_id: cli.id, model: '', access_mode: 'ask', settings: { fallbacks: [{ provider_id: t.providerId, model: 'mock-1' }] } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'antwoord via de API-reserve' });
    await t.say(th.id, 'SCENARIO:login hallo');
    assert.equal(answers(t, th.id).at(-1).content, 'antwoord via de API-reserve');
    assert.ok(events(t, th.id).some((m: any) => /Claude Code is niet \(meer\) ingelogd\. Overgeschakeld naar reserve: Mock/.test(m.content)), events(t, th.id).map((m: any) => m.content).join(' | '));
  } finally {
    await t.close();
  }
});

test('a limit another bot ran into: bots set to "wachten" or "stoppen" never start on a reserve', async () => {
  // Acceptance round 3 (C-06): after one bot hit the limit, bots on "wait" and "stop" ran on the reserve anyway.
  const t = await startTestApp();
  try {
    const r1 = await t.api('POST', '/providers', { kind: 'mock', name: 'Reserve A' });
    const fallbacks = [{ provider_id: r1.id, model: 'mock-1' }];
    t.app.ctx.services.runner.limited.set(t.providerId, { until: Date.now() + 20 * 60_000 });
    for (const onLimit of ['wait', 'stop'] as const) {
      const a = await t.agent({ name: `Bot ${onLimit}`, settings: { onLimit, fallbacks } });
      const th = await t.api('POST', '/threads', { agentId: a.id });
      t.script.push({ error: { message: 'Rate limit reached. Try again in 20 minutes.', status: 429 } }, { text: 'antwoord van de reserve' });
      await t.say(th.id, 'hallo');
      const ev = events(t, th.id).map((m: any) => m.content);
      assert.ok(!ev.some((x: string) => /Overgeschakeld|deze beurt draait op Reserve A/.test(x)), `${onLimit}: no reserve — ${ev.join(' | ')}`);
      assert.ok(!answers(t, th.id).some((m: any) => m.content === 'antwoord van de reserve'), `${onLimit}: the reserve did not answer`);
      const run = t.app.ctx.store.all<any>('SELECT * FROM runs WHERE thread_id = ?', th.id)[0];
      assert.equal(!!JSON.parse(run.meta || '{}').limitRetryAt, onLimit === 'wait', `${onLimit}: retry only when waiting`);
      t.script.splice(0); // the reserve answer was not used
    }
    // A bot on "switch to a reserve" still starts on the reserve right away.
    const f = await t.agent({ name: 'Bot reserve', settings: { onLimit: 'fallback', fallbacks } });
    const th = await t.api('POST', '/threads', { agentId: f.id });
    t.script.push({ text: 'meteen op de reserve' });
    await t.say(th.id, 'hallo');
    assert.equal(answers(t, th.id).at(-1).content, 'meteen op de reserve');
  } finally {
    await t.close();
  }
});

test('"wacht tot de limiet voorbij is": no switch, announced retry for the same message', async () => {
  const t = await startTestApp();
  try {
    const r1 = await t.api('POST', '/providers', { kind: 'mock', name: 'Reserve A' });
    const a = await t.agent({ settings: { onLimit: 'wait', fallbacks: [{ provider_id: r1.id, model: 'mock-1' }] } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ error: { message: 'Rate limit reached. Try again in 20 minutes.', status: 429 } });
    await t.say(th.id, 'wacht maar');
    const failed = t.app.ctx.store.all<any>('SELECT * FROM runs WHERE thread_id = ?', th.id)[0];
    assert.equal(failed.status, 'error');
    const meta = JSON.parse(failed.meta);
    assert.ok(Date.parse(meta.limitRetryAt) > Date.now() + 15 * 60_000, 'retry at the reset');
    assert.ok(events(t, th.id).some((m: any) => /probeert het rond .* automatisch opnieuw/.test(m.content)));
    assert.ok(!events(t, th.id).some((m: any) => /Overgeschakeld/.test(m.content)), 'wait = no switching');
    // Fast-forward the timer.
    t.script.push({ text: 'na de reset beantwoord' });
    t.app.ctx.services.runner.limited.clear();
    t.app.ctx.services.runner.armRetry(failed.id, Date.now() + 10);
    await new Promise((r) => setTimeout(r, 100));
    await t.waitIdle(th.id);
    const runs = t.app.ctx.store.all<any>('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at', th.id);
    assert.equal(runs.length, 2);
    assert.equal(runs[1].trigger, 'retry');
    assert.equal(runs[1].input_message_id, failed.input_message_id);
    assert.equal(answers(t, th.id).at(-1).content, 'na de reset beantwoord');
  } finally {
    await t.close();
  }
});
