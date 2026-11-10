import crypto from 'node:crypto';
import type { SttEngines } from './engine.js';
import { STT_RATE, findPause, hasSignal, int16ToFloat, quietest } from './pcm.js';

/** Max dictation length per session (10 minutes of 16 kHz audio). */
export const MAX_SESSION_SAMPLES = 10 * 60 * STT_RATE;
const COMMIT_AFTER = 6 * STT_RATE; // look for a pause once 6 s are not yet final
const FORCE_AFTER = 25 * STT_RATE; // nobody pauses: cut anyway
const PARTIAL_STEP = 0.5 * STT_RATE;
const PARTIAL_MAX = 12 * STT_RATE;

interface Segment {
  text: string | null;
  done: Promise<void>;
}

export interface StreamView {
  text: string;
  final: string;
  partial: string;
  seconds: number;
}

/**
 * Live dictation over plain HTTP: the browser posts 16 kHz PCM every few hundred ms. Finished stretches (cut at a
 * pause) are decoded once and become final; the unfinished tail is re-decoded now and then for live text. Stopping
 * only has to decode the last stretch, which keeps the delay after you stop speaking short.
 */
export class DictationSession {
  readonly id = 'ds_' + crypto.randomBytes(12).toString('base64url');
  private buf = new Int16Array(STT_RATE * 20);
  private len = 0;
  private committedAt = 0;
  private segments: Segment[] = [];
  private partial = { text: '', start: 0, upTo: 0 };
  private partialRunning = false;
  lastSeen = Date.now();
  ended = false;

  constructor(
    private engines: SttEngines,
    readonly userId: string,
    readonly modelId: string,
    readonly language: string,
    readonly threadId: string | null,
  ) {}

  get seconds() {
    return this.len / STT_RATE;
  }

  /** Append little-endian 16-bit mono PCM at 16 kHz. */
  push(chunk: Buffer): StreamView {
    if (this.ended) throw new Error('Deze dicteersessie is al afgesloten');
    this.lastSeen = Date.now();
    const n = Math.floor(chunk.length / 2);
    if (this.len + n > MAX_SESSION_SAMPLES) throw new Error('De opname is te lang (max. 10 minuten)');
    if (this.len + n > this.buf.length) {
      const next = new Int16Array(Math.min(MAX_SESSION_SAMPLES, Math.max(this.buf.length * 2, this.len + n)));
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    for (let i = 0; i < n; i++) this.buf[this.len + i] = chunk.readInt16LE(i * 2);
    this.len += n;
    this.maybeCommit();
    this.maybePartial();
    return this.view();
  }

  private float(from: number, to: number): Float32Array {
    return int16ToFloat(this.buf.subarray(from, to));
  }

  private commit(to: number) {
    const from = this.committedAt;
    this.committedAt = to;
    const seg: Segment = { text: null, done: Promise.resolve() };
    const samples = this.float(from, to);
    seg.done = (hasSignal(samples, STT_RATE) ? this.engines.decode(this.modelId, this.language, samples, STT_RATE) : Promise.resolve({ text: '', ms: 0 })).then(
      (r) => void (seg.text = r?.text || ''),
      () => void (seg.text = ''),
    );
    this.segments.push(seg);
  }

  private maybeCommit() {
    const base = this.committedAt;
    const open = this.len - base;
    if (open < COMMIT_AFTER) return;
    const seg = this.float(base, this.len);
    const cut = findPause(seg, STT_RATE, 3 * STT_RATE, seg.length - Math.round(0.25 * STT_RATE));
    if (cut !== null && cut > 0) return this.commit(base + cut);
    if (open >= FORCE_AFTER) this.commit(base + quietest(seg, STT_RATE, 15 * STT_RATE, seg.length - Math.round(0.5 * STT_RATE)));
  }

  private maybePartial() {
    if (this.partialRunning || this.len - this.partial.upTo < PARTIAL_STEP) return;
    const start = this.committedAt;
    const open = this.len - start;
    if (open < 0.4 * STT_RATE || open > PARTIAL_MAX) return;
    const upTo = this.len;
    this.partialRunning = true;
    this.engines
      .decode(this.modelId, this.language, this.float(start, upTo), STT_RATE, { partial: true })
      .then((r) => {
        if (r && start === this.committedAt) this.partial = { text: r.text, start, upTo };
        else if (r) this.partial = { text: '', start: this.committedAt, upTo };
      })
      .catch(() => {})
      .finally(() => (this.partialRunning = false));
  }

  view(): StreamView {
    const final = this.segments
      .map((s) => s.text)
      .filter((t): t is string => !!t)
      .join(' ');
    const partial = this.partial.start === this.committedAt ? this.partial.text : '';
    return { text: [final, partial].filter(Boolean).join(' '), final, partial, seconds: Math.round(this.seconds * 10) / 10 };
  }

  /** Finish: decode what is left and return the whole text. */
  async end(): Promise<{ text: string; seconds: number; finalMs: number }> {
    const t0 = performance.now();
    this.ended = true;
    if (this.len - this.committedAt >= 0.15 * STT_RATE) this.commit(this.len);
    await Promise.all(this.segments.map((s) => s.done));
    const text = this.segments
      .map((s) => s.text)
      .filter(Boolean)
      .join(' ')
      .replace(/\s+/g, ' ')
      .trim();
    return { text, seconds: Math.round(this.seconds * 100) / 100, finalMs: Math.round(performance.now() - t0) };
  }
}

/** All open dictation sessions of this server process (in memory; at most 3 per user, dropped after 60 s idle). */
export class DictationSessions {
  private map = new Map<string, DictationSession>();
  private timer: NodeJS.Timeout;
  constructor(private engines: SttEngines) {
    this.timer = setInterval(() => this.sweep(), 15_000);
    this.timer.unref?.();
  }

  open(userId: string, modelId: string, language: string, threadId: string | null): DictationSession {
    const mine = [...this.map.values()].filter((s) => s.userId === userId).sort((a, b) => a.lastSeen - b.lastSeen);
    while (mine.length >= 3) this.map.delete(mine.shift()!.id);
    const s = new DictationSession(this.engines, userId, modelId, language, threadId);
    this.map.set(s.id, s);
    this.engines.warm(modelId, language);
    return s;
  }

  get(userId: string, id: string): DictationSession | null {
    const s = this.map.get(id);
    return s && s.userId === userId ? s : null;
  }

  close(id: string) {
    this.map.delete(id);
  }

  sweep(now = Date.now()) {
    for (const [id, s] of this.map) if (now - s.lastSeen > 60_000) this.map.delete(id);
  }

  stop() {
    clearInterval(this.timer);
    this.map.clear();
  }
}
