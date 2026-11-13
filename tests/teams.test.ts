import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { createApp } from '../server/app.js';
import { modules as allModules } from '../server/modules/index.js';
import { agentRootList } from '../server/tools/builtin/files.js';

// These tests are about bots that are not the main bot: without this the first bot would be it (teams `autoMain`,
// covered in works-right-away.test.ts).
process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

test('fresh install starts empty; the first bot creates the default team; one team adds no team text to prompts', async () => {
  const t = await startTestApp();
  try {
    assert.deepEqual(await t.api('GET', '/teams'), [], 'no team before the first bot');
    assert.equal(t.app.ctx.store.all('SELECT id FROM teams').length, 0);
    const a = await t.agent({ name: 'Ada' });
    const teams = await t.api('GET', '/teams');
    assert.equal(teams.length, 1);
    assert.equal(teams[0].name, 'Mijn team');
    assert.equal(teams[0].isDefault, true);
    assert.deepEqual(teams[0].bots.map((b: any) => b.name), ['Ada']);
    assert.deepEqual(teams[0].access, []);

    // One team: nothing about teams in the system prompt or the turn context (no profile filled in).
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'hoi' });
    await t.say(th.id, 'hallo');
    const req = t.requests.at(-1)!;
    assert.doesNotMatch(req.system, /## Teams|Bedrijfsprofiel/);
    assert.doesNotMatch(JSON.stringify(req.messages), /Bedrijfsprofiel/);
  } finally {
    await t.close();
  }
});

test('upgrade from 0.3: bots, org chart, tasks and the team folder all go into one team "Mijn team"', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-teams-up-'));
  const folder = path.join(dir, 'Gedeeld');
  fs.mkdirSync(folder);
  // 0.3: the same app without the teams module.
  const old = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true, modules: allModules.filter((m) => m.id !== 'teams') });
  const owner = old.ctx.auth.ensureLocalOwner() && old.ctx.store.users()[0].id;
  const s = old.ctx.store;
  const chief = s.createAgent(owner, { name: 'Chef' });
  const helper = s.createAgent(owner, { name: 'Helper' });
  const archived = s.createAgent(owner, { name: 'Oud' });
  s.updateAgent(archived.id, { archived: true });
  s.setSetting(owner, 'teamFolder', { path: folder, label: 'Gedeelde teammap', mode: 'rw', agents: 'all' });
  const ts = new Date().toISOString();
  s.insert('room_teams', { id: 'team_org', user_id: owner, parent_id: null, name: 'Directie', description: '', chief_agent_id: chief.id, created_at: ts, updated_at: ts });
  s.insert('room_teams', { id: 'team_sub', user_id: owner, parent_id: 'team_org', name: 'Verkoop', description: '', chief_agent_id: helper.id, created_at: ts, updated_at: ts });
  s.insert('room_tasks', { id: 'task_old', user_id: owner, title: 'Oude taak', status: 'todo', created_by_type: 'user', created_at: ts, updated_at: ts });
  await old.close();

  const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
  try {
    const st = app.ctx.store;
    const teams = st.find<any>('teams', { user_id: owner });
    assert.equal(teams.length, 1);
    assert.equal(teams[0].name, 'Mijn team');
    assert.equal(teams[0].lead_agent_id, chief.id, 'the single top-level chief of staff leads the team');
    assert.equal(path.resolve(teams[0].folder.path), path.resolve(folder), 'the old team folder is the team folder now');
    assert.equal(st.getSetting(owner, 'teamFolder', null), null);
    assert.deepEqual(st.all<any>('SELECT agent_id FROM team_bots ORDER BY agent_id').map((r) => r.agent_id).sort(), [chief.id, helper.id, archived.id].sort(), 'every bot, archived ones too');
    assert.deepEqual(st.all<any>('SELECT workspace_id FROM room_teams').map((r) => r.workspace_id), [teams[0].id, teams[0].id], 'the org chart is filed under the team');
    assert.equal(st.get<any>('room_tasks', 'task_old').workspace_id, teams[0].id);
    // The bots still get the folder.
    assert.ok(agentRootList(st.agent(helper.id)!).some((r) => r.kind === 'team' && path.resolve(r.path) === path.resolve(folder)));
    // A second start changes nothing.
    await app.close();
    const again = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
    assert.equal(again.ctx.store.all('SELECT id FROM teams').length, 1);
    await again.close();
  } finally {
    try {
      await app.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
});

test('teams API: create, rename, colour, profile, lead, move a bot, access per bot, key scope, delete only when empty', async () => {
  const t = await startTestApp();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-teams-api-'));
  try {
    const a = await t.agent({ name: 'Ada' });
    const b = await t.agent({ name: 'Bo' });
    const [mine] = await t.api('GET', '/teams');
    await assert.rejects(t.api('POST', '/teams', { name: '  ' }), /naam/);
    await assert.rejects(t.api('POST', '/teams', { name: 'mijn TEAM' }), /al een team/);
    const shop = await t.api('POST', '/teams', { name: 'Webshop', color: '#0EA5E9', profile: { company: 'Shop BV', about: 'Verkoopt thee.', tone: 'Vriendelijk', rules: 'Altijd u.', extra: 'genegeerd' } });
    assert.equal(shop.color, '#0ea5e9');
    assert.deepEqual(shop.profile, { company: 'Shop BV', about: 'Verkoopt thee.', tone: 'Vriendelijk', rules: 'Altijd u.' });
    assert.equal(shop.isDefault, false);
    // The other team's bots are listed for access, all at "none".
    assert.deepEqual(shop.access.map((x: any) => [x.name, x.level, x.homeTeamName]), [['Ada', 'none', 'Mijn team'], ['Bo', 'none', 'Mijn team']]);

    // Move Bo into the webshop team and make him lead; a bot of another team cannot be lead.
    await assert.rejects(t.api('PATCH', `/teams/${shop.id}`, { leadAgentId: a.id }), /hoort niet bij dit team/);
    await t.api('PUT', `/teams/${shop.id}/bots/${b.id}`);
    const led = await t.api('PATCH', `/teams/${shop.id}`, { leadAgentId: b.id, name: 'Webwinkel', profile: { tone: 'Zakelijk' } });
    assert.equal(led.leadName, 'Bo');
    assert.equal(led.name, 'Webwinkel');
    assert.equal(led.profile.tone, 'Zakelijk');
    assert.equal(led.profile.company, 'Shop BV', 'a partial profile keeps the other fields');

    // Access: read and direct for Ada; never for the bot's own home team.
    await assert.rejects(t.api('PUT', `/teams/${shop.id}/access/${b.id}`, { level: 'read' }), /thuisteam/);
    await assert.rejects(t.api('PUT', `/teams/${shop.id}/access/${a.id}`, { level: 'alles' }), /meekijken of aansturen/);
    const acc = await t.api('PUT', `/teams/${shop.id}/access/${a.id}`, { level: 'direct' });
    assert.equal(acc.access.find((x: any) => x.agentId === a.id).level, 'direct');
    const botView = await t.api('GET', `/teams/bots/${a.id}`);
    assert.equal(botView.homeTeamId, mine.id);
    assert.deepEqual(botView.teams.map((x: any) => [x.name, x.reach]), [['Mijn team', 'home'], ['Webwinkel', 'direct']]);

    // Moving Bo back: he stops being the webshop's lead.
    await t.api('PUT', `/teams/${mine.id}/bots/${b.id}`);
    assert.equal((await t.api('GET', `/teams/${shop.id}`)).leadAgentId, null);

    // Keys: listed with their scope; a team-only key blocks deleting that team.
    const keys = await t.api('GET', '/teams/keys');
    const k = keys.find((x: any) => x.kind === 'provider' && x.id === t.providerId);
    assert.equal(k.teamId, null);
    await assert.rejects(t.api('PUT', '/teams/keys/provider/prv_bestaatniet', { teamId: shop.id }), /niet gevonden/);
    await assert.rejects(t.api('PUT', '/teams/keys/geheim/x', { teamId: shop.id }), /Onbekende soort/);
    assert.equal((await t.api('PUT', `/teams/keys/provider/${t.providerId}`, { teamId: shop.id })).teamId, shop.id);
    await assert.rejects(t.api('DELETE', `/teams/${shop.id}`), /1 sleutel alleen voor dit team/);
    await t.api('PUT', `/teams/keys/provider/${t.providerId}`, { teamId: null });

    // Team folders never overlap.
    const fa = path.join(root, 'A');
    await t.api('PUT', '/folders/team', { teamId: mine.id, path: fa, create: true });
    await assert.rejects(t.api('PUT', '/folders/team', { teamId: shop.id, path: path.join(fa, 'sub'), create: true }), /overlapt met de teammap van “Mijn team”/);
    const ft = await t.api('GET', `/folders/team?teamId=${shop.id}`);
    assert.equal(ft.folder, null);
    assert.deepEqual(ft.teams.map((x: any) => x.name), ['Mijn team', 'Webwinkel']);
    assert.match(ft.suggestion, /TeamBot[\\/]Webwinkel$/, 'another team gets its own suggested folder');
    assert.notEqual((await t.api('GET', '/folders/team')).suggestion, ft.suggestion);

    // Delete: refused while it has bots, fine when empty; access rows go with it.
    await t.api('PUT', `/teams/${shop.id}/bots/${a.id}`);
    await assert.rejects(t.api('DELETE', `/teams/${shop.id}`), /nog 1 bot/);
    await t.api('PUT', `/teams/${mine.id}/bots/${a.id}`);
    await t.api('DELETE', `/teams/${shop.id}`);
    assert.equal((await t.api('GET', '/teams')).length, 1);
    assert.equal(t.app.ctx.store.all('SELECT id FROM team_access').length, 0);

    // A deleted bot leaves no rows behind.
    await t.api('DELETE', `/agents/${b.id}`);
    assert.equal(t.app.ctx.store.all('SELECT agent_id FROM team_bots WHERE agent_id = ?', b.id).length, 0);
  } finally {
    await t.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('business profile: in the turn context of the team’s bots, repeated only when it changed or after a while', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Ada' });
    const [team] = await t.api('GET', '/teams');
    await t.api('PATCH', `/teams/${team.id}`, { profile: { company: 'Bakkerij Jansen', rules: 'Noem nooit prijzen.' } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const ctxOf = () => t.app.ctx.store.messages(th.id).filter((m) => m.role === 'user').map((m) => m.parts?.context || '');
    t.script.push({ text: 'een' }, { text: 'twee' }, { text: 'drie' });
    await t.say(th.id, 'eerste');
    await t.say(th.id, 'tweede');
    let c = ctxOf();
    assert.match(c[0], /Bedrijfsprofiel van team “Mijn team”[\s\S]*Bedrijf: Bakkerij Jansen[\s\S]*Regels: Noem nooit prijzen\./);
    assert.doesNotMatch(c[1], /Bedrijfsprofiel/, 'not repeated in the next turn');
    // Changed profile: said again.
    await t.api('PATCH', `/teams/${team.id}`, { profile: { rules: 'Noem nooit prijzen. Zeg altijd u.' } });
    await t.say(th.id, 'derde');
    c = ctxOf();
    assert.match(c[2], /Zeg altijd u\./);
    // The profile is not in the (cached) system prompt.
    assert.doesNotMatch(t.requests.at(-1)!.system, /Bakkerij Jansen/);
    // A bot of another team gets that team's profile, not this one.
    const other = await t.api('POST', '/teams', { name: 'Webshop', profile: { company: 'Shop BV' } });
    const b = await t.agent({ name: 'Bo', settings: { homeTeam: other.id } });
    const th2 = await t.api('POST', '/threads', { agentId: b.id });
    t.script.push({ text: 'ok' });
    await t.say(th2.id, 'hallo');
    const ctx2 = t.app.ctx.store.messages(th2.id).find((m) => m.role === 'user')!.parts?.context || '';
    assert.match(ctx2, /Bedrijf: Shop BV/);
    assert.doesNotMatch(ctx2, /Bakkerij Jansen/);
  } finally {
    await t.close();
  }
});

test('a bot lands in the team it was made for whoever asks first, and a bot that is being deleted gets no team again', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const userId = ctx.auth.owner()!.id;
    const teams = ctx.services.teams;
    await t.agent({ name: 'Ada' });
    const second = await t.api('POST', '/teams', { name: 'Tweede' });
    // A module asks for the team of a new bot before the teams module heard of it (a listener that runs earlier, or a
    // bot made in the store): the bot still lands in the team it was made for, not in the default team for good.
    const bo = ctx.store.createAgent(userId, { name: 'Bo', settings: { homeTeam: second.id } });
    assert.equal(teams.teamOf(bo.id), second.id, 'the team named in settings.homeTeam');
    ctx.events.emit(userId, 'agent.updated', bo);
    assert.equal(teams.teamOf(bo.id), second.id);

    // A module that still asks for the bot's team while it is being deleted (after the teams module let it go, before
    // its row is gone) must not write it back into the team: the team could never be emptied.
    const asked: (string | null)[] = [];
    const off = ctx.events.on('teams.changed', () => void asked.push(teams.teamOf(bo.id)));
    await t.api('DELETE', `/agents/${bo.id}`);
    off();
    assert.ok(asked.length > 0, 'a module asked during the deletion');
    assert.equal(ctx.store.all('SELECT agent_id FROM team_bots WHERE agent_id = ?', bo.id).length, 0, 'no row left behind');
    await t.api('DELETE', `/teams/${second.id}`);
    assert.deepEqual((await t.api('GET', '/teams')).map((x: any) => x.name), ['Mijn team'], 'the empty team can go');
  } finally {
    await t.close();
  }
});
