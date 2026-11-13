import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockAdapter, startTestApp, type TestApp } from './helpers.js';
import { setShortCallFake } from '../server/agent/short-call.js';
import { nightlyDue } from '../server/modules/memory/maintenance.js';

async function freeEngine(t: TestApp) {
  t.app.ctx.providers.registerKind({ id: 'mock-local', label: 'Lokaal testmodel', type: 'api', group: 'local', billing: 'local', needsKey: false, description: 'test', models: ['lokaal-1'], defaultModel: 'lokaal-1', create: () => mockAdapter(t.script, t.requests) });
  return t.api('POST', '/providers', { kind: 'mock-local' });
}

const old = (days: number) => new Date(Date.now() - days * 864e5).toISOString();

test('maintenance: merges duplicates, resolves same-subject contradictions, keeps the brief in budget — no model call over all notes; one report, undo per line and for all', async () => {
  const t = await startTestApp();
  try {
    await freeEngine(t);
    const st = t.app.ctx.store;
    const svc = t.app.ctx.services.memory.svc;
    const me = t.app.ctx.auth.owner()!.id;
    const add = (content: string, extra: any = {}) => svc.insertItem({ user_id: me, scope: 'about_you', content, source_trust: 'user', source_kind: 'user', created_by: 'user', ...extra });
    const d1 = add('Ik hou van wandelen in de bergen');
    const d2 = add('Ik hou van wandelen in de bergen!');
    // Same key, two values (e.g. kept side by side earlier): the newest statement of the owner wins.
    const k1 = add('Ik woon in Utrecht', { canonical_key: 'woonplaats', valid_from: old(40), created_at: old(40) });
    const k2 = add('Ik woon in Amersfoort', { canonical_key: 'woonplaats' });
    add('Mijn naam is Sanne', { canonical_key: 'naam' });
    // (The model pass over all notes is gone: what a conversation ends, the one review ends with "vervangt" —
    // tests/memory-consolidate.test.ts. Maintenance itself never asks a model to judge all notes.)
    let maint = 0;
    setShortCallFake((system) => (/onderhoudsmodule/.test(system) ? (maint++, '{}') : ''));
    const rep = await t.api('POST', '/memory/maintenance', {});
    assert.equal(rep.status, 'done');
    assert.equal(maint, 0, 'no model pass over the notes');
    assert.equal(rep.cost, 0);
    const status = (id: string) => st.get<any>('memory_items', id).status;
    assert.equal([status(d1.id), status(d2.id)].sort().join(','), 'active,archived', 'duplicates merged');
    assert.equal(status(k1.id), 'superseded');
    assert.equal(status(k2.id), 'active');
    // Brief: the core facts (naam, woonplaats) are pinned, within the budget.
    const brief = st.all<any>("SELECT content FROM memory_items WHERE user_id = ? AND pinned = 1 AND flags LIKE '%brief%'", me).map((r) => r.content);
    assert.ok(brief.includes('Mijn naam is Sanne') && brief.includes('Ik woon in Amersfoort'), brief.join(' | '));
    assert.match(rep.summary, /samengevoegd/);
    const ops = rep.lines.map((l: any) => l.op);
    for (const op of ['merge', 'supersede', 'pin']) assert.ok(ops.includes(op), `${op} in ${ops.join(',')}`);

    // Report is listed; one line can be undone…
    const reports = await t.api('GET', '/memory/reports');
    assert.equal(reports[0].id, rep.id);
    const idx = rep.lines.findIndex((l: any) => l.op === 'merge');
    await t.api('POST', `/memory/reports/${rep.id}/undo`, { index: idx });
    assert.equal(status(d1.id), 'active');
    assert.equal(status(d2.id), 'active');
    // …and the rest at once.
    const all = await t.api('POST', `/memory/reports/${rep.id}/undo`, {});
    assert.deepEqual(all.errors, []);
    assert.equal(status(k1.id), 'active');
    assert.equal(st.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND pinned = 1", me).n, 0);
    // An undone brief pin is not pinned again by the next run.
    await t.api('POST', '/memory/maintenance', {});
    assert.equal(st.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND pinned = 1 AND content = 'Mijn naam is Sanne'", me).n, 0);
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});

test("maintenance: what the owner wrote himself is never archived by it; a learned commitment long past and never used is", async () => {
  const t = await startTestApp();
  try {
    await freeEngine(t);
    const st = t.app.ctx.store;
    const svc = t.app.ctx.services.memory.svc;
    const me = t.app.ctx.auth.owner()!.id;
    const own = (await t.api('POST', '/memory/items', { content: 'Door mij genoteerd: het kenteken van bus 3 is VX-102-B', scope: 'about_you' })).item;
    const learned = svc.insertItem({ user_id: me, scope: 'about_you', content: 'Ik moet de offerte voor Jansen vrijdag versturen', type: 'task', source_trust: 'user', source_kind: 'message', created_by: 'agent', idem_key: 'ml:oud:1' });
    st.exec('UPDATE memory_items SET created_at = ?, updated_at = ?, valid_from = ? WHERE id IN (?, ?)', old(60), old(60), old(60), own.id, learned.id);
    await t.api('POST', '/memory/maintenance', {});
    const row = (id: string) => st.get<any>('memory_items', id);
    assert.equal(row(own.id).status, 'active', "the owner's own note stays");
    assert.equal(row(learned.id).status, 'archived', 'a learned commitment long past is archived as before');
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});

test('maintenance: conversations about a dossier roll up into its timeline, decisions, open actions and a rewritten "NU" summary', async () => {
  const t = await startTestApp();
  try {
    await freeEngine(t);
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Velo Vintage', summary: '' })).dossier;
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    setShortCallFake((system) => {
      if (/Je bent het geheugen van TeamBot/.test(system)) return 'Samenvatting: Gesprek over de nieuwe site van Velo Vintage: lancering op 1 maart, Shopify gekozen.\nBesluit: We kiezen voor Shopify\nActie: Productfoto’s aanleveren vóór 15 februari';
      if (/blok "NU"/.test(system)) return JSON.stringify({ summary: 'Nieuwe site op Shopify, lancering 1 maart. Open: productfoto’s vóór 15 februari.' });
      return JSON.stringify({ duplicates: [], contradictions: [], outdated: [] });
    });
    t.script.push({ text: 'Mooi plan.' });
    await t.say(th.id, 'Voor Velo Vintage hebben we besloten om voor Shopify te gaan. De lancering is op 1 maart.');
    await t.app.ctx.services.memory.drain();
    // (0.4 F2) The conversation names the dossier: it was linked at its first turn already (the bot had the dossier
    // in its context), so maintenance has no link to make.
    assert.equal(t.app.ctx.store.one<any>('SELECT dossier_id FROM memory_links WHERE thread_id = ?', th.id)?.dossier_id, d.id, 'linked at the first turn');
    const rep = await t.api('POST', '/memory/maintenance', {});
    const ops = rep.lines.map((l: any) => l.op);
    assert.ok(!ops.includes('link'), 'no second link');
    assert.ok(ops.includes('timeline') && ops.includes('decision') && ops.includes('action') && ops.includes('summary'), ops.join(','));
    const full = await t.api('GET', `/memory/dossiers/${d.id}`);
    assert.match(full.dossier.summary, /lancering 1 maart/);
    assert.ok(full.events.some((e: any) => /^Gesprek:/.test(e.title) && /Velo Vintage/.test(e.body)));
    assert.ok(full.decisions.some((x: any) => /Shopify/.test(x.title)));
    assert.ok(full.actions.some((x: any) => /Productfoto/.test(x.title) && x.status === 'open'));
    // A second run without anything new changes nothing (cursor per conversation).
    const again = await t.api('POST', '/memory/maintenance', {});
    assert.equal(again.lines.filter((l: any) => ['timeline', 'decision', 'action', 'summary', 'link'].includes(l.op)).length, 0);
    // Undo everything of the first report: summary back, records trashed; the link of the conversation stays (it is
    // the conversation's own, shown and removable in the inspector).
    await t.api('POST', `/memory/reports/${rep.id}/undo`, {});
    const after = await t.api('GET', `/memory/dossiers/${d.id}`);
    assert.equal(after.dossier.summary, '');
    assert.equal(after.decisions.length, 0);
    assert.equal(t.app.ctx.store.one<any>('SELECT COUNT(*) AS n FROM memory_links WHERE thread_id = ?', th.id).n, 1);
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});

test('maintenance without a free engine still tidies deterministically; nightly runs once per day after 03:00', async () => {
  const t = await startTestApp();
  try {
    const svc = t.app.ctx.services.memory.svc;
    const me = t.app.ctx.auth.owner()!.id;
    svc.insertItem({ user_id: me, scope: 'shared', content: 'De klant wil wekelijks een rapport', source_trust: 'user', source_kind: 'user', created_by: 'user' });
    svc.insertItem({ user_id: me, scope: 'shared', content: 'De klant wil wekelijks een rapport.', source_trust: 'user', source_kind: 'user', created_by: 'user' });
    const rep = await t.api('POST', '/memory/maintenance', {});
    assert.equal(rep.engine, null);
    assert.equal(rep.counts.merged, 1);
    // Forgetting leaves no copy in the report either.
    const kept = (await t.api('GET', '/memory/items?scope=shared')).items[0];
    await t.api('POST', `/memory/items/${kept.id}/forget`, {});
    const after = (await t.api('GET', '/memory/reports'))[0];
    assert.ok(!JSON.stringify(after.lines).includes('wekelijks een rapport'), JSON.stringify(after.lines));
    assert.equal(after.lines[0].text, '(vergeten)');
    assert.equal(nightlyDue(svc, me, new Date(2026, 10, 8, 2, 0)), false, 'not before 03:00');
    assert.equal(nightlyDue(svc, me, new Date(2026, 10, 8, 3, 30)), true);
    svc.bumpMeta(me, { last_nightly_day: '2026-11-08' });
    assert.equal(nightlyDue(svc, me, new Date(2026, 10, 8, 14, 0)), false, 'once per day');
    await t.api('PUT', '/memory/settings', { nightly: false });
    assert.equal(nightlyDue(svc, me, new Date(2026, 10, 9, 4, 0)), false, 'switch respected');
  } finally {
    await t.close();
  }
});
