// Proactive by default, end to end with a REAL local model (Ollama) and the real planner on the real clock:
// a fresh team with an SEO bot and a website → the vaste taak runs by itself on its schedule → in order: quiet, no
// model → a seeded problem (noindex + a broken page) → TeamBot makes the tasks with the measurement as proof and wakes
// the bot on the local model → the main bot's briefing mentions it. Then screenshots of the new screens.
//
// Real: the routines engine and its timer, the site fetch over HTTP (a local test site), the team database, the model
// (Ollama, TEAMBOT_E2E_MODEL). Not real: Search Console, Merchant Center and Ads (no accounts here; those duties wait
// for their app and say so).
// Usage: npm run build:ui && node --import tsx tests/e2e/proactive.mjs   (port 4836; never 4747/4748)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('./server.mjs');
const { modules } = await import('../../server/modules/index.ts');
const { createRoutinesModule } = await import('../../server/modules/routines/index.ts');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout: ${what}`);
    await sleep(500);
  }
};
const port = Number(process.env.TEAMBOT_E2E_PORT) || 4836;
if (port === 4747 || port === 4748) throw new Error('4747/4748 zijn van de geïnstalleerde TeamBot');
const MODEL = process.env.TEAMBOT_E2E_MODEL || 'qwen3.6-uncensored-snel:latest';
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || path.join(os.tmpdir(), 'teambot-proactief-shots');
fs.mkdirSync(SHOTS, { recursive: true });

// ---- a small website the SEO bot's duty watches
const site = { noindex: false, broken: false };
const html = (title, noindex) => `<html><head><title>${title}</title><meta name="description" content="Vergelijk kozijnen">${noindex ? '<meta name="robots" content="noindex">' : ''}</head><body>${title}</body></html>`;
const web = http.createServer((req, res) => {
  const base = `http://127.0.0.1:${web.address().port}`;
  const send = (code, body, type = 'text/html') => {
    res.writeHead(code, { 'content-type': type });
    res.end(body);
  };
  if (req.url === '/') return send(200, html('Raamwinkel', site.noindex));
  if (req.url === '/robots.txt') return send(200, `User-agent: *\nAllow: /\nSitemap: ${base}/sitemap.xml`, 'text/plain');
  if (req.url === '/sitemap.xml') return send(200, `<urlset><url><loc>${base}/</loc></url><url><loc>${base}/prijzen</loc></url><url><loc>${base}/over</loc></url></urlset>`, 'application/xml');
  if (req.url === '/prijzen') return site.broken ? send(404, 'weg') : send(200, html('Prijzen', false));
  if (req.url === '/over') return send(200, html('Over ons', false));
  send(404, 'niet gevonden');
});
await new Promise((r) => web.listen(0, '127.0.0.1', r));
const siteUrl = `http://127.0.0.1:${web.address().port}`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-proactief-'));
const app = await createApp({ dataDir: dir, port, host: '127.0.0.1', mode: 'desktop', quiet: true, modules: modules.map((m) => (m.id === 'routines' ? createRoutinesModule({ tickMs: 1000 }) : m)) });
const ctx = app.ctx;
const token = ctx.auth.ensureLocalOwner();
const owner = ctx.auth.owner();
const api = async (method, p, body) => {
  const r = await fetch(`${app.url}/api${p}`, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${j.error}`);
  return j;
};
let browser;
try {
  const prov = await api('POST', '/providers', { kind: 'ollama', config: { defaultModel: MODEL } });
  const sem = await api('POST', '/agents', { name: 'Sem', role: 'Technische SEO', provider_id: prov.id, model: MODEL, access_mode: 'auto', tool_groups: ['team'], settings: { allowPrivateNetwork: true } });
  const intent = await api('POST', '/teams/main/intent', {});
  const baas = await api('POST', '/agents', { name: 'Baas', role: 'Hoofdbot', provider_id: prov.id, model: MODEL, access_mode: 'auto', tool_groups: ['team'], settings: { mainBot: intent.token } });
  const rik = await api('POST', '/agents', { name: 'Rik', role: 'Researcher', provider_id: prov.id, model: MODEL, access_mode: 'auto', tool_groups: ['team', 'web'] });
  const [team] = await api('GET', '/teams');
  await api('PATCH', `/teams/${team.id}`, { name: 'Kozijnen', profile: { company: 'Raamwinkel', sites: [siteUrl] } });
  step(`TeamBot op ${app.url}, testsite op ${siteUrl}, model ${MODEL} (Ollama, lokaal)`);

  // 1. The owner wrote no routine: the duties come with the role.
  const view = await api('GET', '/proactive/duties');
  const keys = view.duties.filter((d) => d.agentName === 'Sem').map((d) => d.duty.key).sort();
  if (keys.join() !== 'seo.indexering,seo.posities,seo.techniek,werk.afmaken') fail(`vaste taken van Sem: ${keys}`);
  if (!/Koppel Search Console/.test(view.duties.find((d) => d.duty.key === 'seo.posities').needs || '')) fail('seo.posities zegt niet wat hij nodig heeft');
  step(`Sem kreeg zonder instellen: ${keys.join(', ')}; de Search Console-taken wachten op de koppeling en zeggen dat`);
  const tech = view.duties.find((d) => d.duty.key === 'seo.techniek');
  const runs = () => ctx.store.all('SELECT * FROM routine_runs WHERE routine_id = ? ORDER BY created_at, rowid', tech.id).map((r) => ctx.store.decode('routine_runs', r));
  const calls = () => ctx.store.one('SELECT COUNT(*) n FROM usage_log WHERE user_id = ?', owner.id)?.n || 0;

  if (!process.env.TEAMBOT_E2E_UI_ONLY) {
  // 2. On its own schedule (every minute here), the site is in order: quiet, no model.
  await api('PATCH', `/routines/${tech.id}`, { schedule: { kind: 'interval', everyMinutes: 1 } });
  const first = await until(() => runs().find((r) => r.finished_at), 100_000, 'eerste run volgens schema');
  if (first.trigger !== 'schedule') fail(`de run kwam niet van het schema: ${first.trigger}`);
  if (first.status !== 'no_update' || !/^In orde: 1 website, 3 pagina’s gecontroleerd/.test(first.summary)) fail(`eerste run: ${first.status} ${first.summary}`);
  if (calls() !== 0) fail(`er is een model aangeroepen voor een controle die in orde was (${calls()})`);
  // (The main bot's first overview, "Nodig van jou: koppel Search Console", is not about this check.)
  const quiet = ((await api('GET', '/notifications')).items || []).filter((n) => !/overzicht/.test(n.title));
  if (quiet.length) fail(`een controle zonder bevinding gaf een melding: ${quiet.map((n) => n.title)}`);
  step(`run volgens schema om ${first.finished_at}: “${first.summary}” — 0 modelaanroepen, 0 meldingen`);
  await api('POST', '/proactive/briefing', {}); // the state before the problem

  // 3. The seeded problem.
  site.noindex = true;
  site.broken = true;
  const found = await until(() => runs().find((r) => r.meta?.duty?.findings > 0), 100_000, 'de run die het probleem vindt');
  const taken = await until(async () => {
    const t = await ctx.services.teamdata.rows(owner.id, 'SELECT * FROM taken ORDER BY id', [], true, team.id);
    return t.length >= 2 ? t : null;
  }, 20_000, 'taken op het bord');
  for (const t of taken) if (!t.klaar_als || !/gemeten \d{4}-\d\d-\d\d \d\d:\d\d UTC/.test(t.beschrijving || '') || t.eigenaar !== 'Sem' || t.status === undefined) fail(`taak zonder klaar_als of bewijs: ${JSON.stringify(t)}`);
  step(`probleem gevonden (run ${found.trigger}); taken: ${taken.map((t) => `#${t.id} “${t.titel}” · klaar als: ${t.klaar_als} · bewijs: ${t.beschrijving}`).join(' | ')}`);

  // 4. The bot is woken on the real local model with what TeamBot measured.
  const done = await until(() => runs().find((r) => r.id === found.id && ['done', 'no_update', 'error', 'cancelled'].includes(r.status) && r.run_id), 600_000, 'het antwoord van het lokale model');
  const core = ctx.store.one('SELECT * FROM runs WHERE id = ?', done.run_id);
  const msgs = ctx.store.messages(done.thread_id);
  const answer = msgs.filter((m) => m.role === 'assistant' && m.content).at(-1)?.content || '';
  const toolsUsed = msgs.filter((m) => m.run_id === done.run_id).flatMap((m) => (m.parts?.toolCalls || []).map((c) => c.name));
  if (done.status === 'error') fail(`de run op het lokale model mislukte: ${done.error}`);
  if (!calls()) fail('geen modelaanroep vastgelegd');
  step(`echte modelrun: status ${done.status}, ${calls()} modelaanroep(en), engine ${core.provider_id === prov.id ? 'Ollama' : core.provider_id}, tools: ${toolsUsed.join(', ') || 'geen'}`);
  step(`antwoord van ${MODEL}: ${answer.replace(/\s+/g, ' ').slice(0, 400)}`);
  await api('PATCH', `/routines/${tech.id}`, { schedule: { kind: 'weekly', days: [0, 1, 2, 3, 4, 5, 6], times: ['06:30'] } });

  // 5. The briefing of the main bot mentions it (no model).
  const before = calls();
  const b = await api('POST', '/proactive/briefing', {});
  if (!/nieuwe problemen gevonden|nieuw probleem gevonden/.test(b.text) || !/noindex/.test(b.text)) fail(`het overzicht noemt het probleem niet: ${b.text}`);
  if (calls() !== before) fail('het overzicht riep een model aan');
  const mainChat = ctx.store.messages(ctx.chat.threadForAgent(owner.id, baas.id).id).at(-1);
  if (mainChat?.content !== b.text) fail('het overzicht staat niet in de chat van de hoofdbot');
  step(`overzicht van Baas (zonder model):\n${b.text}`);

  }
  // ---- data for the other screens: a project in the loop and scored opportunities (written through the services)
  const projects = ctx.services.projects;
  const kansen = ctx.services.kansen;
  await projects.start(owner.id, team.id, 'Sem', { naam: 'Raamwinkel tip-top', site: siteUrl, doel: 'Geen technische SEO-fouten meer', eigenaar: 'Sem' });
  await projects.step(owner.id, team.id, 1, 'Sem', { nulmeting: 'Search Console 9 nov: 1.240 klikken per week, gemiddelde positie 14,2' });
  await projects.step(owner.id, team.id, 1, 'Sem', { diagnose: 'De startpagina staat op noindex en een pagina uit de sitemap geeft 404; daardoor verdwijnen pagina’s uit Google.' });
  await projects.step(owner.id, team.id, 1, 'Sem', { plan: 'Noindex weghalen, de kapotte pagina herstellen, daarna opnieuw meten.', klaar_als: 'de sitecontrole vindt 0 fouten', taken: [{ titel: 'Noindex van de startpagina halen', klaar_als: 'geen noindex meer' }, { titel: 'Pagina /prijzen herstellen', klaar_als: '/prijzen geeft 200' }] });
  await api('POST', '/proactive/projects', { naam: 'Merchant Center feed', doel: 'Geen afgekeurde producten' });
  const src = (u, d, t) => ({ url: u, datum: d, titel: t });
  const base = { kosten: '€ 150 testbudget en 4 uur', risico: 'Account kan geblokkeerd worden bij AI-video’s zonder label.', minitest: '3 video’s voor 1 product, 7 dagen, meet kosten per bestelling.' };
  await kansen.report(owner.id, team.id, 'Rik', { ...base, titel: 'TikTok Shop-advertenties', wat: 'Producten verkopen via TikTok Shop met betaalde video’s.', waarom_nu: 'TikTok Shop is net in Nederland geopend en de advertentiekosten zijn nog laag.', bronnen: [src('https://example.com/tiktok-shop-nl', '2026-10-21', 'Voorbeeldbron (testgegevens)')] });
  await kansen.report(owner.id, team.id, 'Rik', { ...base, titel: 'YouTube-kanaal dat verkeer naar de site stuurt', wat: 'Korte uitlegvideo’s over kozijnen met een link naar de vergelijker.', waarom_nu: 'Shorts in het Nederlands krijgen sinds kort meer bereik.', risico: 'Massale AI-video’s kunnen tot een ban leiden.', kosten: '€ 0 en 6 uur', minitest: '5 video’s in 10 dagen, meet kliks naar de site.', bronnen: [src('https://example.com/shorts-nl', '2026-10-28', 'Voorbeeldbron (testgegevens)')] });
  await kansen.score(owner.id, team.id, 'Baas', 1, { vraag: 4, past: 5, moeite: 2, kosten: 2, risico: 4, toelichting: 'Past bij de webshop; het risico op een ban is echt.' });
  await kansen.score(owner.id, team.id, 'Baas', 2, { vraag: 4, past: 4, moeite: 3, kosten: 1, risico: 3, toelichting: 'Past bij de SEO-sites; rustig opbouwen.' });
  await kansen.propose(owner.id);
  step(`kansen: ${(await api('GET', '/proactive/kansen')).kansen.map((k) => `${k.id} ${k.status} ${k.score}`).join(', ')}`);
  void rik;
  void sem;

  // ---- the new screens
  browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
  const errors = [];
  const shots = [
    ['werk-vaste-taken', '#/m/routines/werk', '[data-testid="duty-row"]'],
    ['werk-projecten', '#/m/routines/werk/projecten', '[data-testid="project-card"]'],
    ['werk-kansen', '#/m/routines/werk/kansen', '[data-testid="kans-card"]'],
    ['wacht-op-jou-kansen', '#/inbox', '[data-testid="kans-card"]'],
    ['taken-bord', '#/tasks', 'text=noindex'],
  ];
  for (const [w, h, name] of [[1280, 900, 'pc'], [402, 874, 'telefoon']]) {
    const page = await (await browser.newContext({ viewport: { width: w, height: h }, colorScheme: 'light', bypassCSP: true, isMobile: name === 'telefoon', hasTouch: name === 'telefoon' })).newPage();
    page.on('pageerror', (e) => errors.push(e.message));
    await page.goto(`${app.url}/#token=${token}`);
    await page.waitForTimeout(800);
    for (const [file, hash, sel] of shots) {
      await page.goto(`${app.url}/${hash}`);
      try {
        await page.locator(sel).first().waitFor({ timeout: 10_000 });
      } catch {
        fail(`${name} ${hash}: ${sel} niet in beeld`);
      }
      await page.waitForTimeout(400);
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      if (overflow > 1) fail(`${name} ${hash}: de pagina schuift ${overflow}px opzij`);
      await page.screenshot({ path: path.join(SHOTS, `${file}-${name}.png`), fullPage: true });
    }
    if (name === 'pc') {
      // The owner says yes to one opportunity on the board: it becomes a mini-test in the project loop.
      await page.goto(`${app.url}/#/m/routines/werk/kansen`);
      await page.locator('[data-testid="kans-card"]').first().getByRole('button', { name: 'Ja, test dit' }).click();
      await until(async () => (await api('GET', '/proactive/projects')).projects.some((p) => /^Mini-test: /.test(p.naam)), 8000, 'mini-test als project');
      step('“Ja, test dit” op het kansenbord maakt een mini-test in de projectlus');
    }
    await page.context().close();
  }
  if (errors.length) fail(`paginafouten: ${errors.join(' | ')}`);
  step(`schermafbeeldingen in ${SHOTS}`);
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  await browser?.close();
  await app.close();
  web.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
if (!process.exitCode) step('klaar: alles geslaagd');
