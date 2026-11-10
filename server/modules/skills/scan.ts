import path from 'node:path';
import crypto from 'node:crypto';
import { type FileMap, isBinary, isSkillMd, sha256 } from './files.js';

/**
 * Static safety scan for skills. Skills are untrusted input: we flag executable content, prompt
 * injection, exfiltration patterns, secrets, hidden characters and external addresses. The scan
 * never blocks on its own; it labels and the UI asks for explicit acknowledgement on "danger".
 */

export type Severity = 'info' | 'warn' | 'danger';

export interface Finding {
  severity: Severity;
  kind: 'script' | 'binary' | 'injection' | 'exfiltration' | 'secret' | 'network' | 'hidden' | 'command' | 'sensitive';
  file: string;
  line?: number;
  message: string;
  excerpt?: string;
}

export interface ScanFile {
  path: string;
  size: number;
  type: 'skill' | 'text' | 'script' | 'executable' | 'binary';
  sha256: string;
}

export interface ScanResult {
  level: 'ok' | Severity;
  kind: 'prompt' | 'scripts';
  labels: string[];
  findings: Finding[];
  files: ScanFile[];
  scripts: string[];
  binaries: string[];
  urls: string[];
  domains: string[];
}

const SCRIPT_EXT = new Set([
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.psm1', '.psd1', '.bat', '.cmd', '.vbs', '.vbe', '.js', '.mjs', '.cjs', '.ts', '.mts', '.cts', '.jsx', '.tsx',
  '.py', '.pyw', '.rb', '.pl', '.php', '.lua', '.r', '.jar', '.go', '.rs', '.swift', '.kts', '.groovy', '.applescript', '.scpt', '.wsf', '.hta', '.reg', '.ahk',
]);
const EXEC_EXT = new Set(['.exe', '.dll', '.so', '.dylib', '.msi', '.com', '.scr', '.appimage', '.bin', '.elf', '.app', '.deb', '.rpm', '.pkg', '.node', '.wasm', '.sys', '.cpl', '.ocx']);

export function fileType(rel: string, buf: Buffer): ScanFile['type'] {
  if (isSkillMd(rel) && !rel.includes('/')) return 'skill';
  const ext = path.posix.extname(rel).toLowerCase();
  if (buf.length >= 4) {
    const mz = buf[0] === 0x4d && buf[1] === 0x5a;
    const elf = buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46;
    const macho = [0xfeedface, 0xfeedfacf, 0xcefaedfe, 0xcffaedfe, 0xcafebabe].includes(buf.readUInt32BE(0));
    if (mz || elf || macho) return 'executable';
  }
  if (EXEC_EXT.has(ext)) return 'executable';
  if (SCRIPT_EXT.has(ext)) return 'script';
  if (!isBinary(buf) && buf.subarray(0, 2).toString() === '#!') return 'script';
  if (isBinary(buf)) return 'binary';
  return 'text';
}

const NEGATION = /\b(never|not|don't|do not|no|nooit|niet|geen|zonder dat)\b[^.\n]{0,25}$/i;

interface Rule {
  re: RegExp;
  severity: Severity;
  kind: Finding['kind'];
  message: string;
  /** Skip when a negation ("never", "nooit", "niet") precedes the match. */
  negatable?: boolean;
  /** Only in scripts / only in prose. */
  scope?: 'script' | 'prose';
}

const RULES: Rule[] = [
  // --- prompt injection (EN + NL) ---
  { re: /\b(ignore|disregard|forget|override|bypass)\b[^.\n]{0,40}\b(previous|prior|above|earlier|all|any|system|your|other)\b[^.\n]{0,30}\b(instructions?|prompts?|rules|guidelines|directives|messages)\b/i, severity: 'danger', kind: 'injection', message: 'Probeert eerdere instructies te laten negeren (prompt-injectie).' },
  { re: /\b(negeer|vergeet|negeren|overschrijf|omzeil)\b[^.\n]{0,40}\b(eerdere|vorige|bovenstaande|alle|voorgaande|je|jouw|andere|systeem)\b[^.\n]{0,30}\b(instructies|regels|opdrachten|prompts?|richtlijnen|berichten)\b/i, severity: 'danger', kind: 'injection', message: 'Probeert eerdere instructies te laten negeren (prompt-injectie).' },
  { re: /\b(developer mode|jailbreak|DAN mode|do anything now|no longer bound by|unrestricted mode|god mode)\b/i, severity: 'danger', kind: 'injection', message: 'Bevat een bekende jailbreak-formulering.' },
  { re: /\b(you are now|from now on,? you are|je bent vanaf nu|vanaf nu ben je)\b[^.\n]{0,60}\b(unrestricted|unfiltered|without (any )?(rules|limits|restrictions)|zonder (regels|beperkingen|grenzen))\b/i, severity: 'danger', kind: 'injection', message: 'Probeert de rol en de regels van de bot te vervangen.' },
  { re: /\b(reveal|print|show|output|leak|repeat|dump|disclose)\s+(me\s+|us\s+)?(the\s+|your\s+)?(full\s+|entire\s+|original\s+|exact\s+)?(system prompt|hidden instructions|secret instructions|developer message|hidden prompt|initial instructions|instructions above)\b/i, severity: 'danger', kind: 'injection', message: 'Probeert de systeemprompt of verborgen instructies te laten tonen.' },
  { re: /\b(toon|geef|print|lek|herhaal)\s+(me\s+|ons\s+)?(de\s+|je\s+|jouw\s+)?(volledige\s+|hele\s+|originele\s+)?(systeemprompt|system prompt|verborgen instructies|geheime instructies|instructies hierboven)\b/i, severity: 'danger', kind: 'injection', message: 'Probeert de systeemprompt of verborgen instructies te laten tonen.' },
  { re: /\b(do not|don't|never)\s+(tell|inform|mention|show|notify|alert)\s+(this\s+|it\s+)?(to\s+)?(the\s+)?user\b(?!\s+(they|he|she|it's|its|to|how|why|what|which|whether)\b)/i, severity: 'danger', kind: 'injection', message: 'Vraagt de bot iets voor de gebruiker te verbergen.' },
  { re: /\b(vertel|zeg|meld|toon)\b[^.\n]{0,15}\b(dit|het|niets)\b[^.\n]{0,15}\bniet\b[^.\n]{0,15}\b(aan|tegen)\s+de\s+gebruiker\b|\bverberg\b[^.\n]{0,30}\bvoor\s+de\s+gebruiker\b/i, severity: 'danger', kind: 'injection', message: 'Vraagt de bot iets voor de gebruiker te verbergen.' },
  { re: /\b(without|skip|bypass|circumvent|avoid)\b[^.\n]{0,20}\b(asking|approval|permission|confirmation|consent|the approval)\b/i, severity: 'info', kind: 'injection', message: 'Spoort aan om zonder toestemming te handelen (goedkeuringen blijven altijd gelden).', negatable: true },
  { re: /\b(zonder|omzeil|sla)\b[^.\n]{0,20}\b(toestemming|goedkeuring|te vragen|bevestiging)\b/i, severity: 'info', kind: 'injection', message: 'Spoort aan om zonder toestemming te handelen (goedkeuringen blijven altijd gelden).', negatable: true },
  { re: /\b(set|switch|change|zet)\b[^.\n]{0,30}\b(access[_ ]mode|tool[_ ]policy|toegangsmodus)\b[^.\n]{0,30}\b(auto|allow)\b/i, severity: 'danger', kind: 'injection', message: 'Probeert de toegangsrechten van de bot te verhogen.' },

  // --- exfiltration ---
  { re: /\b(webhook\.site|requestbin|pipedream\.net|ngrok(-free)?\.(io|app|dev)|burpcollaborator|oast\.(fun|me|pro|live|site|online)|interact\.sh|pastebin\.com|transfer\.sh|hookbin|beeceptor|requestcatcher|discord(app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|canarytokens)\b/i, severity: 'danger', kind: 'exfiltration', message: 'Verwijst naar een dienst die vaak gebruikt wordt om gegevens weg te sluizen.' },
  { re: /\b(send|post|upload|forward|exfiltrate|stuur|verstuur|upload|doorsturen)\b[^.\n]{0,60}\b(api[_ -]?keys?|tokens?|passwords?|wachtwoord(en)?|secrets?|geheimen|credentials|inloggegevens|conversation|gesprek(ken)?|chat ?history|geschiedenis|env(ironment)? variables?|omgevingsvariabelen|cookies)\b[^\n]{0,80}https?:\/\//i, severity: 'danger', kind: 'exfiltration', message: 'Lijkt gevoelige gegevens naar een extern adres te willen sturen.' },
  { re: /\b(curl|wget|Invoke-WebRequest|Invoke-RestMethod|iwr|irm|fetch|requests\.post|http\.post|axios\.post)\b[^\n]{0,200}(\s-d\b|--data|\s-F\b|--upload-file|-Method\s+Post|-Body\b|\bbody\s*[:=]|data\s*=)/i, severity: 'warn', kind: 'exfiltration', message: 'Verstuurt gegevens naar een extern adres.' },
  { re: /(\.ssh[\\/]|id_rsa|id_ed25519|\.aws[\\/]credentials|\.git-credentials|\.netrc|\.npmrc|\.pypirc|master\.key|local-token|Login Data|cookies\.sqlite|\bkeychain\b|wallet\.dat|\.kube[\\/]config)/i, severity: 'warn', kind: 'sensitive', message: 'Verwijst naar bestanden met sleutels of inloggegevens.' },
  { re: /\b(printenv|Get-ChildItem\s+env:|gci\s+env:|\$env:[A-Z_]*(KEY|TOKEN|SECRET)|os\.environ|process\.env)\b/i, severity: 'warn', kind: 'sensitive', message: 'Leest omgevingsvariabelen (kunnen sleutels bevatten).', scope: 'script' },

  // --- risky commands ---
  { re: /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^\n|]{0,200}\|\s*(sudo\s+)?(ba|z|da)?sh\b|\b(curl|wget|iwr|irm|Invoke-WebRequest)\b[^\n]{0,200}\|\s*(iex|Invoke-Expression)\b/i, severity: 'danger', kind: 'command', message: 'Downloadt en voert direct code uit (pipe naar shell).' },
  { re: /\b(Invoke-Expression|iex\s*\(|powershell(\.exe)?\s+[^\n]{0,40}-(e|enc|encodedcommand)\b|base64\s+(-d|--decode)[^\n]{0,40}\|\s*(ba)?sh|\beval\s*\(\s*(atob|base64|Buffer\.from))/i, severity: 'danger', kind: 'command', message: 'Voert verborgen of gecodeerde code uit.' },
  { re: /\b(rm\s+-rf\s+(\/\*?|~\/?|\$HOME\/?)(?=\s|$|["'`;&|])|Remove-Item\s+[^\n]{0,60}-Recurse[^\n]{0,40}(C:\\|~|\$env:USERPROFILE)|format\s+[a-z]:|mkfs\.|vssadmin\s+delete|bcdedit|cipher\s+\/w)/i, severity: 'danger', kind: 'command', message: 'Bevat een opdracht die systeembreed gegevens kan wissen.' },
  { re: /\b(Set-MpPreference|Add-MpPreference|DisableRealtimeMonitoring|netsh\s+advfirewall|reg\s+add|schtasks\s+\/create|crontab\s+-|launchctl\s+load|New-Service|sc\.exe\s+create|chmod\s+(\+s|[0-7]*777)|sudo\s)/i, severity: 'warn', kind: 'command', message: 'Wijzigt systeeminstellingen, beveiliging of automatisch starten.' },

  // --- obfuscation ---
  { re: /[A-Za-z0-9+/]{240,}={0,2}/, severity: 'warn', kind: 'hidden', message: 'Bevat een lange gecodeerde tekst (base64); controleer wat erin zit.', scope: 'prose' },
];

const SECRET_RULES: { re: RegExp; label: string }[] = [
  { re: /sk-ant-[A-Za-z0-9_\-]{16,}/, label: 'Anthropic-sleutel' },
  { re: /\bsk-(proj-)?[A-Za-z0-9_\-]{20,}/, label: 'OpenAI-achtige sleutel' },
  { re: /\bAIza[0-9A-Za-z_\-]{30,}/, label: 'Google-sleutel' },
  { re: /\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{30,}/, label: 'GitHub-token' },
  { re: /\bxox[abprs]-[A-Za-z0-9-]{10,}/, label: 'Slack-token' },
  { re: /\bAKIA[0-9A-Z]{16}\b/, label: 'AWS-sleutel' },
  { re: /-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/, label: 'privésleutel' },
  { re: /\b\d{8,10}:[A-Za-z0-9_-]{30,}\b/, label: 'Telegram-bottoken' },
  { re: /eyJ[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{20,}\.[A-Za-z0-9_-]{10,}/, label: 'JWT-token' },
  { re: /\b(api[_-]?key|apikey|secret|token|password|passwd|wachtwoord)\b\s*[:=]\s*["']?(?!\$\{|\$[A-Z_]|<|your|jouw|xxx|\.\.\.)[A-Za-z0-9_\-\/+=]{16,}/i, label: 'wachtwoord of sleutel' },
];

const HIDDEN_CHARS = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF\u00AD]/;
const URL_RE = /\bhttps?:\/\/[^\s<>"'`)\]}]+/gi;

export function maskSecret(s: string) {
  return s.length <= 8 ? '…' : s.slice(0, 4) + '…[verborgen]';
}

/** Replace secrets in a text (used for template export and excerpts). */
export function redactSecrets(text: string): { text: string; count: number } {
  let count = 0;
  let t = text;
  for (const r of SECRET_RULES) {
    const g = new RegExp(r.re.source, r.re.flags.includes('g') ? r.re.flags : r.re.flags + 'g');
    t = t.replace(g, () => {
      count++;
      return '[geheim verwijderd]';
    });
  }
  return { text: t, count };
}

export function findSecrets(text: string): string[] {
  const out: string[] = [];
  for (const r of SECRET_RULES) if (r.re.test(text)) out.push(r.label);
  return out;
}

/**
 * The text around a finding, with every secret on the line masked. The secrets are found on the whole line before the
 * window is cut: a key the window cuts in half no longer looks like a key, and its tail was shown as it was
 * (acceptance round 5, B-09: "…QrStUvWxYz0123456789abcdefghijklmnop" of an Anthropic key next to a GitHub token).
 */
export function excerptOf(line: string, idx: number, len: number) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(line.length, idx + len + 40);
  const hidden: [number, number][] = [];
  for (const r of SECRET_RULES) for (const m of line.matchAll(new RegExp(r.re.source, r.re.flags.replace('g', '') + 'g'))) hidden.push([m.index ?? 0, (m.index ?? 0) + m[0].length]);
  let s = '';
  for (let i = start; i < end; ) {
    const cover = hidden.filter(([a, b]) => a <= i && b > i).sort((x, y) => y[1] - x[1])[0];
    if (cover) {
      s += maskSecret(line.slice(cover[0], cover[1]));
      i = cover[1];
      continue;
    }
    const next = Math.min(end, ...hidden.filter(([a]) => a > i).map(([a]) => a));
    s += line.slice(i, next);
    i = next;
  }
  return (start > 0 ? '…' : '') + s.trim().slice(0, 160);
}

export function scanSkill(files: FileMap, opts: { execBits?: Set<string> } = {}): ScanResult {
  const findings: Finding[] = [];
  const out: ScanFile[] = [];
  const urls = new Set<string>();
  const add = (f: Finding) => {
    if (findings.length < 300 && !findings.some((x) => x.file === f.file && x.line === f.line && x.message === f.message)) findings.push(f);
  };

  for (const [rel, buf] of [...files.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    let type = fileType(rel, buf);
    if (type === 'text' && opts.execBits?.has(rel)) type = 'script';
    out.push({ path: rel, size: buf.length, type, sha256: sha256(buf) });
    if (type === 'executable') {
      add({ severity: 'danger', kind: 'binary', file: rel, message: 'Uitvoerbaar programma (binary). Dit wordt nooit automatisch uitgevoerd; installeer alleen als je de bron vertrouwt.' });
      continue;
    }
    if (type === 'binary') continue;
    if (type === 'script') add({ severity: 'info', kind: 'script', file: rel, message: 'Script. Wordt nooit automatisch uitgevoerd; pas na "Vertrouw deze skill", en dan elke keer met jouw toestemming.' });
    const text = buf.toString('utf8');
    if (HIDDEN_CHARS.test(text.replace(/^\uFEFF/, ''))) {
      const ln = text.split(/\r?\n/).findIndex((l, i) => HIDDEN_CHARS.test(i === 0 ? l.replace(/^\uFEFF/, '') : l));
      add({ severity: 'danger', kind: 'hidden', file: rel, line: ln >= 0 ? ln + 1 : undefined, message: 'Bevat onzichtbare of tekstrichting-omkerende tekens die instructies kunnen verbergen.' });
    }
    for (const m of text.matchAll(/<!--([\s\S]*?)-->/g)) {
      const inner = m[1];
      const line = text.slice(0, m.index).split('\n').length;
      const risky = RULES.some((r) => r.kind === 'injection' && r.re.test(inner));
      if (inner.trim().length > 20 && (type === 'skill' || rel.toLowerCase().endsWith('.md'))) add({ severity: risky ? 'danger' : 'info', kind: 'hidden', file: rel, line, message: risky ? 'Verborgen commentaar met verdachte instructies.' : 'Bevat verborgen commentaar (niet zichtbaar in de voorbeeldweergave).', excerpt: excerptOf(inner.replace(/\s+/g, ' '), 0, 60) });
    }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      if (line.length > 20_000) line = line.slice(0, 20_000);
      for (const r of RULES) {
        if (r.scope === 'script' && type !== 'script') continue;
        if (r.scope === 'prose' && type === 'script') continue;
        const m = r.re.exec(line);
        if (!m) continue;
        if (r.negatable && NEGATION.test(line.slice(0, m.index))) continue;
        let severity = r.severity;
        let message = r.message;
        const quoted = /["'“‘«]$/.test(line.slice(0, m.index).trimEnd()) && r.kind === 'injection';
        if (quoted && severity === 'danger') {
          severity = 'warn';
          message += ' (als citaat; controleer de context)';
        }
        if (r.kind === 'command' && type !== 'script' && severity === 'danger') {
          severity = 'warn';
          message += ' (beschreven in tekst; de bot kan dit alleen via de terminal met jouw toestemming uitvoeren)';
        }
        add({ severity, kind: r.kind, file: rel, line: i + 1, message, excerpt: excerptOf(line, m.index, m[0].length) });
      }
      for (const s of SECRET_RULES) {
        const m = s.re.exec(line);
        if (m) add({ severity: 'danger', kind: 'secret', file: rel, line: i + 1, message: `Bevat mogelijk een geheim (${s.label}). Verwijder het voordat je de skill deelt.`, excerpt: excerptOf(line, m.index, m[0].length) });
      }
      for (const u of line.matchAll(URL_RE)) urls.add(u[0].replace(/[.,;:!?]+$/, ''));
    });
  }

  const domains = [...new Set([...urls].map((u) => {
    try {
      return new URL(u).hostname.toLowerCase();
    } catch {
      return '';
    }
  }).filter(Boolean))].sort();
  if (domains.length) add({ severity: 'info', kind: 'network', file: '', message: `Verwijst naar externe adressen: ${domains.slice(0, 12).join(', ')}${domains.length > 12 ? ` en ${domains.length - 12} meer` : ''}.` });

  const scripts = out.filter((f) => f.type === 'script').map((f) => f.path);
  const binaries = out.filter((f) => f.type === 'executable').map((f) => f.path);
  const has = (k: Finding['kind']) => findings.some((f) => f.kind === k && f.severity !== 'info');
  const labels: string[] = [scripts.length || binaries.length ? 'scripts' : 'prompt-only'];
  if (binaries.length) labels.push('binary');
  if (has('injection') || findings.some((f) => f.kind === 'hidden' && f.severity === 'danger')) labels.push('injectie');
  if (has('exfiltration')) labels.push('exfiltratie');
  if (has('secret')) labels.push('geheim');
  if (has('command')) labels.push('riskante-opdracht');
  if (domains.length) labels.push('netwerk');
  const rank = { ok: 0, info: 1, warn: 2, danger: 3 } as const;
  let level: ScanResult['level'] = 'ok';
  for (const f of findings) if (rank[f.severity] > rank[level]) level = f.severity;
  findings.sort((a, b) => rank[b.severity] - rank[a.severity]);
  return { level, kind: scripts.length || binaries.length ? 'scripts' : 'prompt', labels, findings, files: out, scripts, binaries, urls: [...urls].slice(0, 200), domains };
}

/** Checksum over executable files only: trust is bound to this, so changed scripts need new trust. */
export function scriptsChecksum(scan: ScanResult): string {
  const exec = scan.files.filter((f) => f.type === 'script' || f.type === 'executable');
  if (!exec.length) return '';
  const h = crypto.createHash('sha256');
  for (const f of exec.sort((a, b) => a.path.localeCompare(b.path))) h.update(`${f.path}\0${f.sha256}\n`);
  return h.digest('hex');
}

// ---------- permission manifest ----------

/** Map common `allowed-tools` names (Claude Code / Agent Skills) to TeamBot tool groups. */
const TOOL_MAP: Record<string, { group: string; label: string }> = {
  bash: { group: 'shell', label: 'Terminal' },
  shell: { group: 'shell', label: 'Terminal' },
  powershell: { group: 'shell', label: 'Terminal' },
  run_command: { group: 'shell', label: 'Terminal' },
  read: { group: 'files', label: 'Bestanden lezen' },
  glob: { group: 'files', label: 'Bestanden lezen' },
  grep: { group: 'files', label: 'Bestanden lezen' },
  ls: { group: 'files', label: 'Bestanden lezen' },
  write: { group: 'files', label: 'Bestanden schrijven' },
  edit: { group: 'files', label: 'Bestanden schrijven' },
  multiedit: { group: 'files', label: 'Bestanden schrijven' },
  notebookedit: { group: 'files', label: 'Bestanden schrijven' },
  webfetch: { group: 'web', label: 'Internet' },
  websearch: { group: 'web', label: 'Internet' },
  web_fetch: { group: 'web', label: 'Internet' },
  web_search: { group: 'web', label: 'Internet' },
  browser: { group: 'browser', label: 'Browser' },
};

export interface Permissions {
  /** Declared tools (allowed-tools), as written. */
  tools: string[];
  /** TeamBot tool groups the declared tools map onto. */
  groups: string[];
  scripts: { path: string; sha256: string }[];
  binaries: string[];
  domains: string[];
}

export function toolGroupOf(tool: string): { group: string; label: string } | null {
  const base = tool.replace(/\(.*$/, '').trim().toLowerCase();
  if (base.startsWith('mcp__')) return { group: 'mcp', label: 'MCP-connector' };
  return TOOL_MAP[base] || null;
}

export function permissionsOf(allowedTools: string[], scan: ScanResult): Permissions {
  const groups = new Set<string>();
  for (const t of allowedTools) {
    const g = toolGroupOf(t);
    if (g) groups.add(g.group);
  }
  if (scan.scripts.length || scan.binaries.length) groups.add('shell');
  return {
    tools: [...new Set(allowedTools)].sort(),
    groups: [...groups].sort(),
    scripts: scan.files.filter((f) => f.type === 'script' || f.type === 'executable').map((f) => ({ path: f.path, sha256: f.sha256 })),
    binaries: [...scan.binaries],
    domains: [...scan.domains],
  };
}

export interface PermissionDiff {
  addedTools: string[];
  removedTools: string[];
  addedGroups: string[];
  addedScripts: string[];
  changedScripts: string[];
  removedScripts: string[];
  addedBinaries: string[];
  addedDomains: string[];
  removedDomains: string[];
  /** True when the new version needs more than the old one (requires explicit confirmation). */
  elevated: boolean;
}

export function diffPermissions(oldP: Permissions | null | undefined, newP: Permissions): PermissionDiff {
  const o: Permissions = oldP || { tools: [], groups: [], scripts: [], binaries: [], domains: [] };
  const minus = (a: string[], b: string[]) => a.filter((x) => !b.includes(x));
  const oldScripts = new Map(o.scripts.map((s) => [s.path, s.sha256]));
  const newScripts = new Map(newP.scripts.map((s) => [s.path, s.sha256]));
  const d: PermissionDiff = {
    addedTools: minus(newP.tools, o.tools),
    removedTools: minus(o.tools, newP.tools),
    addedGroups: minus(newP.groups, o.groups),
    addedScripts: [...newScripts.keys()].filter((p) => !oldScripts.has(p)),
    changedScripts: [...newScripts.keys()].filter((p) => oldScripts.has(p) && oldScripts.get(p) !== newScripts.get(p)),
    removedScripts: [...oldScripts.keys()].filter((p) => !newScripts.has(p)),
    addedBinaries: minus(newP.binaries, o.binaries),
    addedDomains: minus(newP.domains, o.domains),
    removedDomains: minus(o.domains, newP.domains),
    elevated: false,
  };
  d.elevated = !!(d.addedTools.length || d.addedGroups.length || d.addedScripts.length || d.changedScripts.length || d.addedBinaries.length || d.addedDomains.length);
  return d;
}
