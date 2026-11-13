// The download buttons of free speech, in the real screens, on a fresh install: the microphone button (dictation) and
// "Klaarmaken en bellen" (the free live call). Nothing is really downloaded: the models come from a small local test
// server with fake files, the recogniser and the voice are fakes, the call parts count as present. A fake microphone
// (a WAV file) talks. Checks: one clear download with its size, progress, and the function works right after.
//   npm run build:ui && node --import tsx tests/e2e/voice-download-buttons.mjs
// Env: TEAMBOT_E2E_BROWSER=chrome|msedge.
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright-core');
const AdmZip = require('adm-zip');
const { startTestApp } = await import('../helpers.ts');
const { fakeStt, fakeTts } = await import('../voice-fakes.ts');
const { setLocalCatalog } = await import('../../server/modules/voice/local/service.ts');
const { LOCAL_MODELS } = await import('../../server/modules/voice/local/catalog.ts');
const { setDuplexTestDeps } = await import('../../server/modules/voice/duplex/index.ts');
const { energyVad } = await import('../../server/modules/voice/duplex/vad.ts');
const { silenceOnlyTurn } = await import('../../server/modules/voice/duplex/turn.ts');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- a local "model server" with fake files ----------
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const files = new Map();
const server = http.createServer((req, res) => {
  const f = files.get(req.url || '');
  if (!f) return res.writeHead(404).end();
  // Slow enough that the progress is visible.
  res.writeHead(200, { 'content-length': f.length });
  let o = 0;
  const step = () => {
    if (o >= f.length) return res.end();
    res.write(f.subarray(o, o + 100_000));
    o += 100_000;
    setTimeout(step, 60);
  };
  step();
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;
const serve = (name, body) => (files.set('/' + name, body), { path: name, url: `${base}/${name}`, sha256: sha(body), size: body.length });
const zip = new AdmZip();
zip.addFile('piper/piper.exe', Buffer.from('nep'));
setLocalCatalog(
  LOCAL_MODELS.map((m) =>
    m.id === 'parakeet-tdt-0.6b-v3'
      ? { ...m, files: [serve('encoder.int8.onnx', crypto.randomBytes(1_500_000)), serve('tokens.txt', Buffer.from('a 0\nb 1\n'))] }
      : m.id === 'piper-runtime'
        ? { ...m, platforms: undefined, files: [{ ...serve('piper.zip', zip.toBuffer()), extract: 'zip' }] }
        : m.id === 'nl_NL-alex-medium'
          ? { ...m, files: [serve('alex.onnx', crypto.randomBytes(800_000)), serve('alex.onnx.json', Buffer.from('{}'))] }
          : m,
  ),
);
const stt = fakeStt(() => 'Zet koffie op de boodschappenlijst');
const tts = fakeTts();
setDuplexTestDeps({ partsReady: true, vad: () => energyVad({ minSilence: 0.3, minSpeech: 0.1, threshold: 0.5, level: 0.01 }), turn: silenceOnlyTurn });

/** 48 kHz mono WAV for the browser's fake microphone: silence, two seconds of a speech-like tone, silence. */
function micWav() {
  const rate = 48000;
  const n = rate * 30;
  const pcm = Buffer.alloc(n * 2);
  for (let i = rate; i < rate * 3; i++) pcm.writeInt16LE(Math.round(9000 * Math.abs(Math.sin((Math.PI * 4 * i) / rate)) * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'latin1'); h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-voice-buttons-'));
if (!process.env.TEAMBOT_UI_DIR) {
  fs.cpSync(path.resolve('dist/ui'), path.join(work, 'ui'), { recursive: true });
  process.env.TEAMBOT_UI_DIR = path.join(work, 'ui');
}
const micFile = path.join(work, 'mic.wav');
fs.writeFileSync(micFile, micWav());
const t = await startTestApp({ mode: 'desktop' });
let browser;
try {
  const bot = await t.agent({ name: 'Sam' });
  const th = await t.api('POST', '/threads', { agentId: bot.id });
  browser = await chromium.launch({
    channel: process.env.TEAMBOT_E2E_BROWSER || (process.platform === 'win32' ? 'msedge' : 'chrome'),
    headless: true,
    args: ['--use-fake-ui-for-media-stream', '--use-fake-device-for-media-stream', `--use-file-for-fake-audio-capture=${micFile}`, '--autoplay-policy=no-user-gesture-required', '--mute-audio'],
  });
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 900 }, permissions: ['microphone'], locale: 'nl-NL' });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${t.app.url}/#token=${t.token}`);
  await page.goto(`${t.app.url}/#/t/${th.id}`);

  // ---------- 1. dictation: the microphone button ----------
  const mic = page.getByRole('button', { name: /^Dicteren/ });
  await mic.click({ timeout: 15000 });
  const setup = page.getByRole('dialog', { name: 'Gratis spraakherkenning op deze computer' });
  await setup.waitFor({ timeout: 10000 }).catch(() => {});
  const dl = setup.getByRole('button', { name: /^Downloaden \(\d+ MB\)$/ });
  check('dicteren: de microfoonknop biedt één knop "Downloaden" met de grootte', (await dl.count()) === 1, await setup.innerText().catch(() => ''));
  await dl.click();
  const bar = await setup.getByRole('progressbar').first().waitFor({ timeout: 5000 }).then(() => true, () => false);
  check('dicteren: voortgang tijdens het downloaden', bar);
  await setup.getByRole('button', { name: 'Klaar — probeer het nu' }).click({ timeout: 30000 });
  await sleep(500);
  await mic.click();
  await page.getByText('Microfoon aan').waitFor({ timeout: 10000 }).catch(() => {});
  await sleep(3500);
  await page.getByRole('button', { name: 'Klaar', exact: true }).click({ timeout: 5000 }).catch(() => {});
  let typed = '';
  for (let i = 0; i < 40 && !/koffie/.test(typed); i++) {
    typed = await page.locator('textarea').first().inputValue().catch(() => '');
    await sleep(250);
  }
  check('dicteren: meteen na het downloaden komt de tekst in het berichtveld', /Zet koffie op de boodschappenlijst/.test(typed), typed);

  // ---------- 2. the free live call: "Klaarmaken en bellen" ----------
  await page.getByRole('button', { name: 'Live praten' }).click();
  const dlg = page.getByRole('dialog', { name: 'Praten met Sam' });
  const choice = dlg.getByRole('radio', { name: /Live gesprek, gratis/ });
  await choice.waitFor({ timeout: 10000 });
  const said = await choice.innerText();
  check('bellen: het gratis gesprek zegt wat er nog moet, met de grootte en de knop', /Nog niet klaar\. Eénmalige download \(\d+ MB\)/.test(said) && /Klaarmaken en bellen/.test(said) && !/Instellingen › Spraak/.test(said), said.replace(/\s+/g, ' '));
  await page.getByRole('button', { name: 'Klaarmaken en bellen' }).click();
  const setup2 = page.getByRole('dialog', { name: 'Gratis spraakherkenning op deze computer' });
  const dl2 = setup2.getByRole('button', { name: /^Downloaden en bellen \(\d+ MB\)$/ });
  await dl2.waitFor({ timeout: 10000 }).catch(() => {});
  check('bellen: één knop "Downloaden en bellen" met de grootte', (await dl2.count()) === 1, await setup2.innerText().catch(() => ''));
  await dl2.click();
  const live = page.getByRole('dialog', { name: 'Live gesprek met Sam' });
  const started = await live.waitFor({ timeout: 40000 }).then(() => true, () => false);
  check('bellen: na het downloaden start het gesprek vanzelf (geen tweede tik)', started);
  const call = t.app.ctx.store.one("SELECT status, mode FROM voice_calls ORDER BY started_at DESC LIMIT 1");
  check('bellen: een echt gesprek loopt', call?.status === 'active' && call?.mode === 'duplex', JSON.stringify(call));
  if (started) {
    await live.getByRole('button', { name: 'Ophangen' }).click();
    await page.getByText('Gesprek beëindigd').first().waitFor({ timeout: 10000 }).catch(() => {});
  }
  check('geen fouten in de pagina', !errors.length, errors.join(' | ').slice(0, 300));
} finally {
  await browser?.close().catch(() => {});
  await t.close();
  stt.restore();
  tts.restore();
  setDuplexTestDeps(null);
  setLocalCatalog(null);
  server.close();
  fs.rmSync(work, { recursive: true, force: true });
}
const bad = results.filter((r) => !r).length;
console.log(bad ? `\n${bad} van ${results.length} controles mislukt` : `\nAlle ${results.length} controles geslaagd`);
process.exit(bad ? 1 : 0);
