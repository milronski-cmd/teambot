// "Wat start vanzelf" in a real browser, with a scripted AI (no real model, nothing of this pc).
//
// The one list of everything that starts by itself (ui/src/modules/routines/Planned.tsx, GET /api/routines/planned)
// gives every row one action. This check makes one row of every kind that list can show — a routine, a reminder, a
// wait point a bot set itself, a vaste taak, a new attempt, a scheduled workflow, work that lies ready for a bot, the
// main bot's check-in and overview, a specialist's learning round, and a conversation the memory still has to read —
// walks to the list the way a person does (Instellingen › Meer mogelijkheden › Wat start vanzelf), clicks every action
// of every row, also the ones under "Staat uit" and the banner when all routines are paused, and checks after each
// click through the API that it really happened (and that nothing else changed). The same list on Taken › Werk last.
//
// Usage: npm run build:ui && node --import tsx tests/e2e/planned-actions.mjs
//        (TEAMBOT_UI_DIR = another build; TEAMBOT_E2E_SHOTS = folder for screenshots; TEAMBOT_E2E_PORT;
//         TEAMBOT_E2E_BROWSER=chrome|msedge)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

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
const until = async (fn, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) {
    try {
      if (await fn()) return true;
    } catch {
      /* not there yet */
    }
  }
  return false;
};

// The browser first (it needs this pc's own environment), then TeamBot in an empty one: a temporary data folder and
// home, and nothing of this pc found or used.
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-planned-home-'));
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
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-planned-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
for (const k of app.ctx.providers.kinds.values()) if (k.detect) k.detect = async () => ({ installed: false, detail: 'e2e' });
console.log(`• TeamBot op ${app.url} (lege datamap ${dir})`);

// ---------------------------------------------------------------- a scripted AI on this computer (free, like Ollama)
// A message with WACHTPUNT makes the bot set a wait point itself (wait_for, tomorrow 09:00); everything else: "Gedaan."
const pad = (n) => String(n).padStart(2, '0');
const tomorrow = new Date(Date.now() + 86_400_000);
const waitAt = `${tomorrow.getFullYear()}-${pad(tomorrow.getMonth() + 1)}-${pad(tomorrow.getDate())}T09:00`;
const textOf = (m) => (typeof m?.content === 'string' ? m.content : (m?.content || []).map((p) => p.text || '').join(' '));
app.ctx.providers.registerKind({
  id: 'mock',
  label: 'Testmodel',
  type: 'api',
  needsKey: false,
  description: 'e2e',
  billing: 'local',
  models: ['mock-1'],
  defaultModel: 'mock-1',
  create: () => ({
    kind: 'mock',
    async listModels() {
      return [{ id: 'mock-1' }];
    },
    async test() {
      return { ok: true, detail: 'e2e' };
    },
    async chat(req, _signal, onEvent) {
      const last = req.messages.at(-1);
      if (last?.role === 'user' && /WACHTPUNT/.test(textOf(last)))
        return { text: '', toolCalls: [{ id: `call_${Date.now()}`, name: 'wait_for', args: { event: 'time', at: waitAt, then: 'Laat de eigenaar weten dat het zover is.' } }], usage: { input: 10, output: 5 }, stop: 'tool_use', model: req.model };
      onEvent({ type: 'text', delta: 'Gedaan.' });
      return { text: 'Gedaan.', toolCalls: [], usage: { input: 10, output: 5 }, stop: 'end', model: req.model };
    },
  }),
});

const api = async (method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${j.error}`);
  return j;
};
const planned = async () => (await api('GET', '/routines/planned')).planned;
const idle = () => until(() => !app.ctx.store.all("SELECT id FROM runs WHERE status IN ('queued','running','waiting')").length, 20_000);

const errors = [];
const ctx = await browser.newContext({ viewport: { width: 1360, height: 950 }, locale: 'nl-NL' });
const page = await ctx.newPage();
page.on('pageerror', (e) => errors.push(e.message));
page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push(m.text()));
page.on('response', (r) => r.status() >= 400 && /\/api\//.test(r.url()) && errors.push(`${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`));
const shot = async (name) => SHOTS && page.screenshot({ path: path.join(SHOTS, `wat-start-vanzelf-${name}.png`), fullPage: true });

const list = page.getByTestId('planned-list');
/** The row of a kind in the list (and its title, when there are more of that kind). */
const row = (kind, title) => {
  const l = list.locator(`li[data-planned="${kind}"]`);
  return title ? l.filter({ hasText: title }) : l;
};
const offRow = (key) => list.locator(`li[data-off="${key}"]`);
/** What the list shows now: kind and title of every row, and the keys of the rows under "Staat uit". */
const shown = async () => ({
  on: await list.locator('li[data-planned]').evaluateAll((ls) => ls.map((l) => `${l.getAttribute('data-planned')}: ${l.querySelector('span > span')?.textContent.trim()}`)),
  off: await list.locator('li[data-off]').evaluateAll((ls) => ls.map((l) => l.getAttribute('data-off'))),
});
/** Walk to the list as a person does: Instellingen, Meer mogelijkheden, Wat start vanzelf. */
async function walkToList() {
  await page.locator('aside a[href="#/settings"]').first().click();
  await page.getByRole('navigation', { name: 'Instellingen' }).getByRole('link', { name: /^Meer mogelijkheden/ }).first().click();
  await page.getByRole('link', { name: /^Wat start vanzelf/ }).first().click();
  await list.waitFor({ timeout: 15_000 });
  await until(async () => (await list.locator('li').count()) > 0, 10_000);
}
/** Click a button of a row and wait until the list has taken the change in. */
async function press(where, name) {
  const b = where.getByRole('button', { name, exact: true });
  await b.click();
  await until(async () => !(await b.count()) || !(await b.isVisible()) || !(await b.isDisabled()), 8000);
  await page.waitForTimeout(400);
}

try {
  // ---------------------------------------------------------------- an empty install: nothing starts
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForTimeout(1000);
  const prov = await api('POST', '/providers', { kind: 'mock' });
  // The first bot is the main bot; Bo gets work on the board; Vindbaar is a specialist by its role.
  const eerste = await api('POST', '/agents', { name: 'Eerste', role: 'Assistent', provider_id: prov.id, model: 'mock-1', access_mode: 'auto' });
  const bo = await api('POST', '/agents', { name: 'Bo', role: 'Assistent', provider_id: prov.id, model: 'mock-1', access_mode: 'auto' });
  await page.reload();
  await page.waitForTimeout(1000);
  await walkToList();
  let s = await shown();
  // Only what TeamBot does for the installation itself: the automatic backup and, on a pc where it can run, the one
  // download of the search model. Both cost nothing.
  check(
    'lege installatie met twee bots: alleen de back-up (en het zoekmodel) start vanzelf, en dat kost niets',
    s.on.includes('backup: Automatische back-up van je gegevens') && s.on.every((x) => /^(backup|download): /.test(x)) && (await list.locator('li[data-planned]').getByText('kost niets').count()) === s.on.length,
    JSON.stringify(s),
  );
  await row('backup').getByRole('link', { name: 'Aanpassen' }).click();
  await until(async () => (await page.evaluate(() => location.hash)) === '#/settings/backups-app');
  check('back-up › Aanpassen: de instellingen van de back-ups', (await page.evaluate(() => location.hash)) === '#/settings/backups-app', await page.evaluate(() => location.hash));
  await page.goBack();
  await list.waitFor({ timeout: 10_000 });
  check('onder "Staat uit": de check-in, het overzicht en de leerronde van een specialist', s.off.join(',') === 'checkin,briefing,learning', s.off.join(','));
  // "Instellen" for the learning round: no specialist yet, so it opens the page where you make one.
  await offRow('learning').getByRole('link', { name: 'Instellen' }).click();
  await until(async () => (await page.evaluate(() => location.hash)).startsWith('#/m/specialists'));
  check('Leerronde van een specialist › Instellen opent Specialisten', (await page.evaluate(() => location.hash)).startsWith('#/m/specialists'), await page.evaluate(() => location.hash));
  await page.goBack();
  await list.waitFor({ timeout: 10_000 });

  // ---------------------------------------------------------------- one row of every kind
  const routine = await api('POST', '/routines', { name: 'Post nalopen', prompt: 'Kijk of er post is.', agent_id: eerste.id, schedule: { kind: 'interval', everyMinutes: 600 } });
  const reminder = await api('POST', '/routines', { name: 'Tandarts bellen', prompt: 'Herinnering', agent_id: eerste.id, schedule: { kind: 'interval', everyMinutes: 1440 }, options: { reminder: { text: 'Bel de tandarts.' } } });
  const duty = await api('POST', '/routines', { name: 'Site in de gaten houden', prompt: 'Kijk of de site werkt.', agent_id: bo.id, schedule: { kind: 'interval', everyMinutes: 720 }, options: { duty: { check: 'De site geeft een 200 terug.' } } });
  const later = await api('POST', '/routines', { name: 'Rapport maken', prompt: 'Maak het rapport.', agent_id: eerste.id, schedule: { kind: 'interval', everyMinutes: 10080 } });
  const retry = await api('POST', `/routines/${later.id}/run-after`, { at: Date.now() + 2 * 3600_000 });
  const flow = await api('POST', '/workflows', { name: 'Weekoverzicht', steps: [{ kind: 'bot', agentId: eerste.id, prompt: 'Vat de week samen.' }], schedule: { kind: 'daily', time: '07:30' } });
  // The bot sets a wait point itself, in its chat (and that conversation is one the memory reads later).
  const th = await api('POST', '/threads', { agentId: eerste.id });
  await api('POST', `/threads/${th.id}/messages`, { content: 'Zet een WACHTPUNT voor morgen.' });
  await idle();
  // A task on Bo's name: handed over at once, Bo answers without finishing it, so it lies ready.
  await api('POST', '/rooms/tasks', { title: 'Sitemap nalopen', owner: 'Bo' });
  await idle();
  await api('PUT', '/proactive/settings', { briefing: 'dag' });
  await api('PUT', '/proactive/checkin', { enabled: true });
  const seo = await api('POST', '/agents', { name: 'Vindbaar', role: 'SEO-specialist: technische SEO en zoekwoorden', provider_id: prov.id, model: 'mock-1', access_mode: 'auto' });
  await idle();
  const want = ['routine', 'reminder', 'waitpoint', 'duty', 'retry', 'workflow', 'work', 'checkin', 'learning', 'backup'];
  await until(async () => {
    const got = new Set((await planned()).map((p) => p.kind));
    return want.every((k) => got.has(k));
  }, 20_000);
  const api0 = await planned();
  check('de server plant een regel van elke soort (behalve het overzicht: dat brengt de check-in mee)', want.every((k) => api0.some((p) => p.kind === k)) && !api0.some((p) => p.kind === 'briefing'), api0.map((p) => `${p.kind}:${p.id}`).join(', '));
  const review = api0.find((p) => p.kind === 'learning' && p.id.startsWith('review:'));
  check('het gesprek met de bot staat erbij: het geheugen leest het straks na (gebruikt AI)', !!review && review.model === true && review.agentId === eerste.id, JSON.stringify(review || null));

  await page.reload();
  await page.waitForTimeout(800);
  await walkToList();
  await until(async () => (await list.locator('li[data-planned]').count()) >= api0.length, 10_000);
  s = await shown();
  check('het scherm toont precies wat de server plant', s.on.length === api0.length && api0.every((p) => s.on.includes(`${p.kind}: ${p.title}`)), `${s.on.length}/${api0.length}: ${s.on.join(' | ')}`);
  check('onder "Staat uit": de leerronde van de nieuwe specialist (die staat uit tot je hem aanzet)', s.off.join(',') === `learning:${seo.id}`, s.off.join(','));
  await shot('alles');

  // ---------------------------------------------------------------- the routine kinds: Pauzeren
  for (const [kind, r] of [
    ['routine', routine],
    ['reminder', reminder],
    ['duty', duty],
  ]) {
    await press(row(kind, r.name), 'Pauzeren');
    const now = await api('GET', `/routines/${r.id}`);
    const gone = !(await planned()).some((p) => p.id === r.id) && !(await row(kind, r.name).count());
    check(`${kind} "${r.name}" › Pauzeren: de routine staat op pauze en is uit de lijst`, now.status === 'paused' && gone, `${now.status}, uit de lijst: ${gone}`);
  }
  const wp = (await planned()).find((p) => p.kind === 'waitpoint');
  await press(row('waitpoint'), 'Pauzeren');
  const wpNow = await api('GET', `/routines/${wp.id}`);
  check('wachtpunt dat de bot zelf zette › Pauzeren: op pauze en uit de lijst', wpNow.status === 'paused' && !(await planned()).some((p) => p.id === wp.id) && !(await row('waitpoint').count()), wpNow.status);

  // ---------------------------------------------------------------- paused: under "Staat uit", with who paused it, and Aanzetten
  const pausedKeys = [routine, reminder, duty, wp].map((r) => `routine:${r.id}`);
  s = await shown();
  check('de gepauzeerde routines staan onder "Staat uit"', pausedKeys.every((k) => s.off.includes(k)), s.off.join(','));
  const offLine = (await offRow(`routine:${routine.id}`).innerText()).trim();
  check('met wie hem pauzeerde', /Gepauzeerd door gebruiker/.test(offLine), offLine);
  await press(offRow(`routine:${routine.id}`), 'Aanzetten');
  const back = await api('GET', `/routines/${routine.id}`);
  check(
    'Staat uit › routine › Aanzetten: staat weer aan, weer in de lijst, niet meer onder "Staat uit"',
    back.status === 'active' && (await planned()).some((p) => p.id === routine.id) && (await row('routine', routine.name).count()) === 1 && !(await offRow(`routine:${routine.id}`).count()),
    back.status,
  );
  await press(offRow(`routine:${reminder.id}`), 'Aanzetten');
  check('Staat uit › herinnering › Aanzetten: weer aan en in de lijst', (await api('GET', `/routines/${reminder.id}`)).status === 'active' && (await row('reminder', reminder.name).count()) === 1);

  // ---------------------------------------------------------------- a new attempt and a workflow: the page where you change it
  // The list itself names the routine and the workflow too: look for the name only once the list is gone (otherwise
  // the check sees the old page, and a moment later the new page's loading placeholder without the name).
  await row('retry').getByRole('link', { name: 'Bekijken' }).click();
  await until(async () => (await page.evaluate(() => location.hash)) === `#/m/routines/r/${later.id}?tab=history`);
  const retryPage = await page.evaluate(() => location.hash);
  await list.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
  await page.getByText(later.name).first().waitFor({ timeout: 10_000 }).catch(() => {});
  const runs = await api('GET', `/routines/${later.id}/runs`);
  const waiting = (runs.runs || runs).find?.((x) => x.id === retry.id);
  check('nieuwe poging › Bekijken: de geschiedenis van die routine, waar de wachtende run staat (er verandert niets)', retryPage === `#/m/routines/r/${later.id}?tab=history` && (await page.getByText(later.name).count()) > 0 && waiting?.status === 'retrying', `${retryPage} ${waiting?.status}`);
  await page.goBack();
  await list.waitFor({ timeout: 10_000 });
  await row('workflow').getByRole('link', { name: 'Aanpassen' }).click();
  await until(async () => (await page.evaluate(() => location.hash)) === `#/m/workflows/w/${flow.id}`);
  await list.waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
  // (The editor shows the name in its field.)
  const named = () => page.evaluate((n) => [...document.querySelectorAll('#inhoud input')].some((e) => e.value === n) || (document.querySelector('#inhoud')?.textContent || '').includes(n), flow.name);
  await until(named, 10_000);
  const flowNow = await api('GET', `/workflows/${flow.id}`);
  const flowAt = await page.evaluate(() => location.hash);
  check('workflow › Aanpassen: de pagina van die workflow (er verandert niets)', flowAt === `#/m/workflows/w/${flow.id}` && (await named()) && flowNow.enabled !== false, `${flowAt}, naam in beeld: ${await named()}, aan: ${flowNow.enabled}`);
  await page.goBack();
  await list.waitFor({ timeout: 10_000 });

  // ---------------------------------------------------------------- the conversation the memory still reads
  const reviewRow = row('learning', review.title);
  const reviewAction = (await reviewRow.locator('a, button').last().innerText()).trim();
  const specialistsBefore = await api('GET', '/specialists');
  if (await reviewRow.getByRole('button').count()) await press(reviewRow, reviewAction);
  else await reviewRow.getByRole('link', { name: reviewAction }).click();
  await page.waitForTimeout(800);
  const specialistsAfter = await api('GET', '/specialists');
  const hash = await page.evaluate(() => location.hash);
  check(
    'gesprek dat het geheugen nog naleest › Bekijken: opent het geheugen waar het staat, en raakt geen specialist',
    reviewAction === 'Bekijken' && JSON.stringify(specialistsAfter) === JSON.stringify(specialistsBefore) && hash === '#/m/memory/pas-geleerd' && (await planned()).some((p) => p.id === review.id),
    `actie "${reviewAction}", ${hash}, specialisten ${specialistsBefore.length} → ${specialistsAfter.length}`,
  );
  if (hash === '#/m/memory/pas-geleerd') {
    // As many conversations as the list has rows for the memory.
    const reviews = (await planned()).filter((p) => p.id.startsWith('review:')).length;
    const waits = page.getByText(/\d+ gesprekk?e?n? (wordt|worden) zo verwerkt/);
    await waits.first().waitFor({ timeout: 10_000 }).catch(() => {});
    const said = (await waits.count()) ? (await waits.first().innerText()).trim() : '';
    check('daar staat dat die gesprekken zo worden verwerkt', said.startsWith(`${reviews} gesprek`), `${said || 'niets'} (${reviews} in de lijst)`);
    await page.goBack();
    await list.waitFor({ timeout: 10_000 });
  } else await walkToList();

  // ---------------------------------------------------------------- work that lies ready: Nu niet, and back
  await press(row('work', 'Bo'), 'Nu niet');
  let w = ((await api('GET', '/proactive/work')).work || []).find((x) => x.agentId === bo.id);
  check('werk dat klaarligt › Nu niet: geparkeerd, uit de lijst, onder "Staat uit"', w?.parked === true && !(await planned()).some((p) => p.kind === 'work') && (await offRow(`work:${bo.id}`).count()) === 1, JSON.stringify({ parked: w?.parked }));
  await press(offRow(`work:${bo.id}`), 'Weer oppakken');
  w = ((await api('GET', '/proactive/work')).work || []).find((x) => x.agentId === bo.id);
  check('Staat uit › Weer oppakken: niet meer geparkeerd en weer in de lijst', w?.parked === false && (await planned()).some((p) => p.kind === 'work') && (await row('work', 'Bo').count()) === 1, JSON.stringify({ parked: w?.parked }));

  // ---------------------------------------------------------------- the learning round of a specialist: Aanzetten, Uitzetten
  await press(offRow(`learning:${seo.id}`), 'Aanzetten');
  let sp = (await api('GET', '/specialists')).find((x) => x.agentId === seo.id);
  check('Staat uit › leerronde van Vindbaar › Aanzetten: aan, en nu in de lijst met een tijd', sp?.learnOn === true && (await planned()).some((p) => p.id === `learn:${seo.id}` && p.at) && (await row('learning', 'Leerronde van Vindbaar').count()) === 1, JSON.stringify({ learnOn: sp?.learnOn }));
  await press(row('learning', 'Leerronde van Vindbaar'), 'Uitzetten');
  sp = (await api('GET', '/specialists')).find((x) => x.agentId === seo.id);
  check('leerronde van Vindbaar › Uitzetten: uit, uit de lijst, weer onder "Staat uit"', sp?.learnOn === false && !(await planned()).some((p) => p.id === `learn:${seo.id}`) && (await offRow(`learning:${seo.id}`).count()) === 1, JSON.stringify({ learnOn: sp?.learnOn }));

  // ---------------------------------------------------------------- the main bot's check-in and overview
  await press(row('checkin'), 'Uitzetten');
  let ci = await api('GET', '/proactive/checkin');
  // Without the check-in the overview comes by itself again.
  check('check-in › Uitzetten: uit, onder "Staat uit"; het overzicht komt nu zelf', ci.enabled === false && (await offRow('checkin').count()) === 1 && (await planned()).some((p) => p.kind === 'briefing') && (await row('briefing').count()) === 1, JSON.stringify({ enabled: ci.enabled }));
  await press(row('briefing'), 'Uitzetten');
  let br = (await api('GET', '/proactive/settings')).settings.briefing;
  check('overzicht › Uitzetten: uit, uit de lijst, onder "Staat uit"', br === 'uit' && !(await planned()).some((p) => p.kind === 'briefing') && (await offRow('briefing').count()) === 1, br);
  await press(offRow('briefing'), 'Aanzetten');
  br = (await api('GET', '/proactive/settings')).settings.briefing;
  check('Staat uit › overzicht › Aanzetten: elke dag, en weer in de lijst', br === 'dag' && (await row('briefing').count()) === 1, br);
  await press(offRow('checkin'), 'Aanzetten');
  ci = await api('GET', '/proactive/checkin');
  check('Staat uit › check-in › Aanzetten: aan, en weer in de lijst', ci.enabled === true && (await planned()).some((p) => p.kind === 'checkin') && (await row('checkin').count()) === 1, JSON.stringify({ enabled: ci.enabled }));
  await shot('na-de-acties');

  // ---------------------------------------------------------------- all routines paused: the banner, Weer aanzetten
  const daily = await api('POST', '/routines', { name: 'Ochtendronde', prompt: 'Kijk wat er ligt.', agent_id: eerste.id, schedule: { kind: 'interval', everyMinutes: 480 } });
  await api('PUT', '/routines/settings', { paused: true });
  await page.waitForTimeout(600);
  const banner = list.getByRole('status').filter({ hasText: 'Alle routines staan op pauze' });
  await banner.waitFor({ timeout: 8000 }).catch(() => {});
  check('alle routines op pauze: de melding staat boven de lijst en geen routine start', (await banner.count()) === 1 && !(await planned()).some((p) => p.id === daily.id) && !(await row('routine', daily.name).count()));
  await press(banner, 'Weer aanzetten');
  const gs = await api('GET', '/routines/settings');
  check('melding › Weer aanzetten: routines staan weer aan, de routine staat weer in de lijst', gs.paused === false && (await planned()).some((p) => p.id === daily.id) && (await row('routine', daily.name).count()) === 1 && !(await banner.count()), JSON.stringify({ paused: gs.paused }));

  // ---------------------------------------------------------------- the same list on Taken › Automatisch › Werk
  await page.evaluate(() => (location.hash = '#/m/routines/werk'));
  await list.waitFor({ timeout: 15_000 });
  await until(async () => (await list.locator('li[data-planned]').count()) === (await planned()).length, 10_000);
  const onWerk = await shown();
  const now = await planned();
  check('Taken › Werk toont dezelfde lijst', onWerk.on.length === now.length && now.every((p) => onWerk.on.includes(`${p.kind}: ${p.title}`)), `${onWerk.on.length}/${now.length}`);
} catch (e) {
  check('de controle liep door tot het einde', false, e?.stack || String(e));
} finally {
  check('geen fouten in de console en geen geweigerde verzoeken', errors.length === 0, errors.slice(0, 5).join(' | '));
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
