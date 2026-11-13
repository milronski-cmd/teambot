// Apps with one click, through the screens, in an empty data folder (fix-apps round, 12 Nov 2026).
//   node --import tsx tests/e2e/apps-one-click.mjs normal    one click on a no-account app (Apps and Marktplaats), a bot
//                                                             on Claude Code (haiku, your own login) uses it, removing it
//                                                             removes it for every bot
//   node --import tsx tests/e2e/apps-one-click.mjs no-node   a PC without Node: an npx app shows "Installeren", one click
//                                                             gets TeamBot's own npx and the app works
// Needs `npm run build:ui` first. Data in .data/fix-apps or TEAMBOT_E2E_DIR (removed again); screenshots in SHOTS_DIR.
// "normal" and "no-node" use the internet (MCP Registry, npm, the apps themselves) and "normal" spends one real Claude
// Code turn; "form" stays on this pc.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');

//   node --import tsx tests/e2e/apps-one-click.mjs form      the own-server form: only what is needed in view, every
//                                                             other option under "Meer opties"
const MODE = ['no-node', 'form'].includes(process.argv[2]) ? process.argv[2] : 'normal';
const ROOT = path.resolve(process.env.TEAMBOT_E2E_DIR || '.data/fix-apps');
const SHOTS = process.env.SHOTS_DIR || path.join(ROOT, 'shots');
const dir = path.join(ROOT, `run-${MODE}`);
fs.rmSync(dir, { recursive: true, force: true });
fs.mkdirSync(dir, { recursive: true });
fs.mkdirSync(SHOTS, { recursive: true });
process.env.XDG_DOCUMENTS_DIR = path.join(ROOT, 'documents');
fs.mkdirSync(process.env.XDG_DOCUMENTS_DIR, { recursive: true });
process.env.TEAMBOT_TEST_NO_STARTER_RULES = '1';
if (MODE === 'no-node') {
  // A PC without Node, npm or uv: only the Windows folders on PATH (TeamBot itself runs on its own Node, like the app).
  const sys = process.env.SystemRoot || 'C:\\Windows';
  const key = Object.keys(process.env).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
  process.env[key] = [path.join(sys, 'System32'), sys].join(path.delimiter);
}

const { createApp } = await import('./server.mjs');
const { onPath } = await import('../../server/core/runtimes.ts');
const app = await createApp({ dataDir: dir, port: Number(process.env.PORT || 4786), host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const api = async (method, p, body) => {
  const res = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  const j = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${j.error}`);
  return j;
};
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok });
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const shot = async (page, name) => {
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(SHOTS, `${MODE}-${name}.png`) });
  console.log(`  schermafbeelding: ${MODE}-${name}.png`);
};

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || 'msedge', headless: true });
try {
  console.log(`TeamBot op ${app.url} (${MODE}); node op PATH: ${onPath('node')}, npx op PATH: ${onPath('npx')}`);
  const prov = await api('POST', '/providers', { kind: 'claude-code', config: {} }).catch(() => api('POST', '/providers', { kind: 'ollama', config: { baseUrl: 'http://127.0.0.1:11434' } }));
  const bot1 = await api('POST', '/agents', { name: 'Onderzoeker', provider_id: prov.id, model: prov.kind === 'claude-code' ? 'haiku' : 'qwen3:1.7b', access_mode: 'auto' });
  const bot2 = await api('POST', '/agents', { name: 'Schrijver', provider_id: prov.id, model: prov.kind === 'claude-code' ? 'haiku' : 'qwen3:1.7b', access_mode: 'auto' });
  const bots = [bot1.id, bot2.id];

  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(1500);
  const openApps = async () => {
    await page.evaluate(() => (location.hash = '#/m/mcp'));
    await page.getByRole('heading', { name: 'Apps', exact: true }).first().waitFor({ timeout: 20_000 });
  };
  const catalogCard = async (search, title) => {
    await page.getByLabel('Zoeken in catalogus').fill(search);
    const card = page.locator('[data-testid="catalog-card"]').filter({ hasText: title }).first();
    await card.waitFor({ timeout: 15_000 });
    await card.scrollIntoViewIfNeeded();
    return card;
  };

  if (MODE === 'normal') {
    // 1. Apps: Context7 (remote, no account) with one click.
    await openApps();
    const c7 = await catalogCard('Context7', 'Context7');
    await shot(page, '1-context7-voor');
    await c7.getByRole('button', { name: 'Koppelen' }).click();
    await c7.getByText('Verbinding werkt').waitFor({ timeout: 60_000 });
    await shot(page, '2-context7-na-een-klik');
    const conns = await api('GET', '/mcp/connections');
    const c = conns.find((x) => x.catalog_id === 'context7');
    check('Context7: één klik, getest, voor alle bots', !!c?.verified_at && bots.every((b) => c.agents.includes(b)), `${c?.counts.usable} tools, bots ${c?.agents.length}`);

    // 2. Marktplaats › Apps: Microsoft Learn MCP (MCP Registry, remote, no account) with one click on "Toevoegen".
    await page.evaluate(() => (location.hash = '#/m/skills/apps'));
    await page.getByRole('searchbox').first().fill('Microsoft Learn');
    const learn = page.locator('[data-card="app"]').filter({ hasText: 'Microsoft Learn' }).first();
    await learn.waitFor({ timeout: 60_000 });
    await learn.scrollIntoViewIfNeeded();
    await shot(page, '3-microsoft-learn-voor');
    await learn.getByRole('button', { name: 'Toevoegen' }).click();
    await page.getByText('Verbinding werkt').first().waitFor({ timeout: 90_000 });
    await shot(page, '4-microsoft-learn-na-een-klik');
    const ml = (await api('GET', '/mcp/connections')).find((x) => /learn/i.test(x.name));
    check('Microsoft Learn: één klik, getest, voor alle bots', !!ml?.verified_at && bots.every((b) => ml.agents.includes(b)), `${ml?.counts.usable} tools, bots ${ml?.agents.length}`);

    // 3. A bot on Claude Code (haiku) uses the app in its next turn, without asking.
    if (prov.kind === 'claude-code' && ml) {
      const th = await api('POST', '/threads', { agentId: bot1.id });
      await api('POST', `/threads/${th.id}/messages`, { content: 'Zoek met de app Microsoft Learn (een mcp-tool) naar "Azure Functions Python quickstart" en geef alleen de titel van het eerste resultaat. Antwoord kort in het Nederlands.' });
      const start = Date.now();
      const asked = [];
      while (Date.now() - start < 300_000) {
        for (const ap of (await api('GET', '/approvals')).filter((x) => x.status === 'pending')) asked.push(ap.tool);
        if (!app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", th.id).length) break;
        await new Promise((r) => setTimeout(r, 1000));
      }
      const calls = app.ctx.store.all('SELECT tool, ok, agent_id FROM mcp_calls WHERE connection_id = ? AND kind = ?', ml.id, 'tool');
      const answer = app.ctx.store.messages(th.id).filter((m) => m.role === 'assistant').at(-1);
      check('bot op Claude Code (haiku) gebruikt de app-tool zonder te vragen', calls.some((x) => x.agent_id === bot1.id && x.ok) && !asked.length, `aanroepen: ${calls.map((x) => x.tool).join(', ') || 'geen'}; gevraagd: ${asked.join(', ') || 'niets'}; antwoord: ${(answer?.content || answer?.parts?.error || '').replace(/\s+/g, ' ').slice(0, 160)}`);
      await page.evaluate((id) => (location.hash = `#/t/${id}`), th.id);
      await page.waitForTimeout(2500);
      await shot(page, '5-bot-gebruikt-app');
    }

    // 4. Remove the app (Apps › Beheren › Ontkoppelen): gone for every bot.
    await openApps();
    const card = page.locator('[data-testid="app-card"]').filter({ hasText: 'Microsoft Learn' }).first();
    await card.getByRole('button', { name: 'Beheren' }).click();
    await page.getByRole('button', { name: 'Meer opties' }).first().click();
    await page.getByRole('menuitem', { name: 'Ontkoppelen' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Ontkoppelen' }).click();
    await page.waitForTimeout(1500);
    await openApps();
    await shot(page, '6-verwijderd');
    const left = await Promise.all(bots.map(async (b) => (await api('GET', `/mcp/agents/${b}`)).filter((x) => /learn/i.test(x.name) && x.bound).length));
    const tools = await Promise.all(bots.map(async (b) => (await app.ctx.tools.forAgent(app.ctx.store.agent(b), app.ctx.store.thread((await api('POST', '/threads', { agentId: b })).id))).filter((x) => /learn/.test(x.name)).length));
    check('verwijderd: bij geen enkele bot meer', left.every((n) => n === 0) && tools.every((n) => n === 0), `koppelingen ${left.join('/')}, tools ${tools.join('/')}`);
  } else if (MODE === 'form') {
    // An own server (Apps › Meer opties › Eigen server): name, kind, address in view; the rest folded, nothing gone.
    await openApps();
    await page.locator('main').getByText('Meer opties', { exact: true }).last().click();
    await page.getByRole('button', { name: 'Eigen server' }).click();
    const dlg = page.getByRole('dialog');
    await dlg.waitFor({ timeout: 10_000 });
    await dlg.getByLabel('Soort server').selectOption('http');
    const visible = async (label) => (await dlg.getByText(label, { exact: true }).first().isVisible().catch(() => false));
    const before = { Naam: await visible('Naam *'), URL: await visible('URL *'), Accountlabel: await visible('Accountlabel'), Lokaal: await visible('Lokaal netwerk toestaan (localhost/LAN)'), Geavanceerd: await visible('Geavanceerd'), Bots: await visible('Welke bots mogen deze app gebruiken?') };
    await shot(page, '1-eigen-server-kort');
    check('eigen server: alleen naam, soort en adres in beeld', before.Naam && before.URL && !before.Accountlabel && !before.Lokaal && !before.Geavanceerd && !before.Bots, JSON.stringify(before));
    await dlg.getByText('Meer opties', { exact: true }).click();
    const after = { Accountlabel: await visible('Accountlabel'), Lokaal: await visible('Lokaal netwerk toestaan (localhost/LAN)'), Geavanceerd: await visible('Geavanceerd'), Bots: await visible('Welke bots mogen deze app gebruiken?'), Headers: await visible('Headers') };
    await shot(page, '2-eigen-server-meer-opties');
    check('eigen server: alle opties blijven bereikbaar onder Meer opties', Object.values(after).every(Boolean), JSON.stringify(after));
  } else {
    // A PC without Node: the npx app "Kennisgraaf" shows "Node.js nodig" and "Installeren"; one click gets npx, then works.
    check('PATH zonder node en npx', !onPath('node') && !onPath('npx'));
    await openApps();
    const kg = await catalogCard('Kennisgraaf', 'Kennisgraaf');
    await kg.getByText('Node.js nodig').waitFor({ timeout: 10_000 });
    await shot(page, '1-kennisgraaf-voor');
    await kg.getByRole('button', { name: 'Installeren' }).click();
    await page.waitForTimeout(1200);
    await shot(page, '2-kennisgraaf-bezig');
    await kg.getByText('Verbinding werkt').waitFor({ timeout: 300_000 });
    await shot(page, '3-kennisgraaf-na-een-klik');
    const rt = await api('GET', '/mcp/runtimes/node');
    const c = (await api('GET', '/mcp/connections')).find((x) => x.catalog_id === 'memory');
    check('npx van TeamBot zelf, app getest, voor alle bots', rt.source === 'teambot' && !!c?.verified_at && bots.every((b) => c.agents.includes(b)), `node: ${rt.source} ${rt.version}; ${c?.counts.usable} tools`);
    const th = await api('POST', '/threads', { agentId: bot1.id });
    const names = (await app.ctx.tools.forAgent(app.ctx.store.agent(bot1.id), app.ctx.store.thread(th.id))).filter((x) => x.name.startsWith('mcp_')).map((x) => x.name);
    check('de bot heeft de tools in zijn volgende beurt', names.length > 0, names.slice(0, 4).join(', '));
  }
  check('geen fouten in de pagina', !errors.length, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('script', false, String(e?.stack || e).slice(0, 600));
} finally {
  await browser.close().catch(() => {});
  await app.close();
  console.log(`\n${results.filter((r) => r.ok).length}/${results.length} geslaagd`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
  if (!process.env.KEEP) {
    // Windows keeps a file of a just-stopped program locked for a moment.
    try {
      fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 500 });
    } catch {
      console.log(`Map nog in gebruik, later weghalen: ${dir}`);
    }
  }
}
