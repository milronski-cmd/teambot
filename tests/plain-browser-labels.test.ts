import { test } from 'node:test';
import assert from 'node:assert/strict';
import { argsPreview, resultForDisplay } from '../shared/toolLabels.js';
import { describeElement as uiDescribe } from '../ui/src/modules/browser/describe.js';
import { browserTools, describeElement } from '../server/modules/browser/tools.js';

/** Q-03: no page references such as "e10", no raw data tags such as <skill naam=…> where people read. */

test('browser approval cards and steps never show a page reference like e10', () => {
  const tools = browserTools({} as any);
  const sum = (name: string, args: any) => tools.find((t) => t.name === name)!.summarize!(args);
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

  for (const f of [describeElement, uiDescribe]) {
    assert.equal(f({ tag: 'a', name: 'Bekijk de foto' }), 'link “Bekijk de foto”');
    assert.equal(f({ tag: 'button', name: 'Bestellen' }), 'knop “Bestellen”');
    assert.equal(f({ tag: 'input', type: 'email', name: 'E-mail' }), 'veld “E-mail”');
    assert.equal(f({ tag: 'input', type: 'file', name: '' }), 'een bestandsveld');
  }
  // The step chip next to "Gebruikte de browser" shows the bot's words, never the ref.
  assert.equal(argsPreview({ ref: 'e10' }), '');
  assert.equal(argsPreview({ ref: 'e10', element: 'knop Bestellen' }), 'knop Bestellen');
  assert.equal(argsPreview({ ref: 'e3', text: 'Amsterdam' }), 'Amsterdam');
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
