import type { Agent, Ctx } from '../../core/types.js';
import { userLanguage } from '../../core/i18n.js';
import { GEMINI_LIVE_MODELS, GEMINI_VOICES, OPENAI_TTS_MODELS, REALTIME_MODELS, REALTIME_TRANSCRIBE_MODELS, REALTIME_VOICES, STT_LANGUAGES } from './catalog.js';
import { LOCAL_MODELS, LOCAL_STT_DEFAULT, LOCAL_VOICE_EN_DEFAULT, type LocalModel } from './local/catalog.js';
import { localVoice } from './local/service.js';
import { DEFAULT_HOTKEY, parseHotkey } from './hotkey.js';
import { AUTO_APP, preferInstalled, resolveSttLanguage, sttModelLanguage, sttModelsFor, voicesFor } from '../../../shared/voiceLanguage.js';

/** 'local' = free and on this computer (Piper); 'auto' = local when installed, else OpenAI, else the browser voice. */
export type TtsEngine = 'auto' | 'local' | 'browser' | 'provider' | 'off';
/** 'local' = free, on this computer (Parakeet/Whisper via sherpa-onnx). */
export type SttEngine = 'local' | 'provider' | 'browser';
export type LiveMode = 'direct' | 'agent';
/**
 * Calls: 'local' = free turn-taking call (local STT → the bot → local TTS); 'realtime' = OpenAI Realtime (paid);
 * 'gemini' = Gemini Live (paid, or Google's free tier). The cloud kinds put a voice model in front of the bot.
 */
export type CallEngine = 'local' | 'realtime' | 'gemini';
/**
 * How you talk in a call: 'hold' = hold a key/button while you talk (push-to-talk), 'handsfree' = the microphone
 * listens and a pause ends your turn, 'auto' = hold on a computer and hands-free on a phone (ui/src/modules/voice/talk.ts).
 */
export type CallTalk = 'auto' | 'hold' | 'handsfree';

/**
 * Per-user voice settings (stored under settings key "voice"). Automatic choices follow the interface language:
 * stt.language 'auto-app', stt.localModel '' and tts.localVoice '' (see effectiveSettings).
 */
export interface VoiceSettings {
  /** language: 'auto-app' | 'auto' | 'auto-nl' | a fixed code (STT_LANGUAGES); localModel: '' = recommended for the language. */
  stt: { engine: SttEngine; providerId: string | null; model: string; language: string; localModel: string };
  tts: {
    engine: TtsEngine;
    providerId: string | null;
    model: string;
    voice: string;
    speed: number;
    instructions: string;
    browserVoice: string;
    /**
     * Local voice ('' = the recommended voice for the interface language). Text in another language is read by
     * an installed voice for that language; `localVoiceEn` is the one for English ('' = English with this voice).
     */
    localVoice: string;
    localSpeaker: number;
    localVoiceEn: string;
    /** Start reading aloud while the bot is still writing (local voice; first sentence first). */
    streaming: boolean;
  };
  call: { engine: CallEngine; bargeIn: boolean; silenceMs: number; talk: CallTalk };
  realtime: { providerId: string | null; model: string; voice: string; transcribeModel: string; mode: LiveMode; sendContext: boolean; vad: 'semantic' | 'server' };
  /** Gemini Live: a Google Gemini provider with an API key (AI Studio); uses the same mode and context choice as realtime. */
  gemini: { providerId: string | null; model: string; voice: string };
  /** Warn at 80 % and hang up at 100 % of this amount per call (USD). */
  priceCapUsd: number;
  maxMinutes: number;
  keepTranscripts: boolean;
  /** Delete voice-memo audio after N days (0 = keep). Transcripts stay in the chat. */
  audioDays: number;
  /** Delete cached spoken replies not played for N days. */
  ttsCacheDays: number;
  /** Desktop app: dictate into any program with a global key combination (off until the owner turns it on). */
  hotkey: { enabled: boolean; accelerator: string };
}

/** Per-bot voice (agent.settings.voice). Empty fields fall back to the user defaults. */
export interface AgentVoice {
  engine?: TtsEngine | 'default';
  providerId?: string | null;
  model?: string;
  voice?: string;
  speed?: number;
  instructions?: string;
  browserVoice?: string;
  localVoice?: string;
  localSpeaker?: number;
  autoRead?: boolean;
  realtimeVoice?: string;
  liveMode?: LiveMode | 'default';
}

export const DEFAULTS: VoiceSettings = {
  stt: { engine: 'local', providerId: null, model: '', language: AUTO_APP, localModel: '' },
  tts: { engine: 'local', providerId: null, model: 'gpt-4o-mini-tts', voice: 'marin', speed: 1, instructions: '', browserVoice: '', localVoice: '', localSpeaker: 0, localVoiceEn: LOCAL_VOICE_EN_DEFAULT, streaming: true },
  call: { engine: 'local', bargeIn: true, silenceMs: 800, talk: 'auto' },
  // 'agent' ("Bot bedienen"): your requests go to the bot itself, with its own model, tools and approvals; the Realtime
  // model is only the voice in between. 'direct' lets the Realtime model answer by itself (another model than the bot's
  // in the chat), so it is a choice, never the default (0.4: the same brain in voice as in text).
  realtime: { providerId: null, model: 'gpt-realtime-2.1-mini', voice: 'marin', transcribeModel: 'gpt-4o-mini-transcribe', mode: 'agent', sendContext: true, vad: 'semantic' },
  gemini: { providerId: null, model: 'gemini-3.8-live', voice: 'Kore' },
  priceCapUsd: 1,
  maxMinutes: 30,
  keepTranscripts: true,
  audioDays: 0,
  ttsCacheDays: 30,
  hotkey: { enabled: false, accelerator: DEFAULT_HOTKEY },
};

const s = (v: any, max = 200) => (typeof v === 'string' ? v.slice(0, max) : '');
const num = (v: any, min: number, max: number, def: number) => {
  const x = Number(v);
  return Number.isFinite(x) ? Math.min(max, Math.max(min, x)) : def;
};
const pick = <T extends string>(v: any, allowed: readonly T[], def: T): T => (allowed.includes(v) ? v : def);
const modelName = (v: any) => (typeof v === 'string' && /^[\w.:/@-]{0,120}$/.test(v) ? v : '');
const voiceName = (v: any) => (typeof v === 'string' && /^[\w.-]{0,80}$/.test(v) ? v : '');
const localId = (v: any, kind: 'stt' | 'tts-voice') => (typeof v === 'string' && LOCAL_MODELS.some((m) => m.id === v && m.kind === kind) ? v : '');

/** Coerce anything (also data written via the generic /api/settings) into valid settings. */
export function sanitize(raw: any): VoiceSettings {
  const r = raw && typeof raw === 'object' ? raw : {};
  const stt = r.stt || {};
  const tts = r.tts || {};
  const rt = r.realtime || {};
  const call = r.call || {};
  const gm = r.gemini || {};
  return {
    stt: {
      engine: pick(stt.engine, ['local', 'provider', 'browser'] as const, DEFAULTS.stt.engine),
      providerId: typeof stt.providerId === 'string' && stt.providerId ? stt.providerId.slice(0, 60) : null,
      model: modelName(stt.model),
      language: STT_LANGUAGES.some((l) => l.id === stt.language) ? stt.language : DEFAULTS.stt.language,
      // '' (or anything unknown) = automatic: the recommended model for the dictation language.
      localModel: localId(stt.localModel, 'stt'),
    },
    tts: {
      engine: pick(tts.engine, ['auto', 'local', 'browser', 'provider', 'off'] as const, DEFAULTS.tts.engine),
      providerId: typeof tts.providerId === 'string' && tts.providerId ? tts.providerId.slice(0, 60) : null,
      model: modelName(tts.model) || DEFAULTS.tts.model,
      voice: voiceName(tts.voice) || DEFAULTS.tts.voice,
      speed: num(tts.speed, 0.25, 4, 1),
      instructions: s(tts.instructions, 1000),
      browserVoice: s(tts.browserVoice, 200),
      localVoice: localId(tts.localVoice, 'tts-voice'),
      localSpeaker: Math.round(num(tts.localSpeaker, 0, 999, 0)),
      localVoiceEn: tts.localVoiceEn === '' ? '' : localId(tts.localVoiceEn, 'tts-voice') || DEFAULTS.tts.localVoiceEn,
      streaming: tts.streaming === undefined ? DEFAULTS.tts.streaming : !!tts.streaming,
    },
    call: {
      engine: pick(call.engine, ['local', 'realtime', 'gemini'] as const, DEFAULTS.call.engine),
      bargeIn: call.bargeIn === undefined ? DEFAULTS.call.bargeIn : !!call.bargeIn,
      silenceMs: Math.round(num(call.silenceMs, 400, 3000, DEFAULTS.call.silenceMs)),
      talk: pick(call.talk, ['auto', 'hold', 'handsfree'] as const, DEFAULTS.call.talk),
    },
    realtime: {
      providerId: typeof rt.providerId === 'string' && rt.providerId ? rt.providerId.slice(0, 60) : null,
      model: REALTIME_MODELS.some((m) => m.id === rt.model) ? rt.model : DEFAULTS.realtime.model,
      voice: REALTIME_VOICES.includes(rt.voice) ? rt.voice : DEFAULTS.realtime.voice,
      transcribeModel: rt.transcribeModel === '' || REALTIME_TRANSCRIBE_MODELS.some((m) => m.id === rt.transcribeModel) ? (rt.transcribeModel ?? DEFAULTS.realtime.transcribeModel) : DEFAULTS.realtime.transcribeModel,
      mode: pick(rt.mode, ['direct', 'agent'] as const, DEFAULTS.realtime.mode),
      sendContext: rt.sendContext === undefined ? DEFAULTS.realtime.sendContext : !!rt.sendContext,
      vad: pick(rt.vad, ['semantic', 'server'] as const, DEFAULTS.realtime.vad),
    },
    gemini: {
      providerId: typeof gm.providerId === 'string' && gm.providerId ? gm.providerId.slice(0, 60) : null,
      model: GEMINI_LIVE_MODELS.some((m) => m.id === gm.model) ? gm.model : DEFAULTS.gemini.model,
      voice: GEMINI_VOICES.includes(gm.voice) ? gm.voice : DEFAULTS.gemini.voice,
    },
    priceCapUsd: num(r.priceCapUsd, 0.05, 50, DEFAULTS.priceCapUsd),
    maxMinutes: Math.round(num(r.maxMinutes, 1, 120, DEFAULTS.maxMinutes)),
    keepTranscripts: r.keepTranscripts === undefined ? DEFAULTS.keepTranscripts : !!r.keepTranscripts,
    audioDays: Math.round(num(r.audioDays, 0, 3650, DEFAULTS.audioDays)),
    ttsCacheDays: Math.round(num(r.ttsCacheDays, 1, 3650, DEFAULTS.ttsCacheDays)),
    hotkey: {
      enabled: !!r.hotkey?.enabled,
      accelerator: parseHotkey(r.hotkey?.accelerator)?.accel || DEFAULTS.hotkey.accelerator,
    },
  };
}

export function sanitizeAgentVoice(raw: any): AgentVoice {
  const r = raw && typeof raw === 'object' ? raw : {};
  const out: AgentVoice = {};
  if (['default', 'auto', 'local', 'browser', 'provider', 'off'].includes(r.engine)) out.engine = r.engine;
  if (typeof r.providerId === 'string' && r.providerId) out.providerId = r.providerId.slice(0, 60);
  if (modelName(r.model)) out.model = modelName(r.model);
  if (voiceName(r.voice)) out.voice = voiceName(r.voice);
  if (r.speed !== undefined && r.speed !== null && r.speed !== '') out.speed = num(r.speed, 0.25, 4, 1);
  if (s(r.instructions, 1000)) out.instructions = s(r.instructions, 1000);
  if (s(r.browserVoice)) out.browserVoice = s(r.browserVoice);
  if (localId(r.localVoice, 'tts-voice')) out.localVoice = r.localVoice;
  if (r.localSpeaker !== undefined && r.localSpeaker !== null && r.localSpeaker !== '') out.localSpeaker = Math.round(num(r.localSpeaker, 0, 999, 0));
  if (r.autoRead !== undefined) out.autoRead = !!r.autoRead;
  if (REALTIME_VOICES.includes(r.realtimeVoice)) out.realtimeVoice = r.realtimeVoice;
  if (['default', 'direct', 'agent'].includes(r.liveMode)) out.liveMode = r.liveMode;
  return out;
}

/** The language voice defaults follow: the user's interface language ('nl' until they choose one). */
export const voiceLanguage = (ctx: Ctx, userId: string) => userLanguage(ctx.store, userId);

/** Automatic speech recognition model for a language: the recommended one, or a suitable one that is installed. */
export function autoSttModel(lang: string, installed: (id: string) => boolean, models: LocalModel[] = LOCAL_MODELS): string {
  return preferInstalled(sttModelsFor(lang, models), installed)?.id || LOCAL_STT_DEFAULT;
}

/** Automatic local voice for a language: the recommended one, or another installed voice for it ('' = none exists). */
export function autoVoice(lang: string, installed: (id: string) => boolean, models: LocalModel[] = LOCAL_MODELS): string {
  return preferInstalled(voicesFor(lang, models), installed)?.id || '';
}

/**
 * Settings with the automatic choices filled in for interface language `lang` (what the engines use). The speech
 * model follows the dictation language (Turkish dictation in a Dutch interface → Whisper), the voice the interface.
 */
export function effectiveSettings(s: VoiceSettings, lang: string, installed: (id: string) => boolean = () => false, models: LocalModel[] = LOCAL_MODELS): VoiceSettings {
  const sttLanguage = resolveSttLanguage(s.stt.language, lang);
  return {
    ...s,
    stt: { ...s.stt, language: sttLanguage, localModel: s.stt.localModel || autoSttModel(sttModelLanguage(sttLanguage, lang), installed, models) },
    tts: { ...s.tts, localVoice: s.tts.localVoice || autoVoice(lang, installed, models) },
  };
}

/** The settings as the user saved them ('' / 'auto-app' = automatic), for the settings page. */
export function storedSettings(ctx: Ctx, userId: string): VoiceSettings {
  const s = sanitize(ctx.store.getSetting(userId, 'voice', {}));
  // "Automatisch (Nederlands voorkeur)" was the default before there were other languages; with a Dutch interface it
  // means exactly the same as the new automatic default, which then also follows a later change of language.
  if (s.stt.language === 'auto-nl' && voiceLanguage(ctx, userId) === 'nl') s.stt.language = AUTO_APP;
  return s;
}

/** The settings the engines use: automatic choices resolved for the user's interface language. */
export function getSettings(ctx: Ctx, userId: string): VoiceSettings {
  const lv = localVoice(ctx);
  return effectiveSettings(storedSettings(ctx, userId), voiceLanguage(ctx, userId), (id) => lv.models.installed(id), lv.models.list());
}

export function saveSettings(ctx: Ctx, userId: string, patch: any): VoiceSettings {
  const cur = storedSettings(ctx, userId);
  const p = patch && typeof patch === 'object' ? patch : {};
  const merged = sanitize({
    ...cur,
    ...p,
    stt: { ...cur.stt, ...(p.stt || {}) },
    tts: { ...cur.tts, ...(p.tts || {}) },
    call: { ...cur.call, ...(p.call || {}) },
    realtime: { ...cur.realtime, ...(p.realtime || {}) },
    gemini: { ...cur.gemini, ...(p.gemini || {}) },
    hotkey: { ...cur.hotkey, ...(p.hotkey || {}) },
  });
  ctx.store.setSetting(userId, 'voice', merged);
  return merged;
}

/** The TTS configuration that applies to one bot (bot overrides on top of user defaults). */
export function ttsFor(settings: VoiceSettings, agent: Agent | null, override?: AgentVoice) {
  const av = { ...sanitizeAgentVoice(agent?.settings?.voice), ...(override ? sanitizeAgentVoice(override) : {}) };
  const engine: TtsEngine = av.engine && av.engine !== 'default' ? av.engine : settings.tts.engine;
  const model = av.model || settings.tts.model;
  const known = OPENAI_TTS_MODELS.find((m) => m.id === model);
  let voice = av.voice || settings.tts.voice;
  if (known && !known.voices.includes(voice)) voice = known.voices[0];
  return {
    engine,
    providerId: av.providerId || settings.tts.providerId,
    model,
    voice,
    speed: av.speed ?? settings.tts.speed,
    instructions: av.instructions ?? settings.tts.instructions,
    browserVoice: av.browserVoice || settings.tts.browserVoice,
    // A bot with its own local voice keeps it for every language (except text in a script it cannot read); otherwise
    // text in another language is read by an installed voice for that language (English: the English voice).
    localVoice: av.localVoice || settings.tts.localVoice,
    localSpeaker: av.localVoice ? (av.localSpeaker ?? 0) : (av.localSpeaker ?? settings.tts.localSpeaker),
    localVoiceEn: av.localVoice ? '' : settings.tts.localVoiceEn,
    matchLanguage: !av.localVoice,
    autoRead: !!av.autoRead,
  };
}
