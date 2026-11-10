/**
 * Whisper-style log-mel features for Smart Turn v3 (80 mel bins × 800 frames = 8 s at 16 kHz), in plain TypeScript.
 *
 * Own implementation of the published math of `transformers.WhisperFeatureExtractor(chunk_length=8)` (Apache-2.0)
 * as Pipecat's Smart Turn v3 calls it (BSD-2-Clause): the last 8 s, zero-padded at the START, waveform normalised to
 * zero mean and unit variance, centred STFT (n_fft 400, hop 160, periodic Hann, reflect padding), power spectrum,
 * Slaney mel filters (0-8 kHz), log10 with floor 1e-10, the last frame dropped, clamped to (max - 8), then (x + 4) / 4.
 */

export const SR = 16000;
const N_FFT = 400;
const HOP = 160;
const N_MELS = 80;
const BINS = N_FFT / 2 + 1;
export const N_SAMPLES = 8 * SR;
export const N_FRAMES = N_SAMPLES / HOP;

const WINDOW = Float64Array.from({ length: N_FFT }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / N_FFT));
const COS = Float64Array.from({ length: N_FFT }, (_, i) => Math.cos((-2 * Math.PI * i) / N_FFT));
const SIN = Float64Array.from({ length: N_FFT }, (_, i) => Math.sin((-2 * Math.PI * i) / N_FFT));

const hzToMel = (f: number) => (f < 1000 ? (3 * f) / 200 : 15 + Math.log(f / 1000) * (27 / Math.log(6.4)));
const melToHz = (m: number) => (m < 15 ? (200 * m) / 3 : 1000 * Math.exp((Math.log(6.4) / 27) * (m - 15)));

/** Slaney-normalised triangular filters, stored sparse: for each mel bin its first FFT bin and weights. */
const FILTERS: { start: number; w: Float64Array }[] = (() => {
  const mMax = hzToMel(SR / 2);
  const ff = Array.from({ length: N_MELS + 2 }, (_, i) => melToHz((mMax * i) / (N_MELS + 1)));
  const fft = Array.from({ length: BINS }, (_, k) => (k * (SR / 2)) / (BINS - 1));
  const out: { start: number; w: Float64Array }[] = [];
  for (let m = 0; m < N_MELS; m++) {
    const enorm = 2 / (ff[m + 2] - ff[m]);
    const ws: number[] = [];
    let start = -1;
    for (let k = 0; k < BINS; k++) {
      const down = (fft[k] - ff[m]) / (ff[m + 1] - ff[m]);
      const up = (ff[m + 2] - fft[k]) / (ff[m + 2] - ff[m + 1]);
      const v = Math.max(0, Math.min(down, up)) * enorm;
      if (v > 0) {
        if (start < 0) start = k;
        ws[k - start] = v;
      } else if (start >= 0) break;
    }
    out.push({ start: Math.max(0, start), w: Float64Array.from(ws, (x) => x || 0) });
  }
  return out;
})();

const smallestFactor = (n: number) => {
  for (let p = 2; p * p <= n; p++) if (n % p === 0) return p;
  return n;
};

/** Mixed-radix FFT of length dividing 400 (decimation in time); writes n outputs at `o`. */
function fft(xr: Float64Array, xi: Float64Array, n: number, off: number, stride: number, or: Float64Array, oi: Float64Array, o: number, tr: Float64Array, ti: Float64Array) {
  if (n === 1) {
    or[o] = xr[off];
    oi[o] = xi[off];
    return;
  }
  const p = smallestFactor(n);
  const m = n / p;
  for (let q = 0; q < p; q++) fft(xr, xi, m, off + q * stride, stride * p, or, oi, o + q * m, tr, ti);
  const step = N_FFT / n;
  for (let k = 0; k < m; k++) {
    for (let q = 0; q < p; q++) (tr[q] = or[o + q * m + k]), (ti[q] = oi[o + q * m + k]);
    for (let s = 0; s < p; s++) {
      const idx = k + m * s;
      let re = 0;
      let im = 0;
      for (let q = 0; q < p; q++) {
        const a = ((q * idx) % n) * step;
        const c = COS[a];
        const d = SIN[a];
        re += tr[q] * c - ti[q] * d;
        im += tr[q] * d + ti[q] * c;
      }
      or[o + idx] = re;
      oi[o + idx] = im;
    }
  }
}

/** The 8 s window Smart Turn looks at: the end of `audio`, zero-padded at the start. */
export function lastEightSeconds(audio: Float32Array): Float32Array {
  if (audio.length >= N_SAMPLES) return audio.subarray(audio.length - N_SAMPLES);
  const out = new Float32Array(N_SAMPLES);
  out.set(audio, N_SAMPLES - audio.length);
  return out;
}

/** Features as a [80, 800] row-major Float32Array (mel-major), ready for an ONNX tensor [1, 80, 800]. */
export function logMel(audio16k: Float32Array): Float32Array {
  const x = lastEightSeconds(audio16k);
  let mean = 0;
  for (let i = 0; i < x.length; i++) mean += x[i];
  mean /= x.length;
  let v = 0;
  for (let i = 0; i < x.length; i++) v += (x[i] - mean) ** 2;
  const sd = Math.sqrt(v / x.length + 1e-7);
  const pad = N_FFT / 2;
  const padded = new Float64Array(N_SAMPLES + 2 * pad);
  for (let i = 0; i < N_SAMPLES; i++) padded[pad + i] = Math.fround((x[i] - mean) / sd);
  for (let i = 1; i <= pad; i++) {
    padded[pad - i] = padded[pad + i];
    padded[pad + N_SAMPLES - 1 + i] = padded[pad + N_SAMPLES - 1 - i];
  }
  const out = new Float32Array(N_MELS * N_FRAMES);
  const fr = new Float64Array(N_FFT);
  const fi = new Float64Array(N_FFT);
  const or = new Float64Array(N_FFT);
  const oi = new Float64Array(N_FFT);
  const tr = new Float64Array(8);
  const ti = new Float64Array(8);
  const pow = new Float64Array(BINS);
  let max = -Infinity;
  for (let t = 0; t < N_FRAMES; t++) {
    const s = t * HOP;
    for (let i = 0; i < N_FFT; i++) (fr[i] = padded[s + i] * WINDOW[i]), (fi[i] = 0);
    fft(fr, fi, N_FFT, 0, 1, or, oi, 0, tr, ti);
    for (let k = 0; k < BINS; k++) pow[k] = or[k] * or[k] + oi[k] * oi[k];
    for (let m = 0; m < N_MELS; m++) {
      const f = FILTERS[m];
      let acc = 0;
      for (let j = 0; j < f.w.length; j++) acc += f.w[j] * pow[f.start + j];
      const l = Math.log10(Math.max(1e-10, acc));
      out[m * N_FRAMES + t] = l;
      if (l > max) max = l;
    }
  }
  const floor = max - 8;
  for (let i = 0; i < out.length; i++) out[i] = (Math.max(out[i], floor) + 4) / 4;
  return out;
}
