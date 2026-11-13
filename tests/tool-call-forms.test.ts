import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { msgs, settle, team } from './team-mock.js';
import { checkArgs } from '../server/tools/schema.js';
import { parseEvidence } from '../server/modules/quality/evidence.js';

// The first bot would otherwise become the main bot by itself; the test about the main bot makes one on purpose.
process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

/**
 * Five tool calls that failed in real use (12 nov): a bot on a CLI engine calls TeamBot's tools without their schema in
 * front of it and guesses (`skill` for `name`, `task_id` for `id`, evidence as one text), a bot changes a task another
 * bot is working on, and the main bot asks for a cost estimate without saying for which bot. Either the call now does
 * what was meant, or the answer says exactly what to send, so the next call succeeds without the owner.
 */

const toolResults = (t: TestApp, threadId: string, name: string) =>
  msgs(t, threadId)
    .filter((m) => m.role === 'tool' && m.parts?.toolResult?.name === name)
    .map((m) => ({ content: m.content, isError: !!m.parts.toolResult!.isError }));
const task = async (t: TestApp, id: string) => (await t.api('GET', '/rooms/tasks')).find((x: any) => x.id === id);

test('skill_load with the name under "skill": the skill is loaded', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Bo', tool_groups: ['skills'] });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    t.script.push({ toolCalls: [{ name: 'skill_save', args: { name: 'Werkwijze verslag', description: 'Zo schrijf je een verslag van een overleg.', instructions: '1. Lees de aantekeningen.\n2. Schrijf het verslag. VERSLAG-STAPPEN' } }] }, { text: 'Vastgelegd.' });
    await t.say(th.id, 'Leg vast hoe je een verslag schrijft.');
    t.script.push({ toolCalls: [{ name: 'skill_load', args: { skill: 'werkwijze-verslag' } }] }, { text: 'Geladen.' });
    await t.say(th.id, 'Schrijf een verslag.');
    const r = toolResults(t, th.id, 'skill_load').at(-1)!;
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, /VERSLAG-STAPPEN/);
  } finally {
    await t.close();
  }
});

test('task_claim with the id under "task_id": the task is claimed', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Bo', tool_groups: ['team'] });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const tk = await t.api('POST', '/rooms/tasks', { title: 'Verslag van het overleg schrijven' });
    t.script.push({ toolCalls: [{ name: 'task_claim', args: { task_id: tk.id } }] }, { text: 'Ik begin eraan.' });
    await t.say(th.id, 'Pak de taak op.');
    const r = toolResults(t, th.id, 'task_claim').at(-1)!;
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, /Geclaimd: jij werkt nu aan “Verslag van het overleg schrijven”/);
    const after = await task(t, tk.id);
    assert.equal(after.status, 'doing');
    assert.equal(after.quality.claim.agentId, bot.id);
  } finally {
    await t.close();
  }
});

test('task_done with the evidence as one text, a piece per line: every line is looked at', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Bo', tool_groups: ['team', 'files'] });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const ws = t.app.ctx.store.agent(bot.id)!.workspace;
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'verslag.md'), '# Verslag\nBesloten: de planning schuift een week op.\n');
    fs.writeFileSync(path.join(ws, 'actielijst.md'), '- planning aanpassen\n');
    const tk = await t.api('POST', '/rooms/tasks', { title: 'Verslag schrijven', doneWhen: 'verslag.md bevat het besluit' });
    t.script.push(
      { toolCalls: [{ name: 'task_done', args: { id: tk.id, result: 'Verslag en actielijst geschreven.', evidence: 'verslag.md\nactielijst.md' } }] },
      { text: '{"verdict":"klaar","reason":"In verslag.md staat het besluit."}' },
      { text: 'Afgemeld.' },
    );
    await t.say(th.id, 'Meld het verslag af.');
    const r = toolResults(t, th.id, 'task_done').at(-1)!;
    assert.equal(r.isError, false, r.content);
    assert.match(r.content, /Gecontroleerd en klaar/);
    const after = await task(t, tk.id);
    assert.equal(after.status, 'done');
    assert.deepEqual(after.quality.evidence.map((e: any) => e.ok), [true, true], 'two pieces of evidence, both found');
    // The same rule in the parts: text for a list of texts is a list of one, and a piece per line also inside a list.
    const schema = { type: 'object', properties: { id: { type: 'string' }, evidence: { type: 'array', items: { type: 'string' } } }, required: ['id'] };
    assert.deepEqual(checkArgs(schema, { id: 'x', evidence: 'verslag.md' }), { args: { id: 'x', evidence: ['verslag.md'] }, error: null });
    assert.deepEqual(parseEvidence(['verslag.md\n- actielijst.md', 'https://voorbeeld.test/pagina']), ['verslag.md', 'actielijst.md', 'https://voorbeeld.test/pagina']);
    assert.match(checkArgs({ type: 'object', properties: { rows: { type: 'array', items: { type: 'object' } } } }, { rows: 'tekst' }).error!, /rows moet type array hebben/, 'text is never a list of objects');
  } finally {
    await t.close();
  }
});

test('a guessed argument name is only taken when it is clear which argument was meant', () => {
  const claim = { type: 'object', properties: { id: { type: 'string', description: 'Id van de taak (task_…)' } }, required: ['id'] };
  assert.deepEqual(checkArgs(claim, { taskId: 'task_1' }).args, { id: 'task_1' });
  assert.deepEqual(checkArgs(claim, { task_id: 'task_1', note: 'haast' }).args, { id: 'task_1', note: 'haast' }, 'the name holds the missing one as a word');
  // Nothing to go on: the answer says what the argument is, so the next call has it.
  assert.equal(checkArgs(claim, {}).error, 'Verplicht argument ontbreekt: id — Id van de taak (task_…).');
  assert.match(checkArgs(claim, { titel: 'a', nummer: 'b' }).error!, /Verplicht argument ontbreekt: id/, 'two unknown arguments: no guess');
  assert.match(checkArgs(claim, { task_id: 5 }).error!, /Verplicht argument ontbreekt: id/, 'the wrong type is never moved');
  const write = { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] };
  assert.deepEqual(checkArgs(write, { file_path: 'a.txt', text: 'hallo' }).args, { path: 'a.txt', content: 'hallo' }, 'one by its name, the other because it is the only one left');
  assert.deepEqual(checkArgs(write, { path: 'a.txt', content: 'hallo', extra: 1 }).args, { path: 'a.txt', content: 'hallo', extra: 1 }, 'a complete call is left alone');
  const many = { type: 'object', properties: { bots: { type: 'array', items: { type: 'string' } }, message: { type: 'string' } }, required: ['bots', 'message'] };
  assert.deepEqual(checkArgs(many, { bot: 'Ada', message: 'hoi' }).args, { bots: ['Ada'], message: 'hoi' });
});

test('task_update on a task another bot is working on: the answer says what does work, and that call succeeds', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    await m.bot('Cy');
    const tk = await t.api('POST', '/rooms/tasks', { title: 'Planning bijwerken', ownerType: 'agent', ownerId: bo.id, start: false });
    const boChat = await t.api('POST', '/threads', { agentId: bo.id });
    m.script('Bo', { toolCalls: [{ name: 'task_claim', args: { id: tk.id } }] }, { text: 'Ik ben ermee bezig.' });
    await t.api('POST', `/threads/${boChat.id}/messages`, { content: 'Pak de planning op.' });
    await settle(t);
    assert.equal((await task(t, tk.id)).quality.claim.agentId, bo.id);

    const th = await t.api('POST', '/threads', { agentId: ada.id });
    m.script('Ada', { toolCalls: [{ name: 'task_update', args: { id: tk.id, status: 'blocked', result: 'Wacht op de nieuwe datum.' } }] }, { toolCalls: [{ name: 'task_update', args: { id: tk.id, owner: 'Cy' } }] }, { text: 'Cy neemt het over.' });
    m.script('Cy', { text: 'Cy: ik pak de planning op.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Zet de planning op geblokkeerd.' });
    await settle(t);
    const [refused, given] = toolResults(t, th.id, 'task_update');
    assert.equal(refused.isError, true);
    assert.match(refused.content, /Bo werkt aan “Planning bijwerken”, dus de status en het resultaat zet alleen Bo/);
    assert.match(refused.content, /task_update met alleen id en owner .* of ask_bot om Bo iets te laten weten/);
    assert.equal(given.isError, false, given.content);
    assert.match(given.content, /Bijgewerkt[\s\S]*eigenaar: Cy/);
    const after = await task(t, tk.id);
    assert.equal(after.ownerName, 'Cy');
    assert.notEqual(after.status, 'blocked', 'the refused change did not happen');
  } finally {
    await t.close();
  }
});

test('teambot_do GET /usage/estimate without a bot: the answer says what to send; a name works as well as an id', async () => {
  const t = await startTestApp();
  try {
    const main = await t.agent({ name: 'Baas' });
    await t.api('PUT', `/teams/main/${main.id}`);
    const th = t.app.ctx.chat.threadForAgent(t.app.ctx.auth.owner()!.id, main.id);
    t.script.push(
      { toolCalls: [{ name: 'teambot_do', args: { method: 'GET', path: '/usage/estimate' } }] },
      { toolCalls: [{ name: 'teambot_do', args: { method: 'GET', path: '/usage/estimate', query: { agentId: 'Baas' } } }] },
      { toolCalls: [{ name: 'teambot_do', args: { method: 'GET', path: '/usage/estimate', query: { agentId: 'Niemand' } } }] },
      { text: 'Dit kost een run ongeveer.' },
    );
    await t.say(th.id, 'Wat kost een run van jou?');
    const [first, second, third] = toolResults(t, th.id, 'teambot_do');
    assert.equal(first.isError, true);
    assert.match(first.content, /Geef aan voor welke bot of routine .* query agentId \(het id of de naam van een bot, zie GET \/agents\) of routineId/);
    assert.doesNotMatch(first.content, /Klopt het id/, 'there was no id to check');
    assert.equal(second.isError, false, second.content);
    assert.match(second.content, /gelukt[\s\S]*"estimated"/);
    // A bot that does not exist is still a plain "niet gevonden", now with a full stop before the hint.
    assert.match(third.content, /Bot niet gevonden\. Klopt het id\?/);
    assert.equal(typeof (await t.api('GET', `/usage/estimate?agentId=${main.id}`)).estimated, 'boolean', 'by id, as the app asks it');
    await assert.rejects(t.api('GET', '/usage/estimate'), /400: Geef aan voor welke bot of routine/);
  } finally {
    await t.close();
  }
});
