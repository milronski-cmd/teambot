import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CATALOG } from '../server/modules/mcp/catalog.js';
import { CATALOG_SERVICE } from '../server/modules/mcp/catalog-service.js';

// Pack “Klantenservice en verkoop”: every app carries a licence, a pin and a Dutch one-line note (the skills of the
// catalogue: tests/skills-catalog-data.test.ts).

const DUTCH = /\b(de|het|een|en|van|je|jouw|met|voor|naar|op|in|wat|niet|of|om|die|dat|als|ook|alleen|zonder|wordt|bijvoorbeeld|gekoppelde?|klant|klanten)\b/gi;
const ENGLISH = /\b(the|and|with|your|from|this)\b/i;
function dutchLine(s: string | undefined, what: string) {
  assert.ok(s && s.trim().length > 10, `${what}: a note`);
  assert.ok(!s!.includes('\n'), `${what}: one line`);
  const words = new Set((s!.match(DUTCH) || []).map((w) => w.toLowerCase()));
  assert.ok(words.size >= 2 && !ENGLISH.test(s!), `${what}: Dutch (“${s}”)`);
}

test('service apps: licence, pinned version or hosted endpoint, Dutch texts, wired into the catalogue', () => {
  assert.ok(CATALOG_SERVICE.length > 0);
  for (const e of CATALOG_SERVICE) {
    assert.ok(e.license && !/AGPL|SSPL|non-?commercial|BUSL/i.test(e.license), `${e.id}: licence`);
    assert.ok(e.source.startsWith('https://'), `${e.id}: source`);
    assert.equal(e.verification, 'geverifieerd', e.id);
    assert.match(e.verifiedAt, /^\d{4}-\d{2}-\d{2}$/, e.id);
    assert.ok(e.testStatus, e.id);
    if (e.transport === 'stdio') {
      assert.ok(e.command === 'npx' || e.command === 'uvx', `${e.id}: npx or uvx`);
      const pkg = (e.args || []).find((a) => !a.startsWith('-'));
      assert.match(pkg || '', /^(@[a-z0-9-]+\/)?[a-z0-9.-]+@\d+\.\d+\.\d+$/, `${e.id}: pinned to one version`);
      for (const f of e.env || []) if (/TOKEN|SECRET|PASSWORD|KEY/.test(f.name) && !/_ID$/.test(f.name)) assert.ok(f.secret, `${e.id}: ${f.name} is a secret`);
    } else {
      assert.ok(e.url?.startsWith('https://'), `${e.id}: hosted endpoint`);
      assert.ok(e.auth === 'oauth' || e.auth === 'headers', `${e.id}: auth`);
    }
    assert.ok(!JSON.stringify(e).includes('@latest'), `${e.id}: no @latest`);
    dutchLine(e.description, `${e.id} description`);
    dutchLine(e.dataFlow, `${e.id} dataFlow`);
    assert.ok(CATALOG.includes(e), `${e.id} is in CATALOG`);
  }
  const ids = CATALOG.map((c) => c.id);
  assert.equal(new Set(ids).size, ids.length, 'unique catalogue ids');
  assert.equal(CATALOG[CATALOG.length - 1].id, 'custom', '“Eigen server” stays last');
});
