import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { safeEnv } from '../../tools/builtin/shell.js';
import { getJson } from './ollama.js';
import { originOf } from '../../providers/localmodels.js';

/**
 * "Installeren" when Ollama is not on this pc: TeamBot fetches Ollama's official installer, checks that Ollama signed
 * it, runs it silently and waits until Ollama answers. No terminal, no second window, no step after the click.
 *  - Windows: OllamaSetup.exe (installs for this user only, no administrator needed) with /VERYSILENT; the file must
 *    carry a valid Authenticode signature of Ollama.
 *  - macOS: Ollama-darwin.zip, unpacked into ~/Applications; codesign must find a valid signature of Ollama.
 *  - Linux: Ollama's installer needs root (sudo), so there is no silent install: no plan (the download page instead).
 */

export interface InstallPlan {
  url: string;
  /** File name of the download. */
  file: string;
  /** Check what was downloaded before anything runs; false = not Ollama's own, nothing is installed. */
  verify(file: string): Promise<boolean>;
  /** Install silently and wait until the installer is done. */
  install(file: string): Promise<void>;
  /** Start Ollama when the installer did not (it normally does). */
  start(): Promise<void>;
}

export type InstallPhase = 'download' | 'verify' | 'install' | 'start' | 'model' | 'done' | 'error';

export interface InstallState {
  phase: InstallPhase;
  /** Bytes of the installer (download) or of the model (model). */
  received: number;
  total: number;
  /** The model fetched after the install. */
  model?: string;
  error?: string;
  startedAt: string;
}

function run(cmd: string, args: string[], timeoutMs: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, windowsHide: true, env: safeEnv(), maxBuffer: 1024 * 1024 }, (err: any, stdout) =>
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, out: String(stdout || '') }),
    );
  });
}

const detached = (cmd: string, args: string[]) => {
  const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true, env: safeEnv() });
  p.on('error', () => {});
  p.unref();
};

/** The plan for this computer, or null when Ollama cannot be installed without the owner (Linux: root). */
export function ollamaPlan(platform = process.platform): InstallPlan | null {
  if (platform === 'win32') {
    const dir = path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'Ollama');
    return {
      url: 'https://ollama.com/download/OllamaSetup.exe',
      file: 'OllamaSetup.exe',
      async verify(file) {
        const ps = `$s = Get-AuthenticodeSignature -LiteralPath '${file.replace(/'/g, "''")}'; if ($s.Status -eq 'Valid' -and $s.SignerCertificate.Subject -match 'Ollama') { 'ok' } else { [string]$s.Status }`;
        const r = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], 60_000);
        return r.out.trim() === 'ok';
      },
      async install(file) {
        const r = await run(file, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-'], 15 * 60_000);
        if (r.code !== 0) throw new Error(`Het installatieprogramma van Ollama stopte met code ${r.code}.`);
      },
      async start() {
        const app = path.join(dir, 'ollama app.exe');
        if (fs.existsSync(app)) detached(app, []);
        else detached(path.join(dir, 'ollama.exe'), ['serve']);
      },
    };
  }
  if (platform === 'darwin') {
    const apps = path.join(os.homedir(), 'Applications');
    const app = path.join(apps, 'Ollama.app');
    return {
      url: 'https://ollama.com/download/Ollama-darwin.zip',
      file: 'Ollama-darwin.zip',
      async verify(file) {
        // Unpack next to the download and check the app's signature there, before it goes anywhere.
        const tmp = `${file}.check`;
        fs.rmSync(tmp, { recursive: true, force: true });
        if ((await run('ditto', ['-x', '-k', file, tmp], 300_000)).code !== 0) return false;
        const ok = (await run('codesign', ['--verify', '--deep', '--strict', path.join(tmp, 'Ollama.app')], 120_000)).code === 0;
        const who = await new Promise<string>((r) => execFile('codesign', ['-dv', '--verbose=2', path.join(tmp, 'Ollama.app')], (_e, _o, err) => r(String(err || ''))));
        fs.rmSync(tmp, { recursive: true, force: true });
        return ok && /Authority=Developer ID Application: .*Ollama/i.test(who);
      },
      async install(file) {
        fs.mkdirSync(apps, { recursive: true });
        fs.rmSync(app, { recursive: true, force: true });
        const r = await run('ditto', ['-x', '-k', file, apps], 300_000);
        if (r.code !== 0) throw new Error('Ollama uitpakken lukte niet.');
      },
      async start() {
        detached('open', ['-a', app]);
      },
    };
  }
  return null;
}

/** Download `url` to `file`, with progress; a partial file is removed. */
export async function download(url: string, file: string, progress: (received: number, total: number) => void): Promise<void> {
  const r = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(30 * 60_000) });
  if (!r.ok || !r.body) throw new Error(`Downloaden lukte niet (${r.status}).`);
  const total = Number(r.headers.get('content-length')) || 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const out = fs.createWriteStream(file);
  let received = 0;
  let last = 0;
  try {
    const reader = r.body.getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      received += value.length;
      if (!out.write(value)) await new Promise((res) => out.once('drain', res));
      if (Date.now() - last > 300) (last = Date.now()), progress(received, total);
    }
    await new Promise<void>((res, rej) => out.end((e?: Error | null) => (e ? rej(e) : res())));
    progress(received, total || received);
  } catch (e) {
    out.destroy();
    fs.rmSync(file, { force: true });
    throw e;
  }
}

/** Ollama answers at `base` within `ms`. */
export async function ollamaUp(base: string, ms: number): Promise<boolean> {
  for (const end = Date.now() + ms; ; ) {
    const v = await getJson(`${originOf(base)}/api/version`, 1500).catch(() => null);
    if (typeof v?.version === 'string') return true;
    if (Date.now() > end) return false;
    await new Promise((r) => setTimeout(r, 1000));
  }
}

/**
 * Install Ollama with `plan` and wait until it answers at `base`. The installer is removed afterwards. Throws with a
 * plain sentence when a step fails; nothing is run when the download is not Ollama's own.
 */
export async function installOllama(o: { plan: InstallPlan; dir: string; base: string; set(p: Partial<InstallState>): void; waitMs?: number }): Promise<void> {
  const file = path.join(o.dir, o.plan.file);
  try {
    o.set({ phase: 'download', received: 0, total: 0 });
    await download(o.plan.url, file, (received, total) => o.set({ received, total }));
    o.set({ phase: 'verify' });
    if (!(await o.plan.verify(file))) throw new Error('Het gedownloade bestand is niet ondertekend door Ollama; er is niets geïnstalleerd.');
    o.set({ phase: 'install' });
    await o.plan.install(file);
    o.set({ phase: 'start' });
    const wait = o.waitMs ?? 30_000;
    if (!(await ollamaUp(o.base, wait))) {
      await o.plan.start();
      if (!(await ollamaUp(o.base, wait * 2))) throw new Error('Ollama is geïnstalleerd maar start niet. Start Ollama één keer zelf; TeamBot ziet het daarna vanzelf.');
    }
  } finally {
    fs.rmSync(file, { force: true });
  }
}
