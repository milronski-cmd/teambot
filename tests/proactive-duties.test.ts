// Vaste taken (standing duties): a bot gets the duties of its role without the owner writing a routine; TeamBot
// measures first and wakes no model when everything is in order; a problem becomes one task with "klaar als" and the
// measurement, and is closed by the next measurement; proactive work stays inside one budget and on a free engine.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { give, setup, teamWithSite, page } from './proactive-helpers.js';
import { BUILTIN_KEYS, builtinDuty, cleanPresets, defaultDuties, rolesFor } from '../server/modules/routines/duties/catalog.js';
import { checkSites, robotsBlocksAll, pageFacts, sample } from '../server/modules/routines/duties/checks.js';
import { cleanProactive } from '../server/modules/routines/duties/types.js';

// These tests are about bots that are not the main bot: without this the first bot would be it (teams `autoMain`,
// covered in works-right-away.test.ts).
process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

test('no bot gets a duty by itself: the built-in presets are a library, only the owner’s own presets apply', () => {
  const keys = (role: string, name = 'Bot', presets?: any) => defaultDuties({ role, name, description: '' }, { presets }).map((d) => d.key);
  for (const role of ['Technische SEO', 'Merchant Center', 'Google Ads', 'Klantenservice', 'Researcher', 'Persoonlijke assistent', 'Content NL', 'Hoofdbot', '']) assert.deepEqual(keys(role), [], `nothing for “${role}”`);
  // The owner's own preset is his instruction: it applies to the bots it recognises.
  const own = cleanPresets([{ label: 'Advocatuur', words: ['advocaat'], duties: [{ key: 'adv.termijnen', title: 'Termijnen', check: 'Lopen er termijnen af?' }] }]);
  assert.deepEqual(keys('Advocaat arbeidsrecht', 'Eva', own), ['adv.termijnen']);
  assert.deepEqual(keys('Technische SEO', 'Sem', own), []);
  // The library is still there to pick from.
  assert.ok(BUILTIN_KEYS.has('seo.techniek') && BUILTIN_KEYS.has('werk.afmaken') && BUILTIN_KEYS.has('vaste-taken.bedenken'));
  assert.equal(builtinDuty('seo.techniek')!.title, 'Websites: technische fouten en indexeerbaarheid');
  assert.equal(builtinDuty('eigen'), null);
  // Words recognise a role; roles from the team templates must not be mistaken for a guard.
  assert.deepEqual(rolesFor({ role: 'Technische SEO', name: 'Sem', description: '' }).map((r) => r.id), ['seo']);
  assert.deepEqual(rolesFor({ role: 'zoekwoorden en concurrentie', name: 'Zoekwoordonderzoeker', description: '' }), []);
  assert.deepEqual(rolesFor({ role: 'test en meldt fouten', name: 'Tester', description: '' }), []);
});

test('the site check measures real numbers and names what is wrong', async () => {
  assert.equal(robotsBlocksAll('User-agent: *\nDisallow: /'), true);
  assert.equal(robotsBlocksAll('User-agent: *\nDisallow: /admin\n\nUser-agent: BadBot\nDisallow: /'), false);
  assert.deepEqual(pageFacts(page({ noindex: true, description: '' })), { title: 'Kozijnen vergelijken', description: '', noindex: true, canonical: '' });
  assert.equal(pageFacts('<title>x</title>', 'noindex').noindex, true, 'the X-Robots-Tag header counts too');
  assert.deepEqual(sample([1, 2, 3, 4, 5, 6, 7, 8], 4, 0), [1, 3, 5, 7]);
  assert.deepEqual(sample([1, 2, 3, 4, 5, 6, 7, 8], 4, 1), [2, 4, 6, 8], 'the next run looks at other pages');
  const pages: Record<string, { status: number; text: string }> = {
    'https://a.test': { status: 200, text: page({ noindex: true }) },
    'https://a.test/robots.txt': { status: 200, text: 'User-agent: *\nDisallow: /' },
    'https://a.test/sitemap.xml': { status: 200, text: '<urlset><url><loc>https://a.test/weg</loc></url></urlset>' },
  };
  const fetcher = async (url: string) => ({ url, contentType: 'text/html', ...(pages[url] || { status: 404, text: '' }) });
  const r = await checkSites(fetcher as any, ['https://a.test', 'https://b.test'], { depth: 'full', now: () => Date.parse('2026-11-09T06:30:00Z') });
  assert.deepEqual(r.findings.map((f) => f.key), ['a.test:noindex', 'a.test:robots', 'a.test:kapot', 'b.test:status']);
  assert.match(r.findings[2].evidence, /https:\/\/a\.test\/weg \(404\) \(gemeten 2026-11-09 06:30 UTC\)/);
  assert.match(r.findings[3].evidence, /status 404/);
  assert.equal(r.numbers.fouten, 4);
  assert.equal(r.numbers['a.test status'], 200);
  const up = await checkSites(fetcher as any, ['https://a.test'], { depth: 'uptime' });
  assert.deepEqual(up.findings, [], 'the uptime check only asks: does it answer');
});

test('an SEO bot given the website check: quiet when in order, one task with proof when not, closed by measuring; nothing was seeded', async () => {
  const env = await setup();
  try {
    const sem = await env.t.agent({ name: 'Sem', role: 'Technische SEO', tool_groups: ['team', 'files', 'web'] });
    await teamWithSite(env);
    await env.at('2026-11-09T04:01:00Z');
    assert.deepEqual(env.duties.duties(env.userId, sem.id), [], 'a new bot gets nothing by itself, whatever its role says');
    assert.equal(env.t.app.ctx.store.one<any>('SELECT COUNT(*) n FROM routines')!.n, 0);
    // The owner picks two checks for him.
    await give(env, sem, ['seo.techniek', 'seo.posities']);
    const names = env.duties.duties(env.userId, sem.id).map((r) => r.options.duty!.key);
    assert.deepEqual(names.sort(), ['seo.posities', 'seo.techniek']);
    const tech = env.duty(sem.id, 'seo.techniek');
    assert.equal(tech.status, 'active');
    assert.equal(tech.options.notify, 'errors');

    // 06:30 local: the check runs on schedule; everything is in order.
    await env.at('2026-11-09T05:30:05Z');
    let runs = env.runs(tech.id);
    assert.equal(runs.length, 1);
    assert.equal(runs[0].status, 'no_update');
    assert.match(runs[0].summary, /^In orde: 1 website, 3 pagina’s gecontroleerd\.$/);
    assert.equal(runs[0].meta.duty.numbers['raamwinkel.test status'], 200);
    assert.equal(env.t.requests.length, 0, 'no model was called');
    assert.equal(env.notes().length, 0, 'and nobody was told: nothing to tell');
    assert.deepEqual(await env.taken(), []);

    // A duty whose source is not connected has nothing to look at: it says what it needs and parks itself, so it is
    // not scheduled again for nothing.
    const pos = env.duty(sem.id, 'seo.posities');
    await env.at('2026-11-09T06:00:05Z'); // Monday 07:00
    assert.equal(env.runs(pos.id)[0].status, 'skipped');
    assert.match(env.runs(pos.id)[0].summary, /^Wacht: Koppel Search Console/);
    assert.equal(env.duty(sem.id, 'seo.posities').status, 'paused');
    assert.match(env.duty(sem.id, 'seo.posities').paused_reason, /^Wacht: Koppel Search Console/);
    assert.equal(env.duty(sem.id, 'seo.posities').next_run_at, null);
    assert.equal(env.t.requests.length, 0);
    assert.equal(env.notes().length, 0);

    // Someone breaks the site: the start page goes to noindex and a page from the sitemap disappears.
    env.site.pages['https://raamwinkel.test'] = { body: page({ noindex: true }) };
    delete env.site.pages['https://raamwinkel.test/prijzen'];
    env.t.script.push({ text: 'De noindex staat in het thema; dat kan ik niet zelf aanpassen. De taken staan op het bord.' });
    await env.at('2026-11-10T05:30:05Z');
    let taken = await env.taken();
    assert.equal(taken.length, 2);
    assert.equal(taken[0].titel, 'raamwinkel.test: de startpagina staat op noindex');
    assert.equal(taken[0].eigenaar, 'Sem');
    assert.equal(taken[0].status, 'open');
    assert.equal(taken[0].site, 'raamwinkel.test');
    assert.equal(taken[0].klaar_als, 'de startpagina van raamwinkel.test heeft geen noindex meer');
    assert.match(taken[0].beschrijving, /“noindex” in de robots-meta .* \(gemeten 2026-11-10 05:30 UTC\)/);
    assert.equal(taken[0].aangevraagd_door, 'Vaste taak: Websites: technische fouten en indexeerbaarheid');
    assert.match(taken[1].titel, /1 pagina uit de sitemap geeft een fout/);
    assert.match(taken[1].beschrijving, /https:\/\/raamwinkel\.test\/prijzen \(404\)/);
    const found = env.notes().filter((n) => /probleem|problemen/.test(n.title));
    assert.equal(found.length, 1, 'one notification for the new problems');
    assert.equal(found[0].title, 'Sem: 2 problemen gevonden');
    assert.equal(found[0].level, 'warn');
    assert.equal(found[0].link, '#/tasks');
    // The bot is woken once, with what TeamBot measured and the tasks it made.
    assert.equal(env.t.requests.length, 1);
    const asked = JSON.stringify(env.t.requests[0].messages);
    assert.match(asked, /TeamBot heeft dit zelf gemeten/);
    assert.match(asked, /taak 1: raamwinkel\.test: de startpagina staat op noindex/);
    runs = env.runs(tech.id);
    assert.equal(runs[1].status, 'done');
    assert.equal(runs[1].meta.duty.model, 1);
    assert.equal(env.duties.budget(env.userId).used, 1);

    // The work loop: the two tasks are on his name, so he gets a turn for them (no clock in between). He cannot fix
    // them and hands them to the owner.
    env.t.script.push({ toolCalls: [{ name: 'team_execute', args: { sql: "UPDATE taken SET status = 'wacht_op_eigenaar', resultaat = ? WHERE id IN (?, ?)", params: ['De noindex staat in het thema: de bouwer of de eigenaar moet dit aanpassen.', '1', '2'] } }] }, { text: 'Beide taken wachten op de eigenaar.' });
    assert.equal(await env.workNow(), 1);
    assert.match(JSON.stringify(env.t.requests[1].messages), /Op jouw naam:[\s\S]*taak 1 \(teamdatabase, tabel taken, open\): raamwinkel\.test: de startpagina staat op noindex[\s\S]*taak 2 /);
    assert.equal(await env.workNow(), 0, 'nothing open on his name any more: no turn at all');
    assert.deepEqual((await env.taken()).map((x) => x.status), ['wacht_op_eigenaar', 'wacht_op_eigenaar']);
    const calls = env.t.requests.length;

    // The next day the problem is still there: no second task, no notification, no model.
    const notesBefore = env.notes().length;
    await env.at('2026-11-11T05:30:05Z');
    assert.equal((await env.taken()).length, 2, 'never a second task for the same open problem');
    assert.equal(env.notes().length, notesBefore);
    assert.equal(env.t.requests.length, calls, 'nothing new: no bot is woken');
    assert.match(env.runs(tech.id)[2].summary, /^Nog open: 2 problemen/);
    assert.equal(env.runs(tech.id)[2].status, 'no_update');

    // The site is repaired (by a bot or by hand): the next measurement closes the tasks, with that measurement as proof.
    env.site.pages['https://raamwinkel.test'] = { body: page() };
    env.site.pages['https://raamwinkel.test/prijzen'] = { body: page({ title: 'Prijzen' }) };
    await env.at('2026-11-12T05:30:05Z');
    taken = await env.taken();
    assert.deepEqual(taken.map((x) => x.status), ['klaar', 'klaar']);
    assert.equal(taken[0].resultaat, 'Opgelost: de controle vindt het probleem niet meer.');
    assert.match(taken[0].bewijs, /Controle “Websites: technische fouten en indexeerbaarheid” van 2026-11-12 05:30 UTC: 1 website, 3 pagina’s gecontroleerd, dit probleem niet meer gevonden\./);
    assert.match(env.runs(tech.id)[3].summary, /In orde: .* 2 taken afgesloten/);
    assert.equal(env.t.requests.length, calls, 'closing costs no model call either');

    // A bot says "klaar" while the problem is still there: TeamBot measures again itself, right then. Not gone → the
    // task goes back to open with what is still wrong, and the bot is told. Gone → klaar, with the measurement as proof.
    env.site.pages['https://raamwinkel.test'] = { body: page({ noindex: true }) };
    env.t.script.push({ toolCalls: [{ name: 'team_execute', args: { sql: "UPDATE taken SET status = 'klaar', resultaat = 'Noindex verwijderd', bewijs = 'gedaan' WHERE id = ?", params: ['3'] } }] }, { text: 'Opgelost: de noindex is weg.' });
    await env.at('2026-11-13T05:30:05Z');
    taken = await env.taken();
    assert.equal(taken[2].status, 'open', 'the bot’s word is not enough');
    assert.match(taken[2].resultaat, /^Niet klaar: TeamBot mat opnieuw en het probleem is er nog\. https:\/\/raamwinkel\.test heeft “noindex”/);
    const told = env.t.app.ctx.store.all<any>("SELECT content FROM messages WHERE role = 'tool' AND content LIKE '%is NIET klaar en staat weer op open%'");
    assert.equal(told.length, 1, 'and the bot hears what is still wrong');
    env.site.pages['https://raamwinkel.test'] = { body: page() };
    env.t.script.push({ toolCalls: [{ name: 'team_execute', args: { sql: "UPDATE taken SET status = 'klaar', resultaat = 'Noindex verwijderd in het thema' WHERE id = ?", params: ['3'] } }] }, { text: 'Nu echt opgelost.' });
    await env.at('2026-11-13T08:30:05Z');
    assert.equal(await env.workNow(), 1, 'the task is open on his name again: the work loop gives him a turn');
    taken = await env.taken();
    assert.equal(taken[2].status, 'klaar');
    assert.match(taken[2].bewijs, /TeamBot mat opnieuw op 2026-11-13 08:30 UTC: 1 website, 3 pagina’s gecontroleerd, dit probleem niet meer gevonden\./);

    await env.at('2026-11-14T05:30:05Z');

    // The owner sees every duty with what it last found.
    const view = await env.t.api('GET', '/proactive/duties');
    const row = view.duties.find((d: any) => d.duty.key === 'seo.techniek');
    assert.equal(row.agentName, 'Sem');
    assert.equal(row.needs, null);
    assert.match(row.last.summary, /^In orde/);
    assert.match(view.duties.find((d: any) => d.duty.key === 'seo.posities').needs, /Koppel Search Console/);
    assert.deepEqual(view.budget, { limit: 0, used: 0, left: null }, 'no limit by default; a day of watching one healthy site used no bot turn');
  } finally {
    await env.t.close();
  }
});

test('no cap by default: the bot’s own model, any frequency; a limit and "gratis eerst" only when the owner sets them', async () => {
  const env = await setup({ free: true });
  try {
    assert.deepEqual(cleanProactive({}), { runsPerDay: 0, cheapFirst: false, maxSprint: 0, briefing: 'uit', interests: '' }, 'no limit (also none on projects in the sprint), no engine rule, and no overview that nobody asked for');
    const sem = await env.t.agent({ name: 'Sem', role: 'SEO', tool_groups: ['team'] });
    await teamWithSite(env);
    await give(env, sem, ['seo.techniek']);
    await env.at('2026-11-09T04:01:00Z');
    const tech = env.duty(sem.id, 'seo.techniek');
    assert.equal(tech.options.maxRunsPerDay, 0, 'a duty has no run limit of its own');
    assert.deepEqual((await env.t.api('GET', '/proactive/settings')).budget, { limit: 0, used: 0, left: null });

    // A problem: the bot is woken on its own engine, like any other work (a free engine exists, and is not forced).
    env.site.pages['https://raamwinkel.test'] = { body: page({ title: '' }) };
    env.t.script.push({ text: 'Titel ontbreekt; taak staat open voor de bouwer.' });
    await env.at('2026-11-09T05:30:05Z');
    assert.equal(env.t.requests.length, 1, 'the bot’s own engine did the work');
    assert.equal(env.free!.requests.length, 0);
    let rr = env.runs(tech.id)[0];
    assert.equal(rr.meta.duty.override, undefined);
    assert.notEqual(JSON.parse(env.t.app.ctx.store.one<any>('SELECT meta FROM runs WHERE id = ?', rr.run_id).meta).frugal, true);

    // Any frequency the owner wants, down to a minute: the app does not refuse, and a hundred checks in order are free.
    env.site.pages['https://raamwinkel.test'] = { body: page() };
    const upd = await env.t.api('PATCH', `/routines/${tech.id}`, { schedule: { kind: 'interval', everyMinutes: 1 } });
    assert.equal(upd.schedule.everyMinutes, 1);
    const before = env.runs(tech.id).length;
    await env.at('2026-11-09T07:15:00Z');
    const minute = env.runs(tech.id).slice(before);
    assert.ok(minute.length >= 100, `${minute.length} runs in 100 minutes`);
    assert.ok(minute.every((x: any) => x.status === 'no_update'), 'none limited, none skipped');
    assert.equal(env.t.requests.filter((r) => /Vaste taak “Websites/.test(JSON.stringify(r.messages))).length, 1, 'and no model call for any of them');
    // Every problem wakes the bot, however often: nothing counts down.
    for (const [i, o] of [{ title: '' }, { description: '' }, { noindex: true }].entries()) {
      env.site.pages['https://raamwinkel.test'] = { body: page(o) };
      env.t.script.push({ text: `Gezien ${i}.` });
      await env.at(new Date(env.clock.now + 60_000).toISOString());
      env.site.pages['https://raamwinkel.test'] = { body: page() };
      await env.at(new Date(env.clock.now + 60_000).toISOString());
    }
    assert.equal(env.runs(tech.id).filter((x: any) => x.meta?.duty?.model === 1).length, 4);
    assert.equal(env.runs(tech.id).filter((x: any) => x.status === 'limited').length, 0);
    assert.equal(env.duties.budget(env.userId).used, 4);
    await env.t.api('PATCH', `/routines/${tech.id}`, { schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['06:30'] } });

    // The optional limit: 5 bot turns a day, 4 are used. One more wake, then proactive work waits, quietly.
    await env.t.api('PUT', '/proactive/settings', { runsPerDay: 5 });
    assert.deepEqual(env.duties.budget(env.userId), { limit: 5, used: 4, left: 1 });
    await env.t.app.ctx.services.teamdata.write(env.userId, [{ sql: "INSERT INTO taken (titel, eigenaar, status) VALUES ('Sitemap nalopen', 'Sem', 'open')" }]);
    env.t.script.push({ toolCalls: [{ name: 'team_execute', args: { sql: "UPDATE taken SET status = 'klaar', resultaat = 'Nagelopen', bewijs = 'sitemap.xml: 3 adressen, alle 200' WHERE titel = 'Sitemap nalopen'" } }] }, { text: 'Sitemap nagelopen.' });
    assert.equal(await env.workNow(), 1, 'the fifth turn: his open task');
    assert.deepEqual(env.duties.budget(env.userId), { limit: 5, used: 5, left: 0 }, 'a work turn counts for the owner’s own limit');
    await env.t.app.ctx.services.teamdata.write(env.userId, [{ sql: "INSERT INTO taken (titel, eigenaar, status) VALUES ('Robots nalopen', 'Sem', 'open')" }]);
    const notes = env.notes().length;
    const calls = env.t.requests.length;
    assert.equal(await env.workNow(), 0, 'over the limit he set: no turn');
    assert.equal(env.t.requests.length, calls, 'no model call over the limit');
    assert.equal(env.notes().length, notes, 'and no noise about it');
    assert.match((await env.t.api('GET', '/proactive/work')).work.find((w: any) => w.agentName === 'Sem').waits, /je limiet voor proactief werk is voor vandaag bereikt \(5 van 5 botbeurten\)/);
    await env.t.app.ctx.services.teamdata.write(env.userId, [{ sql: "UPDATE taken SET status = 'geannuleerd' WHERE titel = 'Robots nalopen'" }]);
    await env.t.api('PUT', '/proactive/settings', { runsPerDay: 0 });

    // The optional "gratis eerst": the free engine, and the run never moves on to a paid one.
    await env.t.api('PUT', '/proactive/settings', { cheapFirst: true });
    env.site.pages['https://raamwinkel.test'] = { body: page({ noindex: true }) };
    env.free!.script.push({ text: 'Gezien.' });
    await env.at('2026-11-10T05:30:05Z');
    assert.equal(env.free!.requests.length, 1, 'the free engine did the work');
    rr = env.runs(tech.id).at(-1);
    assert.equal(rr.meta.duty.override.provider_id, env.free!.id);
    assert.equal(JSON.parse(env.t.app.ctx.store.one<any>('SELECT meta FROM runs WHERE id = ?', rr.run_id).meta).frugal, true);
  } finally {
    await env.t.close();
  }
});

test('a duty on a connected source ends with duty_report: in orde is silent, a problem needs proof and becomes one task', async () => {
  const env = await setup();
  try {
    const mia = await env.t.agent({ name: 'Mia', role: 'Persoonlijke assistent', tool_groups: ['team'] });
    await env.at('2026-11-09T04:01:00Z');
    // The owner writes a duty of his own on the team's data (no app needed).
    const made = await env.t.api('POST', '/proactive/duties', { agentId: mia.id, title: 'Openstaande facturen', check: 'Welke facturen in de tabel facturen zijn langer dan 30 dagen open?', source: 'team', okWhen: 'geen factuur is langer dan 30 dagen open', onProblem: 'task', days: [1, 2, 3, 4, 5], times: ['08:00'] });
    assert.equal(made.options.duty.key, 'eigen');

    // In orde: silent.
    env.t.script.push({ toolCalls: [{ name: 'duty_report', args: { status: 'in_orde', samenvatting: '0 facturen ouder dan 30 dagen (tabel facturen, 9 nov)' } }] }, { text: 'In orde.' });
    await env.at('2026-11-09T07:00:05Z');
    let rr = env.runs(made.id)[0];
    assert.equal(rr.status, 'no_update');
    assert.equal(rr.summary, 'In orde: 0 facturen ouder dan 30 dagen (tabel facturen, 9 nov)');
    assert.equal(env.notes().length, 0);
    const sys = JSON.stringify(env.t.requests[0].messages);
    assert.match(sys, /Vaste taak “Openstaande facturen”/);
    assert.match(sys, /In orde als: geen factuur is langer dan 30 dagen open/);
    assert.ok(env.t.requests[0].tools?.some((x: any) => x.name === 'duty_report'), 'the report tool is offered in a duty run');

    // A problem without a number or source is refused; with proof it becomes a task.
    env.t.script.push(
      { toolCalls: [{ name: 'duty_report', args: { status: 'probleem', punten: [{ titel: 'Factuur Jansen te laat', bewijs: 'staat al lang open', klaar_als: 'factuur betaald' }] } }] },
      { toolCalls: [{ name: 'duty_report', args: { status: 'probleem', punten: [{ titel: 'Factuur Jansen te laat', bewijs: 'Factuur 2026-014 van € 420 staat 41 dagen open (tabel facturen, 10 nov)', klaar_als: 'factuur 2026-014 staat op betaald', sleutel: 'factuur-2026-014' }] } }] },
      { text: 'Factuur 2026-014 staat 41 dagen open; taak gemaakt.' },
    );
    await env.at('2026-11-10T07:00:05Z');
    rr = env.runs(made.id)[1];
    assert.equal(rr.status, 'done');
    const refused = env.t.app.ctx.store.all<any>("SELECT content FROM messages WHERE role = 'tool' AND content LIKE '%ontbreekt het bewijs%'");
    assert.equal(refused.length, 1, 'no number, no source: TeamBot puts nothing on the board');
    let taken = await env.taken();
    assert.equal(taken.length, 1);
    assert.equal(taken[0].titel, 'Factuur Jansen te laat');
    assert.equal(taken[0].klaar_als, 'factuur 2026-014 staat op betaald');
    assert.match(taken[0].beschrijving, /€ 420 staat 41 dagen open/);
    assert.equal(env.notes().filter((n) => n.title === 'Mia: probleem gevonden').length, 1);

    // The task is on her name: the work loop gives her a turn. She cannot do it and says so honestly.
    env.t.script.push({ toolCalls: [{ name: 'team_execute', args: { sql: "UPDATE taken SET status = 'wacht_op_eigenaar', resultaat = ? WHERE id = ?", params: ['Klant reageert niet; de eigenaar moet bellen.', '1'] } }] }, { text: 'Taak 1 wacht op de eigenaar: de klant reageert niet.' });
    assert.equal(await env.workNow(), 1);
    assert.match(JSON.stringify(env.t.requests.at(-2)!.messages), /taak 1 \(teamdatabase, tabel taken, open\): Factuur Jansen te laat/);
    assert.equal((await env.taken())[0].status, 'wacht_op_eigenaar');
    // Nothing open for her any more: no turn is started, and there is no routine that runs to find that out.
    const calls = env.t.requests.length;
    assert.equal(await env.workNow(), 0);
    assert.equal(env.t.requests.length, calls);
    assert.deepEqual(env.duties.duties(env.userId, mia.id).map((r) => r.name), ['Openstaande facturen'], 'only the duty the owner wrote');

    // The same problem the next day: the same task.
    await env.at('2026-11-11T06:59:00Z');
    env.t.script.push({ toolCalls: [{ name: 'duty_report', args: { status: 'probleem', punten: [{ titel: 'Factuur Jansen nog steeds te laat', bewijs: 'Factuur 2026-014 staat 42 dagen open (tabel facturen, 11 nov)', klaar_als: 'factuur 2026-014 staat op betaald', sleutel: 'factuur-2026-014' }] } }] }, { text: 'Nog open.' });
    await env.at('2026-11-11T07:00:05Z');
    taken = await env.taken();
    assert.equal(taken.length, 1, 'no second task');
    assert.equal(env.notes().filter((n) => /probleem gevonden/.test(n.title)).length, 1, 'and no second notification');
  } finally {
    await env.t.close();
  }
});
