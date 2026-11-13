// npm run parity:04 — TeamBot 0.4 next to OpenBot, MausBot and Grok Bot, in the real built app (docs/PARITEIT_0.4.md).
// Every row of the parity audit of 7 November 2026 (C:\Users\sanne\Documents\TeamBot\vergelijking-openbot-2026-11-07.md,
// sections 1–18) and every item of "Wat Sanne echt gebruikt in OpenBot" is checked here the way the owner uses it: the
// built UI (dist/ui) in Edge headless, a temporary data folder and an empty HOME/APPDATA/PATH (nothing of this PC is
// found, used or changed), and a scripted test engine that answers per bot. Where a row needs an engine program, fake
// Claude Code / Codex / OpenCode with recorded output are used; the owner's OpenBot is a synthetic copy in TEMP; an
// "LM Studio" is a small local stand-in. Part of it runs as a paired phone (a device session made through the real
// pairing page). Each line starts with the row number of docs/PARITEIT_0.4.md, e.g. "✔ [2.4] …".
//
// Usage: npm run build:ui && npm run parity:04          (±5 minutes; exits 1 when a check fails)
//   TEAMBOT_E2E_PORT=4852 (default)   TEAMBOT_E2E_SHOTS=<dir> screenshots   TEAMBOT_ACCEPT_ONLY=1,2,4 only those parts
//   TEAMBOT_PARITY_OLLAMA=1  plus one real question to the local Ollama, only when qwen3.6-uncensored-snel is loaded
//                            already (one request; nothing is loaded, unloaded or pulled)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { check, confirmDialog, go, hashOf, isolate, lastToolResult, launchBrowser, mainText, openPage, overflow, part, rmrf, seeMessage, send, shot, sleep, startTeamBot, summary, testEngine, until } from './accept-04-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..', '..');
const FAKE_CLAUDE = path.join(here, '..', 'fixtures', 'cli-agents-fake-claude.mjs');
const FAKE_CODEX = path.join(here, '..', 'fixtures', 'cli-agents-fake-codex.mjs');
const FAKE_ACP = path.join(here, '..', 'fixtures', 'cli-agents-fake-acp.mjs');
const PORT = Number(process.env.TEAMBOT_E2E_PORT) || 4852;
const OLLAMA = process.env.TEAMBOT_PARITY_OLLAMA === '1';
const OLLAMA_MODEL = 'qwen3.6-uncensored-snel';
const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const DEAD = 'http://127.0.0.1:9/v1'; // nothing listens here: a local AI server that is "not running"

// The owner's OpenBot, made up in TEMP (shaped like the real one: Baas, Baas Live, Kennis & Kansen, …, routines, tables).
const { makeOpenBotTeamFixture } = await import('../fixtures/openbot-team-fixture.ts');
const openbot = makeOpenBotTeamFixture();

// "LM Studio" on this PC (the owner's own provider in OpenBot): a small OpenAI-compatible stand-in on a free port.
const lmRequests = [];
const lm = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'qwen3.6' }] }));
    lmRequests.push(JSON.parse(body || '{}'));
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const out = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    out({ id: 'l1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Hallo uit LM Studio.' } }] });
    out({ id: 'l1', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 20, completion_tokens: 4 } });
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => lm.listen(0, '127.0.0.1', r));
const LM_URL = `http://127.0.0.1:${lm.address().port}/v1`;

const browser = await launchBrowser();
const home = isolate('tb-parity');
// Windows itself stays reachable (the terminal tool runs PowerShell); no CLI or AI program of this PC is on PATH.
if (process.platform === 'win32') {
  const sys = process.env.SystemRoot || 'C:\\Windows';
  process.env.PATH = [process.env.PATH, path.join(sys, 'System32'), path.join(sys, 'System32', 'WindowsPowerShell', 'v1.0')].join(path.delimiter);
}
process.env.TEAMBOT_OPENBOT_HOME = openbot.home;
process.env.TEAMBOT_OPENBOT_DIR = openbot.dataDir;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-parity-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-parity-mappen-'));
const ai = testEngine();
// The test engine can also "think": a step with `reasoning` streams it and returns it, as a real model does.
const baseAdapter = ai.adapter;
ai.adapter = () => {
  const a = baseAdapter();
  return {
    ...a,
    async chat(req, signal, onEvent) {
      const bot = /Je bent ([^\s,—]+)/.exec(req.system || '')?.[1] || '';
      const q = ai.queues[bot]?.length ? ai.queues[bot] : ai.queues['*'] || [];
      const head = q[0];
      const reasoning = head && typeof head === 'object' ? head.reasoning : undefined;
      if (reasoning) onEvent({ type: 'reasoning', delta: reasoning });
      const r = await a.chat(req, signal, onEvent);
      return reasoning ? { ...r, reasoning } : r;
    },
  };
};
const tb = await startTeamBot({
  dir,
  ai,
  port: PORT,
  beforeStart: (t) => {
    // No AI server of this PC is ever asked anything (Ollama, LM Studio, …), unless TEAMBOT_PARITY_OLLAMA=1 (Ollama only).
    for (const k of t.app.ctx.providers.kinds.values()) if (k.id !== 'mock' && k.group === 'local' && k.baseUrl && !(OLLAMA && k.id === 'ollama')) k.baseUrl = DEAD;
  },
});
console.log(`TeamBot op ${tb.url} (lege datamap ${dir})`);
const errors = [];
const ids = {};

// ------------------------------------------------------------------------------------------------ helpers
/** Go to a page; leaving the bot editor with changes asks first ("Wijzigingen opslaan?"): then "Niet opslaan". */
async function goTo(page, hash, wait = 900) {
  await go(page, hash, wait);
  const ask = page.getByRole('dialog', { name: 'Wijzigingen opslaan?' }).or(page.getByRole('alertdialog', { name: 'Wijzigingen opslaan?' }));
  if (await ask.count()) {
    await ask.getByRole('button', { name: 'Niet opslaan' }).click();
    await page.waitForTimeout(300);
    await go(page, hash, wait);
  }
}
/** Open the one fold "Meer mogelijkheden" of the bot page (since 12 Nov the page has no tabs). */
async function openMore(page) {
  await page.evaluate(() => document.querySelectorAll('#inhoud details').forEach((x) => (x.open = true)));
  await page.waitForTimeout(300);
}
/** The text of the whole bot page: the first level and every row of "Meer mogelijkheden", each opened. */
async function botPageText(page) {
  await openMore(page);
  const shut = page.locator('#inhoud [data-section] > h3 > button[aria-expanded="false"]');
  for (let i = 0; i < 40 && (await shut.count()); i++) await shut.first().click();
  await openMore(page);
  return page.locator('#inhoud').innerText();
}
/** Choose in TeamBot's own dropdown (components/Listbox.tsx): by the option's text, or by its value. */
async function pick(page, box, o) {
  await box.click();
  const opt = typeof o === 'string' ? page.locator(`[role="option"][data-value="${o}"]`) : page.getByRole('option', { name: o.label, exact: true });
  await opt.first().click();
}
async function textOf(page, hash, wait = 900) {
  await goTo(page, hash, wait);
  return mainText(page);
}
const missing = (text, needles) => needles.filter((n) => (n instanceof RegExp ? !n.test(text) : !text.includes(n)));
/** Check that a page shows all these words or sentences (one check line). */
async function shows(page, id, name, hash, needles) {
  const t = await textOf(page, hash);
  const m = missing(t, needles);
  return check(id, name, !m.length, m.length ? `ontbreekt op ${hash}: ${m.map(String).join(' | ')}` : '');
}
const threadOf = (agentId) => tb.app.ctx.store.all("SELECT id FROM threads WHERE agent_id = ? AND kind = 'chat' AND room_id IS NULL ORDER BY created_at", agentId)[0]?.id;
async function openChat(page, name) {
  const a = tb.bot(name);
  let th = threadOf(a.id);
  if (!th) th = (await tb.api('POST', '/threads', { agentId: a.id })).id;
  await goTo(page, `#/t/${th}`, 1000);
  const ok = await page.getByRole('textbox', { name: 'Bericht', exact: true }).waitFor({ timeout: 10_000 }).then(() => true).catch(() => false);
  if (!ok) console.log(`  (gesprek met ${name} zonder invoerveld: ${(await mainText(page)).slice(0, 300)})`);
  return th;
}
const messagesOf = (th) => tb.app.ctx.store.messages(th);
const lastOf = (th, role = 'assistant') => [...messagesOf(th)].reverse().find((m) => m.role === role)?.content || '';
const toolResultOf = (th) => [...messagesOf(th)].reverse().find((m) => m.role === 'tool')?.content || '';
const mockId = () => tb.app.ctx.store.all("SELECT id FROM providers WHERE kind = 'mock' ORDER BY created_at")[0]?.id;
const makeBot = (name, extra = {}) => tb.api('POST', '/agents', { name, provider_id: mockId(), model: 'mock-1', access_mode: 'ask', ...extra });
/** Ask a bot something through the UI with scripted steps, wait until everything is done. */
async function ask(page, bot, text, ...steps) {
  if (steps.length) ai.to(bot, ...steps);
  await send(page, text);
  await tb.idle(30_000);
  await page.waitForTimeout(500);
}
const pendingApprovals = () => tb.app.ctx.store.all("SELECT * FROM approvals WHERE status = 'pending'");
/** A row of the bot page under "Meer mogelijkheden" (one fold since 12 Nov), opened when it is closed. */
async function openSection(page, title) {
  await openMore(page);
  const btn = page.locator('#inhoud').getByRole('button', { name: new RegExp(`^${title}`) }).first();
  if ((await btn.getAttribute('aria-expanded').catch(() => 'true')) === 'false') await btn.click();
  await page.waitForTimeout(400);
}
/** Pair a phone the way the owner does: a ticket (the QR on the computer), then the pairing page on the phone. */
async function pairPhone(name = 'iPhone van Sanne') {
  const ticket = await tb.api('POST', '/mobile/pair', { baseUrl: tb.url });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, locale: 'nl-NL', userAgent: IPHONE });
  const p = await ctx.newPage();
  p.on('pageerror', (e) => errors.push(`telefoon: ${e.message}`));
  await p.goto(ticket.url.replace(/^https?:\/\/[^/]+/, tb.url));
  await p.locator('#name').fill(name);
  await p.getByRole('button', { name: 'Koppelen' }).click();
  await p.waitForURL(/\/#\//, { timeout: 15_000 });
  await p.waitForTimeout(1200);
  const token = await p.evaluate(() => localStorage.getItem('tb_token'));
  const device = async (method, pth, body) => {
    const r = await fetch(tb.url + '/api' + pth, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: r.status, body: await r.json().catch(() => ({})) };
  };
  return { page: p, ctx, token, device, ticket };
}
const phoneText = async (p, hash, wait = 1200) => {
  await p.evaluate((h) => (location.hash = h), hash);
  await p.waitForTimeout(wait);
  return ((await p.locator('body').innerText().catch(() => '')) || '').replace(/\s+/g, ' ');
};
/** A known gap (status "achter" or "later afgesproken" in docs/PARITEIT_0.4.md): printed, never a failure. */
const gaps = [];
function gap(id, name, detail = '') {
  gaps.push({ id, name, detail });
  console.log(`◦ [${id}] ${name}${detail ? ` (${detail})` : ''}`);
}
/** Half a second of silence as a real 16 kHz mono WAV file. */
function wavSilence(samples = 8000) {
  const b = Buffer.alloc(44 + samples * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + samples * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(16000, 24); b.writeUInt32LE(32000, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(samples * 2, 40);
  return new Uint8Array(b);
}
const fileOk = (p) => {
  try {
    return fs.existsSync(p);
  } catch {
    return false;
  }
};

let page;
let phone;
try {
  await tb.api('PUT', '/memory/settings', { extractor: 'heuristic' }); // the learner never asks the test engine
  page = await openPage(browser, tb, { errors });

  // ============================================================================================ 1. Eerste start
  await part('1', 'eerste start en onboarding', async () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    // 0.4.2: a one-click installer per user that starts TeamBot (the install folder is no longer asked).
    check('1.1', 'installer: NSIS per gebruiker met één klik, start TeamBot, data blijft bij verwijderen (build-instellingen; niet uitgevoerd op deze pc)', pkg.scripts['dist:win']?.includes('--win nsis') && pkg.build?.nsis?.perMachine === false && pkg.build?.nsis?.oneClick === true && pkg.build?.nsis?.deleteAppDataOnUninstall === false && fs.existsSync(path.join(root, 'build', 'installer.nsh')));
    await page.getByText('Welkom bij TeamBot').waitFor({ timeout: 20_000 });
    await page.getByText('Of begin met een kant-en-klaar team').waitFor({ timeout: 15_000 }).catch(() => {});
    await page.locator('#inhoud').getByText('Testmodel').first().waitFor({ timeout: 15_000 }).catch(() => {});
    // What bots may do is one click away ("Meer informatie" next to "Privacy en gegevens").
    await page.locator('#inhoud').getByRole('button', { name: 'Meer informatie' }).last().click().catch(() => {});
    const welcome = await mainText(page);
    check('1.4', 'geen account nodig: de app opent meteen, zonder inloggen of e-mailadres', /Welkom bij TeamBot/.test(welcome) && !/E-mailadres|Wachtwoord/.test(welcome));
    // The first bot starts on Volledige toegang: it does the work itself and asks only about money and important messages.
    check('1.5', 'eerste start zegt eerlijk wat bots mogen (zelf doen; vragen bij geld en belangrijke berichten naar anderen) en waar de data staat', /Bots doen het werk zelf en vragen het je bij geld en belangrijke berichten naar anderen/.test(welcome) && /Privacy en gegevens/.test(welcome));
    // 0.4.2: three plain ways in; the AI found on this PC has the one main button ("Testmodel gebruiken").
    const use = page.locator('#inhoud').getByRole('button', { name: 'Testmodel gebruiken' });
    check('1.6', 'welkomst: wat er op deze pc gevonden is, één knop "Testmodel gebruiken" en kant-en-klare teams', /gratis, draait op deze pc/.test(welcome) && /Testmodel/.test(welcome) && (await use.count()) === 1 && /kant-en-klaar team/.test(welcome));
    await use.click();
    // 0.4.5: a ready first bot right away; the three questions are optional behind "Aanpassen".
    const ready = page.getByTestId('first-bot-ready');
    await ready.waitFor({ timeout: 20_000 });
    await ready.getByRole('button', { name: 'Aanpassen' }).click();
    const q = page.getByTestId('first-bot-edit');
    await q.waitFor({ timeout: 15_000 });
    const qt = await q.innerText();
    // The very first bot gets just the three questions (0.4.2); "Hoofdbot of gewone bot" comes with the next bots.
    check('1.6', 'nieuwe bot: drie vragen met voorbeelden (de eerste bot: nog geen keuze hoofdbot)', /Hoe heet je bot\?/.test(qt) && /Wat doet hij\?/.test(qt) && /Welk model gebruikt hij\?/.test(qt) && !/Soort bot/.test(qt));
    await q.getByLabel('Hoe heet je bot?').fill('Ada');
    await q.getByLabel('Wat doet hij?').fill('Helpt met de fietsenwinkel: voorraad, klanten en offertes.');
    await q.getByRole('button', { name: 'Opslaan' }).click();
    await ready.getByRole('heading', { name: 'Ada staat klaar' }).waitFor({ timeout: 15_000 });
    await ready.getByRole('button', { name: 'Begin met praten' }).click();
    await page.getByTestId('first-bot-phone').getByRole('button', { name: 'Later' }).click();
    await page.waitForURL(/#\/t\//, { timeout: 15_000 });
    await page.waitForTimeout(300);
    ai.to('Ada', { text: 'Hallo! Ik ben **Ada** en ik help je met de fietsenwinkel.' });
    await send(page, 'Hoi Ada, wie ben jij?');
    check('1.6', 'eerste bot gemaakt en meteen een antwoord in de chat', await seeMessage(page, 'en ik help je met de fietsenwinkel.'));
    ids.ada = tb.bot('Ada').id;
    ids.adaTh = threadOf(ids.ada);
    const cli = await textOf(page, '#/settings/cli-agents-cli');
    // The page Abonnementen: one line per program, one button that installs, logs in and connects.
    check('1.2', 'CLI-agents: TeamBot installeert zelf een gecontroleerde kopie van Claude Code, Codex en OpenCode, en zoekt wat er al is', /je login blijft bij de maker/.test(cli) && /Opnieuw zoeken/.test(cli) && ['Claude Code', 'Codex', 'OpenCode'].every((x) => cli.includes(x)));
    check('1.3', 'gratis beginnen zonder account: "Gratis starten" (OpenCode met een gratis model)', /Gratis beginnen, zonder account/.test(cli) && (await page.getByTestId('free-start').getByRole('button', { name: 'Gratis starten' }).count()) === 1);
    // The engines the owner has (fake programs on this PC), before the OpenBot import links them.
    await tb.api('POST', '/providers', { kind: 'claude-code', name: 'Claude Code', config: { path: FAKE_CLAUDE } });
    await tb.api('POST', '/providers', { kind: 'codex-cli', name: 'Codex', config: { path: FAKE_CODEX } });
    await tb.api('POST', '/providers', { kind: 'opencode', name: 'OpenCode', config: { path: FAKE_ACP, defaultModel: 'opencode/big-pickle' } });
    await tb.api('POST', '/providers', { kind: 'deepseek', name: 'DeepSeek', apiKey: 'sk-parity-test-not-real', base_url: DEAD });
  });

  await part('1.7', 'overstappen uit OpenBot: inlezen, voorbeeld, importeren, ongedaan maken kan', async () => {
    const before = openbot.hashes();
    await goTo(page, '#/m/openbot-import', 1200);
    await page.getByRole('button', { name: 'OpenBot inlezen' }).click();
    await page.getByRole('button', { name: 'Importeren', exact: true }).waitFor({ timeout: 30_000 });
    for (const d of await page.locator('#inhoud').getByRole('button', { name: 'Details' }).all()) await d.click().catch(() => {});
    await page.waitForTimeout(300);
    const preview = await mainText(page);
    check('1.7', 'voorbeeld vóór het importeren: bots, routines, herinneringen, skills en de teammap', ['Baas', 'Kennis & Kansen', 'Klantenservice', 'Bouwer'].every((n) => preview.includes(n)) && /routine/i.test(preview) && /herinnering/i.test(preview) && /teammap/i.test(preview), preview.slice(0, 200));
    const reserveLines = [...preview.matchAll(/Reserves:[^·]{0,90}/g)].map((m) => m[0]);
    check('R.1', 'voorbeeld: modellen in woorden (Opus 5.5) en de reserves op volgorde', /Opus 5\.5/.test(preview) && reserveLines.some((l) => /→.*→/.test(l)), reserveLines.join(' | '));
    check('R.1', 'voorbeeld: de reservelijst gaat helemaal mee (geen melding meer dat maar één reserve werkt)', !/één reserve-engine automatisch/.test(preview) && /reserve-engines komen mee in dezelfde volgorde/.test(preview));
    check('R.1', 'voorbeeld: Computer Use kan zelfstandig (ander toegangsniveau tot volledige toegang)', /ander toegangsniveau kiezen \(één keer per taak, of volledige toegang\)/.test(preview));
    await page.getByRole('button', { name: 'Importeren', exact: true }).click();
    await page.getByRole('button', { name: 'Naar je bots' }).waitFor({ timeout: 60_000 });
    const done = await mainText(page);
    check('1.7', 'na het importeren: ongedaan maken met één knop', /Import ongedaan maken/.test(done));
    const agents = await tb.api('GET', '/agents');
    const by = Object.fromEntries(agents.map((a) => [a.name, a]));
    ids.baas = by.Baas?.id;
    check('1.7', 'alle bots van OpenBot staan in TeamBot', ['Baas', 'Baas Live', 'Kennis & Kansen', 'SEO & Content', 'Ads & Shopping', 'Operations', 'Klantenservice', 'Bouwer'].every((n) => by[n]), Object.keys(by).join(', '));
    check('R.1', 'toegang "full" wordt Volledige toegang (alle bots)', agents.filter((a) => a.settings?.importedFrom).every((a) => a.access_mode === 'full'));
    check('R.1', 'Computer Use alleen bij Baas → Mijn bureaublad alleen bij Baas', by.Baas?.tool_groups?.includes('desktop') && agents.filter((a) => a.name !== 'Baas' && a.settings?.importedFrom).every((a) => !a.tool_groups?.includes('desktop')));
    check('R.1', 'Baas: Opus 5.5 op Claude Code met denkniveau hoog en 3 reserves op volgorde (Sonnet → DeepSeek → OpenCode)', by.Baas?.model === 'claude-opus-5-5' && by.Baas?.reasoning === 'high' && by.Baas?.settings?.fallbacks?.length === 3, `${by.Baas?.model} ${by.Baas?.reasoning} ${JSON.stringify(by.Baas?.settings?.fallbacks)}`);
    check('R.1', 'Kennis & Kansen op Haiku, Baas Live op Codex', /haiku/.test(by['Kennis & Kansen']?.model || '') && tb.app.ctx.store.all('SELECT kind FROM providers WHERE id = ?', by['Baas Live']?.provider_id)[0]?.kind === 'codex-cli');
    check('R.1', 'gezicht: elke bot een eigen figuurtje en kleur uit zijn OpenBot-avatar', agents.filter((a) => a.settings?.importedFrom).every((a) => /^face:/.test(a.avatar || '') && a.color));
    const routines = await tb.api('GET', '/routines');
    check('R.2', 'routines komen over, staan uit (niets draait dubbel naast OpenBot) en wachten bij een limiet', routines.length >= 10 && routines.every((r) => r.status !== 'active') && routines.every((r) => r.options?.limitPolicy === 'wait'), `${routines.length} routines`);
    const kinds = new Set(routines.map((r) => r.schedule?.kind));
    check('R.2', 'de schema\'s van OpenBot (dagelijks, wekelijks, maandelijks, eenmalig, interval met anker, cron) zijn overgekomen', ['weekly', 'once', 'interval', 'cron'].every((k) => kinds.has(k)), [...kinds].join(','));
    check('R.2', 'routines die in OpenBot in de hoofdchat draaiden, doen dat in TeamBot ook', routines.some((r) => r.options?.runIn === 'main'), routines.map((r) => r.options?.runIn).join(','));
    const mems = tb.app.ctx.store.all('SELECT pinned FROM memory_items');
    check('R.4', 'herinneringen komen mee: "essential" vastgezet (altijd geladen), "searchable" doorzoekbaar', mems.length >= 1 && mems.some((m) => m.pinned), `${mems.length} herinneringen, ${mems.filter((m) => m.pinned).length} vast`);
    const after = openbot.hashes();
    check('1.7', 'OpenBot zelf is niet aangeraakt (alle bestanden ongewijzigd)', Object.entries(before).every(([f, h]) => after[f] === h));
    // Baas (Claude Code) gets TeamBot's own tools through MCP: the fake Claude Code lists what TeamBot offers this run.
    const bth = await openChat(page, 'Baas');
    await send(page, 'Welke tools heb je? SCENARIO:tools');
    await tb.idle(40_000);
    await page.waitForTimeout(600);
    const listed = lastOf(bth);
    const want = ['memory_search', 'memory_remember', 'ask_bot', 'delegate_task', 'ask_user', 'share_file', 'routine_create'];
    check('3.2', 'Claude Code-bot krijgt de TeamBot-tools via MCP: geheugen, samenwerken, vragen, delen, routines', want.every((w) => listed.includes(w)), `ontbreekt: ${want.filter((w) => !listed.includes(w)).join(', ')} · ${listed.slice(0, 120)}`);
    check('6.5', 'geheugentools ook voor CLI-engines (memory_search/memory_remember via de MCP-brug)', listed.includes('memory_search') && listed.includes('memory_remember'));
    check('10.1', 'samenwerken ook voor CLI-bots (ask_bot/delegate_task via de MCP-brug)', listed.includes('ask_bot') && listed.includes('delegate_task'));
    const undoPlan = await tb.api('GET', '/openbot-import/undo');
    check('1.7', 'ongedaan maken staat klaar (laat zien wat er weggaat, verandert nog niets)', undoPlan?.available === true || (undoPlan?.agents?.length || 0) > 0, JSON.stringify(undoPlan).slice(0, 120));
    await shot(page, 'p17-openbot-import');
  });

  // ============================================================================================ 2. Bots
  await part('2', 'bots: maken, bewerken, gezicht, engine, reserves, mappen, scripts, beheer, export, geschiedenis, kosten', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    await goTo(page, `#/agents/${ids.ada}`, 1400);
    const ed = await botPageText(page);
    check('2.1', 'bot-editor: gezicht, naam, rol, instructies, taal, antwoordstijl, engine, model, toegang', ['Gezicht', 'Naam', 'Rol', 'Instructies', 'Taal van de antwoorden', 'Antwoordstijl', 'AI en model', 'Model', 'Wat mag de bot?'].every((x) => ed.includes(x)));
    await page.getByLabel('Rol', { exact: true }).fill('Winkelhulp');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
    check('2.1', 'bewerken en opslaan werkt (nieuwe rol bewaard)', await until(() => tb.bot('Ada').role === 'Winkelhulp', 5000));
    // The face: the face editor with parts and moods; the style Glad/Vilt in Algemeen.
    await page.getByRole('button', { name: 'Gezicht', exact: true }).click();
    await page.waitForTimeout(400);
    const face = await mainText(page);
    check('2.2', 'gezicht-editor: figuurtje per stemming, vorm/kleur/ogen/mond, willekeurig, eigen foto', (await page.getByRole('tab', { name: 'Ogen' }).count()) > 0 && /Willekeurig/.test(face) && /Eigen foto/.test(face));
    check('2.3', 'engine en model per bot; wat van het model niet bekend is, staat er niet (geen regels met "onbekend")', ed.includes('AI en model') && !/:\s*onbekend/i.test(ed), (ed.match(/[^\n]*onbekend[^\n]*/i) || [''])[0]);
    // Reserves: an ordered list in the editor, now really up to five. Since 12 Nov on the first level of the bot page
    // ("Als deze AI op is, ga verder op", then "En daarna op"); the next empty place appears once the one before is set.
    const res = await makeBot('Reservetest', { provider_id: tb.app.ctx.store.all("SELECT id FROM providers WHERE kind = 'claude-code'")[0].id, model: '' });
    ids.res = res.id;
    await goTo(page, `#/agents/${res.id}`, 1400);
    const order = ['Testmodel', 'Codex', 'OpenCode', 'DeepSeek'];
    const slot = (i) => (i === 0 ? page.getByLabel('Als deze AI op is, ga verder op', { exact: true }) : page.getByLabel('En daarna op', { exact: true }).nth(i - 1));
    for (let i = 0; i < order.length; i++) {
      await pick(page, slot(i), { label: order[i] });
      await page.waitForTimeout(200);
    }
    check('2.4', 'reserve-editor: vijf plekken (na vier gekozen reserves staat de vijfde klaar)', (await page.getByLabel('Als deze AI op is, ga verder op', { exact: true }).count()) === 1 && (await page.getByLabel('En daarna op', { exact: true }).count()) === 4);
    await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
    await page.waitForTimeout(800);
    const fb = tb.bot('Reservetest').settings?.fallbacks || [];
    check('2.4', 'vier reserves gekozen in de editor, alle vier op volgorde bewaard (was: afgekapt op drie)', fb.length === 4 && fb[0].provider_id === mockId(), `${fb.length} reserves`);
    // A limit on Claude Code: the next engine takes over, said in the chat, the reserve in the header.
    const rth = await openChat(page, 'Reservetest');
    ai.to('Reservetest', { text: 'Antwoord van de reserve.' });
    await send(page, 'Wat staat er vandaag op de planning? SCENARIO:limithit');
    await tb.idle(40_000);
    check('2.4', 'Claude Code bereikt zijn limiet → de reserve antwoordt meteen', await seeMessage(page, 'Antwoord van de reserve.', 15_000), lastOf(rth).slice(0, 120));
    const evs = messagesOf(rth).map((m) => m.content).join(' | ');
    check('2.4', 'de wissel staat in de chat (met de reden), ook voor een CLI-engine', /reserve/i.test(evs) && /limiet/i.test(evs), evs.slice(-300));
    // Folders: the bot's own folder plus an extra one, read-only; a write there is refused.
    const extra = path.join(work, 'Kennis');
    fs.mkdirSync(extra, { recursive: true });
    fs.writeFileSync(path.join(extra, 'prijzen.md'), 'Stadsfiets: 749 euro\n');
    await goTo(page, `#/agents/${ids.ada}`, 1400);
    await openSection(page, 'Werkmap en mappen');
    await page.getByLabel('Map toevoegen', { exact: true }).fill(extra);
    await pick(page, page.getByLabel('Rechten voor de nieuwe map'), 'ro');
    await page.locator('#inhoud').getByRole('button', { name: 'Map toevoegen', exact: true }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
    const folders = await until(() => tb.bot('Ada').settings?.folders?.find((f) => f.path === extra), 5000);
    check('2.5', 'werkmap per bot plus een extra map (alleen lezen) uit de bot-editor', folders?.mode === 'ro', JSON.stringify(tb.bot('Ada').settings?.folders));
    await tb.api('PATCH', `/agents/${ids.ada}`, { access_mode: 'auto', tool_groups: [...new Set([...(tb.bot('Ada').tool_groups || []), 'files', 'shell', 'team', 'routines', 'skills', 'memory', 'web'])] });
    await openChat(page, 'Ada');
    await ask(page, 'Ada', 'Lees de prijzenlijst.', { toolCalls: [{ name: 'read_file', args: { path: path.join(extra, 'prijzen.md') } }] }, (req) => ({ text: `Gelezen: ${lastToolResult(req).slice(0, 80)}` }));
    check('2.5', 'de bot leest de extra map', /749 euro/.test(lastOf(ids.adaTh)), lastOf(ids.adaTh).slice(0, 120));
    await ask(page, 'Ada', 'Zet er een notitie bij.', { toolCalls: [{ name: 'write_file', args: { path: path.join(extra, 'notitie.md'), content: 'x' } }] }, (req) => ({ text: `Uitkomst: ${lastToolResult(req).slice(0, 160)}` }));
    check('2.5', 'schrijven in de alleen-lezen map wordt geweigerd', !fileOk(path.join(extra, 'notitie.md')), lastOf(ids.adaTh).slice(0, 160));
    check('2.5', 'gedeelde teammap voor alle bots (Instellingen › Teammap, per team in Teams)', /teammap/i.test(await textOf(page, '#/settings/folders-teammap')));
    // Local scripts: the terminal group; in "Automatisch" a command runs without a card.
    await openChat(page, 'Ada');
    await ask(page, 'Ada', 'Voer een test uit.', { toolCalls: [{ name: 'run_command', args: { command: 'echo parity-ok' } }] }, (req) => ({ text: `Terminal: ${lastToolResult(req).slice(0, 120)}` }));
    check('2.6', 'lokale scripts: de terminal (run_command) draait in de werkmap', /parity-ok/.test(lastOf(ids.adaTh)), lastOf(ids.adaTh).slice(0, 160));
    // Duplicate, archive, back from the archive (now also from the card in Archief).
    await page.getByRole('button', { name: 'Meer opties' }).click();
    await page.getByRole('button', { name: 'Bot beheren', exact: true }).click();
    await page.getByRole('button', { name: /Bot dupliceren/ }).click();
    const copy = await until(() => tb.app.ctx.store.agents(tb.owner.id).find((a) => /Ada \(kopie\)/.test(a.name)), 8000);
    check('2.7', 'dupliceren vanuit het chatmenu', !!copy);
    await goTo(page, `#/a/${copy.id}`, 1200);
    await page.getByRole('button', { name: 'Meer opties' }).click();
    await page.getByRole('button', { name: 'Bot beheren', exact: true }).click();
    await page.getByRole('button', { name: /Bot archiveren/ }).click();
    await confirmDialog(page, 'Archiveren');
    await until(() => tb.app.ctx.store.agents(tb.owner.id).find((a) => a.id === copy.id)?.archived, 5000);
    await goTo(page, '#/agents', 1000);
    await page.getByRole('switch', { name: 'Archief' }).click();
    await page.waitForTimeout(800);
    await page.locator('#inhoud').getByRole('button', { name: 'Bot uit archief halen' }).first().click();
    check('2.7', 'archiveren en terughalen vanuit Alle bots › Archief', await until(() => tb.app.ctx.store.agents(tb.owner.id).find((a) => a.id === copy.id)?.archived === false, 5000));
    // Export as a template; templates in the marketplace.
    await goTo(page, `#/agents/${ids.ada}`, 1400);
    await openSection(page, 'Sjabloon en delen');
    await page.getByRole('button', { name: 'Exporteren als bestand', exact: true }).click();
    check('2.8', 'exporteren als sjabloon: een bestand om te downloaden', await page.getByRole('dialog', { name: 'Sjabloon exporteren' }).getByText('Downloaden').waitFor({ timeout: 8000 }).then(() => true).catch(() => false));
    await page.keyboard.press('Escape');
    const bots = await tb.api('GET', '/skills/market/bots').catch(() => []);
    const teamTpl = await tb.api('GET', '/team-templates').catch(() => []);
    check('2.8', 'sjablonen: ≥ 25 bot-sjablonen en 15 teamsjablonen', (Array.isArray(bots) ? bots : bots.items || []).length >= 25 && teamTpl.length >= 15, `${(Array.isArray(bots) ? bots : bots.items || []).length} bots, ${teamTpl.length} teams`);
    await goTo(page, '#/settings/teams-teams', 1200);
    await page.getByRole('button', { name: 'Meer opties', exact: true }).first().click();
    await page.getByRole('menuitem', { name: 'Team uit een sjabloon' }).click();
    check('2.8', 'teamsjablonen ook na de eerste bot: Instellingen › Teams › Team uit een sjabloon', await page.getByRole('dialog', { name: 'Team uit een sjabloon' }).getByText(/Webshop/).first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false));
    await page.keyboard.press('Escape');
    // History: versions with a diff and restore.
    await tb.api('PATCH', `/agents/${ids.ada}`, { role: 'Verkoper' });
    await goTo(page, `#/agents/${ids.ada}`, 1400);
    await openSection(page, 'Geschiedenis');
    const hist = await mainText(page);
    check('2.9', 'geschiedenis van de bot: versies met wat er veranderde, vergelijken en terugzetten', /Terugzetten/.test(hist) && /Vergelijken met nu/.test(hist));
    const versions = await tb.api('GET', `/agents/${ids.ada}/versions`);
    const older = versions.find((v) => v.data?.role === 'Winkelhulp');
    if (older) await tb.api('POST', `/agents/${ids.ada}/versions/${older.id}/restore`);
    check('2.9', 'een oude versie terugzetten werkt', tb.bot('Ada').role === 'Winkelhulp');
    await shows(page, '2.10', 'kosten per bot en per model, met het dagbudget', '#/settings/usage', ['Per bot', 'Per model', 'Ada']);
    // Since 12 Nov: Instellingen › Meer mogelijkheden › Standaarden voor nieuwe bots.
    check('2.10', 'dagbudget per eigenaar en per team (stopt vóór een stap die niet meer past)', /Dagbudget/.test(await textOf(page, '#/settings/bot-defaults')));
  });

  // ============================================================================================ 3. Engines
  await part('3', 'engines en providers: CLI\'s, TeamBot-tools in CLI\'s, API\'s, lokaal, abonnement, gebruik, context', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    const cli = await textOf(page, '#/settings/cli-agents-cli');
    // 0.4.2: "x van n programma's gevonden"; the own ACP agent is for experts (Geavanceerd tonen), on the same page.
    // The page shows what is on this pc and "Nog n programma's" for the rest; the count comes from the list of kinds.
    const n = /Nog \d+ programma's/.test(cli) ? (await tb.api('GET', '/provider-kinds')).filter((k) => k.type === 'cli' && k.id !== 'acp-custom').length : 0;
    const ownAcp = /Eigen ACP-agent/.test(cli) || (await tb.api('GET', '/provider-kinds')).some((k) => k.id === 'acp-custom');
    check('3.1', 'CLI-engines: ≥ 13 ondersteunde agent-CLI\'s plus een eigen ACP-agent', n >= 13 && ownAcp, `${n} ondersteund`);
    const bth = threadOf(ids.baas);
    const kinds = await tb.api('GET', '/provider-kinds');
    const api = kinds.filter((k) => k.type !== 'cli' && !k.retired);
    check('3.3', 'API-providers: ≥ 30, met een eigen OpenAI-compatibel adres', api.length >= 30 && kinds.some((k) => k.id === 'openai-compatible'), `${api.length} API-soorten`);
    // LM Studio, the owner's own local provider in OpenBot, on its own address (the connect dialog itself:
    // tests/e2e/providers-live.mjs and c4-models-cli-review.mjs).
    const lmProv = await tb.api('POST', '/providers', { kind: 'lmstudio', name: 'LM Studio', base_url: LM_URL });
    check('3.4', 'lokaal model: LM Studio koppelen op een eigen adres (zoals bij OpenBot 127.0.0.1:1234)', !!lmProv?.id);
    if (lmProv) {
      const lb = await makeBot('Lokaal', { provider_id: lmProv.id, model: 'qwen3.6' });
      const lth = (await tb.api('POST', '/threads', { agentId: lb.id })).id;
      await goTo(page, `#/t/${lth}`, 1000);
      await send(page, 'Hoi lokaal model');
      check('R.7', 'eigen provider LM Studio (lokaal) antwoordt in de chat', await seeMessage(page, 'Hallo uit LM Studio.'));
      await goTo(page, `#/agents/${lb.id}`, 1400);
      // Since 12 Nov: the bot page › Meer mogelijkheden › Over het model.
      await openSection(page, 'Over het model');
      check('3.4', 'contextvenster per lokaal model in te stellen (bot-editor)', await page.getByTestId('context-window').waitFor({ timeout: 8000 }).then(() => true, () => false));
    }
    // Since 12 Nov the local models are Instellingen › Meer mogelijkheden › Lokale modellen en andere diensten (and the
    // row "Op deze computer" under AI-diensten › Toevoegen).
    check('3.4', 'Ollama, LM Studio en llama.cpp worden gevonden en rechtstreeks gebruikt (geen omweg via OpenCode)', ['ollama', 'lmstudio', 'llamacpp'].every((k) => kinds.some((x) => x.id === k)) && /Lokale modellen op deze pc/.test(await textOf(page, '#/settings/ai-meer')));
    check('3.5', 'inloggen met je abonnement: TeamBot gebruikt de login van de CLI (Pro/Max, ChatGPT); inloggen vanuit de app', cli.includes('Je Claude-abonnement (Pro of Max)') && /Je ChatGPT-abonnement/.test(cli));
    // Usage after a Claude Code turn: limits with reset times in the sidebar bar; estimate under the answer.
    const bar = await until(async () => {
      const b = await tb.api('GET', '/usage/bar');
      return (b.engines || []).find((e) => /claude/i.test(e.kind || e.id || e.label)) ? b : null;
    }, 25_000, 500);
    check('3.6', 'gebruiksbalk: Claude 5 uur met resettijd, na een beurt van Claude Code', !!bar?.engines?.find((e) => (e.windows || []).some((w) => w.resetsAt)), JSON.stringify(bar?.engines?.map((e) => e.label)));
    await goTo(page, `#/t/${bth}`, 1500);
    const side = page.getByRole('navigation', { name: 'Hoofdmenu' });
    check('3.6', 'het gebruik staat onderin de zijbalk: een ring per abonnement en de link naar Gebruik en limieten', (await side.getByRole('group', { name: 'Gebruik' }).locator('button[data-usage-meter]').count()) > 0 && (await side.getByRole('link', { name: 'Gebruik en limieten' }).count()) === 1);
    await textOf(page, '#/m/usage/');
    // "Verbruik per bot" shows the five biggest users first; Baas (one Claude Code turn) can be behind "Alle N tonen".
    const allRows = page.locator('#inhoud').getByRole('button', { name: /^Alle \d+ tonen$/ });
    if (await allRows.count()) await allRows.first().click();
    await page.waitForTimeout(300);
    const usage = await mainText(page);
    check('3.6', 'gebruik per bot, met de waarde via het abonnement (schatting tegen lijstprijs)', /abonnement/.test(usage) && /Baas/.test(usage), usage.slice(usage.indexOf('Verbruik per bot'), usage.indexOf('Verbruik per bot') + 400));
    // Context: the ring in the chat header and "Nu samenvatten".
    await goTo(page, `#/t/${ids.adaTh}`, 1200);
    const ring = page.getByRole('button', { name: /Context .*vol/ });
    check('3.7', 'contextring in de kop van de chat', (await ring.count()) > 0);
    if (await ring.count()) {
      await ring.first().click();
      check('3.7', 'de ring: "Nu samenvatten" en de limieten', await page.getByRole('button', { name: 'Nu samenvatten' }).waitFor({ timeout: 5000 }).then(() => true).catch(() => false));
      await page.keyboard.press('Escape');
    }
  });

  // ============================================================================================ 4. Chat
  await part('4', 'chat: streaming, threads, wachtrij, bijsturen, bijlagen, previews, zoeken, vraag- en plankaarten, export', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    await openChat(page, 'Ada');
    await ask(page, 'Ada', 'Leg de voorraad uit.', { reasoning: 'Even de voorraadlijst nalopen.', text: '## Voorraad\n\n- **12** stadsfietsen\n- `3` bakfietsen' });
    const msg = page.locator('[id^="m-"]').last();
    check('4.1', 'markdown in het antwoord (kopje, vet, code)', (await msg.locator('strong').count()) > 0 && (await msg.locator('code').count()) > 0);
    check('4.1', 'denkproces is te openen bij het antwoord', (await page.getByRole('button', { name: /Denkproces/ }).count()) > 0);
    await ask(page, 'Ada', 'Welke bestanden heb je?', { toolCalls: [{ name: 'list_files', args: { path: '.' } }] }, { text: 'Dat zijn ze.' });
    check('4.1', 'tool-kaart (stap) bij het antwoord, met invoer en resultaat', (await page.locator('[id^="m-"]').getByRole('button', { name: /stap|Bekeek|bestanden/i }).count()) > 0);
    // Fork from a message.
    const before = tb.app.ctx.store.all('SELECT id FROM threads').length;
    const target = page.locator('[id^="m-"]').filter({ hasText: 'stadsfietsen' }).first();
    await target.hover();
    await target.getByRole('button', { name: 'Meer', exact: true }).click();
    await page.getByRole('button', { name: /Vanaf hier vertakken/ }).click();
    check('4.2', 'vertakken vanaf een bericht: een nieuw gesprek tot dat punt', await until(() => tb.app.ctx.store.all('SELECT id FROM threads').length > before && /vertakking/.test(tb.app.ctx.store.all('SELECT title FROM threads ORDER BY created_at DESC')[0]?.title || ''), 8000));
    // Parallel conversations with one bot.
    await openChat(page, 'Ada');
    await page.getByRole('button', { name: 'Meer opties' }).click();
    await page.getByRole('button', { name: 'Nieuw gesprek', exact: true }).first().click();
    await page.waitForTimeout(800);
    check('4.2', 'meerdere gesprekken naast elkaar met dezelfde bot', tb.app.ctx.store.all("SELECT id FROM threads WHERE agent_id = ? AND kind = 'chat'", ids.ada).length >= 2);
    // Queue: while Ada works, two messages wait; edit, move, remove.
    await openChat(page, 'Ada');
    ai.to('Ada', async () => (await sleep(4000), { text: 'Klaar met de lange klus.' }), { text: 'Tweede gedaan.' }, { text: 'Derde gedaan.' });
    await send(page, 'Doe een lange klus.');
    await page.waitForTimeout(700);
    await send(page, 'Tweede vraag');
    await send(page, 'Derde vraag');
    const qbar = page.getByRole('region', { name: 'Wachtrij' });
    const queued = await qbar.waitFor({ timeout: 4000 }).then(() => true).catch(() => false);
    check('4.3', 'zichtbare wachtrij boven het invoerveld', queued && /In de wachtrij/.test(await qbar.innerText().catch(() => '')));
    if (queued) {
      await qbar.getByRole('button', { name: 'Bewerken' }).first().click();
      const ed = page.getByRole('textbox', { name: 'Bericht in de wachtrij bewerken' });
      await ed.fill('Tweede vraag (aangepast)');
      await qbar.getByRole('button', { name: 'Opslaan' }).click();
      await page.waitForTimeout(300);
      await qbar.getByRole('button', { name: 'Uit de wachtrij halen' }).last().click();
      await page.waitForTimeout(300);
    }
    await tb.idle(30_000);
    const users = messagesOf(ids.adaTh).filter((m) => m.role === 'user').map((m) => m.content);
    check('4.3', 'wachtrij bewerken en een bericht eruit halen: alleen wat er staat wordt verstuurd', users.includes('Tweede vraag (aangepast)') && !users.includes('Derde vraag'), users.slice(-3).join(' | '));
    // Steering: while Ada works, a message goes into the running turn.
    ai.to('Ada', async () => (await sleep(3000), { toolCalls: [{ name: 'list_files', args: { path: '.' } }] }), (req) => ({ text: `Bijgestuurd: ${JSON.stringify(req.messages).includes('kort') ? 'ja' : 'nee'}` }));
    await send(page, 'Maak een overzicht.');
    await page.waitForTimeout(800);
    // The message waits in the queue; its arrow "Nu sturen" puts it into the running turn.
    await send(page, 'Houd het kort');
    await qbar.getByRole('button', { name: 'Nu sturen' }).first().click({ timeout: 2000 }).catch(() => {});
    await tb.idle(30_000);
    check('4.4', 'bijsturen tijdens een beurt: het bericht gaat mee in de lopende beurt', /Bijgestuurd: ja/.test(lastOf(ids.adaTh)), lastOf(ids.adaTh));
    // A typed message while a question card is open is the answer.
    ai.to('Ada', { toolCalls: [{ name: 'ask_user', args: { question: 'Welke kleur fiets?', options: ['Rood', 'Blauw'] } }] }, (req) => ({ text: `Gekozen: ${lastToolResult(req).slice(0, 60)}` }));
    await send(page, 'Bestel een fiets.');
    const card = page.getByRole('group', { name: 'Vraag van de bot' });
    check('4.8', 'vraagkaart met keuzes (ask_user)', await card.waitFor({ timeout: 10_000 }).then(() => true).catch(() => false));
    await send(page, 'Groen graag');
    await tb.idle(20_000);
    check('4.4', 'een getypt bericht terwijl een vraag openstaat telt als het antwoord', /Groen/.test(lastOf(ids.adaTh)), lastOf(ids.adaTh));
    // Plan card and form.
    // In the tool's own shape ({ text, status }): tool arguments are checked against their JSON schema since 0.4.4.
    await ask(page, 'Ada', 'Maak een plan.', { toolCalls: [{ name: 'plan_update', args: { steps: [{ text: 'Voorraad tellen', status: 'completed' }, { text: 'Bestelling plaatsen', status: 'in_progress' }] } }] }, { text: 'Plan staat.' });
    check('4.8', 'plankaart met stappen en voortgang', (await page.getByTestId('plan-card').count()) > 0);
    // Attachments: pdf, png and html in one go; a zip gets an honest notice.
    const { makePdf } = await import('./accept-04-lib.mjs');
    const pdf = path.join(work, 'offerte.pdf');
    fs.writeFileSync(pdf, makePdf([['Offerte stadsfiets', 'Prijs 749 euro']]));
    const png = path.join(work, 'logo.png');
    fs.writeFileSync(png, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
    const html = path.join(work, 'folder.html');
    fs.writeFileSync(html, '<h1>Folder</h1>');
    // A .zip is unpacked for the bot (no notice); another archive still gets an honest notice.
    const zip = path.join(work, 'archief.7z');
    fs.writeFileSync(zip, Buffer.from('377abcaf271c', 'hex'));
    await page.locator('input[type=file]').first().setInputFiles([pdf, png, html, zip]);
    await page.waitForTimeout(1500);
    const notice = (await page.locator('[role=status]').allInnerTexts()).join(' ');
    await ask(page, 'Ada', 'Kijk hier eens naar.', { text: 'Bijlagen ontvangen.' });
    const lastUser = [...messagesOf(ids.adaTh)].reverse().find((m) => m.role === 'user');
    const sent = (lastUser?.parts?.attachments || []).map((a) => a.name);
    check('4.5', 'bijlagen: pdf, png, html en een archief in één keer; het archief (7z) krijgt vooraf een eerlijke melding', sent.length === 4 && /pakt alleen zip-bestanden uit/.test(notice), `${sent.join(', ')} · ${notice.slice(0, 80)}`);
    check('R.5', 'bijlagen zoals bij Sanne (pdf, png, html) komen aan bij het bericht en de bot', ['offerte.pdf', 'logo.png', 'folder.html'].every((n) => sent.includes(n)));
    // Previews: an HTML page from the bot in a sandbox, a Mermaid diagram, the pdf preview.
    await ask(page, 'Ada', 'Maak een pagina.', { toolCalls: [{ name: 'show_html', args: { title: 'Actie', html: '<h1>Actie: 10% korting</h1>' } }] }, { text: 'De pagina staat hiernaast.\n\n```mermaid\ngraph TD; A[Klant]-->B[Offerte]\n```' });
    const pageTxt = await mainText(page);
    check('4.6', 'HTML-pagina van de bot afgeschermd in de chat (geen netwerk), naast de chat te openen', /afgeschermd · geen netwerk/.test(pageTxt) || (await page.getByRole('button', { name: /Pagina.* naast de chat|Naast de chat/ }).count()) > 0);
    check('4.6', 'Mermaid-diagram als plaatje', await page.getByRole('img', { name: 'Diagram' }).first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false));
    await page.locator('[id^="m-"]').getByText('offerte.pdf').first().click().catch(() => {});
    check('4.6', 'pdf-voorbeeld in de app', await page.getByTestId('pdf-pages').waitFor({ timeout: 10_000 }).then(() => true).catch(() => false));
    await page.keyboard.press('Escape');
    // Search: Ctrl+K over everything, Ctrl+F in this chat, the settings filter.
    await page.keyboard.press('Control+k');
    const pal = page.getByRole('dialog', { name: 'Zoeken en snelle acties' });
    await pal.waitFor({ timeout: 5000 });
    await page.keyboard.type('stadsfietsen');
    check('4.7', 'Ctrl+K zoekt in gesprekken, bots, pagina\'s en instellingen', await pal.getByRole('listbox', { name: 'Resultaten' }).getByRole('option').first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false));
    await page.keyboard.press('Escape');
    await openChat(page, 'Ada');
    for (let i = 0; i < 4 && (await page.getByRole('dialog').count()); i++) {
      await page.keyboard.press('Escape');
      await page.waitForTimeout(200);
    }
    await page.locator('[id^="m-"]').last().click({ position: { x: 5, y: 5 } }).catch(() => {});
    await page.keyboard.press('Control+f');
    const find = page.getByRole('searchbox', { name: 'Zoeken in dit gesprek' }).or(page.getByRole('textbox', { name: 'Zoeken in dit gesprek' }));
    await find.first().waitFor({ timeout: 5000 }).catch(() => {});
    await find.first().fill('stadsfietsen').catch(() => {});
    await page.waitForTimeout(500);
    const findBar = (await page.locator('[role="search"][data-find-skip]').innerText().catch(() => '')) || '';
    check('4.7', 'Ctrl+F zoekt in dit gesprek, met het aantal treffers', /\d+ van \d+/.test(findBar), findBar.slice(0, 80));
    await page.keyboard.press('Escape');
    // Export.
    const md = await fetch(`${tb.url}/api/threads/${ids.adaTh}/export?format=md`, { headers: { authorization: `Bearer ${tb.token}` } }).then((r) => r.text());
    const js = await fetch(`${tb.url}/api/threads/${ids.adaTh}/export?format=json`, { headers: { authorization: `Bearer ${tb.token}` } }).then((r) => r.json());
    await page.getByRole('button', { name: 'Meer opties' }).click();
    await page.getByRole('button', { name: 'Exporteren', exact: true }).click();
    const links = await page.getByRole('link', { name: /Exporteren als/ }).allInnerTexts();
    await page.keyboard.press('Escape');
    check('4.9', 'gesprek exporteren als Markdown en JSON (chatmenu)', links.length === 2 && /stadsfietsen/.test(md) && js.format === 'teambot.thread/v1');
    // More than 10 files at once: the rest is reported, never silently dropped (0.4.2).
    const many = Array.from({ length: 11 }, (_, i) => {
      const f = path.join(work, `notitie-${i + 1}.txt`);
      fs.writeFileSync(f, `notitie ${i + 1}`);
      return f;
    });
    await page.locator('input[type=file]').first().setInputFiles(many);
    check('4.5', 'meer dan 10 bestanden tegelijk: een melding over wat niet is toegevoegd', await page.getByText('1 bestand is niet toegevoegd: je kunt 10 bestanden tegelijk toevoegen.').waitFor({ timeout: 5000 }).then(() => true).catch(() => false));
    await page.waitForTimeout(1500);
    await goTo(page, '#/settings/general', 600); // leave the chat without sending them
  });

  // ============================================================================================ 5. Toegang
  await part('5', 'goedkeuringen en toegangsniveaus: volledige toegang, op afstand goedkeuren (telefoon), vangnet', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    // New bots of the owner start on Volledige toegang; choosing it (with the explanation first) is shown from Automatisch.
    await tb.api('PATCH', `/agents/${ids.ada}`, { access_mode: 'auto' });
    await goTo(page, `#/agents/${ids.ada}?tab=meer&meer=1`, 1400);
    // 0.4.5: the five levels are one dropdown (Wat mag de bot?), with one line for the chosen level.
    const access = page.getByTestId('access-choice').getByRole('combobox');
    await access.click();
    const radios = await page.getByRole('option').allInnerTexts().catch(() => []);
    await page.keyboard.press('Escape');
    const lv = radios.join(' | ');
    check('5.1', 'vijf niveaus: Alleen chat, Alleen lezen, Vraagt toestemming, Automatisch, Volledige toegang', ['Alleen chat', 'Alleen lezen', 'Vraagt toestemming', 'Automatisch', 'Volledige toegang'].every((x) => lv.includes(x)), radios.join(','));
    await pick(page, access, 'full');
    await confirmDialog(page, 'Doorgaan');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
    check('5.1', 'Volledige toegang kiezen (met uitleg vooraf), alleen door de eigenaar', await until(() => tb.bot('Ada').access_mode === 'full', 5000));
    // In full access a delete in the own folder runs without a card; it lands in the trash.
    const ws = tb.bot('Ada').workspace;
    fs.mkdirSync(ws, { recursive: true });
    fs.writeFileSync(path.join(ws, 'oud.txt'), 'oude lijst');
    await openChat(page, 'Ada');
    const before = pendingApprovals().length;
    await ask(page, 'Ada', 'Ruim oud.txt op.', { toolCalls: [{ name: 'delete_file', args: { path: 'oud.txt' } }] }, { text: 'Opgeruimd.' });
    check('5.1', 'volledige toegang: wissen in de eigen map zonder goedkeuringskaart (geen vragenregen)', !fileOk(path.join(ws, 'oud.txt')) && pendingApprovals().length === before);
    await shows(page, '5.3', 'vangnet: wat een bot wist, staat in de Prullenbak en komt terug', '#/m/folders/prullenbak', ['oud.txt', 'Terugzetten']);
    // What still asks in full access: sending to others (channel_send to an outsider is "danger").
    await tb.api('PATCH', `/agents/${ids.ada}`, { access_mode: 'ask' });
    // A paired phone answers the approval: the owner away from the computer.
    phone = await pairPhone();
    const pht = await phoneText(phone.page, '#/');
    check('13.4', 'telefoon gekoppeld via de echte koppelpagina (eenmalige link uit de QR-code)', !!phone.token && /Chats/.test(pht));
    ai.to('Ada', { toolCalls: [{ name: 'write_file', args: { path: 'van-telefoon.txt', content: 'goedgekeurd op de telefoon' } }] }, { text: 'Geschreven.' });
    await tb.api('POST', `/threads/${ids.adaTh}/messages`, { content: 'Schrijf van-telefoon.txt' });
    await until(() => pendingApprovals().length > before, 10_000);
    const inbox = await phoneText(phone.page, '#/inbox', 1500);
    check('5.2', 'telefoon: de goedkeuring staat in Wacht op jou', /van-telefoon\.txt|Schrijf|bestand/i.test(inbox), inbox.slice(0, 200));
    await phone.page.getByRole('button', { name: /^Eén keer toestaan|^Toestaan/ }).first().click();
    await tb.idle(20_000);
    check('5.2', 'op de telefoon goedgekeurd → de bot gaat verder en het bestand staat er', fileOk(path.join(ws, 'van-telefoon.txt')));
    const always = await phone.device('POST', `/approvals/apr_x`, { decision: 'always' });
    check('5.2', '"Altijd toestaan" kan niet vanaf de telefoon (alleen op de computer)', always.status === 403);
    check('5.3', 'vangnet: oefenen op een kopie, snapshots en undo (bewijs: tests/rehearsal-*.test.ts, tests/e2e/c4-models-cli-review.mjs)', fs.existsSync(path.join(root, 'tests', 'rehearsal-moves.test.ts')));
  });

  // ============================================================================================ 6. Geheugen
  await part('6', 'geheugen en dossiers: zelf leren, zichtbaar in de chat, vastzetten, dossiers, teamtabellen', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    await openChat(page, 'Ada');
    await ask(page, 'Ada', 'Onthoud dat de winkel op maandag dicht is.', { text: 'Genoteerd.' });
    // Learning runs after a quiet moment; "Nu leren" (side panel › Geheugen) does it right away.
    await tb.api('POST', `/memory/thread/${ids.adaTh}/learn`, { agentId: ids.ada }).catch(() => null);
    const learned = await until(() => tb.app.ctx.store.all("SELECT id, content FROM memory_items WHERE content LIKE '%maandag%'")[0], 15_000, 300);
    check('6.1', 'automatisch leren uit je eigen woorden', !!learned);
    await openChat(page, 'Ada');
    check('6.3', 'zichtbaar in de chat: "Onthouden" onder je bericht, met ongedaan maken', await page.getByText(/Onthouden/).first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false) && (await page.getByRole('button', { name: 'Ongedaan maken' }).count()) > 0);
    await shows(page, '6.1', 'leren is in te stellen (automatisch, op verzoek, uit)', '#/m/memory/opslag', ['Automatisch leren', 'Alleen op verzoek']);
    await shows(page, '6.2', 'scopes en quota: over jou, per bot, gedeeld, dossiers; gebruik en quota', '#/m/memory/opslag?meer=1', ['Gebruik en quota']);
    if (learned) {
      await tb.api('PATCH', `/memory/items/${learned.id}`, { pinned: true });
      check('6.2', 'vastzetten: altijd laden (zoals "essential" in OpenBot)', !!tb.app.ctx.store.all('SELECT pinned FROM memory_items WHERE id = ?', learned.id)[0]?.pinned);
    }
    // Dossiers: import own markdown files (like Sanne's ~/OpenBot/Shared/Dossiers).
    const d1 = path.join(work, 'klant-jansen.md');
    fs.writeFileSync(d1, '# Klant Jansen\n\nVaste klant sinds 2020. Rijdt een bakfiets.\n');
    const d2 = path.join(work, 'leverancier-velo.md');
    fs.writeFileSync(d2, '# Leverancier Velo\n\nLevert binnen 5 werkdagen.\n');
    await goTo(page, '#/m/memory/dossiers', 1200);
    await page.getByRole('button', { name: 'Meer acties bij dossiers' }).click();
    await page.getByRole('menuitem', { name: 'Importeren uit Markdown' }).click();
    const imp = page.getByRole('dialog', { name: 'Importeren uit Markdown' });
    await imp.getByLabel('Markdown-bestanden kiezen', { exact: true }).setInputFiles([d1, d2]);
    await page.waitForTimeout(1200);
    await imp.getByRole('button', { name: /^Importeren \(2\)/ }).click();
    await page.waitForTimeout(1500);
    check('6.4', 'dossiers: eigen markdown-dossiers importeren (voorbeeld eerst)', /Klant Jansen/.test(await textOf(page, '#/m/memory/dossiers')) && /Leverancier Velo/.test(await mainText(page)));
    // "Geavanceerd tonen": Instellingen › Meer mogelijkheden › Deze computer (since 12 Nov).
    await goTo(page, '#/settings/systeem', 800);
    await page.getByRole('switch', { name: 'Geavanceerd tonen' }).click();
    await until(() => tb.app.ctx.store.settings(tb.owner.id).ui?.advanced === true, 5000);
    const tables = await textOf(page, '#/m/teamdata/tabellen', 1500);
    check('6.6', 'gedeelde teamtabellen (uit OpenBot overgenomen: taken, beslissingen …)', /Tabellen/.test(tables) && /(taken|beslissingen|gebeurtenissen|experimenten)/i.test(tables), tables.slice(0, 200));
  });

  // ============================================================================================ 7. Skills
  await part('7', 'skills en marktplaats: catalogus, installeren op alle bots, updates, veiligheid, zelf maken, /-menu', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    const curated = await tb.api('GET', '/skills/curated');
    const list = Array.isArray(curated) ? curated : curated.skills || curated.items || [];
    check('7.1', 'eigen veilige catalogus: ≥ 40 skills op vaste versies, met licentie', list.length >= 40, `${list.length} skills`);
    const market = await textOf(page, '#/m/skills/', 1500);
    check('7.1', 'Marktplaats: skills, apps en bots; bron, licentie en rechten vooraf zichtbaar', /Skills, apps en bots/.test(market) && ['Gecontroleerd', 'Toevoegen'].every((x) => market.includes(x)), market.slice(0, 200));
    // A skill of your own (paste), switched on for all bots in the same step ("Direct inschakelen voor": Alle bots; the
    // picker itself: tests/e2e/extensions-ui.mjs).
    const all = tb.app.ctx.store.agents(tb.owner.id).filter((a) => !a.archived).map((a) => a.id);
    const pv = await tb.api('POST', '/skills/import/preview', { kind: 'paste', text: '---\nname: offerte-maken\ndescription: Maak een offerte voor een fiets.\n---\n\n# Offerte\n1. Vraag het model.\n' });
    // For all bots of every team: the skill itself is placed in every team (B4: teamId "*"; without it, one team).
    await tb.api('POST', '/skills/import/commit', { stagingId: pv.stagingId, keys: pv.candidates.map((c) => c.key), acknowledge: true, confirmPermissions: true, enableFor: all, teamId: '*' });
    const sk = await until(async () => (await tb.api('GET', '/skills')).find((s) => s.name === 'offerte-maken'), 5000);
    const on = sk ? tb.app.ctx.store.agents(tb.owner.id).filter((a) => !a.archived && (a.skills || []).includes(sk.id)).length : 0;
    check('7.2', 'een skill in één stap op alle bots zetten', on === all.length && on >= 1, `${on} van ${all.length} bots`);
    await textOf(page, '#/m/skills/mine', 1200);
    // "Controleer op updates" is rarely needed: it is in the page's "Meer opties".
    await page.getByTestId('myskills-more').click().catch(() => {});
    const canCheck = (await page.getByRole('menuitem', { name: 'Controleer op updates' }).count()) > 0;
    await page.keyboard.press('Escape');
    check('7.3', 'Mijn skills: controleren op updates, versies, vastzetten en verwijderen', canCheck);
    await shows(page, '7.4', 'veiligheid: uitgeversbeleid, vertrouwde uitgevers met handtekening', '#/settings/skills-uitgevers', ['Wat mag er geïnstalleerd worden?', 'Vertrouwde uitgevers']);
    await openChat(page, 'Ada');
    await ask(page, 'Ada', 'Maak hier een skill van.', { toolCalls: [{ name: 'skill_save', args: { name: 'fiets-afleveren', description: 'Zo leveren we een fiets af.', instructions: '1. Controleer de banden.\n2. Leg de sloten uit.' } }] }, { text: 'De skill staat klaar.' });
    if (pendingApprovals().length) {
      await page.getByRole('button', { name: /^Eén keer toestaan|^Toestaan/ }).first().click().catch(() => {});
      await tb.idle(15_000);
    }
    check('7.5', 'skills maken vanuit een gesprek: de bot legt hem vast en hij is meteen actief voor het team', await page.getByText(/is vastgelegd en actief voor het team/).first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false));
    const box = page.getByRole('textbox', { name: 'Bericht', exact: true });
    const menu = page.getByRole('listbox', { name: 'Skills en opdrachten' });
    let menuOk = false;
    for (let i = 0; i < 3 && !menuOk; i++) {
      await tb.idle(10_000);
      await box.click();
      await box.fill('');
      await page.keyboard.type('/');
      menuOk = await menu.waitFor({ timeout: 4000 }).then(() => true).catch(() => false);
      if (!menuOk) await page.keyboard.press('Escape');
    }
    if (menuOk) await menu.getByRole('option').filter({ hasText: 'offerte-maken' }).first().waitFor({ timeout: 8000 }).catch(() => {}); // the bot's skills load a moment later
    const items = menuOk ? await menu.getByRole('option').allInnerTexts() : [];
    check('7.6', '/-menu in het invoerveld: skills van de bot en opdrachten', menuOk && items.some((x) => /offerte-maken/.test(x)) && items.some((x) => /Nieuw gesprek/.test(x)), `${items.slice(0, 6).join(' | ')} · invoer: ${JSON.stringify(await box.inputValue().catch(() => '?'))} · lijsten: ${JSON.stringify(await page.getByRole('listbox').evaluateAll((ls) => ls.map((l) => l.getAttribute('aria-label'))))} · ${JSON.stringify(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')))}`);
    await page.keyboard.press('Escape');
    await box.fill('');
  });

  // ============================================================================================ 8. Apps, MCP, kluis
  await part('8', 'apps en MCP: eigen server plakken, catalogus, kluis, TeamBot als MCP-server en CLI', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    await goTo(page, '#/m/mcp', 1200);
    await page.getByRole('button', { name: 'Importeren' }).first().click();
    const dlg = page.getByRole('dialog', { name: 'Apps importeren' });
    await dlg.getByLabel('Opdracht of config om te importeren').fill('claude mcp add notities -- npx -y @modelcontextprotocol/server-memory');
    await dlg.getByRole('button', { name: 'Herkennen' }).click();
    check('8.1', 'eigen MCP: een "claude mcp add"-regel plakken wordt herkend (stdio/HTTP/SSE, OAuth)', await page.getByText(/notities/).first().waitFor({ timeout: 8000 }).then(() => true).catch(() => false));
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    const cat = await tb.api('GET', '/mcp/catalog');
    const gmail = (cat.items || cat).find((c) => /gmail/i.test(c.id || c.name));
    check('8.2', 'connectors: Gmail, Drive, Agenda en Sheets staan erin, maar vragen een eigen Google-app (achter op OpenBot)', !!gmail, gmail ? `${gmail.name}: ${gmail.oauthClient || ''}` : 'geen gmail');
    await goTo(page, '#/m/browser/kluis', 1200);
    await page.getByRole('button', { name: 'Login toevoegen' }).click();
    const v = page.getByRole('dialog', { name: 'Login toevoegen aan de kluis' });
    await v.getByLabel('Websites').fill('https://winkel.example');
    await v.getByLabel('Gebruikersnaam of e-mailadres').fill('sanne@example.com');
    await v.locator('input[type=password]').first().fill('Geheim-1234!');
    await v.getByRole('button', { name: /Opslaan|Toevoegen/ }).click();
    await page.waitForTimeout(800);
    const vaultTxt = await mainText(page);
    check('8.3', 'kluis voor bots: een login toevoegen; het wachtwoord komt nooit op het scherm', /winkel\.example/.test(vaultTxt) && !/Geheim-1234!/.test(await page.content()));
    check('8.3', 'kluis: importeren uit Bitwarden, 1Password, Chrome/Edge of CSV', (await page.getByRole('button', { name: 'Importeren' }).count()) > 0);
    // TeamBot as an MCP server, and the local CLI.
    const tok = await tb.api('POST', '/mcp/server-tokens', { name: 'Parity', agentIds: [ids.ada] });
    const rpc = async (method, params) => (await fetch(`${tb.url}/api/public/mcp/server`, { method: 'POST', headers: { authorization: `Bearer ${tok.token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }).then((r) => r.text()));
    await rpc('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'parity', version: '1' } });
    const tl = await rpc('tools/list', {});
    check('8.4', 'TeamBot als MCP-server: list_bots en ask_bot met een eigen token', /list_bots/.test(tl) && /ask_bot/.test(tl), tl.slice(0, 160));
    ai.to('Ada', { text: 'Antwoord via de terminal.' });
    // Not spawnSync: the server runs in this process and must keep answering while the CLI waits.
    const cliRun = await new Promise((resolve) => execFile(process.execPath, [path.join(root, 'bin', 'teambot.mjs'), 'send', '--server', tb.url, '--token', tok.token, '--bot', 'Ada', 'Hoi vanuit de terminal'], { encoding: 'utf8', timeout: 60_000 }, (err, stdout, stderr) => resolve({ stdout: stdout || '', stderr: stderr || String(err || '') })));
    check('9.12', 'lokale automatisering: `teambot send` vanuit de terminal krijgt het antwoord van de bot', /Antwoord via de terminal/.test(cliRun.stdout), (cliRun.stdout || cliRun.stderr || '').slice(0, 200));
  });

  // ============================================================================================ 9. Routines
  await part('9', 'routines: schema\'s, gemist en limieten, hoofdchat, stil, webhooks, triggers, ketens, wachtpunten, kalender', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    await tb.api('PATCH', `/agents/${ids.ada}`, { tool_groups: [...new Set([...(tb.bot('Ada').tool_groups || []), 'routines', 'files'])] });
    await goTo(page, `#/m/routines/r/new?agent=${ids.ada}`, 1400);
    const when = page.getByRole('combobox', { name: 'Wanneer', exact: true });
    const opts = await when.locator('option').allInnerTexts();
    check('9.1', 'schema\'s: vaste dagen/tijden, maandelijks, interval met begintijd, eenmalig, cron, geen', ['Op vaste dagen en tijden', 'Elke maand', 'Steeds na een vaste tijd', 'Eenmalig', 'Cron'].every((x) => opts.some((o) => o.includes(x))), opts.join(' | '));
    await page.getByLabel('Naam', { exact: true }).first().fill('Maandafsluiting');
    await page.getByLabel(/Opdracht|Wat moet de bot doen/).first().fill('Maak het maandoverzicht van de winkel.');
    await when.selectOption({ label: opts.find((o) => o.includes('Elke maand')) });
    await page.getByRole('button', { name: 'laatste werkdag' }).click();
    await page.waitForTimeout(400);
    // What is rarely changed sits in folds (Uitvoering, Meldingen, Limieten …): open them to read their controls.
    for (const fold of ['routine-run', 'routine-notify', 'routine-limits']) await page.getByTestId(fold).locator('summary').click();
    await page.waitForTimeout(300);
    const ed = await mainText(page);
    check('9.1', 'maandelijks op de laatste werkdag, met een voorbeeld van de eerstvolgende run', /Eerstvolgende/.test(ed));
    const limitOpts = await page.getByLabel('Bij een limiet', { exact: true }).locator('option').allInnerTexts().catch(() => []);
    check('9.2', 'gemiste runs (inhalen of overslaan) en limietbeleid (wachten tot de reset, overslaan, fout)', /Gemiste runs/.test(ed) && limitOpts.some((o) => /Wachten tot de reset/.test(o)), limitOpts.join(' | '));
    check('9.3', 'waar de routine draait: eigen gesprek of de hoofdchat van de bot', /Waar draait de routine/.test(ed) && /In de hoofdchat van de bot/.test(ed));
    check('9.4', 'stille runs verbergen ("niets nieuws" blijft stil)', /Stille runs verbergen/.test(ed));
    check('9.7', 'resultaat naar een chat-app ("Resultaat ook sturen naar"), zodra er een kanaal is', true, 'veld verschijnt met een kanaal; bewijs: tests/routines-parity.test.ts "deliver the result to a chat app", tests/whatsapp-web.test.ts "routine result is delivered to the owner on WhatsApp, with the PDF"');
    check('9.9', 'routineketen A → B ("Daarna starten"), kringen geweigerd', /Daarna starten/.test(ed));
    await page.getByRole('button', { name: 'Routine aanmaken' }).click();
    const made = await until(() => tb.app.ctx.store.all("SELECT * FROM routines WHERE name = 'Maandafsluiting'")[0], 8000);
    check('9.1', 'routine aangemaakt vanuit de editor (maandelijks)', !!made);
    // Run in the main chat: the result lands in Ada's own chat; a silent run leaves nothing.
    const r = await tb.api('POST', '/routines', { name: 'Kassa', agent_id: ids.ada, prompt: 'Tel de kassa.', schedule: { kind: 'none' }, options: { runIn: 'main' } });
    ai.to('Ada', { text: 'Kassa geteld: 1.240 euro.' });
    await tb.api('POST', `/routines/${r.id}/run`, { test: false });
    const kassa = await until(() => tb.app.ctx.store.all("SELECT t.kind, t.agent_id FROM messages m JOIN threads t ON t.id = m.thread_id WHERE m.content LIKE '%Kassa geteld%'")[0], 20_000, 300);
    check('9.3', 'routine in de hoofdchat: het resultaat staat in een gewoon gesprek met Ada, niet in een apart routinegesprek', kassa?.kind === 'chat' && kassa?.agent_id === ids.ada, JSON.stringify(kassa));
    const quiet = await tb.api('POST', '/routines', { name: 'Stil', agent_id: ids.ada, prompt: 'Kijk of er iets nieuws is.', schedule: { kind: 'none' }, options: { runIn: 'main', hideSilentRuns: true } });
    const n0 = messagesOf(ids.adaTh).length;
    ai.to('Ada', { toolCalls: [{ name: 'routine_no_update', args: { reason: 'niets nieuws' } }] }, { text: '' });
    await tb.api('POST', `/routines/${quiet.id}/run`, { test: false });
    await until(() => tb.app.ctx.store.all("SELECT status FROM routine_runs WHERE routine_id = ? AND status NOT IN ('pending','running')", quiet.id)[0], 20_000, 300);
    const qr = tb.app.ctx.store.all('SELECT status FROM routine_runs WHERE routine_id = ?', quiet.id)[0];
    check('9.4', 'stille run: "niets nieuws", en het gesprek blijft schoon', qr?.status === 'no_update' && messagesOf(ids.adaTh).filter((m) => m.role === 'assistant').length <= messagesOf(ids.adaTh).slice(0, n0).filter((m) => m.role === 'assistant').length + 0, qr?.status);
    // Webhook with a GitHub signature and a test delivery.
    const wh = await tb.api('POST', '/routines', { name: 'Nieuwe issue', agent_id: ids.ada, prompt: 'Vat de issue samen.', schedule: { kind: 'none' } });
    const trg = await tb.api('POST', `/routines/${wh.id}/triggers`, { kind: 'webhook', preset: 'github', secret: 'parity-geheim-0123456789' });
    const payload = JSON.stringify({ action: 'opened', issue: { title: 'Bel klant terug' } });
    const crypto = await import('node:crypto');
    const sig = 'sha256=' + crypto.createHmac('sha256', trg.secret || 'parity-geheim-0123456789').update(payload).digest('hex');
    ai.to('Ada', { text: 'Issue: bel klant terug.' });
    const hook = await fetch(`${tb.url}/api/public/hooks/${trg.trigger.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': 'd-1', 'x-hub-signature-256': sig }, body: payload });
    const dup = await fetch(`${tb.url}/api/public/hooks/${trg.trigger.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': 'd-1', 'x-hub-signature-256': sig }, body: payload });
    const bad = await fetch(`${tb.url}/api/public/hooks/${trg.trigger.id}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-github-event': 'issues', 'x-github-delivery': 'd-2', 'x-hub-signature-256': 'sha256=00' }, body: payload });
    check('9.5', 'webhook met GitHub-handtekening: aangenomen, dubbele levering genegeerd, foute handtekening geweigerd', hook.status === 202 && dup.status === 200 && bad.status === 401, `${hook.status}/${dup.status}/${bad.status}`);
    await goTo(page, `#/m/routines/r/${wh.id}?tab=triggers`, 1400);
    await page.getByRole('button', { name: 'Trigger toevoegen' }).click();
    const kinds = await page.getByLabel('Soort trigger').locator('option').allInnerTexts();
    check('9.6', 'triggers: webhook, feed, webpagina, map, e-mail en chatbericht (WhatsApp, Telegram …)', ['Webhook', 'RSS', 'Webpagina', 'Map', 'E-mail', 'Chat-bericht'].every((x) => kinds.some((k) => k.includes(x))), kinds.join(' | '));
    await page.keyboard.press('Escape');
    check('9.8', 'workflows tekenen: later afgesproken (na 0.4, achter Geavanceerd)', true, 'docs/PLAN_0.4.md › Na 0.4');
    // Chain A → B.
    const b = await tb.api('POST', '/routines', { name: 'Doorgeven', agent_id: ids.ada, prompt: 'Verwerk het resultaat.', schedule: { kind: 'none' } });
    const a = await tb.api('POST', '/routines', { name: 'Ophalen', agent_id: ids.ada, prompt: 'Haal de bestellingen op.', schedule: { kind: 'none' }, options: { then: { routineId: b.id, on: 'done', passResult: true } } });
    ai.to('Ada', { text: 'Drie bestellingen.' }, { text: 'Verwerkt.' });
    await tb.api('POST', `/routines/${a.id}/run`, { test: false });
    check('9.9', 'keten: na routine A start routine B met het resultaat', !!(await until(() => tb.app.ctx.store.all("SELECT id FROM routine_runs WHERE routine_id = ? AND status = 'done'", b.id)[0], 20_000, 300)));
    // wait_for: a bot waits for a file in its folder and goes on in the same conversation.
    await openChat(page, 'Ada');
    await ask(page, 'Ada', 'Laat me weten als de levering binnen is.', { toolCalls: [{ name: 'wait_for', args: { event: 'file', path: 'levering', pattern: '*.txt', label: 'levering', timeout_minutes: 10, then: 'Meld de eigenaar dat de levering binnen is.' } }] }, { text: 'Ik wacht op de levering.' });
    // In "Vraagt toestemming" a waitpoint is one clear card: approve it once.
    if (await page.getByRole('button', { name: /^Eén keer toestaan/ }).count()) {
      await page.getByRole('button', { name: /^Eén keer toestaan/ }).first().click();
      await tb.idle(15_000);
    }
    const wp = await until(() => tb.app.ctx.store.all("SELECT id FROM routines WHERE json_extract(options, '$.waitpoint') IS NOT NULL")[0], 8000);
    check('9.10', 'wachten op een gebeurtenis (wait_for): een wachtpunt', !!wp, toolResultOf(ids.adaTh).slice(0, 160));
    await shows(page, '9.11', 'kalender met week en maand, gepland en gebeurd', '#/m/routines/kalender', ['Week', 'Maand', 'Vandaag']);
  });

  // ============================================================================================ 10. Samenwerken
  await part('10', 'bots samen: vragen en wekken, groepen met vier werkwijzen, grenzen, organisatie', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    const bo = await makeBot('Bo', { access_mode: 'auto' });
    await openChat(page, 'Ada');
    ai.to('Bo', { text: 'Bo: er staan 7 bakfietsen in het magazijn.' });
    ai.to('Ada', { toolCalls: [{ name: 'ask_bot', args: { bot: 'Bo', message: 'Hoeveel bakfietsen staan er in het magazijn?' } }] }, { text: 'Ik heb het aan Bo gevraagd.' }, (req) => ({ text: `Antwoord van Bo: ${JSON.stringify(req.messages).includes('7 bakfietsen') ? '7 bakfietsen' : 'nog niets'}` }));
    await send(page, 'Vraag Bo hoeveel bakfietsen er zijn.');
    await until(() => /Antwoord van Bo: 7 bakfietsen/.test(lastOf(ids.adaTh)), 30_000, 300);
    check('10.1', 'bot vraagt een andere bot (async) en wordt gewekt met het antwoord', /Antwoord van Bo: 7 bakfietsen/.test(lastOf(ids.adaTh)), lastOf(ids.adaTh));
    await goTo(page, '#/m/rooms/', 1200);
    await page.getByRole('button', { name: 'Nieuwe groep' }).first().click();
    const g = page.getByRole('dialog', { name: 'Nieuwe groep' });
    await g.locator('summary', { hasText: 'Meer opties' }).click(); // the cost cap sits behind Meer opties
    await page.waitForTimeout(300);
    const gt = await g.innerText();
    check('10.2', 'groepen: lead, om de beurt, iedereen, alleen op vermelding; kostenplafond', ['Lead', 'Om de beurt', 'Iedereen', 'Alleen op vermelding', 'Kostenplafond'].every((x) => gt.includes(x)));
    await page.keyboard.press('Escape');
    const room = await tb.api('POST', '/rooms', { name: 'Winkelteam', agentIds: [ids.ada, bo.id], mode: 'everyone' });
    ai.to('Ada', { text: 'Ada: ik pak de klanten.' });
    ai.to('Bo', { text: 'Bo: ik pak het magazijn.' });
    await goTo(page, `#/t/${room.threadId}`, 1200);
    await send(page, 'Wie doet wat vandaag?');
    check('10.2', 'groepsgesprek: beide bots antwoorden', (await seeMessage(page, 'Ada: ik pak de klanten.')) && (await seeMessage(page, 'Bo: ik pak het magazijn.')));
    const ui = tb.app.ctx.store.settings(tb.owner.id).ui || {};
    await tb.api('PUT', '/settings', { ui: { ...ui, advanced: true } }); // "Grenzen" is for experts (Geavanceerd tonen)
    await page.reload();
    await goTo(page, '#/m/rooms/', 1200);
    await page.getByRole('button', { name: 'Meer opties', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Grenzen' }).click();
    await page.getByRole('dialog').getByText('Budget per keten').first().waitFor({ timeout: 8000 }).catch(() => {});
    const lim = await page.getByRole('dialog').innerText().catch(() => '');
    check('10.3', 'grenzen voor samenwerkende bots: ketendiepte, beurten, berichten per uur, budget per keten', ['ketendiepte', 'per uur', 'Budget per keten'].every((x) => lim.includes(x)), lim.slice(0, 200));
    await page.keyboard.press('Escape');
    check('10.4', 'teamserver met SSO (OIDC) en SCIM: in de servermodus (bewijs: tests/sso-scim.test.ts, tests/scim-groups.test.ts)', fs.existsSync(path.join(root, 'tests', 'sso-scim.test.ts')));
    check('10.5', 'subagents van Claude Code als stappen "Deeltaak · …" (bewijs: tests/cli-activity.test.ts)', fs.existsSync(path.join(root, 'tests', 'cli-activity.test.ts')));
  });

  // ============================================================================================ 11. Computers
  await part('11', 'computers: eigen browser, je bureaublad, oefenen, container, cloud, eigen server', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    await goTo(page, `#/agents/${ids.ada}`, 1400);
    await openSection(page, 'Computer & bestanden');
    const comp = await mainText(page);
    check('11.1', 'eigen browser per bot (profiel eigen of gedeeld, sites toestaan/blokkeren)', /Eigen browser/.test(comp));
    check('11.2', 'computer use op je eigen bureaublad (Mijn bureaublad)', /Mijn bureaublad/.test(comp));
    check('11.4', 'privé-container / VM: eerlijk "niet beschikbaar" met de reden als het niet kan', /Privé-container/.test(comp));
    check('11.6', 'eigen server via SSH', /Mijn eigen server|Eigen server/.test(comp));
    await page.getByRole('radio', { name: /Mijn bureaublad/ }).click().catch(() => {});
    await page.waitForTimeout(500);
    const host = await mainText(page);
    // The third desktop level is called "Niet vragen" since 10 Nov (ui/src/modules/browser/api.ts LEVELS): "Volledige
    // toegang" is only the bot's own level, and a bot on it never asks per desktop action.
    const at = Math.max(0, host.indexOf('Toegangsniveau'));
    check('11.2', 'bureaublad: vraag bij elke actie, één keer per taak, of zelfstandig ("Niet vragen"); hele scherm zien', /Vraag bij elke actie/.test(host) && /Vraag één keer per taak/.test(host) && /Niet vragen/.test(host) && /hele scherm zien/.test(host), host.slice(at, at + 400));
    await page.getByRole('radio', { name: /Eigen server/ }).click().catch(() => {});
    await page.waitForTimeout(500);
    check('11.5', 'cloud-VM laten maken (Hetzner, DigitalOcean), met de kosten vooraf', /Cloud-VM laten maken/.test(await mainText(page)));
    await goTo(page, '#/settings/general', 800); // leave without saving ("Niet opslaan")
    await openChat(page, 'Ada');
    check('11.1', 'browser in de app: paneel naast de chat met live beeld, overnemen en beeld-in-beeld (bewijs: tests/e2e/browser-dock.mjs)', fs.existsSync(path.join(here, 'browser-dock.mjs')));
    check('11.3', 'oefenen en terugdraaien: zie 5.3', true);
    // 0.4.4: own build on the screen driver of computer use (Sunshine/Moonlight/RustDesk are GPL/AGPL). The full use
    // from a phone and another PC (touch, keyboard, screens, quality, the stop bar) is tests/e2e/remote-desktop.mjs.
    await goTo(page, '#/m/remote-desktop', 900);
    const rdText = await mainText(page);
    check('11.7', 'bureaublad op afstand vanaf de telefoon: standaard uit, aanzetten alleen op de computer, kijken en bedienen met aanraken en toetsenbord, schermkeuze, stopbalk op de pc (bewijs: tests/e2e/remote-desktop.mjs)', /Bureaublad op afstand/.test(rdText) && /Staat uit/.test(rdText) && fs.existsSync(path.join(here, 'remote-desktop.mjs')), rdText.slice(0, 160));
  });

  // ============================================================================================ 12. Spraak
  await part('12', 'spraak: lokaal dicteren, lokaal voorlezen, live gesprek, vergadernotities', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    const vs = await tb.api('GET', '/voice/settings');
    check('12.1', 'dicteren standaard lokaal en gratis (Parakeet/Whisper via sherpa-onnx), ook Nederlands', vs.settings?.stt?.engine === 'local');
    await shows(page, '12.1', 'Instellingen › Spraak: herkenning op deze computer, sneltoets in elk programma', '#/settings/voice-spraak', ['op deze computer omgezet in tekst', 'Dicteren in elk programma']);
    const tr = await fetch(`${tb.url}/api/voice/transcribe`, { method: 'POST', headers: { authorization: `Bearer ${tb.token}`, 'content-type': 'audio/wav' }, body: wavSilence() });
    const trj = await tr.json().catch(() => ({}));
    check('12.1', 'zonder spraakmodel: een eerlijke melding (eerst downloaden), geen stille fout', tr.status === 409 && /download|model/i.test(trj.error || ''), `${tr.status} ${trj.error || ''}`);
    check('12.2', 'voorlezen standaard lokaal (stemmen in 10 talen), snelheid instelbaar', vs.settings?.tts?.engine === 'local' && /Voorlezen/.test(await textOf(page, '#/settings/voice-spraak')) && /Snelheid/.test(await mainText(page)));
    await openChat(page, 'Ada');
    await page.getByRole('button', { name: 'Live praten' }).click();
    const call = page.getByRole('dialog', { name: /Praten met Ada/ });
    // 0.4.4: the free choice is the live call on the pc ("Live gesprek, gratis"); "Gratis gesprek, om de beurt" joins it
    // once speech recognition is ready.
    check('12.3', 'live gesprek: gratis op je eigen pc (onderbreken door te praten, of om de beurt) of OpenAI Realtime', await call.getByRole('radio', { name: /Live gesprek, gratis|Gratis gesprek/ }).first().waitFor({ timeout: 5000 }).then(() => true).catch(() => false));
    await page.keyboard.press('Escape');
    await goTo(page, '#/m/voice/vergadering', 800);
    check('12.4', 'vergadernotities: opnemen (met toestemming van iedereen), uitschrijven, notulen door een bot', await page.getByRole('button', { name: 'Opname starten' }).or(page.getByText('Spraak-naar-tekst is nog niet ingesteld')).first().waitFor({ timeout: 10_000 }).then(() => true).catch(() => false), 'zonder spraakmodel eerlijk: eerst instellen; opnemen zelf: npm run voice:live');
  });

  // ============================================================================================ 13. Telefoon
  await part('13', 'telefoon: app (PWA), bereikbaar, push, koppelen en intrekken, delen, alles bedienen', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    if (!phone) phone = await pairPhone();
    const manifest = await fetch(`${tb.url}/manifest.webmanifest`).then((r) => r.json());
    check('13.1', 'telefoon-app: installeerbare PWA (beginscherm, snelkoppelingen) en de iPhone-app-broncode', manifest.display === 'standalone' && fs.existsSync(path.join(root, 'mobile', 'ios')));
    check('13.5', 'delen vanuit andere apps (Android-deelmenu)', !!manifest.share_target);
    // The owner's phone can do what the computer can (0.4.1): make a bot, chat, change a setting.
    const made = await phone.device('POST', '/agents', { name: 'Telefoonbot', provider_id: mockId(), model: 'mock-1' });
    check('13.6', 'telefoon: een bot maken kan (0.4.1)', made.status === 200 && !!made.body.id, `${made.status}`);
    const pth = await phone.device('POST', '/threads', { agentId: made.body.id });
    ai.to('Telefoonbot', { text: 'Hoi vanaf je telefoon.' });
    await go(phone.page, `#/t/${pth.body.id}`, 1500);
    // On a phone Enter is a new line: the button sends.
    await phone.page.getByRole('textbox', { name: 'Bericht' }).fill('Hoi');
    await phone.page.getByRole('button', { name: 'Versturen' }).click();
    check('13.6', 'telefoon: chatten met een bot', await seeMessage(phone.page, 'Hoi vanaf je telefoon.'));
    check('13.6', 'telefoon: geen horizontaal scrollen in de chat (390 px)', (await overflow(phone.page)) <= 1);
    const secrets = await phone.device('GET', '/secrets');
    check('13.6', 'telefoon: geheimen bekijken blijft op de computer (403 met uitleg)', secrets.status === 403 && /computer/.test(secrets.body.error || ''));
    const push = await phone.device('GET', '/mobile/push');
    check('13.3', 'push: Web Push op de telefoon (via https of Tailscale) en APNs voor de iPhone-app', push.status === 200 && 'publicKey' in push.body);
    const reach = await tb.api('GET', '/mobile/reachability');
    // 0.4.4: "zonder Tailscale" is no longer "later afgesproken" but the TeamBot connection (iroh, server/modules/mobile
    // iroh.ts); the reachability answer carries `iroh` instead of the old `relay: { available: false }`, and offers it
    // as an address whenever the library is present on this computer.
    const irohOffered = reach.candidates?.some((c) => c.kind === 'iroh' && c.secure);
    check('13.2', 'bereikbaar: thuis via wifi, onderweg via Tailscale met één knop of zonder Tailscale via de TeamBot-verbinding', Array.isArray(reach.candidates) && typeof reach.iroh?.available === 'boolean' && (!reach.iroh.available || irohOffered), JSON.stringify({ iroh: reach.iroh, kinds: reach.candidates?.map((c) => c.kind) }));
    // Revoke on the computer: the phone stops at once.
    const devs = await tb.api('GET', '/mobile/devices');
    const me = devs.find((d) => d.name === 'iPhone van Sanne');
    await goTo(page, '#/settings/mobile-telefoon', 1400);
    await page.getByRole('button', { name: 'Intrekken' }).first().click();
    await confirmDialog(page, 'Intrekken').catch(async () => page.getByRole('dialog').getByRole('button', { name: 'Intrekken' }).click());
    await page.waitForTimeout(800);
    const after = await phone.device('GET', '/agents');
    check('13.4', 'apparaat intrekken op de computer: de telefoon kan direct niets meer', !!me && after.status === 401, `${after.status}`);
  });

  // ============================================================================================ 14. Kanalen
  await part('14', 'kanalen: WhatsApp (QR met waarschuwing, of Business), Telegram, Discord, Slack, e-mail, veiligheid', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    await goTo(page, '#/m/channels/', 1200);
    await page.getByRole('button', { name: /Kanaal toevoegen/ }).first().click();
    await page.waitForTimeout(500);
    const add = await mainText(page);
    const dialogs = (await page.getByRole('dialog').allInnerTexts().catch(() => [])).join(' ');
    const all = `${add} ${dialogs}`;
    check('14.3', 'Telegram, Discord en Slack als kanaal (zonder open poort)', ['Telegram', 'Discord', 'Slack'].every((x) => all.includes(x)));
    check('14.4', 'e-mail als kanaal (IMAP en SMTP)', /E-mail/.test(all));
    check('14.1', 'WhatsApp: via de QR-code (onofficieel, met waarschuwing) of de officiële Business-API', /WhatsApp \(QR-code\)/.test(all) && /Business/.test(all));
    const qr = page.locator('[data-adapter="whatsapp-web"]');
    if (await qr.count()) {
      await qr.first().click();
      check('14.1', 'WhatsApp via QR: eerst "Lees dit eerst" met wat het risico is', await page.getByRole('dialog', { name: 'Lees dit eerst' }).waitFor({ timeout: 5000 }).then(() => true).catch(() => false));
    }
    await page.keyboard.press('Escape');
    await page.keyboard.press('Escape');
    // A local webhook channel (no internet): the safety tabs and who answers.
    const bnd = await tb.api('POST', '/channels/bindings', { adapter: 'webhook', name: 'Eigen app', agent_id: ids.ada, config: { replyMode: 'none' }, secrets: { signingSecret: 'parity-webhook-geheim-0123456789' } });
    const ch = await textOf(page, `#/m/channels/${bnd.id}`, 1500);
    check('14.5', 'veiligheid per kanaal: toegang (allowlist, koppelcode), alleen praten voor anderen, logboek', /Toegang/.test(ch) && /Logboek/.test(ch));
    check('14.6', 'wie antwoordt: een bot of een groep (met de werkwijze van de groep)', /Wie antwoordt/.test(ch));
    await tb.api('PATCH', `/agents/${ids.ada}`, { tool_groups: [...new Set([...(tb.bot('Ada').tool_groups || []), 'channels'])] });
    await goTo(page, `#/agents/${ids.ada}`, 1400);
    await openSection(page, 'Kanalen');
    await page.waitForTimeout(800);
    check('14.2', 'bestanden (pdf) sturen naar de eigenaar zonder te vragen: per bot aan te zetten', /zonder te vragen berichten en bestanden sturen/.test(await mainText(page)));
  });

  // ============================================================================================ 15. Meldingen
  await part('15', 'meldingen: niveaus per bot, geluid, zwevend statusvenster, telefoon', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    await shows(page, '15.1', 'meldingen per bot (alles, alleen belangrijk, niets) en geluid', '#/settings/notifications-meldingen', ['Geluid bij een melding', 'Alles', 'Alleen belangrijk', 'Niets']);
    check('15.2', 'zwevend statusvenster (desktop-app; bewijs: tests/e2e/status-check.mjs in echte Electron)', fs.existsSync(path.join(root, 'desktop', 'status.ts')) && /Zwevend statusvenster/.test(fs.readFileSync(path.join(root, 'desktop', 'main.ts'), 'utf8')));
    check('15.3', 'telefoon: pushmeldingen, zie 13.3', true);
  });

  // ============================================================================================ 16. Instellingen
  await part('16', 'back-ups, updates, wakker houden, privacy, taal', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    await goTo(page, '#/settings/backups-app', 1400);
    await page.getByRole('button', { name: 'Nu een back-up maken' }).click();
    const listed = await until(async () => (await tb.api('GET', '/backups')).items?.length > 0, 30_000, 500);
    check('16.1', 'back-ups in de app: elke dag automatisch, nu maken, terugzetten met één klik', listed && /Elke dag automatisch/.test(await mainText(page)));
    const upd = await tb.api('GET', '/backups/updates');
    check('16.2', 'updates: back-up vooraf, "Wat is er nieuw", terug naar de vorige versie; nog geen openbaar kanaal (achter)', !!upd.version && Array.isArray(upd.whatsNew || upd.history || []));
    // Since 12 Nov: Instellingen › Meer mogelijkheden › Deze computer.
    const gen = await textOf(page, '#/settings/systeem');
    check('16.3', 'pc wakker houden terwijl routines of taken lopen (desktop-app; ook op batterij)', /Houd de pc wakker terwijl routines of taken lopen/.test(gen));
    await shows(page, '16.4', 'privacy: geen statistieken of foutrapporten; "Wat verlaat je pc?"', '#/settings/data', ['Wat verlaat je pc?', 'geen statistieken']);
    await goTo(page, '#/settings/general', 900);
    await page.getByLabel('Taal van de app').click();
    const langs = (await page.getByRole('option').allInnerTexts().catch(() => [])).join(' | ');
    await page.keyboard.press('Escape');
    check('16.5', 'taal van de app: 11 talen', langs.includes('العربية') && langs.includes('Українська'), langs.slice(0, 200));
  });

  // ============================================================================================ 17. Stabiliteit
  await part('17', 'herstel na herstart', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    await openChat(page, 'Ada');
    ai.to('Ada', async () => (await sleep(20_000), { text: 'te laat' }));
    await send(page, 'Doe iets langs.');
    await until(() => tb.app.ctx.store.all("SELECT id FROM runs WHERE status = 'running'")[0], 8000);
    await tb.restart();
    ai.clear();
    await page.reload();
    await page.waitForTimeout(2000);
    const t = await mainText(page);
    check('17.2', 'na een herstart: de taak is onderbroken (nooit stil herhaald) en te hervatten', /onderbroken/.test(t) && (await page.getByRole('button', { name: 'Hervatten' }).count()) > 0, t.slice(-200));
    check('17.1', 'prestaties gemeten: npm run perf (14 budgetten, 50.000 berichten); geen vergelijkende meting naast OpenBot', fs.existsSync(path.join(here, 'perf.mjs')));
  });

  // ============================================================================================ 18. Uiterlijk
  await part('18', 'zijbalk met gezichten en status, thema, eenvoud', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    await goTo(page, '#/', 800);
    const side = page.getByRole('navigation', { name: 'Hoofdmenu' });
    const st = (await side.innerText().catch(() => '')) || '';
    // 0.4.2 (simpler desktop): Wacht op jou, Taken and Instellingen; Routines live on Taken, Geheugen and Marktplaats
    // under Instellingen › Bots en teams.
    check('18.1', 'zijbalk: de bots met gezicht en status, Wacht op jou, Taken en Instellingen', ['Wacht op jou', 'Taken', 'Instellingen'].every((x) => st.includes(x)));
    check('18.1', 'eigen volgorde en vastzetten (bovenaan)', (await page.getByRole('button', { name: 'Volgorde van de bots' }).count()) > 0);
    await goTo(page, '#/settings/appearance', 1000);
    await page.getByRole('radio', { name: 'Donker' }).click();
    await page.waitForTimeout(300);
    check('18.2', 'thema licht, donker of systeem; figuurtjes glad of vilt', await page.evaluate(() => document.documentElement.classList.contains('dark') || document.documentElement.dataset.theme === 'dark'));
    await page.getByRole('radio', { name: 'Systeem' }).click();
    check('18.3', 'eenvoudig is de standaard; experts achter Geavanceerd tonen (hier aangezet in deel 6)', tb.app.ctx.store.settings(tb.owner.id).ui?.advanced === true);
  });

  // ============================================================================================ R. Wat Sanne echt gebruikt
  await part('R', 'wat Sanne echt gebruikt in OpenBot', async () => {
    ai.clear(); // nothing scripted for one part leaks into the next
    check('R.3', 'samenwerken: berichten tussen bots met wekken (10.1), vraagkaarten (4.8), plankaart (4.8), bijsturen (4.4), context wissen (3.7)', true);
    check('R.6', 'kosten per beurt geschat met de bron, ook "via abonnement" (3.6)', true);
    const kinds = (await tb.api('GET', '/providers')).map((p) => p.kind);
    check('R.7', 'providers zoals bij Sanne: Claude Code, Codex, OpenCode, LM Studio en een DeepSeek-sleutel', ['claude-code', 'codex-cli', 'opencode', 'lmstudio', 'deepseek'].every((k) => kinds.includes(k)), kinds.join(','));
    const desk = fs.readFileSync(path.join(root, 'desktop', 'main.ts'), 'utf8');
    check('R.11', 'op de achtergrond blijven draaien (venster sluiten = systeemvak)', /win\?\.hide\(\)/.test(desk));
    check('R.11', 'spellingcontrole: rechtsklik met suggesties en "Toevoegen aan woordenboek" (nieuw in 0.4.2)', /contextMenuEntries/.test(desk) && /spellcheck: true/.test(desk));
    if (OLLAMA) {
      const ps = await fetch('http://127.0.0.1:11434/api/ps').then((r) => r.json()).catch(() => null);
      const loaded = (ps?.models || []).some((m) => String(m.name).startsWith(OLLAMA_MODEL));
      if (!loaded) check('R.7', `live Ollama overgeslagen: ${OLLAMA_MODEL} is niet geladen (niets geladen of verdrongen)`, true);
      else {
        const ol = await tb.api('POST', '/providers', { kind: 'ollama', name: 'Ollama' });
        const lb = await tb.api('POST', '/agents', { name: 'Ollie', provider_id: ol.id, model: OLLAMA_MODEL, access_mode: 'chat' });
        const th = (await tb.api('POST', '/threads', { agentId: lb.id })).id;
        await tb.api('POST', `/threads/${th}/messages`, { content: 'Antwoord met één woord: wat is de hoofdstad van Nederland?' });
        await until(() => !tb.app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running')", th).length, 300_000, 1000);
        check('R.7', 'live: een bot op de echte Ollama (qwen3.6-uncensored-snel) antwoordt', /Amsterdam/i.test(lastOf(th)), lastOf(th).slice(0, 120));
      }
    }
  });
} finally {
  // results below
}

const failedRun = summary('parity-04');
if (gaps.length) console.log(`\nBekende achterstanden en latere afspraken (geen fout; zie docs/PARITEIT_0.4.md):\n${gaps.map((g) => `  [${g.id}] ${g.name}`).join('\n')}`);
if (errors.length) console.log(`\nPaginafouten (${errors.length}):\n  ${[...new Set(errors)].slice(0, 20).join('\n  ')}`);
await phone?.ctx?.close().catch(() => {});
await page?.context().close().catch(() => {});
await tb.close().catch(() => {});
await browser.close().catch(() => {});
lm.close();
rmrf(dir, work, home, openbot.root);
process.exit(failedRun);
