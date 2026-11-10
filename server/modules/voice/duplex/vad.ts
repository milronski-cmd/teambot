import { createRequire } from 'node:module';
import { preloadOrt } from '../local/ort.js';

/** Is someone speaking right now? Fed with 16 kHz mono float samples in any chunk size. */
export interface VoiceActivity {
  accept(samples: Float32Array): void;
  /** Speech detected (true from `minSpeech` after the start until `minSilence` after the end). */
  speaking(): boolean;
  reset(): void;
  close?(): void;
}

export interface VadOptions {
  /** Silence after speech before it counts as ended (s). Short: Smart Turn decides whether the turn is over. */
  minSilence: number;
  /** Speech needed before it counts as speech (s): coughs and clicks do not interrupt the bot. */
  minSpeech: number;
  threshold: number;
}

export const VAD_DEFAULTS: VadOptions = { minSilence: 0.2, minSpeech: 0.25, threshold: 0.5 };

const req = createRequire(import.meta.url);

/** Silero VAD (MIT) through sherpa-onnx's `Vad` (Apache-2.0): < 1 ms per 32 ms window on a desktop CPU. */
export function sileroVad(model: string, o: VadOptions = VAD_DEFAULTS): VoiceActivity {
  preloadOrt();
  const sherpa = req('sherpa-onnx-node');
  const vad = new sherpa.Vad(
    { sileroVad: { model, threshold: o.threshold, minSilenceDuration: o.minSilence, minSpeechDuration: o.minSpeech, windowSize: 512, maxSpeechDuration: 30 }, sampleRate: 16000, numThreads: 1, provider: 'cpu', debug: false },
    60,
  );
  return {
    accept(samples) {
      vad.acceptWaveform(samples);
      // Finished segments are not needed (the session keeps its own audio): drop them so the buffer stays small.
      while (!vad.isEmpty()) vad.pop();
    },
    speaking: () => !!vad.isDetected(),
    reset: () => vad.reset(),
  };
}

/**
 * Loudness-based fallback with the same timing rules (tests, and as a stand-in until the Silero model is there).
 * Speech = 20 ms frames above `level` RMS.
 */
export function energyVad(o: VadOptions & { level?: number } = VAD_DEFAULTS): VoiceActivity {
  const level = o.level ?? 0.02;
  let on = false;
  let run = 0;
  let quiet = 0;
  let rest = new Float32Array(0);
  return {
    accept(samples) {
      const buf = new Float32Array(rest.length + samples.length);
      buf.set(rest);
      buf.set(samples, rest.length);
      let i = 0;
      for (; i + 320 <= buf.length; i += 320) {
        let s = 0;
        for (let k = i; k < i + 320; k++) s += buf[k] * buf[k];
        const loud = Math.sqrt(s / 320) > level;
        if (loud) (run += 0.02), (quiet = 0);
        else (quiet += 0.02), (run = on ? run : 0);
        if (!on && run >= o.minSpeech) on = true;
        if (on && quiet >= o.minSilence) (on = false), (run = 0);
      }
      rest = buf.slice(i);
    },
    speaking: () => on,
    reset() {
      on = false;
      run = quiet = 0;
      rest = new Float32Array(0);
    },
  };
}
