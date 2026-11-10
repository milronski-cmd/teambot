import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hasMath, prepareMath } from '../ui/src/shell/math-text.js';

test('formulas in chat: which answers load KaTeX', () => {
  assert.ok(hasMath('De formule $E = mc^2$ zegt het.'));
  assert.ok(hasMath('$$\n\\int_0^1 x\\,dx = \\tfrac12\n$$'));
  assert.ok(hasMath('Zo: \\[ a^2 + b^2 = c^2 \\]'));
  assert.ok(hasMath('inline \\(x_1\\) ook'));
  assert.ok(!hasMath('Het kost $5 tot $10 per maand.'), 'amounts are no formula');
  assert.ok(!hasMath('Gewone tekst zonder formule.'));
  assert.ok(!hasMath('In code: `echo $HOME en $PATH`'), 'inline code is skipped');
  assert.ok(!hasMath('```sh\nexport A=$B$C\n```'), 'code blocks are skipped');
});

test('formulas in chat: \\(…\\) and \\[…\\] become dollars, amounts stay dollar signs, code is untouched', () => {
  assert.equal(prepareMath('a \\(x^2\\) b'), 'a $x^2$ b');
  assert.equal(prepareMath('\\[ x = 1 \\]'), '\n$$\nx = 1\n$$\n');
  assert.equal(prepareMath('kost $5 of $ 10, en $x$'), 'kost \\$5 of \\$ 10, en $x$');
  assert.equal(prepareMath('\\(5x\\)'), '$5x$', 'a formula that starts with a digit stays a formula');
  assert.equal(prepareMath('$$2x$$'), '$$2x$$');
  assert.equal(prepareMath('`\\(x\\) $5`'), '`\\(x\\) $5`');
  assert.equal(prepareMath('```\n\\[x\\] $5\n```\nen \\(y\\)'), '```\n\\[x\\] $5\n```\nen $y$');
});
