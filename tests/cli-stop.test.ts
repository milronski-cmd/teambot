import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp, type TestApp } from './helpers.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');
const FAKE_ACP = path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs');
const NOTE = /De eigenaar heeft je vorige taak gestopt/;

async function running(t: TestApp, th: string) {
  for (let i = 0; i < 400; i++) {
    if (t.app.ctx.store.one("SELECT id FROM runs WHERE thread_id = ? AND status = 'running'", th)) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not start');
}

const lastAnswer = (t: TestApp, th: string) => t.app.ctx.store.messages(th).filter((x) => x.role === 'assistant').at(-1)!;
const fakeLog = (file: string) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
const promptsIn = (file: string) => fakeLog(file).filter((l) => l.method === 'session/prompt').map((l) => String(l.params.text));
const FOLLOW_UP = /^\[TeamBot\] TeamBot heeft deze actie geweigerd: /;

/** Answer every card of this thread (the owner clicking), until its runs are done. */
async function decideCards(t: TestApp, th: string, decision: 'approve' | 'deny') {
  for (let i = 0; i < 600; i++) {
    for (const ap of await t.api('GET', '/approvals')) if (ap.status === 'pending') await t.api('POST', `/approvals/${ap.id}`, { decision });
    if (!t.app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", th).length && i > 2) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('run did not finish');
}

test('acp: after a person refused an action and the CLI ended its turn, it says so (not "Gestopt", not an engine error, no follow-up)', async () => {
  const t = await startTestApp();
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  try {
    const p = await t.api('POST', '/providers', { kind: 'acp-custom', config: { command: FAKE_ACP, args: [] } });
    const a = await t.api('POST', '/agents', { name: 'Weigerbot', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'SCENARIO:exec STOPNAWEIGERING' });
    await decideCards(t, th.id, 'deny');
    const m = lastAnswer(t, th.id);
    assert.equal(m.status, 'done', String(m.parts.error || ''));
    assert.match(m.content, /stopte deze beurt nadat een actie niet mocht \(Opdracht: npm test\)/);
    assert.equal(promptsIn(file).length, 1, 'the owner said no: the bot stops, TeamBot does not push it on');
    const run = t.app.ctx.store.one<any>('SELECT status FROM runs WHERE thread_id = ?', th.id);
    assert.equal(run.status, 'done', 'not counted as stopped by the owner');
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});

// Acceptance round 6 (B-45/B-46, OpenCode 2.2.6): OpenCode ends its whole turn on any refusal, also when TeamBot's own
// limits refused (here: "Alleen lezen"). TeamBot then lets it go on with the rest in one short follow-up turn.
test('acp: after TeamBot itself refused an action and the CLI ended its turn, a follow-up turn does the rest', async () => {
  const t = await startTestApp();
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  try {
    const p = await t.api('POST', '/providers', { kind: 'acp-custom', config: { command: FAKE_ACP, args: [] } });
    const a = await t.api('POST', '/agents', { name: 'Weigerbot', provider_id: p.id, model: '', access_mode: 'readonly' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'SCENARIO:exec STOPNAWEIGERING', 15_000);
    const m = lastAnswer(t, th.id);
    assert.equal(m.status, 'done', String(m.parts.error || ''));
    assert.equal(m.content, 'De rest is klaar; npm test mocht niet.');
    const P = promptsIn(file);
    assert.equal(P.length, 2);
    assert.match(P[1], FOLLOW_UP);
    assert.match(P[1], /Opdracht: npm test/);
    assert.match(P[1], /alleen lezen|readonly/i, "TeamBot's reason goes along");
    assert.match(P[1], /niet nog eens en ook niet via een omweg/);
    assert.ok(m.parts.activity?.some((x: any) => x.title === 'TeamBot liet Eigen ACP-agent verdergaan zonder de geweigerde actie' && x.detail === 'Opdracht: npm test'));
    assert.equal(t.app.ctx.store.all('SELECT id FROM approvals WHERE thread_id = ?', th.id).length, 0, 'never a card for what TeamBot refuses');

    // An agent that tries the refused action again each time: at most two follow-ups, then the turn ends with the note.
    await t.say(th.id, 'SCENARIO:exec STOPNAWEIGERING KOPPIG', 15_000);
    const m2 = lastAnswer(t, th.id);
    assert.equal(m2.status, 'done', String(m2.parts.error || ''));
    assert.match(m2.content, /stopte deze beurt nadat een actie niet mocht \(Opdracht: npm test\)/);
    assert.equal(promptsIn(file).length, 2 + 3, 'the message and two follow-ups');
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});

// Acceptance round 6 (B-45/B-46, OpenCode 2.2.6): two writes at once, one outside the bot's folders. TeamBot refused
// that one, OpenCode dropped the other and ended the turn, but the card for the other write stayed open; the owner
// approved it and nothing was written. The card is withdrawn as soon as the agent drops its call, and the follow-up
// turn writes the other file after all (with a new card: the owner never approved the first one).
test('acp: when the agent drops a call that still waits for a card, the card is withdrawn and a follow-up does it', async () => {
  const t = await startTestApp();
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  try {
    const p = await t.api('POST', '/providers', { kind: 'acp-custom', config: { command: FAKE_ACP, args: [] } });
    const a = await t.api('POST', '/agents', { name: 'Parallelbot', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'SCENARIO:paralleldrop' });
    // the first card is withdrawn before anyone can approve it; the follow-up's card is approved
    for (let i = 0; i < 400 && !fakeLog(file).some((l) => l.parallel?.inside); i++) await new Promise((r) => setTimeout(r, 25));
    await decideCards(t, th.id, 'approve');
    const approvals = t.app.ctx.store.all<any>('SELECT status, summary FROM approvals WHERE thread_id = ? ORDER BY created_at', th.id);
    assert.deepEqual(approvals.map((x) => x.status), ['expired', 'approved'], JSON.stringify(approvals));
    for (const x of approvals) assert.match(x.summary, /binnen-parallel\.txt/);
    assert.equal(fakeLog(file).find((l) => l.parallel?.inside)?.parallel.inside.outcome, 'cancelled');
    assert.equal(fs.readFileSync(path.join(a.workspace, 'binnen-parallel.txt'), 'utf8'), 'prijs 49 euro');
    const m = lastAnswer(t, th.id);
    assert.equal(m.content, 'Binnen geschreven; buiten mocht niet.');
    assert.match(promptsIn(file)[1], /buiten-parallel\.txt/, 'the refused write is named, not the dropped one');
    // nobody refused the withdrawn card (live, round 6 retest: "Geweigerd: … Gestopt voordat er toestemming was")
    const steps = (m.parts.activity || []) as { title: string; detail?: string }[];
    assert.ok(steps.some((x) => x.title === 'Kaart ingetrokken: een bestand wijzigen' && x.detail === 'Eigen ACP-agent gaf deze actie op voordat je besliste.'), steps.map((x) => x.title).join(' | '));
    assert.equal(steps.filter((x) => /^Geweigerd: /.test(x.title)).length, 1, 'only the write outside the folders');
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});

// The live case of round 6: the owner had already approved the write to the team folder when OpenCode dropped it.
// The follow-up does the very same write without asking again; the steps never show the bot's internal folder.
test('acp: a write the owner approved before the agent dropped it is not asked again in the follow-up turn', async () => {
  const t = await startTestApp();
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  try {
    const p = await t.api('POST', '/providers', { kind: 'acp-custom', config: { command: FAKE_ACP, args: [] } });
    const a = await t.api('POST', '/agents', { name: 'Parallelbot', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'SCENARIO:eerstgoed' });
    await decideCards(t, th.id, 'approve');
    const approvals = t.app.ctx.store.all<any>('SELECT status FROM approvals WHERE thread_id = ?', th.id);
    assert.deepEqual(approvals.map((x) => x.status), ['approved'], 'one card, approved once');
    assert.deepEqual(fakeLog(file).find((l) => l.parallel?.retry)?.parallel.retry, { outcome: 'selected', optionId: 'a' });
    assert.equal(fs.readFileSync(path.join(a.workspace, 'binnen-parallel.txt'), 'utf8'), 'prijs 49 euro');
    const m = lastAnswer(t, th.id);
    assert.equal(m.status, 'done', String(m.parts.error || ''));
    assert.equal(m.content, 'Binnen geschreven; buiten mocht niet.');
    assert.doesNotMatch(m.content, /stopte deze beurt/);
    assert.deepEqual(m.usage && [m.usage.input, m.usage.output], [15, 5], 'tokens of both prompts');
    const steps = (m.parts.activity || []) as { title: string; detail?: string }[];
    assert.ok(steps.some((x) => x.title === 'Lukte niet: binnen-parallel.txt aanpassen'), steps.map((x) => x.title).join(' | '));
    assert.ok(steps.some((x) => x.title === 'Wil binnen-parallel.txt aanpassen'), 'the dropped step says what the bot wanted');
    // B-45: the refusal names the bot's folder in words, never its path with the internal id
    const refusal = steps.find((x) => /^Geweigerd: /.test(x.title));
    assert.match(String(refusal?.detail), /Toegestaan: de werkmap/);
    for (const x of steps) assert.doesNotMatch(`${x.title} ${x.detail || ''}`, /ag_[0-9a-f]{12}/, x.title);
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});

// Acceptance round 6 (B-04), live with OpenCode 2.2.6: a code-mode step sends its program only after it ran, so the
// TeamBot call is reported before TeamBot knows what the step does. Still one line; real code keeps its own line.
test('acp code mode: a TeamBot tool call is one step even when the program comes after the call; real code keeps its own step', async () => {
  const t = await startTestApp();
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  try {
    const p = await t.api('POST', '/providers', { kind: 'acp-custom', config: { command: FAKE_ACP, args: [] } });
    const a = await t.api('POST', '/agents', { name: 'Codebot', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'SCENARIO:codemode', 15_000);
    assert.ok(fakeLog(file).find((l) => l.codemode)?.codemode.read, 'the TeamBot tool really ran');
    const tools = (m: any) => (m.parts.activity || []).filter((x: any) => ['tool', 'tool_result', 'tool_error'].includes(x.kind)).map((x: any) => `${x.kind}: ${x.title}`);
    assert.deepEqual(tools(lastAnswer(t, th.id)), ['tool_result: TeamBot · Geheugen doorzoeken: fiets']);

    await t.say(th.id, 'SCENARIO:codemode ECHTECODE', 15_000);
    assert.deepEqual(tools(lastAnswer(t, th.id)), ['tool_result: TeamBot · Geheugen doorzoeken: fiets', 'tool: Voerde code uit'], 'the fetch is not hidden behind the TeamBot step');
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});

// Practice test 0.4.4 (live, OpenCode 2.2.5): every code-mode step starts as the same bare "Wil code uitvoeren" line,
// so three different steps in a row (a lookup, task_create, delegate_task) were stopped as "3× dezelfde stap".
test('acp code mode: three different steps in a row are not a loop; the loop guard judges each step by what it did', async () => {
  const t = await startTestApp();
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  try {
    const p = await t.api('POST', '/providers', { kind: 'acp-custom', config: { command: FAKE_ACP, args: [] } });
    const a = await t.api('POST', '/agents', { name: 'Codebot', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.say(th.id, 'SCENARIO:codemode3', 15_000);
    assert.deepEqual(fakeLog(file).find((l) => l.codemode3)?.codemode3.ran, [0, 1, 2], 'all three steps ran');
    assert.ok(!t.app.ctx.store.messages(th.id).some((m) => m.role === 'event' && m.parts?.kind === 'loop_stop'), 'no loop stop');
    const m = lastAnswer(t, th.id);
    assert.equal(m.status, 'done');
    assert.match(m.content, /Drie stappen gedaan/);
    const tools = (m.parts.activity || []).filter((x: any) => ['tool', 'tool_result', 'tool_error'].includes(x.kind)).map((x: any) => x.title);
    assert.deepEqual(tools, ['Zocht een TeamBot-functie op', 'TeamBot · Geheugen doorzoeken: fiets', 'TeamBot · Geheugen doorzoeken: winkel']);
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});

// Acceptance round 3 (A-20): after Stop mid-answer, "Hervatten" made Claude Code say "er was nog niets geschreven" and
// start over: a CLI session does not keep a turn that was cut off. The resumed turn gets what was already written.
test('claude-code: "Hervatten" after a stop mid-answer hands the bot the text it had already written', async () => {
  const t = await startTestApp();
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  const prompts = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)).filter((l) => l.cli === 'claude' && typeof l.prompt === 'string').map((l) => l.prompt as string) : []);
  try {
    const p = await t.api('POST', '/providers', { kind: 'claude-code', config: { path: FAKE_CLAUDE } });
    const a = await t.api('POST', '/agents', { name: 'Verteller', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Schrijf een lang verhaal SCENARIO:halfhang' });
    await running(t, th.id);
    for (let i = 0; i < 400; i++) {
      const m = t.app.ctx.store.messages(th.id).filter((x) => x.role === 'assistant').at(-1);
      if (m?.content.includes('HALVERWEGE')) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    await t.api('POST', `/threads/${th.id}/stop`, {});
    await t.waitIdle(th.id, 15_000);
    await t.api('POST', `/threads/${th.id}/resume`, {});
    await t.waitIdle(th.id, 15_000);
    const last = prompts().at(-1)!;
    assert.match(last, /Je vorige antwoord werd afgebroken/);
    assert.match(last, /HALVERWEGE-ZIN/, 'the cut-off text goes along');
    assert.doesNotMatch(last, NOTE, 'not the "do not continue" note: the owner asked to continue');
    // A normal next message after that gets neither note.
    await t.say(th.id, 'Hoeveel is 2 + 3?', 15_000);
    assert.doesNotMatch(prompts().at(-1)!, /Je vorige antwoord werd afgebroken/);
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});

for (const engine of [
  { kind: 'claude-code', config: { path: FAKE_CLAUDE }, prompts: (l: any) => (l.cli === 'claude' && typeof l.prompt === 'string' ? l.prompt : null), session: (l: any) => (l.cli === 'claude' && typeof l.prompt === 'string' ? (l.argv.includes('--resume') ? 'verder' : 'nieuw') : null) },
  { kind: 'acp-custom', config: { command: FAKE_ACP, args: [] }, prompts: (l: any) => (l.cli === 'acp' && l.method === 'session/prompt' ? JSON.stringify(l.params) : null), session: (l: any) => (l.cli === 'acp' && /^session\/(new|load|resume)$/.test(l.method) ? (l.method === 'session/new' ? 'nieuw' : 'verder') : null) },
]) {
  test(`${engine.kind}: after the owner pressed Stop, the next turn starts from the new message, not the stopped task`, async () => {
    const t = await startTestApp();
    const file = path.join(t.dir, 'fake-cli.log');
    process.env.FAKE_CLI_LOG = file;
    const prompts = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => engine.prompts(JSON.parse(l))).filter(Boolean) as string[] : []);
    /** Per turn: a new session of the engine ("nieuw") or the earlier one resumed ("verder"). */
    const how = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => engine.session(JSON.parse(l))).filter(Boolean) as string[] : []);
    try {
      const p = await t.api('POST', '/providers', { kind: engine.kind, config: engine.config });
      const a = await t.api('POST', '/agents', { name: 'Stopbot', provider_id: p.id, model: '', access_mode: 'ask' });
      const th = await t.api('POST', '/threads', { agentId: a.id });
      await t.api('POST', `/threads/${th.id}/messages`, { content: 'Schrijf een heel lang verhaal SCENARIO:hang' });
      await running(t, th.id);
      for (let i = 0; i < 400 && !prompts().length; i++) await new Promise((r) => setTimeout(r, 25));
      await t.api('POST', `/threads/${th.id}/stop`, {});
      await t.waitIdle(th.id, 15_000);
      await t.say(th.id, 'Hoeveel is 2 + 3?', 15_000);
      let P = prompts();
      assert.match(P.at(-1)!, NOTE, 'the engine hears that the previous task was stopped');
      assert.match(P.at(-1)!, /Hoeveel is 2 \+ 3\?/);
      assert.doesNotMatch(P.at(-1)!, /heel lang verhaal/, 'the stopped request is not sent again as a "new message"');
      const m = t.app.ctx.store.messages(th.id).filter((x) => x.role === 'assistant').at(-1)!;
      assert.ok(m.parts.activity?.some((x: any) => /Vorige taak was gestopt/.test(x.title)));
      // Not the stopped session: the engine wrote the call the stop cut off into it as "outcome unknown", and the bot
      // believed that over TeamBot's note (12 nov). A new session starts, with the earlier chat as context.
      assert.equal(how().at(-1), 'nieuw', `after a stop: a new session (${how().join(', ')})`);

      await t.say(th.id, 'En 3 + 4?', 15_000);
      P = prompts();
      assert.doesNotMatch(P.at(-1)!, NOTE, 'only right after a stop');
      assert.equal(how().at(-1), 'verder', 'the next turn goes on in that new session');

      // Interrupted by a new message (busy policy "interrupt") is not a stop: the owner steers, the work goes on.
      await t.api('PATCH', `/agents/${a.id}`, { busy_policy: 'interrupt' });
      const before = prompts().length;
      await t.api('POST', `/threads/${th.id}/messages`, { content: 'Nog een lang verhaal SCENARIO:hang' });
      await running(t, th.id);
      for (let i = 0; i < 400 && prompts().length === before; i++) await new Promise((r) => setTimeout(r, 25));
      await t.api('POST', `/threads/${th.id}/messages`, { content: 'Maak het korter' });
      await t.waitIdle(th.id, 15_000);
      P = prompts();
      assert.doesNotMatch(P.at(-1)!, NOTE);
    } finally {
      delete process.env.FAKE_CLI_LOG;
      await t.close();
    }
  });
}
