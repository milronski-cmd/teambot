// End-to-end smoke test of the real UI (release gate).
// Starts TeamBot (desktop mode, temp data) + a fake OpenAI-compatible model server, then drives Edge/Chrome with
// Playwright: welcome screen → connect provider → create bot from template → chat with streaming → approve a write in
// the chat → check the file exists → phone width has no horizontal overflow → no console errors.
// Usage: npm run build:ui && npm run e2e   (TEAMBOT_E2E_BROWSER=chrome|msedge, default msedge on Windows)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('./server.mjs'); // run with: node --import tsx tests/e2e/smoke.mjs

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};

// ---- fake OpenAI-compatible model: first turn asks to write a file, second turn answers ----
let turn = 0;
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'nep-model' }] }));
    const j = JSON.parse(body || '{}');
    const hasToolResult = (j.messages || []).some((m) => m.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (!hasToolResult) {
      turn++;
      send({ id: 'c1', choices: [{ index: 0, delta: { role: 'assistant', content: 'Ik schrijf het bestand. ' } }] });
      send({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'write_file', arguments: JSON.stringify({ path: 'e2e.txt', content: 'hallo e2e' }) } }] } }] });
      send({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }], usage: { prompt_tokens: 10, completion_tokens: 5 } });
    } else {
      for (const w of ['Klaar: ', 'e2e.txt ', 'staat ', 'in ', 'je ', 'werkmap.']) send({ id: 'c2', choices: [{ index: 0, delta: { content: w } }] });
      send({ id: 'c2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 12, completion_tokens: 6 } });
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}/v1`;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
step(`TeamBot op ${app.url}, nep-model op ${fakeUrl}`);

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED/.test(m.text()) && errors.push(m.text()));
  await page.goto(`${app.url}/#token=${token}`);
  await page.getByText('Welkom bij TeamBot').waitFor({ timeout: 15000 });
  step('onboarding (welkomstscherm) zichtbaar');
  // Privacy in one click from the welcome screen (§15 "Privacy en gegevens"); elsewhere it is the first row of
  // Instellingen › Gegevens en privacy (the unnamed lock next to Instellingen in the sidebar is gone).
  if ((await page.getByRole('link', { name: 'Privacy en gegevens' }).count()) < 1) fail('welkom: link "Privacy en gegevens" ontbreekt op het welkomstscherm');
  if (await page.getByRole('navigation', { name: 'Hoofdmenu' }).getByRole('link', { name: 'Privacy en gegevens' }).count()) fail('zijbalk: het losse slotje staat er nog');

  // Connect the fake model as an OpenAI-compatible provider via the settings UI: AI-diensten (empty: the ways in) ›
  // "Op deze computer" (a model on this pc, or another service) › search › the row's one action "Koppelen".
  await page.goto(`${app.url}/#/settings/providers`);
  await page.getByRole('main').getByRole('link', { name: /^Op deze computer/ }).click();
  await page.waitForURL(/#\/settings\/ai-meer/, { timeout: 5000 }).catch(() => fail('AI toevoegen: "Op deze computer" opent Lokale modellen en andere diensten niet'));
  await page.getByLabel('Zoek een dienst', { exact: true }).fill('eigen');
  await page.getByTestId('search-openai-compatible').getByRole('button', { name: 'Koppelen' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByPlaceholder(/https:\/\//).fill(fakeUrl);
  const modelInput = dialog.locator('input[list^="models-"]');
  await modelInput.fill('nep-model');
  await dialog.getByRole('button', { name: 'Koppelen en testen' }).click();
  await dialog.getByTestId('connect-ok').or(dialog.getByTestId('connect-error')).first().waitFor({ timeout: 15000 });
  if (!(await dialog.getByTestId('connect-ok').count())) fail('provider-test mislukt: ' + (await dialog.innerText()));
  else step('provider gekoppeld en getest');
  await dialog.getByRole('button', { name: 'Klaar' }).click();

  // The next provider's dialog never shows or keeps the previous name and key, also when you type right away
  // (acceptance round 3: "Anthropic koppelen" kept the name "OpenAI (API)" from the dialog before).
  for (const [search, label, key] of [['groq', 'Groq', 'gsk_eerste-sleutel'], ['mistral', 'Mistral', 'tweede-sleutel']]) {
    await page.getByLabel('Zoek een dienst', { exact: true }).fill(search);
    await page.getByTestId(`search-${search}`).getByRole('button', { name: 'Koppelen' }).click();
    await dialog.locator('input[type=password]').fill(key);
    const vals = await dialog.locator('input').evaluateAll((els) => els.map((e) => e.value));
    if (!vals.includes(label) || !vals.includes(key) || vals.includes('gsk_eerste-sleutel') !== (label === 'Groq')) fail(`koppelvenster ${label}: oude naam of sleutel van het vorige venster (${JSON.stringify(vals.map((v) => (v.includes('sleutel') ? v : v.slice(0, 20))))})`);
    await dialog.getByRole('button', { name: 'Annuleren' }).click();
  }
  step('koppelvenster begint per provider leeg');

  // Create a bot from the "Codeerhulp" template (has file tools), access mode "ask".
  await page.goto(`${app.url}/#/agents/new`);
  await page.getByRole('button', { name: /Assistent/ }).first().click();
  await page.getByRole('button', { name: 'Bot aanmaken' }).click();
  await page.waitForURL(/#\/t\//, { timeout: 15000 });
  step('bot aangemaakt, chat geopend');
  const chatHash = await page.evaluate(() => location.hash);
  // A new bot starts at "Volledige toegang" (it does its work without a question per step). The approval card in the
  // chat is checked at "Vraagt toestemming": set on the bot page › Wat mag de bot?, then Opslaan.
  {
    const created = app.ctx.store.agents(app.ctx.auth.owner().id)[0];
    if (created.access_mode !== 'full') fail(`nieuwe bot start op "${created.access_mode}" in plaats van Volledige toegang`);
    await page.goto(`${app.url}/#/agents/${created.id}`);
    await page.locator('[data-testid="access-choice"] [role="combobox"]').click({ timeout: 15000 });
    await page.getByRole('option', { name: 'Vraagt toestemming' }).click();
    await page.getByRole('button', { name: 'Opslaan' }).first().click();
    await page.getByText('Opgeslagen', { exact: true }).first().waitFor({ timeout: 8000 }).catch(() => fail('botpagina: "Vraagt toestemming" niet opgeslagen'));
    if (app.ctx.store.agents(app.ctx.auth.owner().id)[0].access_mode !== 'ask') fail('botpagina: Wat mag de bot? staat na opslaan niet op Vraagt toestemming');
    await page.goto(`${app.url}/${chatHash}`);
  }

  await page.getByLabel('Bericht').fill('Schrijf hallo e2e naar e2e.txt');
  await page.keyboard.press('Enter');
  await page.getByRole('button', { name: 'Eén keer toestaan' }).click({ timeout: 20000 });
  step('goedkeuringskaart verscheen en is goedgekeurd');
  // Scoped to the conversation: the chat list in the sidebar shows the same text as the bot's last-message preview.
  await page.locator('[id^="m-"]').getByText('Klaar: e2e.txt staat in je werkmap.').waitFor({ timeout: 20000 });
  step('gestreamd eindantwoord zichtbaar');
  // Every message shows its time without hovering (a phone has no hover).
  const timeShown = await page
    .locator('[id^="m-"]')
    .filter({ hasText: 'Klaar: e2e.txt' })
    .last()
    .evaluate((el) => [...el.querySelectorAll('span, div')].some((x) => /^\d{1,2}:\d{2}$/.test(x.textContent.trim()) && Number(getComputedStyle(x).opacity) > 0 && Number(getComputedStyle(x.parentElement).opacity) > 0));
  if (!timeShown) fail('antwoord van de bot toont de tijd alleen bij hover');

  const agent = app.ctx.store.agents(app.ctx.auth.owner().id)[0];
  const file = path.join(agent.workspace, 'e2e.txt');
  if (!fs.existsSync(file) || fs.readFileSync(file, 'utf8') !== 'hallo e2e') fail('bestand niet (correct) geschreven');
  else step('bestand staat echt in de werkmap');

  // Command palette (Ctrl+K): pages, settings, quick actions and server results (files), all by keyboard.
  const palette = page.getByRole('dialog', { name: 'Zoeken en snelle acties' });
  const activeOption = () => palette.locator('[role="option"][aria-selected="true"]');
  const paletteGo = async (q, want) => {
    await page.keyboard.press('Control+k');
    await palette.waitFor({ timeout: 5000 });
    await page.keyboard.type(q);
    await page.waitForTimeout(450);
    await page.keyboard.press('Enter');
    await page.waitForFunction((h) => location.hash.startsWith(h), want, { timeout: 5000 }).catch(async () => fail(`palet: "${q}" opent ${await page.evaluate(() => location.hash)} in plaats van ${want}`));
    if (await palette.count()) fail(`palet: blijft open na "${q}"`);
  };
  await page.goto(`${app.url}/#/`);
  await page.waitForTimeout(500);
  await paletteGo('Marktplaats', '#/m/skills/');
  await paletteGo('Telefoon', '#/settings/telefoon');
  await paletteGo('Kluis', '#/m/browser/kluis');
  await paletteGo('Limieten', '#/settings/usage-limits');
  await paletteGo('nieuwe bot', '#/agents/new');
  // A file in the bot's folder (server search) opens the folder browser with its preview.
  await page.keyboard.press('Control+k');
  await page.keyboard.type('e2e.txt');
  const fileHit = palette.locator('[role="group"]', { hasText: 'Bestanden' }).locator('[role="option"]', { hasText: 'e2e.txt' });
  await fileHit.waitFor({ timeout: 8000 }).catch(() => fail('palet: bestand e2e.txt niet gevonden'));
  await fileHit.click();
  await page.getByRole('dialog', { name: 'e2e.txt' }).getByText('hallo e2e').waitFor({ timeout: 8000 }).catch(() => fail('palet: bestandsvoorbeeld niet geopend'));
  await page.keyboard.press('Escape');
  step("Ctrl+K vindt pagina's, instellingen, acties en bestanden (Marktplaats, Telefoon, Kluis, Limieten, Nieuwe bot, e2e.txt)");

  // Keyboard only: Ctrl+K → type the bot name → ↓/Enter on the result → type → Enter sends (no mouse).
  await page.goto(`${app.url}/#/`);
  await page.waitForTimeout(500);
  await page.keyboard.press('Control+k');
  await page.waitForTimeout(300);
  await page.keyboard.type(agent.name.slice(0, 5));
  await page.waitForTimeout(500);
  let found = false;
  for (let i = 0; i < 8 && !found; i++) {
    found = ((await activeOption().textContent().catch(() => '')) || '').includes(agent.name);
    if (!found) await page.keyboard.press('ArrowDown');
  }
  if (!found) fail('toetsenbord: zoekresultaat niet bereikbaar met de pijltjes');
  await page.keyboard.press('Enter');
  await page.waitForURL(/#\/t\//, { timeout: 10000 }).catch(() => fail('toetsenbord: Enter op resultaat opent de chat niet'));
  await page.getByPlaceholder(/Bericht aan/).waitFor({ timeout: 10000 });
  await page.waitForTimeout(800); // let the thread finish loading so the composer is not re-mounted while typing
  const composer = page.getByPlaceholder(/Bericht aan/);
  await composer.focus();
  const focusVisible = await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle !== 'none' || document.activeElement?.closest('[class*="focus-within"]') !== null);
  if (!focusVisible) fail('toetsenbord: geen zichtbare focus op het berichtveld');
  turn = 1; // fake model: answer directly, no tool call
  await page.keyboard.type('Alleen toetsenbord');
  await page.keyboard.press('Enter');
  // .first(): during one render the text can briefly exist twice in the DOM; the steady state is checked below.
  await page.getByText('Alleen toetsenbord', { exact: true }).first().waitFor({ timeout: 10000 }).catch(async (e) => {
    const n = await page.getByText('Alleen toetsenbord', { exact: true }).count();
    const typed = await composer.inputValue().catch(() => '?');
    await page.screenshot({ path: path.join(os.tmpdir(), 'tb-e2e-kbd.png') });
    fail(`toetsenbord: bericht niet verstuurd met Enter (${n} treffers, veld: ${JSON.stringify(typed)}; ${String(e.message).split('\n')[0]}; screenshot: ${path.join(os.tmpdir(), 'tb-e2e-kbd.png')})`);
  });
  await page.waitForTimeout(1500);
  const bubbles = await page.locator('[id^="m-"]').getByText('Alleen toetsenbord', { exact: true }).count();
  if (bubbles !== 1) fail(`toetsenbord: bericht staat ${bubbles}× in het gesprek`);
  step('volledige flow met alleen het toetsenbord (Ctrl+K, pijltjes, Enter)');

  // Notification centre: a bot notification → toast, bell count, history; opening it marks it read.
  const owner = app.ctx.auth.owner();
  await page.goto(`${app.url}/#/agents`);
  await page.waitForTimeout(400);
  const thread = app.ctx.store.one('SELECT id FROM threads WHERE agent_id = ? ORDER BY created_at LIMIT 1', agent.id);
  app.ctx.events.emit(owner.id, 'notification', { title: `${agent.name} is klaar`, body: 'Het rapport staat in je werkmap', link: `#/t/${thread.id}`, kind: 'agent', agentId: agent.id });
  await page.getByText(`${agent.name} is klaar: Het rapport staat in je werkmap`).waitFor({ timeout: 5000 }).catch(() => fail('meldingen: geen toast'));
  const bell = page.getByRole('button', { name: /^Meldingen, 1 ongelezen/ });
  await bell.waitFor({ timeout: 5000 }).catch(() => fail('meldingen: bel toont geen 1 ongelezen'));
  await bell.click();
  const panel = page.getByRole('dialog', { name: 'Meldingen' });
  await panel.getByRole('button', { name: new RegExp(`Ongelezen: ${agent.name} is klaar`) }).click({ timeout: 5000 });
  await page.waitForURL(new RegExp(`#/t/${thread.id}`), { timeout: 5000 }).catch(() => fail('meldingen: klikken opent het gesprek niet'));
  await page.getByRole('button', { name: /^Meldingen$/ }).waitFor({ timeout: 5000 }).catch(() => fail('meldingen: na openen nog ongelezen'));
  // A bot set to "Niets": quiet (no toast), but in the history.
  await page.goto(`${app.url}/#/settings/notifications-meldingen`);
  await page.getByRole('radiogroup', { name: `Meldingen van ${agent.name}` }).getByRole('radio', { name: 'Niets' }).click();
  await page.waitForTimeout(400);
  app.ctx.events.emit(owner.id, 'notification', { title: 'Stille melding', body: 'mag niet poppen', kind: 'agent', agentId: agent.id });
  await page.waitForTimeout(800);
  if (await page.getByText('Stille melding: mag niet poppen').count()) fail('meldingen: "Niets" gaf toch een toast');
  if (!app.ctx.store.one("SELECT id FROM notifications WHERE title = 'Stille melding' AND muted = 1 AND read_at IS NOT NULL")) fail('meldingen: stille melding niet in de geschiedenis');
  step('meldingencentrum: toast, bel met aantal, geschiedenis, gelezen na openen, "Niets" per bot is stil');

  // Phone width: no horizontal page overflow on the chat and settings.
  await page.setViewportSize({ width: 390, height: 800 });
  for (const h of [page.url().split('#')[1], '/settings/general', '/settings', '/', '/search?q=telefoon', '/m/notifications/']) {
    await page.goto(`${app.url}/#${h.replace(/^#?/, '')}`);
    await page.waitForTimeout(600);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) fail(`horizontale overflow ${over}px op ${h} (390 px)`);
  }
  step('telefoonbreedte zonder horizontale overflow');
  // Phone: the search page finds a setting; the settings list is one list of plain rows (what you set yourself, then
  // "Van je bots", then "Meer mogelijkheden"), a row opens its page with a way back, and an entry under "Meer
  // mogelijkheden" leads back to that row.
  await page.goto(`${app.url}/#/search?q=Telefoon`);
  await page.getByRole('option', { name: /Telefoon.*Instellingen/ }).first().waitFor({ timeout: 5000 }).catch(() => fail('telefoon: zoeken vindt de instelling Telefoon niet'));
  await page.goto(`${app.url}/#/settings`);
  await page.waitForTimeout(400);
  const settingsRows = ['AI-diensten', 'Telefoon', 'Taal en uiterlijk', 'Regels', 'Back-ups', 'Vergrendeling', 'Bots', 'Teams', 'Geheugen', 'Kanalen', 'Apps', 'Bestanden', 'Meer mogelijkheden'];
  for (const g of settingsRows) if (!(await page.getByRole('main').getByRole('link', { name: new RegExp(`^${g}\\b`) }).count())) fail(`telefoon: instellingenregel ${g} ontbreekt`);
  if (!(await page.getByRole('main').getByRole('group', { name: 'Van je bots' }).count())) fail('telefoon: kopje "Van je bots" ontbreekt in de instellingenlijst');
  await page.getByRole('main').getByRole('link', { name: /^Meer mogelijkheden/ }).click();
  await page.getByRole('link', { name: 'Instellingen' }).first().waitFor({ timeout: 5000 }).catch(() => fail('telefoon: terug naar Instellingen ontbreekt'));
  await page.getByRole('navigation', { name: 'Onderdelen' }).getByRole('link', { name: /^Privacy en gegevens/ }).click();
  await page.getByRole('link', { name: 'Meer mogelijkheden' }).first().waitFor({ timeout: 5000 }).catch(() => fail('telefoon: terug naar Meer mogelijkheden ontbreekt'));
  step(`telefoon: zoeken en de ${settingsRows.length} instellingenregels`);
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
console.log(process.exitCode ? 'E2E MISLUKT' : 'E2E GESLAAGD');
