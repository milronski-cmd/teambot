// TeamBot's skill catalogue as data (server/modules/skills/curated.ts): community skills by GitHub stars, an open
// licence, one pinned commit, a known publisher, one plain Dutch sentence per skill. No company default bundles as
// content. Data checks only; nothing here touches the network (every entry was installed and loaded for real when the
// list was made, see the header of curated.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { CURATED_SOURCES, curatedId, starsText } from '../server/modules/skills/curated.js';
import { checkPublisher } from '../server/modules/skills/import-rules.js';

const SHA = /^[0-9a-f]{40}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const ALLOWED = /^(MIT|Apache-2\.0|BSD-[23]-Clause|ISC)$/;
/** Company default bundles: not the content of the marketplace (the owner's choice, 2026-11-12). */
const VENDORS = ['anthropics', 'openai', 'google', 'googleworkspace', 'google-gemini', 'microsoft', 'vercel', 'vercel-labs'];
/** Sources that were looked at and must stay out (licence, or they do not work as a loose skill folder). */
const EXCLUDED = /trailofbits|hesreallyhim|figma|vercel-labs\/agent-skills|ComposioHQ|sickn33|garrytan\/gstack|Agent-Reach/i;

/** One Dutch sentence: Dutch function words, none of the common English ones, no line break, a full stop. */
function dutchSentence(s: string | undefined, what: string) {
  assert.ok(typeof s === 'string' && s.length > 15, `${what}: a note`);
  assert.ok(!s!.includes('\n'), `${what}: one line`);
  assert.match(s!, /\b(de|het|een|en|van|voor|met|je|op|in|zonder|naar|bij|als|die|dat|uit|of|wat)\b/i, `${what}: Dutch words (“${s}”)`);
  assert.doesNotMatch(s!, /\b(the|and|with|your|from|this|which)\b/i, `${what}: no English (“${s}”)`);
  assert.match(s!.trim(), /[.!?)]$/, `${what}: a full sentence (“${s}”)`);
}

test('the catalogue: community skills by stars, open licence, pinned commit, known publisher, Dutch notes, unique names', () => {
  assert.ok(CURATED_SOURCES.length >= 15, 'a good number of sources');
  const total = CURATED_SOURCES.reduce((n, s) => n + s.skills.length, 0);
  assert.ok(total >= 50 && total <= 120, `dozens of proven skills, not hundreds (${total})`);
  const names = new Set<string>();
  const ids = new Set<string>();
  let prev = Infinity;
  for (const s of CURATED_SOURCES) {
    assert.match(s.commit, SHA, `${s.id}: pinned to one full commit`);
    assert.match(s.commitDate, DAY, s.id);
    assert.match(s.verifiedAt, DAY, s.id);
    assert.ok(s.commitDate <= s.verifiedAt, `${s.id}: commit not after the check`);
    assert.match(s.license, ALLOWED, `${s.id}: open licence (${s.license})`);
    assert.equal(s.repo.split('/')[0].toLowerCase(), s.owner.toLowerCase(), `${s.id}: owner matches the repository`);
    assert.equal(checkPublisher(s.owner, s.repo.split('/')[1]).status, 'known', `${s.repo}: known publisher (no look-alike warning on a one-click install)`);
    assert.ok(!VENDORS.includes(s.owner.toLowerCase()), `${s.repo}: a company's default bundle is not listed`);
    assert.doesNotMatch(s.repo, EXCLUDED, `${s.repo} stays out`);
    // Why it is here, and the order of the marketplace.
    assert.ok(Number.isInteger(s.stars) && s.stars! >= 100, `${s.id}: stars counted (${s.stars})`);
    assert.ok(s.stars! <= prev, `${s.id}: sorted by stars, most first`);
    prev = s.stars!;
    dutchSentence(s.note, s.id);
    assert.ok(s.skills.length >= 1 && s.skills.length <= 20, `${s.id}: a selection, not a dump (${s.skills.length})`);
    for (const k of s.skills) {
      const what = `${s.id}/${k.path}`;
      assert.ok(!k.path.startsWith('/') && !k.path.includes('..') && !k.path.endsWith('/'), `${what}: path`);
      if (k.root) assert.ok(k.path.startsWith(k.root + '/'), `${what} lies inside its root`);
      assert.ok(k.pack && k.category, what);
      dutchSentence(k.note, what);
      if (k.needs) assert.ok(k.needs.length > 5 && !k.needs.includes('\n'), `${what}: needs on one line`);
      // A skill with scripts says so, and how they do on Windows (they are installed switched off).
      if (k.scripts) dutchSentence(k.windows?.note, `${what} (Windows)`);
      // One install per name in a team: folder names are unique over the whole catalogue.
      const name = path.posix.basename(k.path) || s.id;
      assert.ok(!names.has(name), `unique skill name ${name}`);
      names.add(name);
      const id = curatedId(s, k);
      assert.ok(!ids.has(id), `unique id ${id}`);
      ids.add(id);
    }
  }
  // The areas this owner's bots work in are covered where good community skills exist.
  const cats = new Set(CURATED_SOURCES.flatMap((s) => s.skills.map((k) => k.category)));
  for (const c of ['SEO', 'Advertenties', 'Content', 'Webshop', 'Verkoop', 'Klantenservice', 'Financiën', 'Onderzoek', 'Ontwikkeling', 'Browser', 'Werkwijze']) assert.ok(cats.has(c), `category ${c}`);
  assert.ok(CURATED_SOURCES.find((s) => s.repo === 'obra/superpowers')!.skills.some((k) => k.path === 'skills/verification-before-completion'));
});

test('stars as shown on a card', () => {
  assert.deepEqual([0, 212, 999, 1234, 9950, 28240, 321994].map((n) => starsText(n)), ['', '212', '999', '1,2k', '10k', '28k', '322k']);
  assert.equal(starsText(undefined), '');
});
