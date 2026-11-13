/**
 * 0.4 F2: synonyms at learn time (word search finds by meaning, also without any model) and facts that refresh
 * themselves: a "herzien op" date for prices, versions, rules, agreements, opening hours and contact details; refreshed
 * from the same source, confirmed by the owner's own words, re-read from a dossier document, or "te controleren".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockAdapter, startTestApp, type TestApp } from './helpers.js';
import { setShortCallFake } from '../server/agent/short-call.js';
import { builtinSynonyms } from '../server/modules/memory/synonyms.js';
import { detectReviewKind } from '../server/modules/memory/refresh.js';

const svcOf = (t: TestApp) => t.app.ctx.services.memory.svc;
const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();

async function freeEngine(t: TestApp) {
  t.app.ctx.providers.registerKind({ id: 'mock-local', label: 'Lokaal testmodel', type: 'api', group: 'local', billing: 'local', needsKey: false, description: 'test', models: ['lokaal-1'], defaultModel: 'lokaal-1', create: () => mockAdapter(t.script, t.requests) });
  return t.api('POST', '/providers', { kind: 'mock-local' });
}

test('synonyms: built-in Dutch/English groups', () => {
  assert.ok(builtinSynonyms('Mijn auto is blauw').includes('wagen'));
  assert.ok(builtinSynonyms('De tandarts zit in Utrecht').includes('dentist'));
  assert.deepEqual(builtinSynonyms('Hallo daar'), []);
  // What kind of fact can change over time.
  assert.equal(detectReviewKind('De hosting kost 25 euro per maand'), 'price');
  assert.equal(detectReviewKind('Shopify rekent 2,1 procent transactiekosten'), 'price');
  assert.equal(detectReviewKind('De server draait op Node 22'), 'version');
  assert.equal(detectReviewKind('De winkel is open van 10 tot 18 uur'), 'hours');
  assert.equal(detectReviewKind('Ons contract met TransIP loopt tot juni 2027'), 'agreement');
  assert.equal(detectReviewKind('Mijn hond heet Bram'), null);
  assert.equal(detectReviewKind('Noem bedragen altijd inclusief btw', 'instruction'), null, 'a working rule is no ageing fact');
  assert.equal(detectReviewKind('Dat kost veel tijd'), null, 'a price without a number is a remark');
});

test('what the review writes is in the dossier every bot always reads: asked in other words ("huisdier") the bot has it; forgetting takes it out', async () => {
  const t = await startTestApp();
  try {
    await freeEngine(t);
    // (The review no longer makes search words per fact: a fact it writes is a line of a core dossier, which is in the
    // bot's prompt every turn — no search needed to find it, whatever words the owner uses later.)
    setShortCallFake((system) => (/Je bent het geheugen van TeamBot/.test(system) ? 'Eigenaar: Mijn hond heet Bram\nOverzicht: De hosting kost 25 euro per maand' : ''));
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Leuk!' });
    await t.say(th.id, 'Trouwens, mijn hond heet Bram. En de hosting kost 25 euro per maand.');
    await t.app.ctx.services.memory.learner.learnNow(t.app.ctx.store.agent(a.id)!, t.app.ctx.store.thread(th.id)!);
    const th2 = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Bram.' });
    const n = t.requests.length;
    await t.say(th2.id, 'Hoe heet mijn huisdier ook alweer?');
    assert.match(t.requests[n].system, /## Dossiers[\s\S]*naam="Eigenaar"[\s\S]*Mijn hond heet Bram/);
    assert.match(t.requests[n].system, /naam="Overzicht"[\s\S]*De hosting kost 25 euro per maand/);
    // The owner takes it out (Geheugen › the dossier): gone from the next turn, kept in the dossier's history.
    const own = (await t.api('GET', '/memory/dossiers')).find((d: any) => d.core === 'owner');
    await t.api('PATCH', `/memory/dossiers/${own.id}`, { body: '' });
    t.script.push({ text: 'Dat weet ik niet.' });
    const m = t.requests.length;
    await t.say(th2.id, 'En nu?');
    assert.doesNotMatch(t.requests[m].system, /Bram/);
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});

test('refresh from the same source: a due fact is replaced by the new statement (old version in the history); not before its date, never a pinned one', async () => {
  const t = await startTestApp();
  try {
    const me = t.app.ctx.auth.owner()!.id;
    const mem = t.app.ctx.services.memory;
    const st = t.app.ctx.store;
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Kennisbank Shopify' })).dossier;
    const url = 'https://example.org/plannen';
    const put = (content: string, i: string) => mem.remember(me, { content, scope: 'dossier', dossierId: d.id, source: { kind: 'url', ref: url, excerpt: content, trust: 'system' }, idemKey: `t-${i}` });
    // Before the review date a different statement is a contradiction for the owner (as always).
    const p0 = put('Het Shopify Plus-abonnement kost 2300 dollar per maand', '0');
    const early = put('Het Shopify Plus-abonnement kost 2500 dollar per maand', '2');
    assert.ok(['conflict', 'proposed'].includes(early.action), early.action);
    assert.equal(st.one<any>('SELECT status FROM memory_items WHERE id = ?', p0.item.id).status, 'active');
    const v1 = put('Het Shopify Basic-abonnement kost 36 euro per maand', '1');
    assert.equal(v1.action, 'inserted');
    assert.equal(st.one<any>('SELECT review_kind FROM memory_items WHERE id = ?', v1.item.id).review_kind, 'price');
    // After its review date: the same page says something new → a new version, the old one superseded (and undoable).
    st.exec('UPDATE memory_items SET review_at = ? WHERE id = ?', ago(1), v1.item.id);
    const v2 = put('Het Shopify Basic-abonnement kost 39 euro per maand', '3');
    assert.equal(v2.action, 'superseded');
    assert.equal(v2.reason, 'refresh');
    assert.equal(st.one<any>('SELECT status FROM memory_items WHERE id = ?', v1.item.id).status, 'superseded');
    const now2 = st.decode<any>('memory_items', st.get('memory_items', v2.item.id));
    assert.equal(now2.review_kind, 'price');
    assert.ok(now2.review_at > new Date().toISOString(), 'the new version gets its own next date');
    // A pinned fact is never replaced by itself: a proposal instead.
    const p1 = put('De nieuwste versie van het thema Dawn is 15.0', '4');
    await t.api('POST', `/memory/items/${p1.item.id}/pin`, {});
    st.exec('UPDATE memory_items SET review_at = ? WHERE id = ?', ago(1), p1.item.id);
    const p2 = put('De nieuwste versie van het thema Dawn is 15.2', '5');
    assert.notEqual(p2.action, 'superseded');
    assert.equal(st.one<any>('SELECT status FROM memory_items WHERE id = ?', p1.item.id).status, 'active');
  } finally {
    await t.close();
  }
});

test('the owner says it again: a due fact is confirmed by his own words, with or without a model (no extra call)', async () => {
  const t = await startTestApp();
  try {
    await freeEngine(t);
    const st = t.app.ctx.store;
    const a = await t.agent();
    const fact = (await t.api('POST', '/memory/items', { content: 'De huur van de winkel is 2100 euro per maand', scope: 'agent', agentId: a.id })).item;
    st.exec('UPDATE memory_items SET review_at = ? WHERE id = ?', ago(3), fact.id);
    let calls = 0;
    setShortCallFake((system) => (/Je bent het geheugen van TeamBot/.test(system) ? (calls++, 'NIETS') : ''));
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Genoteerd.' });
    await t.say(th.id, 'Ter herinnering: de huur van de winkel is nog steeds 2100 euro per maand.');
    const res = await t.app.ctx.services.memory.learner.learnNow(st.agent(a.id)!, st.thread(th.id)!);
    assert.equal(calls, 1, 'the one review call, nothing extra for the check');
    assert.equal(res?.confirmed, 1);
    assert.ok(st.one<any>('SELECT review_at FROM memory_items WHERE id = ?', fact.id).review_at > new Date().toISOString());

    // Without a model: his own words restating it confirm it too.
    setShortCallFake(null);
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    st.exec('UPDATE memory_items SET review_at = ? WHERE id = ?', ago(3), fact.id);
    t.script.push({ text: 'Oké.' });
    // (No model reads it: the conversation's job still confirms what he said again — no model call.)
    await t.say(th.id, 'Even ter info: de huur van de winkel is 2100 euro per maand, dat is niet veranderd.');
    await t.app.ctx.services.memory.learner.learnNow(st.agent(a.id)!, st.thread(th.id)!);
    assert.ok(st.one<any>('SELECT review_at FROM memory_items WHERE id = ?', fact.id).review_at > new Date().toISOString());
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});

test('nightly: a fact from a dossier document is re-read (changed → refreshed, same → confirmed); no source → "te controleren" after two weeks, also for the bot', async () => {
  const t = await startTestApp();
  try {
    await freeEngine(t);
    const me = t.app.ctx.auth.owner()!.id;
    const st = t.app.ctx.store;
    const mem = t.app.ctx.services.memory;
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Leverancier Boekhout' })).dossier;
    const src = await mem.dossiers.addSource(me, d.id, { kind: 'note', title: 'Prijslijst', text: 'Prijslijst 2027.\nEen Brooks-zadel kost 95 euro.\nStuurlint kost 18 euro per rol.\nEen complete ketting kost 35 euro.' });
    const fromDoc = (content: string, i: string) => mem.remember(me, { content, scope: 'dossier', dossierId: d.id, source: { kind: 'file', ref: src.id, excerpt: content, trust: 'system' }, idemKey: `d-${i}` }).item;
    const zadel = fromDoc('Een Brooks-zadel kost 89 euro', '1');
    const lint = fromDoc('Stuurlint kost 18 euro per rol', '2');
    const ketting = fromDoc('Een complete ketting kost 32 euro', '3');
    const loose = (await t.api('POST', '/memory/items', { content: 'De versie van onze kassa-app is 4.2', scope: 'shared' })).item;
    st.exec('UPDATE memory_items SET review_at = ? WHERE id IN (?, ?, ?)', ago(1), zadel.id, lint.id, ketting.id);
    st.exec('UPDATE memory_items SET review_at = ? WHERE id = ?', ago(20), loose.id);
    setShortCallFake((system, prompt) => {
      if (/controleert of een opgeslagen feit nog klopt/.test(system)) {
        if (/Brooks-zadel kost 89/.test(prompt)) return JSON.stringify({ status: 'changed', new: 'Een Brooks-zadel kost 95 euro', quote: 'Een Brooks-zadel kost 95 euro' });
        // A model that says "same" while its own quote has another price: never confirmed.
        if (/ketting kost 32/.test(prompt)) return JSON.stringify({ status: 'same', new: '', quote: 'Een complete ketting kost 35 euro' });
        return JSON.stringify({ status: 'same', new: '', quote: 'Stuurlint kost 18 euro per rol' });
      }
      if (/onderhoudsmodule/.test(system)) return JSON.stringify({ duplicates: [], contradictions: [], outdated: [] });
      return JSON.stringify({ summary: '' });
    });
    const rep = await t.api('POST', '/memory/maintenance', {});
    const ops = rep.lines.map((l: any) => l.op);
    assert.ok(ops.includes('refresh') && ops.includes('confirm') && ops.includes('review'), ops.join(','));
    assert.equal(st.one<any>('SELECT status FROM memory_items WHERE id = ?', zadel.id).status, 'superseded');
    const neu = st.one<any>("SELECT * FROM memory_items WHERE content = 'Een Brooks-zadel kost 95 euro' AND status = 'active'");
    assert.ok(neu, 'refreshed from the document');
    assert.ok(st.one<any>('SELECT review_at FROM memory_items WHERE id = ?', lint.id).review_at > new Date().toISOString(), 'confirmed');
    assert.ok(st.decode<any>('memory_items', st.get('memory_items', ketting.id)).flags.includes('check'), '"same" with another number in the quote is "te controleren"');
    const chk = st.decode<any>('memory_items', st.get('memory_items', loose.id));
    assert.ok(chk.flags.includes('check'));
    assert.match(chk.review_note, /veranderd/);
    // The owner sees it in Te beoordelen, with why; the bot reads it as uncertain.
    const review = await t.api('GET', '/memory/review');
    assert.ok(review.due.some((x: any) => x.id === loose.id && /veranderd/.test(x.review_note)));
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'ok' });
    const msgs = await t.say(th.id, 'Welke versie heeft de kassa-app?');
    assert.match(String(msgs.find((m: any) => m.role === 'user')?.parts?.context || ''), /te controleren/);
    // Undo of the report line puts the old price back.
    const idx = rep.lines.findIndex((l: any) => l.op === 'refresh');
    await t.api('POST', `/memory/reports/${rep.id}/undo`, { index: idx });
    assert.equal(st.one<any>('SELECT status FROM memory_items WHERE id = ?', zadel.id).status, 'active');
    // "Klopt nog" in Te beoordelen clears the note.
    await t.api('POST', `/memory/items/${loose.id}/confirm`, {});
    assert.ok(st.one<any>('SELECT review_at FROM memory_items WHERE id = ?', loose.id).review_at > new Date().toISOString());
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});
