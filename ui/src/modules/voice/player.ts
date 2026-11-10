import { create } from 'zustand';
import { api, authUrl, getToken } from '../../lib/api';
import { speakLocal, stopLocal } from './audio';
import { audioCtx } from './capture';

interface PlayerState {
  /** Message currently being read aloud (or loading). */
  messageId: string | null;
  phase: 'idle' | 'loading' | 'playing';
  /** A call is open: automatic read-aloud stays quiet. */
  inCall: boolean;
}

export const usePlayer = create<PlayerState>(() => ({ messageId: null, phase: 'idle', inCall: false }));

let audio: HTMLAudioElement | null = null;
let token = 0;
let sources: AudioBufferSourceNode[] = [];
let streamAbort: AbortController | null = null;
let wake: (() => void) | null = null;

/**
 * What the bot's voice plays right now, for the barge-in detector's self-voice gate (vad.ts): the RMS per 20 ms of
 * every buffer the PCM player scheduled, on the AudioContext clock. Only for the local voice (Web Audio); the
 * browser voice and audio files are not measured (outputLevel() is then null).
 */
interface EnvelopeSegment {
  start: number;
  step: number;
  levels: Float32Array;
}
let envelope: EnvelopeSegment[] = [];
let measured = false;
const ENVELOPE_STEP_S = 0.02;
/** The echo of a sound lasts a little after it (room, output latency): look back this far. */
const ECHO_TAIL_S = 0.3;

function segmentLevels(ch: Float32Array, rate: number): Float32Array {
  const per = Math.max(1, Math.round(rate * ENVELOPE_STEP_S));
  const out = new Float32Array(Math.ceil(ch.length / per));
  for (let k = 0; k < out.length; k++) {
    let s = 0;
    const a = k * per;
    const b = Math.min(ch.length, a + per);
    for (let i = a; i < b; i++) s += ch[i] * ch[i];
    out[k] = Math.sqrt(s / Math.max(1, b - a));
  }
  return out;
}

/**
 * Level (0..1) of the bot's voice that plays now or just played (the last 300 ms), or null when the current playback
 * is not measured (browser voice, audio file) or nothing went through the PCM player.
 */
export function outputLevel(): number | null {
  if (!measured) return null;
  let now: number;
  try {
    now = audioCtx().currentTime;
  } catch {
    return null;
  }
  const from = now - ECHO_TAIL_S;
  envelope = envelope.filter((s) => s.start + s.levels.length * s.step > now - 1);
  let max = 0;
  for (const s of envelope) {
    const end = s.start + s.levels.length * s.step;
    if (end < from || s.start > now) continue;
    const i0 = Math.max(0, Math.floor((from - s.start) / s.step));
    const i1 = Math.min(s.levels.length - 1, Math.floor((now - s.start) / s.step));
    for (let i = i0; i <= i1; i++) if (s.levels[i] > max) max = s.levels[i];
  }
  return max;
}

export function stopPlayback() {
  token++;
  measured = false;
  envelope = [];
  stopLocal();
  if (audio) {
    audio.pause();
    audio.src = '';
    audio = null;
  }
  streamAbort?.abort();
  streamAbort = null;
  for (const s of sources) {
    try {
      s.stop();
    } catch {
      /* not started */
    }
  }
  sources = [];
  wake?.();
  wake = null;
  usePlayer.setState({ messageId: null, phase: 'idle' });
}

export interface SpeakResponse {
  engine: 'browser' | 'provider' | 'off' | 'local';
  id?: string;
  url?: string;
  stream?: string;
  sampleRate?: number;
  text?: string;
  browserVoice?: string;
  speed?: number;
  /** Browser engine: the language of the text (the browser picks a voice for it). */
  lang?: string;
  cached?: boolean;
  cost?: number | null;
  provider?: string;
  model?: string;
  voice?: string;
  truncated?: boolean;
  /** A local voice is chosen but not downloaded yet (the browser voice was used). */
  localMissing?: string | null;
}

/** Time from the request until the first sound of the last local playback (shown in Settings as a measurement). */
export let lastFirstAudioMs: number | null = null;

async function play(r: SpeakResponse, fallbackText: string, my: number, t0: number) {
  if (r.engine === 'browser') return speakLocal(r.text || fallbackText, { voice: r.browserVoice, rate: r.speed, lang: r.lang });
  if (r.engine === 'local' && r.id) {
    try {
      return await playPcm(r.stream || `/voice/tts/${r.id}/pcm`, my, t0);
    } catch (e: any) {
      if (my !== token || e?.name === 'AbortError') return;
      // No Web Audio streaming: the file endpoint waits until the audio is complete (not measured for the echo gate).
      measured = false;
      return playUrl(authUrl(r.url || `/voice/tts/${r.id}`), my);
    }
  }
  return playUrl(authUrl(r.url!), my);
}

/**
 * Read a message aloud with the voice of the bot that wrote it. Resolves when playback ends (or is stopped).
 * Returns what was used so callers can show who generated the audio.
 */
export async function playMessage(messageId: string, o: { callId?: string | null } = {}): Promise<SpeakResponse> {
  stopPlayback();
  const my = ++token;
  const t0 = performance.now();
  usePlayer.setState({ messageId, phase: 'loading' });
  try {
    const r = await api.post<SpeakResponse>('/voice/speak', { messageId, callId: o.callId || undefined });
    if (my !== token) return r;
    if (r.engine === 'off') {
      usePlayer.setState({ messageId: null, phase: 'idle' });
      return r;
    }
    usePlayer.setState({ phase: 'playing' });
    await play(r, '', my, t0);
    return r;
  } finally {
    if (my === token) usePlayer.setState({ messageId: null, phase: 'idle' });
  }
}

/** Stream raw 16-bit PCM from the PC into Web Audio: playback starts with the first sentence. */
async function playPcm(path: string, my: number, t0: number, onFirst?: (ms: number) => void): Promise<void> {
  const ctx = audioCtx();
  if (ctx.state !== 'running') await ctx.resume().catch(() => {});
  if (ctx.state !== 'running') throw new Error('Web Audio staat stil');
  const ac = new AbortController();
  streamAbort = ac;
  const tok = getToken();
  const res = await fetch('/api' + path, { headers: tok ? { authorization: `Bearer ${tok}` } : {}, signal: ac.signal });
  if (!res.ok || !res.body) throw new Error(`Afspelen mislukt (${res.status})`);
  const rate = Number(res.headers.get('x-sample-rate')) || 22050;
  const reader = res.body.getReader();
  if (my === token) measured = true;
  let at = 0;
  let carry: Uint8Array | null = null;
  let first = true;
  for (;;) {
    const { value, done } = await reader.read();
    if (my !== token) {
      ac.abort();
      return;
    }
    if (done) break;
    let bytes = value;
    if (carry) {
      const j = new Uint8Array(carry.length + value.length);
      j.set(carry);
      j.set(value, carry.length);
      bytes = j;
      carry = null;
    }
    const even = bytes.length - (bytes.length % 2);
    if (even < bytes.length) carry = bytes.slice(even);
    if (!even) continue;
    const view = new DataView(bytes.buffer, bytes.byteOffset, even);
    const n = even / 2;
    const buf = ctx.createBuffer(1, n, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = view.getInt16(i * 2, true) / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const start = Math.max(at, ctx.currentTime + 0.03);
    src.start(start);
    envelope.push({ start, step: ENVELOPE_STEP_S, levels: segmentLevels(ch, rate) });
    if (first) {
      first = false;
      lastFirstAudioMs = Math.round(performance.now() - t0);
      onFirst?.(lastFirstAudioMs);
    }
    at = start + buf.duration;
    sources.push(src);
  }
  // Wait until the last scheduled buffer has played (or playback is stopped).
  const left = at - ctx.currentTime;
  if (left > 0 && my === token)
    await new Promise<void>((resolve) => {
      const t = window.setTimeout(resolve, left * 1000 + 50);
      wake = () => {
        clearTimeout(t);
        resolve();
      };
    });
  if (my === token) sources = [];
}

function playUrl(url: string, my: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const a = new Audio(url);
    audio = a;
    const done = () => resolve();
    a.onended = done;
    a.onpause = () => my !== token && done();
    a.onerror = () => reject(new Error('Afspelen mislukt'));
    a.play().catch((e) => reject(e?.name === 'NotAllowedError' ? new Error('De browser blokkeert automatisch afspelen. Tik op het luidsprekertje om te luisteren.') : e));
  });
}

/**
 * Play a live voice (the bot's answer read aloud while it is still being written). Resolves when everything has been
 * played, or when playback is stopped (e.g. you interrupted by talking). `onFirst` fires with the first sound.
 * Returns false when there was nothing to play.
 */
export async function playLive(speech: { id: string; stream: string }, o: { label?: string; t0?: number; onFirst?: (ms: number) => void } = {}): Promise<boolean> {
  stopPlayback();
  const my = ++token;
  let played = false;
  usePlayer.setState({ messageId: o.label || `live:${speech.id}`, phase: 'loading' });
  try {
    await playPcm(speech.stream, my, o.t0 ?? performance.now(), (ms) => {
      played = true;
      if (my === token) usePlayer.setState({ phase: 'playing' });
      o.onFirst?.(ms);
    });
  } catch (e: any) {
    if (my !== token || e?.name === 'AbortError') return played;
    throw e;
  } finally {
    if (my === token) usePlayer.setState({ messageId: null, phase: 'idle' });
  }
  return played;
}

/** Read-aloud of a bot's answer that is still being written (local voice). null = not possible, read it when done. */
export async function followRunAloud(runId: string, label?: string): Promise<boolean | null> {
  const r = await api.post<{ stream: string | null; id?: string }>('/voice/speak/run', { runId });
  if (!r.stream || !r.id) return null;
  return playLive({ id: r.id, stream: r.stream }, { label });
}

/** Preview a voice in the bot editor / settings (short text, server validates the choice). */
export async function previewVoice(text: string, agentId: string | null, override: any): Promise<SpeakResponse> {
  stopPlayback();
  const my = ++token;
  const t0 = performance.now();
  usePlayer.setState({ messageId: 'preview', phase: 'loading' });
  try {
    const r = await api.post<SpeakResponse>('/voice/speak', { text, agentId: agentId || undefined, override });
    if (my !== token || r.engine === 'off') return r;
    usePlayer.setState({ phase: 'playing' });
    await play(r, text, my, t0);
    return r;
  } finally {
    if (my === token) usePlayer.setState({ messageId: null, phase: 'idle' });
  }
}
