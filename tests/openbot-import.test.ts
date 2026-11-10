import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestApp } from './helpers.js';
import { DECOY_SECRETS, makeOpenBotFixture } from './fixtures/openbot-fixture.js';
import { classifySkill, readOpenBot } from '../server/modules/openbot-import/reader.js';
import { mapAccess, mapEngine, mapSchedule } from '../server/modules/openbot-import/mapping.js';
import { createOpenBotImportModule } from '../server/modules/openbot-import/index.js';
import { createFoldersModule } from '../server/modules/folders/index.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import skills from '../server/modules/skills/index.js';
import memory from '../server/modules/memory/index.js';
import cliAgents from '../server/modules/cli-agents/index.js';

/** Fake engine detection: Claude Code + OpenCode are "installed", Codex is not. Never spawns a CLI. */
const fakeDetect = () => async (kind: string) => (kind === 'claude-code' || kind === 'opencode' ? { installed: true, loggedIn: true, version: 'test' } : { installed: false });

async function app(fx: ReturnType<typeof makeOpenBotFixture>, mode: 'desktop' | 'server' = 'desktop') {
  return startTestApp({
    mode,
    modules: [cliAgents, memory, skills, createRoutinesModule(), createFoldersModule(), createOpenBotImportModule({ paths: () => ({ dataDir: fx.dataDir, home: fx.home }), detect: fakeDetect })],
  });
}

function selection(plan: any, o: { workspace?: string } = {}) {
  return {
    stagingId: plan.stagingId,
    bots: Object.fromEntries(plan.bots.map((b: any) => [b.key, { selected: b.selected, workspace: o.workspace || b.workspace.default }])),
    routines: plan.routines.filter((r: any) => r.selected).map((r: any) => r.key),
    skills: plan.skills.filter((s: any) => s.selected).map((s: any) => s.key),
    memories: true,
    shared: plan.shared.selected,
  };
}

test('mapping: engines, access and every OpenBot schedule kind', () => {
  assert.equal(mapEngine('claude').kind, 'claude-code');
  assert.equal(mapEngine('codex').kind, 'codex-cli');
  assert.equal(mapEngine('opencode').kind, 'opencode');
  assert.equal(mapEngine('deepseek').kind, 'deepseek');
  assert.equal(mapEngine('lokaal-1', [{ id: 'lokaal-1', name: 'LM Studio', baseUrl: 'http://127.0.0.1:1234/v1' }]).kind, 'lmstudio');
  assert.equal(mapEngine('iets-nieuws').kind, null);
  assert.equal(mapAccess('full').mode, 'full');
  assert.equal(mapAccess('ask').mode, 'ask');
  const s = (x: any) => (mapSchedule(x) as any).schedule;
  assert.deepEqual(s({ kind: 'daily', time: '7:45' }), { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['07:45'] });
  assert.deepEqual(s({ kind: 'weekly', weekday: 0, time: '20:00' }), { kind: 'weekly', days: [0], times: ['20:00'] });
  assert.deepEqual(s({ kind: 'monthly', day: 1, time: '08:00' }), { kind: 'cron', expr: '0 8 1 * *' });
  assert.deepEqual(s({ kind: 'once', date: '2026-11-20', time: '09:00' }), { kind: 'once', at: '2026-11-20T09:00' });
  assert.deepEqual(s({ kind: 'interval', amount: 3, unit: 'hours', anchorAt: '2026-11-06T12:00:00+01:00' }), { kind: 'interval', everyMinutes: 180, anchor: '2026-11-06T11:00:00.000Z' });
  assert.deepEqual(s({ kind: 'custom', expression: '5 * * * *' }), { kind: 'cron', expr: '5 * * * *' });
  assert.ok('error' in mapSchedule({ kind: 'lunar' }));
});

test('reader: read-only snapshot without secrets; OpenBot skills are recognised', () => {
  const fx = makeOpenBotFixture();
  const tmp = fs.mkdtempSync(path.join(fx.root, 'tmp-'));
  try {
    const before = fx.hashes();
    const snap = readOpenBot({ dataDir: fx.dataDir, home: fx.home }, tmp);
    const after = fx.hashes();
    for (const [f, h] of Object.entries(before)) assert.equal(after[f], h, `unchanged: ${f}`);
    assert.deepEqual(fs.readdirSync(tmp), [], 'the private database copy is removed again');
    const text = JSON.stringify(snap);
    for (const secret of DECOY_SECRETS) assert.ok(!text.includes(secret), 'no secret in the snapshot');
    assert.equal(snap.agents.length, 2);
    const baas = snap.agents.find((a) => a.name === 'Baas')!;
    assert.match(baas.instructions, /baas van het testteam/);
    assert.equal(baas.instructionsSource, 'AGENTS.md');
    assert.equal(baas.backups.length, 3);
    assert.equal(baas.pinned, true);
    assert.ok(!snap.agents.find((a) => a.name === 'Klantenservice')!.instructions.startsWith('﻿'), 'BOM stripped');
    assert.equal(snap.routines.length, 7);
    assert.equal(snap.memories.length, 3);
    assert.deepEqual(snap.mcpServers, [{ name: 'Testapp', transport: 'stdio', enabled: true }]);
    assert.deepEqual(snap.channels, [{ id: 'c1', platform: 'telegram', name: 'Testgroep', enabled: true, agentId: null, senders: [] }]);
    const byName = Object.fromEntries(snap.skills.map((s) => [s.name, s]));
    assert.equal(byName['dossier-bijwerken'].klass, 'own');
    assert.equal(byName['dossier-bijwerken'].scope, 'team', 'the team copy wins');
    assert.equal(byName['dossier-bijwerken'].variants, 2);
    assert.equal(byName['beheerde-skill'].klass, 'openbot');
    assert.equal(byName['markt-skill'].klass, 'openbot');
    assert.equal(byName['vrije-skill'].klass, 'permissive');
    assert.equal(classifySkill(path.join(fx.workspace(fx.agents.baas), '.agents', 'skills', 'markt-skill')).license, 'PolyForm Noncommercial');
  } finally {
    fx.cleanup();
  }
});

test('reader sees writes that are still in the WAL of a running OpenBot, without touching its files', () => {
  const fx = makeOpenBotFixture();
  const live = new DatabaseSync(path.join(fx.dataDir, 'openbot.db'));
  try {
    live.exec('PRAGMA journal_mode = WAL; PRAGMA wal_autocheckpoint = 0;');
    live.prepare("INSERT INTO projection_agent_memories VALUES ('m9', ?, 'Alleen in de WAL.', 'alleen in de wal.', 'automatic', NULL, '2026-11-07', '2026-11-07', 2)").run(fx.agents.klant);
    assert.ok(fs.existsSync(path.join(fx.dataDir, 'openbot.db-wal')));
    const before = fx.hashes();
    const snap = readOpenBot({ dataDir: fx.dataDir, home: fx.home }, path.join(fx.root, 'tmp'));
    assert.ok(snap.memories.some((m) => m.text === 'Alleen in de WAL.'));
    assert.deepEqual(fx.hashes(), before, 'database, WAL and all other files byte-identical');
  } finally {
    live.close();
    fx.cleanup();
  }
});

test('preview → import: bots, engines, skills, team folder, memories and routines (switched off)', async () => {
  const fx = makeOpenBotFixture();
  const t = await app(fx);
  try {
    const before = fx.hashes();
    const det = await t.api('GET', '/openbot-import/detect');
    assert.equal(det.found, true);
    assert.equal(det.workspaces, 2);

    const plan = await t.api('POST', '/openbot-import/preview');
    for (const secret of DECOY_SECRETS) assert.ok(!JSON.stringify(plan).includes(secret), 'no secret in the preview');
    assert.equal(plan.bots.length, 2);
    const pb = plan.bots.find((b: any) => b.name === 'Baas');
    assert.equal(pb.engine.status, 'connect');
    assert.equal(pb.access.to, 'full');
    assert.equal(pb.workspace.default, 'reference');
    assert.ok(pb.toolGroups.includes('desktop'), 'computer use → desktop group');
    // Parity 0.4.2: the preview tells the truth about reserves (the whole ordered list is used) and computer use
    // (other levels exist, up to "volledige toegang"), not the 0.2 limitations.
    const notes = pb.notes.join(' | ');
    assert.ok(!/één reserve-engine automatisch/.test(notes), `no outdated reserve note: ${notes}`);
    assert.match(notes, /reserve-engines komen mee in dezelfde volgorde/);
    assert.match(notes, /ander toegangsniveau kiezen \(één keer per taak, of volledige toegang\)/);
    assert.deepEqual(pb.skippedSkills.sort(), ['beheerde-skill', 'markt-skill']);
    const eng = Object.fromEntries(plan.engines.map((e: any) => [e.from, e.status]));
    assert.deepEqual(eng, { claude: 'connect', deepseek: 'reconnect', opencode: 'connect', codex: 'missing' });
    const sk = Object.fromEntries(plan.skills.map((s: any) => [s.name, s]));
    assert.equal(sk['beheerde-skill'].importable, false);
    assert.equal(sk['markt-skill'].importable, false);
    assert.equal(sk['dossier-bijwerken'].selected, true);
    assert.equal(sk['vrije-skill'].selected, true);
    const weird = plan.routines.find((r: any) => r.name === 'Raar schema');
    assert.equal(weird.ok, false);
    assert.equal(weird.selected, false);
    assert.equal(plan.shared.selected, true);
    assert.ok(plan.notImported.some((a: any) => /Telegram|telegram/.test(a.what) && /opnieuw verbinden/i.test(a.why)), 'channels: reconnect');
    assert.equal(plan.team.available, false, 'without the teams module: no team');
    // Routines that wait at a usage limit keep doing that in TeamBot (limitPolicy 'wait'); the preview said it could not.
    assert.ok(!plan.attention.some((a: any) => /kan TeamBot nog niet/.test(a.text)), 'no false "TeamBot cannot wait at a limit"');

    const res = await t.api('POST', '/openbot-import/commit', selection(plan));
    assert.equal(res.counts.bots, 2);
    assert.equal(res.counts.routines, 6);
    assert.equal(res.counts.skills, 3);
    assert.equal(res.counts.memories, 3);
    assert.ok(res.attention[0].text.includes('routines staan uit'));
    const imported = await t.api('GET', '/routines');
    assert.ok(imported.length && imported.every((r: any) => r.options.limitPolicy === 'wait'), 'imported routines wait for a limit reset');
    // Parity 0.4.2: a routine that ran in OpenBot's main chat runs in the bot's main chat in TeamBot too.
    assert.equal(imported.find((r: any) => r.name === 'Maandmeting')?.options.runIn, 'main', 'run_in chat → runIn main');
    assert.ok(imported.filter((r: any) => r.name !== 'Maandmeting').every((r: any) => (r.options.runIn || 'thread') === 'thread'), 'the others keep their own thread');
    assert.ok(!plan.routines.some((r: any) => (r.notes || []).some((n: string) => /eigen routinegesprek/.test(n))), 'no outdated "own thread only" note');

    const agents = await t.api('GET', '/agents');
    const baas = agents.find((a: any) => a.name === 'Baas');
    const klant = agents.find((a: any) => a.name === 'Klantenservice');
    const providers = await t.api('GET', '/providers');
    const cc = providers.find((p: any) => p.kind === 'claude-code');
    assert.ok(cc, 'Claude Code linked (no key involved)');
    assert.ok(providers.find((p: any) => p.kind === 'opencode'));
    assert.ok(!providers.find((p: any) => p.kind === 'deepseek'), 'no key → not linked');
    assert.equal(baas.provider_id, cc.id);
    assert.equal(baas.model, 'claude-opus-5-5');
    assert.equal(baas.reasoning, 'high');
    assert.equal(baas.access_mode, 'full');
    assert.equal(baas.pinned, true);
    assert.equal(path.resolve(baas.workspace), path.resolve(fx.workspace(fx.agents.baas)), 'workspace referenced, not copied');
    assert.match(baas.instructions, /baas van het testteam/);
    assert.deepEqual(baas.fallback, { provider_id: cc.id, model: 'claude-sonnet-5-5' });
    assert.equal(baas.settings.importedFrom.backups.length, 3, 'full ordered backup list kept');
    assert.deepEqual(baas.settings.importedFrom.backups.map((b: any) => b.kind), ['claude-code', 'deepseek', 'opencode']);
    // every linked reserve lands in TeamBot's ordered reserve list (DeepSeek needs a key → skipped until reconnected)
    assert.deepEqual(
      baas.settings.fallbacks.map((f: any) => f.provider_id),
      baas.settings.importedFrom.backups.filter((b: any) => b.provider_id).map((b: any) => b.provider_id),
    );
    assert.equal(baas.settings.fallbacks[0].model, 'claude-sonnet-5-5');
    assert.equal(klant.provider_id, null, 'Codex not installed → engine to choose');
    assert.equal(klant.reasoning, 'low');

    const lib = await t.api('GET', '/skills');
    const names = (Array.isArray(lib) ? lib : lib.skills || []).map((s: any) => s.name).sort();
    assert.deepEqual(names, ['dossier-bijwerken', 'team-database', 'vrije-skill']);
    assert.equal(baas.skills.length, 3);
    assert.equal(klant.skills.length, 2);
    const dossier = t.app.ctx.services.skills.library.getByName(t.app.ctx.store.users()[0].id, 'dossier-bijwerken');
    assert.match(t.app.ctx.services.skills.library.readFiles(dossier).get('SKILL.md').toString(), /tijdlijn/, 'team copy imported');

    const routines = t.app.ctx.services.routines.list(baas.user_id);
    assert.equal(routines.length, 6);
    for (const r of routines) {
      assert.equal(r.status, 'paused', `${r.name} is switched off`);
      assert.match(r.paused_reason, /OpenBot stopt/);
      assert.equal(r.next_run_at, null);
    }
    const byName = Object.fromEntries(routines.map((r: any) => [r.name, r]));
    assert.deepEqual(byName['Dagoverzicht'].schedule, { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['07:45'] });
    assert.deepEqual(byName['Maandmeting'].schedule, { kind: 'cron', expr: '0 8 1 * *' });
    assert.equal(byName['Eenmalig meten'].schedule.kind, 'once', 'past one-off is kept (paused)');
    assert.equal(byName['Eenmalig meten'].options.missedPolicy, 'catchup');
    assert.equal(byName['Inbox-ronde'].schedule.everyMinutes, 180);
    assert.equal(byName['Inbox-ronde'].agent_id, klant.id);

    const team = await t.api('GET', '/folders/team');
    assert.equal(path.resolve(team.folder.path), path.resolve(fx.home, 'OpenBot', 'Shared'));
    assert.deepEqual([...team.folder.agents].sort(), [baas.id, klant.id].sort());
    const roots = await t.api('GET', `/folders/roots?agentId=${baas.id}`);
    assert.ok(roots.roots.some((r: any) => r.kind === 'team' && r.mode === 'rw'));

    const mems = t.app.ctx.store.all<any>("SELECT * FROM memory_items WHERE status = 'active' AND scope = 'agent'");
    assert.equal(mems.length, 3, 'memories are live, like in OpenBot');
    assert.deepEqual(mems.filter((m) => m.pinned).map((m) => m.content), ['Sanne wil korte antwoorden in het Nederlands.'], 'essential → pinned');
    assert.equal(mems.find((m) => /weekplanning/.test(m.content)).agent_id, baas.id);

    // Re-import: nothing is duplicated.
    const plan2 = await t.api('POST', '/openbot-import/preview');
    assert.ok(plan2.bots.every((b: any) => b.existing && !b.selected));
    assert.ok(plan2.routines.every((r: any) => !r.selected));
    const res2 = await t.api('POST', '/openbot-import/commit', selection(plan2));
    assert.equal(res2.counts.bots, 0);
    assert.equal((await t.api('GET', '/agents')).length, 2);
    assert.equal(t.app.ctx.services.routines.list(baas.user_id).length, 6);

    const last = await t.api('GET', '/openbot-import/last');
    assert.equal(last.counts.bots, 0);
    assert.equal((await t.api('GET', '/openbot-import/detect')).dismissed, true);

    const logs = fs.readFileSync(path.join(t.dir, 'logs', 'server.log'), 'utf8');
    for (const secret of DECOY_SECRETS) assert.ok(!logs.includes(secret), 'no secret in the log');
    for (const [f, h] of Object.entries(before)) assert.equal(fx.hashes()[f], h, `OpenBot file unchanged: ${f}`);
  } finally {
    await t.close();
    fx.cleanup();
  }
});

test('workspace "copy" copies into TeamBot; "new" starts empty', async () => {
  const fx = makeOpenBotFixture();
  const t = await app(fx);
  try {
    const plan = await t.api('POST', '/openbot-import/preview');
    const sel = selection(plan);
    sel.bots[fx.agents.baas].workspace = 'copy';
    sel.bots[fx.agents.klant].workspace = 'new';
    sel.routines = [];
    (sel as any).memories = 'review';
    const res = await t.api('POST', '/openbot-import/commit', sel);
    assert.equal(res.memories.proposed, 3, 'review mode: proposals');
    assert.equal(t.app.ctx.store.all<any>("SELECT id FROM memory_items WHERE status = 'proposed'").length, 3);
    const agents = await t.api('GET', '/agents');
    const baas = agents.find((a: any) => a.name === 'Baas');
    const klant = agents.find((a: any) => a.name === 'Klantenservice');
    assert.ok(path.resolve(baas.workspace).startsWith(path.resolve(t.dir)), 'copied into the TeamBot data folder');
    assert.equal(fs.readFileSync(path.join(baas.workspace, 'notities', 'plan.md'), 'utf8'), 'Plan voor de week.\n');
    assert.ok(path.resolve(klant.workspace).startsWith(path.resolve(t.dir)));
    assert.ok(!fs.existsSync(path.join(klant.workspace, 'AGENTS.md')));
  } finally {
    await t.close();
    fx.cleanup();
  }
});

test('only the owner can import; members of a server never see it', async () => {
  const fx = makeOpenBotFixture();
  const t = await app(fx, 'server');
  try {
    const u = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@test.local', password: 'geheim1234', role: 'member' });
    const tok = t.app.ctx.auth.createSession(u.id, 'web', 'x').token;
    const as = (m: string, p: string) => fetch(`${t.app.url}/api${p}`, { method: m, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: m === 'POST' ? '{}' : undefined });
    assert.equal((await as('POST', '/openbot-import/preview')).status, 403);
    assert.equal((await as('POST', '/openbot-import/commit')).status, 403);
    assert.deepEqual(await (await as('GET', '/openbot-import/detect')).json(), { available: false, found: false });
  } finally {
    await t.close();
    fx.cleanup();
  }
});
