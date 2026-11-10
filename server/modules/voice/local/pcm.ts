/** PCM helpers for the local speech engines: WAV parsing, resampling, int16/float conversion and pause finding. */
import { detectTextLanguage } from '../textlang.js';

export const STT_RATE = 16000;

export interface Pcm {
  samples: Float32Array;
  sampleRate: number;
}

/** Parse a RIFF/WAVE file (PCM 8/16/24/32-bit or IEEE float 32) into mono float samples. */
export function parseWav(buf: Buffer): Pcm {
  if (buf.length < 12 || buf.toString('latin1', 0, 4) !== 'RIFF' || buf.toString('latin1', 8, 12) !== 'WAVE') throw new Error('Geen geldig WAV-bestand');
  let pos = 12;
  let fmt: { format: number; channels: number; rate: number; bits: number } | null = null;
  let data: Buffer | null = null;
  while (pos + 8 <= buf.length) {
    const id = buf.toString('latin1', pos, pos + 4);
    let size = buf.readUInt32LE(pos + 4);
    const start = pos + 8;
    if (size === 0xffffffff || start + size > buf.length) size = buf.length - start; // streamed/truncated
    if (id === 'fmt ' && size >= 16) {
      let format = buf.readUInt16LE(start);
      if (format === 0xfffe && size >= 26) format = buf.readUInt16LE(start + 24); // WAVE_FORMAT_EXTENSIBLE
      fmt = { format, channels: buf.readUInt16LE(start + 2), rate: buf.readUInt32LE(start + 4), bits: buf.readUInt16LE(start + 14) };
    } else if (id === 'data') {
      data = buf.subarray(start, start + size);
      if (fmt) break;
    }
    pos = start + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV-bestand zonder audio');
  const { format, channels, rate, bits } = fmt;
  if (channels < 1 || channels > 8 || rate < 4000 || rate > 192000) throw new Error('Niet-ondersteund WAV-formaat');
  const bytes = bits / 8;
  if (!((format === 1 && [8, 16, 24, 32].includes(bits)) || (format === 3 && bits === 32))) throw new Error('Niet-ondersteund WAV-formaat (alleen PCM of float)');
  const frames = Math.floor(data.length / (bytes * channels));
  const out = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let acc = 0;
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * bytes;
      let v: number;
      if (format === 3) v = data.readFloatLE(o);
      else if (bits === 16) v = data.readInt16LE(o) / 32768;
      else if (bits === 8) v = (data[o] - 128) / 128;
      else if (bits === 24) v = data.readIntLE(o, 3) / 8388608;
      else v = data.readInt32LE(o) / 2147483648;
      acc += v;
    }
    out[i] = acc / channels;
  }
  return { samples: out, sampleRate: rate };
}

/** Resample mono audio. Downsampling averages over the source window first (cheap anti-aliasing). */
export function resample(samples: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return samples;
  const ratio = from / to;
  const n = Math.max(0, Math.floor(samples.length / ratio));
  const out = new Float32Array(n);
  if (ratio > 1) {
    for (let i = 0; i < n; i++) {
      const a = i * ratio;
      const b = Math.min(samples.length, a + ratio);
      let s = 0;
      let c = 0;
      for (let k = Math.floor(a); k < b; k++) (s += samples[k]), c++;
      out[i] = c ? s / c : 0;
    }
  } else {
    for (let i = 0; i < n; i++) {
      const x = i * ratio;
      const k = Math.floor(x);
      const f = x - k;
      out[i] = (samples[k] ?? 0) * (1 - f) + (samples[k + 1] ?? samples[k] ?? 0) * f;
    }
  }
  return out;
}

export function int16ToFloat(buf: Buffer | Int16Array): Float32Array {
  const i16 = buf instanceof Int16Array ? buf : new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.length / 2));
  const out = new Float32Array(i16.length);
  for (let i = 0; i < i16.length; i++) out[i] = i16[i] / 32768;
  return out;
}

export function floatToInt16(samples: Float32Array): Int16Array {
  const out = new Int16Array(samples.length);
  for (let i = 0; i < samples.length; i++) {
    const v = Math.max(-1, Math.min(1, samples[i]));
    out[i] = v < 0 ? v * 32768 : v * 32767;
  }
  return out;
}

/** RMS per frame of `frameMs`. */
export function frameRms(samples: Float32Array, rate: number, frameMs = 20): Float32Array {
  const len = Math.max(1, Math.round((rate * frameMs) / 1000));
  const n = Math.floor(samples.length / len);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * len; i < (f + 1) * len; i++) s += samples[i] * samples[i];
    out[f] = Math.sqrt(s / len);
  }
  return out;
}

/**
 * Find a pause to cut a long recording at: the middle of the longest run of quiet frames (≥ minSilenceMs) between
 * `from` and `to` (sample indices). Quiet = below max(0.0015, 2.5 × the 10th-percentile frame level). Returns null
 * when there is no such pause.
 */
export function findPause(samples: Float32Array, rate: number, from: number, to: number, minSilenceMs = 350): number | null {
  const frameMs = 20;
  const len = Math.round((rate * frameMs) / 1000);
  const seg = samples.subarray(Math.max(0, from), Math.min(samples.length, to));
  const rms = frameRms(seg, rate, frameMs);
  if (rms.length < 3) return null;
  const sorted = [...rms].sort((a, b) => a - b);
  const floor = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const thr = Math.max(0.0015, floor * 2.5);
  const need = Math.ceil(minSilenceMs / frameMs);
  let best: { start: number; len: number } | null = null;
  let runStart = -1;
  for (let i = 0; i <= rms.length; i++) {
    const quiet = i < rms.length && rms[i] < thr;
    if (quiet && runStart < 0) runStart = i;
    if (!quiet && runStart >= 0) {
      const l = i - runStart;
      if (l >= need && (!best || l > best.len)) best = { start: runStart, len: l };
      runStart = -1;
    }
  }
  if (!best) return null;
  return Math.max(0, from) + Math.round((best.start + best.len / 2) * len);
}

/** Index of the quietest 100 ms window between from and to (forced cut when somebody never pauses). */
export function quietest(samples: Float32Array, rate: number, from: number, to: number): number {
  const rms = frameRms(samples.subarray(from, to), rate, 100);
  let k = 0;
  for (let i = 1; i < rms.length; i++) if (rms[i] < rms[k]) k = i;
  return from + Math.round((k + 0.5) * rate * 0.1);
}

/**
 * Is there anything that could be speech? Relative to the clip's own noise floor (quiet microphones are common:
 * speech at -30 dBFS is still recognised fine), so pure silence or a steady hum is skipped (Whisper would
 * otherwise invent a sentence).
 */
export function hasSignal(samples: Float32Array, rate: number): boolean {
  const rms = frameRms(samples, rate, 30);
  if (rms.length < 3) return false;
  const sorted = [...rms].sort((a, b) => a - b);
  const p10 = sorted[Math.floor(sorted.length * 0.1)] || 0;
  const p95 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] || 0;
  if (p95 < 0.0015) return false;
  // Speech goes up and down; a steady hum does not. Loud throughout (no pauses at all) also counts.
  return p95 > p10 * 3 || p10 > 0.01;
}

/** Dutch or English only ('nl', 'en' or null): the old two-language guess. Other languages: detectTextLanguage. */
export function guessLanguage(text: string): 'nl' | 'en' | null {
  const l = detectTextLanguage(text, 'nl');
  return l === 'nl' || l === 'en' ? l : null;
}
