// The model switcher on top of a chat, in a real browser with scripted AIs (no real model, nothing of this pc):
// the control in the chat header says which AI and model the bot is on; one click opens the list of every model of
// every connected AI (grouped, "Automatisch" on top, a search field, what it costs, a way to connect more); a pick is
// in the control at once and the next message really goes to that AI with that model, also on another AI (which gets
// the conversation so far), also after a reload; a turn that is running is not interrupted; a thinking level the new
// model does not take becomes the nearest it does. Once at desktop size as the owner on the computer, once at
// 402 × 874 as the owner's paired phone (device session, the sheet from the bottom). A group chat has no control.
// Then with programs (the fake Claude Code and Codex of the tests): the next turn runs on the program and model picked
// (also when Codex goes on in a session it already has), and a switch of AI puts aside what the new AI cannot take and
// brings it back with its AI, as the bot page does.
// Usage: npm run build:ui && node --import tsx tests/e2e/model-switch.mjs
//        (TEAMBOT_E2E_SHOTS=<dir> for screenshots, TEAMBOT_E2E_PORT=<port>, TEAMBOT_E2E_BROWSER=chrome|msedge)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 8000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(80)) {
    try {
      if (await fn()) return true;
    } catch {
      /* not there yet */
    }
  }
  return false;
};

// The browser first (it needs this pc's own environment), then TeamBot in an empty one: a temporary data folder and
// home, a free port, and nothing of this pc found or used (no Claude Code, Codex, OpenCode, Ollama, no %APPDATA%\TeamBot).
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-model-switch-home-'));
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_DATA_HOME: path.join(home, 'xdg', 'data'),
  XDG_CONFIG_HOME: path.join(home, 'xdg', 'config'),
  XDG_CACHE_HOME: path.join(home, 'xdg', 'cache'),
  PATH: path.dirname(process.execPath),
  TEAMBOT_TEST_NO_STARTER_RULES: '1',
});
delete process.env.Path;
delete process.env.TEAMBOT_DATA;

const { createApp } = await import('./server.mjs');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-model-switch-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const pcToken = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
for (const k of app.ctx.providers.kinds.values()) if (k.detect) k.detect = async () => ({ installed: false, detail: 'e2e' });
console.log(`• TeamBot op ${app.url} (lege datamap ${dir})`);

// ---------------------------------------------------------------- two scripted AIs; every request they get is kept
/** { kind, model, text: everything the AI was sent as conversation } */
const requests = [];
const slowDone = new Set();
const scripted = (id, label, billing, models, extra = {}) =>
  app.ctx.providers.registerKind({
    id,
    label,
    type: 'api',
    needsKey: false,
    description: 'e2e',
    billing,
    models: models.map((m) => m.id),
    defaultModel: models[0].id,
    ...extra,
    create: () => ({
      kind: id,
      async listModels() {
        if (extra.fail) throw new Error(extra.fail);
        // The first time takes seconds, as a CLI that reads its models after a start does.
        if (extra.slowFirstMs && !slowDone.has(id)) {
          slowDone.add(id);
          await new Promise((r) => setTimeout(r, extra.slowFirstMs));
        }
        return models;
      },
      async test() {
        return { ok: true, detail: 'e2e' };
      },
      async chat(req, signal, onEvent) {
        const text = req.messages.map((m) => (typeof m.content === 'string' ? m.content : m.content.map((p) => p.text || '').join(' '))).join('\n');
        const entry = { kind: id, model: req.model, reasoning: req.reasoning, text, done: false };
        requests.push(entry);
        const last = [...req.messages].reverse().find((m) => m.role === 'user');
        const said = typeof last?.content === 'string' ? last.content : '';
        // "langzaam": a turn that takes a while, to switch the model while it runs.
        if (/langzaam/.test(said)) await new Promise((r) => setTimeout(r, 2500));
        if (signal.aborted) throw new Error('Gestopt');
        const answer = `Antwoord ${requests.length} van ${req.model}.`;
        onEvent({ type: 'text', delta: answer });
        entry.done = true;
        return { text: answer, toolCalls: [], usage: { input: 10, output: 5 }, stop: 'end', model: req.model };
      },
    }),
  });
scripted('mock', 'Testmodel', 'local', [
  { id: 'mock-1', reasoningLevels: ['low', 'medium', 'high'] },
  { id: 'mock-2', reasoningLevels: ['low', 'medium'] },
]);
scripted('mock-b', 'Tweede AI', 'paid', [{ id: 'beta-1' }, { id: 'beta-2' }, { id: 'beta-3' }, { id: 'beta-4' }, { id: 'beta-5' }, { id: 'beta-6' }]);
scripted('mock-c', 'Derde AI', 'local', [{ id: 'gamma-1' }], { fail: 'ECONNREFUSED 127.0.0.1:9', models: undefined, defaultModel: undefined });
// An engine of the CLI kind (it picks its own model, so "Automatisch" always works) that is slow the first time.
scripted('mock-d', 'Trage AI', 'subscription', [{ id: 'traag-1' }, { id: 'traag-2' }], { type: 'cli', slowFirstMs: 4000, models: undefined, defaultModel: undefined });

const call = async (token, method, p, body, headers = {}) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}), ...headers }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  return { status: r.status, body: j };
};
const pc = async (method, p, body) => {
  const r = await call(pcToken, method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${r.body.error}`);
  return r.body;
};
const provA = await pc('POST', '/providers', { kind: 'mock' });
const provB = await pc('POST', '/providers', { kind: 'mock-b' });
const provC = await pc('POST', '/providers', { kind: 'mock-c' });
const provD = await pc('POST', '/providers', { kind: 'mock-d' });
const provOff = await pc('POST', '/providers', { kind: 'mock-b', name: 'Staat uit' });
await pc('PATCH', `/providers/${provOff.id}`, { enabled: false });
const mk = (name, extra = {}) => pc('POST', '/agents', { name, avatar: '🤖', role: 'Assistent', provider_id: provA.id, model: 'mock-1', access_mode: 'auto', ...extra });
const made = await pc('POST', '/rooms', { name: 'Redactie', agentIds: [(await mk('Ada')).id, (await mk('Bo')).id], mode: 'lead' }).catch((e) => ({ error: e.message }));

// The owner's phone, paired as the owner does it (a device session, with what a phone may and may not do).
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.4';
const ticket = await pc('POST', '/mobile/pair', { baseUrl: app.url });
const claimed = await call(null, 'POST', '/public/mobile/claim', { secret: new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t'), name: 'iPhone van de eigenaar', platform: 'ios', client: 'ios-app' }, { 'user-agent': IOS_UA });
const phoneToken = claimed.body.token;
check('telefoon: gekoppeld met een eigen apparaatsessie', (await call(phoneToken, 'GET', '/me')).body.session?.kind === 'device');

const errors = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  page.on('response', (r) => r.status() >= 400 && /\/api\//.test(r.url()) && errors.push(`${who}: ${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
};
const idle = (threadId) => until(() => !app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId).length, 15000);

/** One pass through the whole flow: `phone` = the paired phone at 402 × 874, else the computer at desktop size. */
async function pass(who, phone) {
  const say = (name, ok, detail) => check(`${who}: ${name}`, ok, detail);
  const bot = await mk(phone ? 'Mila' : 'Sam', { reasoning: 'high' });
  const thread = await pc('POST', '/threads', { agentId: bot.id });
  const agentNow = () => app.ctx.store.agent(bot.id);
  const ctx = phone
    ? await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IOS_UA, locale: 'nl-NL' })
    : await browser.newContext({ viewport: { width: 1360, height: 880 }, locale: 'nl-NL' });
  if (phone) {
    await ctx.addInitScript((t) => {
      try {
        if (localStorage.getItem('tb_token') !== t) {
          localStorage.removeItem('tb_urlkey');
          localStorage.setItem('tb_token', t);
        }
      } catch {}
    }, phoneToken);
  }
  const page = await ctx.newPage();
  watch(page, who);
  const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `model-switch-${phone ? 'telefoon' : 'desktop'}-${name}.png`) });
  const press = (loc) => (phone ? loc.tap() : loc.click());
  await page.goto(phone ? `${app.url}/#/t/${thread.id}` : `${app.url}/#token=${pcToken}`);
  if (!phone) {
    await page.waitForTimeout(800);
    await page.evaluate((h) => (location.hash = h), `#/t/${thread.id}`);
  }
  const control = page.getByTestId('model-switch');
  await control.waitFor({ timeout: 15000 });
  const label = async () => (await control.innerText()).replace(/\s+/g, ' ').trim();
  // What is on screen: on a narrow header the AI's name is left out, the model stays.
  const shownLabel = () =>
    control.evaluate((b) => {
      const walk = (n) => (n.nodeType === 3 ? n.textContent : n.nodeType === 1 && getComputedStyle(n).display !== 'none' ? [...n.childNodes].map(walk).join('') : '');
      return walk(b).replace(/\s+/g, ' ').trim();
    });
  const menu = page.getByTestId('model-menu');
  const row = (provider, model) => menu.locator(`[data-provider="${provider}"] [data-model-row][data-model="${model}"]`);
  const open = async () => {
    await press(control);
    await menu.waitFor({ timeout: 8000 });
    await menu.locator('[data-model-row]').first().waitFor({ timeout: 15000 });
  };
  const send = async (text) => {
    const n = requests.length;
    const box = page.getByRole('textbox', { name: 'Bericht' });
    await box.fill(text);
    if (phone) await page.getByRole('button', { name: 'Versturen' }).tap();
    else await box.press('Enter');
    await until(() => requests.length > n);
    return requests[n];
  };
  const fits = () =>
    page.evaluate(() => {
      const head = document.querySelector('#inhoud header') || document.querySelector('header');
      const vw = window.innerWidth;
      const out = [...head.querySelectorAll('button, a, h1')].map((e) => ({ e, r: e.getBoundingClientRect() })).filter(({ e, r }) => r.width > 0 && !e.classList.contains('sr-only') && (r.left < -0.5 || r.right > vw + 0.5));
      const name = head.querySelector('button[aria-label^="Gesprekken met"] span');
      const pill = head.querySelector('[data-testid="model-switch"]');
      const text = pill?.querySelector('.truncate');
      return {
        overflow: document.documentElement.scrollWidth - vw,
        outside: out.map(({ e }) => e.getAttribute('aria-label') || e.textContent.trim()),
        nameWidth: name ? Math.round(name.getBoundingClientRect().width) : 0,
        nameCut: name ? name.scrollWidth > name.clientWidth + 1 : true,
        controlWidth: pill ? Math.round(pill.getBoundingClientRect().width) : 0,
        controlCut: text ? text.scrollWidth > text.clientWidth + 1 : true,
      };
    });

  // ---- the control
  say('de knop bovenin zegt op welk model de bot staat', phone ? (await shownLabel()) === 'mock-1' : (await shownLabel()) === 'Testmodel · mock-1', await shownLabel());
  say('de knop noemt de AI en het model voor een schermlezer', /^Testmodel · mock-1 — Model wijzigen$/.test((await control.getAttribute('aria-label')) || ''), (await control.getAttribute('aria-label')) || '');
  let f = await fits();
  say('de kop past: niets valt buiten het scherm, de naam van de bot en het model staan er helemaal', f.overflow <= 0 && !f.outside.length && !f.nameCut && !f.controlCut, JSON.stringify(f));
  if (phone) {
    const box = await control.boundingBox();
    say('de knop is groot genoeg om te tikken (44 px hoog)', box.height >= 43.5 && box.width >= 43.5, `${Math.round(box.width)}×${Math.round(box.height)}`);
  }
  await page.waitForTimeout(300);
  await shot('kop');

  // ---- the list
  await open();
  if (!phone) {
    // The very first look after a start: one AI still reads its models. The list does not wait for it.
    const slowGroup = menu.locator(`[data-provider="${provD.id}"]`);
    const early = { text: (await slowGroup.innerText()).replace(/\s+/g, ' '), rows: await slowGroup.locator('[data-model-row]').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-model'))), others: await row(provB.id, 'beta-6').count() };
    say('een AI die zijn modellen nog leest houdt de lijst niet op: de rest staat er, bij die AI staat "Modellen laden…" en Automatisch kan al', /Modellen laden/.test(early.text) && early.rows.join(',') === '' && early.rows.length === 1 && early.others === 1, JSON.stringify(early));
    await row(provD.id, 'traag-2').waitFor({ timeout: 12000 });
    say('zodra die AI klaar is, staan zijn modellen erbij', !/Modellen laden/.test(await slowGroup.innerText()) && (await slowGroup.locator('[data-model-row]').count()) === 3);
  }
  const groups = await menu.locator('[role="group"]').evaluateAll((gs) => gs.map((g) => [...g.firstElementChild.children].map((c) => c.textContent.trim()).join(' ')));
  say('de lijst: per gekoppelde AI een groep met wat het kost; een AI die uit staat ontbreekt', groups.join(' | ') === 'Testmodel · lokaal, gratis | Tweede AI · betaald | Derde AI · lokaal, gratis | Trage AI · abonnement', groups.join(' | '));
  const first = await menu.locator('[data-model-row]').first().innerText();
  say('"Automatisch" staat bovenaan', /^Automatisch/.test(first.trim()), first.replace(/\s+/g, ' '));
  say('het huidige model is aangevinkt', (await menu.locator('[aria-selected="true"]').getAttribute('data-model')) === 'mock-1');
  say('een AI die nu niet bereikbaar is, staat er met die melding en zonder modellen', /Niet bereikbaar/.test(await menu.locator(`[data-provider="${provC.id}"]`).innerText()) && (await menu.locator(`[data-provider="${provC.id}"] [data-model-row]`).count()) === 0);
  const more = page.getByRole('link', { name: "Meer AI's koppelen" });
  say('één rustige regel naar de pagina waar je een AI koppelt', (await more.getAttribute('href')) === '#/settings/providers');
  const place = await page.getByRole('dialog', { name: 'Model' }).evaluate((d) => {
    const r = d.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), vw: window.innerWidth, vh: window.innerHeight };
  });
  if (phone) say('de lijst opent als blad van onderaf, over de hele breedte', place.left === 0 && place.right === place.vw && place.bottom === place.vh && place.top > 60, JSON.stringify(place));
  else say('de lijst opent als venster onder de knop, binnen het scherm', place.left >= 0 && place.right <= place.vw && place.bottom <= place.vh && place.right - place.left <= 360, JSON.stringify(place));
  await page.waitForTimeout(300);
  await shot('lijst');
  const search = menu.getByRole('textbox', { name: 'Zoek een model' });
  say('een zoekveld bij een lange lijst', (await search.count()) === 1);
  await search.fill('tweede beta-2');
  await until(async () => (await menu.locator('[data-model-row]').count()) === 1);
  const hits = await menu.locator('[data-model-row]').evaluateAll((rs) => rs.map((r) => r.getAttribute('data-model')));
  say('zoeken vindt op de naam van de AI en het model', hits.join(',') === 'beta-2', hits.join(','));
  await search.fill('');

  // ---- another model of the same AI
  await press(row(provA.id, 'mock-2'));
  await until(async () => /mock-2/.test(await label()));
  await until(async () => (await menu.count()) === 0, 3000);
  say('kiezen: de knop zegt meteen het nieuwe model, de lijst is dicht', /mock-2$/.test(await shownLabel()) && (await menu.count()) === 0, await shownLabel());
  await until(() => agentNow().model === 'mock-2');
  say('bewaard op de bot: AI en model samen', agentNow().provider_id === provA.id && agentNow().model === 'mock-2');
  if (!phone) {
    // The usage button next to the message box names the model too: it follows without a new message.
    const chip = page.locator('button[aria-label$="gebruik en limieten"]');
    await until(async () => /mock-2/.test(await chip.innerText()), 3000);
    say('de modelnaam naast het invoerveld volgt meteen mee', /mock-2/.test(await chip.innerText()), (await chip.innerText()).trim());
  }
  say('denkniveau "hoog" kent het nieuwe model niet: het dichtstbijzijnde (middel) is gekozen', agentNow().reasoning === 'medium', agentNow().reasoning);
  let r = await send('Eerste vraag over de offerte.');
  say('het volgende bericht gaat naar het nieuwe model', r?.kind === 'mock' && r?.model === 'mock-2', JSON.stringify({ kind: r?.kind, model: r?.model }));
  await page.locator('[id^="m-"]').getByText(/van mock-2\./).waitFor({ timeout: 15000 });
  await idle(thread.id);

  // ---- another AI
  await open();
  await press(row(provB.id, 'beta-2'));
  await until(async () => /beta-2/.test(await label()));
  say('een andere AI: de knop zegt de nieuwe AI en het model', phone ? (await shownLabel()) === 'beta-2' : (await shownLabel()) === 'Tweede AI · beta-2', await shownLabel());
  await until(() => agentNow().model === 'beta-2');
  say('een model zonder denkniveaus: het denkniveau staat weer op standaard', agentNow().provider_id === provB.id && agentNow().reasoning === '', JSON.stringify(agentNow().reasoning));
  r = await send('Tweede vraag, aan de andere AI.');
  say('het volgende bericht gaat naar de andere AI met dat model', r?.kind === 'mock-b' && r?.model === 'beta-2', JSON.stringify({ kind: r?.kind, model: r?.model }));
  say('de andere AI krijgt het gesprek tot nu toe mee', /Eerste vraag over de offerte\./.test(r?.text || '') && /van mock-2\./.test(r?.text || '') && /Tweede vraag, aan de andere AI\./.test(r?.text || ''), (r?.text || '').replace(/\s+/g, ' ').slice(0, 160));
  await page.locator('[id^="m-"]').getByText(/van beta-2\./).waitFor({ timeout: 15000 });
  await idle(thread.id);

  // ---- after a reload (the phone: with a long bot name, to see who gives way in the narrow header)
  if (phone) await pc('PATCH', `/agents/${bot.id}`, { name: 'Boekhouder Noor' });
  await page.reload();
  await control.waitFor({ timeout: 15000 });
  await until(async () => /beta-2/.test(await label()));
  say('na opnieuw laden zegt de knop nog steeds het nieuwe model', phone ? (await shownLabel()) === 'beta-2' : (await shownLabel()) === 'Tweede AI · beta-2', await shownLabel());
  f = await fits();
  if (phone) say('een lange botnaam op de telefoon: niets valt buiten het scherm, de naam houdt ruimte en het model staat er helemaal', f.overflow <= 0 && !f.outside.length && f.nameWidth >= 28 && f.controlWidth >= 44 && !f.controlCut, JSON.stringify(f));
  else say('de kop past ook met de andere AI', f.overflow <= 0 && !f.outside.length && !f.nameCut && !f.controlCut, JSON.stringify(f));
  await shot('andere-ai');

  // ---- a turn that is running is not interrupted
  const slow = send('Doe dit langzaam.');
  await until(() => requests.at(-1)?.text.includes('Doe dit langzaam.') && !requests.at(-1).done);
  const running = requests.at(-1);
  await open();
  say('de AI waar de bot op staat, staat nu bovenaan in de lijst', (await menu.locator('[role="group"]').first().getAttribute('data-provider')) === provB.id);
  await press(row(provB.id, 'beta-3'));
  await until(async () => /beta-3/.test(await label()));
  await until(async () => (await page.getByText('Geldt vanaf je volgende bericht.').count()) > 0, 4000);
  say('wisselen terwijl de bot werkt: de knop wisselt, met één regel dat het vanaf het volgende bericht geldt', /beta-3/.test(await label()) && (await page.getByText('Geldt vanaf je volgende bericht.').count()) > 0);
  await slow;
  await until(() => running.done, 8000);
  await idle(thread.id);
  const runs = app.ctx.store.all('SELECT status FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', thread.id);
  say('de lopende beurt is niet onderbroken en maakte zijn antwoord af op het oude model', running.done && running.model === 'beta-2' && runs[0]?.status === 'done', JSON.stringify({ done: running.done, model: running.model, run: runs[0]?.status }));
  r = await send('En nu verder.');
  say('het bericht daarna gaat naar het nieuwe model', r?.kind === 'mock-b' && r?.model === 'beta-3', JSON.stringify({ kind: r?.kind, model: r?.model }));
  await idle(thread.id);

  // ---- Automatisch: the AI picks
  await open();
  await press(menu.locator('[data-model-row]').first());
  await until(async () => /Automatisch/.test(await label()));
  say('"Automatisch": de knop zegt het, er is geen model meer bewaard', (phone ? (await shownLabel()) === 'Automatisch' : (await shownLabel()) === 'Tweede AI · Automatisch') && (await until(() => agentNow().model === '')) && agentNow().provider_id === provB.id, await shownLabel());
  r = await send('Wie kiest er nu?');
  say('op Automatisch draait het eigen standaardmodel van die AI', r?.kind === 'mock-b' && r?.model === 'beta-1', JSON.stringify({ kind: r?.kind, model: r?.model }));
  await idle(thread.id);
  if (phone) {
    // The longest word the control can say, next to a short name again.
    await pc('PATCH', `/agents/${bot.id}`, { name: 'Mila' });
    await page.reload();
    await control.waitFor({ timeout: 15000 });
    await until(async () => /Automatisch/.test(await label()));
    f = await fits();
    say('"Automatisch" op de telefoon: het woord en de naam van de bot staan er helemaal, niets valt buiten het scherm', f.overflow <= 0 && !f.outside.length && !f.nameCut && !f.controlCut, JSON.stringify(f));
    await shot('automatisch');
  }

  // ---- closing without a choice
  await open();
  if (phone) await page.getByRole('dialog', { name: 'Model' }).getByRole('button', { name: 'Sluiten' }).tap();
  else await page.keyboard.press('Escape');
  await until(async () => (await menu.count()) === 0, 3000);
  say(phone ? 'sluiten zonder te kiezen laat alles zoals het was' : 'Escape sluit zonder te kiezen; de focus staat weer op de knop', (await menu.count()) === 0 && agentNow().model === '' && (phone || (await control.evaluate((b) => b === document.activeElement))));
  if (!phone) {
    // Keyboard: open, type, Enter picks the first hit.
    await control.focus();
    await page.keyboard.press('Enter');
    await search.waitFor({ timeout: 8000 });
    await until(() => search.evaluate((e) => e === document.activeElement), 3000);
    await page.keyboard.type('testmodel mock-1');
    await page.keyboard.press('Enter');
    await until(() => agentNow().model === 'mock-1');
    say('met het toetsenbord: openen, typen, Enter kiest de eerste treffer', agentNow().provider_id === provA.id && agentNow().model === 'mock-1' && (await shownLabel()) === 'Testmodel · mock-1', await shownLabel());
    // A narrow window (the chat next to a docked panel is about this wide): only the model, and the header still fits.
    await page.setViewportSize({ width: 900, height: 800 });
    await page.waitForTimeout(400);
    f = await fits();
    say('smal venster op de computer: de knop toont alleen het model en de kop past', (await shownLabel()) === 'mock-1' && f.overflow <= 0 && !f.outside.length && !f.nameCut && !f.controlCut, `${await shownLabel()} ${JSON.stringify(f)}`);
    await shot('smal');
    await page.setViewportSize({ width: 1360, height: 880 });
    await page.waitForTimeout(300);
  }

  // ---- a group chat keeps its header as it was
  if (made.threadId) {
    await page.evaluate((h) => (location.hash = h), `#/t/${made.threadId}`);
    await page.getByRole('textbox', { name: 'Bericht' }).waitFor({ timeout: 10000 });
    await page.waitForTimeout(500);
    say('een groepschat heeft geen modelknop (de kop noemt de bots daar niet bij naam)', (await page.getByTestId('model-switch').count()) === 0);
  } else say('groepschat aangemaakt voor de controle', false, made.error || '');
  await ctx.close();
}

/**
 * The same control with programs (the fake Claude Code and Codex of the tests): the next turn really runs on the
 * program and the model picked, also when Codex goes on in the session it already has in this chat; and a switch of AI
 * follows the rule of the bot page (agentRows.ts aiPick): what the new AI cannot take ("Alleen chat", the extra flags of
 * Claude Code) is put aside and comes back with the AI it belongs to.
 */
async function engines() {
  const say = (name, ok, detail) => check(`programma's: ${name}`, ok, detail);
  const log = path.join(home, 'fake-cli.jsonl');
  process.env.FAKE_CLI_LOG = log;
  process.env.FAKE_CODEX_MODELS = 'gpt-a,gpt-b';
  const lines = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const fixture = (n) => fileURLToPath(new URL(`../fixtures/${n}`, import.meta.url));
  const claude = await pc('POST', '/providers', { kind: 'claude-code', config: { path: fixture('cli-agents-fake-claude.mjs') } });
  const codex = await pc('POST', '/providers', { kind: 'codex-cli', config: { path: fixture('cli-agents-fake-codex.mjs') } });
  const pending = () => app.ctx.store.all("SELECT id FROM approvals WHERE status = 'pending'");
  // A Codex turn at "Vraagt toestemming" asks to write a file: the owner says no, and the turn ends.
  const denyAll = async (threadId) => {
    for (const end = Date.now() + 20_000; Date.now() < end; await sleep(100)) {
      for (const a of pending()) await pc('POST', `/approvals/${a.id}`, { decision: 'deny' });
      if (!app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId).length) return;
    }
  };

  const ctx = await browser.newContext({ viewport: { width: 1360, height: 880 }, locale: 'nl-NL' });
  const page = await ctx.newPage();
  watch(page, 'programma');
  await page.goto(`${app.url}/#token=${pcToken}`);
  await page.waitForTimeout(800);
  const control = page.getByTestId('model-switch');
  const menu = page.getByTestId('model-menu');
  const row = (provider, model) => menu.locator(`[data-provider="${provider}"] [data-model-row][data-model="${model}"]`);
  const pick = async (provider, model) => {
    await control.click();
    await menu.waitFor({ timeout: 8000 });
    await row(provider, model).waitFor({ timeout: 20_000 });
    await row(provider, model).click();
  };
  const send = async (threadId, text) => {
    const n = lines().length;
    const runs = () => app.ctx.store.all('SELECT id FROM runs WHERE thread_id = ?', threadId).length;
    const before = runs();
    const box = page.getByRole('textbox', { name: 'Bericht' });
    await box.fill(text);
    await box.press('Enter');
    await until(() => runs() > before, 8000);
    await denyAll(threadId);
    await idle(threadId);
    return lines().slice(n);
  };
  /** How the last turn of a thread ended, for a check that fails. */
  const lastRun = (threadId) => {
    const r = app.ctx.store.one('SELECT status, error FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', threadId);
    const m = app.ctx.store.all('SELECT role, content FROM messages WHERE thread_id = ? ORDER BY created_at DESC LIMIT 4', threadId);
    return JSON.stringify({ run: r?.status, error: String(r?.error || '').slice(0, 300), said: m.map((x) => `${x.role}: ${String(x.content || '').slice(0, 160)}`), log: lines().map((l) => l.method || l.mode || (l.argv || []).slice(0, 2).join(' ')).join(',') });
  };
  const open = async (threadId) => {
    await page.evaluate((h) => (location.hash = h), `#/t/${threadId}`);
    await control.waitFor({ timeout: 15_000 });
  };

  // ---- Claude Code at "Alleen chat" with its own extra flags → Codex, model gpt-a, in the chat.
  const cas = await pc('POST', '/agents', { name: 'Cas', avatar: '🤖', role: 'Assistent', provider_id: claude.id, model: 'sonnet', access_mode: 'chat', reasoning: 'high' });
  // (The fake programs say their week is 86% and 97% used: with "Bij een gebruikslimiet: wachten" the bot stays on the
  // program picked instead of going on with another AI of the chain.)
  await pc('PATCH', `/agents/${cas.id}`, { settings: { ...(cas.settings || {}), onLimit: 'wait', cli: { extraArgs: ['--fallback-model', 'haiku'] } } });
  const casNow = () => app.ctx.store.agent(cas.id);
  const t1 = await pc('POST', '/threads', { agentId: cas.id });
  await open(t1.id);
  await pick(codex.id, 'gpt-a');
  await until(() => casNow().provider_id === codex.id && casNow().model === 'gpt-a');
  let a = casNow();
  say(
    'naar Codex: "Alleen chat" kan daar niet en wordt Alleen lezen; chat, de extra vlaggen van Claude Code en het model van Claude Code staan opzij',
    a.access_mode === 'readonly' && a.settings?.kept?.access === 'chat' && !a.settings?.cli?.extraArgs && a.settings?.kept?.extraArgs?.['claude-code']?.join(' ') === '--fallback-model haiku' && a.settings?.kept?.models?.[claude.id] === 'sonnet',
    JSON.stringify({ access: a.access_mode, settings: a.settings }),
  );
  let got = await send(t1.id, 'Eerste vraag aan Codex.');
  const cx1 = got.filter((l) => l.cli === 'codex' && Array.isArray(l.argv) && l.argv[0] === 'exec');
  say('de volgende beurt draait op Codex met gpt-a', cx1.length === 1 && cx1[0].argv.join(' ').includes('-m gpt-a') && !got.some((l) => l.cli === 'claude' && l.argv), cx1.map((l) => l.argv.join(' ')).join(' | ') || lastRun(t1.id));

  // ---- back to Claude Code, model haiku: "Alleen chat" and the flags are back.
  await pick(claude.id, 'haiku');
  await until(() => casNow().provider_id === claude.id && casNow().model === 'haiku');
  a = casNow();
  say('terug naar Claude Code (haiku): weer "Alleen chat" met de eigen extra vlaggen, niets meer opzij', a.access_mode === 'chat' && a.settings?.cli?.extraArgs?.join(' ') === '--fallback-model haiku' && !a.settings?.kept?.access && !a.settings?.kept?.extraArgs, JSON.stringify({ access: a.access_mode, settings: a.settings }));
  got = await send(t1.id, 'En nu weer aan Claude.');
  const cl = got.filter((l) => l.cli === 'claude' && Array.isArray(l.argv) && l.prompt !== '/model');
  const argv = cl.at(-1)?.argv || [];
  const flag = (f) => (argv.includes(f) ? argv[argv.indexOf(f) + 1] : undefined);
  say('de volgende beurt draait op Claude Code met haiku, zonder tools (Alleen chat) en met de extra vlaggen', flag('--model') === 'haiku' && flag('--tools') === '' && flag('--fallback-model') === 'haiku', argv.join(' '));
  // The bot page shows the same as after a switch made there (tests/e2e/agent-page-per-ai.mjs).
  await page.evaluate((h) => (location.hash = h), `#/agents/${cas.id}`);
  const level = page.locator('[data-testid="access-choice"] [role="combobox"]');
  await level.waitFor({ timeout: 15_000 });
  const aiShown = (await page.locator('[data-row="ai"] [role="combobox"]').first().innerText().catch(() => '')).trim();
  say('de botpagina zegt hetzelfde: Claude Code, Alleen chat', (await level.innerText()).trim() === 'Alleen chat' && aiShown === claude.name, `${aiShown} · ${(await level.innerText()).trim()}`);

  // ---- Codex goes on in the session it already has: the next turn still takes the model picked now.
  const dex = await pc('POST', '/agents', { name: 'Dex', avatar: '🤖', role: 'Assistent', provider_id: codex.id, model: 'gpt-a', access_mode: 'ask' });
  await pc('PATCH', `/agents/${dex.id}`, { settings: { ...(dex.settings || {}), onLimit: 'wait' } });
  const t2 = await pc('POST', '/threads', { agentId: dex.id });
  await open(t2.id);
  got = await send(t2.id, 'Eerste vraag.');
  const start = got.find((l) => l.cli === 'codex' && l.method === 'thread/start');
  say('Codex bij Vraagt toestemming: een nieuwe sessie met gpt-a', start?.params?.model === 'gpt-a', JSON.stringify(start?.params?.model));
  await pick(codex.id, 'gpt-b');
  await until(() => app.ctx.store.agent(dex.id).model === 'gpt-b');
  got = await send(t2.id, 'Tweede vraag, op het andere model.');
  const resumed = got.find((l) => l.cli === 'codex' && l.method === 'thread/resume');
  const turn = got.filter((l) => l.cli === 'codex' && l.method === 'turn/start').at(0);
  say('na de wissel naar gpt-b gaat Codex verder in dezelfde sessie, en die beurt draait op gpt-b', !!resumed && !got.some((l) => l.method === 'thread/start') && (turn?.params?.model === 'gpt-b' || resumed?.params?.model === 'gpt-b'), JSON.stringify({ calls: got.filter((l) => l.cli === 'codex').map((l) => l.method || l.mode || 'exec'), resume: resumed?.params?.model ?? null, turn: turn?.params?.model ?? null }) + (resumed ? '' : ` ${lastRun(t2.id)}`));
  delete process.env.FAKE_CLI_LOG;
  delete process.env.FAKE_CODEX_MODELS;
  await ctx.close();
}

try {
  await pass('desktop', false);
  await pass('telefoon', true);
  await engines();
  check('geen fouten in de console en geen geweigerde verzoeken (de telefoon mag de lijst lezen en het model wijzigen)', errors.length === 0, errors.slice(0, 5).join(' | '));
} catch (e) {
  check('de controle liep door tot het einde', false, e?.stack || String(e));
} finally {
  await browser.close();
  await app.close();
  for (const d of [dir, home]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* left in the temp folder */
    }
  }
}
const failed = results.filter((x) => !x).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
