// A run that is meant to start fresh starts a new session of its CLI engine (core/store.ts forgetEngineSessions).
// Seen 22 nov 2026: a routine in its own thread cleared TeamBot's note of the session, but the next run still resumed
// the old Claude Code session. One routine went on in one session for 131 runs, up to 966,000 tokens per step, and was
// never compacted, because its thread counts as fresh.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = { kind: 'claude-code', config: { path: path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs') } };

const flag = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);
const runsOf = (t: TestApp) => fs.readFileSync(process.env.FAKE_CLI_LOG!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => Array.isArray(l.argv) && l.argv.includes('-p'));

async function runRoutine(t: TestApp, id: string) {
  const rr = await t.api('POST', `/routines/${id}/run`, {});
  const row = () => t.app.ctx.store.get<any>('routine_runs', rr.id);
  for (let i = 0; i < 400 && !['done', 'failed', 'no_update', 'skipped'].includes(row()?.status); i++) await new Promise((res) => setTimeout(res, 25));
  assert.ok(['done', 'no_update'].includes(row()?.status), JSON.stringify(row()));
  return row();
}

test('every run of a routine in its own conversation starts a new Claude Code session; in the main chat it goes on', async () => {
  const t = await startTestApp();
  process.env.FAKE_CLI_LOG = path.join(t.dir, 'fake-cli.log');
  try {
    const p = await t.api('POST', '/providers', FAKE_CLAUDE);
    const bot = await t.api('POST', '/agents', { name: 'Ronde', provider_id: p.id, model: '', access_mode: 'auto' });
    const own = await t.api('POST', '/routines', { name: 'Mail nalopen', agent_id: bot.id, prompt: 'Loop de mail na.', schedule: { kind: 'none' } });

    const first = await runRoutine(t, own.id);
    const th = first.thread_id;
    const sessionAfter = () => t.app.ctx.store.one<any>('SELECT session_id FROM cli_sessions WHERE thread_id = ?', th)?.session_id;
    const s1 = sessionAfter();
    assert.ok(s1, 'the first run made a session');
    assert.equal(flag(runsOf(t).at(-1).argv, '--resume'), undefined, 'the first run starts one');

    // The second and third run: the same conversation, a new session each time (nothing to resume).
    await runRoutine(t, own.id);
    assert.equal(flag(runsOf(t).at(-1).argv, '--resume'), undefined, 'no resume of the previous run’s session');
    const s2 = sessionAfter();
    assert.ok(s2 && s2 !== s1, 'a new session');
    await runRoutine(t, own.id);
    assert.equal(flag(runsOf(t).at(-1).argv, '--resume'), undefined);
    assert.equal(t.app.ctx.store.get<any>('routine_runs', first.id).thread_id, th, 'still one conversation for the routine');
    assert.equal(t.app.ctx.store.all<any>('SELECT 1 FROM cli_sessions WHERE thread_id = ?', th).length, 1, 'one session row: the newest');

    // A routine that runs "in de hoofdchat" keeps the bot's context: its runs resume the main chat's session.
    const main = await t.api('POST', '/routines', { name: 'In de hoofdchat', agent_id: bot.id, prompt: 'Hoe staat het?', schedule: { kind: 'none' }, options: { runIn: 'main' } });
    const m1 = await runRoutine(t, main.id);
    await runRoutine(t, main.id);
    const mainSession = t.app.ctx.store.one<any>('SELECT session_id FROM cli_sessions WHERE thread_id = ?', m1.thread_id)?.session_id;
    assert.ok(mainSession);
    assert.equal(flag(runsOf(t).at(-1).argv, '--resume'), mainSession, 'the main chat resumes its session');
  } finally {
    await t.close();
  }
});

test('Claude Code compacts within a long turn at the same number as TeamBot between turns; not when the owner switched compaction off', async () => {
  // Seen 22 nov 2026: one long task grew to 650,000 tokens per step; on its own Claude Code compacts a 1M-token model
  // only near 967,000. Tried on the real Claude Code with this setting: 67% less input, the same answers.
  const { CLI_CONTEXT_CAP } = await import('../server/agent/compaction.js');
  const t = await startTestApp();
  process.env.FAKE_CLI_LOG = path.join(t.dir, 'fake-cli.log');
  try {
    const p = await t.api('POST', '/providers', FAKE_CLAUDE);
    const bot = await t.api('POST', '/agents', { name: 'Lang', provider_id: p.id, model: '', access_mode: 'auto' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    await t.say(th.id, 'Lees alles na.');
    const first = fs.readFileSync(process.env.FAKE_CLI_LOG!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.argv?.includes('-p')).at(-1);
    assert.equal(CLI_CONTEXT_CAP, 100_000);
    assert.equal(first.autoCompactWindow, String(CLI_CONTEXT_CAP));
    // The owner switched compaction off for this bot: Claude Code keeps its own setting.
    const a = t.app.ctx.store.agent(bot.id)!;
    t.app.ctx.store.updateAgent(bot.id, { settings: { ...a.settings, compaction: false } });
    await t.say(th.id, 'Nog een keer.');
    const second = fs.readFileSync(process.env.FAKE_CLI_LOG!, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((l) => l.argv?.includes('-p')).at(-1);
    assert.equal(second.autoCompactWindow, null);
  } finally {
    await t.close();
  }
});

test('forgetting the engine sessions of a conversation: all bots, or one bot, and meta in the same step', async () => {
  const t = await startTestApp();
  try {
    const s = t.app.ctx.store;
    const a = await t.agent({ name: 'Een' });
    const th = s.createThread({ user_id: a.user_id, agent_id: a.id, kind: 'room' });
    const now = new Date().toISOString();
    for (const [agent, sid] of [['ag_een', 'sess-een'], ['ag_twee', 'sess-twee']])
      s.exec('INSERT INTO cli_sessions (thread_id, agent_id, provider_id, user_id, cli, session_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', th.id, agent, 'prv_x', a.user_id, 'claude', sid, now, now);
    s.updateThread(th.id, { provider_state: { prv_x: { sessionId: 'sess-een' } }, meta: { keep: 1 } });

    s.forgetEngineSessions(th.id, { agentId: 'ag_een' });
    assert.deepEqual(s.all<any>('SELECT agent_id FROM cli_sessions WHERE thread_id = ?', th.id).map((r) => r.agent_id), ['ag_twee'], 'only that bot');
    assert.deepEqual(s.thread(th.id)!.provider_state, {});

    const after = s.forgetEngineSessions(th.id, { meta: { contextFromSeq: 7 } })!;
    assert.equal(s.all<any>('SELECT 1 FROM cli_sessions WHERE thread_id = ?', th.id).length, 0, 'every bot');
    assert.deepEqual(after.meta, { keep: 1, contextFromSeq: 7 }, 'meta merged, nothing lost');
    assert.equal(s.forgetEngineSessions('thr_bestaat_niet'), null);
  } finally {
    await t.close();
  }
});
