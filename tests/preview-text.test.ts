import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewText } from '../shared/preview.js';

test('chat list preview: plain text, no markdown symbols or memory codes', () => {
  assert.equal(previewText('Je webshop heet **Velomax** en zit in **Arnhem** [m:2tdmcj].'), 'Je webshop heet Velomax en zit in Arnhem.');
  assert.equal(previewText('**Smeren? Over mijn lijk.**\n\nOf een paar andere opties:\n- *Kees trapt er niet in*'), 'Smeren? Over mijn lijk. Of een paar andere opties: Kees trapt er niet in');
  assert.equal(previewText('## Werkwijze\n1. Lees `notities.md` en [de site](https://x.nl)'), 'Werkwijze Lees notities.md en de site');
  assert.equal(previewText('5 * 3 = 15 en snake_case_naam blijft'), '5 * 3 = 15 en snake_case_naam blijft');
  assert.equal(previewText(null), '');
});

test('chat list preview: a code block, also one cut off by the preview length, never shows as raw markdown', () => {
  // Found live (A-35): the sidebar read "```mermaid flowchart TD A[Water ko…".
  assert.equal(previewText('```mermaid\nflowchart TD\n  A[Water ko'), 'Diagram');
  assert.equal(previewText('```mermaid\ngraph TD\n A-->B\n```'), 'Diagram');
  assert.equal(previewText('```python\nprint(1)\n```'), 'Codeblok');
  assert.equal(previewText('Hier is het plan:\n```mermaid\ngraph TD\n A-->B'), 'Hier is het plan:');
});
