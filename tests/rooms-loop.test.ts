import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppHandle } from '../server/app.js';
import type { ChatRequest, ChatResult, StreamEvent } from '../server/core/types.js';
import { DEFAULT_LIMITS } from '../server/modules/rooms/routing.js';
import { startTestApp, type TestApp } from './helpers.js';
import { msgs, reopen, runsOf, settle, sleep, team, until, type BotStep } from './team-mock.js';

/**
 * No built-in brake on the work between bots (owner rule): the counts of turns, hops and messages are settings that
 * are off until the owner sets them. What stops by itself is only a real loop: in one chain the same bot gives the
 * same colleague the same request for the third time, the two times before came back the same, and nothing changed in
 * between. A busy team that keeps producing is never stopped by a count. Two bots that keep talking in other words
 * without anything changing are not stopped either: the owner hears it once.
 */

process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, 'fixtures', 'cli-agents-fake-claude.mjs');
const FAKE_ACP = path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs');

type App = { app: AppHandle };
const CAPS = ['maxTurnsPerMessage', 'maxDelegationDepth', 'maxHandoffs', 'maxBroadcastTargets', 'maxAskTurns', 'maxAsksPerHour', 'maxAsksPerPairPerHour'] as const;
const deleg = (t: App) => t.app.ctx.store.all<any>('SELECT * FROM room_delegations ORDER BY created_at, rowid').map((r: any) => t.app.ctx.store.decode<any>('room_delegations', r));
const allRuns = (t: App) => t.app.ctx.store.all<any>('SELECT * FROM runs ORDER BY created_at, rowid');
const toolOut = (t: TestApp, threadId: string) => msgs(t, threadId).filter((x) => x.role === 'tool');
const loopNotes = (t: App) => t.app.ctx.store.all<any>("SELECT title, body, link FROM notifications WHERE title LIKE 'Lus gestopt%'");
/** The notices that two bots talk without change, each with how often it came in (the centre makes repeats one line). */
const stallNotes = (t: App) => t.app.ctx.store.all<any>("SELECT title, body, link, count FROM notifications WHERE title LIKE '% overleggen al % beurten zonder dat er iets verandert'");
const LOOP = /^Gestopt om een lus te voorkomen: je gaf Bo dit al twee keer, het kwam twee keer hetzelfde terug en er is in de tussentijd niets veranderd\./;

async function quiet(t: App) {
  await settle(t, 30_000);
  await sleep(300);
  await settle(t, 30_000);
}

test('two bots that go round without progress are stopped by the loop rule: one sentence to the giver, one notification to the owner; anything that changed is not a loop', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const store = t.app.ctx.store;
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    const ask = (message = 'Maak de offerte af.') => ({ name: 'ask_bot', args: { bot: 'Bo', message } });
    const turnsOfBo = () => allRuns(t).filter((x) => x.agent_id === bo.id).length;
    const refused = () => toolOut(t, th.id).filter((x) => LOOP.test(x.content));

    // 1. Ada asks Bo the same thing, Bo answers the same thing, and nothing else happens. The third time is not started.
    m.script('Ada', { toolCalls: [ask()] }, { text: 'Gevraagd.' }, { toolCalls: [ask()] }, { text: 'Nog eens gevraagd.' }, { toolCalls: [ask(), ask()] }, { text: 'Het lukt zo niet; ik leg het je voor.' });
    m.script('Bo', { text: 'Bo: ik wacht op de cijfers van Ada.' }, { text: 'Bo: ik wacht op de cijfers van Ada.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Bo de offerte afmaken.' });
    await quiet(t);
    assert.equal(deleg(t).length, 2, 'two rounds were made, the third was not');
    assert.equal(turnsOfBo(), 2);
    assert.equal(refused().length, 2, 'both further attempts in that turn');
    assert.equal(refused()[0].content, 'Gestopt om een lus te voorkomen: je gaf Bo dit al twee keer, het kwam twee keer hetzelfde terug en er is in de tussentijd niets veranderd. Geef het niet nog een keer zo: pak het anders aan, doe het zelf of leg het voor aan ' + t.app.ctx.auth.owner()!.name + '.');
    assert.equal(msgs(t, th.id).filter((x) => x.role === 'assistant').at(-1)!.content, 'Het lukt zo niet; ik leg het je voor.');
    const told = loopNotes(t);
    assert.equal(told.length, 1, 'the owner hears it once');
    assert.equal(told[0].title, 'Lus gestopt tussen Ada en Bo');
    assert.match(told[0].body, /Ada gaf Bo drie keer hetzelfde en kreeg twee keer hetzelfde terug, zonder dat er iets veranderde: “Maak de offerte af\.”/);
    assert.equal(told[0].link, `#/t/${th.id}`);
    const chain1 = deleg(t)[0].chain_id;
    assert.ok(deleg(t).every((x) => x.chain_id === chain1), 'one origin');

    // 2. A new message of the owner is a new origin: the same request is simply made again.
    m.script('Ada', { toolCalls: [ask()] }, { text: 'Opnieuw gevraagd.' });
    m.script('Bo', { text: 'Bo: de offerte is af.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'De cijfers staan er nu; vraag het Bo nog eens.' });
    await quiet(t);
    assert.equal(deleg(t).length, 3);
    assert.notEqual(deleg(t)[2].chain_id, chain1);
    assert.equal(deleg(t)[2].status, 'done');

    // 3. The same request with a different outcome each time is work, not a loop.
    m.script('Ada', { toolCalls: [ask('Hoe ver is de offerte?')] }, { text: '.' }, { toolCalls: [ask('Hoe ver is de offerte?')] }, { text: '.' }, { toolCalls: [ask('Hoe ver is de offerte?')] }, { text: '.' }, { toolCalls: [ask('Hoe ver is de offerte?')] }, { text: 'Klaar.' });
    m.script('Bo', { text: 'Bo: een kwart.' }, { text: 'Bo: de helft.' }, { text: 'Bo: bijna.' }, { text: 'Bo: af.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Volg de offerte.' });
    await quiet(t);
    assert.equal(deleg(t).length, 7, 'four rounds, none refused');

    // 4. The same request and the same outcome, but between the rounds the giver told the owner something: not a loop.
    m.script('Ada', { toolCalls: [ask('Staat de bus er al?')] }, { text: '.' }, { toolCalls: [{ name: 'notify_user', args: { message: 'De bus is er nog niet.' } }, ask('Staat de bus er al?')] }, { text: '.' }, { toolCalls: [{ name: 'notify_user', args: { message: 'Nog steeds niet.' } }, ask('Staat de bus er al?')] }, { text: 'Ik blijf kijken.' });
    m.script('Bo', { text: 'Bo: nee.' }, { text: 'Bo: nee.' }, { text: 'Bo: nee.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Kijk of de bus er is en houd me op de hoogte.' });
    await quiet(t);
    assert.equal(deleg(t).length, 10, 'three rounds, none refused');

    // 5. The same request and the same outcome, but a task on the board moved on in between: not a loop.
    const task = () => store.one<any>("SELECT id FROM room_tasks WHERE title = 'Offerte nalopen'");
    m.script(
      'Ada',
      { toolCalls: [ask('Is er nieuws?')] },
      { text: '.' },
      { toolCalls: [{ name: 'task_create', args: { title: 'Offerte nalopen', owner: 'mij', done_when: 'De offerte is nagelopen' } }, ask('Is er nieuws?')] },
      { text: '.' },
      {
        get toolCalls() {
          return [{ name: 'task_claim', args: { id: task().id } }, ask('Is er nieuws?')];
        },
      },
      { text: 'Ik loop de offerte na.' },
    );
    m.script('Bo', { text: 'Bo: nee.' }, { text: 'Bo: nee.' }, { text: 'Bo: nee.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Vraag Bo naar nieuws en loop de offerte na.' });
    await quiet(t);
    assert.equal(deleg(t).length, 13, 'three rounds, none refused');
    assert.equal(refused().length, 2, 'only the loop of step 1 was ever refused');
    assert.equal(loopNotes(t).length, 1);

    // 6. A cap is a setting of the owner. Off (the default) refuses nothing; set, it works as before. -1 = no work
    //    between bots at all.
    await t.api('PUT', '/rooms/defaults', { maxDelegationDepth: -1 });
    m.script('Ada', { toolCalls: [ask('Nog één vraag.')] }, { text: 'Dat mag niet.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Vraag het Bo.' });
    await quiet(t);
    assert.equal(toolOut(t, th.id).at(-1)!.content, 'Werk doorgeven aan andere bots staat uit (ingesteld door de eigenaar).');
    assert.equal(deleg(t).length, 13);
  } finally {
    await t.close();
  }
});

test('a colleague on a CLI engine that writes with the engine’s own tools makes progress: the same request three times is no loop; without the write it is (Claude Code, an ACP agent)', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    const refused = (name: string) => toolOut(t, th.id).filter((x) => x.content.startsWith(`Gestopt om een lus te voorkomen: je gaf ${name} dit al twee keer`));
    // Bo on Claude Code writes perm.txt with its own Write tool; Cy on an ACP agent writes acp.txt through fs/write_text_file.
    const engines = [
      { name: 'Bo', kind: 'claude-code', config: { path: FAKE_CLAUDE }, write: 'SCENARIO:perm', file: 'perm.txt' },
      { name: 'Cy', kind: 'acp-custom', config: { command: FAKE_ACP, args: [] }, write: 'SCENARIO:edit', file: 'acp.txt' },
    ];
    for (const e of engines) {
      const p = await t.api('POST', '/providers', { kind: e.kind, config: e.config });
      const bot = await t.api('POST', '/agents', { name: e.name, provider_id: p.id, model: '', access_mode: 'auto' });
      const ask = (message: string) => ({ name: 'ask_bot', args: { bot: e.name, message } });
      // One message of the owner (one chain): Ada gives the colleague the same request three times.
      const rounds = async (message: string, owner: string) => {
        const before = deleg(t).length;
        m.script('Ada', { toolCalls: [ask(message)] }, { text: '.' }, { toolCalls: [ask(message)] }, { text: '.' }, { toolCalls: [ask(message)] }, { text: 'Klaar.' });
        await t.api('POST', `/threads/${th.id}/messages`, { content: owner });
        await quiet(t);
        return deleg(t).slice(before);
      };

      // 1. Each time the colleague writes the file with its engine's own tool and gives the same answer: not a loop.
      const wrote = await rounds(`${e.write} Zet het bestand neer.`, `Laat ${e.name} het bestand neerzetten.`);
      assert.equal(wrote.length, 3, `${e.name}: all three were started`);
      assert.ok(wrote.every((d) => d.status === 'done'), JSON.stringify(wrote.map((d) => [d.status, d.error])));
      assert.equal(new Set(wrote.map((d) => d.result)).size, 1, `${e.name}: the same answer each time (${wrote[0].result})`);
      assert.ok(fs.existsSync(path.join(bot.workspace, e.file)), `${e.name} wrote ${e.file}`);
      assert.equal(refused(e.name).length, 0);

      // 2. The same three requests in a new chain, but the colleague only answers: the third is refused.
      const talked = await rounds('Hoe gaat het?', `Vraag ${e.name} hoe het gaat.`);
      assert.equal(talked.length, 2, `${e.name}: the third was not started`);
      assert.equal(new Set(talked.map((d) => d.result)).size, 1, `${e.name}: the same answer twice (${talked[0].result})`);
      assert.equal(refused(e.name).length, 1);
    }
    assert.equal(loopNotes(t).length, 2, 'the owner heard of both loops, once each');
  } finally {
    await t.close();
  }
});

test('a fresh installation has no cap: one chain does more than 600 productive turns through ask_bot and board tasks, nothing is refused and the owner is not warned', async () => {
  const t = await startTestApp();
  try {
    // Nothing was set: every count is off.
    const d = await t.api('GET', '/rooms/defaults');
    for (const k of CAPS) assert.equal((d.limits || d)[k], 0, k);
    for (const k of CAPS) assert.equal(DEFAULT_LIMITS[k], 0, k);

    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const cy = await m.bot('Cy');
    const store = t.app.ctx.store;
    const ROUNDS = 200;
    // Every turn of Ada hands out a question for Bo and a task for Cy; every answer wakes her for the next round. Cy
    // picks up the task it got (task_claim): the board moves on every round, so this chain really produces.
    const giving: BotStep[] = [];
    for (let i = 1; i <= ROUNDS; i++) giving.push({ toolCalls: [{ name: 'ask_bot', args: { bot: 'Bo', message: `Reken deel ${i} door.` } }, { name: 'task_create', args: { title: `Hoofdstuk ${i} schrijven`, owner: 'Cy', done_when: `Hoofdstuk ${i} staat in het rapport` } }] }, { text: `Ronde ${i} uitgezet.` });
    m.script('Ada', ...giving);
    m.script('Bo', ...Array.from({ length: ROUNDS }, (_, i) => ({ text: `Bo: deel ${i + 1} is doorgerekend.` })));
    const nextTask = () => store.one<{ id: string }>("SELECT id FROM room_tasks WHERE owner_id = ? AND status = 'todo' ORDER BY created_at, rowid LIMIT 1", cy.id)!.id;
    const working: BotStep[] = [];
    for (let i = 1; i <= ROUNDS; i++)
      working.push(
        {
          get toolCalls() {
            return [{ name: 'task_claim', args: { id: nextTask() } }];
          },
        },
        { text: `Cy: hoofdstuk ${i} is geschreven.` },
      );
    m.script('Cy', ...working);
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Maak het rapport met het hele team.' });
    await until(() => deleg(t).length === 2 * ROUNDS && deleg(t).every((x) => x.status === 'done' && x.delivered), 240_000);
    await quiet(t);

    const ds = deleg(t);
    const chain = ds[0].chain_id;
    assert.ok(ds.every((x) => x.chain_id === chain), 'one origin: the owner’s one message');
    assert.equal(ds.filter((x) => x.to_agent_id === bo.id).length, ROUNDS, 'a pair far above the old 60 an hour');
    assert.equal(ds.filter((x) => x.to_agent_id === cy.id && x.task_id).length, ROUNDS);
    const turns = store.one<{ n: number }>("SELECT COUNT(*) n FROM runs WHERE json_extract(meta, '$.team.chainId') = ?", chain)!.n + 1;
    assert.ok(turns >= 600, `${turns} turns in the one chain`);
    assert.ok(allRuns(t).every((x) => x.status === 'done'), 'every turn ended well');
    const bad = toolOut(t, th.id).filter((x) => x.parts.toolResult?.isError);
    assert.deepEqual(bad.map((x) => x.content.slice(0, 120)), [], 'no hand-over was refused');
    assert.ok(!msgs(t, th.id).some((x) => x.role === 'event' && /Maximum van|Limiet bereikt/.test(x.content)));
    assert.equal(t.app.ctx.store.all("SELECT 1 FROM notifications WHERE title LIKE 'Lus gestopt%'").length, 0, 'producing is not a loop');
    assert.equal(stallNotes(t).length, 0, 'producing is not talking without change');
    assert.equal(store.one<{ n: number }>("SELECT COUNT(*) n FROM room_tasks WHERE owner_id = ? AND status = 'doing'", cy.id)!.n, ROUNDS, 'Cy picked up every task');
    assert.ok(runsOf(t, th.id, ada.id).length >= ROUNDS);
  } finally {
    await t.close();
  }
});

/**
 * An API engine for one bot whose steps (tool calls too) go on after a restart of TeamBot: register it again on the
 * reopened app with the steps from then on (the engine of reopen() answers only with text).
 */
function oneBotEngine(app: AppHandle, steps: BotStep[]) {
  let n = 0;
  app.ctx.providers.registerKind({
    id: 'mockone',
    label: 'Mock één bot',
    type: 'api',
    needsKey: false,
    description: 'test',
    models: ['one-1'],
    defaultModel: 'one-1',
    create: () => ({
      kind: 'mockone',
      async listModels() {
        return [{ id: 'one-1' }];
      },
      async test() {
        return { ok: true, detail: 'mock' };
      },
      async chat(req: ChatRequest, _signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<ChatResult> {
        const step = steps.shift();
        const text = step ? step.text ?? '' : 'ok';
        if (text) onEvent({ type: 'text', delta: text });
        const toolCalls = (step?.toolCalls || []).map((c) => ({ id: `one_${++n}_${Date.now()}`, name: c.name, args: c.args }));
        return { text, toolCalls, usage: { input: 10, output: 5 }, stop: toolCalls.length ? 'tool_use' : 'end', model: req.model };
      },
    }),
  });
}

test('two bots that keep talking in other words are not stopped: after about 30 turns without anything changing the owner hears it once, also across a restart', async () => {
  const t = await startTestApp();
  let r2: Awaited<ReturnType<typeof reopen>> | null = null;
  try {
    const m = await team(t);
    // Ada's engine keeps its script across the restart; Bo is on the team engine.
    const adaSteps: BotStep[] = [];
    oneBotEngine(t.app, adaSteps);
    const one = await t.api('POST', '/providers', { kind: 'mockone' });
    const ada = await t.api('POST', '/agents', { name: 'Ada', provider_id: one.id, model: 'one-1', access_mode: 'auto' });
    await m.bot('Bo');
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    const ask = (i: number) => ({ toolCalls: [{ name: 'ask_bot', args: { bot: 'Bo', message: `Ronde ${i}: hoe kijk jij nu naar het plan?` } }] });
    // Each round in other words, and each answer too: the loop rule does not see a loop, so nothing is refused.
    const ROUNDS = 20;
    for (let i = 1; i <= ROUNDS; i++) adaSteps.push(ask(i), { text: `Ronde ${i} gevraagd.` });
    m.script('Bo', ...Array.from({ length: ROUNDS - 1 }, (_, i) => ({ text: `Bo: ik zie het plan nu zo, versie ${i + 1}.` })), { text: 'nooit', delayMs: 60_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Overleg met Bo over het plan.' });
    const adaBusy = () => !!t.app.ctx.store.one("SELECT 1 FROM runs WHERE agent_id = ? AND status IN ('queued','running','waiting')", ada.id);
    await until(() => deleg(t).length === ROUNDS && deleg(t)[ROUNDS - 1].status === 'running' && !adaBusy(), 60_000);

    const ds = deleg(t);
    assert.ok(ds.every((x) => x.chain_id === ds[0].chain_id), 'one chain');
    assert.ok(ds.slice(0, -1).every((x) => x.status === 'done'), 'every round was made, nothing refused');
    assert.equal(new Set(ds.slice(0, -1).map((x) => x.result)).size, ROUNDS - 1, 'a different answer every round');
    assert.equal(loopNotes(t).length, 0, 'not a loop for the loop rule');
    const told = stallNotes(t);
    assert.deepEqual(told.map((x) => x.count), [1], 'the owner hears it once');
    assert.equal(told[0].title, 'Ada en Bo overleggen al 30 beurten zonder dat er iets verandert');
    assert.equal(told[0].link, `#/t/${th.id}`, 'to the conversation of the bot that gives the work');
    const audit = t.app.ctx.store.all<any>("SELECT * FROM audit WHERE kind = 'team.stall'");
    assert.equal(audit.length, 1);
    assert.ok(audit[0].created_at >= ds[14].created_at && audit[0].created_at <= ds[15].created_at, 'at the 15th request between them');

    // TeamBot starts again while Bo works on round 20; after it Ada asks once more in the same chain: not told twice.
    await t.app.close();
    adaSteps.length = 0;
    adaSteps.push(ask(21), { text: 'Ronde 21 gevraagd.' }, { text: 'Genoeg overlegd.' });
    r2 = await reopen(t, new Map<string, BotStep[]>([['Bo', [{ text: 'Bo: na de herstart, versie 20.' }, { text: 'Bo: versie 21.' }]]]));
    oneBotEngine(r2.app, adaSteps);
    await until(() => deleg(r2!).length === ROUNDS + 1 && deleg(r2!).every((x) => x.status === 'done' && x.delivered), 30_000);
    await quiet(r2);
    assert.equal(deleg(r2).at(-1)!.chain_id, ds[0].chain_id, 'the same chain after the restart');
    assert.deepEqual(stallNotes(r2).map((x) => x.count), [1], 'not told again after the restart');
    assert.equal(r2.app.ctx.store.all("SELECT 1 FROM audit WHERE kind = 'team.stall'").length, 1);
  } finally {
    if (r2) await r2.close();
    else await t.close();
  }
});

test('an installation from before: a value the owner chose stays, a value TeamBot wrote as default goes off, and what was stored is kept beside it', async () => {
  const t = await startTestApp();
  let r2: Awaited<ReturnType<typeof reopen>> | null = null;
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const store = t.app.ctx.store;
    const owner = t.app.ctx.auth.owner()!;
    const other = t.app.ctx.auth.createUser({ name: 'Bob', email: 'bob@example.test', password: 'wachtwoord123' });
    // As an installation from before the change had it: the settings form saved every field, so values the owner
    // never touched (the defaults of that day) are stored next to the two he did change and the cost cap he set.
    const before = { maxTurnsPerMessage: 200, maxDelegationDepth: 8, maxHandoffs: 20, maxBroadcastTargets: 50, maxAskTurns: 120, maxAsksPerHour: 600, maxAsksPerPairPerHour: 15, maxCostUsd: 5 };
    store.setSetting(owner.id, 'rooms:defaults', before);
    // Someone who had turned work between bots off (0 meant "none"), on the defaults of the first week otherwise.
    store.setSetting(other.id, 'rooms:defaults', { maxDelegationDepth: 0, maxHandoffs: 0, maxTurnsPerMessage: 8, maxAskTurns: 40 });
    const mk = async (name: string, limits: any) => {
      const r = await t.api('POST', '/rooms', { name, agentIds: [ada.id], mode: 'lead', leadAgentId: ada.id });
      store.exec('UPDATE rooms SET limits = ? WHERE id = ?', JSON.stringify(limits), r.room.id);
      return r.room.id as string;
    };
    const readyMade = await mk('Kant-en-klaar team', { maxTurnsPerMessage: 8, maxDelegationDepth: 2, maxCostUsd: 3 });
    const own = await mk('Eigen groep', { maxTurnsPerMessage: 25 });
    const plain = await mk('Gewone groep', {});
    store.exec("DELETE FROM _migrations WHERE id = 'rooms-limits-off-by-default'");
    await t.app.close();

    r2 = await reopen(t, new Map<string, BotStep[]>());
    const s2 = r2.app.ctx.store;
    const limitsOf = (id: string) => s2.decode<any>('rooms', s2.one<any>('SELECT * FROM rooms WHERE id = ?', id));
    // The owner: his own three values stay, the five defaults are gone, so those limits are off.
    assert.deepEqual(s2.getSetting(owner.id, 'rooms:defaults', null), { maxAskTurns: 120, maxAsksPerPairPerHour: 15, maxCostUsd: 5 });
    const eff = await (await fetch(`${r2.app.url}/api/rooms/defaults`, { headers: { authorization: `Bearer ${t.token}` } })).json();
    const l = eff.limits || eff;
    assert.deepEqual(CAPS.map((k) => l[k]), [0, 0, 0, 0, 120, 0, 15]);
    assert.equal(l.maxCostUsd, 5);
    // "None at all" keeps its meaning under the new numbers.
    assert.deepEqual(s2.getSetting(other.id, 'rooms:defaults', null), { maxDelegationDepth: -1, maxHandoffs: -1 });
    // Groups: what a ready-made team wrote goes, what the owner typed stays.
    assert.deepEqual(limitsOf(readyMade).limits, { maxCostUsd: 3 });
    assert.deepEqual(limitsOf(own).limits, { maxTurnsPerMessage: 25 });
    assert.deepEqual(limitsOf(plain).limits, {});
    // Nothing is lost: what was stored is kept beside it.
    assert.deepEqual(s2.getSetting(owner.id, 'rooms:defaults:voor-limieten-uit', null), before);
    assert.deepEqual(limitsOf(readyMade).settings.limitsBefore, { maxTurnsPerMessage: 8, maxDelegationDepth: 2, maxCostUsd: 3 });
    assert.equal(limitsOf(plain).settings.limitsBefore, undefined);
    assert.ok(s2.one("SELECT 1 FROM _migrations WHERE id = 'rooms-limits-off-by-default'"), 'once');
  } finally {
    if (r2) await r2.close();
    else await t.close();
  }
});
