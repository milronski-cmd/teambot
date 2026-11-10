import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { Module } from '../server/core/types.js';
import { startTestApp } from './helpers.js';
import { DECOY_SECRETS } from './fixtures/openbot-fixture.js';
import { TEAM_DECOY_SECRETS, makeOpenBotTeamFixture } from './fixtures/openbot-team-fixture.js';
import { readOpenBot, skillText } from '../server/modules/openbot-import/reader.js';
import { fieldOf, firstSentence, isCustomerRoutine, pickBoss, pickSpecialists, proposeTeamName, sourcesOf } from '../server/modules/openbot-import/roles.js';
import { createOpenBotImportModule } from '../server/modules/openbot-import/index.js';
import { createFoldersModule } from '../server/modules/folders/index.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import teams from '../server/modules/teams/index.js';
import teamdata from '../server/modules/teamdata/index.js';
import skills from '../server/modules/skills/index.js';
import memory from '../server/modules/memory/index.js';
import cliAgents from '../server/modules/cli-agents/index.js';

/**
 * The OpenBot team lands in the 0.4 model: one team (folder + team tables), the boss as main bot (or team lead when
 * the main-bot role is not there), the knowledge bot as specialist (or a normal bot), every routine off. Preview first,
 * one import, undo removes it again. Synthetic OpenBot data only; OpenBot's files stay byte-identical throughout.
 */

const SECRETS = [...DECOY_SECRETS, ...TEAM_DECOY_SECRETS];
const fakeDetect = () => async (kind: string) => (kind === 'claude-code' || kind === 'opencode' ? { installed: true, loggedIn: true, version: 'test' } : { installed: false });

/** Stand-ins for the main-bot role (package C) and specialists (package S), so the feature detection is tested. */
function fakeMainAndSpecialists(calls: { main: string[]; cleared: number; specialists: { agentId: string; spec: any }[] }): Module {
  return {
    id: 'test-main-specialists',
    label: 'test',
    init(ctx) {
      const main = new Map<string, string>();
      Object.assign(ctx.services.teams, {
        mainOf: (u: string) => {
          const id = main.get(u);
          return id && ctx.store.agent(id) ? id : null;
        },
        setMain: (u: string, a: string) => {
          const cur = main.get(u);
          if (cur && cur !== a && ctx.store.agent(cur)) throw new Error('Je hebt al een hoofdbot.');
          main.set(u, a);
          calls.main.push(a);
          return { notes: [] };
        },
        clearMain: (u: string) => {
          main.delete(u);
          calls.cleared++;
        },
      });
      // The real entry of package S: importForAgent(userId, agentId, { field, suggestedSources }).
      const made = new Set<string>();
      ctx.services.specialists = {
        importForAgent: (_u: string, agentId: string, spec: any) => (calls.specialists.push({ agentId, spec }), made.add(agentId), true),
        profile: (agentId: string) => (made.has(agentId) ? { enabled: true } : null),
      };
    },
  };
}

/**
 * The main-bot role (package C2) is part of the real teams module now; these scenarios test the import without it
 * (the boss becomes team lead), so the default test app takes it out again.
 */
function withoutMainRole(): Module {
  return {
    id: 'test-no-main-role',
    label: 'test',
    init(ctx) {
      for (const k of ['setMain', 'mainOf', 'clearMain']) delete ctx.services.teams[k];
    },
  };
}

async function app(fx: ReturnType<typeof makeOpenBotTeamFixture>, extra: Module[] = [withoutMainRole()]) {
  return startTestApp({
    modules: [cliAgents, memory, skills, createRoutinesModule(), teams, createFoldersModule(), teamdata, ...extra, createOpenBotImportModule({ paths: () => ({ dataDir: fx.dataDir, home: fx.home }), detect: fakeDetect })],
  });
}

/** The commit body the page sends with every proposal as it is. */
function asProposed(plan: any) {
  return {
    stagingId: plan.stagingId,
    team: plan.team.choice,
    mainBot: plan.roles.main,
    lead: plan.roles.lead,
    specialists: Object.fromEntries(plan.roles.specialists.map((s: any) => [s.key, { selected: s.selected, field: s.field, sources: s.sources }])),
    bots: Object.fromEntries(plan.bots.map((b: any) => [b.key, { selected: b.selected, workspace: b.workspace.default }])),
    routines: plan.routines.filter((r: any) => r.selected).map((r: any) => r.key),
    skills: plan.skills.filter((s: any) => s.selected).map((s: any) => s.key),
    memories: 'active',
    shared: plan.shared.selected,
    teamData: !!plan.teamData?.selected,
  };
}

function counts(t: Awaited<ReturnType<typeof app>>) {
  const n = (sql: string) => Number(t.app.ctx.store.one<{ n: number }>(sql)?.n || 0);
  return { agents: n('SELECT COUNT(*) AS n FROM agents'), teams: n('SELECT COUNT(*) AS n FROM teams'), routines: n('SELECT COUNT(*) AS n FROM routines'), skills: n('SELECT COUNT(*) AS n FROM skills'), providers: n('SELECT COUNT(*) AS n FROM providers'), memories: n("SELECT COUNT(*) AS n FROM memory_items WHERE status IN ('active','proposed')") };
}

test('roles: Baas is the boss (not Baas Live), Kennis & Kansen the specialist with field and sources, inbox routines are customer work', () => {
  const fx = makeOpenBotTeamFixture();
  try {
    const snap = readOpenBot({ dataDir: fx.dataDir, home: fx.home }, path.join(fx.root, 'tmp'));
    assert.equal(snap.agents.length, 8);
    assert.equal(snap.workspaceName, '', 'the default name "OpenBot" is no team name');
    const boss = pickBoss(snap.agents);
    assert.equal(boss.key, fx.team.baas);
    assert.match(boss.reason, /naam “Baas”/);
    // Two equal bosses: none is guessed.
    const twin = { ...snap.agents.find((a) => a.id === fx.team.baas)!, id: 'x', name: 'Baas' };
    assert.equal(pickBoss([...snap.agents, twin]).key, null);
    // Without Baas, Baas Live (a voice line) is not the boss.
    assert.equal(pickBoss(snap.agents.filter((a) => a.id !== fx.team.baas)).key, null);
    // A lead marker in OpenBot counts.
    assert.equal(pickBoss(snap.agents.map((a) => (a.id === fx.team.ops ? { ...a, lead: true } : a)).filter((a) => a.id !== fx.team.baas)).key, fx.team.ops);

    const sp = pickSpecialists(snap.agents, snap.routines, snap.skills, skillText, boss.key);
    assert.deepEqual(
      sp.map((s) => s.key),
      [fx.team.kennis],
      'only the knowledge bot (SEO & Content applies knowledge but has no knowledge round)',
    );
    assert.equal(sp[0].field, 'Je houdt het team elke dag op de hoogte van nieuwe kennis over SEO en Google Ads.');
    assert.deepEqual(sp[0].rounds, ['Kennisronde ochtend', 'Kansenronde']);
    const labels = sp[0].sources.map((s) => s.label);
    for (const l of ['Google Search Central', 'SE Roundtable', 'Reddit', 'nieuwsbrieven', 'developers.google.com/search/blog', 'r/SEO', 'r/PPC', 'seroundtable.com']) assert.ok(labels.includes(l), `source ${l}`);
    assert.ok(!sp[0].sources.some((s) => /<|%3C/.test(s.url || '')), 'a link template is no source');
    assert.equal(sp[0].sources.find((s) => s.label === 'r/SEO')!.url, 'https://www.reddit.com/r/SEO/');

    const klant = snap.agents.find((a) => a.id === fx.team.klant)!;
    const byName = (n: string) => snap.routines.find((r) => r.name === n)!;
    assert.equal(isCustomerRoutine(byName('Inbox beantwoorden'), klant.name), true);
    assert.equal(isCustomerRoutine(byName('Inbox-ronde'), klant.name), true);
    assert.equal(isCustomerRoutine(byName('Orders-ronde'), 'Operations'), false, 'only the customer service bot');

    assert.deepEqual(proposeTeamName('', []), { name: 'Mijn team', fromOpenBot: false });
    assert.deepEqual(proposeTeamName('Webshops', []), { name: 'Webshops', fromOpenBot: true });
    assert.deepEqual(proposeTeamName('', ['Mijn team']), { name: 'Team uit OpenBot', fromOpenBot: false });
    assert.equal(firstSentence('**Vak:** SEO. En meer.'), 'Vak: SEO.');
    assert.equal(fieldOf({ instructions: '# X\n\nVakgebied: belastingen voor zzp’ers\n', description: '' }), 'belastingen voor zzp’ers');
    assert.deepEqual(sourcesOf(['Bronnen: Alfa, Beta (met uitleg); Gamma. Daarna iets anders.']).map((s) => s.label), ['Alfa', 'Beta', 'Gamma']);
    // Logins, tokens, APIs and this computer are tools, not sources.
    const links = 'Token: https://oauth2.googleapis.com/token, https://accounts.example.com/login, https://api.example.com/v1, http://127.0.0.1:1234/v1, https://example.org/blog/ en https://author.example.net/';
    assert.deepEqual(sourcesOf([links]).map((s) => s.label), ['example.org/blog', 'author.example.net']);
  } finally {
    fx.cleanup();
  }
});

test('preview is a dry run: one team, Baas as team lead (no main-bot role here), Kennis & Kansen as a normal bot, routines off; nothing written', async () => {
  const fx = makeOpenBotTeamFixture();
  const t = await app(fx);
  try {
    const before = fx.hashes();
    const c0 = counts(t);
    const plan = await t.api('POST', '/openbot-import/preview');
    assert.deepEqual(counts(t), c0, 'the preview writes nothing in TeamBot');
    for (const s of SECRETS) assert.ok(!JSON.stringify(plan).includes(s), 'no secret in the preview');

    assert.equal(plan.team.available, true);
    assert.equal(plan.team.name, 'Mijn team');
    assert.deepEqual(plan.team.choice, { mode: 'new', name: 'Mijn team' });
    assert.equal(plan.team.tablesPerTeam, true, 'B2: the tables go into the team database of the import\'s team');
    assert.equal(plan.bots.length, 8);
    assert.ok(plan.bots.every((b: any) => b.selected));

    assert.equal(plan.roles.mainAvailable, false);
    assert.equal(plan.roles.main, null, 'no main bot without the main-bot role');
    assert.equal(plan.roles.lead, fx.team.baas, 'the boss leads the team instead');
    assert.match(plan.roles.note, /hoofdbot staat in deze TeamBot niet aan.*Baas wordt teamleider/i);
    assert.equal(plan.roles.specialistsAvailable, false);
    assert.deepEqual(plan.roles.specialists.map((s: any) => s.name), ['Kennis & Kansen']);
    assert.match(plan.roles.specialistsNote, /gewone bot/);

    assert.ok(plan.routines.every((r: any) => r.off), 'every routine comes in switched off');
    const inbox = plan.routines.find((r: any) => r.name === 'Inbox beantwoorden');
    assert.equal(inbox.customer, true);
    assert.equal(inbox.wasActive, false);
    assert.ok(inbox.notes.some((n: string) => /testrun/.test(n)), 'customer routines get the extra note');
    assert.equal(plan.routines.filter((r: any) => r.customer).length, 2);

    assert.equal(plan.shared.selected, true);
    assert.equal(path.resolve(plan.shared.path), path.resolve(fx.home, 'OpenBot', 'Shared'));
    assert.deepEqual(plan.teamData.tables.map((x: any) => [x.name, x.rows]), [['beslissingen', 2], ['dagtotaal', 1], ['experimenten', 1], ['gebeurtenissen', 1], ['taken', 3]]);
    const not = plan.notImported.map((x: any) => x.what);
    assert.ok(not.includes('Gesprekken en bijlagen'));
    assert.ok(not.includes('Sleutels, tokens en wachtwoorden'));
    assert.ok(not.some((x: string) => /telegram/i.test(x)), 'channels: reconnect');
    assert.equal(plan.undo, false);
    assert.deepEqual(fx.hashes(), before, 'OpenBot untouched');
  } finally {
    await t.close();
    fx.cleanup();
  }
});

test('import creates exactly the preview; undo removes all of it; OpenBot untouched; importing again works', async () => {
  const fx = makeOpenBotTeamFixture();
  const t = await app(fx);
  try {
    const owner = t.app.ctx.auth.owner()!;
    const before = fx.hashes();
    const c0 = counts(t);
    const plan = await t.api('POST', '/openbot-import/preview');
    const res = await t.api('POST', '/openbot-import/commit', asProposed(plan));
    for (const s of SECRETS) assert.ok(!JSON.stringify(res).includes(s), 'no secret in the result');
    assert.equal(res.counts.memories, 3);

    // One team, with all eight bots, Baas as its lead and OpenBot's shared folder as its folder.
    const tsvc = t.app.ctx.services.teams;
    const list = tsvc.list(owner.id);
    assert.equal(list.length, 1);
    const team = list[0];
    assert.equal(team.name, 'Mijn team');
    assert.deepEqual(res.team, { id: team.id, name: 'Mijn team', created: true });
    const agents = t.app.ctx.store.agents(owner.id);
    assert.equal(agents.length, 8);
    assert.ok(agents.every((a) => tsvc.teamOf(a.id) === team.id), 'every bot is in the team');
    const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
    assert.equal(tsvc.lead(team.id), byName['Baas'].id);
    assert.equal(res.roles.lead.status, 'set');
    assert.equal(res.roles.main, null);
    assert.ok(!agents.some((a) => a.settings?.role === 'main'), 'no main bot made');
    assert.equal(path.resolve(tsvc.teamFolder(team.id).path), path.resolve(fx.home, 'OpenBot', 'Shared'));
    assert.equal(tsvc.teamFolder(team.id).agents, 'all');
    const roots = await t.api('GET', `/folders/roots?agentId=${byName['Bouwer'].id}`);
    assert.ok(roots.roots.some((r: any) => r.kind === 'team'), 'the team folder reaches the bots');

    // Kennis & Kansen: a normal bot (no specialists here), field and sources kept, its rounds off.
    const kk = byName['Kennis & Kansen'];
    assert.equal(kk.settings.specialist, undefined, 'not made a specialist without the specialists part');
    assert.equal(kk.settings.importedFrom.specialist.field, 'Je houdt het team elke dag op de hoogte van nieuwe kennis over SEO en Google Ads.');
    assert.ok(kk.settings.importedFrom.specialist.sources.length >= 6);
    assert.deepEqual(res.roles.specialists.map((s: any) => [s.name, s.status]), [['Kennis & Kansen', 'bot']]);

    // Every routine off, with the list "staan uit tot jij ze aanzet"; customer routines with their own reason.
    const routines = t.app.ctx.services.routines.list(owner.id);
    assert.equal(routines.length, plan.routines.filter((r: any) => r.selected).length);
    assert.ok(routines.every((r: any) => r.status === 'paused' && r.next_run_at === null));
    assert.equal(res.routinesOff.length, routines.length);
    const inbox = routines.find((r: any) => r.name === 'Inbox beantwoorden');
    assert.match(inbox.paused_reason, /testrun/);
    assert.match(routines.find((r: any) => r.name === 'Kennisronde ochtend').paused_reason, /OpenBot stopt/);
    assert.ok(res.attention.some((a: any) => /klantenservice-routines .*testrun/i.test(a.text)));

    // Team tables in the team database.
    const td = t.app.ctx.services.teamdata;
    assert.equal(res.counts.teamRows, 8);
    assert.equal((await td.rows(owner.id, 'SELECT COUNT(*) AS n FROM taken'))[0].n, 3);
    assert.ok((await td.tables(owner.id)).some((x: any) => x.name === 'dagtotaal' && x.owner.name === 'Operations'));
    assert.deepEqual(fx.hashes(), before, 'OpenBot untouched by the import');

    // Undo: first what it would remove (nothing changes), then removing it.
    const c1 = counts(t);
    const up = await t.api('GET', '/openbot-import/undo');
    assert.deepEqual(counts(t), c1);
    assert.equal(up.available, true);
    assert.equal(up.bots.length, 8);
    assert.deepEqual(up.teams.map((x: any) => [x.name, x.remove]), [['Mijn team', true]]);
    assert.equal(up.teamRows, 8);
    assert.deepEqual(up.tables, ['dagtotaal']);
    assert.ok(up.providers.some((p: any) => /Claude/.test(p.name)), 'the engine link the import made');
    const undone = await t.api('POST', '/openbot-import/undo');
    assert.equal(undone.bots, 8);
    assert.equal(undone.teams, 1);
    assert.equal(undone.teamRows, 8);
    assert.deepEqual(counts(t), c0, 'back to how it was: no bots, team, routines, skills, engine links or memories');
    assert.equal(tsvc.list(owner.id).length, 0);
    assert.equal((await td.rows(owner.id, 'SELECT COUNT(*) AS n FROM taken'))[0].n, 0);
    assert.ok(!(await td.tables(owner.id)).some((x: any) => x.name === 'dagtotaal'), 'the table the import made is gone');
    for (const a of agents) if (a.settings.importedFrom.workspace === 'reference') assert.ok(fs.existsSync(a.workspace), `OpenBot folder of ${a.name} stays`);
    assert.deepEqual(fx.hashes(), before, 'OpenBot untouched by the undo');
    assert.equal((await t.api('GET', '/openbot-import/detect')).undoable, false);
    await assert.rejects(t.api('POST', '/openbot-import/undo'), /400/);

    // Importing again after an undo brings everything back, team rows included.
    const plan2 = await t.api('POST', '/openbot-import/preview');
    assert.ok(plan2.bots.every((b: any) => !b.existing && b.selected));
    const res2 = await t.api('POST', '/openbot-import/commit', asProposed(plan2));
    assert.equal(res2.counts.bots, 8);
    assert.equal(res2.counts.teamRows, 8);
    assert.equal(res2.counts.memories, 3, 'memories come back too (the undone ones stay in the trash)');
    assert.equal(res2.counts.routines, res.counts.routines);
    assert.equal(res2.counts.skills, res.counts.skills);
    assert.equal(tsvc.list(owner.id).length, 1);

    const logs = fs.readFileSync(path.join(t.dir, 'logs', 'server.log'), 'utf8');
    for (const s of SECRETS) assert.ok(!logs.includes(s), 'no secret in the log');
  } finally {
    await t.close();
    fx.cleanup();
  }
});

test('with the main-bot role and specialists: Baas becomes the main bot (not also team lead), Kennis & Kansen a specialist with its round off; never a second main bot', async () => {
  const fx = makeOpenBotTeamFixture({ workspaceName: 'Webshops Test' });
  const calls = { main: [] as string[], cleared: 0, specialists: [] as { agentId: string; spec: any }[] };
  const t = await app(fx, [fakeMainAndSpecialists(calls)]);
  try {
    const owner = t.app.ctx.auth.owner()!;
    const plan = await t.api('POST', '/openbot-import/preview');
    assert.equal(plan.team.name, 'Webshops Test', 'name from the OpenBot workspace');
    assert.equal(plan.team.nameFromOpenBot, true);
    assert.equal(plan.roles.mainAvailable, true);
    assert.equal(plan.roles.main, fx.team.baas);
    assert.equal(plan.roles.lead, null, 'the main bot stands above the teams');
    assert.deepEqual(plan.roles.specialists.map((s: any) => [s.name, s.selected]), [['Kennis & Kansen', true]]);

    // The owner edits the team name and the field in the preview.
    const body = asProposed(plan);
    body.team = { mode: 'new', name: 'Mijn webshops' };
    body.specialists[fx.team.kennis].field = 'SEO en Google Ads';
    const res = await t.api('POST', '/openbot-import/commit', body);
    assert.equal(res.team.name, 'Mijn webshops');
    const agents = t.app.ctx.store.agents(owner.id);
    const byName = Object.fromEntries(agents.map((a) => [a.name, a]));
    assert.deepEqual(calls.main, [byName['Baas'].id]);
    assert.equal(t.app.ctx.services.teams.mainOf(owner.id), byName['Baas'].id);
    assert.equal(res.roles.main.status, 'set');
    assert.equal(t.app.ctx.services.teams.lead(res.team.id), null);
    assert.equal(calls.specialists.length, 1);
    assert.equal(calls.specialists[0].agentId, byName['Kennis & Kansen'].id);
    // S's own entry (importForAgent): the field and the sources with a link, as suggestions; S keeps the round off.
    assert.deepEqual(Object.keys(calls.specialists[0].spec).sort(), ['field', 'suggestedSources']);
    assert.equal(calls.specialists[0].spec.field, 'SEO en Google Ads');
    assert.ok(calls.specialists[0].spec.suggestedSources.every((x: any) => typeof x.url === 'string' && x.url));
    assert.equal(byName['Kennis & Kansen'].settings.specialist.field, 'SEO en Google Ads');
    assert.ok(t.app.ctx.services.routines.list(owner.id, byName['Kennis & Kansen'].id).every((r: any) => r.status === 'paused'), 'its learning rounds are off');

    // Undo makes the main bot a normal bot again and removes everything.
    const undone = await t.api('POST', '/openbot-import/undo');
    assert.equal(undone.bots, 8);
    assert.equal(calls.cleared, 1);
    assert.equal(t.app.ctx.services.teams.list(owner.id).length, 0);

    // With a main bot already there, Baas is proposed as team lead, and asking for main anyway makes no second one.
    const mine = await t.agent({ name: 'Mijn hoofdbot' });
    t.app.ctx.services.teams.setMain(owner.id, mine.id);
    calls.main.length = 0;
    const plan2 = await t.api('POST', '/openbot-import/preview');
    assert.equal(plan2.roles.currentMain.name, 'Mijn hoofdbot');
    assert.equal(plan2.roles.main, null);
    assert.equal(plan2.roles.lead, fx.team.baas);
    assert.match(plan2.roles.note, /al een hoofdbot \(Mijn hoofdbot\)/);
    assert.deepEqual(plan2.team.choice, { mode: 'new', name: 'Webshops Test' }, 'a team with bots is not filled by default');
    const body2 = { ...asProposed(plan2), mainBot: fx.team.baas, lead: null };
    const res2 = await t.api('POST', '/openbot-import/commit', body2);
    assert.deepEqual(calls.main, [], 'no second main bot');
    assert.equal(t.app.ctx.services.teams.mainOf(owner.id), mine.id);
    assert.equal(res2.roles.main.status, 'lead');
    assert.match(res2.roles.main.note, /al een hoofdbot/);
    const baas = t.app.ctx.store.agents(owner.id).find((a) => a.name === 'Baas')!;
    assert.equal(t.app.ctx.services.teams.lead(res2.team.id), baas.id);
    // Undo leaves the team that was there before (and the owner's own main bot).
    await t.api('POST', '/openbot-import/undo');
    assert.equal(t.app.ctx.services.teams.list(owner.id).length, 1);
    assert.equal(t.app.ctx.services.teams.mainOf(owner.id), mine.id);
    assert.deepEqual(t.app.ctx.store.agents(owner.id).map((a) => a.name), ['Mijn hoofdbot']);
  } finally {
    await t.close();
    fx.cleanup();
  }
});

test('a team name that exists is refused before anything is written; an existing team can be chosen instead', async () => {
  const fx = makeOpenBotTeamFixture();
  const t = await app(fx);
  try {
    const owner = t.app.ctx.auth.owner()!;
    const tsvc = t.app.ctx.services.teams;
    const mine = await t.agent({ name: 'Eigen bot' });
    const def = tsvc.teamOf(mine.id);
    const c0 = counts(t);
    const plan = await t.api('POST', '/openbot-import/preview');
    assert.equal(plan.team.name, 'Team uit OpenBot', '"Mijn team" exists already');
    assert.deepEqual(plan.team.choice, { mode: 'new', name: 'Team uit OpenBot' }, 'a team with bots is not filled by default');
    await assert.rejects(t.api('POST', '/openbot-import/commit', { ...asProposed(plan), team: { mode: 'new', name: 'mijn team' } }), /400/);
    assert.deepEqual(counts(t), c0, 'nothing written');

    const plan2 = await t.api('POST', '/openbot-import/preview');
    const res = await t.api('POST', '/openbot-import/commit', { ...asProposed(plan2), team: { mode: 'existing', id: def } });
    assert.equal(res.team.created, false);
    assert.equal(tsvc.list(owner.id).length, 1);
    assert.equal(tsvc.botsOf(def).length, 9);
    // The existing team had no folder: it gets the shared folder, for the imported bots only.
    const tf = tsvc.teamFolder(def);
    assert.ok(Array.isArray(tf.agents) && !tf.agents.includes(mine.id));
    await t.api('POST', '/openbot-import/undo');
    assert.equal(tsvc.list(owner.id).length, 1, 'the team that was there stays');
    assert.equal(tsvc.teamFolder(def), null, 'its folder is back as it was');
    assert.equal(tsvc.lead(def), null);
    assert.deepEqual(t.app.ctx.store.agents(owner.id).map((a) => a.name), ['Eigen bot']);
  } finally {
    await t.close();
    fx.cleanup();
  }
});

test('with every real 0.4 part (C2 main bot, S specialists, B2 team databases): Baas the main bot, Kennis & Kansen a specialist, the tables in the team; undo takes all of it back', async () => {
  const fx = makeOpenBotTeamFixture();
  const { modules } = await import('../server/modules/index.js');
  // Every module as in the app, only the import reads the fixture (never this computer's OpenBot).
  const t = await startTestApp({ modules: modules.map((m) => (m.id === 'openbot-import' ? createOpenBotImportModule({ paths: () => ({ dataDir: fx.dataDir, home: fx.home }), detect: fakeDetect }) : m)) });
  try {
    const owner = t.app.ctx.auth.owner()!;
    const plan = await t.api('POST', '/openbot-import/preview');
    assert.equal(plan.roles.mainAvailable, true);
    assert.equal(plan.roles.specialistsAvailable, true);
    assert.equal(plan.team.tablesPerTeam, true);
    const res = await t.api('POST', '/openbot-import/commit', asProposed(plan));
    const tsvc = t.app.ctx.services.teams;
    const team = tsvc.list(owner.id)[0];
    const byName = Object.fromEntries(t.app.ctx.store.agents(owner.id).map((a) => [a.name, a]));
    assert.equal(tsvc.mainOf(owner.id), byName['Baas'].id, 'the real main bot (C2)');
    assert.equal(res.roles.main.status, 'set');
    const kk = t.app.ctx.services.specialists.profile(byName['Kennis & Kansen'].id);
    assert.equal(kk?.enabled, true, 'a real specialist (S)');
    assert.equal((await t.api('GET', `/specialists/${byName['Kennis & Kansen'].id}`)).learnOn, true, 'its learning round on, like every new specialist (the import said nothing else)');
    assert.deepEqual(res.roles.specialists.map((s: any) => [s.name, s.status]), [['Kennis & Kansen', 'specialist']]);
    const td = t.app.ctx.services.teamdata;
    const rowsIn = async (tbl: string) => (await td.rows(owner.id, `SELECT COUNT(*) AS n FROM ${tbl}`, [], true, team.id))[0]?.n ?? 0;
    assert.equal(await rowsIn('taken'), 3, 'the tasks in the team database of the import team (B2)');

    const undone = await t.api('POST', '/openbot-import/undo', {});
    assert.equal(undone.ok ?? true, true);
    assert.equal(tsvc.mainOf(owner.id), null, 'no main bot left');
    // The rows went from that team database (8 copied rows, also into tables that already existed, such as taken);
    // the team the import made is gone again, and so is B2's record of what came from OpenBot.
    assert.equal(undone.teamRows, 8, JSON.stringify(undone));
    assert.equal(tsvc.list(owner.id).length, 0);
    assert.equal(t.app.ctx.store.one<any>("SELECT COUNT(*) AS n FROM teamdata_imports WHERE user_id = ? AND source = 'openbot'", owner.id).n, 0);
    assert.equal(t.app.ctx.store.agents(owner.id).length, 0);
  } finally {
    await t.close();
    fx.cleanup();
  }
});
