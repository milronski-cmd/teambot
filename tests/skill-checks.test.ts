import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { skillSubstance } from '../server/modules/skills/substance.js';

// A skill that only points to another skill (mattpocock/grill-me: "Call the Skill tool with grilling") or is nearly
// empty is flagged before installing; "Controleer op updates" in Mijn skills asks the sources again.

const md = (name: string, body: string, description = 'Een skill.') => `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n\n${body}\n`;

test('substance: a skill that only hands off to another skill is thin (mattpocock/grill-me)', () => {
  const grill = skillSubstance(md('grill-me', 'Call the Skill tool with grilling.', 'Interview me relentlessly about a plan.'), ['SKILL.md'], 'grill-me');
  assert.equal(grill.thin, true);
  assert.deepEqual(grill.pointsTo, ['grilling']);
  assert.match(grill.message!, /^Deze skill doet zelf weinig: hij verwijst alleen naar de skill “grilling”/);

  for (const body of ['Use the `brand-guidelines` skill for this.', 'Gebruik de skill brand-guidelines.', 'Follow the **brand-guidelines** skill.']) {
    const s = skillSubstance(md('wrapper', body), ['SKILL.md'], 'wrapper');
    assert.deepEqual(s.pointsTo, ['brand-guidelines'], body);
    assert.equal(s.thin, true, body);
  }
  // The skill's own name and filler words are never "another skill".
  assert.deepEqual(skillSubstance(md('pdf', 'Use the pdf skill instructions below.\n\n' + 'Read the file. '.repeat(3)), [], 'pdf').pointsTo, []);
});

test('substance: nearly empty is thin; real instructions, extra files or references are not', () => {
  const empty = skillSubstance(md('leeg', 'Wees behulpzaam.'), ['SKILL.md'], 'leeg');
  assert.equal(empty.thin, true);
  assert.match(empty.message!, /maar 2 woorden lang/);

  const real = 'Lees eerst het hele document. Maak dan een samenvatting van maximaal tien regels, met de belangrijkste besluiten bovenaan en de open vragen onderaan. Noem altijd de bron en de datum. Gebruik geen jargon en schrijf in de jij-vorm.';
  assert.equal(skillSubstance(md('samenvatten', real), ['SKILL.md'], 'samenvatten').thin, false);
  // A short SKILL.md with its own scripts or references does something itself.
  assert.equal(skillSubstance(md('pdf', 'Run scripts/fill.py.'), ['SKILL.md', 'scripts/fill.py'], 'pdf').thin, false);
  // A licence or readme next to it does not count as substance.
  assert.equal(skillSubstance(md('grill-me', 'Call the Skill tool with grilling.'), ['SKILL.md', 'LICENSE', 'README.md'], 'grill-me').thin, true);
  // Nor does display metadata for other clients: the real mattpocock/grill-me ships agents/openai.yaml (found live).
  assert.equal(skillSubstance(md('grill-me', 'Call the Skill tool with "grilling".'), ['agents/openai.yaml', 'SKILL.md'], 'grill-me').thin, true);
  assert.equal(skillSubstance(md('pdf', 'Run scripts/fill.py.'), ['SKILL.md', 'agents/openai.yaml', 'scripts/fill.py'], 'pdf').thin, false);
  // Mentioning another skill inside long, real instructions is fine.
  assert.equal(skillSubstance(md('plan', real + ' Use the grilling skill when the plan is vague. ' + real), ['SKILL.md'], 'plan').thin, false);
  // Headings and the frontmatter do not count as instructions.
  assert.equal(skillSubstance('---\nname: x\ndescription: Heel veel woorden in de beschrijving maar niets in de tekst zelf van deze skill.\n---\n\n# Titel\n## Nog een titel\n', [], 'x').words, 0);
});

test('the import review carries the warning (not a block), and "Controleer op updates" answers without sources', async () => {
  const t = await startTestApp();
  try {
    const pv = await t.api('POST', '/skills/import/preview', { kind: 'paste', text: md('grill-me', 'Call the Skill tool with grilling.', 'Interview me about a plan.') });
    const c = pv.candidates[0];
    assert.equal(c.substance.thin, true);
    assert.deepEqual(c.substance.pointsTo, ['grilling']);
    const r = await t.api('POST', '/skills/import/commit', { stagingId: pv.stagingId });
    assert.equal(r.results[0].status, 'created', 'a warning, the owner may still install it');
    // A pasted skill has no source to ask: nothing to check, no errors. (A GitHub source: marketplace-web.test.ts.)
    const cu = await t.api('POST', '/skills/check-updates', {});
    assert.deepEqual([cu.checked, cu.sources, cu.updates.length, cu.errors.length], [0, 0, 0, 0]);
    assert.ok(cu.checkedAt);
  } finally {
    await t.close();
  }
});
