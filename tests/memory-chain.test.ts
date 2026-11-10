/**
 * Chains of endings (0.4.5, consolidate.ts): "Ahmed is weg" also ends what was only true because Ahmed worked here —
 * his open tasks, the dossier actions he owns or that name him, and the notes about the work he does — with a reason
 * and undo. Who he is (the brother of Fleur) stays, and so does everyone else's work. Only on the owner's word.
 * Bench: "Ketting: wat ervan afhing ook beëindigd" was 0/2.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { departedNames, names } from '../server/modules/memory/consolidate.js';

const add = async (t: TestApp, content: string, extra: any = {}) => (await t.api('POST', '/memory/items', { content, scope: 'about_you', ...extra })).item;
const item = (t: TestApp, id: string) => t.app.ctx.store.get<any>('memory_items', id);
const rec = (t: TestApp, id: string) => t.app.ctx.store.get<any>('memory_records', id);

test('departedNames: who left, only when someone left', () => {
  assert.deepEqual(departedNames('Ahmed is weg'), ['Ahmed']);
  assert.deepEqual(departedNames('Ahmed werkt niet meer bij ons, hij is vertrokken'), ['Ahmed']);
  assert.deepEqual(departedNames('Sanne is met pensioen'), ['Sanne']);
  assert.deepEqual(departedNames('De printer is weg'), [], 'no person');
  assert.deepEqual(departedNames('Werkt Ahmed hier niet meer?'), [], 'a question');
  assert.deepEqual(departedNames('Ahmed heeft de frames gespoten'), [], 'nobody left');
  assert.equal(names('Foto’s van de fietsen maakt Ahmed met een Sony A7', 'ahmed'), true);
  assert.equal(names('Ahmedabad is een stad', 'Ahmed'), false, 'the whole word');
});

test('"Ahmed is weg" ends his open tasks, his actions and his work; his family and other people stay; undo works', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const frames = await add(t, 'Ahmed restaureert de frames in de werkplaats');
    const fotos = await add(t, 'Foto’s van de fietsen maakt Ahmed met een Sony A7');
    const todo = await add(t, 'Ahmed moet de offerte voor Jansen nog sturen');
    const broer = await add(t, 'Ahmed is de broer van Fleur');
    const jeroen = await add(t, 'Jeroen doet de marketing en de socials');
    const pinned = await add(t, 'Ahmed doet altijd de eindcontrole van een fiets', { pinned: true });
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Werkplaats' })).dossier;
    const act = async (title: string, owner?: string) => (await t.api('POST', `/memory/dossiers/${d.id}/records`, { kind: 'action', title, ...(owner ? { owner } : {}) })).record;
    const spuiten = await act('Frames van de Gazelle spuiten', 'Ahmed');
    const bellen = await act('Ahmed belt de lakspuiter terug');
    const banner = await act('Banner voor de kerstactie maken', 'Jeroen');

    await add(t, 'Ahmed is weg');

    for (const x of [frames, fotos, todo]) {
      const r = item(t, x.id);
      assert.equal(r.status, 'superseded', `${r.content} ended`);
      assert.match(r.invalid_reason, /Ahmed is weg/);
      assert.ok(r.valid_to);
    }
    assert.equal(item(t, broer.id).status, 'active', 'who he is stays');
    assert.equal(item(t, jeroen.id).status, 'active', "someone else's work stays");
    assert.equal(item(t, pinned.id).status, 'active', 'a pinned note is never ended by a pattern');
    assert.equal(rec(t, spuiten.id).status, 'cancelled', 'the action he owned');
    assert.equal(rec(t, bellen.id).status, 'cancelled', 'the action that names him');
    assert.equal(rec(t, banner.id).status, 'open', "Jeroen's action stays");
    const ch = t.app.ctx.store.one<any>("SELECT * FROM memory_changes WHERE record_id = ? ORDER BY created_at DESC LIMIT 1", spuiten.id);
    assert.match(ch.reason, /Ahmed is weg/);
    assert.match(ch.summary, /^Vervallen/);

    // Undo brings the action back.
    await t.api('POST', `/memory/changes/${ch.id}/undo`);
    assert.equal(rec(t, spuiten.id).status, 'open');
  } finally {
    await t.close();
  }
});

test("a bot's note that someone left ends nothing by itself; neither does related news about a person", async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const frames = await add(t, 'Ahmed restaureert de frames in de werkplaats');
    const bakker = await add(t, 'Bakker belt liever dan dat hij mailt');
    const bot = await t.agent({ name: 'Notulist', tool_groups: ['memory'] });
    const mem = t.app.ctx.services.memory;
    mem.remember(owner.id, { content: 'Ahmed is weg', scope: 'agent', agentId: bot.id, createdBy: 'agent', createdByAgent: bot.id, source: { kind: 'message', trust: 'agent' } });
    await add(t, 'Bakker heeft vandaag gebeld over zijn bestelling');
    assert.equal(item(t, frames.id).status, 'active', 'only the owner’s word starts a chain');
    assert.equal(item(t, bakker.id).status, 'active');
  } finally {
    await t.close();
  }
});
