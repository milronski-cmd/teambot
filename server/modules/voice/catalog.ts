/**
 * Server-side allowlist of voice models with prices (USD). Checked against the official OpenAI pricing and API
 * reference on PRICES_CHECKED. Model names and prices change: the browser never decides which model or price is
 * used — the server validates every choice against this list.
 */
export const PRICES_CHECKED = '2026-11-06';

export interface TokenRates {
  in: number;
  cached: number;
  out: number;
}

export interface RealtimeModel {
  id: string;
  label: string;
  /** USD per 1M tokens */
  text: TokenRates;
  audio: TokenRates;
}

export const REALTIME_MODELS: RealtimeModel[] = [
  { id: 'gpt-realtime-2.1-mini', label: 'GPT Realtime 2.1 mini — voordelig', text: { in: 0.6, cached: 0.06, out: 2.4 }, audio: { in: 10, cached: 0.3, out: 20 } },
  { id: 'gpt-realtime-2.1', label: 'GPT Realtime 2.1 — beste kwaliteit', text: { in: 4, cached: 0.4, out: 24 }, audio: { in: 32, cached: 0.4, out: 64 } },
  { id: 'gpt-realtime-2', label: 'GPT Realtime 2', text: { in: 4, cached: 0.4, out: 24 }, audio: { in: 32, cached: 0.4, out: 64 } },
  { id: 'gpt-realtime-mini', label: 'GPT Realtime mini (vorige generatie)', text: { in: 0.6, cached: 0.06, out: 2.4 }, audio: { in: 10, cached: 0.3, out: 20 } },
  { id: 'gpt-realtime', label: 'GPT Realtime (vorige generatie)', text: { in: 4, cached: 0.4, out: 16 }, audio: { in: 32, cached: 0.4, out: 64 } },
];

/**
 * Gemini Live (Google, second cloud voice; speaks Dutch). Prices per 1M tokens (paid tier, checked 2026-11-09 on
 * https://aistudio.google.com/docs/pricing): text in $0.75, audio in $3, text out $4.50, audio out $12 (≈ $0.005/min
 * in, $0.018/min out). There is a free tier in which Google may use the input to improve its products.
 */
export const GEMINI_LIVE_MODELS: RealtimeModel[] = [{ id: 'gemini-3.8-live', label: 'Gemini 3.8 Live', text: { in: 0.75, cached: 0.75, out: 4.5 }, audio: { in: 3, cached: 3, out: 12 } }];
/** Prebuilt Gemini Live voices (all speak every supported language, Dutch included). */
export const GEMINI_VOICES = ['Kore', 'Puck', 'Charon', 'Aoede', 'Fenrir', 'Leda', 'Orus', 'Zephyr'];
/** Per-minute range for Gemini Live (half the time each side talks, plus the context it re-reads). */
export const GEMINI_ESTIMATE = { low: 0.01, high: 0.03 };

/** Built-in Realtime voices (OpenAI recommends marin or cedar). */
export const REALTIME_VOICES = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'sage', 'shimmer', 'verse'];

export interface PerMinuteModel {
  id: string;
  label: string;
  /** USD per minute of audio (estimate published by OpenAI). */
  perMin: number;
  /** After this date the model is shut down; the server switches to `fallback`. */
  deprecatedAfter?: string;
  fallback?: string;
  /** Returns real segment timestamps (verbose_json) for captions. */
  segments?: boolean;
  /** USD per 1M tokens when the API reports token usage instead of seconds. */
  tokIn?: number;
  tokOut?: number;
}

/** Input transcription inside a Realtime session (live captions of what the user says). */
export const REALTIME_TRANSCRIBE_MODELS: PerMinuteModel[] = [
  { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe — voordelig', perMin: 0.003, tokIn: 1.25, tokOut: 5, deprecatedAfter: '2027-02-26', fallback: 'gpt-live-transcribe' },
  { id: 'gpt-live-transcribe', label: 'gpt-live-transcribe — aanbevolen live-model', perMin: 0.017 },
  { id: 'gpt-realtime-whisper', label: 'gpt-realtime-whisper', perMin: 0.017 },
];

/** File transcription (/v1/audio/transcriptions) on OpenAI. Other providers: free-form model, price unknown. */
export const OPENAI_STT_MODELS: PerMinuteModel[] = [
  { id: 'gpt-transcribe', label: 'gpt-transcribe — aanbevolen', perMin: 0.0045 },
  { id: 'gpt-4o-mini-transcribe', label: 'gpt-4o-mini-transcribe — voordelig', perMin: 0.003, deprecatedAfter: '2027-02-26', fallback: 'gpt-transcribe' },
  { id: 'gpt-4o-transcribe', label: 'gpt-4o-transcribe', perMin: 0.006, deprecatedAfter: '2027-02-26', fallback: 'gpt-transcribe' },
  { id: 'whisper-1', label: 'whisper-1 — met echte ondertiteltijden', perMin: 0.006, deprecatedAfter: '2027-02-26', fallback: 'gpt-transcribe', segments: true },
];

export interface TtsModel {
  id: string;
  label: string;
  voices: string[];
  /** USD per 1M characters (tts-1 style) */
  perMChars?: number;
  /** USD per 1M tokens text in / audio out (gpt-4o-mini-tts style) */
  textIn?: number;
  audioOut?: number;
  instructions?: boolean;
  /** Synthesised through the Realtime API (WebSocket) instead of /audio/speech. */
  realtime?: boolean;
  deprecatedAfter?: string;
  maxSpeed: number;
}

const TTS_VOICES_NEW = ['marin', 'cedar', 'alloy', 'ash', 'ballad', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer', 'verse'];
const TTS_VOICES_OLD = ['alloy', 'ash', 'coral', 'echo', 'fable', 'nova', 'onyx', 'sage', 'shimmer'];

export const OPENAI_TTS_MODELS: TtsModel[] = [
  { id: 'gpt-4o-mini-tts', label: 'gpt-4o-mini-tts — natuurlijk, met stijl-instructies', voices: TTS_VOICES_NEW, textIn: 0.6, audioOut: 12, instructions: true, deprecatedAfter: '2027-01-06', maxSpeed: 4 },
  { id: 'gpt-realtime-2.1-mini', label: 'gpt-realtime-2.1-mini (via Realtime) — opvolger', voices: REALTIME_VOICES, textIn: 0.6, audioOut: 20, instructions: true, realtime: true, maxSpeed: 1.5 },
  { id: 'tts-1', label: 'tts-1 — snel', voices: TTS_VOICES_OLD, perMChars: 15, deprecatedAfter: '2027-01-06', maxSpeed: 4 },
  { id: 'tts-1-hd', label: 'tts-1-hd — hogere kwaliteit', voices: TTS_VOICES_OLD, perMChars: 30, deprecatedAfter: '2027-01-06', maxSpeed: 4 },
];

/**
 * Dictation language. 'auto-app' (default): detect, with the interface language as hint. 'auto-nl': the old default
 * (Dutch hint), kept for users who chose it with another interface language. Fixed codes cover every interface
 * language. The page shows the 'auto-app' label with the actual language name.
 */
export const STT_LANGUAGES: { id: string; label: string }[] = [
  { id: 'auto-app', label: 'Automatisch (voorkeur: taal van de app)' },
  { id: 'auto', label: 'Volledig automatisch' },
  { id: 'auto-nl', label: 'Automatisch (Nederlands voorkeur)' },
  { id: 'nl', label: 'Nederlands' },
  { id: 'en', label: 'Engels' },
  { id: 'de', label: 'Duits' },
  { id: 'fr', label: 'Frans' },
  { id: 'es', label: 'Spaans' },
  { id: 'it', label: 'Italiaans' },
  { id: 'pt', label: 'Portugees' },
  { id: 'pl', label: 'Pools' },
  { id: 'tr', label: 'Turks' },
  { id: 'uk', label: 'Oekraïens' },
  { id: 'ar', label: 'Arabisch' },
];

/** Speech rates used for estimates: ~1 audio token per 100 ms in, per 50 ms out (OpenAI docs); ~15 chars/s speech. */
export const AUDIO_TOKENS_IN_PER_MIN = 600;
export const AUDIO_TOKENS_OUT_PER_MIN = 1200;
export const SPEECH_CHARS_PER_MIN = 900;

export const isPast = (date?: string, nowMs = Date.now()) => !!date && nowMs >= Date.parse(date + 'T00:00:00Z');

export function realtimeModel(id: string): RealtimeModel | undefined {
  return REALTIME_MODELS.find((m) => m.id === id);
}

/** Effective model after deprecation fallback. */
export function effective<T extends { id: string; deprecatedAfter?: string; fallback?: string }>(list: T[], id: string): T | undefined {
  let m = list.find((x) => x.id === id);
  for (let i = 0; m && isPast(m.deprecatedAfter) && m.fallback && i < 3; i++) m = list.find((x) => x.id === m!.fallback);
  return m;
}

/**
 * Rough per-minute cost range for a Realtime conversation, assuming the user and the AI each talk half the time.
 * low: most context re-reads hit the prompt cache. high: no cache hits. Transcription of the user's speech included.
 */
export function realtimeEstimate(modelId: string, transcribeId: string | null): { low: number; high: number } | null {
  const m = realtimeModel(modelId);
  if (!m) return null;
  const tr = transcribeId ? effective(REALTIME_TRANSCRIBE_MODELS, transcribeId) : undefined;
  const userAudio = AUDIO_TOKENS_IN_PER_MIN / 2;
  const aiAudio = AUDIO_TOKENS_OUT_PER_MIN / 2;
  const base = userAudio * m.audio.in + aiAudio * m.audio.out + 100 * m.text.out;
  const low = (base + 1500 * m.audio.cached + 300 * m.text.in) / 1e6 + (tr ? tr.perMin * 0.5 : 0);
  const high = (base + 3000 * m.audio.in + 600 * m.text.in) / 1e6 + (tr ? tr.perMin : 0);
  return { low: round(low), high: round(high) };
}

export interface RealtimeUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_token_details?: { text_tokens?: number; audio_tokens?: number; image_tokens?: number; cached_tokens?: number; cached_tokens_details?: { text_tokens?: number; audio_tokens?: number; image_tokens?: number } };
  output_token_details?: { text_tokens?: number; audio_tokens?: number };
}

const n = (v: any) => (typeof v === 'number' && isFinite(v) && v > 0 ? Math.min(v, 50_000_000) : 0);

/** Exact cost of one Realtime response from its `usage` block (response.done). */
/** Any cloud voice model with token prices (OpenAI Realtime or Gemini Live), for pricing a call's usage. */
export function liveModel(id: string): RealtimeModel | undefined {
  return realtimeModel(id) || GEMINI_LIVE_MODELS.find((m) => m.id === id);
}

export function realtimeUsageCost(modelId: string, u: RealtimeUsage): number {
  const m = liveModel(modelId);
  if (!m || !u) return 0;
  const inD = u.input_token_details || {};
  const cD = inD.cached_tokens_details || {};
  const outD = u.output_token_details || {};
  const cachedText = n(cD.text_tokens);
  const cachedAudio = n(cD.audio_tokens) + n(cD.image_tokens);
  const text = Math.max(0, n(inD.text_tokens) - cachedText) + n(inD.image_tokens);
  const audio = Math.max(0, n(inD.audio_tokens) - cachedAudio);
  const cost =
    text * m.text.in + audio * m.audio.in + cachedText * m.text.cached + cachedAudio * m.audio.cached + n(outD.text_tokens) * m.text.out + n(outD.audio_tokens) * m.audio.out;
  return cost / 1e6;
}

export function sttCost(modelId: string, seconds: number, kind: string): number | null {
  if (kind !== 'openai') return LOCAL_KINDS.has(kind) ? 0 : null;
  const m = OPENAI_STT_MODELS.find((x) => x.id === modelId) || REALTIME_TRANSCRIBE_MODELS.find((x) => x.id === modelId);
  if (!m) return null;
  return round((Math.max(0, seconds) / 60) * m.perMin, 6);
}

/** Cost of live input transcription inside a Realtime session (usage from ...input_audio_transcription.completed). */
export function transcribeUsageCost(modelId: string | null, u: { seconds?: number; input_tokens?: number; output_tokens?: number }): number {
  const m = modelId ? REALTIME_TRANSCRIBE_MODELS.find((x) => x.id === modelId) : undefined;
  if (!m || !u) return 0;
  if (n(u.seconds)) return (n(u.seconds) / 60) * m.perMin;
  if (m.tokIn !== undefined) return (n(u.input_tokens) * m.tokIn + n(u.output_tokens) * (m.tokOut || 0)) / 1e6;
  return (n(u.input_tokens) / AUDIO_TOKENS_IN_PER_MIN) * m.perMin;
}

export function ttsCost(modelId: string, chars: number, kind: string): number | null {
  if (kind !== 'openai') return LOCAL_KINDS.has(kind) ? 0 : null;
  const m = OPENAI_TTS_MODELS.find((x) => x.id === modelId);
  if (!m) return null;
  if (m.perMChars) return round((chars * m.perMChars) / 1e6, 6);
  const minutes = chars / SPEECH_CHARS_PER_MIN;
  const textTokens = chars / 4;
  return round((textTokens * (m.textIn || 0) + minutes * AUDIO_TOKENS_OUT_PER_MIN * (m.audioOut || 0)) / 1e6, 6);
}

export const LOCAL_KINDS = new Set(['ollama', 'lmstudio']);

export function round(v: number, digits = 4) {
  const f = 10 ** digits;
  return Math.round(v * f) / f;
}
