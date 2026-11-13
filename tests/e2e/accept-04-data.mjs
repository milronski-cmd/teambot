// Acceptance 0.4, part 2 (package T): memory, back-ups, engine versions and free models, as the owner does it in the
// real built app.
//  F  a fact in other words is found (meaning search via an Ollama on this pc: a local stand-in with a fixed "meaning");
//     a Word and a pdf document in a dossier, quoted by the bot with a source chip; "ja, doe maar" on the bot's proposal
//     becomes a memory with undo; a pinned safety rule stays in every call, also after "Gesprek samenvatten".
//  N  a back-up in Instellingen › Back-ups, then changes (a forgotten memory, a renamed bot, a new memory), then
//     restore with one click and a restart: everything is back except what was forgotten; the back-up before an update;
//     engine versions: a new Claude Code version is noticed, a self-check without quota fails and shows the way back.
//  D  Instellingen › Gratis modellen: everything off at first, a key field with its sign-up link, labels (privacy,
//     tools werken / nog niet getest), Kilo without a key; the providers' real hosts go to a local fixture server.
// Optional live check with the local Ollama on this pc (TEAMBOT_ACCEPT_OLLAMA=1, model TEAMBOT_ACCEPT_OLLAMA_MODEL,
// default: the chat model Ollama has loaded right now, else qwen3:1.7b): a bot on Ollama answers and quotes the Word
// document. Run it with TEAMBOT_ACCEPT_ONLY=F-03,A-01 for just that.
// Usage: npm run build:ui && node --import tsx tests/e2e/accept-04-data.mjs   [TEAMBOT_E2E_SHOTS=<dir>] [TEAMBOT_E2E_PORT]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, confirmDialog, go, hashOf, isolate, launchBrowser, mainText, makeDocx, makePdf, openPage, part, rmrf, seeMessage, send, shot, sleep, startTeamBot, summary, testEngine, until } from './accept-04-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FIX = path.join(here, '..', 'fixtures', 'free-models');
const recorded = (name) => JSON.parse(fs.readFileSync(path.join(FIX, `${name}.json`), 'utf8')).body;
const ENGINE_FAKE = path.join(here, '..', 'fixtures', 'engine-fake-cli.mjs');
const LIVE = process.env.TEAMBOT_ACCEPT_OLLAMA === '1';
// The live check uses the model Ollama has loaded now (so nothing of the owner's is swapped out), else qwen3:1.7b.
const loaded = LIVE && !process.env.TEAMBOT_ACCEPT_OLLAMA_MODEL ? await fetch('http://127.0.0.1:11434/api/ps').then((r) => r.json(), () => null) : null;
const LIVE_MODEL = process.env.TEAMBOT_ACCEPT_OLLAMA_MODEL || loaded?.models?.find((m) => !/embed/i.test(m.name))?.name || 'qwen3:1.7b';

// ------------------------------------------------------------------------------------------------ fixture server
// The free providers' real hosts (Groq, OpenRouter, Kilo, Cloudflare, Z.ai) are sent to this server: model lists as
// the providers publish them, and a tool call for the probe. Nothing leaves this pc.
const chunk = (delta, finish = null, model = 'm') => ({ id: 'c1', object: 'chat.completion.chunk', created: 1794000000, model, choices: [{ index: 0, delta, finish_reason: finish }] });
const toolSSE = (model) => [chunk({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'ping', arguments: '{"text":"ok"}' } }] }, null, model), chunk({}, 'tool_calls', model), '[DONE]'];
const GROQ_MODELS = {
  object: 'list',
  data: [
    { id: 'openai/gpt-oss-120b', object: 'model', created: 1754408224, owned_by: 'OpenAI', active: true, context_window: 131072, max_completion_tokens: 65536 },
    { id: 'qwen/qwen3.8-27b', object: 'model', created: 1790000000, owned_by: 'Alibaba Cloud', active: true, context_window: 131072, max_completion_tokens: 16384 },
    { id: 'whisper-large-v3', object: 'model', created: 1693721698, owned_by: 'OpenAI', active: true, context_window: 448, max_completion_tokens: 448 },
  ],
};
const seen = [];
const fixture = http.createServer((rq, rs) => {
  let data = '';
  rq.on('data', (c) => (data += c));
  rq.on('end', () => {
    const url = (rq.url || '/').split('?')[0];
    let body = {};
    try {
      body = data ? JSON.parse(data) : {};
    } catch {
      /* text */
    }
    seen.push({ method: rq.method, url, body, auth: rq.headers.authorization || '' });
    const json = (status, b, headers = {}) => (rs.writeHead(status, { 'content-type': 'application/json', ...headers }), rs.end(JSON.stringify(b)));
    const sse = (events, headers = {}) => {
      rs.writeHead(200, { 'content-type': 'text/event-stream', ...headers });
      for (const ev of events) rs.write(typeof ev === 'string' ? `data: ${ev}\n\n` : `data: ${JSON.stringify(ev)}\n\n`);
      rs.end();
    };
    if (rq.method === 'GET' && url === '/groq/openai/v1/models') return json(200, GROQ_MODELS);
    if (rq.method === 'POST' && url === '/groq/openai/v1/chat/completions') return sse(toolSSE(body.model), { 'x-ratelimit-limit-requests': '1000', 'x-ratelimit-remaining-requests': '998', 'x-ratelimit-reset-requests': '2m59.56s' });
    if (rq.method === 'GET' && url === '/kilo/api/v1/models') return json(200, recorded('kilo-models'));
    if (rq.method === 'POST' && url === '/kilo/api/v1/chat/completions') return sse(toolSSE(body.model));
    if (rq.method === 'GET' && url === '/openrouter/api/v1/models') return json(200, recorded('openrouter-models'));
    return json(404, { error: { message: `no fixture for ${rq.method} ${url}` } });
  });
});
await new Promise((r) => fixture.listen(0, '127.0.0.1', r));
const FIXTURE_URL = `http://127.0.0.1:${fixture.address().port}`;
const realFetch = globalThis.fetch;
const HOSTS = [
  ['https://api.groq.com', `${FIXTURE_URL}/groq`],
  ['https://openrouter.ai', `${FIXTURE_URL}/openrouter`],
  ['https://ai-gateway.kilo.ai', `${FIXTURE_URL}/kilo`],
  ['https://api.cloudflare.com', `${FIXTURE_URL}/cf`],
  ['https://api.z.ai', `${FIXTURE_URL}/zai`],
];
const outside = [];
globalThis.fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  for (const [from, to] of HOSTS) if (url.startsWith(from)) return realFetch(to + url.slice(from.length), init);
  if (/^https?:\/\//.test(url) && !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(url)) outside.push(url);
  return realFetch(input, init);
};

// ------------------------------------------------------------------------------------------------ TeamBot
const browser = await launchBrowser();
const home = isolate('tb-accept-data');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-accept-data-'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-accept-data-files-'));
const { startFakeOllama } = await import('../memory-fake-ollama.ts');
const ollama = await startFakeOllama();
const ai = testEngine();
const tb = await startTeamBot({ dir, ai });
console.log(`TeamBot op ${tb.url} (lege datamap ${dir}); nep-Ollama op ${ollama.url}; gratis aanbieders → ${FIXTURE_URL}`);
const errors = [];
let page;
const ids = {};

/** All text of the conversation as the model got it (the frozen per-turn context is part of the user messages). */
const asked = (req) => JSON.stringify(req.messages);
/** "[s:abc12] “name”" or "[m:abc12] …" refs in what the model got. */
const refIn = (req, re) => re.exec(asked(req))?.[1] || null;
const milaThread = () => tb.app.ctx.store.all("SELECT id FROM threads WHERE agent_id = ? AND kind = 'chat' ORDER BY created_at", tb.bot('Mila').id)[0]?.id;
const openMila = async () => go(page, `#/t/${milaThread()}`, 900);
const memoryNew = async (content, { type, pin } = {}) => {
  await go(page, '#/m/memory/', 900);
  // Adding one yourself is rare: it sits behind "Meer opties".
  await page.locator('#inhoud').getByRole('button', { name: 'Meer opties', exact: true }).first().click();
  await page.getByRole('menuitem', { name: 'Zelf iets toevoegen' }).click();
  const dlg = page.getByRole('dialog', { name: 'Nieuwe herinnering' });
  await dlg.waitFor({ timeout: 5000 });
  await dlg.getByLabel('Inhoud').fill(content);
  if (type) await dlg.getByLabel('Soort').selectOption({ label: type });
  if (pin) await dlg.getByRole('switch', { name: /Vastzetten/ }).click();
  await dlg.getByRole('button', { name: 'Opslaan', exact: true }).click();
  await dlg.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
};
/** Geheugen › Overzicht › "Wat weet je over…": the text of the results once they are there (or "niets"). */
const searchMemory = async (q) => {
  await go(page, '#/', 200); // a fresh visit, so no earlier result is still on screen
  await go(page, '#/m/memory/', 900);
  await page.locator('#mem-ask').fill(q);
  await page.locator('#inhoud').getByRole('button', { name: 'Zoeken', exact: true }).click();
  const box = page.locator('#mem-ask').locator('xpath=ancestor::form/..');
  const text = await until(async () => {
    const t = (await box.innerText()).replace(/\s+/g, ' ');
    return t.length > 40 || /niets over/.test(t) ? t : false;
  }, 10_000, 200);
  await page.waitForTimeout(400);
  return ((await box.innerText()) || String(text)).replace(/\s+/g, ' ');
};
/** The card of a memory in the search results (with its "Acties" menu and badges). */
const memoryCard = (content) => page.locator('p', { hasText: content }).first().locator('xpath=ancestor::*[.//button[@aria-label="Acties"]][1]');

try {
  // Setup as after the first start: the found AI and one bot.
  await tb.api('PUT', '/memory/settings', { extractor: 'heuristic' });
  const prov = await tb.api('POST', '/providers', { kind: 'mock', name: 'Testmodel' });
  await tb.api('POST', '/agents', { name: 'Mila', description: 'Helpt met de verbouwing en het huishouden.', provider_id: prov.id, model: 'mock-1' });
  await tb.api('POST', '/threads', { agentId: tb.bot('Mila').id });
  page = await openPage(browser, tb, { errors });
  await page.waitForTimeout(1200);

  // ============================================================================================ F: memory
  await part('F-01', 'een feit dat in andere woorden is opgeslagen wordt gevonden (zoeken op betekenis)', async () => {
    // The owner connects his Ollama (on this pc) at AI-providers; it has the embedding model bge-m3.
    await tb.api('POST', '/providers', { kind: 'ollama', name: 'Ollama', base_url: `${ollama.url}/v1` });
    await memoryNew('Mijn auto is een blauwe Volvo.');
    const section = async () => {
      await go(page, '#/m/memory/', 200);
      await go(page, '#/m/memory/opslag', 1200);
      return ((await page.locator('h2', { hasText: 'Zoeken op betekenis' }).locator('xpath=ancestor::*[contains(@class,"rounded-card")][1]').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
    };
    const on = await until(async () => {
      const t = await section();
      return /Aan met bge-m3/.test(t) && /1 \/ 1/.test(t) ? t : false;
    }, 70_000, 1500);
    check('F-01', 'Opslag › Zoeken op betekenis: aan met bge-m3, de herinnering is op betekenis doorzoekbaar', !!on, on || (await section()).slice(0, 500));
    // Fully indexed is "done", not a full memory (before the fix: a red "Vol" and "Hier wordt niets nieuws meer onthouden").
    check('F-01', 'alles doorzocht op betekenis is geen "vol geheugen" (geen rood "Vol", geen waarschuwing)', !!on && !/Vol\s*\d+ \/ \d+/.test(on) &&!/Hier wordt niets nieuws meer onthouden/.test(on), String(on).slice(0, 400));
    await shot(page, 'f01-opslag');
    const t = await searchMemory('wagen');
    check('F-01', '"wagen" vindt "Mijn auto is een blauwe Volvo", met "Ook gevonden op betekenis"', /blauwe Volvo/.test(t) && /Ook gevonden op betekenis/.test(t), t.slice(0, 300));
    await shot(page, 'f01-wagen');
    const none = await searchMemory('koffie');
    check('F-01', '"koffie" vindt niets (geen valse treffer)', !/blauwe Volvo/.test(none) && /Daar weet je geheugen niets over/.test(none), none.slice(0, 200));
    // In a chat: the bot gets the memory by meaning and cites it; the source chip is under the answer.
    await openMila();
    let got = '';
    ai.to('Mila', (req) => {
      got = asked(req);
      const ref = refIn(req, /\[m:([a-z0-9]+)\][^\]]{0,200}blauwe Volvo/);
      return { text: ref ? `Je wagen is een blauwe Volvo [m:${ref}].` : 'Dat weet ik niet.' };
    });
    await send(page, 'Welke kleur heeft mijn wagen?');
    const said = await seeMessage(page, 'Je wagen is een blauwe Volvo', 15_000);
    const chip = said && (await page.locator('a[title*="blauwe Volvo"]').first().waitFor({ timeout: 8000 }).then(() => true, () => false));
    check('F-01', 'in de chat: de bot krijgt de herinnering op betekenis mee en citeert hem, met de bron eronder', said && chip, said ? 'geen bronnen onder het antwoord' : `de bot kreeg: ${got.slice(-600)}`);
  });

  await part('F-03', 'een Word- en een pdf-document in een dossier worden geciteerd', async () => {
    const docx = path.join(scratch, 'offerte-dakkapel.docx');
    fs.writeFileSync(docx, makeDocx(['Offerte dakkapel voor de verbouwing', 'De dakkapel kost 7450 euro inclusief plaatsing.', 'Levertijd: zes weken na akkoord.']));
    const pdf = path.join(scratch, 'garantie.pdf');
    fs.writeFileSync(pdf, makePdf([['Garantievoorwaarden zonnepanelen'], ['De garantie op de omvormer is 12 jaar']]));
    await go(page, '#/m/memory/dossiers', 900);
    await page.getByRole('button', { name: 'Nieuw dossier' }).click();
    const dlg = page.getByRole('dialog', { name: 'Nieuw dossier' });
    await dlg.getByLabel('Titel').fill('Verbouwing');
    await dlg.getByRole('button', { name: 'Aanmaken' }).click();
    await page.waitForTimeout(1200);
    await page.getByRole('tab', { name: 'Bronnen' }).click();
    for (const [file, label] of [
      [docx, 'offerte-dakkapel.docx'],
      [pdf, 'garantie.pdf'],
    ]) {
      const chooser = page.waitForEvent('filechooser', { timeout: 5000 });
      await page.getByRole('button', { name: 'Bestand toevoegen (pdf, Office, foto of tekst)' }).click();
      await (await chooser).setFiles(file);
      const added = await page.getByText(new RegExp(`${label.replace('.', '\\.')} toegevoegd en doorzoekbaar`)).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
      check('F-03', `${label}: toegevoegd en doorzoekbaar (melding)`, added);
    }
    const listed = await mainText(page);
    check('F-03', 'beide documenten staan bij de bronnen, met "delen doorzoekbaar"', /offerte-dakkapel\.docx/.test(listed) && /garantie\.pdf/.test(listed) && /delen? doorzoekbaar/.test(listed), listed.slice(0, 300));
    await shot(page, 'f03-bronnen');
    await openMila();
    ai.to('Mila', (req) => {
      const ref = refIn(req, /\[s:([a-z0-9]+)\] “offerte-dakkapel\.docx”/);
      return { text: ref && /7450 euro/.test(asked(req)) ? `Volgens de offerte kost de dakkapel 7450 euro inclusief plaatsing [s:${ref}].` : 'Dat staat niet in mijn bronnen.' };
    });
    await send(page, 'Wat kost de dakkapel volgens de offerte?');
    const word = await seeMessage(page, 'Volgens de offerte kost de dakkapel 7450 euro');
    const chipWord = word && (await page.locator('a[title*="offerte-dakkapel.docx"]').first().waitFor({ timeout: 8000 }).then(() => true, () => false));
    check('F-03', 'Word: de bot citeert de offerte (7450 euro) met de bron "offerte-dakkapel.docx" eronder', word && chipWord);
    ai.to('Mila', (req) => {
      const ref = refIn(req, /\[s:([a-z0-9]+)\] “garantie\.pdf”/);
      return { text: ref && /omvormer is 12 jaar/.test(asked(req)) ? `De garantie op de omvormer is 12 jaar [s:${ref}].` : 'Dat staat niet in mijn bronnen.' };
    });
    await send(page, 'Hoe lang is de garantie op de omvormer?');
    const pdfOk = await seeMessage(page, 'De garantie op de omvormer is 12 jaar');
    const chipPdf = pdfOk && (await page.locator('a[title*="garantie.pdf"]').first().waitFor({ timeout: 8000 }).then(() => true, () => false));
    check('F-03', 'pdf: de bot citeert de garantie (12 jaar) met de bron "garantie.pdf" eronder', pdfOk && chipPdf);
    await shot(page, 'f03-geciteerd');
  });

  await part('F-04', '"ja, doe maar" op een voorstel van de bot levert een herinnering op', async () => {
    await openMila();
    ai.to('Mila', { text: 'Wat een leuk verhaal over het strand! Zal ik onthouden dat je hond Bram heet?' });
    await send(page, 'Bram ging vandaag mee naar het strand en rende de hele dag.');
    await seeMessage(page, 'Zal ik onthouden dat je hond Bram heet?');
    await tb.idle();
    ai.to('Mila', { text: 'Genoteerd!' });
    await send(page, 'ja, doe maar');
    const line = await page.getByText(/Onthouden \(Over jou\): Mijn hond heet Bram/).first().waitFor({ timeout: 15_000 }).then(() => true, () => false);
    const undo = line && (await page.getByRole('button', { name: 'Ongedaan maken' }).count()) > 0;
    check('F-04', 'onder "ja, doe maar": "Onthouden (Over jou): Mijn hond heet Bram" met Ongedaan maken', line && undo);
    await shot(page, 'f04-ja-doe-maar');
    await go(page, '#/m/memory/over-jou', 1200);
    const t = await mainText(page);
    check('F-04', 'Geheugen › Over jou: "Mijn hond heet Bram"', /Mijn hond heet Bram/.test(t), t.slice(0, 300));
  });

  await part('F-06', 'een vastgezette veiligheidsregel blijft altijd geladen, ook na samenvatten', async () => {
    const RULE = 'Vraag altijd eerst toestemming voordat je iets verwijdert.';
    await memoryNew(RULE, { type: 'Instructie', pin: true });
    const found = await searchMemory('toestemming verwijdert');
    check('F-06', 'de regel heeft de badge "Vaste regel"', (await memoryCard(RULE).getByText('Vaste regel').count()) > 0, found.slice(0, 300));
    await openMila();
    for (let i = 1; i <= 3; i++) {
      ai.to('Mila', { text: `Antwoord ${i} over de planning.` });
      await send(page, `Vraag ${i} over de planning van de verbouwing.`);
      await seeMessage(page, `Antwoord ${i} over de planning.`);
    }
    const before = ai.last('Mila');
    check('F-06', 'de regel staat in de systeemprompt ("Vaste regels van de eigenaar")', /## Vaste regels van de eigenaar/.test(before?.system || '') && (before?.system || '').includes(RULE.replace(/\.$/, '')));
    // "Gesprek samenvatten" in the chat menu.
    await page.getByRole('button', { name: 'Meer opties' }).first().click();
    await page.getByRole('button', { name: 'Meer acties', exact: true }).click();
    await page.getByRole('button', { name: /Gesprek samenvatten/ }).click();
    const compacted = await page.getByText('Oudere deel samengevat').first().waitFor({ timeout: 20_000 }).then(() => true, () => false);
    check('F-06', 'Gesprek samenvatten: "Oudere deel samengevat"', compacted);
    ai.to('Mila', { text: 'Mag ik eerst vragen: welke map bedoel je precies?' });
    await send(page, 'Gooi die oude map met offertes maar weg.');
    await seeMessage(page, 'Mag ik eerst vragen');
    const after = ai.last('Mila');
    const summarised = typeof after?.messages?.[0]?.content === 'string' && after.messages[0].content.startsWith('[Samenvatting van het eerdere deel');
    check('F-06', 'na samenvatten: de oude beurten zijn een samenvatting, de regel staat er nog', summarised && (after?.system || '').includes(RULE.replace(/\.$/, '')), String(after?.messages?.[0]?.content || '').slice(0, 120));
  });

  // ============================================================================================ N: back-ups
  await part('N-01', 'een back-up maken in Instellingen › Back-ups', async () => {
    await memoryNew('Ik werk bij Bakkerij Jansen.');
    await go(page, '#/settings/backups-app', 1200);
    // What is in a back-up and how many to keep are behind "Meer opties".
    await page.evaluate(() => document.querySelectorAll('[data-testid="more-options"]').forEach((x) => (x.open = true)));
    await page.waitForTimeout(300);
    const text0 = await mainText(page);
    check('N-01', 'de pagina zegt wat erin zit en wat niet, en hoe het met de sleutels zit', /Wat zit erin, en wat niet/.test(text0) && /Niet in een back-up/.test(text0) && /sleutel/i.test(text0), text0.slice(0, 200));
    check('N-01', 'elke dag automatisch staat standaard aan, bewaar de laatste 7', (await page.getByRole('switch', { name: 'Elke dag automatisch een back-up maken' }).getAttribute('aria-checked')) === 'true' && /^7 back-ups/.test((await page.locator('#backup-keep').innerText()).trim()), (await page.locator('#backup-keep').innerText()).trim());
    await page.getByRole('button', { name: 'Nu een back-up maken' }).click();
    const made = await until(async () => /Zelf gemaakt/.test(await mainText(page)), 30_000, 300);
    check('N-01', '"Nu een back-up maken": de back-up staat in de lijst (zelf gemaakt)', !!made);
    ids.backups = (await tb.api('GET', '/backups')).items.map((b) => b.name);
    await shot(page, 'n01-back-up');
  });

  await part('N-02', 'iets veranderen, terugzetten met één klik, opnieuw starten: alles terug, vergeten blijft vergeten', async () => {
    // 1. Forget "Bakkerij Jansen" for good (found with "Wat weet je over…", then Acties › Definitief vergeten).
    await searchMemory('Bakkerij');
    await memoryCard('Ik werk bij Bakkerij Jansen.').getByRole('button', { name: 'Acties' }).click();
    await page.getByRole('menuitem', { name: /Definitief vergeten/ }).click().catch(async () => page.getByText('Definitief vergeten…').click());
    const fdlg = page.getByRole('dialog', { name: 'Definitief vergeten?' });
    await fdlg.getByRole('button', { name: 'Definitief vergeten', exact: true }).click();
    await page.getByRole('dialog', { name: 'Vergeten' }).getByRole('button', { name: 'Klaar' }).click();
    await page.waitForTimeout(500);
    check('N-02', 'vergeten: "Bakkerij Jansen" is niet meer te vinden', !/Bakkerij Jansen/.test(await searchMemory('Bakkerij')));
    // 2. Rename the bot, 3. remember something new.
    await tb.api('PATCH', `/agents/${tb.bot('Mila').id}`, { name: 'Mila Nieuw' });
    await memoryNew('Ik drink graag rooibosthee.');
    // 4. Restore the back-up made before these changes.
    await go(page, '#/settings/backups-app', 1200);
    const row = page.locator('li', { hasText: 'Zelf gemaakt' }).first();
    await row.getByRole('button', { name: 'Terugzetten' }).click();
    await confirmDialog(page, 'Terugzetten');
    const staged = await page.getByText('Een back-up staat klaar om terug te zetten').first().waitFor({ timeout: 10_000 }).then(() => true, () => false);
    check('N-02', 'terugzetten klaargezet: "Een back-up staat klaar om terug te zetten" (de desktop-app start dan vanzelf opnieuw)', staged);
    await shot(page, 'n02-klaargezet');
    // 5. TeamBot starts again (here: the server; in the Windows app the restart is automatic).
    await tb.restart();
    // The Windows app opens a new window after the restart; here the page is loaded again (a hash-only goto would not).
    await page.reload();
    await page.waitForTimeout(2000);
    const side = await page.getByRole('navigation', { name: 'Hoofdmenu' }).innerText().catch(() => '');
    check('N-02', 'na terugzetten: de bot heet weer Mila (de naamswijziging is weg)', /\bMila\b/.test(side) && !/Mila Nieuw/.test(side) && !!tb.bot('Mila'), side.replace(/\s+/g, ' ').slice(0, 200));
    await go(page, '#/m/memory/over-jou', 1500);
    const mem = await mainText(page);
    check('N-02', 'na terugzetten: wat in de back-up zat is terug (hond Bram, blauwe Volvo, vaste regel)', /Mijn hond heet Bram/.test(mem) && /blauwe Volvo/.test(mem) && /Vraag altijd eerst toestemming/.test(mem), mem.slice(0, 300));
    check('N-02', 'na terugzetten: wat later kwam is weg ("rooibosthee")', !/rooibosthee/.test(mem));
    check('F-05', 'na terugzetten: "Bakkerij Jansen" (vergeten na de back-up) blijft vergeten', !/Bakkerij Jansen/.test(mem) && !/Bakkerij Jansen/.test(await searchMemory('Bakkerij')));
    const docs = await searchMemory('dakkapel');
    check('F-05', 'na terugzetten: de zoekindex is herbouwd (de offerte is te vinden)', /offerte-dakkapel|dakkapel/.test(docs), docs.slice(0, 200));
    await go(page, '#/settings/backups-app', 1500);
    const b = await mainText(page);
    check('N-02', 'Back-ups: "Laatst teruggezet op …" en een veiligheidskopie van vóór het terugzetten', /Laatst teruggezet op/.test(b) && /Veiligheidskopie van vóór het terugzetten/.test(b), b.slice(0, 400));
    await go(page, '#/m/notifications/', 1200);
    check('N-02', 'melding "Back-up teruggezet"', /Back-up teruggezet/.test(await mainText(page)));
    await shot(page, 'n02-teruggezet');
  });

  await part('N-04', 'de back-up vóór een update staat in de lijst; Updates en "Wat is er nieuw"', async () => {
    // What the Windows app does in will-quit before it starts an installer (desktop/update-flow.ts).
    await tb.app.ctx.services.backups.beforeUpdate({ from: tb.app.ctx.config.version, to: '0.4.0' });
    await go(page, '#/', 300);
    await go(page, '#/settings/backups-app', 1500);
    const t = await mainText(page);
    check('N-04', 'de back-up "Voor de update naar 0.4.0" staat in de lijst', /Voor de update naar 0\.4\.0/.test(t), t.slice(0, 300));
    check('N-04', 'de kaart Updates toont de versie die nu draait', t.includes(tb.app.ctx.config.version), t.slice(-300));
    await go(page, '#/m/backups/nieuw', 1200);
    const news = await mainText(page);
    check('N-04', '"Wat is er nieuw" opent zonder fout', /Wat is er nieuw/.test(news) && !/Pagina niet gevonden/.test(news), news.slice(0, 200));
  });

  await part('G-04', 'motorversies: een nieuwe Claude Code-versie wordt gezien, getest zonder tegoed, met de weg terug', async () => {
    const { RUNTIMES } = await import('../../server/modules/cli-agents/runtimes.ts');
    const tested = RUNTIMES['claude-code'].pinned;
    const edir = path.join(scratch, 'engines');
    fs.mkdirSync(edir, { recursive: true });
    const bin = path.join(edir, 'claude.mjs');
    fs.copyFileSync(ENGINE_FAKE, bin);
    const log = path.join(edir, 'calls.log');
    const set = (c) => fs.writeFileSync(bin + '.json', JSON.stringify({ kind: 'claude', log, ...c }));
    set({ version: tested });
    await tb.api('PUT', '/cli-agents/paths/claude-code', { path: bin });
    // Since 0.4.2 the versions card is for experts (Instellingen › Geavanceerd tonen).
    const ui = (await tb.api('GET', '/settings')).ui || {};
    await tb.api('PUT', '/settings', { ui: { ...ui, advanced: true } });
    await page.reload();
    await page.waitForTimeout(1200);
    await go(page, '#/settings/cli-agents-cli', 1500);
    const cardSel = page.getByTestId('engine-versions');
    await page.getByRole('button', { name: 'Opnieuw kijken' }).click().catch(() => {});
    const first = await until(async () => /Claude Code/.test(await cardSel.innerText()) && (await cardSel.innerText()).includes(tested), 20_000, 500);
    check('G-04', `kaart "Versies van de engines": Claude Code ${tested}, de versie waarmee TeamBot getest is`, !!first, (await cardSel.innerText().catch(() => '')).replace(/\s+/g, ' ').slice(0, 300));
    // Claude Code "updates itself" to a version that dropped an option TeamBot relies on.
    set({ version: '2.1.400', drop: ['--permission-prompt-tool'] });
    await page.getByRole('button', { name: 'Opnieuw kijken' }).click();
    await until(async () => (await cardSel.innerText()).includes('2.1.400'), 20_000, 500);
    const row = cardSel.locator('li', { hasText: 'Claude Code' }).first();
    await row.getByRole('button', { name: 'Nu testen' }).click();
    const failed = await page.getByText('Eigen test mislukt').first().waitFor({ timeout: 30_000 }).then(() => true, () => false);
    const txt = (await cardSel.innerText()).replace(/\s+/g, ' ');
    check('G-04', 'nieuwe versie 2.1.400 gezien; de eigen test mislukt en noemt de ontbrekende optie', failed && txt.includes('2.1.400') && /permission-prompt-tool/.test(txt), txt.slice(0, 400));
    check('G-04', `de weg terug: "Terug naar ${tested}" met de opdracht om zelf te draaien`, txt.includes(`Terug naar ${tested}`) && (await cardSel.locator('code').count()) > 0, txt.slice(0, 400));
    const calls = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
    const prompted = calls.filter((c) => c.argv.some((a) => a === '-p' || a === '--print' || /install|update|upgrade/.test(a)));
    check('G-04', 'de test kostte geen tegoed: geen prompt, en TeamBot installeerde of wijzigde niets aan de CLI', calls.length > 0 && !prompted.length, JSON.stringify(prompted.slice(0, 3)));
    await go(page, '#/m/notifications/', 1200);
    check('G-04', 'melding "Claude Code is bijgewerkt naar 2.1.400"', /Claude Code is bijgewerkt naar 2\.1\.400/.test(await mainText(page)));
    await go(page, '#/settings/cli-agents-cli', 1200);
    await shot(page, 'g04-motorversies');
    await tb.api('PUT', '/settings', { ui: { ...ui, advanced: false } });
    await page.reload();
    await page.waitForTimeout(1000);
  });

  // ============================================================================================ D: free models
  await part('D-04', 'Instellingen › Gratis modellen: standaard uit, sleutel zelf invullen, labels', async () => {
    await go(page, '#/settings/free-models-gratis', 1500);
    const rowOf = (label) => page.locator('li').filter({ has: page.locator('span.font-semibold', { hasText: new RegExp(`^${label}$`) }) }).first();
    const labels = ['Groq', 'OpenRouter', 'Cloudflare Workers AI', 'Z.ai GLM', 'Kilo Gateway'];
    const present = [];
    for (const l of labels) if (await rowOf(l).count()) present.push(l);
    const allOff = [];
    for (const l of present) allOff.push((await rowOf(l).locator('[data-connect-state]').getAttribute('data-connect-state')) === 'off');
    check('D-04', 'de gratis bronnen staan er (Groq, OpenRouter, Cloudflare, Z.ai, Kilo) en staan allemaal uit', present.length >= 5 && allOff.every(Boolean), present.join(', '));
    const privacy = {};
    for (const l of present) privacy[l] = (await rowOf(l).locator('span').allInnerTexts()).find((x) => /blijft op je pc|bewaart niets|kan trainen/.test(x));
    check('D-05', 'privacylabel per bron (Groq bewaart niets, OpenRouter en Kilo kunnen trainen)', privacy.Groq === 'bewaart niets' && privacy.OpenRouter === 'kan trainen' && privacy['Kilo Gateway'] === 'kan trainen', JSON.stringify(privacy));
    await shot(page, 'd04-gratis-uit');
    // Groq: its card asks for the free key, with a link to make one.
    const groq = rowOf('Groq');
    const keyField = groq.getByLabel('API-sleutel');
    await keyField.waitFor({ timeout: 5000 });
    const signup = await groq.getByRole('link', { name: 'Gratis sleutel aanmaken' }).getAttribute('href');
    check('D-04', 'aanzetten vraagt de sleutel, met één klik naar de aanmeldpagina van Groq', signup === 'https://console.groq.com/keys', signup || '');
    await keyField.fill('gsk_e2e_niet_echt_123456');
    await groq.getByRole('button', { name: 'Koppelen' }).click();
    const avail = await until(async () => /Beschikbaar/.test(await groq.innerText()), 20_000, 300);
    const gtext = (await groq.innerText()).replace(/\s+/g, ' ');
    check('D-04', 'Groq staat aan: Beschikbaar, 2 gratis modellen (spraakmodel niet)', !!avail && /2 gratis modellen/.test(gtext), gtext.slice(0, 300));
    check('D-04', 'de sleutel komt nooit terug in de pagina of de API', !(await page.content()).includes('gsk_e2e_niet_echt') && !JSON.stringify(await tb.api('GET', '/free-models')).includes('gsk_e2e_niet_echt'));
    check('D-04', 'de sleutel ging alleen naar Groq (Authorization bij de modellenlijst)', seen.some((s) => s.url === '/groq/openai/v1/models' && s.auth === 'Bearer gsk_e2e_niet_echt_123456'));
    // Kilo works without a key: its one action is "Koppelen" (was "Aanzetten" before 12 Nov).
    const kilo = rowOf('Kilo Gateway');
    await kilo.getByRole('button', { name: 'Koppelen', exact: true }).click();
    const kOn = await until(async () => /Beschikbaar/.test(await kilo.innerText()), 20_000, 300);
    check('D-04', 'Kilo werkt zonder sleutel: aan en Beschikbaar', !!kOn && !(await kilo.getByLabel('API-sleutel').count()), (await kilo.innerText()).replace(/\s+/g, ' ').slice(0, 200));
    // Labels per model: "nog niet getest" until a probe; one small probe with one tool makes it "tools werken".
    await page.getByRole('button', { name: 'Meer opties', exact: true }).click();
    const before = (await groq.innerText()).replace(/\s+/g, ' ');
    check('D-05', 'per model een label (nog niet getest / tools werken / alleen tekst)', /openai\/gpt-oss-120b/.test(before) && /(nog niet getest|tools werken|alleen tekst)/.test(before), before.slice(0, 300));
    await page.getByRole('button', { name: 'Lijsten nu verversen' }).click();
    const probed = await until(async () => /tools werken/.test(await groq.innerText()), 40_000, 1000);
    const chats = seen.filter((s) => s.url === '/groq/openai/v1/chat/completions');
    check('D-05', 'na de proef: "tools werken"; de proef is klein (één tool, hoogstens 512 tokens)', !!probed && chats.length >= 1 && chats.every((c) => c.body.tools?.length === 1 && c.body.tools[0].function?.name === 'ping' && (c.body.max_tokens ?? c.body.max_completion_tokens ?? 0) <= 512), `${chats.length} proef(ken)`);
    const perModel = {};
    for (const c of chats) perModel[c.body.model] = (perModel[c.body.model] || 0) + 1;
    check('D-05', 'hoogstens één proef per model', Object.values(perModel).every((n) => n <= 1), JSON.stringify(perModel));
    await shot(page, 'd05-gratis-aan');
    // "Gebruik en limieten" names the free sources (Groq) under the limits.
    await go(page, '#/m/usage/', 1200);
    const bar = page.locator('#inhoud');
    const dots = await until(async () => {
      const t = (await bar.innerText().catch(() => '')).replace(/\s+/g, ' ');
      return /Groq/.test(t) ? t : false;
    }, 15_000, 500);
    check('E-06', 'Gebruik en limieten noemt de gratis bronnen (Groq)', !!dots, String(dots || (await bar.innerText().catch(() => ''))).replace(/\s+/g, ' ').slice(0, 300));
    // Every request to a free provider went to the fixture server; nothing else carried the key.
    const freeHosts = /groq\.com|openrouter\.ai|kilo\.ai|cloudflare\.com|z\.ai/;
    check('D-08', 'geen verzoek naar een echte gratis aanbieder (alles naar de nepserver op deze pc)', !outside.some((u) => freeHosts.test(u)), outside.filter((u) => freeHosts.test(u)).join(', '));
    if (outside.length) console.log(`  (info) andere verzoeken naar buiten in deze run: ${[...new Set(outside.map((u) => u.replace(/\?.*$/, '')))].join(', ')}`);
  });

  // ============================================================================================ live (optional)
  if (LIVE) {
    await part('A-01', `live: een bot op de lokale Ollama (${LIVE_MODEL}) antwoordt en citeert de offerte`, async () => {
      const real = await tb.api('POST', '/providers', { kind: 'ollama', name: 'Ollama op deze pc', base_url: 'http://127.0.0.1:11434/v1' });
      const bot = await tb.api('POST', '/agents', { name: 'Lokaal', description: 'Beantwoordt vragen over de verbouwing, kort en in het Nederlands.', provider_id: real.id, model: LIVE_MODEL });
      const th = await tb.api('POST', '/threads', { agentId: bot.id });
      await go(page, `#/t/${th.id}`, 900);
      const t0 = Date.now();
      await send(page, 'Wat kost de dakkapel volgens de offerte? Antwoord in één zin.');
      // A local model can take minutes on a busy pc; an error shows at once (and is reported as what the owner sees).
      await until(() => tb.app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ?", th.id).length, 30_000, 500);
      await tb.idle(300_000);
      const final = tb.app.ctx.store.messages(th.id).filter((m) => m.role === 'assistant' && m.content).map((m) => m.content).join(' ');
      await page.waitForTimeout(800);
      const onScreen = (await mainText(page)).slice(-300);
      check('A-01', `live: antwoord van ${LIVE_MODEL} in ${((Date.now() - t0) / 1000).toFixed(0)} s`, !!final, final ? final.slice(0, 200) : `geen antwoord; op het scherm: ${onScreen}`);
      check('F-03', 'live: het antwoord noemt de prijs uit het Word-document (7450)', /7[.\s]?450/.test(final), final.slice(0, 200));
      await page.waitForTimeout(1500);
      check('F-09', 'live: de bron (het Word-document) staat onder het antwoord, ook als het lokale model niet citeert', (await page.locator('a[title*="offerte-dakkapel.docx"]').count()) > 0);
      await shot(page, 'live-ollama');
    });
  }
} catch (e) {
  check('suite', 'onverwachte fout', false, e?.stack || e?.message);
} finally {
  await browser.close().catch(() => {});
  await tb.close().catch(() => {});
  await ollama.close().catch(() => {});
  await new Promise((r) => fixture.close(() => r()));
  globalThis.fetch = realFetch;
  rmrf(dir, home, scratch);
}
check('suite', 'geen fouten in de console van de app', !errors.length, errors.slice(0, 6).join(' | '));
process.exit(summary('ACCEPTATIE 0.4 — deel 2 (F, N, G, D)'));
