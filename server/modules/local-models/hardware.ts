import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import { safeEnv } from '../../tools/builtin/shell.js';

/**
 * What this pc has for local models: memory, video card(s) and video memory. No new dependencies: Node's own `os`,
 * `nvidia-smi` when it is there, and on Windows one PowerShell call (Win32_VideoController plus the driver's 64-bit
 * memory size in the registry, because Win32_VideoController.AdapterRAM is a 32-bit field that stops at 4 GB).
 * Linux reads AMD video memory from /sys; macOS on Apple silicon shares the main memory with the GPU.
 */

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';

export interface Gpu {
  name: string;
  vendor: GpuVendor;
  /** Video memory in bytes; null = unknown. */
  vram: number | null;
  /** The figure is exact (nvidia-smi, the driver's 64-bit value, /sys); false = Windows' 32-bit field (at most 4 GB). */
  exact: boolean;
  /** A video card of its own, not the graphics built into the processor. */
  dedicated: boolean;
  driver?: string;
}

export interface Hardware {
  platform: string;
  /** Bytes. */
  ram: number;
  ramFree: number;
  cpu: string;
  cores: number;
  gpus: Gpu[];
  /** Apple silicon: the GPU uses the main memory. */
  unified: boolean;
  /** Where the video-card facts came from. */
  sources: string[];
  checkedAt: string;
}

/** Windows' 32-bit AdapterRAM: a card with 4 GB or more reports (about) this. */
const ADAPTER_RAM_CAP = 4 * 1024 ** 3 - 2 * 1024 ** 2;

/** Display adapters that are not hardware (remote desktop, virtual screens, mirroring). */
const VIRTUAL = /Microsoft Basic|Remote Display|Virtual|Parsec|Citrix|DisplayLink|Hyper-V|VMware|VirtualBox|Mirage|Splashtop|IddSample|spacedesk|Meta Quest|Oculus/i;

export function vendorOf(name: string, pnp = ''): GpuVendor {
  const v = /VEN_([0-9A-F]{4})/i.exec(pnp)?.[1]?.toUpperCase();
  if (v === '10DE' || /nvidia|geforce|quadro|rtx|gtx/i.test(name)) return 'nvidia';
  if (v === '1002' || v === '1022' || /\bamd\b|radeon/i.test(name)) return 'amd';
  if (v === '8086' || /intel/i.test(name)) return 'intel';
  if (/apple/i.test(name)) return 'apple';
  return 'other';
}

/** The graphics built into a processor (AMD "Radeon(TM) Graphics", "Radeon 780M"; Intel UHD/Iris/Arc(TM) Graphics). */
export function isIntegrated(name: string, vendor: GpuVendor): boolean {
  if (vendor === 'intel') return !/\bArc\b.*\b[AB]\d{3}\b/i.test(name); // Arc A770 / B580 are cards; "Arc(TM) Graphics", "Arc 140V" are built in
  if (vendor === 'amd') return /Radeon\s*\(TM\)\s*(\d{3,4}M\s*)?Graphics|Radeon\s+(Vega\b|\d{3,4}M\b)|^AMD Radeon Graphics$/i.test(name.trim());
  return vendor === 'other';
}

const arr = (x: any): any[] => (Array.isArray(x) ? x : x ? [x] : []);

/**
 * The PowerShell result: { controllers: Win32_VideoController[], registry: display-class driver keys }. The registry
 * value HardwareInformation.qwMemorySize is the card's real memory; matched to a controller by its PCI id.
 */
export function parseWindowsGpus(raw: any): Gpu[] {
  const reg = arr(raw?.registry).map((r) => ({ desc: String(r?.DriverDesc || ''), qw: Number(r?.Qw) || 0, match: String(r?.MatchingDeviceId || '').toLowerCase() }));
  const out: Gpu[] = [];
  for (const c of arr(raw?.controllers)) {
    const name = String(c?.Name || '').trim();
    const pnp = String(c?.PNPDeviceID || '');
    if (!name || VIRTUAL.test(name)) continue;
    const vendor = vendorOf(name, pnp);
    const hit = reg.find((r) => r.qw > 0 && r.match && pnp.toLowerCase().startsWith(r.match)) || reg.find((r) => r.qw > 0 && r.desc === name);
    const adapterRam = Number(c?.AdapterRAM) || 0;
    const vram = hit ? hit.qw : adapterRam > 0 ? adapterRam : null;
    const exact = !!hit || (adapterRam > 0 && adapterRam < ADAPTER_RAM_CAP);
    out.push({ name, vendor, vram, exact, dedicated: !isIntegrated(name, vendor), driver: c?.DriverVersion ? String(c.DriverVersion) : undefined });
  }
  return out;
}

/** `nvidia-smi --query-gpu=name,memory.total,driver_version --format=csv,noheader,nounits` (memory in MiB). */
export function parseNvidiaSmi(csv: string): Gpu[] {
  const out: Gpu[] = [];
  for (const line of csv.split(/\r?\n/)) {
    const [name, mib, driver] = line.split(',').map((s) => s.trim());
    const n = Number(mib);
    if (!name || !(n > 0)) continue;
    out.push({ name, vendor: 'nvidia', vram: Math.round(n * 1024 * 1024), exact: true, dedicated: true, driver: driver || undefined });
  }
  return out;
}

/** nvidia-smi knows NVIDIA memory exactly: it replaces the Windows figures for those cards. */
export function mergeNvidia(list: Gpu[], smi: Gpu[]): Gpu[] {
  if (!smi.length) return list;
  const rest = list.filter((g) => g.vendor !== 'nvidia');
  return [...smi, ...rest];
}

// PowerShell, run once (-EncodedCommand: no quoting problems). Reading one registry subkey can be refused
// ("Properties"): each key is read on its own, inside try/catch.
const PS_SCRIPT = `$ErrorActionPreference = 'SilentlyContinue'
$c = @(Get-CimInstance Win32_VideoController | ForEach-Object { [pscustomobject]@{ Name = $_.Name; AdapterRAM = [int64]$_.AdapterRAM; DriverVersion = $_.DriverVersion; PNPDeviceID = $_.PNPDeviceID } })
$r = @(Get-ChildItem 'HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' | ForEach-Object {
  try {
    $p = Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction Stop
    if ($p.DriverDesc) {
      $q = $p.'HardwareInformation.qwMemorySize'
      if ($q -is [array]) { $b = [byte[]](@($q) + @(0,0,0,0,0,0,0,0))[0..7]; $q = [BitConverter]::ToInt64($b, 0) }
      [pscustomobject]@{ DriverDesc = $p.DriverDesc; Qw = [int64]$q; MatchingDeviceId = $p.MatchingDeviceId }
    }
  } catch {}
})
[pscustomobject]@{ controllers = $c; registry = $r } | ConvertTo-Json -Depth 4 -Compress`;

function run(cmd: string, args: string[], timeoutMs = 15_000): Promise<string | null> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, env: safeEnv(), maxBuffer: 4 * 1024 * 1024 }, (err, stdout) => resolve(err ? null : String(stdout)));
    } catch {
      resolve(null);
    }
  });
}

async function windowsGpus(sources: string[]): Promise<Gpu[]> {
  const out = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(PS_SCRIPT, 'utf16le').toString('base64')]);
  if (!out) return [];
  try {
    const list = parseWindowsGpus(JSON.parse(out.trim()));
    if (list.length) sources.push('Windows');
    return list;
  } catch {
    return [];
  }
}

function linuxAmdGpus(): Gpu[] {
  const out: Gpu[] = [];
  try {
    for (const card of fs.readdirSync('/sys/class/drm').filter((n) => /^card\d+$/.test(n))) {
      const dir = `/sys/class/drm/${card}/device`;
      const vendor = (() => {
        try {
          return fs.readFileSync(`${dir}/vendor`, 'utf8').trim();
        } catch {
          return '';
        }
      })();
      if (vendor !== '0x1002') continue;
      const total = Number(fs.readFileSync(`${dir}/mem_info_vram_total`, 'utf8').trim());
      if (total > 0) out.push({ name: 'AMD Radeon', vendor: 'amd', vram: total, exact: true, dedicated: total >= 2 * 1024 ** 3 });
    }
  } catch {
    /* no /sys (or no AMD card) */
  }
  return out;
}

/** Look at this pc. Never throws: what cannot be read is left out. */
export async function detectHardware(): Promise<Hardware> {
  const sources: string[] = [];
  const cpus = os.cpus();
  const platform = process.platform;
  let gpus: Gpu[] = [];
  const smiOut = await run('nvidia-smi', ['--query-gpu=name,memory.total,driver_version', '--format=csv,noheader,nounits'], 8000);
  const smi = smiOut ? parseNvidiaSmi(smiOut) : [];
  if (smi.length) sources.push('nvidia-smi');
  if (platform === 'win32') gpus = mergeNvidia(await windowsGpus(sources), smi);
  else if (platform === 'linux') {
    const amd = linuxAmdGpus();
    if (amd.length) sources.push('/sys');
    gpus = [...smi, ...amd];
  } else gpus = smi;
  const unified = platform === 'darwin' && process.arch === 'arm64';
  if (unified) {
    gpus = [{ name: 'Apple silicon', vendor: 'apple', vram: null, exact: false, dedicated: true }];
    sources.push('macOS');
  }
  return {
    platform,
    ram: os.totalmem(),
    ramFree: os.freemem(),
    cpu: (cpus[0]?.model || '').replace(/\s+/g, ' ').trim(),
    cores: cpus.length,
    gpus,
    unified,
    sources,
    checkedAt: new Date().toISOString(),
  };
}
