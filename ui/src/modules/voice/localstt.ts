import { api, request } from '../../lib/api';
import { type PcmCapture, concat } from './capture';

export interface LiveResult {
  text: string;
  seconds: number;
  finalMs: number;
  /** Time from "stop" to having the final text, measured in the browser (includes the network). */
  clientMs: number;
  provider: string;
}

/**
 * Live dictation with the free, local engine on the PC. Audio goes to the PC in small chunks over the normal
 * (authenticated) API connection, so it also works from the phone; the PC answers with the text so far.
 */
export class LiveDictation {
  private id: string | null = null;
  private pending: Int16Array[] = [];
  private all: Int16Array[] = [];
  private sending: Promise<void> | null = null;
  private timer: number;
  private off: () => void;
  private failed: Error | null = null;
  private closed = false;
  private ready: Promise<void>;

  constructor(cap: PcmCapture, private o: { threadId?: string | null; onText(text: string): void; onError?(e: Error): void }) {
    this.off = cap.subscribe((f) => {
      if (this.closed) return;
      this.pending.push(f);
      this.all.push(f);
    });
    this.ready = api
      .post<{ id: string }>('/voice/stt/stream', { threadId: o.threadId || undefined })
      .then((r) => void (this.id = r.id))
      .catch((e) => {
        this.failed = e;
        o.onError?.(e);
      });
    this.timer = window.setInterval(() => void this.flush(), 350);
  }

  /** Everything recorded so far (e.g. to keep it as a voice memo). */
  pcm(): Int16Array {
    return concat(this.all);
  }

  private flush(): Promise<void> {
    if (this.sending || !this.id || !this.pending.length || this.failed) return this.sending || Promise.resolve();
    const chunk = concat(this.pending.splice(0));
    this.sending = request<{ text: string }>(`/voice/stt/stream/${this.id}`, { method: 'POST', raw: chunk.buffer as ArrayBuffer, headers: { 'content-type': 'application/octet-stream' } })
      .then((r) => {
        if (!this.closed && r?.text !== undefined) this.o.onText(r.text);
      })
      .catch((e) => {
        this.failed = e;
        this.o.onError?.(e);
      })
      .finally(() => (this.sending = null));
    return this.sending;
  }

  /** Stop recording and get the final text. */
  async stop(): Promise<LiveResult> {
    const t0 = performance.now();
    this.closed = true;
    this.off();
    clearInterval(this.timer);
    await this.ready;
    if (this.failed) throw this.failed;
    while (this.sending || this.pending.length) {
      await this.sending;
      await this.flush();
    }
    if (this.failed) throw this.failed;
    const r = await api.post<{ text: string; seconds: number; finalMs: number; provider: string }>(`/voice/stt/stream/${this.id}/end`, {});
    return { ...r, clientMs: Math.round(performance.now() - t0) };
  }

  cancel() {
    this.closed = true;
    this.off();
    clearInterval(this.timer);
    this.pending = [];
    void this.ready.then(() => this.id && api.del(`/voice/stt/stream/${this.id}`).catch(() => {}));
  }
}
