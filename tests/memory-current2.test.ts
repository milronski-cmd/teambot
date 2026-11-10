/**
 * Second round of "current, bounded, contradiction-free" (see memory-current.test.ts):
 *   1b. memory_update and dossier decisions follow the same newer-and-as-well-sourced rule;
 *   2b. the three guards against a model's wrong answer in a learning round (found live with a local model);
 *   3b. maintenance starts by itself when a part is clearly over its budget;
 *   4b. the learning round is planned by the module itself (no run of the bot), on the specialist's own model by default;
 *       with "goedkoper model" only on a free or local one, else skipped quietly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestApp, type MockStep, type TestApp } from './helpers.js';
import { writeCandidate } from '../server/modules/memory/pipeline.js';

const owner = (t: TestApp) => t.app.ctx.auth.owner()!.id as string;
const mem = (t: TestApp) => t.app.ctx.services.memory;
const active = (t: TestApp, where: string, ...a: any[]) => t.app.ctx.store.all<any>(`SELECT * FROM memory_items WHERE status = 'active' AND ${where}`, ...a);

async function tool(t: TestApp, agentId: string, name: string, args: any): Promise<string> {
  const th = await t.api('POST', '/threads', { agentId });
  t.script.push({ toolCalls: [{ name, args }] }, { text: 'klaar' });
  const msgs = await t.say(th.id, 'Werk dit bij.');
  return String(msgs.find((m: any) => m.role === 'tool')?.content || '');
}

test('1b memory_update and dossier decisions follow the same rule: a bot replaces a bot, never the owner’s own words', async () => {
  const t = await startTestApp();
  try {
    const u = owner(t);
    const svc = mem(t).svc;
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const bo = await t.agent({ name: 'Bo', tool_groups: ['memory'] });
    const ada = await t.agent({ name: 'Ada', tool_groups: ['memory'] });
    // Shared knowledge written by a bot, updated by another bot of the team: replaced (before: a card).
    const shared = svc.insertItem({ user_id: u, scope: 'shared', content: 'De nieuwsbrief gaat elke dinsdag de deur uit', source_kind: 'tool', source_trust: 'agent', created_by: 'agent', created_by_agent: bo.id } as any);
    assert.match(await tool(t, ada.id, 'memory_update', { id: `m:${shared.ref}`, content: 'De nieuwsbrief gaat elke donderdag de deur uit' }), /Bijgewerkt: nieuwe versie/);
    assert.deepEqual(active(t, "scope = 'shared' AND content LIKE '%nieuwsbrief%'").map((r) => r.content), ['De nieuwsbrief gaat elke donderdag de deur uit']);
    // The owner's own note in the bot's memory: memory_update is one question, his words stay (before: overwritten).
    const own = writeCandidate(svc, { userId: u, content: 'Bo schrijft klanten altijd aan met u', scope: 'agent', agentId: bo.id, source: { kind: 'user', trust: 'user' }, origin: 'user_ui', createdBy: 'user' });
    assert.match(await tool(t, bo.id, 'memory_update', { id: `m:${own.item!.ref}`, content: 'Bo schrijft klanten altijd aan met je' }), /Voorstel .* klaargezet/);
    assert.equal(active(t, "agent_id = ? AND content LIKE '%schrijft klanten%'", bo.id)[0].content, 'Bo schrijft klanten altijd aan met u');
    const review = await t.api('GET', '/memory/review');
    assert.ok(review.proposals.some((p: any) => p.item.proposal_reason === 'conflict' && p.conflict?.id === own.item!.id), 'the question is what "Wacht op jou" shows');

    // Decisions through dossier_note: the same decision with another outcome replaces the bot's earlier one.
    const d = mem(t).dossiers.create(u, { title: 'Project Webshop', agentIds: [bo.id] }).dossier;
    const decisions = () => t.app.ctx.store.all<any>("SELECT title, status FROM memory_records WHERE dossier_id = ? AND kind = 'decision' ORDER BY created_at, rowid", d.id);
    await tool(t, bo.id, 'dossier_note', { dossier: `d:${d.ref}`, text: 'Besloten: we kiezen voor Shopify als platform voor de webshop.' });
    await tool(t, bo.id, 'dossier_note', { dossier: `d:${d.ref}`, text: 'Besloten: we kiezen voor WooCommerce als platform voor de webshop.' });
    assert.deepEqual(decisions().map((x) => x.status), ['superseded', 'active'], JSON.stringify(decisions()));
    // The owner's own decision is not replaced by a bot: a proposal.
    mem(t).dossiers.addDecision(u, d.id, { title: 'Besloten: we leveren alleen binnen Nederland en België.' });
    await tool(t, bo.id, 'dossier_note', { dossier: `d:${d.ref}`, text: 'Besloten: we leveren alleen binnen Nederland en Duitsland.' });
    const all = decisions();
    assert.equal(all.find((x) => /België/.test(x.title))!.status, 'active', 'the owner’s decision stays');
    assert.equal(all.find((x) => /Duitsland/.test(x.title))!.status, 'proposed');
  } finally {
    await t.close();
  }
});

// ------------------------------------------------------------------ a small website + scripted model

async function site() {
  const pages = new Map<string, string>();
  const srv = http.createServer((req, res) => {
    const body = pages.get((req.url || '/').split('?')[0]);
    if (!body) return void (res.writeHead(404), res.end('niet gevonden'));
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(body);
  });
  const port = await new Promise<number>((resolve) => srv.listen(0, '127.0.0.1', () => resolve((srv.address() as any).port)));
  return { base: `http://127.0.0.1:${port}`, pages, close: () => new Promise<void>((r) => srv.close(() => r())) };
}
const html = (...paras: string[]) => `<!doctype html><html><head><title>Gids</title></head><body><main><h1>Gids</h1>${paras.map((p) => `<p>${p}</p>`).join('\n')}</main></body></html>`;
const keyOf = (prompt: string, text: string) => prompt.split('\n').find((l) => l.includes(text))?.match(/^- ([kgf]\d+):/)?.[1] ?? null;
const answer = (re: RegExp, fn: (prompt: string) => any): MockStep => {
  const s: MockStep = {
    check(req) {
      assert.match(req.system, re);
      s.text = JSON.stringify(fn(String(req.messages[0]?.content || '')));
    },
  };
  return s;
};
const extract = (fn: (prompt: string) => any) => answer(/Je haalt feiten uit een bron/, fn);
const recheck = (fn: (prompt: string) => any) => answer(/controleert of feiten uit een kennisbank nog kloppen/, fn);
const knowledge = (t: TestApp, id: string) => t.api('GET', `/specialists/${id}/knowledge`);
const lastRound = (t: TestApp, id: string) => t.app.ctx.store.decode<any>('specialist_rounds', t.app.ctx.store.one('SELECT * FROM specialist_rounds WHERE agent_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 1', id));

const A60 = 'De title tag van een pagina mag hoogstens 60 tekens lang zijn.';
const A70 = 'De title tag van een pagina mag hoogstens 70 tekens lang zijn.';
const KEYW = 'Meta keywords helpen Google om het onderwerp van een pagina te begrijpen.';
const CANON = 'Een canonical-tag vertelt zoekmachines welke versie van een pagina de hoofdversie is.';
const ALT = 'Afbeeldingen met een alt-tekst worden beter gevonden in Google Afbeeldingen.';

test('2b the learning round does not follow a model’s wrong answer: "contradicts" about something else, "same" with another number, "still true" with a quote about something else', async () => {
  const t = await startTestApp();
  const fx = await site();
  try {
    const u = owner(t);
    t.app.ctx.services.specialists.setOptions({ hostDelayMs: 0 });
    const bot = await t.agent({ name: 'Sem', settings: { allowPrivateNetwork: true } });
    fx.pages.set('/seo.html', html(`${A60} Anders kort Google hem af.`, KEYW, CANON));
    const v = await t.api('PUT', `/specialists/${bot.id}`, { enabled: true, field: 'Zoekmachines en vindbaarheid', sources: [{ kind: 'web', target: `${fx.base}/seo.html` }] });
    t.script.push(extract(() => ({ facts: [{ text: A60, quote: 'De title tag van een pagina mag hoogstens 60 tekens lang zijn' }, { text: KEYW, quote: 'Meta keywords helpen Google om het onderwerp van een pagina te begrijpen' }, { text: CANON, quote: 'Een canonical-tag vertelt zoekmachines welke versie van een pagina de hoofdversie is' }] })));
    await t.app.ctx.services.specialists.learn(u, bot.id);
    assert.equal((await knowledge(t, bot.id)).facts.length, 3);

    // The page changes; every fact is due. The model answers wrongly three times.
    t.app.ctx.store.exec("UPDATE memory_items SET review_at = '2026-01-01T00:00:00.000Z' WHERE dossier_id = ?", v.dossierId);
    fx.pages.set('/seo.html', html(`${A70} Anders kort Google hem af.`, CANON, ALT));
    t.script.push(
      extract((prompt) => ({
        facts: [
          // (1) a fact about alt texts "contradicts" the one about canonical tags;
          { text: ALT, quote: 'Afbeeldingen met een alt-tekst worden beter gevonden in Google Afbeeldingen', contradicts: keyOf(prompt, CANON) },
          // (2) "70 tekens" is called the same as the known "60 tekens".
          { text: A70, quote: 'De title tag van een pagina mag hoogstens 70 tekens lang zijn', same: keyOf(prompt, A60) },
        ],
      })),
      // (3) the fact about meta keywords, gone from the page, is called "same" with a real quote about something else.
      recheck((prompt) => ({ results: [{ id: keyOf(prompt, KEYW), status: 'same', quote: 'Een canonical-tag vertelt zoekmachines welke versie van een pagina de hoofdversie is' }] })),
    );
    await t.app.ctx.services.specialists.learn(u, bot.id);
    const r = lastRound(t, bot.id);
    const kb = await knowledge(t, bot.id);
    const facts = kb.facts.map((f: any) => f.content);
    // (1) the canonical fact is still there, the alt-text fact is a new fact next to it.
    assert.ok(facts.includes(CANON), 'a wrong pointer never replaces an unrelated fact');
    assert.ok(facts.includes(ALT));
    assert.ok(r.lines.some((l: any) => l.kind === 'new' && l.text === ALT));
    // (2) another number is an update of the known fact, not "al bekend".
    assert.ok(facts.includes(A70) && !facts.includes(A60), '"same" with another number replaces the old value');
    assert.ok(r.lines.some((l: any) => l.kind === 'updated' && l.text === A70 && l.existing.text === A60));
    // (3) not confirmed on a quote about something else: still due, not "bevestigd".
    assert.ok(!r.lines.some((l: any) => l.kind === 'confirmed' && l.text === KEYW), 'not confirmed with a quote about something else');
    const keyw = t.app.ctx.store.one<any>("SELECT last_confirmed_at, status FROM memory_items WHERE dossier_id = ? AND content = ?", v.dossierId, KEYW);
    assert.equal(keyw.status, 'active');
    assert.equal(keyw.last_confirmed_at, null, '"laatst bevestigd" stays honest');
  } finally {
    await t.close();
    await fx.close();
  }
});

test('4b the learning round starts by itself without a run of the bot: on the own model by default; with "goedkoper model" only on a free or local one, else skipped quietly', async () => {
  const t = await startTestApp();
  const fx = await site();
  try {
    const u = owner(t);
    const sp = t.app.ctx.services.specialists;
    sp.setOptions({ hostDelayMs: 0 });
    fx.pages.set('/seo.html', html(`${A60} Anders kort Google hem af.`));
    const notes: any[] = [];
    t.app.ctx.events.on('notification', (e) => notes.push(e.data));
    // The owner chose "goedkoper model" for a bot on an engine that is not free (the mock provider, like a
    // subscription): the due round is skipped quietly.
    const paid = await t.agent({ name: 'Sem', settings: { allowPrivateNetwork: true } });
    await t.api('PUT', `/specialists/${paid.id}`, { enabled: true, field: 'Zoekmachines en vindbaarheid', learnWith: 'cheap', sources: [{ kind: 'web', target: `${fx.base}/seo.html` }] });
    const runs = () => t.app.ctx.store.one<any>('SELECT COUNT(*) AS n FROM runs').n;
    const calls = t.requests.length;
    assert.equal(await sp.svc.roundsDue(), 0);
    assert.equal(t.requests.length, calls, 'not one model call on the bot’s own engine');
    assert.equal(runs(), 0, 'and no run of the bot');
    assert.equal(t.app.ctx.store.all('SELECT id FROM specialist_rounds WHERE agent_id = ?', paid.id).length, 0);
    assert.equal(notes.length, 0, 'quietly');
    const v = await t.api('GET', `/specialists/${paid.id}`);
    assert.match(v.skipped.reason, /geen gratis of lokaal model/);
    assert.ok(Date.parse(v.nextRoundAt) > Date.now(), 'tried again later');
    // The default, "eigen model": the round runs by itself on the specialist's own model, any time it is due, without
    // a limit of its own — and still without a run of the bot.
    const v2 = await t.api('PUT', `/specialists/${paid.id}`, { learnWith: 'own', cadence: 'hourly' });
    assert.deepEqual([v2.learnWith, v2.cadence, v2.budget, v2.skipped], ['own', 'hourly', 'none', v2.skipped]);
    t.app.ctx.store.exec("UPDATE specialist_profiles SET settings = json_remove(settings, '$.autoSkip') WHERE agent_id = ?", paid.id);
    t.script.push(extract(() => ({ facts: [{ text: A60, quote: 'De title tag van een pagina mag hoogstens 60 tekens lang zijn' }] })));
    assert.equal(await sp.svc.roundsDue(), 1);
    assert.equal((await knowledge(t, paid.id)).facts.length, 1);
    assert.equal(runs(), 0, 'no run of the bot');
    assert.equal(await sp.svc.roundsDue(Date.now() + 30 * 60e3), 0, 'not yet: hourly');
    assert.equal(await sp.svc.roundsDue(Date.now() + 61 * 60e3), 1, 'an hour later again');

    // A bot on a local engine: the due round runs by itself, still without a run of the bot.
    const script: MockStep[] = [];
    const { mockAdapter } = await import('./helpers.js');
    t.app.ctx.providers.registerKind({ id: 'mocklocal', label: 'Lokaal', type: 'api', needsKey: false, billing: 'local', description: 'test', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter(script, []) } as any);
    const prov = await t.api('POST', '/providers', { kind: 'mocklocal' });
    const local = await t.agent({ name: 'Lot', provider_id: prov.id, settings: { allowPrivateNetwork: true } });
    await t.api('PUT', `/specialists/${local.id}`, { enabled: true, field: 'Zoekmachines en vindbaarheid', learnWith: 'cheap', sources: [{ kind: 'web', target: `${fx.base}/seo.html` }] });
    script.push({ text: JSON.stringify({ facts: [{ text: A60, quote: 'De title tag van een pagina mag hoogstens 60 tekens lang zijn' }] }) });
    assert.equal(await sp.svc.roundsDue(), 1, 'a new specialist learns right away');
    assert.equal(await sp.svc.roundsDue(), 0, 'and then not again until the next day');
    assert.equal(lastRound(t, local.id).trigger, 'auto');
    assert.equal((await knowledge(t, local.id)).facts.length, 1);
    assert.equal(runs(), 0, 'no run of any bot');
  } finally {
    await t.close();
    await fx.close();
  }
});

test('3b the ten-minute look starts maintenance during the day when a part is over its budget, at most once per six hours', async () => {
  const t = await startTestApp();
  try {
    const u = owner(t);
    const m = mem(t);
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic', targets: { agent: 20 } });
    const bot = await t.agent({ name: 'Bo', tool_groups: ['memory'] });
    // 02:00 at night, before the nightly hour: nothing is over budget, nothing starts.
    const at = new Date();
    at.setHours(2, 0, 0, 0);
    m.remember(u, { content: 'De winkel is op zondag gesloten.', agentId: bot.id, createdBy: 'agent', createdByAgent: bot.id });
    assert.deepEqual(m.maintenanceTick(at.getTime()), []);
    // 40 notes against a budget of 20: the next look starts maintenance, without waiting for the night.
    for (let i = 0; i < 40; i++) m.remember(u, { content: `Notitie ${i}: order ${5000 + i * 13} hoort bij vak ${String.fromCharCode(97 + (i % 26))}${i} in het magazijn.`, agentId: bot.id, createdBy: 'agent', createdByAgent: bot.id, compared: true });
    const count = () => active(t, "agent_id = ? AND scope = 'agent'", bot.id).length;
    assert.ok(count() > 22);
    assert.deepEqual(m.maintenanceTick(at.getTime()), [u], 'over budget: started now');
    await m.drain();
    assert.ok(count() <= 20, `back within the budget (${count()})`);
    // Over budget again right away: not a second run within six hours; after that, yes.
    for (let i = 0; i < 30; i++) m.remember(u, { content: `Aantekening ${i}: pakket ${7000 + i * 17} ligt klaar op plank ${String.fromCharCode(97 + (i % 26))}${i}.`, agentId: bot.id, createdBy: 'agent', createdByAgent: bot.id, compared: true });
    assert.deepEqual(m.maintenanceTick(at.getTime()), [], 'at most once per six hours');
    t.app.ctx.store.exec("UPDATE memory_meta SET last_maintenance_at = '2020-01-01T00:00:00.000Z' WHERE user_id = ?", u);
    assert.deepEqual(m.maintenanceTick(at.getTime()), [u]);
    await m.drain();
  } finally {
    await t.close();
  }
});

test('5b any specialism: a field nobody foresaw (beekeeping, tax law, TikTok) is adopted by what the bot is called, finds its own primary sources and starts learning', async () => {
  const { fieldOf, primaryScore } = await import('../server/modules/specialists/defaults.js');
  assert.equal(fieldOf('Belastingadviseur', 'Belastingrecht voor zzp’ers'), 'Belastingrecht voor zzp’ers');
  assert.equal(fieldOf('TikTok-specialist', ''), 'TikTok');
  assert.equal(fieldOf('SEO', ''), 'Zoekmachineoptimalisatie (SEO)', 'a preset is only a known case of the same thing');
  assert.equal(fieldOf('Bo', 'Algemene assistent'), null);
  assert.ok(primaryScore('https://www.belastingdienst.nl/zzp', 'Belastingdienst', 'Belastingrecht') > 0);
  assert.ok(primaryScore('https://www.tiktok.com/business', 'TikTok for Business', 'TikTok') > 0, 'the platform itself is primary for that platform');
  assert.equal(primaryScore('https://www.reddit.com/r/bijen', 'Bijen houden', 'Bijen houden'), 0, 'a forum is never a source');

  const t = await startTestApp();
  const fx = await site();
  try {
    const sp = t.app.ctx.services.specialists;
    sp.setOptions({ hostDelayMs: 0 });
    const BEES = 'Een bijenvolk heeft in de winter ongeveer vijftien kilo wintervoer nodig om tot het voorjaar te overleven.';
    fx.pages.set('/bijenhouders.html', html(BEES, 'De Nederlandse Bijenhoudersvereniging geeft voorlichting over het houden van bijen, de varroamijt en het inwinteren van volken. '.repeat(4)));
    const asked: string[] = [];
    sp.setOptions({ search: async (_u: string, q: string) => (asked.push(q), [{ title: 'Bijen houden - forum', url: 'https://www.reddit.com/r/bijen' }, { title: 'Bijen houden: officiële informatie van de Bijenhoudersvereniging', url: `${fx.base}/bijenhouders.html` }, { title: 'Bijen houden', url: `${fx.base}/bestaat-niet.html` }]) });
    // Nothing configured but the name and role: adopted, no preset, no sources yet.
    const bea = await t.agent({ name: 'Imker-expert', role: 'Bijen houden', settings: { allowPrivateNetwork: true } });
    for (let i = 0; i < 80 && !(await t.api('GET', `/specialists/${bea.id}`)).enabled; i++) await new Promise((r) => setTimeout(r, 25));
    let v = await t.api('GET', `/specialists/${bea.id}`);
    assert.deepEqual([v.enabled, v.field, v.learnOn, v.sources.length], [true, 'Bijen houden', true, 0]);
    // The first due round: it searches, keeps what answers and is primary, and learns from it.
    t.script.push(extract(() => ({ facts: [{ text: BEES, quote: 'Een bijenvolk heeft in de winter ongeveer vijftien kilo wintervoer nodig' }] })));
    assert.equal(await sp.svc.roundsDue(), 1);
    v = await t.api('GET', `/specialists/${bea.id}`);
    assert.deepEqual(v.sources.map((s: any) => [s.target, s.suggested]), [[`${fx.base}/bijenhouders.html`, true]], 'the forum and the dead link are no sources');
    assert.match(asked[0], /^Bijen houden officiële informatie$/);
    assert.deepEqual((await knowledge(t, bea.id)).facts.map((f: any) => f.content), [BEES]);
  } finally {
    await t.close();
    await fx.close();
  }
});

test('6b checking that things are current is standing behaviour of every bot: the rule in the prompt, the age on what memory gives, the update in the same turn, a dead proposed source replaced', async () => {
  const t = await startTestApp();
  const fx = await site();
  const fx2 = await site();
  try {
    const u = owner(t);
    const svc = mem(t).svc;
    // An ordinary bot (no specialism) with web tools, and one in chat-only mode.
    const bo = await t.agent({ name: 'Bo', tool_groups: ['memory', 'web'] });
    const chatOnly = await t.agent({ name: 'Praat', access_mode: 'chat' });
    // A time-sensitive note gets its review kind and date when it is written, in ordinary bot memory.
    const price = writeCandidate(svc, { userId: u, content: 'De hosting van de webshop kost 25 euro per maand', scope: 'agent', agentId: bo.id, source: { kind: 'tool', trust: 'agent' }, origin: 'tool', createdBy: 'agent', createdByAgent: bo.id });
    const row = svc.itemRow(price.item!.id)!;
    assert.equal(row.review_kind, 'price');
    assert.ok(row.review_at && row.review_at > new Date().toISOString());
    // Past its review date it comes into the turn marked with its age; the prompt tells the bot what to do with that.
    t.app.ctx.store.exec("UPDATE memory_items SET review_at = '2026-08-01T00:00:00.000Z' WHERE id = ?", row.id);
    const th = await t.api('POST', '/threads', { agentId: bo.id });
    let seen = '';
    t.script.push(
      { check: (req) => (seen = req.system + '\n' + JSON.stringify(req.messages)), toolCalls: [{ name: 'memory_update', args: { id: `m:${row.ref}`, content: 'De hosting van de webshop kost 29 euro per maand' } }] },
      { text: 'Het is nu 29 euro per maand.' },
    );
    await t.say(th.id, 'Wat kost de hosting van de webshop?');
    assert.match(seen, /## Actueel\n.*kennis stopt op een datum/);
    assert.match(seen, /controleer het dan eerst bij een actuele bron .*noem de bron met haar datum/);
    assert.match(seen, /Huidige datum en tijd:/);
    assert.match(seen, /mogelijk verouderd \(sinds 1 aug 2026\)\) De hosting van de webshop kost 25 euro/);
    assert.match(seen, /werk de herinnering dan in dezelfde beurt bij met memory_update/);
    // The bot re-checked and updated in the same turn: one note, the old value in the history.
    assert.deepEqual(active(t, "agent_id = ? AND content LIKE '%hosting%'", bo.id).map((r) => r.content), ['De hosting van de webshop kost 29 euro per maand']);
    // Without a tool to look things up the rule says: say plainly that you could not check.
    const th2 = await t.api('POST', '/threads', { agentId: chatOnly.id });
    let seen2 = '';
    t.script.push({ check: (req) => (seen2 = req.system), text: 'ok' });
    await t.say(th2.id, 'Hoi');
    assert.match(seen2, /## Actueel\n.*\n- .*kun je dat in dit gesprek niet nakijken: zeg dat er eerlijk bij/);

    // A source TeamBot proposed itself that stops answering: after three rounds switched off and replaced.
    const sp = t.app.ctx.services.specialists;
    sp.setOptions({ hostDelayMs: 0, search: async () => [{ title: 'Bijen houden: officiële informatie', url: `${fx2.base}/nieuw.html` }] });
    fx2.pages.set('/nieuw.html', html('De Nederlandse Bijenhoudersvereniging geeft voorlichting over het houden van bijen en het inwinteren van volken. '.repeat(5)));
    const bea = await t.agent({ name: 'Bea', settings: { allowPrivateNetwork: true } });
    await t.api('PUT', `/specialists/${bea.id}`, { enabled: true, field: 'Bijen houden', sources: [{ kind: 'web', target: `${fx.base}/weg.html`, suggested: true }] });
    for (let i = 0; i < 3; i++) await sp.learn(u, bea.id);
    const v = await t.api('GET', `/specialists/${bea.id}`);
    assert.deepEqual(v.sources.map((s: any) => [s.target.split('/').pop(), s.enabled]), [['weg.html', false], ['nieuw.html', true]]);
    assert.match(v.sources[0].lastError, /Drie keer niet bereikbaar/);
  } finally {
    await t.close();
    await fx.close();
    await fx2.close();
  }
});
