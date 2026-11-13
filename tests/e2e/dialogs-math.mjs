// End-to-end, Edge/Chrome headless, desktop 1360 px and phone 390 px (0.4.4, P13):
//   1. dialogs (Radix Dialog): the focus starts inside, Tab stays inside, the page behind is inert, Escape closes,
//      the focus comes back (also when the dialog came from a menu that has closed since); the confirmation dialog
//      (askConfirm) the same, with the focus on its button; axe on an open dialog;
//   2. formulas in a chat answer (KaTeX): inline and display math are drawn, an amount ($5) stays text, the KaTeX fonts
//      load from the app itself under its own CSP (no CDN).
// Fake engine in-process, TEMP data, a free port. Usage: npm run build:ui && node --import tsx tests/e2e/dialogs-math.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('./server.mjs');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const axeSource = fs.readFileSync(require.resolve('axe-core/axe.min.js'), 'utf8');
const axe = async (page, where) => {
  await page.evaluate(axeSource);
  const v = await page.evaluate(async () => {
    // @ts-ignore
    const r = await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] } });
    return r.violations.map((x) => `${x.id}: ${x.nodes.slice(0, 3).map((n) => n.target.join(' ')).join(', ')}`);
  });
  if (v.length) fail(`a11y ${where}: ${v.join(' | ')}`);
  else step(`a11y ${where}: 0 bevindingen`);
};
const until = async (fn, what, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  fail(`time-out: ${what}`);
  return false;
};

const ANSWER = 'De stelling van Pythagoras: $a^2 + b^2 = c^2$.\n\n$$\n\\int_0^1 x\\,dx = \\tfrac{1}{2}\n$$\n\nEn ook \\(e^{i\\pi} + 1 = 0\\). Het boek kost $5.';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-dialogs-math-'));
const app = await createApp({ dataDir: dir, port: Number(process.env.TB_E2E_PORT) || 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
app.ctx.providers.registerKind({
  id: 'e2emock',
  label: 'Testengine',
  type: 'api',
  needsKey: false,
  description: 'e2e',
  models: ['e2e-1'],
  defaultModel: 'e2e-1',
  create: () => ({
    kind: 'e2emock',
    async listModels() {
      return [{ id: 'e2e-1' }];
    },
    async test() {
      return { ok: true, detail: 'ok' };
    },
    async chat(req, _signal, onEvent) {
      onEvent({ type: 'text', delta: ANSWER });
      return { text: ANSWER, toolCalls: [], stop: 'end', usage: { input: 10, output: 5 }, model: req.model };
    },
  }),
});
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const api = async (method, p, body) => {
  const r = await fetch(`${app.url}/api${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error}`);
  return j;
};
await api('PUT', '/settings', { onboarded: true });
const prov = await api('POST', '/providers', { kind: 'e2emock' });
const bot = await api('POST', '/agents', { name: 'Rekenbot', role: 'Wiskunde', provider_id: prov.id, model: 'e2e-1', access_mode: 'auto' });

const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
const watch = (page) => {
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|40[34] \(|Failed to load resource/.test(m.text()) && errors.push(m.text()));
  page.on('requestfailed', (r) => /\.(woff2?|ttf)(\?|$)/.test(r.url()) && errors.push(`lettertype niet geladen: ${r.url()}`));
};
const idle = async (threadId) => until(() => !app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId).length, 'bot klaar');
/** Where the focus is: inside the open dialog, and its accessible label or text. */
const focusInfo = (page) =>
  page.evaluate(() => {
    const a = document.activeElement;
    const d = document.querySelector('[role="dialog"],[role="alertdialog"]');
    return { inDialog: !!(d && a && d.contains(a)), label: a?.getAttribute('aria-label') || a?.textContent?.trim().slice(0, 40) || a?.tagName || '' };
  });

try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 880 } });
  watch(page);
  await page.goto(`${app.url}/#token=${token}`);
  await page.goto(`${app.url}/#/a/${bot.id}`);
  const box = page.getByRole('textbox', { name: 'Bericht' });
  await box.waitFor({ timeout: 20000 });
  const threadId = await until(() => /#\/t\//.test(page.url()), 'chat open').then(() => page.url().split('#/t/')[1]);

  // ---- formulas ----
  await box.fill('Leg Pythagoras uit');
  await box.press('Enter');
  await idle(threadId);
  const md = page.locator('.md', { hasText: 'De stelling van Pythagoras' }).last();
  await md.locator('.katex').first().waitFor({ timeout: 15000 });
  const m = await md.evaluate((el) => ({
    inline: el.querySelectorAll('.katex:not(.katex-display .katex)').length,
    display: el.querySelectorAll('.katex-display').length,
    mathml: el.querySelectorAll('math').length,
    text: el.textContent || '',
  }));
  if (m.inline < 2) fail(`inline formules: ${m.inline} (verwacht 2: $…$ en \\(…\\))`);
  if (m.display !== 1) fail(`formule als blok: ${m.display}`);
  if (m.mathml < 3) fail('geen MathML voor schermlezers');
  if (!m.text.includes('kost $5.')) fail(`een bedrag werd een formule: ${m.text.slice(-60)}`);
  else step(`formules getekend (${m.inline} in de tekst, ${m.display} als blok, MathML erbij); "$5" bleef tekst`);
  const fonts = await page.evaluate(async () => {
    await document.fonts.ready;
    return [...document.fonts].filter((f) => /KaTeX/.test(f.family) && f.status === 'loaded').length;
  });
  if (!fonts) fail('geen KaTeX-lettertype geladen');
  else step(`${fonts} KaTeX-lettertypen geladen uit de app zelf`);

  // ---- a dialog from a menu ----
  const more = page.getByRole('button', { name: 'Meer opties' });
  await more.click();
  await page.getByRole('button', { name: 'Bot beheren', exact: true }).click();
  await page.getByRole('button', { name: 'Geschiedenis wissen…' }).click();
  const dlg = page.getByRole('dialog', { name: 'Geschiedenis van Rekenbot wissen?' });
  await dlg.getByText('Dit gaat weg').waitFor({ timeout: 10000 });
  let f = await focusInfo(page);
  if (!f.inDialog) fail(`focus staat bij openen niet in de dialoog (${f.label})`);
  for (let i = 0; i < 12; i++) await page.keyboard.press('Tab');
  f = await focusInfo(page);
  if (!f.inDialog) fail(`Tab liet de dialoog los (${f.label})`);
  for (let i = 0; i < 5; i++) await page.keyboard.press('Shift+Tab');
  f = await focusInfo(page);
  if (!f.inDialog) fail(`Shift+Tab liet de dialoog los (${f.label})`);
  else step('focus begint in de dialoog en blijft erin met Tab en Shift+Tab');
  const inert = await page.evaluate(() => {
    const d = document.querySelector('[role="dialog"]');
    const outside = [...document.querySelectorAll('[data-aria-hidden="true"]')];
    return { marked: outside.length, inert: outside.filter((el) => el.hasAttribute('inert')).length, composerInert: !!document.querySelector('textarea')?.closest('[inert]'), dialogInert: !!d?.closest('[inert]') };
  });
  if (!inert.marked || inert.inert !== inert.marked || !inert.composerInert || inert.dialogInert) fail(`achtergrond doet nog mee: ${JSON.stringify(inert)}`);
  else step('de pagina achter de dialoog is inert (niet te klikken of te focussen)');
  await axe(page, 'open dialoog');
  await page.keyboard.press('Escape');
  await until(async () => (await dlg.count()) === 0, 'dialoog dicht met Escape');
  await until(async () => (await focusInfo(page)).label === 'Meer opties', 'focus terug op Meer opties', 3000);
  if ((await page.evaluate(() => document.querySelectorAll('[inert]').length)) !== 0) fail('inert bleef staan na sluiten');
  if (app.ctx.store.thread(threadId)) step('Escape sloot de dialoog (niets gewist); focus terug op "Meer opties", het menu zelf was al dicht');
  else fail('Escape wiste de geschiedenis');

  // ---- the confirmation dialog (askConfirm) ----
  await more.click();
  await page.getByRole('button', { name: 'Bot beheren', exact: true }).click();
  await page.getByRole('button', { name: 'Bot archiveren' }).click();
  const ask = page.getByRole('alertdialog');
  await ask.waitFor({ timeout: 5000 });
  if (!(await ask.getAttribute('aria-labelledby'))) fail('bevestiging heeft geen naam');
  f = await focusInfo(page);
  if (f.label !== 'Archiveren') fail(`focus in de bevestiging staat op "${f.label}", niet op Archiveren`);
  for (let i = 0; i < 4; i++) await page.keyboard.press('Tab');
  if (!(await focusInfo(page)).inDialog) fail('Tab liet de bevestiging los');
  await page.keyboard.press('Escape');
  await until(async () => (await ask.count()) === 0, 'bevestiging dicht');
  await until(async () => (await focusInfo(page)).label === 'Meer opties', 'focus terug na bevestiging', 3000);
  if (app.ctx.store.agent(bot.id)?.archived) fail('Escape archiveerde de bot');
  else step('bevestiging: focus op de knop, blijft erin, Escape = annuleren, focus terug');
  // backdrop click closes a dialog, a press inside does not
  await more.click();
  await page.getByRole('button', { name: 'Bot beheren', exact: true }).click();
  await page.getByRole('button', { name: 'Geschiedenis wissen…' }).click();
  await dlg.waitFor({ timeout: 5000 });
  await dlg.getByText('Dit gaat weg').click();
  if ((await dlg.count()) !== 1) fail('klik in de dialoog sloot hem');
  await page.mouse.click(8, 8);
  await until(async () => (await dlg.count()) === 0, 'klik op de achtergrond sluit de dialoog');
  step('klik in de dialoog laat hem open, klik op de achtergrond sluit hem');

  // ---- phone ----
  const ph = await browser.newPage({ viewport: { width: 390, height: 800 }, hasTouch: true, isMobile: true });
  watch(ph);
  await ph.goto(`${app.url}/#token=${token}`);
  await ph.goto(`${app.url}/#/t/${threadId}`);
  await ph.locator('.katex-display').first().waitFor({ timeout: 15000 });
  const wide = await ph.evaluate(() => document.documentElement.scrollWidth);
  if (wide > 392) fail(`telefoon: pagina scrolt horizontaal (${wide})`);
  await ph.getByRole('button', { name: 'Meer opties' }).tap();
  await ph.getByRole('button', { name: 'Bot beheren', exact: true }).tap();
  await ph.getByRole('button', { name: 'Geschiedenis wissen…' }).tap();
  const pdlg = ph.getByRole('dialog', { name: 'Geschiedenis van Rekenbot wissen?' });
  await pdlg.waitFor({ timeout: 5000 });
  const pf = await ph.evaluate(() => ({ tag: document.activeElement?.tagName, role: document.activeElement?.getAttribute('role') }));
  if (pf.tag === 'INPUT' || pf.tag === 'TEXTAREA') fail('telefoon: focus op een tekstveld (toetsenbord springt op)');
  else step(`telefoon: formule past (${wide} px), dialoog opent zonder toetsenbord (focus op ${pf.role || pf.tag})`);
  await ph.getByRole('button', { name: 'Sluiten' }).tap();
  await until(async () => (await pdlg.count()) === 0, 'telefoon: dialoog dicht');

  if (errors.length) fail(`fouten in de console: ${[...new Set(errors)].slice(0, 5).join(' | ')}`);
  else step('geen fouten in de console');
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
console.log(process.exitCode ? '\nDialogen en formules: NIET in orde' : '\nDialogen en formules: in orde');
