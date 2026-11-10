import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diffStats, lineDiff, wordDiff } from '../ui/src/shell/textDiff.js';

test('wordDiff marks only the changed words and keeps the text intact', () => {
  const p = wordDiff('Antwoord kort en vriendelijk.', 'Antwoord heel kort en zakelijk.');
  assert.equal(p.filter((x) => x.kind !== 'ins').map((x) => x.text).join(''), 'Antwoord kort en vriendelijk.');
  assert.equal(p.filter((x) => x.kind !== 'del').map((x) => x.text).join(''), 'Antwoord heel kort en zakelijk.');
  assert.ok(p.some((x) => x.kind === 'del' && x.text.includes('vriendelijk')));
  assert.ok(p.some((x) => x.kind === 'ins' && x.text.includes('zakelijk')));
  assert.ok(p.some((x) => x.kind === 'same' && x.text.includes('kort en')));
});

test('lineDiff: an edited line becomes word pieces, added/removed lines stay whole, long unchanged runs fold', () => {
  const before = ['# Regels', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'Schrijf in het Nederlands.', 'oud slot'].join('\n');
  const after = ['# Regels', 'een', 'twee', 'drie', 'vier', 'vijf', 'zes', 'Schrijf altijd in het Nederlands.', 'nieuwe regel'].join('\n');
  const d = lineDiff(before, after, 2);
  const skip = d.find((l) => l.kind === 'skip');
  assert.ok(skip && skip.kind === 'skip' && skip.count === 5, 'the first 5 unchanged lines are folded (2 kept as context)');
  const changes = d.filter((l) => l.kind === 'change');
  assert.equal(changes.length, 2);
  const first = changes[0];
  assert.ok(first.kind === 'change' && first.pieces.some((p) => p.kind === 'ins' && p.text.includes('altijd')));
  const stats = diffStats(d);
  assert.ok(stats.added >= 2 && stats.removed >= 1);
  // Identical texts: no changes at all.
  assert.ok(lineDiff('a\nb', 'a\nb').every((l) => l.kind === 'same'));
  // Empty before (a field that was blank): everything is added.
  assert.ok(lineDiff('', 'nieuw\ntekst').some((l) => l.kind === 'ins' || l.kind === 'change'));
  // Lines added in the middle stay whole lines, not word soup.
  const mid = lineDiff('a\nb\nc', 'a\nb\nnieuw\nc');
  assert.deepEqual(mid.filter((l) => l.kind !== 'same'), [{ kind: 'ins', text: 'nieuw' }]);
});
