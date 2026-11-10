import fs from 'node:fs';
import path from 'node:path';
import { monitorEventLoopDelay, performance, type EventLoopUtilization, type ELDHistogram } from 'node:perf_hooks';

/**
 * The stall meter (0.4.3, parity 17.1): how responsive the TeamBot server is, measured cheaply inside the process.
 *
 * - Event-loop delay: `perf_hooks.monitorEventLoopDelay` (Node's own native histogram, a timer every 20 ms). A timer
 *   never fires exactly on time — on Windows the clock ticks every ~15.6 ms, so a 20 ms timer comes every ~31 ms — so
 *   the delay is reported above the best interval of the window (its minimum): an idle loop shows ~0–1 ms, not 11 ms.
 * - Stalls: a 50 ms heartbeat timer. When a beat comes more than 100 ms (or 1 s) late, the loop was blocked that long:
 *   nothing else (a chat answer, a click, a routine) could run meanwhile. Measured to within one beat (~50–60 ms).
 *   A very long gap without CPU use (≥ 30 s, less than 10 % CPU) is the computer sleeping or the process being
 *   paused, not TeamBot blocking: counted as a pause, never as a stall.
 * - Once a minute a sample: the delay percentiles, the stalls, how busy the loop was (event-loop utilisation), CPU,
 *   memory (RSS, heap), open handles (`process.getActiveResourcesInfo`) and active runs. Samples are kept in memory and
 *   appended to `<data>/health/samples.jsonl`, compacted to the last `maxSamples` (two days), so the file stays small.
 *
 * Nothing leaves the computer: the numbers are shown in Instellingen and go into the diagnostics file only when the
 * owner downloads it.
 */

export interface HealthSample {
  /** End of the window (ISO). */
  at: string;
  /** Start of this server process (ISO): samples of an earlier run of TeamBot have another `boot`. */
  boot: string;
  /** Seconds this sample covers. */
  windowS: number;
  /** Event-loop delay above the best interval of the window, in ms. */
  loop: { p50: number; p99: number; max: number };
  /** Blocks longer than 100 ms and 1 s, the longest one and their total, in this window. */
  stalls: { over100ms: number; over1s: number; longestMs: number; totalMs: number };
  /** Computer asleep or process paused (long gap without CPU use) in this window. */
  pauses: number;
  /** Event-loop utilisation 0..1 (share of the time the loop was working, not waiting). */
  busy: number;
  /** CPU of this process as % of one core. */
  cpu: number;
  mem: { rssMb: number; heapUsedMb: number; heapTotalMb: number; externalMb: number };
  /** Active libuv handles and requests (sockets, timers, files being read …). */
  handles: number;
  /** The most common kinds of handles (at most five). */
  handleKinds: Record<string, number>;
  /** Runs queued, running or waiting for an answer. */
  runs: number;
}

export interface StallEvent {
  /** When the block ended (ISO). */
  at: string;
  ms: number;
}

export interface MeterTotals {
  startedAt: string;
  stalls100: number;
  stalls1s: number;
  longestMs: number;
  totalStallMs: number;
  pauses: number;
  peakRssMb: number;
  maxLoopMs: number;
}

export interface MeterOptions {
  /** One sample per window (default 60 s). */
  sampleMs?: number;
  /** Heartbeat for stall detection (default 50 ms). */
  heartbeatMs?: number;
  /** Timer of the native delay histogram (default 20 ms). */
  resolutionMs?: number;
  /** Where the history is kept (JSON lines); null = in memory only. */
  file?: string | null;
  /** Samples kept (default 2880 = two days at one a minute). */
  maxSamples?: number;
  /** Active runs right now (cheap: a COUNT on an indexed column). */
  activeRuns?: () => number;
  /** A gap at least this long with hardly any CPU use counts as a pause, not a stall (default 30 s; tests use less). */
  pauseMs?: number;
}

export const STALL_MS = 100;
export const LONG_STALL_MS = 1000;
/** A gap this long with hardly any CPU use is the computer sleeping (or the process paused), not a block. */
const PAUSE_MS = 30_000;
const STALL_EVENTS_KEPT = 500;

const MB = 1024 * 1024;
const r1 = (n: number) => Math.round(n * 10) / 10;
const toMs = (ns: number) => (Number.isFinite(ns) ? ns / 1e6 : 0);

export class StallMeter {
  readonly sampleMs: number;
  readonly heartbeatMs: number;
  readonly resolutionMs: number;
  readonly maxSamples: number;
  private file: string | null;
  private activeRuns: () => number;
  private pauseMs: number;
  private hist: ELDHistogram | null = null;
  private beat: NodeJS.Timeout | null = null;
  private tick: NodeJS.Timeout | null = null;
  private samples: HealthSample[] = [];
  private stallEvents: StallEvent[] = [];
  private boot = new Date().toISOString();
  private totals: MeterTotals = { startedAt: this.boot, stalls100: 0, stalls1s: 0, longestMs: 0, totalStallMs: 0, pauses: 0, peakRssMb: 0, maxLoopMs: 0 };
  // The open window.
  private win = { start: 0, over100ms: 0, over1s: 0, longestMs: 0, totalMs: 0, pauses: 0 };
  private elu: EventLoopUtilization | null = null;
  private cpu: NodeJS.CpuUsage | null = null;
  private lastBeat = 0;
  private lastBeatCpu = 0;
  private appendedSinceCompact = 0;
  private writing: Promise<void> = Promise.resolve();

  constructor(o: MeterOptions = {}) {
    this.sampleMs = Math.max(20, o.sampleMs ?? 60_000);
    this.heartbeatMs = Math.max(5, o.heartbeatMs ?? 50);
    this.resolutionMs = Math.max(1, o.resolutionMs ?? 20);
    this.maxSamples = Math.max(10, o.maxSamples ?? 2880);
    this.file = o.file ?? null;
    this.activeRuns = o.activeRuns ?? (() => 0);
    this.pauseMs = Math.max(STALL_MS * 2, o.pauseMs ?? PAUSE_MS);
  }

  get running(): boolean {
    return !!this.tick;
  }

  start() {
    if (this.tick) return;
    this.boot = new Date().toISOString();
    this.totals = { ...this.totals, startedAt: this.boot };
    this.load();
    this.hist = monitorEventLoopDelay({ resolution: this.resolutionMs });
    this.hist.enable();
    this.openWindow();
    this.lastBeat = performance.now();
    this.lastBeatCpu = cpuMs(process.cpuUsage());
    this.beat = setInterval(() => this.onBeat(), this.heartbeatMs);
    this.beat.unref?.();
    this.tick = setInterval(() => this.sample(), this.sampleMs);
    this.tick.unref?.();
  }

  /** Stop measuring; waits for the history file to be written. */
  async stop() {
    if (this.beat) clearInterval(this.beat);
    if (this.tick) clearInterval(this.tick);
    this.beat = this.tick = null;
    this.hist?.disable();
    this.hist = null;
    await this.writing;
  }

  private openWindow() {
    this.win = { start: performance.now(), over100ms: 0, over1s: 0, longestMs: 0, totalMs: 0, pauses: 0 };
    this.elu = performance.eventLoopUtilization();
    this.cpu = process.cpuUsage();
    this.hist?.reset();
  }

  private onBeat() {
    const t = performance.now();
    const late = t - this.lastBeat - this.heartbeatMs;
    const cpuNow = cpuMs(process.cpuUsage());
    const cpuUsed = cpuNow - this.lastBeatCpu;
    this.lastBeat = t;
    this.lastBeatCpu = cpuNow;
    if (late < STALL_MS) return;
    if (late >= this.pauseMs && cpuUsed < late * 0.1) {
      // The computer slept or the process was paused: not a stall. The delay histogram saw the same gap; start it again
      // once its own timer has fired after the pause.
      this.win.pauses++;
      this.totals.pauses++;
      const h = this.hist;
      setTimeout(() => h === this.hist && h?.reset(), this.resolutionMs * 3).unref?.();
      return;
    }
    this.recordStall(late);
  }

  /** A block of `ms` that just ended (also used by tests). */
  recordStall(ms: number) {
    const w = this.win;
    w.over100ms++;
    this.totals.stalls100++;
    if (ms >= LONG_STALL_MS) {
      w.over1s++;
      this.totals.stalls1s++;
    }
    w.longestMs = Math.max(w.longestMs, ms);
    w.totalMs += ms;
    this.totals.longestMs = Math.max(this.totals.longestMs, ms);
    this.totals.totalStallMs += ms;
    this.stallEvents.push({ at: new Date().toISOString(), ms: Math.round(ms) });
    if (this.stallEvents.length > STALL_EVENTS_KEPT) this.stallEvents.splice(0, this.stallEvents.length - STALL_EVENTS_KEPT);
  }

  /** The open window so far, without closing it ("now"). */
  live(): HealthSample {
    return this.read(false);
  }

  /** Close the window: keep the sample, write it to the history file and open the next window. */
  sample(): HealthSample {
    const s = this.read(true);
    this.samples.push(s);
    if (this.samples.length > this.maxSamples) this.samples.splice(0, this.samples.length - this.maxSamples);
    this.persist(s);
    this.openWindow();
    return s;
  }

  private read(closing: boolean): HealthSample {
    const h = this.hist;
    const base = h && h.count > 0 ? toMs(h.min) : 0;
    const over = (v: number) => (h && h.count > 0 ? Math.max(0, toMs(v) - base) : 0);
    const loop = { p50: r1(over(h?.percentile(50) ?? 0)), p99: r1(over(h?.percentile(99) ?? 0)), max: r1(Math.max(over(h?.max ?? 0), this.win.longestMs)) };
    const elapsed = Math.max(1, performance.now() - this.win.start);
    const elu = this.elu ? performance.eventLoopUtilization(this.elu) : null;
    const cpu = this.cpu ? process.cpuUsage(this.cpu) : null;
    const m = process.memoryUsage();
    const kinds: Record<string, number> = {};
    let handles = 0;
    try {
      for (const k of process.getActiveResourcesInfo()) {
        handles++;
        kinds[k] = (kinds[k] || 0) + 1;
      }
    } catch {
      /* not available on this Node */
    }
    let runs = 0;
    try {
      runs = this.activeRuns();
    } catch {
      /* database closing */
    }
    const s: HealthSample = {
      at: new Date().toISOString(),
      boot: this.boot,
      windowS: r1(elapsed / 1000),
      loop,
      stalls: { over100ms: this.win.over100ms, over1s: this.win.over1s, longestMs: Math.round(this.win.longestMs), totalMs: Math.round(this.win.totalMs) },
      pauses: this.win.pauses,
      busy: elu ? Math.round(elu.utilization * 1000) / 1000 : 0,
      cpu: cpu ? r1(((cpu.user + cpu.system) / 1000 / elapsed) * 100) : 0,
      mem: { rssMb: r1(m.rss / MB), heapUsedMb: r1(m.heapUsed / MB), heapTotalMb: r1(m.heapTotal / MB), externalMb: r1(m.external / MB) },
      handles,
      handleKinds: Object.fromEntries(
        Object.entries(kinds)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 5),
      ),
      runs,
    };
    if (closing) {
      this.totals.peakRssMb = Math.max(this.totals.peakRssMb, s.mem.rssMb);
      this.totals.maxLoopMs = Math.max(this.totals.maxLoopMs, s.loop.max);
    }
    return s;
  }

  /** Samples after `afterIso` (all when omitted), oldest first. */
  history(afterIso?: string): HealthSample[] {
    return afterIso ? this.samples.filter((s) => s.at > afterIso) : [...this.samples];
  }

  /** Stalls of this process since it started (the last 500), oldest first. */
  stalls(afterIso?: string): StallEvent[] {
    return afterIso ? this.stallEvents.filter((e) => e.at > afterIso) : [...this.stallEvents];
  }

  sinceStart(): MeterTotals {
    const live = this.live();
    return { ...this.totals, peakRssMb: Math.max(this.totals.peakRssMb, live.mem.rssMb), maxLoopMs: Math.max(this.totals.maxLoopMs, live.loop.max) };
  }

  // ---------------------------------------------------------------- history file

  private load() {
    if (!this.file || this.samples.length) return;
    try {
      const st = fs.statSync(this.file);
      // Never read an unexpectedly large file whole: the tail holds the newest samples.
      const len = Math.min(st.size, 4 * MB);
      const fd = fs.openSync(this.file, 'r');
      const buf = Buffer.alloc(len);
      fs.readSync(fd, buf, 0, len, st.size - len);
      fs.closeSync(fd);
      const out: HealthSample[] = [];
      for (const line of buf.toString('utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const s = JSON.parse(line);
          if (s && typeof s.at === 'string' && s.loop && s.mem) out.push(s);
        } catch {
          /* a line cut off by the tail read or a crash */
        }
      }
      this.samples = out.slice(-this.maxSamples);
      this.appendedSinceCompact = out.length;
    } catch {
      /* no history yet */
    }
  }

  private persist(s: HealthSample) {
    const file = this.file;
    if (!file) return;
    this.appendedSinceCompact++;
    const compact = this.appendedSinceCompact > this.maxSamples * 1.25;
    if (compact) this.appendedSinceCompact = this.samples.length;
    const keep = compact ? this.samples.map((x) => JSON.stringify(x)).join('\n') + '\n' : '';
    this.writing = this.writing.then(async () => {
      try {
        await fs.promises.mkdir(path.dirname(file), { recursive: true });
        if (compact) {
          const tmp = `${file}.tmp`;
          await fs.promises.writeFile(tmp, keep);
          await fs.promises.rename(tmp, file);
        } else {
          await fs.promises.appendFile(file, JSON.stringify(s) + '\n');
        }
      } catch {
        /* the data folder is read-only or gone: the meter keeps working in memory */
      }
    });
  }
}

function cpuMs(u: NodeJS.CpuUsage): number {
  return (u.user + u.system) / 1000;
}
