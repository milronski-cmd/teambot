// Work catalogue (0.4.5): apps for development, data, documents, design, research and productivity. Every entry must
// carry an allowed licence, a pinned commit and a one-sentence note in Dutch (the skills of the catalogue:
// tests/skills-catalog-data.test.ts). No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CATALOG_WORK } from '../server/modules/mcp/catalog-work.js';
import { CATALOG } from '../server/modules/mcp/catalog.js';
import { checkPublisher } from '../server/modules/skills/import-rules.js';

const SHA = /^[0-9a-f]{40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
/** Licences allowed for skills and apps; never AGPL, SSPL, non-commercial or none. */
const ALLOWED = /^(MIT|Apache-2\.0|BSD-[23]-Clause|ISC)\b/;
const FORBIDDEN = /AGPL|SSPL|GPL-|non-?commercial|\bNC\b|geen licentie|unlicensed/i;

/** One Dutch sentence: Dutch function words, no common English ones, no line break. */
function dutchSentence(s: string, what: string) {
  assert.ok(typeof s === 'string' && s.length > 15, `${what}: a note`);
  assert.ok(!s.includes('\n'), `${what}: one line`);
  assert.match(s, /\b(de|het|een|en|van|voor|met|je|op|in|zonder|naar|bij|als|die|dat|uit)\b/i, `${what}: Dutch words`);
  assert.doesNotMatch(s, /\b(the|and|with|your|for|from|this|that|which)\b/i, `${what}: no English`);
  assert.match(s.trim(), /[.!?]$/, `${what}: a full sentence`);
}

test('work apps: allowed licence, checked commit, pinned version, Dutch texts, in the catalogue before “Eigen server”', () => {
  assert.ok(CATALOG_WORK.length >= 5, 'several apps');
  for (const e of CATALOG_WORK) {
    assert.match(e.commit, SHA, `${e.id}: checked commit`);
    assert.match(e.license, ALLOWED, `${e.id}: allowed licence`);
    assert.doesNotMatch(e.license, FORBIDDEN, e.id);
    assert.ok(e.source.startsWith('https://github.com/'), `${e.id}: open source on GitHub`);
    assert.match(e.verifiedAt, DAY, e.id);
    assert.equal(e.verification, 'geverifieerd', e.id);
    assert.ok(e.testStatus, e.id);
    dutchSentence(e.note, `${e.id} (note)`);
    dutchSentence(e.description, `${e.id} (description)`);
    assert.ok(e.dataFlow.length > 40, `${e.id}: says where data goes`);
    if (e.transport === 'stdio') {
      assert.ok(e.command === 'npx' || e.command === 'uvx', e.id);
      const pkg = (e.args || []).find((a) => !a.startsWith('-'));
      assert.ok(pkg && /@\d/.test(pkg.replace(/^@/, '')) && !/@latest$/.test(pkg), `${e.id}: version pinned (${pkg})`);
      assert.ok(e.requirements, `${e.id}: says what to install`);
    } else {
      assert.match(e.url!, /^https:\/\//, e.id);
    }
    assert.equal(CATALOG.filter((x) => x.id === e.id).length, 1, `${e.id} in CATALOG once`);
  }
  const ids = CATALOG.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'unique app ids');
  assert.equal(ids[ids.length - 1], 'custom', '“Eigen server” stays last');
  // Least privilege where the server offers it.
  const args = (id: string) => CATALOG_WORK.find((e) => e.id === id)!.args!;
  assert.ok(args('obsidian-vault').includes('--read-only=true'));
  assert.deepEqual(args('git').slice(-1), ['--repository'], 'the chosen repository follows --repository');
  for (const flag of ['--isolated', '--no-usage-statistics', '--no-performance-crux']) assert.ok(args('chrome-devtools').includes(flag), flag);
  assert.equal(CATALOG_WORK.find((e) => e.id === 'duckdb')!.riskOverrides!.execute_query, 'exec', 'SQL is never treated as reading');
  // Rejected apps stay out (see the header of catalog-work.ts).
  const text = JSON.stringify(CATALOG);
  for (const no of ['zotero-mcp', 'Office-Word-MCP-Server', 'excalidraw-mcp', 'mcp-pandoc', 'mcp-server-chart']) assert.ok(!text.includes(no), `${no} is left out`);
});
