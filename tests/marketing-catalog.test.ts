// Package 0.4.5, marketing area: every new skill source and app has an open licence, is pinned (commit or package
// version) and carries a Dutch one-line note. Data checks only; nothing here touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MARKETING_PUBLISHERS, MARKETING_SOURCES } from '../server/modules/skills/curated-marketing.js';
import { CURATED_SOURCES } from '../server/modules/skills/curated.js';
import { checkPublisher } from '../server/modules/skills/import-rules.js';
import { MARKETING_CATALOG } from '../server/modules/mcp/catalog-marketing.js';
import { CATALOG } from '../server/modules/mcp/catalog.js';

const OPEN = /^(MIT|Apache-2\.0|BSD-[23]-Clause|ISC)\b/;
const NEVER = /AGPL|SSPL|noncommercial|non-commercial|BUSL|PolyForm|NOASSERTION/i;
/** A Dutch sentence: common Dutch words, none of the common English ones. */
const dutch = (s: string) => /\b(de|het|een|en|van|je|jouw|met|voor|op|uit|naar|zonder|wat|die|dat)\b/i.test(s) && !/\b(the|and|with|your|for|from|this)\b/i.test(s);
const oneLine = (s: string) => s.length > 10 && !s.includes('\n');

test('marketing skills: open licence, pinned commit, known publisher, Dutch note, pack and category', () => {
  assert.ok(MARKETING_SOURCES.length >= 4);
  for (const s of MARKETING_SOURCES) {
    assert.ok(CURATED_SOURCES.includes(s), `${s.id} is in the catalogue`);
    assert.match(s.commit, /^[0-9a-f]{40}$/, `${s.id} pinned to one full commit`);
    assert.match(s.commitDate, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(s.commitDate <= s.verifiedAt, `${s.id}: commit not after the check`);
    assert.ok(OPEN.test(s.license) && !NEVER.test(s.license), `${s.id} licence ${s.license}`);
    assert.equal(checkPublisher(s.owner, s.repo.split('/')[1]).status, 'known', s.repo);
    assert.equal(s.repo.split('/')[0].toLowerCase(), s.owner.toLowerCase(), `${s.id}: owner matches the repository`);
    assert.ok(oneLine(s.note) && dutch(s.note), `${s.id} Dutch note: ${s.note}`);
    for (const k of s.skills) {
      assert.ok(k.path && !k.path.startsWith('/') && !k.path.includes('..'), `${s.id} path ${k.path}`);
      if (k.root) assert.ok(k.path.startsWith(k.root + '/'), `${k.path} lies inside its root ${k.root}`);
      assert.equal(k.pack, 'Marketing en SEO', k.path);
      assert.ok(k.category, k.path);
      assert.ok(oneLine(k.note) && dutch(k.note), `${k.path} Dutch note: ${k.note}`);
      if (k.scripts) assert.ok(k.windows, `${k.path} has scripts, so it says how they do on Windows`);
      if (k.windows) assert.ok(dutch(k.windows.note), `${k.path} Windows note in Dutch`);
      if (k.needs) assert.ok(dutch(k.needs), `${k.path} needs in Dutch`);
    }
  }
  for (const p of MARKETING_PUBLISHERS) assert.equal(p, p.toLowerCase(), 'publisher names are lower case');
  // Catalogue ids stay unique once the areas are merged.
  const ids = CURATED_SOURCES.map((s) => s.id);
  assert.equal(new Set(ids).size, ids.length, 'unique source ids');
});

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
