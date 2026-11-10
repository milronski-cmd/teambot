import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Ctx, User } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { newId, now } from '../../core/db.js';
import { PersistentScreenDriver, type ScreenDriver } from '../browser/screen.js';
import type { Monitor } from '../browser/screen-policy.js';
import { cleanSettings, cursorOn, DEFAULT_SETTINGS, driverCall, frameGeometry, frameQuality, ownerPolicy, parseInput, type EndReason, type RemoteSettings } from './core.js';
import type { IndicatorSession } from './indicator.js';

/**
 * "Bureaublad op afstand": the owner sees and controls the whole Windows desktop from the paired phone or a browser on
 * another PC. Built on what computer use already has — the persistent screen driver (screen.ps1.ts: capture, masking,
 * SendInput) in an own process, so a remote session never waits for a bot's screenshot — and plain HTTP: the viewer
 * asks for the next JPEG when it has shown the last one (so a slow connection gets fewer frames instead of a growing
 * delay), and sends taps and keys as small POSTs.
 *
 * Safety: off by default and only switched on at the computer itself; only the owner's own signed-in sessions; a
 * session belongs to the sign-in that started it; an indicator with a Stop button on the PC while anyone watches (no
 * indicator = no remote desktop); Stop at the computer ends every session and switches the feature off; a session
 * stops after the chosen minutes without input and when the viewer is gone; TeamBot's own windows are masked and
 * cannot receive remote input; every session is in the security log (start and end).
 */

export type DeviceKind = 'phone' | 'computer' | 'browser';

export interface RemoteSession {
  id: string;
  userId: string;
  /** The sign-in (auth session) that started it: only that one may use it. */
  authSessionId: string;
  deviceKind: DeviceKind;
  /** The name the owner gave the phone ('' for a browser). */
  deviceName: string;
  ip: string;
  /** Watch only (the viewer's own choice, or because the owner allows watching only). */
  view: boolean;
  monitor: number;
  startedAt: number;
  lastFrameAt: number;
  lastInputAt: number;
  /** Last input or "I am still here": the idle stop counts from here. */
  lastActiveAt: number;
  frames: number;
  inputs: number;
  bytes: number;
  inflight: number;
  inputTimes: number[];
  /** The bot that was paused when this session took over the mouse. */
  tookOverFrom: string | null;
}

export interface PublicSession {
  id: string;
  deviceKind: DeviceKind;
  deviceName: string;
  view: boolean;
  since: string;
  lastInputAt: string | null;
  controlling: boolean;
  mine: boolean;
}

export interface RemoteState extends RemoteSettings {
  available: boolean;
  /** Why it cannot be used here: 'platform' (not Windows) or 'app' (no TeamBot app with the on-screen Stop). */
  unavailable: 'platform' | 'app' | null;
  /** This request comes from the computer itself (only there it can be switched on). */
  here: boolean;
  sessions: PublicSession[];
}

export interface FrameResult {
  notModified: boolean;
  jpeg: Buffer | null;
  etag: string;
  width: number;
  height: number;
  cursor: { x: number; y: number } | null;
  idleLeftMs: number;
}

const GONE_MS = 60_000;
const ENDED_KEEP_MS = 15 * 60_000;
const CONTROLLING_MS = 20_000;
const MAX_SESSIONS = 3;
const MAX_INPUTS_PER_SEC = 40;
const SETTINGS_KEY = 'remoteDesktop';

const endText: Record<EndReason, string> = {
  ended: 'De sessie is beëindigd.',
  stopped_here: 'Gestopt op de computer. Bureaublad op afstand staat nu uit; zet het weer aan op de computer.',
  off: 'Bureaublad op afstand is uitgezet.',
  idle: 'Gestopt omdat er een tijd niets gebeurde.',
  gone: 'De verbinding was te lang weg.',
  unavailable: 'Bureaublad op afstand is op deze computer niet beschikbaar.',
  shutdown: 'TeamBot op de computer is gestopt.',
  signed_out: 'Je bent uitgelogd.',
};

export class RemoteDesktopService {
  private realDriver: ScreenDriver | null = null;
  private injected: ScreenDriver | null = null;
  private sessions = new Map<string, RemoteSession>();
  private ended = new Map<string, { reason: EndReason; at: number }>();
  private indicators = 0;
  private listeners = new Set<(s: { sessions: IndicatorSession[]; enabled: boolean }) => void>();
  private mons: { at: number; list: Monitor[] } | null = null;
  private emitTimer: NodeJS.Timeout | null = null;
  private killTimer: NodeJS.Timeout | null = null;
  private closed = false;
  readonly dir: string;
  /** Overridable for tests (the clock of idle / gone checks). */
  clock: () => number = () => Date.now();

  constructor(private ctx: Ctx) {
    this.dir = path.join(ctx.config.dataDir, 'remote-desktop');
    fs.mkdirSync(path.join(this.dir, 'tmp'), { recursive: true });
    // frames are deleted right after reading; leftovers of a crash never stay
    for (const f of fs.readdirSync(path.join(this.dir, 'tmp'))) fs.rmSync(path.join(this.dir, 'tmp', f), { force: true });
  }

  // ---------------------------------------------------------------- driver

  /** Tests and the e2e put a dry-run driver here (no real input reaches the desktop). */
  setDriver(d: ScreenDriver | null) {
    this.injected = d;
    this.mons = null;
  }

  get driver(): ScreenDriver {
    if (this.injected) return this.injected;
    if (!this.realDriver) this.realDriver = new PersistentScreenDriver(path.join(this.dir, 'driver'), 2 * 60_000);
    return this.realDriver;
  }

  private platformOk() {
    return !!this.injected || process.platform === 'win32';
  }

  // ---------------------------------------------------------------- settings + availability

  settings(): RemoteSettings {
    return cleanSettings(this.ctx.store.getSetting('', SETTINGS_KEY, DEFAULT_SETTINGS));
  }

  private save(s: RemoteSettings) {
    this.ctx.store.setSetting('', SETTINGS_KEY, s);
  }

  /** The desktop shell registers its on-screen indicator (with the Stop button); without it, nothing starts. */
  attachIndicator(): () => void {
    this.indicators++;
    this.emit();
    let done = false;
    return () => {
      if (done) return;
      done = true;
      this.indicators = Math.max(0, this.indicators - 1);
      if (!this.indicators) this.endAll('unavailable');
    };
  }

  unavailable(): 'platform' | 'app' | null {
    if (!this.platformOk()) return 'platform';
    if (!this.indicators) return 'app';
    return null;
  }

  state(o: { userId?: string; authSessionId?: string; here?: boolean } = {}): RemoteState {
    const s = this.settings();
    const un = this.unavailable();
    return {
      ...s,
      available: !un,
      unavailable: un,
      here: !!o.here,
      sessions: [...this.sessions.values()].filter((x) => !o.userId || x.userId === o.userId).map((x) => this.publicSession(x, o.authSessionId)),
    };
  }

  private publicSession(x: RemoteSession, authSessionId?: string): PublicSession {
    return {
      id: x.id,
      deviceKind: x.deviceKind,
      deviceName: x.deviceName,
      view: x.view,
      since: new Date(x.startedAt).toISOString(),
      lastInputAt: x.lastInputAt ? new Date(x.lastInputAt).toISOString() : null,
      controlling: this.controlling(x),
      mine: !!authSessionId && x.authSessionId === authSessionId,
    };
  }

  private controlling(x: RemoteSession) {
    return !!x.lastInputAt && this.clock() - x.lastInputAt < CONTROLLING_MS;
  }

  /** Switch on or off, or change the options (the route makes sure this only happens at the computer itself). */
  configure(u: User, body: any): RemoteSettings {
    const cur = this.settings();
    const next = cleanSettings(body, cur);
    if (next.enabled && !cur.enabled) {
      const un = this.unavailable();
      if (un === 'platform') throw new HttpError(409, 'Bureaublad op afstand werkt alleen op Windows.', 'remote_unavailable');
      if (un === 'app') throw new HttpError(409, 'Bureaublad op afstand werkt alleen in de TeamBot-app op deze computer: daar staat de stopknop op het scherm.', 'remote_unavailable');
    }
    next.changedAt = now();
    this.save(next);
    if (next.enabled && !cur.enabled) this.ctx.audit(u.id, 'remote_desktop.on', { control: next.control, idleMinutes: next.idleMinutes });
    else if (!next.enabled && cur.enabled) this.turnedOff(u.id, 'computer', 'off');
    else if (next.enabled && (next.control !== cur.control || next.idleMinutes !== cur.idleMinutes)) {
      this.ctx.audit(u.id, 'remote_desktop.options', { control: next.control, idleMinutes: next.idleMinutes });
      // watch-only from now on: every open session watches only
      if (!next.control) for (const x of this.sessions.values()) x.view = true;
    }
    this.emit();
    return next;
  }

  /** Switch off from anywhere the owner is signed in (the phone may switch it off, never on). */
  turnOff(u: User, source: string) {
    const cur = this.settings();
    if (cur.enabled) {
      this.save({ ...cur, enabled: false, changedAt: now() });
      this.turnedOff(u.id, source, 'off');
    } else this.endAll('off');
    this.emit();
    return this.settings();
  }

  private turnedOff(userId: string, source: string, reason: EndReason) {
    const n = this.sessions.size;
    this.endAll(reason);
    this.ctx.audit(userId, 'remote_desktop.off', { source, sessions: n });
  }

  /** The Stop button of the on-screen indicator (and the emergency-stop hotkey / tray): end everything, switch off. */
  stopFromComputer(source = 'stopknop') {
    const owner = this.ctx.auth.owner();
    const cur = this.settings();
    const n = this.sessions.size;
    if (cur.enabled) this.save({ ...cur, enabled: false, changedAt: now() });
    this.endAll('stopped_here');
    if (owner && (cur.enabled || n)) this.ctx.audit(owner.id, 'remote_desktop.off', { source, sessions: n });
    if (owner && n) this.ctx.events.emit(owner.id, 'notification', { title: 'Bureaublad op afstand gestopt', body: 'Op de computer is op Stop gedrukt; het staat nu uit. Aanzetten kan alleen weer op de computer zelf.', link: '#/m/remote-desktop', kind: 'computer' });
    this.emit();
    return { ended: n, wasOn: cur.enabled };
  }

  // ---------------------------------------------------------------- sessions

  private requireOwner(u: User) {
    const owner = this.ctx.auth.owner();
    if (u.role !== 'owner' || !owner || owner.id !== u.id) throw new HttpError(403, 'Alleen de eigenaar van deze computer kan het bureaublad op afstand gebruiken.');
  }

  start(u: User, auth: { id: string; kind: string; name: string }, o: { ip: string; monitor?: unknown; view?: unknown }): RemoteSession {
    this.requireOwner(u);
    const s = this.settings();
    if (!s.enabled) throw new HttpError(409, 'Bureaublad op afstand staat uit. Zet het aan op de computer zelf (Instellingen › Telefoon › Bureaublad op afstand).', 'remote_off');
    const un = this.unavailable();
    if (un) throw new HttpError(409, endText.unavailable, 'remote_unavailable');
    // one session per sign-in: a reconnect of the same viewer replaces its old session
    for (const x of [...this.sessions.values()]) if (x.authSessionId === auth.id) this.end(x.id, 'ended', { quiet: true });
    if (this.sessions.size >= MAX_SESSIONS) throw new HttpError(429, 'Er kijken al drie apparaten mee. Stop eerst een andere sessie.', 'remote_busy');
    const t = this.clock();
    const kind: DeviceKind = auth.kind === 'device' ? 'phone' : auth.kind === 'desktop' ? 'computer' : 'browser';
    const x: RemoteSession = {
      id: newId('rds_'),
      userId: u.id,
      authSessionId: auth.id,
      deviceKind: kind,
      deviceName: kind === 'phone' ? String(auth.name || '').slice(0, 60) : '',
      ip: String(o.ip || '').slice(0, 60),
      view: !s.control || o.view === true,
      monitor: Math.max(0, Math.min(15, Math.round(Number(o.monitor) || 0))),
      startedAt: t,
      lastFrameAt: t,
      lastInputAt: 0,
      lastActiveAt: t,
      frames: 0,
      inputs: 0,
      bytes: 0,
      inflight: 0,
      inputTimes: [],
      tookOverFrom: null,
    };
    this.sessions.set(x.id, x);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.killTimer = null;
    this.ctx.audit(u.id, 'remote_desktop.start', { device: x.deviceName || kind, kind, view: x.view, ip: x.ip });
    this.emit();
    return x;
  }

  /** The session of this sign-in, or a 410 that says why it ended (the viewer shows that sentence). */
  get(id: string, u: User, authSessionId: string): RemoteSession {
    const x = this.sessions.get(id);
    if (x && x.userId === u.id && x.authSessionId === authSessionId) return x;
    const e = this.ended.get(id);
    if (e && !x) throw new HttpError(410, endText[e.reason], 'remote_' + e.reason);
    throw new HttpError(404, 'Deze sessie bestaat niet (meer).', 'remote_unknown');
  }

  end(id: string, reason: EndReason, o: { quiet?: boolean } = {}) {
    const x = this.sessions.get(id);
    if (!x) return false;
    this.sessions.delete(id);
    this.ended.set(id, { reason, at: this.clock() });
    for (const [k, v] of this.ended) if (this.clock() - v.at > ENDED_KEEP_MS) this.ended.delete(k);
    this.ctx.audit(x.userId, 'remote_desktop.end', { device: x.deviceName || x.deviceKind, kind: x.deviceKind, reason, seconds: Math.round((this.clock() - x.startedAt) / 1000), inputs: x.inputs });
    if (!o.quiet) this.ctx.events.emit(x.userId, 'remote-desktop.ended', { id, reason });
    if (!this.sessions.size) this.scheduleKill();
    this.emit();
    return true;
  }

  endAll(reason: EndReason) {
    for (const id of [...this.sessions.keys()]) this.end(id, reason);
  }

  /** "I am still here": the idle stop starts counting again. */
  keepalive(x: RemoteSession) {
    x.lastActiveAt = this.clock();
    return { idleLeftMs: this.idleLeft(x) };
  }

  idleLeft(x: RemoteSession) {
    return Math.max(0, x.lastActiveAt + this.settings().idleMinutes * 60_000 - this.clock());
  }

  /** Stop sessions without input for too long, and sessions whose viewer is gone (no frame for a minute). */
  sweep() {
    const t = this.clock();
    const s = this.settings();
    for (const x of [...this.sessions.values()]) {
      if (!s.enabled) this.end(x.id, 'off');
      else if (this.unavailable()) this.end(x.id, 'unavailable');
      else if (t - x.lastActiveAt >= s.idleMinutes * 60_000) this.end(x.id, 'idle');
      else if (t - Math.max(x.lastFrameAt, x.lastInputAt) >= GONE_MS && x.inflight === 0) this.end(x.id, 'gone');
      else if (!this.authAlive(x.authSessionId)) this.end(x.id, 'signed_out');
    }
    // the "kijkt mee / bedient" text of the indicator follows the last input
    this.emit();
  }

  private authAlive(id: string) {
    try {
      const r = this.ctx.store.one<{ revoked: number; expires_at: string | null }>('SELECT revoked, expires_at FROM sessions WHERE id = ?', id);
      return !!r && !r.revoked && (!r.expires_at || r.expires_at > now());
    } catch {
      return true;
    }
  }

  // ---------------------------------------------------------------- monitors, frames, input

  async monitors(refresh = false): Promise<Monitor[]> {
    if (!refresh && this.mons && Date.now() - this.mons.at < 15_000) return this.mons.list;
    const r = await this.driver.call('monitors', {});
    const list: Monitor[] = (r?.monitors || []).map((m: any, i: number) => ({ index: Number(m.index ?? i), x: Number(m.x), y: Number(m.y), w: Number(m.w), h: Number(m.h), primary: !!m.primary, dpi: Number(m.dpi) || 96 }));
    if (!list.length) throw new HttpError(503, 'Geen beeldscherm gevonden.', 'remote_capture');
    this.mons = { at: Date.now(), list };
    return list;
  }

  private async monitorOf(index: unknown): Promise<Monitor> {
    const i = Math.round(Number(index) || 0);
    const list = await this.monitors();
    return list.find((m) => m.index === i) || list.find((m) => m.primary) || list[0];
  }

  async frame(x: RemoteSession, q: { m?: unknown; w?: unknown; q?: unknown }, etag?: string): Promise<FrameResult> {
    if (x.inflight >= 2) throw new HttpError(429, 'Nog bezig met het vorige beeld.', 'remote_busy');
    x.inflight++;
    x.lastFrameAt = this.clock();
    try {
      const mon = await this.monitorOf(q.m ?? x.monitor);
      x.monitor = mon.index;
      const g = frameGeometry(mon, q.w);
      const file = path.join(this.dir, 'tmp', newId('frm_') + '.jpg');
      let meta: any;
      try {
        meta = await this.driver.call('shot', { area: { x: g.x, y: g.y, w: g.w, h: g.h }, outW: g.shotW, outH: g.shotH, out: file, quality: frameQuality(q.q), marks: [], fast: true, policy: ownerPolicy() }, 15_000);
      } catch (e: any) {
        this.mons = null;
        throw new HttpError(503, String(e?.message || e).slice(0, 300) || 'Kon het scherm niet vastleggen.', 'remote_capture');
      }
      let jpeg: Buffer;
      try {
        jpeg = fs.readFileSync(file);
      } finally {
        fs.rmSync(file, { force: true });
      }
      if (!this.sessions.has(x.id)) throw new HttpError(410, endText[this.ended.get(x.id)?.reason || 'ended'], 'remote_' + (this.ended.get(x.id)?.reason || 'ended'));
      const tag = '"' + crypto.createHash('sha1').update(jpeg).digest('hex').slice(0, 20) + '"';
      const same = !!etag && etag === tag;
      x.frames++;
      if (!same) x.bytes += jpeg.length;
      x.lastFrameAt = this.clock();
      return { notModified: same, jpeg: same ? null : jpeg, etag: tag, width: g.shotW, height: g.shotH, cursor: cursorOn(mon, meta?.cursor), idleLeftMs: this.idleLeft(x) };
    } finally {
      x.inflight--;
    }
  }

  async input(x: RemoteSession, owner: User, body: any): Promise<{ ok: true; idleLeftMs: number; tookOverFrom: string | null }> {
    if (!this.settings().control) throw new HttpError(403, 'Op afstand kun je alleen meekijken (ingesteld op de computer).', 'remote_view_only');
    if (x.view) throw new HttpError(403, 'Deze sessie kijkt alleen mee. Zet "Alleen kijken" uit om te bedienen.', 'remote_view_only');
    const t = this.clock();
    x.inputTimes = x.inputTimes.filter((v) => t - v < 1000);
    if (x.inputTimes.length >= MAX_INPUTS_PER_SEC) throw new HttpError(429, 'Te veel invoer tegelijk; even rustiger.', 'remote_busy');
    x.inputTimes.push(t);
    let input;
    try {
      input = parseInput(body);
    } catch (e: any) {
      throw new HttpError(400, String(e?.message || e), 'remote_input');
    }
    const mon = await this.monitorOf(body?.monitor ?? x.monitor);
    const call = driverCall(input, mon);
    if (input.type !== 'move') this.pauseBot(x, owner);
    try {
      await this.driver.call(call.action, call.payload, input.type === 'type' ? 60_000 : 15_000);
    } catch (e: any) {
      throw new HttpError(409, String(e?.message || e).slice(0, 300), 'remote_refused');
    }
    const wasControlling = this.controlling(x);
    x.inputs++;
    x.lastInputAt = this.clock();
    x.lastActiveAt = x.lastInputAt;
    if (!wasControlling) this.emit();
    return { ok: true, idleLeftMs: this.idleLeft(x), tookOverFrom: x.tookOverFrom };
  }

  /** A bot works on this desktop: the owner's remote input takes over (the bot waits until "Geef terug"). */
  private pauseBot(x: RemoteSession, owner: User) {
    try {
      const comp = this.ctx.services.computers;
      const cur = comp?.lease?.current?.('desktop:host');
      if (cur?.kind !== 'bot') return;
      const svc = comp._service;
      svc.takeControl(owner, 'desktop:host', { sticky: true });
      x.tookOverFrom = cur.name || null;
      if (cur.agentId) svc.logAction(owner.id, cur.agentId, { actor: 'user', actorName: owner.name, tool: 'takeover', summary: 'Bureaublad overgenomen via bureaublad op afstand: de bot wacht', status: 'done' });
      svc.screen?.emitState?.();
    } catch {
      /* the bot keeps its own "the owner moved the mouse" pause as a fallback */
    }
  }

  /** What the bot on this desktop is doing (for the viewer: "Ada wacht tot je teruggeeft"). */
  botState(): { agentId: string | null; agentName: string | null; active: boolean; paused: boolean } | null {
    try {
      const s = this.ctx.services.computers?.desktop?.state?.();
      if (!s || (!s.active && !s.paused)) return null;
      return { agentId: s.agentId || null, agentName: s.agentName || null, active: !!s.active, paused: !!s.paused };
    } catch {
      return null;
    }
  }

  // ---------------------------------------------------------------- indicator + events

  /** For the desktop shell's indicator: who watches right now (called at once and on every change). */
  onState(fn: (s: { sessions: IndicatorSession[]; enabled: boolean }) => void): () => void {
    this.listeners.add(fn);
    try {
      fn(this.indicatorState());
    } catch {
      /* listener error */
    }
    return () => this.listeners.delete(fn);
  }

  indicatorState(): { sessions: IndicatorSession[]; enabled: boolean } {
    return { enabled: this.settings().enabled, sessions: [...this.sessions.values()].map((x) => ({ device: x.deviceName || (x.deviceKind === 'computer' ? 'Deze computer' : x.deviceKind === 'phone' ? 'Telefoon' : `Browser ${x.ip}`.trim()), controlling: this.controlling(x) })) };
  }

  private lastSent = '';
  emit() {
    if (this.emitTimer || this.closed) return;
    this.emitTimer = setTimeout(() => {
      this.emitTimer = null;
      if (this.closed) return;
      const s = this.indicatorState();
      const key = JSON.stringify(s);
      if (key === this.lastSent) return;
      this.lastSent = key;
      for (const fn of this.listeners) {
        try {
          fn(s);
        } catch {
          /* ignore */
        }
      }
      try {
        const owner = this.ctx.auth?.owner?.();
        if (owner) this.ctx.events.emit(owner.id, 'remote-desktop.state', { enabled: s.enabled, sessions: this.sessions.size });
      } catch {
        /* shutting down */
      }
    }, 30);
    this.emitTimer.unref?.();
  }

  private scheduleKill() {
    if (!this.realDriver || this.killTimer) return;
    this.killTimer = setTimeout(() => {
      this.killTimer = null;
      if (!this.sessions.size) this.realDriver?.kill();
    }, 30_000);
    this.killTimer.unref?.();
  }

  close() {
    this.endAll('shutdown');
    this.closed = true;
    if (this.emitTimer) clearTimeout(this.emitTimer);
    if (this.killTimer) clearTimeout(this.killTimer);
    this.listeners.clear();
    this.realDriver?.kill();
  }
}
