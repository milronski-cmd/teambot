// Vaste taken are a general mechanism: a role nobody foresaw proposes its own duties, the owner adds presets like the
// built-in ones, a duty is made by asking a bot in chat, and TeamBot's own measurement is a general check (an address,
// a number from a connected app's tool, a number from the team database). And the Google duties use the built-in
// Google server's real tools (against the local stand-in for Google).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { give, setup } from './proactive-helpers.js';
import { wordMatch, cleanPresets, rolesFor } from '../server/modules/routines/duties/catalog.js';
import { pick, compare } from '../server/modules/routines/duties/checks.js';
import { cleanMeasure } from '../server/modules/routines/duties/service.js';
import { GOOGLE_SERVICES } from '../server/modules/mcp/google.js';

// These tests are about bots that are not the main bot: without this the first bot would be it (teams `autoMain`,
// covered in works-right-away.test.ts).
process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

test('presets are data: words recognise a bot; measurements are general building blocks', () => {
  assert.equal(wordMatch('Technische SEO', 'seo'), true);
  assert.equal(wordMatch('Zoekwoordonderzoeker', 'zoek'), false, 'whole words');
  assert.equal(wordMatch('Advertentieschrijver', 'advertent*'), true, 'a * means: begins with');
  assert.equal(wordMatch('research naar zoekgedrag', 'sea'), false);
  const [p] = cleanPresets([{ label: 'Advocatuur', words: 'advocaat, jurist*', duties: [{ title: 'Termijnen bewaken', check: 'Welke termijnen verlopen binnen 7 dagen?', okWhen: 'geen termijn verloopt binnen 7 dagen', onProblem: 'ask', measure: { kind: 'query', sql: 'SELECT COUNT(*) FROM termijnen', op: '=', value: 0 } }] }, { label: 'Leeg' }]);
  assert.equal(p.id, 'advocatuur');
  assert.deepEqual(rolesFor({ role: 'Juriste arbeidsrecht', name: 'Eva', description: '' }, [p]).map((x) => x.id), ['advocatuur']);
  assert.deepEqual(cleanMeasure({ kind: 'url', url: 'https://x.test/a', contains: 'ok' }), { kind: 'url', url: 'https://x.test/a', contains: 'ok' });
  assert.equal(cleanMeasure({ kind: 'query', sql: 'DELETE FROM taken', op: '=', value: 0 }), null, 'a measurement only reads');
  assert.equal(cleanMeasure({ kind: 'tool', tool: 'x', op: '~', value: 1 }), null);
  assert.equal(pick({ rows: [{ clicks: 12 }] }, 'rows[0].clicks'), 12);
  assert.equal(pick({ products: [1, 2, 3] }, 'products.length'), 3);
  assert.equal(pick([1, 2], ''), 2);
  assert.equal(compare(3, '<=', 3), true);
});

test('any role: nothing by itself; asked in chat the bot sets its duties, TeamBot measures them, and the owner’s own preset applies', async () => {
  const env = await setup({ start: '2026-11-09T07:00:00Z' });
  try {
    const eva = await env.t.agent({ name: 'Eva', role: 'Advocaat arbeidsrecht', description: 'Houdt dossiers en termijnen van het kantoor bij.', tool_groups: ['team'] });
    env.site.pages['https://rechtspraak.test/uitspraken'] = { body: '<html><title>Uitspraken</title>Nieuwe uitspraken arbeidsrecht</html>' };
    await env.t.app.ctx.services.teamdata.run(env.userId, { type: 'system', id: null, name: 'TeamBot' } as any, 'CREATE TABLE termijnen (id INTEGER PRIMARY KEY, zaak TEXT, verloopt TEXT, gehaald INTEGER DEFAULT 0)', [], 'execute');

    // No bot gets a duty by itself, whatever its role: nothing is made, and no model is asked to think something up.
    await env.at('2026-11-09T07:03:00Z');
    assert.deepEqual(env.duties.duties(env.userId, eva.id), [], 'nothing was seeded');
    assert.equal(env.t.requests.length, 0, 'and no run "Vaste taken bedenken"');
    // The owner asks for it in a conversation: then the bot sets them (measured by TeamBot where it can).
    const evaChat = await env.t.api('POST', '/threads', { agentId: eva.id });
    env.t.script.push(
      { toolCalls: [{ name: 'duty_set', args: { title: 'Open termijnen', check: 'Staan er termijnen open die niet gehaald zijn?', ok_when: 'geen open termijn', on_problem: 'ask', every_minutes: 30, measure: { kind: 'query', sql: 'SELECT COUNT(*) FROM termijnen WHERE gehaald = 0', op: '=', value: 0 } } }] },
      { toolCalls: [{ name: 'duty_set', args: { title: 'Rechtspraak bereikbaar', check: 'Is de uitsprakenpagina bereikbaar en gaat hij over arbeidsrecht?', ok_when: 'de pagina antwoordt en noemt arbeidsrecht', on_problem: 'task', times: ['08:30'], measure: { kind: 'url', url: 'https://rechtspraak.test/uitspraken', contains: 'arbeidsrecht' } } }] },
      { text: 'Ingesteld.' },
    );
    await env.t.say(evaChat.id, 'Houd de open termijnen en de uitsprakenpagina voor me in de gaten.');
    const mine = () => env.duties.duties(env.userId, eva.id);
    assert.deepEqual(mine().map((r) => r.name).sort(), ['Open termijnen', 'Rechtspraak bereikbaar']);
    const termijnen = mine().find((r) => r.name === 'Open termijnen')!;
    assert.deepEqual(termijnen.schedule.kind, 'interval');
    assert.ok(env.notes().some((n) => n.title === 'Eva heeft een vaste taak ingesteld' && /Open termijnen/.test(n.body)), 'the owner hears what was set up');

    // They run by themselves and TeamBot measures: in order costs no model call.
    const calls = env.t.requests.length;
    await env.at('2026-11-09T07:40:00Z');
    const quiet = env.runs(termijnen.id).at(-1);
    assert.equal(quiet.status, 'no_update');
    assert.equal(quiet.summary, 'In orde: 0 uit de teamdatabase (in orde als = 0).');
    const site = mine().find((r) => r.name === 'Rechtspraak bereikbaar')!;
    assert.match(env.runs(site.id).at(-1).summary, /^In orde: https:\/\/rechtspraak\.test\/uitspraken: status 200 in \d+ ms\.$/);
    assert.equal(env.t.requests.length, calls);

    // A number over its threshold, and a page that no longer says what it should: a decision for the owner, a task.
    await env.t.app.ctx.services.teamdata.write(env.userId, [{ sql: "INSERT INTO termijnen (zaak, verloopt) VALUES ('Jansen / Bakkerij', '2026-11-12')" }]);
    env.site.pages['https://rechtspraak.test/uitspraken'] = { body: '<html>Onderhoud</html>' };
    await env.at('2026-11-10T07:30:05Z');
    const taken = await env.taken();
    assert.deepEqual(taken.map((x) => x.titel).sort(), ['Open termijnen: niet in orde', 'Rechtspraak bereikbaar: niet in orde']);
    assert.match(taken.find((x) => x.titel.startsWith('Open termijnen'))!.beschrijving, /de teamdatabase geeft 1; in orde is = 0 \(gemeten /);
    assert.match(taken.find((x) => x.titel.startsWith('Rechtspraak'))!.beschrijving, /Op https:\/\/rechtspraak\.test\/uitspraken staat “arbeidsrecht” niet/);
    const dec = await env.t.api('GET', '/teamdata/decisions?status=open');
    assert.ok((dec.decisions || dec).some((d: any) => /Open termijnen: niet in orde/.test(d.vraag)), 'on_problem "ask" puts it in Wacht op jou');
    // Solved → the next measurement closes the task.
    await env.t.app.ctx.services.teamdata.write(env.userId, [{ sql: 'UPDATE termijnen SET gehaald = 1' }]);
    await env.at('2026-11-10T08:05:00Z');
    assert.equal((await env.taken()).find((x) => x.titel.startsWith('Open termijnen'))!.status, 'klaar');

    // The owner's own preset is his instruction: a bot it recognises gets its duties (a built-in one never applies by itself).
    const put = await env.t.api('PUT', '/proactive/presets', { presets: [{ label: 'YouTube-kanaal', words: ['youtube', 'videomaker'], duties: [{ title: 'Uploadritme', check: 'Is er deze week een video geplaatst?', okWhen: 'minstens 1 video in de laatste 7 dagen', onProblem: 'task', days: [1], times: ['09:00'] }] }] });
    assert.ok(put.presets.some((x: any) => x.id === 'youtube-kanaal') && put.presets.some((x: any) => x.id === 'seo'), 'next to the built-in ones');
    const yt = await env.t.agent({ name: 'Vic', role: 'Videomaker', tool_groups: ['team'] });
    await env.at('2026-11-10T08:07:00Z');
    assert.deepEqual(env.duties.duties(env.userId, yt.id).map((r) => r.options.duty!.key).sort(), ['youtube-kanaal.uploadritme']);

    // And simply by asking a bot in chat.
    const th = await env.t.api('POST', '/threads', { agentId: yt.id });
    env.t.script.push({ toolCalls: [{ name: 'duty_set', args: { title: 'Reacties nalopen', check: 'Zijn er reacties onder de video’s zonder antwoord?', ok_when: 'geen reactie ouder dan een dag zonder antwoord', on_problem: 'fix', times: ['08:00'] } }] }, { text: 'Doe ik, elke ochtend om 8 uur.' });
    await env.t.say(th.id, 'Houd elke ochtend de reacties onder mijn video’s in de gaten.');
    const made = env.duties.duties(env.userId, yt.id).find((r) => r.name === 'Reacties nalopen')!;
    assert.equal(made.status, 'active');
    assert.deepEqual((made.schedule as any).times, ['08:00']);
    assert.match(await (async () => { env.t.script.push({ toolCalls: [{ name: 'duty_remove', args: { title: 'reacties' } }] }, { text: 'Weg.' }); const m = await env.t.say(th.id, 'Laat maar.'); return String(m.filter((x: any) => x.role === 'tool').at(-1)!.content); })(), /Vaste taak weggehaald: “Reacties nalopen”/);
  } finally {
    await env.t.close();
  }
});

// ---------------------------------------------------------------- Google: the built-in server's real tools

async function fakeGoogle() {
  const seen: string[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      const p = new URL(req.url || '/', 'http://x').pathname;
      seen.push(p);
      const json = (code: number, v: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
      if (p === '/oauth2.googleapis.com/token') {
        const id = Buffer.from(JSON.stringify({ email: 'eigenaar@voorbeeld.nl' })).toString('base64url');
        return json(200, { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 3600, scope: ['openid', 'email', ...GOOGLE_SERVICES.flatMap((x) => x.scopes)].join(' '), id_token: `x.${id}.y` });
      }
      if (p === '/www.googleapis.com/webmasters/v3/sites') return json(200, { siteEntry: [{ siteUrl: 'sc-domain:raamwinkel.test', permissionLevel: 'siteOwner' }] });
      if (p.endsWith('/searchAnalytics/query')) return json(200, { rows: [{ keys: ['kozijnen vergelijken'], clicks: 41, impressions: 1900, ctr: 0.021, position: 11.4 }] });
      if (p.includes('/sitemaps')) return json(200, { sitemap: [{ path: 'https://raamwinkel.test/sitemap.xml', errors: '2', warnings: '0', lastDownloaded: '2026-11-08T05:00:00Z' }] });
      if (p.endsWith('/developerRegistration:registerGcp')) return json(200, {});
      if (p === '/merchantapi.googleapis.com/products/v1/accounts/555/products')
        return json(200, { products: [{ offerId: 'kozijn-1', productStatus: { destinationStatuses: [{ reportingContext: 'SHOPPING_ADS', disapprovedCountries: ['NL'] }], itemLevelIssues: [{ code: 'missing_gtin', description: 'Ontbrekende GTIN' }] } }, { offerId: 'kozijn-2' }] });
      if (p.startsWith('/www.googleapis.com/calendar/v3/')) return json(200, { items: [{ id: 'ev1', summary: 'Tandarts', start: { dateTime: '2026-11-10T15:00:00+01:00' }, end: { dateTime: '2026-11-10T15:30:00+01:00' }, location: 'Dorpsstraat 1' }] });
      json(404, { error: { code: 404, message: `geen nep-antwoord voor ${p}` } });
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen, close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('Google connected: the duties name and use the built-in Google tools (Search Console, Merchant Center, Agenda)', async () => {
  const g = await fakeGoogle();
  process.env.TEAMBOT_GOOGLE_BASE = g.base;
  const env = await setup({ start: '2026-11-09T04:00:00Z' });
  try {
    const sem = await env.t.agent({ name: 'Sem', role: 'Technische SEO', tool_groups: ['team', 'mcp'] });
    const mo = await env.t.agent({ name: 'Mo', role: 'Merchant Center', tool_groups: ['team', 'mcp'] });
    const ans = await env.t.agent({ name: 'Ans', role: 'Persoonlijke assistent', tool_groups: ['team', 'mcp'] });
    await give(env, sem, ['seo.posities', 'seo.indexering']);
    await give(env, mo, ['merchant.afkeuringen', 'merchant.feed']);
    await give(env, ans, ['agenda.vandaag']);
    await env.at('2026-11-09T04:01:00Z');
    assert.match((await env.t.api('GET', '/proactive/duties')).duties.find((d: any) => d.duty.key === 'seo.posities').needs, /Koppel Search Console/);

    // One Google login (the module's own flow, against the stand-in).
    await env.t.api('PUT', '/mcp/google/client', { json: JSON.stringify({ installed: { client_id: '123456-abc.apps.googleusercontent.com', client_secret: 'secret-x' } }) });
    const a = new URL((await env.t.api('POST', '/mcp/google/start', {})).authorizationUrl);
    assert.equal((await fetch(`${a.searchParams.get('redirect_uri')}?code=code-123&state=${a.searchParams.get('state')}`)).status, 200);
    const view = (await env.t.api('GET', '/proactive/duties')).duties;
    for (const key of ['seo.posities', 'seo.indexering', 'merchant.afkeuringen', 'merchant.feed', 'agenda.vandaag']) assert.equal(view.find((d: any) => d.duty.key === key).needs, null, `${key} no longer waits`);
    assert.deepEqual(env.duties.sourceTools(env.t.app.ctx.store.agent(sem.id)!, 'search_console'), ['mcp_google_gsc_inspect_url', 'mcp_google_gsc_search_analytics', 'mcp_google_gsc_sitemaps', 'mcp_google_gsc_sites']);
    assert.deepEqual(env.duties.sourceTools(env.t.app.ctx.store.agent(ans.id)!, 'calendar'), ['mcp_google_calendar_events']);

    const toolText = (re: RegExp) => env.t.app.ctx.store.all<any>("SELECT content FROM messages WHERE role = 'tool'").map((m) => String(m.content)).filter((c) => re.test(c));
    const turn = (key: string) => env.t.requests.filter((r) => new RegExp(key).test(JSON.stringify(r.messages)));

    // Monday 07:00 — rankings: the bot reads Search Console through the real tool and reports with the number.
    env.t.script.push(
      { toolCalls: [{ name: 'mcp_google_gsc_search_analytics', args: { site: 'sc-domain:raamwinkel.test' } }] },
      { toolCalls: [{ name: 'duty_report', args: { status: 'in_orde', samenvatting: '41 klikken, positie 11,4 op “kozijnen vergelijken” (Search Console, 9 nov)' } }] },
      { text: 'In orde.' },
    );
    await env.at('2026-11-09T06:00:05Z');
    assert.match(JSON.stringify(turn('Posities en klikken in Google')[0].messages), /Gebruik deze tools: mcp_google_gsc_inspect_url, mcp_google_gsc_search_analytics, mcp_google_gsc_sitemaps, mcp_google_gsc_sites\./);
    // The duty names its tools: they are in the list of that run (tools/selection.ts `wanted`); the rest of the app
    // stays on demand.
    const sent = turn('Posities en klikken in Google')[0].tools.map((x: any) => x.name);
    for (const n of ['mcp_google_gsc_inspect_url', 'mcp_google_gsc_search_analytics', 'mcp_google_gsc_sitemaps', 'mcp_google_gsc_sites']) assert.ok(sent.includes(n), `${n} listed for the duty that names it`);
    assert.ok(!sent.includes('mcp_google_gmail_send'));
    assert.match(turn('Posities en klikken in Google')[0].system, /ook een tool die je instructies, een opdracht of een skill noemen, zoek je met tools_find/);
    assert.equal(toolText(/kozijnen vergelijken/).length, 1, 'rankings were read from (the stand-in for) Search Console');
    assert.equal(env.runs(env.duty(sem.id, 'seo.posities').id).at(-1).summary, 'In orde: 41 klikken, positie 11,4 op “kozijnen vergelijken” (Search Console, 9 nov)');

    // 08:15 — Merchant Center: disapprovals read; the bot forgets duty_report, and the receipt still says what was read.
    env.t.script.push({ toolCalls: [{ name: 'mcp_google_merchant_products', args: { account: '555' } }] }, { text: 'kozijn-1 is afgekeurd voor Shopping in NL: ontbrekende GTIN.' });
    await env.at('2026-11-09T06:15:05Z');
    assert.equal(toolText(/missing_gtin/).length, 1, 'disapprovals were read from Merchant Center');
    const mr = env.runs(env.duty(mo.id, 'merchant.afkeuringen').id).at(-1);
    assert.equal(mr.status, 'done');
    assert.equal(mr.summary, 'Gelezen met mcp_google_merchant_products, maar geen uitkomst gemeld. Mo: kozijn-1 is afgekeurd voor Shopping in NL: ontbrekende GTIN.');
    assert.deepEqual([mr.meta.duty.result, mr.meta.duty.reported, mr.meta.duty.read], ['gelezen_niet_gemeld', false, ['mcp_google_merchant_products']]);
    assert.ok(!env.notes().some((n) => /zonder resultaat/.test(n.title)), 'no "zonder resultaat" alarm for a run TeamBot could account for');

    // 07:25 — the feed duty of the same bot (connected too).
    env.t.script.push({ toolCalls: [{ name: 'duty_report', args: { status: 'kon_niet', samenvatting: 'Geen feedrapport beschikbaar in dit account' } }] }, { text: 'De feed kon ik niet lezen.' });
    await env.at('2026-11-09T06:25:05Z');

    // 07:30 — the private assistant reads the agenda.
    env.t.script.push({ toolCalls: [{ name: 'mcp_google_calendar_events', args: {} }] }, { toolCalls: [{ name: 'duty_report', args: { status: 'in_orde', samenvatting: '1 afspraak: Tandarts 15:00 (Agenda, 9 nov)' } }] }, { text: 'Niets voor te bereiden.' });
    await env.at('2026-11-09T06:30:05Z');
    assert.equal(toolText(/Tandarts/).length >= 1, true, 'a calendar event was read');
    assert.match(env.runs(env.duty(ans.id, 'agenda.vandaag').id).at(-1).summary, /Tandarts 15:00/);

    // And without any model: a number from a Google tool against a threshold (TeamBot calls the reading tool itself).
    const made = await env.t.api('POST', '/proactive/duties', { agentId: mo.id, title: 'Producten in de feed', check: 'Staan er nog genoeg producten in Merchant Center?', source: 'merchant_center', okWhen: 'minstens 3 producten', onProblem: 'task', everyMinutes: 15, measure: { kind: 'tool', tool: 'merchant_products', args: { account: '555' }, path: 'products.length', op: '>=', value: 3 } });
    const calls = env.t.requests.length;
    await env.at('2026-11-10T06:50:00Z');
    const fr = env.runs(made.id)[0];
    assert.equal(fr.status, 'done', fr.summary);
    assert.match(fr.summary, /^1 probleem \(2 uit merchant_products \(products\.length\) \(in orde als >= 3\)\): Producten in de feed: niet in orde/);
    assert.match((await env.taken()).find((x) => x.titel === 'Producten in de feed: niet in orde')!.beschrijving, /merchant_products \(products\.length\) geeft 2; in orde is >= 3/);
    assert.equal(env.t.requests.filter((r) => /Vaste taak “Producten in de feed”/.test(JSON.stringify(r.messages))).length, 0, 'measured by TeamBot, no model');
    void calls;
  } finally {
    delete process.env.TEAMBOT_GOOGLE_BASE;
    await env.t.close();
    await g.close();
  }
});

test('unanswered customer messages are measured from the channel data, without a model', async () => {
  const env = await setup({ start: '2026-11-09T07:00:00Z' });
  try {
    const ctx = env.t.app.ctx;
    const kim = await env.t.agent({ name: 'Kim', role: 'Klantenservice', tool_groups: ['team'] });
    await give(env, kim, ['klant.onbeantwoord']);
    await env.at('2026-11-09T07:01:00Z');
    const duty = env.duty(kim.id, 'klant.onbeantwoord');
    assert.match(env.duties.needs(duty, ctx.store.agent(kim.id)!)!, /Koppel een mailbox of chat-app/);
    const b = await env.t.api('POST', '/channels/bindings', { adapter: 'webhook', name: 'Webchat', agent_id: kim.id, config: { replyMode: 'none' }, secrets: { signingSecret: 'webhook-secret-0123456789abcdef' } });
    const conv = (id: string, title: string, inbound: string, outbound: string | null) =>
      ctx.store.exec('INSERT INTO channel_conversations (id, binding_id, user_id, external_id, title, is_private, meta, paused, last_sender_id, last_inbound_at, last_outbound_at, created_at) VALUES (?, ?, ?, ?, ?, 1, ?, 0, ?, ?, ?, ?)', id, b.id, env.userId, id, title, '{}', id, inbound, outbound, inbound);
    conv('cv_a', 'Jan de Vries', '2026-11-09T02:30:00.000Z', null); // 5.5 hours at 09:00, never answered
    conv('cv_b', 'Piet', '2026-11-09T06:30:00.000Z', null); // 1.5 hours: not yet
    conv('cv_c', 'Anna', '2026-11-08T10:00:00.000Z', '2026-11-08T10:05:00.000Z'); // answered

    env.t.script.push({ text: 'Ik heb Jan nog niet kunnen antwoorden.' });
    await env.at('2026-11-09T08:00:05Z'); // 09:00
    const rr = env.runs(duty.id).at(-1);
    assert.deepEqual(rr.meta.duty.numbers, { kanalen: 1, gesprekken: 3, onbeantwoord: 1, fouten: 1 });
    const taken = await env.taken();
    assert.equal(taken.length, 1);
    assert.equal(taken[0].titel, 'Klantbericht van Jan de Vries wacht al 5 uur op antwoord');
    assert.match(taken[0].beschrijving, /Webchat: laatste bericht van Jan de Vries op 2026-11-09 02:30 UTC, nog geen antwoord/);
    // The bot answered nothing about the outcome itself: the receipt is TeamBot's measurement plus what the bot said.
    assert.match(rr.summary, /^1 probleem \(1 kanaal, 3 gesprekken bekeken\): Klantbericht van Jan de Vries wacht al 5 uur op antwoord — Kim: Ik heb Jan nog niet kunnen antwoorden\.$/);

    // Answered → the next measurement closes the task; everything answered → quiet, no model.
    ctx.store.exec("UPDATE channel_conversations SET last_outbound_at = '2026-11-09T09:10:00.000Z' WHERE id IN ('cv_a', 'cv_b')");
    const calls = env.t.requests.length;
    await env.at('2026-11-09T12:00:05Z'); // 13:00
    assert.equal((await env.taken())[0].status, 'klaar');
    assert.match(env.runs(duty.id).at(-1).summary, /^In orde: 1 kanaal, 3 gesprekken bekeken\. 1 taak afgesloten/);
    assert.equal(env.t.requests.filter((r) => /Onbeantwoorde klantberichten/.test(JSON.stringify(r.messages))).length, 1);
    assert.ok(env.t.requests.length >= calls);
  } finally {
    await env.t.close();
  }
});
