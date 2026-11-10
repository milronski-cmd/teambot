import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { startTestApp } from './helpers.js';
import { DECOY_SECRETS } from './fixtures/openbot-fixture.js';
import { TEAM_DECOY_SECRETS, makeOpenBotTeamFixture } from './fixtures/openbot-team-fixture.js';
import { readOpenBot, readOpenBotLive, workspaceOf } from '../server/modules/openbot-import/reader.js';
import { createOpenBotImportModule } from '../server/modules/openbot-import/index.js';
import { createFoldersModule } from '../server/modules/folders/index.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import teams from '../server/modules/teams/index.js';
import teamdata from '../server/modules/teamdata/index.js';
import skills from '../server/modules/skills/index.js';
import memory from '../server/modules/memory/index.js';
import cliAgents from '../server/modules/cli-agents/index.js';
import channels from '../server/modules/channels/index.js';

/**
 * Switching over from OpenBot (docs/OVERSTAPPEN_OPENBOT.md): everything comes over with channels and routines paused,
 * a channel never connects on import (no token, switched off, allowlist kept; WhatsApp is linked again), the routines
 * that were on in OpenBot go on in one step but never while a running OpenBot still runs them and never customer
 * routines, and the import of a COPY of OpenBot's data reads only that copy. Synthetic data only.
 */

const CHANNEL_DECOYS = ['decoy-telegram-bot-user-777', 'decoy-slack-app-id-888'];
const SECRETS = [...DECOY_SECRETS, ...TEAM_DECOY_SECRETS, ...CHANNEL_DECOYS];
const fakeDetect = () => async (kind: string) => (kind === 'claude-code' || kind === 'opencode' ? { installed: true, loggedIn: true, version: 'test' } : { installed: false });

/** The owner's team, plus chat connections (Telegram with an allowlist, WhatsApp) and a run marker. */
function fixture() {
  const fx = makeOpenBotTeamFixture({ workspaceName: 'Sannes team' });
  const db = new DatabaseSync(path.join(fx.dataDir, 'openbot.db'));
  db.exec('CREATE TABLE projection_messaging_allowed_senders (connection_id TEXT NOT NULL, sender_id TEXT NOT NULL, kind TEXT NOT NULL, name TEXT, created_at TEXT NOT NULL)');
  db.prepare('UPDATE projection_messaging_connections SET orchestrator_agent_id = ?, bot_user_id = ?, app_id = ? WHERE connection_id = ?').run(fx.team.baas, CHANNEL_DECOYS[0], CHANNEL_DECOYS[1], 'c1');
  const ts = '2026-11-06T00:00:00.000Z';
  db.prepare('INSERT INTO projection_messaging_connections VALUES (?, ?, ?, ?, 1, NULL, NULL, ?, NULL, ?, ?)').run('c2', 'whatsapp', 'w2', 'Klanten', fx.team.klant, ts, ts);
  db.prepare('INSERT INTO projection_messaging_allowed_senders VALUES (?, ?, ?, ?, ?)').run('c1', '123456789', 'user', 'Eigenaar', ts);
  db.prepare('INSERT INTO projection_messaging_allowed_senders VALUES (?, ?, ?, ?, ?)').run('c1', '987654321', 'user', 'Collega', ts);
  db.close();
  return fx;
}

function marker(fx: ReturnType<typeof fixture>, running: boolean) {
  fs.writeFileSync(path.join(fx.dataDir, 'openbot-run-marker-v1.json'), JSON.stringify({ version: 1, appVersion: '0.62.0', startedAt: Date.now() - 60_000, heartbeatAt: running ? Date.now() : Date.now() - 3_600_000, state: running ? 'running' : 'stopped' }));
}

async function app(fx: ReturnType<typeof fixture>) {
  return startTestApp({
    modules: [cliAgents, memory, skills, createRoutinesModule(), teams, createFoldersModule(), teamdata, channels, createOpenBotImportModule({ paths: () => ({ dataDir: fx.dataDir, home: fx.home }), detect: fakeDetect })],
  });
}

function asProposed(plan: any) {
  return {
    stagingId: plan.stagingId,
    team: plan.team.choice,
    mainBot: plan.roles.main,
    lead: plan.roles.lead,
    specialists: Object.fromEntries(plan.roles.specialists.map((s: any) => [s.key, { selected: s.selected, field: s.field, sources: s.sources }])),
    bots: Object.fromEntries(plan.bots.map((b: any) => [b.key, { selected: b.selected, workspace: b.workspace.default }])),
    routines: plan.routines.filter((r: any) => r.selected).map((r: any) => r.key),
    channels: (plan.channels || []).filter((c: any) => c.selected).map((c: any) => c.key),
    skills: plan.skills.filter((s: any) => s.selected).map((s: any) => s.key),
    memories: 'active',
    shared: plan.shared.selected,
    teamData: !!plan.teamData?.selected,
  };
}

test('reader: channels with bot and allowlist but no ids or tokens; a copy of the data reads its own workspaces', () => {
  const fx = fixture();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-obc-'));
  try {
    const snap = readOpenBot({ dataDir: fx.dataDir, home: fx.home }, tmp);
    const tg = snap.channels.find((c) => c.platform === 'telegram')!;
    assert.equal(tg.agentId, fx.team.baas);
    assert.deepEqual(
      tg.senders.map((s) => s.id),
      ['123456789', '987654321'],
    );
    assert.ok(snap.channels.some((c) => c.platform === 'whatsapp' && c.agentId === fx.team.klant));
    for (const s of SECRETS) assert.ok(!JSON.stringify(snap).includes(s), 'no secret or platform id in the snapshot');

    // A copy (as for a dry run): OpenBot stored absolute workspace paths of the original home.
    const copy = path.join(tmp, 'copy');
    fs.cpSync(fx.root, copy, { recursive: true });
    const cHome = path.join(copy, path.relative(fx.root, fx.home));
    const cData = path.join(copy, path.relative(fx.root, fx.dataDir));
    const snap2 = readOpenBot({ dataDir: cData, home: cHome }, tmp);
    assert.equal(snap2.agents.length, snap.agents.length);
    for (const a of snap2.agents) assert.ok(a.workspacePath.toLowerCase().startsWith(path.resolve(cHome).toLowerCase()), `${a.name}: the copy's own workspace, not the original`);
    assert.equal(snap2.agents.find((a) => a.name === 'Baas')!.instructions, snap.agents.find((a) => a.name === 'Baas')!.instructions);
    assert.ok(snap2.skills.every((s) => s.dir.toLowerCase().startsWith(path.resolve(copy).toLowerCase())), 'skills from the copy');
    // A workspace somewhere else (not the default layout) is kept as it is.
    assert.equal(workspaceOf({ dataDir: cData, home: cHome }, 'agent-x', path.join(tmp, 'elders')), path.resolve(path.join(tmp, 'elders')));

    // Live look: routines on, channels on, whether OpenBot runs (its own run marker).
    marker(fx, true);
    const live = readOpenBotLive({ dataDir: fx.dataDir, home: fx.home }, tmp);
    assert.equal(live.running, true);
    assert.ok(live.routines.some((r) => r.active) && live.routines.some((r) => !r.active));
    assert.equal(live.channels.filter((c) => c.enabled).length, 2);
    marker(fx, false);
    assert.equal(readOpenBotLive({ dataDir: fx.dataDir, home: fx.home }, tmp).running, false);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
    fx.cleanup();
  }
});

test('import: channels come over switched off without a token (allowlist kept), WhatsApp is linked again, nothing connects; undo removes them', async () => {
  const fx = fixture();
  const before = fx.hashes();
  const t = await app(fx);
  try {
    const plan = await t.api('POST', '/openbot-import/preview');
    const tg = plan.channels.find((c: any) => c.platform === 'telegram');
    const wa = plan.channels.find((c: any) => c.platform === 'whatsapp');
    assert.equal(tg.adapter, 'telegram');
    assert.equal(tg.selected, true);
    assert.equal(tg.off, true);
    assert.equal(tg.bot, 'Baas');
    assert.equal(tg.senders, 2);
    assert.equal(wa.adapter, null, 'WhatsApp: a new QR scan, never an imported link');
    assert.match(wa.note, /QR/);
    assert.ok(plan.notImported.some((x: any) => /WhatsApp/.test(x.what) && /QR/.test(x.why)));
    assert.equal(t.app.ctx.store.all('SELECT id FROM channel_bindings').length, 0, 'the preview writes nothing');

    const res = await t.api('POST', '/openbot-import/commit', asProposed(plan));
    assert.equal(res.counts.channels, 1);
    assert.ok(res.attention.some((a: any) => /staat uit en heeft nog geen token/.test(a.text)));
    const rows = t.app.ctx.store.all<any>('SELECT * FROM channel_bindings');
    assert.equal(rows.length, 1);
    const b = rows[0];
    assert.equal(b.adapter, 'telegram');
    assert.equal(Number(b.enabled), 0, 'switched off');
    assert.equal(b.status, 'stopped');
    assert.equal(b.secret_ids, '{}', 'no token');
    assert.equal(JSON.parse(b.config).importedFrom.app, 'openbot');
    assert.deepEqual(
      t.app.ctx.store
        .all<any>('SELECT external_id FROM channel_senders WHERE binding_id = ? ORDER BY external_id', b.id)
        .map((r) => r.external_id),
      ['123456789', '987654321'],
    );
    assert.equal(t.app.ctx.services.channels.manager.allEnabled().length, 0, 'nothing polls or logs in');
    assert.equal(t.app.ctx.services.channels.manager.isLive(b.id), false);
    assert.equal(t.app.ctx.store.all("SELECT id FROM routines WHERE status != 'paused'").length, 0, 'every routine paused');
    // Never a secret in TeamBot's database.
    const dbText = fs.readFileSync(path.join(t.dir, 'teambot.db')).toString('latin1');
    for (const s of SECRETS) assert.ok(!dbText.includes(s), 'no secret in the database');

    // The owner changes a setting of the channel: it stays off and keeps where it came from.
    await t.api('PATCH', `/channels/bindings/${b.id}`, { config: { errorReply: false } });
    const b2 = t.app.ctx.store.one<any>('SELECT config, enabled FROM channel_bindings WHERE id = ?', b.id)!;
    assert.equal(JSON.parse(b2.config).importedFrom.id, 'c1');
    assert.equal(Number(b2.enabled), 0);
    // Importing again does not make the channel twice.
    const plan2 = await t.api('POST', '/openbot-import/preview');
    assert.equal(plan2.channels.find((c: any) => c.platform === 'telegram').existing, true);

    const up = await t.api('GET', '/openbot-import/undo');
    assert.equal(up.channels.length, 1);
    await t.api('POST', '/openbot-import/undo');
    assert.equal(t.app.ctx.store.all('SELECT id FROM channel_bindings').length, 0, 'undo removes the channel');
    assert.equal(t.app.ctx.store.all('SELECT id FROM channel_senders').length, 0);
    assert.deepEqual(fx.hashes(), before, 'OpenBot untouched');
  } finally {
    await t.app.close();
    fx.cleanup();
  }
});

test('switch-over steps: status per step; routines on only when OpenBot no longer runs them, never customer routines', async () => {
  const fx = fixture();
  marker(fx, true);
  const t = await app(fx);
  try {
    let c = await t.api('GET', '/openbot-import/cutover');
    const step = (x: any, id: string) => x.steps.find((s: any) => s.id === id);
    assert.deepEqual(
      c.steps.map((s: any) => s.id),
      ['backup', 'import', 'check', 'channels', 'routines', 'back'],
    );
    assert.equal(step(c, 'backup').status, 'now');
    assert.equal(step(c, 'import').status, 'later');
    assert.equal(c.openbot, null, 'OpenBot is only read when asked');

    c = await t.api('POST', '/openbot-import/cutover/mark', { step: 'backup', done: true });
    assert.ok(step(c, 'backup').openbotConfirmedAt);
    await assert.rejects(t.api('POST', '/openbot-import/cutover/mark', { step: 'nope' }), /400/);

    const plan = await t.api('POST', '/openbot-import/preview');
    await t.api('POST', '/openbot-import/commit', asProposed(plan));
    c = await t.api('POST', '/openbot-import/cutover/check');
    assert.equal(step(c, 'import').status, 'done');
    assert.equal(step(c, 'check').status, 'now');
    assert.equal(c.openbot.running, true);
    const ch = step(c, 'channels');
    const tg = ch.items.find((x: any) => /Telegram/.test(x.label));
    assert.equal(tg.phase, 'openbot', 'still on in OpenBot, off in TeamBot');
    assert.equal(tg.teambot.enabled, false);
    assert.ok(ch.items.find((x: any) => /WhatsApp/.test(x.label)).relink);
    const r = step(c, 'routines');
    assert.ok(r.wasOn > 0 && r.on === 0);
    assert.ok(r.customer.includes('Inbox-ronde'), 'customer routines are listed apart');

    // OpenBot still runs the same routines: nothing goes on (they would run twice).
    const refused = await t.api('POST', '/openbot-import/cutover/routines');
    assert.equal(refused.started.length, 0);
    assert.ok(refused.skipped.some((s: any) => /OpenBot/.test(s.why)));

    // OpenBot stopped: the routines that were on in OpenBot go on; customer routines and ones that were off stay off.
    marker(fx, false);
    const ok = await t.api('POST', '/openbot-import/cutover/routines');
    assert.ok(ok.started.includes('Dagoverzicht') && ok.started.includes('Kennisronde ochtend'));
    assert.ok(!ok.started.includes('Inbox-ronde') && !ok.started.includes('Avondcontrole') && !ok.started.includes('Inbox beantwoorden'));
    assert.ok(ok.skipped.some((s: any) => s.name === 'Inbox-ronde' && /testrun/.test(s.why)));
    assert.ok(ok.skipped.some((s: any) => s.name === 'Eenmalig meten'), 'a one-off in the past stays off, with the reason');
    const engine = t.app.ctx.services.routines.engine;
    const status = (name: string) => engine.routinesOf(t.app.ctx.store.one<any>('SELECT id FROM users LIMIT 1')!.id).find((x: any) => x.name === name)?.status;
    assert.equal(status('Dagoverzicht'), 'active');
    assert.equal(status('Avondcontrole'), 'paused');
    assert.equal(status('Inbox-ronde'), 'paused');
    const after = step(ok.status, 'routines');
    assert.equal(after.on, ok.started.length);
  } finally {
    await t.app.close();
    fx.cleanup();
  }
});
