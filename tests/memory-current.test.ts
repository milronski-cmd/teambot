/**
 * Memory and specialist knowledge that stay current, bounded and free of contradictions. One test per behaviour; each
 * fails on the code before this package:
 *   1. supersede instead of accumulate (a bot's tool, another module, the nightly sweep);
 *   2. bounded size (a knowledge base over its budget is brought back; the budget use is shown);
 *   3. freshness (a due fact is confirmed / updated / retired against its source; retired = "niet meer doen");
 *   4. no contradictions (newer and at least as well sourced wins at write time; unclear = one question);
 *   5. self-updating specialists by default (adopted by name, default sources, learning on, news search, record);
 *   6. memory updated at once after a message on a channel (a customer, and the owner himself);
 *   7. learning from mistakes (lessons always applied; work sent back; a double reply on two channels).
 * Fake model (the mock provider); the real-model runs are in docs/modules/memory.md › "Actueel, begrensd, zonder tegenspraak".
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mockAdapter, startTestApp, type MockStep, type TestApp } from './helpers.js';
import { setShortCallFake } from '../server/agent/short-call.js';
import type { AdapterContext, AdapterDef, Outbound } from '../server/modules/channels/types.js';
import type { ChannelManager } from '../server/modules/channels/manager.js';
import { writeCandidate } from '../server/modules/memory/pipeline.js';
import { overTarget } from '../server/modules/memory/cleanup.js';
import { specialismOf, defaultSourcesFor, newsQuery } from '../server/modules/specialists/defaults.js';

async function until<T>(fn: () => T | Promise<T>, ms = 8000, what = 'condition'): Promise<NonNullable<T>> {
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as NonNullable<T>;
    if (Date.now() - start > ms) throw new Error(`timeout waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}

const owner = (t: TestApp) => t.app.ctx.auth.owner()!.id as string;
const mem = (t: TestApp) => t.app.ctx.services.memory;
const active = (t: TestApp, where: string, ...a: any[]) => t.app.ctx.store.all<any>(`SELECT * FROM memory_items WHERE status = 'active' AND ${where}`, ...a);

// ------------------------------------------------------------------ 1 + 4: supersede, no contradictions

test('1/4 a newer note about the same subject replaces the old one (history, undo); the owner is asked only when his own words are at stake; the sweep resolves what is already there', async () => {
  const t = await startTestApp();
  try {
    const u = owner(t);
    const svc = mem(t).svc;
    const bot = await t.agent({ name: 'Bo', tool_groups: ['memory'] });
    const byBot = (content: string, key: string, extra: any = {}) =>
      writeCandidate(svc, { userId: u, content, scope: 'agent', agentId: bot.id, key, source: { kind: 'tool', ref: 'run1', trust: 'agent' }, origin: 'tool', createdBy: 'agent', createdByAgent: bot.id, ...extra });

    // A bot's own tool (memory_remember): the same subject again with a new value.
    const a1 = byBot('De website van de klant draait bij Hostnet', 'hosting website');
    assert.equal(a1.action, 'inserted');
    const a2 = byBot('De website van de klant draait bij TransIP', 'hosting website');
    assert.equal(a2.action, 'superseded', 'newer wins: not a second note, not a card');
    assert.equal(a2.reason, 'newer_source');
    const rows = t.app.ctx.store.all<any>("SELECT content, status, valid_to, superseded_by FROM memory_items WHERE agent_id = ? AND key_norm IS NOT NULL ORDER BY created_at", bot.id);
    assert.deepEqual(rows.map((r) => r.status), ['superseded', 'active']);
    assert.ok(rows[0].valid_to && rows[0].superseded_by, 'the old version is history, with its end date');
    // One undo brings the old one back.
    await t.api('POST', `/memory/changes/${a2.changeId}/undo`);
    assert.deepEqual(active(t, 'agent_id = ? AND key_norm IS NOT NULL', bot.id).map((r) => r.content), ['De website van de klant draait bij Hostnet']);

    // Another module pointing at the note it updates (services.memory.remember with replacesId).
    const old = active(t, 'agent_id = ? AND key_norm IS NOT NULL', bot.id)[0];
    const m1 = mem(t).remember(u, { content: 'De website van de klant is verhuisd naar Vimexx', agentId: bot.id, createdBy: 'agent', createdByAgent: bot.id, source: { kind: 'tool', ref: 'mod', trust: 'agent' }, replacesId: old.id });
    assert.equal(m1.action, 'superseded');
    assert.equal(active(t, "agent_id = ? AND content LIKE '%website van de klant%'", bot.id).length, 1, 'never both');

    // What the owner said himself is never overwritten by a bot: one question, and his words stay until he answers.
    const own = writeCandidate(svc, { userId: u, content: 'De webshop gebruikt het thema Dawn', scope: 'agent', agentId: bot.id, key: 'thema webshop', source: { kind: 'user', trust: 'user' }, origin: 'user_ui', createdBy: 'user' });
    assert.equal(own.action, 'inserted');
    const c = byBot('De webshop gebruikt het thema Sense', 'thema webshop');
    assert.equal(c.action, 'conflict');
    assert.equal(active(t, "agent_id = ? AND content LIKE '%thema%'", bot.id)[0].content, 'De webshop gebruikt het thema Dawn');
    // That question is what "Wacht op jou" shows (the review list with the note it contradicts).
    const review = await t.api('GET', '/memory/review');
    const card = review.proposals.find((p: any) => p.item.proposal_reason === 'conflict');
    assert.equal(card.conflict.content, 'De webshop gebruikt het thema Dawn');
    await t.api('POST', `/memory/items/${card.item.id}/approve`, { mode: 'replace' });
    assert.deepEqual(active(t, "agent_id = ? AND content LIKE '%thema%'", bot.id).map((r) => r.content), ['De webshop gebruikt het thema Sense'], 'his answer settles it: one note');

    // A pinned note is never replaced silently either.
    const pin = byBot('De klant wil facturen per e-mail', 'factuur kanaal');
    await t.api('POST', `/memory/items/${pin.item!.id}/pin`);
    assert.equal(byBot('De klant wil facturen per post', 'factuur kanaal').action, 'conflict');

    // The sweep: two active notes with the same key that got in next to each other (an older version, an import).
    const mk = (content: string, at: string) => svc.insertItem({ user_id: u, scope: 'agent', agent_id: bot.id, content, canonical_key: 'levertijd', source_kind: 'tool', source_trust: 'agent', created_by: 'agent', created_by_agent: bot.id, created_at: at, valid_from: at } as any);
    mk('De levertijd is vijf werkdagen', '2026-01-01T10:00:00.000Z');
    mk('De levertijd is twee werkdagen', '2026-06-01T10:00:00.000Z');
    assert.equal(active(t, "agent_id = ? AND content LIKE '%levertijd%'", bot.id).length, 2);
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    await mem(t).maintain(u, 'manual');
    assert.deepEqual(active(t, "agent_id = ? AND content LIKE '%levertijd%'", bot.id).map((r) => r.content), ['De levertijd is twee werkdagen'], 'the newest one holds, the other is history');
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------------ fixture: a small website

async function site() {
  const pages = new Map<string, string>();
  const hits = new Map<string, number>();
  const srv = http.createServer((req, res) => {
    const p = (req.url || '/').split('?')[0];
    hits.set(p, (hits.get(p) || 0) + 1);
    const body = pages.get(p);
    if (!body) return void (res.writeHead(404), res.end('niet gevonden'));
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  const port = await new Promise<number>((resolve) => srv.listen(0, '127.0.0.1', () => resolve((srv.address() as any).port)));
  return { base: `http://127.0.0.1:${port}`, pages, hits, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
const html = (title: string, ...paras: string[]) => `<!doctype html><html><head><title>${title}</title></head><body><main><h1>${title}</h1>${paras.map((p) => `<p>${p}</p>`).join('\n')}</main></body></html>`;

const extract = (fn: (prompt: string) => any): MockStep => {
  const s: MockStep = {
    check(req) {
      assert.match(req.system, /Je haalt feiten uit een bron/, 'this step is an extraction call');
      s.text = JSON.stringify(fn(String(req.messages[0]?.content || '')));
    },
  };
  return s;
};
const keyOf = (prompt: string, text: string) => prompt.split('\n').find((l) => l.includes(text))?.match(/^- ([kgf]\d+):/)?.[1] ?? null;
const lastRound = (t: TestApp, id: string) => t.app.ctx.store.decode<any>('specialist_rounds', t.app.ctx.store.one('SELECT * FROM specialist_rounds WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1', id));
const knowledge = (t: TestApp, id: string) => t.api('GET', `/specialists/${id}/knowledge`);

const A60 = 'De title tag van een pagina mag hoogstens 60 tekens lang zijn.';
const A70 = 'De title tag van een pagina mag hoogstens 70 tekens lang zijn.';
const KEYW = 'Meta keywords helpen Google om het onderwerp van een pagina te begrijpen.';
const CANON = 'Een canonical-tag vertelt zoekmachines welke versie van een pagina de hoofdversie is.';

// ------------------------------------------------------------------ 3: freshness

test('3 freshness: a due fact is checked against its source again: still there = confirmed (no model call), changed = replaced, gone = retired with reason and date, and the bot is told not to use it any more', async () => {
  const t = await startTestApp();
  const fx = await site();
  try {
    const u = owner(t);
    t.app.ctx.services.specialists.setOptions({ hostDelayMs: 0 });
    const bot = await t.agent({ name: 'Sem', settings: { allowPrivateNetwork: true } });
    fx.pages.set('/seo.html', html('SEO-gids', `${A60} Anders kort Google hem af.`, KEYW, CANON));
    const v = await t.api('PUT', `/specialists/${bot.id}`, { enabled: true, field: 'Zoekmachines en vindbaarheid', sources: [{ kind: 'web', target: `${fx.base}/seo.html`, label: 'Gids' }] });
    t.script.push(
      extract(() => ({
        facts: [
          { text: A60, quote: 'De title tag van een pagina mag hoogstens 60 tekens lang zijn' },
          { text: KEYW, quote: 'Meta keywords helpen Google om het onderwerp van een pagina te begrijpen' },
          { text: CANON, quote: 'Een canonical-tag vertelt zoekmachines welke versie van een pagina de hoofdversie is' },
        ],
      })),
    );
    await t.app.ctx.services.specialists.learn(u, bot.id);
    let kb = await knowledge(t, bot.id);
    assert.equal(kb.facts.length, 3);
    // Everything a specialist knows has a review date (a technique: 120 days), and "laatst bevestigd".
    const rows = t.app.ctx.store.all<any>('SELECT review_at, review_kind, review_every_days FROM memory_items WHERE dossier_id = ?', v.dossierId);
    assert.ok(rows.every((r) => r.review_at && r.review_every_days > 0), 'every fact has a review date');
    assert.ok(rows.some((r) => r.review_kind === 'practice'));

    // Four months later the page changed: 60 became 70, meta keywords are gone, the canonical line still stands.
    t.app.ctx.store.exec("UPDATE memory_items SET review_at = '2026-01-01T00:00:00.000Z' WHERE dossier_id = ?", v.dossierId);
    fx.pages.set('/seo.html', html('SEO-gids', `${A70} Anders kort Google hem af.`, CANON, 'Afbeeldingen met een alt-tekst worden beter gevonden in Google Afbeeldingen.'));
    let recheckCalls = 0;
    t.script.push(extract(() => ({ facts: [] })), {
      check(req) {
        recheckCalls++;
        assert.match(req.system, /controleert of feiten uit een kennisbank nog kloppen/);
        const prompt = String(req.messages[0].content);
        assert.doesNotMatch(prompt.split('<bron')[0], /canonical-tag/, 'what still stands literally in the source needs no model');
        const a = keyOf(prompt, A60);
        const k = keyOf(prompt, KEYW);
        assert.ok(a && k);
        (this as any).text = JSON.stringify({ results: [{ id: a, status: 'changed', new: A70, quote: 'De title tag van een pagina mag hoogstens 70 tekens lang zijn' }, { id: k, status: 'gone', why: 'staat niet meer in de bron' }] });
      },
    } as MockStep);
    await t.app.ctx.services.specialists.learn(u, bot.id);
    const r = lastRound(t, bot.id);
    assert.equal(recheckCalls, 1);
    assert.deepEqual([r.stats.confirmed, r.stats.updated, r.stats.retired], [1, 1, 1], JSON.stringify(r.lines));
    kb = await knowledge(t, bot.id);
    assert.deepEqual(kb.facts.map((f: any) => f.content).sort(), [A70, CANON].sort(), 'the new value replaced the old one; the retired fact is gone');
    // Confirmed: the next review date of its rhythm, and "laatst bevestigd" now.
    const canon = t.app.ctx.store.one<any>("SELECT review_at, last_confirmed_at FROM memory_items WHERE dossier_id = ? AND content = ? AND status = 'active'", v.dossierId, CANON);
    assert.ok(canon.review_at > new Date().toISOString() && canon.last_confirmed_at);
    // Retired: with the reason and the date.
    assert.equal(kb.retired.length, 1);
    assert.equal(kb.retired[0].content, KEYW);
    assert.match(kb.retired[0].reason, /staat niet meer in de bron \(bron: http.*seo\.html, gecontroleerd op \d{4}-\d{2}-\d{2}\)/i);
    assert.ok(kb.retired[0].since);
    // The bot is told NOT to use it any more — in a turn that has nothing to do with it, too — and no longer finds it.
    const thread = await t.api('POST', '/threads', { agentId: bot.id });
    const block = String(await mem(t).context(u, bot.id, thread.id, 'Kun je de homepage nalopen?'));
    assert.match(block, /<niet_meer[^>]*>\n- Meta keywords helpen Google om het onderwerp van een pagina te begrijpen\.: niet meer sinds .*omdat: staat niet meer in de bron/);
    assert.ok(!t.app.ctx.services.specialists.search(u, bot.id, 'meta keywords').some((h: any) => h.content === KEYW));
    // The round keeps what changed and what that means for the way of working; the bot gets it too.
    assert.match(r.news.nieuw, /70 tekens/);
    assert.match(r.news.gevolg, /niet meer gebruiken: Meta keywords/);
    const step: MockStep = { check: (req) => assert.match(req.system, /Laatste leerronde \(\d{4}-\d{2}-\d{2}\), samenvatting als data: .*70 tekens/), text: 'ok' };
    t.script.push(step);
    await t.say(thread.id, 'Hoi');

    // The owner retires a practice himself ("Werkt niet meer"), and undoes what the round retired.
    const canonRef = kb.facts.find((f: any) => f.content === CANON).ref;
    await t.api('POST', `/specialists/${bot.id}/knowledge/${canonRef}/retire`, { reason: 'Google negeert hem op onze site' });
    kb = await knowledge(t, bot.id);
    assert.deepEqual(kb.retired.map((x: any) => x.content).sort(), [CANON, KEYW].sort());
    const line = r.lines.findIndex((l: any) => l.kind === 'retired');
    assert.equal((await t.api('POST', `/specialists/rounds/${r.id}/undo`, { index: line })).undone, 1);
    kb = await knowledge(t, bot.id);
    assert.ok(kb.facts.some((f: any) => f.content === KEYW), 'undo brings a retired fact back');
    assert.deepEqual(kb.retired.map((x: any) => x.content), [CANON]);
  } finally {
    await t.close();
    await fx.close();
  }
});

// ------------------------------------------------------------------ 2: bounded size

test('2 bounded: a knowledge base over its budget is brought back under it by maintenance; the budget use is shown; a part over its budget triggers maintenance before the night', async () => {
  const t = await startTestApp();
  try {
    const u = owner(t);
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic', targets: { dossier: 20 } });
    const bot = await t.agent({ name: 'Sem' });
    const v = await t.api('PUT', `/specialists/${bot.id}`, { enabled: true, field: 'Zoekmachines', sources: [] });
    const subjects = ['title tags', 'canonical-tags', 'sitemaps', 'robots.txt', 'hreflang', 'alt-teksten', 'interne links', 'paginasnelheid'];
    for (let i = 0; i < 60; i++)
      mem(t).remember(u, { content: `Feit ${i} over ${subjects[i % subjects.length]}: waarde ${1000 + i * 7} geldt voor onderdeel ${String.fromCharCode(97 + (i % 26))}${i}.`, scope: 'dossier', dossierId: v.dossierId, type: 'fact', createdBy: 'agent', createdByAgent: bot.id, source: { kind: 'url', ref: `https://bron.example/${i}`, trust: 'system' }, compared: true });
    let view = await t.api('GET', `/specialists/${bot.id}`);
    assert.deepEqual(view.size, { active: 60, target: 20 }, 'the budget use is shown: 60 of 20');
    assert.equal(overTarget(mem(t).svc, u), true, 'over budget: maintenance does not wait for the night');
    await mem(t).maintain(u, 'manual');
    view = await t.api('GET', `/specialists/${bot.id}`);
    assert.ok(view.size.active <= 20, `back under the budget (${view.size.active})`);
    assert.equal(overTarget(mem(t).svc, u), false);
    // Nothing is thrown away: what left the active set is archived or summarised, with undo, and still findable.
    const kept = t.app.ctx.store.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE dossier_id = ? AND status IN ('active','archived')", v.dossierId).n;
    assert.ok(kept >= 60);
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------------ 5: self-updating by default

test('5 self-updating by default: a bot named after a known specialism becomes a specialist with default sources and the learning round on; it searches for what changed; a found page never overrules its own sources', async () => {
  // Pure: specialisms and their sources.
  assert.equal(specialismOf('SEO-specialist')?.id, 'seo');
  assert.equal(specialismOf('Google Ads campagnes')?.id, 'google-ads');
  assert.equal(specialismOf('Merchant Center feeds')?.id, 'merchant');
  assert.equal(specialismOf('Boekhouder'), null);
  assert.ok(defaultSourcesFor('SEO en Google Ads').some((s) => /search\/blog\/feed\.xml/.test(s.target)) && defaultSourcesFor('SEO en Google Ads').some((s) => /google-ads/.test(s.target)));
  assert.match(newsQuery('Zoekmachineoptimalisatie (SEO)', new Date('2026-11-09')), /^Google Search core update SEO november 2026$/);

  const t = await startTestApp();
  const fx = await site();
  try {
    const u = owner(t);
    const sp = t.app.ctx.services.specialists;
    sp.setOptions({ hostDelayMs: 0 });
    // Nothing configured: the owner only made a bot called "SEO-specialist".
    const seo = await t.agent({ name: 'SEO-specialist' });
    const v = await until(async () => ((await t.api('GET', `/specialists/${seo.id}`)).enabled ? t.api('GET', `/specialists/${seo.id}`) : null), 3000, 'adopted');
    assert.equal(v.field, 'Zoekmachineoptimalisatie (SEO)');
    assert.equal(v.learnOn, false, 'nothing that costs model calls starts by itself');
    assert.ok(!v.nextRoundAt, 'no round is planned until the round is switched on');
    const on = await t.api('PUT', `/specialists/${seo.id}`, { learnOn: true });
    assert.deepEqual([on.cadence, on.budget, on.learnWith], ['daily', 'none', 'own'], 'daily, on its own model, no limit of its own');
    assert.ok(on.nextRoundAt, 'the next round is planned');
    assert.ok(v.sources.some((s: any) => s.kind === 'feed' && /developers\.google\.com\/static\/search\/blog\/feed\.xml/.test(s.target) && s.suggested && s.enabled));
    assert.ok(v.sources.some((s: any) => /status\.search\.google\.com/.test(s.target)));
    // An ordinary bot is left alone; a specialist the owner switched off is never adopted again.
    const bo = await t.agent({ name: 'Bo' });
    assert.equal((await t.api('GET', `/specialists/${bo.id}`)).enabled, false);
    await t.api('PUT', `/specialists/${seo.id}`, { enabled: false });
    sp.svc.syncAll();
    assert.equal((await t.api('GET', `/specialists/${seo.id}`)).enabled, false);

    // Searching for what changed: one search, the page it finds is read like a source.
    const sem = await t.agent({ name: 'Sem', settings: { allowPrivateNetwork: true } });
    fx.pages.set('/seo.html', html('SEO-gids', `${A60} Anders kort Google hem af.`));
    fx.pages.set('/nieuws.html', html('Google-update november', 'Google heeft in november 2026 bekendgemaakt dat sitelinks in de zoekresultaten voortaan uit hoogstens acht regels bestaan, tegen zes regels eerder dit jaar.', 'Volgens deze blog mag de title tag van een pagina hoogstens 90 tekens lang zijn, maar dat is alleen een gerucht van een forum en nergens door Google zelf bevestigd of gedocumenteerd.'));
    await t.api('PUT', `/specialists/${sem.id}`, { enabled: true, field: 'Zoekmachines en vindbaarheid', sources: [{ kind: 'web', target: `${fx.base}/seo.html` }] });
    const queries: string[] = [];
    sp.setOptions({ search: async (_u: string, q: string) => (queries.push(q), [{ title: 'Google-update', url: `${fx.base}/nieuws.html` }]) });
    const SITELINKS = 'Sitelinks in de zoekresultaten bestaan sinds november 2026 uit hoogstens acht regels.';
    t.script.push(
      extract(() => ({ facts: [{ text: A60, quote: 'De title tag van een pagina mag hoogstens 60 tekens lang zijn' }] })),
      extract((prompt) => {
        assert.match(prompt, /nieuws\.html/);
        return { facts: [{ text: SITELINKS, quote: 'sitelinks in de zoekresultaten voortaan uit hoogstens acht regels bestaan' }, { text: 'De title tag van een pagina mag hoogstens 90 tekens lang zijn.', quote: 'mag de title tag van een pagina hoogstens 90 tekens lang zijn', contradicts: keyOf(prompt, A60) }] };
      }),
    );
    await sp.learn(u, sem.id);
    const r = lastRound(t, sem.id);
    assert.equal(queries.length, 1);
    assert.match(queries[0], /Zoekmachines en vindbaarheid nieuw wijziging \w+ \d{4}/);
    const kb = await knowledge(t, sem.id);
    assert.deepEqual(kb.facts.map((f: any) => f.content).sort(), [A60, SITELINKS].sort());
    assert.equal(t.app.ctx.store.one<any>('SELECT source_trust FROM memory_items WHERE content = ?', SITELINKS).source_trust, 'agent', 'a found page counts less than an own source');
    assert.ok(r.lines.some((l: any) => l.kind === 'rejected' && /spreekt een van je eigen bronnen tegen/.test(l.text)), 'a found page never overrules an own source');
    assert.ok(r.news?.nieuw, 'a short record of what is new');
    // Not again within the week, and never the same page twice.
    await sp.learn(u, sem.id);
    assert.equal(queries.length, 1);
    assert.equal(fx.hits.get('/nieuws.html'), 1);
  } finally {
    await t.close();
    await fx.close();
  }
});

// ------------------------------------------------------------------ channels (6 and 7)

function fakeAdapter(id: string, label: string) {
  const state = { ctx: null as AdapterContext | null, sent: [] as { conv: string; out: Outbound }[] };
  const def: AdapterDef = {
    id,
    label,
    description: 'test',
    needsPublicUrl: () => false,
    approveViaChannel: false,
    maxText: 4000,
    secretFields: [{ key: 'token', label: 'Token', required: true }],
    validate: () => ({}),
    test: async () => ({ ok: true, detail: 'ok' }),
    create(ctx) {
      state.ctx = ctx;
      return {
        async start() {
          return 'connected' as const;
        },
        async stop() {},
        async send(conv, out) {
          state.sent.push({ conv: conv.external_id, out });
          return [`out${state.sent.length}`];
        },
      };
    },
  };
  return { def, state };
}

async function channel(t: TestApp, agentId: string, adapterId: string, label: string) {
  const f = fakeAdapter(adapterId, label);
  t.app.ctx.services.channels.registerAdapter(f.def);
  const b = await t.api('POST', '/channels/bindings', { adapter: adapterId, name: label, agent_id: agentId, config: { customer: { enabled: true, knowledge: 'Openingstijden: maandag tot en met vrijdag 09:00–17:00.', aiLabel: false } }, secrets: { token: `fake-secret-token-${adapterId}-123456` } });
  await until(() => f.state.ctx && t.app.ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected', 3000, 'connected');
  return { f, b, ctx: f.state.ctx!, m: t.app.ctx.services.channels.manager as ChannelManager };
}
type Chan = Awaited<ReturnType<typeof channel>>;

let seq = 0;
/** Someone writes on a channel; resolves to the thread once the bot's run is done. `seen` gets what the model was given. */
async function writes(t: TestApp, c: Chan, who: string, text: string, reply: string, seen?: { text: string }) {
  t.script.push({ text: reply, check: (req) => seen && (seen.text = req.system + '\n' + JSON.stringify(req.messages)) });
  const before = c.f.state.sent.length;
  await c.ctx.receive({ messageId: `mc${++seq}`, conversation: { id: `chat-${who}`, title: who, private: true }, sender: { id: `id-${who}`, name: who }, text });
  const tid: string = await until(() => c.m.conversationByExt(c.b.id, `chat-${who}`)?.thread_id || null, 8000, `thread of ${who}`);
  await until(() => !t.app.ctx.store.one<any>("SELECT 1 FROM runs WHERE thread_id = ? AND status IN ('queued','running')", tid) && (c.f.state.sent.length > before || t.app.ctx.store.one<any>("SELECT 1 FROM runs WHERE thread_id = ? AND status NOT IN ('queued','running')", tid)), 8000, `run of ${who}`);
  return tid;
}

test('6 memory is updated at once after a message on a channel: a customer (no 15 minutes of quiet) and the owner writing to his own bot', async () => {
  const t = await startTestApp();
  try {
    const u = owner(t);
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const bot = await t.agent({ name: 'Winkelbot', tool_groups: ['memory'] });
    const wa = await channel(t, bot.id, 'nepwa', 'WhatsApp');
    assert.equal(mem(t).svc.userSettings(u).quietMin, 15, 'the quiet period for conversations in the app is unchanged');

    // A customer: one message, and his dossier knows it within seconds — nobody calls drain() here.
    const tid = await writes(t, wa, 'Karin', 'Hallo, ik woon in Zuidlaren. Mijn bestelnummer is 48211.', 'Dank je, Karin!');
    const did = await until(() => mem(t).customerDossierFor(tid) as string | null, 3000, 'customer dossier');
    const facts = await until(() => {
      const rows = active(t, 'dossier_id = ?', did);
      return rows.length >= 2 ? rows : null;
    }, 4000, 'facts learned at once');
    assert.match(facts.map((f: any) => f.content).join(' | '), /Zuidlaren/);
    const job = t.app.ctx.store.one<any>('SELECT due_at, status, last_run_at FROM memory_learn WHERE thread_id = ?', tid);
    assert.ok(job.last_run_at, 'the learning job ran right after the message');
    // And a new value replaces the old one (not next to it).
    await writes(t, wa, 'Karin', 'Ik woon in Haren, ik ben verhuisd.', 'Genoteerd!');
    await until(() => active(t, "dossier_id = ? AND content LIKE '%Haren%'", did).length === 1, 4000, 'the new address');
    assert.equal(active(t, "dossier_id = ? AND content LIKE '%Zuidlaren%'", did).length, 0, 'the old address is history');

    // The owner himself on WhatsApp (his own verified number): his words are read like in the app, at once — by the
    // one review, on a free engine (his customers' words stay with customer-learn above).
    t.app.ctx.providers.registerKind({ id: 'mock-local', label: 'Lokaal testmodel', type: 'api', group: 'local', billing: 'local', needsKey: false, description: 'test', models: ['lokaal-1'], defaultModel: 'lokaal-1', create: () => mockAdapter(t.script, t.requests) });
    await t.api('POST', '/providers', { kind: 'mock-local' });
    await t.api('PUT', '/memory/settings', { extractor: 'free' });
    setShortCallFake((system) => (/Je bent het geheugen van TeamBot/.test(system) ? 'Eigenaar: Ik woon in Amersfoort\nEigenaar: Mijn hond heet Bram' : ''));
    await t.api('POST', `/channels/bindings/${wa.b.id}/senders`, { external_id: 'id-Sanne', label: 'Sanne', is_owner: true });
    await writes(t, wa, 'Sanne', 'Ik woon in Amersfoort en mijn hond heet Bram.', 'Leuk!');
    const ownerBody = () => String(t.app.ctx.store.one<any>("SELECT body FROM memory_dossiers WHERE user_id = ? AND core = 'owner'", u)?.body || '');
    await until(() => (/Amersfoort/.test(ownerBody()) ? true : null), 4000, "the owner's words learned at once");
    assert.match(ownerBody(), /Mijn hond heet Bram/);
    setShortCallFake(null);
    // "Onthoud dat …" over WhatsApp works too.
    await writes(t, wa, 'Sanne', 'Onthoud dat de winkel op koningsdag gesloten is.', 'Doe ik.');
    await until(() => t.app.ctx.store.one<any>("SELECT 1 FROM memory_items WHERE user_id = ? AND content LIKE '%koningsdag%' AND status IN ('active','proposed')", u), 3000, 'explicit remember over the channel');
    // Someone who is not the owner never writes into the owner's memory by saying "ik woon in …".
    assert.equal(active(t, "user_id = ? AND scope = 'about_you' AND content LIKE '%Zuidlaren%'", u).length, 0);
    assert.doesNotMatch(ownerBody(), /Zuidlaren/);
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});

test('7 learning from mistakes: lessons are in every turn; work sent back becomes a lesson; the same customer on two channels is told apart, and a double reply becomes a lesson for the team', async () => {
  const t = await startTestApp();
  try {
    const u = owner(t);
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const bot = await t.agent({ name: 'Winkelbot', tool_groups: ['memory'] });
    const mate = await t.agent({ name: 'Collega', tool_groups: ['memory'] });

    // A lesson applies before the mistake is repeated: it is in a turn that shares no word with it.
    mem(t).remember(u, { content: 'Offertes stuur je als PDF, niet als Word-bestand.', scope: 'shared', agentId: bot.id, type: 'lesson', createdBy: 'user', source: { kind: 'message', trust: 'user' } });
    const chat = await t.api('POST', '/threads', { agentId: mate.id });
    const block = String(await mem(t).context(u, mate.id, chat.id, 'Wat is het weer morgen?'));
    assert.match(block, /Lessen uit eerdere fouten \(pas ze altijd toe\):\n- \[m:[a-z0-9]+\] Offertes stuur je als PDF/, 'the whole team works by it');

    // Work sent back ("nog niet klaar", with the reason) becomes a lesson.
    await t.app.ctx.services.quality.tellBot({ id: u, name: 'Sanne' }, t.app.ctx.store.agent(bot.id), 'De taak “Productfoto’s uploaden” is nog niet klaar. De foto’s staan er wel maar zonder alt-tekst.\n\nMaak hem af en meld hem opnieuw af met task_done, met bewijs.', { kind: 'task_reopened', taskId: 'tk1' });
    const sentBack = await until(() => t.app.ctx.store.one<any>("SELECT * FROM memory_items WHERE user_id = ? AND type = 'lesson' AND content LIKE '%alt-tekst%' AND status = 'active'", u), 4000, 'lesson from the task sent back');
    assert.match(sentBack.content, /Winkelbot meldde een taak \(“Productfoto’s uploaden”\) af als klaar, maar de eigenaar stuurde hem terug/);
    assert.equal(sentBack.scope, 'shared');

    // The double reply. A customer asks the same on WhatsApp and by e-mail.
    const wa = await channel(t, bot.id, 'nepwa', 'WhatsApp');
    const mail = await channel(t, bot.id, 'nepmail', 'E-mail');
    const Q = 'Hallo, wanneer wordt mijn bestelde regenjas eindelijk geleverd?';
    const ANSWER = 'Hallo Anna, ik zoek het voor je uit en kom er vandaag nog bij je op terug.';
    const t1 = await writes(t, wa, 'Anna', Q, ANSWER);
    // Before the bot answers on the second channel it is told the question came in elsewhere and was answered there.
    const seen = { text: '' };
    const notes: any[] = [];
    t.app.ctx.events.on('notification', (e) => notes.push(e.data));
    const t2 = await writes(t, mail, 'Anna', Q, ANSWER, seen);
    assert.notEqual(t1, t2);
    assert.match(seen.text, /<al_verstuurd[^>]*>\\n- Dezelfde vraag kwam .* ook binnen via WhatsApp en is daar al beantwoord\./, 'cross-channel awareness before answering');
    assert.match(seen.text, /Geef hier niet nog eens hetzelfde antwoord/);
    assert.doesNotMatch(seen.text, /ik zoek het voor je uit/, 'not linked by the owner: told THAT it was answered, never what was said');
    // The (fake) bot answered the same anyway: TeamBot notices, the team learns, the owner hears it once.
    const lesson = await until(() => t.app.ctx.store.one<any>("SELECT * FROM memory_items WHERE user_id = ? AND type = 'lesson' AND content LIKE '%al_verstuurd%' AND status = 'active'", u), 4000, 'lesson from the double reply');
    assert.match(lesson.content, /antwoord dan één keer.*\(Aanleiding: Een klant stelde dezelfde vraag via E-mail en via WhatsApp en kreeg twee keer antwoord\.\)/);
    assert.equal(lesson.scope, 'shared', 'for the whole team');
    assert.ok(notes.some((n) => n.title === 'Een klant kreeg twee keer antwoord' && /Is dit dezelfde klant\?/.test(n.body)));
    // Applied from then on, also in a customer conversation (where nothing else of memory may come).
    const seen3 = { text: '' };
    await writes(t, wa, 'Piet', 'Goedemiddag, hebben jullie ook regenbroeken voor kinderen?', 'Ja, die hebben we.', seen3);
    assert.match(seen3.text, /<lessen[^>]*>.*al_verstuurd/s);
    // The same pair of conversations makes no second lesson.
    await writes(t, mail, 'Anna', Q, ANSWER);
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(t.app.ctx.store.all<any>("SELECT id FROM memory_items WHERE user_id = ? AND type = 'lesson' AND content LIKE '%al_verstuurd%'", u).length, 1);

    // Once the owner says it is the same customer (one dossier), the bot sees what was sent on the other channel.
    const d1 = mem(t).customerDossierFor(t1) as string;
    const d2 = mem(t).customerDossierFor(t2) as string;
    assert.ok(d1 && d2 && d1 !== d2);
    const identity = mem(t).customers.info(u, d2).identities[0];
    mem(t).customers.link(u, identity.id, d1);
    const seen4 = { text: '' };
    await writes(t, mail, 'Anna', 'Kan de bezorging ook op een zaterdag?', 'Dat kan.', seen4);
    assert.match(seen4.text, /Verstuurd via WhatsApp \([^)]*\): “Hallo Anna, ik zoek het voor je uit/);
  } finally {
    await t.close();
  }
});
