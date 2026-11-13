import os from 'node:os';
import path from 'node:path';
import type { ToolImpact, ToolRisk } from '../../core/types.js';
import { isInside as within, KEY_PATH } from './files.js';

/**
 * Risk of one shell command, the ONE list for TeamBot's own terminal tool (run_command) and for the commands of every
 * CLI engine (modules/cli-agents/permissions.ts): approval only where it counts. A command that sends,
 * publishes, pushes or deletes outside the Prullenbak is "danger" (asks a human, also in "Automatisch"); everything
 * else is a normal "exec". Deleting a single file counts too: a shell delete bypasses the trash, so it is never a
 * silent, reversible change. Best effort: a command can hide what it does; the terminal tool stays off by default.
 */
const OUTWARD = [
  /\bgit\s+push\b/i,
  /\bgh\s+(pr|issue|release|repo|gist|api)\s+(create|merge|close|delete|comment|edit|upload|-X)/i,
  /\b(npm|pnpm|yarn|bun)\s+publish\b|\bcargo\s+publish\b|\btwine\s+upload\b|\bdocker\s+push\b|\bgem\s+push\b|\bdotnet\s+nuget\s+push\b/i,
  /\b(curl|wget|http|xh)\b.*(\s-X\s*(POST|PUT|PATCH|DELETE)|\s--data|\s-d\s|\s-F\s|--upload-file|--form|\s-T\s)/i,
  /\b(Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b.*-Method\s+(Post|Put|Patch|Delete)/i,
  /\b(ssh|scp|sftp|rsync)\s+[^|;&]*\w@[\w.-]+/i,
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

/**
 * Sends a message to a person. On "Volledige toegang" this is the only kind of command that counts as "to others"
 * (asks unless the owner allowed sending, and his rule about important messages is checked). Pushing code, deploying,
 * publishing a package, calling an API or working on a server over ssh is the bot's ordinary work there: the owner's
 * choice (12 nov): "only money and messages to customers ask; going live does not".
 */
export function mailsSomeone(cmd: string): boolean {
  const c = commandText(cmd);
  return /\bSend-MailMessage\b/i.test(c) || MAIL_PROGRAM.test(c);
}
/**
 * A mail program where a command starts (also inside `bash -c "…"`), never the word in an argument: `grep "the account
 * e-mail" tests` and `cat mail.txt` mail nobody (seen live: a bot on "Volledige toegang" waited four times for a card).
 */
const MAIL_PROGRAM = new RegExp(String.raw`(?:^|[;&|(){\n\r\`]\s*|\s-(?:c|Command)\s+["']\s*|\b(?:sudo|xargs|nohup|env|cmd(?:\.exe)?\s+\/c)\s+)(?:[\w.~/\\:-]*[\\/])?(?:sendmail|mailx?|msmtp|mutt|swaks|mailsend)(?:\.exe)?(?=\s|$)`, 'i');

/**
 * The command without the text it types into a file or a program (the body of a heredoc: `cat >> a.ts <<'EOF' … EOF`):
 * that text is content, not a command. A heredoc a shell reads (`bash <<EOF`) stays, it is run.
 */
function commandText(cmd: string): string {
  return String(cmd || '').replace(/^([^\n]*?)<<-?[ \t]*(["']?)([A-Za-z_]\w*)\2([^\n]*)\n[\s\S]*?\n[ \t]*\3[ \t]*(?=\n|$)/gm, (all, before: string, _q: string, _tag: string, after: string) =>
    /(?:^|[;&|(]\s*|\bsudo\s+)(?:(?:ba|z|da|k)?sh|pwsh|powershell)(?:\.exe)?(?=\s|$)/i.test(`${before} ${after}`) ? all : `${before}${after}`,
  );
}

/** The fixed blocklist below "Volledige toegang" (and for a shared bot): system-wide damage, in any mode. */
const HARDLINE = [
  /\bformat(\.com)?\s+[a-z]:/i,
  /\brm\s+-[a-z]*r[a-z]*f?[a-z]*\s+(\/|~|\$HOME|\/\*)(\s|$)/i,
  /Remove-Item\s+.*-Recurse.*\s+(C:\\|~|\$env:USERPROFILE)\s*$/i,
  /\bmkfs\./i,
  /\bdd\s+if=.*of=\/dev\//i,
  /:\(\)\s*\{\s*:\|:&\s*\};:/,
  /\bshutdown\b|\bStop-Computer\b|\bRestart-Computer\b/i,
  /\bvssadmin\s+delete\b|\bbcdedit\b|\bcipher\s+\/w/i,
  /\breg\s+delete\s+HKLM/i,
];

const START = String.raw`(?:^|[;&|(]\s*|\b(?:sudo|cmd(?:\.exe)?\s+\/c)\s+)`;
const END = String.raw`\s*(?:$|[;&|)])`;
const Q = `["']?`;
/** The whole of a drive, the user profile or the home folder as the target of a delete (never a folder inside it). */
function wholeTargets(home: string): string {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const profile = home
    ? '|' +
      home
        .replace(/[\\/]+$/, '')
        .split(/[\\/]/)
        .map(esc)
        .join(String.raw`[\\/]`) +
      String.raw`[\\/]?\*?`
    : '';
  return String.raw`(?:[A-Za-z]:[\\/]?\*?(?:\.\*)?|~[\\/]?\*?|\$env:USERPROFILE[\\/]?\*?|\$\{?HOME\}?[\\/]?\*?|%USERPROFILE%[\\/]?\*?|%HOMEDRIVE%[\\/]?\*?|\/\*?${profile})`;
}

/**
 * What stays refused on "Volledige toegang": only a command that wipes the machine beyond repair by an obvious
 * accident. Anchored on the command and on the whole target, so a word in an argument or a path never trips it:
 *  1. `format C:` (the system drive), `Format-Volume -DriveLetter C`, `Clear-Disk`;
 *  2. a recursive delete of a whole drive, the user profile or the home folder: `rm -rf /`, `rm -rf ~`,
 *     `Remove-Item -Recurse C:\`, `rd /s /q C:\`, `del /s /q C:\*`;
 *  3. writing straight over a disk: `mkfs.* /dev/…`, `dd … of=/dev/sd…`.
 * Nothing else: shutdown, the registry, bcdedit, a delete of any folder inside the profile all run.
 */
export function fullHardline(cmd: string, o: { home?: string; systemDrive?: string } = {}): boolean {
  const c = String(cmd || '');
  const home = o.home ?? (process.env.USERPROFILE || process.env.HOME || '');
  const sys = (o.systemDrive ?? process.env.SystemDrive ?? 'C:').replace(/[^A-Za-z]/g, '').slice(0, 1) || 'C';
  const T = wholeTargets(home);
  const tests = [
    new RegExp(String.raw`${START}format(?:\.com)?\s+(?:\/\S+\s+)*${sys}:`, 'i'),
    new RegExp(String.raw`\bFormat-Volume\b[^;|&]*-DriveLetter\s+${Q}${sys}\b`, 'i'),
    /\bClear-Disk\b/i,
    new RegExp(String.raw`${START}rm\s+(?:-{1,2}[\w-]+\s+)*-[a-z]*r[a-z]*\s+(?:-{1,2}[\w-]+\s+)*${Q}${T}${Q}${END}`, 'i'),
    new RegExp(String.raw`\b(?:Remove-Item|ri|rm|del|rmdir|rd)\b(?=[^;|&]*\s-(?:Recurse|r)\b)[^;|&]*?\s(?:-(?:Path|LiteralPath)\s+)?${Q}${T}${Q}(?=\s+-|${END})`, 'i'),
    new RegExp(String.raw`${START}(?:rd|rmdir)\s+(?:\/[sq]\s+)*\/s\s+(?:\/[sq]\s+)*${Q}${T}${Q}${END}`, 'i'),
    new RegExp(String.raw`${START}(?:del|erase)\s+(?:\/[a-z]\s+)*\/s\s+(?:\/[a-z]\s+)*${Q}${T}${Q}${END}`, 'i'),
    /\bmkfs\.\w+\s+(?:-\S+\s+)*\/dev\//i,
    /\bdd\b[^;|&]*\bof=\/dev\/(?:sd|hd|nvme|disk|mmcblk|vd)/i,
  ];
  return tests.some((r) => r.test(c));
}

/** Is this command refused outright? `full`: the bot is on "Volledige toegang" (only `fullHardline`). */
export function isHardline(cmd: string, full = false): boolean {
  const c = String(cmd || '');
  return full ? fullHardline(c) : HARDLINE.some((r) => r.test(c)) || fullHardline(c);
}

export function shellCommandRisk(cmd: string): ToolRisk {
  const c = commandText(cmd);
  return OUTWARD.some((r) => r.test(c)) || mailsSomeone(c) || LOCAL_DESTRUCTIVE.some((r) => r.test(c)) ? 'danger' : 'exec';
}

/** For "Volledige toegang" (the only level that looks at impact): only a command that mails someone is "to others". */
export function shellCommandImpact(cmd: string): ToolImpact {
  return mailsSomeone(cmd) ? 'external' : 'local';
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
 * a sandbox: a command can still hide a path. Used by the permission gate (tools/gate.ts) for every command, whichever
 * way it arrives, and by the terminal tool itself when it runs (shell.ts).
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
