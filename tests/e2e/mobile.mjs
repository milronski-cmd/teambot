// Android/iPad check (MOB-05) with device emulation: share target (a real multipart POST navigation through the
// service worker, as the Android share sheet does), share page → conversation with attachment, and tablet layouts
// without horizontal scrolling. Usage: npm run build:ui && npm run mobile:check  [TEAMBOT_MOBILE_SHOTS=<dir>]
// In another interface language: npm run mobile:check -- --lang ar  (or TEAMBOT_LANG=de); right-to-left included.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium, devices } = require('playwright-core');
const { createApp } = await import('../../server/app.ts');
const { testLanguage } = await import('./lang.mjs');
const lang = testLanguage();
const { L } = lang;

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-mobile-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
await lang.apply(app, owner.id);
const agent = app.ctx.store.createAgent(owner.id, { name: 'Lezer', avatar: '📖', role: 'Test' });
const shots = process.env.TEAMBOT_MOBILE_SHOTS;
if (shots) fs.mkdirSync(shots, { recursive: true });
const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const sample = path.join(dir, 'notitie.txt');
fs.writeFileSync(sample, 'Boodschappen: melk, brood, koffie.\n');

try {
  // ---------------- Android phone: share target ----------------
  const phone = await browser.newContext({ ...devices['Pixel 7'], ...lang.contextOptions() });
  await lang.apply(app, owner.id, phone);
  const page = await phone.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(`${app.url}/#token=${token}`);
  await page.waitForFunction(() => navigator.serviceWorker?.controller || null, null, { timeout: 15_000 }).catch(async () => {
    await page.reload();
    await page.waitForFunction(() => navigator.serviceWorker?.controller || null, null, { timeout: 15_000 });
  });
  check('service worker beheert de pagina (installeerbare PWA)', await page.evaluate(() => !!navigator.serviceWorker.controller));
  const manifest = await (await fetch(`${app.url}/manifest.webmanifest`)).json();
  check('manifest heeft een deeldoel en snelkoppelingen', manifest.share_target?.action === '/share-target' && manifest.share_target?.method === 'POST' && manifest.shortcuts?.length >= 3);

  // What the OS share sheet does: a multipart POST navigation to the share target.
  await page.evaluate(() => {
    const f = document.createElement('form');
    f.method = 'POST';
    f.action = '/share-target';
    f.enctype = 'multipart/form-data';
    f.id = 'share-form';
    for (const [k, v] of [['title', 'Lijstje'], ['text', 'Kun je dit samenvatten?'], ['url', 'https://example.com/artikel']]) {
      const i = document.createElement('input');
      i.name = k;
      i.value = v;
      f.appendChild(i);
    }
    const file = document.createElement('input');
    file.type = 'file';
    file.name = 'files';
    file.id = 'share-file';
    f.appendChild(file);
    document.body.appendChild(f);
  });
  await page.setInputFiles('#share-file', sample);
  await Promise.all([page.waitForURL(/#\/m\/mobile\/delen\//, { timeout: 15_000 }), page.evaluate(() => (document.getElementById('share-form')).submit())]);
  await page.waitForSelector(`text=${L('Delen met TeamBot')}`, { timeout: 10_000 });
  const shareText = await page.locator('textarea').inputValue();
  check('deelpagina toont de gedeelde tekst en link', shareText.includes('Kun je dit samenvatten?') && shareText.includes('https://example.com/artikel'), JSON.stringify(shareText.slice(0, 80)));
  check('deelpagina toont het gedeelde bestand', (await page.locator('text=notitie.txt').count()) > 0);
  if (shots) await page.screenshot({ path: path.join(shots, `android-delen${lang.tag}.png`) });
  await page.selectOption('select', { value: `a:${agent.id}` });
  await Promise.all([page.waitForURL(/#\/t\//, { timeout: 15_000 }), page.getByRole('button', { name: L('Versturen') }).click()]);
  const threadId = page.url().split('#/t/')[1];
  const msgs = app.ctx.store.messages(threadId);
  const sent = msgs.find((m) => m.role === 'user');
  check('bericht met bijlage in een nieuw gesprek met de gekozen bot', !!sent && sent.content.includes('samenvatten') && (sent.parts.attachments || []).some((a) => a.name === 'notitie.txt'));
  const left = await page.evaluate(async () => (await (await caches.open('tb-share')).keys()).length);
  check('gedeelde gegevens na versturen van het apparaat verwijderd', left === 0, `${left} over`);
  const scroll = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  check('telefoon: geen horizontaal scrollen', scroll);
  check('geen paginafouten op de telefoon', errors.length === 0, errors.join(' | ').slice(0, 200));

  // ---------------- phone: usage sheet (context + limits) and what waits for you ----------------
  await page.evaluate((x) => (location.hash = x), `#/t/${threadId}`);
  await page.waitForTimeout(700);
  // The button's name is "<context> — gebruik en limieten": a substring match on the translated tail.
  await page.getByRole('button', { name: L('{0}{1} — gebruik en limieten', '', '').replace(/^[\s—-]+/, '') }).click();
  const sheet = page.getByRole('dialog');
  await sheet.waitFor({ timeout: 5000 });
  await page.waitForTimeout(500);
  const sheetInfo = await sheet.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { text: el.textContent || '', bottom: Math.round(r.bottom), left: Math.round(r.left), right: Math.round(r.right), vw: window.innerWidth, vh: window.innerHeight };
  });
  check('telefoon: gebruik-paneel als blad onderin, binnen het scherm', sheetInfo.left >= 0 && sheetInfo.right <= sheetInfo.vw + 1 && Math.abs(sheetInfo.bottom - sheetInfo.vh) <= 2, JSON.stringify({ ...sheetInfo, text: undefined }));
  const honest = lang.source ? /onbekend|gebruikt|nog geen AI-provider/ : lang.re('Context onbekend', 'Onbekend.', 'Deze bot heeft nog geen AI-provider.', 'Limieten: onbekend (gedeelde provider van iemand anders).');
  check('telefoon: paneel toont context en limieten (of eerlijk "onbekend")', lang.re('Context van dit gesprek').test(sheetInfo.text) && lang.re('Limieten').test(sheetInfo.text) && honest.test(sheetInfo.text), sheetInfo.text.slice(0, 160));
  if (shots) await page.screenshot({ path: path.join(shots, `android-gebruik${lang.tag}.png`) });
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  check('telefoon: paneel sluit met Escape', (await page.getByRole('dialog').count()) === 0);
  // Something waits for the owner: visible and decidable in "Nu bezig" on the phone.
  const ownerUser = app.ctx.auth.owner();
  const waiting = app.ctx.broker
    .request({ userId: ownerUser.id, agent: app.ctx.store.agent(agent.id), thread: app.ctx.store.thread(threadId), run: null, kind: 'tool', tool: 'write_file', input: {}, summary: 'Bestand schrijven: test.md', risk: 'write' })
    .catch(() => null);
  await page.evaluate((x) => (location.hash = x), '#/m/usage/status');
  await page.waitForSelector(`text=${L('Bestand schrijven: test.md')}`, { timeout: 8000 });
  const statusFits = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
  check('telefoon: "Nu bezig" toont wat op je wacht, zonder horizontaal scrollen', statusFits);
  if (shots) await page.screenshot({ path: path.join(shots, `android-nu-bezig${lang.tag}.png`) });
  // Touch targets on a phone are at least 44 px high (the approval buttons were 32 px).
  const btnH = await page.getByRole('button', { name: L('Weigeren'), exact: !lang.source }).evaluate((e) => e.getBoundingClientRect().height);
  check('telefoon: knoppen om goed te keuren zijn minstens 44 px hoog', btnH >= 44, `${btnH}px`);
  await page.getByRole('button', { name: L('Weigeren'), exact: !lang.source }).click();
  const decided = await Promise.race([waiting, new Promise((r) => setTimeout(() => r('time-out'), 8000))]);
  check('telefoon: weigeren vanuit "Nu bezig" komt bij de bot aan', decided && decided !== 'time-out' && decided.approved === false, JSON.stringify(decided));
  await phone.close();

  // ---------------- iPad portrait/landscape ----------------
  for (const [label, dev] of [
    ['iPad staand', { ...devices['iPad Pro 11'] }],
    ['iPad liggend', { ...devices['iPad Pro 11 landscape'] }],
  ]) {
    const ctx = await browser.newContext({ ...dev, ...lang.contextOptions() });
    await lang.apply(app, owner.id, ctx);
    const p = await ctx.newPage();
    await p.goto(`${app.url}/#token=${token}`);
    await p.waitForTimeout(900);
    let ok = true;
    const bad = [];
    for (const h of ['/', `/t/${threadId}`, '/agents', `/agents/${agent.id}`, '/settings/general', '/m/memory/', '/m/rooms/', '/inbox', '/m/teamdata/']) {
      await p.evaluate((x) => (location.hash = x), '#' + h);
      await p.waitForTimeout(450);
      const fits = await p.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth + 1);
      if (!fits) {
        ok = false;
        bad.push(h);
      }
    }
    const sidebar = await p.evaluate(() => {
      const a = document.querySelector('aside');
      return !!a && a.getBoundingClientRect().width > 0;
    });
    await p.evaluate((x) => (location.hash = x), `#/t/${threadId}`);
    await p.waitForTimeout(500);
    const composer = await p.evaluate(() => {
      const t = document.querySelector('textarea');
      if (!t) return false;
      const r = t.getBoundingClientRect();
      return r.bottom <= window.innerHeight && r.width > 200;
    });
    if (shots) await p.screenshot({ path: path.join(shots, `${label.replace(/\s+/g, '-')}${lang.tag}.png`) });
    check(`${label}: geen horizontaal scrollen`, ok, bad.join(', '));
    check(`${label}: zijbalk vast in beeld`, sidebar);
    check(`${label}: invoerveld zichtbaar en breed genoeg`, composer);
    await ctx.close();
  }
} catch (e) {
  check('onverwachte fout', false, e.message);
} finally {
  await browser.close();
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd (taal: ${lang.code}, ${lang.dir})`);
process.exit(failed ? 1 : 0);
