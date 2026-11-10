import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { DECOY, makeOpenClawFixture, snapshotFiles } from './fixtures/openclaw-fixture.js';
import { mapOcSchedule, ocPrompt, parseIdentity, parseJson5, readOpenClaw } from '../server/modules/openbot-import/openclaw-reader.js';

/** 0.4.4 P7 (item 13): switching from OpenClaw. Preview writes nothing, import = the plan, undo removes it all. */

function withFixture() {
  const fx = makeOpenClawFixture();
  process.env.TEAMBOT_OPENCLAW_DIR = fx.state;
  process.env.TEAMBOT_OPENCLAW_HOME = fx.home;
  return fx;
}

/** Every text in TeamBot's database, to look for decoy secrets. */
function allText(t: any): string {
  const st = t.app.ctx.store;
  const tables = st.all("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%'").map((r: any) => r.name);
  return tables.map((n: string) => JSON.stringify(st.all(`SELECT * FROM "${n}"`))).join('\n');
}

test('openclaw: reader (JSON5 config, agents, workspaces, identity, skills, jobs) without reading secrets', () => {
  const fx = withFixture();
  const snap = readOpenClaw({
    stateDir: fx.state,
    configPath: `${fx.state}/openclaw.json`,
  });
  assert.deepEqual(
    snap.agents.map((a) => [a.id, a.name, a.emoji, a.model, a.isDefault]),
    [
      ['main', 'Clawd', '🦞', 'anthropic/claude-sonnet-4-6', true],
      ['research', 'Onderzoeker', '', 'openai/gpt-5.2', false],
    ],
  );
  assert.match(snap.agents[0].instructions, /persoonlijke assistent[\s\S]*## Persoonlijkheid \(uit SOUL\.md van OpenClaw\)[\s\S]*droog gevoel/);
  assert.match(snap.agents[1].workspace, /workspace-research$/);
  assert.deepEqual(
    snap.agents[0].skills.map((s) => s.name),
    ['notities'],
  );
  assert.deepEqual(
    snap.sharedSkills.map((s) => s.name),
    ['weer'],
  );
  assert.equal(snap.agents[0].dailyLogs, 1);
  assert.deepEqual(
    snap.jobs.map((j) => [j.id, j.agentId]),
    [
      ['job-ochtend', 'main'],
      ['job-bronnen', 'research'],
      ['job-herinnering', 'main'],
      ['job-backup', 'main'],
    ],
  );
  assert.deepEqual(snap.seen.channels, ['telegram', 'whatsapp']);
  assert.ok(!JSON.stringify(snap).includes(`${DECOY}-TELEGRAM`), 'channel accounts are never in the snapshot');
  assert.ok(!JSON.stringify(snap).includes(`${DECOY}-AUTH`) && !JSON.stringify(snap).includes(`${DECOY}-ENV`) && !JSON.stringify(snap).includes(`${DECOY}-WHATSAPP`));
});

test('openclaw: helpers (JSON5, identity, schedules, payloads)', () => {
  assert.deepEqual(parseJson5("// c\n{ a: 1, 'b': 'x, y: z', c: [1, 2,], /* d */ e: { f: \"g\" }, }"), { a: 1, b: 'x, y: z', c: [1, 2], e: { f: 'g' } });
  assert.deepEqual(parseIdentity('Name: Molty\nEmoji: 🦀'), {
    name: 'Molty',
    emoji: '🦀',
  });
  assert.deepEqual(mapOcSchedule({ kind: 'cron', expr: '0 0 7 * * 1-5' }), {
    schedule: { kind: 'cron', expr: '0 7 * * 1-5' },
    label: 'cron 0 7 * * 1-5',
  });
  assert.deepEqual((mapOcSchedule({ kind: 'every', everyMs: 7_200_000 }) as any).schedule, { kind: 'interval', everyMinutes: 120 });
  assert.deepEqual((mapOcSchedule({ kind: 'at', at: '2026-12-01T09:30:00Z' }) as any).schedule, { kind: 'once', at: '2026-12-01T09:30' });
  assert.ok('error' in mapOcSchedule({ kind: 'stream', command: ['tail'] }));
  assert.ok('error' in mapOcSchedule({ kind: 'every', everyMs: 5000 }), 'less than a minute');
  assert.deepEqual(ocPrompt({ kind: 'agentTurn', message: ' hoi ' }), {
    prompt: 'hoi',
  });
  assert.ok('error' in ocPrompt({ kind: 'command', argv: ['rm'] }));
});

test('openclaw: preview writes nothing; import makes bots, skills (off), routines (off) and memory proposals; undo removes it', async () => {
  const fx = withFixture();
  const t = await startTestApp();
  try {
    const before = snapshotFiles(fx.state);
    const d = await t.api('GET', '/openbot-import/openclaw/detect');
    assert.deepEqual([d.available, d.found, d.undoable], [true, true, false]);
    const agentsBefore = (await t.api('GET', '/agents')).length;

    const pv = await t.api('POST', '/openbot-import/openclaw/preview');
    assert.deepEqual(
      pv.bots.map((b: any) => [b.name, b.selected, b.memories, b.routines]),
      [
        ['Clawd', true, 2, 3],
        ['Onderzoeker', true, 1, 1],
      ],
    );
    assert.equal(pv.bots[0].engine.linked, false, 'no Anthropic engine connected in the test app: said, never a key');
    assert.deepEqual(pv.skills.map((s: any) => s.name).sort(), ['notities', 'weer']);
    assert.deepEqual(
      pv.routines.map((r: any) => [r.name, !!r.error]),
      [
        ['Ochtendbriefing', false],
        ['Bronnen checken', false],
        ['Tandarts', false],
        ['Back-up script', true],
      ],
    );
    assert.equal(pv.aboutYou, 3, 'USER.md: 3 lines (the password line is refused at import)');
    assert.ok(pv.notImported.some((x: string) => /telegram/.test(x)));
    assert.equal((await t.api('GET', '/agents')).length, agentsBefore, 'the preview writes nothing');

    const res = await t.api('POST', '/openbot-import/openclaw/commit', {
      stagingId: pv.stagingId,
    });
    assert.deepEqual(
      res.bots.map((b: any) => [b.name, b.status]),
      [
        ['Clawd', 'created'],
        ['Onderzoeker', 'created'],
      ],
    );
    assert.deepEqual([res.counts.bots, res.counts.routines, res.counts.skills], [2, 3, 2]);
    const clawd = (await t.api('GET', '/agents')).find((a: any) => a.name === 'Clawd');
    assert.match(clawd.instructions, /persoonlijke assistent[\s\S]*Persoonlijkheid/);
    assert.equal(clawd.access_mode, 'ask');
    assert.equal(clawd.settings.importedFrom.app, 'openclaw');

    // Skills: through the importer, attached to the bot that had it, but switched off.
    const skills = await t.api('GET', '/skills');
    assert.deepEqual(skills.map((s: any) => s.name).sort(), ['notities', 'weer'], JSON.stringify(res.skills));
    const notities = skills.find((s: any) => s.name === 'notities');
    assert.equal(notities.status, 'disabled');
    assert.equal(skills.find((s: any) => s.name === 'weer').status, 'disabled');
    assert.ok(clawd.skills.includes(notities.id));

    // Routines: off, the command job never.
    const routines = t.app.ctx.services.routines.engine.routinesOf(t.app.ctx.auth.owner()!.id);
    assert.deepEqual(routines.map((r: any) => [r.name, r.status]).sort(), [
      ['Bronnen checken', 'paused'],
      ['Ochtendbriefing', 'paused'],
      ['Tandarts', 'paused'],
    ]);
    assert.ok(!res.routines.some((r: any) => r.name === 'Back-up script' && r.status === 'created'));
    // Asked for anyway: refused with the reason.
    const forced = await t.api('POST', '/openbot-import/openclaw/commit', {
      stagingId: (await t.api('POST', '/openbot-import/openclaw/preview')).stagingId,
      bots: [],
      skills: [],
      routines: ['job-backup'],
      memories: 'off',
    });
    assert.match(forced.routines[0].error, /opdracht of script/);

    // Memory: proposals only (USER.md → Over jou, MEMORY.md → the bot), the password line refused.
    const proposals = await t.api('GET', '/memory/items?status=proposed');
    const list = proposals.items || proposals;
    const texts = list.map((i: any) => `${i.scope}:${i.content}`);
    assert.ok(texts.includes('about_you:Woont in Utrecht'), texts.join(' | '));
    assert.ok(texts.includes('agent:Houdt van korte antwoorden'));
    assert.ok(texts.includes('agent:Gebruikt bij voorkeur Nederlandse bronnen'));
    assert.ok(!texts.some((x: string) => x.includes('hunter2')));
    assert.equal((await t.api('GET', '/memory/items?status=active')).items?.filter?.((i: any) => i.source_kind === 'import').length ?? 0, 0, 'nothing active right away');

    // No secret and no conversation of OpenClaw anywhere in TeamBot.
    assert.ok(!allText(t).includes(DECOY), 'a decoy secret ended up in TeamBot');

    // Again: nothing double.
    const pv2 = await t.api('POST', '/openbot-import/openclaw/preview');
    assert.deepEqual(
      pv2.bots.map((b: any) => [b.selected, !!b.existing]),
      [
        [false, true],
        [false, true],
      ],
    );
    const again = await t.api('POST', '/openbot-import/openclaw/commit', {
      stagingId: pv2.stagingId,
      bots: ['main'],
    });
    assert.equal(again.bots[0].status, 'skipped');

    // Undo: first what would go, then everything goes; OpenClaw is byte-identical throughout.
    const plan = await t.api('GET', '/openbot-import/openclaw/undo');
    assert.deepEqual([plan.bots.sort(), plan.routines], [['Clawd', 'Onderzoeker'], 3]);
    const u = await t.api('POST', '/openbot-import/openclaw/undo');
    assert.deepEqual([u.bots, u.routines, u.skills], [2, 3, 2]);
    assert.equal((await t.api('GET', '/agents')).length, agentsBefore);
    assert.equal((await t.api('GET', '/skills')).length, 0);
    const left = await t.api('GET', '/memory/items?status=proposed');
    assert.equal((left.items || left).filter((i: any) => i.source_kind === 'import').length, 0);
    assert.deepEqual(snapshotFiles(fx.state), before, 'OpenClaw is never changed');

    // After undo, importing again brings everything back.
    const pv3 = await t.api('POST', '/openbot-import/openclaw/preview');
    const back = await t.api('POST', '/openbot-import/openclaw/commit', {
      stagingId: pv3.stagingId,
      memories: 'off',
    });
    assert.equal(back.counts.bots, 2);
    assert.equal(back.counts.memories, 0, 'memories: off');
  } finally {
    await t.close();
  }
});

test('openclaw: not found is said plainly', async () => {
  process.env.TEAMBOT_OPENCLAW_DIR = `${process.cwd()}/nope-${Date.now()}`;
  const t = await startTestApp();
  try {
    const d = await t.api('GET', '/openbot-import/openclaw/detect');
    assert.equal(d.found, false);
    await assert.rejects(t.api('POST', '/openbot-import/openclaw/preview'), /404: OpenClaw is niet gevonden/);
  } finally {
    await t.close();
  }
});
