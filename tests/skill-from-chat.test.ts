import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { chatTurns, outlineDraft, parseDraft, transcriptOf } from '../server/modules/skills/from-chat.js';

/** "Bewaar als skill" (parity 7.5): a draft from a conversation, edited by the owner, saved for the bot or the team. */

test('from chat: the bot writes the draft from the conversation; nothing is saved until the owner saves', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Offertebot' });
    const other = await t.agent({ name: 'Collega' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    await t.say(th.id, 'Maak een offerte voor 3 bakfietsen aan Jansen');
    const before = (await t.api('GET', '/skills')).length;
    t.script.push({
      text: '{"name":"Offerte Opstellen","description":"Stelt een offerte op uit een klantvraag.","instructions":"# Offerte\\n\\n1. Lees de vraag.\\n2. Zet aantallen en prijzen in een tabel."}',
      check: (req) => {
        const prompt = String(req.messages.at(-1)?.content);
        assert.match(prompt, /<gesprek>[\s\S]*bakfietsen[\s\S]*<\/gesprek>/, 'the conversation goes along as data');
        assert.equal(req.tools?.length ?? 0, 0, 'no tools');
      },
    });
    const d = await t.api('POST', '/skills/from-chat/draft', { threadId: th.id });
    assert.deepEqual([d.ai, d.name, d.bot.name], [true, 'offerte-opstellen', 'Offertebot']);
    assert.match(d.instructions, /Zet aantallen/);
    assert.equal((await t.api('GET', '/skills')).length, before, 'a draft is not saved');

    // The owner edits and saves for this bot only.
    const saved = await t.api('POST', '/skills/from-chat/save', { threadId: th.id, agentId: bot.id, name: 'offerte-maken', description: 'Offerte uit een klantvraag.', instructions: d.instructions + '\n3. Controleer de btw.', scope: 'bot' });
    assert.equal(saved.status, 'created');
    assert.deepEqual(saved.enabledFor.map((a: any) => a.name), ['Offertebot']);
    const s = await t.api('GET', `/skills/${saved.skillId}`);
    assert.deepEqual([s.name, s.status, s.source.type], ['offerte-maken', 'active', 'chat']);
    const lib = t.app.ctx.services.skills.library;
    const md = lib.readFiles(lib.get(t.app.ctx.auth.owner()!.id, saved.skillId)).get('SKILL.md').toString('utf8');
    assert.match(md, /^---\nname: offerte-maken\ndescription: Offerte uit een klantvraag\./);
    assert.match(md, /Controleer de btw/);
    assert.ok((await t.api('GET', `/agents/${bot.id}`)).skills.includes(saved.skillId));
    assert.ok((await t.api('GET', `/agents/${other.id}`)).skills.includes(saved.skillId), 'every bot of the team has an active skill (skills/defaults.ts)');

    // The same name again is refused (never overwrites an existing skill); "for the team" switches it on for every bot.
    await assert.rejects(t.api('POST', '/skills/from-chat/save', { threadId: th.id, agentId: bot.id, name: 'offerte-maken', description: 'x', instructions: 'y', scope: 'bot' }), /409/);
    const team = await t.api('POST', '/skills/from-chat/save', { threadId: th.id, agentId: bot.id, name: 'offerte-team', description: 'Voor iedereen.', instructions: '# Stappen\n\n1. Doe het.', scope: 'team' });
    assert.deepEqual(team.enabledFor.map((a: any) => a.name).sort(), ['Collega', 'Offertebot']);
    // A bot that is not in the conversation cannot be used to save from it.
    await assert.rejects(t.api('POST', '/skills/from-chat/save', { threadId: th.id, agentId: other.id, name: 'nope', description: 'x', instructions: 'y' }), /400/);
  } finally {
    await t.close();
  }
});

test('from chat: when the engine fails, an outline from the conversation itself, with the reason', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Planner' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    await t.say(th.id, 'Plan mijn week met drie klantafspraken');
    t.script.push({ error: { message: 'service unavailable', status: 503 } });
    const d = await t.api('POST', '/skills/from-chat/draft', { threadId: th.id });
    assert.equal(d.ai, false);
    assert.ok(d.note, 'says why there is no AI draft');
    assert.match(d.instructions, /## Werkwijze\n1\. Plan mijn week/);
    assert.ok(d.name.length > 0 && /^[a-z0-9-]+$/.test(d.name));
  } finally {
    await t.close();
  }
});

test('from chat: helpers (turns up to a message, transcript with tools, parsing the engine answer)', () => {
  const m = (id: string, role: any, content: string, extra: any = {}) => ({ id, role, content, deleted: false, parts: {}, author_name: role === 'user' ? 'Jij' : 'Bot', ...extra }) as any;
  const msgs = [m('1', 'user', 'vraag'), m('2', 'assistant', 'antwoord', { parts: { toolCalls: [{ name: 'web_fetch' }] } }), m('3', 'event', 'x'), m('4', 'user', 'later')];
  assert.deepEqual(chatTurns(msgs, '2').map((x) => x.id), ['1', '2']);
  assert.deepEqual(chatTurns(msgs).map((x) => x.id), ['1', '2', '4']);
  const tr = transcriptOf(chatTurns(msgs));
  assert.deepEqual(tr.tools, ['web_fetch']);
  assert.match(tr.text, /^Gebruiker: vraag\n\nBot: antwoord/);
  assert.equal(parseDraft('geen json'), null);
  assert.equal(parseDraft('{"name":"","description":"a","instructions":"b"}'), null);
  assert.deepEqual(parseDraft('Hier: {"name":"Mijn Skill!","description":"Doet  iets.","instructions":"stap"}'), { name: 'mijn-skill', description: 'Doet iets.', instructions: 'stap' });
  const o = outlineDraft('Weekplanning', chatTurns(msgs), ['web_fetch']);
  assert.equal(o.name, 'weekplanning');
  assert.match(o.instructions, /Gebruikt in het gesprek: web_fetch/);
});
