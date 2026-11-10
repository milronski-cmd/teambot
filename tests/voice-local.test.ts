// Free, local speech (no paid service): model store, PCM helpers, live dictation sessions, local voice jobs and the
// API around them. No real models are downloaded here: files come from a local test server and the native engines
// (sherpa-onnx, Piper) are replaced by small fakes.
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { startTestApp } from './helpers.js';
import type { LocalModel } from '../server/modules/voice/local/catalog.js';
import { LOCAL_MODELS, catalogFor } from '../server/modules/voice/local/catalog.js';
import { LocalModels, type ModelState } from '../server/modules/voice/local/models.js';
import { SttEngines, setSttBackend, tidy } from '../server/modules/voice/local/engine.js';
import { DictationSession } from '../server/modules/voice/local/stream.js';
import { findPause, guessLanguage, hasSignal, parseWav, resample } from '../server/modules/voice/local/pcm.js';
import { setLocalCatalog, setTtsBackend, speechChunks } from '../server/modules/voice/local/service.js';
import { pcmToWav } from '../server/modules/voice/audio.js';
import { effectiveSettings, sanitize } from '../server/modules/voice/settings.js';

const RATE = 16000;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Speech-like test signal: 220 Hz tone with a 4 Hz syllable envelope; silence = zeros. */
function speech(seconds: number, rate = RATE, amp = 0.3): Float32Array {
  const n = Math.round(seconds * rate);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = amp * Math.abs(Math.sin((Math.PI * 4 * i) / rate)) * Math.sin((2 * Math.PI * 220 * i) / rate);
  return out;
}
const silence = (seconds: number, rate = RATE) => new Float32Array(Math.round(seconds * rate));
function join(...parts: Float32Array[]) {
  const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) (out.set(p, o), (o += p.length));
  return out;
}
function int16(samples: Float32Array): Buffer {
  const b = Buffer.alloc(samples.length * 2);
  for (let i = 0; i < samples.length; i++) b.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), i * 2);
  return b;
}
const wav16 = (samples: Float32Array, rate = RATE) => pcmToWav(int16(samples), rate);

/** Fake recogniser: says how much audio it got, so tests can check nothing is lost or decoded twice. */
const decodes: number[] = [];
setSttBackend({
  name: 'fake-stt',
  problem: () => null,
  async create() {
    return {
      async decode(samples: Float32Array, rate: number) {
        const s = samples.length / rate;
        decodes.push(s);
        await new Promise((r) => setTimeout(r, 5));
        return ` deel van ${s.toFixed(2)} s `;
      },
    };
  },
});
/** Fake Piper: 10 ms of a quiet tone per character, at 22.05 kHz. */
const synths: string[] = [];
setTtsBackend({
  name: 'fake-piper',
  async synth(r) {
    synths.push(r.text);
    return { pcm: int16(speech(r.text.length * 0.01, 22050, 0.1)), sampleRate: 22050 };
  },
  close() {},
});
after(() => {
  setSttBackend(null);
  setTtsBackend(null);
  setLocalCatalog(null);
});

// ---------- a local "model server" ----------
interface Served {
  body: Buffer;
  ranges: string[];
}
const files = new Map<string, Served>();
const server = http.createServer((req, res) => {
  const f = files.get(req.url || '');
  if (!f) return res.writeHead(404).end();
  const range = req.headers.range;
  if (range) {
    f.ranges.push(range);
    const start = Number(/bytes=(\d+)-/.exec(range)?.[1] || 0);
    res.writeHead(206, { 'content-length': f.body.length - start, 'content-range': `bytes ${start}-${f.body.length - 1}/${f.body.length}` });
    return res.end(f.body.subarray(start));
  }
  res.writeHead(200, { 'content-length': f.body.length });
  res.end(f.body);
});
await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
after(() => server.close());
const base = `http://127.0.0.1:${(server.address() as any).port}`;
function serve(name: string, body: Buffer) {
  files.set('/' + name, { body, ranges: [] });
  return { path: name, url: `${base}/${name}`, sha256: sha(body), size: body.length };
}

const runtimeZip = (() => {
  const z = new AdmZip();
  z.addFile('piper/piper.exe', Buffer.from('nep'));
  z.addFile('piper/espeak-ng-data/nl_dict', Buffer.from('nep'));
  return z.toBuffer();
})();
const real = (id: string) => LOCAL_MODELS.find((m) => m.id === id)!;
const testCatalog: LocalModel[] = [
  { ...real('parakeet-tdt-0.6b-v3'), files: [serve('encoder.int8.onnx', crypto.randomBytes(300_000)), serve('tokens.txt', Buffer.from('a 0\nb 1\n'))] },
  { ...real('whisper-large-v3-turbo'), files: [serve('turbo.onnx', crypto.randomBytes(1000))] },
  { ...real('piper-runtime'), platforms: undefined, files: [{ ...serve('piper.zip', runtimeZip), extract: 'zip' as const }] },
  { ...real('nl_NL-alex-medium'), files: [serve('alex.onnx', crypto.randomBytes(50_000)), serve('alex.onnx.json', Buffer.from('{}'))] },
  { ...real('en_US-ljspeech-medium'), files: [serve('lj.onnx', crypto.randomBytes(1000)), serve('lj.onnx.json', Buffer.from('{}'))] },
  { ...real('nl_NL-mls-medium'), files: [serve('mls.onnx', crypto.randomBytes(1000)), serve('mls.onnx.json', Buffer.from('{}'))] },
];

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tb-voice-local-'));

test('catalog: pinned https files with sha256, permissive licences, platform entries', () => {
  for (const m of LOCAL_MODELS) {
    assert.ok(m.files.length, m.id);
    for (const f of m.files) {
      assert.match(f.url, /^https:\/\/(huggingface\.co|github\.com)\//, f.url);
      assert.match(f.url, /\/resolve\/[0-9a-f]{40}\/|\/releases\/download\/[\w.-]+\//, `pinned revision: ${f.url}`);
      assert.match(f.sha256, /^[0-9a-f]{64}$/);
      assert.ok(f.size > 0);
    }
    // ADR 0004: permissive only (BSD-3-Clause is allowed there too).
    assert.ok(['CC-BY-4.0', 'MIT', 'CC0-1.0', 'Public domain', 'Apache-2.0', 'BSD-3-Clause'].includes(m.licence), `${m.id}: ${m.licence}`);
  }
  const win = catalogFor(LOCAL_MODELS, 'win32-x64');
  assert.equal(win.filter((m) => m.id === 'piper-runtime').length, 1);
  assert.match(win.find((m) => m.id === 'piper-runtime')!.files[0].url, /windows_amd64\.zip$/);
  const mac = catalogFor(LOCAL_MODELS, 'darwin-arm64').find((m) => m.id === 'piper-runtime')!;
  assert.equal(mac.files.length, 0, 'no working Piper build for macOS: listed as unsupported');
  assert.ok(catalogFor(LOCAL_MODELS, 'darwin-arm64').find((m) => m.id === 'parakeet-tdt-0.6b-v3')!.files.length, 'speech recognition still works on macOS');
});

test('model store: download with progress + sha256, resume with Range, corrupt file refused, zip unpacked, remove', async () => {
  const dir = tmp();
  try {
    const events: ModelState[] = [];
    const store = new LocalModels(dir, { catalog: testCatalog, onProgress: (s) => events.push(s) });
    assert.equal(store.state('parakeet-tdt-0.6b-v3').status, 'missing');

    // Resume: half of the encoder is already there from an interrupted download.
    const enc = files.get('/encoder.int8.onnx')!;
    fs.mkdirSync(path.join(dir, 'parakeet-tdt-0.6b-v3'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'parakeet-tdt-0.6b-v3', 'encoder.int8.onnx.part'), enc.body.subarray(0, 120_000));
    await store.install('parakeet-tdt-0.6b-v3');
    assert.deepEqual(enc.ranges, ['bytes=120000-'], 'continues where it stopped');
    assert.equal(store.state('parakeet-tdt-0.6b-v3').status, 'installed');
    assert.deepEqual(fs.readFileSync(path.join(dir, 'parakeet-tdt-0.6b-v3', 'encoder.int8.onnx')), enc.body);
    assert.ok(events.some((e) => e.status === 'downloading'), 'progress events');
    assert.equal(events.at(-1)!.status, 'installed');

    // Same id twice at once: one download.
    const before = files.get('/alex.onnx')!.ranges.length;
    await Promise.all([store.install('nl_NL-alex-medium'), store.install('nl_NL-alex-medium')]);
    assert.equal(files.get('/alex.onnx')!.ranges.length, before);
    assert.ok(store.installed('nl_NL-alex-medium'));

    // Runtime archive: verified, unpacked, archive removed.
    await store.install('piper-runtime');
    assert.ok(fs.existsSync(path.join(dir, 'piper-runtime', 'piper', 'piper.exe')));
    assert.ok(!fs.existsSync(path.join(dir, 'piper-runtime', 'piper.zip.part')));

    // Corrupt download: wrong checksum → error, nothing left behind, not installed.
    const bad: LocalModel[] = testCatalog.map((m) => (m.id === 'whisper-large-v3-turbo' ? { ...m, files: [{ ...m.files[0], sha256: '0'.repeat(64) }] } : m));
    const store2 = new LocalModels(dir, { catalog: bad });
    await assert.rejects(store2.install('whisper-large-v3-turbo'), /SHA-256/);
    assert.equal(store2.state('whisper-large-v3-turbo').status, 'error');
    assert.ok(!fs.existsSync(path.join(dir, 'whisper-large-v3-turbo', 'turbo.onnx.part')));
    assert.ok(!store2.installed('whisper-large-v3-turbo'));

    // A catalog revision change makes an old install count as missing.
    const changed = testCatalog.map((m) => (m.id === 'nl_NL-alex-medium' ? { ...m, files: [...m.files, serve('extra.bin', Buffer.from('x'))] } : m));
    assert.equal(new LocalModels(dir, { catalog: changed }).installed('nl_NL-alex-medium'), false);

    store.remove('nl_NL-alex-medium');
    assert.equal(store.state('nl_NL-alex-medium').status, 'missing');
    assert.ok(!fs.existsSync(path.join(dir, 'nl_NL-alex-medium')));
    assert.throws(() => store.root('../x'), /Ongeldige/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('model store: archive entries outside the model folder are refused', async () => {
  const dir = tmp();
  try {
    const z = new AdmZip();
    z.addFile('piper/ok.txt', Buffer.from('ok'));
    // adm-zip keeps the raw entry name; a hostile archive could contain "../" paths.
    const evil = z.toBuffer();
    const entryName = 'piper/ok.txt';
    const hacked = Buffer.from(evil.toString('latin1').split(entryName).join('../../ev.tx'), 'latin1');
    const cat: LocalModel[] = [{ ...real('piper-runtime'), platforms: undefined, files: [{ ...serve('evil.zip', hacked), extract: 'zip' as const }] }];
    await assert.rejects(new LocalModels(dir, { catalog: cat }).install('piper-runtime'), /Onveilig pad|ongeldig|invalid/i);
    assert.ok(!fs.existsSync(path.join(dir, '..', 'ev.tx')));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('pcm helpers: wav parsing, resampling, pauses, signal, language guess, speech chunks', () => {
  const s = join(speech(1), silence(0.5), speech(1));
  const p = parseWav(wav16(s));
  assert.equal(p.sampleRate, RATE);
  assert.equal(p.samples.length, s.length);
  // Stereo float WAV
  const fl = Buffer.alloc(44 + 8 * 4);
  fl.write('RIFF', 0, 'latin1');
  fl.writeUInt32LE(36 + 32, 4);
  fl.write('WAVEfmt ', 8, 'latin1');
  fl.writeUInt32LE(16, 16);
  fl.writeUInt16LE(3, 20);
  fl.writeUInt16LE(2, 22);
  fl.writeUInt32LE(48000, 24);
  fl.writeUInt32LE(48000 * 8, 28);
  fl.writeUInt16LE(8, 32);
  fl.writeUInt16LE(32, 34);
  fl.write('data', 36, 'latin1');
  fl.writeUInt32LE(32, 40);
  for (let i = 0; i < 4; i++) (fl.writeFloatLE(0.5, 44 + i * 8), fl.writeFloatLE(-0.5, 48 + i * 8));
  const st = parseWav(fl);
  assert.equal(st.samples.length, 4);
  assert.equal(st.samples[0], 0, 'channels averaged');
  assert.throws(() => parseWav(Buffer.from('no wav at all, sorry')), /WAV/);

  assert.equal(resample(speech(1, 48000), 48000, 16000).length, 16000);
  assert.equal(resample(speech(1, 22050), 22050, 16000).length, 16000);

  const cut = findPause(s, RATE, 0, s.length)!;
  assert.ok(cut > 1.1 * RATE && cut < 1.4 * RATE, `cut in the pause: ${cut / RATE}`);
  assert.equal(findPause(speech(3), RATE, 0, 3 * RATE), null, 'no pause in continuous speech');
  assert.ok(hasSignal(s, RATE));
  assert.ok(hasSignal(join(speech(1, RATE, 0.02), silence(1)), RATE), 'quiet speech (-34 dBFS) still counts');
  assert.ok(!hasSignal(silence(2), RATE));
  const hum = new Float32Array(RATE).map((_, i) => 0.01 * Math.sin((2 * Math.PI * 50 * i) / RATE));
  assert.ok(!hasSignal(hum, RATE), 'steady hum is not speech');

  assert.equal(guessLanguage('Ik heb de afspraak met de tandarts voor je gemaakt, en het is morgen om drie uur.'), 'nl');
  assert.equal(guessLanguage('I have made the appointment with the dentist for you and it is tomorrow at three.'), 'en');
  assert.equal(guessLanguage('OK'), null);

  const chunks = speechChunks('Eerste zin. Tweede zin is wat langer. Derde! ' + 'Lang woord '.repeat(80));
  assert.equal(chunks[0], 'Eerste zin.', 'first sentence alone: first sound comes fast');
  assert.ok(chunks.every((c) => c.length <= 400));
  assert.equal(chunks.join(' ').replace(/\s+/g, ' ').trim(), ('Eerste zin. Tweede zin is wat langer. Derde! ' + 'Lang woord '.repeat(80)).replace(/\s+/g, ' ').trim());
  assert.equal(tidy('  Hallo  ,  wereld . '), 'Hallo, wereld.');
});

test('live dictation session: final stretches at pauses, live text, nothing lost or doubled, limits', async () => {
  const dir = tmp();
  try {
    const store = new LocalModels(dir, { catalog: testCatalog });
    await store.install('parakeet-tdt-0.6b-v3');
    const engines = new SttEngines(store, { warn() {} });
    const sess = new DictationSession(engines, 'u1', 'parakeet-tdt-0.6b-v3', 'auto-nl', null);
    const audio = join(speech(4), silence(0.6), speech(4), silence(0.6), speech(3), silence(0.3));
    const pcm = int16(audio);
    const step = 0.4 * RATE * 2;
    let sawText = false;
    for (let o = 0; o < pcm.length; o += step) {
      const v = sess.push(pcm.subarray(o, o + step));
      if (v.text) sawText = true;
      await new Promise((r) => setTimeout(r, 15));
    }
    assert.ok(sawText, 'live text while talking');
    decodes.length = 0;
    const end = await sess.end();
    const parts = [...end.text.matchAll(/deel van ([\d.]+) s/g)].map((m) => Number(m[1]));
    assert.ok(parts.length >= 2, `split at pauses: ${end.text}`);
    const total = parts.reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(total - audio.length / RATE) < 0.05, `all audio decoded exactly once (${total} vs ${audio.length / RATE})`);
    assert.ok(decodes.length <= 1, 'stopping only decodes the last stretch');
    assert.throws(() => sess.push(Buffer.alloc(10)), /afgesloten/);
    engines.close();

    const engines2 = new SttEngines(store, { warn() {} });
    const big = new DictationSession(engines2, 'u1', 'parakeet-tdt-0.6b-v3', 'auto-nl', null);
    assert.throws(() => big.push(Buffer.alloc(10 * 60 * RATE * 2 + 2)), /te lang/);
    engines2.close();
    // Not installed → clear error.
    const engines3 = new SttEngines(store, { warn() {} });
    await assert.rejects(engines3.decode('whisper-large-v3-turbo', 'nl', speech(1), RATE), /nog niet gedownload/);
    engines3.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('settings: defaults are local and free; local ids validated', () => {
  const d = sanitize({});
  assert.equal(d.stt.engine, 'local');
  assert.equal(d.stt.localModel, '', 'automatic: the model for the interface language');
  assert.equal(d.tts.engine, 'local');
  assert.equal(d.tts.localVoice, '', 'automatic: the voice for the interface language');
  assert.equal(d.call.engine, 'local');
  assert.equal(d.call.bargeIn, true);
  // For a Dutch interface the automatic choices are what the defaults always were.
  const nl = effectiveSettings(d, 'nl');
  assert.equal(nl.stt.localModel, 'parakeet-tdt-0.6b-v3');
  assert.equal(nl.stt.language, 'auto-nl');
  assert.equal(nl.tts.localVoice, 'nl_NL-alex-medium');
  const bad = sanitize({ stt: { localModel: '../../etc', engine: 'x' }, tts: { localVoice: 'parakeet-tdt-0.6b-v3', localVoiceEn: 'evil' }, call: { engine: 'paid', silenceMs: 99999 } });
  assert.equal(bad.stt.localModel, '');
  assert.equal(bad.tts.localVoice, '', 'an STT model is not a voice');
  assert.equal(effectiveSettings(bad, 'nl').tts.localVoice, 'nl_NL-alex-medium');
  assert.equal(bad.tts.localVoiceEn, 'en_US-ljspeech-medium');
  assert.equal(bad.call.engine, 'local');
  assert.equal(bad.call.silenceMs, 3000);
  assert.equal(sanitize({ tts: { localVoiceEn: '' } }).tts.localVoiceEn, '', 'English voice can be switched off');
});

test('API: local dictation, live stream, local voice, free call, permissions, phone routes', async () => {
  setLocalCatalog(testCatalog);
  const t = await startTestApp({ mode: 'server' });
  try {
    const bea = t.app.ctx.auth.createUser({ name: 'Bea', email: 'bea@example.nl', password: 'wachtwoord123' });
    const beaToken = t.app.ctx.auth.createSession(bea.id).token;
    const call = async (token: string, method: string, p: string, body?: any, type?: string) => {
      const res = await fetch(t.app.url + '/api' + p, {
        method,
        headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': type || 'application/json' } : {}) },
        body: body === undefined ? undefined : Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body),
      });
      const text = await res.text();
      let json: any = {};
      try {
        json = JSON.parse(text);
      } catch {
        /* not json */
      }
      return { status: res.status, json, text, res };
    };
    const A = (m: string, p: string, b?: any, type?: string) => call(t.token, m, p, b, type);
    const B = (m: string, p: string, b?: any, type?: string) => call(beaToken, m, p, b, type);

    // Defaults: everything local; nothing downloaded yet → clear message, browser voice meanwhile.
    const s0 = await A('GET', '/voice/settings');
    assert.equal(s0.json.settings.stt.engine, 'local');
    assert.equal(s0.json.status.stt.ready, false);
    assert.match(s0.json.status.stt.missing, /nog niet gedownload/);
    assert.equal(s0.json.status.tts.engine, 'browser');
    assert.match(s0.json.status.tts.localMissing, /Alex/);
    assert.equal(s0.json.local.canManage, true);
    assert.ok(s0.json.local.models.find((m: any) => m.id === 'parakeet-tdt-0.6b-v3' && m.licence === 'CC-BY-4.0'));
    const wav = wav16(join(silence(0.3), speech(2), silence(0.3)));
    const missing = await A('POST', '/voice/transcribe', wav, 'audio/wav');
    assert.equal(missing.status, 409);
    assert.equal(missing.json.code, 'voice_local_missing');
    const spokenBrowser = await A('POST', '/voice/speak', { text: 'Hallo daar.' });
    assert.equal(spokenBrowser.json.engine, 'browser', 'free browser voice until the local voice is there');
    assert.ok(spokenBrowser.json.localMissing);

    // Only the owner/admin may download (a member on a shared server may not).
    assert.equal((await B('POST', '/voice/local/models/parakeet-tdt-0.6b-v3/install', {})).status, 403);
    assert.equal((await A('POST', '/voice/local/models/bestaat-niet/install', {})).status, 404);
    assert.equal((await A('POST', '/voice/local/models/parakeet-tdt-0.6b-v3/install', {})).status, 200);
    assert.equal((await A('POST', '/voice/local/models/nl_NL-alex-medium/install', {})).status, 200);
    for (let i = 0; i < 100; i++) {
      const v = await A('GET', '/voice/local');
      const st = (id: string) => v.json.models.find((m: any) => m.id === id).status;
      if (st('parakeet-tdt-0.6b-v3') === 'installed' && st('nl_NL-alex-medium') === 'installed' && st('piper-runtime') === 'installed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const s1 = await A('GET', '/voice/settings');
    assert.equal(s1.json.status.stt.ready, true);
    assert.equal(s1.json.status.tts.engine, 'local');

    // File transcription (memo/call/meeting path): WAV only, free, nothing sent anywhere.
    const tr = await A('POST', '/voice/transcribe', wav, 'audio/wav');
    assert.equal(tr.status, 200, tr.text);
    assert.match(tr.json.text, /deel van 2\.\d+ s/);
    assert.equal(tr.json.cost, 0);
    assert.equal(tr.json.provider, 'Lokaal (deze computer)');
    const webm = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.alloc(400, 7)]);
    const wrong = await A('POST', '/voice/transcribe', webm, 'audio/webm');
    assert.equal(wrong.status, 415);
    assert.equal(wrong.json.code, 'voice_local_format');
    const quiet = await A('POST', '/voice/transcribe', wav16(silence(2)), 'audio/wav');
    assert.equal(quiet.json.text, '', 'silence is not sent to the recogniser');
    assert.equal(t.app.ctx.store.one<any>("SELECT COUNT(*) AS n FROM usage_log WHERE model = 'parakeet-tdt-0.6b-v3'")?.n ?? 0, 0, 'free: no usage cost rows');

    // Live dictation stream.
    const st = await A('POST', '/voice/stt/stream', {});
    assert.equal(st.status, 200, st.text);
    assert.equal(st.json.sampleRate, 16000);
    const chunk = int16(speech(1));
    const p1 = await A('POST', `/voice/stt/stream/${st.json.id}`, chunk, 'application/octet-stream');
    assert.equal(p1.status, 200);
    assert.equal(typeof p1.json.text, 'string');
    assert.equal((await B('POST', `/voice/stt/stream/${st.json.id}`, chunk, 'application/octet-stream')).status, 404, "someone else's session");
    await A('POST', `/voice/stt/stream/${st.json.id}`, int16(join(speech(1), silence(0.4))), 'application/octet-stream');
    const fin = await A('POST', `/voice/stt/stream/${st.json.id}/end`, {});
    assert.equal(fin.status, 200, fin.text);
    assert.match(fin.json.text, /deel van/);
    assert.ok(fin.json.seconds > 2);
    assert.equal((await A('POST', `/voice/stt/stream/${st.json.id}/end`, {})).status, 404, 'closed');
    await A('PUT', '/voice/settings', { stt: { engine: 'browser' } });
    assert.equal((await A('POST', '/voice/stt/stream', {})).status, 400, 'live stream needs the local engine');
    await A('PUT', '/voice/settings', { stt: { engine: 'local' } });

    // Local voice: streams while it is made, then cached (no second synthesis).
    synths.length = 0;
    const sp = await A('POST', '/voice/speak', { text: 'Goedemorgen! Dit is de eerste zin. En dit is de tweede zin.' });
    assert.equal(sp.json.engine, 'local');
    assert.equal(sp.json.cached, false);
    assert.equal(sp.json.provider, 'Lokaal (deze computer)');
    assert.ok(sp.json.stream);
    const pcmRes = await fetch(t.app.url + '/api' + sp.json.stream, { headers: { authorization: `Bearer ${t.token}` } });
    assert.equal(pcmRes.headers.get('x-sample-rate'), '22050');
    const pcmBody = Buffer.from(await pcmRes.arrayBuffer());
    assert.ok(pcmBody.length > 1000);
    assert.ok(synths.length >= 2 && synths[0] === 'Goedemorgen!', 'sentence by sentence, first sentence first');
    assert.equal((await B('GET', sp.json.stream)).status, 404, "someone else's audio");
    const file = await fetch(t.app.url + t.signed(`/api/voice/tts/${sp.json.id}`));
    assert.equal(file.headers.get('content-type'), 'audio/wav');
    assert.equal(Buffer.from(await file.arrayBuffer()).length, pcmBody.length + 44);
    const made = synths.length;
    const again = await A('POST', '/voice/speak', { text: 'Goedemorgen! Dit is de eerste zin. En dit is de tweede zin.' });
    assert.equal(again.json.cached, true);
    assert.equal(synths.length, made, 'no new synthesis');
    // English text: English voice only when installed; otherwise the Dutch voice.
    const en = await A('POST', '/voice/speak', { text: 'This is an English answer and it is read with the voice you have.' });
    assert.equal(en.json.model, 'nl_NL-alex-medium');
    await A('POST', '/voice/local/models/en_US-ljspeech-medium/install', {});
    for (let i = 0; i < 100; i++) {
      const v = await A('GET', '/voice/local');
      if (v.json.models.find((m: any) => m.id === 'en_US-ljspeech-medium').status === 'installed') break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const en2 = await A('POST', '/voice/speak', { text: 'This is another English answer and it is read with the English voice now.' });
    assert.equal(en2.json.model, 'en_US-ljspeech-medium');
    // Service for other modules waits for the complete file.
    const svc = await t.app.ctx.services.voice.speak(t.app.ctx.auth.owner()!.id, 'Een bericht voor een kanaal.');
    assert.equal(svc.engine, 'local');
    assert.ok(fs.existsSync(svc.path));

    // Free call: local STT → the bot (normal run) → local voice.
    const bot = await t.agent({ name: 'Sam' });
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    const c = await A('POST', '/voice/calls', { agentId: bot.id, threadId: th.id });
    const heard = await A('POST', `/voice/transcribe?callId=${c.json.id}`, wav, 'audio/wav');
    t.script.push({ text: 'Dat klopt. Ik heb het genoteerd.' });
    const turn = await A('POST', `/voice/calls/${c.json.id}/turn`, { text: heard.json.text });
    assert.equal(turn.json.status, 'done', JSON.stringify(turn.json));
    assert.equal(turn.json.text, 'Dat klopt. Ik heb het genoteerd.');
    const voice = await A('POST', '/voice/speak', { messageId: turn.json.messageId, callId: c.json.id });
    assert.equal(voice.json.engine, 'local');
    const ended = await A('POST', `/voice/calls/${c.json.id}/end`, {});
    assert.equal(ended.json.cost, 0, 'free call');
    const userMsg = t.app.ctx.store.messages(th.id).find((m) => m.role === 'user');
    assert.equal(userMsg?.parts?.voice?.via, 'call');

    // Removing a model (owner only).
    assert.equal((await B('DELETE', '/voice/local/models/nl_NL-alex-medium')).status, 403);
    assert.equal((await A('DELETE', '/voice/local/models/nl_NL-alex-medium')).json.status, 'missing');

    // Phone: the paired-device allowlist contains the streaming routes (download/remove stay desktop-only).
    const routes = (t.app.ctx.services.mobileRoutes as { method: string; path: string }[]).map((r) => `${r.method} ${r.path}`);
    for (const r of ['POST /voice/stt/stream', 'POST /voice/stt/stream/:id', 'POST /voice/stt/stream/:id/end', 'GET /voice/tts/:id/pcm', 'GET /voice/local']) assert.ok(routes.includes(r), r);
    assert.ok(!routes.some((r) => r.includes('/install') || r.startsWith('DELETE /voice/local')));
  } finally {
    await t.close();
    setLocalCatalog(null);
  }
});
