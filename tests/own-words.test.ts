/**
 * What a user or a bot wrote is never translated, not even in part, and TeamBot's own words are shown in the reader's
 * language (new-user check in English, 12 nov):
 * - a chat title "Elke werkdag om 9:00 zoek je…" showed as "Every werkdag at 9:00 zoek je…", a role "Onderzoeker"
 *   as "Researcher": the page translator also ran over the user's words;
 * - "Gesprek “…” nalezen voor het geheugen" in "Wat start vanzelf", the hand-off result note and "Gestopt door de
 *   eigenaar…" were stored as finished Dutch sentences;
 * - the owner read what was meant for the bot ("Neem dit niet over als klaar…", "Opnieuw geven kan met delegate_task")
 *   and the colleague's answer as raw **markdown** in a grey oval.
 * TeamBot's words with someone's words in them are now a Dutch template plus values (shared/i18n-core.ts Words,
 * ownPieces): the screen shows the template translated and the values as written. A note keeps its text for the bot
 * and has a line for the owner (`parts.note`) and the colleague's own answer (`parts.said`).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Translator, fillSource, ownPieces, type Piece } from '../shared/i18n-core.js';
import { startTestApp } from './helpers.js';
import { msgs, settle, team, until } from './team-mock.js';

process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

const en = new Translator(JSON.parse(fs.readFileSync(path.join('ui', 'src', 'i18n', 'en.json'), 'utf8')), 'en-GB');
const english = (tpl: string, ...values: (string | number)[]) => ownPieces(tpl, values, (x, v) => en.format(x, v));
const dutch = (tpl: string, ...values: (string | number)[]) => ownPieces(tpl, values, (x, v) => fillSource(x, v));
const own = (p: Piece[]) => p.filter((x): x is { own: string } => typeof x !== 'string').map((x) => x.own);
const text = (p: Piece[]) => p.map((x) => (typeof x === 'string' ? x : x.own)).join('');
/** Everything a note shows the owner: its line, the colleague's answer, what the second look said. */
const shown = (parts: any) => JSON.stringify({ note: parts.note, said: parts.said, check: parts.check, reason: parts.reason, answers: parts.answers });

const TITLE = 'Elke werkdag om 9:00 zoek je nieuwe berichten op';

test('a template with someone’s own words: the template in the reader’s language, the words exactly as written', () => {
  // The page translator's way: the filled sentence as a whole, the title in it half translated.
  assert.notEqual(en.translate(`Gesprek “${TITLE}” nalezen voor het geheugen`), `Reviewing chat “${TITLE}” for memory`);
  assert.match(en.translate(TITLE), /^Every /, 'the title alone fits a pattern of the dictionary');
  // Pieces: TeamBot's words translated, the title untouched.
  const p = english('Gesprek “{0}” nalezen voor het geheugen', TITLE);
  assert.deepEqual(p, ['Reviewing chat “', { own: TITLE }, '” for memory']);
  // A bot named after a word of the dictionary keeps its name.
  assert.equal(en.translate('Onderzoeker'), 'Researcher');
  assert.deepEqual(english('Resultaat van {0}', 'Onderzoeker'), ['Result from ', { own: 'Onderzoeker' }]);
  // A number is nobody's words: it stays in the sentence.
  assert.deepEqual(english('Gesprekken met {0} ({1})', 'Pen', 3), ['Chats with ', { own: 'Pen' }, ' (3)']);
  // In Dutch, and for a template the dictionary does not have yet: the Dutch sentence, the words still apart.
  assert.equal(text(dutch('Gesprek “{0}” nalezen voor het geheugen', TITLE)), `Gesprek “${TITLE}” nalezen voor het geheugen`);
  const unknown = english('Nog niet vertaald: {0} en {1}.', TITLE, 'Onderzoeker');
  assert.deepEqual(own(unknown), [TITLE, 'Onderzoeker']);
  assert.ok(!text(unknown).includes('Every'), text(unknown));
});

test('the hand-off result note: the bot reads what to do, the owner gets one plain line and the colleague’s answer as written', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const bo = await m.bot('Bo');
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Zoek de nieuwe berichten op.', expected_output: 'een lijst' } }] }, { text: 'Doorgegeven.' }, { text: 'Bo is klaar.' });
    m.script('Bo', { text: '**Klaar**: de lijst staat in `lijst.md`.' }, { text: 'Gedaan.' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Bo de berichten opzoeken.' });
    const note = await until(() => msgs(t, th.id).find((x: any) => x.role === 'system' && x.parts.kind === 'delegation_result'));
    await settle(t);
    // The bot's text is unchanged: what came back and what it should do with it.
    assert.match(note.content, /^Resultaat van de gedelegeerde taak van Bo \((?:klaar|te controleren)\):\n\n\*\*Klaar\*\*: de lijst staat in `lijst\.md`\./);
    // The owner: TeamBot's words as a template with the name, and Bo's own words.
    assert.deepEqual(note.parts.note, { text: 'Resultaat van {0}', values: ['Bo'] });
    assert.equal(note.parts.said, '**Klaar**: de lijst staat in `lijst.md`.');
    assert.equal(note.parts.from, bo.id);
    // The second look (quality module) on the fake engine: whatever it said, the owner reads it as a state.
    if (/TE CONTROLEREN/.test(note.content)) {
      assert.match(note.content, /Neem dit niet over als klaar/, 'the bot is told not to take it as done');
      assert.equal(note.parts.check?.state, 'review', 'the owner sees that a second look is needed');
    }
    assert.doesNotMatch(shown(note.parts), /Neem dit niet over|delegate_task|task_update|\bje gaf\b/, 'nothing meant for the bot');
  } finally {
    await t.close();
  }
});

test('work the owner stopped: the bot reads how to give it again, the owner reads what was stopped, without tool names', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    await m.bot('Bo');
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    m.script('Ada', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bo', task: 'Zoek uit waarom het formulier niet werkt.', expected_output: 'de oorzaak' } }] }, { text: 'Doorgegeven.' });
    m.script('Bo', { text: 'nooit', delayMs: 30_000 });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Laat Bo het formulier uitzoeken.' });
    await until(() => t.app.ctx.store.all<any>("SELECT r.id FROM runs r JOIN agents a ON a.id = r.agent_id WHERE a.name = 'Bo' AND r.status = 'running'").length > 0);
    await t.api('POST', '/stop-all', {});
    const note = await until(() => msgs(t, th.id).find((x: any) => x.role === 'system' && x.parts.kind === 'delegation_cancelled'));
    assert.match(note.content, /^Gestopt door de eigenaar: het werk dat je aan Bo gaf .*Opnieuw geven kan met delegate_task\.$/s);
    assert.deepEqual(note.parts.note, { text: 'Gestopt: het werk dat {0} aan {1} gaf (“{2}”). Het is niet af.', values: ['Ada', 'Bo', 'Zoek uit waarom het formulier niet werkt.'] });
    assert.doesNotMatch(shown(note.parts), /delegate_task|eigenaar|\bje\b/);
    // The conversation list shows the owner's line as the last message, not the bot's text.
    await settle(t);
    assert.equal(msgs(t, th.id).at(-1)!.id, note.id);
    const list = await t.api('GET', '/threads');
    assert.deepEqual((Array.isArray(list) ? list : list.threads).find((x: any) => x.id === th.id)?.last?.note, note.parts.note);
    // "Hervatten": the bot reads what to do, the owner reads that it goes on.
    await t.api('POST', `/threads/${th.id}/resume`, {});
    const resumed = await until(() => msgs(t, th.id).find((x: any) => x.role === 'system' && x.parts.note && /Ga verder waar je gebleven was/.test(x.content)));
    assert.deepEqual(resumed.parts.note, { text: '{0} gaat verder waar hij gebleven was.', values: ['Ada'] });
    await settle(t);
  } finally {
    await t.close();
  }
});

test('"Wat start vanzelf": a row with a chat title or a task title carries TeamBot’s words and the title apart', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const userId = ctx.auth.owner()!.id;
    const bot = await t.agent({ name: 'Bo' });
    await t.api('PUT', '/memory/settings', { extractor: 'model' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    t.script.push({ text: 'Goed.' });
    await t.say(th.id, 'Ik werk deze maand aan een nieuwe website.');
    await t.api('PATCH', `/threads/${th.id}`, { title: TITLE });
    const at = new Date(Date.now() + 3_600_000).toISOString();
    ctx.store.exec("INSERT INTO quality_tasks (id, user_id, kind, ref, title, reported_by, reported_at, check_state, open, recheck_at, created_at, updated_at) VALUES ('q1', ?, 'room', 't1', 'Elke werkdag de sitemap nalopen', ?, ?, 'review', 1, ?, ?, ?)", userId, bot.id, at, at, at, at);
    const planned: any[] = (await t.api('GET', '/routines/planned')).planned;
    const review = planned.find((p) => p.id === `review:${th.id}`);
    assert.ok(review, JSON.stringify(planned.map((p) => p.id)));
    assert.deepEqual(review.words, { text: 'Gesprek “{0}” nalezen voor het geheugen', values: [TITLE.slice(0, 39) + '…'] });
    assert.equal(text(english(review.words.text, ...review.words.values)), `Reviewing chat “${review.words.values[0]}” for memory`);
    const recheck = planned.find((p) => p.kind === 'recheck');
    assert.deepEqual(recheck?.words, { text: 'Tweede controle: {0}', values: ['Elke werkdag de sitemap nalopen'] });
    assert.equal(text(english(recheck.words.text, ...recheck.words.values)), 'Second check: Elke werkdag de sitemap nalopen');
  } finally {
    await t.close();
  }
});
