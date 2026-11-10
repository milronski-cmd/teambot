import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, User } from '../../core/types.js';
import { newId } from '../../core/db.js';
import { safeEnv } from '../../tools/builtin/shell.js';
import { SCREEN_PS1 } from './screen.ps1.js';
import { driverPolicy, grantCovers, pickMonitor, planShot, RateWindow, userMovedMouse, type DriverPolicy, type HostLevel, type Monitor, type ShotGeometry, type TaskGrant } from './screen-policy.js';
import type { ComputerConfig, ComputerService } from './service.js';

/**
 * Full-screen computer use on the owner's Windows desktop: the persistent screen driver plus everything around it
 * that is shared by tools, routes and the desktop shell - task grants, the live screen stream, approval previews,
 * "the owner moved the mouse" detection, the global emergency stop and the state for the on-screen indicator.
 */

export interface ScreenDriver {
  call(action: string, input: Record<string, any>, timeoutMs?: number): Promise<any>;
  /** Abort everything in flight right now (emergency stop): kills the helper process. */
  kill(): void;
}

/** JSON with every non-ASCII character escaped, so the helper never depends on console code pages. */
export function asciiJson(v: unknown): string {
  return JSON.stringify(v).replace(/[\u007f-￿]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0'));
}

type Waiting = { resolve: (v: any) => void; reject: (e: Error) => void; timer: NodeJS.Timeout };

/** One long-lived powershell.exe (see screen.ps1.ts); requests are serialised, a timeout or kill restarts it. */
export class PersistentScreenDriver implements ScreenDriver {
  private child: ChildProcess | null = null;
  private ready: Promise<void> | null = null;
  private buf = '';
  private seq = 0;
  private waiting = new Map<number, Waiting>();
  private chain: Promise<unknown> = Promise.resolve();
  private idle: NodeJS.Timeout | null = null;
  private readonly script: string;
  private readonly dll: string;

  constructor(dir: string, private idleMs = 10 * 60_000) {
    fs.mkdirSync(dir, { recursive: true });
    this.script = path.join(dir, 'teambot-screen.ps1');
    const hash = crypto.createHash('sha256').update(SCREEN_PS1).digest('hex').slice(0, 12);
    this.dll = path.join(dir, `teambot-screen-${hash}.dll`);
    const want = '﻿' + SCREEN_PS1;
    const cur = fs.existsSync(this.script) ? fs.readFileSync(this.script, 'utf8') : '';
    if (cur !== want) fs.writeFileSync(this.script, want, 'utf8');
    try {
      for (const f of fs.readdirSync(dir)) if (/^teambot-screen-[0-9a-f]{12}\.dll$/.test(f) && path.join(dir, f) !== this.dll) fs.rmSync(path.join(dir, f), { force: true });
    } catch {
      /* a loaded old assembly may still be locked; it is removed next time */
    }
  }

  private fail(e: Error) {
    for (const [, w] of this.waiting) {
      clearTimeout(w.timer);
      w.reject(e);
    }
    this.waiting.clear();
  }

  private start(): Promise<void> {
    if (this.ready) return this.ready;
    const p = new Promise<void>((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script], {
        windowsHide: true,
        env: { ...safeEnv(), TB_SCREEN_DLL: this.dll },
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      this.child = child;
      this.buf = '';
      let err = '';
      const timer = setTimeout(() => {
        reject(new Error('De schermhulp startte niet op tijd'));
        child.kill();
      }, 60_000);
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (s: string) => {
        this.buf += s;
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).replace(/^﻿/, '').trim();
          this.buf = this.buf.slice(i + 1);
          if (!line) continue;
          let j: any;
          try {
            j = JSON.parse(line);
          } catch {
            continue;
          }
          if (j?.ready) {
            clearTimeout(timer);
            resolve();
            continue;
          }
          const w = this.waiting.get(Number(j?.id));
          if (!w) continue;
          this.waiting.delete(Number(j.id));
          clearTimeout(w.timer);
          if (j.error) w.reject(new Error(String(j.error)));
          else w.resolve(j);
        }
      });
      child.stderr!.on('data', (b: Buffer) => (err = (err + b.toString('utf8')).slice(-3000)));
      const gone = (e: Error) => {
        clearTimeout(timer);
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
        reject(e);
        this.fail(e);
      };
      child.on('error', (e) => gone(e));
      child.on('close', () => gone(new Error('De schermhulp is gestopt' + (err.trim() ? `: ${err.trim().split('\n').slice(-3).join(' ').slice(0, 300)}` : ''))));
    });
    p.catch(() => {});
    this.ready = p;
    return p;
  }

  private touch() {
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => this.kill(), this.idleMs);
    this.idle.unref?.();
  }

  call(action: string, input: Record<string, any>, timeoutMs = 20_000): Promise<any> {
    if (process.platform !== 'win32') return Promise.reject(new Error('Bureaubladbediening werkt alleen op Windows'));
    const run = async () => {
      await this.start();
      const child = this.child;
      if (!child?.stdin || child.stdin.destroyed) throw new Error('De schermhulp draait niet');
      const id = ++this.seq;
      return new Promise<any>((resolve, reject) => {
        const timer = setTimeout(() => {
          this.waiting.delete(id);
          reject(new Error('Bureaubladactie duurde te lang; de schermhulp wordt opnieuw gestart'));
          child.kill();
        }, timeoutMs);
        this.waiting.set(id, { resolve, reject, timer });
        child.stdin!.write(asciiJson({ ...input, action, id }) + '\n');
      });
    };
    const p = this.chain.then(run, run);
    this.chain = p.catch(() => {});
    this.touch();
    return p;
  }

  kill() {
    const c = this.child;
    this.child = null;
    this.ready = null;
    this.fail(new Error('Gestopt (noodstop)'));
    try {
      c?.kill();
    } catch {
      /* already gone */
    }
  }
}

// ---------------- control service ----------------

export interface DesktopState {
  /** a bot holds the desktop right now */
  active: boolean;
  /** the owner holds the desktop (took over / paused / moved the mouse) */
  paused: boolean;
  agentId: string | null;
  agentName: string | null;
  controller: { kind: 'bot' | 'user'; name: string } | null;
  waiting: string[];
  /** screen area of the monitor the bot works on (physical pixels) */
  monitor: { x: number; y: number; w: number; h: number } | null;
  level: HostLevel | null;
  lastAction: string | null;
  lastActionAt: string | null;
  /** agents whose desktop control is paused by an emergency stop */
  stopped: string[];
  hotkey: string | null;
}

interface Preview {
  agentId: string;
  file: string;
  meta: any;
  at: number;
}

const PREVIEW_TTL_MS = 30 * 60_000;
const STREAM_INTERVAL_MS = 1000;
const RESOURCE = 'desktop:host';

export class ScreenControl {
  driver: ScreenDriver;
  /** Global emergency-stop hotkey as registered by the desktop shell (null in server mode). */
  hotkey: string | null = null;
  private mons: { at: number; list: Monitor[] } | null = null;
  private grants = new Map<string, TaskGrant>();
  private cursor = new Map<string, { x: number; y: number; at: number }>();
  private rates = new Map<string, RateWindow>();
  private previews = new Map<string, Preview>();
  private viewers = new Map<string, Set<(jpeg: Buffer) => void>>();
  private loops = new Map<string, NodeJS.Timeout>();
  private latest = new Map<string, { buf: Buffer; at: number }>();
  private listeners = new Set<(s: DesktopState) => void>();
  private last: { agentId: string; agentName: string; summary: string; at: number; monitor: Monitor | null } | null = null;
  private stateTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private ctx: Ctx,
    private svc: ComputerService,
    driver?: ScreenDriver,
  ) {
    this.driver = driver || new PersistentScreenDriver(path.join(svc.base, 'host'));
    svc.leases.onChange((resource) => {
      if (resource === RESOURCE) this.emitState();
    });
  }

  // ---------- geometry ----------

  async monitors(refresh = false): Promise<Monitor[]> {
    if (!refresh && this.mons && Date.now() - this.mons.at < 15_000) return this.mons.list;
    const r = await this.driver.call('monitors', {});
    const list: Monitor[] = (r.monitors || []).map((m: any, i: number) => ({ index: Number(m.index ?? i), x: Number(m.x), y: Number(m.y), w: Number(m.w), h: Number(m.h), primary: !!m.primary, dpi: Number(m.dpi) || 96 }));
    this.mons = { at: Date.now(), list };
    return list;
  }

  async monitor(cfg: ComputerConfig, index?: number): Promise<Monitor> {
    const list = await this.monitors();
    return pickMonitor(list, index ?? cfg.host_options.monitor ?? 0);
  }

  /** The screenshot space the bot's coordinates refer to: deterministic per monitor (no hidden state). */
  async geometry(cfg: ComputerConfig, index?: number): Promise<{ geom: ShotGeometry; mon: Monitor }> {
    const mon = await this.monitor(cfg, index);
    return { geom: planShot(mon, { monitor: mon.index }), mon };
  }

  policy(cfg: ComputerConfig): DriverPolicy {
    return driverPolicy(cfg.host_apps, cfg.host_options);
  }

  tmpFile(ext = '.jpg') {
    return path.join(this.svc.base, 'tmp', newId('scr_') + ext);
  }

  /** Capture an area as the bot may see it (masked in the driver), scaled to the shot size. */
  async capture(cfg: ComputerConfig, g: ShotGeometry, o: { file?: string; quality?: number; marks?: number[][]; fast?: boolean } = {}): Promise<{ file: string; meta: any }> {
    const file = o.file || this.tmpFile();
    const meta = await this.driver.call('shot', { area: { x: g.x, y: g.y, w: g.w, h: g.h }, outW: g.shotW, outH: g.shotH, out: file, quality: o.quality ?? 80, marks: o.marks || [], fast: !!o.fast, policy: this.policy(cfg) }, 25_000);
    return { file, meta };
  }

  // ---------- task grants ----------

  grant(agentId: string): TaskGrant | null {
    const g = this.grants.get(agentId);
    if (!g) return null;
    if (Date.now() >= g.until || g.actions >= g.maxActions) {
      this.grants.delete(agentId);
      return null;
    }
    return g;
  }

  covers(agentId: string, threadId: string, app: string): boolean {
    return grantCovers(this.grant(agentId), { agentId, threadId, app, now: Date.now() });
  }

  useGrant(agentId: string) {
    const g = this.grant(agentId);
    if (g) g.actions++;
  }

  createGrant(agent: Agent, threadId: string, o: { goal: string; apps: string[]; minutes: number; by: string }): TaskGrant {
    const g: TaskGrant = {
      id: newId('dg_'),
      agentId: agent.id,
      threadId,
      goal: o.goal.slice(0, 300),
      apps: o.apps,
      createdAt: Date.now(),
      until: Date.now() + o.minutes * 60_000,
      actions: 0,
      maxActions: 500,
      by: o.by,
    };
    this.grants.set(agent.id, g);
    this.ctx.audit(agent.user_id, 'desktop.grant', { goal: g.goal, apps: g.apps, minutes: o.minutes }, agent.id);
    this.svc.logAction(agent.user_id, agent.id, { actor: 'user', tool: 'desktop_grant', summary: `Toestemming voor deze taak (${o.minutes} min): ${g.goal || 'bureaublad bedienen'}`, status: 'done', threadId });
    this.ctx.events.emit(agent.user_id, 'computer.status', this.svc.statusOf(agent));
    return g;
  }

  revokeGrant(agentId: string, reason: string) {
    const g = this.grants.get(agentId);
    if (!g) return false;
    this.grants.delete(agentId);
    const a = this.ctx.store.agent(agentId);
    if (a) {
      this.svc.logAction(a.user_id, a.id, { actor: 'system', tool: 'desktop_grant', summary: `Taaktoestemming ingetrokken: ${reason}`, status: 'done' });
      this.ctx.events.emit(a.user_id, 'computer.status', this.svc.statusOf(a));
    }
    return true;
  }

  // ---------- pacing + "the owner moved the mouse" ----------

  /** ms to wait before the next mutating action (actions-per-minute safety valve). */
  rateWait(agentId: string, max: number): number {
    let r = this.rates.get(agentId);
    if (!r) this.rates.set(agentId, (r = new RateWindow(max)));
    r.setMax(max);
    return r.waitMs(Date.now());
  }

  noteAction(agent: Agent, summary: string, cursor: { x: number; y: number } | null, mon: Monitor | null) {
    const now = Date.now();
    if (cursor) this.cursor.set(agent.id, { x: cursor.x, y: cursor.y, at: now });
    this.rates.get(agent.id)?.record(now);
    this.last = { agentId: agent.id, agentName: agent.name, summary: summary.slice(0, 200), at: now, monitor: mon };
    this.emitState();
  }

  userMoved(agentId: string, current: { x: number; y: number } | null | undefined): boolean {
    const last = this.cursor.get(agentId);
    return userMovedMouse({ last: last || null, lastAt: last?.at || 0, now: Date.now(), current: current || null });
  }

  /** The owner touched the mouse while the bot was working: the owner gets control, the bot waits. */
  pauseForUser(agent: Agent, why: string) {
    const owner = this.ctx.store.user(agent.user_id);
    if (!owner) return;
    this.cursor.delete(agent.id);
    try {
      this.svc.takeControl(owner, RESOURCE, { sticky: true });
    } catch {
      /* someone else already holds it */
    }
    this.svc.logAction(owner.id, agent.id, { actor: 'user', actorName: owner.name, tool: 'takeover', summary: why, status: 'done' });
    this.ctx.events.emit(owner.id, 'notification', { title: `${agent.name} is gepauzeerd`, body: `${why} Geef de bediening terug in TeamBot (Computer) als de bot verder mag.`, link: '#/m/browser', kind: 'computer' });
    this.emitState();
  }

  // ---------- emergency stop ----------

  /** Stop all computer use on this desktop right now: kill in-flight input, cancel the runs involved, pause host control. */
  stopAll(u: User, source: string) {
    this.driver.kill();
    const holders = new Set<string>();
    const l = this.svc.leases.current(RESOURCE);
    if (l?.holder.kind === 'bot') holders.add(l.holder.id);
    for (const h of this.svc.leases.waiting(RESOURCE)) if (h.kind === 'bot') holders.add(h.id);
    let cancelled = 0;
    const agents = new Set<string>();
    for (const runId of holders) {
      const run = this.ctx.store.run(runId);
      if (run?.agent_id) agents.add(run.agent_id);
      if (this.ctx.runs.cancel(runId, `Noodstop (${source})`)) cancelled++;
      this.svc.leases.releaseHolder(runId);
    }
    for (const a of this.ctx.store.agents(u.id)) {
      const cfg = this.svc.config(a);
      if (!cfg.host_control) continue;
      this.svc.hostStopped.add(a.id);
      this.grants.delete(a.id);
      agents.add(a.id);
    }
    for (const id of agents) {
      const a = this.ctx.store.agent(id);
      if (!a) continue;
      this.svc.logAction(u.id, a.id, { actor: 'user', actorName: u.name, tool: 'stop', summary: `Noodstop bureaublad (${source}): bediening direct gestopt en gepauzeerd tot je hervat`, status: 'done' });
      this.ctx.events.emit(u.id, 'computer.status', this.svc.statusOf(a));
    }
    this.cursor.clear();
    this.ctx.audit(u.id, 'computer.desktop_stop', { source, cancelled, agents: agents.size });
    this.emitState();
    return { cancelled, agents: agents.size };
  }

  resumeAll(u: User) {
    let n = 0;
    for (const a of this.ctx.store.agents(u.id)) if (this.svc.hostStopped.delete(a.id)) n++;
    this.ctx.audit(u.id, 'computer.host_resumed', { all: true, n });
    this.emitState();
    return { resumed: n };
  }

  // ---------- previews for approvals ----------

  savePreview(callId: string, agentId: string, file: string, meta: any) {
    for (const [k, p] of this.previews) {
      if (Date.now() - p.at > PREVIEW_TTL_MS) {
        fs.rmSync(p.file, { force: true });
        this.previews.delete(k);
      }
    }
    const old = this.previews.get(callId);
    if (old && old.file !== file) fs.rmSync(old.file, { force: true });
    this.previews.set(callId, { agentId, file, meta, at: Date.now() });
  }

  preview(callId: string, agentId: string): Preview | null {
    const p = this.previews.get(callId);
    if (!p || p.agentId !== agentId || Date.now() - p.at > PREVIEW_TTL_MS || !fs.existsSync(p.file)) return null;
    return p;
  }

  // ---------- live stream ----------

  pushFrame(agentId: string, buf: Buffer) {
    this.latest.set(agentId, { buf, at: Date.now() });
    for (const fn of this.viewers.get(agentId) || []) {
      try {
        fn(buf);
      } catch {
        /* viewer gone */
      }
    }
  }

  latestFrame(agentId: string): Buffer | null {
    return this.latest.get(agentId)?.buf || null;
  }

  viewerCount(agentId: string) {
    return this.viewers.get(agentId)?.size || 0;
  }

  /** One fresh, masked, fast frame of the bot's monitor (for viewers; never shown to the bot). */
  async frame(agent: Agent): Promise<Buffer | null> {
    const cfg = this.svc.config(agent);
    if (!cfg.host_control || process.platform !== 'win32') return this.latestFrame(agent.id);
    const mon = await this.monitor(cfg);
    const g = planShot(mon, { maxW: 1280, maxH: 1280, maxPixels: 1_000_000 });
    const { file } = await this.capture(cfg, g, { quality: 60, fast: true });
    try {
      const buf = fs.readFileSync(file);
      this.pushFrame(agent.id, buf);
      return buf;
    } finally {
      fs.rmSync(file, { force: true });
    }
  }

  subscribe(agent: Agent, fn: (jpeg: Buffer) => void): () => void {
    let set = this.viewers.get(agent.id);
    if (!set) this.viewers.set(agent.id, (set = new Set()));
    set.add(fn);
    const cached = this.latestFrame(agent.id);
    if (cached) fn(cached);
    if (!this.loops.has(agent.id)) {
      let busy = false;
      const tick = async () => {
        if (busy) return;
        busy = true;
        try {
          const a = this.ctx.store.agent(agent.id);
          if (a) await this.frame(a);
        } catch {
          /* desktop locked or helper restarting: try again next tick */
        } finally {
          busy = false;
        }
      };
      tick();
      const t = setInterval(tick, STREAM_INTERVAL_MS);
      t.unref?.();
      this.loops.set(agent.id, t);
    }
    return () => {
      set!.delete(fn);
      if (!set!.size) {
        this.viewers.delete(agent.id);
        const t = this.loops.get(agent.id);
        if (t) clearInterval(t);
        this.loops.delete(agent.id);
      }
    };
  }

  // ---------- indicator state ----------

  state(): DesktopState {
    const l = this.svc.leases.current(RESOURCE);
    const waiting = this.svc.leases.waiting(RESOURCE);
    const botHolder = l?.holder.kind === 'bot' ? l.holder : waiting.find((h) => h.kind === 'bot') || null;
    const agentId = botHolder?.agentId || (l?.holder.kind === 'user' && this.last && Date.now() - this.last.at < 10 * 60_000 ? this.last.agentId : null);
    const agent = agentId ? this.ctx.store.agent(agentId) : null;
    const cfg = agent ? this.svc.config(agent) : null;
    const mon = this.last?.agentId === agentId ? this.last?.monitor : null;
    const stopped = [...this.svc.hostStopped];
    return {
      active: l?.holder.kind === 'bot',
      paused: l?.holder.kind === 'user' && !!agentId,
      agentId: agent?.id || null,
      agentName: agent?.name || null,
      controller: l ? { kind: l.holder.kind, name: l.holder.name } : null,
      waiting: waiting.map((h) => h.name),
      monitor: (() => {
        // the monitor of the bot's last action, else the one configured for it, else the primary one
        const m = mon || (cfg ? this.mons?.list.find((x) => x.index === cfg.host_options.monitor) : null) || this.mons?.list[0] || null;
        return m ? { x: m.x, y: m.y, w: m.w, h: m.h } : null;
      })(),
      level: cfg?.host_level || null,
      lastAction: this.last?.agentId === agentId ? this.last?.summary || null : null,
      lastActionAt: this.last?.agentId === agentId && this.last ? new Date(this.last.at).toISOString() : null,
      stopped,
      hotkey: this.hotkey,
    };
  }

  onState(fn: (s: DesktopState) => void): () => void {
    this.listeners.add(fn);
    try {
      fn(this.state());
    } catch {
      /* listener error */
    }
    return () => this.listeners.delete(fn);
  }

  emitState() {
    // coalesce bursts (lease changes + action notes) into one update
    if (this.stateTimer || this.stopped) return;
    this.stateTimer = setTimeout(() => {
      this.stateTimer = null;
      if (this.stopped) return;
      let s: DesktopState;
      try {
        s = this.state();
      } catch {
        return;
      }
      for (const fn of this.listeners) {
        try {
          fn(s);
        } catch {
          /* ignore */
        }
      }
      try {
        const owner = this.ctx.auth?.owner?.();
        if (owner) this.ctx.events.emit(owner.id, 'computer.desktop', s);
      } catch {
        /* shutting down */
      }
    }, 30);
    this.stateTimer.unref?.();
  }

  stop() {
    this.stopped = true;
    for (const t of this.loops.values()) clearInterval(t);
    this.loops.clear();
    this.viewers.clear();
    if (this.stateTimer) clearTimeout(this.stateTimer);
    this.stateTimer = null;
    this.driver.kill();
    for (const p of this.previews.values()) fs.rmSync(p.file, { force: true });
    this.previews.clear();
  }
}
