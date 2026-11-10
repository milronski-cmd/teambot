/**
 * 0.4 F2 "nooit oneindig groot": every part of memory stays within its target (summaries with sources, the least
 * valuable to the archive, a bounded archive), pinned / owner-confirmed / often used memories always stay, the archive
 * is out of the bots' context but found by the owner and restorable, and a monthly "opruimverslag" has undo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockAdapter, startTestApp, type TestApp } from './helpers.js';
import { setShortCallFake } from '../server/agent/short-call.js';
import { writeCandidate } from '../server/modules/memory/pipeline.js';
import { isProtected, monthKey, monthlyReport, subjectGroups, valueOf } from '../server/modules/memory/cleanup.js';

const svcOf = (t: TestApp) => t.app.ctx.services.memory.svc;
/** Twenty notes about twenty different things (nothing to summarise). */
const LOOSE = [
  'De koffiemachine is van Jura', 'De printer staat op de eerste verdieping', 'Parkeren kan achter het station', 'De post komt rond elf uur', 'Sleutels hangen in het kastje',
  'Het wifi-netwerk heet VeloGast', 'Vrijdag is de schoonmaker er', 'Het alarm gaat om zeven uur uit', 'Plantjes water geven op maandag', 'De brandblusser is gekeurd',
  'Lampen bestellen bij Hornbach', 'Het dak lekt bij regen', 'Voor de deur staat een fietsenrek', 'De buurvrouw neemt pakjes aan', 'Het magazijn ruikt naar olie',
  'De kantine heeft een nieuwe magnetron', 'Op zolder staan oude dozen', 'De voordeur klemt een beetje', 'Het telefoonboek ligt in de la', 'De vergaderkamer heet Merckx',
];
const ago = (days: number) => new Date(Date.now() - days * 864e5).toISOString();

/** A note the learner took from the owner's words (applied directly; not owner-confirmed). */
function learned(t: TestApp, agentId: string, content: string, i: number) {
  return writeCandidate(svcOf(t), { userId: t.app.ctx.auth.owner()!.id, content, scope: 'agent', agentId, source: { kind: 'message', trust: 'user', excerpt: content }, origin: 'model', createdBy: 'agent', createdByAgent: agentId, idemKey: `c-${i}`, ownStatement: true });
}

test('value and protection: pinned, owner-made, often or recently used never go; an owner’s keyed fact outweighs a note', () => {
  const base: any = { id: 'x', type: 'note', scope: 'agent', pinned: false, flags: [], use_count: 0, confidence: 0.8, sensitivity: 'normal', created_at: ago(300), updated_at: ago(300), last_used_at: null, last_confirmed_at: null, canonical_key: null };
  const none = new Set<string>();
  assert.equal(isProtected({ ...base, pinned: true }, none), true);
  assert.equal(isProtected(base, new Set(['x'])), true, 'owner-confirmed');
  assert.equal(isProtected({ ...base, use_count: 6 }, none), true, 'often used');
  assert.equal(isProtected({ ...base, last_used_at: ago(3) }, none), true, 'recently used');
  assert.equal(isProtected({ ...base, sensitivity: 'sensitive' }, none), true, 'never summarised');
  assert.equal(isProtected(base, none), false);
  assert.ok(valueOf({ ...base, scope: 'about_you', type: 'fact', canonical_key: 'woonplaats' }) > valueOf(base) + 2);
});

test('within the target: small facts about one subject become one summary with its sources, then the least valuable go to the archive; nothing important lost', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic', targets: { agent: 20 } });
    const st = t.app.ctx.store;
    const a = await t.agent({ name: 'Notitiebot' });
    // What must stay: pinned, written by the owner himself, used often.
    const pin = (await t.api('POST', '/memory/items', { content: 'Vaste afspraak: de groothandel levert op dinsdag', scope: 'agent', agentId: a.id })).item;
    await t.api('POST', `/memory/items/${pin.id}/pin`, {});
    const mine = (await t.api('POST', '/memory/items', { content: 'Het kenteken van de bus is VX-100-B', scope: 'agent', agentId: a.id })).item;
    const often = learned(t, a.id, 'De ophaaldag van retourpakketten is vrijdag', 0).item!;
    st.exec('UPDATE memory_items SET use_count = 8 WHERE id = ?', often.id);
    // Five small notes about one subject, and twenty loose ones.
    const jansen = ['Klant Jansen wil de offerte vóór vrijdag', 'Klant Jansen heeft een nieuwe inkoper, Piet', 'Klant Jansen betaalt altijd binnen 14 dagen', 'Klant Jansen bestelt graag in het voorjaar', 'Klant Jansen wil voortaan factuur per e-mail'];
    jansen.forEach((c, i) => learned(t, a.id, c, 10 + i));
    LOOSE.forEach((c, i) => learned(t, a.id, c, 100 + i));
    const before = st.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE agent_id = ? AND status = 'active'", a.id).n;
    assert.equal(before, 28);
    const rep = await t.api('POST', '/memory/maintenance', {});
    const active = st.all<any>("SELECT * FROM memory_items WHERE agent_id = ? AND status = 'active'", a.id);
    assert.ok(active.length <= 20, `within the target (${active.length})`);
    for (const id of [pin.id, mine.id, often.id]) assert.equal(st.one<any>('SELECT status FROM memory_items WHERE id = ?', id).status, 'active', 'important memories stay');
    // The summary keeps everything the five said, with them as its sources; they are archived, not gone.
    const sum = st.decode<any>('memory_items', active.find((r) => r.source_kind === 'consolidation'));
    assert.ok(sum, 'a summary');
    assert.equal(sum.merge_of.length, 5);
    for (const w of ['offerte', 'Piet', '14 dagen', 'voorjaar', 'e-mail']) assert.match(sum.content, new RegExp(w));
    assert.ok(jansen.every((c) => st.one<any>('SELECT status FROM memory_items WHERE content = ?', c).status === 'archived'));
    assert.ok(rep.lines.some((l: any) => l.op === 'consolidate') && rep.lines.some((l: any) => l.op === 'archive'));
    // Archived = out of the bot's context, still found by the owner (with its status), restorable with one click.
    const archived = st.one<any>(`SELECT * FROM memory_items WHERE agent_id = ? AND status = 'archived' AND content IN (${LOOSE.map(() => '?').join(',')})`, a.id, ...LOOSE);
    const reader = svcOf(t).readerFor(st.agent(a.id)!, null);
    assert.equal(svcOf(t).searchItems(reader, archived.content, { limit: 10 }).some((h: any) => h.row.id === archived.id), false, 'not for the bot');
    const found = (await t.api('GET', `/memory/search?q=${encodeURIComponent(archived.content)}`)).items.find((x: any) => x.id === archived.id);
    assert.equal(found?.status, 'archived', 'the owner still finds it');
    await t.api('POST', `/memory/items/${archived.id}/restore`, {});
    assert.equal(st.one<any>('SELECT status FROM memory_items WHERE id = ?', archived.id).status, 'active');
    // Undo of the summary line brings the five back and takes the summary away.
    const idx = rep.lines.findIndex((l: any) => l.op === 'consolidate');
    await t.api('POST', `/memory/reports/${rep.id}/undo`, { index: idx });
    assert.ok(jansen.every((c) => st.one<any>('SELECT status FROM memory_items WHERE content = ?', c).status === 'active'));
    assert.notEqual(st.one<any>('SELECT status FROM memory_items WHERE id = ?', sum.id).status, 'active');
  } finally {
    await t.close();
  }
});

test('long unused and worth little → archive (an owner’s own keyed fact stays); a full archive is trimmed to the trash, never what the owner confirmed', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic', archiveAfterDays: 180, quotas: { agent: { items: 60, bytes: 512_000 } }, targets: { agent: 50 } });
    const st = t.app.ctx.store;
    const me = t.app.ctx.auth.owner()!.id;
    const a = await t.agent();
    const note = learned(t, a.id, 'De koffiemachine op kantoor is van Jura', 1).item!;
    const city = writeCandidate(svcOf(t), { userId: me, content: 'Ik woon in Utrecht', scope: 'about_you', key: 'woonplaats', source: { kind: 'message', trust: 'user' }, origin: 'model', createdBy: 'agent', createdByAgent: a.id, idemKey: 'c-city', ownStatement: true }).item!;
    st.exec('UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id IN (?, ?)', ago(200), ago(200), note.id, city.id);
    // A full archive: old archived notes up to the quota, and one the owner himself put there.
    for (let i = 0; i < 52; i++) {
      const r = learned(t, a.id, `Oude afgehandelde kwestie ${i} met code ${i * 13}`, 200 + i).item!;
      st.exec("UPDATE memory_items SET status = 'archived', updated_at = ? WHERE id = ?", ago(120), r.id);
    }
    const keep = (await t.api('POST', '/memory/items', { content: 'Mijn eigen gearchiveerde aantekening over de verbouwing', scope: 'agent', agentId: a.id })).item;
    await t.api('POST', `/memory/items/${keep.id}/archive`, {});
    st.exec('UPDATE memory_items SET updated_at = ? WHERE id = ?', ago(120), keep.id);
    const rep = await t.api('POST', '/memory/maintenance', {});
    assert.equal(st.one<any>('SELECT status FROM memory_items WHERE id = ?', note.id).status, 'archived', 'a long unused note');
    assert.equal(st.one<any>('SELECT status FROM memory_items WHERE id = ?', city.id).status, 'active', 'where the owner lives stays');
    const retained = st.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE agent_id = ? AND status IN ('active','proposed','archived','superseded')", a.id).n;
    assert.ok(retained <= 48, `the archive was trimmed (${retained})`);
    assert.equal(st.one<any>('SELECT status FROM memory_items WHERE id = ?', keep.id).status, 'archived', 'never what the owner archived himself');
    assert.ok(rep.lines.some((l: any) => l.op === 'trash'));
    // Nothing piles up as proposals any more: no automatic merge proposals.
    assert.equal(st.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE status = 'proposed' AND proposal_reason = 'consolidation'").n, 0);
  } finally {
    await t.close();
  }
});

test('monthly "opruimverslag": the cleanup of last month in one report, with sizes and undo, and a notification', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const st = t.app.ctx.store;
    const svc = svcOf(t);
    const me = t.app.ctx.auth.owner()!.id;
    const a = await t.agent();
    const r = learned(t, a.id, 'Een notitie die al lang niet gebruikt is', 1).item!;
    st.exec('UPDATE memory_items SET created_at = ?, updated_at = ? WHERE id = ?', ago(400), ago(400), r.id);
    // Last month's maintenance archived it …
    const rep = await t.api('POST', '/memory/maintenance', {});
    assert.equal(st.one<any>('SELECT status FROM memory_items WHERE id = ?', r.id).status, 'archived');
    const lastMonth = new Date();
    lastMonth.setDate(1);
    lastMonth.setMonth(lastMonth.getMonth() - 1);
    st.exec('UPDATE memory_reports SET started_at = ? WHERE id = ?', new Date(lastMonth.getTime() + 3 * 864e5).toISOString(), rep.id);
    svc.bumpMeta(me, { last_cleanup_month: monthKey(lastMonth) });
    // … and the first maintenance of this month sums it up.
    const id = monthlyReport(svc, me);
    assert.ok(id);
    const monthly = (await t.api('GET', '/memory/reports?trigger=monthly'))[0];
    assert.equal(monthly.trigger, 'monthly');
    assert.match(monthly.summary, /gearchiveerd/);
    assert.ok(monthly.lines.some((l: any) => l.op === 'size'), 'the size of each part against its target');
    const idx = monthly.lines.findIndex((l: any) => l.op === 'archive');
    assert.ok(idx >= 0);
    await t.api('POST', `/memory/reports/${monthly.id}/undo`, { index: idx });
    assert.equal(st.one<any>('SELECT status FROM memory_items WHERE id = ?', r.id).status, 'active', 'undo from the monthly report');
    // Once a month.
    assert.equal(monthlyReport(svc, me), null);
  } finally {
    await t.close();
  }
});

test('subjects: only small, unprotected notes that share a real word are grouped', () => {
  const fake: any = { contentOf: (r: any) => r.content };
  const row = (id: string, content: string, extra: any = {}) => ({ id, content, type: 'note', key_norm: null, canonical_key: null, created_at: id, ...extra });
  const g = subjectGroups(fake, [row('1', 'Klant Jansen wil de offerte vóór vrijdag'), row('2', 'Klant Jansen heeft een nieuwe inkoper'), row('3', 'Klant Jansen betaalt snel'), row('4', 'De printer is kapot'), row('5', 'Noem bedragen inclusief btw', { type: 'instruction' })]);
  assert.equal(g.length, 1);
  assert.deepEqual(g[0].map((r: any) => r.id), ['1', '2', '3']);
});

test('summaries by the free model are checked: nothing invented, else the facts joined', async () => {
  const t = await startTestApp();
  try {
    t.app.ctx.providers.registerKind({ id: 'mock-local', label: 'Lokaal testmodel', type: 'api', group: 'local', billing: 'local', needsKey: false, description: 'test', models: ['lokaal-1'], defaultModel: 'lokaal-1', create: () => mockAdapter(t.script, t.requests) });
    await t.api('POST', '/providers', { kind: 'mock-local' });
    await t.api('PUT', '/memory/settings', { targets: { agent: 20 } });
    setShortCallFake((system) => {
      if (/vat herinneringen over hetzelfde onderwerp samen/.test(system)) return JSON.stringify({ summary: 'Klant Jansen wil de offerte vóór vrijdag en heeft een nieuwe inkoper; hij betaalt binnen 14 dagen en krijgt 50 procent korting' });
      if (/onderhoudsmodule/.test(system)) return JSON.stringify({ duplicates: [], contradictions: [], outdated: [] });
      return JSON.stringify({ summary: '' });
    });
    const a = await t.agent();
    ['Klant Jansen wil de offerte vóór vrijdag', 'Klant Jansen heeft een nieuwe inkoper', 'Klant Jansen betaalt binnen 14 dagen'].forEach((c, i) => learned(t, a.id, c, i));
    for (let i = 0; i < 20; i++) learned(t, a.id, `Losse notitie ${i} over iets anders nummer ${i * 7}`, 50 + i);
    await t.api('POST', '/memory/maintenance', {});
    const sum = t.app.ctx.store.one<any>("SELECT content FROM memory_items WHERE source_kind = 'consolidation' AND status = 'active'");
    assert.ok(sum);
    assert.doesNotMatch(sum.content, /50 procent korting/, 'the invented part was refused: the facts were joined instead');
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});
