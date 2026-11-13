/**
 * The global dictation hotkey as a small state machine, without Electron (so it is tested with fakes).
 *
 *   idle ──press──▶ starting ──mic+STT open──▶ recording ──(release after a hold | press again | max length)──▶ finishing
 *     ▲                │ password field / error                │ Esc                                              │ text
 *     └──── message ◀──┘                                       └──▶ idle (nothing kept)            inserting ◀──┘
 *
 * Hold the combination ≥ HOLD_MS = push-to-talk (letting go finishes). A short tap = hands-free: it keeps recording
 * until you press the combination again. Key repeats while the keys are held are ignored.
 */

export type DictPhase = 'idle' | 'starting' | 'recording' | 'finishing' | 'inserting' | 'message';
export type DictMode = 'pending' | 'hold' | 'toggle';

export interface Recorder {
  /** Open the microphone and the recogniser. Rejects with a Dutch message. `onText`: live text while you talk. */
  start(onText: (text: string) => void, onLevel: (level: number) => void): Promise<void>;
  /** Stop recording and return the final text. */
  stop(): Promise<string>;
  cancel(): void;
}

export interface InsertResult {
  ok: boolean;
  /** pasted = in the app; clipboard = left on the clipboard (could not paste); refused = password field etc. */
  how: 'pasted' | 'typed' | 'clipboard' | 'refused';
  message?: string;
}

export interface Target {
  /** What has the focus now: null = unknown (no helper). */
  probe(): Promise<{ password: boolean; blocked?: string | null } | null>;
  insert(text: string): Promise<InsertResult>;
}

/** Watches the main key of the combination; calls back once when it is released. null = cannot (toggle only). */
export type KeyWatch = ((onRelease: () => void) => () => void) | null;

export interface OverlayView {
  phase: 'starting' | 'recording' | 'working' | 'done' | 'message';
  mode?: DictMode;
  text?: string;
  level?: number;
  seconds?: number;
  hint?: string;
  tone?: 'ok' | 'warn';
}

export interface MachineDeps {
  recorder: Recorder;
  target: Target;
  keyWatch: KeyWatch;
  view: { show(v: OverlayView): void; hide(): void };
  /** Esc cancels: armed only while recording (the shell registers/unregisters the global Esc). */
  armEscape(on: boolean): void;
  label: () => string;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  onDone?: (r: { text: string; result: InsertResult | null; seconds: number }) => void;
}

export const HOLD_MS = 350;
export const MAX_MS = 5 * 60_000;
/** Hard limits, so the pill can never stay hanging over other programs: opening the microphone, and writing out + pasting. */
export const START_MAX_MS = 20_000;
export const FINISH_MAX_MS = 120_000;
const REPEAT_MS = 250;

export class DictationMachine {
  phase: DictPhase = 'idle';
  mode: DictMode = 'pending';
  private startedAt = 0;
  private lastPress = -Infinity;
  private stopWatch: (() => void) | null = null;
  private timers = new Set<unknown>();
  private finishWhenStarted = false;
  private liveText = '';
  private level = 0;
  private gen = 0;
  private now: () => number;
  private setTimer: (fn: () => void, ms: number) => unknown;
  private clearTimer: (t: unknown) => void;

  constructor(private d: MachineDeps) {
    this.now = d.now || (() => Date.now());
    this.setTimer = d.setTimer || ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer || ((t) => clearTimeout(t as any));
  }

  private later(fn: () => void, ms: number) {
    const t = this.setTimer(() => {
      this.timers.delete(t);
      fn();
    }, ms);
    this.timers.add(t);
    return t;
  }

  private clearAll() {
    for (const t of this.timers) this.clearTimer(t);
    this.timers.clear();
    this.stopWatch?.();
    this.stopWatch = null;
  }

  private hint() {
    const k = this.d.label();
    return this.mode === 'toggle' ? `${k} = klaar · Esc = annuleren` : this.mode === 'hold' ? `loslaten = klaar · Esc = annuleren` : `loslaten = klaar · tikken = handsfree · Esc = annuleren`;
  }

  private render() {
    if (this.phase !== 'recording') return;
    this.d.view.show({ phase: 'recording', mode: this.mode, text: this.liveText, level: this.level, seconds: Math.floor((this.now() - this.startedAt) / 1000), hint: this.hint() });
  }

  private message(text: string, tone: 'ok' | 'warn' = 'warn', ms = 2600) {
    const my = ++this.gen;
    this.phase = 'message';
    this.d.view.show({ phase: 'message', text, tone });
    this.later(() => {
      if (this.gen !== my) return;
      this.phase = 'idle';
      this.d.view.hide();
    }, ms);
  }

  /** The hotkey fired (key down; Windows repeats it while held). */
  press() {
    const t = this.now();
    const repeat = t - this.lastPress < REPEAT_MS;
    this.lastPress = t;
    if (repeat) return;
    if (this.phase === 'idle' || this.phase === 'message') return void this.start();
    if (this.phase === 'starting') {
      // Second tap before the microphone was even open: finish as soon as it is (a very short dictation).
      this.finishWhenStarted = true;
      return;
    }
    if (this.phase === 'recording' && this.mode !== 'hold') void this.finish();
  }

  /** Esc: throw the recording away. */
  escape() {
    if (this.phase !== 'starting' && this.phase !== 'recording') return;
    ++this.gen;
    this.clearAll();
    this.d.armEscape(false);
    this.d.recorder.cancel();
    this.phase = 'idle';
    this.d.view.hide();
  }

  /**
   * It broke while busy (the microphone went away, the pill crashed, writing out hangs): throw the recording away,
   * say why for a moment and go away. Nothing is pasted.
   */
  fail(text: string) {
    if (this.phase === 'idle' || this.phase === 'message') return;
    ++this.gen;
    this.clearAll();
    this.d.armEscape(false);
    this.d.recorder.cancel();
    this.message(String(text || 'Dicteren lukte niet').slice(0, 160));
  }

  /** Feature switched off / app quits. */
  shutdown() {
    if (this.phase === 'starting' || this.phase === 'recording') this.escape();
    ++this.gen;
    this.clearAll();
    this.phase = 'idle';
    this.d.view.hide();
  }

  private async start() {
    const my = ++this.gen;
    this.clearAll();
    this.phase = 'starting';
    this.mode = 'pending';
    this.liveText = '';
    this.level = 0;
    this.finishWhenStarted = false;
    this.startedAt = this.now();
    this.d.view.show({ phase: 'starting', hint: 'Microfoon aan…' });
    this.later(() => this.gen === my && this.phase === 'starting' && this.fail('De microfoon reageerde niet.'), START_MAX_MS);
    // Hold detection starts right away: the key may already be up by the time the microphone is open.
    let releasedEarly = false;
    if (this.d.keyWatch) {
      this.stopWatch = this.d.keyWatch(() => {
        this.stopWatch = null;
        if (this.gen !== my) return;
        const held = this.now() - this.startedAt;
        if (held < HOLD_MS) this.mode = 'toggle';
        else this.mode = 'hold';
        if (this.phase === 'starting') releasedEarly = this.mode === 'hold';
        else if (this.phase === 'recording') {
          if (this.mode === 'hold') void this.finish();
          else this.render();
        }
      });
      this.later(() => {
        // Still held after HOLD_MS: push-to-talk.
        if (this.gen === my && this.mode === 'pending' && this.stopWatch) {
          this.mode = 'hold';
          this.render();
        }
      }, HOLD_MS);
    } else this.mode = 'toggle';
    try {
      const probe = await this.d.target.probe().catch(() => null);
      if (this.gen !== my) return;
      if (probe?.password) {
        this.clearAll();
        return this.message('Wachtwoordveld: dicteren staat hier uit.');
      }
      if (probe?.blocked) {
        this.clearAll();
        return this.message(probe.blocked);
      }
      await this.d.recorder.start(
        (text) => {
          if (this.gen !== my) return;
          this.liveText = text;
          this.render();
        },
        (level) => {
          if (this.gen !== my) return;
          this.level = level;
        },
      );
    } catch (e: any) {
      if (this.gen !== my) return;
      this.clearAll();
      this.d.recorder.cancel();
      return this.message(String(e?.message || e).slice(0, 160) || 'Dicteren lukte niet');
    }
    if (this.gen !== my) {
      this.d.recorder.cancel();
      return;
    }
    this.phase = 'recording';
    this.d.armEscape(true);
    this.render();
    const tick = () => {
      if (this.gen !== my || this.phase !== 'recording') return;
      this.render();
      this.later(tick, 250);
    };
    this.later(tick, 250);
    this.later(() => this.gen === my && this.phase === 'recording' && void this.finish(), MAX_MS);
    if (releasedEarly || this.finishWhenStarted) void this.finish();
  }

  private async finish() {
    if (this.phase !== 'recording') return;
    const my = this.gen;
    this.phase = 'finishing';
    this.clearAll();
    this.d.armEscape(false);
    const seconds = (this.now() - this.startedAt) / 1000;
    this.d.view.show({ phase: 'working', text: this.liveText, hint: 'Uitschrijven…' });
    this.later(() => this.gen === my && (this.phase === 'finishing' || this.phase === 'inserting') && this.fail('Uitschrijven duurde te lang.'), FINISH_MAX_MS);
    let text = '';
    try {
      text = (await this.d.recorder.stop()).trim();
    } catch (e: any) {
      if (this.gen !== my) return;
      return this.message(`Uitschrijven lukte niet: ${String(e?.message || e).slice(0, 140)}`);
    }
    if (this.gen !== my) return;
    if (!text) {
      this.d.onDone?.({ text: '', result: null, seconds });
      return this.message('Niets verstaan.', 'warn', 1500);
    }
    this.phase = 'inserting';
    let r: InsertResult;
    try {
      r = await this.d.target.insert(text);
    } catch (e: any) {
      r = { ok: false, how: 'clipboard', message: String(e?.message || e) };
    }
    if (this.gen !== my) return;
    this.d.onDone?.({ text, result: r, seconds });
    if (r.ok && (r.how === 'pasted' || r.how === 'typed')) {
      const my2 = ++this.gen;
      this.phase = 'message';
      this.d.view.show({ phase: 'done', text, tone: 'ok' });
      this.later(() => {
        if (this.gen !== my2) return;
        this.phase = 'idle';
        this.d.view.hide();
      }, 900);
      return;
    }
    this.message(r.message || (r.how === 'clipboard' ? 'Niet geplakt: de tekst staat op het klembord (Ctrl+V).' : 'Niet geplakt.'), 'warn', 4000);
  }
}
