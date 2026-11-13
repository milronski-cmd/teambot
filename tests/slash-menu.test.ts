import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { applyPick, filterItems, slashToken, type MenuItem } from '../ui/src/shell/slash.js';

/** B-13: "/" or "$" in the composer lists the bot's skills (and commands); the picked skill is really used. */

test('when the menu opens, what it finds, and what a pick does to the text', () => {
  assert.deepEqual(slashToken('/bra', 4), { start: 0, end: 4, trigger: '/', query: 'bra' });
  assert.deepEqual(slashToken('/', 1), { start: 0, end: 1, trigger: '/', query: '' });
  assert.deepEqual(slashToken('eerste regel\n/zo', 16), { start: 13, end: 16, trigger: '/', query: 'zo' });
  assert.equal(slashToken('rood / blauw', 6), null, 'a slash inside a sentence is no command');
  assert.equal(slashToken('km/u', 4), null);
  assert.deepEqual(slashToken('schrijf dit met $brand', 22), { start: 16, end: 22, trigger: '$', query: 'brand' });
  assert.equal(slashToken('het kost $5', 11), null, 'money is not a skill');
  assert.equal(slashToken('/brand-guidelines maak', 22), null, 'after a space the menu closes');

  const items: MenuItem[] = [
    { kind: 'skill', id: 's1', label: 'brand-guidelines', description: 'Huisstijl van Anthropic' },
    { kind: 'skill', id: 's2', label: 'pdf', description: 'Pdf-bestanden maken en lezen' },
    { kind: 'command', id: 'c1', label: 'Zoeken in dit gesprek', keywords: ['zoek', 'vind'] },
    { kind: 'command', id: 'c2', label: 'Nieuw gesprek' },
  ];
  assert.deepEqual(filterItems(items, '').map((i) => i.id), ['s1', 's2', 'c1', 'c2']);
  assert.deepEqual(filterItems(items, 'br').map((i) => i.id), ['s1']);
  assert.deepEqual(filterItems(items, 'GUIDE').map((i) => i.id), ['s1'], 'a word inside the name, any case');
  assert.deepEqual(filterItems(items, 'zoek').map((i) => i.id), ['c1']);
  assert.deepEqual(filterItems(items, 'huisstijl').map((i) => i.id), ['s1'], 'also on the description');
  assert.deepEqual(filterItems(items, 'xyz'), []);

  assert.deepEqual(applyPick('/bra', slashToken('/bra', 4)!, items[0]), { text: '/brand-guidelines ', caret: 18 });
  assert.deepEqual(applyPick('maak dit $pd mooi', { start: 9, end: 12, trigger: '$', query: 'pd' }, items[1]), { text: 'maak dit $pdf mooi', caret: 14 });
  assert.deepEqual(applyPick('/zoe', slashToken('/zoe', 4)!, items[2]), { text: '', caret: 0 }, 'a command removes what was typed');
});

const md = (name: string, description: string, body: string) => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;

async function importPaste(t: TestApp, text: string) {
  const pv = await t.api('POST', '/skills/import/preview', { kind: 'paste', text });
  return (await t.api('POST', '/skills/import/commit', { stagingId: pv.stagingId })).results[0].skillId as string;
}

test('the menu lists the skills of the bot\'s team, and a picked skill is loaded and followed', async () => {
  const t = await startTestApp();
  try {
    const brand = await importPaste(t, md('brand-guidelines', 'Huisstijl met kleuren en lettertypen.', 'Gebruik altijd #d97757 en Poppins.'));
    // Switched off by the owner: not in the menu, and picking it does nothing.
    const off = await importPaste(t, md('niet-aan', 'Uitgezet door de eigenaar.', 'GEHEIM'));
    await t.api('PATCH', `/skills/${off}`, { status: 'disabled' });
    await importPaste(t, md('ook-van-het-team', 'Van het team; bij één bot weggehaald.', 'TEAM'));
    const bot = await t.agent({ tool_groups: ['skills'] });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    assert.deepEqual((await t.api('GET', `/skills/menu?threadId=${th.id}`)).skills.map((s: any) => s.name), ['brand-guidelines', 'ook-van-het-team'], 'every active skill of the team, nobody switched anything on');
    // Taken away from this bot (the owner names the one it keeps): not in its menu any more.
    await t.api('PUT', `/skills/agents/${bot.id}`, { skillIds: [brand] });

    const menu = await t.api('GET', `/skills/menu?threadId=${th.id}`);
    assert.deepEqual(menu.skills.map((s: any) => s.name), ['brand-guidelines'], 'the skills this bot has: its team\'s, minus what was taken away from it');
    assert.match(menu.skills[0].description, /Huisstijl/);

    // "/name" at the start: the turn tells the bot to load and follow that skill; the step shows "Skill laden".
    t.script.push({ toolCalls: [{ name: 'skill_load', args: { name: 'brand-guidelines' } }] }, { text: 'Poster in #d97757.' });
    const msgs = await t.say(th.id, '/brand-guidelines maak een poster voor de fietsenwinkel');
    const first = t.requests[0].messages.map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('\n');
    assert.match(first, /koos voor dit bericht de skill “brand-guidelines”/);
    assert.match(first, /skill_load/);
    const loaded = msgs.find((m: any) => m.role === 'tool' && m.parts.toolResult?.toolCallId && /Gebruik altijd #d97757/.test(m.content));
    assert.ok(loaded, 'the skill was loaded in this turn');

    // "$name" in the middle of a sentence works too; a skill the bot does not have or a plain message adds nothing.
    t.requests.length = 0;
    t.script.push({ text: 'ok' }, { text: 'ok' }, { text: 'ok' });
    await t.say(th.id, 'schrijf dit in onze stijl met $brand-guidelines, graag');
    await t.say(th.id, '/niet-aan doe iets');
    await t.say(th.id, 'gewoon een vraag over 3/4 van de omzet');
    const ctxOf = (i: number) => t.requests[i].messages.slice(-1).map((m: any) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content))).join('');
    assert.match(ctxOf(0), /skill “brand-guidelines”/);
    assert.doesNotMatch(ctxOf(1), /koos voor dit bericht de skill/);
    assert.doesNotMatch(ctxOf(2), /koos voor dit bericht de skill/);

    // A group conversation lists the skills of its bots (acceptance round 6: the menu was empty in every group).
    // A new bot has every active skill of the team; the first bot has only the brand skill left.
    const second = await t.agent({ name: 'Tweede', tool_groups: ['skills'] });
    const room = await t.api('POST', '/rooms', { name: 'Fietsteam', mode: 'mention', agentIds: [bot.id, second.id] });
    const groupMenu = await t.api('GET', `/skills/menu?threadId=${room.thread_id || room.threadId}`);
    assert.deepEqual(groupMenu.skills.map((s: any) => [s.name, s.bots]), [['brand-guidelines', ['Testbot', 'Tweede']], ['ook-van-het-team', ['Tweede']]], 'each skill names the bots that have it');

    // Someone else's conversation: not found.
    const other = t.app.ctx.auth.createUser({ name: 'Ander', role: 'member' });
    const tok = t.app.ctx.auth.createSession(other.id).token;
    const r = await fetch(`${t.app.url}/api/skills/menu?threadId=${th.id}`, { headers: { authorization: `Bearer ${tok}` } });
    assert.equal(r.status, 404);
  } finally {
    await t.close();
  }
});
