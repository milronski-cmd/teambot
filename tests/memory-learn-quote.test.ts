/**
 * 0.4.4: the learner's quote check is paraphrase-tolerant but never accepts words the owner did not write. A literal
 * quote passes; a quote with one word in seven changed passes and the owner's own sentence is what is stored; a quote
 * from the bot, from a quoted mail, or made up does not.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { findEvidence } from '../server/modules/memory/learn.js';

const MSG = 'Trouwens, mijn hond Bram is een labrador van zeven jaar. Kun je dit mailtje korter maken?\n> Beste Sanne, uw factuur van 300 euro staat nog open.';

test('quote check: literal, slightly changed (owner sentence stored), across two sentences; never the bot, a quote or invented words', () => {
  assert.equal(findEvidence('mijn hond Bram is een labrador', MSG), 'mijn hond Bram is een labrador');
  assert.equal(findEvidence('MIJN HOND BRAM, is een labrador!', MSG), 'MIJN HOND BRAM, is een labrador!', 'case and punctuation do not matter');
  assert.equal(findEvidence('je hond Bram is een labrador van zeven jaar', MSG), 'Trouwens, mijn hond Bram is een labrador van zeven jaar.', 'one word changed: the owner sentence is the source');
  assert.equal(findEvidence('hond Bram is een labrador. Kun je dit mailtje korter maken', MSG) !== null, true, 'two adjacent sentences');
  assert.equal(findEvidence('uw factuur van 300 euro staat nog open', MSG), null, 'a quoted mail is not the owner speaking');
  assert.equal(findEvidence('mijn kat Mies is een Pers van drie jaar', MSG), null, 'made up');
  assert.equal(findEvidence('mijn hond Bram heeft epilepsie en slikt medicijnen', MSG), null, 'real start, invented end');
  assert.equal(findEvidence('Bram', MSG), null, 'too short to prove anything');
});
