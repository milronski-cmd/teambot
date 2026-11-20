/** A full dossier of knowledge is split by sub-subject, never cut; the bot's own notes stay short on purpose. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { growAdvice } from '../server/modules/memory/living.js';

test('knowledge grows: a subject dossier is split, working notes are rewritten shorter', () => {
  assert.match(growAdvice({ core: null }), /^splits het: zet een deelonderwerp in een eigen dossier .* wat je weet kort je niet in$/);
  assert.match(growAdvice({ core: 'notes' }), /^herschrijf het korter/);
});
