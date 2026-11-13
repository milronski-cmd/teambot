/**
 * 0.4 F2: dossiers without effort for bots. A conversation (or task) that names a dossier of the bot's team is linked
 * to it by itself and the bot gets its state every turn; one tool (`dossier_note`) files one sentence as decision,
 * action, event, person, source, note or "done"; a recurring client/project without a dossier is proposed (one click)
 * or made for the bot's team; team walls everywhere. Plus: lessons from corrections are for the whole team.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import { classifyNote, namesDossier, subjectsFromText } from '../server/modules/memory/dossier-auto.js';
import { DETAIL_GROUP } from '../server/modules/memory/tools.js';

const ctxOf = (msgs: any[]) => String([...msgs].reverse().find((m: any) => m.role === 'user')?.parts?.context || '');

async function note(t: TestApp, threadId: string, args: any, say = 'noteer het') {
  t.script.push({ toolCalls: [{ name: 'dossier_note', args }] }, { text: 'Genoteerd.' });
  const msgs = await t.say(threadId, say);
  return String([...msgs].reverse().find((m: any) => m.role === 'tool')?.content || '');
}

test('one sentence → the right place: decision, action with owner and deadline, done, event, person, organisation, source, note', () => {
  assert.equal(classifyNote('Besloten: we leveren de fietsen in maart').kind, 'decision');
  assert.equal(classifyNote('We kiezen voor Shopify').kind, 'decision');
  assert.equal(classifyNote('Jan stuurt vrijdag de offerte').kind, 'action');
  assert.equal(classifyNote('Ik moet de offerte voor vrijdag sturen').kind, 'action');
  assert.equal(classifyNote('Offerte sturen', { due: '2026-12-01' }).kind, 'action');
  assert.equal(classifyNote('De offerte is verstuurd').kind, 'done');
  assert.equal(classifyNote('Vandaag gebeld met de inkoper over de levering').kind, 'event');
  assert.deepEqual(classifyNote('Piet de Vries is de contactpersoon bij Jansen'), { kind: 'person', name: 'Piet de Vries', role: 'contactpersoon' });
  assert.equal(classifyNote('Bouwbedrijf Visser BV is de aannemer').kind, 'organization');
  assert.equal(classifyNote('Prijslijst https://example.org/prijzen').kind, 'source');
  assert.equal(classifyNote('Ze houden van groen in de huisstijl').kind, 'note');
  assert.deepEqual(subjectsFromText('Kun je iets maken voor klant Jansen? En voor project Zwaluw Twee ook.').map((s) => s.name), ['Klant Jansen', 'Project Zwaluw Twee']);
  assert.equal(namesDossier('Jansen wil de offerte eerder', { title: 'Klant Jansen' }), true, 'the generic word "klant" is not needed');
  assert.equal(namesDossier('De klant wil de offerte eerder', { title: 'Klant Jansen' }), false);
  assert.equal(namesDossier('Hoe staat het met de zolder?', { title: 'Verbouwing', tags: ['zolder'] }), true, 'a tag counts');
});

test('a conversation that names a dossier is linked by itself; its state is in every turn; dossier_note files each kind; the detailed tools are their own part', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Klant Jansen', summary: 'Vaste klant: tien fietsen per voorjaar.' })).dossier;
    const a = await t.agent({ name: 'Verkoop' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Ik zoek het uit.' });
    const first = await t.say(th.id, 'Hoe staat het met Jansen? Hij belde vanochtend.');
    assert.equal(t.app.ctx.store.one<any>('SELECT dossier_id FROM memory_links WHERE thread_id = ?', th.id)?.dossier_id, d.id, 'linked at the first turn');
    const c1 = ctxOf(first);
    assert.match(c1, /TeamBot heeft het eraan gekoppeld/);
    assert.match(c1, /Dossier van dit gesprek:[\s\S]*Klant Jansen — Vaste klant/);

    // One tool, every kind; no dossier argument: the conversation's dossier.
    assert.match(await note(t, th.id, { text: 'Besloten: Jansen krijgt 5 procent korting op de tweede bestelling' }), /als besluit: \[b:/);
    assert.match(await note(t, th.id, { text: 'Offerte sturen naar Jansen', owner: 'Sanne', due: '2026-12-01' }), /als actie, voor Sanne, uiterlijk 2026-12-01/);
    assert.match(await note(t, th.id, { text: 'Piet de Vries is de contactpersoon bij Jansen' }), /als persoon/);
    assert.match(await note(t, th.id, { text: 'Vanochtend gebeld met Piet over de levertijd' }), /als gebeurtenis/);
    assert.match(await note(t, th.id, { text: 'Hun bestelpagina https://example.org/bestellen' }), /Bron toegevoegd/);
    assert.match(await note(t, th.id, { text: 'Ze houden van groen in de huisstijl' }), /Notitie in dossier/);
    // "Done" closes the open action it is about.
    assert.match(await note(t, th.id, { text: 'De offerte naar Jansen is verstuurd' }), /Actie afgerond/);
    const full = await t.api('GET', `/memory/dossiers/${d.id}`);
    assert.equal(full.decisions.length, 1);
    assert.equal(full.actions[0].status, 'done');
    assert.equal(full.entities[0].title, 'Piet de Vries');
    assert.ok(full.events.some((e: any) => /levertijd/.test(e.title)));
    assert.ok(full.sources.some((s: any) => s.target === 'https://example.org/bestellen'));
    assert.ok(full.items.some((i: any) => /groen/.test(i.content)));
    // Next turn: the decision and open actions are there without the bot asking.
    await note(t, th.id, { text: 'Jansen wil de fietsen vóór 1 april geleverd', due: '2027-04-01' });
    t.script.push({ text: 'ok' });
    const c2 = ctxOf(await t.say(th.id, 'Wat moeten we nog doen voor Jansen?'));
    assert.match(c2, /Besluiten: \[b:[^\]]+\] Besloten: Jansen krijgt 5 procent korting/);
    assert.match(c2, /Open acties: \[a:[^\]]+\] Jansen wil de fietsen vóór 1 april geleverd/);

    // The tool list stays small: dossier_write and dossier_get in "memory", the detailed writers (dossier_note with
    // them, since living dossiers) in their own part (still callable).
    const tools = await t.app.ctx.tools.forAgent(t.app.ctx.store.agent(a.id)!, t.app.ctx.store.thread(th.id)!);
    assert.equal(tools.find((x) => x.name === 'dossier_write')?.group, 'memory');
    assert.equal(tools.find((x) => x.name === 'dossier_note')?.group, DETAIL_GROUP);
    assert.deepEqual(tools.filter((x) => x.group === 'memory').map((x) => x.name).sort(), ['dossier_get', 'dossier_write', 'memory_forget', 'memory_remember', 'memory_search', 'memory_update']);
    assert.equal(tools.find((x) => x.name === 'dossier_add')?.group, DETAIL_GROUP);
    assert.ok(!tools.some((x) => x.group === 'memory' && ['dossier_add', 'dossier_note', 'dossier_update'].includes(x.name)));
  } finally {
    await t.close();
  }
});

test('a recurring client without a dossier: proposed after the second conversation (one click files the waiting notes), or made for the bot’s team; "niet nodig" is final', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const a = await t.agent({ name: 'Verkoop' });
    const st = t.app.ctx.store;
    const ag = st.agent(a.id)!;
    const learnIn = async (text: string) => {
      const th = await t.api('POST', '/threads', { agentId: a.id });
      t.script.push({ text: 'Goed.' });
      await t.say(th.id, text);
      await t.app.ctx.services.memory.learner.learnNow(ag, st.thread(th.id)!);
      return th;
    };
    const th1 = await learnIn('Kun je een mailtje opstellen voor klant Bakker over de levering van de racefietsen?');
    assert.equal((await t.api('GET', '/memory/dossier-proposals')).length, 0, 'once is no pattern');
    // A note for it before it exists waits with the proposal.
    assert.match(await note(t, th1.id, { text: 'Bakker belt liever dan dat hij mailt', dossier: 'Klant Bakker' }), /voorgesteld/);
    const th2 = await learnIn('Klant Bakker vraagt weer naar de levertijd, wat zeggen we?');
    const props = await t.api('GET', '/memory/dossier-proposals');
    assert.equal(props.length, 1);
    assert.equal(props[0].name, 'Klant Bakker');
    assert.equal(props[0].pending, 1);
    assert.equal(props[0].agent.name, 'Verkoop');
    // The bot does not see a proposal as a dossier.
    assert.equal(t.app.ctx.store.all<any>("SELECT id FROM memory_dossiers WHERE core IS NULL AND status = 'active'").length, 0);
    const made = (await t.api('POST', `/memory/dossier-proposals/${props[0].id}/accept`, {})).dossier;
    assert.equal(made.title, 'Klant Bakker');
    assert.equal(made.agent_ids, null, 'for every bot of the team');
    for (const th of [th1, th2]) assert.equal(st.one<any>('SELECT dossier_id FROM memory_links WHERE thread_id = ?', th.id)?.dossier_id, made.id);
    const full = await t.api('GET', `/memory/dossiers/${made.id}`);
    assert.ok(full.items.some((i: any) => /belt liever/.test(i.content)), 'the waiting note went in');

    // "Niet nodig": never proposed again.
    await learnIn('Iets voor klant Pietersen: de factuur klopt niet.');
    await learnIn('Klant Pietersen heeft weer gebeld.');
    const p2 = (await t.api('GET', '/memory/dossier-proposals')).find((p: any) => p.name === 'Klant Pietersen');
    await t.api('POST', `/memory/dossier-proposals/${p2.id}/dismiss`, {});
    await learnIn('Klant Pietersen wil een afspraak.');
    assert.equal((await t.api('GET', '/memory/dossier-proposals')).length, 0);

    // The owner allows it: made right away for the bot's team, with a notification.
    await t.api('PUT', '/memory/settings', { dossierAuto: 'create' });
    await learnIn('Klant De Wit wil een proefrit.');
    await learnIn('Klant De Wit komt zaterdag langs.');
    const wit = st.one<any>("SELECT * FROM memory_dossiers WHERE title = 'Klant De Wit'");
    assert.ok(wit, 'made by itself');
    assert.equal(wit.created_by, 'agent');
    // And off: nothing.
    await t.api('PUT', '/memory/settings', { dossierAuto: 'off' });
    assert.match(await note(t, th1.id, { text: 'Iets over hen', dossier: 'Klant Nergens' }), /maakt dossiers zelf/);
  } finally {
    await t.close();
  }
});

test('forgetting also removes a note that waits for a proposed dossier; "alles wissen" clears the proposals', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const a = await t.agent({ name: 'Verkoop' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const item = (await t.api('POST', '/memory/items', { content: 'Klant Bakker heeft de bijnaam Tijger', scope: 'agent', agentId: a.id })).item;
    assert.match(await note(t, th.id, { text: 'Klant Bakker heeft de bijnaam Tijger', dossier: 'Klant Bakker' }), /voorgesteld/);
    assert.equal((await t.api('GET', '/memory/dossier-proposals'))[0].pending, 1);
    await t.api('POST', `/memory/items/${item.id}/forget`, { alsoSource: false });
    assert.equal((await t.api('GET', '/memory/dossier-proposals'))[0].pending, 0, 'the waiting note went with it');
    await t.api('POST', '/memory/delete-all', { confirm: 'WISSEN' });
    assert.equal((await t.api('GET', '/memory/dossier-proposals')).length, 0);
  } finally {
    await t.close();
  }
});

test('team walls: another team’s dossier with the same name is never linked or written; a lesson from a correction is for the whole team, and can be narrowed to one bot', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const ada = await t.agent({ name: 'Ada' });
    const [def] = await t.api('GET', '/teams');
    await t.api('PATCH', `/teams/${def.id}`, { name: 'Team A' });
    const B = await t.api('POST', '/teams', { name: 'Team B' });
    const bo = await t.agent({ name: 'Bo', settings: { homeTeam: B.id } });
    const eva = await t.agent({ name: 'Eva' });
    const dB = (await t.api('POST', '/memory/dossiers', { title: 'Klant Zwaluw', teamId: B.id })).dossier;
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    t.script.push({ text: 'ok' });
    const msgs = await t.say(th.id, 'Wat weten we over Zwaluw?');
    assert.equal(t.app.ctx.store.one<any>('SELECT 1 AS x FROM memory_links WHERE thread_id = ?', th.id), undefined, 'not linked to team B’s dossier');
    assert.doesNotMatch(ctxOf(msgs), /Zwaluw —/);
    const out = await note(t, th.id, { text: 'Besloten: Zwaluw krijgt voorrang', dossier: `d:${dB.ref}` });
    assert.doesNotMatch(out, /Genoteerd/);
    assert.equal((await t.api('GET', `/memory/dossiers/${dB.id}`)).decisions.length, 0);

    // A lesson (C1) through the memory service as the quality module stores it: the team of the bot, not one bot.
    const mem = t.app.ctx.services.memory;
    const me = t.app.ctx.auth.owner()!.id;
    const les = mem.remember(me, { content: 'Offertes stuur je als PDF, niet als Word-bestand', scope: 'shared', agentId: ada.id, type: 'lesson', source: { kind: 'message', trust: 'user' }, createdBy: 'user', module: 'quality' });
    assert.equal(les.action, 'inserted');
    const svc = mem.svc;
    const sees = (id: string) => svc.searchItems(svc.readerFor(t.app.ctx.store.agent(id)!, null), 'offerte als PDF', { limit: 5 }).some((h: any) => h.row.id === les.item.id);
    assert.equal(sees(ada.id), true);
    assert.equal(sees(eva.id), true, 'another bot of the same team');
    assert.equal(sees(bo.id), false, 'not a bot of another team');
    // The owner narrows it to Ada only.
    await t.api('PATCH', `/memory/items/${les.item.id}`, { scope: 'agent', agentId: ada.id });
    assert.equal(sees(ada.id), true);
    assert.equal(sees(eva.id), false);
  } finally {
    await t.close();
  }
});
