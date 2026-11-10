// Makes the spoken WAV fixtures of the free live call (16 kHz mono 16-bit). Not part of `npm test`; the output is
// committed. Needs installed local models (Piper + the Dutch voice "Alex", dataset CC0), e.g. a TeamBot data folder:
//   node --import tsx tests/fixtures/make-duplex-fixtures.ts <dir with voice/models> tests/fixtures
// duplex-vraag.wav: "Hoe laat gaat de bakker morgen open?" followed by 0.8 s of silence.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PiperPool } from '../../server/modules/voice/local/piper.js';
import { int16ToFloat, resample } from '../../server/modules/voice/local/pcm.js';
import { pcmToWav } from '../../server/modules/voice/audio.js';

const [modelsRoot, outDir] = process.argv.slice(2);
if (!modelsRoot || !outDir) throw new Error('usage: make-duplex-fixtures.ts <models dir> <out dir>');
const models = fs.existsSync(path.join(modelsRoot, 'voice', 'models')) ? path.join(modelsRoot, 'voice', 'models') : modelsRoot;
const pool = new PiperPool(fs.mkdtempSync(path.join(os.tmpdir(), 'tb-fix-')));
const say = async (text: string) => {
  const r = await pool.synth({ voiceDir: path.join(models, 'nl_NL-alex-medium'), runtimeDir: path.join(models, 'piper-runtime'), text, speed: 1 });
  return resample(int16ToFloat(r.pcm), r.sampleRate, 16000);
};
const write = (name: string, parts: Float32Array[]) => {
  const n = parts.reduce((a, p) => a + p.length, 0);
  const all = new Float32Array(n);
  let o = 0;
  for (const p of parts) all.set(p, o), (o += p.length);
  const pcm = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(all[i] * 32767))), i * 2);
  fs.writeFileSync(path.join(outDir, name), pcmToWav(pcm, 16000));
  console.log(name, (n / 16000).toFixed(2), 's');
};
const silence = (s: number) => new Float32Array(Math.round(s * 16000));
write('duplex-vraag.wav', [silence(0.3), await say('Hoe laat gaat de bakker morgen open?'), silence(0.8)]);
pool.close();
