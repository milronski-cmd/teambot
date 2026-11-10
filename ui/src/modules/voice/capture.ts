/**
 * Microphone → 16 kHz PCM for the free, local speech engines on the PC. One shared AudioContext serves capture and
 * playback; iOS only lets it run after a tap, so call `unlockAudio()` at the start of every tap handler that leads
 * to recording or playback.
 */
import workletUrl from './pcm-worklet.js?url&no-inline';

export const PCM_RATE = 16000;
const FRAME = 320; // 20 ms
const RING_FRAMES = 150; // 3 s

let shared: AudioContext | null = null;

export function audioCtx(): AudioContext {
  if (!shared || shared.state === 'closed') {
    const AC: typeof AudioContext = (window as any).AudioContext || (window as any).webkitAudioContext;
    shared = new AC({ latencyHint: 'interactive' });
  }
  return shared;
}

/** Create/resume the shared AudioContext inside a user gesture (required by iOS Safari, harmless elsewhere). */
export function unlockAudio() {
  try {
    const c = audioCtx();
    if (c.state !== 'running') void c.resume().catch(() => {});
  } catch {
    /* no Web Audio */
  }
}

const loaded = new WeakSet<AudioContext>();

/** Continuous 16 kHz capture of one microphone stream. Consumers subscribe to 20 ms frames. */
export class PcmCapture {
  private subs = new Set<(f: Int16Array) => void>();
  private ring: Int16Array[] = [];
  private levels: number[] = [];
  private lastRms = 0;
  private closed = false;

  private constructor(private nodes: AudioNode[]) {}

  static async open(stream: MediaStream): Promise<PcmCapture> {
    const ctx = audioCtx();
    if (ctx.state !== 'running') await ctx.resume().catch(() => {});
    const src = ctx.createMediaStreamSource(stream);
    const mute = ctx.createGain();
    mute.gain.value = 0;
    mute.connect(ctx.destination);
    let cap: PcmCapture;
    if (ctx.audioWorklet && typeof AudioWorkletNode !== 'undefined') {
      try {
        if (!loaded.has(ctx)) {
          await ctx.audioWorklet.addModule(workletUrl);
          loaded.add(ctx);
        }
        const node = new AudioWorkletNode(ctx, 'teambot-pcm-tap', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
        cap = new PcmCapture([src, node, mute]);
        node.port.onmessage = (e) => cap.frame(new Int16Array(e.data as ArrayBuffer));
        src.connect(node);
        node.connect(mute);
        return cap;
      } catch {
        /* fall back below */
      }
    }
    // Older browsers: ScriptProcessor on the main thread, same downsampling.
    const sp = ctx.createScriptProcessor(4096, 1, 1);
    cap = new PcmCapture([src, sp, mute]);
    const ratio = Math.max(1, ctx.sampleRate / PCM_RATE);
    let pos = 0;
    let acc = 0;
    let n = 0;
    let out = new Int16Array(FRAME);
    let k = 0;
    sp.onaudioprocess = (e) => {
      const ch = e.inputBuffer.getChannelData(0);
      for (let i = 0; i < ch.length; i++) {
        acc += ch[i];
        n++;
        pos += 1;
        if (pos >= ratio) {
          pos -= ratio;
          const v = Math.max(-1, Math.min(1, acc / n));
          acc = 0;
          n = 0;
          out[k++] = v < 0 ? v * 32768 : v * 32767;
          if (k === FRAME) {
            cap.frame(out);
            out = new Int16Array(FRAME);
            k = 0;
          }
        }
      }
    };
    src.connect(sp);
    sp.connect(mute);
    return cap;
  }

  private frame(f: Int16Array) {
    if (this.closed) return;
    let s = 0;
    for (let i = 0; i < f.length; i++) s += f[i] * f[i];
    this.lastRms = Math.sqrt(s / f.length) / 32768;
    this.ring.push(f);
    this.levels.push(this.lastRms);
    // 3 s: enough to go back to the start of what you said when you interrupt the bot (see preroll.ts).
    if (this.ring.length > RING_FRAMES) this.ring.shift(), this.levels.shift();
    for (const fn of this.subs) fn(f);
  }

  /** RMS level per 20 ms frame of the last `ms` (oldest first). */
  recentLevels(ms: number): number[] {
    const n = Math.min(this.levels.length, Math.ceil(ms / 20));
    return n > 0 ? this.levels.slice(-n) : [];
  }

  subscribe(fn: (f: Int16Array) => void): () => void {
    this.subs.add(fn);
    return () => this.subs.delete(fn);
  }

  /** RMS level 0..1 of the last 20 ms (same scale as LevelMeter). */
  level(): number {
    return this.lastRms;
  }

  /** The last `ms` of audio (pre-roll, so the first syllable of a barge-in is not lost). */
  recent(ms: number): Int16Array[] {
    const n = Math.min(this.ring.length, Math.ceil(ms / 20));
    return n > 0 ? this.ring.slice(-n) : [];
  }

  record(preRollMs = 0): PcmRecording {
    return new PcmRecording(this, this.recent(preRollMs));
  }

  close() {
    this.closed = true;
    this.subs.clear();
    for (const n of this.nodes) {
      try {
        n.disconnect();
      } catch {
        /* already */
      }
    }
  }
}

export function concat(frames: Int16Array[]): Int16Array {
  const out = new Int16Array(frames.reduce((n, f) => n + f.length, 0));
  let o = 0;
  for (const f of frames) (out.set(f, o), (o += f.length));
  return out;
}

export function wavBlob(pcm: Int16Array, rate = PCM_RATE): Blob {
  const h = new DataView(new ArrayBuffer(44));
  const w = (o: number, s: string) => [...s].forEach((c, i) => h.setUint8(o + i, c.charCodeAt(0)));
  w(0, 'RIFF');
  h.setUint32(4, 36 + pcm.byteLength, true);
  w(8, 'WAVE');
  w(12, 'fmt ');
  h.setUint32(16, 16, true);
  h.setUint16(20, 1, true);
  h.setUint16(22, 1, true);
  h.setUint32(24, rate, true);
  h.setUint32(28, rate * 2, true);
  h.setUint16(32, 2, true);
  h.setUint16(34, 16, true);
  w(36, 'data');
  h.setUint32(40, pcm.byteLength, true);
  return new Blob([h.buffer, pcm.buffer as ArrayBuffer], { type: 'audio/wav' });
}

/** A recording from a PcmCapture; same shape as the MediaRecorder-based Recording, but produces 16 kHz WAV. */
export class PcmRecording {
  private frames: Int16Array[];
  private off: () => void;
  private started = performance.now();
  private stopped = false;

  constructor(cap: PcmCapture, preRoll: Int16Array[] = []) {
    this.frames = [...preRoll];
    this.started -= preRoll.length * 20;
    this.off = cap.subscribe((f) => !this.stopped && this.frames.push(f));
  }

  get ms() {
    return performance.now() - this.started;
  }

  pcm(): Int16Array {
    return concat(this.frames);
  }

  async stop(): Promise<{ blob: Blob; durationMs: number }> {
    this.stopped = true;
    this.off();
    const pcm = this.pcm();
    return { blob: wavBlob(pcm), durationMs: (pcm.length / PCM_RATE) * 1000 };
  }

  cancel() {
    this.stopped = true;
    this.off();
    this.frames = [];
  }
}
