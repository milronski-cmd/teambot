// Read-only process statistics from the operating system, for the soak test (scripts/soak.mjs): memory, CPU time,
// handles and threads of a process and its children. Never attaches to, signals or talks to the process: it only reads
// what the OS reports (Windows: Win32_Process via PowerShell/CIM; Linux: /proc; macOS: ps).
// Own code because pidusage and systeminformation (both MIT) do not report Windows handle counts.
import { execFile } from 'node:child_process';
import fs from 'node:fs';

const run = (cmd, args) =>
  new Promise((resolve, reject) => execFile(cmd, args, { windowsHide: true, maxBuffer: 32 * 1024 * 1024, timeout: 60_000 }, (e, out) => (e ? reject(e) : resolve(String(out)))));

/** All processes: { pid, ppid, name, wsBytes, privateBytes, handles, threads, cpuMs }. */
export async function snapshot() {
  if (process.platform === 'win32') {
    const props = 'ProcessId,ParentProcessId,Name,WorkingSetSize,PrivatePageCount,HandleCount,ThreadCount,UserModeTime,KernelModeTime';
    const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-CimInstance Win32_Process -Property ${props} | Select-Object ${props} | ConvertTo-Json -Compress`]);
    const rows = JSON.parse(out || '[]');
    return (Array.isArray(rows) ? rows : [rows]).map((r) => ({
      pid: r.ProcessId,
      ppid: r.ParentProcessId,
      name: String(r.Name || ''),
      wsBytes: Number(r.WorkingSetSize) || 0,
      privateBytes: Number(r.PrivatePageCount) || 0,
      handles: Number(r.HandleCount) || 0,
      threads: Number(r.ThreadCount) || 0,
      cpuMs: ((Number(r.UserModeTime) || 0) + (Number(r.KernelModeTime) || 0)) / 10_000,
    }));
  }
  if (process.platform === 'linux') {
    const page = 4096;
    const out = [];
    for (const d of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(d)) continue;
      try {
        const stat = fs.readFileSync(`/proc/${d}/stat`, 'utf8');
        const name = stat.slice(stat.indexOf('(') + 1, stat.lastIndexOf(')'));
        const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
        let handles = 0;
        try {
          handles = fs.readdirSync(`/proc/${d}/fd`).length;
        } catch {
          /* another user's process */
        }
        out.push({ pid: Number(d), ppid: Number(f[1]), name, wsBytes: Number(f[21]) * page, privateBytes: Number(f[21]) * page, handles, threads: Number(f[17]), cpuMs: ((Number(f[11]) + Number(f[12])) * 1000) / 100 });
      } catch {
        /* gone meanwhile */
      }
    }
    return out;
  }
  const out = await run('ps', ['-axo', 'pid=,ppid=,rss=,time=,comm=']);
  return out
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      const [pid, ppid, rss, time, ...name] = l.trim().split(/\s+/);
      const [m, s] = time.split(':');
      return { pid: Number(pid), ppid: Number(ppid), name: name.join(' ').split('/').pop(), wsBytes: Number(rss) * 1024, privateBytes: Number(rss) * 1024, handles: 0, threads: 0, cpuMs: (Number(m) * 60 + Number(s)) * 1000 };
    });
}

/** The processes of a target (a PID, or a program name like "OpenBot" / "OpenBot.exe") and all their children. */
export function selectTree(all, target) {
  const want = String(target).trim();
  const byPid = /^\d+$/.test(want);
  const norm = (n) => n.toLowerCase().replace(/\.exe$/, '');
  const roots = all.filter((p) => (byPid ? p.pid === Number(want) : norm(p.name) === norm(want)));
  const picked = new Map(roots.map((p) => [p.pid, p]));
  for (let grew = true; grew; ) {
    grew = false;
    for (const p of all) if (!picked.has(p.pid) && picked.has(p.ppid) && p.pid !== p.ppid) (picked.set(p.pid, p), (grew = true));
  }
  return [...picked.values()];
}

/** Totals of a set of processes. */
export function totals(procs) {
  const sum = (k) => procs.reduce((n, p) => n + (p[k] || 0), 0);
  const names = {};
  for (const p of procs) names[p.name] = (names[p.name] || 0) + 1;
  return { processes: procs.length, wsMb: Math.round(sum('wsBytes') / 1048576), privateMb: Math.round(sum('privateBytes') / 1048576), handles: sum('handles'), threads: sum('threads'), cpuMs: Math.round(sum('cpuMs')), names };
}
