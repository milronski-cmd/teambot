// The simpler layout of 0.4 (package A) in a real browser, with synthetic data and no AI:
//  - the sidebar: pinned bots always in view, the chat list (a status dot per bot), "Wacht op jou", Taken, Marktplaats
//    and Instellingen (0.4.2: Routines live in Taken, Geheugen in Instellingen; 0.4.5: Marktplaats its own place
//    again), no "Meer"; the usage meters (one ring per subscription) at the bottom with their popover;
//  - Instellingen: one list where every row opens one thing: AI-diensten, Telefoon, Taal en uiterlijk, Regels,
//    Back-ups, Vergrendeling; then "Van je bots": Bots, Teams, Geheugen, Kanalen, Apps, Bestanden; then "Meer
//    mogelijkheden" (was Geavanceerd), where every optional function is one row. No overview pages (Bots en teams, Apps
//    en bestanden) in between; old links still open the page that has it now; every page keeps its own link; the
//    rarely needed ones also one click from the page they belong to;
//  - "Geavanceerd tonen" (off by default) hides the expert panels without removing them;
//  - three streams: routine runs and bot-to-bot threads never take over the owner's own conversation;
//  - the phone: the tab bar from one list, a short "Meer", a way back to Instellingen; Ctrl+K finds everything;
//  - teams (A3): with one team nothing about teams; from the second team the switcher on top of the sidebar (mouse and
//    keyboard), the chat list and the task board follow it, the choice is kept per device, access per bot in the bot
//    editor, the switcher on the phone's Chats and Meer, and the main bot (C2's flag in GET /api/teams, simulated here)
//    first above all teams and opened on the desktop start.
// Usage: npm run build:ui && node --import tsx tests/e2e/layout.mjs   [TEAMBOT_E2E_SHOTS=<dir>]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('./server.mjs');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-layout-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const shots = process.env.TEAMBOT_E2E_SHOTS || '';
if (shots) fs.mkdirSync(shots, { recursive: true });
const shot = async (page, name) => shots && page.screenshot({ path: path.join(shots, `layout-${name}.png`) });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---- data: three bots (one pinned), the owner's chat, then later a routine run and a bot-to-bot thread
const prov = app.ctx.providers.create(owner.id, { kind: 'ollama', name: 'Ollama' });
const mk = (name, role) => app.ctx.store.createAgent(owner.id, { name, avatar: '🤖', role, provider_id: prov.id, model: 'llama3' });
const mila = mk('Mila', 'Assistent');
const sam = mk('Sam', 'Onderzoeker');
const noor = mk('Noor', 'Schrijver');
app.ctx.store.update('agents', mila.id, { pinned: true });
const say = (th, role, who, content) =>
  app.ctx.store.createMessage({ thread_id: th.id, role, author_type: role === 'user' ? 'user' : 'agent', author_id: role === 'user' ? owner.id : who.id, author_name: role === 'user' ? owner.name : who.name, content });
const chatMila = app.ctx.store.createThread({ user_id: owner.id, agent_id: mila.id, kind: 'chat' });
say(chatMila, 'user', null, 'Wat staat er vandaag op de planning?');
say(chatMila, 'assistant', mila, 'Eigen gesprek: de nieuwsbrief en de offerte.');
await sleep(30); // distinct timestamps: Sam's conversation is the newest own one
const chatSam = app.ctx.store.createThread({ user_id: owner.id, agent_id: sam.id, kind: 'chat' });
say(chatSam, 'assistant', sam, 'Eigen gesprek met Sam.');
await sleep(30);
const routine = app.ctx.store.createThread({ user_id: owner.id, agent_id: mila.id, kind: 'routine', title: 'Routine · Ochtendbriefing' });
say(routine, 'assistant', mila, 'ROUTINE-UITVOER: 12 mails samengevat.');
const dlg = app.ctx.store.createThread({ user_id: owner.id, agent_id: sam.id, kind: 'delegation', title: 'Mila → Sam' });
say(dlg, 'assistant', sam, 'BOT-OVERLEG: ik zoek het uit.');
const call = async (method, p, body) => {
  const r = await fetch(app.url + '/api' + p, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p} → ${r.status}: ${j.error}`);
  return j;
};
const until = async (fn, ms = 5000) => {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(100)) if (await fn()) return true;
  return false;
};
const setAdvanced = (on) => app.ctx.store.setSetting(owner.id, 'ui', { ...(app.ctx.store.settings(owner.id).ui || {}), advanced: on });

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
const watch = (p) => {
  p.on('pageerror', (e) => errors.push(e.message));
  p.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push(m.text()));
};
const go = async (p, h, wait = 600) => {
  await p.evaluate((x) => (location.hash = x), h);
  await p.waitForTimeout(wait);
};
const hash = (p) => p.evaluate(() => location.hash);
const overflow = (p) => p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
try {
  // ================================================================ desktop
  const desk = await browser.newContext({ viewport: { width: 1360, height: 880 } });
  const d = await desk.newPage();
  watch(d);
  await d.goto(`${app.url}/#token=${token}`);
  await d.waitForTimeout(1200);
  const side = d.getByRole('navigation', { name: 'Hoofdmenu' });

  // Sidebar: the fixed places in order, no Meer and no Teamwerk (0.4.5: Nu bezig and the Marktplaats are fixed places).
  const fixed = await side.locator('a[href^="#/"]').evaluateAll((as) => as.map((a) => a.textContent.trim()).filter((t) => ['Wacht op jou', 'Nu bezig', 'Taken', 'Marktplaats', 'Routines', 'Geheugen', 'Instellingen', 'Meer', 'Teamwerk'].includes(t)));
  check('zijbalk: Wacht op jou, Taken, Marktplaats, Instellingen (geen Routines, Geheugen of Meer; Nu bezig via Taken)', fixed.join(',') === 'Wacht op jou,Taken,Marktplaats,Instellingen', fixed.join(','));
  check('zijbalk: Taken gaat naar #/tasks', (await side.getByRole('link', { name: 'Taken', exact: true }).getAttribute('href')) === '#/tasks');
  check('zijbalk: Marktplaats gaat naar #/m/skills/', (await side.getByRole('link', { name: 'Marktplaats', exact: true }).getAttribute('href')) === '#/m/skills/');
  // Each row ends in ONE signal (count that waits, working, unread); calm shows nothing, but says data-status="idle".
  const dots = await side.locator('[data-status]').evaluateAll((ds) => ds.map((x) => x.getAttribute('data-status')));
  check('zijbalk: elke bot heeft een statusbolletje (rustig: grijs)', dots.length >= 3 && dots.every((x) => x === 'idle'), dots.join(', '));
  // The usage meters at the bottom: one ring per provider, each its own button (here the local Ollama); a click shows
  // that provider only, one sentence per line. The gauge next to the rings goes to the whole usage page.
  const meter = side.locator('button[data-usage-meter]');
  await meter.waitFor({ timeout: 8000 }).catch(() => {});
  check('zijbalk: gebruiksmeter onderaan', (await meter.count()) === 1);
  if (await meter.count()) {
    await meter.click();
    check('gebruiksmeter: de ring heeft een eigen naam (Ollama …)', /^Ollama/.test((await meter.getAttribute('aria-label')) || ''), (await meter.getAttribute('aria-label')) || '');
    check('gebruiksmeter: een aparte weg naar alle limieten', (await side.getByRole('link', { name: 'Gebruik en limieten' }).getAttribute('href')) === '#/m/usage/');
    const pop = d.getByRole('dialog', { name: 'Ollama' });
    const popText = (await pop.innerText().catch(() => '')).replace(/\s+/g, ' ');
    check('gebruiksmeter: popover met Ollama (lokaal), een zin en de weg naar alle limieten', /Ollama/.test(popText) && /Lokaal/.test(popText) && /Alle limieten en verbruik per bot/.test(popText), popText.slice(0, 200));
    await shot(d, 'gebruik');
    await d.keyboard.press('Escape');
    check('gebruiksmeter: Escape sluit, de focus staat weer op de knop', !(await pop.count()) && (await meter.evaluate((b) => b === document.activeElement)));
  }
  // One team ("Mijn team", made on the first look): nothing about teams in view.
  check('één team: geen teamkiezer', (await d.getByTestId('team-switcher').count()) === 0 && (await call('GET', '/teams')).length === 1);
  // Pinned bots: above the scrolling list (always in view), not again in the list.
  const pinnedOutside = await d.evaluate(() => {
    const g = document.querySelector('[role="group"][aria-label="Vastgezette bots"]');
    return !!g && !g.closest('.overflow-y-auto');
  });
  check('zijbalk: vastgezette bot staat boven de lijst, buiten het scrollgebied', pinnedOutside);
  const rows = await d.getByRole('list', { name: 'Bots en groepen' }).innerText();
  check('zijbalk: vastgezette bot staat niet nog eens in de lijst', !rows.includes('Mila'), rows.replace(/\n/g, ' | '));

  // Three streams: the start screen and the bot rows follow the owner's own conversation.
  // The newest thread is the bot-to-bot one, then the routine run; the newest own conversation is the one with Sam.
  check('start: opent je nieuwste eigen gesprek, niet de nieuwste routine-run of het overleg tussen bots', (await hash(d)) === `#/t/${chatSam.id}`, await hash(d));
  check('zijbalk: overleg tussen bots neemt de rij van Sam niet over', !rows.includes('BOT-OVERLEG') && rows.includes('Sam'), rows.replace(/\n/g, ' | '));
  const samHref = await d.getByRole('list', { name: 'Bots en groepen' }).getByRole('link', { name: /Sam/ }).getAttribute('href');
  check('zijbalk: de rij van Sam opent het eigen gesprek', samHref === `#/t/${chatSam.id}`, samHref || '');
  const tileHref = await d.getByRole('group', { name: 'Vastgezette bots' }).getByRole('link').first().getAttribute('href');
  check('zijbalk: de tegel van Mila opent het eigen gesprek, niet de routine', tileHref === `#/t/${chatMila.id}`, tileHref || '');
  await go(d, `#/t/${chatMila.id}`);
  await d.getByRole('button', { name: /Gesprekken met Mila/ }).click();
  const streams = await d.locator('section[aria-label]').evaluateAll((ss) => ss.map((s) => s.getAttribute('aria-label')));
  check('gesprekskiezer: eigen stroom voor automatische runs', streams.includes('Jouw gesprekken') && streams.includes('Automatische runs'), streams.join(', '));
  await shot(d, 'stromen');
  await d.keyboard.press('Escape');

  // Instellingen: one list, every row opens one thing; every other page keeps its own URL and opens inside
  // Instellingen, with the row it belongs to marked.
  await go(d, '#/more');
  check('desktop: de oude link #/more opent Instellingen', (await hash(d)) === '#/settings', await hash(d));
  const settingsNav = d.getByRole('navigation', { name: 'Instellingen' });
  // The entries of a row: "Meer" under its page, or the overview of a row without a page of its own.
  const moreNav = d.locator('#inhoud').getByRole('navigation', { name: /^(Meer|Onderdelen)$/ });
  // One small title in the list ("Van je bots", a group), no headings.
  const groups = await settingsNav.getByRole('heading').allInnerTexts();
  check('Instellingen: geen koppen, alleen het kleine kopje "Van je bots"', groups.length === 0 && (await settingsNav.getByRole('group', { name: 'Van je bots' }).count()) === 1, groups.join(', '));
  const rowNames = (await settingsNav.locator('a').allInnerTexts()).map((r) => r.trim());
  const ROWS = ['AI-diensten', 'Telefoon', 'Taal en uiterlijk', 'Regels', 'Back-ups', 'Vergrendeling', 'Bots', 'Teams', 'Geheugen', 'Kanalen', 'Apps', 'Bestanden', 'Meer mogelijkheden'];
  check('Instellingen: de rijen in deze volgorde, Meer mogelijkheden precies één keer en als laatste', rowNames.join(',') === ROWS.join(','), rowNames.join(', '));
  const botRows = (await settingsNav.getByRole('group', { name: 'Van je bots' }).locator('a').allInnerTexts()).map((r) => r.trim());
  check('Instellingen › Van je bots: Bots, Teams, Geheugen, Kanalen, Apps, Bestanden', botRows.join(',') === 'Bots,Teams,Geheugen,Kanalen,Apps,Bestanden', botRows.join(', '));
  // Gebruik and Limieten are under Meer mogelijkheden.
  check('Instellingen: één Back-ups, geen Gebruik, Limieten of Takenbord van groepen', rowNames.filter((r) => /back-ups/i.test(r)).length === 1 && !rowNames.some((r) => ['Gebruik', 'Limieten', 'Takenbord van groepen'].includes(r)), rowNames.join(', '));
  for (const [h, row] of [
    ['#/m/channels/', 'Kanalen'],
    ['#/m/mcp/', 'Apps'],
    ['#/m/memory/', 'Geheugen'],
    ['#/m/memory/dossiers', 'Geheugen'],
    ['#/m/folders/', 'Bestanden'],
    ['#/settings/backups-app', 'Meer mogelijkheden'],
    ['#/settings/usage-limits', 'Meer mogelijkheden'],
    ['#/m/browser/kluis', 'Meer mogelijkheden'],
    ['#/settings/free-models-gratis', 'Meer mogelijkheden'],
    ['#/settings/veilig', 'Back-ups'],
    ['#/settings/slot', 'Vergrendeling'],
    ['#/settings/regels', 'Regels'],
    ['#/settings/telefoon', 'Telefoon'],
    ['#/settings/teams', 'Teams'],
    ['#/agents', 'Bots'],
  ]) {
    await go(d, h);
    const cur = (await settingsNav.locator('a[aria-current="page"]').innerText().catch(() => '')).trim();
    const sideCur = await side.locator('a[aria-current="page"]').innerText().catch(() => '');
    check(`${h}: binnen Instellingen (${row} gemarkeerd, zijbalk op Instellingen)`, cur === row && sideCur === 'Instellingen', `${cur} / ${sideCur}`);
  }
  // 0.4.5: "Nu bezig" has its own place in the sidebar (no longer on the Geavanceerd page of Instellingen).
  await go(d, '#/m/usage/status');
  {
    const sideCur = await side.locator('a[aria-current="page"]').innerText().catch(() => '');
    check('#/m/usage/status: een eigen pagina (via Taken, niet binnen Instellingen)', !(await settingsNav.count()), `${sideCur} / instellingen: ${await settingsNav.count()}`);
  }
  await shot(d, 'instellingen-kanalen');
  // The Marktplaats (0.4.5): its own place, not inside Instellingen; its tabs and details keep the sidebar on it.
  for (const h of ['#/m/skills/', '#/m/skills/mine']) {
    await go(d, h);
    const sideCur = await side.locator('a[aria-current="page"]').innerText().catch(() => '');
    check(`${h}: eigen plek (zijbalk op Marktplaats, niet binnen Instellingen)`, sideCur === 'Marktplaats' && !(await settingsNav.count()), sideCur);
  }
  // Detail page under its list page; deep link with parameters keeps working.
  await go(d, '#/m/channels/nieuw');
  // "nieuw" opens the new-channel dialog over the page; while it is open the page behind is hidden from screen readers
  // (and inert), so read the settings list with includeHidden, then close the dialog.
  const dialogOpen = (await d.getByRole('dialog').count()) === 1;
  const behind = d.getByRole('navigation', { name: 'Instellingen', includeHidden: true });
  check('#/m/channels/nieuw: diepe link werkt binnen Instellingen', dialogOpen && (await behind.locator('a[aria-current="page"]').innerText().catch(() => '')).trim() === 'Kanalen', `dialoog open: ${dialogOpen}`);
  // Kanalen is a row of the list itself: the way back is the list next to it (its title goes to Instellingen).
  check('#/m/channels/nieuw: de lijst van Instellingen ernaast, met een weg terug naar Instellingen', (await d.locator('#inhoud a[href="#/m/channels/"][aria-current="page"]').count()) === 1 && (await d.locator('#inhoud a[href="#/settings"]').count()) >= 1);
  await d.keyboard.press('Escape');
  await d.getByRole('dialog').waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
  // The overviews Bots en teams and Apps en bestanden are gone: their old links open the row with that id (Bots, Apps),
  // and Teams is a row of its own, also with one team (the option is there).
  await go(d, '#/settings/bots');
  check('#/settings/bots (oude link naar Bots en teams): opent Bots; Teams is een eigen rij, ook met één team', (await hash(d)) === '#/agents' && (await settingsNav.getByRole('link', { name: 'Teams', exact: true }).getAttribute('href').catch(() => '')) === '#/settings/teams', await hash(d));
  await go(d, '#/settings/apps');
  check('#/settings/apps (oude link naar Apps en bestanden): opent Apps', (await hash(d)) === '#/m/mcp/', await hash(d));
  await go(d, '#/settings/general');
  // Taal en uiterlijk is short: name, language, theme, colour and the style of the bot figures; nothing hangs under it.
  const generalControls = await d.evaluate(() => [...document.querySelectorAll('#inhoud :is(input, [role=switch], [role=radiogroup], [role=combobox], select, textarea)')].filter((e) => !e.closest('nav[aria-label="Instellingen"]')).length);
  const generalParts = (await d.getByRole('textbox', { name: 'Je naam' }).count()) + (await d.getByRole('radiogroup', { name: 'Thema' }).count()) + (await d.getByRole('radiogroup', { name: 'Kleur' }).count());
  check('Taal en uiterlijk: naam, taal, thema, kleur en figuurtjes (hoogstens 5 instellingen), geen lijst "Meer"', generalControls <= 5 && generalParts === 3 && !(await moreNav.count()), `${generalControls} instellingen`);
  // "Alle routines pauzeren" left Algemeen: Meer mogelijkheden › Standaarden voor routines (and the Routines page).
  await go(d, '#/settings/routines-routines');
  check('Alle routines pauzeren: onder Meer mogelijkheden › Standaarden voor routines', await d.getByRole('switch', { name: 'Alle routines pauzeren' }).isVisible().catch(() => false));
  // The old link to the Geavanceerd page opens Meer mogelijkheden: the one place for everything optional, every
  // function one row.
  await go(d, '#/settings/advanced');
  check('#/settings/advanced (oude link): Meer mogelijkheden, met Netwerk en proxy en Deze computer', (await d.getByRole('heading', { level: 1 }).innerText()) === 'Meer mogelijkheden' && (await moreNav.getByRole('link', { name: /^Netwerk en proxy/ }).count()) === 1 && (await moreNav.getByRole('link', { name: /^Deze computer/ }).getAttribute('href')) === '#/settings/systeem');
  {
    const want = ['#/settings/cli-agents-cli', '#/settings/free-models-gratis', '#/m/browser/', '#/m/sites/', '#/m/rooms/organisatie', '#/settings/openbot-import-overstappen', '#/settings/kant-en-klaar', '#/settings/vanzelf'];
    const have = await moreNav.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
    const missing = want.filter((h) => have.filter((x) => x === h).length !== 1);
    check('Meer mogelijkheden: elke optionele functie één rij (AI-programma’s, Gratis modellen, Computers, Websites, Organisatie, Overstappen, Kant-en-klare teams, Wat start vanzelf)', !missing.length, missing.join(', '));
  }
  await go(d, '#/settings/systeem');
  check('Meer mogelijkheden › Deze computer: Geavanceerd tonen en pc wakker houden, met een pijl terug', (await d.getByRole('switch', { name: 'Geavanceerd tonen' }).isVisible()) && (await d.locator('#inhoud a[href="#/settings/meer"]').count()) >= 1);
  // Routines live in Taken: Taken stays marked on the routines pages; the old Groepen › Takenbord is the same board.
  await go(d, '#/m/routines/');
  check('#/m/routines/: zijbalk op Taken', (await side.locator('a[aria-current="page"]').innerText().catch(() => '')) === 'Taken');
  await go(d, '#/m/rooms/taken');
  check('#/m/rooms/taken (hetzelfde bord als Taken): zijbalk op Taken, niet binnen Instellingen', (await side.locator('a[aria-current="page"]').innerText().catch(() => '')) === 'Taken' && !(await settingsNav.count()));
  // The bot page: everything optional is a row under "Meer mogelijkheden"; an old link to a tab (?tab=rechten) opens it.
  await go(d, `#/agents/${sam.id}?tab=rechten`, 900);
  const noTeams = (await d.locator('[data-section="teams:teams"]').count()) === 0 && (await d.locator('[data-section="usage:cap"]').count()) === 1;
  check('één team: geen onderdeel Teams op de botpagina (Meer mogelijkheden open, met Onderdelen en skills)', noTeams && (await d.getByTestId('bot-advanced').locator('details').first().evaluate((x) => x.open).catch(() => false)) && (await d.locator('[data-section="core:can"]').count()) === 1);
  await go(d, '#/settings/geavanceerd');
  check('Meer mogelijkheden wijst naar Privacy en gegevens', (await moreNav.getByRole('link', { name: /^Privacy en gegevens/ }).getAttribute('href').catch(() => '')) === '#/settings/data');
  await go(d, '#/settings/veilig');
  check('Back-ups: een back-up maken op één korte pagina', (await d.getByRole('button', { name: 'Nu een back-up maken' }).count()) === 1);
  await go(d, '#/settings/slot');
  check('Vergrendeling: een eigen rij met Vergrendeling instellen', (await d.getByRole('button', { name: 'Vergrendeling instellen' }).count()) === 1);
  await go(d, '#/settings/backups');
  check('Back-ups (volledig, onder Meer mogelijkheden): met exporteren', (await d.getByRole('button', { name: 'Exporteren' }).count()) === 1);

  // Two clicks: every page from the sidebar (click 1), then a link or tab on that page (click 2). What hangs under a
  // row of Instellingen is one click further: Instellingen › the row › the page.
  const reached = new Set();
  const norm = (h) => h.replace(/^#\/?/, '').split('?')[0].replace(/\/$/, '');
  const level1 = await side.locator('a[href^="#/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')));
  for (const h of level1) reached.add(norm(h));
  for (const h of level1) {
    await go(d, h, 500);
    for (const l of await d.locator('main a[href^="#/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))) reached.add(norm(l));
  }
  const inTwo = new Set(reached);
  await go(d, '#/settings', 500);
  for (const row of await settingsNav.locator('a').evaluateAll((as) => as.map((a) => a.getAttribute('href')))) {
    await go(d, row, 500);
    for (const l of await d.locator('main a[href^="#/"]').evaluateAll((as) => as.map((a) => a.getAttribute('href')))) reached.add(norm(l));
  }
  // Geheugen's own pages are its tabs (one click on the page).
  await go(d, '#/m/memory/');
  const memTabs = await d.getByRole('tab').allInnerTexts();
  // Rarely needed (Te beoordelen, Geschiedenis, Opslag): behind "Meer opties" on the same page.
  await d.getByRole('button', { name: 'Meer opties' }).click();
  const memMore = await d.getByRole('menuitem').allInnerTexts();
  await d.keyboard.press('Escape');
  // The rows of Instellingen, Taken (with the routines) and Wacht op jou: two clicks at most. "Privacy en gegevens"
  // and the other optional pages are a row of Meer mogelijkheden (three clicks). Nu bezig is a line on the Taken board
  // while a bot works, else behind its "Meer opties" (checked below with the other rarely needed pages).
  const want2 = ['tasks', 'inbox', 'm/routines', 'settings/providers', 'settings/telefoon', 'settings/general', 'settings/regels', 'settings/veilig', 'settings/slot', 'agents', 'settings/teams', 'm/memory', 'm/channels', 'm/mcp', 'm/folders', 'settings/meer'];
  const missing2 = want2.filter((w) => !inTwo.has(w));
  check('de regels van Instellingen, Taken en Wacht op jou in hoogstens 2 klikken vanuit de zijbalk', !missing2.length, missing2.join(', ') || `${inTwo.size} bestemmingen`);
  // Groepschats (#/m/rooms/) are made from the "+" and live in the chat list: the page is a deep link and in Ctrl+K
  // (below). Abonnement and Gratis are two of the ways behind AI-diensten › Toevoegen (checked right after).
  const want3 = ['settings/data', 'm/sites', 'm/browser', 'm/voice/vergadering', 'm/skills', 'm/usage', 'settings/usage', 'settings/voice-spraak', 'settings/teams-teams', 'settings/mobile-telefoon', 'settings/websearch-zoeken', 'settings/security', 'settings/backups', 'settings/network-proxy', 'settings/notifications-meldingen', 'settings/cli-agents-cli', 'settings/free-models-gratis', 'm/rooms/organisatie', 'settings/openbot-import-overstappen', 'settings/kant-en-klaar', 'settings/vanzelf'];
  const missing3 = want3.filter((w) => !reached.has(w));
  check('de rest via zijn regel in Instellingen in hoogstens 3 klikken vanuit de zijbalk', !missing3.length, missing3.join(', ') || `${reached.size} bestemmingen`);
  check('Geheugen: Dossiers als tabblad, Opslag achter Meer opties', memTabs.includes('Dossiers') && memMore.some((t) => /^Opslag/.test(t.trim())), `tabbladen: ${memTabs.join(', ')}; meer: ${memMore.join(', ')}`);
  await go(d, '#/settings/providers', 500);
  await d.getByTestId('add-ai').click();
  const addDlg = d.getByRole('dialog', { name: 'AI toevoegen' });
  // One row per kind of AI: Abonnement, Sleutel, Gratis, Op deze computer.
  check('AI-diensten › Toevoegen: één rij per soort (Abonnement, Sleutel, Gratis, Op deze computer)', (await addDlg.locator('a[href="#/settings/cli-agents-cli"]').count()) === 1 && (await addDlg.getByRole('button', { name: /^Sleutel plakken/ }).count()) === 1 && (await addDlg.locator('a[href="#/settings/free-models-gratis"]').count()) === 1 && (await addDlg.locator('a[href="#/settings/ai-meer"]').count()) === 1);
  await d.keyboard.press('Escape');
  // Rarely needed pages: one click on the page they belong to. Limieten and
  // Back-ups beheren are the same as Gebruik en limieten and Back-ups; Concepten only matters when there are drafts
  // (then the phone settings say so).
  const onPage = async (h, name, role = 'any') => {
    await go(d, h, 700);
    const m = d.locator('#inhoud');
    if (role === 'heading') return (await m.getByRole('heading', { name, exact: true }).count()) > 0;
    if ((await m.getByRole('link', { name, exact: true }).count()) + (await m.getByRole('button', { name, exact: true }).count()) > 0) return true;
    // Or one click away behind the page's "Meer opties" (the "⋯" in its header).
    const more = m.getByRole('button', { name: 'Meer opties', exact: true }).first();
    if (!(await more.count())) return false;
    await more.click();
    const found = (await m.getByRole('menuitem', { name, exact: true }).count()) > 0;
    await d.keyboard.press('Escape');
    return found;
  };
  const fromParent = [
    ['Spraakgesprekken', '#/settings/voice-spraak', 'Eerdere spraakgesprekken'],
    ['Teammap', '#/m/folders/', 'Teammap instellen'],
    ['Prullenbak', '#/m/folders/', 'Prullenbak'],
    ['Kluis', '#/m/browser/', 'Kluis', 'heading'],
    // The limits of all routines are the first item of the "Meer opties" menu next to "Nieuwe routine".
    ['Routines-limieten', '#/m/routines/', 'Meer'],
    ['Gratis doorschakelen', '#/settings/free-models-gratis', 'Doorschakelen instellen'],
    ['Nu bezig', '#/tasks', 'Nu bezig'],
  ];
  const lost = [];
  for (const [what, h, name, role] of fromParent) if (!(await onPage(h, name, role))) lost.push(`${what} (${h})`);
  check('zelden nodig: één klik op de pagina waar het bij hoort', !lost.length, lost.join(', '));

  // Simple by default: expert panels hidden, not removed.
  await go(d, '#/m/teamdata/');
  const simpleTabs = await d.getByRole('tab').allInnerTexts();
  check('Teamwerk (eenvoudig): alleen Taken en Logboek', simpleTabs.map((t) => t.trim()).join(',') === 'Taken,Logboek', simpleTabs.join(', '));
  // From the sidebar's Taken (the one board) the rest of Teamwerk is one click away: the log, experts also the rest.
  await go(d, '#/tasks');
  const tw = (tab) => d.locator(`#inhoud a[href="#/m/teamdata/${tab}"]`).count();
  await d.locator('#inhoud').getByRole('button', { name: 'Meer opties', exact: true }).first().click();
  check('Taken (eenvoudig): het Logboek van Teamwerk in één klik, geen experttabbladen', (await tw('logboek')) === 1 && !(await tw('beslissingen')) && !(await tw('tabellen')));
  await go(d, '#/m/teamdata/tabellen');
  check('diepe link naar een verborgen tabblad (Tabellen) werkt', (await d.getByRole('tab', { name: /Tabellen/ }).getAttribute('aria-selected')) === 'true');
  await go(d, `#/t/${chatMila.id}`);
  if (!(await d.getByRole('button', { name: 'Zijpaneel sluiten' }).count())) await d.getByRole('button', { name: 'Zijpaneel' }).click();
  await d.waitForTimeout(300);
  // One purpose, so no tabs: the files of this conversation.
  const inspSimple = await d.getByRole('tab').allInnerTexts();
  check('zijpaneel (eenvoudig): alleen de bestanden van dit gesprek, geen Activiteit, Team, CLI of Details', (await d.getByRole('heading', { name: 'Bestanden van dit gesprek' }).count()) === 1 && !['Activiteit', 'Team', 'CLI', 'Details'].some((t) => inspSimple.includes(t)), inspSimple.join(', '));
  await go(d, '#/settings');
  check('Instellingen (eenvoudig): geen Netwerk en proxy', !(await settingsNav.getByRole('link', { name: 'Netwerk en proxy' }).count()));
  await settingsNav.getByLabel('Zoek een instelling').fill('proxy');
  await d.waitForTimeout(200);
  check('Instellingen: het zoekvak vindt ook verborgen onderdelen (proxy)', (await settingsNav.getByRole('link', { name: 'Netwerk en proxy' }).count()) === 1);
  await settingsNav.getByLabel('Zoek een instelling').fill('');
  // Switch on, everything shows; switch off again.
  await go(d, '#/settings/systeem');
  await d.getByRole('switch', { name: 'Geavanceerd tonen' }).click();
  await d.waitForTimeout(600);
  check('Geavanceerd tonen wordt bewaard', app.ctx.store.settings(owner.id).ui?.advanced === true);
  check('Geavanceerd tonen aan: de lijst van Instellingen blijft dezelfde (geen tweede laag)', !(await settingsNav.getByRole('link', { name: 'Netwerk en proxy' }).count()) && (await settingsNav.locator('a').allInnerTexts()).map((r) => r.trim()).join(',') === ROWS.join(','));
  await go(d, '#/m/teamdata/');
  const advTabs = await d.getByRole('tab').allInnerTexts();
  check('Teamwerk (geavanceerd): ook beslissingen, gebeurtenissen, experimenten en tabellen', advTabs.length === 6, advTabs.join(', '));
  await go(d, '#/tasks');
  await d.locator('#inhoud').getByRole('button', { name: 'Meer opties', exact: true }).first().click();
  check('Taken (geavanceerd): ook beslissingen, gebeurtenissen, experimenten en tabellen van Teamwerk in één klik', (await Promise.all(['logboek', 'beslissingen', 'gebeurtenissen', 'experimenten', 'tabellen'].map(tw))).every((n) => n === 1));
  await d.keyboard.press('Escape');
  await go(d, `#/t/${chatMila.id}`);
  if (!(await d.getByRole('button', { name: 'Zijpaneel sluiten' }).count())) await d.getByRole('button', { name: 'Zijpaneel' }).click();
  await d.waitForTimeout(300);
  const inspAdv = await d.getByRole('tab').allInnerTexts();
  check('zijpaneel (geavanceerd): ook Activiteit en Details', inspAdv.includes('Activiteit') && inspAdv.includes('Details'), inspAdv.join(', '));
  setAdvanced(false);
  app.ctx.events.emit(owner.id, 'settings.updated', app.ctx.store.settings(owner.id));
  await d.waitForTimeout(500);
  check('uitzetten (ook vanaf een ander apparaat): zijpaneel weer eenvoudig', !(await d.getByRole('tab', { name: 'Activiteit' }).count()));

  // Ctrl+K still finds everything.
  const palette = d.getByRole('dialog', { name: 'Zoeken en snelle acties' });
  for (const [q, want] of [
    ['Taken', '#/tasks'],
    ['Kanalen', '#/m/channels/'],
    ['proxy', '#/settings/network-proxy'],
    // "back-up": the row Back-ups of the list (make one, put one back); the full page (automatic, off-site, export)
    // is under Meer mogelijkheden and found by what it has.
    ['back-up', '#/settings/veilig'],
    ['exporteren', '#/settings/backups'],
    ['Organisatie', '#/m/rooms/organisatie'],
  ]) {
    await go(d, `#/t/${chatMila.id}`, 300);
    await d.keyboard.press('Control+k');
    await palette.waitFor({ timeout: 5000 });
    await d.keyboard.type(q);
    await d.waitForTimeout(450);
    await d.keyboard.press('Enter');
    await d.waitForTimeout(400);
    check(`Ctrl+K "${q}" opent ${want}`, (await hash(d)).startsWith(want), await hash(d));
  }

  // ---------------------------------------------------------------- two teams (A3)
  const mine = (await call('GET', '/teams'))[0];
  const shop = await call('POST', '/teams', { name: 'Webshop', color: '#10b981' });
  await call('PUT', `/teams/${shop.id}/bots/${noor.id}`);
  await go(d, `#/t/${chatMila.id}`, 300);
  const switcher = side.getByTestId('team-switcher').getByRole('button').first();
  const appeared = await until(async () => (await switcher.count()) === 1);
  check('tweede team: de teamkiezer verschijnt vanzelf, bovenaan de zijbalk', appeared && (await d.evaluate(() => !!document.querySelector('nav[aria-label="Hoofdmenu"]')?.firstElementChild?.querySelector('[data-testid="team-switcher"]'))));
  check('teamkiezer: begint op Alle teams (niets verborgen)', (await switcher.innerText()).includes('Alle teams') && (await d.getByRole('list', { name: 'Bots en groepen' }).innerText()).includes('Noor'));
  // Keyboard: Enter opens with the focus on the current choice, Escape closes and gives the focus back.
  await switcher.focus();
  await d.keyboard.press('Enter');
  const menu = d.getByRole('menu', { name: 'Teams' });
  await menu.waitFor({ timeout: 3000 });
  const items = (await menu.locator('[role^="menuitem"]').allInnerTexts()).map((x) => x.split('\n')[0].trim());
  check('teammenu: Alle teams, elk team, Nieuw team en Teams beheren', items.join(',') === 'Alle teams,Mijn team,Webshop,Nieuw team,Teams beheren', items.join(', '));
  check('teammenu met toetsenbord: focus op de huidige keuze', (await d.evaluate(() => document.activeElement?.getAttribute('aria-checked') === 'true' && document.activeElement.textContent.trim())) === 'Alle teams');
  await shot(d, 'teammenu');
  await d.keyboard.press('Escape');
  check('teammenu: Escape sluit en zet de focus terug op de kiezer', (await menu.count()) === 0 && (await switcher.evaluate((b) => b === document.activeElement)));
  await d.keyboard.press('ArrowDown');
  await menu.waitFor({ timeout: 3000 });
  await d.keyboard.press('ArrowDown');
  await d.keyboard.press('ArrowDown');
  await d.keyboard.press('Enter');
  await d.waitForTimeout(400);
  check('Webshop gekozen (pijltjes en Enter): naam in de kiezer', (await switcher.innerText()).includes('Webshop') && (await menu.count()) === 0, await switcher.innerText());
  const shopRows = await d.getByRole('list', { name: 'Bots en groepen' }).innerText();
  check('Webshop: de chatlijst toont alleen de bots van dit team', shopRows.includes('Noor') && !shopRows.includes('Sam') && !(await d.getByRole('group', { name: 'Vastgezette bots' }).count()), shopRows.replace(/\n/g, ' | '));
  await shot(d, 'team-webshop');
  // The task board follows the switcher; the owner's own tasks (no team) show in every team.
  await call('POST', '/rooms/tasks', { title: 'Taak van Mila', ownerType: 'agent', ownerId: mila.id });
  await call('POST', '/rooms/tasks', { title: 'Taak van Noor', ownerType: 'agent', ownerId: noor.id });
  await call('POST', '/rooms/tasks', { title: 'Taak voor mezelf' });
  await go(d, '#/tasks', 1000);
  const boardShop = await d.locator('#inhoud').innerText();
  check('Taken (Webshop): taken van het team en je eigen taken, niet die van een ander team', boardShop.includes('Taak van Noor') && boardShop.includes('Taak voor mezelf') && !boardShop.includes('Taak van Mila'));
  check('Taken: zegt welk team je ziet', (await d.getByTestId('team-filter-note').innerText()).includes('Webshop'));
  await shot(d, 'team-taken');
  await d.reload();
  await d.waitForTimeout(1500);
  check('de teamkeuze blijft na herladen (per apparaat)', (await switcher.innerText()).includes('Webshop') && !(await d.locator('#inhoud').innerText()).includes('Taak van Mila'));
  await d.getByRole('button', { name: 'Alle teams tonen' }).click();
  await d.waitForTimeout(400);
  check('Alle teams tonen: weer alle taken en Alle teams in de kiezer', (await d.locator('#inhoud').innerText()).includes('Taak van Mila') && (await switcher.innerText()).includes('Alle teams'));
  // Access per bot in the bot editor (saved with Opslaan), and a move to another home team.
  const openTeams = async () => {
    await d.evaluate(() => document.querySelectorAll('details').forEach((x) => (x.open = true)));
    const b = d.locator('[data-section="teams:teams"] h3 button');
    await b.waitFor({ timeout: 5000 });
    if ((await b.getAttribute('aria-expanded')) !== 'true') await b.click();
    await d.getByTestId('bot-teams').getByLabel('Thuisteam').waitFor({ timeout: 5000 });
  };
  const botTeams = (id) => call('GET', `/teams/bots/${id}`);
  await go(d, `#/agents/${noor.id}`, 900);
  await openTeams();
  // TeamBot's own dropdown (components/Listbox.tsx): open it and click the option (options carry data-value).
  const pick = async (box, value) => (await box.click(), await d.locator(`[role="listbox"] [role="option"][data-value="${value}"]`).click());
  await pick(d.getByRole('combobox', { name: 'Toegang van Noor tot Mijn team' }), 'direct');
  check('bot-editor: een gewijzigde toegang is "Niet opgeslagen: Teams"', (await d.getByRole('status').filter({ hasText: 'Niet opgeslagen' }).innerText().catch(() => '')).includes('Teams'));
  await shot(d, 'bot-teams');
  await d.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
  check('bot-editor: Noor stuurt Mijn team nu aan (opgeslagen)', await until(async () => (await botTeams(noor.id)).teams.find((x) => x.teamId === mine.id)?.reach === 'direct'));
  await go(d, `#/agents/${sam.id}`, 900);
  await openTeams();
  await pick(d.getByTestId('bot-teams').getByLabel('Thuisteam'), shop.id);
  check('bot-editor: verhuizen zegt wat er bij opslaan gebeurt', (await d.getByTestId('bot-teams').innerText()).includes('Bij opslaan verhuist Sam naar Webshop'));
  await d.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
  check('bot-editor: Sam is verhuisd naar Webshop', await until(async () => (await botTeams(sam.id)).homeTeamId === shop.id));
  // A new bot with Alle teams chosen says under the questions which team it lands in, and lets you pick another
  // right there (praktijktest 0.4.4: it said nothing; choosing was only under Meer opties).
  await go(d, '#/agents/new', 1200);
  const nbt = d.getByTestId('new-bot-team');
  await nbt.waitFor({ timeout: 5000 }).catch(() => {});
  check('nieuwe bot (Alle teams): zegt in welk team hij komt', (await nbt.innerText().catch(() => '')).includes('Komt in team Mijn team.'), await nbt.innerText().catch(() => '(geen regel)'));
  await nbt.getByRole('button', { name: 'Ander team' }).click();
  await pick(nbt.getByLabel('Team'), shop.id);
  check('nieuwe bot: een ander team kiezen zegt het meteen', (await nbt.innerText()).includes('Komt in team Webshop.'));
  await shot(d, 'nieuwe-bot-team');
  await desk.close();

  // ---------------------------------------------------------------- the main bot (C2's flag in GET /api/teams, simulated)
  const mainCtx = await browser.newContext({ viewport: { width: 1360, height: 880 } });
  const mp = await mainCtx.newPage();
  watch(mp);
  await mp.route('**/api/teams', async (route) => {
    const r = await route.fetch();
    const j = await r.json();
    for (const t of j) for (const b of t.bots) b.main = b.id === noor.id;
    await route.fulfill({ response: r, json: j });
  });
  // The desktop start asks GET /api/teams/main (C2): make Noor the main bot for real, as the owner would.
  await call('PUT', `/teams/main/${noor.id}`);
  await mp.goto(`${app.url}/#token=${token}`);
  const noorThread = () => app.ctx.store.all("SELECT id FROM threads WHERE agent_id = ? AND kind = 'chat'", noor.id)[0]?.id;
  check('hoofdbot: de start op de pc opent de hoofdbot', await until(async () => (await hash(mp)) === `#/t/${noorThread()}`, 8000), await hash(mp));
  const mainSide = mp.getByRole('navigation', { name: 'Hoofdmenu' });
  // Choose Mijn team (Noor's home is Webshop): the main bot stays first, above all teams.
  await mainSide.getByTestId('team-switcher').getByRole('button').first().click();
  await mp.getByRole('menuitemradio', { name: /Mijn team/ }).click();
  await mp.waitForTimeout(400);
  const tiles = await mainSide.getByRole('group', { name: 'Vastgezette bots' }).getByRole('link').allInnerTexts();
  check('hoofdbot: eerste tegel, ook met een ander team gekozen', !!tiles[0]?.includes('Noor') && tiles[0].includes('Hoofdbot') && tiles.some((x) => x.includes('Mila')), tiles.join(' | ').replace(/\n/g, ' '));
  await shot(mp, 'hoofdbot');
  await mainCtx.close();

  // ================================================================ phone
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await phone.newPage();
  watch(p);
  await p.goto(`${app.url}/#token=${token}`);
  await p.waitForTimeout(1000);
  await go(p, '#/');
  const tabs = await p.getByRole('navigation', { name: 'Hoofdmenu' }).getByRole('link').allInnerTexts();
  check('telefoon: tabbladen Chats, Wacht op jou, Meer', tabs.map((t) => t.trim()).join(',') === 'Chats,Wacht op jou,Meer', tabs.join(', '));
  await go(p, '#/more');
  const more = await p.getByRole('navigation', { name: 'Meer' }).getByRole('link').allInnerTexts();
  check('telefoon: Meer is kort (Taken, Routines, Geheugen, Marktplaats, Instellingen)', ['Taken', 'Routines', 'Geheugen', 'Marktplaats', 'Instellingen'].every((t) => more.includes(t)) && more.length <= 8, more.join(', '));
  check('telefoon: Alles stoppen altijd in Meer', (await p.getByRole('button', { name: /Alles stoppen/ }).count()) === 1);
  check('telefoon: de teamkiezer staat in Meer', (await p.getByTestId('team-switcher').count()) === 1);
  await go(p, '#/');
  check('telefoon: de teamkiezer staat boven de chats', (await p.getByTestId('team-switcher').count()) === 1);
  await p.getByTestId('team-switcher').getByRole('button').first().click();
  await p.getByRole('menuitemradio', { name: /Webshop/ }).click();
  await p.waitForTimeout(400);
  const phoneRows = await p.locator('#inhoud').innerText();
  check('telefoon: Webshop kiezen filtert de chats', phoneRows.includes('Noor') && !phoneRows.includes('Mila'), phoneRows.replace(/\n/g, ' | ').slice(0, 200));
  await shot(p, 'telefoon-team');
  await go(p, '#/more');
  await shot(p, 'telefoon-meer');
  await go(p, '#/m/channels/');
  // Kanalen is a row of the list: back goes to Instellingen. A page under a row (the Kluis, under Meer mogelijkheden)
  // goes back to that row.
  check('telefoon: de pagina van een regel heeft een weg terug naar Instellingen', (await p.locator('#inhoud').getByRole('link', { name: 'Instellingen', exact: true }).first().getAttribute('href').catch(() => '')) === '#/settings');
  await go(p, '#/m/browser/kluis');
  check('telefoon: een pagina onder een regel heeft een weg terug naar die regel', (await p.locator('#inhoud').getByRole('link', { name: 'Meer mogelijkheden', exact: true }).first().getAttribute('href').catch(() => '')) === '#/settings/meer');
  await go(p, '#/m/channels/');
  check('telefoon: tabblad Meer actief binnen Instellingen', (await p.getByRole('navigation', { name: 'Hoofdmenu' }).locator('a[aria-current="page"]').innerText()).trim() === 'Meer');
  const wide = [];
  for (const w of [390, 320]) {
    await p.setViewportSize({ width: w, height: 720 });
    for (const h of ['#/', '#/more', '#/settings', '#/m/channels/', '#/m/browser/kluis', '#/tasks', '#/settings/advanced', '#/agents', `#/agents/${noor.id}`]) {
      await go(p, h, 400);
      if ((await overflow(p)) > 1) wide.push(`${h} @${w}`);
    }
  }
  check('telefoon: geen horizontaal scrollen (390 en 320 px)', !wide.length, wide.join(', '));
  await phone.close();

  // ================================================================ narrow desktop (iPad portrait width)
  const mid = await browser.newContext({ viewport: { width: 834, height: 1100 } });
  const m = await mid.newPage();
  watch(m);
  await m.goto(`${app.url}/#token=${token}`);
  await m.waitForTimeout(900);
  const midWide = [];
  for (const h of ['#/settings', '#/settings/general', '#/m/rooms/', '#/m/channels/', '#/agents', '#/tasks']) {
    await go(m, h, 400);
    if ((await overflow(m)) > 1) midWide.push(h);
  }
  check('834 px: geen horizontaal scrollen', !midWide.length, midWide.join(', '));
  await mid.close();
} catch (e) {
  check('onverwachte fout', false, e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
check('geen fouten in de console', !errors.length, errors.slice(0, 5).join(' | '));
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
