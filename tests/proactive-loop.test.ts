// The work loop around the vaste taken: projects in fixed steps with a sprint limit, opportunities that need a dated
// source and the owner's yes, the main bot's briefing without a model, two teams side by side, and the private team
// with reminders that arrive on the owner's phone and chat app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teamWithSite, page, healthySite, type Env, give } from './proactive-helpers.js';
import { parseDate, cleanSources, scoreOf } from '../server/modules/teamdata/kansen.js';
import { isoWeek } from '../server/modules/teams/briefing.js';
import type { AdapterContext, AdapterDef, Outbound } from '../server/modules/channels/types.js';

// These tests are about bots that are not the main bot: without this the first bot would be it (teams `autoMain`,
// covered in works-right-away.test.ts).
process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

const tool = async (env: Env, agent: any, name: string, args: any) => {
  const th = await env.t.api('POST', '/threads', { agentId: agent.id });
  env.t.script.push({ toolCalls: [{ name, args }] }, { text: 'ok' });
  const msgs = await env.t.say(th.id, name);
  const res = msgs.filter((m: any) => m.role === 'tool').at(-1);
  return String(res?.content || '');
};

async function mainBot(env: Env, name = 'Baas') {
  const { token } = await env.t.api('POST', '/teams/main/intent', {});
  return env.t.agent({ name, role: 'Hoofdbot', tool_groups: ['team'], settings: { mainBot: token } });
}

test('a project goes inspectie → diagnose → plan → uitvoeren → meten → tip-top, and no step is taken without what it must deliver', async () => {
  const env = await setup();
  try {
    const sem = await env.t.agent({ name: 'Sem', role: 'Technische SEO', tool_groups: ['team'] });
    const [team] = await env.t.api('GET', '/teams');
    await teamWithSite(env);
    await give(env, sem, ['seo.techniek']);
    await env.at('2026-11-09T04:01:00Z');
    const projects = env.t.app.ctx.services.projects;
    projects.clock = () => env.clock.now;

    // The bot starts the project; TeamBot measures the site itself: the first real numbers of the nulmeting.
    env.site.pages['https://raamwinkel.test'] = { body: page({ description: '' }) };
    const started = await tool(env, sem, 'project_start', { naam: 'Raamwinkel tip-top', site: 'raamwinkel.test', doel: 'Geen technische SEO-fouten meer' });
    assert.match(started, /Project “Raamwinkel tip-top” is gestart \(project 1\)/);
    assert.match(started, /TeamBot sitecontrole 2026-11-09 04:01 UTC \(https:\/\/raamwinkel\.test\): .*fouten: 1, raamwinkel\.test status: 200.*de startpagina heeft geen beschrijving/);

    // A project without a site has no numbers yet: the step is refused until the bot gives them, with source and date.
    await projects.start(env.userId, team.id, 'Sem', { naam: 'Nieuwsbrief', doel: 'Meer inschrijvingen' });
    await assert.rejects(projects.step(env.userId, team.id, 2, 'Sem', {}), /De nulmeting ontbreekt: geef de echte cijfers van nu/);
    await assert.rejects(projects.step(env.userId, team.id, 2, 'Sem', { nulmeting: 'Het gaat niet zo goed' }), /De nulmeting ontbreekt/);
    await assert.rejects(projects.step(env.userId, team.id, 2, 'Sem', { nulmeting: '412 inschrijvingen' }), /de datum van de meting en de bron/);
    await projects.step(env.userId, team.id, 2, 'Sem', { nulmeting: '412 inschrijvingen, 1,8% conversie (Mailchimp, 9 nov)' });

    // Project 1, step by step through the bot's tool.
    assert.match(await tool(env, sem, 'project_stap', { project: 1, nulmeting: 'Search Console 9 nov: 1.240 klikken per week, positie 14,2' }), /Nulmeting vastgelegd/);
    assert.match(await tool(env, sem, 'project_stap', { project: 1 }), /De diagnose ontbreekt/);
    assert.match(await tool(env, sem, 'project_stap', { project: 1, diagnose: 'De startpagina mist een meta description; daardoor toont Google willekeurige tekst.' }), /Diagnose vastgelegd/);
    assert.match(await tool(env, sem, 'project_stap', { project: 1, plan: 'Meta description schrijven en plaatsen op de startpagina.' }), /“klaar_als” ontbreekt/);
    assert.match(await tool(env, sem, 'project_stap', { project: 1, plan: 'Meta description schrijven en plaatsen op de startpagina.', klaar_als: 'de sitecontrole vindt 0 fouten' }), /Een plan heeft taken nodig/);
    const planned = await tool(env, sem, 'project_stap', {
      project: 1,
      plan: 'Meta description schrijven en plaatsen op de startpagina.',
      klaar_als: 'de sitecontrole vindt 0 fouten',
      taken: [{ titel: 'Meta description startpagina plaatsen', eigenaar: 'Sem', klaar_als: 'de startpagina heeft een meta description' }],
    });
    assert.match(planned, /Plan vastgelegd; 1 taak staat op het bord/);
    let taken = await env.taken();
    assert.equal(taken.length, 1);
    assert.equal(taken[0].project_id, 1);
    assert.equal(taken[0].klaar_als, 'de startpagina heeft een meta description');
    assert.equal(taken[0].aangevraagd_door, 'Project: Raamwinkel tip-top');

    // Uitvoeren ends only when every task is closed.
    assert.match(await tool(env, sem, 'project_stap', { project: 1 }), /Nog niet klaar met uitvoeren: deze taak staat nog open: taak 1/);
    assert.match(await tool(env, sem, 'project_stap', { project: 1, werklog: 'Tekst geschreven en ter controle gezet' }), /Genoteerd in het werklog/);
    await env.t.app.ctx.services.teamdata.write(env.userId, [{ sql: "UPDATE taken SET status = 'klaar', resultaat = 'Geplaatst', bewijs = 'https://raamwinkel.test' WHERE id = 1" }], team.id);
    assert.match(await tool(env, sem, 'project_stap', { project: 1 }), /Alle taken zijn dicht\. Volgende stap: meten/);

    // Meten: TeamBot measures again. The description is still missing → not tip-top, whatever the bot says.
    assert.match(await tool(env, sem, 'project_stap', { project: 1, meting: 'Search Console 12 nov: 1.310 klikken' }), /Nog niet tip-top\. TeamBot sitecontrole .*fouten: 1/);
    env.site.pages['https://raamwinkel.test'] = { body: page() };
    const tiptop = await tool(env, sem, 'project_stap', { project: 1, meting: 'Search Console 12 nov: 1.310 klikken per week, positie 12,9' });
    assert.match(tiptop, /Project “Raamwinkel tip-top” is tip-top\. De vaste taak “Websites: technische fouten en indexeerbaarheid” blijft als bewaker achter \(goedkoop model\)\./);
    assert.equal(env.duty(sem.id, 'seo.techniek').options.duty.guard, true, 'the duty stays behind as the guard');
    assert.equal(env.duty(sem.id, 'seo.techniek').options.duty.projectId, 1);

    // One simple progress view per project.
    const { projects: list } = await env.t.api('GET', '/proactive/projects');
    const p1 = list.find((p: any) => p.id === 1);
    assert.equal(p1.status, 'tiptop');
    assert.equal(p1.step, 5);
    assert.deepEqual(p1.tasks, { total: 1, open: 0, done: 1 });
    assert.match(p1.nulmeting, /fouten: 1[\s\S]*1\.240 klikken/);
    assert.match(p1.meting, /fouten: 0[\s\S]*1\.310 klikken/);
    assert.match(p1.werklog, /Sem: project gestart: inspectie[\s\S]*Sem: Tekst geschreven en ter controle gezet[\s\S]*Sem: gemeten: tip-top/);
    const p2 = list.find((p: any) => p.id === 2);
    assert.equal(p2.fase, 'diagnose');
    assert.equal(p2.step, 1);
    assert.equal(p2.next, 'Diagnose: wat is de oorzaak, onderbouwd met de nulmeting.');
  } finally {
    await env.t.close();
  }
});

test('with a maximum of three in the sprint (the owner’s setting; none by default): the fourth waits and moves up by itself', async () => {
  const env = await setup();
  try {
    await env.t.agent({ name: 'Sem', role: 'SEO' });
    const [team] = await env.t.api('GET', '/teams');
    const projects = env.t.app.ctx.services.projects;
    await env.t.api('PUT', '/proactive/settings', { maxSprint: 3 });
    for (const n of ['A', 'B', 'C']) assert.equal((await env.t.api('POST', '/proactive/projects', { naam: `Project ${n}`, doel: 'x' })).project.status, 'sprint');
    const d = await env.t.api('POST', '/proactive/projects', { naam: 'Project D', doel: 'x' });
    assert.equal(d.project.status, 'wacht');
    assert.match(d.note, /wacht: er zitten al 3 projecten in de sprint/);
    await assert.rejects(projects.step(env.userId, team.id, d.project.id, 'Sem', { nulmeting: '1 (bron, 9 nov)' }), /wacht nog op een plek in de sprint/);
    await assert.rejects(env.t.api('POST', '/proactive/projects', { naam: 'Project A', doel: 'x' }), /Er loopt al een project “Project A”/);

    await env.t.api('POST', '/proactive/projects/1/stop', {});
    const list = (await env.t.api('GET', '/proactive/projects')).projects;
    assert.deepEqual(list.map((p: any) => [p.naam, p.status]), [['Project B', 'sprint'], ['Project C', 'sprint'], ['Project D', 'sprint'], ['Project A', 'gestopt']]);
    assert.ok(env.notes().some((n) => n.title === 'Project “Project D” is gestart'));

    // The owner's one setting decides how many.
    await env.t.api('PUT', '/proactive/settings', { maxSprint: 2 });
    assert.equal((await env.t.api('POST', '/proactive/projects', { naam: 'Project E', doel: 'x' })).project.status, 'wacht');
  } finally {
    await env.t.close();
  }
});

test('an opportunity needs a dated, recent source; the main bot scores; the top 3 go to the owner; only his yes makes work', async () => {
  assert.equal(parseDate('2026-11-03'), '2026-11-03');
  assert.equal(parseDate('3 nov 2026'), '2026-11-03');
  assert.equal(parseDate('03-11-2026'), '2026-11-03');
  assert.equal(parseDate('vorige week'), null);
  assert.equal(parseDate('2026-02-31'), null);
  const now = Date.parse('2026-11-09T08:00:00Z');
  assert.deepEqual(cleanSources([{ url: 'https://a.test/x', datum: '2026-11-01' }, { url: 'geen link', datum: '2026-11-01' }, { url: 'https://b.test/y' }, { url: 'https://c.test', datum: '2027-01-01' }], now), [{ url: 'https://a.test/x', titel: '', datum: '2026-11-01' }]);
  assert.equal(scoreOf({ vraag: 5, past: 5, moeite: 1, kosten: 1, risico: 1 }), 100);
  assert.equal(scoreOf({ vraag: 1, past: 1, moeite: 5, kosten: 5, risico: 5 }), 0);
  assert.equal(scoreOf({ vraag: 4, past: 5, moeite: 2, kosten: 2, risico: 4 }), 73);

  const env = await setup({ start: '2026-11-09T04:00:00Z' });
  try {
    const rik = await env.t.agent({ name: 'Rik', role: 'Researcher', tool_groups: ['team', 'web'] });
    const baas = await mainBot(env);
    const kansen = env.t.app.ctx.services.kansen;
    kansen.clock = () => env.clock.now;
    env.t.app.ctx.services.projects.clock = () => env.clock.now;
    const base = { titel: 'TikTok Shop-advertenties', wat: 'Producten verkopen via TikTok Shop met betaalde video’s.', waarom_nu: 'TikTok Shop is in oktober in Nederland geopend en de advertentiekosten zijn nog laag.', kosten: '€ 150 testbudget en 4 uur', risico: 'Account kan geblokkeerd worden bij AI-video’s zonder label.', minitest: '3 video’s voor 1 product, 7 dagen, meet kosten per bestelling.' };

    // No source → refused, and nothing is stored: there is nothing to show.
    assert.match(await tool(env, rik, 'kans_melden', { ...base, bronnen: [] }), /Bronnen ontbreken: geef per bron het webadres en de datum/);
    assert.match(await tool(env, rik, 'kans_melden', { ...base, bronnen: [{ url: 'https://newsroom.tiktok.test/shop-nl', datum: 'onlangs' }] }), /Geen enkele bron heeft een webadres .* én een datum/);
    assert.match(await tool(env, rik, 'kans_melden', { ...base, bronnen: [{ url: 'https://newsroom.tiktok.test/shop-nl', datum: '2026-03-01' }] }), /Alle bronnen zijn ouder dan 90 dagen/);
    assert.match(await tool(env, rik, 'kans_melden', { ...base, minitest: '', bronnen: [{ url: 'https://newsroom.tiktok.test/shop-nl', datum: '2026-10-21' }] }), /De mini-test ontbreekt/);
    assert.equal((await env.t.api('GET', '/proactive/kansen')).kansen.length, 0);
    assert.match(await tool(env, rik, 'kans_melden', { ...base, bronnen: [{ url: 'https://newsroom.tiktok.test/shop-nl', titel: 'TikTok Shop opent in Nederland', datum: '2026-10-21' }] }), /Kans 1 staat op het kansenbord met 1 bron/);
    assert.match(await tool(env, rik, 'kans_melden', { ...base, bronnen: [{ url: 'https://newsroom.tiktok.test/shop-nl', datum: '2026-10-21' }] }), /Deze kans staat al op het bord \(kans 1\)/);
    for (const [i, t] of ['YouTube Shorts voor kozijnen', 'Bol-advertenties', 'Pinterest-pins'].entries())
      await kansen.report(env.userId, null, 'Rik', { ...base, titel: t, bronnen: [{ url: `https://bron.test/${i}`, datum: '2026-11-0' + (i + 1) }] });

    // Only the main bot scores; TeamBot computes the score.
    assert.match(await tool(env, rik, 'kans_scoren', { kans: 1, vraag: 5, past: 5, moeite: 1, kosten: 1, risico: 1, toelichting: 'Lijkt me top, laten we gaan.' }), /De scorekaart maakt de hoofdbot/);
    assert.match(await tool(env, baas, 'kans_scoren', { kans: 1, vraag: 4, past: 5, moeite: 2, kosten: 2, risico: 9, toelichting: 'x' }), /Geef voor “risico” een cijfer van 1 tot 5/);
    assert.match(await tool(env, baas, 'kans_scoren', { kans: 1, vraag: 4, past: 5, moeite: 2, kosten: 2, risico: 4, toelichting: 'Past bij de webshop; het risico op een ban is echt.' }), /kans 1 “TikTok Shop-advertenties” scoort 73\/100/);
    await kansen.score(env.userId, null, 'Baas', 2, { vraag: 3, past: 3, moeite: 3, kosten: 3, risico: 3, toelichting: 'Gemiddeld op alle punten.' });
    await kansen.score(env.userId, null, 'Baas', 3, { vraag: 5, past: 4, moeite: 2, kosten: 2, risico: 1, toelichting: 'Sterke vraag en weinig risico.' });
    await kansen.score(env.userId, null, 'Baas', 4, { vraag: 1, past: 2, moeite: 4, kosten: 3, risico: 2, toelichting: 'Past slecht bij de doelgroep.' });

    // Monday 08:00: the weekly top 3 goes to the owner, by the main bot, with source and date; nothing became work.
    const briefing = env.t.app.ctx.services.teams.briefing;
    briefing.clock = () => env.clock.now;
    env.clock.now = Date.parse('2026-11-09T07:00:30Z');
    const [sent] = await briefing.tick();
    assert.match(sent.text, /\*\*Kansen van deze week\*\*\n1\. Bol-advertenties \(score 86\/100\)\. Waarom nu: .* Bron: https:\/\/bron\.test\/1 \(2026-11-02\)\. Mini-test: /);
    assert.match(sent.text, /2\. TikTok Shop-advertenties \(score 73\/100\)[\s\S]*3\. YouTube Shorts voor kozijnen \(score 50\/100\)/);
    assert.doesNotMatch(sent.text, /Pinterest/, 'only the top 3');
    const note = env.notes().find((n) => n.title === 'Top 3 kansen van deze week');
    assert.ok(note);
    assert.equal(note.link, '#/inbox');
    assert.equal(note.level, 'important');
    const chat = env.t.app.ctx.store.messages(env.t.app.ctx.chat.threadForAgent(env.userId, baas.id).id);
    assert.equal(chat.at(-1)!.content, sent.text, 'the main bot says it in his own chat');
    assert.deepEqual(await briefing.tick(), [], 'once a week, not every minute');
    let board = (await env.t.api('GET', '/proactive/kansen')).kansen;
    assert.equal(board.filter((k: any) => k.status === 'voorgelegd').length, 3);
    assert.equal((await env.t.api('GET', '/proactive/kansen')).waiting, 3);
    assert.equal((await env.t.api('GET', '/proactive/projects')).projects.length, 0, 'an opportunity is not work');
    assert.ok(!env.t.app.ctx.tools.get('kans_beslissen'), 'no bot tool can decide');

    // Yes → a mini-test in the project loop; no → gone.
    const yes = await env.t.api('POST', '/proactive/kansen/1/decide', { choice: 'ja' });
    assert.equal(yes.kans.status, 'ja');
    assert.equal(yes.note, 'De mini-test is gestart als project.');
    const [proj] = (await env.t.api('GET', '/proactive/projects')).projects;
    assert.equal(proj.naam, 'Mini-test: TikTok Shop-advertenties');
    assert.equal(proj.kans_id, 1);
    assert.equal(proj.eigenaar, 'Rik');
    assert.match(proj.plan, /Mini-test: 3 video’s voor 1 product/);
    await env.t.api('POST', '/proactive/kansen/3/decide', { choice: 'nee' });
    await assert.rejects(env.t.api('POST', '/proactive/kansen/3/decide', { choice: 'ja' }), /al beslist/);
    board = (await env.t.api('GET', '/proactive/kansen')).kansen;
    assert.deepEqual(board.map((k: any) => [k.id, k.status]).sort(), [[1, 'ja'], [2, 'voorgelegd'], [3, 'nee'], [4, 'gescoord']]);
  } finally {
    await env.t.close();
  }
});

test('the researcher looks on the schedule the owner gave it, and the main bot scores what it found right away (no clock)', async () => {
  const env = await setup({ start: '2026-11-09T04:00:00Z' });
  try {
    const rik = await env.t.agent({ name: 'Rik', role: 'Kansenzoeker', tool_groups: ['team', 'web'] });
    const baas = await mainBot(env);
    env.t.app.ctx.services.kansen.clock = () => env.clock.now;
    await env.t.api('PUT', '/proactive/settings', { interests: 'webshops, SEO-sites, YouTube' });
    await env.at('2026-11-09T04:01:00Z');
    assert.equal(env.t.app.ctx.store.one<any>('SELECT COUNT(*) n FROM routines')!.n, 0, 'neither bot got a routine by itself');
    await give(env, rik, ['kansen.zoeken']);
    const search = env.duty(rik.id, 'kansen.zoeken');
    assert.equal(await env.workNow(), 0, 'no work yet: nobody is woken');

    // Tuesday 06:45: the researcher runs by itself and reports one opportunity with a dated source.
    env.t.script.push(
      { toolCalls: [{ name: 'kans_melden', args: { titel: 'YouTube cashcow-kanaal over verbouwen', wat: 'Een kanaal zonder gezicht dat kijkers naar raamwinkel stuurt.', waarom_nu: 'YouTube betaalt sinds oktober ook Shorts in het Nederlands beter uit.', bronnen: [{ url: 'https://blog.youtube.test/shorts-nl', datum: '2026-10-28' }], kosten: '€ 0 en 6 uur', risico: 'Massale AI-video’s kunnen tot een ban leiden.', minitest: '5 video’s in 10 dagen, meet kliks naar de site.' } }] },
      { toolCalls: [{ name: 'duty_report', args: { status: 'in_orde', samenvatting: '1 kans gemeld (kans 1), verder niets nieuws met een bron van de laatste 60 dagen' } }] },
      { text: 'Eén kans gemeld.' },
    );
    await env.at('2026-11-10T05:45:05Z');
    assert.match(JSON.stringify(env.t.requests[0].messages), /Vaste taak “Kansen zoeken”[\s\S]*openbare bronnen op internet/);
    assert.equal(env.runs(search.id)[0].status, 'no_update', 'no notification for the search itself');
    assert.equal((await env.t.api('GET', '/proactive/kansen')).kansen[0].status, 'nieuw');

    // No clock in between: the opportunity has no scorecard, that is work for the main bot, now.
    const before = env.t.requests.length;
    env.t.script.push({ toolCalls: [{ name: 'kans_scoren', args: { kans: 1, vraag: 4, past: 4, moeite: 3, kosten: 1, risico: 4, toelichting: 'Past bij de SEO-sites; pas op met massale AI-video’s.' } }] }, { text: 'Kans 1 gescoord: 16 punten.' });
    assert.equal(await env.workNow(), 1);
    assert.match(JSON.stringify(env.t.requests[before].messages), /Kansen om te scoren \(kans_scoren\):[\s\S]*kans 1 heeft nog geen scorekaart: YouTube cashcow-kanaal over verbouwen/);
    assert.equal((await env.t.api('GET', '/proactive/kansen')).kansen[0].status, 'gescoord');
    // Nothing new → the main bot is not woken at all, however long it takes.
    const calls = env.t.requests.length;
    assert.equal(await env.workNow(), 0);
    await env.at('2026-11-15T17:00:05Z');
    assert.equal(await env.workNow(), 0);
    assert.equal(env.t.requests.filter((r) => /Kansen om te scoren/.test(JSON.stringify(r.messages))).length, 2, 'the two calls of that one turn; no turn without work');
    void calls;
    assert.equal(env.duty(baas.id, 'kansen.scoren'), undefined, 'and no routine that runs to find that out');
  } finally {
    await env.t.close();
  }
});

test('the briefing: what was done, what changed (numbers), what waits; a quiet day stays quiet', async () => {
  assert.equal(isoWeek('2026-11-09'), '2026-W46');
  assert.equal(isoWeek('2026-11-15'), '2026-W46');
  assert.equal(isoWeek('2026-11-16'), '2026-W47');
  const env = await setup({ start: '2026-11-09T04:00:00Z' });
  try {
    const sem = await env.t.agent({ name: 'Sem', role: 'Technische SEO', tool_groups: ['team'] });
    const baas = await mainBot(env);
    await teamWithSite(env);
    await give(env, sem, ['seo.techniek', 'seo.posities']);
    const briefing = env.t.app.ctx.services.teams.briefing;
    briefing.clock = () => env.clock.now;
    const tick = async (isoUtc: string) => {
      await env.at(isoUtc);
      return briefing.tick();
    };
    const mainChat = () => env.t.app.ctx.store.messages(env.t.app.ctx.chat.threadForAgent(env.userId, baas.id).id);

    // Day 1, 08:00: everything is in order and nothing waits. The first briefing only says what the team needs.
    let out = await tick('2026-11-09T07:00:30Z');
    assert.match(out[0].text, /^\*\*Nodig van jou\*\*\n- Koppel Search Console/);
    assert.deepEqual(await tick('2026-11-09T10:00:00Z'), [], 'once a day');

    // Day 2: a quiet day (the checks found nothing, nothing waits) → no message at all.
    const n = mainChat().length;
    out = await tick('2026-11-10T07:00:30Z');
    assert.equal(out[0].quiet, true);
    assert.equal(mainChat().length, n);

    // Day 2, later: the site breaks; the check of day 3 finds it and Sem hands it to the owner.
    env.site.pages['https://raamwinkel.test'] = { body: page({ noindex: true }) };
    env.t.script.push({ toolCalls: [{ name: 'team_execute', args: { sql: "UPDATE taken SET status = 'wacht_op_eigenaar', resultaat = ? WHERE id = ?", params: ['De noindex staat in het thema.', '1'] } }] }, { text: 'Taak 1 wacht op de eigenaar.' });
    out = await tick('2026-11-11T07:00:30Z');
    assert.equal(out.length, 1);
    const text = out[0].text;
    assert.match(text, /\*\*Veranderd\*\*\n- 1 nieuw probleem gevonden: raamwinkel\.test: de startpagina staat op noindex\n- Websites: technische fouten en indexeerbaarheid: fouten 0 → 1/);
    assert.match(text, /\*\*Wacht op jou\*\*\n- 1 taak die op jou wacht/);
    assert.match(text, /_\d+ controles zonder AI in orde, 1 botbeurt proactief werk\._/);
    assert.equal(mainChat().at(-1)!.content, text);
    assert.equal(mainChat().at(-1)!.role, 'assistant');
    const note = env.notes().find((x) => x.title === 'Baas: overzicht' && /wacht op jou/.test(x.body));
    assert.ok(note, 'one notification, important because something waits');
    assert.equal(note.level, 'important');
    assert.equal((await env.t.api('GET', '/proactive/briefing')).text, text);

    // Day 4: repaired. The briefing says what was done, with the measured numbers.
    env.site.pages['https://raamwinkel.test'] = { body: page() };
    out = await tick('2026-11-12T07:00:30Z');
    assert.match(out[0].text, /\*\*Gedaan\*\*\n- raamwinkel\.test: de startpagina staat op noindex — Opgelost: de controle vindt het probleem niet meer\. \(Sem\)/);
    assert.match(out[0].text, /fouten 1 → 0/);
    assert.doesNotMatch(out[0].text, /Wacht op jou/);
    const before = env.t.requests.length;
    await tick('2026-11-12T07:05:00Z');
    assert.equal(env.t.requests.length, before, 'the briefing itself never calls a model');

    // Weekly instead of daily: nothing on Friday, the overview on Monday.
    await env.t.api('PUT', '/proactive/settings', { briefing: 'week' });
    env.site.pages['https://raamwinkel.test'] = { body: page({ title: '' }) };
    assert.deepEqual(await tick('2026-11-13T07:00:30Z'), []);
    out = await tick('2026-11-16T07:00:30Z');
    assert.match(out[0].text, /de startpagina heeft geen titel/);
  } finally {
    await env.t.close();
  }
});

test('two teams for two businesses: own duties, tasks, projects and opportunities, steered by the one main bot', async () => {
  const env = await setup({ start: '2026-11-09T04:00:00Z' });
  try {
    const sem = await env.t.agent({ name: 'Sem', role: 'Technische SEO', tool_groups: ['team'] });
    const [a] = await env.t.api('GET', '/teams');
    await env.t.api('PATCH', `/teams/${a.id}`, { name: 'Kozijnen', profile: { sites: ['raamwinkel.test'] } });
    const b = await env.t.api('POST', '/teams', { name: 'Fietsen', profile: { about: 'Webshop in fietsaccu’s. Website: https://accufix.test' } });
    const sam = await env.t.agent({ name: 'Sam', role: 'Technische SEO', tool_groups: ['team'], settings: { homeTeam: b.id } });
    const rik = await env.t.agent({ name: 'Rik', role: 'Researcher', tool_groups: ['team'], settings: { homeTeam: b.id } });
    const baas = await mainBot(env);
    Object.assign(env.site.pages, healthySite('https://accufix.test').pages);
    env.site.pages['https://accufix.test'] = { body: page({ noindex: true }) };
    const kansen = env.t.app.ctx.services.kansen;
    const projects = env.t.app.ctx.services.projects;
    kansen.clock = projects.clock = () => env.clock.now;
    await give(env, sem, ['seo.techniek']);
    await give(env, sam, ['seo.techniek']);

    // Each team's bot watches its own team's site (the second one found in the profile text), on the same morning.
    env.t.script.push({ text: 'Taak staat open.' });
    await env.at('2026-11-09T05:30:05Z');
    assert.match(env.runs(env.duty(sem.id, 'seo.techniek').id)[0].summary, /^In orde: 1 website/);
    assert.equal(env.runs(env.duty(sam.id, 'seo.techniek').id)[0].meta.duty.findings, 1);
    assert.deepEqual(await env.taken(a.id), [], 'team Kozijnen has no task');
    const tb = await env.taken(b.id);
    assert.equal(tb.length, 1);
    assert.equal(tb[0].eigenaar, 'Sam');
    const view = await env.t.api('GET', `/proactive/duties?teamId=${b.id}`);
    assert.deepEqual([...new Set(view.duties.map((d: any) => d.teamName))], ['Fietsen']);
    assert.ok(view.duties.every((d: any) => ['Sam', 'Rik'].includes(d.agentName)));

    // Projects: each team has its own sprint; a bot only sees its own team's.
    await env.t.api('PUT', '/proactive/settings', { maxSprint: 1 });
    assert.equal((await env.t.api('POST', '/proactive/projects', { teamId: a.id, naam: 'Raamwinkel tip-top', doel: 'x' })).project.status, 'sprint');
    assert.equal((await env.t.api('POST', '/proactive/projects', { teamId: b.id, naam: 'Accufix tip-top', doel: 'x' })).project.status, 'sprint', 'the other team has its own sprint');
    assert.equal((await env.t.api('POST', '/proactive/projects', { teamId: b.id, naam: 'Accufix feed', doel: 'x' })).project.status, 'wacht');
    const semSees = await tool(env, sem, 'project_list', {});
    assert.match(semSees, /Raamwinkel tip-top/);
    assert.doesNotMatch(semSees, /Accufix/, 'no way into the other team’s projects');
    assert.match(await tool(env, sem, 'project_stap', { project: 2, nulmeting: '1 (x, 9 nov)' }), /Project 2 bestaat niet in dit team/);
    assert.deepEqual((await env.t.api('GET', '/proactive/projects')).projects.map((p: any) => `${p.teamName}: ${p.naam}`).sort(), ['Fietsen: Accufix feed', 'Fietsen: Accufix tip-top', 'Kozijnen: Raamwinkel tip-top']);

    // Opportunities live in the researcher's team; the one main bot scores them there, by team name.
    const k = await kansen.report(env.userId, b.id, 'Rik', { titel: 'Accu-abonnement', wat: 'Accu’s in abonnement.', waarom_nu: 'Nieuwe regels vanaf 1 november.', bronnen: [{ url: 'https://rvo.test/accu', datum: '2026-11-01' }], kosten: '€ 0', risico: 'Laag', minitest: 'Landingspagina, 7 dagen.' });
    assert.equal(k.teamName, 'Fietsen');
    assert.deepEqual((await kansen.unscored(env.userId, baas)).map((x: any) => x.titel), ['Accu-abonnement']);
    assert.match(await tool(env, baas, 'kans_scoren', { kans: 1, team: 'Fietsen', vraag: 4, past: 4, moeite: 2, kosten: 1, risico: 1, toelichting: 'Past bij de accuwinkel.' }), /scoort 82\/100/);
    assert.match(await tool(env, sem, 'kansen_lijst', {}), /Het kansenbord is leeg/, 'a bot of the other team does not see it');
    assert.equal((await env.t.api('GET', `/proactive/kansen?team=${a.id}`)).kansen.length, 0);
    await kansen.propose(env.userId);
    const yes = await env.t.api('POST', '/proactive/kansen/1/decide', { choice: 'ja', teamId: b.id });
    assert.equal(yes.note, 'De mini-test staat klaar en begint zodra er plek is in de sprint.');
    assert.ok((await env.t.api('GET', `/proactive/projects?team=${b.id}`)).projects.some((p: any) => p.naam === 'Mini-test: Accu-abonnement' && p.status === 'wacht'));

    // One briefing from the one main bot, with the team named.
    const briefing = env.t.app.ctx.services.teams.briefing;
    briefing.clock = () => env.clock.now;
    await env.at('2026-11-09T07:00:30Z');
    await briefing.tick();
    env.site.pages['https://raamwinkel.test'] = { body: page({ title: '' }) };
    env.t.script.push({ text: 'Gezien.' });
    await env.at('2026-11-10T07:00:30Z');
    const [out] = await briefing.tick();
    assert.match(out.text, /- Kozijnen: 1 nieuw probleem gevonden: raamwinkel\.test: de startpagina heeft geen titel/);
    assert.doesNotMatch(out.text, /Fietsen: 1 nieuw probleem/, 'the known problem of the other team is not news');
  } finally {
    await env.t.close();
  }
});

function fakeChannel() {
  const state = { ctx: null as AdapterContext | null, sent: [] as { conv: string; out: Outbound }[] };
  const def: AdapterDef = {
    id: 'fake',
    label: 'Nep',
    description: 'test',
    needsPublicUrl: () => false,
    approveViaChannel: false,
    maxText: 1000,
    secretFields: [{ key: 'token', label: 'Token', required: true }],
    validate: (c) => ({ x: Number(c.x) || 1 }),
    test: async () => ({ ok: true, detail: 'ok', info: { botName: 'nepbot' } }),
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
        async sendTo(target, out) {
          state.sent.push({ conv: target, out });
          return { conversationId: target, title: target, private: true, ids: [`new${state.sent.length}`] };
        },
      };
    },
  };
  return { def, state };
}

test('private: the Privé team in one click, apart from the business; a reminder asked on the phone arrives on time', async () => {
  const env = await setup({ start: '2026-11-09T09:00:00Z' });
  try {
    const ctx = env.t.app.ctx;
    const sem = await env.t.agent({ name: 'Sem', role: 'Technische SEO', tool_groups: ['team'] });
    const [zaak] = await env.t.api('GET', '/teams');
    await ctx.services.teamdata.write(env.userId, [{ sql: "INSERT INTO taken (titel, eigenaar, status) VALUES ('Zakelijke taak', 'Sem', 'klaar')" }], zaak.id);

    // One click: no answers, no choices.
    const made = await env.t.api('POST', '/team-templates/prive/install', { provider_id: env.t.providerId, model: 'mock-1' });
    const teams = await env.t.api('GET', '/teams');
    const prive = teams.find((x: any) => x.id === made.teamId);
    assert.equal(prive.name, 'Privé');
    assert.deepEqual(prive.bots.map((b: any) => b.name).sort(), ['Assistent', 'Kasboek', 'Opzoeker']);
    const assistent = ctx.store.agent(prive.bots.find((b: any) => b.name === 'Assistent').id)!;
    assert.equal(assistent.access_mode, 'full', 'a bot of a TeamBot template works by itself (only paying still asks) …');
    // Private data stays apart: its own team database, and no access for the business bot (and the other way round).
    await ctx.services.teamdata.write(env.userId, [{ sql: "INSERT INTO taken (titel, eigenaar, status) VALUES ('Tandarts bellen', 'Assistent', 'klaar')" }], prive.id);
    assert.deepEqual((await env.taken(prive.id)).map((x) => x.titel), ['Tandarts bellen']);
    assert.deepEqual((await env.taken(zaak.id)).map((x) => x.titel), ['Zakelijke taak']);
    assert.equal(ctx.services.teams.canRead(sem.id, prive.id), false);
    assert.equal(ctx.services.teams.canRead(assistent.id, zaak.id), false);
    await env.at('2026-11-09T09:05:00Z');
    assert.deepEqual((await env.t.api('GET', `/proactive/duties?teamId=${prive.id}`)).duties, [], 'no bot of the new team got a routine by itself');
    // Asked for, the agenda check says what it needs.
    await give(env, assistent, ['agenda.vandaag']);
    assert.match((await env.t.api('GET', `/proactive/duties?teamId=${prive.id}`)).duties.find((d: any) => d.duty.key === 'agenda.vandaag').needs, /Koppel een agenda/);

    // The owner's phone: a chat app connected to the assistant, with himself as "Dit ben ik".
    const f = fakeChannel();
    ctx.services.channels.registerAdapter(f.def);
    const b = await env.t.api('POST', '/channels/bindings', { adapter: 'fake', name: 'Mijn Telegram', agent_id: assistent.id, config: {}, secrets: { token: 'fake-secret-token-123456' } });
    for (let i = 0; i < 150 && !(f.state.ctx && ctx.store.get<any>('channel_bindings', b.id)?.status === 'connected'); i++) await new Promise((r) => setTimeout(r, 20));
    await env.t.api('POST', `/channels/bindings/${b.id}/senders`, { external_id: 'me', label: 'Sanne', is_owner: true });

    // He asks on his phone; the assistant sets the reminder (no approval card: a reminder only tells the owner).
    env.t.script.push({ toolCalls: [{ name: 'reminder_set', args: { text: 'De tandarts bellen', at: '2026-11-09T15:00' } }] }, { text: 'Staat klaar: vandaag om 15:00.' });
    const r = await f.state.ctx!.receive({ messageId: 'm1', conversation: { id: 'mine', title: 'Sanne', private: true }, sender: { id: 'me', name: 'Sanne' }, text: 'Herinner me om 3 uur aan de tandarts bellen' } as any);
    await env.t.waitIdle(r.threadId!);
    // Every bot can set a reminder, also without the Routines tools; this one's instructions name reminder_set, so it is
    // in its list (tools/selection.ts `wanted`) instead of found on demand.
    assert.ok(env.t.requests.at(-1)!.tools.some((x: any) => x.name === 'reminder_set'));
    const toolMsg = ctx.store.messages(r.threadId!).find((m: any) => m.role === 'tool');
    assert.match(String(toolMsg!.content), /Herinnering gezet voor .*15:00.*: “De tandarts bellen”/);
    assert.equal(ctx.store.all("SELECT id FROM approvals WHERE status = 'pending'").length, 0);
    const rem = env.engine.routinesOf(env.userId, assistent.id).find((x) => x.options.reminder)!;
    assert.equal(rem.status, 'active');
    assert.equal(rem.next_run_at, '2026-11-09T14:00:00.000Z', '15:00 in Amsterdam');
    await new Promise((res) => setTimeout(res, 100));
    const sentBefore = f.state.sent.length;
    const modelCalls = env.t.requests.length;

    // 14:59: nothing yet. 15:00: it fires, without a model, and reaches him three ways.
    await env.at('2026-11-09T13:59:00Z');
    assert.equal(env.notes().filter((n) => n.title === 'Herinnering').length, 0);
    await env.at('2026-11-09T14:00:05Z');
    const rr = env.runs(rem.id)[0];
    assert.equal(rr.status, 'done');
    assert.equal(rr.summary, 'Herinnering: De tandarts bellen');
    assert.ok(Date.parse(rr.finished_at) - Date.parse('2026-11-09T14:00:00Z') < 60_000, 'within a minute of the time');
    assert.equal(env.t.requests.length, modelCalls, 'no model call: it cannot fail on a limit');
    const note = env.notes().find((n) => n.title === 'Herinnering');
    assert.equal(note.body, 'De tandarts bellen');
    assert.equal(note.level, 'important', 'alerts also when only important notifications do');
    // The notification centre has it (this is what the app, the desktop and the phone push read).
    const centre = await env.t.api('GET', '/notifications');
    const item = (centre.items || centre).find((x: any) => x.title === 'Herinnering');
    assert.equal(item.body, 'De tandarts bellen');
    assert.equal(item.important, true);
    // His chat app got it, in his own conversation.
    assert.equal(f.state.sent.length, sentBefore + 1);
    assert.deepEqual([f.state.sent.at(-1)!.conv, f.state.sent.at(-1)!.out.text], ['mine', 'Herinnering: De tandarts bellen']);
    assert.deepEqual(rr.meta.reminder.delivered, ['melding', 'chat', 'Mijn Telegram']);
    // And it is in the chat with the assistant.
    assert.equal(ctx.store.messages(ctx.chat.threadForAgent(env.userId, assistent.id).id).at(-1)!.content, 'Herinnering: De tandarts bellen');
    assert.equal(env.engine.routine(rem.id)!.status, 'completed', 'a one-off reminder is done');

    // A repeating one, and taking it away again.
    assert.match(await tool(env, sem, 'reminder_set', { text: 'Container buiten', days: ['do'], times: ['19:00'] }), /Herinnering gezet voor .*19:00/);
    assert.match(await tool(env, sem, 'reminder_cancel', {}), /- Container buiten · /);
    assert.match(await tool(env, sem, 'reminder_cancel', { text: 'container' }), /Herinnering weggehaald: “Container buiten”/);
    assert.match(await tool(env, sem, 'reminder_set', { text: 'Te laat', at: '2026-11-01T09:00' }), /Kon de herinnering niet zetten/);
  } finally {
    await env.t.close();
  }
});
