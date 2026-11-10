import { api, on } from '../../lib/api';
import type { SttEngine } from './api';
import { transcribeBlob } from './api';
import { LevelMeter, Recording, recognizeOnce } from './audio';
import { PcmCapture } from './capture';
import { HalfDuplexCore, type HdCallbacks, type HdDeps } from './halfduplex-core';
import { lastFirstAudioMs, outputLevel, playLive, playMessage, stopPlayback } from './player';
import type { TalkMode } from './talk';

export type { HdCallbacks, HdState, HdTiming } from './halfduplex-core';

/** The browser parts of the free spoken call: microphone, API, live events, playback, speech recognition. */
const browserDeps: HdDeps = {
  post: (p, body) => api.post(p, body),
  get: (p) => api.get(p),
  on: (type, fn) => on(type, fn),
  transcribe: (blob, o) => transcribeBlob(blob, o),
  playLive: (speech, o) => playLive(speech, o),
  playMessage: (messageId, o) => playMessage(messageId, o),
  stopPlayback: () => stopPlayback(),
  lastFirstAudioMs: () => lastFirstAudioMs,
  openCapture: (stream) => PcmCapture.open(stream),
  levelMeter: (stream) => new LevelMeter(stream),
  recording: (stream) => new Recording(stream),
  recognizeOnce: (lang, onPartial, continuous) => recognizeOnce(lang, onPartial, !!continuous),
  // The bot's own voice as it plays (the samples the player scheduled): the barge-in detector's echo reference.
  outputLevel: () => outputLevel(),
  now: () => performance.now(),
};

/**
 * A spoken call that works with every bot and engine: take turns, hold-to-talk or hands-free, with barge-in (see
 * halfduplex-core.ts for the turn-taking itself).
 */
export class HalfDuplexCall extends HalfDuplexCore {
  constructor(o: { callId: string; sttEngine: SttEngine; lang: string; bargeIn?: boolean; silenceMs?: number; talk?: TalkMode; cb: HdCallbacks }) {
    super(o, browserDeps);
  }
}
