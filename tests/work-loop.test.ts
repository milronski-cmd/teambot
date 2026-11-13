// "Vanzelf het goede werk" (11 Nov 2026). On the owner's own computer TeamBot had made 49 routines in one night, 64
// runs all ended "niets nieuws" (59 of them without ever calling a model), while his five real tasks stood untouched on
// the task board and a bot learned 452 facts about a city his business has nothing to do with. These tests hold the
// repair:
//  - a new bot gets nothing by itself, whatever its role says;
//  - on the first start after the update, what TeamBot once seeded and never produced anything is archived (logged,
//    visible, one click back) and everything deliberate stays;
//  - a due routine leads to a real run: the bot's model, its tools, a result on the receipt;
//  - work that lies there is picked up now by the bot it belongs to, the main bot hands out and checks, nothing is
//    run twice for the same list, and without work no turn is started at all;
//  - a specialist only learns from sources about its own field.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { give, setup, teamWithSite, page, type Env } from './proactive-helpers.js';
import { newId } from '../server/core/db.js';
import { builtinDuty, SETUP_KEY } from '../server/modules/routines/duties/catalog.js';
import { MAX_SAME, RETRY_SAME_MS } from '../server/modules/routines/duties/work.js';
import { checkinOf } from '../server/modules/teams/proactive.js';
import { fieldOf, onTopic, primaryScore, roleHead } from '../server/modules/specialists/defaults.js';
import { extractionSystem } from '../server/modules/specialists/round.js';

async function mainBot(env: Env, name = 'Baas') {
  const { token } = await env.t.api('POST', '/teams/main/intent', {});
  return env.t.agent({ name, role: 'Eigenaar helpt met alle projecten en denkt en werkt proactief mee.', tool_groups: ['team'], settings: { mainBot: token } });
}

/** A team of twelve bots with ordinary roles. */
const TEAM: [string, string][] = [
  ['Postbot', 'Postbot: mail, berichten en signalen; belangrijke zaken direct naar de eigenaar'],
  ['Kantoor', 'Kantoor: administratie, financiën, contracten, domeinen en deadlines'],
  ['Assistent', 'Persoonlijke assistent: agenda, afspraken, herinneringen en privézaken'],
  ['Verkenner', 'Kansenonderzoeker: nieuwe niches, leadkopers, verdienmodellen en bedrijven'],
  ['Strateeg', 'Strateeg: plannen voor nieuwe leadsites, webshops en bedrijven; scoort kansen'],
  ['Radar', 'Beheerder leadsites: techniek, leadroute, livegang en onderhoud'],
  ['Vindbaar', 'SEO-specialist: technische SEO, zoekwoorden en ranking van leadsites en shops'],
  ['Pen', "Contentschrijver: SEO-pagina's, gidsen, vergelijkingen en productteksten"],
  ['Winkelchef', 'Beheerder webshops: CMS, catalogus, kassa, feeds en nieuwe winkels'],
  ['Inkoper', 'Inkoop en voorraad: leveranciers, bestelvoorstellen, levertijden en marges'],
  ['Klanthulp', 'Klantenservice: beantwoordt klantvragen van alle shops en leadsites als concept'],
  ['Campagne', 'Google Ads-, Merchant Center- en metingspecialist'],
];

test('a new team gets nothing by itself: no routine, no run, no model call, whatever the roles say', async () => {
  const env = await setup({ start: '2026-11-09T04:00:00Z' });
  try {
    await mainBot(env, 'Robin');
    for (const [name, role] of TEAM) await env.t.agent({ name, role, description: role, tool_groups: ['team', 'web'] });
    // Two full days of the planner, and the work loop looking as well.
    await env.at('2026-11-11T04:00:00Z');
    assert.equal(await env.workNow(), 0, 'no work: no turn');
    const store = env.t.app.ctx.store;
    assert.equal(store.one<any>('SELECT COUNT(*) n FROM routines')!.n, 0, 'live this was 49 routines in one night');
    assert.equal(store.one<any>('SELECT COUNT(*) n FROM routine_runs')!.n, 0, 'live: 64 runs, all "niets nieuws"');
    assert.equal(env.t.requests.length, 0, 'and nobody was asked to think up duties');
    const view = await env.t.api('GET', '/proactive/duties');
    assert.deepEqual(view.duties, []);
    assert.deepEqual(view.archived, []);
    assert.deepEqual((await env.t.api('GET', '/proactive/work')).work, []);
  } finally {
    await env.t.close();
  }
});

test('upgrade: seeded routines that never produced anything are archived (logged, restorable); everything deliberate stays', async () => {
  const env = await setup({ start: '2026-11-11T04:00:00Z' });
  try {
    const ctx = env.t.app.ctx;
    const store = ctx.store;
    const { engine, duties, userId } = env;
    const sem = await env.t.agent({ name: 'Vindbaar', role: 'SEO-specialist: technische SEO', tool_groups: ['team'] });
    const pen = await env.t.agent({ name: 'Pen', role: "Contentschrijver: SEO-pagina's en gidsen", tool_groups: ['team'] });
    const ink = await env.t.agent({ name: 'Inkoper', role: 'Inkoop en voorraad', tool_groups: ['team'] });
    await teamWithSite(env);
    await env.at('2026-11-11T04:01:00Z'); // a fresh install: the clean-up finds nothing and remembers it ran
    assert.equal(store.getSetting<any>(userId, 'proactive.cleanup', null).archived, 0);

    // ---- Now make it the owner's install of 0.4.4, the way the old seeder left it.
    const lib = (key: string) => builtinDuty(key)!;
    const old = (agentId: string, key: string) => duties.create(userId, agentId, lib(key));
    const run = (r: any, o: any = {}) =>
      store.insert('routine_runs', { id: newId('rr_'), routine_id: r.id, user_id: userId, run_key: newId('k_'), trigger: 'schedule', trigger_id: null, event_id: null, scheduled_for: null, status: 'no_update', attempt: 1, max_attempts: 2, next_retry_at: null, run_id: null, thread_id: null, message_id: null, no_update: true, payload: null, usage: {}, summary: 'In orde: geen open taken op het bord.', error: null, meta: {}, notified: false, created_at: '2026-11-11T08:30:00.000Z', started_at: '2026-11-11T08:30:00.000Z', finished_at: '2026-11-11T08:30:00.000Z', duration_ms: 0, ...o });
    // Seeded and never useful: "open taken afmaken" for all three, the SEO checks for the SEO bot AND for the writer.
    const filler = [old(sem.id, 'werk.afmaken'), old(pen.id, 'werk.afmaken'), old(ink.id, 'werk.afmaken'), old(pen.id, 'seo.techniek'), old(pen.id, 'seo.posities'), old(sem.id, 'seo.posities')];
    for (const r of filler.slice(0, 3)) for (let i = 0; i < 2; i++) run(r, { meta: { duty: { key: 'werk.afmaken', numbers: { open: 0 } } } });
    run(filler[4], { summary: 'Wacht: Koppel Search Console (Instellingen › Apps) en zet de app aan bij Pen.', meta: { duty: { key: 'seo.posities', needs: 'Koppel Search Console' } } });
    // Seeded, but it did find something once: it stays.
    const useful = old(sem.id, 'seo.techniek');
    run(useful, { status: 'done', no_update: false, summary: '1 probleem', meta: { duty: { key: 'seo.techniek', findings: 1, created: [1] } } });
    // Seeded, but the owner changed it since: it stays.
    const edited = old(sem.id, 'seo.indexering');
    engine.update(edited, { prompt: 'Kijk alleen naar de sitemap van raamwinkel.' });
    // The one-off "Vaste taken bedenken" of the buyer, with the duty it thought up in that run (on an empty table).
    const setupR = engine.create(userId, { name: 'Vaste taken bedenken', agent_id: ink.id, prompt: 'Bedenk welke vaste taken bij je rol passen en stel ze in.', schedule: { kind: 'weekly', days: [1], times: ['07:00'] }, options: { duty: { key: SETUP_KEY, check: 'Bedenk welke vaste taken bij je rol passen en stel ze in.', source: 'team', okWhen: 'je vaste taken zijn ingesteld', onProblem: 'task' } } });
    const from = env.clock.now;
    const invented = duties.create(userId, ink.id, { key: 'eigen', title: 'Marge onder 25%', check: 'Welke artikelen hebben een marge onder 25%?', source: 'team', okWhen: '0 artikelen', onProblem: 'ask', days: [1], times: ['10:00'], measure: { kind: 'query', sql: 'SELECT 0', op: '=', value: 0 } } as any);
    run(setupR, { run_id: 'run_setup', summary: 'In orde: 1 vaste taak ingesteld', started_at: new Date(from - 5000).toISOString(), finished_at: new Date(from + 30_000).toISOString(), meta: { duty: { key: SETUP_KEY, model: 1 } } });
    run(invented, { summary: 'In orde: 0 uit de teamdatabase (in orde als = 0).', meta: { duty: { key: 'eigen', findings: 0, created: [], closed: 0 } } });
    store.setSetting(userId, 'proactive.seeded', {
      [sem.id]: { v: 2, keys: ['seo.techniek', 'seo.posities', 'seo.indexering', 'werk.afmaken'], sig: 'x' },
      [pen.id]: { v: 2, keys: ['seo.techniek', 'seo.posities', 'seo.indexering', 'werk.afmaken'], sig: 'x' },
      [ink.id]: { v: 2, keys: ['werk.afmaken', SETUP_KEY], sig: 'x' },
    });
    // Deliberate: a duty the owner wrote, one a bot set in a conversation (much later than its setup run), an ordinary
    // routine and a reminder.
    env.clock.now += 10 * 60_000;
    const own = await env.t.api('POST', '/proactive/duties', { agentId: ink.id, title: 'Voorraad kozijnen', check: 'Is er nog voorraad?', okWhen: 'meer dan 5 stuks', onProblem: 'task', times: ['08:00'] });
    const th = await env.t.api('POST', '/threads', { agentId: ink.id });
    env.t.script.push({ toolCalls: [{ name: 'duty_set', args: { title: 'Te late leveringen', check: 'Welke leveringen zijn te laat?', ok_when: 'geen', on_problem: 'task', times: ['09:00'] } }] }, { text: 'Ingesteld.' });
    await env.t.say(th.id, 'Houd de te late leveringen in de gaten.');
    const plain = engine.create(userId, { name: 'Weekrapport', agent_id: sem.id, prompt: 'Maak het weekrapport.', schedule: { kind: 'weekly', days: [5], times: ['16:00'] } });
    const before = store.one<any>('SELECT COUNT(*) n FROM routines')!.n;
    assert.equal(before, 13);

    // ---- The first start after the update.
    store.setSetting(userId, 'proactive.cleanup', null);
    env.clock.now += 61_000;
    engine.tick();
    await engine.idle();

    const gone = [...filler, setupR, invented];
    const left = store.all<any>('SELECT id, name FROM routines').map((r) => r.id);
    for (const r of gone) assert.ok(!left.includes(r.id), `${r.name} is archived`);
    for (const r of [useful, edited, { id: own.id }, plain]) assert.ok(left.includes(r.id), 'kept');
    assert.ok(duties.duties(userId, ink.id).some((r) => r.name === 'Te late leveringen'), 'what a bot set in a conversation stays');
    assert.equal(left.length, before - 8);

    // Nothing is lost: the whole routine is kept, each one is in the log, and the owner hears it once.
    const arch = duties.archived(userId);
    assert.equal(arch.length, 8);
    assert.deepEqual(arch.map((a) => a.id).sort(), gone.map((r) => r.id).sort());
    const a1 = arch.find((a) => a.id === filler[4].id)!;
    assert.equal(a1.agentName, 'Pen');
    assert.match(a1.reason, /Door TeamBot zelf aangemaakt op grond van de rol van de bot, niet door jou gevraagd\. Heeft nooit iets opgeleverd\. \(Koppel Search Console/);
    assert.deepEqual(a1.routine.schedule, filler[4].schedule);
    assert.equal(a1.routine.options.duty.key, 'seo.posities');
    assert.match(arch.find((a) => a.id === invented.id)!.reason, /bedacht in de automatische ronde “Vaste taken bedenken”, niet door jou gevraagd/);
    assert.equal(arch.find((a) => a.id === filler[0].id)!.runs, 2);
    assert.equal(store.all<any>("SELECT id FROM audit WHERE kind = 'routine.archived'").length, 8);
    const told = env.notes().filter((n) => n.title === 'TeamBot heeft opgeruimd');
    assert.equal(told.length, 1);
    assert.match(told[0].body, /^8 automatische routines die nooit iets opleverden, zijn gearchiveerd\. Niets is weg/);
    const view = await env.t.api('GET', '/proactive/duties');
    assert.equal(view.archived.length, 8, 'shown at Werk');

    // Once: the next minutes archive nothing more (not even a built-in check the owner picks now).
    await give(env, pen, ['seo.techniek']);
    await env.at(new Date(env.clock.now + 5 * 60_000).toISOString());
    assert.equal(duties.archived(userId).length, 8);
    assert.ok(env.duty(pen.id, 'seo.techniek'));

    // One click puts a routine back as it was.
    const back = await env.t.api('POST', `/proactive/archived/${invented.id}/restore`, {});
    assert.equal(back.name, 'Marge onder 25%');
    assert.equal(back.status, 'active');
    assert.equal(back.options.duty.measure.sql, 'SELECT 0');
    assert.equal(duties.archived(userId).length, 7);
    assert.equal(store.all<any>("SELECT id FROM audit WHERE kind = 'routine.restored'").length, 1);
  } finally {
    await env.t.close();
  }
});

test('a due routine leads to a real run: the bot’s own model, its tools, and the result on the receipt', async () => {
  const env = await setup({ start: '2026-11-09T04:00:00Z' });
  try {
    const store = env.t.app.ctx.store;
    const kim = await env.t.agent({ name: 'Kim', role: 'Administratie', tool_groups: ['team'] });
    const made = await env.t.api('POST', '/routines', { name: 'Logboek bijwerken', agent_id: kim.id, prompt: 'Schrijf in het logboek wat er vandaag is nagekeken.', schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['06:00'] } });
    env.t.script.push(
      { toolCalls: [{ name: 'team_execute', args: { sql: 'INSERT INTO logboek (agent, wat, waarom, bewijs) VALUES (?, ?, ?, ?)', params: ['Kim', 'Dagcontrole gedaan', 'Routine Logboek bijwerken', '3 posten nagekeken op 9 nov'] } }] },
      { text: 'Het logboek is bijgewerkt: 3 posten nagekeken.' },
    );
    await env.at('2026-11-09T05:00:05Z'); // 06:00 local
    const [rr] = env.runs(made.id);
    assert.equal(rr.status, 'done', 'not "niets nieuws": the run did something');
    assert.ok(rr.run_id, 'a real bot turn');
    assert.equal(rr.summary, 'Het logboek is bijgewerkt: 3 posten nagekeken.');
    assert.equal(env.t.requests.length, 2, 'the model was called: once for the tool, once for the answer');
    assert.equal(env.t.requests[0].model, 'mock-1', 'on the bot’s own model');
    // With its own tools: the core in its list, the team database on demand (tools/selection.ts).
    assert.match(env.t.requests[0].tools!.find((x: any) => x.name === 'tools_find')!.description, /teamdatabase: [^;]*\bteam_execute\b/);
    assert.match(JSON.stringify(env.t.requests[0].messages), /Schrijf in het logboek wat er vandaag is nagekeken/);
    const core = store.one<any>('SELECT status, trigger FROM runs WHERE id = ?', rr.run_id);
    assert.deepEqual([core.status, core.trigger], ['done', 'routine']);
    const log = await env.t.app.ctx.services.teamdata.rows(env.userId, 'SELECT agent, wat, bewijs FROM logboek', [], true);
    assert.deepEqual(log.map((x: any) => [x.agent, x.wat, x.bewijs]), [['Kim', 'Dagcontrole gedaan', '3 posten nagekeken op 9 nov']], 'the tool really ran');
    assert.equal(store.all<any>("SELECT id FROM messages WHERE run_id = ? AND role = 'tool'", rr.run_id).length, 1);

    // A measured duty whose check finds a problem wakes its bot too (the gate is only "nothing wrong → no model").
    await teamWithSite(env);
    await give(env, kim, ['seo.techniek']);
    env.site.pages['https://raamwinkel.test'] = { body: page({ noindex: true }) };
    env.t.script.push({ text: 'De noindex staat in het thema; taak blijft open.' });
    await env.at('2026-11-10T05:30:05Z');
    const dr = env.runs(env.duty(kim.id, 'seo.techniek').id)[0];
    assert.equal(dr.status, 'done');
    assert.equal(dr.meta.duty.model, 1);
    assert.equal(dr.meta.duty.findings, 1);
  } finally {
    await env.t.close();
  }
});

test('the work loop: a task is picked up now, the main bot hands out and checks, the same list is never run twice, permission is asked once', async () => {
  const env = await setup({ start: '2026-11-09T08:00:00Z' });
  try {
    const ctx = env.t.app.ctx;
    const store = ctx.store;
    const baas = await mainBot(env);
    const radar = await env.t.agent({ name: 'Radar', role: 'Beheerder leadsites: techniek, leadroute, livegang en onderhoud', tool_groups: ['team'] });
    await env.t.agent({ name: 'Pen', role: 'Contentschrijver', tool_groups: ['team'] });
    env.work.enabled = false;
    const turns = (re: RegExp) => env.t.requests.filter((r) => re.test(JSON.stringify(r.messages)));
    const work = async () => (await env.t.api('GET', '/proactive/work')).work as any[];

    // The owner's goals as TeamBot knows them go into the main bot's check-in: nothing yet, so it asks for one.
    const checkin = checkinOf(ctx)!;
    let goals = await checkin.goals(env.userId);
    assert.deepEqual(goals, { lines: [], projects: 0, tasks: 0 });
    let ins = checkin.instruction(env.userId, 'morning', '', [], [], goals);
    assert.match(ins, /Er loopt geen enkel project en er staat geen taak open/);
    assert.match(ins, /welk doel moet het team als eerste oppakken\? Verzin zelf geen doel/);
    assert.equal(await env.workNow(), 0, 'no work: nobody gets a turn');

    // Live: this task stood on the board with nobody behind it, while 26 runs said "geen open taken".
    const task = await env.t.api('POST', '/rooms/tasks', { title: 'Voorbeeldsite.nl heeft geen leadkoper: aanvragen komen nergens aan', description: 'Zoek een koper voor de leads en sluit het formulier aan.' });
    assert.equal(store.one<any>('SELECT owner_id FROM room_tasks WHERE id = ?', task.id).owner_id, null);
    assert.deepEqual((await work()).map((w) => [w.agentName, w.items.map((i: any) => i.kind)]), [['Baas', ['unowned']]]);

    // 1. The main bot gets it (it has no owner) and gives it to the bot whose role fits.
    env.t.script.push({ toolCalls: [{ name: 'task_update', args: { id: task.id, owner: 'Radar', done_when: 'elke aanvraag op voorbeeldsite.nl komt bij een koper aan' } }] }, { text: 'De taak staat nu bij Radar.' });
    assert.equal(await env.workNow(), 1);
    const first = JSON.stringify(turns(/Zonder eigenaar:/)[0].messages);
    assert.match(first, /Zonder eigenaar:[\s\S]*taak “Voorbeeldsite\.nl heeft geen leadkoper: aanvragen komen nergens aan” \(takenbord, id task_\w+\) heeft geen eigenaar/);
    assert.match(first, /Jij stuurt het team\. Een taak zonder eigenaar geef je aan de bot wiens rol erbij past/);
    assert.match(first, /Toestemming van de eigenaar is alleen nodig voor: geld uitgeven, een eerste bericht aan een nieuw contact, en mail of berichten aan klanten\. Vraag dat ÉÉN keer, met een concreet voorstel[\s\S]*ga meteen door met de rest/);
    assert.match(first, /Verzin geen werk dat niet bij deze lijst, je rol of de projecten van de eigenaar hoort\. Zet geen wachtpunt/);
    assert.equal(store.one<any>('SELECT owner_id FROM room_tasks WHERE id = ?', task.id).owner_id, radar.id);

    // 2. That makes it Radar's work: its turn starts on the next look, in its own chat, with its own tools. It needs
    //    the owner's yes for a first message to a new contact: it asks once and parks the task.
    env.t.script.push(
      { toolCalls: [{ name: 'team_execute', args: { sql: 'INSERT INTO beslissingen (vraag, uitleg, opties, gevraagd_door) VALUES (?, ?, ?, ?)', params: ['Mag ik Zonwering Noord mailen met een voorstel voor de leads van voorbeeldsite.nl?', 'Eerste bericht aan een nieuw contact. Voorstel: € 12 per aanvraag, proef van 10 leads.', '["Ja, stuur", "Nee"]', 'Radar'] } }] },
      { toolCalls: [{ name: 'task_update', args: { id: task.id, status: 'blocked', result: 'Koper gevonden (Zonwering Noord). Wacht op je akkoord voor het eerste bericht.' } }] },
      { text: 'Koper gevonden: Zonwering Noord. Ik heb je om akkoord gevraagd voor het eerste bericht.' },
    );
    assert.equal(await env.workNow(), 1);
    const second = turns(/Op jouw naam:/)[0];
    assert.match(JSON.stringify(second.messages), /Op jouw naam:[\s\S]*taak “Voorbeeldsite\.nl heeft geen leadkoper[^”]*” \(takenbord, id task_\w+, te doen\) · klaar als: elke aanvraag op voorbeeldsite\.nl komt bij een koper aan/);
    assert.match(second.tools!.find((x: any) => x.name === 'tools_find')!.description, /\btask_done\b.*\bteam_execute\b/s, 'Radar works with its own tools');
    assert.doesNotMatch(JSON.stringify(second.messages), /Jij stuurt het team/);
    assert.equal(store.one<any>('SELECT status FROM room_tasks WHERE id = ?', task.id).status, 'blocked');
    const dec = await env.t.api('GET', '/teamdata/decisions?status=open');
    assert.equal((dec.decisions || dec).length, 1, 'asked once, with a concrete proposal');
    const radarChat = store.messages(ctx.chat.threadForAgent(env.userId, radar.id).id).filter((m: any) => !m.deleted);
    assert.equal(radarChat.at(-1)!.content, 'Koper gevonden: Zonwering Noord. Ik heb je om akkoord gevraagd voor het eerste bericht.', 'what it did is in its own chat');
    const audit = store.all<any>("SELECT data FROM audit WHERE kind = 'work.run' ORDER BY id").map((r) => JSON.parse(r.data));
    assert.deepEqual(audit.map((a) => [a.agent, a.items, a.closed, a.left, a.result]), [['Baas', 1, 1, 0, 'gewerkt'], ['Radar', 1, 1, 0, 'gewerkt']]);
    assert.equal(audit[1].tools, 2, 'the receipt says the turn used tools');

    // 3. What came back is the main bot's to look at: the blocked task. It looks once …
    env.t.script.push({ text: 'Radar wacht op je akkoord voor het eerste bericht aan Zonwering Noord; verder ligt er niets.' });
    assert.equal(await env.workNow(), 1);
    assert.match(JSON.stringify(turns(/Teruggekomen, kijk ernaar:/)[0].messages), /taak “Voorbeeldsite\.nl[^”]*” van Radar \(takenbord, id task_\w+\) staat op “geblokkeerd”: Koper gevonden \(Zonwering Noord\)/);
    // … and is not started again for the very same list, however often TeamBot looks. No bot is.
    const calls = env.t.requests.length;
    for (let i = 0; i < 5; i++) {
      env.clock.now += 60_000;
      assert.equal(await env.workNow(), 0);
    }
    assert.equal(env.t.requests.length, calls, 'no pointless turns');
    assert.match((await work()).find((w) => w.agentName === 'Baas').waits, /het gaat verder zodra er iets verandert/);
    assert.equal((await work()).find((w) => w.agentName === 'Baas').last.result, 'gewerkt');

    // 4. Meanwhile other work goes on: a new task for Radar is picked up at once (the waiting one does not hold it).
    await env.t.api('POST', '/rooms/tasks', { title: 'Sitemaps van 4 leadsites zijn onvolledig', owner: 'Radar' });
    env.t.script.push({ text: 'Ik kan de sitemaps nu niet aanpassen: de server geeft geen toegang.' });
    assert.equal(await env.workNow(), 1);
    assert.match(JSON.stringify(env.t.requests.at(-1)!.messages), /taak “Sitemaps van 4 leadsites zijn onvolledig”/);
    assert.doesNotMatch(JSON.stringify(env.t.requests.at(-1)!.messages.at(-1)), /Voorbeeldsite/, 'the parked task is not in the list');
    // It did not sign the task off: the same list is not run again right away, but once more after a while, and
    // the instruction then says so; after MAX_SAME tries it rests until something changes.
    assert.equal(await env.workNow(), 0);
    for (let n = 2; n <= MAX_SAME; n++) {
      env.clock.now += RETRY_SAME_MS + 60_000;
      // (The main bot's own unchanged list — the blocked task — gets its later try in the same look.)
      env.t.script.push({ text: 'Nog steeds geen toegang tot de server.' }, { text: 'Nog steeds geen toegang tot de server.' });
      assert.equal(await env.workNow(), 2, `try ${n}`);
      assert.equal(turns(new RegExp(`Sitemaps van 4 leadsites[\\s\\S]*dezelfde lijst als de vorige keer \\(poging ${n} van ${MAX_SAME}\\)`)).length, 1);
    }
    env.clock.now += RETRY_SAME_MS + 60_000;
    assert.equal(await env.workNow(), 0, 'no fourth try');
    assert.match((await work()).find((w) => w.agentName === 'Radar').waits, /kwam hier niet verder mee/);

    // 5. A project is a goal of the owner: its owner gets the next step as work, and the check-in names it.
    const p = await env.t.api('POST', '/proactive/projects', { naam: 'Voorbeeldsite verkoopt leads', doel: 'Elke aanvraag gaat naar een betalende koper', eigenaar: 'Radar' });
    assert.equal(p.project.status, 'sprint');
    goals = await checkin.goals(env.userId);
    assert.equal(goals!.projects, 1);
    ins = checkin.instruction(env.userId, 'morning', '', [], [], goals);
    assert.match(ins, /De doelen van de eigenaar waar nu aan gewerkt wordt \(projecten\):\n- project 1 “Voorbeeldsite verkoopt leads”/);
    assert.match(ins, /Wat je zelf kunt doen of bij een bot kunt uitzetten, doe je nu, in deze beurt/);
    const owner = (await env.t.api('GET', '/proactive/projects')).projects[0].eigenaar;
    const who = owner === 'Radar' ? 'Radar' : 'Baas';
    env.t.script.push({ toolCalls: [{ name: 'project_stap', args: { project: 1, nulmeting: '0 van de 11 aanvragen in oktober ging naar een koper (formulierlog voorbeeldsite.nl, 9 nov 2026)' } }] }, { text: 'Nulmeting vastgelegd.' });
    assert.ok((await env.workNow()) >= 1);
    assert.match(JSON.stringify(turns(/project 1 “Voorbeeldsite verkoopt leads”/).at(-2)!.messages), /volgende stap: Nulmeting: de echte cijfers van nu, met bron en datum/);
    assert.equal((await env.t.api('GET', '/proactive/projects')).projects[0].fase, 'diagnose', `${who} took the step`);
  } finally {
    await env.t.close();
  }
});

test('the work loop starts no turn while the owner is talking to the bot, for a bot without an AI, or when switched off', async () => {
  const env = await setup({ start: '2026-11-09T08:00:00Z' });
  try {
    const kim = await env.t.agent({ name: 'Kim', role: 'Administratie', tool_groups: ['team'] });
    await env.t.app.ctx.services.teamdata.write(env.userId, [{ sql: "INSERT INTO taken (titel, eigenaar, status, klaar_als) VALUES ('Factuur 12 inboeken', 'Kim', 'open', 'factuur 12 staat in de boekhouding')" }]);
    // Off (as under the test runner by default): the planner's minute does nothing.
    await env.at('2026-11-09T08:05:00Z');
    assert.equal(env.t.requests.length, 0);
    // A bot that is busy is left alone; the work waits for it.
    const store = env.t.app.ctx.store;
    const th = env.t.app.ctx.chat.threadForAgent(env.userId, kim.id);
    store.exec("INSERT INTO runs (id, thread_id, agent_id, user_id, status, trigger, created_at) VALUES ('run_busy', ?, ?, ?, 'running', 'user', ?)", th.id, kim.id, env.userId, new Date().toISOString());
    assert.equal(await env.workNow(), 0);
    assert.equal((await env.t.api('GET', '/proactive/work')).work[0].waits, 'de bot is bezig');
    store.exec("DELETE FROM runs WHERE id = 'run_busy'");
    // Free again: the turn starts, and the task that is signed off leaves the list.
    env.t.script.push({ toolCalls: [{ name: 'team_execute', args: { sql: "UPDATE taken SET status = 'klaar', resultaat = 'Ingeboekt', bewijs = 'boekstuk 2026-0412' WHERE id = 1" } }] }, { text: '{"verdict":"klaar","reason":"Het boekstuk is genoemd."}' }, { text: 'Factuur 12 is ingeboekt (boekstuk 2026-0412).' });
    assert.equal(await env.workNow(), 1);
    // (Signed off with proof: TeamBot's own second look at that proof is the model call in between.)
    assert.equal((await env.taken())[0].status, 'klaar');
    assert.equal(await env.workNow(), 0);
    const w = (await env.t.api('GET', '/proactive/work')).work[0];
    assert.deepEqual([w.agentName, w.items.length, w.last.result, w.last.text], ['Kim', 0, 'gewerkt', 'Factuur 12 is ingeboekt (boekstuk 2026-0412).']);
  } finally {
    await env.t.close();
  }
});

test('a specialist learns only about its own field: what a bot is, not what its role mentions; a page about something else is no source', async () => {
  // What the bot IS (its name and the head of its role).
  assert.equal(roleHead("Contentschrijver: SEO-pagina's, gidsen, vergelijkingen en productteksten"), 'Contentschrijver');
  assert.equal(fieldOf('Pen', "Contentschrijver: SEO-pagina's, gidsen, vergelijkingen en productteksten"), null, 'live this writer became an SEO specialist');
  assert.equal(fieldOf('Vindbaar', 'SEO-specialist: technische SEO, zoekwoorden en ranking van leadsites en shops'), 'Zoekmachineoptimalisatie (SEO)');
  assert.equal(fieldOf('Radar', 'Beheerder leadsites: techniek, leadroute, livegang en onderhoud'), null);
  assert.equal(fieldOf('Verkenner', 'Onderzoekt de markt'), null, '"Verkenner" is not a "kenner"');
  assert.equal(fieldOf('Imker-expert', 'Bijen houden'), 'Bijen houden');
  // A source must be about the field; that it is official says nothing about its subject.
  const field = 'Strateeg: plannen voor nieuwe leadsites, webshops en bedrijven; scoort kansen';
  assert.equal(onTopic('https://lokaleregelgeving.overheid.nl/CVDR766086/1', 'Omgevingsvisie gemeente Voorbeeld "Koers op een sterke thuishaven"', field), false, 'a municipal vision is not a source for a strategy bot');
  assert.equal(primaryScore('https://lokaleregelgeving.overheid.nl/CVDR766086/1', 'Omgevingsvisie gemeente Voorbeeld "Koers op een sterke thuishaven"', field), 0);
  assert.equal(onTopic('https://polydoor.nl/nieuwe-regels', 'Nieuwe regels voor webshops en ondernemers per 1 juli 2026', field), true);
  assert.equal(onTopic('https://questry.ai/blog/x', 'Nieuwe klanten werven B2B: 6 methoden naast elkaar', field), false, '"nieuwe" and "voor" are not a subject');
  assert.ok(primaryScore('https://www.belastingdienst.nl/zzp', 'Belastingdienst', 'Belastingrecht') > 0);
  // The model that reads a source is told for whom, and to take nothing from a text about something else.
  const sys = extractionSystem(field, { max: 8, about: 'rol van de bot: Strateeg; het bedrijf: Leadsites en webshops voor de bouw' });
  assert.match(sys, /Voor wie de specialist werkt: rol van de bot: Strateeg; het bedrijf: Leadsites en webshops voor de bouw/);
  assert.match(sys, /Gaat de bron \(of een deel ervan\) over iets anders \(een andere branche, een gemeente of regio, een ander onderwerp\), neem daar dan niets uit over/);

  // Upgrade: a source a bot found by itself that is not about its field is switched off (not removed), once, and logged.
  const env = await setup({ start: '2026-11-11T08:00:00Z' });
  try {
    const ctx = env.t.app.ctx;
    const sp = ctx.services.specialists.svc;
    const st = await env.t.agent({ name: 'Strateeg', role: field, settings: { specialist: true } });
    const agent = ctx.store.agent(st.id)!;
    sp.save(env.userId, st.id, { enabled: true, field, learnOn: false, sources: [{ kind: 'web', target: 'https://eigen.test/webshops', label: 'Door de eigenaar toegevoegd' }] });
    const prof = sp.profile(st.id);
    const found = new Date(Date.now() + 1000).toISOString();
    ctx.store.update('specialist_profiles', st.id, { settings: { ...prof.settings, discoveredAt: found } }, 'agent_id');
    const src = (target: string, label: string, sort: number) => ctx.store.insert('specialist_sources', { id: newId('sps_'), agent_id: st.id, user_id: env.userId, kind: 'web', target, label, enabled: true, suggested: true, state: {}, last_checked_at: null, last_status: null, last_error: null, sort, created_at: found, updated_at: found });
    src('https://lokaleregelgeving.overheid.nl/CVDR766086/1', 'Omgevingsvisie gemeente Voorbeeld "Koers op een sterke thuishaven"', 1);
    src('https://polydoor.nl/nieuwe-regels-voor-webshops', 'Nieuwe regels voor webshops en ondernemers per 1 juli 2026', 2);
    assert.equal(sp.pruneOffTopic(agent), 1);
    const rows = sp.sources(st.id).map((s: any) => [s.label.slice(0, 22), s.enabled]);
    assert.deepEqual(rows, [['Door de eigenaar toegev', true], ['Omgevingsvisie gemeente', false], ['Nieuwe regels voor web', true]].map(([l, e]) => [String(l).slice(0, 22), e]), 'only the page about something else is off; the owner’s own source is never touched');
    assert.match(sp.sources(st.id).find((s: any) => !s.enabled).last_error, /deze bron gaat niet over het vakgebied/);
    assert.equal(ctx.store.all<any>("SELECT id FROM audit WHERE kind = 'specialists.source_off'").length, 1);
    assert.ok(env.notes().some((n) => /Strateeg leert niet meer van een bron buiten zijn vak/.test(n.title)));
    assert.equal(sp.pruneOffTopic(agent), 0, 'once');
  } finally {
    await env.t.close();
  }
});

test('the main bot’s own task that the second look did not pass is its work (not only the owner’s), unless TeamBot looks again by itself', async () => {
  const env = await setup({ start: '2026-11-09T08:00:00Z' });
  try {
    const store = env.t.app.ctx.store;
    const baas = await mainBot(env);
    env.work.enabled = false;
    const task = await env.t.api('POST', '/rooms/tasks', { title: 'Sitemap nalopen' });
    store.update('room_tasks', task.id, { owner_type: 'agent', owner_id: baas.id, status: 'review', updated_at: new Date(env.clock.now).toISOString() });
    const q = env.t.app.ctx.services.quality.svc.ensure(env.userId, 'room', task.id, 'Sitemap nalopen');
    store.update('quality_tasks', q.id, { check_state: 'review', check_reason: 'De uitvoer van de telling ontbreekt.', open: true });
    const work = async () => ((await env.t.api('GET', '/proactive/work')).work as any[]).flatMap((w) => w.items.map((i: any) => [w.agentName, i.kind, i.text]));
    assert.deepEqual(await work(), [['Baas', 'check', `je eigen taak “Sitemap nalopen” (takenbord, id ${task.id}) staat op “te controleren”: De uitvoer van de telling ontbreekt.`]]);
    env.t.script.push({ text: 'De telling staat er nu bij.' });
    assert.equal(await env.workNow(), 1);
    assert.match(JSON.stringify(env.t.requests.at(-1)!.messages), /Een eigen taak op “te controleren”: lees waarom de controle hem niet goedkeurde/);
    assert.equal(await env.workNow(), 0, 'the same task is not started for again right away');
    // TeamBot will do the look again itself: then it is not the bot's work.
    store.update('quality_tasks', q.id, { recheck_at: new Date(env.clock.now + 3600_000).toISOString() });
    assert.deepEqual(await work(), []);
  } finally {
    await env.t.close();
  }
});
