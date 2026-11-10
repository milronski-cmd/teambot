import { loadSherpa, sherpaError } from './sherpa.js';
import os from 'node:os';
import path from 'node:path';
import type { LocalModel } from './catalog.js';
import type { LocalModels } from './models.js';
import { STT_RATE, resample } from './pcm.js';
import { isAutoLanguage } from '../../../../shared/voiceLanguage.js';

/** One loaded speech recogniser. `decode` must not block the event loop. */
export interface LocalRecognizer {
  decode(samples: Float32Array, sampleRate: number): Promise<string>;
}

export interface SttBackend {
  name: string;
  /** Is the native runtime usable on this machine? null = yes, otherwise the reason. */
  problem(): string | null;
  create(model: LocalModel, dir: string, opts: { language: string; threads: number }): Promise<LocalRecognizer>;
}

/**
 * sherpa-onnx (Apache-2.0, bundled as an npm dependency; since 2.0 without espeak-ng) with onnxruntime (MIT); models
 * come from the model store. Only APIs that take JS buffers in and return JSON are used: Electron forbids external
 * buffers, so e.g. readWave(file) or TTS samples from the addon would fail in the desktop app.
 */
export const sherpaBackend: SttBackend = {
  name: 'sherpa-onnx',
  problem() {
    loadSherpa();
    return sherpaError() ? `Lokale spraakherkenning kon niet starten: ${sherpaError()}` : null;
  },
  async create(model, dir, opts) {
    const sherpa = loadSherpa();
    if (!sherpa) throw new Error(sherpaError() || 'sherpa-onnx ontbreekt');
    const p = (f: string) => path.join(dir, f);
    const modelConfig: any = { numThreads: opts.threads, debug: 0, provider: 'cpu' };
    if (model.engine === 'parakeet') {
      modelConfig.transducer = { encoder: p('encoder.int8.onnx'), decoder: p('decoder.int8.onnx'), joiner: p('joiner.int8.onnx') };
      modelConfig.tokens = p('tokens.txt');
      modelConfig.modelType = 'nemo_transducer';
    } else if (model.engine === 'whisper') {
      // Whisper can only be told one fixed language; an automatic setting lets it detect the language itself.
      const lang = whisperLanguage(opts.language);
      const f = (suffix: string) => p(model.files.find((x) => x.path.endsWith(suffix))?.path || `turbo${suffix}`);
      modelConfig.whisper = { encoder: f('-encoder.int8.onnx'), decoder: f('-decoder.int8.onnx'), language: lang, task: 'transcribe' };
      modelConfig.tokens = f('-tokens.txt');
    } else throw new Error(`Onbekend modeltype ${model.engine}`);
    const rec = await sherpa.OfflineRecognizer.createAsync({ featConfig: { sampleRate: STT_RATE, featureDim: 80 }, modelConfig, decodingMethod: 'greedy_search' });
    return {
      async decode(samples: Float32Array, sampleRate: number) {
        const s = rec.createStream();
        s.acceptWaveform({ samples: sampleRate === STT_RATE ? samples : resample(samples, sampleRate, STT_RATE), sampleRate: STT_RATE });
        const r = await rec.decodeAsync(s);
        return String(r?.text || '');
      },
    };
  },
};

let backendOverride: SttBackend | null = null;
/** Tests: replace the native engine by a fake (no model downloads in `npm test`). */
export function setSttBackend(b: SttBackend | null) {
  backendOverride = b;
}
export const sttBackend = () => backendOverride || sherpaBackend;

export const defaultThreads = () => Math.max(1, Math.min(8, Math.floor((os.availableParallelism?.() || os.cpus().length || 2) / 2)));

interface Loaded {
  key: string;
  rec: Promise<LocalRecognizer>;
  lastUsed: number;
  chain: Promise<unknown>;
  busy: number;
}

const IDLE_MS = 15 * 60_000;

/**
 * Keeps recognisers loaded between dictations (loading Parakeet takes ~1.5 s) and unloads them after 15 idle
 * minutes. Decodes run one at a time per recogniser; partial (live) decodes are skipped while one is running.
 */
export class SttEngines {
  private loaded = new Map<string, Loaded>();
  private timer: NodeJS.Timeout;

  constructor(private models: LocalModels, private log: { warn(...a: any[]): void; info?(...a: any[]): void } = console) {
    this.timer = setInterval(() => this.sweep(), 60_000);
    this.timer.unref?.();
  }

  close() {
    clearInterval(this.timer);
    this.loaded.clear();
  }

  private key(modelId: string, language: string) {
    const m = this.models.model(modelId);
    return m?.engine === 'whisper' ? `${modelId}|${whisperLanguage(language)}` : modelId;
  }

  private entry(modelId: string, language: string): Loaded {
    const key = this.key(modelId, language);
    let e = this.loaded.get(key);
    if (!e) {
      const model = this.models.model(modelId);
      if (!model) throw new Error('Onbekend spraakmodel');
      if (!this.models.installed(modelId)) throw new Error('Het lokale spraakmodel is nog niet gedownload');
      const t0 = Date.now();
      const rec = sttBackend().create(model, this.models.root(modelId), { language, threads: defaultThreads() });
      rec.then(
        () => this.log.info?.(`[voice] lokaal spraakmodel ${modelId} geladen in ${Date.now() - t0} ms`),
        () => this.loaded.delete(key),
      );
      e = { key, rec, lastUsed: Date.now(), chain: Promise.resolve(), busy: 0 };
      this.loaded.set(key, e);
    }
    e.lastUsed = Date.now();
    return e;
  }

  /** Start loading in the background (e.g. when the microphone opens). */
  warm(modelId: string, language: string) {
    try {
      this.entry(modelId, language).rec.catch(() => {});
    } catch {
      /* not installed: nothing to warm */
    }
  }

  isLoaded(modelId: string, language: string) {
    return this.loaded.has(this.key(modelId, language));
  }

  /** Decode; `partial` requests return null instead of queueing when the recogniser is busy. */
  async decode(modelId: string, language: string, samples: Float32Array, sampleRate: number, o: { partial?: boolean } = {}): Promise<{ text: string; ms: number } | null> {
    const e = this.entry(modelId, language);
    if (o.partial && e.busy > 0) return null;
    e.busy++;
    const run = e.chain.then(async () => {
      const rec = await e.rec;
      const t0 = performance.now();
      const text = await rec.decode(samples, sampleRate);
      return { text: tidy(text), ms: Math.round(performance.now() - t0) };
    });
    e.chain = run.catch(() => {});
    try {
      return await run;
    } finally {
      e.busy--;
      e.lastUsed = Date.now();
    }
  }

  sweep(now = Date.now()) {
    for (const [k, e] of this.loaded) if (e.busy === 0 && now - e.lastUsed > IDLE_MS) this.loaded.delete(k);
  }
}

/** Whisper's language for a dictation setting: '' (detect) for every automatic setting, else the fixed code. */
export const whisperLanguage = (setting: string) => (isAutoLanguage(setting) ? '' : setting);

export function tidy(t: string): string {
  return String(t || '')
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.!?;:])/g, '$1')
    .trim();
}
