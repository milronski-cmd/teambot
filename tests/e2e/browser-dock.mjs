// Browser panel + vault check (real UI, real bot browser): the docked panel next to a chat (desktop) and the full-screen
// sheet (phone) with live view, address bar, tabs, "Neem over" / "Geef terug"; a vault login TeamBot fills in by itself
// (one login fits the site, so nothing is asked); the Kluis page. Checks: no horizontal scrolling on the phone, no page errors, no serious
// axe-core violations in the open panel (light + dark), and that no password reaches the page text of the panel.
// Usage: npm run build:ui && npm run browser:check   [TEAMBOT_DOCK_SHOTS=<dir> to keep the screenshots]
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const { createApp } = await import('./server.mjs');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const USER = 'sanne@example.nl';
const PASS = 'Dock-Wachtwoord-77!';

// ---- a small local shop with a login form ----
const style = `<style>body{font:15px/1.5 system-ui,sans-serif;margin:0;color:#1d1d24;background:#fafafa}header{background:#14532d;color:#fff;padding:14px 28px;display:flex;gap:24px;align-items:center}header b{font-size:20px}main{padding:28px;max-width:860px}.grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}.card{background:#fff;border:1px solid #e5e5e5;border-radius:12px;padding:14px}.img{height:90px;border-radius:8px;background:linear-gradient(135deg,#bbf7d0,#86efac)}input{display:block;width:280px;padding:8px 10px;margin:4px 0 14px;border:1px solid #ccc;border-radius:8px;font-size:15px}button{background:#14532d;color:#fff;border:0;border-radius:8px;padding:9px 16px;font-size:15px}</style>`;
const COLOR_PAGES = { '/rood': '#dc2626', '/blauw': '#2563eb', '/geel': '#facc15' };
const shop = (body) => `<!doctype html><html lang="nl"><head><meta charset="utf-8"><title>Groene Winkel</title>${style}</head><body><header><b>Groene Winkel</b><span>Planten</span><span>Potten</span><span>Aanbiedingen</span></header><main>${body}</main></body></html>`;
const site = http.createServer((req, res) => {
  let b = '';
  req.on('data', (d) => (b += d));
  req.on('end', () => {
    const url = new URL(req.url, 'http://x');
    if (req.method === 'POST' && url.pathname === '/login') {
      const f = Object.fromEntries(new URLSearchParams(b));
      if (f.email === USER && f.password === PASS) {
        res.writeHead(302, { location: '/account', 'set-cookie': 'sessie=ok; Path=/' });
        return res.end();
      }
    }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    // solid pages for the live-view check: the picture must show the page the address bar names
    if (COLOR_PAGES[url.pathname]) return res.end(`<!doctype html><html lang="nl"><head><title>Kleur ${url.pathname.slice(1)}</title></head><body style="margin:0;height:100vh;background:${COLOR_PAGES[url.pathname]}"></body></html>`);
    if (url.pathname === '/login')
      return res.end(shop(`<h1>Inloggen</h1><form method="post" action="/login"><label for="e">E-mailadres</label><input id="e" name="email" type="email" autocomplete="username"><label for="p">Wachtwoord</label><input id="p" name="password" type="password" autocomplete="current-password"><button>Inloggen</button></form>`));
    if (url.pathname === '/account') return res.end(shop(`<h1>Welkom terug</h1><p>Je hebt 2 lopende bestellingen.</p>`));
    res.end(shop(`<h1>Lente in huis</h1><p>Kamerplanten die makkelijk groeien.</p><div class="grid">${['Monstera', 'Calathea', 'Pilea'].map((n, i) => `<div class="card"><div class="img"></div><b>${n}</b><div>€ ${(14.95 + i * 5).toFixed(2).replace('.', ',')}</div></div>`).join('')}</div>`));
  });
});
await new Promise((r) => site.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${site.address().port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-dock-'));
process.env.TEAMBOT_BROWSER_HEADLESS_ONLY = '1';
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const call = async (method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error || ''}`);
  return j;
};
const agent = app.ctx.store.createAgent(owner.id, { name: 'Operations', avatar: '', role: 'Webwinkel en advertenties', tool_groups: ['files'] });
await call('PUT', `/computers/${agent.id}/config`, { mode: 'browser', allow_private: true });
const th = app.ctx.store.createThread({ user_id: owner.id, agent_id: agent.id, kind: 'chat' });
app.ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: owner.id, author_name: owner.name, content: 'Kun je de nieuwe aanbiedingen in de winkel bekijken?' });
app.ctx.store.createMessage({ thread_id: th.id, role: 'assistant', author_type: 'agent', author_id: agent.id, author_name: agent.name, content: 'Ik open de winkel in mijn browser. Je kunt meekijken via de knop **Browser** bovenaan.' });
await call('POST', `/computers/${agent.id}/browser/start`, { url: base + '/' });
await call('POST', '/computers/vault', { label: 'Groene Winkel', origins: base, username: USER, password: PASS });

const shots = process.env.TEAMBOT_DOCK_SHOTS || path.join(dir, 'shots');
fs.mkdirSync(shots, { recursive: true });
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
const watch = (page) => {
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|ERR_ABORTED/.test(m.text()) && errors.push(m.text()));
};
const openDockInit = (agentId) => localStorage.setItem('tb_browser_dock', JSON.stringify({ open: { [agentId]: true }, width: 600 }));
const liveLoaded = (page) => page.waitForFunction(() => [...document.querySelectorAll('img[alt^="Live beeld"]')].some((i) => i.naturalWidth > 0), null, { timeout: 20_000 });
/** Colour of the live picture (a pixel near the bottom right of the MJPEG image, as the browser shows it now). */
const livePixel = (page) =>
  page.evaluate(() => {
    const img = [...document.querySelectorAll('img')].find((i) => i.naturalWidth > 0 && i.src.includes('/stream'));
    if (!img) return 'geen beeld';
    const c = document.createElement('canvas');
    c.width = img.naturalWidth;
    c.height = img.naturalHeight;
    const g = c.getContext('2d');
    g.drawImage(img, 0, 0);
    const [r, gr, b] = g.getImageData(c.width - 30, c.height - 30, 1, 1).data;
    return r > 180 && gr < 90 && b < 90 ? 'rood' : b > 180 && r < 90 ? 'blauw' : r > 200 && gr > 160 && b < 90 ? 'geel' : `rgb(${r},${gr},${b})`;
  });
/** Wait (max 3 s) until both the picture and the address show the page; returns what was seen last. */
const waitLive = async (page, kleur, pathPart, addr) => {
  let seen = '';
  for (const t0 = Date.now(); Date.now() - t0 < 3000; await page.waitForTimeout(150)) {
    const label = (await addr().textContent().catch(() => '')) || '';
    const px = await livePixel(page);
    seen = `beeld ${px}, adres ${label.trim().slice(0, 60)}`;
    if (px === kleur && label.includes(pathPart)) return { ok: true, detail: `${seen} (${Date.now() - t0} ms)` };
  }
  return { ok: false, detail: seen };
};
const axe = async (page, label) => {
  await page.addScriptTag({ content: axeSource });
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.filter((x) => x.impact === 'serious' || x.impact === 'critical').map((x) => `${x.id}: ${x.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(', ')}`);
  });
  check(`toegankelijk (axe, ernstig/kritiek): ${label}`, v.length === 0, v.join(' | ').slice(0, 400));
};

try {
  // ---------------- desktop: docked next to the chat ----------------
  for (const scheme of ['light', 'dark']) {
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, colorScheme: scheme, bypassCSP: true });
    await ctx.addInitScript(openDockInit, agent.id);
    if (scheme === 'dark') await ctx.addInitScript(() => localStorage.setItem('tb_theme', 'dark'));
    const page = await ctx.newPage();
    watch(page);
    await page.goto(`${app.url}/#token=${token}`);
    await page.waitForTimeout(600);
    await page.evaluate((h) => (location.hash = h), `#/t/${th.id}`);
    await page.getByRole('heading', { name: 'Browser van Operations' }).waitFor({ timeout: 15_000 });
    await liveLoaded(page);
    await page.waitForTimeout(500);
    const addr = await page.getByRole('button', { name: /^Adres:/ }).innerText();
    check(`desktop (${scheme}): adresbalk toont waar de bot is`, addr.includes('127.0.0.1'), addr);
    check(`desktop (${scheme}): tabblad met titel`, (await page.getByRole('tab', { name: /Groene Winkel/ }).count()) > 0);
    const btn = page.getByRole('button', { name: /^Browser van Operations/ });
    check(`desktop (${scheme}): knop in de chatkop`, (await btn.count()) === 1 && (await btn.getAttribute('aria-pressed')) === 'true');
    const box = await page.locator('aside[aria-label="Browser van de bot"]').boundingBox();
    check(`desktop (${scheme}): paneel naast de chat`, !!box && box.width >= 500 && box.x > 600, JSON.stringify(box));
    await page.screenshot({ path: path.join(shots, `dock-desktop-${scheme}.png`) });
    if (scheme === 'light') {
      await axe(page, 'paneel desktop licht');
      // take over: the address bar becomes editable, the bot waits
      await page.getByRole('button', { name: 'Neem over' }).click();
      await page.getByRole('button', { name: 'Geef terug aan Operations' }).waitFor({ timeout: 10_000 });
      await page.getByRole('button', { name: /^Adres:/ }).click();
      const input = page.getByRole('textbox', { name: 'Adres' });
      await input.fill(base + '/login');
      await input.press('Enter');
      await page.waitForFunction(() => /\/login/.test(document.querySelector('[aria-label^="Adres:"]')?.textContent || ''), null, { timeout: 15_000 });
      check('desktop: zelf navigeren na "Neem over"', true);
      // picture and address follow every navigation at once (the picture used to stay one page behind)
      for (const [p, kleur] of [['/rood', 'rood'], ['/blauw', 'blauw']]) {
        await page.getByRole('button', { name: /^Adres:/ }).click();
        const box = page.getByRole('textbox', { name: 'Adres' });
        await box.fill(base + p);
        await box.press('Enter');
        const r = await waitLive(page, kleur, p, () => page.locator('[aria-label^="Adres:"]').first());
        check(`desktop: live beeld en adres tonen ${p}`, r.ok, r.detail);
      }
      await page.getByRole('button', { name: /^Adres:/ }).click();
      await page.getByRole('textbox', { name: 'Adres' }).fill(base + '/login');
      await page.getByRole('textbox', { name: 'Adres' }).press('Enter');
      await page.waitForFunction(() => /\/login/.test(document.querySelector('[aria-label^="Adres:"]')?.textContent || ''), null, { timeout: 15_000 });
      await page.waitForTimeout(700);
      await page.screenshot({ path: path.join(shots, 'dock-desktop-overgenomen.png') });
      await page.getByRole('button', { name: 'Geef terug aan Operations' }).click();
      await page.getByRole('button', { name: 'Neem over' }).waitFor({ timeout: 10_000 });
      check('desktop: "Geef terug" geeft de bediening terug', true);

      // the bot asks to log in: one login in the vault fits this site, so TeamBot fills it in at once and asks nothing
      // (a card only asks which account when several fit: tests/e2e/vault-choice.mjs)
      const s = app.ctx.store;
      const run = s.createRun({ thread_id: th.id, agent_id: agent.id, user_id: owner.id, status: 'running' });
      const ac = new AbortController();
      const tool = app.ctx.tools.get('browser_request_login');
      const out = await tool.run({ url: base + '/login', reason: 'aanbiedingen in je account bekijken' }, { ctx: app.ctx, agent: s.agent(agent.id), thread: s.thread(th.id), run, userId: owner.id, signal: ac.signal, toolCallId: 'e2e', progress: () => {} });
      check('kluis: één login past bij de site: geen kaart in de chat, TeamBot logt meteen in', (await page.getByRole('group', { name: 'Inloggen met de kluis' }).count()) === 0);
      app.ctx.services.computers._service.leases.releaseHolder(run.id);
      const text = typeof out === 'string' ? out : out.text;
      check('kluis: TeamBot logde in; de bot krijgt alleen "Ingelogd"', /^Ingelogd op 127\.0\.0\.1/.test(text) && !text.includes(PASS) && !text.includes(USER), text.slice(0, 120));
      await page.waitForFunction(() => /\/account/.test(document.querySelector('[aria-label^="Adres:"]')?.textContent || ''), null, { timeout: 15_000 });
      await page.waitForTimeout(700);
      const panelText = await page.locator('aside[aria-label="Browser van de bot"]').innerText();
      check('kluis: wachtwoord nergens in het paneel', !panelText.includes(PASS));
      await page.screenshot({ path: path.join(shots, 'dock-desktop-ingelogd.png') });

      // the bot asks you to log in yourself: the bot is paused and you can click and type in the panel
      // (the typing field used to be hidden while the bot was paused, so this login could not be done here)
      const run2 = s.createRun({ thread_id: th.id, agent_id: agent.id, user_id: owner.id, status: 'running' });
      const ac2 = new AbortController();
      const pending2 = tool.run({ url: base + '/login', reason: 'je account', method: 'zelf' }, { ctx: app.ctx, agent: s.agent(agent.id), thread: s.thread(th.id), run: run2, userId: owner.id, signal: ac2.signal, toolCallId: 'e2e2', progress: () => {} });
      const panel = page.locator('aside[aria-label="Browser van de bot"]');
      await panel.getByRole('button', { name: 'Ga verder' }).waitFor({ timeout: 20_000 });
      const typeField = panel.getByRole('textbox', { name: 'Tekst typen in de pagina' });
      check('zelf inloggen: typveld in het paneel terwijl de bot wacht', (await typeField.count()) === 1);
      const typeIn = async (text) => {
        await typeField.fill(text);
        await panel.getByRole('button', { name: 'Typ' }).click();
        await page.waitForTimeout(300);
      };
      await panel.getByRole('button', { name: 'Tab', exact: true }).click();
      await page.waitForTimeout(300);
      await typeIn(USER);
      await panel.getByRole('button', { name: 'Tab', exact: true }).click();
      await page.waitForTimeout(300);
      await typeIn(PASS);
      await panel.getByRole('button', { name: 'Enter', exact: true }).click();
      await page.waitForFunction(() => /\/account/.test(document.querySelector('[aria-label^="Adres:"]')?.textContent || ''), null, { timeout: 15_000 }).catch(() => {});
      const addr2 = await panel.locator('[aria-label^="Adres:"]').first().textContent();
      check('zelf inloggen: na typen in het paneel staat de bot ingelogd', /\/account/.test(addr2 || ''), (addr2 || '').trim());
      await page.getByRole('button', { name: 'Klaar, ik ben ingelogd' }).first().click();
      const out2 = await pending2;
      const text2 = typeof out2 === 'string' ? out2 : out2.text;
      check('zelf inloggen: de bot gaat verder zonder wachtwoord', !text2.includes(PASS) && !(await panel.innerText()).includes(PASS), text2.slice(0, 100));
      app.ctx.services.computers._service.leases.releaseHolder(run2.id);

      // the Kluis page
      await page.evaluate(() => (location.hash = '#/m/browser/kluis'));
      await page.getByText('Groene Winkel').first().waitFor({ timeout: 10_000 });
      check('kluis-pagina toont de login zonder wachtwoord', !(await page.content()).includes(PASS));
      await page.screenshot({ path: path.join(shots, 'kluis-desktop.png'), fullPage: true });
      await axe(page, 'kluis-pagina');
      await page.getByRole('button', { name: /^Meer opties voor/ }).first().click();
      await page.getByRole('menuitem', { name: 'Bewerken' }).click();
      await page.getByRole('dialog').waitFor();
      await page.screenshot({ path: path.join(shots, 'kluis-bewerken.png') });
      await axe(page, 'kluis bewerken');
      await page.keyboard.press('Escape');

      // the big live screen: take over, open pages with "Ga"; picture and address follow each one. A bot with full
      // access may also use the desktop, so the page opens on the tab "Bureaublad": go to "Browser" first (taking over
      // the desktop of this pc is never part of this check).
      await page.evaluate((h) => (location.hash = h), `#/m/browser/live/${agent.id}`);
      // The page shows the tabs (or only the browser) once it knows the screens of this pc; that can take a while.
      const main = page.locator('main');
      await main.getByRole('tablist').or(main.getByRole('button', { name: 'Neem over' })).first().waitFor({ timeout: 30_000 });
      const browserTab = main.getByRole('tab', { name: 'Browser', exact: true });
      if (await browserTab.count()) await browserTab.click();
      if ((await browserTab.count()) && (await browserTab.getAttribute('aria-selected')) !== 'true') throw new Error('live scherm: het tabblad Browser gaat niet open');
      await main.getByRole('button', { name: 'Neem over' }).first().click();
      await page.getByRole('button', { name: /Geef terug/ }).first().waitFor({ timeout: 10_000 });
      await page.waitForFunction(() => [...document.querySelectorAll('img')].some((i) => i.src.includes('/stream') && i.naturalWidth > 0), null, { timeout: 20_000 });
      for (const [p, kleur] of [['/geel', 'geel'], ['/rood', 'rood'], ['/blauw', 'blauw']]) {
        await page.getByPlaceholder(/^Adres, bijv/).fill(base + p);
        await page.getByRole('button', { name: 'Ga', exact: true }).click();
        const r = await waitLive(page, kleur, p, () => page.locator('main span[title^="http"]').first());
        check(`live scherm: beeld en adres tonen ${p}`, r.ok, r.detail);
      }
      await page.screenshot({ path: path.join(shots, 'live-scherm-overgenomen.png') });
      await page.getByPlaceholder(/^Adres, bijv/).fill(base + '/');
      await page.getByRole('button', { name: 'Ga', exact: true }).click();
      await page.locator('main span[title$="/"]').first().waitFor({ timeout: 10_000 });
      await page.getByRole('button', { name: /Geef terug/ }).first().click();
      await page.getByRole('button', { name: 'Neem over' }).first().waitFor({ timeout: 10_000 });
    } else await axe(page, 'paneel desktop donker');
    await ctx.close();
  }

  // ---------------- phone: full-screen sheet ----------------
  const phone = await browser.newContext({ ...devices['Pixel 7'], bypassCSP: true });
  await phone.addInitScript(openDockInit, agent.id);
  const p = await phone.newPage();
  watch(p);
  await p.goto(`${app.url}/#token=${token}`);
  await p.waitForTimeout(600);
  await p.evaluate((h) => (location.hash = h), `#/t/${th.id}`);
  await p.getByRole('heading', { name: 'Browser van Operations' }).waitFor({ timeout: 15_000 });
  await liveLoaded(p);
  await p.waitForTimeout(500);
  const sheet = await p.locator('[role="dialog"][aria-label="Browser van de bot"]').boundingBox();
  const vp = p.viewportSize();
  check('telefoon: browser als volledig scherm', !!sheet && Math.abs(sheet.width - vp.width) < 2 && sheet.height >= vp.height - 2, JSON.stringify(sheet));
  check('telefoon: geen horizontaal scrollen', await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await p.screenshot({ path: path.join(shots, 'dock-telefoon.png') });
  await axe(p, 'browserblad telefoon');
  await p.getByRole('button', { name: 'Neem over' }).click();
  await p.getByRole('button', { name: 'Geef terug aan Operations' }).waitFor({ timeout: 10_000 });
  check('telefoon: typveld na "Neem over"', (await p.getByRole('textbox', { name: 'Tekst typen in de pagina' }).count()) === 1);
  check('telefoon: geen horizontaal scrollen (overgenomen)', await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await p.screenshot({ path: path.join(shots, 'dock-telefoon-overgenomen.png') });
  await p.getByRole('button', { name: 'Geef terug aan Operations' }).click();
  await p.getByRole('button', { name: 'Terug naar het gesprek' }).click();
  check('telefoon: terug naar het gesprek sluit het blad', (await p.locator('[role="dialog"][aria-label="Browser van de bot"]').count()) === 0);
  await p.evaluate(() => (location.hash = '#/m/browser/kluis'));
  await p.getByText('Groene Winkel').first().waitFor({ timeout: 10_000 });
  check('telefoon: kluis zonder horizontaal scrollen', await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1));
  await p.screenshot({ path: path.join(shots, 'kluis-telefoon.png'), fullPage: true });
  await phone.close();
  check('geen paginafouten', errors.length === 0, errors.join(' | ').slice(0, 300));
} catch (e) {
  check('onverwachte fout', false, e?.stack || e?.message);
} finally {
  await browser.close();
  await app.close();
  site.close();
  console.log(`\nSchermafbeeldingen: ${shots}`);
  if (!process.env.TEAMBOT_DOCK_SHOTS) fs.rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter((x) => !x).length;
console.log(`${results.length - failed}/${results.length} controles geslaagd.`);
process.exitCode = failed ? 1 : 0;
