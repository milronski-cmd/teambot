import type { CallMode, CallModeEvent, CallPhase, CallToolHooks } from './mode.js';
import { endCallWords } from '../calltools.js';
import type { VoiceActivity } from './vad.js';
import type { TurnDetector } from './turn.js';

/** The bot's side of the call: answers a turn, sentence by sentence, as soon as each one is ready. */
export interface Brain {
  reply(text: string, o: { onSentence(s: string): void; signal: AbortSignal }): Promise<void>;
  /** You interrupted: only `heard` of the last answer reached you (keep the history to that). */
  interrupted?(heard: string): void;
  close?(): void;
}

export interface Voice {
  synth(text: string): Promise<{ pcm: Buffer; sampleRate: number }>;
}

export interface DuplexDeps {
  vad: VoiceActivity;
  turn: TurnDetector;
  stt(samples16k: Float32Array): Promise<string>;
  voice: Voice;
  brain: Brain;
  /** JSON control message to the page. */
  send(msg: Record<string, unknown>): void;
  /** Bot audio: 16-bit PCM for answer `epoch` (the page drops audio of an interrupted answer). */
  sendAudio(epoch: number, pcm: Buffer): void;
  /** The call ended (hung up by you, the bot, a limit or an error). */
  onEnd?(reason: string): void;
  /**
   * The end_call rules (calltools.ts#runCallTool): null = the bot may hang up, else the refusal for the bot. `heard` is
   * your last sentence from the speech recognition. Without it (unit tests): the same word rules (endCallWords).
   */
  endCallRules?(heard: string, args: { reason: string; summary?: string; runId?: string }): Promise<string | null>;
  /** Longest pause inside an unfinished sentence before the bot answers anyway (ms). */
  maxPauseMs?: number;
  now?: () => number;
}

const RATE = 16000;
/** A turn that is only a "wait" or a filler: the speaker is not done yet. */
export const WAIT_WORDS = /^\s*(wacht( even| eens| maar| effe)?|momentje|moment|even denken|eh+m*|uh+m*|hm+|hold on|wait|um+|uh+)[\s.,!?…]*$/i;
const PREROLL = Math.round(0.3 * RATE);
const MAX_TURN = 30 * RATE;

interface Said {
  text: string;
  start: number;
  end: number;
  rate: number;
}

/**
 * The free full-duplex call: audio from the page streams in all the time, also while the bot speaks.
 *  1. Silero VAD hears speech start and stop (200 ms of silence).
 *  2. At a stop, Smart Turn v3 and the speech recogniser run at the same time: done → the text goes to the bot; not
 *     done ("en dan…") → it keeps listening, and answers anyway after `maxPauseMs`.
 *  3. The bot's answer is spoken sentence by sentence while it is written (the first sentence on its own).
 *  4. You talk while the bot speaks or thinks → it stops at once, the page drops what was not played yet, and only
 *     what you heard stays in the history.
 */
export class DuplexSession implements CallMode, CallToolHooks {
  readonly id = 'duplex';
  private listeners = new Set<(e: CallModeEvent) => void>();
  private phase: CallPhase = 'connecting';
  private ring = new Float32Array(PREROLL);
  private ringLen = 0;
  private turn: Float32Array[] = [];
  private turnLen = 0;
  private inTurn = false;
  private committing = false;
  private wasSpeaking = false;
  private speechEndAt = 0;
  private pauseTimer: NodeJS.Timeout | null = null;
  private evalSeq = 0;
  private epoch = 0;
  private answer: AbortController | null = null;
  private said: Said[] = [];
  /** The answer that was interrupted last, until the page says how much of it it played. */
  private cut: { epoch: number; said: Said[] } | null = null;
  private sentSamples = 0;
  /** Bot audio was sent that the page has not finished playing. */
  private playing = false;
  private ttsChain: Promise<unknown> = Promise.resolve();
  private firstAudio = false;
  private timing = { sttMs: 0, turnMs: 0, brainAt: 0, firstSentenceAt: 0 };
  private lastUser = '';
  /** "Wacht even," on its own: kept and put in front of the rest of the sentence. */
  private carry = '';
  private hangupAfter: { epoch: number; reason: string } | null = null;
  private stopped = false;
  private now: () => number;

  constructor(private d: DuplexDeps) {
    this.now = d.now || (() => performance.now());
  }

  on(cb: (e: CallModeEvent) => void) {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  private emit(e: CallModeEvent) {
    for (const l of this.listeners) l(e);
    this.d.send({ ...e });
  }

  private setPhase(p: CallPhase) {
    if (this.phase === p || this.phase === 'ended') return;
    this.phase = p;
    this.emit({ type: 'phase', phase: p });
  }

  async start() {
    this.setPhase('listening');
  }

  /** 16-bit PCM from the microphone (16 kHz mono, any chunk size). */
  audio(pcm: Buffer) {
    if (this.stopped || pcm.length < 2) return;
    const n = pcm.length >> 1;
    const f = new Float32Array(n);
    for (let i = 0; i < n; i++) f[i] = pcm.readInt16LE(i * 2) / 32768;
    this.samples(f);
  }

  samples(f: Float32Array) {
    if (this.stopped) return;
    this.d.vad.accept(f);
    const speaking = this.d.vad.speaking();
    if (speaking && !this.wasSpeaking) this.speechStarted();
    if (this.inTurn) this.push(f);
    else this.keepPreroll(f);
    if (!speaking && this.wasSpeaking) this.speechStopped();
    this.wasSpeaking = speaking;
    if (this.inTurn && this.turnLen > MAX_TURN && !this.committing) void this.commit(++this.evalSeq, undefined, true);
  }

  private keepPreroll(f: Float32Array) {
    if (f.length >= PREROLL) {
      this.ring.set(f.subarray(f.length - PREROLL));
      this.ringLen = PREROLL;
      return;
    }
    const keep = Math.min(this.ringLen, PREROLL - f.length);
    this.ring.copyWithin(0, this.ringLen - keep, this.ringLen);
    this.ring.set(f, keep);
    this.ringLen = keep + f.length;
  }

  private push(f: Float32Array) {
    this.turn.push(f.slice());
    this.turnLen += f.length;
  }

  private speechStarted() {
    if (this.pauseTimer) clearTimeout(this.pauseTimer), (this.pauseTimer = null);
    this.evalSeq++; // a running turn check is out of date now
    // Talking over the bot: stop it now (barge-in).
    if (this.answer || this.phase === 'speaking' || this.phase === 'thinking') this.interrupt();
    if (!this.inTurn) {
      this.inTurn = true;
      this.turn = this.ringLen ? [this.ring.slice(0, this.ringLen)] : [];
      this.turnLen = this.ringLen;
      this.ringLen = 0;
    }
    this.setPhase('listening');
  }

  private speechStopped() {
    // The VAD reports the stop after its 200 ms of silence; the sentence ended then.
    this.speechEndAt = this.now() - 200;
    void this.evaluate(++this.evalSeq);
  }

  private audioOfTurn(): Float32Array {
    const out = new Float32Array(this.turnLen);
    let o = 0;
    for (const c of this.turn) out.set(c, o), (o += c.length);
    return out;
  }

  /** At a pause: is the turn over? Speech recognition starts at the same time, so a "yes" costs no extra wait. */
  private async evaluate(seq: number) {
    const audio = this.audioOfTurn();
    const t0 = this.now();
    const stt = this.d.stt(audio).then((text) => ((this.timing.sttMs = Math.round(this.now() - t0)), text));
    stt.catch(() => {});
    let p = 1;
    try {
      p = await this.d.turn.predict(audio);
    } catch {
      p = 1;
    }
    this.timing.turnMs = Math.round(this.now() - t0);
    if (seq !== this.evalSeq) return;
    if (p >= 0.5) return this.commit(seq, stt);
    // Not done yet ("en…"): wait for more, answer anyway after a longer pause.
    const wait = Math.max(0, (this.d.maxPauseMs ?? 1800) - (this.now() - this.speechEndAt));
    this.pauseTimer = setTimeout(() => {
      this.pauseTimer = null;
      if (seq === this.evalSeq) void this.commit(seq);
    }, wait);
    this.pauseTimer.unref?.();
  }

  private async commit(seq: number, stt?: Promise<string>, force = false) {
    const audio = this.audioOfTurn();
    this.committing = true;
    // A 30 s monologue: this part goes now, what follows is a new turn.
    if (force) (this.turn = []), (this.turnLen = 0);
    let text = '';
    try {
      if (!stt) {
        const t0 = this.now();
        stt = this.d.stt(audio);
        text = await stt;
        this.timing.sttMs = Math.round(this.now() - t0);
      } else text = await stt;
    } catch (e: any) {
      this.emit({ type: 'error', message: 'Spraakherkenning mislukte: ' + String(e?.message || e).slice(0, 200) });
    } finally {
      this.committing = false;
    }
    // You went on talking while the words were being recognised: the turn simply continues, with all its audio.
    if (seq !== this.evalSeq || this.stopped) return;
    if (!force) {
      this.inTurn = false;
      this.turn = [];
      this.turnLen = 0;
    }
    text = [this.carry, text.trim()].filter(Boolean).join(' ');
    this.carry = '';
    if (!text) return this.setPhase('listening');
    // Only "wacht even" / "ehm": you are not done (a voice pauses after such a comma as after a full stop). Keep
    // listening and put it in front of what you say next; the bot says nothing meanwhile.
    if (WAIT_WORDS.test(text)) {
      this.carry = text;
      this.lastUser = text;
      this.emit({ type: 'user', text, final: false });
      return this.setPhase('listening');
    }
    this.lastUser = text;
    this.emit({ type: 'user', text, final: true });
    void this.respond(text);
  }

  private async respond(text: string) {
    const epoch = ++this.epoch;
    const ctrl = new AbortController();
    this.answer = ctrl;
    this.said = [];
    this.sentSamples = 0;
    this.firstAudio = false;
    this.timing.brainAt = this.now();
    this.timing.firstSentenceAt = 0;
    this.d.send({ type: 'answer', epoch });
    this.setPhase('thinking');
    try {
      await this.d.brain.reply(text, {
        signal: ctrl.signal,
        onSentence: (s) => {
          if (ctrl.signal.aborted || epoch !== this.epoch) return;
          if (!this.timing.firstSentenceAt) this.timing.firstSentenceAt = this.now();
          this.say(epoch, s);
        },
      });
    } catch (e: any) {
      if (!ctrl.signal.aborted) this.emit({ type: 'error', message: String(e?.message || e).slice(0, 300) });
    }
    if (ctrl.signal.aborted || epoch !== this.epoch) return;
    await this.ttsChain;
    if (epoch !== this.epoch) return;
    this.answer = null;
    // The page says `played` when its speaker is done; until then we are still speaking.
    this.d.send({ type: 'answer-end', epoch, samples: this.sentSamples });
    if (!this.sentSamples) this.setPhase('listening');
  }

  /** Synthesize one sentence after the previous one and stream it out. */
  private say(epoch: number, text: string) {
    this.emit({ type: 'bot', text, epoch });
    this.ttsChain = this.ttsChain.then(async () => {
      if (epoch !== this.epoch || this.stopped) return;
      const t0 = this.now();
      let r: { pcm: Buffer; sampleRate: number };
      try {
        r = await this.d.voice.synth(text);
      } catch (e: any) {
        this.emit({ type: 'error', message: String(e?.message || e).slice(0, 300) });
        return;
      }
      if (epoch !== this.epoch || this.stopped) return;
      const n = r.pcm.length >> 1;
      this.said.push({ text, start: this.sentSamples, end: this.sentSamples + n, rate: r.sampleRate });
      this.sentSamples += n;
      if (!this.firstAudio) {
        this.firstAudio = true;
        const at = this.now();
        const ttsMs = Math.round(at - t0);
        const brainMs = Math.round((this.timing.firstSentenceAt || at) - this.timing.brainAt);
        const totalMs = Math.round(at - this.speechEndAt);
        const waitMs = Math.max(0, totalMs - brainMs - ttsMs - this.timing.turnMs);
        this.playing = true;
        this.d.send({ type: 'speech', epoch, sampleRate: r.sampleRate });
        this.emit({ type: 'latency', totalMs, sttMs: this.timing.sttMs, turnMs: this.timing.turnMs, brainMs, ttsMs, waitMs });
        this.setPhase('speaking');
      }
      this.playing = true;
      this.d.sendAudio(epoch, r.pcm);
    });
    this.ttsChain.catch(() => {});
  }

  /** Stop speaking and thinking now; the page reports how much it played (`played`). */
  private interrupt() {
    const was = this.epoch;
    this.cut = { epoch: was, said: this.said };
    this.playing = false;
    this.answer?.abort();
    this.answer = null;
    this.epoch++;
    this.hangupAfter = null;
    this.d.send({ type: 'interrupt', epoch: was });
  }

  /** Message from the page. */
  control(msg: any) {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'played') this.played(Number(msg.epoch), Number(msg.samples), !!msg.interrupted);
    else if (msg.type === 'hangup') this.stop('Opgehangen');
  }

  /** The page played `samples` of answer `epoch` (all of it, or up to where you interrupted). */
  private played(epoch: number, samples: number, interrupted: boolean) {
    if (!Number.isFinite(epoch) || !Number.isFinite(samples)) return;
    if (interrupted) {
      const heard = heardText(this.cut?.epoch === epoch ? this.cut.said : [], samples);
      this.cut = null;
      this.d.brain.interrupted?.(heard);
      this.emit({ type: 'interrupted', heard, epoch });
      return;
    }
    if (epoch !== this.epoch) return;
    this.playing = false;
    if (this.hangupAfter && this.hangupAfter.epoch === epoch) return this.stop(this.hangupAfter.reason);
    if (!this.answer && !this.inTurn) this.setPhase('listening');
  }

  /** `end_call` from the bot: say goodbye, hang up when it has been heard. */
  async endCall(args: { reason: string; goodbye?: string; summary?: string; runId?: string }): Promise<string> {
    if (this.stopped) return 'Het gesprek is al beëindigd.';
    const refusal = this.d.endCallRules ? await this.d.endCallRules(this.lastUser, args) : endCallWords(this.lastUser).refusal;
    if (refusal) return refusal;
    if (this.stopped) return 'Het gesprek is al beëindigd.';
    const reason = String(args.reason || 'De bot hing op').slice(0, 200);
    const goodbye = String(args.goodbye || '').trim().slice(0, 300);
    if (!goodbye && !this.answer && !this.playing) {
      setTimeout(() => this.stop(reason), 50).unref?.();
      return 'Het gesprek wordt beëindigd.';
    }
    if (goodbye) {
      if (!this.answer) {
        this.epoch++;
        this.said = [];
        this.sentSamples = 0;
        this.firstAudio = false;
        this.d.send({ type: 'answer', epoch: this.epoch });
      }
      const idle = !this.answer;
      const epoch = this.epoch;
      this.say(epoch, goodbye);
      if (idle) void this.ttsChain.then(() => epoch === this.epoch && this.d.send({ type: 'answer-end', epoch, samples: this.sentSamples }));
    }
    const pending = (this.hangupAfter = { epoch: this.epoch, reason });
    // Safety net: hang up even if the page never reports the end of playback, unless you talked over the goodbye
    // (then you are not done, and the hang-up is off).
    const sec = this.sentSamples / (this.said[0]?.rate || 22050);
    setTimeout(() => this.hangupAfter === pending && this.stop(reason), Math.min(30_000, 4000 + sec * 1000 + goodbye.length * 90)).unref?.();
    return 'Afscheid wordt uitgesproken; daarna wordt opgehangen.';
  }

  /** Hung up elsewhere: let the sentence that is playing finish, then stop. */
  finish(reason: string) {
    if (this.stopped) return;
    if (!this.answer && !this.playing) return this.stop(reason);
    this.hangupAfter = { epoch: this.epoch, reason };
    setTimeout(() => this.stop(reason), 8000).unref?.();
  }

  stop(reason = 'Opgehangen') {
    if (this.stopped) return;
    this.stopped = true;
    if (this.pauseTimer) clearTimeout(this.pauseTimer);
    this.answer?.abort();
    this.answer = null;
    this.epoch++;
    this.phase = 'ended';
    this.emit({ type: 'phase', phase: 'ended' });
    this.emit({ type: 'ended', reason });
    this.d.brain.close?.();
    this.d.vad.close?.();
    this.d.onEnd?.(reason);
  }

  get ended() {
    return this.stopped;
  }
}

/** What was heard of an answer when the page stopped after `samples` (the sentence it was in, cut by words). */
export function heardText(said: Said[], samples: number): string {
  const out: string[] = [];
  for (const s of said) {
    if (samples >= s.end) out.push(s.text);
    else if (samples > s.start) {
      const words = s.text.split(/\s+/);
      const k = Math.floor((words.length * (samples - s.start)) / Math.max(1, s.end - s.start));
      if (k > 0) out.push(words.slice(0, k).join(' ') + '…');
      break;
    } else break;
  }
  return out.join(' ');
}
