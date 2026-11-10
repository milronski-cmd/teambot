// 0.4.4 P7 and P11, clicked through as the owner does it, on the computer and on a paired phone:
//   P7a  memory from ChatGPT/Claude/Gemini: the question, paste, preview (nothing written), proposals, undo;
//   P7b  Overstappen uit OpenClaw: a synthetic OpenClaw in the empty HOME, preview, import (routines and skills off), undo;
//   P11  a skill's "Testen" tab: questions with "klaar als", the estimate, a run judged per question;
//   P11  "Maak een skill" from a document in a dossier: the bot's draft, saved as a skill.
// Starts TeamBot (desktop mode) in an empty temp data dir with an empty HOME/APPDATA (nothing of this PC is found or
// changed), a scripted test model, and drives Edge/Chrome headless with Playwright; axe-core WCAG 2.2 AA on each screen.
// Usage: npm run build:ui && node --import tsx tests/e2e/switch-skills.mjs   (TEAMBOT_E2E_PORT=<port>, TEAMBOT_E2E_SHOTS=<dir>)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

const step = (s) => console.log(`✔ ${s}`);
const failures = [];
const fail = (s) => {
  failures.push(s);
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms, what) => {
  const end = Date.now() + ms;
  for (;;) {
    try {
      if (await fn()) return true;
    } catch {
      /* not there yet */
    }
    if (Date.now() > end) return fail(`time-out: ${what}`), false;
    await sleep(100);
  }
};
const SHOTS = process.env.TEAMBOT_E2E_SHOTS || '';
if (SHOTS) fs.mkdirSync(SHOTS, { recursive: true });

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-switch-skills-home-'));
Object.assign(process.env, {
  HOME: home,
  USERPROFILE: home,
  APPDATA: path.join(home, 'AppData', 'Roaming'),
  LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
  XDG_DATA_HOME: path.join(home, 'xdg', 'data'),
  XDG_CONFIG_HOME: path.join(home, 'xdg', 'config'),
  XDG_CACHE_HOME: path.join(home, 'xdg', 'cache'),
});
delete process.env.TEAMBOT_DATA;
delete process.env.OPENCLAW_STATE_DIR;
delete process.env.OPENCLAW_CONFIG_PATH;

// A synthetic OpenClaw in the empty HOME (the real one of this PC is never read).
const { makeOpenClawFixture, snapshotFiles } = await import('../fixtures/openclaw-fixture.ts');
const oc = makeOpenClawFixture();
process.env.TEAMBOT_OPENCLAW_DIR = oc.state;
process.env.TEAMBOT_OPENCLAW_HOME = oc.home;
const ocBefore = snapshotFiles(oc.state);

const { createApp } = await import('../../server/app.ts');
const { mockAdapter } = await import('../helpers.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-switch-skills-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const pcToken = app.ctx.auth.ensureLocalOwner();
for (const k of app.ctx.providers.kinds.values()) if (k.detect) k.detect = async () => ({ installed: false, detail: 'e2e' });
const script = [];
const requests = [];
app.ctx.providers.registerKind({ id: 'mock', label: 'Testmodel', type: 'api', group: 'local', billing: 'local', needsKey: false, description: 'e2e', models: ['mock-1'], defaultModel: 'mock-1', detect: async () => ({ installed: true, detail: 'e2e' }), create: () => mockAdapter(script, requests) });
const call = async (token, method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const pc = async (method, p, body) => {
  const r = await call(pcToken, method, p, body);
  if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status}: ${r.body.error}`);
  return r.body;
};
const prov = await pc('POST', '/providers', { kind: 'mock' });
const bot = await pc('POST', '/agents', { name: 'Winkelbot', role: 'Klantenservice', provider_id: prov.id, model: 'mock-1', access_mode: 'ask' });
console.log(`• TeamBot op ${app.url} (lege datamap ${dir})`);

// The phone pairs through the real flow and uses its own device session.
const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.4';
const ticket = await pc('POST', '/mobile/pair', { baseUrl: app.url });
const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
const claim = await fetch(app.url + '/api/public/mobile/claim', { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': IOS_UA }, body: JSON.stringify({ secret, name: 'iPhone van Sanne', platform: 'ios', client: 'ios-app' }) }).then((r) => r.json());
const phoneToken = claim.token;
if ((await call(phoneToken, 'GET', '/me')).body.session?.kind !== 'device') fail('de telefoon heeft geen apparaatsessie');

const errors = [];
const failed = [];
const watch = (page, who) => {
  page.on('pageerror', (e) => errors.push(`${who}: ${e.message}`));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|Failed to load resource/.test(m.text()) && errors.push(`${who}: ${m.text()}`));
  page.on('dialog', (d) => (errors.push(`${who}: onverwacht browserdialoog: ${d.message()}`), d.dismiss().catch(() => {})));
  page.on('response', (r) => {
    const u = new URL(r.url());
    if (u.pathname.startsWith('/api/') && r.status() >= 400) failed.push(`${who}: ${r.status()} ${r.request().method()} ${u.pathname}`);
  });
};
const desk = await browser.newContext({ viewport: { width: 1360, height: 900 }, locale: 'nl-NL', bypassCSP: true, permissions: ['clipboard-read', 'clipboard-write'] });
const page = await desk.newPage();
watch(page, 'pc');
await page.goto(`${app.url}/#token=${pcToken}`);
await page.getByRole('navigation', { name: 'Hoofdmenu' }).waitFor({ timeout: 15000 });
const phoneCtx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IOS_UA, locale: 'nl-NL', bypassCSP: true, permissions: ['clipboard-read', 'clipboard-write'] });
await phoneCtx.addInitScript((t) => {
  try {
    if (localStorage.getItem('tb_token') !== t) {
      localStorage.removeItem('tb_urlkey');
      localStorage.setItem('tb_token', t);
    }
  } catch {}
}, phoneToken);
const phone = await phoneCtx.newPage();
watch(phone, 'telefoon');
await phone.goto(app.url + '/');
await phone.getByRole('navigation', { name: 'Hoofdmenu' }).waitFor({ timeout: 15000 });

const go = async (p, hash) => {
  await p.evaluate((h) => (location.hash = h), hash);
  await p.waitForTimeout(500);
};
const press = async (p, loc) => {
  await loc.scrollIntoViewIfNeeded();
  if (p === phone) await loc.tap();
  else await loc.click();
};
/** Checks on every screen: no failed requests or page errors, no sideways scroll on the phone, axe WCAG 2.2 AA. */
async function screen(p, name) {
  await p.waitForTimeout(400);
  const overflow = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (p === phone && overflow > 1) fail(`${name}: de pagina schuift ${overflow}px opzij`);
  if (failed.length) fail(`${name}: mislukte verzoeken: ${failed.splice(0).join(', ')}`);
  if (errors.length) fail(`${name}: paginafouten: ${errors.splice(0).join(' | ')}`);
  await p.addScriptTag({ content: axeSource });
  const v = await p.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  if (v.length) fail(`a11y ${name}: ${v.join(' | ')}`);
  if (SHOTS) await p.screenshot({ path: path.join(SHOTS, `${name.replace(/[^a-z0-9]+/gi, '-').toLowerCase()}.png`) });
}
const proposals = () => app.ctx.store.all("SELECT id FROM memory_items WHERE status = 'proposed' AND source_kind = 'import'").length;

const PASTE = 'Hier is wat ik over je weet:\n\n**Over mij**\n- Woont in Utrecht\n- Werkt als ontwerper\n\n### Voorkeuren\n- Houdt van korte antwoorden\n- Wachtwoord: hunter2\n\nLaat me weten als je meer wilt!';

try {
  // ============================================================ P7a memory from another assistant (pc, then phone)
  for (const [p, who] of [
    [page, 'computer'],
    [phone, 'telefoon'],
  ]) {
    const main = p.locator('#inhoud');
    await go(p, '#/m/memory/opslag');
    const card = main.getByRole('heading', { name: 'Geheugen overnemen uit ChatGPT, Claude of Gemini' });
    await card.waitFor({ timeout: 10000 }).catch(() => fail(`[P7a] ${who}: geen kaart "Geheugen overnemen" onder Geheugen › Opslag`));
    if (!(await main.getByText('Schrijf alles op wat je over mij weet', { exact: false }).count())) fail(`[P7a] ${who}: de vraag voor de andere assistent staat er niet`);
    await press(p, main.getByRole('button', { name: 'Kopieer de vraag' }));
    if (who === 'computer') {
      const clip = await p.evaluate(() => navigator.clipboard.readText()).catch(() => '');
      if (!/Schrijf alles op wat je over mij weet/.test(clip)) fail('[P7a] computer: de vraag staat niet op het klembord');
    }
    await main.getByLabel('Antwoord van de andere assistent').fill(PASTE);
    const before = proposals();
    await press(p, main.getByRole('button', { name: 'Voorbeeld bekijken' }));
    await main.getByText('Geheim: overgeslagen').waitFor({ timeout: 8000 }).catch(() => fail(`[P7a] ${who}: het voorbeeld markeert het wachtwoord niet als geheim`));
    if (proposals() !== before) fail(`[P7a] ${who}: het voorbeeld schreef al iets`);
    await screen(p, `p7a-voorbeeld-${who}`);
    if (who === 'computer') {
      await press(p, main.getByRole('button', { name: '3 voorstellen klaarzetten' }));
      await main.getByText('3 voorstellen uit ChatGPT klaargezet.', { exact: false }).waitFor({ timeout: 8000 }).catch(() => fail('[P7a] computer: geen melding "3 voorstellen klaargezet"'));
      if (proposals() !== before + 3) fail(`[P7a] computer: ${proposals() - before} voorstellen in plaats van 3`);
      await press(p, main.getByRole('button', { name: 'Ongedaan maken' }).first());
      await until(() => proposals() === before, 8000, '[P7a] computer: ongedaan maken haalt de voorstellen weg');
      step('[P7a] computer: vraag gekopieerd, geplakt, voorbeeld (niets geschreven, geheim overgeslagen), 3 voorstellen, ongedaan gemaakt');
    } else {
      // Undone on the pc, so the same three facts are new again (importing again after an undo works).
      await press(p, main.getByRole('button', { name: '3 voorstellen klaarzetten' }));
      await until(() => proposals() === before + 3, 8000, '[P7a] telefoon: 3 voorstellen');
      await screen(p, 'p7a-klaar-telefoon');
      step('[P7a] telefoon: dezelfde stappen werken vanaf de gekoppelde telefoon');
    }
  }

  // ============================================================ P7b OpenClaw (pc import + undo; phone sees the card)
  {
    const main = page.locator('#inhoud');
    await go(page, '#/settings/openbot-import-overstappen');
    await main.getByText('Overstappen uit OpenClaw').first().waitFor({ timeout: 10000 }).catch(() => fail('[P7b] geen kaart "Overstappen uit OpenClaw" onder Instellingen › Overstappen'));
    await main.getByText(`Gevonden: ${oc.state}`, { exact: false }).waitFor({ timeout: 8000 }).catch(() => fail('[P7b] de nep-OpenClaw is niet gevonden'));
    await press(page, main.getByRole('button', { name: 'OpenClaw inlezen' }));
    const dlg = page.getByRole('dialog', { name: 'Overstappen uit OpenClaw' });
    await dlg.getByText('Clawd').first().waitFor({ timeout: 10000 }).catch(() => fail('[P7b] voorvertoning toont de agent Clawd niet'));
    if (!(await dlg.getByText('Kan niet mee:', { exact: false }).count())) fail('[P7b] de back-up-opdracht staat niet als "Kan niet mee"');
    if (app.ctx.store.agents(app.ctx.auth.owner().id).some((a) => a.name === 'Clawd')) fail('[P7b] de voorvertoning maakte al een bot');
    await screen(page, 'p7b-voorvertoning');
    await press(page, dlg.getByRole('button', { name: 'Importeren' }));
    await main.getByText('Overgenomen: 2 bots', { exact: false }).waitFor({ timeout: 10000 }).catch(() => fail('[P7b] geen samenvatting na importeren'));
    const ocBots = app.ctx.store.agents(app.ctx.auth.owner().id).filter((a) => a.settings?.importedFrom?.app === 'openclaw');
    const routines = app.ctx.services.routines.engine.routinesOf(app.ctx.auth.owner().id);
    if (ocBots.length !== 2 || routines.some((r) => r.status !== 'paused') || routines.length !== 3) fail(`[P7b] ${ocBots.length} bots, routines ${JSON.stringify(routines.map((r) => r.status))}`);
    await screen(page, 'p7b-klaar');
    await press(page, main.getByRole('button', { name: 'Import ongedaan maken' }).last());
    const undo = page.getByRole('dialog', { name: 'Import uit OpenClaw ongedaan maken?' });
    await undo.waitFor({ timeout: 8000 });
    await press(page, undo.getByRole('button', { name: 'Ongedaan maken' }));
    await until(() => !app.ctx.store.agents(app.ctx.auth.owner().id).some((a) => a.settings?.importedFrom?.app === 'openclaw'), 10000, '[P7b] ongedaan maken haalt de bots weg');
    const now = snapshotFiles(oc.state);
    if ([...ocBefore].some(([k, v]) => now.get(k) !== v) || now.size !== ocBefore.size) fail('[P7b] OpenClaw is veranderd');
    step('[P7b] computer: OpenClaw gevonden, voorvertoning (niets geschreven), 2 bots met routines uit, ongedaan gemaakt; OpenClaw onveranderd');
    const pm = phone.locator('#inhoud');
    await go(phone, '#/settings/openbot-import-overstappen');
    await pm.getByText('Overstappen uit OpenClaw').first().waitFor({ timeout: 10000 }).catch(() => fail('[P7b] telefoon: geen OpenClaw-kaart'));
    await screen(phone, 'p7b-telefoon');
    step('[P7b] telefoon: de kaart staat er, rustig en zonder fouten');
  }

  // ============================================================ P11 skill tests (pc) and from a document (phone)
  {
    const pv = await pc('POST', '/skills/import/preview', { kind: 'paste', text: '---\nname: retour-afhandelen\ndescription: Handelt een retour af.\n---\n\n# Retour\n\nBinnen 30 dagen: stuur een retourlabel.\n' });
    const skillId = (await pc('POST', '/skills/import/commit', { stagingId: pv.stagingId, enableFor: [bot.id] })).results[0].skillId;
    const main = page.locator('#inhoud');
    await go(page, `#/m/skills/mine/${skillId}`);
    await press(page, main.getByRole('tab', { name: 'Testen' }));
    await main.getByLabel('Vraag 1').fill('Klant wil na 20 dagen terugsturen.');
    await main.getByLabel('Klaar als').fill('Zegt dat het mag en stuurt een retourlabel.');
    await press(page, main.getByRole('button', { name: 'Testvragen bewaren' }));
    await main.getByText('Kost 2 aanroepen', { exact: false }).waitFor({ timeout: 10000 }).catch(() => fail('[P11] geen schatting vooraf'));
    script.push({ text: 'Dat mag: ik stuur je een retourlabel.' }, { text: '{"verdict":"goed","reason":"Noemt het label."}' });
    await press(page, main.getByRole('button', { name: '1 testvraag draaien' }));
    await main.getByText('Alles goed').first().waitFor({ timeout: 15000 }).catch(() => fail('[P11] testresultaat "Alles goed" verschijnt niet'));
    await screen(page, 'p11-testen');
    step('[P11] computer: testvraag met "klaar als" bewaard, schatting vooraf, test gedraaid: Alles goed');

    // From a document, on the phone.
    const d = (await pc('POST', '/memory/dossiers', { title: 'Webshop' })).dossier;
    await pc('POST', `/memory/dossiers/${d.id}/sources`, { kind: 'note', title: 'Retourbeleid', text: '# Retourbeleid\n\n## Termijn\nBinnen 30 dagen.\n\n## Label\nStuur een label via PostNL.' });
    const pm = phone.locator('#inhoud');
    await go(phone, `#/m/memory/dossiers/${d.id}`);
    await press(phone, pm.getByRole('tab', { name: 'Bronnen' }));
    script.push({ text: '{"name":"retourbeleid","description":"Handelt retouren af volgens het beleid.","instructions":"# Retour\\n\\n1. Binnen 30 dagen.\\n2. Label via PostNL."}' });
    await press(phone, pm.getByRole('button', { name: 'Maak een skill' }));
    const dlg = phone.getByRole('dialog', { name: 'Maak een skill van dit document' });
    await dlg.getByText('Concept van Winkelbot', { exact: false }).waitFor({ timeout: 10000 }).catch(() => fail('[P11] telefoon: geen concept van de bot'));
    await screen(phone, 'p11-document-telefoon');
    await press(phone, dlg.getByRole('button', { name: 'Opslaan als skill' }));
    await until(() => app.ctx.store.one("SELECT id FROM skills WHERE name = 'retourbeleid' AND status = 'active'"), 10000, '[P11] telefoon: skill uit het document bewaard');
    step('[P11] telefoon: Maak een skill van een document → concept van de bot → bewaard');
  }
} catch (e) {
  fail(`onverwachte fout: ${e?.stack || e}`);
} finally {
  if (errors.length) fail(`paginafouten: ${[...new Set(errors)].slice(0, 8).join(' | ')}`);
  await browser.close();
  await app.close();
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    fs.rmSync(oc.root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  } catch {
    /* left in the temp folder */
  }
  console.log(failures.length ? `\n${failures.length} fout(en)` : '\nAlles geslaagd');
  process.exit(failures.length ? 1 : 0);
}
