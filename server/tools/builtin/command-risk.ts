import os from 'node:os';
import path from 'node:path';
import type { ToolImpact, ToolRisk } from '../../core/types.js';
import { isInside as within, KEY_PATH } from './files.js';

/**
 * Risk of one shell command for TeamBot's own terminal tool (run_command): approval only where it counts. A command
 * that sends, publishes, pushes or deletes outside the Prullenbak is "danger" (asks a human, also in "Automatisch");
 * everything else is a normal "exec". Same list as the CLI permission gate (server/modules/cli-agents/permissions.ts
 * DANGER_CMD), plus deleting single files: a shell delete bypasses the trash, so it is never a silent, reversible
 * change. Best effort: a command can hide what it does; the terminal tool stays off by default.
 */
const OUTWARD = [
  /\bgit\s+push\b/i,
  /\bgh\s+(pr|issue|release|repo|gist|api)\s+(create|merge|close|delete|comment|edit|upload|-X)/i,
  /\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bgem\s+push\b|\bdotnet\s+nuget\s+push\b/i,
  /\b(curl|wget|http|xh)\b.*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--data|\s-d\s|\s-F\s|--upload-file|--form|\s-T\s)/i,
  /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b.*-Method\s+(Post|Put|Patch|Delete)/i,
  /\b(ssh|scp|sftp|rsync)\s+[^|;&]*\w@[\w.-]+/i,
  /\b(sendmail|mailx?|Send-MailMessage)\b/i,
  /\bkubectl\s+(apply|delete|create|scale|rollout)\b|\bterraform\s+(apply|destroy)\b/i,
  /\b(aws|az|gcloud)\s+\S+\s+(delete|create|deploy|put|rm|cp)\b/i,
  /\bvercel\b.*--prod|\bnetlify\s+deploy\b|\bfly\s+deploy\b|\bfirebase\s+deploy\b/i,
];

/** Destroys files on this computer without the Prullenbak (recursive or not), or rewrites git history. */
const LOCAL_DESTRUCTIVE = [
  /\bgit\s+(reset\s+--hard|clean\s+-[a-z]*f|branch\s+-D|tag\s+-d|filter-branch)\b/i,
  /(^|[;&|(]\s*|\s)rm\s+\S/i,
  /\bunlink\s+\S/i,
  /\bshred\b/i,
  /\bRemove-Item\s+\S/i,
  /(^|[;&|(]\s*)ri\s+\S/i,
  /(^|[;&|(]\s*|\s)(del|erase)\s+\S/i,
  /(^|[;&|(]\s*|\s)(rd|rmdir)\s+\S/i,
  /\bfind\b[^|;&]*\s-delete\b/i,
  /\[(System\.)?IO\.File\]::Delete\(/i,
];

export function shellCommandRisk(cmd: string): ToolRisk {
  const c = String(cmd || '');
  return OUTWARD.some((r) => r.test(c)) || LOCAL_DESTRUCTIVE.some((r) => r.test(c)) ? 'danger' : 'exec';
}

/** For "Volledige toegang": only local destruction (in the bot's folders) runs without asking; anything outward asks. */
export function shellCommandImpact(cmd: string): ToolImpact {
  const c = String(cmd || '');
  return OUTWARD.some((r) => r.test(c)) ? 'external' : 'local';
}

/** Folders any program may read (the system's own), besides the bot's folders and the temp folder. */
function systemDirs(): string[] {
  if (process.platform === 'win32') {
    const e = process.env;
    return [e.SystemRoot || 'C:\\Windows', e.ProgramFiles || 'C:\\Program Files', e['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', e.ProgramData || 'C:\\ProgramData'];
  }
  return ['/usr', '/bin', '/sbin', '/lib', '/lib64', '/opt', '/etc', '/dev', '/tmp', '/private/tmp', '/System', '/Library', '/Applications'];
}

/**
 * Paths a shell command names outside the bot's folders (best effort: absolute paths, `~`, home/AppData variables
 * and `..` escapes), and the subset that are key files or TeamBot's own data. Claude Code, the ACP engines and
 * TeamBot's own terminal tool run commands without a sandbox on Windows, so in "Automatisch" and "Volledige toegang"
 * a command that reaches outside goes to a human, and one that names a key folder is refused ("Eigen werkplek"). Not
 * a sandbox: a command can still hide a path. Used by the CLI gate (modules/cli-agents/permissions.ts) and shell.ts.
 */
export function commandPaths(cmd: string, o: { roots: string[]; dataDir?: string; home?: string; cwd?: string; whole?: { closed: string[] } | null }): { outside: string[]; keys: string[] } {
  const home = o.home || process.env.USERPROFILE || process.env.HOME || '';
  const env = process.env;
  const vars: [RegExp, string | undefined][] = [
    [/^(?:%USERPROFILE%|\$env:USERPROFILE|\$\{?HOME\}?|\$env:HOME|%HOMEDRIVE%%HOMEPATH%)/i, home],
    [/^(?:%APPDATA%|\$env:APPDATA)/i, env.APPDATA],
    [/^(?:%LOCALAPPDATA%|\$env:LOCALAPPDATA)/i, env.LOCALAPPDATA],
    [/^~(?=$|[\\/])/, home],
  ];
  const cwd = o.cwd || o.roots[0] || process.cwd();
  const found = new Set<string>();
  const tokens: string[] = [];
  // Quoted parts are taken whole (a path with spaces) and split again (a script inside `-Command "…"`).
  const split = (text: string, depth: number) => {
    for (const m of text.matchAll(/"([^"]{1,2000})"|'([^']{1,2000})'|([^\s"'|&;<>()]+)/g)) {
      const t = m[1] ?? m[2] ?? m[3] ?? '';
      tokens.push(t);
      if (depth < 2 && m[3] === undefined && /\s/.test(t)) split(t, depth + 1);
    }
  };
  split(String(cmd || '').slice(0, 20_000), 0);
  for (let t of tokens) {
    t = t.replace(/^(?:-{1,2}[\w-]+[:=]|[\w-]{2,}=)(?=[A-Za-z]:[\\/]|[~%$\\/.])/, ''); // --out=C:\x, -Path:~\x, if=/home/x
    let abs: string | null = null;
    for (const [re, base] of vars) {
      if (base && re.test(t)) {
        abs = path.join(base, t.replace(re, ''));
        break;
      }
    }
    if (!abs) {
      if (/^[A-Za-z]:[\\/]/.test(t) || /^\\\\[^\\]/.test(t)) abs = t;
      else if (process.platform !== 'win32' && /^\/[^/]/.test(t)) abs = t;
      else if (/^\/(home|Users|root|mnt|c|d)\/[^/]/i.test(t)) abs = process.platform === 'win32' && /^\/[a-z]\//i.test(t) ? `${t[1]}:${t.slice(2)}` : t;
      else if (/^\.\.([\\/]|$)/.test(t)) abs = path.resolve(cwd, t);
    }
    if (!abs) continue;
    abs = path.resolve(abs);
    if (o.roots.some((r) => within(abs!, r))) continue;
    // TeamBot's own data stays closed, also when it lives in the temp folder (a portable copy, a test)
    if (o.dataDir && within(abs, o.dataDir)) {
      found.add(abs);
      continue;
    }
    // A folder the owner closed (and TeamBot's data) stays closed for a bot with the whole computer too.
    if (o.whole?.closed.some((c) => within(abs!, c))) {
      found.add(abs);
      continue;
    }
    if (within(abs, os.tmpdir())) continue;
    if (systemDirs().some((d) => within(abs!, d)) && !KEY_PATH.test(abs)) continue;
    // "Volledige toegang" = the whole computer (files.ts wholeComputer): only key files and closed folders count.
    if (o.whole && !KEY_PATH.test(abs)) continue;
    found.add(abs);
  }
  const outside = [...found];
  const keys = outside.filter((p) => KEY_PATH.test(p) || (!!o.dataDir && within(p, o.dataDir)) || !!o.whole?.closed.some((c) => within(p, c)));
  return { outside, keys };
}
