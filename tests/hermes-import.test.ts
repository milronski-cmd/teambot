import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { HERMES_DECOYS, makeHermesFixture, snapshotFolder } from './fixtures/hermes/fixture.js';
import { detectHermes, mapHermesEngine, mapHermesSchedule, parseEntries, readHermes } from '../server/modules/openbot-import/hermes.js';
import { createOpenBotImportModule } from '../server/modules/openbot-import/index.js';
import { createFoldersModule } from '../server/modules/folders/index.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import skills from '../server/modules/skills/index.js';
import memory from '../server/modules/memory/index.js';
import cliAgents from '../server/modules/cli-agents/index.js';

/**
 * PARITEIT 1.7: overstappen uit Hermes Agent (Nous Research). A fake Hermes folder (tests/fixtures/hermes) becomes
 * bots, skills, memories and routines that start switched off; Hermes is only read, its keys never; undo removes it all.
 */

/** Fake engine detection: LM Studio "runs" on this computer, nothing else is installed. Never spawns anything. */
const fakeDetect = () => async (kind: string) => (kind === 'lmstudio' ? { installed: true, version: 'test' } : { installed: false });

async function app(home: string, mode: 'desktop' | 'server' = 'desktop') {
  return startTestApp({
    mode,
    modules: [cliAgents, memory, skills, createRoutinesModule(), createFoldersModule(), createOpenBotImportModule({ paths: () => ({ dataDir: path.join(home, 'geen-openbot'), home: path.join(home, 'geen-openbot') }), detect: fakeDetect, hermesHome: () => home })],
  });
}

const selection = (plan: any) => ({
  stagingId: plan.stagingId,
  bots: plan.bots.filter((b: any) => b.selected).map((b: any) => b.key),
  routines: plan.routines.filter((r: any) => r.selected).map((r: any) => r.key),
  skills: plan.skills.filter((s: any) => s.selected).map((s: any) => s.key),
  memories: 'active',
});

test('hermes mapping: memory entries, engines and every schedule form', () => {
  assert.deepEqual(parseEntries('een\n§\ntwee\r\n§\r\n\n§\n  drie  '), ['een', 'twee', 'drie']);
  assert.deepEqual(parseEntries(null), []);
  assert.equal(mapHermesEngine('openrouter').kind, 'openrouter');
  assert.equal(mapHermesEngine('gemini').kind, 'google', "Hermes' gemini is the Google API, not the Gemini CLI");
  assert.equal(mapHermesEngine('x-ai').kind, 'xai');
  assert.equal(mapHermesEngine('openai-codex').kind, 'codex-cli');
  assert.equal(mapHermesEngine('custom', 'http://127.0.0.1:1234/v1').kind, 'lmstudio');
  assert.equal(mapHermesEngine('custom', 'https://llm.example.com/v1').kind, 'openai-compatible');
  assert.equal(mapHermesEngine('nous').kind, null);
  assert.equal(mapHermesEngine('').kind, null);
  const s = (x: any, tz = 'Europe/Amsterdam') => (mapHermesSchedule(x, tz) as any).schedule;
  assert.deepEqual(s({ kind: 'interval', minutes: 30, display: 'every 30m' }), { kind: 'interval', everyMinutes: 30 });
  assert.deepEqual(s({ kind: 'cron', expr: '0 9 * * *' }), { kind: 'cron', expr: '0 9 * * *' });
  assert.deepEqual(s({ kind: 'once', run_at: '2027-01-20T08:00:00+00:00' }), { kind: 'once', at: '2027-01-20T09:00' }, 'UTC instant in the routine timezone');
  assert.deepEqual(s({ kind: 'once', run_at: '2027-01-20T09:00:00' }), { kind: 'once', at: '2027-01-20T09:00' }, 'a naive time stays as written');
  assert.deepEqual(s('every 2h'), { kind: 'interval', everyMinutes: 120 });
  assert.deepEqual(s('30m'), { kind: 'interval', everyMinutes: 30 });
  assert.deepEqual(s('every 7d'), { kind: 'interval', everyMinutes: 10080 });
  assert.deepEqual(s('15 7 * * 1'), { kind: 'cron', expr: '15 7 * * 1' });
  assert.equal((mapHermesSchedule({ kind: 'interval', minutes: 60 }) as any).label, 'elk uur');
  assert.ok('error' in mapHermesSchedule('every monday 9am'), 'a phrase TeamBot cannot read is said, not guessed');
  assert.ok('error' in mapHermesSchedule({ kind: 'lunar' }));
  assert.ok('error' in mapHermesSchedule(null));
});

test('hermes reader: profiles, SOUL.md, memories, skills and jobs; read only and without secrets', () => {
  const fx = makeHermesFixture();
  try {
    const before = snapshotFolder(fx.home);
    assert.deepEqual(detectHermes(fx.home), { found: true, home: fx.home, profiles: 2 });
    assert.equal(detectHermes(path.join(fx.root, 'nergens')).found, false);
    const snap = readHermes(fx.home);
    assert.deepEqual(snapshotFolder(fx.home), before, 'every file byte-identical, also its time');
    const text = JSON.stringify(snap);
    for (const d of HERMES_DECOYS) assert.ok(!text.includes(d), `no secret in the snapshot (${d})`);
    assert.deepEqual(
      snap.profiles.map((p) => [p.id, p.name]),
      [
        ['default', 'Hermes'],
        ['schrijver', 'Schrijver'],
      ],
      'dot folders and invalid profile names are no profiles',
    );
    const [main, writer] = snap.profiles;
    assert.equal(main.provider, 'openrouter');
    assert.equal(main.model, 'anthropic/claude-opus-4.7');
    assert.equal(main.timezone, 'Europe/Amsterdam');
    assert.match(main.soul, /persoonlijke assistent van Sam/);
    assert.equal(main.memories.length, 3, 'empty entry dropped, CRLF handled');
    assert.deepEqual(main.userFacts, ['Sam heet voluit Sam de Vries.', 'Sam wil antwoorden zonder emoji.']);
    assert.deepEqual(main.mcpServers, ['agenda']);
    assert.equal(main.hasEnv, true);
    assert.equal(main.jobs.length, 4);
    const job = Object.fromEntries(main.jobs.map((j) => [j.name, j]));
    assert.equal(job['Ochtendbriefing'].deliver, 'telegram');
    assert.deepEqual(job['Ochtendbriefing'].skills, ['factuur-check']);
    assert.equal(job['Back-up controleren'].active, false);
    assert.equal(job['Schijfruimte'].script, true);
    assert.equal(writer.provider, 'lmstudio');
    assert.equal(writer.jobs[0].key, 'schrijver:w1', 'the older bare-list form');
    const sk = Object.fromEntries(snap.skills.map((x) => [x.name, x]));
    assert.deepEqual(Object.keys(sk).sort(), ['arxiv', 'blog-stijl', 'factuur-check'], '.archive is skipped');
    assert.equal(sk.arxiv.bundled, true);
    assert.equal(sk['factuur-check'].bundled, false);
    assert.equal(sk.arxiv.category, 'research');
    assert.deepEqual(sk['blog-stijl'].profiles, ['schrijver']);
  } finally {
    fx.cleanup();
  }
});

test('hermes: preview → import → again → undo; Hermes untouched, keys never copied', async () => {
  const fx = makeHermesFixture();
  const t = await app(fx.home);
  try {
    const before = snapshotFolder(fx.home);
    const det = await t.api('GET', '/openbot-import/hermes/detect');
    assert.equal(det.available, true);
    assert.equal(det.found, true);
    assert.equal(det.profiles, 2);

    const plan = await t.api('POST', '/openbot-import/hermes/preview', {});
    for (const d of HERMES_DECOYS) assert.ok(!JSON.stringify(plan).includes(d), 'no secret in the preview');
    assert.equal(plan.bots.length, 2);
    const eng = Object.fromEntries(plan.engines.map((e: any) => [e.from, e.status]));
    assert.deepEqual(eng, { openrouter: 'reconnect', lmstudio: 'connect' });
    assert.match(plan.engines.find((e: any) => e.from === 'openrouter').note, /Sleutels uit Hermes \(\.env\) worden niet gekopieerd/);
    const sk = Object.fromEntries(plan.skills.map((s: any) => [s.name, s]));
    assert.equal(sk['factuur-check'].selected, true, 'your own skill is proposed');
    assert.equal(sk.arxiv.selected, false, 'a skill Hermes ships itself only when you tick it');
    assert.equal(sk.arxiv.importable, true);
    const r = Object.fromEntries(plan.routines.map((x: any) => [x.name, x]));
    assert.equal(r['Schijfruimte'].ok, false, 'a script-only job has no instruction for a bot');
    assert.match(r['Ochtendbriefing'].notes.join(' '), /telegram/);
    assert.match(r['Herinnering btw-aangifte'].notes.join(' '), /openai\/gpt-5/);
    assert.equal(r['Weekblog'].schedule, 'elke 168 uur');
    assert.ok(plan.notImported.some((n: any) => /\.env/.test(n.what)));
    assert.ok(plan.notImported.some((n: any) => /agenda/.test(n.what)), 'MCP apps are named');
    assert.equal(plan.memories.total, 4);
    assert.equal(plan.memories.userFacts, 3, 'the same fact in two profiles once');

    const res = await t.api('POST', '/openbot-import/hermes/commit', selection(plan));
    assert.deepEqual(res.counts, { bots: 2, routines: 4, skills: 2, memories: 7, providers: 1 });
    assert.ok(res.attention[0].text.includes('routines staan uit'));
    const agents = await t.api('GET', '/agents');
    const hermes = agents.find((a: any) => a.name === 'Hermes');
    const writer = agents.find((a: any) => a.name === 'Schrijver');
    assert.match(hermes.instructions, /persoonlijke assistent van Sam/);
    assert.equal(hermes.model, 'anthropic/claude-opus-4.7');
    assert.equal(hermes.provider_id, null, 'OpenRouter needs its key again');
    assert.equal(hermes.access_mode, 'full', 'the start of every new bot of the owner (agent/new-bot.ts)');
    assert.ok(writer.provider_id, 'LM Studio on this computer is linked');
    const lib = await t.api('GET', '/skills');
    const names = (Array.isArray(lib) ? lib : lib.skills).map((s: any) => s.name).sort();
    assert.deepEqual(names, ['blog-stijl', 'factuur-check']);
    const libId = (n: string) => (Array.isArray(lib) ? lib : lib.skills).find((s: any) => s.name === n).id;
    // Every bot has the active skills (skills/defaults.ts): its own first, then the other's.
    assert.deepEqual(t.app.ctx.store.agent(hermes.id)!.skills, [libId('factuur-check'), libId('blog-stijl')]);
    assert.deepEqual(t.app.ctx.store.agent(writer.id)!.skills, [libId('blog-stijl'), libId('factuur-check')]);
    const routines = t.app.ctx.services.routines.list(hermes.user_id);
    assert.equal(routines.length, 4);
    assert.ok(routines.every((x: any) => x.status === 'paused'), 'every routine starts switched off');
    const once = routines.find((x: any) => x.name === 'Herinnering btw-aangifte');
    assert.deepEqual(once.schedule, { kind: 'once', at: '2027-01-20T09:00' });
    assert.equal(once.timezone, 'Europe/Amsterdam');
    const mems = t.app.ctx.store.all<any>("SELECT scope, agent_id, pinned FROM memory_items WHERE status = 'active'");
    assert.equal(mems.filter((m) => m.scope === 'agent' && m.agent_id === hermes.id).length, 3);
    assert.equal(mems.filter((m) => m.scope === 'agent' && m.agent_id === writer.id).length, 1);
    assert.equal(mems.filter((m) => m.scope === 'about_you').length, 3, 'USER.md → Over jou');
    assert.ok(mems.every((m) => !!m.pinned), 'always in the prompt in Hermes, pinned in TeamBot');
    const dump = JSON.stringify(t.app.ctx.store.all('SELECT * FROM agents')) + JSON.stringify(t.app.ctx.store.all('SELECT * FROM settings')) + JSON.stringify(t.app.ctx.store.all('SELECT * FROM audit'));
    for (const d of HERMES_DECOYS) assert.ok(!dump.includes(d), 'no secret anywhere in TeamBot');

    // Importing again: nothing twice.
    const plan2 = await t.api('POST', '/openbot-import/hermes/preview', {});
    assert.ok(plan2.bots.every((b: any) => !!b.existing && !b.selected));
    assert.ok(plan2.routines.every((x: any) => !x.selected));
    const res2 = await t.api('POST', '/openbot-import/hermes/commit', { ...selection(plan2), bots: plan2.bots.map((b: any) => b.key) });
    assert.equal(res2.counts.bots, 0);
    assert.equal((await t.api('GET', '/agents')).length, 2);

    // Undo: what would go, then gone; Hermes still byte-identical.
    const undo = await t.api('GET', '/openbot-import/hermes/undo');
    assert.equal(undo.available, true);
    assert.deepEqual(undo.bots.map((b: any) => b.name).sort(), ['Hermes', 'Schrijver']);
    assert.equal(undo.routines, 4);
    assert.equal(undo.memories, 3);
    assert.match(undo.notes[0], /Hermes zelf blijft/);
    const done = await t.api('POST', '/openbot-import/hermes/undo');
    assert.equal(done.bots, 2);
    assert.equal(done.routines, 4);
    assert.equal(done.skills, 2);
    assert.equal(done.providers, 1);
    assert.equal(done.memories, 3);
    assert.equal((await t.api('GET', '/agents')).length, 0);
    assert.equal(t.app.ctx.store.all<any>("SELECT id FROM memory_items WHERE status = 'active'").length, 0);
    assert.equal((await t.api('GET', '/openbot-import/hermes/detect')).undoable, false);
    assert.deepEqual(snapshotFolder(fx.home), before, 'Hermes is never written');

    // After an undo, importing again brings everything back (memories included).
    const plan3 = await t.api('POST', '/openbot-import/hermes/preview', {});
    const res3 = await t.api('POST', '/openbot-import/hermes/commit', selection(plan3));
    assert.equal(res3.counts.bots, 2);
    assert.equal(res3.counts.memories, 7);
  } finally {
    await t.close();
    fx.cleanup();
  }
});

test('hermes: another folder by path, a wrong folder is said plainly, review mode', async () => {
  const fx = makeHermesFixture();
  const t = await app(path.join(fx.root, 'leeg'));
  try {
    assert.equal((await t.api('GET', '/openbot-import/hermes/detect')).found, false);
    await assert.rejects(t.api('POST', '/openbot-import/hermes/preview', {}), /400: Geen Hermes-map gevonden/);
    await assert.rejects(t.api('POST', '/openbot-import/hermes/preview', { path: 'relatief/pad' }), /400: Geef het volledige pad/);
    const plan = await t.api('POST', '/openbot-import/hermes/preview', { path: fx.home });
    assert.equal(plan.source.home, fx.home);
    const res = await t.api('POST', '/openbot-import/hermes/commit', { ...selection(plan), routines: [], skills: [], memories: 'review' });
    assert.equal(res.counts.bots, 2);
    assert.equal(res.memories.proposed, 7);
    assert.equal(t.app.ctx.store.all<any>("SELECT id FROM memory_items WHERE status = 'proposed'").length, 7);
    await assert.rejects(t.api('POST', '/openbot-import/hermes/commit', { stagingId: plan.stagingId, bots: [] }), /404: Deze voorvertoning is verlopen/);
    fs.rmSync(path.join(fx.root, 'leeg'), { recursive: true, force: true });
  } finally {
    await t.close();
    fx.cleanup();
  }
});
