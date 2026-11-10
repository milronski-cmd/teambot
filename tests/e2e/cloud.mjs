// End-to-end check of TeamBot Cloud in a real browser (Edge/Chrome via Playwright):
// sign up → create a workspace → claim the owner account → use the proxied TeamBot UI (HTTP + WebSocket) →
// status page, phone width, unknown workspace. Screenshots go to CLOUD_E2E_OUT (default: <tmp>/teambot-cloud-e2e).
//
//   npm run build && npm run cloud:e2e                 starts its own cloud (PGlite, process provisioner)
//   CLOUD_E2E_URL=http://cloud.localhost:8080 npm run cloud:e2e    against a running `npm run cloud:dev`
//
// *.localhost resolves to 127.0.0.1 in Chromium, so no DNS setup is needed.
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const out = process.env.CLOUD_E2E_OUT || path.join(os.tmpdir(), 'teambot-cloud-e2e');
fs.mkdirSync(out, { recursive: true });

let cloud = null;
let tmp = null;
let CLOUD = process.env.CLOUD_E2E_URL;
if (!CLOUD) {
  const { createCloud } = await import('../../cloud/server.ts'); // run with: node --import tsx tests/e2e/cloud.mjs
  const port = await new Promise((resolve) => {
    const s = net.createServer().listen(0, '127.0.0.1', () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cloud-e2e-'));
  cloud = await createCloud({
    config: {
      url: `http://cloud.localhost:${port}`,
      listenPort: port,
      dataDir: tmp,
      secretKey: crypto.randomBytes(32),
      quiet: true,
      process: { entry: path.resolve('dist/server/main.js'), nodeBin: process.execPath, startTimeoutMs: 30_000, uiDir: process.env.CLOUD_TEAMBOT_UI_DIR || null },
    },
    pgliteDir: null,
  });
  CLOUD = cloud.cfg.url;
}
const { hostname, port } = new URL(CLOUD);
step(`TeamBot Cloud op ${CLOUD} · schermafbeeldingen in ${out}`);

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|status of 50[23]|status of 40[34]/.test(m.text()) && errors.push(`${page.url()}: ${m.text()}`));
  await page.goto(CLOUD + '/');
  await page.screenshot({ path: path.join(out, '1-home.png'), fullPage: true });
  step('startpagina geladen');

  await page.goto(CLOUD + '/signup');
  const email = `demo${Date.now()}@example.nl`;
  await page.getByLabel('E-mailadres').fill(email);
  await page.getByLabel('Wachtwoord').fill('demo-wachtwoord-123');
  await page.getByRole('button', { name: 'Account maken' }).click();
  await page.waitForURL(/\/dashboard/);
  step('account aangemaakt');

  await page.getByRole('link', { name: /workspace/i }).first().click();
  const slug = `demo${Date.now().toString(36).slice(-5)}`;
  await page.getByLabel('Naam').fill('Team Demo');
  await page.getByLabel('Adres').fill(slug);
  await page.getByRole('button', { name: 'Workspace maken' }).click();
  await page.waitForURL(/\/dashboard/);
  await page.screenshot({ path: path.join(out, '2-provisioning.png'), fullPage: true });
  for (let i = 0; i < 60 && !(await page.getByRole('button', { name: 'Eigenaar-account aanmaken' }).count()); i++) {
    await page.waitForTimeout(1000);
    await page.goto(CLOUD + '/dashboard');
  }
  await page.screenshot({ path: path.join(out, '3-dashboard-active.png'), fullPage: true });
  step(`workspace ${slug} actief`);

  // Owner claim: one-time link → TeamBot's own first-run page on <slug>.<domain>
  await page.getByRole('button', { name: 'Eigenaar-account aanmaken' }).click();
  await page.waitForURL((u) => u.hostname === `${slug}.${hostname}`);
  await page.getByText('Eigenaar-account aanmaken').first().waitFor({ timeout: 20_000 });
  await page.screenshot({ path: path.join(out, '4-teambot-setup.png'), fullPage: true });
  step(`TeamBot-setup geopend op ${new URL(page.url()).host}`);
  await page.getByLabel('Naam').fill('Demo Eigenaar');
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel('Wachtwoord').fill('teambot-wachtwoord-1');
  await page.getByRole('button', { name: 'Account aanmaken' }).click();
  await page.waitForFunction(() => !!localStorage.getItem('tb_token'), null, { timeout: 15_000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join(out, '5-teambot-app.png'), fullPage: true });
  const me = await page.evaluate(async () => (await fetch('/api/me', { headers: { authorization: 'Bearer ' + localStorage.getItem('tb_token') } })).json());
  if (me?.user?.role !== 'owner') fail('geen eigenaar na setup: ' + JSON.stringify(me));
  else step(`ingelogd in TeamBot als eigenaar (${me.user.email}) via de router`);
  const ws = await page.evaluate(
    () =>
      new Promise(async (resolve) => {
        // A signed /ws URL, as the app makes it (the session token never goes into a URL).
        const k = await (await fetch('/api/auth/url-key', { headers: { authorization: 'Bearer ' + localStorage.getItem('tb_token') } })).json();
        const b64 = (raw) => btoa(String.fromCharCode(...new Uint8Array(raw))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
        const keyBytes = Uint8Array.from(atob(k.key.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
        const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
        const base = `/ws?tbs=${k.sid}&tbe=${Math.floor(Date.now() / 1000) + 600}`;
        const sig = b64(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(base)));
        const s = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${base}&tbsig=${sig}`);
        s.onmessage = (e) => {
          resolve(JSON.parse(e.data).type);
          s.close();
        };
        s.onerror = () => resolve('error');
      }),
  );
  if (ws !== 'hello') fail('WebSocket via router: ' + ws);
  else step('WebSocket via de router: hello ontvangen');
  const again = await page.evaluate(async () => (await fetch('/api/public/setup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"password":"xxxxxxxxxx"}' })).status);
  if (again !== 403) fail('tweede setup-poging niet geweigerd: ' + again);
  else step('tweede setup-poging geweigerd (403)');

  await page.goto(CLOUD + '/dashboard');
  await page.screenshot({ path: path.join(out, '6-dashboard-claimed.png'), fullPage: true });
  await page.goto(CLOUD + '/status');
  await page.screenshot({ path: path.join(out, '7-status.png'), fullPage: true });
  if ((await page.content()).includes(slug)) fail('statuspagina toont een workspacenaam');
  else step('statuspagina zonder workspacenamen');
  const phone = await browser.newPage({ viewport: { width: 360, height: 780 } });
  for (const p of ['/', '/dashboard', '/status']) {
    await phone.goto(CLOUD + p);
    if (await phone.evaluate(() => document.documentElement.scrollWidth > window.innerWidth)) fail(`horizontaal scrollen op 360 px: ${p}`);
  }
  await phone.goto(CLOUD + '/');
  await phone.screenshot({ path: path.join(out, '8-home-phone.png'), fullPage: true });
  step('telefoonbreedte (360 px) zonder horizontaal scrollen');
  const wsUrl = `http://${slug}.${hostname}${port ? ':' + port : ''}/`;
  const unknown = await page.goto(`http://bestaatniet.${hostname}${port ? ':' + port : ''}/`);
  if (unknown.status() !== 404) fail('onbekende workspace: ' + unknown.status());
  else step('onbekende workspace: vriendelijke 404');
  await page.screenshot({ path: path.join(out, '9-unknown.png'), fullPage: true });

  await page.goto(CLOUD + '/dashboard');
  await page.getByRole('link', { name: 'Abonnement beheren' }).first().click();
  await page.screenshot({ path: path.join(out, '10-workspace.png'), fullPage: true });
  step('workspacepagina (abonnement, export, verwijderen) geopend');

  if (cloud) {
    // Operator role is granted outside the web UI (npm run cloud:operator); here directly on the handle.
    await cloud.accounts.setRole(email, 'operator');
    await page.goto(CLOUD + '/operator');
    await page.screenshot({ path: path.join(out, '11-operator.png'), fullPage: true });
    await page.getByRole('button', { name: 'Pauzeren' }).first().click();
    await page.waitForURL(/\/operator/);
    const paused = await page.goto(wsUrl);
    const pausedText = await page.textContent('body');
    if (paused.status() !== 503 || !/gepauzeerd — betaling\/beheer/i.test(pausedText || '')) fail('pauzepagina: ' + paused.status());
    else step('gepauzeerde workspace toont de pauzepagina (503)');
    await page.screenshot({ path: path.join(out, '12-paused.png'), fullPage: true });
    await page.goto(CLOUD + '/operator');
    await page.getByRole('button', { name: 'Hervatten' }).first().click();
    await page.waitForURL(/\/operator/);
    const back = await page.goto(wsUrl);
    if (back.status() !== 200) fail('na hervatten: ' + back.status());
    await page.waitForFunction(() => !!localStorage.getItem('tb_token'), null, { timeout: 15_000 });
    const still = await page.evaluate(async () => (await fetch('/api/me', { headers: { authorization: 'Bearer ' + localStorage.getItem('tb_token') } })).status);
    if (still !== 200) fail('sessie na hervatten: ' + still);
    else step('hervat: TeamBot draait weer en de sessie/gegevens zijn er nog');

    // Dedicated (CLD-05): register a customer-run instance (a local fake here, hence the dev flag), monitor it.
    let up = true;
    const fakeDed = http.createServer((_q, r) => (up ? r.writeHead(200, { 'content-type': 'application/json' }).end('{"ok":true}') : r.writeHead(503).end()));
    await new Promise((r) => fakeDed.listen(0, '127.0.0.1', r));
    const dedUrl = `http://127.0.0.1:${fakeDed.address().port}`;
    cloud.cfg.dedicated.allowPrivate = true;
    try {
      await page.goto(CLOUD + '/operator');
      await page.getByLabel('E-mailadres van de klant (bestaand account)').fill(email);
      await page.getByLabel('Naam', { exact: true }).fill('Klant Dedicated');
      await page.getByLabel('Korte naam').fill(`ded${slug.slice(-5)}`);
      await page.getByLabel('Adres van hun TeamBot').fill(dedUrl);
      await page.getByRole('button', { name: 'Registreren' }).click();
      await page.getByText('Bewaar deze waarden nu').waitFor();
      await page.screenshot({ path: path.join(out, '13-dedicated-secrets.png'), fullPage: true });
      step('dedicated geregistreerd; setup-token één keer getoond');
      await cloud.monitoring.sweep();
      up = false;
      for (let i = 0; i < 3; i++) await cloud.monitoring.sweep();
      up = true;
      await cloud.monitoring.sweep();
      const start = new Date(Date.now() + 3 * 864e5);
      const local = (d) => new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
      await page.goto(CLOUD + '/operator');
      await page.getByLabel('Titel').first().fill('Update naar TeamBot 0.3');
      await page.getByLabel('Begin').fill(local(start));
      await page.getByLabel('Einde').fill(local(new Date(start.getTime() + 2 * 3600_000)));
      await page.getByRole('button', { name: 'Onderhoud aankondigen' }).click();
      await page.waitForURL(/onderhoud-/);
      await page.screenshot({ path: path.join(out, '14-operator-dedicated.png'), fullPage: true });
      await page.goto(CLOUD + '/dashboard');
      await page.screenshot({ path: path.join(out, '15-dashboard-dedicated.png'), fullPage: true });
      const dedId = (await cloud.db.query("SELECT id FROM workspaces WHERE deployment = 'dedicated'"))[0].id;
      await page.goto(`${CLOUD}/workspaces/${dedId}`);
      const body = (await page.textContent('body')) || '';
      if (!/Beschikbaarheid/.test(body) || !/Niet bereikbaar/.test(body)) fail('beschikbaarheid/storing ontbreekt op de workspacepagina');
      else step('eigenaar ziet beschikbaarheid en de (opgeloste) storing');
      await page.screenshot({ path: path.join(out, '16-workspace-dedicated.png'), fullPage: true });
      await page.goto(CLOUD + '/status');
      await page.screenshot({ path: path.join(out, '17-status-maintenance.png'), fullPage: true });
      if (!/Gepland onderhoud/.test((await page.textContent('body')) || '')) fail('gepland onderhoud niet op de statuspagina');
      else step('gepland onderhoud op de statuspagina');
    } finally {
      fakeDed.close();
    }
  }
} catch (e) {
  fail(e.stack || String(e));
} finally {
  await browser.close();
  if (cloud) await cloud.close();
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
else step('geen console-fouten');
console.log(process.exitCode ? '✗ cloud-e2e mislukt' : '✓ cloud-e2e geslaagd');
