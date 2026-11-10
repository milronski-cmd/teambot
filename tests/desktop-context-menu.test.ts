import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MAX_SUGGESTIONS, contextMenuEntries, type MenuEntry } from '../desktop/context-menu.js';

/** Parity 0.4.2: the right-click menu of the desktop window (OpenBot has spelling suggestions; Electron shows nothing). */

const labels = (m: MenuEntry[]) => m.map((e) => (e.kind === 'separator' ? '—' : `${e.label}${e.enabled ? '' : ' (uit)'}`));

test('a misspelled word in the composer: suggestions, add to dictionary, then cut/copy/paste/select all', () => {
  const m = contextMenuEntries({ isEditable: true, misspelledWord: 'bijlaag', dictionarySuggestions: ['bijlage', 'bijlagen', 'bijlaag'], selectionText: '', editFlags: { canCut: true, canCopy: true, canPaste: true, canSelectAll: true } });
  assert.deepEqual(labels(m), ['bijlage', 'bijlagen', 'Toevoegen aan woordenboek', '—', 'Knippen (uit)', 'Kopiëren (uit)', 'Plakken', '—', 'Alles selecteren']);
  const first = m[0];
  assert.ok(first.kind === 'item' && first.action === 'replace' && first.word === 'bijlage');
  const learn = m.find((e) => e.kind === 'item' && e.action === 'learn');
  assert.ok(learn && learn.kind === 'item' && learn.word === 'bijlaag');
});

test('no suggestions: a disabled line says so; never more than five suggestions', () => {
  assert.deepEqual(labels(contextMenuEntries({ isEditable: true, misspelledWord: 'xqzv', dictionarySuggestions: [] })).slice(0, 2), ['Geen suggesties (uit)', 'Toevoegen aan woordenboek']);
  const many = contextMenuEntries({ isEditable: true, misspelledWord: 'teh', dictionarySuggestions: ['a', 'b', 'c', 'd', 'e', 'f', 'g'] });
  assert.equal(many.filter((e) => e.kind === 'item' && e.action === 'replace').length, MAX_SUGGESTIONS);
});

test('selected text outside a text box: only Kopiëren; a link adds Link kopiëren; nothing selected = no menu', () => {
  assert.deepEqual(labels(contextMenuEntries({ selectionText: 'Hallo', editFlags: { canCopy: true } })), ['Kopiëren']);
  assert.deepEqual(labels(contextMenuEntries({ selectionText: '', linkURL: 'https://example.com' })), ['Link kopiëren']);
  assert.deepEqual(labels(contextMenuEntries({ selectionText: '', linkURL: 'javascript:alert(1)' })), []);
  assert.deepEqual(contextMenuEntries({}), []);
});

test('labels go through the language function', () => {
  const en: Record<string, string> = { Knippen: 'Cut', Kopiëren: 'Copy', Plakken: 'Paste', 'Alles selecteren': 'Select all' };
  assert.deepEqual(labels(contextMenuEntries({ isEditable: true, selectionText: 'x' }, (t) => en[t] || t)), ['Cut', 'Copy', 'Paste', '—', 'Select all']);
});
