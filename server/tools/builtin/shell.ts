import { spawn } from 'node:child_process';
import fs from 'node:fs';
import type { Agent, ToolDef } from '../../core/types.js';
import { agentRoots, resolveInWorkspace, wholeComputer } from './files.js';
import { commandPaths, shellCommandImpact, shellCommandRisk } from './command-risk.js';

const SECRET_ENV = /(KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|COOKIE|SESSION|PRIVATE)/i;
/** Hard blocklist that applies in every mode (even auto / always-allow). */
const HARDLINE = [
  /\bformat\s+[a-z]:/i,
  /\brm\s+-rf\s+(\/|~|\$HOME)(\s|$)/i,
  /Remove-Item\s+.*-Recurse.*\s+(C:\\|~|\$env:USERPROFILE)\s*$/i,
  /\bmkfs\./i,
  /\bdd\s+if=.*of=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bshutdown\b|\bStop-Computer\b|\bRestart-Computer\b/i,
  /\bvssadmin\s+delete\b|\bbcdedit\b|\bcipher\s+\/w/i,
];

export function safeEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (k.startsWith('TEAMBOT_')) continue;
    if (SECRET_ENV.test(k)) continue;
    env[k] = v;
  }
  return { ...env, ...extra };
}

export function runProcess(
  command: string,
  opts: { cwd: string; timeoutMs: number; signal: AbortSignal; env?: NodeJS.ProcessEnv; onData?: (s: string) => void },
): Promise<{ code: number | null; output: string; timedOut: boolean }> {
  return new Promise((resolve) => {
    const isWin = process.platform === 'win32';
    const child = isWin
      ? spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', `[Console]::OutputEncoding=[Text.Encoding]::UTF8; ${command}`], { cwd: opts.cwd, env: opts.env, windowsHide: true })
      : spawn('bash', ['-lc', command], { cwd: opts.cwd, env: opts.env });
    let out = '';
    let timedOut = false;
    const add = (b: Buffer) => {
      const s = b.toString('utf8');
      if (out.length < 400_000) out += s;
      opts.onData?.(s);
    };
    child.stdout.on('data', add);
    child.stderr.on('data', add);
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
      resolve({ code: -1, output: out + `\n[fout bij starten: ${e.message}]`, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, output: out, timedOut });
    });
  });
}

/**
 * "Eigen werkplek": what a command reaches outside the bot's folders (its werkplek, extra folders, the team folder,
 * temp and the system's program folders). Best effort, like the CLI gate (command-risk.ts commandPaths).
 */
function reach(a: any, agent: Agent, dataDir?: string): { outside: string[]; keys: string[] } {
  try {
    const roots = agentRoots(agent);
    const cwd = a?.cwd ? resolveInWorkspace(agent, String(a.cwd)) : roots[0];
    return commandPaths(String(a?.command || ''), { roots, cwd, dataDir, whole: wholeComputer(agent) });
  } catch {
    return { outside: [], keys: [] };
  }
}

export function shellTools(o: { dataDir?: () => string } = {}): ToolDef[] {
  const dataDir = () => {
    try {
      return o.dataDir?.();
    } catch {
      return undefined;
    }
  };
  return [
    {
      name: 'run_command',
      group: 'shell',
      risk: 'exec',
      // Sending, publishing, pushing or deleting outside the Prullenbak asks a human, also in "Automatisch"
      // (command-risk.ts). In "Volledige toegang" a local delete runs; anything outward still asks. The bot works in
      // its own werkplek: a command that names a path outside its folders asks first in every mode (like the CLI
      // gate), one that names key folders or TeamBot's own data is refused before any card.
      riskFor: (a, t) => (reach(a, t.agent).outside.length ? 'danger' : shellCommandRisk(String(a?.command || ''))),
      impact: (a, agent) => (reach(a, agent).outside.length ? 'external' : shellCommandImpact(String(a?.command || ''))),
      refuse: (a, t) => {
        const r = reach(a, t.agent, dataDir());
        return r.keys.length ? `Geweigerd door TeamBot: deze opdracht gebruikt een beschermde map of beschermd bestand (sleutels, inloggegevens of de gegevens van TeamBot): ${r.keys.slice(0, 3).join(', ')}` : null;
      },
      description:
        process.platform === 'win32'
          ? 'Voer een PowerShell-opdracht uit in de werkmap van deze bot. Geeft uitvoer en exitcode terug. Gebruik dit voor build/test/scripts.'
          : 'Voer een bash-opdracht uit in de werkmap van deze bot. Geeft uitvoer en exitcode terug.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string', description: 'Submap van de werkmap (optioneel)' },
          timeout_sec: { type: 'number', description: 'Max looptijd in seconden (standaard 120, max 1800)' },
        },
        required: ['command'],
      },
      // The exact command on the card (up to 1500 characters), where it runs, and what it reaches outside the werkplek.
      summarize: (a, t) => {
        const out = t?.agent ? reach(a, t.agent).outside : [];
        const base = `Opdracht: ${String(a.command).slice(0, 1500)}${a.cwd ? ` (in ${String(a.cwd).slice(0, 200)})` : ''}`;
        return out.length ? `${base} — ${`buiten de werkplek van de bot: ${out.slice(0, 3).join(', ')}`}` : base;
      },
      async run(a, t) {
        const cmd = String(a.command || '');
        if (HARDLINE.some((r) => r.test(cmd))) return { text: 'Geweigerd: deze opdracht staat op de vaste blokkeerlijst (systeembrede schade).', isError: true };
        const guarded = reach(a, t.agent, t.ctx.config?.dataDir).keys;
        if (guarded.length) return { text: `Geweigerd door TeamBot: deze opdracht gebruikt een beschermde map of beschermd bestand (sleutels, inloggegevens of de gegevens van TeamBot): ${guarded.slice(0, 3).join(', ')}`, isError: true };
        const cwd = a.cwd ? resolveInWorkspace(t.agent, a.cwd) : agentRoots(t.agent)[0];
        fs.mkdirSync(cwd, { recursive: true });
        const timeoutMs = Math.min(1800, Math.max(1, Number(a.timeout_sec) || 120)) * 1000;
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
        if (output.length > 30_000) output = output.slice(0, 12_000) + `\n… (${output.length - 24_000} tekens weggelaten) …\n` + output.slice(-12_000);
        return { text: `exitcode: ${r.code}${r.timedOut ? ' (time-out)' : ''}\n${output || '(geen uitvoer)'}`, isError: r.code !== 0 };
      },
    },
  ];
}
