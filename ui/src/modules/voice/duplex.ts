/**
 * The page side of the free live call (full duplex): one WebSocket carries your microphone (16 kHz PCM, 40 ms steps)
 * to the PC and the bot's voice back. The microphone stays open while the bot speaks, with the browser's echo
 * cancellation (MIC_CONSTRAINTS), so you can interrupt it; the PC decides when you started or finished talking.
 * Interrupting: the PC says `interrupt`, playback stops at once, and the page reports how much it played so the
 * answer in the chat keeps only what you heard.
 */
import { api, signedPath } from '../../lib/api';
import { closeMic, echoCancellationActive, openMic } from './audio';
import { PcmCapture, audioCtx, concat, unlockAudio } from './capture';

export type DuplexPhase = 'connecting' | 'listening' | 'thinking' | 'speaking' | 'ended';

export interface DuplexLatency {
  totalMs: number;
  sttMs: number;
  turnMs: number;
  brainMs: number;
  ttsMs: number;
}

export interface DuplexStatus {
  ready: boolean;
  problem: string | null;
  sttProblem: string | null;
  ttsProblem: string | null;
  parts: { id: string; label: string; licence: string; size: number; status: string; received: number; total: number; error: string | null }[];
  download: number;
  downloadText: string;
  canManage: boolean;
}

export interface DuplexHandlers {
  phase(p: DuplexPhase): void;
  /** final false: "wacht even" on its own, the rest of your sentence follows. */
  user(text: string, final: boolean): void;
  bot(text: string): void;
  interrupted(heard: string): void;
  latency(l: DuplexLatency): void;
  error(message: string): void;
  ended(reason: string): void;
  echo?(active: boolean | null): void;
}

export const duplexStatus = () => api.get<DuplexStatus>('/voice/duplex');

export class DuplexCall {
  private ws: WebSocket | null = null;
  private stream: MediaStream | null = null;
  private cap: PcmCapture | null = null;
  private unsub: (() => void) | null = null;
  private epoch = -1;
  private rate = 22050;
  private sources: AudioBufferSourceNode[] = [];
  private startAt = 0;
  private nextAt = 0;
  private scheduled = 0;
  private answerEnd: { epoch: number; samples: number } | null = null;
  private pending: Int16Array[] = [];
  private closed = false;
  muted = false;
  callId: string | null = null;

  constructor(private h: DuplexHandlers) {}

  async start(o: { agentId: string; threadId?: string | null }) {
    unlockAudio();
    const r = await api.post<{ call: { id: string }; socket: string }>('/voice/duplex/calls', { agentId: o.agentId, threadId: o.threadId || undefined });
    this.callId = r.call.id;
    // Hung up while starting: end the call on the PC and open nothing.
    if (this.closed) return void api.post(`/voice/calls/${r.call.id}/end`, {}).catch(() => {});
    this.stream = await openMic();
    if (this.closed) return (closeMic(this.stream), void api.post(`/voice/calls/${r.call.id}/end`, {}).catch(() => {}));
    this.h.echo?.(echoCancellationActive(this.stream));
    const url = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${signedPath(r.socket)}`;
    const ws = new WebSocket(url);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (e) => (typeof e.data === 'string' ? this.control(e.data) : this.audio(e.data as ArrayBuffer));
    ws.onclose = (e) => {
      if (!this.closed) this.finish(e.reason || 'Verbinding verbroken');
    };
    await new Promise<void>((res, rej) => {
      ws.onopen = () => res();
      ws.onerror = () => rej(new Error('Geen verbinding met TeamBot voor het gesprek.'));
    });
    this.cap = await PcmCapture.open(this.stream);
    let batch: Int16Array[] = [];
    this.unsub = this.cap.subscribe((f) => {
      if (this.muted || ws.readyState !== WebSocket.OPEN) return;
      batch.push(f);
      if (batch.length < 2) return;
      const out = concat(batch);
      batch = [];
      ws.send(out.buffer);
    });
  }

  private send(m: Record<string, unknown>) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private control(raw: string) {
    let m: any;
    try {
      m = JSON.parse(raw);
    } catch {
      return;
    }
    switch (m.type) {
      case 'phase':
        return this.h.phase(m.phase);
      case 'user':
        return this.h.user(String(m.text || ''), m.final !== false);
      case 'bot':
        return this.h.bot(String(m.text || ''));
      case 'answer':
        this.stopAudio();
        this.epoch = Number(m.epoch);
        this.scheduled = 0;
        this.answerEnd = null;
        this.startAt = 0;
        return;
      case 'speech':
        this.rate = Number(m.sampleRate) || 22050;
        for (const p of this.pending.splice(0)) this.play(p);
        return;
      case 'answer-end':
        this.answerEnd = { epoch: Number(m.epoch), samples: Number(m.samples) };
        return this.checkDone();
      case 'interrupt': {
        const played = this.playedSamples();
        const was = Number(m.epoch);
        this.stopAudio();
        this.epoch = -1;
        return this.send({ type: 'played', epoch: was, samples: played, interrupted: true });
      }
      case 'interrupted':
        return this.h.interrupted(String(m.heard || ''));
      case 'latency':
        return this.h.latency(m);
      case 'error':
        return this.h.error(String(m.message || ''));
      case 'ended':
        return this.finish(String(m.reason || 'Opgehangen'));
    }
  }

  private audio(buf: ArrayBuffer) {
    if (buf.byteLength < 6) return;
    const epoch = new DataView(buf).getUint32(0, true);
    if (epoch !== this.epoch) return; // an answer you interrupted
    const pcm = new Int16Array(buf.slice(4));
    this.play(pcm);
  }

  private play(pcm: Int16Array) {
    const ctx = audioCtx();
    const b = ctx.createBuffer(1, pcm.length, this.rate);
    const ch = b.getChannelData(0);
    for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = b;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.02, this.nextAt);
    if (!this.startAt) this.startAt = at;
    src.start(at);
    this.nextAt = at + b.duration;
    this.scheduled += pcm.length;
    this.sources.push(src);
    src.onended = () => {
      this.sources = this.sources.filter((s) => s !== src);
      this.checkDone();
    };
  }

  /** Samples of this answer that came out of the speaker so far. */
  private playedSamples() {
    if (!this.startAt) return 0;
    const ctx = audioCtx();
    return Math.max(0, Math.min(this.scheduled, Math.round((ctx.currentTime - this.startAt) * this.rate)));
  }

  private checkDone() {
    if (!this.answerEnd || this.sources.length || this.answerEnd.epoch !== this.epoch) return;
    this.send({ type: 'played', epoch: this.answerEnd.epoch, samples: this.answerEnd.samples });
    this.answerEnd = null;
  }

  private stopAudio() {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* already stopped */
      }
    }
    this.sources = [];
    this.nextAt = 0;
    this.startAt = 0;
  }

  setMuted(m: boolean) {
    this.muted = m;
  }

  private finish(reason: string) {
    if (this.closed) return;
    this.closed = true;
    this.unsub?.();
    this.cap?.close();
    closeMic(this.stream);
    // Let the goodbye finish playing; the PC already waited for it.
    this.h.phase('ended');
    this.h.ended(reason);
    try {
      this.ws?.close();
    } catch {
      /* gone */
    }
  }

  hangup() {
    this.send({ type: 'hangup' });
    this.stopAudio();
    this.finish('Opgehangen');
  }
}
