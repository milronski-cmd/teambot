/**
 * "Ja, doe maar" on a bot's memory proposal (plan 0.4 F): a memory with the undo line under the owner's reply, and
 * only when the reply plainly says yes to a concrete proposal at the end of the bot's previous answer.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { isConfirmation, ownerVoice, proposalIn } from '../server/modules/memory/confirm.js';

const ctxOf = (m: any): string => m?.parts?.context ?? '';
const lastUser = (msgs: any[]) => msgs.filter((m) => m.role === 'user').at(-1);

test('what counts as yes, what counts as a concrete proposal, and the fact in the owner’s own words', () => {
  for (const s of ['Ja', 'ja, doe maar', 'Ja graag!', 'Ja, klopt', 'klopt', 'Ja, dat klopt helemaal', 'oké, doe maar', 'Prima, sla maar op', 'yes please', 'Sure', '👍', 'Ja, onthoud dat maar'])
    assert.equal(isConfirmation(s), true, s);
  for (const s of ['nee', 'Ja, maar alleen voor werk', 'Ja maar', 'doe maar niet', 'Ja? Hoezo?', 'Ja, en zoek ook even de offerte op', 'Liever niet', 'Hoe laat is het', ''])
    assert.equal(isConfirmation(s), false, s);

  const p = proposalIn('Leuk om te horen! Zal ik onthouden dat je hond Bram heet?');
  assert.deepEqual(p?.clauses, [{ text: 'je hond Bram heet', subordinate: true }]);
  assert.deepEqual(proposalIn('Wil je dat ik onthoud: je werkt op vrijdag thuis?')?.clauses, [{ text: 'je werkt op vrijdag thuis', subordinate: false }]);
  assert.deepEqual(proposalIn('Shall I remember that you prefer short answers?')?.clauses, [{ text: 'you prefer short answers', subordinate: true }]);
  assert.equal(proposalIn('Zal ik onthouden dat je in Utrecht woont en dat je hond Bram heet?')?.clauses.length, 2);
  assert.deepEqual(proposalIn('Zal ik dat voor je onthouden?')?.clauses, [], 'a vague proposal');
  assert.equal(proposalIn('Zal ik de offerte versturen?'), null, 'not about memory');
  assert.equal(proposalIn('Zal ik het bestand opslaan als pdf?'), null, '"opslaan" without memory');
  assert.equal(proposalIn('Ik heb onthouden dat je hond Bram heet.'), null, 'no question');
  assert.equal(proposalIn('Zal ik onthouden dat je hond Bram heet? Daarnaast heb ik nog wat tips. Eerste tip: ga wandelen. Tweede tip: neem water mee.'), null, 'the question is not where the answer ends');

  assert.equal(ownerVoice('je hond Bram heet', true), 'Mijn hond heet Bram');
  assert.equal(ownerVoice('je in Utrecht woont', true), 'Ik woon in Utrecht');
  assert.equal(ownerVoice('je graag thee drinkt', true), 'Ik drink graag thee');
  assert.equal(ownerVoice('je koffie zwart drinkt', true), 'Ik drink koffie zwart');
  assert.equal(ownerVoice('u op dinsdag niet beschikbaar bent', true), 'Ik ben op dinsdag niet beschikbaar');
  assert.equal(ownerVoice('je werkt op vrijdag thuis', false), 'Ik werk op vrijdag thuis');
  assert.equal(ownerVoice('je hond heet Bram', false), 'Mijn hond heet Bram');
  assert.equal(ownerVoice('op vrijdag werk je thuis', false), 'Op vrijdag werk ik thuis');
  assert.equal(ownerVoice('de lancering op 1 maart is', true), 'De lancering is op 1 maart', 'no "you": only the word order');
  assert.equal(ownerVoice('you prefer short answers', true), 'I prefer short answers');
  assert.equal(ownerVoice('your dog is called Bram', true), 'My dog is called Bram');
  assert.equal(ownerVoice('jullie op maandag vergaderen', true), null, '"jullie": not sure who');
  // Live with a small local model: "Zal ik onthouden dat ik de oude offertes verwijdert?" — "ik" is the bot.
  assert.equal(ownerVoice('ik de oude offertes verwijdert', true), null);
  assert.equal(ownerVoice('I will delete the old files', true), null);
});

async function setup() {
  const t = await startTestApp();
  await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
  const a = await t.agent();
  const th = await t.api('POST', '/threads', { agentId: a.id });
  return { t, a, th };
}
const items = async (t: TestApp) => (await t.api('GET', '/memory/items?status=all')).items as any[];

test('"Ja, doe maar" on "Zal ik onthouden dat …?" stores the fact in the owner’s words, with the undo line under the reply', async () => {
  const { t, th } = await setup();
  try {
    t.script.push({ text: 'Wat leuk! Zal ik onthouden dat je hond Bram heet?' });
    await t.say(th.id, 'We hebben sinds kort een pup.');
    assert.equal((await items(t)).length, 0);
    t.script.push({ text: 'Genoteerd!' });
    const msgs = await t.say(th.id, 'Ja, doe maar');
    const yes = lastUser(msgs);
    const it = (await items(t)).find((i) => i.content === 'Mijn hond heet Bram');
    assert.ok(it, JSON.stringify((await items(t)).map((i) => i.content)));
    assert.equal(it.status, 'active');
    assert.equal(it.scope, 'about_you');
    assert.equal(it.source_ref, yes.id, 'the reply is the source');
    assert.match(it.source_excerpt, /Zal ik onthouden dat je hond Bram heet\? — Ja, doe maar/);
    // The bot hears it in the same turn (and does not store it again).
    assert.match(ctxOf(yes), new RegExp(`De gebruiker zei ja op je voorstel om dit te onthouden\\. Onthouden \\[m:${it.ref}\\]`));
    // The undo line under the owner's reply.
    const map = await t.api('GET', `/memory/thread/${th.id}/learned-map`);
    const line = map.byMessage[yes.id]?.[0];
    assert.equal(line?.id, it.id);
    assert.ok(line.changeId);
    await t.api('POST', `/memory/changes/${line.changeId}/undo`, {});
    assert.equal((await items(t)).find((i) => i.id === it.id)?.status, 'trashed');

    // "ja, klopt" on a fact with a key; English too; two facts in one question.
    t.script.push({ text: 'Zal ik onthouden dat je in Utrecht woont?' }, { text: 'Top.' });
    await t.say(th.id, 'Ik ben net verhuisd.');
    await t.say(th.id, 'ja, klopt');
    const home = (await items(t)).find((i) => i.content === 'Ik woon in Utrecht');
    assert.ok(home);
    assert.equal(home.canonical_key, 'woonplaats');
    t.script.push({ text: 'Shall I remember that you prefer short answers?' }, { text: 'Done.' });
    await t.say(th.id, 'Keep it short.');
    await t.say(th.id, 'yes please');
    assert.ok((await items(t)).some((i) => i.content === 'I prefer short answers'));
    t.script.push({ text: 'Zal ik onthouden dat je op maandag sport en dat je kat Mo heet?' }, { text: 'Oké.' });
    await t.say(th.id, 'Druk weekje.');
    await t.say(th.id, 'Ja graag');
    const all = (await items(t)).map((i) => i.content);
    assert.ok(all.includes('Ik sport op maandag') && all.includes('Mijn kat heet Mo'), JSON.stringify(all));
  } finally {
    await t.close();
  }
});

test('no memory without a concrete proposal right before a plain yes', async () => {
  const { t, a, th } = await setup();
  try {
    const n0 = (await items(t)).length;
    // Yes to something that is not about memory.
    t.script.push({ text: 'Zal ik de offerte naar Jan versturen?' }, { text: 'Verstuurd (niet echt).' });
    await t.say(th.id, 'Maak een offerte voor Jan.');
    await t.say(th.id, 'Ja, doe maar');
    // A proposal, but "yes, but …".
    t.script.push({ text: 'Zal ik onthouden dat je hond Bram heet?' }, { text: 'Oké.' });
    await t.say(th.id, 'We hebben een pup.');
    await t.say(th.id, 'Ja, maar alleen tot de zomer');
    // A proposal two answers back: the yes answers the newest one.
    t.script.push({ text: 'Zal ik onthouden dat je kat Mo heet?' }, { text: 'Het is drie uur.' }, { text: 'Prima.' });
    await t.say(th.id, 'En een kat.');
    await t.say(th.id, 'Hoe laat is het?');
    await t.say(th.id, 'ja');
    assert.equal((await items(t)).length, n0, JSON.stringify((await items(t)).map((i) => i.content)));

    // A vague proposal: nothing stored, and the bot is told to name the fact or store it itself.
    t.script.push({ text: 'Mooi. Zal ik dat voor je onthouden?' }, { text: 'Wat moet ik onthouden?' });
    await t.say(th.id, 'Ik heb een nieuwe fiets.');
    const yes = lastUser(await t.say(th.id, 'Ja'));
    assert.equal((await items(t)).length, n0);
    assert.match(ctxOf(yes), /noemde het feit niet\. Sla het nu op met memory_remember/);

    // Learning off for this bot: nothing, and the bot hears why.
    await t.api('PATCH', `/agents/${a.id}`, { settings: { memory: { learn: 'off' } } });
    t.script.push({ text: 'Zal ik onthouden dat je hond Bram heet?' }, { text: 'Oké.' });
    await t.say(th.id, 'We hebben een pup.');
    const off = lastUser(await t.say(th.id, 'Ja, doe maar'));
    assert.equal((await items(t)).length, n0);
    assert.match(ctxOf(off), /Leren staat uit/);
  } finally {
    await t.close();
  }
});

test('yes to a proposal the bot made with memory_remember approves it (undo goes back to the proposal); a turn that read files stays a proposal', async () => {
  const { t, th } = await setup();
  try {
    t.script.push({ toolCalls: [{ name: 'memory_remember', args: { content: 'Ik ben vegetariër', scope: 'about_you' } }] }, { text: 'Ik heb voorgesteld om te onthouden dat je vegetariër bent. Klopt dat?' });
    await t.say(th.id, 'Ik eet geen vlees.');
    const p = (await items(t)).find((i) => i.content === 'Ik ben vegetariër');
    assert.equal(p?.status, 'proposed');
    t.script.push({ text: 'Fijn, dan houd ik er rekening mee.' });
    const yes = lastUser(await t.say(th.id, 'Ja, klopt'));
    const now = (await items(t)).find((i) => i.id === p.id);
    assert.equal(now.status, 'active');
    assert.equal(now.source_ref, yes.id);
    assert.match(ctxOf(yes), new RegExp(`Opgeslagen \\[m:${p.ref}\\]`));
    const line = (await t.api('GET', `/memory/thread/${th.id}/learned-map`)).byMessage[yes.id]?.[0];
    assert.equal(line?.id, p.id);
    await t.api('POST', `/memory/changes/${line.changeId}/undo`, {});
    assert.equal((await items(t)).find((i) => i.id === p.id)?.status, 'proposed', 'back to the proposal');

    // The bot read a file in that turn (external content): the confirmed fact still goes to Te beoordelen.
    t.script.push({ toolCalls: [{ name: 'read_file', args: { path: 'notities.txt' } }] }, { text: 'Zal ik onthouden dat je hond Bram heet?' }, { text: 'Oké.' });
    await t.say(th.id, 'Lees mijn notities eens.');
    await t.say(th.id, 'Ja, doe maar');
    const dog = (await items(t)).find((i) => i.content === 'Mijn hond heet Bram');
    assert.equal(dog?.status, 'proposed');
    assert.equal(dog.proposal_reason, 'tainted');
  } finally {
    await t.close();
  }
});
