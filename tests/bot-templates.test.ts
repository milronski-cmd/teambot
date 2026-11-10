import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { normalizeTemplate, TEMPLATE_FORMAT } from '../server/modules/skills/templates.js';
import { BOT_CATEGORIES, BUILTIN_BOTS, BUILTIN_SKILLS } from '../server/modules/skills/builtin-catalog.js';
import { COLORS, EXTRAS, EYES, MOUTHS, SHAPES, encodeFace, parseFace } from '../shared/botface.js';

/** A handful of very common Dutch words; every description and instruction text should contain some. */
const DUTCH = /\b(je|de|het|een|en|van|voor|niet|met|op)\b/gi;
const TRAITS = ['shape', 'color', 'eyes', 'mouth', 'extra', 'cheeks'] as const;

test('built-in bot templates: complete, consistent, original metadata', () => {
  assert.ok(BUILTIN_BOTS.length >= 27, `at least 27 templates (now ${BUILTIN_BOTS.length})`);
  const skillIds = new Set(BUILTIN_SKILLS.map((s) => s.id));
  assert.equal(skillIds.size, BUILTIN_SKILLS.length, 'skill ids are unique');

  const ids = new Set<string>();
  let lastCat = -1;
  for (const b of BUILTIN_BOTS) {
    assert.match(b.id, /^[a-z0-9]+(-[a-z0-9]+)*$/, `${b.id}: kebab-case id`);
    assert.ok(!ids.has(b.id), `${b.id}: duplicate id`);
    ids.add(b.id);
    assert.ok(b.title.trim() && b.role.trim(), `${b.id}: title and role`);
    assert.ok(b.role.length <= 60, `${b.id}: role fits a card`);

    // One clear Dutch sentence.
    assert.ok(b.description.length >= 40 && b.description.length <= 200, `${b.id}: description length ${b.description.length}`);
    assert.match(b.description, /[.!?]$/, `${b.id}: description ends a sentence`);
    assert.ok((b.description.match(DUTCH) || []).length >= 1, `${b.id}: Dutch description`);
    assert.ok((b.instructions.match(DUTCH) || []).length >= 8, `${b.id}: Dutch instructions`);
    assert.ok(b.instructions.split('\n').filter((l) => l.startsWith('- ')).length >= 3, `${b.id}: instructions are bullet rules`);

    assert.ok(b.access_mode === 'readonly' || b.access_mode === 'ask', `${b.id}: access mode ${b.access_mode}`);
    assert.equal(b.version, '1.0.0', `${b.id}: version`);
    assert.ok(b.changelog.length >= 1 && b.changelog[0].version === b.version, `${b.id}: changelog`);
    assert.ok(b.tags.length >= 2, `${b.id}: tags`);
    assert.match(b.color, /^#[0-9a-f]{6}$/i, `${b.id}: accent colour`);
    assert.equal(b.model_hint, undefined, `${b.id}: no model hint`);

    // Skills come from the same built-in catalogue, without duplicates.
    assert.ok(b.skills.length >= 1, `${b.id}: has skills`);
    assert.equal(new Set(b.skills).size, b.skills.length, `${b.id}: duplicate skill`);
    for (const s of b.skills) assert.ok(skillIds.has(s), `${b.id}: unknown skill ${s}`);

    // Categories from the fixed set, and the list stays grouped in that order (the Bots tab relies on it).
    const ci = (BOT_CATEGORIES as readonly string[]).indexOf(b.category);
    assert.ok(ci >= 0, `${b.id}: unknown category ${b.category}`);
    assert.ok(ci >= lastCat, `${b.id}: BUILTIN_BOTS is not grouped in BOT_CATEGORIES order`);
    lastCat = ci;

    // A drawn face with all six traits from the whitelist, in canonical encoding.
    assert.ok(b.avatar.startsWith('face:'), `${b.id}: avatar is a face`);
    const f = parseFace(b.avatar)!;
    for (const k of TRAITS) assert.ok(f[k] !== undefined, `${b.id}: face trait ${k}`);
    assert.equal(encodeFace(f), b.avatar, `${b.id}: canonical face`);
    assert.ok((SHAPES as readonly string[]).includes(f.shape!) && (COLORS as readonly string[]).includes(f.color!), `${b.id}: shape/colour`);
    assert.ok((EYES as readonly string[]).includes(f.eyes!) && (MOUTHS as readonly string[]).includes(f.mouth!) && (EXTRAS as readonly string[]).includes(f.extra!), `${b.id}: eyes/mouth/extra`);
  }
  for (const c of BOT_CATEGORIES) assert.ok(BUILTIN_BOTS.some((b) => b.category === c), `category ${c} is used`);
  // Faces should be distinguishable: no two templates share the exact same face.
  assert.equal(new Set(BUILTIN_BOTS.map((b) => b.avatar)).size, BUILTIN_BOTS.length, 'every template has its own face');
});

test('built-in bot templates: real tool groups, clean previews, install works', async () => {
  const t = await startTestApp();
  try {
    const groups = t.app.ctx.tools.groups;
    for (const b of BUILTIN_BOTS) {
      assert.equal(new Set(b.tool_groups).size, b.tool_groups.length, `${b.id}: duplicate tool group`);
      for (const g of b.tool_groups) assert.ok(groups.has(g), `${b.id}: tool group "${g}" is not registered`);
    }

    const list = await t.api('GET', '/skills/market/bots');
    const builtin = list.items.filter((i: any) => i.catalogId === 'builtin');
    assert.deepEqual(builtin.map((i: any) => i.id), BUILTIN_BOTS.map((b) => b.id), 'listed in catalogue order');
    for (const c of BOT_CATEGORIES) assert.ok(list.categories.includes(c), `category ${c} listed`);

    // Every template previews without warnings: all groups known, all skills found and scanning clean.
    for (const b of BUILTIN_BOTS) {
      const pv = await t.api('POST', `/skills/market/bots/builtin/${b.id}/preview`, {});
      assert.deepEqual(pv.warnings, [], `${b.id}: preview warnings`);
      assert.equal(pv.needsAcknowledge, false, `${b.id}: needs acknowledge`);
      assert.equal(pv.bot.access_mode, b.access_mode, `${b.id}: access mode kept`);
      assert.equal(pv.bot.avatar, b.avatar, `${b.id}: face kept`);
      assert.ok(pv.bot.tool_groups.every((g: any) => g.known), `${b.id}: unknown group in preview`);
      assert.deepEqual(pv.skills.map((s: any) => s.name), b.skills, `${b.id}: skills resolved`);
      for (const s of pv.skills) {
        assert.equal(s.action, 'create', `${b.id}/${s.name}: action`);
        assert.ok(s.scan && (s.scan.level === 'ok' || s.scan.level === 'info'), `${b.id}/${s.name}: scan ${s.scan?.level}`);
      }
    }

    // Install a new read-only template end to end.
    const jur = BUILTIN_BOTS.find((b) => b.id === 'juridische-check')!;
    const inst = await t.api('POST', '/skills/market/bots/builtin/juridische-check/install', { provider_id: t.providerId, model: 'mock-1' });
    assert.equal(inst.agent.name, jur.title);
    assert.equal(inst.agent.access_mode, 'readonly');
    assert.deepEqual([...inst.agent.tool_groups].sort(), ['files', 'skills', 'team', 'web']);
    assert.equal(inst.agent.skills.length, jur.skills.length);
    assert.deepEqual(parseFace(inst.agent.avatar), parseFace(jur.avatar), 'installed bot has the template face');
    assert.equal(inst.agent.color, jur.color);
    assert.equal(inst.agent.settings.template.itemId, 'juridische-check');
    assert.deepEqual(inst.skillsCreated.map((s: any) => s.name).sort(), [...jur.skills].sort());

    // A second template reuses the skill that is already installed and adds the others.
    const shared = await t.api('POST', '/skills/market/bots/builtin/hr-assistent/preview', {});
    assert.equal(shared.skills.find((s: any) => s.name === 'heldere-taal').action, 'use-existing');
    const hr = await t.api('POST', '/skills/market/bots/builtin/hr-assistent/install', { provider_id: t.providerId, model: 'mock-1' });
    assert.equal(hr.agent.access_mode, 'ask');
    assert.equal(hr.agent.skills.length, 3);
    assert.deepEqual(hr.skillsCreated.map((s: any) => s.name).sort(), ['vacaturetekst', 'zakelijke-email']);

    const after = await t.api('GET', '/skills/market/bots?q=juridische');
    assert.equal(after.items.find((i: any) => i.id === 'juridische-check').installedCount, 1);
  } finally {
    await t.close();
  }
});

// Found in the core acceptance test: the first bot (welcome screen) and every template lacked the "team" tools, so a
// lead in a group could not delegate or ask another bot ("Ik heb geen tool om de opdracht door te geven").
test('bot templates and the welcome starters can work together (team tools on, like a new bot on the server)', async () => {
  const fs = await import('node:fs');
  const path = await import('node:path');
  for (const b of BUILTIN_BOTS) assert.ok(b.tool_groups.includes('team'), `${b.title} mist team`);
  const src = fs.readFileSync(path.join(process.cwd(), 'ui', 'src', 'pages', 'newbot', 'starters.ts'), 'utf8');
  const starters = src.slice(src.indexOf('export const STARTERS'), src.indexOf('];', src.indexOf('export const STARTERS')));
  const groups = [...starters.matchAll(/tool_groups: \[([^\]]*)\]/g)].map((m) => m[1]);
  assert.ok(groups.length >= 4);
  for (const g of groups) assert.match(g, /'team'/);
});

test('a bot template keeps a specialist field with suggested sources (package S), bounded; other objects in settings stay out', () => {
  const base = { format: TEMPLATE_FORMAT, name: 'Fiscus', instructions: 'x' };
  const t = normalizeTemplate({ ...base, settings: { maxTurns: 12, specialist: { field: 'Btw-regels', suggestedSources: ['https://belasting.example/feed', { url: 'https://belasting.example/gids', label: 'Gids', extra: 'weg' }, '', 42] }, folders: [{ path: 'C:/' }] } }).template;
  assert.deepEqual(t.settings, { maxTurns: 12, specialist: { field: 'Btw-regels', suggestedSources: ['https://belasting.example/feed', { url: 'https://belasting.example/gids', label: 'Gids' }] } });
  // From a team template the field sits next to the bot (and in meta): it ends up in the same place.
  assert.equal(normalizeTemplate({ ...base, specialist: { field: 'Klantcontact', suggestedSources: [] } }).template.settings.specialist.field, 'Klantcontact');
  assert.equal(normalizeTemplate({ ...base, meta: { specialist: { field: 'Reizen', suggestedSources: [] } } }).template.settings.specialist.field, 'Reizen');
  assert.equal(normalizeTemplate({ ...base, settings: { specialist: { field: '   ' } } }).template.settings.specialist, undefined, 'no field, no specialist');
  assert.equal(normalizeTemplate({ ...base, settings: { specialist: { field: 'x'.repeat(1000) } } }).template.settings.specialist.field.length, 300);
});
