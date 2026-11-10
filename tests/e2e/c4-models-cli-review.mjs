// End-to-end UI check (round 4): TeamBot's own CLI copies and "Gratis starten" (C-07), login with a device code,
// model facts, thinking levels and the context window (C-01, C-11, C-13), the review step for shared skills (B-11),
// the side-by-side rehearsal comparison (B-42), moves in practice mode as one row (B-36) and the reserve engine in
// the chat header. Desktop and phone width.
// Everything local: a fixture npm registry signed with a test key, a fixture GitHub release (OpenCode 2.x), fake CLIs,
// a fake Ollama, TEMP data and an empty
// HOME/PATH, so nothing from this PC (no real CLI, no OpenBot folder) is used or changed.
// Screenshots only when TEAMBOT_E2E_SHOTS=<folder> is set.
// Usage: npm run build:ui && node --import tsx tests/e2e/c4-models-cli-review.mjs
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const here = path.dirname(fileURLToPath(import.meta.url));
const { fakeCliScript, startFixtureGithub, startFixtureRegistry, tarGz, zip } = await import('../runtime-fixture.ts');
const { RUNTIMES, platformKey } = await import('../../server/modules/cli-agents/runtimes.ts');
const { makeOpenBotFixture } = await import('../fixtures/openbot-fixture.ts');
// A synthetic OpenBot (made-up data in TEMP) for the import preview: models in words, never "claude-sonnet-5-5".
const openbot = makeOpenBotFixture();

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name, opts = {}) => SHOTS && page.screenshot({ path: path.join(SHOTS, name), ...opts });
const fits = (page) => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
/** WCAG 2.x A/AA (axe-core) on what is on screen now; violations fail the run. */
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const axe = async (page, where) => {
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(', ')}`);
  });
  if (v.length) fail(`a11y ${where}: ${v.join(' | ')}`);
};
/** A tab of the bot page (a tab with unsaved changes carries a dot: "Meer niet opgeslagen"). */
const showTab = (page, name) => page.getByRole('tab', { name: new RegExp(`^${name}( niet opgeslagen)?$`) }).click();
/**
 * "Denken, drukte en reserve-engines" is a section on the tab Meer, behind "Meer opties". The bot editor remembers
 * open sections: open it only when it is closed.
 */
const openEngineSection = async (page) => {
  await showTab(page, 'Meer');
  await page.evaluate(() => document.querySelectorAll('details').forEach((x) => (x.open = true)));
  const btn = page.getByRole('button', { name: /Denken, drukte en reserve-engines/ });
  if ((await btn.getAttribute('aria-expanded')) !== 'true') await btn.click();
};
/** TeamBot's own dropdown (components/Listbox.tsx): the texts of its options (it opens, reads, and closes again). */
const optionTexts = async (page, box) => {
  if (!(await box.count())) return [];
  await box.click();
  const texts = (await page.locator('[role="listbox"] [role="option"]').allInnerTexts()).map((x) => x.trim());
  await page.keyboard.press('Escape');
  return texts;
};
/** Choose an option of that dropdown by its value. */
const pick = async (page, box, value) => (await box.click(), await page.locator(`[role="listbox"] [role="option"][data-value="${value}"]`).click());
/** The thinking-level options once they satisfy `ok` (they follow the chosen model), or what is there after 8 s. */
const levelsWhen = async (page, ok) => {
  const end = Date.now() + 8000;
  for (;;) {
    const l = await optionTexts(page, page.getByRole('combobox', { name: 'Denkniveau' })).catch(() => []);
    if (ok(l) || Date.now() > end) return l;
    await new Promise((r) => setTimeout(r, 150));
  }
};

// ---- fixture npm registry with a Codex package, fixture GitHub with an OpenCode 2.x release (fake binaries) ----
const PLAT = platformKey();
const CX = RUNTIMES['codex-cli'].pkg(PLAT, '0.167.0');
const reg = await startFixtureRegistry({
  packages: [
    { name: CX.name, version: CX.version, files: [{ name: 'package/package.json', data: '{}' }, { name: 'package/vendor/x86_64-test/bin/codex.mjs', data: fakeCliScript({ name: 'codex-cli', version: '0.167.0' }) }, { name: 'package/vendor/x86_64-test/codex-path/rg.txt', data: 'rg' }] },
  ],
  distTags: { '@openai/codex': { latest: '0.168.0' } },
});
const OC_ASSET = RUNTIMES.opencode.asset(PLAT);
const ocBin = { name: 'opencode.mjs', data: fakeCliScript({ name: 'opencode', version: '2.2.6' }), mode: 0o100755 };
const gh = await startFixtureGithub({ repo: RUNTIMES.opencode.main, releases: [{ tag: 'v2.2.6', assets: [{ name: OC_ASSET, data: OC_ASSET.endsWith('.zip') ? zip([ocBin]) : tarGz([{ ...ocBin, mode: 0o755 }]) }] }] });

// ---- fake Ollama ----
const info = { 'general.architecture': 'llama', 'llama.block_count': 32, 'llama.attention.head_count': 32, 'llama.attention.head_count_kv': 8, 'llama.embedding_length': 4096 };
const ollama = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const send = (o) => (res.writeHead(200, { 'content-type': 'application/json' }), res.end(JSON.stringify(o)));
    if (req.url === '/api/version') return send({ version: '0.40.15' });
    if (req.url === '/api/tags') return send({ models: [{ name: 'denker:latest', digest: 'a', details: { parameter_size: '8B', quantization_level: 'Q4_K_M', context_length: 131072 }, capabilities: ['completion', 'tools', 'thinking'] }] });
    if (req.url === '/api/ps') return send({ models: [{ name: 'denker:latest', context_length: 8192 }] });
    if (req.url === '/api/show') return send({ model_info: info });
    if (req.url === '/v1/models') return send({ data: [{ id: 'denker:latest' }] });
    if (req.url === '/v1/chat/completions') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Antwoord van het lokale model.' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 5, completion_tokens: 4 } })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(404);
    res.end('{}');
  });
});
await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
const ollamaUrl = `http://127.0.0.1:${ollama.address().port}/v1`;
const FAKE_ACP = path.join(here, '..', 'fixtures', 'cli-agents-fake-acp.mjs');
// ---- fake OpenAI API: only the (free) model list, like a real key gives it ----
const openaiFake = http.createServer((req, res) => {
  res.writeHead(req.url === '/v1/models' ? 200 : 404, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url === '/v1/models' ? { data: [{ id: 'gpt-6.1-terra' }, { id: 'gpt-4o-mini' }, { id: 'gpt-onbekend-1' }] } : {}));
});
await new Promise((r) => openaiFake.listen(0, '127.0.0.1', r));
const openaiUrl = `http://127.0.0.1:${openaiFake.address().port}/v1`;

// The browser starts first (it needs this PC's normal environment), then TeamBot gets an empty one.
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-c4-home-'));
Object.assign(process.env, {
  TEAMBOT_RUNTIME_REGISTRY: reg.url,
  TEAMBOT_RUNTIME_KEYS: JSON.stringify(reg.keys),
  TEAMBOT_RUNTIME_GITHUB: gh.url,
  TEAMBOT_OPENBOT_HOME: openbot.home,
  TEAMBOT_OPENBOT_DIR: openbot.dataDir,
  TEAMBOT_RUNTIME_PINS: JSON.stringify({ opencode: { integrity: { [PLAT]: gh.digest('v2.2.6', OC_ASSET) } }, 'codex-cli': { integrity: { [PLAT]: reg.integrity(CX.name, CX.version) } } }),
  PATH: path.dirname(process.execPath),
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_DATA_HOME: path.join(home, 'xdg', 'data'),
  XDG_CONFIG_HOME: path.join(home, 'xdg', 'config'),
  XDG_CACHE_HOME: path.join(home, 'xdg', 'cache'),
  XDG_STATE_HOME: path.join(home, 'xdg', 'state'),
  FAKE_LOGGED_OUT: '1',
  FAKE_LOGIN_MS: '20000',
  // The fake Claude Code is logged out until its in-app login succeeded.
  FAKE_CLAUDE_LOGIN_FILE: path.join(home, 'claude-ingelogd.txt'),
});
delete process.env.Path;

const { createApp } = await import('../../server/app.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-c4-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const api = async (method, p, body, tok = token) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${j.error}`);
  return j;
};
step(`TeamBot op ${app.url}; nep-register ${reg.url}; nep-Ollama ${ollamaUrl}`);
// Local engines are only ever found at the fake Ollama (when `on`), never at this computer's own Ollama/LM Studio ports.
const localEngines = (on) => {
  for (const k of app.ctx.providers.kinds.values()) {
    if (k.billing !== 'local' || !k.detect) continue;
    k.detect = async () => (on && k.id === 'ollama' ? { installed: true, baseUrl: ollamaUrl, detail: 'e2e' } : { installed: false, detail: 'e2e' });
  }
};
localEngines(false);

let page = null;
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|404/.test(m.text()) && errors.push(m.text()));
};
try {
  page = await browser.newPage({ viewport: { width: 1400, height: 950 }, bypassCSP: true });
  watch(page);
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForLoadState('domcontentloaded');

  // ---------------------------------------------------------------- free path: welcome without any AI, Ollama setup
  await page.getByRole('button', { name: 'Gratis starten' }).waitFor({ timeout: 20000 });
  const hint = page.getByTestId('local-model-hint');
  if ((await hint.innerText().catch(() => '')) !== 'Met een lokaal model (Ollama) werkt het ook offline en zonder daglimiet. Ollama instellen') fail('vrij pad: welkom zegt niet in één regel wat een lokaal model oplevert');
  if ((await hint.getByRole('link', { name: 'Ollama instellen' }).getAttribute('href')) !== '#/settings/providers?koppel=ollama') fail('vrij pad: link naar de Ollama-instelling ontbreekt');
  await shot(page, 'e-00-welkom-gratis-starten.png');
  await hint.getByRole('link', { name: 'Ollama instellen' }).click();
  const ollamaSetup = page.getByTestId('ollama-setup');
  await ollamaSetup.waitFor({ timeout: 20000 });
  if (!/draait nog niet[\s\S]*Ollama downloaden[\s\S]*Opnieuw zoeken/.test(await ollamaSetup.innerText()) || (await ollamaSetup.getByRole('link', { name: /Ollama downloaden/ }).getAttribute('href')) !== 'https://ollama.com/download') fail('vrij pad: de Ollama-instelling zegt niet in één regel hoe je Ollama krijgt');
  await axe(page, 'Ollama koppelen (nog niet geïnstalleerd)');
  await page.keyboard.press('Escape');
  step('vrij pad: welkom met "Gratis starten" en één regel over een lokaal model; "Ollama instellen" opent de stappen');

  // ---------------------------------------------------------------- C-07: CLI page, Gratis starten, own copy, login
  await page.goto(`${app.url}/#/settings/cli-agents-cli`);
  const free = page.getByTestId('free-start');
  await free.waitFor({ timeout: 20000 });
  await shot(page, 'e-01-cli-gratis-starten.png');
  if (!(await free.getByTestId('local-model-hint').count())) fail('vrij pad: CLI-pagina zegt niet wat een lokaal model oplevert');
  // Not installed yet: no version badge, and the button to install it (the badge "niet geïnstalleerd" is gone).
  if ((await page.getByTestId('own-copy-opencode').getByText(/^versie /).count()) || !(await page.getByTestId('own-copy-opencode').getByRole('button', { name: /^Installeren \(versie / , includeHidden: true }).count())) fail('C-07: eigen kopie van OpenCode niet als nog te installeren getoond');
  // Now Ollama runs here: "Gratis starten" connects it and makes it the reserve of new OpenCode bots.
  localEngines(true);
  // Round 5 (C-7): with Ollama found the "Ollama instellen" hint goes, also before it is connected.
  await page.reload();
  await free.waitFor({ timeout: 20000 });
  if (await free.getByTestId('local-model-hint').count()) fail('vrij pad: CLI-pagina toont "Ollama instellen" terwijl Ollama al draait');
  await free.getByRole('button', { name: 'Gratis starten' }).click();
  await page.getByText(/OpenCode staat klaar met Big Pickle\. Nieuwe bots op OpenCode krijgen Ollama \(lokaal\) · denker als reserve-engine\./).waitFor({ timeout: 30000 });
  step('C-07: "Gratis starten" installeerde de eigen kopie, koppelde OpenCode met een gratis model en zette Ollama klaar als reserve');
  const ocCard = page.getByTestId('own-copy-opencode');
  // The details of a card (own copy, path, costs) are under its "Meer opties".
  const openMore = (id) => page.getByTestId(`cli-${id}`).locator('details > summary').first().click();
  await openMore('opencode');
  await ocCard.getByText(/versie 2\.2\.6 · in gebruik/).waitFor({ timeout: 10000 });
  if (!(await ocCard.getByText(/Het officiële programma van OpenCode.*gecontroleerd na het downloaden/).count())) fail('C-07: de eigen OpenCode-kopie zegt niet dat hij het officiële programma is en gecontroleerd wordt');
  if (!(await page.getByText('(door TeamBot geïnstalleerd)').count())) fail('C-07: "Programma: … (eigen kopie van TeamBot)" ontbreekt');
  await ocCard.scrollIntoViewIfNeeded();
  await shot(page, 'e-02-opencode-eigen-kopie.png');
  // Codex in one go: ONE button installs the own copy and starts the login with a device code inside TeamBot.
  const cx = page.getByTestId('cli-codex-cli');
  await cx.scrollIntoViewIfNeeded();
  await cx.getByRole('button', { name: 'Installeren en inloggen' }).click();
  const login = page.getByTestId('login-codex-cli');
  await login.getByText('WXYZ-12345').waitFor({ timeout: 45000 });
  step('C-07: "Installeren en inloggen" installeerde de eigen Codex-kopie en begon zelf met inloggen');
  if (!(await login.getByRole('link', { name: /de inlogpagina/ }).getAttribute('href'))?.startsWith('https://auth.openai.com/')) fail('C-07: inloglink ontbreekt');
  await login.scrollIntoViewIfNeeded();
  await shot(page, 'e-03-codex-inloggen.png');
  await axe(page, 'CLI-pagina met eigen kopieën en inloggen');
  step('C-07: inloggen met een apparaatcode in TeamBot (link + code)');
  await login.getByRole('button', { name: 'Annuleren' }).click();
  const cxCard = page.getByTestId('own-copy-codex-cli');
  await openMore('codex-cli');
  await cxCard.getByText(/versie 0\.167\.0/).first().waitFor({ timeout: 30000 });
  await cxCard.getByText(/update 0\.168\.0 beschikbaar/).waitFor({ timeout: 10000 });
  step('C-07: eigen Codex-kopie geïnstalleerd; updatemelding 0.168.0 zichtbaar');
  // Claude Code is not here: the official install lines are folded under the own copy.
  if (!(await page.getByTestId('own-copy-claude-code').count())) fail('C-07: Claude Code heeft geen "Eigen kopie van TeamBot"');
  // C-07: Claude Code logs in inside TeamBot too: its sign-in link, then the code from that page pasted back here;
  // TeamBot then connects it and tests it by itself ("Verbinding werkt").
  await api('PUT', '/cli-agents/paths/claude-code', { path: path.join(here, '..', 'fixtures', 'cli-agents-fake-claude.mjs') });
  await page.getByRole('button', { name: 'Opnieuw zoeken' }).click();
  const ccCard = page.getByTestId('cli-claude-code');
  await ccCard.getByRole('button', { name: 'Inloggen', exact: true }).click();
  const ccLogin = page.getByTestId('login-claude-code');
  const ccLink = ccLogin.getByRole('link', { name: /de inlogpagina/ });
  await ccLink.waitFor({ timeout: 15000 });
  if (!(await ccLink.getAttribute('href'))?.startsWith('https://claude.com/cai/oauth/authorize?')) fail('C-07: Claude-inloglink ontbreekt');
  await ccLogin.scrollIntoViewIfNeeded();
  await shot(page, 'e-03b-claude-inloggen.png');
  await axe(page, 'Claude Code inloggen in TeamBot');
  await ccLogin.getByRole('textbox', { name: 'Code van de inlogpagina' }).fill('goede-code#s123');
  await ccLogin.getByRole('button', { name: 'Koppelen' }).click();
  await ccCard.getByTestId('connect-ok').waitFor({ timeout: 20000 });
  // The card looks again at the pc right after connecting; "gekoppeld" follows within a moment.
  await page.locator('[data-testid="cli-claude-code"][data-connect-state="on"]').waitFor({ timeout: 8000 }).catch(async () => fail(`C-07: Claude Code staat na het inloggen niet op "gekoppeld" (${await ccCard.getAttribute('data-connect-state')})`));
  await shot(page, 'e-03c-claude-gekoppeld.png');
  // The rest of this suite makes its own Claude Code provider (with the fixture path in its config).
  for (const p of await api('GET', '/providers')) if (p.kind === 'claude-code') await api('DELETE', `/providers/${p.id}`);
  step('C-07: Claude Code inloggen in TeamBot: link naar de inlogpagina, code terugplakken, ingelogd');

  // ---------------------------------------------------------------- OpenBot import preview: models in words (A-04)
  await page.goto(`${app.url}/#/m/openbot-import`);
  await page.getByRole('button', { name: 'OpenBot inlezen' }).click();
  await page.getByText(/^Model:/).first().waitFor({ timeout: 30000 });
  const preview = await page.locator('body').innerText();
  if (!/Model:\s*Opus 5\.5/.test(preview)) fail('A-04: het model in het OpenBot-voorbeeld staat niet in woorden ("Opus 5.5")');
  if (!/Reserves:\s*Sonnet 5\.5 → deepseek-v4-pro → Test/.test(preview)) fail('A-04: reserves in het OpenBot-voorbeeld niet in woorden: ' + (preview.match(/Reserves:[^\n]*/)?.[0] || '(geen)'));
  if (/claude-(opus|sonnet)-\d|opencode\//.test(preview)) fail('A-04: ruwe modelcode in het OpenBot-voorbeeld: ' + preview.match(/claude-(opus|sonnet)-\S+|opencode\/\S+/)?.[0]);
  await shot(page, 'e-04-openbot-voorbeeld.png');
  step('A-04: OpenBot-voorbeeld toont "Model: Opus 5.5" en de reserves in woorden');

  // ---------------------------------------------------------------- C-01/C-11/C-13: model facts, levels, context window
  const ol = await api('POST', '/providers', { kind: 'ollama', base_url: ollamaUrl });
  const lokaal = await api('POST', '/agents', { name: 'Lokaal', provider_id: ol.id, model: 'denker:latest', access_mode: 'ask' });
  await page.goto(`${app.url}/#/agents/${lokaal.id}`);
  const facts = page.getByTestId('model-facts');
  await facts.waitFor({ timeout: 20000 });
  const factText = await facts.innerText();
  // Token sizes in the reader's compact notation ("8K" in Dutch, "8k" in English).
  for (const want of ['Tools:', 'ja', 'Afbeeldingen:', 'nee', '131.072 tokens', 'nu geladen met 8K', 'uit, aan', 'gratis']) if (!factText.includes(want)) fail(`C-01: modelgegevens missen "${want}": ${factText}`);
  const ctxSel = page.getByTestId('context-window').getByRole('combobox', { name: 'Contextvenster' });
  const opts = await optionTexts(page, ctxSel);
  if (!opts.some((o) => /16K tokens \(aanbevolen\) · ±2,1 GB geheugen/.test(o))) fail('C-13: geen geheugenschatting bij 16K: ' + opts.join(' | '));
  await pick(page, ctxSel, '65536');
  await page.getByText(/Een groot venster gebruikt veel extra geheugen/).waitFor({ timeout: 10000 });
  const saved = (await api('GET', '/providers')).find((p) => p.id === ol.id).config.contextWindows;
  if (saved?.['denker:latest'] !== 65536) fail('C-13: contextvenster niet opgeslagen: ' + JSON.stringify(saved));
  await openEngineSection(page);
  const lvl = page.getByRole('combobox', { name: 'Denkniveau' });
  await lvl.waitFor({ timeout: 5000 });
  const lv = await optionTexts(page, lvl);
  if (!lv.includes('Uit (niet nadenken)') || !lv.includes('Aan') || lv.includes('Hoog (grondig)')) fail('C-11: Ollama-niveaus niet per model: ' + lv.join(' | '));
  await showTab(page, 'Overzicht');
  await facts.scrollIntoViewIfNeeded();
  await shot(page, 'e-05-model-lokaal.png', { fullPage: true });
  await axe(page, 'bot-editor met modelgegevens en contextvenster');
  step('C-01/C-11/C-13: modelgegevens, niveaus Uit/Aan, contextvenster met geheugenschatting en waarschuwing');

  // C-01: OpenAI API models have their facts from OpenAI's own pages; an unknown one stays "onbekend".
  const oa = await api('POST', '/providers', { kind: 'openai', base_url: openaiUrl, apiKey: 'sk-e2e-niet-echt' });
  const oaBot = await api('POST', '/agents', { name: 'OpenAI-bot', provider_id: oa.id, model: 'gpt-6.1-terra', access_mode: 'ask' });
  await page.goto(`${app.url}/#/agents/${oaBot.id}`);
  const oaFacts = page.getByTestId('model-facts');
  await oaFacts.waitFor({ timeout: 20000 });
  await page.waitForFunction(() => /1[.,]050[.,]000 tokens/.test(document.querySelector('[data-testid="model-facts"]')?.textContent || ''), null, { timeout: 15000 }).catch(() => {});
  const oaText = await oaFacts.innerText();
  for (const want of ['1.050.000 tokens', 'Tools:', 'Afbeeldingen:', 'documentatie van de maker', 'maximaal']) if (!oaText.includes(want)) fail(`C-01: OpenAI-modelgegevens missen "${want}": ${oaText}`);
  if (/Context:\s*onbekend|Tools:\s*onbekend/.test(oaText)) fail('C-01: gpt-6.1-terra staat nog op "onbekend": ' + oaText);
  await shot(page, 'e-05b-model-openai.png', { fullPage: true });
  step('C-01: gpt-6.1-terra met context 1.050.000, tools en afbeeldingen ja, denkniveaus tot maximaal, bron OpenAI');

  const cc = await api('POST', '/providers', { kind: 'claude-code', config: { path: path.join(here, '..', 'fixtures', 'cli-agents-fake-claude.mjs') } });
  const ccBot = await api('POST', '/agents', { name: 'Claude', provider_id: cc.id, model: 'claude-opus-4-6', access_mode: 'ask' });
  await page.goto(`${app.url}/#/agents/${ccBot.id}`);
  await page.getByTestId('model-facts').waitFor({ timeout: 60000 });
  await openEngineSection(page);
  // claude-opus-4-6 is not in the engine's list ("Ander model"): the server still knows its levels.
  let ccLv = await levelsWhen(page, (l) => l.includes('Maximaal (traagst, duurst)'));
  if (ccLv.includes('Extra hoog') || !ccLv.includes('Maximaal (traagst, duurst)')) fail('C-11: Opus 4.6 hoort low…max zonder xhigh: ' + ccLv.join(' | '));
  await showTab(page, 'Overzicht');
  await pick(page, page.getByRole('combobox', { name: 'Model' }), 'opus');
  await showTab(page, 'Meer');
  ccLv = await levelsWhen(page, (l) => l.includes('Extra hoog'));
  if (!ccLv.includes('Extra hoog')) fail('C-11: Claude Code opus mist "Extra hoog": ' + ccLv.join(' | '));
  await page.getByRole('combobox', { name: 'Denkniveau' }).scrollIntoViewIfNeeded();
  await shot(page, 'e-06-denkniveau-claude-code.png');
  step('C-11: Claude Code-niveaus per model (Opus 4.6 zonder xhigh, Opus 5.5 met xhigh en max)');
  // The model change above is not saved (the editor would ask before leaving): go on in a fresh page.
  await page.close();
  page = await browser.newPage({ viewport: { width: 1400, height: 950 }, bypassCSP: true });
  watch(page);
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForLoadState('domcontentloaded');

  // ---------------------------------------------------------------- free path: OpenCode at its free limit, one click on
  // A bot on OpenCode (the fake 2.x ACP) that has no reserve: the failed answer offers the local model. Since package
  // D2 the default chain does this switch by itself for every bot; the one-click offer is what the owner gets with
  // that chain turned off (Instellingen › Gratis doorschakelen), so it is off for this part.
  await api('PUT', '/engine-chain/settings', { enabled: false });
  const ocAcp = await api('POST', '/providers', { kind: 'opencode', name: 'OpenCode', config: { path: FAKE_ACP, defaultModel: 'opencode/big-pickle' } });
  const zonder = await api('POST', '/agents', { name: 'Zonder reserve', provider_id: ocAcp.id, model: '', access_mode: 'ask', settings: { fallbacks: [] } });
  const thz = await api('POST', '/threads', { agentId: zonder.id });
  await page.goto(`${app.url}/#/t/${thz.id}`);
  await api('POST', `/threads/${thz.id}/messages`, { content: 'Wat is de hoofdstad van Italië? SCENARIO:freelimit' });
  const offer = page.getByTestId('switch-offer');
  await offer.waitFor({ timeout: 30000 });
  const chatText = await page.locator('body').innerText();
  if (!chatText.includes('De gratis limiet van OpenCode is bereikt')) fail('vrij pad: de limietmelding staat niet in gewone woorden in de chat');
  if (/opencode\/|big-pickle/.test(chatText)) fail('vrij pad: modelcode in de chat: ' + chatText.match(/\S*(opencode\/|big-pickle)\S*/)?.[0]);
  await shot(page, 'e-07-limiet-overschakelen.png');
  await axe(page, 'chat met overschakelknop');
  await offer.getByRole('button', { name: 'Verder met Ollama (lokaal) · denker' }).click();
  await page.getByText('Antwoord van het lokale model.').first().waitFor({ timeout: 30000 });
  if (!(await page.getByText('Zonder reserve gaat verder met Ollama (lokaal) · denker; dat is nu ook zijn reserve-engine.').count())) fail('vrij pad: de wissel staat niet in de chat');
  if (await page.getByTestId('switch-offer').count()) fail('vrij pad: de overschakelknop bleef staan');
  // Only the free limit of OpenCode: since package E an 80%+ warning of the (fake) Claude Code week can arrive too (also kind 'limit').
  const limitNotes = app.ctx.store.all("SELECT title FROM notifications WHERE user_id = ? AND ((kind = 'limit' AND title LIKE '%OpenCode%') OR title LIKE '%liep vast%')", owner.id);
  if (limitNotes.length !== 1) fail('vrij pad: niet precies één melding bij de limiet: ' + JSON.stringify(limitNotes));
  if ((await api('GET', `/agents/${zonder.id}`)).settings?.fallbacks?.[0]?.model !== 'denker:latest') fail('vrij pad: het lokale model is niet de reserve geworden');
  await shot(page, 'e-08-na-overschakelen.png');
  step('vrij pad: limiet in woorden, één melding, "Verder met Ollama (lokaal) · denker" antwoordt meteen en blijft reserve');
  await api('PUT', '/engine-chain/settings', { enabled: true });
  // A-30: "Gesprek samenvatten" with OpenCode gives one clear outcome (it showed three notices at once).
  await page.getByRole('button', { name: 'Meer opties' }).click();
  await page.getByRole('button', { name: 'Meer acties', exact: true }).click();
  await page.getByRole('button', { name: /Gesprek samenvatten/ }).click();
  await page.getByText('Niet samengevat: het gesprek is nog te kort om samen te vatten').waitFor({ timeout: 20000 });
  const compactToasts = (await page.locator('[aria-live="polite"] > div').allInnerTexts()).filter((x) => /samengevat|samen te vatten/i.test(x));
  if (compactToasts.length !== 1) fail('A-30: niet één melding bij samenvatten: ' + JSON.stringify(compactToasts));
  step('A-30: samenvatten met OpenCode geeft één duidelijke uitkomst');

  // ---------------------------------------------------------------- A-37 / Q-12: a Claude Code approval card
  // The fake Claude Code reports 86% of its week (package E); since D2 the weekly reserve (85%) would rightly send this
  // normal work to a free model. This part is about Claude Code's own card, so the weekly reserve is off meanwhile.
  await api('PUT', '/engine-chain/settings', { weeklyReserve: 0 });
  const thc = await api('POST', '/threads', { agentId: ccBot.id });
  await page.goto(`${app.url}/#/t/${thc.id}`);
  await api('POST', `/threads/${thc.id}/messages`, { content: 'SCENARIO:perm schrijf een bestand' });
  const card = page.getByRole('group', { name: 'Goedkeuring nodig' });
  await card.waitFor({ timeout: 30000 });
  const cardText = await card.innerText();
  if (!cardText.startsWith('Claude wil')) fail('A-37: de kaart noemt de bot niet: ' + cardText.split('\n')[0]);
  if (/Gevraagd door Claude Code/.test(cardText) || !/via Claude Code/.test(cardText)) fail('A-37: de engine hoort alleen klein op de kaart: ' + cardText.replace(/\n/g, ' | '));
  await page.getByText('Wil perm.txt schrijven').first().waitFor({ timeout: 10000 });
  if (await page.getByText('Schreef perm.txt').count()) fail('Q-12: de stap staat al in de verleden tijd terwijl de kaart nog wacht');
  await shot(page, 'e-09-kaart-claude-code.png');
  await axe(page, 'goedkeuringskaart van een Claude Code-bot');
  await card.getByRole('button', { name: 'Eén keer toestaan' }).click();
  await page.getByText('Schreef perm.txt').first().waitFor({ timeout: 20000 });
  step('A-37/Q-12: kaart "Claude wil …" met "via Claude Code" klein; stap "Wil perm.txt schrijven" tot het resultaat er is, daarna "Schreef perm.txt"');
  await api('PUT', '/engine-chain/settings', { weeklyReserve: 85 });

  // ---------------------------------------------------------------- B-11: review of a member's share
  const member = app.ctx.auth.createUser({ name: 'Lid', email: 'lid@test.local', password: 'geheim1234', role: 'member' });
  const mtok = app.ctx.auth.createSession(member.id, 'web', 'x').token;
  const pv = await api('POST', '/skills/import/preview', { kind: 'paste', text: '---\nname: weekplanner\ndescription: Maakt een weekplanning.\nlicense: MIT\n---\n# Weekplanner\n\nZet de taken per dag in een tabel. Tips: https://example.com/tips\n' }, mtok);
  const cm = await api('POST', '/skills/import/commit', { stagingId: pv.stagingId }, mtok);
  const sh = await api('POST', '/skills/shares', { type: 'skill', skillId: cm.results[0].skillId }, mtok);
  if (sh.status !== 'pending') fail('B-11: delen door een lid is niet "ingediend"');
  await page.goto(`${app.url}/#/m/skills/meldingen`);
  const rev = page.getByTestId('share-reviews');
  await rev.getByText('Ter beoordeling (1)').waitFor({ timeout: 15000 });
  await rev.getByRole('button', { name: /Inhoud bekijken/ }).click();
  await rev.getByText('Zet de taken per dag in een tabel.').waitFor({ timeout: 5000 });
  if (!(await rev.getByText(/Externe adressen: example\.com/).count())) fail('B-11: scan toont de externe adressen niet');
  await shot(page, 'e-08-skill-beoordeling.png');
  await axe(page, 'Ter beoordeling');
  await rev.getByRole('button', { name: 'Goedkeuren' }).click();
  await rev.getByText('Niets te beoordelen.', { exact: false }).waitFor({ timeout: 10000 });
  const visible = (await api('GET', '/skills/market/skills?q=weekplanner', undefined, mtok)).items.some((i) => i.catalogId === 'server');
  if (!visible) fail('B-11: na goedkeuren niet zichtbaar in de marktplaats');
  step('B-11: ingediende skill met scan en inhoud beoordeeld en goedgekeurd');

  // ---------------------------------------------------------------- B-42: practice run next to the real folder
  const agent = app.ctx.store.agent(lokaal.id);
  fs.mkdirSync(agent.workspace, { recursive: true });
  fs.writeFileSync(path.join(agent.workspace, 'plan.md'), '# Weekplan\n\nMaandag: fietsen\nDinsdag: zwemmen\nWoensdag: rust\nDonderdag: yoga\n');
  const row = app.ctx.services.computers._service.startRehearsal(owner.id, agent, 'Weekplan bijwerken');
  fs.writeFileSync(path.join(row.copy_dir, 'plan.md'), '# Weekplan\n\nMaandag: fietsen\nDinsdag: hardlopen in het park\nWoensdag: rust\nDonderdag: yoga\nVrijdag: zwemmen\n');
  fs.writeFileSync(path.join(row.copy_dir, 'boodschappen.md'), '- havermout\n- bananen\n');
  const th = await api('POST', '/threads', { agentId: lokaal.id });
  await page.goto(`${app.url}/#/t/${th.id}`);
  await page.getByRole('button', { name: 'Zijpaneel' }).click();
  await page.getByRole('tab', { name: 'Wijzigingen' }).click();
  await page.getByRole('button', { name: 'plan.md' }).click();
  const sbs = page.getByTestId('side-by-side');
  await sbs.waitFor({ timeout: 10000 });
  const sbsText = await sbs.innerText();
  if (!/Je echte map/.test(sbsText) || !/Wat de bot maakte/.test(sbsText) || !/zwemmen/.test(sbsText) || !/hardlopen in het park/.test(sbsText)) fail('B-42: naast-elkaar mist een kant: ' + sbsText.slice(0, 300));
  await shot(page, 'e-09-oefenronde-naast-elkaar.png');
  await axe(page, 'oefenronde naast elkaar');
  await page.getByRole('button', { name: 'Dit bestand toepassen' }).click();
  await page.getByText(/1 toegepast/).waitFor({ timeout: 10000 });
  if (!/hardlopen in het park/.test(fs.readFileSync(path.join(row.original, 'plan.md'), 'utf8'))) fail('B-42: toepassen per bestand kwam niet in de echte map');
  if (fs.existsSync(path.join(row.original, 'boodschappen.md'))) fail('B-42: een niet gekozen bestand kwam toch in de echte map');
  step('B-42: oefenronde naast de echte map; één bestand toegepast, de rest wacht');

  // ---------------------------------------------------------------- B-42: two bots' practice runs side by side
  const tweede = await api('POST', '/agents', { name: 'Tweede', provider_id: ol.id, model: 'denker:latest', access_mode: 'ask' });
  app.ctx.store.updateAgent(tweede.id, { workspace: row.original });
  const row2 = app.ctx.services.computers._service.startRehearsal(owner.id, app.ctx.store.agent(tweede.id), 'Ook een menu');
  fs.writeFileSync(path.join(row.copy_dir, 'menu.md'), '# Menu\n\nMaandag: pasta\nDinsdag: soep\n');
  fs.writeFileSync(path.join(row2.copy_dir, 'menu.md'), '# Menu\n\nMaandag: pasta\nDinsdag: stamppot\nWoensdag: vis\n');
  app.ctx.events.emit(owner.id, 'rehearsal.updated', row2);
  const cmp = page.getByTestId('compare-practice');
  await cmp.waitFor({ timeout: 10000 });
  await cmp.getByRole('button', { name: /Vergelijk met de oefenronde van Tweede/ }).click();
  await cmp.getByRole('button', { name: /menu\.md/ }).click();
  const sbs2 = cmp.getByTestId('side-by-side');
  await sbs2.waitFor({ timeout: 10000 });
  const sbs2Text = await sbs2.innerText();
  if (!/Oefenronde van Lokaal/.test(sbs2Text) || !/Oefenronde van Tweede/.test(sbs2Text) || !/soep/.test(sbs2Text) || !/stamppot/.test(sbs2Text)) fail('B-42: vergelijking van twee bots mist een kant: ' + sbs2Text.slice(0, 300));
  await shot(page, 'e-09b-twee-oefenrondes.png');
  await axe(page, 'twee oefenrondes naast elkaar');
  await cmp.getByRole('button', { name: 'Versie van Tweede toepassen' }).click();
  await page.getByText('De versie van Tweede staat nu in je echte map').waitFor({ timeout: 10000 });
  if (!/stamppot/.test(fs.readFileSync(path.join(row.original, 'menu.md'), 'utf8'))) fail('B-42: de gekozen versie kwam niet in de echte map');
  step('B-42: twee oefenrondes per bestand naast elkaar; de versie van één bot toegepast');

  // ---------------------------------------------------------------- B-36: a move is one row, applied or rejected as a unit
  // Round 6: "verwijderd rommel/boodschappen.txt" + "nieuw rommel/lijstjes/boodschappen.txt"; rejecting the new half
  // and applying the rest removed the file from the real folder.
  const opruimer = await api('POST', '/agents', { name: 'Opruimer', provider_id: ol.id, model: 'denker:latest', access_mode: 'ask' });
  const opAgent = app.ctx.store.agent(opruimer.id);
  const put = (root, k, v) => (fs.mkdirSync(path.dirname(path.join(root, k)), { recursive: true }), fs.writeFileSync(path.join(root, k), v));
  put(opAgent.workspace, 'rommel/boodschappen.txt', 'melk\nbrood\neieren\n');
  put(opAgent.workspace, 'notities/idee.md', 'Een idee voor zondag: fietsen langs de rivier.\n');
  put(opAgent.workspace, 'weekmenu.md', '# Menu\n\nMaandag: pasta\nDinsdag: soep\nWoensdag: vis\n');
  put(opAgent.workspace, 'todo.txt', 'Te doen:\n- melk halen\n- fiets maken\n');
  put(opAgent.workspace, 'README.md', '# Map\n');
  const op = app.ctx.services.computers._service.startRehearsal(owner.id, opAgent, 'De map opruimen');
  const real = (k) => path.join(op.original, k);
  const mv = (from, to, content) => {
    fs.mkdirSync(path.dirname(path.join(op.copy_dir, to)), { recursive: true });
    fs.renameSync(path.join(op.copy_dir, from), path.join(op.copy_dir, to));
    if (content !== undefined) fs.writeFileSync(path.join(op.copy_dir, to), content);
  };
  mv('rommel/boodschappen.txt', 'rommel/lijstjes/boodschappen.txt'); // moved
  mv('notities/idee.md', 'notities/ideeen.md'); // renamed in the same folder
  mv('weekmenu.md', 'archief/weekmenu.md', '# Menu\n\nMaandag: pasta\nDinsdag: soep\nWoensdag: vis\nDonderdag: stamppot\n'); // moved + small edit
  mv('todo.txt', 'lijst/todo.txt', 'Te doen deze week:\n- melk halen\n- bellen met oma\n- tuin\n'); // too different: two rows
  fs.writeFileSync(path.join(op.copy_dir, 'README.md'), '# Map\n\nOpgeruimd.\n');
  const opTh = await api('POST', '/threads', { agentId: opruimer.id });
  // A moved file's row reads "old → new" (the arrow is text, so this is also its accessible name).
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const moveName = (from, to) => new RegExp(`^${esc(from)}\\s*→\\s*${esc(to)}$`);
  const openChanges = async (p, panelButton) => {
    const tab = p.getByRole('tab', { name: 'Wijzigingen' });
    if (!(await tab.waitFor({ timeout: 4000 }).then(() => true, () => false))) await panelButton();
    await tab.click();
  };
  await page.goto(`${app.url}/#/t/${opTh.id}`);
  await openChanges(page, () => page.getByRole('button', { name: 'Zijpaneel' }).click());
  const movedRows = page.getByTestId('moved-change');
  await movedRows.first().waitFor({ timeout: 10000 });
  if ((await movedRows.count()) !== 3) fail(`B-36: ${await movedRows.count()} verplaatst-regels i.p.v. 3`);
  for (const half of ['rommel/boodschappen.txt', 'rommel/lijstjes/boodschappen.txt', 'notities/idee.md', 'notities/ideeen.md', 'weekmenu.md', 'archief/weekmenu.md'])
    if (await page.getByRole('checkbox', { name: `Selecteer ${half}`, exact: true }).count()) fail(`B-36: ${half} staat nog als losse regel`);
  if (!(await page.getByText('verplaatst en gewijzigd', { exact: true }).count())) fail('B-36: verplaatst-en-gewijzigd-label ontbreekt');
  await page.getByRole('button', { name: moveName('weekmenu.md', 'archief/weekmenu.md') }).click();
  const sbsMove = page.getByTestId('side-by-side');
  await sbsMove.waitFor({ timeout: 10000 });
  if (!/Woensdag: vis[\s\S]*Donderdag: stamppot/.test(await sbsMove.innerText())) fail('B-36: naast-elkaar van een verplaatst en gewijzigd bestand toont de wijziging niet');
  await shot(page, 'e-12-verplaatst-naast-elkaar.png');
  await axe(page, 'verplaatst en gewijzigd');
  // Safety net for the look-alike that stays two rows: deleting todo.txt alone waits for lijst/todo.txt.
  await page.getByText('Lijkt op het nieuwe bestand lijst/todo.txt.').waitFor({ timeout: 5000 });
  await page.getByRole('checkbox', { name: 'Selecteer todo.txt', exact: true }).check();
  await page.getByRole('button', { name: 'Toepassen (1)' }).click();
  await page.getByText(/todo\.txt is niet verwijderd: de inhoud staat nu in lijst\/todo\.txt/).waitFor({ timeout: 10000 });
  if (!fs.existsSync(real('todo.txt'))) fail('B-36: todo.txt is toch uit de echte map verwijderd');
  // The round 6 path: reject the new halves, then apply the rest.
  await page.getByRole('button', { name: moveName('rommel/boodschappen.txt', 'rommel/lijstjes/boodschappen.txt') }).click();
  await page.getByRole('button', { name: 'Niet verplaatsen' }).click();
  await page.getByText('Wijziging verworpen', { exact: true }).waitFor({ timeout: 10000 });
  await page.getByRole('button', { name: 'lijst/todo.txt', exact: true }).click();
  await page.getByText(/Voeg je het niet toe, dan blijft todo\.txt staan\./).waitFor({ timeout: 5000 });
  await axe(page, 'nieuw bestand dat op een verwijderd bestand lijkt');
  await page.getByRole('button', { name: 'Niet toevoegen' }).click();
  await page.getByText(/todo\.txt blijft ook staan, want de bot had het vervangen door lijst\/todo\.txt/).waitFor({ timeout: 10000 });
  await shot(page, 'e-13-blijft-ook-staan.png');
  await page.getByRole('button', { name: 'Alles toepassen' }).click();
  await page.getByText('3 toegepast', { exact: true }).waitFor({ timeout: 10000 });
  const realNow = (k) => (fs.existsSync(real(k)) ? fs.readFileSync(real(k), 'utf8') : null);
  if (realNow('rommel/boodschappen.txt') !== 'melk\nbrood\neieren\n' || realNow('rommel/lijstjes/boodschappen.txt') !== null) fail('B-36: de verworpen verplaatsing veranderde de echte map');
  if (realNow('todo.txt') === null || realNow('lijst/todo.txt') !== null) fail('B-36: todo.txt is weg of lijst/todo.txt kwam toch in de echte map');
  if (realNow('notities/idee.md') !== null || !/fietsen langs de rivier/.test(realNow('notities/ideeen.md') || '')) fail('B-36: hernoemen kwam niet goed in de echte map');
  if (realNow('weekmenu.md') !== null || !/stamppot/.test(realNow('archief/weekmenu.md') || '')) fail('B-36: verplaatsen met een wijziging kwam niet goed in de echte map');
  if (!/Opgeruimd/.test(realNow('README.md') || '')) fail('B-36: README.md niet toegepast');
  await page.getByText('Nog geen wijzigingen.').waitFor({ timeout: 10000 });
  step('B-36: verplaatsen, hernoemen en verplaatsen-met-wijziging elk als één regel; verwerpen houdt het bestand, verwijderen wacht op zijn vervanger');
  await page.goto(`${app.url}/#/t/${th.id}`); // back to Lokaal for the reserve engine check

  // ---------------------------------------------------------------- reserve engine in the chat header
  const run = app.ctx.store.createRun({ thread_id: th.id, agent_id: lokaal.id, user_id: owner.id, trigger: 'user', input_message_id: null, meta: {} });
  const upd = app.ctx.store.updateRun(run.id, { status: 'running', meta: { engine: { provider_id: (await api('GET', '/providers')).find((p) => p.kind === 'opencode').id, kind: 'opencode', name: 'OpenCode', model: 'opencode/big-pickle' } } });
  app.ctx.events.emit(owner.id, 'run.updated', upd);
  await page.getByText('reserve', { exact: true }).waitFor({ timeout: 10000 });
  if (!(await page.getByText(/werkt nu via de reserve-engine OpenCode/).count())) fail('reserve: status onder de naam noemt de reserve niet');
  await shot(page, 'e-11-reserve-in-kop.png', { clip: { x: 300, y: 0, width: 1100, height: 70 } });
  app.ctx.store.updateRun(run.id, { status: 'done' });
  app.ctx.events.emit(owner.id, 'run.updated', app.ctx.store.run(run.id));
  step('reserve-engine staat in de kop zolang hij antwoordt');

  // ---------------------------------------------------------------- phone
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, bypassCSP: true });
  watch(phone);
  await phone.goto(`${app.url}/#token=${token}`);
  await phone.goto(`${app.url}/#/settings/cli-agents-cli`);
  await phone.getByTestId('cli-opencode').waitFor({ timeout: 20000 });
  if (!(await fits(phone))) fail('telefoon: CLI-pagina breder dan het scherm');
  await shot(phone, 'e-04-cli-telefoon.png', { fullPage: false });
  await phone.goto(`${app.url}/#/agents/${lokaal.id}`);
  await phone.getByTestId('model-facts').waitFor({ timeout: 20000 });
  await phone.getByTestId('context-window').scrollIntoViewIfNeeded();
  if (!(await fits(phone))) fail('telefoon: bot-editor breder dan het scherm');
  await shot(phone, 'e-07-model-telefoon.png');
  await phone.goto(`${app.url}/#/t/${th.id}`);
  await phone.getByRole('button', { name: 'Meer opties' }).click();
  await phone.getByRole('button', { name: 'Bestanden en wijzigingen' }).click();
  await phone.getByRole('tab', { name: 'Wijzigingen' }).click();
  await phone.getByRole('button', { name: 'boodschappen.md' }).click();
  await phone.getByTestId('side-by-side').waitFor({ timeout: 10000 });
  if (!(await fits(phone))) fail('telefoon: oefenronde breder dan het scherm');
  await shot(phone, 'e-10-oefenronde-telefoon.png');
  await axe(phone, 'oefenronde op de telefoon');
  await phone.getByRole('button', { name: 'Niet toevoegen' }).click();
  await phone.getByText('Wijziging verworpen').waitFor({ timeout: 10000 });
  step('telefoon: CLI-pagina, bot-editor en oefenronde passen op 390 px; verwerpen per bestand');

  // B-36 on the phone: a move and a rename at once is one row that fits 390 px and is applied as a whole.
  mv('README.md', 'docs/LEESMIJ.md');
  await phone.goto(`${app.url}/#/t/${opTh.id}`);
  await openChanges(phone, async () => {
    await phone.getByRole('button', { name: 'Meer opties' }).click();
    await phone.getByRole('button', { name: 'Bestanden en wijzigingen' }).click();
  });
  await phone.getByRole('button', { name: moveName('README.md', 'docs/LEESMIJ.md') }).click();
  await phone.getByText('De bot heeft dit bestand verplaatst van README.md naar docs/LEESMIJ.md. De inhoud is hetzelfde gebleven.').waitFor({ timeout: 10000 });
  if (!(await fits(phone))) fail('telefoon: verplaatst-regel breder dan het scherm');
  await shot(phone, 'e-14-verplaatst-telefoon.png');
  await axe(phone, 'verplaatst op de telefoon');
  await phone.getByRole('button', { name: 'Verplaatsing toepassen' }).click();
  await phone.getByText('1 toegepast', { exact: true }).waitFor({ timeout: 10000 });
  if (fs.existsSync(real('README.md')) || !/Opgeruimd/.test(fs.readFileSync(real('docs/LEESMIJ.md'), 'utf8'))) fail('B-36: verplaatsing op de telefoon kwam niet goed in de echte map');
  step('telefoon: een verplaatsing is één regel op 390 px en wordt in zijn geheel toegepast (B-36)');

  if (errors.length) fail('console-fouten: ' + errors.slice(0, 5).join(' | '));
} catch (e) {
  fail(String(e?.stack || e));
  if (page) console.error('pagina:', (await page.locator('body').innerText().catch(() => '')).slice(0, 2500));
} finally {
  await browser.close();
  await app.close?.();
  await reg.close();
  await gh.close();
  ollama.close();
  openaiFake.close();
  fs.rmSync(home, { recursive: true, force: true });
  openbot.cleanup();
}
console.log(process.exitCode ? 'c4: MISLUKT' : 'c4: alles groen');
process.exit(process.exitCode || 0);
