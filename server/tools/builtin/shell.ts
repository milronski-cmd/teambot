import { type ChildProcess, spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Agent, ToolDef } from '../../core/types.js';
import { agentRoots, resolveInWorkspace, wholeComputer } from './files.js';
import { commandPaths, shellCommandImpact, shellCommandRisk } from './command-risk.js';
import { words } from '../../../shared/i18n-core.js';

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|PRIVATE)/i;
/**
 * How long one command may run. No fixed brake (a build, a test run or an install takes what it takes): ten minutes
 * unless the bot asks for more, and it may ask up to a day. A command that hangs (waits for input) ends at its limit;
 * the owner can stop it any time.
 */
export const COMMAND_DEFAULT_SEC = 600;
export const COMMAND_MAX_SEC = 86_400;
/** Output for the model: the first and last part of very long output (the middle of a build log is rarely needed). */
const OUTPUT_MAX = 100_000;

export function safeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('TEAMBOT_')) continue;
    if (SECRET_ENV.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

export type ProcessResult = { code: number | null; output: string; timedOut: boolean };

/**
 * Runs a started process to its end: its output (stdout and stderr, the first 400 000 characters), stopped with its
 * children at `timeoutMs` or when `signal` aborts. `start` is called inside; `startError` says in words that it could
 * not start (the error event); `spawnError`, when given, also turns a start that throws into such a result.
 */
export function waitForProcess(
  start: () => ChildProcess,
  opts: { timeoutMs: number; signal: AbortSignal; onData?: (s: string) => void; startError(e: any): string; spawnError?(e: any): string },
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    let child: ChildProcess;
    if (opts.spawnError) {
      try {
        child = start();
      } catch (e: any) {
        return resolve({ code: -1, output: `[${opts.spawnError(e)}]`, timedOut: false });
      }
    } else child = start();
    let out = '';
    let timedOut = false;
    const add = (b: Buffer) => {
      const s = b.toString('utf8');
      if (out.length < 400_000) out += s;
      opts.onData?.(s);
    };
    child.stdout?.on('data', add);
    child.stderr?.on('data', add);
    const kill = () => {
      try {
        if (isWin && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true });
        else child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, opts.timeoutMs);
    opts.signal.addEventListener('abort', kill, { once: true });
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: -1, output: out + `\n[${opts.startError(e)}]`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out, timedOut });
    });
  });
}

export function runProcess(command: string, opts: { cwd: string; timeoutMs: number; signal: AbortSignal; env?: NodeJS.ProcessEnv; onData?: (s: string) => void }): Promise<ProcessResult> {
  const start = () =>
    process.platform === 'win32'
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`], { cwd: opts.cwd, env: opts.env, windowsHide: true })
      : spawn('bash', ['-lc', command], { cwd: opts.cwd, env: opts.env });
  return waitForProcess(start, { ...opts, startError: (e) => `fout bij starten: ${e.message}` });
}

/**
 * "Eigen werkplek": what a command names outside the bot's folders (its werkplek, extra folders, the team folder, temp
 * and the system's program folders), for the line on the card. Deciding about it is the gate's (tools/gate.ts).
 */
function outsideOf(a: any, agent: Agent): string[] {
  try {
    const roots = agentRoots(agent);
    const cwd = a?.cwd ? resolveInWorkspace(agent, String(a.cwd)) : roots[0];
    return commandPaths(String(a?.command || ''), { roots, cwd, whole: wholeComputer(agent) }).outside;
  } catch {
    return [];
  }
}

/**
 * TeamBot's own terminal. The permission gate (tools/gate.ts) reads every command before it runs, like a command of a
 * CLI engine: a command that wipes the disk or names key folders, TeamBot's data or a folder the owner closed is refused
 * before any card; one that names a path outside the bot's folders asks first on every level (a card without "Altijd
 * toestaan"); sending, publishing, pushing or deleting outside the Prullenbak asks (command-risk.ts, read by the
 * broker through `riskFor`/`impact`). `dataDir` is no longer needed here (the gate has it).
 */
export function shellTools(_o: { dataDir?: () => string } = {}): ToolDef[] {
  return [
    {
      name: 'run_command',
      group: 'shell',
      risk: 'exec',
      // Sending, publishing, pushing or deleting outside the Prullenbak asks a human, also in "Automatisch"
      // (command-risk.ts). In "Volledige toegang" a local delete runs; anything outward still asks.
      riskFor: (a) => shellCommandRisk(String(a?.command || '')),
      impact: (a) => shellCommandImpact(String(a?.command || '')),
      description:
        process.platform === 'win32'
          ? 'Voer een PowerShell-opdracht uit in de werkmap van deze bot. Geeft uitvoer en exitcode terug. Gebruik dit voor build/test/scripts.'
          : 'Voer een bash-opdracht uit in de werkmap van deze bot. Geeft uitvoer en exitcode terug.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Submap van de werkmap (optioneel)' },
          timeout_sec: { type: 'number', description: 'Max looptijd in seconden (standaard 600; geef meer voor een lange build of test, tot 86400)' },
        },
        required: ['command'],
      },
      // The exact command on the card (up to 1500 characters), where it runs, and what it reaches outside the werkplek.
      summarize: (a, t) => {
        const out = t?.agent ? outsideOf(a, t.agent) : [];
        const cmd = String(a.command).slice(0, 1500);
        const base = a.cwd ? words('Opdracht: {0} (in {1})', cmd, String(a.cwd).slice(0, 200)) : words('Opdracht: {0}', cmd);
        return out.length ? words('{0} — buiten de werkplek van de bot: {1}', base, out.slice(0, 3).join(', ')) : base;
      },
      async run(a, t) {
        const cmd = String(a.command || '');
        const cwd = a.cwd ? resolveInWorkspace(t.agent, a.cwd) : agentRoots(t.agent)[0];
        fs.mkdirSync(cwd, { recursive: true });
        const timeoutMs = Math.min(COMMAND_MAX_SEC, Math.max(1, Number(a.timeout_sec) || COMMAND_DEFAULT_SEC)) * 1000;
        let lastProgress = 0;
        // The bot's "Sleutels voor scripts" (module script-keys) under the names the owner chose. The owner's key values
        // are hidden in the live output (scrubbed on what came in so far, so a value split over two pieces never shows)
        // and in the result before it is shortened (executeTool scrubs once more).
        const keys = t.ctx.services.scriptKeys;
        const extra: Record<string, string> = keys?.envFor?.(t.agent, { tool: 'run_command' }) || {};
        const hide = typeof keys?.scrubLive === 'function' ? keys : null;
        let seen = '';
        const r = await runProcess(cmd, {
          cwd,
          timeoutMs,
          signal: t.signal,
          env: safeEnv(extra),
          onData: (s) => {
            if (hide) seen = (seen + s).slice(-20_000);
            if (Date.now() - lastProgress > 1000) {
              lastProgress = Date.now();
              t.progress(hide ? String(hide.scrubLive(t.agent.user_id, seen)).slice(-300) : s.slice(-300));
            }
          },
        });
        t.ctx.audit(t.userId, 'shell.run', { command: cmd.slice(0, 500), code: r.code, cwd }, t.agent.id);
        let output = hide ? String(hide.scrub(t.agent.user_id, r.output)) : r.output;
        if (output.length > OUTPUT_MAX) output = output.slice(0, OUTPUT_MAX / 2) + `\n… (${output.length - OUTPUT_MAX} tekens weggelaten) …\n` + output.slice(-OUTPUT_MAX / 2);
        const late = r.timedOut ? ` (time-out na ${Math.round(timeoutMs / 1000)} s; geef timeout_sec mee als dit langer mag duren)` : '';
        return { text: `exitcode: ${r.code}${late}\n${output || '(geen uitvoer)'}`, isError: r.code !== 0 };
      },
    },
  ];
}
