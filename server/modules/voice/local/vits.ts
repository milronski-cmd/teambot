import { loadSherpa, sherpaError } from './sherpa.js';
import fs from 'node:fs';
import path from 'node:path';
import type { SynthRequest, SynthResult, TtsBackend } from './piper.js';

/** null = the in-process voice engine works here; otherwise a Dutch reason for the user. */
export function vitsProblem(): string | null {
  loadSherpa();
  return sherpaError() ? `Lokaal voorlezen in TeamBot zelf kon niet starten: ${sherpaError()}` : null;
}

/** Pause after each sentence (Piper adds the same with --sentence_silence 0.15). */
const SENTENCE_SILENCE = 0.15;

/** Float samples → 16-bit little-endian PCM, with a short pause at the end. */
export function toPcm(samples: Float32Array, sampleRate: number, pause = SENTENCE_SILENCE): Buffer {
  const tail = Math.round(pause * sampleRate);
  const pcm = Buffer.alloc((samples.length + tail) * 2);
  for (let i = 0; i < samples.length; i++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32768))), i * 2);
  return pcm;
}

interface Loaded {
  tts: Promise<any>;
  chain: Promise<unknown>;
  lastUsed: number;
  busy: number;
}

const IDLE_MS = 10 * 60_000;
const MAX_LOADED = 3;

/**
 * Character-based VITS voices (Coqui models, ONNX by the sherpa-onnx project) in the server process, by sherpa-onnx
 * (Apache-2.0; since 2.0 without espeak-ng, and these voices need no phonemiser). Each voice stays loaded (≈ 0,7 s
 * to load) and is unloaded after 10 idle minutes; synthesis runs off the event loop (generateAsync), one sentence at
 * a time per voice. Samples are copied into a JS buffer (enableExternalBuffer: false): Electron forbids external
 * buffers, and with them the call fails there.
 */
export class VitsPool implements TtsBackend {
  name = 'sherpa-vits';
  private loaded = new Map<string, Loaded>();
  private timer: NodeJS.Timeout;

  constructor(private threads = 2) {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }

  private entry(r: Omit<SynthRequest, 'text'>): Loaded {
    const key = `${r.voiceDir}|${r.noise?.join(',') || ''}`;
    let e = this.loaded.get(key);
    if (!e) {
      const sherpa = loadSherpa();
      if (!sherpa) throw new Error(sherpaError() || 'sherpa-onnx ontbreekt');
      if (this.loaded.size >= MAX_LOADED) {
        const idle = [...this.loaded.entries()].filter(([, x]) => x.busy === 0).sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
        if (idle) this.loaded.delete(idle[0]);
      }
      const vits: any = { model: path.join(r.voiceDir, 'model.onnx'), tokens: path.join(r.voiceDir, 'tokens.txt'), lengthScale: 1 };
      // The native loader does not fail gently on a missing file.
      if (!fs.existsSync(vits.model) || !fs.existsSync(vits.tokens)) throw new Error('De stem is nog niet gedownload');
      if (r.noise) (vits.noiseScale = r.noise[0]), (vits.noiseScaleW = r.noise[1]);
      const tts = sherpa.OfflineTts.createAsync({ model: { vits, numThreads: this.threads, debug: false, provider: 'cpu' }, maxNumSentences: 1 });
      tts.catch(() => this.loaded.delete(key));
      e = { tts, chain: Promise.resolve(), lastUsed: Date.now(), busy: 0 };
      this.loaded.set(key, e);
    }
    e.lastUsed = Date.now();
    return e;
  }

  async synth(r: SynthRequest): Promise<SynthResult> {
    const e = this.entry(r);
    e.busy++;
    const run = e.chain.then(async () => {
      const tts = await e.tts;
      const speed = Math.min(2, Math.max(0.5, r.speed || 1));
      const a = await tts.generateAsync({ text: r.text.replace(/[\r\n]+/g, ' '), sid: r.speaker && r.speaker > 0 ? r.speaker : 0, speed, enableExternalBuffer: false });
      const samples: Float32Array = a?.samples instanceof Float32Array ? a.samples : new Float32Array(a?.samples || []);
      const sampleRate = Number(a?.sampleRate) || 22050;
      return { pcm: toPcm(samples, sampleRate), sampleRate };
    });
    e.chain = run.catch(() => {});
    try {
      return await run;
    } catch (err: any) {
      throw new Error('Voorlezen mislukte: ' + String(err?.message || err).slice(0, 200));
    } finally {
      e.busy--;
      e.lastUsed = Date.now();
    }
  }

  /** Load the voice ahead of time (e.g. while the bot is still thinking). */
  warm(r: Omit<SynthRequest, 'text'>) {
    try {
      this.entry(r).tts.catch(() => {});
    } catch {
      /* not available: the real request will say so */
    }
  }

  sweep(now = Date.now()) {
    for (const [k, e] of this.loaded) if (e.busy === 0 && now - e.lastUsed > IDLE_MS) this.loaded.delete(k);
  }

  close() {
    clearInterval(this.timer);
    this.loaded.clear();
  }
}
