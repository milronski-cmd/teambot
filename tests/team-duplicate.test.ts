/**
 * "Team dupliceren" (plan 0.4 B-13, Instellingen › Teams): a new team with a copy of every bot (instructions, engine,
 * routines switched off, specialist field), the same profile, lead and daily budget; never memory, conversations,
 * key scopes, the team folder or access of other teams' bots. The main bot stays one and stays where it is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { copyName } from '../server/modules/teams/duplicate.js';

test('copyName: "(kopie)", then a number, within the 60 characters of a team name', () => {
  assert.equal(copyName(['Webshop'], 'Webshop'), 'Webshop (kopie)');
  assert.equal(copyName(['Webshop', 'webshop (kopie)'], 'Webshop'), 'Webshop (kopie 2)');
  const long = 'x'.repeat(60);
  assert.ok(copyName([long], long).length <= 60);
});

test('Team dupliceren: bots, routines (off), profile, lead and budget come along; memory, chats, keys, folder and access do not', async () => {
  const t = await startTestApp();
  try {
    const ada = await t.agent({ name: 'Ada', role: 'Teamleider', instructions: 'Je leidt de webshop. Antwoord kort.', tool_groups: ['files', 'team', 'memory'] });
    const bo = await t.agent({ name: 'Bo', instructions: 'Je schrijft productteksten.' });
    const teams = await t.api('GET', '/teams');
    assert.equal(teams.length, 1);
    const shop = teams[0];
    await t.api('PATCH', `/teams/${shop.id}`, { name: 'Webshop', leadAgentId: ada.id, profile: { company: 'Fietsen BV', about: 'Verkoopt fietsen', tone: 'vriendelijk', rules: 'Noem geen prijzen zonder overleg' }, dailyBudgetUsd: 2 });
    // Something that must stay behind: a routine that runs, a note in Ada's memory, a chat, a key only for this team,
    // and a bot of another team with access to this one.
    const routine = await t.api('POST', '/routines', { name: 'Ochtendrapport', agent_id: ada.id, prompt: 'Vat de bestellingen samen', schedule: { kind: 'none' } });
    assert.ok(routine.id);
    await t.api('POST', '/memory/items', { content: 'De leverancier heet Gazelle', scope: 'agent', agentId: ada.id });
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    t.script.push({ text: 'Hallo!' });
    await t.say(th.id, 'Hoi Ada');
    const other = await t.api('POST', '/teams', { name: 'Privé' });
    const kim = await t.agent({ name: 'Kim' });
    await t.api('PUT', `/teams/${other.id}/bots/${kim.id}`, {});
    await t.api('PUT', `/teams/${shop.id}/access/${kim.id}`, { level: 'read' });
    const prov = (await t.api('GET', '/providers'))[0];
    await t.api('PUT', `/teams/keys/provider/${prov.id}`, { teamId: shop.id });
    // The main bot lives in the webshop team but stands above the teams: it is not copied.
    const { token } = await t.api('POST', '/teams/main/intent', {});
    const max = await t.agent({ name: 'Max', settings: { mainBot: token } });
    await t.api('PUT', `/teams/${shop.id}/bots/${max.id}`, {});
    assert.equal((await t.api('GET', '/teams/main')).main?.id, max.id);

    const before = { agents: (await t.api('GET', '/agents')).length, routines: (await t.api('GET', '/routines')).length };
    const r = await t.api('POST', `/teams/${shop.id}/duplicate`, {});
    assert.equal(r.team.name, 'Webshop (kopie)');
    assert.equal(r.bots, 2);
    assert.equal(r.mainSkipped, 'Max');

    const copy = (await t.api('GET', '/teams')).find((x: any) => x.id === r.team.id);
    assert.deepEqual(copy.profile, { company: 'Fietsen BV', about: 'Verkoopt fietsen', tone: 'vriendelijk', rules: 'Noem geen prijzen zonder overleg' });
    assert.equal(copy.dailyBudgetUsd, 2);
    assert.deepEqual(copy.bots.map((b: any) => b.name).sort(), ['Ada', 'Bo']);
    const agents = await t.api('GET', '/agents');
    assert.equal(agents.length, before.agents + 2);
    const ada2 = agents.find((a: any) => a.name === 'Ada' && a.id !== ada.id);
    const bo2 = agents.find((a: any) => a.name === 'Bo' && a.id !== bo.id);
    assert.ok(ada2 && bo2);
    assert.equal(copy.leadAgentId, ada2.id, 'the lead of the copy is the copy of the lead');
    assert.equal(ada2.instructions, 'Je leidt de webshop. Antwoord kort.');
    assert.equal(ada2.provider_id, ada.provider_id, 'the same AI engine');
    assert.equal(ada2.model, ada.model);
    assert.equal(bo2.instructions, 'Je schrijft productteksten.');

    // The routine came along, switched off; the original still runs as it did.
    const routines = await t.api('GET', '/routines');
    assert.equal(routines.length, before.routines + 1);
    const r2 = routines.find((x: any) => x.agent_id === ada2.id);
    assert.ok(r2, 'Ada\'s copy has the routine');
    assert.equal(r2.name, 'Ochtendrapport');
    assert.equal(r2.status, 'paused', 'a copied routine is off');
    assert.equal(routines.find((x: any) => x.id === routine.id).status, routine.status, 'the original routine is untouched');

    // Never along: memory, conversations, the key scope, the access of Kim, the team folder.
    const notes = t.app.ctx.store.all<any>("SELECT * FROM memory_items WHERE agent_id = ? AND status = 'active'", ada2.id);
    assert.equal(notes.length, 0, 'no memory');
    assert.equal(t.app.ctx.store.all<any>('SELECT * FROM threads WHERE agent_id = ?', ada2.id).filter((x) => t.app.ctx.store.messages(x.id).length).length, 0, 'no conversations');
    assert.ok(!(await t.api('GET', '/teams/keys')).some((k: any) => k.teamId === copy.id), 'no key only for the copy');
    assert.equal(t.app.ctx.services.teams.access(kim.id, copy.id), 'none', 'access of another team\'s bot is not copied');
    assert.equal(copy.folder ?? null, null, 'no team folder');
    // The main bot stays one, in its own place.
    assert.equal((await t.api('GET', '/teams/main')).main?.id, max.id);
    assert.equal(t.app.ctx.services.teams.teamOf(max.id), shop.id);
    // The original team is as it was.
    const orig = (await t.api('GET', '/teams')).find((x: any) => x.id === shop.id);
    assert.equal(orig.leadAgentId, ada.id);
    assert.deepEqual(orig.bots.map((b: any) => b.name).sort(), ['Ada', 'Bo', 'Max']);

    // Again: a new name, not a clash.
    const r3 = await t.api('POST', `/teams/${shop.id}/duplicate`, {});
    assert.equal(r3.team.name, 'Webshop (kopie 2)');
    // Someone else's team id: not found.
    await assert.rejects(t.api('POST', '/teams/tm_nope/duplicate', {}), /404|niet gevonden|onbekend/i);
  } finally {
    await t.close();
  }
});
