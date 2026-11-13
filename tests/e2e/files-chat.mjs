// End-to-end check (release gate, part of npm run e2e) of:
//   1. the Files page previews: pdf pages (pdf.js), picture, markdown, text, audio player, a file without preview, with
//      "Openen" and "Downloaden" on signed links (never the session token in a URL), desktop and phone;
//   2. a pdf a bot shared in the chat opens in the same preview;
//   3. Ctrl+F in a conversation (highlights, next/previous, Esc);
//   4. the "/" and "$" menu in the composer (search, pick a skill or command, keyboard and touch).
// Starts TeamBot (desktop mode, temp data dir) and drives Edge/Chrome headless with Playwright.
// Usage: npm run build:ui && node --import tsx tests/e2e/files-chat.mjs   (TB_SHOTS_DIR=<dir> for the screenshots)
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const { createApp } = await import('./server.mjs');
const { registerAttachment } = await import('../../server/tools/builtin/files.ts');
const { LOCAL_MODELS } = await import('../../server/modules/voice/local/catalog.ts');
const { markInstalled, fakeStt } = await import('../voice-fakes.ts');

const step = (s) => console.log(`• ${s}`);
const fail = (s) => {
  console.error(`✗ ${s}`);
  process.exitCode = 1;
};
const shots = process.env.TB_SHOTS_DIR || path.resolve('.data/e2e-shots/files-chat');
fs.mkdirSync(shots, { recursive: true });

/** A small, valid two-page pdf (text in Helvetica), built by hand so the test needs no tools. */
export function makePdf(pages) {
  const objs = [];
  const add = (s) => objs.push(s) && objs.length;
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids = [];
  for (const lines of pages) {
    const body = ['BT', '/F1 28 Tf', '72 760 Td'].concat(lines.flatMap((l, i) => (i ? ['0 -40 Td', `(${l}) Tj`] : [`(${l}) Tj`]))).concat(['ET', '0.2 0.4 0.9 rg 72 540 220 90 re f']).join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offs = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

/** A small PNG (a blue/orange block), without an image library. */
function makePng(w = 120, h = 80) {
  const crc = (b) => {
    let c = ~0;
    for (const x of b) {
      c ^= x;
      for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    return ~c >>> 0;
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const o = y * (w * 3 + 1) + 1 + x * 3;
      const left = x < w / 2;
      raw[o] = left ? 40 : 240;
      raw[o + 1] = left ? 90 : 140;
      raw[o + 2] = left ? 220 : 40;
    }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-e2e-files-'));
const app = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true });
const token = app.ctx.auth.ensureLocalOwner();
const owner = app.ctx.auth.owner();
const bot = app.ctx.store.createAgent(owner.id, { name: 'Offertebot', role: 'Test', avatar: '📄' });
const ws = bot.workspace;
const pdf = makePdf([['Offerte VeloMax', 'Bakfiets: 2.450 euro'], ['Pagina twee', 'Levering in week 12']]);
fs.writeFileSync(path.join(ws, 'offerte-velomax.pdf'), pdf);
fs.writeFileSync(path.join(ws, 'foto.png'), makePng());
fs.writeFileSync(path.join(ws, 'notities.md'), '# Notities\n\n- **Bakfiets** bestellen\n- Levering in week 12\n');
fs.writeFileSync(path.join(ws, 'logboek.txt'), 'regel 1\nregel 2\n');
fs.copyFileSync(path.resolve('tests/fixtures/toon-16k.ogg'), path.join(ws, 'geluid.ogg'));
fs.writeFileSync(path.join(ws, 'rapport.docx'), Buffer.concat([Buffer.from('PK\x03\x04'), Buffer.alloc(200, 7)]));

// A fake OpenAI-compatible model: loads the skill when the turn says the user picked one, then answers.
const modelSeen = [];
const fake = http.createServer((req, res) => {
  let body = '';
  req.on('data', (d) => (body += d));
  req.on('end', () => {
    if (req.url.endsWith('/models')) return res.end(JSON.stringify({ data: [{ id: 'nep-model' }] }));
    const j = JSON.parse(body || '{}');
    const text = (j.messages || []).map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content || ''))).join('\n');
    modelSeen.push(text);
    const toolDone = (j.messages || []).some((m) => m.role === 'tool');
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
    if (!toolDone && /koos voor dit bericht de skill “brand-guidelines”/.test(text)) {
      send({ id: 'c1', choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: 'call_s', type: 'function', function: { name: 'skill_load', arguments: JSON.stringify({ name: 'brand-guidelines' }) } }] } }] });
      send({ id: 'c1', choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] });
    } else {
      send({ id: 'c2', choices: [{ index: 0, delta: { content: toolDone ? 'Poster klaar in #d97757 met Poppins.' : 'Hallo! Wat kan ik doen?' } }] });
      send({ id: 'c2', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
    }
    res.end('data: [DONE]\n\n');
  });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const prov = app.ctx.providers.create(owner.id, { kind: 'openai-compatible', name: 'Nep-model', base_url: `http://127.0.0.1:${fake.address().port}/v1` });
const writer = app.ctx.store.createAgent(owner.id, { name: 'Schrijver', role: 'Teksten', provider_id: prov.id, model: 'nep-model', access_mode: 'auto', tool_groups: ['files', 'skills'] });
const helper = app.ctx.store.createAgent(owner.id, { name: 'Assistent', role: 'Hulp', provider_id: prov.id, model: 'nep-model', access_mode: 'auto' });
const researcher = app.ctx.store.createAgent(owner.id, { name: 'Onderzoeker', role: 'Onderzoek', provider_id: prov.id, model: 'nep-model', access_mode: 'auto' });
const H = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
const call = async (method, p, body) => {
  const r = await fetch(`${app.url}/api${p}`, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`${method} ${p}: ${r.status} ${j.error}`);
  return j;
};
const staged = await call('POST', '/skills/import/preview', { kind: 'paste', text: '---\nname: brand-guidelines\ndescription: Huisstijl met kleuren en lettertypen.\n---\n\n# Huisstijl\n\nGebruik altijd #d97757 en Poppins.\n' });
const skillId = (await call('POST', '/skills/import/commit', { stagingId: staged.stagingId })).results[0].skillId;
await call('PUT', `/skills/agents/${writer.id}`, { skillIds: [skillId] });
const writerThread = await call('POST', '/threads', { agentId: writer.id });
const roomThread = (await call('POST', '/rooms', { name: 'Fietsteam', mode: 'lead', agentIds: [helper.id, researcher.id] })).threadId;

/** A 16 kHz mono WAV for the fake microphone: silence, a clear tone (the VAD hears "speech"), silence. */
function micWav() {
  const rate = 16000;
  const parts = [{ s: 1.5, tone: false }, { s: 1.6, tone: true }, { s: 40, tone: false }];
  const n = parts.reduce((a, p) => a + Math.round(p.s * rate), 0);
  const data = Buffer.alloc(n * 2);
  let o = 0;
  for (const p of parts)
    for (let i = 0; i < Math.round(p.s * rate); i++, o += 2) data.writeInt16LE(p.tone ? Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 14000) : 0, o);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + data.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}
const micFile = path.join(dir, 'microfoon.wav');
fs.writeFileSync(micFile, micWav());

step(`TeamBot op ${app.url}`);
const browser = await chromium.launch({ channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'), headless: true });
const errors = [];
const requests = [];
try {
  const page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && !/favicon|ERR_CONNECTION_REFUSED|status of 40[14]/.test(m.text()) && errors.push(m.text()));
  page.on('request', (r) => requests.push(r.url()));
  await page.goto(`${app.url}/#token=${token}`);
  await page.getByRole('navigation').first().waitFor({ timeout: 15000 });

  // ---------------------------------------------------------------- 1. Files page previews
  await page.goto(`${app.url}/#/m/folders/${bot.id}`);
  await page.getByRole('button', { name: /offerte-velomax\.pdf/ }).click();
  const dlg = page.getByRole('dialog');
  await dlg.getByText('Pagina 1 van 2').waitFor({ timeout: 15000 });
  // The first page is really drawn (dark text pixels on the canvas), not raw pdf text.
  await page.waitForFunction(() => {
    const c = document.querySelector('[role=dialog] canvas[aria-label="Pagina 1 van 2"]');
    if (!c || !c.width) return false;
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 16) if (d[i] < 90 && d[i + 1] < 90 && d[i + 2] < 90) dark++;
    return dark > 50;
  }, null, { timeout: 15000 }).then(() => step('pdf: pagina 1 als echte pagina getekend (pdf.js)'), () => fail('pdf: pagina 1 niet getekend'));
  if (await dlg.getByText('%PDF').count()) fail('pdf: ruwe pdf-tekst zichtbaar');
  const srText = await dlg.locator('.sr-only').first().textContent({ timeout: 10000 }).catch(() => '');
  if (!/Offerte VeloMax/.test(srText || '')) fail(`pdf: tekst van de pagina niet voor schermlezers (${srText})`);
  const dl = await dlg.getByRole('link', { name: 'Downloaden' }).getAttribute('href');
  if (!dl || dl.includes(token) || !/tbsig=/.test(dl)) fail(`downloadlink zonder handtekening of met token: ${dl}`);
  const dlRes = await fetch(app.url + dl);
  if (dlRes.status !== 200 || !/^attachment/.test(dlRes.headers.get('content-disposition') || '') || Buffer.from(await dlRes.arrayBuffer()).length !== pdf.length) fail(`downloaden: ${dlRes.status} ${dlRes.headers.get('content-disposition')}`);
  else step('pdf: Downloaden via een gesigneerde link (geen sessietoken)');
  if (await dlg.getByRole('link', { name: 'Openen' }).count()) fail('pdf: "Openen" hoort niet bij een pdf (die wordt hier al getoond)');
  await dlg.getByRole('button', { name: 'Groter' }).click();
  await dlg.getByText('125%').waitFor({ timeout: 3000 }).catch(() => fail('pdf: zoomen werkt niet'));
  await dlg.getByRole('button', { name: 'Passend' }).click();
  await page.screenshot({ path: path.join(shots, 'files-pdf-desktop.png') });
  await dlg.locator('[data-testid=pdf-pages]').evaluate((el) => el.scrollTo(0, el.scrollHeight));
  await dlg.getByText('Pagina 2 van 2').waitFor({ timeout: 8000 }).then(() => step('pdf: scrollen naar pagina 2'), () => fail('pdf: paginateller volgt het scrollen niet'));
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /foto\.png/ }).click();
  const img = dlg.locator('img[alt="foto.png"]');
  await page.waitForFunction(() => (document.querySelector('[role=dialog] img[alt="foto.png"]')?.naturalWidth || 0) > 0, null, { timeout: 10000 }).then(() => step('afbeelding: voorbeeld geladen'), () => fail('afbeelding: niet geladen'));
  const openHref = await dlg.getByRole('link', { name: 'Openen' }).getAttribute('href');
  const openRes = await fetch(app.url + openHref);
  if (openRes.headers.get('content-type') !== 'image/png' || !/^inline/.test(openRes.headers.get('content-disposition') || '') || !/sandbox/.test(openRes.headers.get('content-security-policy') || '')) fail(`afbeelding openen: ${openRes.headers.get('content-type')} ${openRes.headers.get('content-disposition')}`);
  else step('afbeelding: Openen toont het bestand zelf (inline, afgeschermd)');
  await img.screenshot({ path: path.join(shots, 'files-image.png') }).catch(() => {});
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /notities\.md/ }).click();
  await dlg.getByRole('heading', { name: 'Notities' }).waitFor({ timeout: 8000 }).then(() => step('markdown: opgemaakt getoond'), () => fail('markdown: niet opgemaakt'));
  await page.screenshot({ path: path.join(shots, 'files-markdown-desktop.png') });
  await dlg.getByRole('tab', { name: 'Tekst' }).click();
  await dlg.getByText('- **Bakfiets** bestellen').waitFor({ timeout: 3000 }).catch(() => fail('markdown: tekstweergave'));
  if ((await dlg.getByRole('tab', { name: 'Tekst' }).getAttribute('aria-selected')) !== 'true') fail('markdown: tab Tekst niet gekozen');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /geluid\.ogg/ }).click();
  const audioSrc = await dlg.locator('audio').getAttribute('src', { timeout: 8000 });
  const ranged = await fetch(app.url + audioSrc, { headers: { range: 'bytes=0-9' } });
  if (ranged.status !== 206 || (await ranged.arrayBuffer()).byteLength !== 10) fail(`audio: geen bereikverzoeken (${ranged.status})`);
  else step('audio: speler met spoelen (bereikverzoeken)');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: /rapport\.docx/ }).click();
  await dlg.getByText(/geen voorbeeld tonen/).waitFor({ timeout: 8000 }).then(() => step('docx: eerlijk "geen voorbeeld" met Downloaden'), () => fail('docx: geen nette melding'));
  if (!(await dlg.getByRole('link', { name: 'Downloaden' }).count())) fail('docx: geen Downloaden');
  await page.keyboard.press('Escape');

  if (requests.some((u) => u.includes(token))) fail('een verzoek bevatte de sessietoken in de URL');
  else step('geen enkel verzoek met de sessietoken in de URL');

  // ---------------------------------------------------------------- 2. pdf shared by a bot in the chat
  const thread = app.ctx.chat.threadForAgent(owner.id, bot.id);
  const ref = registerAttachment(app.ctx, owner.id, thread.id, path.join(ws, 'offerte-velomax.pdf'), 'offerte-velomax.pdf');
  app.ctx.chat.addAgentMessage(thread, bot, 'Hier is de offerte.', { attachments: [ref] });
  await page.goto(`${app.url}/#/t/${thread.id}`);
  await page.getByRole('button', { name: /offerte-velomax\.pdf/ }).first().click();
  await dlg.getByText('Pagina 1 van 2').waitFor({ timeout: 15000 }).then(() => step('chat: een gedeelde pdf opent in het voorbeeld'), () => fail('chat: pdf-bijlage opent geen voorbeeld'));
  await page.screenshot({ path: path.join(shots, 'chat-pdf-desktop.png') });
  await page.keyboard.press('Escape');

  // ---------------------------------------------------------------- phone
  const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  phone.on('pageerror', (e) => errors.push(e.message));
  await phone.goto(`${app.url}/#token=${token}`);
  await phone.waitForTimeout(800);
  await phone.goto(`${app.url}/#/m/folders/${bot.id}`);
  await phone.getByRole('button', { name: /offerte-velomax\.pdf/ }).click();
  const pd = phone.getByRole('dialog');
  await pd.getByText('Pagina 1 van 2').waitFor({ timeout: 15000 }).catch(() => fail('telefoon: pdf-voorbeeld'));
  await phone.waitForTimeout(800);
  const over = await phone.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over > 1) fail(`telefoon: horizontale overflow ${over}px`);
  const cw = await pd.locator('canvas').first().evaluate((c) => c.getBoundingClientRect().width);
  if (cw > 390 || cw < 250) fail(`telefoon: pdf-pagina past niet in de breedte (${cw}px)`);
  else step(`telefoon: pdf past in de breedte (${Math.round(cw)} px), geen horizontaal scrollen`);
  await phone.screenshot({ path: path.join(shots, 'files-pdf-phone.png') });
  await phone.keyboard.press('Escape');
  await phone.getByRole('button', { name: /foto\.png/ }).click();
  await phone.waitForTimeout(700);
  await phone.screenshot({ path: path.join(shots, 'files-image-phone.png') });
  await phone.keyboard.press('Escape');
  await phone.goto(`${app.url}/#/t/${thread.id}`);
  await phone.getByRole('button', { name: /offerte-velomax\.pdf/ }).first().click();
  await pd.getByText('Pagina 1 van 2').waitFor({ timeout: 15000 }).then(() => step('telefoon: pdf uit de chat opent in het voorbeeld'), () => fail('telefoon: chat-pdf'));
  await phone.screenshot({ path: path.join(shots, 'chat-pdf-phone.png') });

  // ---------------------------------------------------------------- 3. Ctrl+F in a conversation
  for (const t of ['De bakfiets kost 2.450 euro, inclusief levering.', 'Een fiets met trapondersteuning is in week 12 klaar.', 'De fietsenmaker belt je morgen.'])
    app.ctx.chat.addAgentMessage(thread, bot, t, {});
  await page.goto(`${app.url}/#/t/${thread.id}`);
  await page.locator('p', { hasText: 'De fietsenmaker belt je morgen.' }).waitFor({ timeout: 10000 });
  await page.keyboard.press('Control+f');
  const find = page.getByRole('searchbox').or(page.getByLabel('Zoeken in dit gesprek'));
  await find.first().waitFor({ timeout: 5000 });
  if (!(await find.first().evaluate((el) => el === document.activeElement))) fail('Ctrl+F: het zoekveld heeft geen focus');
  await page.keyboard.type('fiets');
  await page.getByText('1 van 3').waitFor({ timeout: 5000 }).then(() => step('Ctrl+F: 3 treffers ("1 van 3")'), async () => fail(`Ctrl+F: telling klopt niet (${await page.locator('[data-find-skip]').innerText()})`));
  const marked = await page.evaluate(() => [(CSS).highlights?.get('tb-find')?.size || 0, (CSS).highlights?.get('tb-find-current')?.size || 0]);
  if (marked[0] !== 3 || marked[1] !== 1) fail(`Ctrl+F: markeringen ${JSON.stringify(marked)}`);
  else step('Ctrl+F: alle treffers gemarkeerd, de huidige apart');
  await page.keyboard.press('Enter');
  await page.getByText('2 van 3').waitFor({ timeout: 3000 }).catch(() => fail('Ctrl+F: Enter springt niet naar de volgende'));
  await page.screenshot({ path: path.join(shots, 'find-desktop.png') });
  await page.keyboard.press('Shift+Enter');
  await page.getByText('1 van 3').waitFor({ timeout: 3000 }).catch(() => fail('Ctrl+F: Shift+Enter springt niet terug'));
  await page.keyboard.press('Escape');
  await page.waitForTimeout(200);
  if (await page.getByLabel('Zoeken in dit gesprek').count()) fail('Ctrl+F: Esc sluit niet');
  if (await page.evaluate(() => (CSS).highlights?.has('tb-find'))) fail('Ctrl+F: markeringen blijven staan na sluiten');
  step('Ctrl+F: Enter / Shift+Enter springen, Esc sluit en wist de markeringen');

  // ---------------------------------------------------------------- 4. "/" and "$" menu in the composer
  await page.goto(`${app.url}/#/t/${writerThread.id}`);
  const box = page.getByLabel('Bericht', { exact: true });
  await box.click();
  await box.type('/');
  const menu = page.getByRole('listbox');
  await menu.getByRole('option', { name: /\/brand-guidelines/ }).waitFor({ timeout: 8000 }).then(() => step('"/" toont de skills van de bot'), () => fail('"/": geen skill in het menu'));
  if (!(await menu.getByRole('option', { name: /Zoeken in dit gesprek/ }).count())) fail('"/": opdrachten ontbreken');
  await page.screenshot({ path: path.join(shots, 'slash-menu-desktop.png') });
  await box.type('bra');
  if ((await menu.getByRole('option').count()) !== 1) fail('"/bra": zoeken filtert niet');
  await page.keyboard.press('Enter');
  if ((await box.inputValue()) !== '/brand-guidelines ') fail(`"/" kiezen: ${JSON.stringify(await box.inputValue())}`);
  await box.type('maak een poster voor de winkel');
  await page.keyboard.press('Enter');
  await page.locator('p', { hasText: 'Poster klaar in #d97757 met Poppins.' }).waitFor({ timeout: 20000 }).then(() => step('gekozen skill wordt gebruikt: de bot laadt hem en volgt hem'), () => fail('skill: geen antwoord met de huisstijl'));
  if (!modelSeen.some((x) => /koos voor dit bericht de skill “brand-guidelines”/.test(x))) fail('skill: het model kreeg de keuze niet door');
  const sentText = app.ctx.store.messages(writerThread.id).find((m) => m.role === 'user')?.content;
  if (sentText !== '/brand-guidelines maak een poster voor de winkel') fail(`skill: verstuurde tekst ${JSON.stringify(sentText)}`);
  await page.screenshot({ path: path.join(shots, 'slash-skill-used-desktop.png') });
  // A command from the menu.
  await box.type('/zoek');
  await page.keyboard.press('Enter');
  await page.getByLabel('Zoeken in dit gesprek').waitFor({ timeout: 3000 }).then(() => step('"/zoek" opent Zoeken in dit gesprek'), () => fail('"/zoek": geen zoekbalk'));
  if ((await box.inputValue()) !== '') fail('een opdracht laat tekst achter in het invoerveld');
  await page.keyboard.press('Escape');

  const phone2 = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  phone2.on('pageerror', (e) => errors.push(e.message));
  await phone2.goto(`${app.url}/#token=${token}`);
  await phone2.waitForTimeout(800);
  await phone2.goto(`${app.url}/#/t/${writerThread.id}`);
  const pbox = phone2.getByLabel('Bericht', { exact: true });
  await pbox.tap();
  await pbox.type('schrijf dit met $');
  const pmenu = phone2.getByRole('listbox');
  await pmenu.getByRole('option', { name: /\$brand-guidelines/ }).waitFor({ timeout: 8000 }).catch(() => fail('telefoon: "$" toont geen skills'));
  if (await pmenu.getByRole('option', { name: /Zoeken in dit gesprek/ }).count()) fail('"$" hoort alleen skills te tonen');
  await phone2.screenshot({ path: path.join(shots, 'slash-menu-phone.png') });
  await pmenu.getByRole('option', { name: /\$brand-guidelines/ }).tap();
  if ((await pbox.inputValue()) !== 'schrijf dit met $brand-guidelines ') fail(`telefoon: tikken op een skill: ${JSON.stringify(await pbox.inputValue())}`);
  else step('telefoon: "$" toont de skills, tikken kiest');
  const over2 = await phone2.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  if (over2 > 1) fail(`telefoon: horizontale overflow ${over2}px met het menu`);
  await pbox.fill('');
  // Ctrl+F on a phone: through the menu.
  await phone2.goto(`${app.url}/#/t/${thread.id}`);
  await phone2.getByRole('button', { name: 'Meer opties' }).tap();
  await phone2.getByRole('button', { name: /Zoeken in dit gesprek/ }).tap();
  await phone2.getByLabel('Zoeken in dit gesprek').fill('fiets');
  await phone2.getByText('1 van 3').waitFor({ timeout: 5000 }).then(() => step('telefoon: zoeken in dit gesprek via het menu'), () => fail('telefoon: zoeken in gesprek'));
  await phone2.screenshot({ path: path.join(shots, 'find-phone.png') });
  await phone2.close();

  // ---------------------------------------------------------------- 5. group call: a name heard slightly wrong
  const voiceBrowser = await chromium.launch({
    channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'),
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}%noloop`],
  });
  try {
    const vp = await voiceBrowser.newPage({ viewport: { width: 1360, height: 900 } });
    vp.on('pageerror', (e) => errors.push(e.message));
    // Speech-to-text answers what a user said with a misheard name (the real recogniser is tested in voice:live).
    let heard = 0;
    await vp.route('**/api/voice/transcribe**', (r) => (heard++, r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'Onderzoek, hoe laat is het in Berlijn?', language: 'nl' }) })));
    await vp.goto(`${app.url}/#token=${token}`);
    await vp.waitForTimeout(800);
    await vp.goto(`${app.url}/#/t/${roomThread}`);
    // A fresh install has no speech recognition yet: the button offers its download (one button, with the size).
    await vp.getByRole('button', { name: 'Groepsgesprek (spraak)' }).click();
    const setup5 = vp.getByRole('dialog', { name: 'Gratis spraakherkenning op deze computer' });
    await setup5.getByRole('button', { name: /^Downloaden en bellen \(\d+ MB\)$/ }).waitFor({ timeout: 15000 }).then(() => step('groepsgesprek zonder spraakherkenning: één knop "Downloaden en bellen" met de grootte'), () => fail('groepsgesprek zonder spraakherkenning: geen knop "Downloaden en bellen"'));
    await setup5.getByRole('button', { name: 'Later' }).click();
    await setup5.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
    // From here the recogniser counts as downloaded (a stand-in: nothing is fetched, nothing real runs).
    for (const m of LOCAL_MODELS.filter((x) => x.kind === 'stt')) markInstalled(dir, m.id);
    fakeStt(() => 'Onderzoek, hoe laat is het in Berlijn?');
    await vp.reload();
    await vp.getByRole('button', { name: 'Groepsgesprek (spraak)' }).click();
    const call5 = vp.getByRole('dialog');
    // On a computer you hold the space bar while you talk (0.4): hold it while the fake microphone speaks.
    await call5.getByText('Houd de spatiebalk of de knop ingedrukt om te praten').waitFor({ timeout: 15000 }).catch(() => fail('groepsgesprek: geen "Houd de spatiebalk … ingedrukt"'));
    await vp.keyboard.down('Space');
    await call5.getByText('De groep luistert naar je').waitFor({ timeout: 3000 }).then(() => step('groepsgesprek: ingedrukt houden → "De groep luistert naar je"'), () => fail('groepsgesprek: luistert niet tijdens het ingedrukt houden'));
    await vp.waitForTimeout(1500);
    await vp.keyboard.up('Space');
    await call5.getByText(/Bedoel je/).waitFor({ timeout: 20000 }).then(() => step('groepsgesprek: een half verstane naam → "Bedoel je Onderzoeker?"'), () => fail(`groepsgesprek: geen vraag (stt ${heard}x)`));
    if (await call5.getByText(/Bedoel je/).count()) {
      await vp.screenshot({ path: path.join(shots, 'voice-name-confirm-desktop.png') });
      const before = app.ctx.store.messages(roomThread).filter((m) => m.role === 'user').length;
      if (before) fail('groepsgesprek: er ging al een bericht weg vóór de bevestiging');
      await call5.getByRole('button', { name: 'Ja, Onderzoeker' }).click();
      const sent = await (async () => {
        for (let i = 0; i < 40; i++) {
          const m = app.ctx.store.messages(roomThread).find((x) => x.role === 'user');
          if (m) return m.content;
          await new Promise((r) => setTimeout(r, 150));
        }
        return '';
      })();
      if (sent !== '@Onderzoeker hoe laat is het in Berlijn?') fail(`groepsgesprek: verstuurd ${JSON.stringify(sent)}`);
      else step('groepsgesprek: na "Ja" gaat het naar @Onderzoeker');
    }
    await call5.getByRole('button', { name: 'Ophangen' }).click();

    // The same question on a phone (a bottom sheet); hang up without answering: nothing is sent.
    const vph = await voiceBrowser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    vph.on('pageerror', (e) => errors.push(e.message));
    await vph.route('**/api/voice/transcribe**', (r) => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ text: 'Onderzoek, wat is het weer?', language: 'nl' }) }));
    await vph.goto(`${app.url}/#token=${token}`);
    await vph.waitForTimeout(800);
    await vph.goto(`${app.url}/#/t/${roomThread}`);
    const sentBefore = app.ctx.store.messages(roomThread).filter((m) => m.role === 'user').length;
    await vph.getByRole('button', { name: 'Groepsgesprek (spraak)' }).tap();
    const pcall = vph.getByRole('dialog');
    await pcall.getByText(/Bedoel je/).waitFor({ timeout: 20000 }).catch(() => fail('groepsgesprek op de telefoon: geen vraag'));
    await vph.screenshot({ path: path.join(shots, 'voice-name-confirm-phone.png') });
    const over5 = await vph.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over5 > 1) fail(`groepsgesprek op de telefoon: horizontale overflow ${over5}px`);
    await pcall.getByRole('button', { name: 'Ophangen' }).tap();
    await vph.waitForTimeout(300);
    if (app.ctx.store.messages(roomThread).filter((m) => m.role === 'user').length !== sentBefore) fail('ophangen tijdens de vraag verstuurde toch iets');
    else step('groepsgesprek op de telefoon: de vraag als onderblad; ophangen verstuurt niets');
  } finally {
    await voiceBrowser.close();
  }
  step(`schermafbeeldingen: ${shots}`);
} catch (e) {
  fail(e.stack || e.message);
} finally {
  await browser.close();
  await app.close();
  fake.closeAllConnections?.();
  fake.close();
  fs.rmSync(dir, { recursive: true, force: true });
}
if (errors.length) fail('console-fouten:\n  ' + errors.join('\n  '));
console.log(process.exitCode ? 'E2E BESTANDEN EN CHAT MISLUKT' : 'E2E BESTANDEN EN CHAT GESLAAGD');
