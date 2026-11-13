// Accent colour (PARITEIT 18.2) in a real browser: on the computer Instellingen › Taal en uiterlijk › Kleur → Lavendel applies
// at once in light and dark (tokens, focus ring, logo mark, both preview panels), is stored for the user and survives a
// reload; the paired phone (a real QR pairing, its own device session, dark by default) shows the same colour, changes
// it, and the computer follows live. axe-core (WCAG 2.x AA, contrast) on the Taal en uiterlijk page for every colour in
// light and dark (the old link #/settings/appearance opens that page). Standaard leaves <html> without data-accent (the look of styles.css).
// Usage: npm run build:ui && node --import tsx tests/e2e/accent.mjs   (TEAMBOT_E2E_BROWSER=chrome|msedge)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');

let failed = 0;
const ok = (name, cond, detail = '') => {
  if (!cond) failed++;
  console.log(`${cond ? '✔' : '✖'} ${name}${detail && !cond ? ` — ${detail}` : ''}`);
};

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-accent-home-'));
Object.assign(process.env, { APPDATA: path.join(home, 'AppData', 'Roaming'), LOCALAPPDATA: path.join(home, 'AppData', 'Local') });
delete process.env.TEAMBOT_DATA;
const { createApp } = await import('./server.mjs');
const { ACCENTS } = await import('../../shared/accent.ts');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-accent-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const lav = ACCENTS.find((a) => a.id === 'lavender');
const teal = ACCENTS.find((a) => a.id === 'teal');
const hex = (rgb) => '#' + (rgb.match(/\d+/g) || []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');

try {
  // ---------------------------------------------------------------- the computer
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'nl-NL', bypassCSP: true });
  await ctx.addInitScript(([t]) => {
    if (!sessionStorage.getItem('tb_init')) {
      sessionStorage.setItem('tb_init', '1');
      localStorage.setItem('tb_token', t);
      localStorage.setItem('tb_lang', 'nl');
      localStorage.setItem('tb_theme', 'light');
    }
  }, [token]);
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${app.url}/#/settings/appearance`);
  const group = page.getByRole('radiogroup', { name: 'Kleur' });
  await group.waitFor({ timeout: 15000 });
  const tokens = () =>
    page.evaluate(() => {
      const cs = getComputedStyle(document.documentElement);
      return { accent: cs.getPropertyValue('--color-accent').trim(), soft: cs.getPropertyValue('--color-accent-soft').trim(), ring: cs.getPropertyValue('--color-ring').trim(), attr: document.documentElement.dataset.accent || null, dark: document.documentElement.classList.contains('dark') };
    });
  const std = await tokens();
  ok('standaard: geen data-accent, de tokens van styles.css', std.attr === null && std.accent === '#1c1b19' && std.ring === '', JSON.stringify(std));
  ok('standaard staat aangevinkt', (await group.getByRole('radio', { name: 'Standaard' }).getAttribute('aria-checked')) === 'true');
  ok('ongeveer 10 kleuren om uit te kiezen, met Lavendel', (await group.getByRole('radio').count()) >= 11 && (await group.getByRole('radio', { name: 'Lavendel' }).count()) === 1);

  await group.getByRole('radio', { name: 'Lavendel' }).click();
  await page.waitForFunction(() => document.documentElement.dataset.accent === 'lavender');
  const l = await tokens();
  ok('lavendel (licht): accent, zachte achtergrond en focusring wisselen meteen', l.accent === lav.light.accent && l.soft === lav.light.accentSoft && l.ring === lav.light.ring, JSON.stringify(l));
  // A real control on the page uses it: the primary button and the focus ring.
  // The last row of the settings list, "Meer mogelijkheden" (was Geavanceerd).
  const btn = page.locator('a[href="#/settings/meer"]').first();
  await btn.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  // The row has transition-colors (outline-color too): read the ring once it stands still.
  await page.waitForTimeout(300);
  const outline = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? hex(getComputedStyle(el).outlineColor) : '';
    function hex(rgb) {
      return '#' + (rgb.match(/\d+/g) || []).slice(0, 3).map((n) => Number(n).toString(16).padStart(2, '0')).join('');
    }
  });
  ok('de focusrand van een echt element is de accentkleur', outline === lav.light.ring, outline);
  // The sample cards (light and dark side by side) are gone from Uiterlijk; the main button has the accent colour
  // (--color-btn), so it follows the choice.
  const btnColour = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--color-btn').trim());
  ok('de hoofdknop krijgt de gekozen accentkleur (lavendel)', btnColour === lav.light.accent, btnColour);
  const markColour = await page.evaluate(() => document.querySelector('nav[aria-label="Hoofdmenu"] .tb-face svg')?.innerHTML || '');
  ok('het TeamBot-figuurtje in de zijbalk krijgt de kleur', markColour.toLowerCase().includes(lav.logo.toLowerCase()));
  await page.waitForTimeout(400);
  ok('opgeslagen voor de gebruiker (settings.ui.accent)', app.ctx.store.settings(owner.id).ui?.accent === 'lavender');

  await page.getByRole('radio', { name: 'Donker' }).click();
  const d = await tokens();
  ok('lavendel (donker): de donkere waarden', d.dark && d.accent === lav.dark.accent && d.ring === lav.dark.ring, JSON.stringify(d));
  await page.reload();
  await group.waitFor({ timeout: 15000 });
  const r = await tokens();
  ok('na opnieuw laden: nog steeds lavendel', r.attr === 'lavender' && r.accent === lav.dark.accent && (await group.getByRole('radio', { name: 'Lavendel' }).getAttribute('aria-checked')) === 'true');

  // axe: every colour, light and dark, on the Uiterlijk page (radios, samples, buttons, links).
  const axeFail = [];
  await page.addScriptTag({ content: axeSource });
  for (const theme of ['Licht', 'Donker']) {
    await page.getByRole('radio', { name: theme }).click();
    // 0.4.5: the page has buttons now ("Standaard terugzetten"); let their colour transition to the new theme finish.
    await page.waitForTimeout(400);
    for (const a of ACCENTS) {
      await page.evaluate((id) => (id === 'standard' ? delete document.documentElement.dataset.accent : (document.documentElement.dataset.accent = id)), a.id);
      await page.waitForTimeout(30);
      const res = await page.evaluate(async () => {
        const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'] } });
        return r.violations.map((v) => `${v.id}: ${v.nodes.slice(0, 2).map((n) => n.target.join(' ')).join(' | ')}`);
      });
      if (res.length) axeFail.push(`${a.id}/${theme}: ${res.join('; ')}`);
    }
  }
  ok(`axe WCAG AA op Uiterlijk: ${ACCENTS.length} kleuren × licht en donker`, !axeFail.length, axeFail.slice(0, 4).join(' ‖ '));
  await page.getByRole('radio', { name: 'Licht' }).click();
  // Back to the stored colour (axe walked through all of them on this page only).
  await page.reload();
  await group.waitFor({ timeout: 15000 });

  // ---------------------------------------------------------------- the paired phone
  const IOS_UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 TeamBotiOS/0.4.3';
  const ticket = await (await fetch(`${app.url}/api/mobile/pair`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ baseUrl: app.url }) })).json();
  const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t');
  const claimed = await (await fetch(`${app.url}/api/public/mobile/claim`, { method: 'POST', headers: { 'content-type': 'application/json', 'user-agent': IOS_UA }, body: JSON.stringify({ secret, name: 'iPhone', platform: 'ios', client: 'ios-app' }) })).json();
  const pctx = await browser.newContext({ viewport: { width: 402, height: 874 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true, userAgent: IOS_UA, locale: 'nl-NL', bypassCSP: true });
  await pctx.addInitScript(([t]) => {
    if (localStorage.getItem('tb_token') !== t) {
      localStorage.setItem('tb_token', t);
      localStorage.setItem('tb_lang', 'nl');
    }
  }, [claimed.token]);
  const phone = await pctx.newPage();
  phone.on('pageerror', (e) => errors.push(String(e)));
  await phone.goto(`${app.url}/#/settings/appearance`);
  const pgroup = phone.getByRole('radiogroup', { name: 'Kleur' });
  await pgroup.waitFor({ timeout: 15000 });
  const pt = await phone.evaluate(() => ({ dark: document.documentElement.classList.contains('dark'), attr: document.documentElement.dataset.accent || null, accent: getComputedStyle(document.documentElement).getPropertyValue('--color-accent').trim() }));
  ok('telefoon (apparaatsessie, standaard donker): dezelfde kleur als de computer', pt.dark && pt.attr === 'lavender' && pt.accent === lav.dark.accent, JSON.stringify(pt));
  await phone.addScriptTag({ content: axeSource });
  const pax = await phone.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa'] } })).violations.map((v) => v.id));
  ok('telefoon: axe WCAG AA zonder fouten in lavendel donker', !pax.length, pax.join(', '));
  const overflow = await phone.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  ok('telefoon: niets loopt opzij weg (402 px)', overflow <= 1, String(overflow));
  await pgroup.getByRole('radio', { name: 'Petrol' }).tap();
  await phone.waitForFunction(() => document.documentElement.dataset.accent === 'teal');
  // The computer follows live (settings.updated over the WebSocket), without reloading.
  await page.waitForFunction(() => document.documentElement.dataset.accent === 'teal', null, { timeout: 8000 }).catch(() => {});
  const back = await tokens();
  ok('kleur gekozen op de telefoon: de computer volgt meteen', back.attr === 'teal' && back.accent === teal.light.accent, JSON.stringify(back));

  // Standaard again: nothing left on <html>.
  await group.getByRole('radio', { name: 'Standaard' }).click();
  await page.waitForFunction(() => !document.documentElement.dataset.accent);
  const end = await tokens();
  ok('terug naar Standaard: precies de oude look', end.attr === null && end.accent === '#1c1b19' && end.ring === '');
  ok('geen fouten op de pagina', !errors.length, errors.slice(0, 3).join(' | '));
} catch (e) {
  failed++;
  console.log(`✖ ${e?.stack || e}`);
} finally {
  await browser.close();
  await app.close?.();
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
}
console.log(failed ? `✖ ${failed} mislukt` : '✔ accentkleur werkt op computer en telefoon');
process.exit(failed ? 1 : 0);
