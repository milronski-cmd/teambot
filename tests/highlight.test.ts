import { test } from 'node:test';
import assert from 'node:assert/strict';
import { highlightHtml, langForFile, loadHighlighter, normalizeLang } from '../ui/src/lib/highlight.js';

// A-35: code blocks and code files get syntax colours (highlight.js, lazy); plain text and huge input stay plain.
test('languages from fence tags and file names', () => {
  assert.equal(normalizeLang('ts'), 'typescript');
  assert.equal(normalizeLang('PS1'), 'powershell');
  assert.equal(normalizeLang('language-py'), 'python');
  assert.equal(langForFile('scripts/opruimen.py'), 'python');
  assert.equal(langForFile('C:\\werk\\build.ps1'), 'powershell');
  assert.equal(langForFile('index.html'), 'xml');
  assert.equal(langForFile('Dockerfile'), 'dockerfile');
  assert.equal(langForFile('notities.txt'), null);
  assert.equal(langForFile('data.csv'), null);
});

test('highlighted output is escaped markup with token classes only', async () => {
  const h = await loadHighlighter();
  const html = highlightHtml(h, 'def groet(naam):\n    return f"Hoi {naam}"  # zeg hallo\n', 'python')!;
  assert.match(html, /<span class="hljs-keyword">def<\/span>/);
  assert.match(html, /hljs-string/);
  assert.match(html, /hljs-comment/);
  const evil = highlightHtml(h, 'const x = "<script>alert(1)</script>"; // <img src=x onerror=alert(1)>', 'js')!;
  assert.doesNotMatch(evil, /<script|<img/i, 'input is escaped');
  assert.match(evil, /&lt;script&gt;/);
  for (const tag of evil.match(/<[^>]+>/g) || []) assert.match(tag, /^<(span class="hljs-[\w ._-]+"|\/span)>$/, `only span tags: ${tag}`);
  // PowerShell and Dockerfile are registered on top of the common set.
  assert.match(highlightHtml(h, 'Get-ChildItem -Path C:\\ | Where-Object { $_.Length -gt 1 }', 'powershell')!, /hljs-built_in|hljs-variable/);
});

test('untagged blocks are detected; plain text, unknown or huge input stays plain', async () => {
  const h = await loadHighlighter();
  assert.ok(highlightHtml(h, 'import os\n\ndef main():\n    for f in os.listdir("."):\n        print(f)\n', undefined, { auto: true }));
  assert.equal(highlightHtml(h, 'Boodschappen: melk, brood en kaas.', undefined, { auto: true }), null);
  assert.equal(highlightHtml(h, 'Stap 1: open de map\nStap 2: klik op opslaan', undefined, { auto: true }), null);
  assert.match(highlightHtml(h, '{"a": 1, "b": [true, null]}', undefined, { auto: true })!, /hljs-attr/);
  assert.equal(highlightHtml(h, 'gewone tekst', 'text', { auto: true }), null);
  assert.equal(highlightHtml(h, 'x = 1', undefined), null, 'no auto-detect unless asked');
  assert.equal(highlightHtml(h, 'a'.repeat(250_000), 'js'), null, 'huge input stays plain');
});
