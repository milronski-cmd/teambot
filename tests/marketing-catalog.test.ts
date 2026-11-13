// Package 0.4.5, marketing area: every app has an open licence, is pinned to a package version and carries a Dutch
// one-line note (the skills of the catalogue: tests/skills-catalog-data.test.ts). Data checks only; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKETING_CATALOG } from '../server/modules/mcp/catalog-marketing.js';
import { CATALOG } from '../server/modules/mcp/catalog.js';

const OPEN = /^(MIT|Apache-2\.0|BSD-[23]-Clause|ISC)\b/;
const NEVER = /AGPL|SSPL|noncommercial|non-commercial|BUSL|PolyForm|NOASSERTION/i;
/** A Dutch sentence: common Dutch words, none of the common English ones. */
const dutch = (s: string) => /\b(de|het|een|en|van|je|jouw|met|voor|op|uit|naar|zonder|wat|die|dat)\b/i.test(s) && !/\b(the|and|with|your|for|from|this)\b/i.test(s);
const oneLine = (s: string) => s.length > 10 && !s.includes('\n');

test('marketing apps: open licence, pinned version, Dutch description and data flow, writes never read', () => {
  assert.ok(MARKETING_CATALOG.length >= 5);
  for (const e of MARKETING_CATALOG) {
    assert.ok(CATALOG.includes(e), `${e.id} is in the catalogue`);
    assert.ok(OPEN.test(e.license) && !NEVER.test(e.license), `${e.id} licence ${e.license}`);
    assert.match(e.source, /^https:\/\/github\.com\/[^/]+\/[^/]+/, `${e.id} source on GitHub`);
    assert.ok(oneLine(e.description) && dutch(e.description), `${e.id} Dutch description: ${e.description}`);
    assert.ok(dutch(e.dataFlow), `${e.id} data flow in Dutch`);
    assert.ok(e.verification === 'geverifieerd' && /^\d{4}-\d{2}-\d{2}$/.test(e.verifiedAt) && e.testStatus, e.id);
    if (e.transport === 'stdio') {
      assert.ok(e.command === 'npx' || e.command === 'uvx', `${e.id} runs with npx or uvx`);
      const pkg = (e.args || []).find((a) => !a.startsWith('-'));
      assert.match(pkg || '', /^(@[^/]+\/)?[^@]+@\d+\.\d+\.\d+$/, `${e.id} pinned to an exact version: ${pkg}`);
      assert.ok(!(e.args || []).includes('--allow-write'), `${e.id} starts without write tools`);
    } else {
      assert.match(e.url || '', /^https:\/\//, `${e.id} over https`);
    }
    for (const f of [...(e.env || []), ...(e.headers || [])]) {
      if (/KEY|TOKEN|SECRET|Authorization/i.test(f.name)) assert.ok(f.secret, `${e.id}: ${f.name} goes to the vault`);
    }
    for (const r of Object.values(e.riskOverrides || {})) assert.notEqual(r, 'read', `${e.id}: overrides are only stricter`);
  }
  const ids = CATALOG.map((e) => e.id);
  assert.equal(new Set(ids).size, ids.length, 'unique app ids');
  assert.equal(CATALOG[CATALOG.length - 1].id, 'custom', '“Eigen server” stays last');
});
