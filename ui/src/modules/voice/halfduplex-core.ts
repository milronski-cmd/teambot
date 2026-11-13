import { bargePreRollMs, voiceLevel } from './preroll.js';
import { plainForSpeech } from './speechText.js';
import { EnergyVad } from './vad.js';
import { PRESS_PRE_ROLL_MS, RELEASE_TAIL_MS, type TalkMode } from './talk.js';

/**
 * The free spoken call (take turns), without browser dependencies: the browser parts (microphone capture, the API,
 * playback, speech recognition) come in as `HdDeps`, so the whole turn-taking with barge-in also runs in tests with a
 * fake microphone, a fake bot and a fake clock (tests/voice-call-bargein.test.ts, tests/voice-talk.test.ts).
 * halfduplex.ts wires the real ones.
 */

/** 'ready': hold-to-talk, waiting for you to press (the microphone is open but nothing is recorded or sent). */
export type HdState = 'ready' | 'listening' | 'user' | 'transcribing' | 'thinking' | 'waiting_approval' | 'speaking' | 'muted' | 'paused';
export type SttEngine = 'local' | 'provider' | 'browser';

/** A voice turn's answer (server: voice/calls.ts AskResult, plus the live speech of /voice/calls/:id/turn). */
export interface AskResult {
  status: 'done' | 'working' | 'waiting_approval' | 'error' | 'cancelled';
  text: string;
  runId: string;
  messageId: string | null;
  error?: string;
  /** The model of the answer (message parts.model), when there is one. */
  model?: string | null;
  speech?: { id?: string; stream: string | null } | null;
}

export interface HdTiming {
  /** Speech-to-text after you stopped talking (ms). */
  sttMs?: number;
  /** The bot's answer (ms). */
  botMs?: number;
  /** From the answer to the first sound (ms). */
  voiceMs?: number;
  /** From sending your words to the bot until its voice starts (ms); with live reading this is before the answer is done. */
  firstSoundMs?: number;
  /** The model that gave the last answer (the same as in the chat: a voice turn is a normal run of the bot). */
  model?: string;
}

export interface HdCallbacks {
  onState(s: HdState): void;
  onCaption(c: { role: 'user' | 'assistant'; text: string; final: boolean }): void;
  onLevel(v: number): void;
  onError(msg: string, fatal: boolean): void;
  onTiming?(t: HdTiming): void;
  onBargeIn?(): void;
  /** A short, calm hint (not an error): "Houd de knop ingedrukt terwijl je praat." */
  onHint?(text: string): void;
}

export interface HdRecording {
  stop(): Promise<{ blob: Blob; durationMs: number }>;
  cancel(): void;
}

/** 16 kHz capture with a level meter, recordings that can start in the past (pre-roll) and recent levels. */
export interface HdCapture {
  level(): number;
  record(preRollMs: number): HdRecording;
  recentLevels(ms: number): number[];
  close(): void;
}

export interface HdMeter {
  level(): number;
  close?(): void;
}

export interface HdDeps {
  post<T>(path: string, body: unknown): Promise<T>;
  get<T>(path: string): Promise<T>;
  /** Live events of the app (message.created, message.delta). */
  on(type: string, fn: (d: any) => void): () => void;
  transcribe(blob: Blob, o: { durationMs: number; callId: string }): Promise<{ text: string }>;
  /** Play a live speech stream; resolves when it ended or was stopped (true = something was heard). */
  playLive(speech: { id: string; stream: string }, o: { t0: number; onFirst: (ms: number) => void }): Promise<boolean>;
  playMessage(messageId: string, o: { callId: string }): Promise<unknown>;
  stopPlayback(): void;
  lastFirstAudioMs(): number | null;
  openCapture(stream: MediaStream): Promise<HdCapture>;
  levelMeter(stream: MediaStream): HdMeter;
  recording(stream: MediaStream): HdRecording;
  /** Browser speech recognition; `continuous` (hold-to-talk): keep listening until stop(). */
  recognizeOnce(lang: string, onPartial: (t: string) => void, continuous?: boolean): { result: Promise<string>; abort(): void; stop?(): void };
  /** Level of the bot's voice that plays right now (0..1), null when unknown: the barge-in detector's echo reference. */
  outputLevel?(): number | null;
  /** Milliseconds (performance.now in the browser). */
  now(): number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const NO_SPEECH_MS = 20_000;
const MAX_UTTERANCE_MS = 60_000;
/** Hold-to-talk: shorter than this is a tap, not a turn (a tap while the bot speaks still stops it). */
const MIN_HOLD_MS = 300;

/**
 *  - idle:      muted or paused
 *  - listening: waiting for you to talk (hands-free), or for you to press the talk key (hold: state 'ready')
 *  - user:      you talk (recording)
 *  - working:   your words are being recognised, or the bot is busy and has not spoken yet
 *  - speaking:  the bot's voice plays
 */
type Phase = 'idle' | 'listening' | 'user' | 'working' | 'speaking';

/** Text of a run's answer as it streams in (live events, collected from before the run id is known). */
class RunText {
  private runOf = new Map<string, string>();
  private text = new Map<string, string>();
  private runId: string | null = null;
  private cb: ((text: string) => void) | null = null;
  private offs: (() => void)[];
  constructor(on: HdDeps['on']) {
    this.offs = [
      on('message.created', (m: any) => {
        if (m?.role === 'assistant' && m.run_id) this.runOf.set(m.id, m.run_id);
      }),
      on('message.delta', (d: { messageId: string; text: string }) => {
        if (!d?.text) return;
        this.text.set(d.messageId, (this.text.get(d.messageId) || '') + d.text);
        if (this.runId && this.runOf.get(d.messageId) === this.runId) this.emit();
      }),
    ];
  }
  private emit() {
    const parts = [...this.runOf.entries()].filter(([, r]) => r === this.runId).map(([id]) => this.text.get(id) || '');
    this.cb?.(parts.filter(Boolean).join('\n\n'));
  }
  follow(runId: string, cb: (text: string) => void) {
    this.runId = runId;
    this.cb = cb;
    this.emit();
  }
  close() {
    this.offs.forEach((f) => f());
    this.offs = [];
    this.cb = null;
  }
}

/**
 * A spoken call that works with every bot and engine (also Claude Code/Codex/OpenCode CLI bots): take turns.
 * Your words → speech-to-text (free on the PC with the local engine) → the bot, through the normal run with its own
 * model, tools, delegation and approvals (exactly as when you type) → its voice → your turn again.
 *
 * Two ways to talk (`talk`, see talk.ts):
 *  - 'hold' (default on a computer): you hold a key or button while you talk; letting go ends your turn. Nothing you
 *    or the speakers say counts while you do not hold it, so the bot's own voice can never interrupt it, and a pause
 *    to think never ends your turn. Pressing while the bot speaks (or is still busy) interrupts it.
 *  - 'handsfree': voice activity detection; a pause ends your turn. With barge-in you interrupt the bot by talking,
 *    while its voice plays and while it is still busy and silent (a slow engine can take seconds before its first
 *    sentence). The detector then uses a higher threshold and the self-voice gate of EnergyVad (the bot's own voice
 *    from the speakers is not you).
 * Either way, what you say after interrupting stops that answer (it stays in the chat as far as it got) and becomes
 * the next turn right away, instead of waiting behind it. The microphone is only recorded while the call screen is
 * open and not muted.
 */
export class HalfDuplexCore {
  private meter: HdMeter | HdCapture | null = null;
  private cap: HdCapture | null = null;
  private vad: EnergyVad | null = null;
  private rec: HdRecording | null = null;
  private sr: { result: Promise<string>; abort(): void; stop?(): void } | null = null;
  private stream: MediaStream | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private levelTimer: ReturnType<typeof setInterval> | null = null;
  private phase: Phase = 'idle';
  private stopped = false;
  private muted = false;
  private paused = false;
  /** What the bot has said so far while its answer is read live (kept as caption when you interrupt). */
  private liveCaption: string | null = null;
  /** The bot's run that is answering you now (spoken or still silent). */
  private answering: string | null = null;
  /** The answer you interrupted: the next turn stops it, so your new words do not wait behind it. */
  private interrupted: string | null = null;
  /** While the bot is busy and silent you can interrupt too, but not while it waits for your approval card. */
  private interruptible = false;
  /** The bot waits for your approval (hold mode: pressing then explains why nothing happens). */
  private waitApproval = false;
  private talk: TalkMode;
  /** Hold mode: the key or button is down. */
  private holding = false;
  private pressedAt = 0;
  /** This press interrupted the bot (a short tap is then a deliberate "stop", not a mistake). */
  private pressBarged = false;
  /** Hold mode: the recording runs on a little after you let go (RELEASE_TAIL_MS). */
  private tail: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private o: { callId: string; sttEngine: SttEngine; lang: string; bargeIn?: boolean; silenceMs?: number; talk?: TalkMode; cb: HdCallbacks },
    private d: HdDeps,
  ) {
    this.talk = o.talk ?? 'handsfree';
  }

  /** How you talk right now ('hold' or 'handsfree'). */
  get talkMode(): TalkMode {
    return this.talk;
  }

  /** Is the talk key held (hold mode)? */
  get isHolding(): boolean {
    return this.holding || !!this.tail;
  }

  async start(stream: MediaStream) {
    this.stream = stream;
    if (this.o.sttEngine === 'browser') {
      this.meter = this.d.levelMeter(stream);
      // (its own timer: clearTimers() is for the turn timers)
      this.levelTimer = setInterval(() => this.o.cb.onLevel(this.meter?.level() || 0), 80);
      this.listen();
      return;
    }
    // 16 kHz WAV for both engines (a provider accepts WAV too): only this way a barge-in can include the audio from
    // before it was detected; MediaRecorder cannot start in the past.
    try {
      this.cap = await this.d.openCapture(stream);
      this.meter = this.cap;
    } catch {
      if (this.o.sttEngine === 'local') throw new Error('Opnemen voor de lokale spraakherkenning lukt niet in deze browser.');
      this.meter = this.d.levelMeter(stream);
    }
    if (this.stopped) return;
    this.vad = new EnergyVad(this.meter, {
      onStart: () => this.speechStart(),
      onEnd: () => void this.speechEnd(),
      onLevel: (v) => this.o.cb.onLevel(v),
      silenceMs: this.o.silenceMs ?? 900,
      echoRef: this.d.outputLevel ? () => this.d.outputLevel!() : undefined,
    });
    this.vad.start();
    this.listen();
  }

  private clearTimers() {
    for (const t of this.timers) clearTimeout(t);
    this.timers = [];
  }

  private newRec(preRollMs: number): HdRecording {
    return this.cap ? this.cap.record(preRollMs) : this.d.recording(this.stream!);
  }

  private listen(): void {
    if (this.stopped) return;
    this.interruptible = false;
    this.waitApproval = false;
    if (this.muted || this.paused) {
      this.phase = 'idle';
      this.o.cb.onState(this.muted ? 'muted' : 'paused');
      return;
    }
    this.phase = 'listening';
    if (this.talk === 'hold') {
      // The microphone stays open (level meter, pre-roll) but nothing is recorded until you press.
      this.sr?.abort();
      this.sr = null;
      this.rec?.cancel();
      this.rec = null;
      this.clearTimers();
      if (this.vad) {
        this.vad.barge = false;
        this.vad.reset();
        this.vad.paused = true;
      }
      this.o.cb.onState('ready');
      return;
    }
    this.o.cb.onState('listening');
    if (this.o.sttEngine === 'browser') {
      void this.listenBrowser();
      return;
    }
    this.rec?.cancel();
    this.rec = this.newRec(300);
    this.vad!.barge = false;
    this.vad!.reset();
    this.vad!.paused = false;
    this.clearTimers();
    // Keep recordings small while nobody talks.
    this.timers.push(setTimeout(() => this.phase === 'listening' && !this.vad?.active && this.listen(), NO_SPEECH_MS));
  }

  private async listenBrowser(): Promise<void> {
    try {
      this.sr = this.d.recognizeOnce(this.o.lang, (t) => this.o.cb.onCaption({ role: 'user', text: t, final: false }));
      const text = await this.sr.result;
      this.sr = null;
      if (this.stopped || this.muted || this.paused || this.talk === 'hold') return;
      if (!text) {
        await sleep(250);
        return this.listen();
      }
      this.phase = 'working';
      await this.turn(text);
    } catch (e: any) {
      this.o.cb.onError(e?.message || String(e), true);
      return;
    }
    if (!this.stopped && (this.phase as Phase) !== 'user') this.listen();
  }

  private utteranceLimit() {
    this.clearTimers();
    this.timers.push(
      setTimeout(() => {
        if (this.phase !== 'user') return;
        if (this.talk === 'hold') {
          // Held for a minute: send what you said so far.
          this.holding = false;
          void this.endHold();
        } else if (this.vad?.active) void this.speechEnd();
      }, MAX_UTTERANCE_MS),
    );
  }

  /**
   * The microphone listens for you interrupting (barge mode: a higher threshold, the bot's echo does not count): while
   * the bot speaks, and while it is busy and silent after your turn was sent. Not in hold mode: there only the key
   * interrupts.
   */
  private armBarge() {
    if (this.talk === 'hold' || !this.vad || this.o.bargeIn === false || this.muted || this.paused || this.stopped) return;
    this.rec?.cancel();
    this.rec = null;
    this.vad.barge = true;
    this.vad.reset();
    this.vad.paused = false;
  }

  /** Stop the bot for you: its voice stops, what it said so far stays as caption, its answer stops with your next turn. */
  private cutIn() {
    this.interruptible = false;
    this.interrupted = this.answering;
    this.d.stopPlayback();
    // Keep what the bot had said so far as its caption (the rest is in the chat).
    if (this.liveCaption) this.o.cb.onCaption({ role: 'assistant', text: this.liveCaption, final: true });
    this.liveCaption = null;
    this.rec?.cancel();
    this.rec = null;
    this.o.cb.onBargeIn?.();
  }

  private speechStart() {
    if (this.stopped || this.muted || this.paused || this.talk === 'hold') return;
    if (this.phase === 'listening') {
      this.phase = 'user';
      this.o.cb.onState('user');
      this.utteranceLimit();
      return;
    }
    if ((this.phase === 'speaking' || (this.phase === 'working' && this.interruptible)) && this.o.bargeIn !== false) {
      // Barge-in: stop the bot and record what you say, from where you started talking (not where the detector
      // became sure, which is ≥ 350 ms later), see preroll.ts.
      const vad = this.vad!;
      const pre = this.cap ? bargePreRollMs(this.cap.recentLevels(3000), { threshold: voiceLevel(vad.baseThreshold, vad.threshold) }) : 0;
      this.phase = 'user';
      this.cutIn();
      this.rec = this.newRec(pre);
      vad.barge = false;
      this.o.cb.onState('user');
      this.utteranceLimit();
    }
  }

  /**
   * Hold-to-talk: the key or button went down. Starts your turn; while the bot speaks or is still busy it interrupts
   * it (you asked for that). Not while your words are being recognised or the bot waits for your approval. Returns
   * whether you are now talking.
   */
  press(): boolean {
    if (this.stopped || this.muted || this.paused || this.talk !== 'hold') return false;
    if (this.holding) return true;
    if (this.tail) {
      // Pressed again right after letting go: the same turn goes on.
      clearTimeout(this.tail);
      this.tail = null;
      this.holding = true;
      return true;
    }
    const barge = this.phase === 'speaking' || (this.phase === 'working' && this.interruptible);
    if (this.phase !== 'listening' && !barge) {
      if (this.waitApproval) this.o.cb.onHint?.('Keur eerst het verzoek goed of weiger het; daarna kun je weer praten.');
      return false;
    }
    this.holding = true;
    this.pressedAt = this.d.now();
    this.pressBarged = barge;
    this.phase = 'user';
    if (barge) this.cutIn();
    if (this.o.sttEngine === 'browser') {
      this.sr?.abort();
      this.sr = this.d.recognizeOnce(this.o.lang, (t) => this.o.cb.onCaption({ role: 'user', text: t, final: false }), true);
      this.sr.result.catch(() => '');
    } else {
      this.rec?.cancel();
      this.rec = this.newRec(PRESS_PRE_ROLL_MS);
    }
    this.o.cb.onState('user');
    this.utteranceLimit();
    return true;
  }

  /** Hold-to-talk: the key or button went up. Your turn ends a moment later (RELEASE_TAIL_MS), unless you press again. */
  release() {
    if (!this.holding) return;
    this.holding = false;
    if (this.phase !== 'user' || this.stopped) return;
    if (this.d.now() - this.pressedAt < MIN_HOLD_MS) {
      // A tap: nothing to send. (A tap while the bot spoke did stop it: that is a fine way to say "stop".)
      this.rec?.cancel();
      this.rec = null;
      this.sr?.abort();
      this.sr = null;
      if (!this.pressBarged) this.o.cb.onHint?.('Houd de knop of de spatiebalk ingedrukt zolang je praat.');
      this.phase = 'working';
      this.listen();
      return;
    }
    this.tail = setTimeout(() => {
      this.tail = null;
      if (this.phase === 'user' && !this.holding) void this.endHold();
    }, RELEASE_TAIL_MS);
  }

  /** Hold mode: your turn is over (let go, held too long, or switched to hands-free). */
  private async endHold() {
    if (this.o.sttEngine !== 'browser') return this.speechEnd();
    const sr = this.sr;
    if (this.phase !== 'user' || !sr) return;
    this.phase = 'working';
    this.clearTimers();
    this.o.cb.onState('transcribing');
    if (sr.stop) sr.stop();
    else sr.abort();
    try {
      const text = (await sr.result).trim();
      if (this.sr === sr) this.sr = null;
      if (this.stopped || this.muted || this.paused) return;
      if (text) await this.turn(text);
    } catch (e: any) {
      this.o.cb.onError(e?.message || String(e), false);
    } finally {
      if (this.sr === sr) this.sr = null;
      if (!this.stopped && (this.phase === 'working' || this.phase === 'idle')) this.listen();
    }
  }

  private async speechEnd() {
    if (this.phase !== 'user' || !this.rec || this.stopped) return;
    this.phase = 'working';
    this.interruptible = false;
    if (this.vad) this.vad.paused = true;
    this.clearTimers();
    const rec = this.rec;
    this.rec = null;
    try {
      const { blob, durationMs } = await rec.stop();
      if (this.muted || this.paused || this.stopped) return;
      if (durationMs < 500 || blob.size < 1500) return;
      this.o.cb.onState('transcribing');
      const t0 = this.d.now();
      const r = await this.d.transcribe(blob, { durationMs, callId: this.o.callId });
      this.o.cb.onTiming?.({ sttMs: Math.round(this.d.now() - t0) });
      const text = r.text.trim();
      if (!text || this.stopped) return;
      await this.turn(text);
    } catch (e: any) {
      this.o.cb.onError(e?.message || String(e), false);
    } finally {
      // After a barge-in the new recording is already running (phase 'user'): leave it alone.
      if (!this.stopped && (this.phase === 'working' || this.phase === 'idle')) this.listen();
    }
  }

  private async turn(text: string) {
    this.o.cb.onCaption({ role: 'user', text, final: true });
    this.o.cb.onState('thinking');
    const t0 = this.d.now();
    // Listen for the answer's text before asking: a fast bot can be writing before the request returns.
    const captions = new RunText(this.d.on);
    // An answer you interrupted stops now: your new words become the next turn at once instead of waiting behind it.
    const interrupt = this.interrupted;
    this.interrupted = null;
    // speak: the PC starts reading the answer aloud after its first sentence, while the bot is still writing.
    let r: AskResult;
    try {
      r = await this.d.post<AskResult>(`/voice/calls/${this.o.callId}/turn`, { text, speak: true, ...(interrupt ? { interrupt } : {}) });
      if (this.stopped) return;
      this.answering = r.runId;
      if (r.speech?.stream) return await this.speakLive(r, t0, captions);
    } finally {
      captions.close();
    }
    this.waitingFor(r.status);
    while (!this.stopped && this.phase === 'working' && (r.status === 'working' || r.status === 'waiting_approval')) {
      this.o.cb.onState(r.status === 'waiting_approval' ? 'waiting_approval' : 'thinking');
      await sleep(1000);
      if (this.phase !== 'working') break;
      r = await this.d.get<AskResult>(`/voice/calls/${this.o.callId}/runs/${r.runId}`);
      this.waitingFor(r.status);
    }
    this.interruptible = false;
    this.waitApproval = false;
    if (this.stopped || this.phase !== 'working') return;
    if (!this.answered(r, t0)) return;
    if (r.messageId && r.text) await this.speakFinished(r.messageId, t0);
  }

  /** The answer is in: how long it took, and its text (or why there is none) under the call. False = nothing to read aloud. */
  private answered(r: AskResult, t0: number): boolean {
    this.o.cb.onTiming?.({ botMs: Math.round(this.d.now() - t0), ...(r.model ? { model: r.model } : {}) });
    if (r.status !== 'done') {
      this.o.cb.onCaption({ role: 'assistant', text: r.status === 'cancelled' ? '(gestopt)' : `(fout: ${r.error || 'onbekend'})`, final: true });
      return false;
    }
    if (r.text) this.o.cb.onCaption({ role: 'assistant', text: plainForSpeech(r.text), final: true });
    return true;
  }

  /** The bot is busy and silent: you may interrupt, unless it waits for your approval (that card is for your hands). */
  private waitingFor(status: AskResult['status']) {
    if (this.phase !== 'working' || this.stopped) return;
    this.waitApproval = status === 'waiting_approval';
    const can = status === 'working';
    if (can && !this.interruptible) {
      this.interruptible = true;
      this.armBarge();
    } else if (!can && this.interruptible) {
      this.interruptible = false;
      if (this.vad) this.vad.paused = true;
    }
  }

  /** The bot talks: from now on the microphone listens for you interrupting (higher threshold, see EnergyVad). */
  private startSpeaking() {
    const wasArmed = this.interruptible && !!this.vad?.barge;
    this.phase = 'speaking';
    this.interruptible = false;
    this.waitApproval = false;
    this.o.cb.onState('speaking');
    // Already listening in barge mode while the bot was silent: keep what the detector has (you may be mid-word).
    if (!wasArmed) this.armBarge();
  }

  /** Read a finished answer (other voices than the local one, or live reading switched off). */
  private async speakFinished(messageId: string, t0: number) {
    this.startSpeaking();
    const botMs = this.d.now() - t0;
    await this.d
      .playMessage(messageId, { callId: this.o.callId })
      .then(() => {
        const first = this.d.lastFirstAudioMs();
        if (first !== null) this.o.cb.onTiming?.({ voiceMs: first, firstSoundMs: Math.round(botMs + first) });
      })
      .catch((e) => this.o.cb.onError(e?.message || String(e), false));
    if (this.phase === 'speaking') this.phase = 'working';
  }

  /**
   * The answer is read aloud while the bot writes it: the voice starts after the first sentence. Captions follow the
   * text as it streams in; a pending approval shows until the bot continues.
   */
  private async speakLive(first: AskResult, t0: number, captions: RunText) {
    const runId = first.runId;
    const speech = first.speech as { id: string; stream: string };
    let finished: AskResult | null = first.status === 'working' || first.status === 'waiting_approval' ? null : first;
    let speaking = false;
    if (!finished) this.waitingFor(first.status);
    captions.follow(runId, (text) => {
      if (this.stopped || this.phase === 'user' || !text) return;
      this.liveCaption = plainForSpeech(text);
      this.o.cb.onCaption({ role: 'assistant', text: this.liveCaption, final: false });
    });
    const status = async () => {
      while (!this.stopped && !finished) {
        await sleep(1000);
        if (finished || this.stopped) break;
        const s = await this.d.get<AskResult>(`/voice/calls/${this.o.callId}/runs/${runId}`).catch(() => null);
        if (!s) continue;
        if (s.status !== 'working' && s.status !== 'waiting_approval') finished = s;
        else if (!speaking && this.phase === 'working') {
          this.o.cb.onState(s.status === 'waiting_approval' ? 'waiting_approval' : 'thinking');
          this.waitingFor(s.status);
        }
      }
    };
    const polling = status();
    let played = false;
    try {
      played = await this.d.playLive(speech, {
        t0,
        onFirst: (ms) => {
          speaking = true;
          this.o.cb.onTiming?.({ firstSoundMs: ms });
          if (!this.stopped && this.phase === 'working') this.startSpeaking();
        },
      });
    } catch (e: any) {
      this.o.cb.onError(e?.message || String(e), false);
    } finally {
      captions.close();
    }
    if (this.stopped) return;
    // Interrupted by talking: the new recording is already running; the bot's text stays in the chat.
    if (this.phase === 'user') return;
    this.liveCaption = null;
    if (this.phase === 'speaking') this.phase = 'working';
    // The voice ended before the answer did (it was cut short or the bot paused long): still interruptible meanwhile.
    if (!finished) {
      this.waitingFor('working');
      await polling;
    }
    this.interruptible = false;
    this.waitApproval = false;
    if (this.phase !== 'working') return;
    const r = finished as AskResult | null;
    if (!r || this.stopped) return;
    if (!this.answered(r, t0)) return;
    // Nothing came out of the live voice (e.g. it stopped early): read the finished answer the normal way.
    if (!played && r.messageId && r.text && this.phase === 'working') await this.speakFinished(r.messageId, t0);
  }

  /** Stop the spoken answer and go back to listening. */
  interrupt() {
    this.d.stopPlayback();
  }

  /**
   * Switch between hold-to-talk and hands-free during the call. What you are saying right now still goes out; a
   * waiting microphone switches at once; while the bot speaks, hands-free listens for you interrupting again.
   */
  setTalk(mode: TalkMode) {
    if (mode === this.talk) return;
    this.talk = mode;
    if (this.stopped) return;
    if (mode === 'hold') {
      if (this.phase === 'listening') return this.listen();
      // The microphone no longer interrupts by itself; your current sentence (if any) ends as detected.
      if (this.vad && this.phase !== 'user') {
        this.vad.barge = false;
        this.vad.paused = true;
      }
      return;
    }
    if (this.tail) {
      clearTimeout(this.tail);
      this.tail = null;
    }
    if (this.phase === 'user' && (this.holding || this.sr || this.rec)) {
      this.holding = false;
      void this.endHold();
      return;
    }
    if (this.phase === 'listening') return this.listen();
    if (this.phase === 'speaking' || (this.phase === 'working' && this.interruptible)) this.armBarge();
  }

  mute(on: boolean) {
    this.muted = on;
    this.applyPause();
  }

  pause(on: boolean) {
    this.paused = on;
    this.applyPause();
  }

  private applyPause() {
    const off = this.muted || this.paused;
    if (off) {
      this.holding = false;
      if (this.tail) clearTimeout(this.tail);
      this.tail = null;
      if (this.phase === 'user' || this.phase === 'listening') {
        this.rec?.cancel();
        this.rec = null;
        this.phase = 'idle';
      }
      this.interruptible = false;
      this.sr?.abort();
      this.sr = null;
      if (this.vad) this.vad.paused = true;
      if (this.phase === 'idle') {
        this.clearTimers();
        this.o.cb.onState(this.muted ? 'muted' : 'paused');
      }
    } else if (this.phase === 'idle') this.listen();
  }

  close() {
    this.stopped = true;
    this.holding = false;
    if (this.tail) clearTimeout(this.tail);
    this.tail = null;
    this.d.stopPlayback();
    this.clearTimers();
    if (this.levelTimer) clearInterval(this.levelTimer);
    this.levelTimer = null;
    this.rec?.cancel();
    this.sr?.abort();
    this.vad?.stop();
    if (this.meter && this.meter !== this.cap) this.meter.close?.();
    this.cap?.close();
  }
}

