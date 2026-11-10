import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';

/**
 * "Stoppen" that really stops, on Windows: every CLI process TeamBot starts (Claude Code, Codex, OpenCode and the other
 * ACP agents) goes into its own Windows Job Object. Windows keeps every process that process starts in the same job,
 * also when its parent is already gone (a server started through a shell that returned, a background task). Stopping
 * then ends the whole job: `taskkill /T` alone cannot find such orphans, because it walks parent ids.
 *
 * One small powershell.exe helper (started on the first CLI run) holds the job handles. The jobs are "kill on close":
 * when TeamBot itself exits or crashes, the helper's stdin closes, it exits, and Windows ends the CLI processes too.
 * Only processes TeamBot started (and what they start) are ever in a job; nothing else is touched. Programs that ask
 * to leave the job may (BREAKAWAY_OK), so nothing breaks; `taskkill /T` still covers those while their parent lives.
 *
 * Everywhere else (and when the helper cannot start, e.g. PowerShell blocked) this is a no-op and the caller falls
 * back to `taskkill /T` / the process group (proc.ts).
 */

const isWin = process.platform === 'win32';

const CS = String.raw`
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
public static class TbJobs {
  [StructLayout(LayoutKind.Sequential)] struct BASIC { public long PerProcessUserTimeLimit; public long PerJobUserTimeLimit; public uint LimitFlags; public UIntPtr MinimumWorkingSetSize; public UIntPtr MaximumWorkingSetSize; public uint ActiveProcessLimit; public UIntPtr Affinity; public uint PriorityClass; public uint SchedulingClass; }
  [StructLayout(LayoutKind.Sequential)] struct IOC { public ulong R, W, O, RB, WB, OB; }
  [StructLayout(LayoutKind.Sequential)] struct EXT { public BASIC Basic; public IOC Io; public UIntPtr ProcessMemoryLimit; public UIntPtr JobMemoryLimit; public UIntPtr PeakProcessMemoryUsed; public UIntPtr PeakJobMemoryUsed; }
  [StructLayout(LayoutKind.Sequential)] struct ACCT { public long TotalUserTime; public long TotalKernelTime; public long ThisPeriodTotalUserTime; public long ThisPeriodTotalKernelTime; public uint TotalPageFaultCount; public uint TotalProcesses; public uint ActiveProcesses; public uint TotalTerminatedProcesses; }
  [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr sa, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool SetInformationJobObject(IntPtr job, int cls, ref EXT info, int len);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool QueryInformationJobObject(IntPtr job, int cls, out ACCT info, int len, IntPtr ret);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr proc);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool TerminateJobObject(IntPtr job, uint code);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  static Dictionary<string, IntPtr> jobs = new Dictionary<string, IntPtr>();
  const uint KILL_ON_CLOSE = 0x2000, BREAKAWAY_OK = 0x800;
  static bool Flags(IntPtr job, uint flags) { EXT e = new EXT(); e.Basic.LimitFlags = flags; return SetInformationJobObject(job, 9, ref e, Marshal.SizeOf(typeof(EXT))); }
  static uint Active(IntPtr job) { ACCT a; return QueryInformationJobObject(job, 1, out a, Marshal.SizeOf(typeof(ACCT)), IntPtr.Zero) ? a.ActiveProcesses : 0; }
  public static string Add(string key, uint pid) {
    IntPtr job;
    if (!jobs.TryGetValue(key, out job)) {
      job = CreateJobObject(IntPtr.Zero, null);
      if (job == IntPtr.Zero) return "err create " + Marshal.GetLastWin32Error();
      Flags(job, KILL_ON_CLOSE | BREAKAWAY_OK);
      jobs[key] = job;
    }
    IntPtr p = OpenProcess(0x0101, false, pid);
    if (p == IntPtr.Zero) return "err open " + Marshal.GetLastWin32Error();
    bool ok = AssignProcessToJobObject(job, p);
    int err = Marshal.GetLastWin32Error();
    CloseHandle(p);
    return ok ? "ok" : "err assign " + err;
  }
  public static string Kill(string key) { IntPtr job; if (!jobs.TryGetValue(key, out job)) return "none"; TerminateJobObject(job, 1); return "ok"; }
  public static string Count(string key) { IntPtr job; if (!jobs.TryGetValue(key, out job)) return "none"; return "ok " + Active(job); }
  public static string Release(string key) { IntPtr job; if (!jobs.TryGetValue(key, out job)) return "none"; Flags(job, BREAKAWAY_OK); CloseHandle(job); jobs.Remove(key); return "ok"; }
  public static string Close(string key) { IntPtr job; if (!jobs.TryGetValue(key, out job)) return "none"; TerminateJobObject(job, 1); CloseHandle(job); jobs.Remove(key); return "ok"; }
}
`;

const PS = `
$ErrorActionPreference = 'Stop'
try { [Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false) } catch { }
$src = @'
${CS}
'@
Add-Type -TypeDefinition $src
[Console]::Out.WriteLine('ready')
[Console]::Out.Flush()
while ($true) {
  $line = [Console]::In.ReadLine()
  if ($line -eq $null) { break }
  $p = $line.Split(' ')
  try {
    switch ($p[1]) {
      'add' { $r = [TbJobs]::Add($p[2], [uint32]$p[3]) }
      'kill' { $r = [TbJobs]::Kill($p[2]) }
      'count' { $r = [TbJobs]::Count($p[2]) }
      'release' { $r = [TbJobs]::Release($p[2]) }
      'close' { $r = [TbJobs]::Close($p[2]) }
      default { $r = 'err unknown' }
    }
  } catch { $r = 'err ' + ($_.Exception.Message -replace '\\s+', ' ') }
  [Console]::Out.WriteLine($p[0] + ' ' + $r)
  [Console]::Out.Flush()
}
`;

type Waiter = { resolve(v: string): void; timer: NodeJS.Timeout };

class JobKeeper {
  private child: ChildProcess | null = null;
  private ready: Promise<boolean> | null = null;
  private waiters = new Map<number, Waiter>();
  private seq = 0;
  private buf = '';
  /** Set once the helper failed to start: then every call is a no-op (fallback: taskkill /T). */
  broken = false;

  private start(): Promise<boolean> {
    if (this.ready) return this.ready;
    this.ready = new Promise<boolean>((resolve) => {
      let child: ChildProcess;
      try {
        const ps = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
        const encoded = Buffer.from(PS, 'utf16le').toString('base64');
        // A bare environment: the helper needs nothing of TeamBot's (no keys, no tokens).
        const env: NodeJS.ProcessEnv = {};
        for (const k of ['SystemRoot', 'windir', 'SystemDrive', 'TEMP', 'TMP', 'PATH', 'Path', 'ComSpec', 'PSModulePath', 'USERPROFILE', 'LOCALAPPDATA', 'APPDATA', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS']) if (process.env[k]) env[k] = process.env[k];
        child = spawn(ps, ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env });
      } catch {
        this.broken = true;
        return resolve(false);
      }
      this.child = child;
      let started = false;
      const fail = () => {
        if (!started) {
          this.broken = true;
          resolve(false);
        }
        this.child = null;
        this.ready = null;
        for (const [id, w] of this.waiters) {
          clearTimeout(w.timer);
          w.resolve('err gone');
          this.waiters.delete(id);
        }
      };
      const giveUp = setTimeout(() => {
        if (started) return;
        try {
          child.kill();
        } catch {
          /* ignore */
        }
        fail();
      }, 30_000);
      giveUp.unref();
      child.on('error', fail);
      child.on('exit', fail);
      child.stdin!.on('error', () => {});
      child.stderr!.on('data', () => {});
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (s: string) => {
        this.buf += s;
        let i: number;
        while ((i = this.buf.indexOf('\n')) >= 0) {
          const line = this.buf.slice(0, i).trim();
          this.buf = this.buf.slice(i + 1);
          if (!started && line === 'ready') {
            started = true;
            clearTimeout(giveUp);
            resolve(true);
            continue;
          }
          const sp = line.indexOf(' ');
          const id = Number(line.slice(0, sp));
          const w = this.waiters.get(id);
          if (w) {
            clearTimeout(w.timer);
            this.waiters.delete(id);
            w.resolve(line.slice(sp + 1));
          }
        }
      });
      // Never keep TeamBot (or a test) alive just for the helper; it ends when TeamBot's process ends.
      child.unref();
      for (const s of [child.stdin, child.stdout, child.stderr] as any[]) s?.unref?.();
    });
    return this.ready;
  }

  /** Start the helper ahead of the first CLI run (no effect off Windows). */
  warm() {
    if (isWin && !this.broken) void this.start();
  }

  /**
   * Wait (at most `maxMs`) until the helper runs, so a CLI started next is in its job before it can start anything.
   * Only the first CLI run after TeamBot starts waits (about a second); false = no jobs (fallback: taskkill /T).
   */
  async whenReady(maxMs = 8000): Promise<boolean> {
    if (!isWin || this.broken) return false;
    let timer: NodeJS.Timeout | null = null;
    const late = new Promise<boolean>((r) => (timer = setTimeout(() => r(false), maxMs)));
    try {
      return await Promise.race([this.start(), late]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async send(cmd: string, key: string, arg = '', timeoutMs = 10_000): Promise<string> {
    if (!isWin || this.broken) return 'off';
    if (!(await this.start()) || !this.child?.stdin?.writable) return 'off';
    const id = ++this.seq;
    return new Promise<string>((resolve) => {
      // A pending answer keeps the process alive until it comes (or times out).
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve('err timeout');
      }, timeoutMs);
      this.waiters.set(id, { resolve, timer });
      this.child!.stdin!.write(`${id} ${cmd} ${key}${arg ? ` ${arg}` : ''}\n`);
    });
  }

  /** Put a process TeamBot just started into the job `key`. */
  add(key: string, pid: number) {
    return this.send('add', key, String(pid));
  }
  /** End every process in the job (the CLI and everything it started, also orphans). */
  kill(key: string) {
    return this.send('kill', key);
  }
  /** How many processes of the job still run ("ok 2"), "none" when unknown. */
  count(key: string) {
    return this.send('count', key);
  }
  /** The CLI ended by itself: stop tracking without ending what it left running (unchanged behaviour). */
  release(key: string) {
    return this.send('release', key);
  }
  /** End the job and forget it. */
  close(key: string) {
    return this.send('close', key);
  }
}

export const jobs = new JobKeeper();
