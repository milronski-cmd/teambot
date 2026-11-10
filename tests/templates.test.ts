import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import rooms from '../server/modules/rooms/index.js';
import skills from '../server/modules/skills/index.js';
import routines from '../server/modules/routines/index.js';
import teams from '../server/modules/teams/index.js';
import templates from '../server/modules/templates/index.js';
import memory from '../server/modules/memory/index.js';
import { TEMPLATE_DEFS, templateDef, builtinTeamPackages } from '../server/modules/templates/registry.js';
import { validateRegistry, validateTemplate, yamlSafe, publicHttps } from '../server/modules/templates/validate.js';
import { buildPackage, HELPER_PERMS, LEAD_PERMS } from '../server/modules/templates/build.js';
import { isEmptyProfile, profileFromAnswers, profileText, teamsProfile } from '../server/modules/templates/profile.js';
import { botInstructions, teamInstructions } from '../server/modules/templates/render.js';
import { findCatalogSkill, resolveSkills } from '../server/modules/templates/skills.js';
import { normalizeTeam } from '../server/modules/rooms/packages.js';
import { TEAM_TEMPLATES } from '../server/modules/rooms/team-templates.js';
import { findSecrets } from '../server/modules/skills/scan.js';
import type { TemplateDef } from '../server/modules/templates/types.js';

// Package R (0.4): team templates as data. Every template loads and validates, builds a clean team package, creates
// a real team with the mock provider in a temporary data folder, fills the profile from the questions, and creates
// nothing that runs by itself.

const BUSINESS_NEW = ['webshop', 'seo-en-content', 'advertenties-en-shopping', 'klantcontact', 'operations', 'software-bouwen'];
const REFRESHED = ['onderzoek-en-schrijven', 'klantenservice', 'software'];
const PRIVATE_NEW = ['prive', 'prive-huishouden', 'prive-geld', 'prive-gezondheid', 'reizen', 'leren-en-studie'];

/** An answer for every question of a template (the first one is the name). */
function answersFor(d: TemplateDef): Record<string, string> {
  const a: Record<string, string> = {};
  for (const q of d.questions) a[q.key] = q.profile === 'name' ? `Testbedrijf ${d.id}` : q.key === 'website' ? 'https://www.voorbeeld.nl' : `Antwoord ${q.key} voor ${d.id}`;
  return a;
}

const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));

test('registry: sixteen templates (six new for business, three refreshed, six private, one empty team) that all validate', () => {
  const ids = TEMPLATE_DEFS.map((d) => d.id);
  assert.equal(ids.length, 16);
  assert.equal(new Set(ids).size, ids.length);
  for (const id of BUSINESS_NEW) assert.deepEqual([templateDef(id)?.status, templateDef(id)?.category], ['new', 'bedrijf'], id);
  for (const id of REFRESHED) assert.equal(templateDef(id)?.status, 'refreshed', id);
  for (const id of PRIVATE_NEW) assert.deepEqual([templateDef(id)?.status, templateDef(id)?.category], ['new', 'prive'], id);
  assert.equal(templateDef('leeg-team')?.minimal, true);
  assert.deepEqual(validateRegistry(TEMPLATE_DEFS), [], 'no problems in any template');

  const faces = new Set<string>();
  for (const d of TEMPLATE_DEFS) {
    assert.equal(d.bots.filter((b) => b.lead).length, 1, `${d.id}: one team lead`);
    if (d.minimal) assert.equal(d.bots.length, 1);
    else assert.ok(d.bots.length >= 3 && d.bots.length <= 5, `${d.id}: a team lead and 2–4 bots`);
    assert.ok(d.questions.length >= 3 && d.questions.length <= 5, `${d.id}: 3–5 questions`);
    for (const b of d.bots) {
      const f = JSON.stringify(b.face);
      assert.ok(!faces.has(f), `${d.id}/${b.name}: a face of its own`);
      faces.add(f);
      // Bot descriptions also appear in the team instructions the bots read, so they never say "je" or "jou".
      assert.doesNotMatch(b.description, /\b(je|jou|jouw|jij)\b/i, `${d.id}/${b.name}: neutral description`);
    }
  }
  // The 0.3 templates keep their ids and the bots the e2e test looks for; only one card says "Klantenservice".
  assert.deepEqual(templateDef('onderzoek-en-schrijven')!.bots.map((b) => b.name), ['Redacteur', 'Onderzoeker', 'Schrijver']);
  assert.equal(templateDef('klantenservice')!.bots.find((b) => b.lead)!.name, 'Coördinator');
  assert.equal(TEMPLATE_DEFS.filter((d) => /Klantenservice/.test(`${d.name} ${d.description}`)).length, 1);
  assert.equal(TEMPLATE_DEFS.filter((d) => /Onderzoek en schrijven/.test(`${d.name} ${d.description}`)).length, 1);
  // The existing template mechanism lists the same templates (registration hook).
  assert.deepEqual(TEAM_TEMPLATES.map((t) => t.id), ids);
});

test('instructions: the lead checks before "klaar", helpers mostly read, every bot knows when to stop, customer and private rules', () => {
  for (const d of TEMPLATE_DEFS) {
    for (const b of d.bots) {
      const text = botInstructions(d, b);
      assert.match(text, /^Stop en (vraag het de eigenaar|meld het aan de teamleider) als:$/m, `${d.id}/${b.name}: when to stop`);
      assert.match(text, /^Klaar als \(voorbeelden\):$/m, `${d.id}/${b.name}: klaar als`);
      assert.match(text, /^Je mag niet:$/m);
      assert.match(text, /Verzin geen resultaat/);
      if (b.lead) {
        assert.match(text, /Controleer het werk tegen het "klaar als" voordat je "klaar" meldt/, `${d.id}: lead checks`);
        assert.match(text, /"te controleren"/);
      } else assert.match(text, /^Als helper:$/m, `${d.id}/${b.name}: helper`);
      if (b.customer === 'direct') {
        assert.match(text, /dat je een AI-assistent bent/);
        assert.match(text, /Verzin nooit beleid/);
        assert.match(text, /beslist de eigenaar/);
        assert.match(text, /zet het door naar de eigenaar/);
      }
      if (b.customer === 'drafts') assert.match(text, /jij verstuurt nooit zelf iets naar een klant/);
    }
    assert.match(teamInstructions(d), /^Doel: /);
  }
  // A helper in the team that talks with customers leaves the customer to the lead.
  const kc = templateDef('klantcontact')!;
  assert.match(botInstructions(kc, kc.bots[1]), /antwoord de klant dan niet zelf/);
  // Private teams: no diagnosis, never pay.
  assert.match(teamInstructions(templateDef('prive-gezondheid')!), /geen diagnose[\s\S]*huisarts/);
  assert.match(teamInstructions(templateDef('prive-geld')!), /betalen nooit/);
  // The empty team's lead knows it works alone and suggests helpers.
  const leeg = templateDef('leeg-team')!;
  assert.match(botInstructions(leeg, leeg.bots[0]), /enige bot in dit team/);
});

test('validator: refuses two leads, YAML-unsafe skill reasons, secrets, an AI choice, unknown placeholders, risky tools and bad sources', () => {
  assert.ok(yamlSafe('Vaste opbouw voor een productpagina'));
  assert.ok(!yamlSafe('Opbouw: titel en tekst'));
  assert.ok(!yamlSafe('"quoted"'));
  assert.ok(!yamlSafe('twee\nregels'));
  assert.ok(!yamlSafe('kleur #rood'));
  assert.ok(publicHttps('https://www.voedingscentrum.nl'));
  assert.ok(!publicHttps('http://www.voedingscentrum.nl'));
  assert.ok(!publicHttps('https://user:pw@example.com'));
  assert.ok(!publicHttps('https://example.com/?token=abc'));

  const d = clone(templateDef('klantcontact')!) as any;
  d.bots[1].lead = true;
  d.bots[1].skills = [{ id: 'Geen Slug!', why: 'Opbouw: titel' }];
  d.bots[1].intro = 'Gebruik sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij voor de API.';
  d.bots[2].provider_id = 'prov_123';
  d.bots[2].routines = [{ name: 'X', prompt: 'Kijk naar {onbekend}.', schedule: { kind: 'weekly', days: ['ma'], times: ['25:00'] } }];
  d.bots[0].tools = ['files', 'team', 'web', 'routines'];
  d.bots[0].specialist = { field: 'Klantcontact', suggestedSources: ['http://niet-veilig.nl'] };
  const p = validateTemplate(d).join('\n');
  assert.match(p, /exactly one team lead \(found 2\)/);
  assert.match(p, /not a stable catalogue id/);
  assert.match(p, /YAML-safe/);
  assert.match(p, /looks like a secret/);
  assert.match(p, /provider_id: not allowed/);
  assert.match(p, /unknown placeholder \{onbekend\}/);
  assert.match(p, /Kies minstens één tijd/);
  assert.match(p, /tool group "routines" is not allowed/);
  assert.match(p, /talks with customers directly, so no "web"/);
  assert.match(p, /must be a plain public https link/);
  // Bot names are unique across templates.
  const twin = clone(templateDef('webshop')!);
  twin.id = 'webshop-twee';
  assert.match(validateRegistry([templateDef('webshop')!, twin]).join('\n'), /also used in webshop/);
});

test('packages: every template builds a clean team package (no secrets, no AI choice, safe access, paused routines)', () => {
  for (const d of TEMPLATE_DEFS) {
    const pkg = buildPackage(d, profileFromAnswers(d, answersFor(d)));
    const raw = JSON.stringify(pkg);
    assert.deepEqual(findSecrets(raw), [], `${d.id}: no secrets`);
    assert.doesNotMatch(raw, /"(provider_id|providerId|workspace|messages|memory_items)"/, `${d.id}: nothing personal`);
    const n = normalizeTeam(pkg);
    assert.equal(n.bots.length, d.bots.length);
    assert.equal(n.bots.filter((b) => b.role === 'lead').length, 1);
    assert.equal(n.mode, 'lead');
    assert.equal(n.limits.maxDelegationDepth, 2);
    for (const b of pkg.bots) {
      assert.equal(b.template.access_mode, 'ask', `${d.id}/${b.template.name}: vraagt toestemming`);
      assert.equal(b.template.model_hint, '');
      assert.deepEqual(b.perms, b.role === 'lead' ? LEAD_PERMS : HELPER_PERMS);
      for (const r of b.template.routines) assert.equal(r.options.missedPolicy, 'skip');
    }
  }
  // Answers fill the routine prompts; without an answer the routine says so and stops.
  const shop = templateDef('webshop')!;
  const withUrl = buildPackage(shop, profileFromAnswers(shop, { website: 'https://winkel.voorbeeld.nl' }));
  const check = (p: any) => p.bots.find((b: any) => b.template.name === 'Shopcontroleur').template.routines[0].prompt;
  assert.match(check(withUrl), /https:\/\/winkel\.voorbeeld\.nl/);
  assert.match(check(buildPackage(shop)), /dit adres: nog niet ingevuld/);
  // The plain packages for "Nieuwe groep › Uit een sjabloon" carry no profile.
  for (const p of builtinTeamPackages()) assert.doesNotMatch(p.instructions, /Bedrijfsprofiel|Profiel van dit team/);
});

test('profile: answers fill the profile; cleaned, bounded, secrets removed, unknown keys ignored', () => {
  const shop = templateDef('webshop')!;
  const r = profileFromAnswers(shop, {
    bedrijf: '  Bakkerij\nJansen  ',
    aanbod: 'Taarten\r\n\r\n\r\n\r\nen brood',
    website: 'https://bakkerij.nl',
    toon: 'Warm',
    regels: 'Retour binnen 14 dagen. Wachtwoord: ghp_abcdefghijklmnopqrstuvwxyz0123456789AB',
    onbekend: 'genegeerd',
    extra: { niet: 'tekst' },
  });
  assert.equal(r.profile.name, 'Bakkerij Jansen');
  assert.equal(r.profile.business, 'Taarten\n\nen brood');
  assert.equal(r.profile.tone, 'Warm');
  assert.deepEqual(r.profile.extra, [{ key: 'website', label: 'Webwinkel', value: 'https://bakkerij.nl' }]);
  assert.doesNotMatch(r.profile.rules, /ghp_/);
  assert.match(r.profile.rules, /\[geheim verwijderd\]/);
  assert.equal(r.warnings.length, 1);
  assert.ok(!JSON.stringify(r).includes('genegeerd'));
  assert.equal(profileFromAnswers(shop, { bedrijf: 'x'.repeat(500) }).profile.name.length, 80);
  assert.ok(isEmptyProfile(profileFromAnswers(shop, null).profile));
  assert.ok(isEmptyProfile(profileFromAnswers(shop, ['a']).profile));
  assert.equal(profileText(profileFromAnswers(shop, {}).profile), '');
  const text = profileText(r.profile, shop);
  assert.match(text, /^Bedrijfsprofiel/);
  assert.match(text, /- Bedrijf: Bakkerij Jansen/);
  assert.match(text, /- Webwinkel: https:\/\/bakkerij\.nl/);
  assert.match(teamInstructions(shop, r.profile), /- Bedrijf: Bakkerij Jansen/);
  assert.deepEqual(teamsProfile(r.profile), { company: 'Bakkerij Jansen', about: 'Taarten\n\nen brood\nWebwinkel: https://bakkerij.nl', tone: 'Warm', rules: r.profile.rules });
  // A private team gets its own words.
  const g = templateDef('prive-gezondheid')!;
  assert.match(profileText(profileFromAnswers(g, { voor: 'Voor mij', doel: 'Fitter' }).profile, g), /^Profiel van dit team[\s\S]*- Voor wie: Voor mij\n- Doel: Fitter/);
});

async function app(withTeams = false): Promise<TestApp> {
  return startTestApp({ modules: withTeams ? [memory, skills, routines, teams, rooms, templates] : [memory, skills, routines, rooms, templates] });
}

test('skills: every suggestion is in the catalogue today, and a missing one is skipped without an error', async () => {
  const t = await app();
  try {
    const owner = t.app.ctx.auth.owner()!;
    for (const d of TEMPLATE_DEFS) {
      const r = resolveSkills(t.app.ctx, owner.id, d);
      const missing = r.suggestions.filter((s) => !s.available).map((s) => s.id);
      assert.deepEqual(missing, [], `${d.id}: suggested skills found in the catalogue`);
    }
    const items = t.app.ctx.services.skills.catalogs.skills(owner.id);
    assert.equal(findCatalogSkill(items, 'builtin/seo-analyse')?.id, 'seo-analyse');
    assert.equal(findCatalogSkill(items, 'bestaat-niet'), null);
    assert.equal(findCatalogSkill(items, 'onbekend/seo-analyse'), null);
    // Graceful: a template whose skill is not (or no longer) in the catalogue still installs, with a note.
    const d = clone(templateDef('leeg-team')!);
    d.bots[0].skills = [{ id: 'bestaat-niet', why: 'Bestaat niet in de catalogus' }];
    const res = resolveSkills(t.app.ctx, owner.id, d);
    assert.deepEqual(res.suggestions.map((s) => [s.id, s.available]), [['bestaat-niet', false]]);
    assert.deepEqual(res.byBot, {});
    // Without the skills module nothing is available, and nothing throws.
    assert.deepEqual(resolveSkills({ services: {} } as any, owner.id, templateDef('webshop')!).byBot, {});
  } finally {
    await t.close();
  }
});

test('API: list, detail and preview (creates nothing); the old "Uit een sjabloon" route still works', async () => {
  const t = await app();
  try {
    const list = await t.api('GET', '/team-templates');
    assert.equal(list.length, 16);
    const shop = list.find((x: any) => x.id === 'webshop');
    assert.equal(shop.questions.length, 5);
    assert.equal(shop.bots.find((b: any) => b.groupRole === 'lead').name, 'Winkelchef');
    assert.equal(shop.routines, 2);
    const det = await t.api('GET', '/team-templates/webshop');
    const sc = det.bots.find((b: any) => b.name === 'Shopcontroleur');
    assert.equal(sc.routines[0].enabled, false);
    assert.ok(sc.routines[0].when.length > 3, 'schedule in words');
    assert.deepEqual(sc.skills.map((s: any) => [s.id, s.available]), [['webshopcheck', true]]);
    assert.equal(sc.specialist.field, 'Regels voor verkopen aan consumenten');
    await assert.rejects(t.api('GET', '/team-templates/bestaat-niet'), /404/);

    const pv = await t.api('POST', '/team-templates/webshop/preview', { answers: answersFor(templateDef('webshop')!), skills: true });
    assert.equal(pv.lead, 'Winkelchef');
    assert.equal(pv.routines, 2);
    assert.match(pv.profileText, /Testbedrijf webshop/);
    assert.match(pv.instructions, /Testbedrijf webshop/);
    assert.ok(pv.bots.find((b: any) => b.name === 'Productschrijver').skills.some((s: any) => s.name === 'productbeschrijving'));
    assert.equal(pv.bots.every((b: any) => b.access_mode === 'ask'), true);
    assert.equal((await t.api('GET', '/agents')).length, 0, 'a preview creates nothing');
    assert.equal((await t.api('GET', '/rooms')).length, 0);

    const old = await t.api('GET', '/rooms/templates');
    assert.equal(old.length, 16);
    const out = await t.api('POST', '/rooms/packages/install', { templateId: 'klantcontact', provider_id: t.providerId, model: 'mock-1' });
    assert.deepEqual(out.agents.map((a: any) => a.name), ['Klanthulp', 'Kennisbeheerder', 'Antwoordcontroleur']);
  } finally {
    await t.close();
  }
});

test('install: a team from every template with the mock provider; the profile is filled and nothing runs by itself', async () => {
  const t = await app();
  try {
    const store = t.app.ctx.store;
    let bots = 0;
    for (const d of TEMPLATE_DEFS) {
      const out = await t.api('POST', `/team-templates/${d.id}/install`, { answers: answersFor(d), provider_id: t.providerId, model: 'mock-1' });
      bots += d.bots.length;
      const room = await t.api('GET', `/rooms/${out.roomId}`);
      assert.equal(room.name, d.name);
      assert.equal(room.mode, 'lead');
      assert.equal(room.bots.length, d.bots.length);
      assert.equal(room.bots.find((b: any) => b.agentId === room.lead_agent_id).name, d.bots.find((b) => b.lead)!.name, `${d.id}: team lead`);
      assert.match(room.instructions, new RegExp(`Testbedrijf ${d.id}`), `${d.id}: profile in the team instructions`);
      const prof = await t.api('GET', `/team-templates/profile/${out.roomId}`);
      assert.equal(prof.profile.name, `Testbedrijf ${d.id}`);
      assert.deepEqual(prof.template, { id: d.id, version: d.version });
      for (const a of out.agents) {
        const agent = store.agent(a.id)!;
        assert.equal(agent.access_mode, 'ask', `${d.id}/${a.name}: vraagt toestemming`);
        assert.equal(agent.provider_id, t.providerId);
        const def = d.bots.find((b) => b.name === a.name)!;
        assert.deepEqual(agent.settings.specialist || null, def.specialist ? { field: def.specialist.field, suggestedSources: def.specialist.suggestedSources } : null, `${d.id}/${a.name}: specialist`);
      }
      assert.equal(out.warnings.length, 0, `${d.id}: ${out.warnings.join(' | ')}`);
    }
    assert.equal((await t.api('GET', '/agents')).length, bots);

    // Nothing runs by itself: every routine is paused with a reason, nothing is scheduled, no run was started.
    const rts = store.all<any>('SELECT status, next_run_at, paused_reason FROM routines');
    assert.equal(rts.length, TEMPLATE_DEFS.reduce((n, d) => n + d.bots.reduce((m, b) => m + (b.routines?.length || 0), 0), 0));
    for (const r of rts) {
      assert.equal(r.status, 'paused');
      assert.equal(r.next_run_at, null);
      assert.match(r.paused_reason, /staat uit/);
    }
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(store.all('SELECT id FROM runs').length, 0, 'no run started');
    assert.equal(store.all("SELECT id FROM threads WHERE kind = 'channel'").length, 0, 'no chat app linked');

    // The lead gets the profile in the team chat.
    const shop = (await t.api('GET', '/rooms')).find((r: any) => r.name === 'Webshop');
    t.script.push({ text: 'Ik maak een plan.' });
    const msgs = await t.say(shop.thread_id, 'Schrijf een productpagina voor ons roggebrood.');
    assert.ok(msgs.some((m: any) => m.author_name === 'Winkelchef' && m.content === 'Ik maak een plan.'));
    const sys = JSON.stringify(t.requests.at(-1));
    assert.match(sys, /Testbedrijf webshop/);
    assert.match(sys, /Controleer het werk tegen het/);
  } finally {
    await t.close();
  }
});

test('install with skills: the suggested catalogue skills are installed for the right bots', async () => {
  const t = await app();
  try {
    const out = await t.api('POST', '/team-templates/seo-en-content/install', { skills: true, provider_id: t.providerId, model: 'mock-1' });
    const owner = t.app.ctx.auth.owner()!;
    const lib = t.app.ctx.services.skills.list(owner.id).map((s: any) => s.name);
    const d = templateDef('seo-en-content')!;
    for (const b of d.bots) {
      const a = t.app.ctx.store.agent(out.agents.find((x: any) => x.name === b.name).id)!;
      const names = t.app.ctx.services.skills.enabledFor(a).map((s: any) => s.name).sort();
      assert.deepEqual(names, (b.skills || []).map((s) => s.id).sort(), `${b.name}: its own skills`);
      for (const n of names) assert.ok(lib.includes(n));
    }
    // Without the option no skill is installed.
    await t.api('POST', '/team-templates/webshop/install', { provider_id: t.providerId, model: 'mock-1' });
    assert.equal(t.app.ctx.services.skills.list(owner.id).length, lib.length);
  } finally {
    await t.close();
  }
});

test('install with the teams module: one team per template with its bots, team lead and business profile', async () => {
  const t = await app(true);
  try {
    // Only the public teams service (no internal handle): what other modules may use to make and change teams.
    const teams = t.app.ctx.services.teams;
    for (const m of ['list', 'own', 'create', 'update', 'setHome', 'remove']) assert.equal(typeof teams[m], 'function', `ctx.services.teams.${m}`);
    delete teams._service;
    assert.equal((await t.api('GET', '/teams')).length, 0, 'a new install starts empty');
    const out = await t.api('POST', '/team-templates/webshop/install', { answers: answersFor(templateDef('webshop')!), provider_id: t.providerId, model: 'mock-1' });
    let list = await t.api('GET', '/teams');
    assert.deepEqual(list.map((x: any) => x.name), ['Webshop'], 'one team, no stray "Mijn team"');
    const team = list[0];
    assert.equal(team.id, out.teamId);
    assert.equal(team.profile.company, 'Testbedrijf webshop');
    assert.match(team.profile.about, /Webwinkel: https:\/\/www\.voorbeeld\.nl/);
    assert.equal(team.leadName, 'Winkelchef');
    assert.equal(team.bots.length, 4);
    // The profile lives in the team (it reaches every bot); the group instructions do not repeat it.
    const room = await t.api('GET', `/rooms/${out.roomId}`);
    assert.doesNotMatch(room.instructions, /Bedrijfsprofiel/);
    t.script.push({ text: 'Begrepen.' });
    await t.say(out.threadId, 'Wat verkopen we?');
    assert.match(JSON.stringify(t.requests.at(-1)), /Testbedrijf webshop/, 'the lead gets the team profile');

    // The same template again gets a free name; a private template goes into an existing team.
    const again = await t.api('POST', '/team-templates/webshop/install', { provider_id: t.providerId, model: 'mock-1' });
    const own = await t.api('POST', '/teams', { name: 'Thuis', profile: { company: 'Gezin Jansen' } });
    const home = await t.api('POST', '/team-templates/prive-huishouden/install', { teamId: own.id, answers: { voor: 'Iemand anders', regels: 'Geen vlees op maandag' }, provider_id: t.providerId, model: 'mock-1' });
    list = await t.api('GET', '/teams');
    assert.deepEqual(list.map((x: any) => x.name), ['Webshop', 'Webshop 2', 'Thuis']);
    assert.equal(list[1].id, again.teamId);
    const thuis = list.find((x: any) => x.id === own.id);
    assert.equal(home.teamId, own.id);
    assert.equal(thuis.profile.company, 'Gezin Jansen', 'what the owner wrote stays');
    assert.equal(thuis.profile.rules, 'Geen vlees op maandag', 'empty fields are filled');
    assert.equal(thuis.leadName, 'Huisplanner');
    assert.equal(thuis.bots.length, 4);
    assert.ok(home.warnings.some((w: string) => /alleen de lege velden/.test(w)));

    // All or nothing: a failing install leaves no empty team behind.
    await assert.rejects(t.api('POST', '/team-templates/reizen/install', { provider_id: 'bestaat-niet' }), /Onbekende provider/);
    assert.equal((await t.api('GET', '/teams')).length, 3);
    assert.equal(t.app.ctx.store.all('SELECT id FROM runs WHERE thread_id NOT IN (?)', out.threadId).length, 0, 'nothing else ran');
  } finally {
    await t.close();
  }
});
