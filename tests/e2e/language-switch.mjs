// Interface language in the real UI (UX-02), desktop and phone:
//   1. first run follows the system/browser language; a language TeamBot does not have → English; stored for the user
//   2. the welcome screen picker: 11 languages, each in its own name (never translated); choosing one switches
//   3. Instellingen › Taal en uiterlijk: switching to Arabic gives a right-to-left page; "Bots antwoorden in" (Meer
//      mogelijkheden › Standaarden voor nieuwe bots) is stored. Instellingen is walked as a person does it, by clicks.
//   4. the phone follows the user's choice: on load, and live when it changes on the computer
//   5. an account that already had bots before languages existed stays Dutch
// Usage: npm run build:ui && node --import tsx tests/e2e/language-switch.mjs   (part of npm run e2e)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { testLanguage } from './lang.mjs';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');
const { createApp } = await import('./server.mjs');
const LANGS = JSON.parse(fs.readFileSync(path.join('ui', 'src', 'i18n', 'languages.json'), 'utf8'));

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-lang-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const store = app.ctx.store;
const shots = process.env.TEAMBOT_LANG_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const userLang = () => store.getSetting(owner.id, 'language', null);
const forget = () => store.exec("DELETE FROM settings WHERE user_id = ? AND key = 'language'", owner.id);
const htmlLang = (page) => page.evaluate(() => ({ lang: document.documentElement.lang, dir: document.documentElement.dir || 'ltr' }));
const until = async (fn, ms = 10_000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try {
      if (await fn()) return true;
    } catch {
      /* the page is reloading */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
};
/** Choose a language in a picker; the page stores it and reloads. */
async function choose(page, select, code) {
  await Promise.all([page.waitForEvent('load', { timeout: 15_000 }), page.locator(select).first().selectOption(code)]);
  return until(async () => (await htmlLang(page)).lang === code);
}
// The interface language picker (the bot language picker has an "auto" option as well).
const PICKER = 'select:has(option[value="nl"]):not(:has(option[value="auto"]))';
// Instellingen uses TeamBot's own dropdown (components/Listbox.tsx): a button that carries the chosen value, options
// with data-value. Its label is translated, so the box is found by its current value (the first one on the page).
const box = (page, value) => page.locator(`[role="combobox"][data-value="${value}"]`).first();
const pick = async (page, from, to) => (await box(page, from).click(), await page.locator(`[role="listbox"] [role="option"][data-value="${to}"]`).click());
/**
 * Open a page of Instellingen the way a person does: Instellingen in the sidebar, then the row (and, for a page under
 * Meer mogelijkheden, that row first). By the links, so it works in every language.
 */
async function walkTo(page, href, under) {
  const side = page.locator('aside a[href="#/settings"]').first();
  await side.waitFor({ timeout: 15_000 });
  await side.click();
  if (under) await page.locator(`#inhoud a[href="${under}"]`).first().click();
  await page.locator(`#inhoud a[href="${href}"]`).first().click();
  return until(async () => (await page.evaluate(() => location.hash)) === href);
}
/** Choose the interface language in Instellingen; the page stores it and reloads. */
async function chooseBox(page, code) {
  const cur = (await htmlLang(page)).lang;
  await box(page, cur).waitFor({ timeout: 15_000 });
  await Promise.all([page.waitForEvent('load', { timeout: 15_000 }), pick(page, cur, code)]);
  return until(async () => (await htmlLang(page)).lang === code);
}

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
try {
  // ---------------- 1. first run ----------------
  {
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'de-DE' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${app.url}/#token=${token}`);
    await page.waitForSelector('h1', { timeout: 15_000 });
    const de = testLanguage(['--lang', 'de']);
    await until(async () => (await page.locator('h1').first().innerText()).trim() === de.L('Welkom bij TeamBot'));
    check('eerste start, browser in het Duits: welkomstscherm in het Duits', (await htmlLang(page)).lang === 'de' && (await page.locator('h1').first().innerText()).trim() === de.L('Welkom bij TeamBot'), await page.locator('h1').first().innerText());
    check('eerste start: de taal is voor de gebruiker opgeslagen', await until(() => userLang() === 'de'), String(userLang()));
    await ctx.close();
  }
  {
    forget();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'sv-SE' });
    const page = await ctx.newPage();
    page.on('pageerror', (e) => errors.push(String(e)));
    await page.goto(`${app.url}/#token=${token}`);
    await page.waitForSelector('h1', { timeout: 15_000 });
    check('eerste start, browser in een taal die TeamBot niet heeft (Zweeds): Engels', await until(async () => (await htmlLang(page)).lang === 'en' && userLang() === 'en'), `${(await htmlLang(page)).lang} / ${userLang()}`);
    await ctx.close();
  }

  // ---------------- 2. welcome screen picker ----------------
  const desk = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-GB' });
  const page = await desk.newPage();
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForSelector(PICKER, { timeout: 15_000 });
  const options = await page.locator(`${PICKER} option`).evaluateAll((els) => els.map((o) => ({ value: o.value, text: o.textContent.trim(), lang: o.getAttribute('lang'), translate: o.getAttribute('translate') })));
  check(
    'welkomstscherm: alle 11 talen, elk in de eigen naam',
    options.length === LANGS.length && LANGS.every((l) => options.some((o) => o.value === l.code && o.text === l.name && o.lang === l.code && o.translate === 'no')),
    options.map((o) => o.text).join(', '),
  );
  check('welkomstscherm: kiezen voor Français schakelt om', await choose(page, PICKER, 'fr'), (await htmlLang(page)).lang);
  const fr = testLanguage(['--lang', 'fr']);
  check('welkomstscherm in het Frans, keuze opgeslagen voor de gebruiker', (await page.locator('h1').first().innerText()).trim() === fr.L('Welkom bij TeamBot') && userLang() === 'fr', `${await page.locator('h1').first().innerText()} / ${userLang()}`);
  const names = await page.locator(`${PICKER} option`).allTextContents();
  check('taalnamen worden nooit vertaald (ook niet in een Franse interface)', names.includes('Nederlands') && names.includes('Deutsch') && names.includes('العربية'), names.join(', '));
  if (shots) await page.screenshot({ path: path.join(shots, 'welkom-fr.png') });

  // ---------------- 3. settings: Arabic, right to left; bot language ----------------
  const helper = store.createAgent(owner.id, { name: 'Helper', avatar: '🤖', role: 'Test' });
  // With a bot the app opens as usual (no welcome screen): Instellingen › Taal en uiterlijk.
  await page.reload();
  check('Instellingen › Taal en uiterlijk geopend met klikken', await walkTo(page, '#/settings/general'), await page.evaluate(() => location.hash));
  check('Instellingen: kiezen voor العربية schakelt om', await chooseBox(page, 'ar'), JSON.stringify(await htmlLang(page)));
  const rtl = await htmlLang(page);
  check('Arabisch: de pagina loopt van rechts naar links', rtl.dir === 'rtl' && userLang() === 'ar', JSON.stringify(rtl));
  // The sidebar sits on the right in a right-to-left layout (the switch reloads the page: wait until the app is back).
  await page.waitForSelector('aside', { timeout: 15_000 }).catch(() => {});
  const side = await page.evaluate(() => {
    const a = document.querySelector('aside');
    if (!a) return null;
    const r = a.getBoundingClientRect();
    return { left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth };
  });
  check('Arabisch: de zijbalk staat rechts', !!side && side.right >= side.vw - 2 && side.left > side.vw / 2, JSON.stringify(side));
  // Chat bubbles swap sides: your own message at the end of the line (left in Arabic), the bot's at the start.
  const th = store.createThread({ user_id: owner.id, agent_id: helper.id, kind: 'chat' });
  const mine = store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: owner.id, author_name: owner.name, content: 'مرحبا' });
  const theirs = store.createMessage({ thread_id: th.id, role: 'assistant', author_type: 'agent', author_id: helper.id, author_name: helper.name, content: 'أهلاً! كيف أساعدك؟' });
  await page.evaluate((h) => (location.hash = h), `#/t/${th.id}`);
  await page.waitForSelector(`#m-${theirs.id}`, { timeout: 10_000 });
  const pos = await page.evaluate(
    ([a, b]) => {
      // The rendered text of a message (bubble or markdown), measured with a range around its first text node.
      const box = (id) => {
        const root = document.getElementById(`m-${id}`);
        const w = root && document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (/[؀-ۿ]/.test(n.nodeValue || '') ? 1 : 3) });
        const n = w?.nextNode();
        if (!n) return null;
        const r = document.createRange();
        r.selectNodeContents(n);
        return r.getBoundingClientRect();
      };
      const m = box(a);
      const t = box(b);
      return m && t ? { mine: Math.round(m.left + m.width / 2), bot: Math.round(t.left + t.width / 2), vw: window.innerWidth } : null;
    },
    [mine.id, theirs.id],
  );
  check('Arabisch: eigen bericht links, bot rechts (gespiegeld)', !!pos && pos.mine < pos.bot, JSON.stringify(pos));
  if (shots) await page.screenshot({ path: path.join(shots, 'chat-ar.png') });
  // "Bots antwoorden in" is under Meer mogelijkheden › Standaarden voor nieuwe bots.
  check('Instellingen › Meer mogelijkheden › Standaarden voor nieuwe bots geopend met klikken', await walkTo(page, '#/settings/bot-defaults', '#/settings/meer'), await page.evaluate(() => location.hash));
  await box(page, 'auto').waitFor({ timeout: 10_000 });
  await pick(page, 'auto', 'de');
  check('"Bots antwoorden in": vaste taal opgeslagen', await until(() => store.getSetting(owner.id, 'botLanguage', null) === 'de'), String(store.getSetting(owner.id, 'botLanguage', null)));
  await pick(page, 'de', 'auto');
  check('"Bots antwoorden in": terug naar de taal van de gebruiker', await until(() => store.getSetting(owner.id, 'botLanguage', null) === 'auto'));

  // ---------------- 4. the phone follows ----------------
  const phone = await browser.newContext({ ...devices['Pixel 7'], locale: 'nl-NL' });
  // This phone chose Dutch earlier itself; the user's choice (Arabic, made on the computer) wins.
  await phone.addInitScript(() => {
    if (!sessionStorage.getItem('tb_seeded')) {
      localStorage.setItem('tb_lang', 'nl');
      sessionStorage.setItem('tb_seeded', '1');
    }
  });
  const ph = await phone.newPage();
  ph.on('pageerror', (e) => errors.push(String(e)));
  await ph.goto(`${app.url}/#token=${token}`);
  check('telefoon volgt bij het openen de keuze van de gebruiker (Arabisch)', await until(async () => (await htmlLang(ph)).lang === 'ar' && (await htmlLang(ph)).dir === 'rtl', 15_000), JSON.stringify(await htmlLang(ph)));
  if (shots) await ph.screenshot({ path: path.join(shots, 'telefoon-ar.png') });
  // Directional icons are mirrored (the "Meer" rows' chevrons point to the left); object icons keep their shape.
  await ph.evaluate(() => (location.hash = '#/more'));
  await ph.waitForSelector('.lucide-chevron-right', { timeout: 10_000 });
  const icons = await ph.evaluate(() => {
    const dir = [...document.querySelectorAll('.lucide-chevron-right, .lucide-chevron-left, .lucide-arrow-right, .lucide-arrow-left')];
    const keep = [...document.querySelectorAll('.lucide-search, .lucide-bell, .lucide-settings, .lucide-lock')];
    const flipped = (el) => /^matrix\(-1,/.test(getComputedStyle(el).transform);
    return { dir: dir.length, dirFlipped: dir.filter(flipped).length, keep: keep.length, keepFlipped: keep.filter(flipped).length };
  });
  check('Arabisch: richting-iconen gespiegeld, andere iconen niet', icons.dir > 0 && icons.dirFlipped === icons.dir && icons.keepFlipped === 0, JSON.stringify(icons));
  // Switch on the computer: the phone reloads into the new language by itself.
  await walkTo(page, '#/settings/general');
  await chooseBox(page, 'de');
  check('telefoon schakelt live mee als de taal op de computer verandert (Deutsch)', await until(async () => (await htmlLang(ph)).lang === 'de' && (await htmlLang(ph)).dir === 'ltr', 15_000), JSON.stringify(await htmlLang(ph)));
  await phone.close();
  await desk.close();

  // ---------------- 5. an existing (Dutch-only era) account stays Dutch ----------------
  {
    forget();
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en-US' });
    const p = await ctx.newPage();
    p.on('pageerror', (e) => errors.push(String(e)));
    await p.goto(`${app.url}/#token=${token}`);
    check('bestaand account zonder taalkeuze (had al bots): blijft Nederlands', await until(async () => (await htmlLang(p)).lang === 'nl' && userLang() === 'nl', 15_000), `${(await htmlLang(p)).lang} / ${userLang()}`);
    await ctx.close();
  }
  check('geen paginafouten', errors.length === 0, errors.slice(0, 3).join(' | '));
} catch (e) {
  check('onverwachte fout', false, e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
