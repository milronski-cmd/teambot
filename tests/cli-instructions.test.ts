// Instructions and conversation history reach every kind of AI in one way (modules/cli-agents/context.ts, index.ts;
// agent/prompt.ts). A CLI engine gets the instructions in full when its session starts and after that only the parts
// that changed since that session last saw them; a session that another engine answered in between is kept and told
// what it missed. Checked on every scripted route: Claude Code, Codex, an ACP agent, and a model through an API.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE = {
  'claude-code': { path: path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs') },
  'codex-cli': { path: path.join(here, 'fixtures', 'cli-agents-fake-codex.mjs') },
  'acp-custom': { command: path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs'), args: [] },
} as const;
type Kind = keyof typeof FAKE;
const KINDS = Object.keys(FAKE) as Kind[];

function useLog(t: TestApp) {
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  return () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
}

/** What each turn handed the engine, in order: the text of the turn, and (Claude Code) the system prompt file. */
const turns = (log: any[], kind: Kind): { prompt: string; system?: string; argv?: string[] }[] =>
  kind === 'acp-custom'
    ? log.filter((l) => l.method === 'session/prompt').map((l) => ({ prompt: String(l.params.text) }))
    : log.filter((l) => l.cli === (kind === 'codex-cli' ? 'codex' : 'claude') && l.argv && typeof l.prompt === 'string').map((l) => ({ prompt: l.prompt, system: l.system, argv: l.argv }));

async function cliBot(t: TestApp, kind: Kind, agent: any = {}) {
  const p = await t.api('POST', '/providers', { kind, config: FAKE[kind] });
  // Read-only: no approval card in between (Codex then runs as one `codex exec` per turn).
  const a = await t.api('POST', '/agents', { name: 'CliBot', provider_id: p.id, model: '', access_mode: 'readonly', ...agent });
  const th = await t.api('POST', '/threads', { agentId: a.id });
  return { p, a, th };
}

const lastAnswer = (t: TestApp, threadId: string) => t.app.ctx.store.messages(threadId).filter((m) => m.role === 'assistant').at(-1)!;

test('the owner changes the instructions in the middle of a conversation: the next turn carries the new text, once, on every route', async (tt) => {
  const t = await startTestApp();
  const logs = useLog(t);
  process.env.CODEX_HOME = t.dir;
  try {
    for (const kind of KINDS) {
      const n = logs().length;
      const { a, th } = await cliBot(t, kind, { instructions: 'Antwoord altijd in het Engels.' });
      await t.say(th.id, 'een');
      await t.say(th.id, 'twee');
      await t.api('PATCH', `/agents/${a.id}`, { instructions: 'Antwoord altijd in het Frans.' });
      await t.say(th.id, 'drie');
      await t.say(th.id, 'vier');
      const T = turns(logs().slice(n), kind);
      assert.equal(T.length, 4, kind);
      // The session starts with the whole text: in the system prompt file (Claude Code) or at the top of the first turn.
      assert.match(kind === 'claude-code' ? T[0].system! : T[0].prompt, /Je bent CliBot[\s\S]*## Jouw instructies\nAntwoord altijd in het Engels\./, kind);
      assert.doesNotMatch(T[1].prompt, /teambot_instructies/, `${kind}: nothing changed → nothing sent with the turn`);
      // The same conversation goes on (the session is resumed) and gets only the part that changed.
      assert.match(T[2].prompt, /<teambot_instructies_update>[\s\S]*## Jouw instructies\nAntwoord altijd in het Frans\.[\s\S]*<\/teambot_instructies_update>\n\n[\s\S]*drie/, kind);
      assert.doesNotMatch(T[2].prompt, /Je bent CliBot|Engels/, `${kind}: only the changed part`);
      assert.ok(t.app.ctx.store.messages(th.id).some((m) => m.parts?.activity?.some((x: any) => x.title === 'Bijgewerkte instructies meegegeven' && /Jouw instructies/.test(x.detail))), `${kind}: said in the steps`);
      assert.doesNotMatch(T[3].prompt, /teambot_instructies/, `${kind}: sent once`);
      if (kind !== 'acp-custom') assert.ok(T[2].argv!.some((x) => x === '--resume' || x === 'resume'), `${kind}: the same session`);
      // The text that goes with a turn when nothing changed: the question and its turn context, no instructions.
      tt.diagnostic(`${kind}: start of the session ${(kind === 'claude-code' ? T[0].system!.length : 0) + T[0].prompt.length} characters; a later turn without changes ${T[1].prompt.length}; the turn after the change ${T[2].prompt.length}`);
      assert.ok(T[1].prompt.length < 600 && T[3].prompt.length < 600, `${kind}: the fixed text per turn stays small (${T[1].prompt.length}, ${T[3].prompt.length})`);
    }
    // A session from before this was kept (nothing known of what it has): the whole text once, then nothing.
    const old = await cliBot(t, 'claude-code', { instructions: 'Wees kort.' });
    await t.say(old.th.id, 'een');
    t.app.ctx.store.exec('UPDATE cli_sessions SET context_state = NULL WHERE thread_id = ?', old.th.id);
    const n = logs().length;
    await t.say(old.th.id, 'twee');
    await t.say(old.th.id, 'drie');
    const T = turns(logs().slice(n), 'claude-code');
    assert.match(T[0].prompt, /volledige nieuwe versie[\s\S]*Je bent CliBot[\s\S]*Wees kort\./);
    assert.doesNotMatch(T[1].prompt, /teambot_instructies/);

    // A model through an API key reads the instructions with every call: the same change, the next turn.
    const api = await t.agent({ name: 'Api', instructions: 'Antwoord altijd in het Engels.' });
    const ath = await t.api('POST', '/threads', { agentId: api.id });
    t.script.push({ text: 'ok' }, { text: 'ok' });
    await t.say(ath.id, 'een');
    await t.api('PATCH', `/agents/${api.id}`, { instructions: 'Antwoord altijd in het Frans.' });
    await t.say(ath.id, 'twee');
    assert.match(t.requests.at(-2)!.system, /Antwoord altijd in het Engels\./);
    assert.match(t.requests.at(-1)!.system, /## Jouw instructies\nAntwoord altijd in het Frans\./);
  } finally {
    delete process.env.CODEX_HOME;
    await t.close();
  }
});

test('another AI answered in between (the owner switched and switched back): the session is kept and gets the turns it missed', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  process.env.CODEX_HOME = t.dir;
  try {
    for (const kind of KINDS) {
      const n = logs().length;
      const { a, th, p } = await cliBot(t, kind);
      await t.say(th.id, 'Eerste vraag aan A');
      const session = t.app.ctx.store.one<any>('SELECT session_id, seen_seq FROM cli_sessions WHERE thread_id = ? AND provider_id = ?', th.id, p.id);
      assert.ok(session.session_id && session.seen_seq > 0, `${kind}: the session knows how far it has seen the chat`);
      // The owner puts the bot on another AI (a model through an API), asks two things, and puts it back.
      await t.api('PATCH', `/agents/${a.id}`, { provider_id: t.providerId, model: 'mock-1' });
      t.script.push({ text: 'ANTWOORD-VAN-B-1' }, { text: 'ANTWOORD-VAN-B-2' });
      await t.say(th.id, 'Vraag die B kreeg');
      await t.say(th.id, 'Nog een vraag voor B');
      assert.equal(lastAnswer(t, th.id).content, 'ANTWOORD-VAN-B-2');
      await t.api('PATCH', `/agents/${a.id}`, { provider_id: p.id, model: '' });
      await t.say(th.id, 'Terug bij A: derde vraag');
      await t.say(th.id, 'Vierde vraag');
      const T = turns(logs().slice(n), kind);
      assert.equal(T.length, 3, kind);
      assert.equal(t.app.ctx.store.one<any>('SELECT session_id FROM cli_sessions WHERE thread_id = ? AND provider_id = ?', th.id, p.id).session_id, session.session_id, `${kind}: the same session, not a new one`);
      if (kind !== 'acp-custom') assert.ok(T[1].argv!.some((x) => x === '--resume' || x === 'resume'), `${kind}: resumed`);
      // What B was asked and answered, in order, in front of the new question; the new question once.
      assert.match(T[1].prompt, /<gemist>[\s\S]*\]: Vraag die B kreeg\n\[jij, via een andere AI\]: ANTWOORD-VAN-B-1\n[^\n]*\]: Nog een vraag voor B\n\[jij, via een andere AI\]: ANTWOORD-VAN-B-2\n<\/gemist>\n\n[\s\S]*Terug bij A: derde vraag/, kind);
      assert.equal(T[1].prompt.split('Terug bij A: derde vraag').length - 1, 1);
      assert.doesNotMatch(T[1].prompt, /Eerste vraag aan A/, `${kind}: not what the session already had`);
      assert.ok(lastAnswer(t, th.id) && t.app.ctx.store.messages(th.id).some((m) => m.parts?.activity?.some((x: any) => x.title === 'Bijgepraat over wat een andere AI hier antwoordde')), `${kind}: said in the steps`);
      assert.doesNotMatch(T[2].prompt, /<gemist>|ANTWOORD-VAN-B/, `${kind}: told once`);
    }
  } finally {
    delete process.env.CODEX_HOME;
    await t.close();
  }
});

test('a reserve engine takes one turn at a usage limit: the main engine sees that turn afterwards', async () => {
  const t = await startTestApp();
  const logs = useLog(t);
  try {
    const { a, th, p } = await cliBot(t, 'claude-code', { fallback: { provider_id: t.providerId, model: 'mock-1' } });
    await t.say(th.id, 'Eerste vraag');
    const session = t.app.ctx.store.one<any>('SELECT session_id FROM cli_sessions WHERE thread_id = ? AND provider_id = ?', th.id, p.id).session_id;
    // The main engine is at its limit for this turn: the reserve answers it.
    t.script.push({ text: 'ANTWOORD-VAN-DE-RESERVE' });
    await t.say(th.id, 'Tweede vraag SCENARIO:limithit', 30_000);
    const reserve = lastAnswer(t, th.id);
    assert.deepEqual([reserve.content, reserve.parts.providerId], ['ANTWOORD-VAN-DE-RESERVE', t.providerId]);
    // The limit is over: the main engine goes on in its own session and is told what the reserve answered.
    (t.app.ctx.services.runner as any).engines.limited.clear();
    const usage: any = t.app.ctx.services.usage;
    const st = usage.state(p.id);
    st.windows = [];
    usage.unblock(st, t.app.ctx.providers.config(p.id), 'reset');
    usage.save(st);
    const n = logs().length;
    // (The fake CLI picks its scenario from the last keyword in what it is handed; the missed turn quotes the one above.)
    await t.say(th.id, 'Derde vraag SCENARIO:gewoon');
    const turn = logs().slice(n).find((l) => l.argv && typeof l.prompt === 'string')!;
    assert.equal(lastAnswer(t, th.id).parts.providerId, a.provider_id);
    assert.equal(turn.argv[turn.argv.indexOf('--resume') + 1], session, 'the same session');
    assert.match(turn.prompt, /<gemist>[\s\S]*\]: Tweede vraag SCENARIO:limithit\n\[jij, via een andere AI\]: ANTWOORD-VAN-DE-RESERVE\n<\/gemist>\n\n[\s\S]*Derde vraag/);
  } finally {
    await t.close();
  }
});
