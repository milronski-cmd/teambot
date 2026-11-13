import fs from 'node:fs';
import path from 'node:path';
import type { Ctx } from '../../core/types.js';

/**
 * The heartbeat for the watchdog outside the app (0.4.4, P14). Every minute the server writes
 * `<data>/health/heartbeat.json`: when, which process, which port, and whether the owner wants to be told. A small
 * PowerShell script (build/watchdog.ps1), started every 10 minutes by a scheduled task of the user, reads it and checks
 * three things without TeamBot's help: does the process run, does `127.0.0.1:<port>/healthz` answer, and is the
 * heartbeat recent. A hanging server stops writing (the timer cannot fire), a crashed one leaves the file behind. On a
 * normal quit the file says `stopped`, so closing TeamBot yourself is never reported. A deliberate stop also leaves
 * `<data>/health/stopped.json` ("bewust gestopt", markStopped): written by the desktop app at Afsluiten, an update or a
 * restart (before-quit) and when Windows signs off or shuts down (session-end), and by the installer before it closes
 * TeamBot (build/installer.nsh, customInit). The watchdog honours it until TeamBot starts again (start() removes it).
 * The script writes its finding to
 * `<data>/health/watchdog.json`, which Status van TeamBot shows. No database, no keys, no AI: the file holds only
 * the facts below.
 * The idea comes from OpenMausBot's Sentinel (Apache-2.0); this is our own code.
 */

export const HEARTBEAT_EVERY_MS = 60_000;
export const WATCH_SETTING = 'watchdogNotify';

export interface Heartbeat {
  v: 1;
  at: string;
  boot: string;
  pid: number;
  port: number;
  version: string;
  /** The program to start again (the TeamBot app, or node for a server). */
  exe: string;
  /** The owner wants a notification when TeamBot is down or hangs. */
  notify: boolean;
  stopped: boolean;
}

export interface WatchdogFinding {
  at: string;
  status: 'ok' | 'down' | 'hang' | 'stopped';
  since?: string | null;
  detail?: string;
}

const dirOf = (ctx: Ctx) => path.join(ctx.config.dataDir, 'health');
export const heartbeatFile = (ctx: Ctx) => path.join(dirOf(ctx), 'heartbeat.json');
export const findingFile = (ctx: Ctx) => path.join(dirOf(ctx), 'watchdog.json');
export const stoppedFile = (dataDir: string) => path.join(dataDir, 'health', 'stopped.json');

/**
 * "Bewust gestopt": TeamBot is about to stop on purpose (quit, update, restart, Windows shutting down). Synchronous and
 * independent of the server, so it is on disk before the process is gone. Never throws.
 */
export function markStopped(dataDir: string, reason: 'quit' | 'update' | 'restart' | 'shutdown' | 'installer') {
  try {
    const file = stoppedFile(dataDir);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ reason, at: new Date().toISOString(), pid: process.pid }));
  } catch {
    /* the data folder is gone: nothing to watch either */
  }
}

/** TeamBot runs again: a stop marker of an earlier run no longer counts. */
export function clearStopped(dataDir: string) {
  try {
    fs.rmSync(stoppedFile(dataDir), { force: true });
  } catch {
    /* in use: the watchdog compares its time with this run's heartbeat anyway */
  }
}

/** The owner's choice (default on). Only the local owner of this installation counts. */
export function watchNotify(ctx: Ctx): boolean {
  const owner = ctx.auth.owner();
  return owner ? ctx.store.getSetting<boolean>(owner.id, WATCH_SETTING, true) !== false : true;
}

export function writeHeartbeat(ctx: Ctx, boot: string, stopped = false) {
  const hb: Heartbeat = { v: 1, at: new Date().toISOString(), boot, pid: process.pid, port: Number(ctx.config.port) || 0, version: ctx.config.version, exe: process.execPath, notify: watchNotify(ctx), stopped };
  const file = heartbeatFile(ctx);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Write and rename: the script never reads half a file.
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(hb));
  fs.renameSync(tmp, file);
  return hb;
}

/** What the watchdog last found (null when it never ran, e.g. in development or outside Windows). */
export function readFinding(ctx: Ctx): WatchdogFinding | null {
  try {
    const raw = fs.readFileSync(findingFile(ctx), 'utf8').replace(/^﻿/, '');
    const j = JSON.parse(raw);
    if (!j || typeof j.at !== 'string' || !['ok', 'down', 'hang', 'stopped'].includes(j.status)) return null;
    return { at: j.at, status: j.status, since: typeof j.since === 'string' ? j.since : null, detail: typeof j.detail === 'string' ? j.detail.slice(0, 200) : undefined };
  } catch {
    return null;
  }
}

export class HeartbeatWriter {
  private timer: NodeJS.Timeout | null = null;
  readonly boot = new Date().toISOString();
  constructor(private ctx: Ctx) {}

  beat(stopped = false) {
    try {
      writeHeartbeat(this.ctx, this.boot, stopped);
    } catch (e) {
      this.ctx.log.warn('[health] hartslag schrijven mislukt', String(e));
    }
  }

  start(everyMs = HEARTBEAT_EVERY_MS) {
    if (this.timer) clearInterval(this.timer);
    clearStopped(this.ctx.config.dataDir);
    this.beat();
    // The port is known once the server listens: beat again shortly after the start.
    setTimeout(() => this.timer && this.beat(), 2000).unref?.();
    this.timer = setInterval(() => this.beat(), everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.beat(true);
  }
}
