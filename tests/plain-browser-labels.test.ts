import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argsPreview, describeElement, resultForDisplay } from '../shared/toolLabels.js';
import { browserTools } from '../server/modules/browser/tools.js';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Translator, fillSource } from '../shared/i18n-core.js';
import { bindLocale } from '../shared/format.js';
import { fillWords } from '../shared/i18n-core.js';

/** Q-03: no page references such as "e10", no raw data tags such as <skill naam=…> where people read. */

test('browser approval cards and steps never show a page reference like e10', () => {
  const tools = browserTools({} as any);
  const sum = (name: string, args: any) => fillWords(tools.find((t) => t.name === name)!.summarize!(args));
  const cases: [string, any][] = [
    ['browser_click', { ref: 'e10' }],
    ['browser_type', { ref: 'e3', text: 'hallo' }],
    ['browser_select', { ref: 'e7', values: ['2'] }],
    ['browser_press', { ref: 'e4', key: 'Enter' }],
    ['browser_scroll', { ref: 'e9' }],
    ['browser_download', { ref: 'e10' }],
    ['browser_upload', { ref: 'e3', path: 'cv.pdf' }],
    ['browser_submit', { ref: 'e12', description: 'bestelling plaatsen' }],
  ];
  for (const [name, args] of cases) assert.doesNotMatch(sum(name, args), /\be\d+\b/, name);
  assert.equal(sum('browser_download', { ref: 'e10' }), 'Downloaden: een link op de pagina');
  assert.equal(sum('browser_download', { ref: 'e10', element: 'link Factuur.pdf' }), 'Downloaden: “link Factuur.pdf”');
  assert.equal(sum('browser_upload', { ref: 'e3', path: 'cv.pdf' }), 'BESTAND UPLOADEN: cv.pdf naar een bestandsveld op de pagina');
  assert.equal(sum('browser_click', { ref: 'e5', element: 'knop Volgende' }), 'Klikken op “knop Volgende”');
  assert.equal(sum('browser_download', { url: 'https://x.test/a.png' }), 'Downloaden: https://x.test/a.png');

  // One describeElement (shared/toolLabels.ts) for the server's step log and the browser card on the page.
  assert.equal(describeElement({ tag: 'a', name: 'Bekijk de foto' }), 'de link “Bekijk de foto”');
  assert.equal(describeElement({ tag: 'button', name: 'Bestellen' }), 'de knop “Bestellen”');
  assert.equal(describeElement({ tag: 'input', type: 'email', name: 'E-mail' }), 'het veld “E-mail”');
  assert.equal(describeElement({ tag: 'input', type: 'file', name: '' }), 'een bestandsveld');
  assert.equal(describeElement({ tag: 'div', name: '' }), '');
  assert.equal(describeElement(null, 'een element op de pagina'), 'een element op de pagina');
  // The step chip next to "Gebruikte de browser" shows the bot's words, never the ref.
  assert.equal(argsPreview({ ref: 'e10' }), '');
  assert.equal(argsPreview({ ref: 'e10', element: 'knop Bestellen' }), 'knop Bestellen');
  assert.equal(argsPreview({ ref: 'e3', text: 'Amsterdam' }), 'Amsterdam');
});

test('browser approval cards and steps are whole sentences: never a Dutch "knop", "veld" or "omhoog" as a value', async () => {
  const tools = browserTools({} as any);
  const sum = (name: string, args: any) => fillWords(tools.find((t) => t.name === name)!.summarize!(args));
  // Without the bot's own words for the element: one whole sentence per form.
  assert.equal(sum('browser_click', { ref: 'e5' }), 'Klikken op een element op de pagina');
  assert.equal(sum('browser_type', { ref: 'e3', text: 'hallo' }), 'Typen in een veld: "hallo"');
  assert.equal(sum('browser_type', { ref: 'e3', text: 'hallo', element: 'zoekveld' }), 'Typen in “zoekveld”: "hallo"');
  assert.equal(sum('browser_select', { ref: 'e7', values: ['2'] }), 'Kiezen in een keuzelijst: 2');
  assert.equal(sum('browser_press', { key: 'Enter' }), 'Toets Enter');
  assert.equal(sum('browser_press', { ref: 'e4', key: 'Enter' }), 'Toets Enter in een veld');
  assert.equal(sum('browser_scroll', { direction: 'up' }), 'Scrollen omhoog');
  assert.equal(sum('browser_scroll', { ref: 'e9' }), 'Scrollen naar een element op de pagina');
  const src = fs.readFileSync(path.join(process.cwd(), 'server/modules/browser/tools.ts'), 'utf8');
  assert.doesNotMatch(src, /named\(a, '|\$\{a\.direction === 'up' \? 'omhoog' : 'omlaag'\}|`\$\{kind[^`]*“/);
  // The kind of element is part of a phrase the dictionary has, so another language reads it whole.
  const tr = new Translator({ 'de knop “{0}”': 'die Schaltfläche „{0}“', 'een veld': 'ein Feld', 'Klik op {0}': 'Klicke auf {0}' }, 'de-DE');
  bindLocale(() => 'de-DE', (s, ...v) => tr.format(s, v));
  try {
    assert.equal(describeElement({ tag: 'button', name: 'Bestellen' }), 'die Schaltfläche „Bestellen“');
    assert.equal(describeElement({ tag: 'input', name: '' }), 'ein Feld');
  } finally {
    bindLocale(() => 'nl-NL', (s, ...v) => (v.length ? fillSource(s, v) : s));
  }
  // A step the server stored in Dutch reads in German, the element too.
  assert.equal(tr.translate('Klik op de knop “Bestellen”'), 'Klicke auf die Schaltfläche „Bestellen“');
  // The translation extractor sees every form, so the translator can give each its own sentence.
  const { extractStrings } = await import(pathToFileURL(path.join(process.cwd(), 'scripts', 'i18n-extract.mjs')).href);
  const seen = extractStrings(process.cwd()).strings as Map<string, unknown>;
  const forms = ['Klikken op “{0}”', 'Klikken op een element op de pagina', 'Typen in een veld: "{0}"', 'Toets {0} in een veld', 'Scrollen omhoog', 'Downloaden: een link op de pagina', 'BESTAND UPLOADEN: {0} naar een bestandsveld op de pagina', 'Klik op een element op de pagina', 'Typen in een veld ({0} tekens)', 'Keuze in {0}', 'Scroll naar {0}', 'Download een link op de pagina', 'de knop “{0}”', 'een knop', 'het veld “{0}”', 'de link “{0}”'];
  assert.deepEqual(forms.filter((f) => !seen.has(f)), []);
});

test('tool results in the step details: data tags become a plain heading', () => {
  const skill = '<skill naam="brand-guidelines" versie="r2" bron="anthropics/skills" geverifieerd="nee">\nLet op: …\n\nGebruik #d97757.\n</skill>\n\nBijbehorende bestanden:';
  const out = resultForDisplay(skill);
  assert.doesNotMatch(out, /<\/?skill/);
  assert.match(out, /^Skill “brand-guidelines”, versie r2, bron: anthropics\/skills \(niet geverifieerd\)\n/);
  assert.match(out, /Gebruik #d97757\.\n\nBijbehorende bestanden:/);
  assert.equal(resultForDisplay('<webinhoud bron="https://x.test/">\n# Kop\n</webinhoud>'), 'Inhoud van https://x.test/:\n# Kop');
  assert.equal(resultForDisplay('<serveruitvoer bron="vps" code="0">\nok\n</serveruitvoer>'), 'Uitvoer van vps:\nok');
  assert.equal(resultForDisplay('gewone tekst met <b>html</b>'), 'gewone tekst met <b>html</b>');
});
