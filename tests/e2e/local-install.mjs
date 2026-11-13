// A local model without setting anything up, through the screens (acceptance 12 Nov 2026), with stand-ins only: no
// real Ollama, no real installer, no model runs. Edge headless, an empty TeamBot with its own data folder and home.
//  1. Ollama is not on this pc: every place where the user meets it has one button "Installeren" (the first screen,
//     the "Ollama koppelen" dialog, Gratis modellen, Lokale modellen op deze pc), no download link to follow by hand.
//  2. "Installeren" on the first screen: TeamBot fetches the installer (a stand-in for ollama.com), checks it, runs it
//     (the stand-in starts a stand-in Ollama), connects Ollama and fetches the model that fits this pc, with progress
//     on the spot; afterwards the row says "Gebruiken" without another step.
//  3. AI-diensten › Toevoegen › Gevonden op deze pc › Koppelen (a stand-in LM Studio): the dialog closes on the list,
//     where the new AI stands with "Verbinding werkt" (acceptance: the dialog stayed open).
// Usage: npm run build:ui && node --import tsx tests/e2e/local-install.mjs
//        (TEAMBOT_E2E_SHOTS=<dir> for screenshots, TEAMBOT_E2E_PORT=<port> (default 4781), TEAMBOT_E2E_BROWSER=chrome|msedge)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const failures = [];
const check = (ok, s, detail = '') => {
  if (ok) console.log(`✔ ${s}`);
  else {
    failures.push(s);
    console.error(`✖ ${s}${detail ? ` (${detail})` : ''}`);
    process.exitCode = 1;
  }
};
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => SHOTS && (await page.waitForTimeout(250), await page.screenshot({ path: path.join(SHOTS, `${name}.png`), fullPage: true }));

// The browser first (it needs this pc's own environment), then TeamBot in an empty one.
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-local-install-home-'));
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_DATA_HOME: path.join(home, 'xdg', 'data'),
  XDG_CONFIG_HOME: path.join(home, 'xdg', 'config'),
  XDG_CACHE_HOME: path.join(home, 'xdg', 'cache'),
  XDG_DOCUMENTS_DIR: path.join(home, 'Documents'),
  PATH: path.dirname(process.execPath),
  TEAMBOT_TEST_NO_STARTER_RULES: '1',
});
delete process.env.Path;
delete process.env.TEAMBOT_DATA;

const listen = (s, port = 0) => new Promise((r) => s.listen(port, '127.0.0.1', () => r(s.address().port)));
const json = (res, x, code = 200) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(x)));

// A stand-in for ollama.com: the "installer".
const SETUP = Buffer.alloc(400_000, 3);
const site = http.createServer((_q, res) => (res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': SETUP.length }), res.end(SETUP)));
const sitePort = await listen(site);

// A stand-in Ollama: nothing listens on its port until the "installer" ran. A fresh Ollama has no models.
const ol = { tags: [], pulls: [], server: null, port: 0 };
{
  const probe = http.createServer();
  ol.port = await listen(probe);
  await new Promise((r) => probe.close(r));
}
const OL = `http://127.0.0.1:${ol.port}`;
const startOllama = async () => {
  ol.server = http.createServer((q, res) => {
    let b = '';
    q.on('data', (d) => (b += d));
    q.on('end', async () => {
      const body = b ? JSON.parse(b) : {};
      if (q.url === '/api/version') return json(res, { version: '0.40.16' });
      if (q.url === '/api/tags') return json(res, { models: ol.tags });
      if (q.url === '/api/ps') return json(res, { models: [] });
      if (q.url === '/api/show') return json(res, { capabilities: ['completion', 'tools'], model_info: { 'general.architecture': 'qwen3', 'qwen3.context_length': 40960, 'qwen3.block_count': 40, 'qwen3.attention.head_count': 40, 'qwen3.attention.head_count_kv': 8, 'qwen3.attention.key_length': 128, 'qwen3.embedding_length': 5120 } });
      if (q.url === '/v1/models') return json(res, { object: 'list', data: ol.tags.map((t) => ({ id: t.name, object: 'model', owned_by: 'library' })) });
      if (q.url === '/api/pull') {
        ol.pulls.push(body.model);
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (const completed of [0, 4e9, 9.276e9]) {
          await new Promise((r) => setTimeout(r, 150));
          res.write(JSON.stringify({ status: 'pulling abc', digest: 'sha256:abc', total: 9.276e9, completed }) + '\n');
        }
        ol.tags.push({ name: body.model, model: body.model, size: 9276198077, digest: 'q14', details: { parameter_size: '14.8B', context_length: 40960 }, capabilities: ['completion', 'tools', 'thinking'] });
        return res.end(JSON.stringify({ status: 'success' }) + '\n');
      }
      json(res, { error: 'not found' }, 404);
    });
  });
  await listen(ol.server, ol.port);
};

// A stand-in LM Studio that is "found on this pc" for the AI toevoegen part.
const lm = http.createServer((q, res) => {
  const model = { id: 'qwen-lm', type: 'llm', state: 'not-loaded', max_context_length: 32768 };
  if (q.url === '/api/v0/models') return json(res, { data: [model] });
  if (q.url === '/api/v1/models') return json(res, { models: [{ type: 'llm', key: 'qwen-lm', max_context_length: 32768, loaded_instances: [] }] });
  if (q.url === '/v1/models') return json(res, { object: 'list', data: [{ id: 'qwen-lm', object: 'model', owned_by: 'organization_owner' }] });
  json(res, { error: 'not found' }, 404);
});
const LM = `http://127.0.0.1:${await listen(lm)}`;
let lmHere = false;

const steps = [];
const plan = {
  url: `http://127.0.0.1:${sitePort}/download/OllamaSetup.exe`,
  file: 'OllamaSetup.exe',
  async verify(file) {
    steps.push('verify');
    return fs.statSync(file).size === SETUP.length;
  },
  async install() {
    steps.push('install');
    await new Promise((r) => setTimeout(r, 600));
    await startOllama();
  },
  async start() {
    steps.push('start');
  },
};
const GiB = 1024 ** 3;
const PC = { platform: 'win32', ram: 64 * GiB, ramFree: 40 * GiB, cpu: 'cpu', cores: 16, gpus: [{ name: 'Test GPU 16 GB', vendor: 'nvidia', vram: 16 * GiB, exact: true, dedicated: true }], unified: false, sources: ['test'], checkedAt: new Date().toISOString() };

const { modules } = await import('../../server/modules/index.ts');
const { createLocalModelsModule } = await import('../../server/modules/local-models/index.ts');
const { createApp } = await import('./server.mjs');
const mods = modules.map((m) => (m.id === 'local-models' ? createLocalModelsModule({ hardware: async () => PC, hardwareTtlMs: 0, installPlan: () => plan, installWaitMs: 3000 }) : m));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-local-install-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 4781, host: '127.0.0.1', mode: 'desktop', quiet: true, modules: mods });
const token = app.ctx.auth.ensureLocalOwner();
const up = () => fetch(`${OL}/api/version`, { signal: AbortSignal.timeout(800) }).then((r) => r.ok, () => false);
for (const k of app.ctx.providers.kinds.values()) {
  if (k.id === 'ollama') {
    k.baseUrl = `${OL}/v1`;
    k.detect = async () => ((await up()) ? { installed: true, baseUrl: `${OL}/v1`, version: '0.40.16' } : { installed: false, detail: 'e2e' });
  } else if (k.id === 'lmstudio') k.detect = async () => (lmHere ? { installed: true, baseUrl: `${LM}/v1` } : { installed: false, detail: 'e2e' });
  else if (k.detect) k.detect = async () => ({ installed: false, detail: 'e2e' });
}
const api = async (method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
console.log(`TeamBot op ${app.url} (lege datamap)`);

const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text()) && errors.push(m.text()));
};

try {
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'nl-NL' });
  await ctx.addInitScript((tok) => {
    try {
      localStorage.setItem('tb_token', tok);
    } catch {}
  }, token);
  const page = await ctx.newPage();
  watch(page);

  // ---------------------------------------------------------------- 1. Ollama missing: Installeren everywhere
  await page.goto(`${app.url}/#/settings/free-models-gratis`);
  const freeRow = page.getByTestId('free-engine-ollama');
  await freeRow.waitFor({ timeout: 20_000 });
  check(await freeRow.getByTestId('ollama-install').isVisible(), 'Gratis modellen: Ollama heeft de knop Installeren');
  check((await freeRow.locator('a[href*="ollama.com"]').count()) === 0, 'Gratis modellen: geen downloadlink die je zelf moet volgen');
  await page.goto(`${app.url}/#/settings/ai-meer`);
  await page.getByText('Lokale modellen op deze pc').first().click();
  const card = page.getByTestId('local-models-no-ollama');
  await card.waitFor({ timeout: 20_000 });
  check(await card.getByTestId('ollama-install').isVisible(), 'Lokale modellen op deze pc: Installeren');
  await page.goto(`${app.url}/#/settings/providers?koppel=ollama`);
  const dlg = page.getByRole('dialog');
  await dlg.getByTestId('ollama-setup').waitFor({ timeout: 20_000 });
  check(await dlg.getByTestId('ollama-install').isVisible(), 'Ollama koppelen: Installeren in het venster');
  await dlg.getByRole('button', { name: 'Annuleren' }).click();

  // ---------------------------------------------------------------- 2. the first screen: one click installs it
  await page.goto(`${app.url}/#/`);
  const row = page.getByTestId('start-local-missing');
  await row.waitFor({ timeout: 20_000 });
  await shot(page, '1-eerste-scherm-ollama-ontbreekt');
  await row.getByTestId('ollama-install').click();
  check(await page.getByTestId('ollama-install-progress').first().waitFor({ timeout: 10_000 }).then(() => true, () => false), 'voortgang ter plekke');
  await shot(page, '2-installeren-bezig');
  const used = page.getByRole('button', { name: /Ollama.*gebruiken/i });
  const ready = await used.first().waitFor({ timeout: 60_000 }).then(() => true, () => false);
  check(ready, 'na het installeren staat Ollama klaar met "Gebruiken", zonder verdere stap');
  await shot(page, '3-ollama-klaar');
  check(steps.join(',') === 'verify,install', 'het installatieprogramma werd eerst gecontroleerd, dan stil uitgevoerd', steps.join(','));
  const provs = await api('GET', '/providers');
  const ollama = provs.find((p) => p.kind === 'ollama');
  check(!!ollama, 'Ollama is gekoppeld');
  check(ollama?.config?.defaultModel === 'qwen3:14b' && ol.pulls.join() === 'qwen3:14b', 'met het model dat op deze pc past, opgehaald', `${ollama?.config?.defaultModel} / ${ol.pulls.join()}`);
  check(!fs.existsSync(path.join(dir, 'downloads', 'OllamaSetup.exe')), 'het installatieprogramma is opgeruimd');

  // ---------------------------------------------------------------- 3. AI toevoegen closes after Koppelen
  lmHere = true;
  await page.waitForTimeout(21_000); // the server looks at most every 20 s again for what runs on this pc
  await page.goto(`${app.url}/#/settings/providers`);
  await page.getByTestId('add-ai').click();
  const add = page.getByRole('dialog', { name: 'AI toevoegen' });
  const found = add.getByTestId('found-lmstudio');
  await found.waitFor({ timeout: 20_000 });
  await shot(page, '4-ai-toevoegen-gevonden');
  await found.getByRole('button', { name: 'Koppelen' }).click();
  const closed = await add.waitFor({ state: 'detached', timeout: 20_000 }).then(() => true, () => false);
  check(closed, 'AI toevoegen sluit na Koppelen');
  const card2 = page.getByTestId('connected-lmstudio');
  check(await card2.waitFor({ timeout: 10_000 }).then(() => true, () => false), 'de nieuwe AI staat in de lijst');
  check(await card2.getByTestId('connect-ok').waitFor({ timeout: 15_000 }).then(() => true, () => false), 'met de test erbij: Verbinding werkt');
  await shot(page, '5-lijst-na-koppelen');
  await ctx.close();
} catch (e) {
  check(false, e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  for (const s of [site, lm, ol.server]) s?.close();
  for (const d of [dir, home]) {
    try {
      fs.rmSync(d, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      /* left in the temp folder */
    }
  }
}
if (errors.length) check(false, 'console-fouten:\n  ' + errors.join('\n  '));
console.log(failures.length ? `LOKAAL INSTALLEREN MISLUKT: ${failures.length} bevinding(en)` : 'LOKAAL INSTALLEREN GESLAAGD');
