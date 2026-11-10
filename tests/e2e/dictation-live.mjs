// LIVE test of "dicteren in elk programma" (Windows): real Electron, the real pill window with microphone capture
// (Chromium's fake device plays generated Dutch speech), real local recognition, the real Windows helper and the real
// clipboard + Ctrl+V — but only into a dedicated test window of this test (keys are refused for any other process),
// without registering the real global key (the test presses it in code). The clipboard you had comes back.
//   npm run dictation:live      (TEAMBOT_VOICE_MODELS=<…/voice/models> reuses downloaded models)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
if (process.platform !== 'win32') {
  console.log('Alleen op Windows (de dicteerhulp gebruikt Windows-functies).');
  process.exit(0);
}
const { startTestApp } = await import('../helpers.ts');
const { parseWav, resample } = await import('../../server/modules/voice/local/pcm.ts');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const info = (s) => console.log(`  ${s}`);
const norm = (s) => String(s).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
function wer(ref, hyp) {
  const r = norm(ref).split(' ').filter(Boolean);
  const h = norm(hyp).split(' ').filter(Boolean);
  const d = Array.from({ length: r.length + 1 }, (_, i) => [i, ...Array(h.length).fill(0)]);
  for (let j = 1; j <= h.length; j++) d[0][j] = j;
  for (let i = 1; i <= r.length; i++) for (let j = 1; j <= h.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (r[i - 1] === h[j - 1] ? 0 : 1));
  return d[r.length][h.length] / Math.max(1, r.length);
}
/** Hard links where possible (models are big), else copies. */
function linkTree(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const a = path.join(from, e.name);
    const b = path.join(to, e.name);
    if (e.isDirectory()) linkTree(a, b);
    else {
      try {
        fs.linkSync(a, b);
      } catch {
        fs.copyFileSync(a, b);
      }
    }
  }
}

const SAY = 'Dit is een test van dicteren met de sneltoets in elk programma.';
const work = path.resolve('.data', `e2e-dictation-${Date.now()}`); // inside the project: the bundle finds node_modules
fs.mkdirSync(work, { recursive: true });
let t = null;
try {
  // ---------- models + test speech ----------
  t = await startTestApp({ mode: 'desktop' });
  const seed = process.env.TEAMBOT_VOICE_MODELS;
  const ids = ['parakeet-tdt-0.6b-v3', 'piper-runtime', 'nl_NL-alex-medium'];
  if (seed && fs.existsSync(seed)) for (const id of ids) if (fs.existsSync(path.join(seed, id))) linkTree(path.join(seed, id), path.join(t.dir, 'voice', 'models', id));
  for (const id of ['parakeet-tdt-0.6b-v3', 'nl_NL-alex-medium']) await t.api('POST', `/voice/local/models/${id}/install`);
  for (;;) {
    const v = await t.api('GET', '/voice/local');
    const ms = v.models.filter((m) => ids.includes(m.id));
    if (ms.some((m) => m.status === 'error')) throw new Error('download: ' + ms.map((m) => m.error).filter(Boolean).join('; '));
    if (ms.every((m) => m.status === 'installed')) break;
    await new Promise((r) => setTimeout(r, 1000));
  }
  const sp = await t.api('POST', '/voice/speak', { text: SAY });
  const voice = parseWav(Buffer.from(await (await fetch(`${t.app.url}/api/voice/tts/${sp.id}`, { headers: { authorization: `Bearer ${t.token}` } })).arrayBuffer()));
  const rate = 48000;
  const speech = resample(voice.samples, voice.sampleRate, rate);
  const pad = (s) => new Float32Array(Math.round(s * rate));
  const all = new Float32Array(pad(0.4).length + speech.length + pad(1.2).length);
  all.set(speech, pad(0.4).length);
  const pcm = Buffer.alloc(all.length * 2);
  for (let i = 0; i < all.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(all[i] * 32767))), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'latin1'); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVE', 8, 'latin1'); h.write('fmt ', 12, 'latin1');
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22); h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36, 'latin1'); h.writeUInt32LE(pcm.length, 40);
  const wav = path.join(work, 'mic.wav');
  fs.writeFileSync(wav, Buffer.concat([h, pcm]));
  linkTree(path.join(t.dir, 'voice', 'models', 'parakeet-tdt-0.6b-v3'), path.join(work, 'data', 'voice', 'models', 'parakeet-tdt-0.6b-v3'));
  await t.close();
  t = null;

  // ---------- bundle the Electron side ----------
  const pkg = JSON.parse(fs.readFileSync('package.json', 'utf8'));
  const external = [...Object.keys(pkg.dependencies || {}), 'electron'];
  const common = { bundle: true, platform: 'node', target: 'node22', external, logLevel: 'silent' };
  await build({ ...common, format: 'esm', entryPoints: ['tests/e2e/dictation-electron.ts'], outfile: path.join(work, 'main.mjs'), banner: { js: "import { createRequire as __cr } from 'node:module'; const require = __cr(import.meta.url);" } });
  await build({ ...common, format: 'cjs', entryPoints: ['desktop/dictation-preload.ts'], outfile: path.join(work, 'dictation-preload.cjs') });

  // ---------- run ----------
  const electron = require('electron');
  const t0 = Date.now();
  const child = spawn(electron, [path.join(work, 'main.mjs')], {
    env: { ...process.env, TB_DICT_DIR: work, TB_DICT_WAV: wav, TB_DICT_WAV_SEC: String(all.length / rate), ELECTRON_ENABLE_LOGGING: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let buf = '';
  let err = '';
  let pasted = '';
  child.stderr.on('data', (b) => (err = (err + b).slice(-4000)));
  await new Promise((resolve) => {
    const timer = setTimeout(() => (check('afgerond binnen 3 minuten', false), child.kill(), resolve()), 180_000);
    child.stdout.on('data', (b) => {
      buf += b;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('@@')) continue;
        const j = JSON.parse(line.slice(2));
        if (j.info) info(j.info);
        if (j.check) check(j.check, !!j.ok, j.detail);
        if (j.text !== undefined) pasted = j.text;
        if (j.end) {
          clearTimeout(timer);
          setTimeout(() => (child.kill(), resolve()), 6000).unref();
        }
      }
    });
    child.on('exit', () => (clearTimeout(timer), resolve()));
  });
  if (pasted) check('herkend wat er gezegd werd (WER ≤ 20 %)', wer(SAY, pasted) <= 0.2, `WER ${(wer(SAY, pasted) * 100).toFixed(0)} %`);
  info(`Electron-test duurde ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  if (results.some((r) => !r) && err.trim()) info(`stderr: ${err.trim().split('\n').slice(-6).join(' | ').slice(0, 800)}`);
} catch (e) {
  check('onverwachte fout', false, e?.stack || e?.message || String(e));
} finally {
  if (t) await t.close().catch(() => {});
  try {
    fs.rmSync(work, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  } catch (e) {
    info(`werkmap niet opgeruimd (${e?.code}): ${work}`);
  }
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
