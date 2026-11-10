/**
 * 0.4.4 customer service: each customer a dossier with its own small target; customers nobody worked on for
 * archiveAfterDays go to the archive (out of the per-turn block, still found by the bot's search, undoable), a customer
 * who comes back is active again; the dossier limit counts the working set, not the archive.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { archiveInactiveCustomers, targetOf } from '../server/modules/memory/cleanup.js';

test('customer dossiers: small target, inactive ones archived but searchable, a returning customer is active again', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic', targets: { client: 12 } });
    const svc = t.app.ctx.services.memory.svc;
    const u = t.app.ctx.auth.owner()!.id;
    const bot = await t.agent({ name: 'Klantenservice', tool_groups: ['memory'] });
    const old = (await t.api('POST', '/memory/dossiers', { title: 'Klant Femke Visser', kind: 'client' })).dossier;
    const fresh = (await t.api('POST', '/memory/dossiers', { title: 'Klant Gijs Smit', kind: 'client' })).dossier;
    const project = (await t.api('POST', '/memory/dossiers', { title: 'Verbouwing winkel', kind: 'project' })).dossier;
    for (const d of [old, fresh]) await t.api('POST', '/memory/items', { content: `${d.title.replace('Klant ', '')} heeft een Gazelle e-bike gekocht`, scope: 'dossier', dossierId: d.id });
    assert.equal(targetOf(svc, u, 'dossier', old.id), 12, 'a customer has the customer target');
    assert.equal(targetOf(svc, u, 'dossier', project.id), svc.userSettings(u).targets.dossier, 'other dossiers the dossier target');

    // Half a year later nothing happened with Femke; Gijs was in a conversation yesterday.
    const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();
    t.app.ctx.store.exec('UPDATE memory_dossiers SET updated_at = ?, created_at = ? WHERE id IN (?, ?)', ago(200), ago(200), old.id, project.id);
    t.app.ctx.store.exec('UPDATE memory_items SET updated_at = ?, created_at = ? WHERE dossier_id IN (?, ?)', ago(200), ago(200), old.id, project.id);
    const lines: any[] = [];
    const counts: any = {};
    archiveInactiveCustomers(svc, u, lines, counts);
    const status = (id: string) => t.app.ctx.store.get<any>('memory_dossiers', id).status;
    assert.equal(status(old.id), 'archived');
    assert.equal(status(fresh.id), 'active');
    assert.equal(status(project.id), 'active', 'only customers');
    assert.equal(counts.customersArchived, 1);
    assert.equal(targetOf(svc, u, 'dossier', old.id), 5, 'an archived customer keeps a quarter (at least 5)');

    // Out of the per-turn block of a turn that does not name her; still found by the bot's own search.
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const block = String((await t.app.ctx.services.memory.context(u, bot.id, th.id, 'Wie heeft er een Gazelle e-bike gekocht?')) || '');
    assert.doesNotMatch(block, /Femke Visser heeft/, 'an archived customer is not in the block');
    assert.match(block, /Gijs Smit heeft/, 'an active one is');
    const reader = svc.readerFor(t.app.ctx.store.agent(bot.id)!, null);
    assert.ok(!svc.searchItems(reader, 'fiets Femke Visser').some((h: any) => /Femke/.test(h.row.content)), 'not without asking for the archive');
    assert.ok(svc.searchItems(reader, 'fiets Femke Visser', { archivedDossiers: true }).some((h: any) => /Femke/.test(h.row.content)), 'memory_search finds her');
    t.script.push({ toolCalls: [{ name: 'memory_search', args: { query: 'Gazelle e-bike gekocht' } }] }, { text: 'Twee klanten.' });
    const msgs = await t.say(th.id, 'Zoek alle klanten met een Gazelle e-bike.');
    assert.match(String(msgs.find((m: any) => m.role === 'tool')?.content), /Femke Visser heeft een Gazelle/, 'the search tool includes archived customers');
    assert.equal(status(old.id), 'archived', 'searching does not make her active');

    // She comes back: the conversation names her, her dossier is active again (and creating it again reuses it).
    const th2 = await t.api('POST', '/threads', { agentId: bot.id });
    t.script.push({ text: 'Welkom terug!' });
    await t.say(th2.id, 'Klant Femke Visser belt over een nieuwe accu');
    assert.equal(status(old.id), 'active');
    const again = await t.api('POST', '/memory/dossiers', { title: 'Klant Femke Visser', kind: 'client' });
    assert.equal(again.dossier.id, old.id);

    // Undo of the archiving works like any change.
    const ch = t.app.ctx.store.one<any>("SELECT id FROM memory_changes WHERE record_id = ? AND op = 'archive'", old.id);
    assert.ok(ch);
  } finally {
    await t.close();
  }
});

test('dossier limits: the working set counts, the archive does not', async () => {
  const t = await startTestApp();
  try {
    t.app.ctx.store.setSetting('', 'memory.limits', { dossiers: 12, dossiersTotal: 13 });
    for (let i = 0; i < 12; i++) await t.api('POST', '/memory/dossiers', { title: `Klant nummer ${i}`, kind: 'client' });
    await assert.rejects(t.api('POST', '/memory/dossiers', { title: 'Klant nummer 12', kind: 'client' }), /Maximaal 12 actieve dossiers/);
    t.app.ctx.store.exec("UPDATE memory_dossiers SET status = 'archived' WHERE title IN ('Klant nummer 0', 'Klant nummer 1')");
    await t.api('POST', '/memory/dossiers', { title: 'Klant nummer 12', kind: 'client' });
    await assert.rejects(t.api('POST', '/memory/dossiers', { title: 'Klant nummer 13', kind: 'client' }), /Maximaal 13 dossiers, ook in het archief/);
  } finally {
    await t.close();
  }
});
