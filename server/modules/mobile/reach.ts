import os from 'node:os';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { safeEnv } from '../../tools/builtin/shell.js';
import { isLoopbackHost } from '../../core/util.js';

export interface NetAddr {
  address: string;
  iface: string;
}

/** Tailscale hands out addresses from the CGNAT range 100.64.0.0/10. */
export function isTailscaleIp(ip: string): boolean {
  const m = /^100\.(\d+)\./.exec(ip);
  return !!m && Number(m[1]) >= 64 && Number(m[1]) <= 127;
}
export function isPrivateLan(ip: string): boolean {
  return /^10\./.test(ip) || /^192\.168\./.test(ip) || /^172\.(1[6-9]|2\d|3[01])\./.test(ip);
}
export function interfaces(): { lan: NetAddr[]; tailscale: NetAddr[] } {
  const lan: NetAddr[] = [];
  const tailscale: NetAddr[] = [];
  for (const [iface, list] of Object.entries(os.networkInterfaces())) {
    for (const i of list || []) {
      if (i.family !== 'IPv4' || i.internal) continue;
      if (isTailscaleIp(i.address) || /tailscale/i.test(iface)) tailscale.push({ address: i.address, iface });
      else if (isPrivateLan(i.address)) lan.push({ address: i.address, iface });
    }
  }
  return { lan, tailscale };
}

export interface TailscaleInfo {
  installed: boolean;
  running: boolean;
  ips: string[];
  dnsName: string | null;
  detail: string;
}

function tailscaleBinaries(): string[] {
  const list = ['tailscale'];
  if (process.platform === 'win32') list.push('C:\\Program Files\\Tailscale\\tailscale.exe');
  if (process.platform === 'darwin') list.push('/Applications/Tailscale.app/Contents/MacOS/Tailscale');
  return list;
}

function run(bin: string, args: string[]): Promise<{ ok: boolean; out: string; missing: boolean }> {
  return new Promise((resolve) => {
    execFile(bin, args, { timeout: 4000, windowsHide: true, env: safeEnv(), maxBuffer: 2_000_000 }, (err: any, stdout) => {
      if (err) return resolve({ ok: false, out: String(stdout || ''), missing: err.code === 'ENOENT' });
      resolve({ ok: true, out: String(stdout || ''), missing: false });
    });
  });
}

let cache: { at: number; v: TailscaleInfo } | null = null;

/** Ask the local Tailscale CLI (read-only: `tailscale status --json`). Cached for 30 s. */
export async function tailscaleStatus(fallbackIps: string[]): Promise<TailscaleInfo> {
  if (cache && Date.now() - cache.at < 30_000) return cache.v;
  let v: TailscaleInfo = { installed: false, running: false, ips: fallbackIps, dnsName: null, detail: 'Tailscale-programma niet gevonden' };
  for (const bin of tailscaleBinaries()) {
    if (bin.includes('\\') || bin.includes('/')) if (!fs.existsSync(bin)) continue;
    const r = await run(bin, ['status', '--json']);
    if (r.missing) continue;
    try {
      const j = JSON.parse(r.out);
      const state = String(j.BackendState || '');
      const ips: string[] = (j.Self?.TailscaleIPs || []).filter((ip: string) => /^\d+\.\d+\.\d+\.\d+$/.test(ip));
      const dns = String(j.Self?.DNSName || '').replace(/\.$/, '');
      v = { installed: true, running: state === 'Running', ips: ips.length ? ips : fallbackIps, dnsName: dns || null, detail: state === 'Running' ? 'Verbonden met je tailnet' : `Status: ${state || 'onbekend'}` };
    } catch {
      v = { installed: true, running: fallbackIps.length > 0, ips: fallbackIps, dnsName: null, detail: r.ok ? 'Status onleesbaar' : 'Tailscale staat uit of is niet ingelogd' };
    }
    break;
  }
  cache = { at: Date.now(), v };
  return v;
}

async function tailscaleRun(args: string[], timeoutMs = 4000): Promise<{ ok: boolean; out: string; found: boolean }> {
  for (const bin of tailscaleBinaries()) {
    if (bin.includes('\\') || bin.includes('/')) if (!fs.existsSync(bin)) continue;
    const r = await new Promise<{ ok: boolean; out: string; missing: boolean }>((resolve) => {
      execFile(bin, args, { timeout: timeoutMs, windowsHide: true, env: safeEnv(), maxBuffer: 2_000_000 }, (err: any, stdout, stderr) => {
        if (err) return resolve({ ok: false, out: String(stdout || '') + String(stderr || ''), missing: err.code === 'ENOENT' });
        resolve({ ok: true, out: String(stdout || ''), missing: false });
      });
    });
    if (r.missing) continue;
    return { ok: r.ok, out: r.out, found: true };
  }
  return { ok: false, out: '', found: false };
}

/** Local targets that Tailscale Serve proxies to on https port 443 (read-only: `tailscale serve status --json`). */
export async function tailscaleServeTargets(): Promise<string[]> {
  const r = await tailscaleRun(['serve', 'status', '--json']);
  if (!r.ok) return [];
  try {
    const j = JSON.parse(r.out || '{}');
    const out: string[] = [];
    for (const [hostPort, web] of Object.entries<any>(j.Web || {})) {
      if (!/:443$/.test(hostPort)) continue;
      for (const h of Object.values<any>(web?.Handlers || {})) if (typeof h?.Proxy === 'string') out.push(h.Proxy.replace(/\/$/, ''));
    }
    return out;
  } catch {
    return [];
  }
}

/** Publish a loopback target on this machine's tailnet https name. Only loopback targets are accepted. */
export async function tailscaleServe(target: string): Promise<{ ok: boolean; detail: string }> {
  const u = new URL(target);
  if (u.protocol !== 'http:' || !isLoopbackHost(u.hostname) || !u.port) return { ok: false, detail: 'Alleen een lokaal adres (127.0.0.1) kan via Tailscale gedeeld worden' };
  const r = await tailscaleRun(['serve', '--bg', `http://127.0.0.1:${u.port}`], 30_000);
  if (!r.found) return { ok: false, detail: 'Tailscale-programma niet gevonden' };
  if (!r.ok) {
    const link = /https:\/\/login\.tailscale\.com\/\S+/.exec(r.out)?.[0];
    return { ok: false, detail: link ? `Zet eerst https aan voor je tailnet: ${link}` : `Tailscale weigerde: ${r.out.trim().slice(0, 300) || 'onbekende fout'}` };
  }
  cache = null;
  return { ok: true, detail: 'Gedeeld via Tailscale Serve' };
}
