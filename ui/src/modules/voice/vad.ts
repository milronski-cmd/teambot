/**
 * Energy-based voice activity detection: calibrates on background noise, then reports speech start/end.
 * Runs only while the call screen is open and the microphone is visibly on. (No DOM types: also runs in tests.)
 *
 * `barge` mode is used while the bot speaks: a much higher threshold and a longer minimum, so the bot's own voice
 * from the speakers (echo cancellation removes most of it) does not count as you interrupting; the noise floor is
 * not adapted to that sound. While the bot talks, the browser's echo canceller also turns *your* voice down in a
 * jumpy way (double talk): every other 50 ms step can fall under the threshold. So in barge mode it counts the loud
 * steps within the last second (at least 350 ms of voice), instead of requiring them almost without a gap; the
 * stricter count lost a short "Wacht even, ik heb een andere vraag" now and then (voice:live, B-52).
 *
 * Self-voice gate (`echoRef`): the level of what the bot's voice plays right now (player.ts knows it exactly, it
 * schedules the samples itself). In barge mode the detector learns how loud that voice comes back in the microphone
 * (the echo the canceller left over: a low percentile of microphone ÷ output over the last 2 s, so your own words
 * do not count as echo) and a step only counts as you when it is clearly louder than that echo. The first 300 ms of
 * loud bot audio are for learning: then nothing counts. Speakers without echo cancellation, a loud room or a laptop
 * microphone next to the speaker therefore do not make the bot interrupt itself. Without a reference (the browser
 * voice, an audio file) the plain thresholds above apply.
 */
export class EnergyVad {
  private timer: ReturnType<typeof setInterval> | null = null;
  private floor = 0;
  private samples = 0;
  private loud = 0;
  private quiet = 0;
  active = false;
  paused = false;
  barge = false;
  /** Barge mode: loud (1) or not (0) for the last BARGE_WINDOW steps. */
  private recent: number[] = [];
  /** Barge mode with an output reference: microphone ÷ output for recent steps with loud bot audio. */
  private echo: number[] = [];
  constructor(
    private meter: { level(): number },
    private o: {
      onStart(): void;
      onEnd(): void;
      onLevel?(v: number): void;
      silenceMs?: number;
      minSpeechMs?: number;
      /** Level of the bot's voice playing right now (0..1, same scale as the samples), null when unknown. */
      echoRef?: () => number | null;
    },
  ) {}
  /** Threshold for normal speech (calibrated on the room). */
  get baseThreshold() {
    return Math.max(0.012, this.floor * 2.5 + 0.004);
  }
  get threshold() {
    const base = this.baseThreshold;
    return this.barge ? Math.max(0.045, base * 3) : base;
  }
  static readonly STEP_MS = 50;
  /** Barge mode: steps looked back at (1 s) and how much voice they must hold (350 ms). */
  static readonly BARGE_WINDOW = 20;
  static readonly BARGE_MIN_MS = 350;
  /** Output quieter than this has no echo worth measuring (a pause between two sentences). */
  static readonly ECHO_MIN_OUT = 0.01;
  /** Ratios kept (2 s of loud bot audio), needed before the gate opens (300 ms), the percentile and the margin. */
  static readonly ECHO_WINDOW = 40;
  static readonly ECHO_LEARN = 6;
  static readonly ECHO_PERCENTILE = 0.3;
  static readonly ECHO_MARGIN = 2;
  start() {
    this.timer = setInterval(() => this.tick(this.meter.level()), EnergyVad.STEP_MS);
  }
  /** How loud the bot's own voice comes back per unit of output (null: not learned yet). */
  echoRatio(): number | null {
    if (this.echo.length < EnergyVad.ECHO_LEARN) return null;
    const sorted = [...this.echo].sort((a, b) => a - b);
    return sorted[Math.floor((sorted.length - 1) * EnergyVad.ECHO_PERCENTILE)];
  }
  /**
   * Barge mode: the level a step must exceed to be you and not the bot's echo (0 = no gate), or Infinity while
   * the echo of the bot audio that just started is still being measured.
   */
  private echoGate(v: number): number {
    const out = this.barge ? (this.o.echoRef?.() ?? null) : null;
    if (out === null || !(out > EnergyVad.ECHO_MIN_OUT)) return 0;
    this.echo.push(Math.min(50, v / out));
    if (this.echo.length > EnergyVad.ECHO_WINDOW) this.echo.shift();
    const ratio = this.echoRatio();
    return ratio === null ? Infinity : ratio * out * EnergyVad.ECHO_MARGIN;
  }
  /** One 50 ms step with the current input level (called by the timer; tests call it directly). */
  tick(v: number) {
    const step = EnergyVad.STEP_MS;
    this.o.onLevel?.(v);
    if (this.paused) return;
    if (this.samples < 12) {
      this.floor = (this.floor * this.samples + v) / (this.samples + 1);
      this.samples++;
      return;
    }
    // (the gate also learns from quiet steps: it must see every step, not only the loud ones)
    const gate = this.echoGate(v);
    const isLoud = v > this.threshold && v > gate;
    if (this.barge && !this.active) {
      this.recent.push(isLoud ? 1 : 0);
      if (this.recent.length > EnergyVad.BARGE_WINDOW) this.recent.shift();
    }
    if (isLoud) {
      this.loud += step;
      this.quiet = 0;
      const sure = this.barge ? this.recent.reduce((n, x) => n + x, 0) * step >= EnergyVad.BARGE_MIN_MS : this.loud >= (this.o.minSpeechMs ?? 200);
      if (!this.active && sure) {
        this.active = true;
        this.recent = [];
        this.o.onStart();
      }
    } else {
      this.quiet += step;
      if (!this.active) {
        this.loud = Math.max(0, this.loud - step);
        if (!this.barge) this.floor = this.floor * 0.98 + v * 0.02; // slowly follow room noise
      } else if (this.quiet >= (this.o.silenceMs ?? 900)) {
        this.active = false;
        this.loud = 0;
        this.o.onEnd();
      }
    }
  }
  reset() {
    this.active = false;
    this.loud = 0;
    this.quiet = 0;
    this.recent = [];
    this.echo = [];
  }
  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}
