/** Test helpers for the local speech engines: fake recogniser/voice and "installed" models without downloads. */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { LOCAL_MODELS } from '../server/modules/voice/local/catalog.js';
import { setSttBackend } from '../server/modules/voice/local/engine.js';
import { setTtsBackend } from '../server/modules/voice/local/service.js';

/** Mark a catalog model as installed in a data folder (same marker + fingerprint as the model store writes). */
export function markInstalled(dataDir: string, id: string) {
  const m = LOCAL_MODELS.find((x) => x.id === id);
  if (!m) throw new Error('unknown model ' + id);
  const dir = path.join(dataDir, 'voice', 'models', id);
  fs.mkdirSync(dir, { recursive: true });
  const fingerprint = crypto.createHash('sha256').update(JSON.stringify(m.files.map((f) => [f.path, f.sha256]))).digest('hex').slice(0, 16);
  fs.writeFileSync(path.join(dir, '.installed.json'), JSON.stringify({ id, fingerprint, installedAt: new Date().toISOString() }));
}

export interface FakeStt {
  /** Each decode: seconds of audio, sample rate and RMS level it got. */
  calls: { seconds: number; rate: number; rms: number }[];
  restore(): void;
}

/** Replace sherpa-onnx by a fake that reports what it received (and answers `text(seconds)`). */
export function fakeStt(text: (seconds: number) => string = (s) => `deel van ${s.toFixed(1)} s`): FakeStt {
  const calls: FakeStt['calls'] = [];
  setSttBackend({
    name: 'fake-stt',
    problem: () => null,
    async create() {
      return {
        async decode(samples: Float32Array, rate: number) {
          let e = 0;
          for (let i = 0; i < samples.length; i++) e += samples[i] * samples[i];
          const seconds = samples.length / rate;
          calls.push({ seconds, rate, rms: Math.sqrt(e / Math.max(1, samples.length)) });
          return text(seconds);
        },
      };
    },
  });
  return { calls, restore: () => setSttBackend(null) };
}

/** Fake Piper: `ms` of quiet tone per character at 22.05 kHz; records what it was asked to say. */
export function fakeTts(o: { msPerChar?: number; delayMs?: number } = {}) {
  const said: string[] = [];
  const rate = 22050;
  setTtsBackend({
    name: 'fake-piper',
    async synth(r) {
      said.push(r.text);
      if (o.delayMs) await new Promise((res) => setTimeout(res, o.delayMs));
      const n = Math.max(1, Math.round((r.text.length * (o.msPerChar ?? 10) * rate) / 1000));
      const pcm = Buffer.alloc(n * 2);
      for (let i = 0; i < n; i++) pcm.writeInt16LE(Math.round(3000 * Math.sin((2 * Math.PI * 220 * i) / rate)), i * 2);
      return { pcm, sampleRate: rate };
    },
    close() {},
  });
  return { said, restore: () => setTtsBackend(null) };
}
