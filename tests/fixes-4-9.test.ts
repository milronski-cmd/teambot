/**
 * Faults found by reading the code (4.9.0), each with the smallest case that showed it:
 *  - a dossier the owner limited to some bots was writable by every bot of the team;
 *  - "vakkennis meenemen" copied a dossier without its text;
 *  - two lines that differ in a small word only ("NL" / "BE") counted as the same line;
 *  - a skill of more than 200 files passed the preview and then failed to install;
 *  - a routine whose next routine was deleted could not be changed any more;
 *  - a routine a bot deletes from its own turn keeps that turn.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { compare } from '../server/modules/memory/same.js';
import { LIMITS } from '../server/modules/skills/files.js';
import { CURATED_LIMITS } from '../server/modules/skills/import-rules.js';

process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

async function tool(t: TestApp, agentId: string, name: string, args: any) {
  const th = await t.api('POST', '/threads', { agentId });
  t.script.push({ toolCalls: [{ name, args }] }, { text: 'ok' });
  const msgs = await t.say(th.id, 'doe het');
  return String(msgs.find((m: any) => m.role === 'tool')?.content || '');
}

test('one rule for "the same": a small word that differs makes two lines, an article does not', () => {
  assert.equal(compare('Klant in BE betaalt 21% btw', 'Klant in NL betaalt 21% btw'), 'other');
  assert.equal(compare('Bel de klant na de vergadering', 'Bel de klant voor de vergadering'), 'other');
  assert.equal(compare('Team B levert op vrijdag', 'Team A levert op vrijdag'), 'other');
  // Still the same line: the same words, with or without an article, or with less in it.
  assert.equal(compare('De klant betaalt 21% btw', 'Klant betaalt 21% btw'), 'same');
  assert.equal(compare('Klant betaalt btw', 'Klant in NL betaalt 21% btw'), 'same');
  // Still a new value for the same thing.
  assert.equal(compare('De verzendkosten naar het buitenland zijn nu 7,25 euro per pakket', 'De verzendkosten naar het buitenland zijn nu 6,95 euro per pakket'), 'replaces');
});

test('skills: what the preview lets in also installs (one limit on the number of files)', () => {
  assert.equal(CURATED_LIMITS.maxFiles, LIMITS.maxFiles);
  assert.ok(LIMITS.maxFiles >= 1000);
});

test('a dossier limited to some bots: another bot of the team neither rewrites it nor reads its text', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const hr = await t.agent({ name: 'Hanna' });
    const sales = await t.agent({ name: 'Sem' });
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Salarissen', agentIds: [hr.id] })).dossier;
    const store = t.app.ctx.store;
    store.update('memory_dossiers', d.id, { body: '- Hanna verdient 4000 euro' });
    const out = await tool(t, sales.id, 'dossier_write', { dossier: 'Salarissen', mode: 'rewrite', content: 'x' });
    assert.match(out, /Geweigerd/);
    assert.doesNotMatch(out, /4000/);
    assert.equal(store.one<any>('SELECT body FROM memory_dossiers WHERE id = ?', d.id)?.body, '- Hanna verdient 4000 euro');
    // The bot on the list still writes it.
    await tool(t, hr.id, 'dossier_write', { dossier: 'Salarissen', mode: 'add', content: '- Loonstrook komt op de 25e' });
    assert.match(String(store.one<any>('SELECT body FROM memory_dossiers WHERE id = ?', d.id)?.body), /25e/);
  } finally {
    await t.close();
  }
});

test('“vakkennis meenemen” takes the text of a dossier along', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const ada = await t.agent({ name: 'Ada' });
    const [A] = await t.api('GET', '/teams');
    const B = await t.api('POST', '/teams', { name: 'Team B', starterRules: false });
    const store = t.app.ctx.store;
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Vakkennis fietsen', teamId: A.id })).dossier;
    store.update('memory_dossiers', d.id, { body: '- Een ketting smeer je elke 300 kilometer' });
    t.app.ctx.services.teams.copyTeamData(store.agent(ada.id)!.user_id, A.id, B.id, { knowledge: true });
    const copy = store.one<any>('SELECT body FROM memory_dossiers WHERE team_id = ? AND title = ?', B.id, 'Vakkennis fietsen');
    assert.equal(copy?.body, '- Een ketting smeer je elke 300 kilometer');
  } finally {
    await t.close();
  }
});

test('routines: a chain to a deleted routine ends quietly, and a bot’s delete keeps the turn that runs', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Rik' });
    const mk = (name: string, extra: any = {}) => t.api('POST', '/routines', { name, agent_id: bot.id, prompt: 'Kijk of er iets te doen is', schedule: { kind: 'interval', everyMinutes: 1440 }, ...extra });
    const b = await mk('Tweede');
    const a = await mk('Eerste', { options: { then: { routineId: b.id } } });
    await t.api('DELETE', `/routines/${b.id}`);
    const renamed = await t.api('PATCH', `/routines/${a.id}`, { name: 'Eerste, hernoemd' });
    assert.equal(renamed.name, 'Eerste, hernoemd');
    assert.equal(renamed.options.then ?? null, null);

    // A running turn of a routine, and the bot itself deletes the routine: the turn is not cancelled.
    const engine = t.app.ctx.services.routines.engine;
    const cancelled: string[] = [];
    const runs = t.app.ctx.runs as any;
    const cancel = runs.cancel.bind(runs);
    runs.cancel = (id: string, why?: string) => (cancelled.push(id), cancel(id, why));
    const store = t.app.ctx.store;
    const fake = (routineId: string) => {
      const rr = store.one<any>('SELECT id FROM routine_runs WHERE routine_id = ? LIMIT 1', routineId);
      if (rr) store.exec("UPDATE routine_runs SET status = 'running', run_id = 'run_x' WHERE id = ?", rr.id);
      return !!rr;
    };
    const c = await mk('Derde');
    await t.api('POST', `/routines/${c.id}/run`);
    if (fake(c.id)) {
      engine.remove(engine.routine(c.id), { keepRunning: true });
      assert.deepEqual(cancelled.filter((x) => x === 'run_x'), []);
    }
    assert.equal(engine.routine(c.id), null);
  } finally {
    await t.close();
  }
});
