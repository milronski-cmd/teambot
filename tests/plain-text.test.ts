import { test } from 'node:test';
import assert from 'node:assert/strict';
import { previewText, stepDetail, stripRefs } from '../shared/preview.js';
import { stripRefs as serverStripRefs } from '../server/core/plain.js';
import { showValue } from '../ui/src/lib/historyText.js';

/** Plain Dutch outside the chat bubble: no memory codes ([m:…]), no request ids (dlg_…), no "instellingen toen {}". */

test('no memory codes or request ids outside the chat bubble; bot history in plain Dutch', () => {
  for (const f of [stripRefs, serverStripRefs]) {
    assert.equal(f('Bijgewerkt: nieuwe versie [m:2tdmcj] vervangt [m:zuixv7] (ongedaan maken kan).'), 'Bijgewerkt: nieuwe versie vervangt (ongedaan maken kan).');
    assert.equal(f('Velomax zit in Arnhem [m:2tdmcj, d:x9k2pq].'), 'Velomax zit in Arnhem.');
    assert.equal(f('Herinnering m:2tdmcj klopt'), 'Herinnering klopt');
    assert.equal(f('Operations antwoordde op je bericht (id dlg_0123456789abcdef0123ab):'), 'Operations antwoordde op je bericht:');
    assert.equal(f('Bericht verstuurd aan Operations (id dlg_0123456789abcdef0123ab, in de chat van Operations).'), 'Bericht verstuurd aan Operations (in de chat van Operations).');
    assert.equal(f('Om 10:30 met a:b en Sanne: hallo'), 'Om 10:30 met a:b en Sanne: hallo', 'ordinary text stays');
  }
  assert.equal(previewText('Je webshop heet **Velomax** [m:2tdmcj].'), 'Je webshop heet Velomax.');

  const names = { provider: (id: string) => ({ p1: 'Claude Code' } as any)[id], group: (id: string) => ({ files: 'Bestanden', web: 'Internet' } as any)[id] };
  assert.equal(showValue('settings', {}, names), 'Geen extra instellingen');
  assert.equal(showValue('settings', { compaction: false, historyTokens: 40000, zzz: 1 }, names), 'Automatisch samenvatten: uit\nLengte van het gespreksgeheugen (tokens): 40.000\n1 andere instelling');
  assert.equal(showValue('tool_policy', {}, names), 'Alles volgens het toegangsniveau');
  assert.equal(showValue('tool_groups', ['files', 'web'], names), 'Bestanden, Internet');
  assert.equal(showValue('access_mode', 'ask', names), 'Vraagt toestemming');
  assert.equal(showValue('provider_id', 'p1', names), 'Claude Code');
  assert.equal(showValue('model', '', names), 'Standaard van de engine');
  for (const [k, val] of [['settings', {}], ['tool_policy', {}], ['fallback', null], ['skills', []], ['avatar', 'face:v1:x']] as const) assert.ok(!/[{}[\]]/.test(showValue(k, val, names)), `${k}: ${showValue(k, val, names)}`);
});

test('step detail: the skill markers for the bot become words', () => {
  assert.equal(stepDetail('<skill naam="brand-guidelines" versie="r1" bron="anthropics/skills/skills/brand-guidelines" geverifieerd="nee">\nDit is de huisstijl.'), 'versie r1 · bron anthropics/skills/skills/brand-guidelines · niet geverifieerd — \nDit is de huisstijl.');
  assert.equal(stepDetail('<skillbestand skill="x" pad="checklist.md">\nPunt 1\n</skillbestand>'), 'checklist.md: \nPunt 1');
  assert.equal(stepDetail('Gewone tekst [m:abc123]'), 'Gewone tekst');
});

test('step detail and result of "Pagina lezen": the page in words, no "URL: … Status: 200" (Q-03)', async () => {
  const { resultForDisplay } = await import('../shared/toolLabels.js');
  const ok = 'URL: https://example.com/\nStatus: 200\nTitel: Example Domain\n\n<webinhoud bron="https://example.com/">\nThis domain is for use in examples.\n</webinhoud>';
  assert.equal(stepDetail(ok), '“Example Domain” — This domain is for use in examples.');
  assert.equal(resultForDisplay(ok), '“Example Domain”\n\nInhoud van https://example.com/:\nThis domain is for use in examples.');
  // The step keeps only the first 600 characters: the closing tag may be missing.
  assert.equal(stepDetail(ok.slice(0, ok.indexOf('examples'))), '“Example Domain” — This domain is for use in');
  const gone = 'URL: https://example.com/weg\nStatus: 404\nTitel: Not Found\n\n<webinhoud bron="https://example.com/weg">\nNot Found\n</webinhoud>';
  assert.equal(stepDetail(gone), 'Deze pagina bestaat niet (meer). “Not Found” — Not Found');
  assert.match(resultForDisplay(gone), /^Deze pagina bestaat niet \(meer\)\.\n“Not Found”\n\nInhoud van/);
  assert.equal(stepDetail('URL: https://x.test/\nStatus: 200\n\n<webinhoud bron="https://x.test/">\nAlleen tekst\n</webinhoud>'), 'Alleen tekst');
  for (const s of [stepDetail(ok), stepDetail(gone), resultForDisplay(ok)]) assert.doesNotMatch(s, /URL:|Status:|\b200\b|404/);
});
