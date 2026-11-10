import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseToml } from './toml.js';

/**
 * Importing MCP servers that the owner already uses elsewhere:
 *  - pasted: a `claude mcp add …` / `claude mcp add-json …` / `codex mcp add …` / `gemini mcp add …` command,
 *    `code --add-mcp '{…}'`, an MCP JSON snippet (`{"mcpServers": {…}}`, VS Code's `{"servers": {…}}`, one server)
 *    or a Codex TOML snippet (`[mcp_servers.x]`);
 *  - from this computer: Claude Code (`~/.claude.json`, also the `.mcp.json` of its projects), Claude Desktop, Codex
 *    (`~/.codex/config.toml`), Cursor, VS Code, Windsurf and Gemini CLI.
 *
 * Everything here only READS (those files are never written) and returns plain data. Values from a config stay with
 * the server: the preview of local files shows names, never secret values (see `previewOf`), and the import itself
 * re-reads the file server-side. Secrets end up in TeamBot's vault through the normal connection create (storeKV).
 */

export interface ImportedKV {
  name: string;
  value: string;
  secret: boolean;
  /** No value in the config (it referred to an environment variable or an input): the owner fills it in. */
  required?: boolean;
  help?: string;
  /** Put before what the owner types (e.g. "Bearer " for an Authorization header). */
  prefix?: string;
}

export interface ImportedServer {
  /** Stable per source and name (for "import these"). */
  id: string;
  name: string;
  /** Where it came from, in words ("claude mcp add", "Claude Code · project shop"). */
  source: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  cwd?: string;
  env: ImportedKV[];
  url?: string;
  headers: ImportedKV[];
  auth: 'none' | 'headers' | 'oauth';
  oauthClientId?: string;
  /** Switched off in the source config. */
  enabled: boolean;
  warnings: string[];
}

export class ImportError extends Error {}

// ------------------------------------------------------------------ secrets

const SECRET_NAME = /(api[_-]?key|key|token|secret|passw(or)?d|pwd|credential|cookie|session|private|auth|bearer|signature|^pat$|_pat$)/i;
const TOKEN_PREFIX = /^(sk-|sk_|pk_|rk_|ghp_|gho_|ghu_|ghs_|github_pat_|glpat-|xox[abprs]-|AKIA|AIza|ya29\.|eyJ|ntn_|secret_|lin_api_|shpat_|SG\.)/;

/** Does this value look like a key or token (long random string, or a known key prefix)? */
export function looksSecret(v: string): boolean {
  const s = String(v || '').trim();
  if (TOKEN_PREFIX.test(s) && s.length >= 12) return true;
  return s.length >= 24 && /^[A-Za-z0-9_\-.=+/]+$/.test(s) && /[A-Za-z]/.test(s) && /\d/.test(s) && !/^[./]/.test(s) && !s.includes('//');
}

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

const PLACEHOLDER = /\$\{(?:env:)?([A-Za-z_][A-Za-z0-9_]*)(?::-[^}]*)?\}|\$\{input:([^}]+)\}|^\$([A-Za-z_][A-Za-z0-9_]*)$|^%([A-Za-z_][A-Za-z0-9_]*)%$/;

/** An env var or header from a config: secrets marked, references to the user's environment turned into a blank to fill in. */
function kv(name: string, raw: unknown, kind: 'env' | 'header', inputs?: Map<string, { password: boolean; description: string }>): ImportedKV {
  const value = raw === null || raw === undefined ? '' : String(raw);
  const secretByName = kind === 'header' ? /authorization|token|key|secret|cookie|auth|session|password/i.test(name) : isSecretName(name);
  const m = PLACEHOLDER.exec(value);
  if (m) {
    const ref = m[1] || m[3] || m[4];
    const input = m[2] ? inputs?.get(m[2]) : undefined;
    const whole = m[0] === value || (kind === 'header' && /^(Bearer|Basic|token)\s+\S+$/i.test(value) && value.endsWith(m[0]));
    if (whole) {
      const prefix = value === m[0] ? '' : value.slice(0, value.indexOf(m[0]));
      return {
        name,
        value: '',
        secret: secretByName || !!input?.password || (!!ref && isSecretName(ref)) || !!prefix,
        required: true,
        ...(prefix ? { prefix } : {}),
        help: m[2]
          ? `Vul dit in${input?.description ? ` (${input.description.slice(0, 120)})` : ''}; je config vroeg er telkens om.`
          : `Vul de waarde in; je config verwees naar de omgevingsvariabele ${ref}.${prefix ? ` TeamBot zet er “${prefix.trim()}” voor.` : ''}`,
      };
    }
  }
  const secret = secretByName || looksSecret(value.replace(/^(Bearer|Basic|token)\s+/i, ''));
  // an example value from documentation ("YOUR_KEY", "<token>"): the owner fills in the real one
  const bare = value.replace(/^(Bearer|Basic|token)\s+/i, '');
  if (secret && EXAMPLE_VALUE.test(bare)) {
    const prefix = bare === value ? '' : value.slice(0, value.length - bare.length);
    return { name, value: '', secret: true, required: true, ...(prefix ? { prefix } : {}), help: `Vul je eigen waarde in; er stond een voorbeeld (“${bare.slice(0, 30)}”).${prefix ? ` TeamBot zet er “${prefix.trim()}” voor.` : ''}` };
  }
  return { name, value, secret };
}

const EXAMPLE_VALUE = /^(<[^>]{1,60}>|\[[^\]]{1,60}\]|\{[^}]{1,60}\}|your[_ -]?[\w -]{0,40}|my[_-]?(api[_-]?)?(key|token|secret)|xxx+|\.\.\.|…|changeme|change[_-]?me|replace[_-]?me|todo|\*{3,}|(api[_-]?)?key[_-]?here|token[_-]?here)$/i;

// ------------------------------------------------------------------ shell words

/**
 * Split a pasted command line into words. POSIX quoting (single and double quotes, backslash escapes), line
 * continuations of bash (\), cmd (^) and PowerShell (`), and Windows paths: an unquoted backslash only escapes a
 * space, a quote or a newline, so `C:\tools\server.exe` stays intact.
 */
export function shellWords(text: string): string[] {
  const s = text.replace(/[\\^`][ \t]*\r?\n/g, ' ');
  const out: string[] = [];
  let cur = '';
  let has = false;
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "'") {
      const end = s.indexOf("'", i + 1);
      if (end < 0) throw new ImportError('Een aanhalingsteken (\') is niet gesloten.');
      cur += s.slice(i + 1, end);
      has = true;
      i = end + 1;
    } else if (c === '"') {
      i++;
      has = true;
      for (;;) {
        if (i >= s.length) throw new ImportError('Een aanhalingsteken (") is niet gesloten.');
        const d = s[i];
        if (d === '"') {
          i++;
          break;
        }
        if (d === '\\' && i + 1 < s.length && '"\\$`'.includes(s[i + 1])) {
          cur += s[i + 1];
          i += 2;
          continue;
        }
        cur += d;
        i++;
      }
    } else if (c === '\\' && i + 1 < s.length && /[\s'"]/.test(s[i + 1])) {
      cur += s[i + 1];
      has = true;
      i += 2;
    } else if (/\s/.test(c)) {
      if (has) out.push(cur);
      cur = '';
      has = false;
      i++;
    } else {
      cur += c;
      has = true;
      i++;
    }
  }
  if (has) out.push(cur);
  return out;
}

// ------------------------------------------------------------------ JSON (also JSONC)

/** JSON with comments and trailing commas (VS Code, Cursor) → value. */
export function parseJsonc(text: string): any {
  let out = '';
  let i = 0;
  const s = text.replace(/^\uFEFF/, '');
  while (i < s.length) {
    const c = s[i];
    if (c === '"') {
      let j = i + 1;
      while (j < s.length && s[j] !== '"') j += s[j] === '\\' ? 2 : 1;
      out += s.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && s[i + 1] === '/') {
      while (i < s.length && s[i] !== '\n') i++;
    } else if (c === '/' && s[i + 1] === '*') {
      const end = s.indexOf('*/', i + 2);
      i = end < 0 ? s.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

const isObj = (v: any): v is Record<string, any> => !!v && typeof v === 'object' && !Array.isArray(v);
const looksLikeServer = (o: any) => isObj(o) && (typeof o.command === 'string' || typeof o.url === 'string' || typeof o.serverUrl === 'string' || typeof o.httpUrl === 'string');

function idOf(sourceKey: string, name: string) {
  return crypto.createHash('sha256').update(`${sourceKey}\0${name}`).digest('hex').slice(0, 16);
}

function transportOf(type: unknown, url: string | undefined): ImportedServer['transport'] {
  const t = String(type || '').toLowerCase();
  if (!url) return 'stdio';
  if (t === 'sse') return 'sse';
  if (t) return 'http';
  return /\/sse\/?(\?|$)/.test(url) ? 'sse' : 'http';
}

/** One server object from any of the JSON (or TOML) formats → ImportedServer. */
export function serverFrom(name: string, o: Record<string, any>, source: { key: string; label: string }, inputs?: Map<string, { password: boolean; description: string }>): ImportedServer {
  const warnings: string[] = [];
  const url = [o.url, o.serverUrl, o.httpUrl].find((v) => typeof v === 'string' && v.trim())?.trim();
  const transport = transportOf(o.type ?? o.transport, url);
  let command = typeof o.command === 'string' ? o.command.trim() : undefined;
  let args = Array.isArray(o.args) ? o.args.map((a: any) => String(a ?? '')) : [];
  if (command && !args.length && /\s/.test(command) && !/^[A-Za-z]:\\|^\//.test(command)) {
    // "command": "npx -y @scope/server" (one string)
    const w = shellWords(command);
    command = w[0];
    args = w.slice(1);
  }
  const env: ImportedKV[] = isObj(o.env) ? Object.entries(o.env).map(([k, v]) => kv(k, v, 'env', inputs)) : [];
  const headerSrc = isObj(o.headers) ? o.headers : isObj(o.http_headers) ? o.http_headers : {};
  const headers: ImportedKV[] = Object.entries(headerSrc).map(([k, v]) => kv(k, v, 'header', inputs));
  // Codex: values that come from the environment
  if (Array.isArray(o.env_vars))
    for (const n of o.env_vars.map(String)) if (isSecretName(n) && !env.some((e) => e.name === n)) env.push({ name: n, value: '', secret: true, required: true, help: `Vul de waarde in; je config gaf de omgevingsvariabele ${n} door.` });
  if (typeof o.bearer_token_env_var === 'string' && !headers.some((h) => h.name.toLowerCase() === 'authorization'))
    headers.push({ name: 'Authorization', value: '', secret: true, required: true, prefix: 'Bearer ', help: `Vul de sleutel in; je config haalde die uit de omgevingsvariabele ${o.bearer_token_env_var}. TeamBot zet er “Bearer” voor.` });
  if (isObj(o.env_http_headers)) for (const [h, n] of Object.entries(o.env_http_headers)) if (!headers.some((x) => x.name.toLowerCase() === h.toLowerCase())) headers.push({ name: h, value: '', secret: true, required: true, help: `Vul de waarde in; je config haalde die uit de omgevingsvariabele ${n}.` });
  if (args.some((a: string) => PLACEHOLDER.test(a) || /\$\{[^}]+\}/.test(a))) warnings.push('Een argument verwijst naar een variabele (${…}); pas het aan bij Instellen.');
  if (url && /\$\{[^}]+\}/.test(url)) warnings.push('Het adres verwijst naar een variabele (${…}); pas het aan bij Instellen.');
  if (!command && !url) warnings.push('Geen opdracht of adres gevonden.');
  const enabled = !(o.disabled === true || o.enabled === false);
  if (!enabled) warnings.push('Staat uit in de oorspronkelijke config.');
  const oauthClientId = typeof o.oauth?.clientId === 'string' ? o.oauth.clientId : typeof o.client_id === 'string' ? o.client_id : undefined;
  const auth: ImportedServer['auth'] = transport === 'stdio' ? 'none' : headers.length ? 'headers' : oauthClientId ? 'oauth' : 'none';
  return {
    id: idOf(source.key, name),
    name: name.slice(0, 80) || 'MCP-server',
    source: source.label,
    transport,
    ...(transport === 'stdio' ? { command, args, cwd: typeof o.cwd === 'string' && o.cwd.trim() ? o.cwd.trim() : undefined } : { url }),
    env: transport === 'stdio' ? env : [],
    headers: transport === 'stdio' ? [] : headers,
    auth,
    oauthClientId,
    enabled,
    warnings,
  };
}

/** Servers in a parsed JSON document of any known shape. */
export function serversFromJson(doc: any, source: { key: string; label: string }): ImportedServer[] {
  const inputs = new Map<string, { password: boolean; description: string }>();
  const collectInputs = (list: any) => {
    if (Array.isArray(list)) for (const x of list) if (isObj(x) && typeof x.id === 'string') inputs.set(x.id, { password: x.password === true, description: String(x.description || '') });
  };
  if (Array.isArray(doc)) return doc.flatMap((d, i) => serversFromJson(d, { ...source, key: `${source.key}#${i}` }));
  if (!isObj(doc)) return [];
  collectInputs(doc.inputs);
  collectInputs(doc.mcp?.inputs);
  const maps = [doc.mcpServers, doc.servers, doc.mcp?.servers, doc.mcp_servers, doc.context_servers].filter(isObj);
  if (maps.length) return maps.flatMap((m) => Object.entries(m).filter(([, v]) => looksLikeServer(v)).map(([n, v]) => serverFrom(n, v as any, source, inputs)));
  if (looksLikeServer(doc)) return [serverFrom(typeof doc.name === 'string' && doc.name.trim() ? doc.name.trim() : guessName(doc), doc, source, inputs)];
  // a bare map of name → server (copied from inside "mcpServers")
  const entries = Object.entries(doc).filter(([, v]) => looksLikeServer(v));
  return entries.map(([n, v]) => serverFrom(n, v as any, source, inputs));
}

function guessName(o: any): string {
  const url = o.url || o.serverUrl || o.httpUrl;
  if (typeof url === 'string') {
    try {
      const h = new URL(url).hostname.replace(/^(www|mcp|api)\./, '');
      return h.split('.')[0] || 'MCP-server';
    } catch {
      /* fall through */
    }
  }
  const words = [o.command, ...(Array.isArray(o.args) ? o.args : [])].map(String).filter((w) => w && !w.startsWith('-') && !/^(npx|uvx|node|python3?|bunx|pnpm|dlx|cmd|\/c|docker|run)$/i.test(w));
  const pkg = words[0] || 'MCP-server';
  return pkg.replace(/^@[^/]+\//, '').replace(/[\\/]/g, ' ').split(' ').pop()!.replace(/\.(exe|cmd|js|py)$/i, '').replace(/-?mcp-?(server)?/gi, '') || 'MCP-server';
}

// ------------------------------------------------------------------ commands

const ENV_ARG = /^[A-Za-z_][A-Za-z0-9_]*=/;
const HEADER_ARG = /^[A-Za-z0-9!#$%&'*+.^_`|~-]+:\s?/;

/** `claude|gemini mcp add [opties] <naam> <opdracht|url> [args…]` and `codex mcp add <naam> [opties] -- <opdracht> [args…]`. */
function fromAddCommand(tool: 'claude' | 'codex' | 'gemini', words: string[], key: string): ImportedServer {
  const label = `${tool} mcp add`;
  let transport: string | undefined;
  const env: [string, string][] = [];
  const headers: [string, string][] = [];
  let url: string | undefined;
  let bearerEnv: string | undefined;
  let clientId: string | undefined;
  const pos: string[] = [];
  const rest: string[] = [];
  let i = 0;
  const val = (w: string) => {
    const eq = w.indexOf('=');
    if (w.startsWith('--') && eq > 0) return w.slice(eq + 1);
    i++;
    if (i >= words.length) throw new ImportError(`De optie ${w} mist een waarde.`);
    return words[i];
  };
  const opt = (w: string) => (w.startsWith('--') ? w.split('=')[0] : w);
  for (; i < words.length; i++) {
    const w = words[i];
    if (w === '--') {
      rest.push(...words.slice(i + 1));
      break;
    }
    // after the command (without "--") everything is an argument of the server, except Claude's own options
    const afterCommand = tool !== 'codex' && pos.length >= 2;
    if (w.startsWith('-') && w.length > 1) {
      const o = opt(w);
      if (o === '-t' || o === '--transport') transport = val(w);
      else if (o === '-s' || o === '--scope' || o === '--callback-port' || o === '--description' || o === '--timeout' || o === '--include-tools' || o === '--exclude-tools') val(w);
      else if (o === '-e' || o === '--env') {
        let v = val(w);
        for (;;) {
          if (!ENV_ARG.test(v)) throw new ImportError(`Ongeldige omgevingsvariabele bij ${w}: gebruik NAAM=waarde.`);
          const eq = v.indexOf('=');
          env.push([v.slice(0, eq), v.slice(eq + 1)]);
          // variadic: more NAAM=waarde words may follow the same option
          if (i + 1 < words.length && ENV_ARG.test(words[i + 1]) && tool !== 'codex') v = words[++i];
          else break;
        }
      } else if (o === '-H' || o === '--header') {
        let v = val(w);
        for (;;) {
          const m = HEADER_ARG.exec(v);
          if (!m) throw new ImportError(`Ongeldige header bij ${w}: gebruik "Naam: waarde".`);
          headers.push([m[0].replace(/:\s?$/, ''), v.slice(m[0].length)]);
          if (i + 1 < words.length && HEADER_ARG.test(words[i + 1]) && !/^https?:/i.test(words[i + 1])) v = words[++i];
          else break;
        }
      } else if (o === '--url' && tool === 'codex') url = val(w);
      else if (o === '--bearer-token-env-var' && tool === 'codex') bearerEnv = val(w);
      else if (o === '--client-id') clientId = val(w);
      else if (o === '--client-secret' || o === '--trust') {
        /* a flag (Claude asks for the secret itself) */
      } else if (afterCommand) pos.push(w);
      else throw new ImportError(`Onbekende optie ${w} in “${label}”.`);
      continue;
    }
    pos.push(w);
  }
  const name = pos[0];
  if (!name) throw new ImportError(`Geen naam gevonden in “${label}”.`);
  let command: string | undefined;
  let args: string[] = [];
  if (tool === 'codex') {
    if (pos.length > 1) rest.unshift(...pos.slice(1));
    if (!url) [command, ...args] = rest;
  } else {
    const target = [...pos.slice(1), ...rest];
    if (/^https?:\/\//i.test(target[0] || '') && (transport === undefined || /^(http|sse|streamable-http)$/i.test(transport))) url = target[0];
    else [command, ...args] = target;
  }
  if (!url && !command) throw new ImportError(`Geen opdracht of adres gevonden in “${label}”.`);
  const o: Record<string, any> = url
    ? { type: transport && transport.toLowerCase() === 'sse' ? 'sse' : 'http', url, headers: Object.fromEntries(headers) }
    : { command, args, env: Object.fromEntries(env) };
  if (bearerEnv) o.bearer_token_env_var = bearerEnv;
  if (clientId) o.oauth = { clientId };
  if (url && env.length) o.env = Object.fromEntries(env);
  const s = serverFrom(name, o, { key, label });
  if (url && clientId) s.auth = 'oauth';
  if (url && env.length) s.warnings.push('Omgevingsvariabelen horen bij lokale programma’s en zijn hier genegeerd.');
  return s;
}

/** Where a pasted line starts a known command: index of the "mcp" word plus the tool, or null. */
function commandStart(words: string[]): { at: number; tool: 'claude' | 'codex' | 'gemini' | 'code' } | null {
  for (let i = 0; i < words.length; i++) {
    const base = path.basename(words[i].replace(/\\/g, '/')).toLowerCase().replace(/\.(exe|cmd|ps1|bat)$/, '');
    if ((base === 'claude' || base === 'claude-code' || base === 'codex' || base === 'gemini') && words[i + 1] === 'mcp') return { at: i + 1, tool: base === 'claude-code' ? 'claude' : (base as any) };
    if ((base === 'code' || base === 'code-insiders' || base === 'cursor') && words.slice(i + 1).includes('--add-mcp')) return { at: i, tool: 'code' };
    if (base.startsWith('@anthropic-ai/claude-code') && words[i + 1] === 'mcp') return { at: i + 1, tool: 'claude' };
  }
  return null;
}

/** One pasted command (already split into words). */
function fromCommandWords(words: string[], key: string): ImportedServer[] {
  const st = commandStart(words);
  if (!st) return [];
  if (st.tool === 'code') {
    const j = words.indexOf('--add-mcp');
    const json = words[j + 1];
    if (!json) throw new ImportError('Na --add-mcp hoort de JSON van de server.');
    return serversFromJson(parseJsonc(json), { key, label: 'code --add-mcp' }).map((s) => ({ ...s, source: 'code --add-mcp' }));
  }
  const sub = words[st.at + 1];
  const tail = words.slice(st.at + 2);
  if (sub === 'add-json') {
    const pos: string[] = [];
    for (let i = 0; i < tail.length; i++) {
      if (/^(-s|--scope)$/.test(tail[i])) i++;
      else if (!tail[i].startsWith('-')) pos.push(tail[i]);
    }
    const [name, json] = pos;
    if (!name || !json) throw new ImportError('Gebruik: claude mcp add-json <naam> \'<json>\'.');
    return serversFromJson(parseJsonc(json), { key, label: `${st.tool} mcp add-json` }).map((s) => ({ ...s, name, id: idOf(key, name) }));
  }
  if (sub !== 'add') throw new ImportError(`“${st.tool} mcp ${sub || ''}” voegt geen server toe; plak een “${st.tool} mcp add …”-opdracht.`);
  return [fromAddCommand(st.tool, tail, key)];
}

// ------------------------------------------------------------------ pasted text

/**
 * Recognise pasted text: JSON (also JSONC or a fragment like `"github": {…}`), a Codex TOML snippet, or one or more
 * commands (one per line, continuation lines joined). Throws ImportError with a Dutch explanation when nothing fits.
 */
export function parsePasted(text: string): ImportedServer[] {
  const raw = String(text || '').trim().replace(/^```[a-z]*\s*\n?|\n?```$/g, '').trim();
  if (!raw) throw new ImportError('Plak eerst een opdracht of een stukje config.');
  if (raw.length > 200_000) throw new ImportError('Dit is te veel tekst om te importeren.');
  const key = 'plakken';
  if (/^[[{]/.test(raw) || /^"[^"]+"\s*:\s*\{/.test(raw)) {
    let doc: any;
    try {
      doc = parseJsonc(raw.startsWith('"') ? `{${raw.replace(/,\s*$/, '')}}` : raw);
    } catch (e: any) {
      if (/^\[mcp_servers/m.test(raw)) return fromToml(raw, { key, label: 'Codex-config' });
      throw new ImportError(`Dit lijkt JSON, maar het is niet geldig: ${String(e?.message || e).slice(0, 120)}`);
    }
    const list = serversFromJson(doc, { key, label: 'JSON' });
    if (!list.length) throw new ImportError('Geen MCP-servers gevonden in deze JSON (verwacht bijv. "mcpServers" met "command" of "url").');
    return list;
  }
  if (/^\s*\[mcp_servers[.\]]/m.test(raw)) return fromToml(raw, { key, label: 'Codex-config' });
  const out: ImportedServer[] = [];
  const prompt = (l: string) => l.trim().replace(/^(\$|>|PS [^>]*>)\s*/, '');
  const starts = raw.match(/(^|[\s/\\])(claude|claude-code|codex|gemini)(\.exe|\.cmd)?\s+mcp\s+add|--add-mcp/gim) || [];
  if (starts.length <= 1) {
    // one command, possibly over several lines (continuations, or JSON inside quotes)
    out.push(...fromCommandWords(shellWords(raw.split(/\r?\n/).map(prompt).join('\n')), `${key}:0`));
  } else {
    // one command per line; continuation lines (\, ^, `) belong to the line before
    const lines = raw.replace(/[\\^`][ \t]*\r?\n/g, ' ').split(/\r?\n/).map(prompt).filter(Boolean);
    for (const [n, line] of lines.entries()) if (!line.startsWith('#')) out.push(...fromCommandWords(shellWords(line), `${key}:${n}`));
  }
  if (!out.length) throw new ImportError('Niet herkend. Plak een “claude mcp add …”- of “codex mcp add …”-opdracht, of MCP-JSON zoals {"mcpServers": {…}}.');
  return out;
}

function fromToml(text: string, source: { key: string; label: string }): ImportedServer[] {
  let doc: any;
  try {
    doc = parseToml(text);
  } catch (e: any) {
    throw new ImportError(`Deze TOML kan ik niet lezen: ${String(e?.message || e).slice(0, 120)}`);
  }
  const servers = isObj(doc.mcp_servers) ? doc.mcp_servers : {};
  return Object.entries(servers)
    .filter(([, v]) => looksLikeServer(v))
    .map(([n, v]) => serverFrom(n, v as any, source));
}

// ------------------------------------------------------------------ this computer

export interface LocalSource {
  key: string;
  label: string;
  file: string;
  kind: 'claude-json' | 'json' | 'vscode-settings' | 'toml';
}

export interface LocalScan {
  key: string;
  label: string;
  file: string;
  found: boolean;
  error?: string;
  servers: ImportedServer[];
}

/** Known config files of other MCP clients on this computer (paths only; nothing is read here). */
export function localSources(o: { home?: string; env?: NodeJS.ProcessEnv; platform?: NodeJS.Platform } = {}): LocalSource[] {
  // TEAMBOT_IMPORT_HOME: look in another home folder instead (tests, diagnostics); then only that folder is used
  const alt = process.env.TEAMBOT_IMPORT_HOME;
  const home = o.home ?? alt ?? os.homedir();
  const env = o.env ?? (alt ? {} : process.env);
  const platform = o.platform ?? process.platform;
  const appData = env.APPDATA || path.join(home, 'AppData', 'Roaming');
  const xdg = env.XDG_CONFIG_HOME || path.join(home, '.config');
  const userConfig = platform === 'win32' ? appData : platform === 'darwin' ? path.join(home, 'Library', 'Application Support') : xdg;
  const out: LocalSource[] = [
    { key: 'claude-code', label: 'Claude Code', file: path.join(home, '.claude.json'), kind: 'claude-json' },
    { key: 'claude-desktop', label: 'Claude Desktop', file: path.join(userConfig, 'Claude', 'claude_desktop_config.json'), kind: 'json' },
  ];
  if (platform === 'win32') {
    // Claude Desktop from the Microsoft Store keeps its config inside the app package
    const pk = path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Packages');
    try {
      for (const d of fs.readdirSync(pk).filter((n) => /^Claude_/i.test(n)).slice(0, 3))
        out.push({ key: `claude-desktop-store-${d}`, label: 'Claude Desktop (Microsoft Store)', file: path.join(pk, d, 'LocalCache', 'Roaming', 'Claude', 'claude_desktop_config.json'), kind: 'json' });
    } catch {
      /* no packages folder */
    }
  }
  out.push(
    { key: 'codex', label: 'Codex', file: path.join(env.CODEX_HOME || path.join(home, '.codex'), 'config.toml'), kind: 'toml' },
    { key: 'cursor', label: 'Cursor', file: path.join(home, '.cursor', 'mcp.json'), kind: 'json' },
    { key: 'vscode', label: 'VS Code', file: path.join(userConfig, 'Code', 'User', 'mcp.json'), kind: 'json' },
    { key: 'vscode-settings', label: 'VS Code (instellingen)', file: path.join(userConfig, 'Code', 'User', 'settings.json'), kind: 'vscode-settings' },
    { key: 'windsurf', label: 'Windsurf', file: path.join(home, '.codeium', 'windsurf', 'mcp_config.json'), kind: 'json' },
    { key: 'gemini', label: 'Gemini CLI', file: path.join(home, '.gemini', 'settings.json'), kind: 'json' },
  );
  return out;
}

const MAX_FILE = 25 * 1024 * 1024;

/** Read a config file (read-only, size-capped); null when it is not there. */
function readFile(file: string): string | null {
  let st: fs.Stats;
  try {
    st = fs.statSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  if (st.size > MAX_FILE) throw new ImportError('Bestand is te groot om te lezen.');
  return fs.readFileSync(file, 'utf8');
}

/** Look through the known config files; per file what was found (or a short error without file contents). */
export function scanLocal(sources: LocalSource[] = localSources()): LocalScan[] {
  const out: LocalScan[] = [];
  for (const src of sources) {
    const scan: LocalScan = { key: src.key, label: src.label, file: src.file, found: false, servers: [] };
    out.push(scan);
    let text: string | null;
    try {
      text = readFile(src.file);
    } catch (e: any) {
      scan.found = true;
      scan.error = String(e?.message || e).slice(0, 200);
      continue;
    }
    if (text === null) continue;
    scan.found = true;
    try {
      if (src.kind === 'toml') scan.servers = fromToml(text, { key: src.key, label: src.label });
      else {
        const doc = parseJsonc(text);
        if (src.kind === 'vscode-settings') scan.servers = isObj(doc.mcp) ? serversFromJson({ mcp: doc.mcp }, { key: src.key, label: src.label }) : [];
        else if (src.kind === 'claude-json') {
          scan.servers = isObj(doc.mcpServers) ? serversFromJson({ mcpServers: doc.mcpServers }, { key: src.key, label: 'Claude Code (alle projecten)' }) : [];
          // per project: servers in ~/.claude.json ("local" scope) and the project's own .mcp.json
          const projects = isObj(doc.projects) ? Object.entries(doc.projects).slice(0, 200) : [];
          for (const [dir, p] of projects) {
            const name = path.basename(dir.replace(/[\\/]+$/, '')) || dir;
            if (isObj(p) && isObj((p as any).mcpServers) && Object.keys((p as any).mcpServers).length)
              scan.servers.push(...serversFromJson({ mcpServers: (p as any).mcpServers }, { key: `${src.key}:${dir}`, label: `Claude Code · project ${name}` }));
            try {
              const mcpJson = readFile(path.join(dir, '.mcp.json'));
              if (mcpJson) scan.servers.push(...serversFromJson(parseJsonc(mcpJson), { key: `${src.key}:${dir}:.mcp.json`, label: `Claude Code · project ${name} (.mcp.json)` }));
            } catch {
              /* an unreadable project file does not spoil the rest */
            }
          }
        } else scan.servers = serversFromJson(doc, { key: src.key, label: src.label });
      }
    } catch (e: any) {
      // never echo file contents: JSON errors only say where it went wrong
      scan.error = e instanceof ImportError ? e.message : `Kon het bestand niet lezen (${String(e?.message || e).replace(/"[^"]*"/g, '…').slice(0, 120)})`;
    }
  }
  return out;
}

// ------------------------------------------------------------------ preview without secrets

const MASK = '••••';

/** A URL with credentials and secret-looking query values hidden. */
export function maskUrl(u: string): string {
  return u
    .replace(/^([a-z][a-z0-9+.-]*:\/\/[^/:@\s]*):[^@/\s]+@/i, `$1:${MASK}@`)
    .replace(/([?&#])([^=&#]+)=([^&#]*)/g, (all, sep, k, v) => (isSecretName(decodeURIComponent(k)) || looksSecret(decodeURIComponent(v)) ? `${sep}${k}=${MASK}` : all));
}

/** Arguments with keys, tokens and passwords hidden ("--api-key xyz", "--token=xyz", "postgres://u:pw@…"). */
export function maskArgs(args: string[]): string[] {
  return args.map((a, i) => {
    const prev = args[i - 1] || '';
    if (/^--?[\w-]*$/.test(prev) && isSecretName(prev) && !a.startsWith('-')) return MASK;
    const eq = /^(--?[\w-]+)=(.*)$/.exec(a);
    if (eq && isSecretName(eq[1])) return `${eq[1]}=${MASK}`;
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(a)) return maskUrl(a);
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(a) && isSecretName(a.split('=')[0])) return `${a.split('=')[0]}=${MASK}`;
    return looksSecret(a) ? MASK : a;
  });
}

/** What the browser may see of a server found on this computer: no secret values, no env/header values at all. */
export function previewOf(s: ImportedServer) {
  return {
    id: s.id,
    name: s.name,
    source: s.source,
    transport: s.transport,
    command: s.command,
    args: s.args ? maskArgs(s.args) : undefined,
    url: s.url ? maskUrl(s.url) : undefined,
    env: s.env.map((k) => ({ name: k.name, secret: k.secret, missing: !!k.required && !k.value })),
    headers: s.headers.map((k) => ({ name: k.name, secret: k.secret, missing: !!k.required && !k.value })),
    auth: s.auth,
    enabled: s.enabled,
    warnings: s.warnings,
  };
}
