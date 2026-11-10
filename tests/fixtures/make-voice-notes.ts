// Makes the Ogg/Opus test fixtures (voice notes as WhatsApp/Telegram send them). Not part of `npm test`; the output is
// committed. Needs the MIT-licensed `opusscript` encoder (libopus) outside the project, e.g.
//   mkdir ../enc && cd ../enc && npm i opusscript@0.1.1
//   node --import tsx tests/fixtures/make-voice-notes.ts ../enc/node_modules/opusscript <in.wav|tone> <out.ogg> [rate]
// The speech fixture (spraakbericht-nl.ogg) is Piper's Dutch voice "Alex" (dataset CC0) reading:
//   "Hoi, kun je morgen om tien uur de vergadering met Sanne inplannen? Dank je wel."
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { parseWav, resample } from '../../server/modules/voice/local/pcm.js';
import { oggMux, opusHead, opusTags } from '../ogg.js';

const [encDir, input, out, rateArg] = process.argv.slice(2);
if (!encDir || !input || !out) throw new Error('usage: make-voice-notes.ts <opusscript dir> <in.wav|tone> <out.ogg> [rate]');
const OpusScript = createRequire(import.meta.url)(path.resolve(encDir));
const rate = Number(rateArg) || 16000;

let samples: Float32Array;
if (input === 'tone') {
  // 1.2 s "speech-like" test signal: 220 Hz with a 4 Hz syllable envelope, then 0.3 s silence.
  const n = Math.round(1.5 * rate);
  samples = new Float32Array(n);
  for (let i = 0; i < Math.round(1.2 * rate); i++) samples[i] = 0.3 * Math.abs(Math.sin((Math.PI * 4 * i) / rate)) * Math.sin((2 * Math.PI * 220 * i) / rate);
} else {
  const w = parseWav(fs.readFileSync(input));
  samples = resample(w.samples, w.sampleRate, rate);
}

const enc = new OpusScript(rate, 1, OpusScript.Application.VOIP);
const frame = Math.round(rate * 0.02);
const preSkip = 312;
const packets: { data: Uint8Array; granule: number }[] = [
  { data: opusHead({ channels: 1, preSkip, inputRate: rate }), granule: 0 },
  { data: opusTags('TeamBot fixture (libopus via opusscript)'), granule: 0 },
];
let granule = preSkip;
for (let i = 0; i < samples.length; i += frame) {
  const pcm = Buffer.alloc(frame * 2);
  for (let k = 0; k < frame && i + k < samples.length; k++) pcm.writeInt16LE(Math.round(Math.max(-1, Math.min(1, samples[i + k])) * 32767), k * 2);
  const data = enc.encode(pcm, frame);
  const real = Math.min(frame, samples.length - i);
  granule += Math.round((real * 48000) / rate);
  packets.push({ data: new Uint8Array(data), granule });
}
enc.delete?.();
const ogg = oggMux(packets, { perPage: 50 });
fs.writeFileSync(out, ogg);
console.log(`${out}: ${(samples.length / rate).toFixed(2)} s, ${packets.length - 2} Opus packets, ${ogg.length} bytes`);
