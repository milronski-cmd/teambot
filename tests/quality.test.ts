import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { msgs, settle, team, until } from './team-mock.js';
import { CliLoopWatch, LoopGuard, loopLimits } from '../server/agent/loops.js';
import { isCorrection } from '../server/modules/quality/lessons.js';
import { inspectEvidence, looksLikePath, parseEvidence, runSteps } from '../server/modules/quality/evidence.js';
import { taskKey } from '../server/modules/quality/skills.js';

/**
 * Werk dat echt af is (plan 0.4, package C): "klaar als" per task, a second look with a fresh context before "klaar"
 * (evidence required), an honest "kon niet", an atomic claim, the loop guard and lessons from corrections.
 */

const toolOut = (t: TestApp, threadId: string, name: string) =>
  msgs(t, threadId)
    .filter((m) => m.role === 'tool' && m.parts?.toolResult?.name === name)
    .map((m) => m.content);

async function bot(t: TestApp, name = 'Bo', extra: any = {}) {
  const a = await t.agent({ name, tool_groups: ['team', 'files', 'skills'], ...extra });
  const th = await t.api('POST', '/threads', { agentId: a.id });
  const ws = t.app.ctx.store.agent(a.id)!.workspace;
  fs.mkdirSync(ws, { recursive: true });
  return { a, th, ws };
}

async function boardTask(t: TestApp, title: string, extra: any = {}) {
  return t.api('POST', '/rooms/tasks', { title, ...extra });
}

const task = async (t: TestApp, id: string) => (await t.api('GET', '/rooms/tasks')).find((x: any) => x.id === id);

test('a task with a deliberately wrong result lands on "te controleren" with a reason (fresh context, evidence looked at)', async () => {
  const t = await startTestApp();
  try {
    const { th, ws } = await bot(t);
    fs.writeFileSync(path.join(ws, 'offerte.md'), '# Offerte\nZonnepanelen voor familie Jansen, 12 panelen.\n');
    // The bot proposes "klaar als" when it creates the task.
    t.script.push({ toolCalls: [{ name: 'task_create', args: { title: 'Offerte zonnepanelen maken', done_when: 'offerte.md bevat een totaalprijs in euro' } }] }, { text: 'Staat op het bord.' });
    await t.say(th.id, 'Zet de offerte op het takenbord');
    const created = (await t.api('GET', '/rooms/tasks'))[0];
    assert.equal(created.quality.doneWhen, 'offerte.md bevat een totaalprijs in euro');
    assert.equal(created.quality.doneWhenBy, 'agent');

    const before = t.requests.length;
    t.script.push(
      { toolCalls: [{ name: 'task_done', args: { id: created.id, result: 'Offerte staat klaar met de prijs.', evidence: ['offerte.md'] } }] },
      { text: '{"verdict":"te_controleren","reason":"In offerte.md staat geen totaalprijs, terwijl dat de eis is."}' },
      { text: 'Ik heb de offerte afgemeld; hij staat op te controleren.' },
    );
    await t.say(th.id, 'Meld de offerte af, geheim-woord-uit-het-gesprek');
    const after = await task(t, created.id);
    assert.equal(after.status, 'review', 'not klaar');
    assert.equal(after.statusLabel, 'Te controleren');
    assert.equal(after.quality.check.state, 'review');
    assert.match(after.quality.check.reason, /totaalprijs/);
    assert.equal(after.quality.evidence[0].ok, true, 'the file exists');
    assert.match(after.quality.evidence[0].note, /bestand bestaat/);

    // The second look ran with a fresh context: one message, no tools, its own system prompt, never the conversation.
    const req = t.requests[before + 1];
    assert.equal(req.tools.length, 0);
    assert.equal(req.messages.length, 1);
    assert.match(req.system, /controleur/);
    const body = String(req.messages[0].content);
    assert.match(body, /Klaar als: offerte\.md bevat een totaalprijs in euro/);
    assert.match(body, /Zonnepanelen voor familie Jansen/, 'what is in the file');
    assert.ok(!body.includes('geheim-woord-uit-het-gesprek'), 'not the conversation');
    assert.ok((req.maxTokens || 0) > 0 && (req.maxTokens || 0) <= 300, 'bounded');

    assert.match(toolOut(t, th.id, 'task_done').at(-1)!, /te controleren[\s\S]*totaalprijs/);
    const inbox = await t.api('GET', '/quality/inbox');
    assert.equal(inbox.tasks.length, 1, 'waits for the owner');
    assert.equal(inbox.tasks[0].ref, created.id);

    // Evidence that is plainly wrong (no such file) decides without a model call.
    const t2 = await boardTask(t, 'Rapport schrijven');
    const n = t.requests.length;
    t.script.push({ toolCalls: [{ name: 'task_done', args: { id: t2.id, result: 'Rapport geschreven', evidence: ['rapport-q3.pdf'] } }] }, { text: 'Gedaan.' });
    await t.say(th.id, 'Meld het rapport af');
    const r2 = await task(t, t2.id);
    assert.equal(r2.status, 'review');
    assert.match(r2.quality.check.reason, /niet gevonden/);
    assert.equal(t.requests.length, n + 2, 'only the bot’s own two steps, no check call');
  } finally {
    await t.close();
  }
});

test('correct evidence → klaar; the owner can approve or send back what waits', async () => {
  const t = await startTestApp();
  try {
    const { a, th, ws } = await bot(t);
    fs.writeFileSync(path.join(ws, 'offerte.md'), '# Offerte\nTotaal: € 4.200 incl. btw\n');
    const tk = await boardTask(t, 'Offerte maken', { doneWhen: 'offerte.md bevat een totaalprijs' });
    assert.equal(tk.quality.doneWhenBy, 'user', 'set by the owner');
    t.script.push(
      { toolCalls: [{ name: 'task_done', args: { id: tk.id, result: 'Offerte met totaal € 4.200', evidence: ['offerte.md'] } }] },
      { text: '{"verdict":"klaar","reason":"offerte.md noemt een totaal van € 4.200."}' },
      { text: 'Klaar, met bewijs.' },
    );
    await t.say(th.id, 'Meld de offerte af');
    const done = await task(t, tk.id);
    assert.equal(done.status, 'done');
    assert.equal(done.quality.check.state, 'passed');
    assert.match(done.quality.check.reason, /4\.200/);
    assert.equal(done.quality.open, false);
    assert.equal((await t.api('GET', '/quality/inbox')).tasks.length, 0);
    assert.equal(done.ownerName, a.name, 'the bot that did it is the owner');

    // A bot cannot overwrite the owner's "klaar als".
    const tk2 = await boardTask(t, 'Factuur sturen', { doneWhen: 'factuur verstuurd naar klant' });
    t.script.push({ toolCalls: [{ name: 'task_update', args: { id: tk2.id, done_when: 'factuur gemaakt' } }] }, { text: 'ok' });
    await t.say(th.id, 'pas klaar als aan');
    assert.match(toolOut(t, th.id, 'task_update').at(-1)!, /vastgezet/);
    assert.equal((await task(t, tk2.id)).quality.doneWhen, 'factuur verstuurd naar klant');

    // Waiting task: approve → klaar (by the owner); send back → bezig, and the bot hears why in its chat.
    t.script.push({ toolCalls: [{ name: 'task_done', args: { id: tk2.id, result: 'verstuurd' } }] }, { text: 'ok' });
    await t.say(th.id, 'meld factuur af');
    assert.equal((await task(t, tk2.id)).status, 'review');
    t.script.push({ text: 'Ik pak het weer op.' });
    const back = await t.api('POST', `/rooms/tasks/${tk2.id}/reopen`, { note: 'Stuur hem echt naar de klant en noem het bericht-id.' });
    assert.equal(back.task.status, 'doing');
    assert.ok(back.told, 'the bot is told');
    await t.waitIdle(th.id);
    assert.ok(msgs(t, th.id).some((m) => m.role === 'user' && /nog niet klaar[\s\S]*bericht-id/.test(m.content)));
    const ok = await t.api('POST', `/rooms/tasks/${tk2.id}/approve`);
    assert.equal(ok.status, 'done');
    assert.equal(ok.quality.check.state, 'owner');
  } finally {
    await t.close();
  }
});

test('no evidence → never klaar: not via task_done, not via task_update, not when the owner skips the check', async () => {
  const t = await startTestApp();
  try {
    const { th, ws } = await bot(t);
    const tk = await boardTask(t, 'Nieuwsbrief versturen');
    const n = t.requests.length;
    t.script.push(
      { toolCalls: [{ name: 'task_done', args: { id: tk.id, result: 'Nieuwsbrief is verstuurd' } }] },
      { toolCalls: [{ name: 'task_update', args: { id: tk.id, status: 'done', result: 'Echt verstuurd' } }] },
      { toolCalls: [{ name: 'task_create', args: { title: 'Meteen klaar', status: 'done' } }] },
      { text: 'Klaar!' },
    );
    await t.say(th.id, 'Meld de nieuwsbrief af');
    assert.equal(t.requests.length, n + 4, 'no model call for a check without evidence');
    const r = await task(t, tk.id);
    assert.equal(r.status, 'review');
    assert.match(r.quality.check.reason, /Geen bewijs/);
    assert.match(toolOut(t, th.id, 'task_update').at(-1)!, /te controleren/);
    // task_create offers no "done" status: the full schema check (0.4.4) refuses it before the tool runs (the tool's own
    // done → review stays as a second line of defence).
    const born = (await t.api('GET', '/rooms/tasks')).find((x: any) => x.title === 'Meteen klaar');
    assert.ok(!born || born.status !== 'done', 'a task is never created "klaar" by a bot');
    assert.match(toolOut(t, th.id, 'task_create').at(-1)!, /Argument status moet een van deze waarden zijn/);

    // The owner turns the check off for this task: evidence is still required, the model call is skipped.
    await t.api('PATCH', `/rooms/tasks/${tk.id}`, { skipCheck: true, status: 'doing' });
    const m = t.requests.length;
    t.script.push({ toolCalls: [{ name: 'task_done', args: { id: tk.id, result: 'verstuurd' } }] }, { text: 'ok' });
    await t.say(th.id, 'nog eens');
    assert.equal((await task(t, tk.id)).status, 'review', 'skip without evidence is still not klaar');
    fs.writeFileSync(path.join(ws, 'nieuwsbrief.html'), '<h1>November</h1>');
    t.script.push({ toolCalls: [{ name: 'task_done', args: { id: tk.id, result: 'verstuurd', evidence: ['nieuwsbrief.html'] } }] }, { text: 'ok' });
    await t.say(th.id, 'en nu met bewijs');
    const s = await task(t, tk.id);
    assert.equal(s.status, 'done');
    assert.equal(s.quality.check.state, 'skipped');
    assert.equal(t.requests.length, m + 4, 'no check call when skipped');

    // Honest "kon niet": a reason in the done path, the task blocked and waiting for the owner.
    const tk3 = await boardTask(t, 'Advertentie plaatsen');
    t.script.push({ toolCalls: [{ name: 'task_done', args: { id: tk3.id, outcome: 'cannot', reason: 'Ik heb geen toegang tot het advertentieaccount.' } }] }, { text: 'Dat lukte niet.' });
    await t.say(th.id, 'plaats de advertentie');
    const c = await task(t, tk3.id);
    assert.equal(c.status, 'blocked');
    assert.equal(c.quality.check.state, 'cant');
    assert.match(c.quality.outcomeReason, /geen toegang/);
    assert.ok((await t.api('GET', '/quality/inbox')).tasks.some((x: any) => x.ref === tk3.id && x.check.state === 'cant'));
  } finally {
    await t.close();
  }
});

test('two bots cannot claim the same task; others see who has it; the owner can release it', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada', { tool_groups: ['team', 'files'] });
    const bo = await m.bot('Bo', { tool_groups: ['team', 'files'] });
    const at = await t.api('POST', '/threads', { agentId: ada.id });
    const bt = await t.api('POST', '/threads', { agentId: bo.id });
    const tk = await boardTask(t, 'Leveranciers bellen');
    m.script('Ada', { toolCalls: [{ name: 'task_claim', args: { id: tk.id } }] }, { text: 'Ik pak hem.' });
    await t.say(at.id, 'Pak de taak op');
    let v = await task(t, tk.id);
    assert.equal(v.quality.claim.name, 'Ada');
    assert.equal(v.status, 'doing');
    assert.equal(v.ownerName, 'Ada');

    m.script(
      'Bo',
      { toolCalls: [{ name: 'task_claim', args: { id: tk.id } }] },
      { toolCalls: [{ name: 'task_update', args: { id: tk.id, status: 'doing' } }] },
      { toolCalls: [{ name: 'task_done', args: { id: tk.id, result: 'gebeld', evidence: ['x'] } }] },
      { toolCalls: [{ name: 'task_list', args: {} }] },
      { text: 'Ada heeft hem al.' },
    );
    await t.say(bt.id, 'Pak jij hem ook op');
    const outs = msgs(t, bt.id).filter((x) => x.role === 'tool');
    assert.equal(outs.length, 4);
    for (const o of outs.slice(0, 3)) {
      assert.equal(o.parts?.toolResult?.isError, true, o.content);
      assert.match(o.content, /Ada/);
    }
    assert.match(outs[3].content, /geclaimd door Ada/, 'the board shows who has it');
    v = await task(t, tk.id);
    assert.equal(v.quality.claim.name, 'Ada');
    assert.notEqual(v.status, 'done');

    // Atomic at the source: of two claims on the same record, exactly one wins.
    const q = t.app.ctx.services.quality;
    const tk2 = await boardTask(t, 'Voorraad tellen');
    const results = [q.claim(tk2.user_id, 'room', tk2.id, ada.id), q.claim(tk2.user_id, 'room', tk2.id, bo.id)];
    assert.deepEqual(results.map((r: any) => r.ok), [true, false]);

    // The owner releases; now Bo can.
    await t.api('POST', `/rooms/tasks/${tk.id}/release`);
    m.script('Bo', { toolCalls: [{ name: 'task_claim', args: { id: tk.id } }] }, { text: 'ok' });
    await t.say(bt.id, 'nu wel');
    assert.equal((await task(t, tk.id)).quality.claim.name, 'Bo');

    // Done with good evidence: the claim ends.
    fs.writeFileSync(path.join(t.app.ctx.store.agent(bo.id)!.workspace, 'belnotities.md'), 'Leverancier A: levert maandag.');
    m.script('Bo', { toolCalls: [{ name: 'task_done', args: { id: tk.id, result: 'Gebeld', evidence: ['belnotities.md'] } }] }, { text: 'klaar' });
    m.script('?', { text: '{"verdict":"klaar","reason":"De belnotities staan in het bestand."}' });
    await t.say(bt.id, 'meld af');
    const fin = await task(t, tk.id);
    assert.equal(fin.status, 'done');
    assert.equal(fin.quality.claim, null);
  } finally {
    await t.close();
  }
});

test('a bot that repeats the same tool call stops by itself, says what it tried and asks for help', async () => {
  const t = await startTestApp();
  try {
    const { a, th } = await bot(t, 'Bo', { settings: { quality: { loopGuard: { repeat: 3 } } } });
    const call = { name: 'read_file', args: { path: 'bestaat-niet.txt' } };
    t.script.push(
      { toolCalls: [call] },
      { toolCalls: [call] },
      { toolCalls: [call] },
      { text: 'Ik kom niet verder: het bestand bestaat-niet.txt bestaat niet. Kun je me zeggen waar het staat?' },
      { text: 'mag nooit gebruikt worden' },
    );
    await t.say(th.id, 'Lees bestaat-niet.txt');
    const results = toolOut(t, th.id, 'read_file');
    assert.equal(results.length, 3);
    assert.match(results[2], /Niet uitgevoerd[\s\S]*eigenaar/, 'the third identical call is not run');
    const ev = msgs(t, th.id).find((m) => m.role === 'event' && m.parts?.kind === 'loop_stop');
    assert.ok(ev, 'a card in the chat');
    assert.match(ev!.content, /gestopt[\s\S]*Help/);
    assert.ok(ev!.parts.loop.tried.length >= 1, 'what it tried');
    const last = msgs(t, th.id).filter((m) => m.role === 'assistant').at(-1)!;
    assert.match(last.content, /Kun je me zeggen/, 'the bot asks for help in its own words');
    assert.match(t.requests.at(-1)!.system, /je zit in een lus/);
    assert.equal(t.script.length, 1, 'it stopped: no more steps');
    const run = t.app.ctx.store.all<any>('SELECT * FROM runs WHERE thread_id = ?', th.id).map((r) => t.app.ctx.store.decode<any>('runs', r)).at(-1);
    assert.equal(run.status, 'done');
    assert.equal(run.meta.loopStop.kind, 'repeat');
    t.script.length = 0;

    // Configurable: off for this bot → no stop after three identical calls.
    await t.api('PATCH', `/agents/${a.id}`, { settings: { quality: { loopGuard: { on: false } } } });
    t.script.push({ toolCalls: [call] }, { toolCalls: [call] }, { toolCalls: [call] }, { text: 'Klaar met proberen.' });
    await t.say(th.id, 'nog eens');
    assert.equal(toolOut(t, th.id, 'read_file').filter((x) => /Niet uitgevoerd/.test(x)).length, 1, 'no new skip');
  } finally {
    await t.close();
  }
});

test('loop guard rules: same result again is no progress, a changed result is; idle steps; CLI steps', () => {
  const g = new LoopGuard({ repeat: 3, idle: 3 });
  g.after('status', { id: 1 }, 'Status', 'bezig', false);
  g.after('status', { id: 1 }, 'Status', 'nog bezig', false);
  assert.equal(g.before('status', { id: 1 }, 'Status'), null, 'polling with a changing result is fine');
  g.after('status', { id: 1 }, 'Status', 'nog bezig', false);
  assert.ok(g.before('status', { id: 1 }, 'Status'), 'twice the same result → the third is stopped');

  const idle = new LoopGuard({ repeat: 9, idle: 3 });
  idle.after('a', {}, 'A', 'x', false);
  assert.equal(idle.endStep(), null);
  for (let i = 0; i < 2; i++) {
    idle.after('a', {}, 'A', 'x', false);
    assert.equal(idle.endStep(), null);
  }
  idle.after('a', {}, 'A', 'x', false);
  assert.equal(idle.endStep()?.kind, 'idle', 'three steps in a row without anything new');

  assert.equal(loopLimits({ settings: { quality: { loopGuard: false } } } as any), null);
  assert.deepEqual(loopLimits({ settings: {} } as any), { repeat: 10, idle: 20 }, 'on by default: only a bot that is really stuck');
  assert.deepEqual(loopLimits({ settings: { quality: { loopGuard: { repeat: 5000, idle: 1 } } } } as any), { repeat: 1000, idle: 3 }, 'bounded');

  const w = new CliLoopWatch({ repeat: 3, idle: 6 });
  const item = (title: string) => ({ kind: 'tool', title, ts: '' });
  assert.equal(w.add(item('Bash: npm test')), null);
  assert.equal(w.add(item('Edit: a.ts')), null);
  assert.equal(w.add(item('Bash: npm test')), null, 'work in between is progress');
  const same = item('Bash: npm test');
  assert.equal(w.add(same), null);
  assert.equal(w.add(same), null, 'a re-sent item does not count');
  assert.ok(w.add(item('Bash: npm test')), 'three in a row');

  // Practice test 0.4.4: steps that start under the same title and are renamed once they are done are judged by
  // their new title; a step that is still waiting does not count yet.
  const cm = new CliLoopWatch({ repeat: 3, idle: 6 });
  const step = (title: string, pending = false) => ({ kind: 'tool', title, ts: '', ...(pending ? { pending: true } : {}) }) as any;
  const done = (s: any, title: string) => (delete s.pending, (s.title = title), cm.add(s));
  const a = step('Wil code uitvoeren');
  assert.equal(cm.add(a), null);
  assert.equal(done(a, 'Zocht een TeamBot-functie op'), null);
  const b = step('Wil code uitvoeren');
  assert.equal(cm.add(b), null);
  assert.equal(done(b, 'TeamBot · Taak aanmaken'), null);
  assert.equal(cm.add(step('Wil code uitvoeren')), null, 'a lookup, a task and a third step are not one step three times');
  const p = [step('Wil een opdracht uitvoeren: npm test', true), step('Wil een opdracht uitvoeren: npm test', true), step('Wil een opdracht uitvoeren: npm test', true)];
  const par = new CliLoopWatch({ repeat: 3, idle: 6 });
  for (const s of p) assert.equal(par.add(s), null, 'three steps still waiting are not counted');
  assert.equal((delete p[0].pending, par.add(p[0])), null);
  assert.equal((delete p[1].pending, par.add(p[1])), null);
  assert.ok((delete p[2].pending, par.add(p[2])), 'the same step three times, once all three are done');
});

test('a CLI bot repeating the same step is stopped too', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const c = await m.cliBot('Codi');
    await t.api('PATCH', `/agents/${c.id}`, { settings: { ...(c.settings || {}), quality: { loopGuard: { repeat: 3 } } } });
    const th = await t.api('POST', '/threads', { agentId: c.id });
    m.script('Codi', { activity: [1, 2, 3, 4].map(() => ({ kind: 'tool', title: 'Opdracht: npm test' })), text: 'Ik probeer het opnieuw' });
    await t.say(th.id, 'Maak de tests groen');
    const ev = msgs(t, th.id).find((x) => x.role === 'event' && x.parts?.kind === 'loop_stop');
    assert.ok(ev, 'loop card');
    const ans = msgs(t, th.id).filter((x) => x.role === 'assistant').at(-1)!;
    assert.equal(ans.status, 'done', 'what it did stays, without an error');
  } finally {
    await t.close();
  }
});

test('an owner correction becomes a lesson for that bot, in its own working notes, visible under the message, with undo; for everyone only when he says so; a plain "voortaan" request is no lesson', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const bo = await m.bot('Bo', { tool_groups: ['team', 'memory'] });
    const cas = await m.bot('Cas', { tool_groups: ['team', 'memory'] });
    const th = await t.api('POST', '/threads', { agentId: bo.id });
    m.script('Bo', { text: 'Ik heb de offerte als Word-bestand voor je klaargezet.' }, { text: 'Begrepen, voortaan als PDF.' }, { text: 'Graag gedaan.' });
    m.script('?', { text: '{"lesson":"Offertes stuur je als PDF, niet als Word-bestand."}' });
    await t.say(th.id, 'Maak de offerte voor Jansen');
    await t.say(th.id, 'Nee, zo doen we dat niet. Offertes gaan altijd als PDF naar de klant.');
    await t.app.ctx.services.quality.drain();
    const owner = msgs(t, th.id).filter((x) => x.role === 'user').at(-1)!;
    // Bo's own: a line in its working notes, with what the owner told it (one place, one copy), not a team lesson.
    const notesOf = (id: string) => String(t.app.ctx.store.one<any>("SELECT body FROM memory_dossiers WHERE core = 'notes' AND created_by_agent = ?", id)?.body || '');
    assert.match(notesOf(bo.id), /## Opdrachten van de eigenaar[\s\S]*Offertes stuur je als PDF, niet als Word-bestand\./, 'in Bo’s own working notes');
    assert.equal(t.app.ctx.store.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE type = 'lesson'").n, 0, 'no lesson for the whole team');
    assert.doesNotMatch(notesOf(cas.id), /PDF/, 'not another bot’s');
    const lesson = await t.api('GET', `/quality/lessons?agentId=${bo.id}`);
    assert.equal(lesson.length, 1);
    assert.equal(lesson[0].content, 'Offertes stuur je als PDF, niet als Word-bestand.');
    const map = await t.api('GET', `/memory/thread/${th.id}/learned-map`);
    assert.ok(map.byMessage[owner.id]?.length, 'shown under the owner’s message');
    // The lesson reached the checker with what the bot did and what the owner said; the next turn can use it.
    const req = m.calls.filter((c) => c.bot === '?').at(-1)!.req;
    assert.match(String(req.messages[0].content), /Word-bestand[\s\S]*zo doen we dat niet/);

    const row = t.app.ctx.store.one<any>('SELECT change_id FROM quality_lessons WHERE agent_id = ?', bo.id);
    await t.api('POST', `/memory/changes/${row.change_id}/undo`);
    assert.doesNotMatch(notesOf(bo.id), /PDF/, 'undo works');

    // A thank-you is no lesson; a plain request with "voortaan" neither (the bot carries it out).
    await t.say(th.id, 'Top, dank je!');
    m.script('Bo', { text: 'Staat op 9:30.' });
    await t.say(th.id, 'Zet die routine voortaan op 9:30 in plaats van 9:00.');
    await t.app.ctx.services.quality.drain();
    assert.equal((await t.api('GET', `/quality/lessons?agentId=${bo.id}`)).length, 1);

    // A one-off correction: the model says "no lasting lesson" → none. The owner's own "volgende keer" → his words.
    m.script('Bo', { text: 'Aangepast.' }, { text: 'Goed.' });
    m.script('?', { text: '{"lesson":""}' }, { text: '{"lesson":""}' });
    await t.say(th.id, 'Dat klopt niet, de afspraak was dinsdag.');
    await t.app.ctx.services.quality.drain();
    await t.say(th.id, 'Volgende keer eerst even bellen voordat je iets verstuurt.');
    await t.app.ctx.services.quality.drain();
    const all = await t.api('GET', `/quality/lessons?agentId=${bo.id}`);
    assert.equal(all.find((x: any) => /dinsdag/.test(x.content || '') || x.action === 'none')?.action, 'none');
    assert.match(all[0].content, /Volgende keer eerst even bellen/, 'kept in the owner’s own words');

    // When he says it is for everyone: a lesson of the team, which Cas gets too.
    m.script('Bo', { text: 'Ik heb het rapport als Word-bestand gemaakt.' }, { text: 'Begrepen.' });
    m.script('?', { text: '{"lesson":"Rapporten maak je als PDF, voor alle bots."}' });
    await t.say(th.id, 'Maak het rapport');
    await t.say(th.id, 'Nee, dat klopt niet: rapporten altijd als PDF, dat geldt voor alle bots.');
    await t.app.ctx.services.quality.drain();
    const team1 = t.app.ctx.store.one<any>("SELECT * FROM memory_items WHERE type = 'lesson' AND status = 'active'");
    assert.ok(team1 && team1.scope === 'shared', 'a lesson for the whole team');
  } finally {
    await t.close();
  }
});

test('a delegated job that comes back "done" gets the second look; "Kon niet:" is passed on honestly', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const lead = await m.bot('Lead', { tool_groups: ['team'] });
    await m.bot('Zoeker', { tool_groups: ['team'] });
    const th = await t.api('POST', '/threads', { agentId: lead.id });
    m.script('Lead', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Zoeker', task: 'Wat is de hoofdstad van Australië?', expected_output: 'De naam van de hoofdstad', wait: true } }] }, { text: 'Ik laat het nakijken.' });
    m.script('Zoeker', { text: 'Sydney' });
    m.script('?', { text: '{"verdict":"te_controleren","reason":"Sydney is niet de hoofdstad van Australië; dat is Canberra."}' });
    await t.say(th.id, 'Zoek de hoofdstad van Australië op');
    await settle(t);
    const out = toolOut(t, th.id, 'delegate_task').at(-1)!;
    assert.match(out, /TE CONTROLEREN[\s\S]*Canberra/);
    const checkReq = m.calls.filter((c) => c.bot === '?').at(-1)!.req;
    assert.match(String(checkReq.messages[0].content), /Klaar als: De naam van de hoofdstad/);
    const d = (await t.api('GET', `/rooms/delegations?threadId=${th.id}`))[0];
    assert.equal(d.check.state, 'review');
    assert.equal(d.statusLabel, 'te controleren');

    const calls = m.calls.length;
    m.script('Lead', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Zoeker', task: 'Plaats de advertentie', expected_output: 'Link naar de advertentie', wait: true } }] }, { text: 'ok' });
    m.script('Zoeker', { text: 'Kon niet: ik heb geen toegang tot het advertentieaccount.' });
    await t.say(th.id, 'Plaats de advertentie');
    await settle(t);
    assert.match(toolOut(t, th.id, 'delegate_task').at(-1)!, /kon het niet[\s\S]*geen toegang/);
    assert.equal(m.calls.length, calls + 3, 'no check call for an honest "kon niet"');
  } finally {
    await t.close();
  }
});

test('team database: a task set to klaar without evidence goes to wacht_op_controle; with good evidence it stays klaar', async () => {
  const t = await startTestApp();
  try {
    const { th, ws } = await bot(t, 'Bo');
    fs.writeFileSync(path.join(ws, 'seo-rapport.md'), 'Positie 3 voor "zonnepanelen kopen".');
    t.script.push(
      { toolCalls: [{ name: 'team_execute', args: { sql: "INSERT INTO taken (titel, eigenaar, status, klaar_als) VALUES (?, ?, 'bezig', ?)", params: ['SEO-rapport', 'Bo', 'seo-rapport.md met de posities'] } }] },
      { toolCalls: [{ name: 'team_execute', args: { sql: "UPDATE taken SET status = 'klaar', resultaat = ? WHERE id = 1", params: ['Rapport af'] } }] },
      { text: 'ok' },
    );
    await t.say(th.id, 'maak het rapport');
    let rows = await t.api('GET', '/teamdata/tasks');
    assert.equal(rows[0].status, 'wacht_op_controle');
    assert.match(toolOut(t, th.id, 'team_execute').at(-1)!, /te controleren[\s\S]*Geen bewijs/);
    assert.equal((await t.api('GET', '/quality/task/teamdata/1')).doneWhen, 'seo-rapport.md met de posities');
    assert.ok((await t.api('GET', '/quality/inbox')).tasks.some((x: any) => x.kind === 'teamdata'));

    t.script.push(
      { toolCalls: [{ name: 'team_execute', args: { sql: "UPDATE taken SET status = 'klaar', bewijs = ? WHERE id = 1", params: ['seo-rapport.md'] } }] },
      { text: '{"verdict":"klaar","reason":"Het rapport noemt de positie."}' },
      { text: 'ok' },
    );
    await t.say(th.id, 'nu met bewijs');
    rows = await t.api('GET', '/teamdata/tasks');
    assert.equal(rows[0].status, 'klaar');
    assert.equal((await t.api('GET', '/quality/task/teamdata/1')).check.state, 'passed');
    assert.equal((await t.api('GET', '/quality/inbox')).tasks.length, 0);

    // The owner sets "klaar als" himself.
    await t.api('PATCH', '/teamdata/tasks/1', { klaar_als: 'Rapport met top-10 posities' });
    assert.equal((await t.api('GET', '/teamdata/tasks'))[0].klaar_als, 'Rapport met top-10 posities');
    assert.equal((await t.api('GET', '/quality/task/teamdata/1')).doneWhenBy, 'user');
  } finally {
    await t.close();
  }
});

test('recurring work done well → a skill suggestion (no install); every bot that can act gets the check-before-klaar rule', async () => {
  const t = await startTestApp();
  try {
    const { a, th, ws } = await bot(t, 'Bo');
    fs.writeFileSync(path.join(ws, 'rapport.md'), 'SEO-weekrapport met posities.');
    for (const week of [1, 2, 3]) {
      const tk = await boardTask(t, `Weekrapport SEO week ${week}`);
      t.script.push({ toolCalls: [{ name: 'task_done', args: { id: tk.id, result: 'Rapport klaar', evidence: ['rapport.md'] } }] }, { text: '{"verdict":"klaar","reason":"Het rapport staat er."}' }, { text: 'ok' });
      await t.say(th.id, `meld week ${week} af`);
    }
    assert.match(t.requests[0].system, /Controleer vóór je "klaar" zegt/);
    // The board lines (a bot with the board tools), without tool ids: those would make the tool selection (package Y)
    // send the whole team part with every call.
    assert.match(t.requests[0].system, /Claim een taak op het takenbord/);
    assert.doesNotMatch(t.requests[0].system, /task_claim|task_done/);
    const inbox = await t.api('GET', '/quality/inbox');
    assert.equal(inbox.suggestions.length, 1);
    assert.equal(inbox.suggestions[0].agentName, a.name);
    assert.equal(t.app.ctx.store.one<any>('SELECT COUNT(*) AS n FROM skills')?.n ?? 0, 0, 'nothing installed by itself');
    t.script.push({ text: 'Ik maak een concept.' });
    await t.api('POST', `/quality/suggestions/${inbox.suggestions[0].id}`, { decision: 'accept' });
    await t.waitIdle(th.id);
    assert.ok(msgs(t, th.id).some((m) => m.role === 'user' && /skill_save/.test(m.content)), 'the bot is asked to save one');
    assert.equal((await t.api('GET', '/quality/inbox')).suggestions.length, 0);

    // A chat-only bot gets no such rule.
    const chat = await t.agent({ name: 'Praat', access_mode: 'chat' });
    const ct = await t.api('POST', '/threads', { agentId: chat.id });
    await t.say(ct.id, 'hoi');
    assert.doesNotMatch(t.requests.at(-1)!.system, /Controleer vóór je "klaar" zegt/);
  } finally {
    await t.close();
  }
});

test('helpers: corrections, evidence, task kinds', () => {
  for (const s of ['Nee, zo doen we dat niet.', 'Dat klopt niet, de prijs is exclusief btw.', 'Doe dit voortaan anders: eerst bellen.', 'Volgende keer graag in het Engels.', "That's not how we do it here"]) assert.ok(isCorrection(s), s);
  for (const s of ['nee', 'Top, dank je!', 'Onthoud dat ik in Delft woon', 'Wat is de hoofdstad van Frankrijk?']) assert.ok(!isCorrection(s), s);
  // What he tells this bot to do from now on is that bot's own order (its working notes), not a lesson for the team.
  assert.ok(!isCorrection('Nee, voortaan stuur je offertes als PDF.'));
  assert.deepEqual(parseEvidence('a.md\n- https://x.nl/p\n\n'), ['a.md', 'https://x.nl/p']);
  assert.deepEqual(parseEvidence([{ path: 'b.pdf' }, 'b.pdf', 'msg_123456789']), ['b.pdf', 'msg_123456789']);
  assert.ok(looksLikePath('rapporten/q3.pdf') && looksLikePath('C:\\Werk\\a.txt') && looksLikePath('offerte.md'));
  assert.ok(!looksLikePath('Ik heb het bestand gemaakt.') && !looksLikePath('https://x.nl/a.pdf'));
  assert.equal(taskKey('Weekrapport SEO 12 november'), taskKey('Weekrapport SEO week 47'));
  assert.notEqual(taskKey('Weekrapport SEO'), taskKey('Offerte zonnepanelen'));
});

test('evidence of a CLI bot: a path with a remark after it is that file, a command\'s output is a real step, a failed step is not "gelukt"', async () => {
  const t = await startTestApp();
  try {
    const { a, th, ws } = await bot(t);
    const agent = t.app.ctx.store.agent(a.id)!;
    fs.mkdirSync(path.join(ws, 'Campagne (2)'), { recursive: true });
    const file = path.join(ws, 'Campagne (2)', 'INRICHTING.md');
    fs.writeFileSync(file, '# Inrichting\nAlles staat goed.\n');
    const run = t.app.ctx.store.createRun({ thread_id: th.id, agent_id: a.id, user_id: a.user_id, trigger: 'user', status: 'done' } as any);
    t.app.ctx.store.createMessage({
      thread_id: th.id,
      role: 'assistant',
      author_type: 'agent',
      author_id: a.id,
      author_name: 'Bo',
      content: 'Klaar.',
      run_id: run.id,
      parts: {
        activity: [
          { kind: 'tool', title: 'Voerde uit: npm test', out: 'ℹ tests 1671\nℹ pass 1671\nℹ fail 0', ts: new Date().toISOString() },
          { kind: 'tool_error', title: 'Lukte niet: een opdracht uitvoeren: npm run lint', detail: 'Exit code 1', ts: new Date().toISOString() },
        ],
      },
    } as any);
    const steps = runSteps(t.app.ctx, run.id);
    assert.deepEqual(steps.map((s) => [s.ok, s.out]), [[true, 'ℹ tests 1671\nℹ pass 1671\nℹ fail 0'], [false, 'Exit code 1']]);
    const ev = inspectEvidence(t.app.ctx, { userId: a.user_id, agent, steps, values: [`${file} (118 regels, 8572 bytes; grep bevestigt sectie 3)`, 'ℹ pass 1671', `${path.join(ws, 'bestaat-niet.md')} (leeg)`] });
    assert.deepEqual(ev.map((e) => [e.type, e.ok]), [['file', true], ['output', true], ['file', false]]);
    assert.match(ev[0].excerpt || '', /Alles staat goed/);
  } finally {
    await t.close();
  }
});

test('deleting a bot releases its claims', async () => {
  const t = await startTestApp();
  try {
    const { a, th } = await bot(t, 'Bo');
    const tk = await boardTask(t, 'Iets doen');
    t.script.push({ toolCalls: [{ name: 'task_claim', args: { id: tk.id } }] }, { text: 'ok' });
    await t.say(th.id, 'pak op');
    assert.ok((await task(t, tk.id)).quality.claim);
    await t.api('DELETE', `/agents/${a.id}`);
    await until(async () => !(await task(t, tk.id)).quality.claim);
  } finally {
    await t.close();
  }
});

test('team databases per team (B2): task #1 of two teams gets its own second look; the routes take "<teamId>:<id>"', async () => {
  const t = await startTestApp();
  try {
    // Two teams; the first is the default team.
    const home = await t.api('POST', '/teams', { name: 'Thuis', starterRules: false });
    const shop = await t.api('POST', '/teams', { name: 'Webshop', starterRules: false });
    const bo = await bot(t, 'Bo');
    const kim = await bot(t, 'Kim');
    await t.api('PUT', `/teams/${home.id}/bots/${bo.a.id}`);
    await t.api('PUT', `/teams/${shop.id}/bots/${kim.a.id}`);
    assert.equal((await t.api('GET', '/teams'))[0].id, home.id);
    const klaar = (titel: string, als: string) => [
      { toolCalls: [{ name: 'team_execute', args: { sql: "INSERT INTO taken (titel, eigenaar, status, klaar_als) VALUES (?, 'bot', 'bezig', ?)", params: [titel, als] } }] },
      { toolCalls: [{ name: 'team_execute', args: { sql: "UPDATE taken SET status = 'klaar', resultaat = 'af' WHERE id = 1" } }] },
      { text: 'ok' },
    ];
    t.script.push(...klaar('Rapport', 'rapport.md'));
    await t.say(bo.th.id, 'maak het rapport');
    t.script.push(...klaar('Productfoto', 'foto.png'));
    await t.say(kim.th.id, 'maak de foto');
    // Both are task #1, each in its own team database, and both wait for the owner.
    assert.equal((await t.api('GET', '/teamdata/tasks'))[0].status, 'wacht_op_controle');
    assert.equal((await t.api('GET', `/teamdata/tasks?team=${shop.id}`))[0].titel, 'Productfoto');
    const inbox = (await t.api('GET', '/quality/inbox')).tasks.filter((x: any) => x.kind === 'teamdata');
    assert.deepEqual(inbox.map((x: any) => x.ref).sort(), [`${home.id}:1`, `${shop.id}:1`].sort(), 'two records, one per team');
    assert.equal((await t.api('GET', '/quality/task/teamdata/1')).doneWhen, 'rapport.md', 'a plain id: the default team');
    assert.equal((await t.api('GET', `/quality/task/teamdata/1?team=${shop.id}`)).doneWhen, 'foto.png');
    assert.equal((await t.api('GET', `/quality/task/teamdata/${shop.id}:1`)).doneWhen, 'foto.png');
    assert.equal((await t.api('GET', `/quality/task/teamdata/${home.id}:1`)).doneWhen, 'rapport.md');

    // The owner approves the webshop's task by its ref: only that team's row and record change.
    await t.api('PATCH', `/teamdata/tasks/${shop.id}:1`, { status: 'klaar' });
    assert.equal((await t.api('GET', `/teamdata/tasks?team=${shop.id}`))[0].status, 'klaar');
    assert.equal((await t.api('GET', '/teamdata/tasks'))[0].status, 'wacht_op_controle');
    assert.deepEqual((await t.api('GET', '/quality/inbox')).tasks.filter((x: any) => x.kind === 'teamdata').map((x: any) => x.ref), [`${home.id}:1`]);
    const back = await t.api('POST', `/teamdata/tasks/${shop.id}:1/reopen`, { note: 'De achtergrond moet wit.' });
    assert.equal(back.task.status, 'bezig');
    assert.equal((await t.api('GET', '/teamdata/tasks'))[0].status, 'wacht_op_controle', 'the other team untouched');
    await assert.rejects(t.api('PATCH', '/teamdata/tasks/team_bestaatniet:1', { status: 'klaar' }), /Team niet gevonden/);
  } finally {
    await t.close();
  }
});
