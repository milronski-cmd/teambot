import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startProc, type Proc } from './proc.js';

/**
 * Logging in to a CLI from inside TeamBot (C-07); the login always stays with the CLI itself.
 *  - Codex: a device-code flow (`codex login --device-auth`). TeamBot shows the link and the one-time code and waits
 *    until the CLI says it is logged in.
 *  - Claude Code (2.1.319, checked without a terminal): `claude auth login --claudeai` prints a sign-in link and waits
 *    for "Paste code here if prompted". TeamBot shows the link, the person signs in in their own browser (also on the
 *    phone) and pastes the code they get there; TeamBot hands it to the CLI's input once and keeps nothing. The CLI is
 *    started with BROWSER set to a program that only fails, so it never opens a browser itself on this computer.
 *  - OpenCode: no login needed for its free models; `opencode auth login` in a terminal for the rest.
 * The exact terminal command stays available for each (TeamBot can open a terminal with it on this computer).
 */

export type LoginState = 'starting' | 'waiting' | 'done' | 'error' | 'cancelled';

export interface DeviceLogin {
  id: string;
  state: LoginState;
  url?: string;
  code?: string;
  /** The CLI waits for a code the person copies from the sign-in page (Claude Code), instead of showing one. */
  needsCode?: boolean;
  /** A pasted code was handed to the CLI and it is checking it. */
  checking?: boolean;
  error?: string;
  startedAt: string;
}

const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;

/** Link and one-time code from the CLI's device-login text (e.g. "https://auth.openai.com/codex/device" + "ABCD-12345"). */
export function parseDeviceLogin(text: string): { url?: string; code?: string } {
  const t = text.replace(ANSI, '');
  const url = t.match(/https:\/\/[^\s"'<>]+/)?.[0]?.replace(/[).,]+$/, '');
  const code = t.match(/\b([A-Z0-9]{4,5}-[A-Z0-9]{4,6})\b/)?.[1];
  return { url, code };
}

/** CLIs that log in from inside TeamBot, and the arguments for it. */
export const DEVICE_LOGIN: Record<string, string[]> = { 'codex-cli': ['login', '--device-auth'], 'claude-code': ['auth', 'login', '--claudeai'] };

/** CLIs whose sign-in page gives a code to paste back (instead of showing a code to type in on the page). */
export const PASTE_LOGIN = new Set(['claude-code']);

/** Claude Code's sign-in link ("If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?…"). */
export function parsePasteLogin(text: string): { url?: string; prompt: boolean } {
  const t = text.replace(ANSI, '');
  const url = t.match(/https:\/\/[^\s"'<>]*oauth\/authorize[^\s"'<>]*/)?.[0]?.replace(/[).,]+$/, '');
  return { url, prompt: /paste code here/i.test(t) };
}

/**
 * A program that only fails, for the CLI's BROWSER: Claude Code then prints its link instead of opening a browser on
 * this computer (it runs `$BROWSER <url>`, else rundll32/open).
 */
export function noBrowser(platform = process.platform): string {
  if (platform === 'win32') return path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', 'where.exe');
  return ['/usr/bin/false', '/bin/false'].find((p) => fs.existsSync(p)) || '/usr/bin/false';
}

/** A code from the sign-in page: one line of plain characters, never a command or a whole text. */
export const PASTE_CODE = /^[A-Za-z0-9._~#=+/-]{8,2000}$/;

/** The login command a person runs in a terminal, for the binary TeamBot uses. */
export function loginCommand(cliId: string, bin: string | null, fallback: string): string {
  const quoted = bin ? (/\s/.test(bin) ? `"${bin}"` : bin) : null;
  const call = quoted && process.platform === 'win32' && quoted.startsWith('"') ? `& ${quoted}` : quoted;
  if (cliId === 'claude-code' && call) return `${call} auth login`;
  if (cliId === 'opencode' && call) return `${call} auth login`;
  if (cliId === 'codex-cli' && call) return `${call} login`;
  return fallback;
}

/**
 * Open a terminal window on this computer that runs `command` (desktop mode only; the person finishes the login
 * there). Returns false when no terminal could be started.
 */
export function openTerminal(command: string, platform = process.platform, run: typeof spawn = spawn): boolean {
  try {
    if (platform === 'win32') {
      // (lower case: PowerShell does not mind, and it keeps this command out of the interface texts)
      run('powershell.exe', ['-NoProfile', '-Command', `start-process powershell -argumentlist '-noexit','-command',${psQuote(command)}`], { windowsHide: true, detached: true, stdio: 'ignore' }).unref();
      return true;
    }
    if (platform === 'darwin') {
      run('osascript', ['-e', `tell application "Terminal" to do script ${JSON.stringify(command)}`, '-e', 'tell application "Terminal" to activate'], { detached: true, stdio: 'ignore' }).unref();
      return true;
    }
    run('x-terminal-emulator', ['-e', 'sh', '-c', `${command}; exec "\${SHELL:-sh}"`], { detached: true, stdio: 'ignore', cwd: os.homedir() }).unref();
    return true;
  } catch {
    return false;
  }
}

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;

/** Running device logins, one per CLI. */
export class DeviceLogins {
  private runs = new Map<string, { login: DeviceLogin; proc: Proc; ctl: AbortController }>();

  get(id: string): DeviceLogin | null {
    return this.runs.get(id)?.login || null;
  }

  /**
   * Start `<bin> <args>` and resolve as soon as the link and code are known (or the CLI ended). `onEnd` gets the final
   * state when the CLI exits (done = exit code 0).
   */
  start(id: string, bin: string, args: string[], onEnd: (l: DeviceLogin) => void, timeoutMs = 15 * 60_000): Promise<DeviceLogin> {
    this.cancel(id);
    const paste = PASTE_LOGIN.has(id);
    const login: DeviceLogin = { id, state: 'starting', startedAt: new Date().toISOString(), ...(paste ? { needsCode: true } : {}) };
    const ctl = new AbortController();
    let text = '';
    let resolveFirst!: (l: DeviceLogin) => void;
    const first = new Promise<DeviceLogin>((r) => (resolveFirst = r));
    const seen = (s: string) => {
      text = (text + s).slice(-20_000);
      if (paste) {
        // The link is enough: the prompt for the code comes on the same output without a line end.
        const p = parsePasteLogin(text);
        if (p.url && !login.url) login.url = p.url;
      } else {
        const p = parseDeviceLogin(text);
        if (p.url && !login.url) login.url = p.url;
        if (p.code && !login.code) login.code = p.code;
      }
      if (login.url && (paste || login.code) && login.state === 'starting') {
        login.state = 'waiting';
        resolveFirst({ ...login });
      }
    };
    // No Job Object (job: false): a login may open the owner's own browser, which must outlive the login.
    const proc = startProc({ bin, args, cwd: os.tmpdir(), env: { NO_COLOR: '1', ...(paste ? { BROWSER: noBrowser() } : {}) }, signal: ctl.signal, timeoutMs, idleMs: timeoutMs, job: false, onLine: (l) => seen(l + '\n'), onStderr: seen });
    // A device login needs no input; a paste login keeps its input open for the code.
    if (!paste) proc.end();
    this.runs.set(id, { login, proc, ctl });
    proc.done.then((r) => {
      if (login.state === 'cancelled') return;
      const plain = text.replace(ANSI, '');
      if (r.code === 0 && !/error|failed|expired/i.test(plain.split('\n').slice(-3).join(' '))) login.state = 'done';
      else {
        login.state = 'error';
        // Never the link or anything code-like back on screen; the prompt text says nothing either.
        const tail = plain.replace(/paste code here( if prompted)?\s*>\s*/gi, '').replace(/https:\/\/\S+/g, '').replace(/[A-Za-z0-9._~#=+/-]{24,}/g, '…').trim().split('\n').slice(-2).join(' ').slice(0, 300);
        login.error = proc.killedReason?.startsWith('Time-out')
          ? 'De code is verlopen. Probeer het opnieuw.'
          : paste && login.checking
            ? // Without the CLI's own English lines about the browser and the OAuth error (Q-03).
              'De code werd niet geaccepteerd. Begin opnieuw met "Hier inloggen" en plak de nieuwe code.'
            : r.error || tail || `De CLI stopte (exitcode ${r.code}).`;
      }
      login.checking = undefined;
      resolveFirst({ ...login });
      onEnd({ ...login });
    });
    // Do not wait forever for the code: after 30 s show what is there.
    setTimeout(() => resolveFirst({ ...login }), 30_000).unref();
    return first;
  }

  /**
   * Hand the code the person copied from the sign-in page to the waiting CLI (once; TeamBot keeps no copy). The CLI
   * then ends on its own: logged in, or with its error (shown as the login's error).
   */
  submit(id: string, code: string): DeviceLogin {
    const r = this.runs.get(id);
    if (!r || !r.login.needsCode || r.login.state !== 'waiting') throw new Error('Er wacht geen inlogpoging op een code. Begin opnieuw met "Hier inloggen".');
    const c = String(code || '').trim();
    if (!PASTE_CODE.test(c)) throw new Error('Dat lijkt geen code van de inlogpagina. Kopieer de hele code en plak hem hier.');
    if (r.login.checking) throw new Error('De code wordt al gecontroleerd.');
    r.login.checking = true;
    r.proc.write(c + '\n');
    return { ...r.login };
  }

  cancel(id: string) {
    const r = this.runs.get(id);
    if (!r) return;
    if (r.login.state === 'starting' || r.login.state === 'waiting') {
      r.login.state = 'cancelled';
      r.ctl.abort();
    }
    this.runs.delete(id);
  }

  stopAll() {
    for (const id of [...this.runs.keys()]) this.cancel(id);
  }
}
