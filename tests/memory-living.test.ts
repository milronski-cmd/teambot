/**
 * Living dossiers (server/modules/memory/living.ts): the shared memory the bots keep themselves.
 * - what one bot writes, every bot of the owner reads in its next turn, without any setting;
 * - the core dossiers are in every turn on an API engine, on Claude Code and on an engine with its own session;
 * - a dossier has a limit: over it the write is refused, a shorter rewrite moves what went out to a searchable archive;
 * - a conversation of thirty messages leaves a handful of notes, not dozens;
 * - the one-time consolidation of loose notes loses nothing and one undo brings everything back.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import type { AgentRunRequest } from '../server/core/types.js';
import { BODY_LIMITS, coreDossiers } from '../server/modules/memory/living.js';
import { moveLooseNotes, moveOnce } from '../server/modules/memory/move.js';

const svcOf = (t: TestApp) => t.app.ctx.services.memory.svc;

/** One tool call by a bot in a new conversation; returns the tool's answer. */
async function tool(t: TestApp, agentId: string, name: string, args: any, say = 'doe het') {
  const th = await t.api('POST', '/threads', { agentId });
  t.script.push({ toolCalls: [{ name, args }] }, { text: 'ok' });
  const msgs = await t.say(th.id, say);
  return String(msgs.find((m: any) => m.role === 'tool')?.content || '');
}

/** The system prompt a bot gets for a new message. */
async function systemOf(t: TestApp, agentId: string, say = 'Hoi') {
  const th = await t.api('POST', '/threads', { agentId });
  const n = t.requests.length;
  await t.say(th.id, say);
  return t.requests[n].system;
}

async function twoBots() {
  const t = await startTestApp();
  await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
  const ada = await t.agent({ name: 'Ada' });
  const bo = await t.agent({ name: 'Bo' });
  return { t, ada, bo, owner: t.app.ctx.auth.owner()!.id };
}

test('fresh install: an empty data dir, a first bot, a few messages — the dossiers exist, fill through the bot’s own writes, are shared with a second bot and stay within their limit', async () => {
  // No settings touched, nothing prepared: exactly what a new user gets.
  const t = await startTestApp();
  try {
    const store = t.app.ctx.store;
    assert.equal(store.one<any>('SELECT COUNT(*) AS n FROM memory_dossiers').n, 0);
    const first = await t.agent({ name: 'Eerste bot' });
    const th = await t.api('POST', '/threads', { agentId: first.id });

    // Message 1: the bot gets its instructions and four empty core dossiers with neutral names.
    await t.say(th.id, 'Hoi, ik ben net begonnen.');
    const sys0 = t.requests[0].system;
    assert.match(sys0, /Bijhouden doe je zelf, in dezelfde beurt, met dossier_write/);
    for (const name of ['Eigenaar', 'Overzicht', 'Lessen', 'Werknotities van Eerste bot']) assert.match(sys0, new RegExp(`<dossier id="d:[a-z0-9]+" naam="${name}" tekens="0/\\d+"`), name);
    assert.equal((sys0.match(/\(nog leeg\)/g) || []).length, 4, 'empty structure, no assumptions about the user');
    // In every call: reading and keeping the dossiers, and searching. The loose-note tools are found on demand.
    const everyday = t.requests[0].tools.map((x) => x.name).filter((n) => /^(memory|dossier)_/.test(n)).sort();
    assert.deepEqual(everyday, ['dossier_get', 'dossier_write', 'memory_search']);
    const has = (await t.app.ctx.tools.forAgent(t.app.ctx.store.agent(first.id)!, t.app.ctx.store.thread(th.id)!)).map((x) => x.name);
    for (const n of ['memory_forget', 'memory_remember', 'memory_update']) assert.ok(has.includes(n), `${n} within reach`);
    assert.match(t.requests[0].tools.find((x) => x.name === 'tools_find')!.description, /losse notities: memory_remember, memory_update, memory_forget/);

    // Messages 2–4: the owner tells things; the bot writes them down itself, in the same turn.
    const turn = async (say: string, calls: any[]) => {
      t.script.push({ toolCalls: calls.map((args) => ({ name: 'dossier_write', args })) }, { text: 'Genoteerd.' });
      const msgs = await t.say(th.id, say);
      return msgs.filter((m: any) => m.role === 'tool').slice(-calls.length).map((m: any) => String(m.content));
    };
    const r1 = await turn('Ik heet Sam en ik wil altijd korte antwoorden.', [{ dossier: 'Eigenaar', content: 'Heet Sam. Wil altijd korte antwoorden.' }]);
    assert.match(r1[0], /bijgewerkt \(\d+\/5000 tekens\)/);
    const r2 = await turn('Ik ben bezig met de verbouwing van mijn zolder; de aannemer begint in maart.', [
      { dossier: 'Verbouwing zolder', kind: 'project', content: 'De zolder wordt een werkkamer. De aannemer begint in maart.' },
      { dossier: 'Overzicht', content: '- Verbouwing zolder: start in maart (dossier "Verbouwing zolder").' },
    ]);
    assert.match(r2[0], /aangemaakt/);
    const r3 = await turn('De aannemer begint toch pas in april.', [{ dossier: 'Verbouwing zolder', mode: 'replace', old_text: 'De aannemer begint in maart.', content: 'De aannemer begint in april.' }]);
    assert.match(r3[0], /bijgewerkt/);
    const zolder = () => String(store.one<any>("SELECT body FROM memory_dossiers WHERE title = 'Verbouwing zolder'").body);
    assert.equal(zolder(), 'De zolder wordt een werkkamer. De aannemer begint in april.', 'updated in place, not appended');

    // The next turn of the same bot already has it (no restart, no setting).
    t.script.push({ text: 'ok' });
    await t.say(th.id, 'Dank je.');
    assert.match(t.requests.at(-1)!.system, /Heet Sam\. Wil altijd korte antwoorden\./);

    // A second bot, made afterwards: it reads everything at once.
    const second = await t.agent({ name: 'Tweede bot' });
    const sys = await systemOf(t, second.id, 'Wat weet je al?');
    assert.match(sys, /naam="Eigenaar"[^\n]*\n[^\n]*\nHeet Sam\. Wil altijd korte antwoorden\./);
    assert.match(sys, /Verbouwing zolder: start in maart/);
    assert.match(sys, /Andere dossiers[^\n]*\n- \[d:[a-z0-9]+\] Verbouwing zolder/);
    assert.match(await tool(t, second.id, 'dossier_get', { dossier: 'Verbouwing zolder' }), /De aannemer begint in april\./);

    // Within the limit, whatever the bots try: a write that would go over it is refused and nothing changes.
    const big = Array.from({ length: 120 }, (_, i) => `- Regel ${i} met genoeg woorden om ruimte te vullen in dit dossier, nummer ${i * 13}.`).join('\n');
    assert.match(await tool(t, second.id, 'dossier_write', { dossier: 'Eigenaar', content: big }), /er passen er 5000 in/);
    for (const d of store.all<any>('SELECT core, LENGTH(body) AS n FROM memory_dossiers')) assert.ok(d.n <= BODY_LIMITS[(d.core as keyof typeof BODY_LIMITS) || 'subject'], `${d.core}: ${d.n}`);
    // What TeamBot caught by itself along the way is already in a dossier: no loose notes in view, nothing waits for
    // the owner.
    assert.doesNotMatch(await systemOf(t, second.id), /Losse notities/);
    assert.equal(store.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE status = 'proposed'").n, 0);
    assert.ok(store.one<any>('SELECT COUNT(*) AS n FROM memory_items').n <= 2);
  } finally {
    await t.close();
  }
});

test('shared by default: what bot A writes in a dossier, bot B reads in its next turn', async () => {
  const { t, ada, bo } = await twoBots();
  try {
    const out = await tool(t, ada.id, 'dossier_write', { dossier: 'Eigenaar', content: 'Sam wil dat de bots alles zelf regelen en alleen bij twijfel iets vragen.', section: 'Voorkeuren' });
    assert.match(out, /bijgewerkt/);
    assert.match(out, /Alle bots van je team lezen dit/);
    // A new subject gets its own dossier, for the whole team (not "only for you").
    const made = await tool(t, ada.id, 'dossier_write', { dossier: 'Verbouwing zolder', kind: 'project', content: 'De zolder wordt een werkkamer. De aannemer is Bouwbedrijf De Wit.' });
    assert.match(made, /aangemaakt/);
    // A loose note is shared too, and applies at once (no proposal for the owner).
    const note = await tool(t, ada.id, 'memory_remember', { content: 'De boekhouding staat in het pakket Rekenmaar' });
    assert.match(note, /Onthouden \[m:/);
    const store = t.app.ctx.store;
    assert.equal(store.one<any>("SELECT scope, status FROM memory_items WHERE content LIKE 'De boekhouding%'")?.scope, 'shared');
    assert.equal(store.one<any>("SELECT status FROM memory_items WHERE content LIKE 'De boekhouding%'")?.status, 'active');
    assert.equal(store.one<any>("SELECT agent_ids FROM memory_dossiers WHERE title = 'Verbouwing zolder'")?.agent_ids, null, 'for every bot of the team');

    const sys = await systemOf(t, bo.id);
    assert.match(sys, /## Dossiers/);
    assert.match(sys, /<dossier id="d:[a-z0-9]+" naam="Eigenaar"/);
    assert.match(sys, /Sam wil dat de bots alles zelf regelen en alleen bij twijfel iets vragen\./);
    assert.match(sys, /naam="Overzicht"/);
    assert.match(sys, /naam="Lessen"/);
    assert.match(sys, /naam="Werknotities van Bo"/);
    assert.match(sys, /Andere dossiers[^\n]*\n- \[d:[a-z0-9]+\] Verbouwing zolder — De zolder wordt een werkkamer/);
    // The note is a note of the team's “Overzicht” now (every write lands in a dossier): Bo reads it with that dossier.
    assert.match(sys, /Notities bij deze dossiers[^\n]*\n- \[m:[a-z0-9]+\] De boekhouding staat in het pakket Rekenmaar \(Overzicht\)/);
    // Bo reads the subject dossier with one simple tool, by its name.
    const read = await tool(t, bo.id, 'dossier_get', { dossier: 'Verbouwing zolder' });
    assert.match(read, /De aannemer is Bouwbedrijf De Wit\./);
    // The list of dossiers, without a name.
    const list = await tool(t, bo.id, 'dossier_get', {});
    assert.match(list, /Eigenaar/);
    assert.match(list, /Verbouwing zolder/);
  } finally {
    await t.close();
  }
});

test('the owner reviews what bots write ("Eerst als voorstel"): what a bot puts in a dossier is a card; approved, every bot reads it; making the text shorter still goes at once; also chosen for one bot', async () => {
  const { t, ada, bo } = await twoBots();
  try {
    const sys = (id: string) => systemOf(t, id);
    await tool(t, ada.id, 'dossier_write', { dossier: 'Overzicht', content: '- De winkel is op maandag dicht.\n- Oude regel die weg mag.' });
    await t.api('PUT', '/memory/settings', { botWrites: 'propose' });
    const out = await tool(t, ada.id, 'dossier_write', { dossier: 'Overzicht', content: '- De nieuwe leverancier levert op dinsdag.' });
    assert.match(out, /voorstel/);
    const overview = () => String(coreDossiers(svcOf(t), t.app.ctx.store.agent(ada.id)!).find((d) => d.core === 'overview')!.body);
    assert.doesNotMatch(overview(), /leverancier/, 'the text is not changed');
    assert.doesNotMatch(await sys(bo.id), /leverancier/, 'not read before the owner approves');
    const card = (await t.api('GET', '/memory/review')).proposals.find((p: any) => /leverancier levert op dinsdag/.test(p.item.content));
    assert.ok(card, 'a card for the owner');
    await t.api('POST', `/memory/items/${card.item.id}/approve`, {});
    assert.match(await sys(bo.id), /leverancier levert op dinsdag/, 'approved: a note of the dossier, read by every bot');
    // Making the text shorter adds nothing: at once.
    assert.match(await tool(t, ada.id, 'dossier_write', { dossier: 'Overzicht', mode: 'rewrite', content: '- De winkel is op maandag dicht.' }), /bijgewerkt/);
    assert.doesNotMatch(overview(), /Oude regel/);
    // The same choice for one bot only (its own memory settings): its writes wait, a colleague's do not.
    await t.api('PUT', '/memory/settings', { botWrites: 'direct' });
    await t.api('PATCH', `/agents/${bo.id}`, { settings: { memory: { botWrites: 'propose' } } });
    assert.match(await tool(t, bo.id, 'dossier_write', { dossier: 'Eigenaar', content: '- Sam drinkt thee zonder suiker.' }), /voorstel/);
    assert.match(await tool(t, bo.id, 'memory_remember', { content: 'Sam fietst elke dag naar de winkel', scope: 'about_you' }), /voorstel|Voorgesteld|beoordel/i);
    assert.match(await tool(t, ada.id, 'dossier_write', { dossier: 'Eigenaar', content: '- Sam leest graag detectives.' }), /bijgewerkt/);
  } finally {
    await t.close();
  }
});

test('only working notes are private: another bot does not see them and cannot write them', async () => {
  const { t, ada, bo } = await twoBots();
  try {
    await tool(t, ada.id, 'dossier_write', { dossier: 'Werknotities', content: 'Ik ben halverwege de migratie van shop 3.' });
    const adaSys = await systemOf(t, ada.id);
    assert.match(adaSys, /halverwege de migratie van shop 3/);
    const boSys = await systemOf(t, bo.id);
    assert.doesNotMatch(boSys, /halverwege de migratie/);
    assert.doesNotMatch(boSys, /Werknotities van Ada/);
    const refused = await tool(t, bo.id, 'dossier_write', { dossier: 'Werknotities van Ada', content: 'Ik schrijf hier ook.' });
    assert.doesNotMatch(refused, /bijgewerkt/);
    assert.doesNotMatch(String(coreDossiers(svcOf(t), t.app.ctx.store.agent(ada.id)!).find((d: any) => d.core === 'notes').body), /Ik schrijf hier ook/);
  } finally {
    await t.close();
  }
});

test('update in place: replace, duplicates are not added, the limit makes the bot write shorter, what went out is archived and found', async () => {
  const { t, ada, bo, owner } = await twoBots();
  try {
    const svc = svcOf(t);
    await tool(t, ada.id, 'dossier_write', { dossier: 'Overzicht', content: '- Er lopen 6 projecten.\n- De facturen gaan via het pakket Rekenmaar de deur uit.' });
    // The same thing again adds nothing.
    assert.match(await tool(t, ada.id, 'dossier_write', { dossier: 'overzicht', content: 'Er lopen 6 projecten.' }), /stond al/);
    // What changed is replaced, not written next to it.
    assert.match(await tool(t, bo.id, 'dossier_write', { dossier: 'Overzicht', mode: 'replace', old_text: 'Er lopen 6 projecten.', content: 'Er lopen 8 projecten.' }), /bijgewerkt/);
    const d = () => t.app.ctx.store.decode<any>('memory_dossiers', t.app.ctx.store.one<any>("SELECT * FROM memory_dossiers WHERE core = 'overview'"));
    assert.match(d().body, /8 projecten/);
    assert.doesNotMatch(d().body, /6 projecten/);
    // Over the limit: refused, with the numbers, nothing changed.
    const before = d().body;
    const big = Array.from({ length: 80 }, (_, i) => `- Regel ${i} over iets heel anders met genoeg woorden om ruimte te vullen in dit dossier, nummer ${i * 7}.`).join('\n');
    const full = await tool(t, ada.id, 'dossier_write', { dossier: 'Overzicht', content: big });
    assert.match(full, new RegExp(`er passen er ${BODY_LIMITS.overview} in`));
    assert.match(full, /mode rewrite/);
    assert.equal(d().body, before);
    // A shorter rewrite: the invoicing line goes out and lands in the archive, where memory_search finds it.
    const re = await tool(t, ada.id, 'dossier_write', { dossier: 'Overzicht', mode: 'rewrite', content: 'Er lopen 8 projecten; de planning staat in de agenda.' });
    assert.match(re, /archief/);
    assert.doesNotMatch(d().body, /Rekenmaar/);
    const arch = t.app.ctx.store.all<any>("SELECT title, body, data FROM memory_records WHERE dossier_id = ? AND kind = 'event'", d().id);
    assert.ok(arch.some((x) => /via het pakket Rekenmaar/.test(x.body)));
    assert.ok(arch.some((x) => /Er lopen 6 projecten/.test(x.body)), 'the old number too');
    assert.match(await tool(t, bo.id, 'memory_search', { query: 'facturen Rekenmaar' }), /Rekenmaar/);
    // Every version stays in the history, and the owner can undo the rewrite.
    const ch = t.app.ctx.store.all<any>("SELECT id, before FROM memory_changes WHERE record_id = ? AND record_kind = 'dossier' AND op = 'update' ORDER BY created_at DESC, rowid DESC", d().id);
    assert.ok(ch.length >= 3);
    svc.undo(owner, ch[0].id, owner);
    assert.match(d().body, /Rekenmaar/);
    // A secret never gets in.
    assert.match(await tool(t, ada.id, 'dossier_write', { dossier: 'Eigenaar', content: 'Het wachtwoord van de shop is Geheim123!xyz en de api key is sk-live-1234567890abcdef1234567890' }), /Niet opgeslagen/);
  } finally {
    await t.close();
  }
});

/** Fake CLI engines that record what TeamBot hands them. */
function cliKinds(t: TestApp) {
  const calls: { kind: string; req: AgentRunRequest }[] = [];
  for (const id of ['claude-code', 'codex-cli'] as const)
    t.app.ctx.providers.registerKind({
      id,
      label: id,
      type: 'cli',
      needsKey: false,
      description: 'test',
      models: ['default'],
      defaultModel: 'default',
      create: () => ({
        kind: id,
        async listModels() {
          return [{ id: 'default' }];
        },
        async test() {
          return { ok: true, detail: 'nep' };
        },
        async runAgent(req: AgentRunRequest) {
          calls.push({ kind: id, req });
          return { text: 'ok', usage: { input: 1, output: 1 } };
        },
      }),
    });
  return calls;
}

test('the core dossiers are in every turn on every engine: API, Claude Code, and an engine with its own session', async () => {
  const { t, ada } = await twoBots();
  try {
    const calls = cliKinds(t);
    await tool(t, ada.id, 'dossier_write', { dossier: 'Eigenaar', content: 'Sam wil korte antwoorden zonder vaktaal.' });
    await tool(t, ada.id, 'dossier_write', { dossier: 'Overzicht', content: 'Twee lopende projecten: de verbouwing van de zolder en de nieuwe website.' });

    // API engine: both turns of one conversation carry the dossiers (the system prompt of every call).
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    const n = t.requests.length;
    await t.say(th.id, 'Hoi');
    await t.say(th.id, 'En nu?');
    for (const r of t.requests.slice(n)) {
      assert.match(r.system, /Sam wil korte antwoorden zonder vaktaal\./);
      assert.match(r.system, /Twee lopende projecten/);
    }
    // More than a snippet, within a few thousand tokens.
    const core = t.app.ctx.services.memory.living.context(ada.id);
    assert.ok(core.text.length > 400);
    assert.ok(core.tokensEstimate < 6000);

    // Claude Code: the full system prompt goes with every turn.
    const cc = await t.api('POST', '/providers', { kind: 'claude-code' });
    const claudia = await t.api('POST', '/agents', { name: 'Claudia', provider_id: cc.id, model: 'default' });
    const th2 = await t.api('POST', '/threads', { agentId: claudia.id });
    await t.say(th2.id, 'Hoi');
    await t.say(th2.id, 'En nu?');
    const ccCalls = calls.filter((c) => c.kind === 'claude-code');
    assert.equal(ccCalls.length, 2);
    for (const c of ccCalls) {
      assert.match(c.req.system, /Sam wil korte antwoorden zonder vaktaal\./);
      assert.match(c.req.system, /naam="Werknotities van Claudia"/);
    }

    // An engine with its own session (Codex): TeamBot hands it the same system prompt every turn, with the dossiers as
    // they are now; the engine's session gets only what changed (a marked block, cli-agents/context.ts — checked on the
    // real Codex and ACP routes in tests/memory-engines.test.ts). Memory no longer repeats itself per turn.
    const cx = await t.api('POST', '/providers', { kind: 'codex-cli' });
    const codie = await t.api('POST', '/agents', { name: 'Codie', provider_id: cx.id, model: 'default' });
    const th3 = await t.api('POST', '/threads', { agentId: codie.id });
    await t.say(th3.id, 'Hoi');
    await t.say(th3.id, 'En nu?');
    await tool(t, ada.id, 'dossier_write', { dossier: 'Eigenaar', content: 'Sam is op vrijdag niet bereikbaar.' });
    await t.say(th3.id, 'Wanneer kan ik hem bellen?');
    const cxCalls = calls.filter((c) => c.kind === 'codex-cli');
    assert.equal(cxCalls.length, 3);
    for (const c of cxCalls) assert.match(c.req.system, /Sam wil korte antwoorden zonder vaktaal\./);
    assert.doesNotMatch(cxCalls[1].req.system, /Sam is op vrijdag niet bereikbaar/);
    assert.match(cxCalls[2].req.system, /## Dossiers[\s\S]*Sam is op vrijdag niet bereikbaar\./);
    for (const c of cxCalls) assert.doesNotMatch(c.req.prompt, /<dossiers/, 'no second copy of memory in the turn itself');
  } finally {
    await t.close();
  }
});

test('a dossier is loaded when its subject comes up', async () => {
  const { t, ada, bo } = await twoBots();
  try {
    await tool(t, ada.id, 'dossier_write', { dossier: 'Bakkerij Jansen', kind: 'client', content: 'Nieuwe website voor de bakkerij. Het ontwerp is klaar; de teksten zijn nog niet aangeleverd.' });
    const th = await t.api('POST', '/threads', { agentId: bo.id });
    const n = t.requests.length;
    await t.say(th.id, 'Hoe staat het met Bakkerij Jansen?');
    const last = t.requests[n].messages.at(-1)!;
    const text = typeof last.content === 'string' ? last.content : JSON.stringify(last.content);
    assert.match(text, /de teksten zijn nog niet aangeleverd/);
  } finally {
    await t.close();
  }
});

test('no flood: thirty messages leave a handful of merged notes, and the bot is told to work them into a dossier', async () => {
  const { t, ada, bo } = await twoBots();
  try {
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    const durable = ['Ik woon in Zwolle.', 'Onthoud dat de facturen naar Rekenmaar gaan.', 'Ik woon in Zwolle, dat weet je toch?', 'Onthoud dat de facturen naar Rekenmaar gaan.', 'Ik heet Sam.'];
    const chatter = ['Kun je de site even nakijken?', 'Top, dankjewel!', 'Wat is de stand van het project?', 'Ok.', 'Hoeveel bestellingen staan er nu open?', 'Doe maar.', 'Kijk ook even naar de mail.', 'Wat vind jij ervan?', 'Zet het live.', 'Hm, dat klopt niet helemaal.'];
    for (let i = 0; i < 30; i++) await t.say(th.id, i % 6 === 0 ? durable[(i / 6) % durable.length] : chatter[i % chatter.length]);
    await t.app.ctx.services.memory.drain();
    // (Without a model nothing is read in the background: what is caught is what the owner asked to remember. What the
    // bot writes itself is in tests/memory-one-path.test.ts.)
    const rows = t.app.ctx.store.all<any>("SELECT content, scope, status, dossier_id FROM memory_items WHERE status IN ('active','proposed')");
    assert.ok(rows.length >= 1, 'the lasting things are caught');
    assert.ok(rows.length <= 6, `a handful, not dozens (got ${rows.length}: ${rows.map((r) => r.content).join(' | ')})`);
    assert.ok(rows.every((r) => r.scope !== 'agent'), 'nothing is locked into one bot');
    assert.ok(rows.every((r) => r.dossier_id), 'each a note of a dossier');
    // The other bot sees them at once, as notes of the dossier to work into its text.
    const sys = await systemOf(t, bo.id);
    assert.match(sys, /Notities bij deze dossiers die nog niet in de tekst staan[^\n]*\n(?:- .*\n)*- \[m:[a-z0-9]+\] [^\n]*Rekenmaar/);
    // Working one into the dossier's text takes it out of the notes (archived, not deleted).
    const ref = t.app.ctx.store.one<any>("SELECT ref FROM memory_items WHERE content LIKE '%Rekenmaar%' AND status = 'active'").ref;
    await tool(t, bo.id, 'dossier_write', { dossier: 'Overzicht', content: 'Alle facturen gaan naar het pakket Rekenmaar.' });
    assert.equal(t.app.ctx.store.one<any>('SELECT status FROM memory_items WHERE ref = ?', ref).status, 'archived');
    const after = await systemOf(t, ada.id);
    assert.doesNotMatch(after.split('Notities bij deze dossiers')[1] || '', /Rekenmaar/);
    assert.match(after, /Alle facturen gaan naar het pakket Rekenmaar/);
  } finally {
    await t.close();
  }
});

test('one-time consolidation: loose notes go into the dossiers, duplicates become one line, nothing is lost, one undo restores', async () => {
  const { t, ada, bo, owner } = await twoBots();
  try {
    const svc = svcOf(t);
    const store = t.app.ctx.store;
    const add = (content: string, scope: string, extra: any = {}) => t.api('POST', '/memory/items', { content, scope, ...extra });
    await add('Ik werk drie dagen per week aan eigen projecten', 'about_you');
    await add('Ik werk het liefst in de ochtend', 'about_you');
    await add('Regel en maak alles zelf aan; ik stuur alleen bij', 'agent', { agentId: ada.id, type: 'instruction' });
    await add('Er lopen 6 projecten die elke maandag met het team worden besproken', 'agent', { agentId: ada.id });
    await add('Er lopen 6 projecten die elke maandag met het team worden besproken', 'shared');
    await add('Zeg niet te snel dat iets niet kan: probeer eerst alle routes', 'shared', { type: 'lesson' });
    await add('De pincode van de alarminstallatie is bij de buren bekend', 'about_you', { sensitivity: 'sensitive' });
    // As an install from before the one write path left them: notes in no dossier.
    store.exec("UPDATE memory_items SET dossier_id = NULL WHERE scope IN ('about_you','shared','agent')");
    const all = () => store.all<any>('SELECT id, status, content, sensitivity FROM memory_items ORDER BY id');
    const before = all();
    assert.equal(before.length, 7);
    assert.ok(before.every((r) => r.status === 'active'));

    const r = moveLooseNotes(svc, owner);
    assert.equal(r.inText, 6);
    assert.equal(r.asNotes, 1, 'the sensitive note stays a note (of the owner’s dossier), never plain text');
    const dossier = (core: string, agentId?: string) => store.one<any>(`SELECT * FROM memory_dossiers WHERE core = ?${agentId ? ' AND created_by_agent = ?' : ''}`, core, ...(agentId ? [agentId] : []));
    assert.match(dossier('owner').body, /## Feiten\n- Ik werk drie dagen per week aan eigen projecten\n- Ik werk het liefst in de ochtend/);
    assert.equal(dossier('overview').body.match(/6 projecten die elke maandag/g)?.length, 1, 'once in the team’s overview');
    assert.match(dossier('lessons').body, /Zeg niet te snel dat iets niet kan/);
    // What was Ada's own stays Ada's own: her working notes (it was never shared, and the move does not share it).
    assert.match(dossier('notes', ada.id).body, /Regel en maak alles zelf aan; ik stuur alleen bij/);
    assert.match(dossier('notes', ada.id).body, /6 projecten die elke maandag/);
    // Nothing is deleted: every note is still there, archived (the sensitive one untouched), with a change record.
    const after = all();
    assert.equal(after.length, 7);
    assert.deepEqual(after.map((x) => x.content), before.map((x) => x.content));
    assert.equal(after.filter((x) => x.status === 'archived').length, 6);
    assert.equal(after.find((x) => x.sensitivity === 'sensitive')!.status, 'active');
    assert.equal(store.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE dossier_id IS NULL AND status IN ('active','proposed')").n, 0);
    // Ada reads her own, Bo the shared part only.
    assert.match(await systemOf(t, ada.id), /Regel en maak alles zelf aan/);
    const boSys = await systemOf(t, bo.id);
    assert.doesNotMatch(boSys, /Regel en maak alles zelf aan/);
    assert.match(boSys, /6 projecten die elke maandag/);
    // A second run does nothing.
    assert.equal(moveLooseNotes(svc, owner).inText, 0);
    // One undo brings every note and every dossier text back.
    const ch = store.one<any>('SELECT id FROM memory_changes WHERE batch_id = ? LIMIT 1', r.batchId);
    svc.undo(owner, ch.id, owner);
    assert.ok(all().every((x) => x.status === 'active'));
    assert.equal(dossier('owner').body, '');
    assert.equal(dossier('overview').body, '');
    assert.equal(dossier('notes', ada.id).body, '');
  } finally {
    await t.close();
  }
});

test('the owner edits a dossier text in Geheugen; the bots read the new text', async () => {
  const { t, ada } = await twoBots();
  try {
    const list = await t.api('GET', '/memory/dossiers');
    const own = list.find((d: any) => d.core === 'owner');
    assert.ok(own, 'the core dossiers are there before any bot ran');
    assert.equal(list[0].core, 'owner', 'core dossiers first');
    assert.equal(own.body_limit, BODY_LIMITS.owner);
    const full = await t.api('PATCH', `/memory/dossiers/${own.id}`, { body: 'Sam beslist zelf over geld, klanten en mail.' });
    assert.equal(full.dossier.body, 'Sam beslist zelf over geld, klanten en mail.');
    assert.match(await systemOf(t, ada.id), /Sam beslist zelf over geld, klanten en mail\./);
    await assert.rejects(t.api('PATCH', `/memory/dossiers/${own.id}`, { body: 'x'.repeat(BODY_LIMITS.owner + 1) }));
  } finally {
    await t.close();
  }
});

test('the upgrade runs once per install, at boot, without a model: later loose notes are left to the bots', async () => {
  const { t, ada, owner } = await twoBots();
  try {
    const svc = svcOf(t);
    const store = t.app.ctx.store;
    assert.ok(store.getSetting('', 'memory.onePath', null), 'a new install is marked at its first start');
    // An install from before the one write path: notes in no dossier, no mark.
    store.exec("DELETE FROM settings WHERE key = 'memory.onePath'");
    await t.api('POST', '/memory/items', { content: 'Ik werk het liefst in de ochtend', scope: 'about_you' });
    await t.api('POST', '/memory/items', { content: 'De bots moeten zuinig zijn in modelkeuze', scope: 'agent', agentId: ada.id, type: 'preference' });
    store.exec('UPDATE memory_items SET dossier_id = NULL');
    const calls = t.requests.length;
    moveOnce(svc);
    assert.equal(t.requests.length, calls, 'no model call');
    assert.equal(store.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE status = 'archived'").n, 2);
    assert.match(store.one<any>("SELECT body FROM memory_dossiers WHERE core = 'owner'").body, /liefst in de ochtend/);
    assert.match(store.one<any>("SELECT body FROM memory_dossiers WHERE core = 'notes' AND created_by_agent = ?", ada.id).body, /zuinig zijn in modelkeuze/, 'a bot’s own note in its own working notes');
    assert.equal(store.getSetting<any>(owner, 'memory.moved', null).inText, 2);
    // Once per install: a note that comes in the old way later is not moved at the next start.
    const later = svc.insertItem({ user_id: owner, scope: 'about_you', type: 'fact', content: 'Ik ga in december twee weken weg', status: 'active', source_kind: 'user', source_trust: 'user', created_by: 'user' } as any);
    moveOnce(svc);
    assert.equal(store.get<any>('memory_items', later.id).dossier_id, null);
  } finally {
    await t.close();
  }
});

test('the owner on his own channel (WhatsApp …): his bot reads and updates the dossiers there too; a stranger gets nothing', async () => {
  const { t, ada, owner } = await twoBots();
  try {
    const svc = svcOf(t);
    const store = t.app.ctx.store;
    const agent = store.agent(ada.id)!;
    await tool(t, ada.id, 'dossier_write', { dossier: 'Eigenaar', content: 'Sam wil korte antwoorden zonder vaktaal.' });
    const channelThread = (isOwner: boolean) => {
      const th = store.createThread({ user_id: owner, agent_id: ada.id, kind: 'channel', title: 'WhatsApp' });
      store.createMessage({ thread_id: th.id, role: 'user', author_type: 'external', author_name: 'Afzender', content: 'Hoi', parts: { channel: { isOwner, private: true } } as any });
      return store.thread(th.id)!;
    };
    const mine = channelThread(true);
    assert.equal(svc.audience(mine, owner), 'private');
    assert.match(t.app.ctx.services.memory.living.context(ada.id, mine.id).text, /Sam wil korte antwoorden zonder vaktaal\./);
    const other = channelThread(false);
    assert.equal(svc.audience(other, owner), 'public');
    assert.equal(t.app.ctx.services.memory.living.context(ada.id, other.id), null);
    const sys = (await import('../server/modules/memory/context.js')).systemPromptText(svc, agent, other) || '';
    assert.doesNotMatch(sys, /Sam wil korte antwoorden/);
  } finally {
    await t.close();
  }
});

test('the upgrade reads as a short dossier: plain headings, what is said twice once, and one line for the main bot to tidy up later', async () => {
  const { t, ada, owner } = await twoBots();
  try {
    const svc = svcOf(t);
    const store = t.app.ctx.store;
    t.app.ctx.services.teams.setMain?.(owner, ada.id);
    const isMain = t.app.ctx.services.teams.mainOf?.(owner) === ada.id;
    const add = (content: string, scope: string, extra: any = {}) => t.api('POST', '/memory/items', { content, scope, ...extra });
    await add('Antwoord altijd kort en zonder vaktaal', 'about_you', { type: 'instruction' });
    await add('Ik werk het liefst in de ochtend', 'about_you');
    await add('We hebben besloten de nieuwsbrief maandelijks te versturen', 'about_you', { type: 'decision' });
    // The same thing, noted twice in nearly the same words (once by a bot for itself, once shared).
    await add('De nieuwsbrief gaat elke eerste maandag van de maand uit', 'agent', { agentId: ada.id });
    await add('De nieuwsbrief gaat elke eerste maandag van de maand uit naar alle abonnees', 'shared');
    await add('De nieuwsbrief gaat elke eerste maandag van de maand uit naar alle abonnees.', 'shared');
    store.exec('UPDATE memory_items SET dossier_id = NULL');
    const r = moveLooseNotes(svc, owner);
    assert.equal(r.inText, 5);
    const body = (core: string) => String(store.one<any>('SELECT body FROM memory_dossiers WHERE core = ?', core).body);
    assert.equal(body('owner'), ['## Voorkeuren en afspraken', '- Antwoord altijd kort en zonder vaktaal', '', '## Besluiten', '- We hebben besloten de nieuwsbrief maandelijks te versturen', '', '## Feiten', '- Ik werk het liefst in de ochtend'].join(String.fromCharCode(10)));
    assert.equal(body('overview'), ['## Feiten', '- De nieuwsbrief gaat elke eerste maandag van de maand uit naar alle abonnees'].join(String.fromCharCode(10)), 'what was said twice is one line');
    assert.ok(isMain);
    {
      const notes = String(store.one<any>("SELECT body FROM memory_dossiers WHERE core = 'notes' AND created_by_agent = ?", ada.id).body);
      assert.match(notes, /De nieuwsbrief gaat elke eerste maandag van de maand uit/, 'the bot’s own note in its own working notes');
      assert.match(notes, /automatisch samengesteld uit losse notities\. Loop ze na zodra je eraan werkt/);
      assert.equal(store.one<any>("SELECT COUNT(*) AS n FROM memory_dossiers WHERE core = 'notes' AND body LIKE '%automatisch samengesteld%'").n, 1, 'only the main bot');
    }
    assert.equal(t.requests.length, 0, 'no model call, no routine');
    assert.equal(store.one<any>("SELECT COUNT(*) AS n FROM routines").n, 0);
  } finally {
    await t.close();
  }
});
