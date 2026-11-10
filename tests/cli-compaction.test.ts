import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * "Gesprek samenvatten" and automatic compaction for CLI engines (agent/compaction.ts): Claude Code /compact,
 * Codex thread/compact/start, and a TeamBot summary + new session for ACP agents (OpenCode) or when the engine
 * cannot do it itself.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');
const FAKE_ACP = path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs');
const FAKE_CODEX = path.join(here, 'fixtures', 'cli-agents-fake-codex.mjs');

function useLog(t: TestApp) {
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  return () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
}

async function cliBot(t: TestApp, kind: string, config: any, agent: any = {}) {
  const p = await t.api('POST', '/providers', { kind, config });
  const a = await t.api('POST', '/agents', { name: 'CliBot', provider_id: p.id, model: '', access_mode: 'ask', ...agent });
  const th = await t.api('POST', '/threads', { agentId: a.id });
  return { p, a, th };
}

const flag = (a: string[], f: string) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);
const events = (t: TestApp, threadId: string) => t.app.ctx.store.messages(threadId).filter((m) => m.role === 'event').map((m) => m.content);
const session = (t: TestApp, threadId: string, agentId: string) => t.app.ctx.store.one<{ session_id: string }>('SELECT session_id FROM cli_sessions WHERE thread_id = ? AND agent_id = ?', threadId, agentId)?.session_id;

test('Claude Code: "Gesprek samenvatten" runs /compact on the bot session; without a session TeamBot summarises', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { a, th } = await cliBot(t, 'claude-code', { path: FAKE_CLAUDE });
    // No session yet but an earlier conversation (e.g. from another engine): TeamBot's own summary.
    const s = t.app.ctx.store;
    for (const [role, content] of [['user', 'Mijn webshop heet Velomax'], ['assistant', 'Genoteerd'], ['user', 'Hij zit in Arnhem'], ['assistant', 'Duidelijk'], ['user', 'Wat nog meer?'], ['assistant', 'Niets']] as const)
      s.createMessage({ thread_id: th.id, role, author_type: role === 'user' ? 'user' : 'agent', author_id: role === 'user' ? a.user_id : a.id, author_name: role === 'user' ? 'Sanne' : a.name, content, status: 'done' });
    let r = await t.api('POST', `/threads/${th.id}/compact`, {});
    assert.equal(r.compacted, true, r.reason);
    assert.match(s.thread(th.id)!.meta.summary, /SAMENVATTING-VAN-FAKE-CLAUDE/);
    assert.ok(logs().some((l) => l.mode === 'complete'), 'one answer without tools');
    assert.ok(events(t, th.id).some((e) => /nieuwe Claude Code-sessie/.test(e)));

    // The new session gets the summary as context.
    await t.say(th.id, 'Hallo');
    const first = logs().filter((l) => l.prompt !== undefined).at(-1);
    assert.match(first.prompt, /Samenvatting van het eerdere deel van dit gesprek:\n## Besluiten/);
    assert.ok(!first.prompt.includes('Mijn webshop heet Velomax'), 'summarised turns are not resent');
    const sid = session(t, th.id, a.id);
    assert.ok(sid);

    // With a session: Claude Code's own /compact on exactly that session.
    r = await t.api('POST', `/threads/${th.id}/compact`, {});
    assert.equal(r.compacted, true, r.reason);
    const c = logs().filter((l) => l.prompt?.trim() === '/compact').at(-1);
    assert.equal(flag(c.argv, '--resume'), sid);
    assert.ok(events(t, th.id).some((e) => /Claude Code heeft het gesprek van CliBot samengevat \(van 120\.000 naar 9\.000 tokens\)/.test(e)));
    assert.equal(session(t, th.id, a.id), sid, 'same session after /compact');
  } finally {
    await t.close();
  }
});

test('Claude Code: automatic compaction at the start of the next turn when the context was ≥ 75% full', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { a, th } = await cliBot(t, 'claude-code', { path: FAKE_CLAUDE });
    await t.say(th.id, 'Eerste vraag');
    await t.say(th.id, 'SCENARIO:fullcontext');
    const ctxv = await t.api('GET', `/usage/context/${th.id}`);
    assert.ok(ctxv.percent >= 75, `context ${ctxv.percent}%`);
    assert.equal(ctxv.canCompact, true);
    const before = logs().filter((l) => l.prompt?.trim() === '/compact').length;
    await t.say(th.id, 'Volgende vraag');
    const after = logs().filter((l) => l.prompt?.trim() === '/compact');
    assert.equal(after.length, before + 1, '/compact before the turn');
    const last = t.app.ctx.store.messages(th.id).filter((m) => m.role === 'assistant').at(-1)!;
    assert.ok(last.parts.activity!.some((x: any) => /Gesprek eerst samengevat \(context was \d+% vol\)/.test(x.title)));
    // Only once: the next turn does not compact again (the context is small now).
    await t.say(th.id, 'En nog een');
    assert.equal(logs().filter((l) => l.prompt?.trim() === '/compact').length, before + 1);
    // Switched off for this bot: never automatically.
    await t.api('PATCH', `/agents/${a.id}`, { settings: { compaction: false } });
    await t.say(th.id, 'SCENARIO:fullcontext');
    await t.say(th.id, 'Weer een vraag');
    assert.equal(logs().filter((l) => l.prompt?.trim() === '/compact').length, before + 1);
  } finally {
    await t.close();
  }
});

test('Codex: thread/compact/start on the same thread; an older Codex falls back to a TeamBot summary + new session', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { a, th } = await cliBot(t, 'codex-cli', { path: FAKE_CODEX }, { access_mode: 'readonly' });
    await t.say(th.id, 'Hallo');
    await t.say(th.id, 'Nog iets');
    await t.say(th.id, 'En nog iets');
    const sid = session(t, th.id, a.id);
    let r = await t.api('POST', `/threads/${th.id}/compact`, {});
    assert.equal(r.compacted, true, r.reason);
    const call = logs().find((l) => l.method === 'thread/compact/start');
    assert.equal(call?.params.threadId, sid);
    assert.equal(session(t, th.id, a.id), sid, 'Codex keeps the thread');
    assert.ok(events(t, th.id).some((e) => /OpenAI Codex CLI heeft het gesprek van CliBot samengevat/.test(e)));

    process.env.FAKE_CODEX_NO_COMPACT = '1';
    try {
      r = await t.api('POST', `/threads/${th.id}/compact`, {});
    } finally {
      delete process.env.FAKE_CODEX_NO_COMPACT;
    }
    assert.equal(r.compacted, true, r.reason);
    assert.match(t.app.ctx.store.thread(th.id)!.meta.summary, /SAMENVATTING-VAN-FAKE-CODEX/);
    assert.equal(session(t, th.id, a.id), undefined, 'new session on the next turn');
    await t.say(th.id, 'Verder');
    const exec = logs().filter((l) => l.cli === 'codex' && l.prompt !== undefined).at(-1);
    assert.ok(!exec.argv.includes('resume'));
    assert.match(exec.prompt, /SAMENVATTING-VAN-FAKE-CODEX/);
  } finally {
    await t.close();
  }
});

test('OpenCode (ACP): TeamBot summary with OpenCode itself, then a new session that gets the summary', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { a, th } = await cliBot(t, 'opencode', { path: FAKE_ACP });
    await t.say(th.id, 'Mijn webshop heet Velomax');
    await t.say(th.id, 'Hij zit in Arnhem');
    await t.say(th.id, 'Wat weet je?');
    assert.ok(session(t, th.id, a.id));
    const r = await t.api('POST', `/threads/${th.id}/compact`, {});
    assert.equal(r.compacted, true, r.reason);
    const run = logs().find((l) => l.mode === 'complete');
    assert.equal(run?.argv[0], 'run');
    assert.ok(run.argv.includes('--standalone'));
    assert.equal(session(t, th.id, a.id), undefined);
    assert.ok(events(t, th.id).some((e) => /nieuwe OpenCode-sessie/.test(e)));
    await t.say(th.id, 'En nu?');
    const prompts = logs().filter((l) => l.method === 'session/prompt');
    assert.match(prompts.at(-1).params.text, /SAMENVATTING-VAN-FAKE-OPENCODE/);
    assert.equal(logs().filter((l) => l.method === 'session/new').length, 2, 'a new session after compaction');
  } finally {
    await t.close();
  }
});

// Acceptance round 4 (A-30): OpenCode showed three notices at once and an English engine error could come through.
test('OpenCode compaction: one plain outcome — too short, already running, or the free limit in words', async () => {
  const t = await startTestApp();
  useLog(t);
  try {
    const { th } = await cliBot(t, 'opencode', { path: FAKE_ACP });
    await t.say(th.id, 'Hallo');
    const short = await t.api('POST', `/threads/${th.id}/compact`, {});
    assert.equal(short.compacted, false);
    assert.equal(short.reason, 'het gesprek is nog te kort om samen te vatten');
    await t.say(th.id, 'Mijn webshop heet Velomax');
    await t.say(th.id, 'Hij zit in Arnhem');
    await t.say(th.id, 'Wat weet je?');
    // Two clicks at once: the second says it is already running, it does not start a second summary.
    const [one, two] = await Promise.all([t.api('POST', `/threads/${th.id}/compact`, {}), t.api('POST', `/threads/${th.id}/compact`, {})]);
    const busy = [one, two].find((r) => r.reason === 'het gesprek wordt al samengevat');
    assert.ok(busy, JSON.stringify([one, two]));
    const done = [one, two].find((r) => r !== busy)!;
    assert.equal(done.compacted, true, done.reason);
    // OpenCode at its free limit while it summarises: the reason in words, not "Free usage limit reached …".
    for (const m of ['SCENARIO:freelimit één', 'twee', 'drie', 'vier', 'vijf']) await t.say(th.id, m, 20_000);
    const limited = await t.api('POST', `/threads/${th.id}/compact`, {});
    assert.equal(limited.compacted, false);
    assert.match(limited.reason, /^De gratis limiet van OpenCode is bereikt\./);
  } finally {
    await t.close();
  }
});

test('a busy bot is not compacted from outside; the API path is unchanged', async () => {
  const t = await startTestApp();
  try {
    const { a, th } = await cliBot(t, 'claude-code', { path: FAKE_CLAUDE });
    const sent = t.api('POST', `/threads/${th.id}/messages`, { content: 'SCENARIO:silent' });
    await sent;
    for (let i = 0; i < 100 && !t.app.ctx.store.one("SELECT 1 FROM runs WHERE thread_id = ? AND status = 'running'", th.id); i++) await new Promise((r) => setTimeout(r, 20));
    const r = await t.api('POST', `/threads/${th.id}/compact`, {});
    assert.equal(r.compacted, false);
    assert.match(r.reason, /nog bezig/);
    await t.api('POST', `/threads/${th.id}/stop`, {});
    await t.waitIdle(th.id);
    void a;
  } finally {
    await t.close();
  }
});
