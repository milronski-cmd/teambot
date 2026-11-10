import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { HOST_PS1 } from './host.ps1.js';
import { safeEnv } from '../../tools/builtin/shell.js';
import { blockedReason, normApp } from './screen-policy.js';

/**
 * Windows host control ("Mijn bureaublad") via UI Automation (window-scoped tools desktop_inspect/click/type/key).
 * Off by default; only for the machine owner, only for explicitly allowed apps; input is gated by the bot's desktop
 * access level (see screen-policy.ts). Full-screen computer use with screenshots lives in screen.ts.
 */

/** Never controllable, whatever the allowlist says (TeamBot itself, UAC/credential prompts, lock screen). */
export const HOST_DENY = ['teambot', 'electron', 'consent', 'credentialuibroker', 'lockapp', 'logonui', 'useraccountcontrolsettings'];

export function cleanApps(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.map(normApp).filter((a) => a && !HOST_DENY.includes(a)))].slice(0, 50);
}

export interface HostWindow {
  hwnd: number;
  pid: number;
  process: string;
  title: string;
  x: number;
  y: number;
  w: number;
  h: number;
  minimized: boolean;
}

export function windowAllowed(w: Pick<HostWindow, 'process' | 'title'>, allow: string[], o: { blockWords?: string[]; allApps?: boolean } = {}): boolean {
  const p = normApp(w.process);
  if (HOST_DENY.includes(p) || /teambot/i.test(w.title)) return false;
  // password managers, banking/payment pages, credential prompts: never, whatever the allowlist says
  if (blockedReason(w, o.blockWords || [])) return false;
  return !!o.allApps || allow.includes(p);
}

export interface UiaElement {
  depth: number;
  type: string;
  name: string;
  id: string;
  enabled: boolean;
  password: boolean;
  value: string;
  invoke: boolean;
  runtime: string;
  x: number;
  y: number;
  w: number;
  h: number;
  offscreen: boolean;
}

export interface DesktopSnapshot {
  id: string;
  agentId: string;
  userId: string;
  at: number;
  window: HostWindow;
  elements: (UiaElement & { ref: string })[];
  preview: string | null;
}

/** Desktop snapshots are referenced by globally unique refs like "k3f9.e5" (valid for a few minutes). */
export const desktopSnapshots = new Map<string, DesktopSnapshot>();
export const SNAPSHOT_TTL_MS = 5 * 60_000;

export function lookupRef(ref: string): { snap: DesktopSnapshot; el: DesktopSnapshot['elements'][number] | null } | null {
  const [sid, eid] = String(ref || '').split('.');
  const snap = desktopSnapshots.get(sid);
  if (!snap || Date.now() - snap.at > SNAPSHOT_TTL_MS) return null;
  return { snap, el: eid ? snap.elements.find((e) => e.ref === eid) || null : null };
}

export function pruneSnapshots() {
  for (const [k, s] of desktopSnapshots) if (Date.now() - s.at > SNAPSHOT_TTL_MS * 2) desktopSnapshots.delete(k);
}

const VK: Record<string, number> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5b, enter: 0x0d, return: 0x0d, tab: 0x09, esc: 0x1b, escape: 0x1b,
  backspace: 0x08, delete: 0x2e, del: 0x2e, insert: 0x2d, home: 0x24, end: 0x23, pageup: 0x21, pagedown: 0x22,
  up: 0x26, down: 0x28, left: 0x25, right: 0x27, space: 0x20,
};
for (let i = 1; i <= 12; i++) VK['f' + i] = 0x6f + i;

/** "ctrl+s" -> [0x11, 0x53]. Refuses system combos that could escape the window (win key, ctrl+alt+del, alt+tab). */
export function parseKeys(combo: string): number[] {
  const parts = String(combo || '')
    .toLowerCase()
    .split('+')
    .map((s) => s.trim())
    .filter(Boolean);
  if (!parts.length || parts.length > 4) throw new Error('Ongeldige toetscombinatie');
  const out: number[] = [];
  for (const p of parts) {
    if (VK[p] !== undefined) out.push(VK[p]);
    else if (/^[a-z0-9]$/.test(p)) out.push(p.toUpperCase().charCodeAt(0));
    else throw new Error(`Onbekende toets: ${p}`);
  }
  const set = new Set(out);
  if (set.has(0x5b)) throw new Error('De Windows-toets is niet toegestaan voor bots');
  if (set.has(0x12) && (set.has(0x09) || set.has(0x73) || set.has(0x1b))) throw new Error('Alt+Tab, Alt+F4 en Alt+Esc zijn niet toegestaan voor bots');
  if (set.has(0x11) && set.has(0x12) && set.has(0x2e)) throw new Error('Ctrl+Alt+Del is niet toegestaan');
  if (set.has(0x11) && set.has(0x1b)) throw new Error('Ctrl+Esc is niet toegestaan');
  return out;
}

export interface HostDriver {
  call(action: string, input: Record<string, any>, timeoutMs?: number): Promise<any>;
}

/** Runs the PowerShell helper (JSON over stdin/stdout). */
export class PowerShellDriver implements HostDriver {
  private script: string;
  constructor(dir: string) {
    fs.mkdirSync(dir, { recursive: true });
    this.script = path.join(dir, 'teambot-host.ps1');
    const want = '﻿' + HOST_PS1;
    const cur = fs.existsSync(this.script) ? fs.readFileSync(this.script, 'utf8') : '';
    if (cur !== want) fs.writeFileSync(this.script, want, 'utf8');
  }
  call(action: string, input: Record<string, any>, timeoutMs = 30_000): Promise<any> {
    if (process.platform !== 'win32') return Promise.reject(new Error('Bureaubladbediening werkt alleen op Windows'));
    return new Promise((resolve, reject) => {
      const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', this.script], { windowsHide: true, env: safeEnv() });
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill();
        reject(new Error('Bureaubladactie duurde te lang'));
      }, timeoutMs);
      child.stdout.on('data', (b) => (out += b.toString('utf8')));
      child.stderr.on('data', (b) => (err += b.toString('utf8')));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', () => {
        clearTimeout(timer);
        const text = out.replace(/^﻿/, '').trim();
        try {
          const j = JSON.parse(text);
          if (j && j.error) reject(new Error(j.error));
          else resolve(j);
        } catch {
          reject(new Error('Bureaubladhulp gaf geen geldig antwoord' + (err ? `: ${err.slice(0, 300)}` : '')));
        }
      });
      child.stdin.end(JSON.stringify({ action, ...input }));
    });
  }
}

export function newSnapshotId() {
  return crypto.randomBytes(3).toString('hex');
}

/** Compact, model-friendly text for a UIA snapshot (no password values). */
export function renderDesktopSnapshot(s: DesktopSnapshot, maxChars = 12_000): string {
  const lines: string[] = [`Venster: "${s.window.title}" (${s.window.process}, ${s.window.w}×${s.window.h})`];
  let len = lines[0].length;
  let cut = false;
  for (const e of s.elements) {
    if (e.offscreen && !e.name) continue;
    const name = (e.name || '').replace(/\s+/g, ' ').slice(0, 100);
    let line = `${'  '.repeat(Math.min(e.depth - 1, 8))}[${s.id}.${e.ref}] ${e.type}${name ? ` "${name}"` : ''}`;
    if (e.password) line += ' (wachtwoordveld — niet typen)';
    else if (e.value) line += ` = "${e.value.replace(/\s+/g, ' ').slice(0, 80)}"`;
    if (!e.enabled) line += ' (uitgeschakeld)';
    if (len + line.length > maxChars) {
      cut = true;
      break;
    }
    lines.push(line);
    len += line.length + 1;
  }
  if (cut) lines.push('… (afgekapt)');
  return lines.join('\n');
}
