// Acceptance 0.4, part 1 (package T): the owner in the real built app, from an empty install.
//  A  a first bot in three questions and an answer; the five fixed places, no Meer; every former Meer page from
//     Instellingen in two clicks; "Geavanceerd tonen" hides and shows the expert parts; the chat never blocks.
//  B  a second team made in Instellingen › Teams, a bot moved there, a folder and a key per team; then bot Ada of team A
//     actively tries to reach team B (file, write, key, delegate) without access, with Meekijken and with Aansturen.
//  E  the usage bar with the recorded output of fake Claude Code and Codex CLIs: colours, resets, a live jump after new
//     numbers, a free-source dot, estimate and shared pot, the notifications, and usage per bot.
// Ids in brackets are the items of docs/ACCEPTANCE_0.4.md.
// Usage: npm run build:ui && node --import tsx tests/e2e/accept-04-core.mjs   [TEAMBOT_E2E_SHOTS=<dir>] [TEAMBOT_E2E_PORT]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { check, confirmDialog, go, hashOf, isolate, lastToolResult, launchBrowser, mainText, openPage, overflow, part, rmrf, seeMessage, send, shot, sleep, startTeamBot, summary, testEngine, until } from './accept-04-lib.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_CLAUDE = path.join(here, '..', 'fixtures', 'cli-agents-fake-claude.mjs');
const FAKE_CODEX = path.join(here, '..', 'fixtures', 'cli-agents-fake-codex.mjs');

const browser = await launchBrowser();
const home = isolate('tb-accept-core');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-accept-core-'));
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-accept-core-mappen-'));
const ai = testEngine();
const tb = await startTeamBot({ dir, ai });
console.log(`TeamBot op ${tb.url} (lege datamap ${dir})`);
const errors = [];
const SECRET_B = 'Klantenlijst van Webshop B: alleen voor team B';

let page;
try {
  page = await openPage(browser, tb, { errors });

  // ============================================================================================ A: the first bot
  await part('A-01', 'nieuwkomer: eerste bot in drie vragen en een antwoord', async () => {
    await tb.api('PUT', '/memory/settings', { extractor: 'heuristic' }); // the learner never asks the test engine
    const empty = await Promise.all(['/agents', '/rooms', '/skills', '/routines', '/providers', '/teams'].map(async (p) => [p, (await tb.api('GET', p)).length]));
    check('A-08', 'nieuwe installatie is leeg (geen bots, groepen, skills, routines, AI-koppelingen of teams)', empty.every(([, n]) => n === 0), empty.map(([p, n]) => `${p} ${n}`).join(', '));
    await page.getByText('Welkom bij TeamBot').waitFor({ timeout: 20_000 });
    const t0 = Date.now();
    // 0.4.2: three plain ways in; the AI found on this PC has the one main button ("Testmodel gebruiken").
    await page.locator('#inhoud').getByRole('button', { name: 'Testmodel gebruiken' }).click();
    // 0.4.5: a ready first bot right away; the three questions are optional behind "Aanpassen".
    const ready = page.getByTestId('first-bot-ready');
    await ready.waitFor({ timeout: 20_000 });
    await ready.getByRole('button', { name: 'Aanpassen' }).click();
    const q = page.getByTestId('first-bot-edit');
    await q.waitFor({ timeout: 15_000 });
    const asked = await q.locator('label[data-i18n="label"], legend').allInnerTexts();
    check('A-01', 'nieuwe bot vraagt precies drie dingen: naam, wat hij doet, welk model', asked.join(' | ') === 'Hoe heet je bot? | Wat doet hij? | Welk model gebruikt hij?', asked.join(' | '));
    const engine = q.getByRole('radio', { name: /Testmodel/ });
    check('A-01', 'het model dat op deze pc gevonden is, is voorgesteld', await until(async () => (await engine.count()) && (await engine.isChecked()), 10_000));
    await q.getByLabel('Hoe heet je bot?').fill('Ada');
    await q.getByLabel('Wat doet hij?').fill('Helpt met de fietsenwinkel: voorraad, klanten en offertes.');
    await q.getByRole('button', { name: 'Opslaan' }).click();
    await ready.getByRole('heading', { name: 'Ada staat klaar' }).waitFor({ timeout: 15_000 });
    await ready.getByRole('button', { name: 'Begin met praten' }).click();
    await page.getByTestId('first-bot-phone').getByRole('button', { name: 'Later' }).click();
    await page.waitForURL(/#\/t\//, { timeout: 15_000 });
    await page.waitForTimeout(300);
    ai.to('Ada', { text: 'Hallo! Ik ben Ada en ik help je met de fietsenwinkel.' });
    await send(page, 'Hoi Ada, wie ben jij?');
    const answered = await seeMessage(page, 'Ik ben Ada en ik help je met de fietsenwinkel.');
    const secs = (Date.now() - t0) / 1000;
    check('A-01', 'eerste antwoord in de chat, binnen 2 minuten na het eerste scherm', answered && secs < 120, `${secs.toFixed(1)} s`);
    const ada = tb.bot('Ada');
    check('A-01', 'de bot kent zijn taak (staat in zijn systeemprompt)', !!ai.last('Ada')?.system.includes('Helpt met de fietsenwinkel'));
    check('A-08', 'de eerste bot maakt vanzelf het eerste team (Mijn team)', (await tb.api('GET', '/teams')).map((t) => t.name).join() === 'Mijn team');
    await shot(page, 'a01-eerste-antwoord');
    // Setup for the walls later: Ada may use files and team tools without asking (what the owner can set in the editor).
    await tb.api('PATCH', `/agents/${ada.id}`, { access_mode: 'auto', tool_groups: [...new Set([...(ada.tool_groups || []), 'files', 'team'])] });
  });

  await part('A-11', 'de chat blokkeert nooit tijdens een run', async () => {
    // A slow answer: while Ada works, the owner can type and send the next message.
    ai.to('Ada', async () => (await sleep(2500), { text: 'Klaar met de voorraadlijst.' }), { text: 'En de tweede vraag is ook beantwoord.' });
    await send(page, 'Maak een voorraadlijst.');
    await page.waitForTimeout(500);
    const box = page.getByRole('textbox', { name: 'Bericht' });
    const enabled = await box.isEnabled();
    await send(page, 'En hoeveel fietsen staan er in de winkel?');
    const second = await seeMessage(page, 'En hoeveel fietsen staan er in de winkel?', 5000);
    check('A-11', 'tijdens een lopende beurt kan de eigenaar typen en versturen', enabled && second);
    check('A-11', 'beide vragen krijgen antwoord', (await seeMessage(page, 'Klaar met de voorraadlijst.')) && (await seeMessage(page, 'En de tweede vraag is ook beantwoord.')));
    await tb.idle();
  });

  // ============================================================================================ A: the layout
  // TeamBot 0.4.2 ("simpeler"): the sidebar keeps Wacht op jou, Taken and Instellingen; Routines live in Taken,
  // Geheugen in Instellingen. 0.4.5: the Marktplaats is a fixed place again (shell/nav.tsx).
  await part('A-06', 'zijbalk: Wacht op jou, Taken, Marktplaats en Instellingen, geen Meer', async () => {
    const side = page.getByRole('navigation', { name: 'Hoofdmenu' });
    const fixed = await side.locator('a[href^="#/"]').evaluateAll((as) => as.map((a) => a.textContent.trim()).filter((t) => ['Wacht op jou', 'Taken', 'Routines', 'Geheugen', 'Marktplaats', 'Instellingen', 'Meer', 'Teamwerk', 'Groepen'].includes(t)));
    check('A-06', 'zijbalk: Wacht op jou, Taken, Marktplaats, Instellingen', fixed.join(',') === 'Wacht op jou,Taken,Marktplaats,Instellingen', fixed.join(', '));
    await go(page, '#/more');
    check('A-06', 'de oude link #/more opent Instellingen', (await hashOf(page)) === '#/settings', await hashOf(page));
  });

  await part('A-02', 'elke vroegere Meer-pagina vanuit de zijbalk: de regels in twee klikken, de rest onder zijn regel in drie', async () => {
    const side = page.getByRole('navigation', { name: 'Hoofdmenu' });
    const nav = page.getByRole('navigation', { name: 'Instellingen' });
    // What "Meer" held in 0.3 (ui/src/pages/More.tsx before 0.4): now under Instellingen, each with its own address.
    // Since 12 Nov the list has a row per thing (Bots, Geheugen, Kanalen, Apps, Bestanden under "Van je bots") and one
    // row "Meer mogelijkheden" with every optional function (lib/palette.ts SETTINGS_ROWS).
    const underSettings = [
      ['#/agents', 'Alle bots', 'Bots'],
      ['#/m/mcp/', 'Apps', 'Apps'],
      ['#/m/memory/', 'Geheugen', 'Geheugen'],
      ['#/m/channels/', 'Kanalen', 'Kanalen'],
      ['#/m/browser/', 'Computers', 'Meer mogelijkheden'],
      ['#/m/sites/', 'Websites', 'Meer mogelijkheden'],
      ['#/m/voice/vergadering', 'Vergadernotities', 'Meer mogelijkheden'],
      ['#/m/usage/', 'Gebruik en limieten', 'Meer mogelijkheden'],
      ['#/m/folders/', 'Bestanden', 'Bestanden'],
      ['#/settings/data', 'Privacy en gegevens', 'Meer mogelijkheden'],
    ];
    const bad = [];
    for (const [href, title, rowName] of underSettings) {
      await go(page, '#/', 300); // start from the chats
      await side.getByRole('link', { name: 'Instellingen', exact: true }).click(); // click 1
      await nav.waitFor({ timeout: 5000 });
      // Instellingen is one flat list of rows; what hangs under a row is on that row's page (one click more).
      let row = nav.locator(`a[href="${href}"]`);
      if (!(await row.count())) {
        await nav.getByRole('link', { name: rowName, exact: true }).click(); // click 2
        await page.waitForTimeout(500);
        row = page.locator(`#inhoud nav[aria-label="Meer"] a[href="${href}"], #inhoud nav[aria-label="Onderdelen"] a[href="${href}"]`);
      }
      if (!(await row.count())) {
        bad.push(`${title}: geen regel in Instellingen of onder ${rowName}`);
        continue;
      }
      await row.first().click(); // click 2 or 3
      await page.waitForTimeout(600);
      const h = await hashOf(page);
      const text = await mainText(page);
      if (h !== href) bad.push(`${title}: kwam op ${h}`);
      else if (/Pagina niet gevonden/.test(text)) bad.push(`${title}: pagina niet gevonden`);
      else if ((await side.locator('a[aria-current="page"]').innerText().catch(() => '')) !== 'Instellingen') bad.push(`${title}: zijbalk niet op Instellingen`);
    }
    check('A-02', `${underSettings.length} vroegere Meer-pagina's: Instellingen (klik 1), zo nodig de regel waar het bij hoort, en de regel openen de pagina`, !bad.length, bad.join(' | '));
    // What has a fixed place: one click.
    const fixed = [
      ['Taken', '#/tasks', 'Taken'],
      ['Wacht op jou', '#/inbox', 'Wacht op jou'],
    ];
    const bad2 = [];
    for (const [link, href, heading] of fixed) {
      await go(page, '#/', 300);
      await side.getByRole('link', { name: link, exact: true }).click();
      await page.waitForTimeout(600);
      const h = await hashOf(page);
      if (!h.startsWith(href)) bad2.push(`${link}: ${h}`);
      else if (!(await page.getByRole('heading', { name: heading, exact: true }).count())) bad2.push(`${link}: kop "${heading}" ontbreekt`);
    }
    check('A-02', 'Taken en Wacht op jou: één klik in de zijbalk', !bad2.length, bad2.join(' | '));
    // Routines: Taken (click 1), Routines (click 2).
    await go(page, '#/', 300);
    await side.getByRole('link', { name: 'Taken', exact: true }).click();
    await page.waitForTimeout(600);
    await page.locator('#inhoud').getByRole('link', { name: 'Automatisch', exact: true }).click();
    await page.waitForTimeout(600);
    check('A-02', 'Routines: Taken (klik 1) en Routines (klik 2)', (await hashOf(page)).startsWith('#/m/routines/') && (await page.getByRole('heading', { name: 'Automatisch', exact: true }).count()) > 0, await hashOf(page));
    // "Nu bezig" (a former Meer page): since 0.4.2 on the Taken page, so also two clicks.
    await go(page, '#/', 300);
    await side.getByRole('link', { name: 'Taken', exact: true }).click();
    await page.waitForTimeout(600);
    // Behind the "⋯" of the board (a line on the board itself while a bot works).
    await page.locator('#inhoud').getByRole('button', { name: 'Meer opties', exact: true }).first().click();
    await page.locator('#inhoud').getByRole('menuitem', { name: 'Nu bezig' }).first().click();
    await page.waitForTimeout(600);
    check('A-02', 'Nu bezig: Taken (klik 1) en Nu bezig (klik 2)', (await hashOf(page)).startsWith('#/m/usage/status'), await hashOf(page));
    // "Mijn skills": one more click from Marktplaats (Instellingen, Geavanceerd, Marktplaats, Mijn skills; 0.4.4).
    await page.getByRole('navigation', { name: 'Hoofdmenu' }).locator('a[href="#/m/skills/"]').first().click();
    await page.waitForTimeout(700);
    const mine = page.locator('#inhoud').getByRole('link', { name: 'Geïnstalleerd' }).or(page.locator('#inhoud').getByRole('button', { name: 'Geïnstalleerd' })).first();
    if (await mine.count()) await mine.click();
    await page.waitForTimeout(700);
    check('A-02', 'Mijn skills: Instellingen, Marktplaats en Mijn skills', (await hashOf(page)).startsWith('#/m/skills/mine'), await hashOf(page));
    await go(page, '#/settings');
    await nav.getByLabel('Zoek een instelling').fill('telegram');
    await page.waitForTimeout(250);
    check('A-02', 'Instellingen: het zoekvak vindt een pagina (telegram → Kanalen)', (await nav.locator('a[href="#/m/channels/"]').count()) === 1);
    await nav.getByLabel('Zoek een instelling').fill('');
    await shot(page, 'a02-instellingen');
  });

  await part('A-07', 'eenvoudig is de standaard; Geavanceerd tonen aan en weer uit', async () => {
    const nav = page.getByRole('navigation', { name: 'Instellingen' });
    const adaThread = tb.app.ctx.store.all("SELECT id FROM threads WHERE agent_id = ? AND kind = 'chat'", tb.bot('Ada').id)[0]?.id;
    const tabsOf = async (h) => (await go(page, h), (await page.getByRole('tab').allInnerTexts()).map((t) => t.trim()));
    const inspector = async () => {
      await go(page, `#/t/${adaThread}`);
      if (!(await page.getByRole('button', { name: 'Zijpaneel sluiten' }).count())) await page.getByRole('button', { name: 'Zijpaneel' }).click().catch(() => {});
      await page.waitForTimeout(300);
      const tabs = (await page.getByRole('tab').allInnerTexts()).map((t) => t.trim());
      // Simple: one purpose, no tabs; the panel is then called "Bestanden van dit gesprek".
      return tabs.length ? tabs : (await page.getByRole('heading', { name: 'Bestanden van dit gesprek' }).count()) ? ['Bestanden'] : [];
    };
    check('A-07', 'Geavanceerd tonen staat standaard uit', !tb.app.ctx.store.settings(tb.owner.id).ui?.advanced);
    const simple = await tabsOf('#/m/teamdata/');
    check('A-07', 'Teamwerk (eenvoudig): alleen Taken en Logboek', simple.join(',') === 'Taken,Logboek', simple.join(', '));
    // From "Taken" in the sidebar (the one board, #/tasks) the owner must still reach the Logboek (and, with Geavanceerd
    // tonen, the expert tabs) within one more click: a tab or a link on the board.
    const fromBoard = async () => {
      await go(page, '#/', 300);
      await page.getByRole('navigation', { name: 'Hoofdmenu' }).getByRole('link', { name: 'Taken', exact: true }).click();
      await page.waitForTimeout(700);
      await page.locator('#inhoud').getByRole('button', { name: 'Meer opties', exact: true }).first().click();
      const tabs = (await page.getByRole('tab').allInnerTexts()).map((t) => t.trim());
      const links = await page.locator('#inhoud a[href^="#/m/teamdata/"]').evaluateAll((as) => as.map((a) => a.textContent.trim()));
      return [...tabs, ...links];
    };
    const reach = await fromBoard();
    check('A-02', 'Teamwerk: vanuit Taken (zijbalk) is het Logboek in één klik te bereiken (2 klikken totaal)', reach.some((x) => /^Logboek/.test(x)), `op #/tasks: ${reach.join(', ') || 'geen tabbladen of links naar Teamwerk'}`);
    const inspSimple = await inspector();
    check('A-07', 'zijpaneel (eenvoudig): geen Activiteit en Details', inspSimple.includes('Bestanden') && !inspSimple.includes('Activiteit') && !inspSimple.includes('Details'), inspSimple.join(', '));
    // Since 12 Nov there is no hidden second layer in Instellingen: every optional function is one row under "Meer
    // mogelijkheden" for everyone (lib/palette.ts ADVANCED_ONLY is empty), Netwerk en proxy too.
    const proxyRow = async () => (await go(page, '#/settings/meer'), page.locator('#inhoud').getByRole('navigation', { name: 'Onderdelen' }).locator('a[href="#/settings/network-proxy"]').count());
    check('A-07', 'eenvoudig: Netwerk en proxy staat als regel onder Instellingen › Meer mogelijkheden', (await proxyRow()) === 1);
    // On, with the switch in Instellingen › Meer mogelijkheden › Deze computer (the old link #/settings/advanced opens
    // Meer mogelijkheden).
    await go(page, '#/settings/systeem');
    const sw = page.getByRole('switch', { name: 'Geavanceerd tonen' });
    await sw.click();
    await until(() => tb.app.ctx.store.settings(tb.owner.id).ui?.advanced === true, 5000);
    const adv = await tabsOf('#/m/teamdata/');
    check('A-07', 'aan: Teamwerk toont ook Beslissingen, Gebeurtenissen, Experimenten en Tabellen', adv.length === 6 && ['Beslissingen', 'Gebeurtenissen', 'Experimenten', 'Tabellen'].every((x) => adv.some((t) => t.startsWith(x))), adv.join(', '));
    const reachAdv = await fromBoard();
    check('A-07', 'aan: vanuit Taken (zijbalk) zijn Beslissingen, Gebeurtenissen, Experimenten en Tabellen te bereiken', ['Beslissingen', 'Gebeurtenissen', 'Experimenten', 'Tabellen'].every((x) => reachAdv.some((t) => t.startsWith(x))), `op #/tasks: ${reachAdv.join(', ') || 'geen tabbladen of links naar Teamwerk'}`);
    const inspAdv = await inspector();
    check('A-07', 'aan: zijpaneel toont Activiteit en Details', inspAdv.includes('Activiteit') && inspAdv.includes('Details'), inspAdv.join(', '));
    check('A-07', 'aan: Netwerk en proxy blijft één regel onder Meer mogelijkheden', (await proxyRow()) === 1);
    await shot(page, 'a07-geavanceerd-aan');
    // Off again: hidden again, never removed (a deep link still works).
    await go(page, '#/settings/systeem');
    await page.getByRole('switch', { name: 'Geavanceerd tonen' }).click();
    await until(() => tb.app.ctx.store.settings(tb.owner.id).ui?.advanced === false, 5000);
    const off = await tabsOf('#/m/teamdata/');
    check('A-07', 'weer uit: Teamwerk weer eenvoudig', off.join(',') === 'Taken,Logboek', off.join(', '));
    const inspOff = await inspector();
    check('A-07', 'weer uit: zijpaneel weer zonder Activiteit en Details', !inspOff.includes('Activiteit') && !inspOff.includes('Details'), inspOff.join(', '));
    await go(page, '#/m/teamdata/tabellen');
    check('A-07', 'uit: een diepe link naar een verborgen tabblad (Tabellen) werkt nog', (await page.getByRole('tab', { name: /Tabellen/ }).getAttribute('aria-selected').catch(() => null)) === 'true');
  });

  // ============================================================================================ B: two teams with walls
  const fa = path.join(work, 'Fietsen A');
  const fb = path.join(work, 'Webshop B');
  fs.mkdirSync(fa, { recursive: true });
  fs.mkdirSync(fb, { recursive: true });
  fs.writeFileSync(path.join(fa, 'voorraad.md'), 'Voorraad van Fietsen A: 12 stadsfietsen\n');
  fs.writeFileSync(path.join(fb, 'klanten.md'), SECRET_B + '\n');
  const ids = {};

  const teamsPage = async (team) => {
    await go(page, '#/', 300); // a fresh visit, as the owner coming back from AI-providers
    await go(page, '#/settings/teams-teams', 900);
    if (team) {
      const pick = page.getByRole('group', { name: 'Kies een team' }).getByRole('button', { name: new RegExp(`^${team}`) });
      if (await pick.count()) await pick.click();
      await page.waitForTimeout(400);
    }
    // What is rarely set (business profile, team folder, access, keys) sits in folds: open them all.
    const shut = page.locator('#inhoud details.tb-fold:not([open]) > summary');
    for (let i = 0; i < 12 && (await shut.count()); i++) await shut.first().click();
    await page.waitForTimeout(300);
  };
  const setFolder = async (folder) => {
    const map = page.getByLabel('Map', { exact: true });
    await map.fill(folder);
    await page.waitForTimeout(500);
    await map.locator("xpath=ancestor::*[.//button[normalize-space()='Opslaan']][1]").getByRole('button', { name: 'Opslaan', exact: true }).click();
    await page.waitForTimeout(700);
  };

  await part('B-01', 'twee teams, elk met een bot, map en sleutel, ingericht in Instellingen › Teams', async () => {
    // Since 12 Nov the first bot is the main bot by itself, and the main bot directs every team by default
    // (server/modules/teams/service.ts access()). The walls below are about a normal bot of team A, so the owner first
    // hands the main-bot role to a bot of its own ("Baas", its page › Meer mogelijkheden › Hoofdbot): Ada is then a
    // normal bot of Fietsen A, as in this scenario.
    check('B-01', 'de eerste bot (Ada) is vanzelf de hoofdbot', tb.app.ctx.services.teams.mainOf(tb.owner.id) === tb.bot('Ada')?.id);
    await go(page, '#/agents/new');
    const nq = page.getByTestId('new-bot-questions');
    await nq.waitFor({ timeout: 10_000 });
    await nq.getByLabel('Naam', { exact: true }).fill('Baas');
    await nq.getByLabel(/^Rol/).fill('Verdeelt het werk over de teams.');
    await page.getByRole('button', { name: 'Bot aanmaken' }).click();
    await page.waitForURL(/#\/t\//, { timeout: 15_000 });
    await go(page, `#/agents/${tb.bot('Baas').id}?meer=1`, 1200);
    await page.locator('#inhoud').getByRole('button', { name: /^Hoofdbot/ }).first().click();
    await page.getByRole('button', { name: 'Baas hoofdbot maken' }).click();
    await confirmDialog(page, 'Hoofdbot maken');
    check('B-01', 'een andere bot hoofdbot maken op zijn pagina (Meer mogelijkheden › Hoofdbot): Ada is daarna een gewone bot', await until(() => tb.app.ctx.services.teams.mainOf(tb.owner.id) === tb.bot('Baas')?.id, 5000));
    await teamsPage();
    check('B-10', 'één team: geen teamkeuze, geen toegang per bot en geen sleutelscope in beeld', !(await page.getByRole('group', { name: 'Kies een team' }).count()) && !(await page.getByText('Toegang voor bots van andere teams').count()));
    // Team A: name and business profile.
    await page.getByLabel('Naam', { exact: true }).first().fill('Fietsen A');
    await page.getByLabel('Naam van het bedrijf').fill('Fietsen A BV');
    await page.getByLabel('Wat het bedrijf doet').fill('Verkoopt en repareert stadsfietsen.');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
    await page.waitForTimeout(600);
    await setFolder(fa);
    // Team B.
    await page.getByRole('button', { name: 'Nieuw team' }).click();
    const dlg = page.getByRole('dialog', { name: 'Nieuw team' });
    await dlg.getByLabel('Naam').fill('Webshop B');
    await dlg.getByRole('button', { name: 'Team maken' }).click();
    await page.getByRole('group', { name: 'Kies een team' }).waitFor({ timeout: 8000 });
    check('B-10', 'vanaf het tweede team: teamkeuze met beide teams', (await page.getByRole('group', { name: 'Kies een team' }).getByRole('button').allInnerTexts()).filter((x) => /Fietsen A|Webshop B/.test(x)).length === 2);
    await teamsPage('Webshop B');
    check('B-01', 'een nieuw team begint leeg', (await page.getByText('Dit team heeft nog geen bots.').count()) === 1);
    await page.getByLabel('Regels', { exact: true }).fill('Noem nooit prijzen zonder overleg.');
    await page.getByLabel('Naam van het bedrijf').fill('Webshop B');
    await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
    await page.waitForTimeout(600);
    await setFolder(fb);
    // A bot for team B: made with the three questions, then moved to Webshop B.
    await go(page, '#/agents/new');
    const q = page.getByTestId('new-bot-questions');
    await q.waitFor({ timeout: 10_000 });
    await q.getByLabel('Naam', { exact: true }).fill('Bo');
    await q.getByLabel(/^Rol/).fill('Beheert de webshop van team B.');
    await page.getByRole('button', { name: 'Bot aanmaken' }).click();
    await page.waitForURL(/#\/t\//, { timeout: 15_000 });
    await teamsPage('Webshop B');
    await page.getByLabel('Bot naar dit team verplaatsen').selectOption({ label: 'Bo (nu in Fietsen A)' });
    await page.getByRole('button', { name: 'Naar dit team verplaatsen' }).click();
    await page.waitForTimeout(800);
    // Bo becomes the team lead of Webshop B.
    await page.getByLabel('Teamleider').selectOption({ label: 'Bo' });
    await page.getByRole('button', { name: 'Opslaan', exact: true }).first().click();
    await page.waitForTimeout(800);
    const teams = await tb.api('GET', '/teams');
    const A = teams.find((t) => t.name === 'Fietsen A');
    const B = teams.find((t) => t.name === 'Webshop B');
    ids.A = A?.id;
    ids.B = B?.id;
    check('B-01', 'Fietsen A met Ada (en de hoofdbot Baas) en een eigen map, Webshop B met Bo (teamleider) en een eigen map', A?.bots.map((b) => b.name).sort().join() === 'Ada,Baas' && B?.bots.map((b) => b.name).join() === 'Bo' && B?.leadName === 'Bo' && A?.folder?.path === fa && B?.folder?.path === fb, JSON.stringify(teams.map((t) => ({ n: t.name, bots: t.bots.map((b) => b.name), lead: t.leadName, folder: t.folder?.path }))));
    check('B-10', 'Webshop B toont Ada bij "Toegang voor bots van andere teams", standaard Geen toegang', (await page.getByLabel('Toegang van Ada tot Webshop B').inputValue().catch(() => '')) === 'none');
    // Keys: "Sleutel A" only for Fietsen A, "Sleutel B" only for Webshop B (the found Testmodel stays for all teams).
    const kA = await tb.api('POST', '/providers', { kind: 'mock', name: 'Sleutel A' });
    const kB = await tb.api('POST', '/providers', { kind: 'mock', name: 'Sleutel B' });
    ids.kA = kA.id;
    ids.kB = kB.id;
    await teamsPage('Webshop B');
    await page.getByLabel('Welke teams Sleutel A mogen gebruiken').selectOption({ label: 'Alleen Fietsen A' });
    await page.waitForTimeout(400);
    await page.getByLabel('Welke teams Sleutel B mogen gebruiken').selectOption({ label: 'Alleen Webshop B' });
    await page.waitForTimeout(600);
    const keys = await tb.api('GET', '/teams/keys');
    const scope = (n) => keys.find((k) => k.name === n)?.teamId ?? null;
    check('B-01', 'sleutels: Sleutel A alleen Fietsen A, Sleutel B alleen Webshop B, Testmodel voor alle teams', scope('Sleutel A') === ids.A && scope('Sleutel B') === ids.B && keys.some((k) => k.kind === 'provider' && k.teamId === null), JSON.stringify(keys.map((k) => [k.name, k.teamId])));
    check('B-01', 'de UI zegt "alleen dit team" bij Sleutel B', await page.getByText('alleen dit team').first().isVisible().catch(() => false));
    await shot(page, 'b01-teams');
  });

  const ada = () => tb.bot('Ada');
  const adaThread = async () => {
    const th = tb.app.ctx.store.all("SELECT id FROM threads WHERE agent_id = ? AND kind = 'chat' ORDER BY created_at", ada().id)[0];
    await go(page, `#/t/${th.id}`, 900);
    return th.id;
  };
  /** Ada tries one tool and tells what TeamBot answered (the real tool result). */
  const adaTries = async (ask, call, extra = []) => {
    ai.to('Ada', { toolCalls: [call] }, ...extra, (req) => ({ text: `Uitkomst: ${lastToolResult(req).slice(0, 400)}` }));
    await send(page, ask);
    await tb.idle();
    await page.waitForTimeout(600);
    const msgs = tb.app.ctx.store.messages((await tb.app.ctx.store.all("SELECT id FROM threads WHERE agent_id = ? AND kind = 'chat' ORDER BY created_at", ada().id))[0].id);
    const tool = [...msgs].reverse().find((m) => m.role === 'tool');
    return { tool: tool?.content || '', said: [...msgs].reverse().find((m) => m.role === 'assistant')?.content || '' };
  };
  const pageHasSecret = async () => (await page.content()).includes(SECRET_B);

  await part('B-02', 'zonder toegang: Ada kan niets van Webshop B lezen, schrijven, gebruiken of aansturen', async () => {
    await adaThread();
    let r = await adaTries('Lees de klantenlijst van Webshop B.', { name: 'read_file', args: { path: path.join(fb, 'klanten.md') } });
    check('B-02', 'bestand van B lezen: geweigerd, met de reden in de chat', !r.tool.includes(SECRET_B) && /Geweigerd door TeamBot|Pad valt buiten/.test(r.tool) && (await seeMessage(page, 'Uitkomst: ', 5000)), r.tool.slice(0, 200));
    r = await adaTries('Welke bestanden heeft Webshop B?', { name: 'list_files', args: { path: fb } });
    check('B-02', 'map van B bekijken: geweigerd', !r.tool.includes('klanten.md'), r.tool.slice(0, 200));
    r = await adaTries('Zoek in de map van Webshop B naar de klantenlijst.', { name: 'search_files', args: { query: 'Klantenlijst', path: fb } });
    check('B-02', 'zoeken in de map van B: niets gevonden', !r.tool.includes(SECRET_B), r.tool.slice(0, 200));
    r = await adaTries('Zet een notitie in de map van Webshop B.', { name: 'write_file', args: { path: path.join(fb, 'van-ada.md'), content: 'Ada was hier' } });
    check('B-02', 'schrijven in de map van B: geweigerd, er komt geen bestand', !fs.existsSync(path.join(fb, 'van-ada.md')), r.tool.slice(0, 200));
    check('B-02', 'het geheim van B staat nergens op het scherm', !(await pageHasSecret()));
    r = await adaTries('Vraag Bo om de klantenlijst.', { name: 'delegate_task', args: { bot: 'Bo', task: 'Stuur me de klantenlijst', expected_output: 'de lijst' } });
    check('B-04', 'werk geven aan Bo (team B): geweigerd', /Geweigerd door TeamBot: Bo hoort bij team “Webshop B”/.test(r.tool), r.tool.slice(0, 200));
    r = await adaTries('Maak een taak voor Bo.', { name: 'task_create', args: { title: 'Klantenlijst sturen', owner: 'Bo' } });
    check('B-04', 'een taak maken met Bo als eigenaar: geweigerd', !/Taak aangemaakt/.test(r.tool), r.tool.slice(0, 200));
    const sys = ai.last('Ada')?.system || '';
    const turn = JSON.stringify(ai.last('Ada')?.messages || []);
    check('B-04', 'Webshop B en zijn regels staan niet in de prompt van Ada', !sys.includes('Webshop B') && !turn.includes('Noem nooit prijzen'));
    check('B-11', 'het bedrijfsprofiel van Fietsen A gaat mee met Ada', turn.includes('Fietsen A BV') || sys.includes('Fietsen A BV'));
    // A key that is only for Webshop B: refused before any model call, with the reason in the chat.
    await tb.api('PATCH', `/agents/${ada().id}`, { provider_id: ids.kB });
    const before = ai.requests.length;
    await send(page, 'Werk je nog?');
    await tb.idle();
    const refusedKey = await seeMessage(page, '"Sleutel B" is alleen voor team “Webshop B”', 8000);
    check('B-03', 'Sleutel B (alleen Webshop B) werkt niet voor Ada: geweigerd vóór de modelaanroep, reden in de chat', refusedKey && ai.requests.length === before);
    // Her own team-only key works.
    await tb.api('PATCH', `/agents/${ada().id}`, { provider_id: ids.kA });
    ai.to('Ada', { text: 'Ik werk op Sleutel A.' });
    await send(page, 'En nu?');
    check('B-03', 'Sleutel A (alleen Fietsen A) werkt voor Ada', await seeMessage(page, 'Ik werk op Sleutel A.'));
    await shot(page, 'b02-muren');
  });

  await part('B-08', 'de gedeelde sleutel werkt in beide teams; een sleutel van A niet voor B', async () => {
    const bo = tb.bot('Bo');
    const boTh = tb.app.ctx.store.all("SELECT id FROM threads WHERE agent_id = ? AND kind = 'chat'", bo.id)[0];
    await go(page, `#/t/${boTh.id}`, 900);
    ai.to('Bo', { text: 'Bo hier, op de gedeelde sleutel.' });
    await send(page, 'Hoi Bo');
    check('B-08', 'Bo (team B) werkt op Testmodel, de sleutel voor alle teams (Ada ook, zie A-01)', await seeMessage(page, 'Bo hier, op de gedeelde sleutel.'));
    await tb.api('PATCH', `/agents/${bo.id}`, { provider_id: ids.kA });
    await send(page, 'En op Sleutel A?');
    await tb.idle();
    check('B-03', 'Sleutel A (alleen Fietsen A) werkt niet voor Bo', await seeMessage(page, '"Sleutel A" is alleen voor team “Fietsen A”', 8000));
    await tb.api('PATCH', `/agents/${bo.id}`, { provider_id: ids.kB });
    ai.to('Bo', { text: 'Bo op Sleutel B.' });
    await send(page, 'En op Sleutel B?');
    check('B-03', 'Sleutel B werkt wel voor Bo (zijn eigen team)', await seeMessage(page, 'Bo op Sleutel B.'));
  });

  await part('B-06', 'Meekijken: Ada leest de map van Webshop B, maar schrijft niets en geeft geen werk', async () => {
    await teamsPage('Webshop B');
    await page.getByLabel('Toegang van Ada tot Webshop B').selectOption('read');
    check('B-06', 'Meekijken gekozen in de UI en bewaard', await until(() => tb.app.ctx.services.teams.access(ada().id, ids.B) === 'read', 5000));
    await adaThread();
    let r = await adaTries('Lees de klantenlijst van Webshop B.', { name: 'read_file', args: { path: path.join(fb, 'klanten.md') } });
    check('B-06', 'met Meekijken: de klantenlijst van B lezen lukt', r.tool.includes(SECRET_B), r.tool.slice(0, 200));
    r = await adaTries('Zet een notitie in de map van Webshop B.', { name: 'write_file', args: { path: path.join(fb, 'van-ada.md'), content: 'Ada was hier' } });
    check('B-06', 'met Meekijken: schrijven in de map van B geweigerd ("alleen meekijken")', !fs.existsSync(path.join(fb, 'van-ada.md')) && /alleen-lezen|alleen meekijken/.test(r.tool), r.tool.slice(0, 200));
    r = await adaTries('Vraag Bo om de klantenlijst.', { name: 'delegate_task', args: { bot: 'Bo', task: 'Stuur me de klantenlijst', expected_output: 'de lijst' } });
    check('B-06', 'met Meekijken: werk geven aan Bo nog steeds geweigerd', /Geweigerd door TeamBot/.test(r.tool), r.tool.slice(0, 200));
    const sys = ai.last('Ada')?.system || '';
    check('B-06', 'met Meekijken: Webshop B staat nu in de prompt van Ada (als team om mee te kijken)', sys.includes('Webshop B'));
  });

  await part('B-07', 'Aansturen: Ada geeft Bo, de teamleider van Webshop B, een taak', async () => {
    await teamsPage('Webshop B');
    await page.getByLabel('Toegang van Ada tot Webshop B').selectOption('direct');
    check('B-07', 'Aansturen gekozen in de UI en bewaard', await until(() => tb.app.ctx.services.teams.access(ada().id, ids.B) === 'direct', 5000));
    await adaThread();
    ai.to('Bo', { text: 'Gedaan: de nieuwsbrief van Webshop B staat klaar.' });
    let r = await adaTries('Laat Bo de nieuwsbrief van Webshop B klaarzetten.', { name: 'delegate_task', args: { bot: 'Bo', task: 'Zet de nieuwsbrief klaar', expected_output: 'één zin', wait: true } });
    const boRuns = tb.app.ctx.store.all('SELECT id FROM runs WHERE agent_id = ?', tb.bot('Bo').id).length;
    check('B-07', 'met Aansturen: delegeren aan Bo lukt en Bo doet het werk', !/Geweigerd/.test(r.tool) && /nieuwsbrief/.test(r.tool) && boRuns >= 3, r.tool.slice(0, 200));
    r = await adaTries('Zet een taak voor Bo op het bord.', { name: 'task_create', args: { title: 'Kortingscodes nalopen', owner: 'Bo' } });
    check('B-07', 'met Aansturen: een taak voor Bo op het takenbord', /Taak aangemaakt/.test(r.tool), r.tool.slice(0, 200));
    await go(page, '#/tasks', 1200);
    check('B-07', 'het takenbord toont de taak voor Bo', await page.getByText('Kortingscodes nalopen').first().isVisible().catch(() => false));
    await adaThread();
    r = await adaTries('Schrijf toch een notitie in de map van Webshop B.', { name: 'write_file', args: { path: path.join(fb, 'van-ada.md'), content: 'Ada was hier' } }).catch((e) => ({ tool: String(e) }));
    check('B-07', 'met Aansturen: zelf schrijven in de map van B blijft geweigerd', !fs.existsSync(path.join(fb, 'van-ada.md')), r.tool.slice(0, 200));
    // The side panel never claims Ada made or changed a file in team B (every write there was refused).
    if (!(await page.getByRole('button', { name: 'Zijpaneel sluiten' }).count())) await page.getByRole('button', { name: 'Zijpaneel' }).click().catch(() => {});
    await page.getByRole('tab', { name: 'Bestanden' }).click().catch(() => {});
    await page.waitForTimeout(1200);
    const made = await page.locator('section[aria-label="Gemaakt of gewijzigd door Ada"]').innerText().catch(() => '');
    check('B-02', 'zijpaneel: een geweigerd schrijven staat niet bij "Gemaakt of gewijzigd door Ada"', !/van-ada\.md/.test(made), made.replace(/\s+/g, ' ').slice(0, 200));
    await shot(page, 'b07-aansturen');
  });

  // ============================================================================================ E: the usage bar
  await part('E-01', 'de gebruiksbalk met de cijfers van (nep-)Claude Code en Codex', async () => {
    const claude = await tb.api('POST', '/providers', { kind: 'claude-code', name: 'Claude Code', config: { path: FAKE_CLAUDE } });
    const codex = await tb.api('POST', '/providers', { kind: 'codex-cli', name: 'Codex', config: { path: FAKE_CODEX } });
    ids.claude = claude.id;
    await page.reload();
    await page.waitForTimeout(1500);
    // The limits live on "Gebruik en limieten" (card "Limieten nu"); the sidebar shows the same numbers as rings.
    await go(page, '#/m/usage/', 1200);
    const bar = page.locator('#inhoud');
    await bar.getByText('Limieten nu').first().waitFor({ timeout: 10_000 });
    // The owner asks for fresh numbers (the CLIs answer /usage and account/rateLimits/read without a model call).
    await bar.getByRole('button', { name: /Vernieuwen/ }).first().click().catch(() => {});
    const seen = await until(async () => {
      const t = (await bar.innerText()).replace(/\s+/g, ' ');
      return /Claude/.test(t) && /Nog 14%/.test(t) && /Codex/.test(t) && /Nog 3%/.test(t) ? t : false;
    }, 25_000, 300);
    check('E-01', 'Limieten nu toont Claude (5 uur 12% en week 86% gebruikt: nog 88% en 14%) en Codex (nog 58% en 3%) uit de CLI-uitvoer', !!seen && /Nog 88%/.test(seen) && /Nog 58%/.test(seen), seen || (await bar.innerText()).replace(/\s+/g, ' ').slice(0, 300));
    const sentences = await bar.locator('li li > span[class*="text-"]').evaluateAll((els) => els.map((e) => `${e.textContent.trim()}|${e.className}`).filter((x) => /^(Nog|Op)/.test(x)));
    const tone = (left) => sentences.find((r) => r.startsWith(left))?.split('|')[1] || '';
    check('E-01', 'kleuren: nog 88% rustig, nog 14% oranje (bijna op)', /text-fg/.test(tone('Nog 88%')) && /text-warn/.test(tone('Nog 14%')), `${tone('Nog 88%')} / ${tone('Nog 14%')}`);
    const resets = sentences.map((x) => x.split('|')[0]);
    check('E-01', 'elke regel heeft een resettijd', resets.filter((r) => /weer vol o[mp] /.test(r)).length >= 4, resets.join(' | '));
    // The explanation is one click away ("Meer informatie" under the limits).
    await bar.getByRole('button', { name: 'Meer informatie' }).first().click().catch(() => {});
    await page.waitForTimeout(300);
    const text = (await bar.innerText()).replace(/\s+/g, ' ');
    check('E-04', 'de gedeelde pot is uitgelegd (Claude en ChatGPT buiten TeamBot)', /Gedeelde pot: je eigen gebruik van Claude en ChatGPT buiten TeamBot/.test(text), text.slice(0, 300));
    await shot(page, 'e01-gebruiksbalk');
  });

  await part('E-03', 'de balk verspringt na nieuw gebruik, rood bij de limiet, en meldt het', async () => {
    const { parseClaudeRateLimitEvent } = await import('../../server/modules/usage/parse.ts');
    const svc = tb.app.ctx.services.usage;
    const bar = page.locator('#inhoud');
    // First let the reads that "Vernieuwen" started finish (their answer would replace the numbers reported below).
    await until(async () => (await tb.api('GET', '/usage/bar')).engines.every((e) => !e.reading), 30_000, 300);
    await sleep(1000);
    const now = Date.now();
    // A turn reports the 5-hour window at 47%: the bar jumps without a reload (the plan: within a minute).
    const t0 = Date.now();
    svc.report(ids.claude, parseClaudeRateLimitEvent({ rate_limit_info: { status: 'allowed', resetsAt: Math.floor(now / 1000) + 3 * 3600, rateLimitType: 'five_hour', utilization: 0.47 } }, now));
    const jumped = await until(async () => /Nog 53%/.test(await bar.innerText()), 60_000, 200);
    check('E-03', 'nieuw gebruik: 12% → 47% gebruikt (nog 53%) op de pagina zonder herladen', !!jumped, `${((Date.now() - t0) / 1000).toFixed(1)} s`);
    // The Opus week is full: red, "op", with the reset; one notification.
    svc.report(ids.claude, parseClaudeRateLimitEvent({ rate_limit_info: { status: 'rejected', resetsAt: Math.floor(now / 1000) + 2 * 86400, rateLimitType: 'seven_day_opus', utilization: 1 } }, now));
    const red = await until(async () => (await bar.locator('li li > span.text-danger').filter({ hasText: /^Op, weer vol/ }).count()) > 0, 15_000, 200);
    check('E-01', 'limiet bereikt: rood met de resettijd', !!red, (await bar.innerText()).replace(/\s+/g, ' ').slice(0, 300));
    // A free source reported by another module (the free chain): a dot with "op tot …", an estimate.
    svc.reportSource({ id: 'groq', label: 'Groq', status: 'limited', resetsAt: now + 2 * 3600_000, estimated: true, note: '1.000 verzoeken per dag per model; telt TeamBot zelf.', userId: tb.owner.id, kind: 'free' });
    const dot = await until(async () => /Groq.{0,40}Op, weer vol/.test((await bar.innerText()).replace(/\s+/g, ' ')), 10_000, 200);
    check('E-06', 'gratis bron met een limiet als eigen regel: "Groq … Op, weer vol om …"', !!dot, ((await bar.innerText()).replace(/\s+/g, ' ').match(/.{0,80}Groq.{0,120}/) || ['Groq staat niet op de pagina'])[0]);
    const text = (await bar.innerText()).replace(/\s+/g, ' ');
    check('E-04', 'schatting uitgelegd ("≈ is een schatting" bij de regel, "Schatting:" onder Meer informatie)', (await bar.locator('[title*="is een schatting"]').count()) > 0 && /Schatting: de aanbieder geeft daar geen exact cijfer/.test(text), text.slice(0, 300));
    await go(page, '#/m/notifications/', 1200);
    const notes = await mainText(page);
    check('E-07', 'melding vóór de grens (86% van je limiet) en bij de limiet', /86% van je limiet gebruikt/.test(notes) && /gebruikslimiet bereikt/.test(notes), notes.slice(0, 400));
    await shot(page, 'e07-meldingen');
  });

  await part('E-05', 'klik op de balk: verbruik per bot, vandaag en deze week', async () => {
    await go(page, '#/', 600);
    await page.getByRole('navigation', { name: 'Hoofdmenu' }).getByRole('link', { name: 'Gebruik en limieten' }).click();
    await page.waitForTimeout(1200);
    check('E-05', 'de klik opent Gebruik en limieten', (await hashOf(page)).startsWith('#/m/usage'), await hashOf(page));
    const text = await mainText(page);
    check('E-05', 'Verbruik per bot toont Ada en Bo, vandaag en deze week', /Verbruik per bot/.test(text) && /Ada/.test(text) && /Bo\b/.test(text) && /Vandaag/i.test(text) && /week/i.test(text), text.slice(0, 500));
    await shot(page, 'e05-verbruik');
    // Phone: the same bar on top of Meer.
    const ph = await openPage(browser, tb, { width: 390, height: 844, phone: true, errors });
    await ph.waitForTimeout(800);
    await go(ph, '#/more', 1200);
    const phoneBar = (await ph.locator('#inhoud').innerText().catch(() => '')).replace(/\s+/g, ' ');
    check('E-01', 'telefoon: de balk staat bovenaan Meer, zonder opzij schuiven', /Gebruik/.test(phoneBar) && /Claude/.test(phoneBar) && (await overflow(ph)) <= 1, phoneBar.slice(0, 200));
    await ph.context().close();
  });
} catch (e) {
  check('suite', 'onverwachte fout', false, e?.stack || e?.message);
} finally {
  await browser.close().catch(() => {});
  await tb.close().catch(() => {});
  rmrf(dir, home, work);
}
check('suite', 'geen fouten in de console van de app', !errors.length, errors.slice(0, 6).join(' | '));
process.exit(summary('ACCEPTATIE 0.4 — deel 1 (A, B, E)'));
