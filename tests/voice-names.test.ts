import { test } from 'node:test';
import assert from 'node:assert/strict';
import { addressed, confirmAnswer, matchSpokenName, nameScore, phoneticKey } from '../ui/src/modules/voice/names.js';

/** B-53: in a group call a bot is found also when speech-to-text gets its name slightly wrong; unsure → ask first. */

const BOTS = ['Assistent', 'Onderzoeker', 'Juf Ans', 'Bram', 'Bo'];

test('exact names, greetings and "iedereen"', () => {
  assert.deepEqual(matchSpokenName('Onderzoeker, hoe laat is het in Berlijn?', BOTS), { kind: 'exact', name: 'Onderzoeker', heard: 'Onderzoeker', rest: 'hoe laat is het in Berlijn?' });
  assert.equal((matchSpokenName('Hé Onderzoeker. Wat denk jij?', BOTS) as any).name, 'Onderzoeker');
  assert.equal((matchSpokenName('hoi juf ans, lees voor', BOTS) as any).name, 'Juf Ans');
  assert.deepEqual(matchSpokenName('Iedereen: wat vinden jullie?', BOTS), { kind: 'everyone', rest: 'wat vinden jullie?' });
  assert.equal(matchSpokenName('Wat is het weer morgen?', BOTS).kind, 'none');
  // A name inside a longer word is not a name ("Brammetje" is not "Bram").
  assert.equal(matchSpokenName('Brammetje heeft honger', ['Bram']).kind, 'none');
});

test('close matches from speech-to-text are understood (the report: "Onderzoeken" for Onderzoeker)', () => {
  const m = matchSpokenName('Onderzoeken, hoe laat is het in Berlijn?', BOTS);
  assert.equal(m.kind, 'close');
  assert.equal((m as any).name, 'Onderzoeker');
  assert.equal((m as any).heard, 'Onderzoeken');
  assert.equal(m.rest, 'hoe laat is het in Berlijn?');
  for (const heard of ['Assistant', 'Asistent', 'Assistente', 'Onderzoekster', 'Onder zoeker']) {
    const r = matchSpokenName(`${heard}, zet een herinnering`, BOTS);
    assert.ok(r.kind === 'close' || r.kind === 'unsure', `${heard} → ${r.kind}`);
    if (r.kind === 'close') assert.ok(['Assistent', 'Onderzoeker'].includes(r.name), heard);
    if (r.kind === 'unsure') assert.ok(r.candidates.some((c) => ['Assistent', 'Onderzoeker'].includes(c)), heard);
  }
  assert.equal((matchSpokenName('Juf Anz, lees voor', BOTS) as any).name, 'Juf Ans');
  // Short names stay exact only: "Bob" is not "Bo", "Brom" is not sure enough for "Bram".
  assert.equal(matchSpokenName('Bob, kom eens', BOTS).kind, 'none');
  const brom = matchSpokenName('Brom, kom eens', BOTS);
  assert.ok(brom.kind === 'unsure' || brom.kind === 'none');
  assert.equal(nameScore('Onderzoeken', 'Onderzoeker'), 2);
  assert.equal(phoneticKey('Assistent'), phoneticKey('Asistend'));
  assert.equal(nameScore('Onderzoek', 'Onderzoeker'), 1, 'a real word that resembles a name: ask, do not assume');
});

test('unsure or two lookalike bots → ask "Bedoel je …?", and understand the answer', () => {
  const unsure = matchSpokenName('Onderzoek dit eens', BOTS);
  assert.equal(unsure.kind, 'unsure');
  assert.deepEqual((unsure as any).candidates, ['Onderzoeker']);
  const twins = matchSpokenName('Annet, wat vind jij?', ['Anne', 'Annette']);
  assert.equal(twins.kind, 'unsure');
  assert.deepEqual(new Set((twins as any).candidates), new Set(['Anne', 'Annette']));
  assert.deepEqual(confirmAnswer('Ja.', ['Onderzoeker']), { kind: 'yes' });
  assert.deepEqual(confirmAnswer('ja klopt', ['Onderzoeker']), { kind: 'yes' });
  assert.deepEqual(confirmAnswer('Nee', ['Onderzoeker']), { kind: 'no' });
  assert.deepEqual(confirmAnswer('Annette', ['Anne', 'Annette']), { kind: 'name', name: 'Annette' });
  assert.equal(confirmAnswer('wat is het weer', ['Anne']), null);
  assert.equal(addressed('Onderzoeker', 'hoe laat is het?', 'x'), '@Onderzoeker hoe laat is het?');
  assert.equal(addressed('Juf Ans', 'lees voor', 'x'), '@"Juf Ans" lees voor');
  assert.equal(addressed(null, 'x', 'Onderzoek dit eens'), 'Onderzoek dit eens');
  assert.equal(addressed('iedereen', 'kom', 'x'), '@iedereen kom');
});
