/**
 * Gemini Live client over one WebSocket (full duplex): 16 kHz PCM from the microphone up, 24 kHz PCM down, played
 * through Web Audio. Google's own voice detection hears you while the bot talks; when it says "interrupted" the
 * playback stops at once (barge-in). Authentication: the single-use token our server minted (POST /voice/gemini/session).
 */
import { audioCtx, concat, PcmCapture } from './capture';
import { geminiUsage } from './cloudcall';

export interface GeminiCallbacks {
  onConnected(): void;
  onState(s: 'listening' | 'user' | 'thinking' | 'speaking'): void;
  onCaption(c: { id: string; role: 'user' | 'assistant'; text: string; final: boolean }): void;
  /** Usage in the shared Realtime shape (the server prices it from its own list). */
  onUsage(u: any): void;
  onFunctionCall(c: { name: string; callId: string; args: any }): void;
  onSpeaking(on: boolean): void;
  onUserSpeaking(on: boolean): void;
  onLevel?(v: number): void;
  onError(message: string, fatal: boolean): void;
}

const b64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};
const unb64 = (s: string) => {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
};

export class GeminiLiveClient {
  private ws: WebSocket | null = null;
  private cap: PcmCapture | null = null;
  private unsub: (() => void) | null = null;
  private frames: Int16Array[] = [];
  private muted = false;
  private closed = false;
  private sources = new Set<AudioBufferSourceNode>();
  private playAt = 0;
  private speaking = false;
  private dropTurn = false;
  private userText = '';
  private botText = '';
  private turn = 0;
  private userTalking = false;
  private stopTimer: any = null;

  constructor(private cb: GeminiCallbacks) {}

  async connect(stream: MediaStream, wsUrl: string, setup: any) {
    const ws = new WebSocket(wsUrl);
    this.ws = ws;
    ws.binaryType = 'arraybuffer';
    await new Promise<void>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Gemini Live reageert niet (time-out bij verbinden).')), 15_000);
      ws.onopen = () => {
        clearTimeout(t);
        ws.send(JSON.stringify({ setup }));
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        reject(new Error('Kon geen verbinding maken met Gemini Live.'));
      };
    });
    ws.onmessage = async (e) => {
      try {
        const text = typeof e.data === 'string' ? e.data : new TextDecoder().decode(e.data as ArrayBuffer);
        this.handle(JSON.parse(text));
      } catch {
        /* ignore malformed */
      }
    };
    ws.onclose = (e) => {
      if (this.closed) return;
      const why = e.reason ? `: ${String(e.reason).slice(0, 160)}` : '';
      this.cb.onError(`De verbinding met Gemini Live is verbroken${why}.`, true);
    };
    ws.onerror = null;
    this.cap = await PcmCapture.open(stream);
    this.unsub = this.cap.subscribe((f) => {
      if (this.muted || this.closed) return;
      this.frames.push(f);
      if (this.frames.length < 5) return; // 100 ms per message
      this.cb.onLevel?.(this.cap?.level() || 0);
      const pcm = concat(this.frames.splice(0));
      this.send({ realtimeInput: { audio: { data: b64(new Uint8Array(pcm.buffer)), mimeType: 'audio/pcm;rate=16000' } } });
    });
  }

  private send(m: any) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(m));
  }

  private setSpeaking(on: boolean) {
    if (this.speaking === on) return;
    this.speaking = on;
    this.cb.onSpeaking(on);
    this.cb.onState(on ? 'speaking' : 'listening');
  }

  private setUser(on: boolean) {
    if (this.userTalking === on) return;
    this.userTalking = on;
    this.cb.onUserSpeaking(on);
    if (on) this.cb.onState('user');
  }

  /** Your words so far are one finished sentence (before the bot answers or calls a tool). */
  private finishUser() {
    this.setUser(false);
    const t = this.userText.trim();
    this.userText = '';
    if (t) this.cb.onCaption({ id: `u_${this.turn}`, role: 'user', text: t, final: true });
  }

  private play(pcm: Uint8Array, rate: number) {
    if (this.dropTurn) return;
    const ctx = audioCtx();
    if (ctx.state !== 'running') void ctx.resume().catch(() => {});
    const samples = new Int16Array(pcm.buffer, pcm.byteOffset, Math.floor(pcm.byteLength / 2));
    const buf = ctx.createBuffer(1, samples.length, rate);
    const ch = buf.getChannelData(0);
    for (let i = 0; i < samples.length; i++) ch[i] = samples[i] / 32768;
    const src = ctx.createBufferSource();
    src.buffer = buf;
    src.connect(ctx.destination);
    const at = Math.max(ctx.currentTime + 0.03, this.playAt);
    src.start(at);
    this.playAt = at + buf.duration;
    this.sources.add(src);
    this.setSpeaking(true);
    if (this.stopTimer) clearTimeout(this.stopTimer);
    src.onended = () => {
      this.sources.delete(src);
      if (!this.sources.size) this.stopTimer = setTimeout(() => !this.sources.size && this.setSpeaking(false), 120);
    };
  }

  /** Stop what the bot is saying right now (barge-in by voice or by the button). */
  private flushPlayback() {
    for (const s of this.sources) {
      try {
        s.onended = null;
        s.stop();
      } catch {
        /* ended */
      }
    }
    this.sources.clear();
    this.playAt = 0;
    this.setSpeaking(false);
  }

  private handle(m: any) {
    if (m.setupComplete) {
      this.cb.onConnected();
      this.cb.onState('listening');
      return;
    }
    if (m.usageMetadata) this.cb.onUsage(geminiUsage(m.usageMetadata));
    if (m.toolCall) {
      this.finishUser();
      for (const fc of m.toolCall.functionCalls || []) this.cb.onFunctionCall({ name: String(fc.name || ''), callId: String(fc.id || ''), args: fc.args || {} });
    }
    if (m.goAway) this.cb.onError('Gemini Live beëindigt deze verbinding zo (de sessie is op zijn maximum). Bel daarna opnieuw.', false);
    const sc = m.serverContent;
    if (!sc) return;
    if (sc.inputTranscription?.text) {
      if (!this.userTalking && !this.userText) this.turn++;
      this.userText += sc.inputTranscription.text;
      this.setUser(true);
      this.cb.onCaption({ id: `u_${this.turn}`, role: 'user', text: this.userText.trim(), final: false });
    }
    if (sc.interrupted) {
      // You started talking: stop the bot's voice and drop the rest of this answer.
      this.flushPlayback();
      this.finishBot();
      this.setUser(true);
      return;
    }
    if (sc.modelTurn?.parts?.length || sc.outputTranscription?.text) {
      if (this.userText) this.finishUser();
      else this.setUser(false);
    }
    for (const p of sc.modelTurn?.parts || []) {
      const d = p?.inlineData;
      if (d?.data && /^audio\//.test(d.mimeType || 'audio/pcm')) {
        const rate = Number(/rate=(\d+)/.exec(d.mimeType || '')?.[1]) || 24000;
        this.play(unb64(d.data), rate);
      }
    }
    if (sc.outputTranscription?.text && !this.dropTurn) {
      this.botText += sc.outputTranscription.text;
      this.cb.onCaption({ id: `a_${this.turn}`, role: 'assistant', text: this.botText.trim(), final: false });
    }
    if (sc.turnComplete || sc.generationComplete) {
      if (sc.turnComplete) {
        this.finishBot();
        this.dropTurn = false;
        if (!this.sources.size) this.setSpeaking(false);
      }
    }
  }

  private finishBot() {
    const t = this.botText.trim();
    this.botText = '';
    if (t) this.cb.onCaption({ id: `a_${this.turn}`, role: 'assistant', text: t, final: true });
  }

  mute(on: boolean) {
    this.muted = on;
    if (on) this.frames = [];
  }

  /** The button: stop the current answer here (Gemini's own voice detection handles talking over it). */
  interrupt() {
    this.dropTurn = true;
    this.flushPlayback();
    this.finishBot();
  }

  /** Result of a NON_BLOCKING function: spoken when the line is quiet, or silently. */
  functionResult(callId: string, name: string, output: any, speak: boolean) {
    this.send({ toolResponse: { functionResponses: [{ id: callId, name, response: { ...output, scheduling: speak ? 'WHEN_IDLE' : 'SILENT' } }] } });
  }

  /** Something new for the voice (a late result): as a marked system note, so it is never taken for your words. */
  inform(text: string) {
    this.send({ clientContent: { turns: [{ role: 'user', parts: [{ text: `[Systeembericht van TeamBot, niet gezegd door de gebruiker] ${text}` }] }], turnComplete: true } });
  }

  isSpeaking() {
    return this.speaking;
  }

  close() {
    this.closed = true;
    this.unsub?.();
    this.cap?.close();
    this.flushPlayback();
    try {
      this.ws?.close(1000, 'ophangen');
    } catch {
      /* closed */
    }
    this.ws = null;
  }
}
