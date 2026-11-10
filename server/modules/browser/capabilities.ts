import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Runtime capability detection (plan §14 / §26 truth table). Every probe fails closed:
 * errors, time-outs and unknown states count as "not available". Nothing here ever
 * installs or enables a feature (e.g. we never run `wsl --install`).
 */

export type CapStatus = 'available' | 'missing' | 'unsupported' | 'unknown';

export interface Capability {
  id: string;
  label: string;
  status: CapStatus;
  detail: string;
  /** What the user can do about it (Dutch, plain language). */
  howTo?: string;
  /** Is this an isolation boundary (VM/container) or just process permissions? */
  isolation: 'vm' | 'container' | 'none' | 'process';
  path?: string;
}

export interface BrowserInfo {
  name: 'Microsoft Edge' | 'Google Chrome' | 'Chromium';
  path: string;
}

export interface Capabilities {
  platform: NodeJS.Platform;
  osName: string;
  edition: string;
  isWindowsHome: boolean;
  appMode: 'desktop' | 'server';
  detectedAt: string;
  browsers: BrowserInfo[];
  caps: Record<string, Capability>;
}

export interface Probes {
  platform(): NodeJS.Platform;
  exists(p: string): boolean;
  run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number | null; stdout: string; stderr: string; timedOut: boolean }>;
  env(name: string): string | undefined;
}

export const realProbes: Probes = {
  platform: () => process.platform,
  exists: (p) => {
    try {
      return fs.existsSync(p);
    } catch {
      return false;
    }
  },
  env: (n) => process.env[n],
  run: (cmd, args, timeoutMs) =>
    new Promise((resolve) => {
      try {
        execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, encoding: 'buffer', maxBuffer: 2_000_000 }, (err: any, stdout: Buffer, stderr: Buffer) => {
          resolve({
            code: err ? (typeof err.code === 'number' ? err.code : -1) : 0,
            stdout: decode(stdout),
            stderr: decode(stderr),
            timedOut: !!err?.killed,
          });
        });
      } catch (e: any) {
        resolve({ code: -1, stdout: '', stderr: String(e?.message || e), timedOut: false });
      }
    }),
};

/** wsl.exe writes UTF-16LE; most tools write UTF-8. */
function decode(b: Buffer | string | undefined): string {
  if (!b) return '';
  if (typeof b === 'string') return b;
  if (b.length >= 2 && b[1] === 0 && b[0] !== 0) return b.toString('utf16le').replace(/\0/g, '');
  return b.toString('utf8');
}

export function browserCandidates(p: Probes): BrowserInfo[] {
  const out: BrowserInfo[] = [];
  const add = (name: BrowserInfo['name'], file: string | undefined) => {
    if (file && p.exists(file) && !out.some((b) => b.path.toLowerCase() === file.toLowerCase())) out.push({ name, path: file });
  };
  const custom = p.env('TEAMBOT_BROWSER_PATH');
  if (custom) add(/edge/i.test(custom) ? 'Microsoft Edge' : /chrom(e|ium)/i.test(custom) ? 'Google Chrome' : 'Chromium', custom);
  const plat = p.platform();
  if (plat === 'win32') {
    const pf = p.env('ProgramFiles') || 'C:\\Program Files';
    const pf86 = p.env('ProgramFiles(x86)') || 'C:\\Program Files (x86)';
    const local = p.env('LOCALAPPDATA') || path.join(os.homedir(), 'AppData', 'Local');
    add('Microsoft Edge', path.win32.join(pf, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    add('Microsoft Edge', path.win32.join(pf86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'));
    add('Google Chrome', path.win32.join(pf, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    add('Google Chrome', path.win32.join(pf86, 'Google', 'Chrome', 'Application', 'chrome.exe'));
    add('Google Chrome', path.win32.join(local, 'Google', 'Chrome', 'Application', 'chrome.exe'));
  } else if (plat === 'darwin') {
    add('Google Chrome', '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    add('Microsoft Edge', '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge');
    add('Chromium', '/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const f of ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome']) add('Google Chrome', f);
    for (const f of ['/usr/bin/microsoft-edge', '/usr/bin/microsoft-edge-stable', '/opt/microsoft/msedge/msedge']) add('Microsoft Edge', f);
    for (const f of ['/usr/bin/chromium', '/usr/bin/chromium-browser', '/snap/bin/chromium']) add('Chromium', f);
  }
  return out;
}

async function windowsEdition(p: Probes): Promise<{ edition: string; product: string }> {
  const r = await p.run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'EditionID'], 5000);
  const r2 = await p.run('reg', ['query', 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion', '/v', 'ProductName'], 5000);
  const edition = r.stdout.match(/EditionID\s+REG_SZ\s+(.+)/)?.[1]?.trim() || '';
  let product = r2.stdout.match(/ProductName\s+REG_SZ\s+(.+)/)?.[1]?.trim() || '';
  // Windows 11 still reports "Windows 10" in ProductName; the build number tells the truth.
  const rel = os.release().split('.');
  if (/Windows 10/.test(product) && Number(rel[2]) >= 22000) product = product.replace('Windows 10', 'Windows 11');
  return { edition, product };
}

/**
 * `inApp`: the desktop app hosts the bot browsers itself (server/modules/browser/inapp.ts), so a bot has its own
 * browser right after installing, also without Edge or Chrome. An installed Edge/Chrome stays the alternative.
 */
export async function detectCapabilities(p: Probes = realProbes, appMode: 'desktop' | 'server' = 'desktop', o: { inApp?: boolean } = {}): Promise<Capabilities> {
  const plat = p.platform();
  const caps: Record<string, Capability> = {};
  let osName = `${plat} ${os.release()}`;
  let edition = '';
  let isHome = false;
  const sys32 = path.win32.join(p.env('WINDIR') || 'C:\\Windows', 'System32');

  if (plat === 'win32') {
    const e = await windowsEdition(p);
    edition = e.edition;
    osName = e.product || 'Windows';
    isHome = /^core/i.test(edition) || /home/i.test(e.product);
  }

  // --- browsers ---
  const browsers = browserCandidates(p);
  caps.browser = o.inApp
    ? { id: 'browser', label: 'Eigen browser per bot', status: 'available', detail: 'Ingebouwd in TeamBot: elke bot heeft onzichtbare eigen tabbladen in de app.', isolation: 'process' }
    : browsers.length
    ? { id: 'browser', label: 'Eigen browser per bot', status: 'available', detail: `${browsers[0].name} gevonden`, path: browsers[0].path, isolation: 'process' }
    : {
        id: 'browser',
        label: 'Eigen browser per bot',
        status: 'missing',
        detail: 'Geen Microsoft Edge, Google Chrome of Chromium gevonden.',
        howTo: 'Installeer Edge of Chrome, of zet TEAMBOT_BROWSER_PATH naar een Chromium-browser.',
        isolation: 'process',
      };

  // --- Hyper-V ---
  if (plat !== 'win32') caps.hyperv = { id: 'hyperv', label: 'Hyper-V', status: 'unsupported', detail: 'Alleen op Windows.', isolation: 'vm' };
  else if (isHome)
    caps.hyperv = {
      id: 'hyperv',
      label: 'Hyper-V',
      status: 'unsupported',
      detail: 'Hyper-V bestaat niet op Windows Home.',
      howTo: 'TeamBot heeft Hyper-V niet nodig: een afgeschermde bot draait in Docker Desktop, en dat werkt ook op Windows Home (via WSL2).',
      isolation: 'vm',
    };
  else {
    const r = await p.run('sc', ['query', 'vmms'], 5000);
    caps.hyperv =
      r.code === 0 && /STATE/i.test(r.stdout)
        ? { id: 'hyperv', label: 'Hyper-V', status: 'available', detail: 'Hyper-V-dienst (vmms) gevonden. TeamBot start zelf geen Hyper-V-VM’s; een afgeschermde bot draait in Docker.', isolation: 'vm' }
        : { id: 'hyperv', label: 'Hyper-V', status: 'missing', detail: 'Hyper-V is niet ingeschakeld.', howTo: 'Schakel Hyper-V in via "Windows-onderdelen in- of uitschakelen" (vereist virtualisatie in BIOS).', isolation: 'vm' };
  }

  // --- Windows Sandbox ---
  if (plat !== 'win32') caps.sandbox = { id: 'sandbox', label: 'Windows Sandbox', status: 'unsupported', detail: 'Alleen op Windows.', isolation: 'vm' };
  else if (isHome) caps.sandbox = { id: 'sandbox', label: 'Windows Sandbox', status: 'unsupported', detail: 'Windows Sandbox bestaat niet op Windows Home.', howTo: 'TeamBot heeft Windows Sandbox niet nodig: een afgeschermde bot draait in Docker Desktop.', isolation: 'vm' };
  else
    caps.sandbox = p.exists(path.win32.join(sys32, 'WindowsSandbox.exe'))
      ? { id: 'sandbox', label: 'Windows Sandbox', status: 'available', detail: 'Aanwezig. TeamBot start zelf geen Windows Sandbox; een afgeschermde bot draait in Docker.', isolation: 'vm' }
      : { id: 'sandbox', label: 'Windows Sandbox', status: 'missing', detail: 'Niet ingeschakeld.', howTo: 'Schakel "Windows Sandbox" in via Windows-onderdelen.', isolation: 'vm' };

  // --- WSL2 (never triggers an install). The inbox wsl.exe is only an installer stub when neither the
  // WslService (Store WSL) nor LxssManager (inbox WSL) exists; we then do not start it at all. ---
  const wslMissing: Capability = {
    id: 'wsl',
    label: 'WSL2',
    status: 'missing',
    detail: 'WSL is niet geïnstalleerd (alleen de opstarthulp is aanwezig).',
    howTo: 'Installeer WSL met "wsl --install" in een beheerdersvenster als je Docker Desktop wilt gebruiken.',
    isolation: 'none',
  };
  const wslService = plat === 'win32' && ((await p.run('sc', ['query', 'WslService'], 4000)).code === 0 || (await p.run('sc', ['query', 'LxssManager'], 4000)).code === 0);
  if (plat !== 'win32') caps.wsl = { id: 'wsl', label: 'WSL2', status: 'unsupported', detail: 'Alleen op Windows.', isolation: 'none' };
  else if (!p.exists(path.win32.join(sys32, 'wsl.exe'))) caps.wsl = { ...wslMissing, detail: 'wsl.exe ontbreekt.' };
  else if (!wslService) caps.wsl = wslMissing;
  else {
    const r = await p.run(path.win32.join(sys32, 'wsl.exe'), ['--status'], 6000);
    const text = (r.stdout + '\n' + r.stderr).trim();
    if (r.timedOut) caps.wsl = { id: 'wsl', label: 'WSL2', status: 'unknown', detail: 'WSL reageerde niet binnen 6 seconden.', isolation: 'none' };
    else if (r.code === 0 && !/REGDB_E_CLASSNOTREG|not installed|niet geïnstalleerd/i.test(text))
      caps.wsl = { id: 'wsl', label: 'WSL2', status: 'available', detail: 'WSL is geïnstalleerd. Let op: WSL is geen afgeschermde omgeving (het kan bij je Windows-bestanden).', isolation: 'none' };
    else
      caps.wsl = {
        id: 'wsl',
        label: 'WSL2',
        status: 'missing',
        detail: 'WSL is niet geïnstalleerd (alleen de opstarthulp is aanwezig).',
        howTo: 'Installeer WSL met "wsl --install" in een beheerdersvenster als je Docker Desktop wilt gebruiken.',
        isolation: 'none',
      };
  }

  // --- Docker ---
  {
    const r = await p.run('docker', ['version', '--format', '{{.Server.Version}}'], 6000);
    const v = r.stdout.trim();
    if (r.code === 0 && /^\d/.test(v)) caps.docker = { id: 'docker', label: 'Docker (container)', status: 'available', detail: `Docker ${v} draait.`, isolation: 'container' };
    else if (r.code === 0 || /daemon|pipe|socket|connect/i.test(r.stderr))
      caps.docker = { id: 'docker', label: 'Docker (container)', status: 'missing', detail: 'Docker is geïnstalleerd maar draait niet.', howTo: 'Start Docker Desktop (of de docker-dienst).', isolation: 'container' };
    else
      caps.docker = {
        id: 'docker',
        label: 'Docker (container)',
        status: 'missing',
        detail: 'Docker is niet gevonden.',
        howTo: plat === 'win32' ? 'Installeer Docker Desktop (werkt op Windows 11 Home via WSL2).' : 'Installeer Docker Engine.',
        isolation: 'container',
      };
  }

  // --- host desktop control ---
  if (plat === 'win32') {
    const ps = p.exists(path.win32.join(sys32, 'WindowsPowerShell', 'v1.0', 'powershell.exe'));
    caps.host = ps
      ? { id: 'host', label: 'Mijn bureaublad bedienen', status: 'available', detail: 'Mogelijk via Windows (PowerShell + UI Automation). Staat standaard uit; per bot en per app aanzetten.', isolation: 'none' }
      : { id: 'host', label: 'Mijn bureaublad bedienen', status: 'missing', detail: 'Windows PowerShell ontbreekt.', isolation: 'none' };
  } else
    caps.host = {
      id: 'host',
      label: 'Mijn bureaublad bedienen',
      status: 'unsupported',
      detail: plat === 'darwin' ? 'Bureaubladbediening kan alleen op Windows, niet op macOS.' : 'Bureaubladbediening kan alleen op Windows, niet op Linux (X11/Wayland).',
      isolation: 'none',
    };

  // --- visible window for takeover ---
  caps.visible =
    appMode === 'desktop'
      ? { id: 'visible', label: 'Zichtbaar browservenster', status: 'available', detail: 'De browser van een bot kan als venster op dit bureaublad openen om over te nemen of in te loggen.', isolation: 'process' }
      : { id: 'visible', label: 'Zichtbaar browservenster', status: 'unsupported', detail: 'De server draait niet op jouw bureaublad. Overnemen kan via het live scherm (klikken en typen in het voorbeeld).', isolation: 'process' };

  return { platform: plat, osName, edition, isWindowsHome: isHome, appMode, detectedAt: new Date().toISOString(), browsers, caps };
}

/** Which isolated runtime (if any) TeamBot can actually drive. Only Docker is implemented. */
export function isolatedRuntime(c: Capabilities): { available: boolean; runtime: 'docker' | null; missing: string[] } {
  if (c.caps.docker?.status === 'available') return { available: true, runtime: 'docker', missing: [] };
  const missing = ['docker', 'hyperv', 'sandbox', 'wsl'].map((k) => c.caps[k]).filter(Boolean).map((x) => `${x.label}: ${x.detail}`);
  return { available: false, runtime: null, missing };
}

export type ModeId = 'none' | 'workspace' | 'browser' | 'host' | 'container' | 'remote';

export interface ModeInfo {
  id: ModeId;
  label: string;
  description: string;
  available: boolean;
  isolation: string;
  missing?: string[];
}

/** The truth table shown in the UI: what each computer mode means on this device. */
export function modeTable(c: Capabilities, opts: { isOwner: boolean }): ModeInfo[] {
  const iso = isolatedRuntime(c);
  return [
    { id: 'none', label: 'Geen computer', description: 'De bot praat alleen; geen bestanden, terminal of browser.', available: true, isolation: 'Niet van toepassing' },
    {
      id: 'workspace',
      label: 'Alleen werkmap',
      description: 'Lezen en schrijven in één map. Dit is géén afgeschermde omgeving: de map staat gewoon op deze computer.',
      available: true,
      isolation: 'Geen (alleen mapgrenzen en toestemmingen)',
    },
    {
      id: 'browser',
      label: 'Eigen browser',
      description: 'Een eigen browser met een eigen profiel per bot (nooit jouw browserprofiel), plus de werkmap.',
      available: c.caps.browser.status === 'available',
      isolation: 'Apart browserprofiel en Chromium-sandbox; geen VM',
      missing: c.caps.browser.status === 'available' ? undefined : [c.caps.browser.detail],
    },
    {
      id: 'host',
      label: 'Mijn bureaublad',
      description: 'De bot bedient toegestane apps op dit bureaublad. Jij kiest hoeveel hij mag: vragen bij elke actie, één keer per taak of volledige toegang.',
      available: c.caps.host.status === 'available' && opts.isOwner,
      isolation: 'Geen — de bot werkt op je echte bureaublad',
      missing: c.caps.host.status !== 'available' ? [c.caps.host.detail] : !opts.isOwner ? ['Alleen de eigenaar van deze computer mag dit aanzetten.'] : undefined,
    },
    {
      id: 'container',
      label: 'Privé-container / VM',
      description: 'Opdrachten draaien in een afgeschermde container met de werkmap als enige gedeelde map.',
      available: iso.available,
      isolation: iso.available ? 'Container (Docker)' : 'Niet beschikbaar op dit apparaat',
      missing: iso.available ? undefined : iso.missing,
    },
    {
      id: 'remote',
      label: 'Eigen server (SSH)',
      description: 'De bot werkt via SSH op jouw eigen server of VPS (Linux of macOS), of op een cloud-VM die TeamBot voor je aanmaakt (Hetzner of DigitalOcean, ook met GPU). Opdrachten draaien met de rechten van die SSH-gebruiker.',
      available: true,
      isolation: 'Een andere machine; verder alleen de rechten van die SSH-gebruiker (of Docker op de server)',
    },
  ];
}
