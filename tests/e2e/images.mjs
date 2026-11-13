// Afbeeldingen maken as the owner uses it: the settings page without an image service (says what to connect), with a
// connected service (choose the model, "Proefafbeelding maken" shows the picture), and a bot that makes an image in
// the chat: the picture is in the conversation and in the bot's folder. The "service" is a small local server that
// speaks the OpenAI images protocol and returns a real PNG; no real provider is called.
// Edge/Chrome headless, temp data dir, temp APPDATA and home.
// Usage: npm run build:ui && node --import tsx tests/e2e/images.mjs
//   TEAMBOT_E2E_PORT (never 4747/4748), TEAMBOT_E2E_SHOTS=<dir> for screenshots, TEAMBOT_UI_DIR=<built ui>.
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const port = Number(process.env.TEAMBOT_E2E_PORT) || 0;
if (port === 4747 || port === 4748) throw new Error('4747/4748 zijn van de geïnstalleerde TeamBot');
const killer = setTimeout(() => (console.error('images e2e: time-out na 3 minuten'), process.exit(2)), 180_000);
killer.unref();

const parentEnv = { ...process.env };
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-images-'));
const tmp = (p) => {
  const d = path.join(dir, p);
  fs.mkdirSync(d, { recursive: true });
  return d;
};
Object.assign(process.env, { TEAMBOT_DATA: tmp('data'), APPDATA: tmp('appdata'), LOCALAPPDATA: tmp('localappdata'), USERPROFILE: tmp('home'), HOME: tmp('home'), TEAMBOT_OPENBOT_DIR: tmp('no-openbot'), TEAMBOT_OPENBOT_HOME: tmp('home') });
if (!process.env.TEAMBOT_UI_DIR && path.resolve('dist/ui').includes(`${path.sep}.claude${path.sep}`)) {
  fs.cpSync(path.resolve('dist/ui'), path.join(dir, 'ui'), { recursive: true });
  process.env.TEAMBOT_UI_DIR = path.join(dir, 'ui');
}

// A real 320×200 PNG (a red bar on a light field), made here so nothing is downloaded.
function png(w, h) {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const sum = Buffer.alloc(4);
    sum.writeUInt32BE(crc(body));
    return Buffer.concat([len, body, sum]);
  };
  const head = Buffer.alloc(13);
  head.writeUInt32BE(w, 0);
  head.writeUInt32BE(h, 4);
  head.set([8, 2, 0, 0, 0], 8);
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const red = y > h * 0.35 && y < h * 0.65 && x > w * 0.1 && x < w * 0.9;
      raw.set(red ? [200, 40, 40] : [240, 238, 230], y * (w * 3 + 1) + 1 + x * 3);
    }
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = png(320, 200);
const asked = [];
const service = http.createServer((req, res) => {
  let raw = '';
  req.on('data', (c) => (raw += c));
  req.on('end', () => {
    const json = (code, body) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(body)));
    if (req.url === '/v1/models') return json(200, { data: [{ id: 'praatmodel-1' }, { id: 'flux-schnell' }, { id: 'sdxl-turbo' }] });
    if (req.url === '/v1/images/generations') {
      asked.push(JSON.parse(raw || '{}'));
      return json(200, { data: [{ b64_json: PNG.toString('base64') }] });
    }
    json(404, { error: 'not found' });
  });
});
await new Promise((r) => service.listen(0, '127.0.0.1', r));
const serviceBase = `http://127.0.0.1:${service.address().port}/v1`;

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true, env: parentEnv });
const { createApp } = await import('./server.mjs');
const app = await createApp({ dataDir: process.env.TEAMBOT_DATA, port, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
// The chat engine: asked for a banner it calls generate_image, then says so.
app.ctx.providers.registerKind({
  id: 'mock',
  label: 'Testmodel',
  type: 'api',
  billing: 'local',
  needsKey: false,
  description: 'e2e',
  models: ['mock-1'],
  defaultModel: 'mock-1',
  create: () => ({
    kind: 'mock',
    async listModels() {
      return [{ id: 'mock-1' }];
    },
    async test() {
      return { ok: true, detail: 'mock' };
    },
    async chat(req, _signal, onEvent) {
      if (!req.messages.some((m) => m.role === 'tool'))
        return { text: '', toolCalls: [{ id: 'img1', name: 'generate_image', args: { prompt: 'Een rode stadsfiets tegen een lichte muur, productfoto', shape: 'landscape', name: 'banner-stadsfiets' } }], usage: { input: 20, output: 10 }, stop: 'tool_use', model: req.model };
      const text = 'Hier is de banner voor de stadsfiets. Hij staat ook in mijn map afbeeldingen.';
      onEvent({ type: 'text', delta: text });
      return { text, toolCalls: [], usage: { input: 30, output: 12 }, stop: 'end', model: req.model };
    },
  }),
});
const call = async (method, p, body) => {
  const r = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  return r.json();
};
const prov = await call('POST', '/providers', { kind: 'mock', name: 'Testmodel' });
const bot = await call('POST', '/agents', { name: 'SEO & Content', role: 'Teksten en beeld', provider_id: prov.id, model: 'mock-1', access_mode: 'auto' });
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });
const shot = async (page, name) => SHOTS && (await page.screenshot({ path: path.join(SHOTS, `${name}.png`) }));
step(`TeamBot op ${app.url}, beeldserver op ${serviceBase}`);

const errors = [];
try {
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 900 }, locale: 'nl-NL', bypassCSP: true })).newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|401 \(Unauthorized\)/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(800);

  // 1. No image service yet: the page says what to connect.
  await page.goto(`${app.url}/#/settings/images-afbeeldingen`);
  await page.getByText('Nog geen dienst die afbeeldingen kan maken').waitFor({ timeout: 8000 });
  await page.getByRole('link', { name: 'AI-dienst koppelen' }).waitFor({ timeout: 3000 });
  await shot(page, '1-instellingen-zonder-dienst');
  step('Instellingen › Afbeeldingen maken zonder dienst: zegt wat je koppelt, met een link naar AI-diensten');

  // 2. Connect a service (as on the AI page), choose the model, make a proof image.
  await call('POST', '/providers', { kind: 'openai-compatible', name: 'Mijn beeldserver', base_url: serviceBase });
  await page.reload();
  // Dienst and Model are TeamBot's own dropdowns (a combobox button with a list of options), not a system <select>.
  await page.getByRole('combobox', { name: 'Dienst', exact: true }).waitFor({ timeout: 8000 });
  const modelBox = page.getByRole('combobox', { name: 'Model', exact: true });
  await modelBox.click();
  const options = page.locator('[role="listbox"] [role="option"]');
  await options.first().waitFor({ timeout: 5000 });
  const models = (await options.allTextContents()).map((x) => x.trim());
  if (models.join('|') !== 'Kies een model…|flux-schnell|sdxl-turbo') fail(`modellen: ${models.join('|')}`);
  await page.keyboard.press('Escape');
  if (!(await page.getByRole('button', { name: 'Proefafbeelding maken' }).isDisabled())) fail('Proefafbeelding kan zonder model');
  await modelBox.click();
  await page.locator('[role="listbox"] [role="option"][data-value="flux-schnell"]').click();
  await page.getByRole('button', { name: 'Proefafbeelding maken' }).click();
  const img = page.getByRole('img', { name: 'Proefafbeelding' });
  await img.waitFor({ timeout: 15_000 });
  const w = await img.evaluate((el) => new Promise((r) => (el.complete ? r(el.naturalWidth) : (el.onload = () => r(el.naturalWidth)))));
  if (w !== 320) fail(`de proefafbeelding is geen echte afbeelding (breedte ${w})`);
  await page.getByText('Gemaakt met Mijn beeldserver · flux-schnell').waitFor({ timeout: 3000 });
  await page.getByText('Vandaag 1 gemaakt.').waitFor({ timeout: 5000 });
  await shot(page, '2-proefafbeelding');
  step('dienst gekoppeld: alleen de beeldmodellen staan in de lijst, de proefafbeelding verschijnt en telt mee voor vandaag');

  // 3. In the chat: the bot makes a banner; the picture is in the conversation and in its folder.
  const thread = app.ctx.chat.threadForAgent(owner.id, bot.id);
  await page.goto(`${app.url}/#/t/${thread.id}`);
  const box = page.locator('textarea').first();
  await box.waitFor({ timeout: 8000 });
  await box.fill('Maak een banner voor de rode stadsfiets');
  await box.press('Enter');
  await page.getByRole('paragraph').filter({ hasText: 'Hier is de banner voor de stadsfiets.' }).first().waitFor({ timeout: 20_000 });
  // Like a file a bot shares (share_file), the picture sits under the step that made it: open the step.
  await page.getByText('Afbeelding maken: Een rode stadsfiets', { exact: false }).first().click();
  const pic = page.locator('main img[src*="att_"], main img[src*="attachments"]').first();
  await pic.waitFor({ timeout: 8000 }).catch(() => fail('de afbeelding staat niet in het gesprek'));
  const pw = await pic.evaluate((el) => new Promise((r) => (el.complete ? r(el.naturalWidth) : ((el.onload = () => r(el.naturalWidth)), (el.onerror = () => r(0)))))).catch(() => 0);
  if (pw !== 320) fail(`de afbeelding in het gesprek laadt niet (breedte ${pw})`);
  await shot(page, '3-afbeelding-in-de-chat');
  const last = asked.at(-1);
  if (last?.model !== 'flux-schnell' || last?.size !== '1536x1024' || !/stadsfiets/.test(last?.prompt || '')) fail(`verzoek aan de dienst: ${JSON.stringify(last)}`);
  const folder = path.join(app.ctx.store.agent(bot.id).workspace, 'afbeeldingen');
  const files = fs.existsSync(folder) ? fs.readdirSync(folder) : [];
  if (files.length !== 1 || !/^banner-stadsfiets-\d{14}\.png$/.test(files[0]) || !fs.readFileSync(path.join(folder, files[0])).equals(PNG)) fail(`map van de bot: ${files.join(', ')}`);
  step(`in de chat: de bot maakte de banner (liggend, flux-schnell); hij staat in het gesprek en als ${files[0]} in zijn map`);

  if (errors.length) fail(`paginafouten: ${[...new Set(errors)].slice(0, 5).join(' | ')}`);
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  await browser.close().catch(() => {});
  await app.close().catch(() => {});
  await new Promise((r) => service.close(r));
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {}
}
console.log(process.exitCode ? '✗ images e2e: MISLUKT' : '✔ images e2e: geslaagd');
process.exit(process.exitCode || 0);
