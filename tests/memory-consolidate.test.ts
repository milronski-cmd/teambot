/**
 * 0.4.4 consolidation on write (consolidate.ts): a new fact ends what no longer holds (also without a shared key),
 * finishes open tasks and dossier actions (the owner's words, a bare "gedaan" after the bot named the task, a bot that
 * did the work with a tool, a routine), never silently (undo, a reason), never a standing rule, never across a team
 * wall; with a free model the Hindsight-style verdicts are applied by code that checks ids, dates and relatedness.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mockAdapter, startTestApp, type TestApp } from './helpers.js';
import { setShortCallFake } from '../server/agent/short-call.js';
import { doneSignal, endSignal, isOpenTodo, objectTokens } from '../server/modules/memory/consolidate.js';

async function freeEngine(t: TestApp) {
  t.app.ctx.providers.registerKind({ id: 'mock-local', label: 'Lokaal testmodel', type: 'api', group: 'local', billing: 'local', needsKey: false, description: 'test', models: ['lokaal-1'], defaultModel: 'lokaal-1', create: () => mockAdapter(t.script, t.requests) });
  return t.api('POST', '/providers', { kind: 'mock-local' });
}
const item = (t: TestApp, content: string) => t.app.ctx.store.one<any>('SELECT * FROM memory_items WHERE content = ? ORDER BY created_at DESC LIMIT 1', content);
const add = async (t: TestApp, content: string, extra: any = {}) => (await t.api('POST', '/memory/items', { content, scope: 'about_you', ...extra })).item;

test('signals: done, ended, open task, subject words (Dutch participles, compounds, recurring duties)', () => {
  assert.equal(doneSignal('De SEO van de website is bijgewerkt'), true);
  assert.equal(doneSignal('De SEO is nog niet bijgewerkt'), false, 'not done after all');
  assert.equal(doneSignal('De SEO moet nog worden bijgewerkt'), false, 'still to do');
  assert.equal(doneSignal('Is de SEO bijgewerkt?'), false, 'a question');
  assert.equal(endSignal('We sponsoren De Spurt niet meer'), true);
  assert.equal(isOpenTodo({ type: 'fact', status: 'active', content: '' }, 'We moeten de SEO van de website nog bijwerken'), true);
  assert.equal(isOpenTodo({ type: 'fact', status: 'active', content: '' }, 'De parkeervergunning moet elk jaar in februari verlengd'), false, 'a recurring duty is no one-off task');
  assert.equal(isOpenTodo({ type: 'instruction', status: 'active', content: '' }, 'Je moet altijd eerst toestemming vragen'), false, 'a standing rule is never a task');
  assert.deepEqual(objectTokens('We moeten de SEO van de website nog bijwerken'), objectTokens('De SEO van de website is bijgewerkt'), 'bijwerken ~ bijgewerkt');
  assert.ok(objectTokens('Ahmed heeft zijn lascursus afgerond').some((w) => objectTokens('een cursus lassen').includes(w)), 'lascursus ~ cursus');
});

test('without a model: a finished task and an ending leave the active set with a reason and undo; related news does not; history finds them', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const seo = await add(t, 'We moeten de SEO van de website nog bijwerken');
    const spurt = await add(t, 'We sponsoren het lokale wielerteam De Spurt');
    const bakker = await add(t, 'Bakker belt liever dan dat hij mailt');
    const rule = await add(t, 'Je moet klanten nooit mailen zonder toestemming', { type: 'instruction', pinned: true });
    await add(t, 'De SEO van de website is bijgewerkt');
    await add(t, 'We sponsoren De Spurt niet meer');
    await add(t, 'Bakker heeft vandaag gebeld over zijn bestelling');
    await add(t, 'Klanten mailen is niet meer nodig');
    const st = (id: string) => t.app.ctx.store.get<any>('memory_items', id);
    assert.equal(st(seo.id).status, 'superseded', 'the task is done');
    assert.match(st(seo.id).invalid_reason, /bijgewerkt/);
    assert.ok(st(seo.id).valid_to, 'until when it held');
    assert.equal(st(spurt.id).status, 'superseded', 'the sponsoring ended');
    assert.equal(st(bakker.id).status, 'active', 'calling does not end how Bakker likes to be reached');
    assert.equal(st(rule.id).status, 'active', 'a standing rule is never ended by a pattern');
    // Never silently: one change with a reason and undo.
    const ch = t.app.ctx.store.one<any>("SELECT * FROM memory_changes WHERE record_id = ? AND op = 'invalidate'", seo.id);
    assert.ok(ch?.reason && ch.undoable);
    // History: a bot finds it only when it asks for the past, with until when it held.
    const a = await t.agent({ tool_groups: ['memory'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'memory_search', args: { query: 'SEO website' } }] }, { toolCalls: [{ name: 'memory_search', args: { query: 'SEO website', history: true } }] }, { text: 'ok' });
    const msgs = await t.say(th.id, 'Wat moet er nog met de SEO?');
    const outs = msgs.filter((m: any) => m.role === 'tool').map((m: any) => String(m.content));
    assert.doesNotMatch(outs[0], new RegExp(`m:${seo.ref}`), 'now: only what holds');
    assert.match(outs[1], new RegExp(`\\[m:${seo.ref}\\].*geldt niet meer`), 'history: with until when');
    // Undo brings it back.
    await t.api('POST', `/memory/changes/${ch.id}/undo`);
    assert.equal(st(seo.id).status, 'active');
  } finally {
    await t.close();
  }
});

test('open dossier actions close: the owner says it is done, "gedaan" after the bot named it, a bot that did the work, a routine; nothing else closes', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const svc = t.app.ctx.services.memory.svc;
    const d = (await t.api('POST', '/memory/dossiers', { title: 'Website Velo Vintage' })).dossier;
    const act = async (title: string) => (await t.api('POST', `/memory/dossiers/${d.id}/records`, { kind: 'action', title })).record;
    const seo = await act('SEO van de website bijwerken');
    const offerte = await act('Offerte versturen naar klant Jansen');
    const fotos = await act("Productfoto's van de Gazelle uploaden");
    const sitemap = await act('Sitemap opnieuw indienen bij Google');
    const banner = await act('Banner voor de kerstactie maken');
    const status = (r: any) => t.app.ctx.store.get<any>('memory_records', r.id).status;
    const a = await t.agent({ name: 'Webbot', tool_groups: ['memory', 'core'] });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('PUT', `/memory/thread/${th.id}/link`, { dossierId: d.id });

    // 1. The owner says it ("onthoud dat" → his own words, applied now).
    t.script.push({ text: 'Top!' });
    await t.say(th.id, 'Onthoud dat de SEO van de website is bijgewerkt.');
    assert.equal(status(seo), 'done');
    assert.match(JSON.stringify(t.app.ctx.store.get<any>('memory_records', seo.id).data), /eigenaar/);

    // 2. "Gedaan" right after the bot named exactly one open task.
    t.script.push({ text: 'Herinnering: de offerte voor klant Jansen moet nog verstuurd worden.' });
    await t.say(th.id, 'Wat staat er nog open?');
    t.script.push({ text: 'Prima.' });
    const gedaan = await t.say(th.id, 'Gedaan!');
    assert.equal(status(offerte), 'done');
    const own = gedaan.find((m: any) => m.role === 'user' && m.content === 'Gedaan!');
    assert.match(JSON.stringify((await t.api('GET', `/memory/message/${own.id}`)) || {}), /Afgerond/);

    // 3. A bot that reports the work as done without doing anything closes nothing …
    t.script.push({ text: "Ik heb de productfoto's van de Gazelle geüpload." });
    await t.say(th.id, 'Hoe staat het met de foto’s?');
    assert.equal(status(fotos), 'open', 'no evidence (no tool used): not closed');
    // … with evidence (it used a tool) it does.
    t.script.push({ toolCalls: [{ name: 'notify_user', args: { message: 'Foto’s staan online' } }] }, { text: "Ik heb de productfoto's van de Gazelle geüpload." });
    await t.say(th.id, 'Zet de foto’s online.');
    assert.equal(status(fotos), 'done');
    assert.match(JSON.stringify(t.app.ctx.store.get<any>('memory_records', fotos.id).data), /Webbot/);

    // 4. A routine run that finished.
    const u = t.app.ctx.auth.owner()!;
    const th2 = t.app.ctx.store.thread(th.id)!;
    const msg = t.app.ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'system', author_id: null, author_name: 'Routine', content: 'Routine: sitemap controleren' } as any);
    t.script.push({ text: 'Klaar: de sitemap is opnieuw ingediend bij Google.' });
    const run = t.app.ctx.chat.startAgent(th2, a.id, msg.id, 'schedule');
    await t.app.ctx.runs.waitFor(run!.id, 5000);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(status(sitemap), 'done');
    void u;

    // Nothing else closed; the block of a new conversation about the dossier no longer lists the done ones.
    assert.equal(status(banner), 'open');
    const th3 = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('PUT', `/memory/thread/${th3.id}/link`, { dossierId: d.id });
    const block = await t.app.ctx.services.memory.context(u.id, a.id, th3.id, 'Wat moet er nog gebeuren aan de website?');
    assert.match(String(block), /Banner voor de kerstactie/);
    assert.doesNotMatch(String(block), /SEO van de website bijwerken|Sitemap opnieuw/);
    void svc;
  } finally {
    await t.close();
  }
});

test('the owner just says it in a conversation ("De SEO is bijgewerkt"): the open dossier action closes and the task line leaves the dossier text — with a model and without one, with undo', async () => {
  for (const withModel of [false, true]) {
    const t = await startTestApp();
    try {
      if (withModel) await freeEngine(t);
      else await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
      setShortCallFake((system) => (/Je bent het geheugen van TeamBot/.test(system) ? 'NIETS' : ''));
      const d = (await t.api('POST', '/memory/dossiers', { title: 'Website Velo Vintage' })).dossier;
      const seo = (await t.api('POST', `/memory/dossiers/${d.id}/records`, { kind: 'action', title: 'SEO van de website bijwerken' })).record;
      const banner = (await t.api('POST', `/memory/dossiers/${d.id}/records`, { kind: 'action', title: 'Banner voor de kerstactie maken' })).record;
      const a = await t.agent({ name: 'Webbot' });
      const mem = t.app.ctx.services.memory;
      const overview = mem.living.core(a.id).find((x: any) => x.core === 'overview');
      mem.living.write(overview.id, '- We moeten de SEO van de website nog bijwerken\n- De banner voor de kerstactie moet nog gemaakt worden', { type: 'user', id: t.app.ctx.auth.owner()!.id });
      const th = await t.api('POST', '/threads', { agentId: a.id });
      await t.api('PUT', `/memory/thread/${th.id}/link`, { dossierId: d.id });
      t.script.push({ text: 'Mooi zo.' });
      await t.say(th.id, 'De SEO van de website is bijgewerkt.');
      await mem.drain();
      const status = (r: any) => t.app.ctx.store.get<any>('memory_records', r.id).status;
      const text = () => String(t.app.ctx.store.get<any>('memory_dossiers', overview.id).body);
      assert.equal(status(seo), 'done', `${withModel ? 'with' : 'without'} a model: the action is closed`);
      assert.equal(status(banner), 'open', 'nothing else');
      assert.doesNotMatch(text(), /SEO van de website nog bijwerken/, 'the task line left the text');
      assert.match(text(), /banner voor de kerstactie/);
      // In the dossier's archive and the history: one undo brings the line back.
      const change = t.app.ctx.store.one<any>("SELECT id FROM memory_changes WHERE record_id = ? AND record_kind = 'dossier' AND reason LIKE 'afgerond volgens eigenaar%' ORDER BY created_at DESC LIMIT 1", overview.id);
      assert.ok(change);
      await t.api('POST', `/memory/changes/${change.id}/undo`, {});
      assert.match(text(), /SEO van de website nog bijwerken/);
    } finally {
      setShortCallFake(null);
      await t.close();
    }
  }
});

test('with a free model: the review ends what no longer holds ("vervangt") — a new value, an ending; wrong and unrelated pointers and standing rules are guarded', async () => {
  const t = await startTestApp();
  let prompt = '';
  try {
    await freeEngine(t);
    const hosting = await add(t, 'Onze hosting zit bij TransIP', { scope: 'about_you' });
    const ahmed = await add(t, 'Ahmed restaureert de frames in de werkplaats');
    const broer = await add(t, 'Ahmed is de broer van Fleur');
    const koffie = await add(t, 'Ik drink mijn koffie zwart');
    const rule = await add(t, 'Mail klanten alleen na toestemming', { type: 'instruction', pinned: true });
    const unrelated = await add(t, 'De printer op kantoor is een Brother');
    setShortCallFake((system, p) => {
      if (!/Je bent het geheugen van TeamBot/.test(system)) return '';
      prompt = p;
      return [
        'Eigenaar: Onze hosting zit nu bij Hetzner (vervangt: Onze hosting zit bij TransIP)',
        // A pointer at something it has nothing in common with: not applied (guard against a wrong pairing).
        'Eigenaar: Onze hosting zit nu bij Hetzner (vervangt: De printer op kantoor is een Brother)',
        'Eigenaar: Ahmed werkt niet meer bij ons (vervangt: Mail klanten alleen na toestemming)',
        'Eigenaar: Ahmed werkt niet meer bij ons (vervangt: Ahmed restaureert de frames in de werkplaats)',
        'Eigenaar: Mijn koffie neem ik zonder melk',
      ].join('\n');
    });
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Genoteerd.' });
    await t.say(th.id, 'Onze hosting zit nu bij Hetzner. Ahmed werkt niet meer bij ons. En mijn koffie neem ik altijd zonder melk.');
    await t.app.ctx.services.memory.drain();
    const st = (r: any) => t.app.ctx.store.get<any>('memory_items', r.id);
    assert.match(prompt, /naam="Eigenaar"[\s\S]*- Onze hosting zit bij TransIP[\s\S]*<\/dossier>/, 'the review sees the notes of the dossier');
    const owner = String(t.app.ctx.store.one<any>("SELECT body FROM memory_dossiers WHERE core = 'owner'").body);
    assert.match(owner, /Onze hosting zit nu bij Hetzner/);
    assert.equal(st(hosting).status, 'superseded', 'a new value: the old note no longer holds');
    assert.match(st(hosting).invalid_reason, /Hetzner/);
    assert.equal(st(ahmed).status, 'superseded', 'an ending');
    assert.equal(st(broer).status, 'active', 'unrelated stays');
    assert.equal(st(rule).status, 'active', 'a standing rule is never ended by a model');
    assert.equal(st(unrelated).status, 'active', 'a pair that shares nothing is not applied');
    assert.equal(st(koffie).status, 'active', 'something else about coffee stays');
    assert.match(owner, /Mijn koffie neem ik zonder melk/);
    // One undo brings an ended note back.
    const ch = t.app.ctx.store.one<any>("SELECT id FROM memory_changes WHERE record_id = ? AND op = 'invalidate'", ahmed.id);
    await t.api('POST', `/memory/changes/${ch.id}/undo`);
    assert.equal(st(ahmed).status, 'active');
  } finally {
    setShortCallFake(null);
    await t.close();
  }
});


test('team walls: a bot of team A never ends a note of team B', async () => {
  const t = await startTestApp();
  try {
    await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
    const ada = await t.agent({ name: 'Ada', tool_groups: ['memory'] });
    const [def] = await t.api('GET', '/teams');
    await t.api('PATCH', `/teams/${def.id}`, { name: 'Team A' });
    const B = await t.api('POST', '/teams', { name: 'Team B' });
    const bo = await t.agent({ name: 'Bo', tool_groups: ['memory'], settings: { homeTeam: B.id } });
    const noteB = (await t.api('POST', '/memory/items', { content: 'We moeten de SEO van de webshop nog bijwerken', scope: 'agent', agentId: bo.id })).item;
    const noteA = (await t.api('POST', '/memory/items', { content: 'We moeten de SEO van de webshop nog bijwerken voor team A', scope: 'agent', agentId: ada.id })).item;
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    t.script.push({ toolCalls: [{ name: 'memory_remember', args: { content: 'De SEO van de webshop is bijgewerkt' } }] }, { text: 'ok' });
    await t.say(th.id, 'Noteer dat de SEO klaar is.');
    const b = t.app.ctx.store.get<any>('memory_items', noteB.id);
    assert.equal(b.status, 'active', 'team B is not touched …');
    assert.ok(!(b.flags || []).includes('check'), '… not even marked');
    // In its own team a bot's claim on a note the owner wrote is "te controleren", never a silent end.
    const a = t.app.ctx.store.get<any>('memory_items', noteA.id);
    assert.equal(a.status, 'active');
    assert.ok((a.flags || []).includes('check'), 'its own team: te controleren');
  } finally {
    await t.close();
  }
});

test('updates in the owner\'s words end what they end — the review names them (one call), and without a model "onthoud dat" does; news and small talk are not stored', async () => {
  for (const withModel of [true, false]) {
    const t = await startTestApp();
    try {
      let calls = 0;
      if (withModel) {
        await freeEngine(t);
        setShortCallFake((system) =>
          /Je bent het geheugen van TeamBot/.test(system)
            ? (calls++,
              [
                'Eigenaar: Klant Bakker heeft zijn terugbetaling gekregen (vervangt: Klant Bakker wacht nog op een terugbetaling)',
                'Eigenaar: We sponsoren De Spurt niet meer (vervangt: We sponsoren het lokale wielerteam De Spurt)',
                'Eigenaar: We zijn gestopt met de nieuwsbrief (vervangt: Onze nieuwsbrief gaat elke eerste dinsdag van de maand uit)',
              ].join('\n'))
            : '',
        );
      } else await t.api('PUT', '/memory/settings', { extractor: 'heuristic' });
      const bakker = await add(t, 'Klant Bakker wacht nog op een terugbetaling');
      const nieuwsbrief = await add(t, 'Onze nieuwsbrief gaat elke eerste dinsdag van de maand uit');
      const spurt = await add(t, 'We sponsoren het lokale wielerteam De Spurt');
      const belt = await add(t, 'Bakker belt liever dan dat hij mailt');
      const a = await t.agent({ tool_groups: ['memory'] });
      const th = await t.api('POST', '/threads', { agentId: a.id });
      const say = (m: string) => (withModel ? m : /terugbetaling|Spurt|nieuwsbrief/.test(m) ? `Onthoud dat ${m.charAt(0).toLowerCase()}${m.slice(1)}` : m);
      for (const m of ['Klant Bakker heeft zijn terugbetaling gekregen.', 'We sponsoren De Spurt niet meer.', 'Ik ben vandaag een beetje moe.', 'Bakker heeft vandaag gebeld over zijn bestelling.', 'We zijn gestopt met de nieuwsbrief.', 'Het concert is niet meer uitverkocht.']) {
        t.script.push({ text: 'Oké.' });
        await t.say(th.id, say(m));
      }
      await t.app.ctx.services.memory.learner.learnNow(t.app.ctx.store.agent(a.id)!, t.app.ctx.store.thread(th.id)!);
      await t.app.ctx.services.memory.drain();
      const st = (id: string) => t.app.ctx.store.get<any>('memory_items', id);
      const label = withModel ? 'the review' : 'without a model';
      assert.equal(st(bakker.id).status, 'superseded', `${label}: the refund came`);
      assert.match(st(bakker.id).invalid_reason, /terugbetaling gekregen/);
      assert.equal(st(nieuwsbrief.id).status, 'superseded', `${label}: the newsletter stopped`);
      assert.equal(st(spurt.id).status, 'superseded', `${label}: the sponsoring stopped`);
      assert.equal(st(belt.id).status, 'active', `${label}: a call ends nothing`);
      if (withModel) assert.equal(calls, 1, 'one call for the whole conversation');
      // The owner's own sentence is what ended it, kept; small talk and an ending without a target are not.
      const all = [...t.app.ctx.store.all<any>('SELECT body FROM memory_dossiers').map((d) => d.body), ...t.app.ctx.store.all<any>("SELECT content FROM memory_items WHERE status = 'active'").map((r) => r.content)].join('\n');
      assert.match(all, /terugbetaling (?:heeft )?gekregen/i, `${label}: the owner's sentence is stored`);
      assert.doesNotMatch(all, /beetje moe/);
      assert.doesNotMatch(all, /concert/i, `${label}: an ending that ends nothing known is not stored`);
    } finally {
      setShortCallFake(null);
      await t.close();
    }
  }
});
