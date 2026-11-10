import path from 'node:path';
import type { Ctx } from '../../../core/types.js';
import { LOCAL_MODELS, PIPER_RUNTIME, type LocalModel, totalSize, LICENCES_CHECKED, platformKey, voiceEngineOf } from './catalog.js';
import { LocalModels, type ModelState } from './models.js';
import { SttEngines, sttBackend } from './engine.js';
import { DictationSessions } from './stream.js';
import { PiperPool, type SynthRequest, type TtsBackend } from './piper.js';
import { VitsPool, vitsProblem } from './vits.js';
import { STT_RATE, hasSignal, parseWav, resample } from './pcm.js';
import { decodeOggOpus } from './opus.js';
import { spellNumbers } from '../numbers.js';

let ttsOverride: TtsBackend | null = null;
/** Tests: replace Piper and the in-process voices by a fake synthesiser (it gets every request, with `engine`). */
export function setTtsBackend(b: TtsBackend | null) {
  ttsOverride = b;
}
let vitsProblemOverride: (() => string | null) | null = null;
/** Tests: pretend the in-process voice engine is (not) available. */
export function setVitsProblem(f: (() => string | null) | null) {
  vitsProblemOverride = f;
}
/** Why the in-process voices cannot run here (null = they can); with a fake synthesiser only the test override. */
const inProcessProblem = () => (vitsProblemOverride ? vitsProblemOverride() : ttsOverride ? null : vitsProblem());

export interface TtsJob {
  id: string;
  userId: string;
  sampleRate: number;
  chunks: Buffer[];
  bytes: number;
  done: boolean;
  error: string | null;
  /** Resolves (never rejects) when synthesis finished or failed. */
  finished: Promise<void>;
  listeners: Set<() => void>;
  firstChunkMs: number | null;
  /** Live job that follows a bot's answer while it is written (stops when its listener goes away). */
  cancel?: () => void;
}

/** Split for streaming: the first sentence alone (fast first audio), then chunks of a few sentences. */
export function speechChunks(text: string, max = 400): string[] {
  const sentences = String(text || '')
    .split(/(?<=[.!?…:;])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (let s of sentences) {
    while (s.length > max) {
      const cut = s.lastIndexOf(' ', max) > max / 2 ? s.lastIndexOf(' ', max) : max;
      if (cur) out.push(cur), (cur = '');
      out.push(s.slice(0, cut).trim());
      s = s.slice(cut).trim();
    }
    if (!out.length && !cur) {
      out.push(s);
      continue;
    }
    if ((cur + ' ' + s).trim().length > max) {
      out.push(cur);
      cur = s;
    } else cur = (cur + ' ' + s).trim();
  }
  if (cur) out.push(cur);
  return out.filter(Boolean);
}

/**
 * Everything for free, on-device speech: model store (download on first use), recognisers, live dictation sessions
 * and local voices (Piper program or in-process VITS) with streaming synthesis jobs.
 */
export class LocalVoice {
  readonly models: LocalModels;
  readonly stt: SttEngines;
  readonly sessions: DictationSessions;
  private piper: PiperPool | null = null;
  private vits: VitsPool | null = null;
  private router: TtsBackend | null = null;
  readonly jobs = new Map<string, TtsJob>();

  constructor(private ctx: Ctx, opts: { catalog?: LocalModel[] } = {}) {
    this.models = new LocalModels(path.join(ctx.config.dataDir, 'voice', 'models'), {
      catalog: opts.catalog || LOCAL_MODELS,
      onProgress: (s) => this.progress(s),
    });
    this.stt = new SttEngines(this.models, ctx.log);
    this.sessions = new DictationSessions(this.stt);
  }

  private watchers = new Set<string>();
  /** Users that should get download progress events (who started a download / looked at the page). */
  watch(userId: string) {
    this.watchers.add(userId);
  }
  private progress(s: ModelState) {
    for (const u of this.watchers) this.ctx.events.emit(u, 'voice.local.progress', s);
  }

  /** The synthesiser: each request goes to the engine of its voice (`engine` in the request). */
  tts(): TtsBackend {
    if (ttsOverride) return ttsOverride;
    if (!this.router) {
      const piper = () => (this.piper ??= new PiperPool(path.join(this.ctx.config.dataDir, 'voice', 'tmp')));
      const vits = () => (this.vits ??= new VitsPool());
      this.router = {
        name: 'local',
        synth: (r) => (r.engine === 'vits' ? vits() : piper()).synth(r),
        warm: (r) => (r.engine === 'vits' ? vits() : piper()).warm?.(r),
        close: () => (this.piper?.close(), this.vits?.close()),
      };
    }
    return this.router;
  }

  /**
   * The synthesis request for a voice: its engine, folders and sampling noise, and the text as that voice can read
   * it (numbers in words for a voice without digits).
   */
  synthRequest(voiceId: string, text: string, speaker: number | undefined, speed: number): SynthRequest {
    const m = this.models.model(voiceId);
    const say = m?.spellNumbers ? spellNumbers(text, m.lang || '') : text;
    return { engine: m ? voiceEngineOf(m) : 'piper', voiceDir: this.models.root(voiceId), runtimeDir: this.models.root(PIPER_RUNTIME), text: say, speaker, speed, noise: m?.noise };
  }

  /** null = ready; otherwise a Dutch reason for the user. */
  sttProblem(modelId: string): string | null {
    const m = this.models.model(modelId);
    if (!m || m.kind !== 'stt') return 'Onbekend lokaal spraakmodel';
    const p = sttBackend().problem();
    if (p) return p;
    if (!this.models.installed(modelId)) return `Het lokale spraakmodel is nog niet gedownload (${mb(totalSize(m))}). Download het bij Instellingen › Spraak.`;
    return null;
  }

  ttsProblem(voiceId: string): string | null {
    const v = this.models.model(voiceId);
    if (!v || v.kind !== 'tts-voice') return 'Onbekende lokale stem';
    if (voiceEngineOf(v) === 'vits') {
      // Runs in TeamBot itself (sherpa-onnx): no Piper program needed, on every system sherpa-onnx runs on.
      const p = inProcessProblem();
      if (p) return p;
    } else {
      if (!this.models.supported(PIPER_RUNTIME)) return `Lokaal voorlezen (Piper) is niet beschikbaar voor ${platformKey()}`;
      if (!ttsOverride && !this.models.installed(PIPER_RUNTIME)) return 'Het voorleesprogramma (Piper) is nog niet gedownload';
    }
    if (!this.models.installed(voiceId)) return `De stem ${v.label} is nog niet gedownload`;
    return null;
  }

  /** Transcribe a complete WAV clip. */
  async transcribeWav(buf: Buffer, modelId: string, language: string): Promise<{ text: string; durationSec: number; ms: number }> {
    const { samples, sampleRate } = parseWav(buf);
    return this.transcribeSamples(samples, sampleRate, modelId, language);
  }

  /** Transcribe an Ogg/Opus voice note (WhatsApp, Telegram, phone recorders), decoded straight to 16 kHz. */
  async transcribeOggOpus(buf: Buffer, modelId: string, language: string): Promise<{ text: string; durationSec: number; ms: number }> {
    const { samples, sampleRate } = await decodeOggOpus(buf, STT_RATE);
    return this.transcribeSamples(samples, sampleRate, modelId, language);
  }

  async transcribeSamples(samples: Float32Array, sampleRate: number, modelId: string, language: string): Promise<{ text: string; durationSec: number; ms: number }> {
    const s16 = sampleRate === STT_RATE ? samples : resample(samples, sampleRate, STT_RATE);
    const durationSec = s16.length / STT_RATE;
    if (!hasSignal(s16, STT_RATE)) return { text: '', durationSec, ms: 0 };
    const r = await this.stt.decode(modelId, language, s16, STT_RATE);
    return { text: r?.text || '', durationSec, ms: r?.ms || 0 };
  }

  /** Start streaming synthesis; `onDone` gets the full PCM (to cache it). */
  startSpeech(o: { id: string; userId: string; text: string; voiceId: string; speaker?: number; speed: number; onDone(pcm: Buffer, sampleRate: number): void }): TtsJob {
    const voice = this.models.model(o.voiceId)!;
    const job: TtsJob = { id: o.id, userId: o.userId, sampleRate: voice.sampleRate || 22050, chunks: [], bytes: 0, done: false, error: null, finished: Promise.resolve(), listeners: new Set(), firstChunkMs: null };
    const notify = () => job.listeners.forEach((l) => l());
    const t0 = Date.now();
    job.finished = (async () => {
      try {
        for (const chunk of speechChunks(o.text)) {
          const r = await this.tts().synth(this.synthRequest(o.voiceId, chunk, o.speaker, o.speed));
          job.sampleRate = r.sampleRate;
          job.chunks.push(r.pcm);
          job.bytes += r.pcm.length;
          if (job.firstChunkMs === null) job.firstChunkMs = Date.now() - t0;
          notify();
        }
        job.done = true;
        o.onDone(Buffer.concat(job.chunks), job.sampleRate);
      } catch (e: any) {
        job.error = String(e?.message || e).slice(0, 300);
        job.done = true;
      } finally {
        notify();
        setTimeout(() => this.jobs.delete(job.id), 120_000).unref?.();
      }
    })();
    this.jobs.set(job.id, job);
    return job;
  }

  view() {
    const states = new Map(this.models.states().map((s) => [s.id, s]));
    return {
      platform: platformKey(),
      licencesChecked: LICENCES_CHECKED,
      // ttsSupported: the Piper program exists for this system (voices with voiceEngine 'vits' do not need it).
      runtime: { stt: sttBackend().name, sttProblem: sttBackend().problem(), tts: 'piper', ttsSupported: this.models.supported(PIPER_RUNTIME), vitsProblem: inProcessProblem() },
      models: this.models.list().map((m) => ({
        kind: m.kind,
        voiceEngine: m.kind === 'tts-voice' ? voiceEngineOf(m) : null,
        label: m.label,
        description: m.description,
        licence: m.licence,
        licenceNote: m.licenceNote || null,
        source: m.source,
        languages: m.languages,
        lang: m.lang || null,
        speakers: m.speakers || null,
        speedHint: m.speedHint || null,
        recommended: !!m.recommended,
        recommendedFor: m.recommendedFor || null,
        size: totalSize(m),
        ...states.get(m.id)!,
      })),
    };
  }

  close() {
    this.stt.close();
    this.sessions.stop();
    this.piper?.close();
    this.vits?.close();
    for (const id of this.models.states().filter((s) => s.status === 'downloading').map((s) => s.id)) this.models.cancel(id);
  }
}

let catalogOverride: LocalModel[] | null = null;
/** Tests: use a catalog whose files come from a local test server. */
export function setLocalCatalog(list: LocalModel[] | null) {
  catalogOverride = list;
}

const instances = new WeakMap<Ctx, LocalVoice>();
/** The LocalVoice of this app instance (created on first use). */
export function localVoice(ctx: Ctx): LocalVoice {
  let v = instances.get(ctx);
  if (!v) {
    v = new LocalVoice(ctx, { catalog: catalogOverride || undefined });
    instances.set(ctx, v);
  }
  return v;
}
export function closeLocalVoice(ctx: Ctx) {
  instances.get(ctx)?.close();
  instances.delete(ctx);
}

export const mb = (b: number) => (b >= 1e9 ? `${(b / 1e9).toFixed(1).replace('.', ',')} GB` : `${Math.round(b / 1e6)} MB`);
