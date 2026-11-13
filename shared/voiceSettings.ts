/**
 * The voice settings: per user (settings key "voice") and per bot (agent.settings.voice). The server checks and
 * stores them (server/modules/voice/settings.ts); the Spraak screens show and change them. Types only.
 */

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
