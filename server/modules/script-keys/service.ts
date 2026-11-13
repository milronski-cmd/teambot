import type { Agent, Ctx } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { bad, notFound } from '../../core/http.js';
import { rememberSecret } from '../../core/secrets.js';
import { sharedRunOf } from '../../agent/shared.js';
import { PLACE } from '../../../shared/places.js';

/**
 * "Sleutels voor scripts": secrets of the owner that a bot's own scripts get as environment variables under a name the
 * owner chooses (SHOPIFY_TOKEN). The value is stored in the encrypted secret store (`ctx.secrets`, row
 * `scriptkey:<id>`); this table only keeps the name, a description and who may use it: one bot, or every bot whose
 * home team is a team. The value goes into the environment of TeamBot's own `run_command` and `skill_run_script`
 * only; the model sees the names (system prompt), never a value, and every tool result, live output and the full export
 * replace a value by `[verborgen: $NAME]`. A key that Instellingen › Teams limits to one team ("alleen dit team")
 * never reaches a bot of another team.
 */

export const MAX_KEYS = 200;
export const MIN_VALUE = 8;
export const MAX_VALUE = 16_000;
export const SECRET_PREFIX = 'scriptkey:';
/** Teams kind for "alleen dit team" (team_key_scopes). */
export const TEAM_KIND = 'script';

export type GrantTarget = 'agent' | 'team';

export interface KeyRow {
  id: string;
  user_id: string;
  name: string;
  label: string;
  secret_id: string | null;
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

interface GrantRow {
  id: string;
  user_id: string;
  key_id: string;
  target: GrantTarget;
  target_id: string;
  created_at: string;
}

/** What the owner's UI sees of a key: never the value. */
export interface KeyView {
  id: string;
  name: string;
  label: string;
  has_value: boolean;
  /** Instellingen › Teams: the one team this key is limited to, or null (all teams). */
  team_id: string | null;
  grants: { target: GrantTarget; id: string; name: string; blocked?: string }[];
  created_at: string;
  updated_at: string;
  last_used_at: string | null;
}

/** One key as a bot gets it (bot editor). */
export interface AgentKeyView {
  id: string;
  name: string;
  label: string;
  /** Given to this bot itself, or to its home team. */
  via: GrantTarget;
  team_name?: string;
  has_value: boolean;
  /** Why the bot does not get it after all (another team's key, value missing, a key of its own with this name). */
  blocked?: string;
}

export interface AgentKeysView {
  keys: AgentKeyView[];
  /** Keys of the owner this bot does not have yet (to add with one click). */
  others: { id: string; name: string; label: string }[];
  /** Why the bot would not use its keys right now (no terminal or scripts, chat-only …), or null. */
  unusable: string | null;
  /** The bot's home team, for "voor alle bots van team …". */
  team: { id: string; name: string } | null;
}

const NAME_RE = /^[A-Z_][A-Z0-9_]{1,63}$/;
/**
 * Names that change how programs start or where they look (or that TeamBot sets itself): taking one over would break
 * scripts or run something else. Never a key name.
 */
const RESERVED = new Set([
  'PATH', 'PATHEXT', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'PROGRAMDATA', 'PROGRAMFILES',
  'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'SHELL', 'PWD', 'OLDPWD', 'USER', 'USERNAME',
  'LOGNAME', 'LANG', 'TERM', 'NODE_OPTIONS', 'NODE_PATH', 'PYTHONPATH', 'PYTHONHOME', 'PYTHONSTARTUP', 'PYTHONNOUSERSITE',
  'PERL5LIB', 'PERL5OPT', 'RUBYOPT', 'RUBYLIB', 'JAVA_TOOL_OPTIONS', '_JAVA_OPTIONS', 'CLASSPATH', 'PSMODULEPATH', 'BASH_ENV',
  'ENV', 'PROMPT_COMMAND', 'IFS', 'PS1', 'PS4', 'SKILL_DIR', 'GIT_SSH_COMMAND', 'GIT_ASKPASS', 'GIT_CONFIG_GLOBAL',
  'GIT_EXEC_PATH', 'SSH_ASKPASS', 'SSH_AUTH_SOCK', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'GNUPGHOME', 'NO_COLOR',
]);
const RESERVED_PREFIX = /^(TEAMBOT_|DYLD_|LD_|NPM_CONFIG_)/;

/** What the owner typed ("shopify token") as an environment variable name (SHOPIFY_TOKEN). */
export function normalizeName(input: unknown): string {
  return String(input ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s.-]+/g, '_');
}

/** A valid key name, or an HttpError 400 in plain Dutch. */
export function checkName(input: unknown): string {
  const name = normalizeName(input);
  if (!name) throw bad('Vul een naam in, bijvoorbeeld SHOPIFY_TOKEN.');
  if (!NAME_RE.test(name)) throw bad(`“${name.slice(0, 70)}” kan geen naam zijn: gebruik hoofdletters, cijfers en _ (niet beginnen met een cijfer), bijvoorbeeld SHOPIFY_TOKEN.`);
  if (RESERVED.has(name) || RESERVED_PREFIX.test(name)) throw bad(`${name} gebruikt je computer of een programma zelf. Kies een eigen naam, bijvoorbeeld SHOPIFY_TOKEN.`);
  return name;
}

/** The value as stored: surrounding spaces and line breaks of a paste dropped, the rest as it is. */
export function checkValue(input: unknown): string {
  const v = String(input ?? '').trim();
  if (!v) throw bad('Plak de sleutel of het wachtwoord.');
  if (v.length < MIN_VALUE) throw bad(`Een sleutel heeft minstens ${MIN_VALUE} tekens.`);
  if (v.length > MAX_VALUE) throw bad('Deze sleutel is te lang.');
  if (v.includes('\u0000')) throw bad('Deze sleutel bevat een teken dat niet kan.');
  return v;
}

/** Every form in which a script may print a value: plain, JSON-escaped, URL-encoded, base64, and long single lines. */
export function valueVariants(v: string): string[] {
  const out = new Set<string>([v]);
  out.add(JSON.stringify(v).slice(1, -1));
  try {
    out.add(encodeURIComponent(v));
    out.add(new URLSearchParams({ v }).toString().slice(2));
  } catch {
    /* lone surrogate: plain is enough */
  }
  const b64 = Buffer.from(v, 'utf8').toString('base64');
  out.add(b64);
  out.add(b64.replace(/=+$/, ''));
  out.add(Buffer.from(v, 'utf8').toString('base64url'));
  // A multi-line key (a PEM block) printed in part or with other line endings: each long line on its own.
  if (/[\r\n]/.test(v)) for (const line of v.split(/\r?\n/)) if (line.trim().length >= 16) out.add(line.trim());
  return [...out].filter((x) => x.length >= MIN_VALUE);
}

export const hiddenMark = (name: string) => `[verborgen: $${name}]`;

/** Replace every variant of every value by its marker (longest first, so a value inside another one is covered too). */
export function scrubWith(text: string, items: { name: string; variants: string[] }[]): string {
  if (!text || !items.length) return text;
  const pairs = items.flatMap((i) => i.variants.map((v) => [v, i.name] as const)).sort((a, b) => b[0].length - a[0].length);
  let t = text;
  for (const [v, name] of pairs) if (t.includes(v)) t = t.split(v).join(hiddenMark(name));
  return t;
}

/** Drop a tail of at least 4 characters that is the beginning of one of the values (it may still be printing). */
export function cutPartial(text: string, items: { variants: string[] }[]): string {
  let cut = 0;
  for (const i of items)
    for (const v of i.variants)
      for (let n = Math.min(v.length - 1, text.length); n >= 4 && n > cut; n--)
        if (text.endsWith(v.slice(0, n))) {
          cut = n;
          break;
        }
  return cut ? text.slice(0, -cut) : text;
}

/** The mirror of `cutPartial`: drop a first piece that could be the end of a value (output cut off at the front). */
export function cutLeading(text: string, items: { variants: string[] }[]): string {
  let cut = 0;
  for (const i of items)
    for (const v of i.variants)
      for (let n = Math.min(v.length - 1, text.length); n >= 4 && n > cut; n--)
        if (text.startsWith(v.slice(-n))) {
          cut = n;
          break;
        }
  return cut ? text.slice(cut) : text;
}

export class ScriptKeys {
  /** Per owner: name + forms of every value, for scrubbing (dropped on every change, at most 15 s old). */
  private cache = new Map<string, { at: number; items: { name: string; variants: string[] }[] }>();

  constructor(private ctx: Ctx) {}

  private get teams(): any {
    return this.ctx.services.teams;
  }

  private changed(userId: string, data: Record<string, unknown> = {}, o: { keyList?: boolean } = {}) {
    this.cache.delete(userId);
    this.ctx.events.emit(userId, 'scriptKeys.updated', data);
    // A new, renamed or deleted key also changes the list under Instellingen › Teams (Sleutels en logins).
    if (o.keyList) this.ctx.events.emit(userId, 'teams.changed', {});
  }

  // ---------------------------------------------------------------- rows

  row(id: string): KeyRow | null {
    return this.ctx.store.get<KeyRow>('script_keys', id);
  }

  rows(userId: string): KeyRow[] {
    return this.ctx.store.find<KeyRow>('script_keys', { user_id: userId }, { order: 'name, created_at' });
  }

  own(userId: string, id: string): KeyRow {
    const r = this.row(id);
    if (!r || r.user_id !== userId) throw notFound('Sleutel niet gevonden');
    return r;
  }

  private grants(keyId: string): GrantRow[] {
    return this.ctx.store.find<GrantRow>('script_key_grants', { key_id: keyId }, { order: 'created_at' });
  }

  private hasValue(r: KeyRow): boolean {
    return !!r.secret_id && !!this.ctx.store.one('SELECT 1 FROM secrets WHERE id = ?', r.secret_id);
  }

  private value(r: KeyRow): string | null {
    return r.secret_id ? this.ctx.secrets.get(r.secret_id) : null;
  }

  private scope(keyId: string): string | null {
    return this.teams?.keyScope?.(TEAM_KIND, keyId) ?? null;
  }

  private teamName(teamId: string | null | undefined): string {
    return (teamId && this.teams?.team?.(teamId)?.name) || 'een ander team';
  }

  private agentOf(userId: string, id: string): Agent | null {
    const a = this.ctx.store.agent(id);
    return a && a.user_id === userId ? a : null;
  }

  private teamOf(userId: string, id: string): { id: string; name: string } | null {
    const t = this.teams?.team?.(id);
    return t && t.user_id === userId ? { id: t.id, name: t.name } : null;
  }

  // ---------------------------------------------------------------- the owner's view

  view(r: KeyRow): KeyView {
    const scope = this.scope(r.id);
    const grants: KeyView['grants'] = [];
    for (const g of this.grants(r.id)) {
      if (g.target === 'agent') {
        const a = this.agentOf(r.user_id, g.target_id);
        // A bot that is gone loses its grants (agentDeleted); one that slipped through is dropped here.
        if (!a) {
          this.ctx.store.remove('script_key_grants', g.id);
          continue;
        }
        const home = this.teams?.teamOf?.(a.id) ?? null;
        grants.push({ target: 'agent', id: a.id, name: a.name, ...(scope && home !== scope ? { blocked: `Alleen voor team “${this.teamName(scope)}”` } : {}) });
      } else {
        const t = this.teamOf(r.user_id, g.target_id);
        if (!t) {
          this.ctx.store.remove('script_key_grants', g.id);
          continue;
        }
        grants.push({ target: 'team', id: t.id, name: t.name, ...(scope && t.id !== scope ? { blocked: `Alleen voor team “${this.teamName(scope)}”` } : {}) });
      }
    }
    return { id: r.id, name: r.name, label: r.label, has_value: this.hasValue(r), team_id: scope, grants, created_at: r.created_at, updated_at: r.updated_at, last_used_at: r.last_used_at };
  }

  list(userId: string): KeyView[] {
    return this.rows(userId).map((r) => this.view(r));
  }

  create(userId: string, body: any): KeyView {
    const n = this.ctx.store.one<{ n: number }>('SELECT COUNT(*) AS n FROM script_keys WHERE user_id = ?', userId)?.n ?? 0;
    if (n >= MAX_KEYS) throw bad(`Je kunt maximaal ${MAX_KEYS} sleutels voor scripts bewaren.`);
    const name = checkName(body?.name);
    const value = checkValue(body?.value);
    const label = String(body?.label ?? '').trim().slice(0, 120);
    // The first bot or team that gets it (optional), checked before anything is stored.
    const first = body?.agent_id ? { target: 'agent' as const, id: String(body.agent_id) } : body?.team_id ? { target: 'team' as const, id: String(body.team_id) } : null;
    if (first) this.checkGrant(userId, null, name, first.target, first.id);
    const id = newId('sk_');
    const t = now();
    const secretId = this.ctx.secrets.set(userId, SECRET_PREFIX + id, value);
    this.ctx.store.insert('script_keys', { id, user_id: userId, name, label, secret_id: secretId, created_at: t, updated_at: t, last_used_at: null });
    // Never the value in the audit log: the name and who got it.
    this.ctx.audit(userId, 'script-keys.created', { id, name });
    if (first) this.addGrant(userId, this.row(id)!, first.target, first.id);
    this.changed(userId, { id }, { keyList: true });
    return this.view(this.row(id)!);
  }

  update(userId: string, id: string, body: any): KeyView {
    const r = this.own(userId, id);
    const patch: Partial<KeyRow> = { updated_at: now() };
    const changed: string[] = [];
    if (body?.name !== undefined) {
      const name = checkName(body.name);
      if (name !== r.name) {
        // The new name may not collide for any bot or team that has this key.
        for (const g of this.grants(r.id)) this.checkGrant(userId, r.id, name, g.target, g.target_id, { renaming: true });
        patch.name = name;
        changed.push('name');
      }
    }
    if (body?.label !== undefined) {
      patch.label = String(body.label).trim().slice(0, 120);
      changed.push('label');
    }
    // Write-only: empty = keep, a value = replace.
    if (body?.value !== undefined && String(body.value).trim() !== '') {
      const value = checkValue(body.value);
      patch.secret_id = this.ctx.secrets.set(userId, SECRET_PREFIX + r.id, value);
      changed.push('value');
    }
    this.ctx.store.update('script_keys', r.id, patch);
    this.ctx.audit(userId, 'script-keys.updated', { id: r.id, name: patch.name || r.name, changed });
    this.changed(userId, { id: r.id }, { keyList: changed.includes('name') || changed.includes('label') });
    return this.view(this.row(r.id)!);
  }

  remove(userId: string, id: string) {
    const r = this.own(userId, id);
    this.ctx.store.tx(() => {
      this.ctx.store.exec('DELETE FROM script_key_grants WHERE key_id = ?', r.id);
      // "Alleen dit team" of this key (Instellingen › Teams), when the teams module is there.
      if (this.ctx.store.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'team_key_scopes'")) this.ctx.store.exec('DELETE FROM team_key_scopes WHERE kind = ? AND ref_id = ?', TEAM_KIND, r.id);
      this.ctx.store.remove('script_keys', r.id);
    });
    if (r.secret_id) this.ctx.secrets.delete(r.secret_id);
    this.ctx.audit(userId, 'script-keys.deleted', { id: r.id, name: r.name });
    this.changed(userId, { id: r.id }, { keyList: true });
  }

  // ---------------------------------------------------------------- grants

  /**
   * May this key (by `name`) go to this bot or team? Refused: a bot or team of someone else, a key that is "alleen
   * team X" for another team, and a second key with the same name for the same bot or team (which one would win?).
   */
  private checkGrant(userId: string, keyId: string | null, name: string, target: GrantTarget, targetId: string, o: { renaming?: boolean } = {}) {
    const renaming = !!o.renaming;
    // A rename keeps the grants as they are (one that is blocked by "alleen dit team" stays blocked): only name clashes.
    const scope = keyId && !renaming ? this.scope(keyId) : null;
    if (target === 'agent') {
      const a = this.agentOf(userId, targetId);
      if (!a) throw notFound('Bot niet gevonden');
      if (scope && (this.teams?.teamOf?.(a.id) ?? null) !== scope) throw bad(`Deze sleutel is alleen voor team “${this.teamName(scope)}”, en ${a.name} hoort bij een ander team. Kies een andere sleutel, of zet de sleutel op alle teams (${PLACE.teams}).`);
      const clash = this.ctx.store.one<{ id: string }>("SELECT k.id FROM script_key_grants g JOIN script_keys k ON k.id = g.key_id WHERE g.target = 'agent' AND g.target_id = ? AND k.name = ? AND k.id != ?", a.id, name, keyId || '');
      if (clash) throw bad(`${a.name} heeft al een sleutel met de naam ${name}. Haal die eerst weg${renaming ? ', of kies een andere naam' : ''}.`);
    } else {
      const t = this.teamOf(userId, targetId);
      if (!t) throw notFound('Team niet gevonden');
      if (scope && scope !== t.id) throw bad(`Deze sleutel is alleen voor team “${this.teamName(scope)}”. Geef hem aan dat team, of zet de sleutel op alle teams (${PLACE.teams}).`);
      const clash = this.ctx.store.one<{ id: string }>("SELECT k.id FROM script_key_grants g JOIN script_keys k ON k.id = g.key_id WHERE g.target = 'team' AND g.target_id = ? AND k.name = ? AND k.id != ?", t.id, name, keyId || '');
      if (clash) throw bad(`Team “${t.name}” heeft al een sleutel met de naam ${name}. Haal die eerst weg${renaming ? ', of kies een andere naam' : ''}.`);
    }
  }

  private addGrant(userId: string, r: KeyRow, target: GrantTarget, targetId: string) {
    if (this.ctx.store.one('SELECT 1 FROM script_key_grants WHERE key_id = ? AND target = ? AND target_id = ?', r.id, target, targetId)) return;
    this.ctx.store.insert('script_key_grants', { id: newId('skg_'), user_id: userId, key_id: r.id, target, target_id: targetId, created_at: now() });
    this.ctx.audit(userId, 'script-keys.granted', { id: r.id, name: r.name, target, targetId }, target === 'agent' ? targetId : undefined);
  }

  grant(userId: string, keyId: string, body: any): KeyView {
    const r = this.own(userId, keyId);
    const target: GrantTarget = body?.target === 'team' ? 'team' : 'agent';
    const targetId = String(body?.id ?? '').slice(0, 80);
    if (!targetId) throw bad(target === 'team' ? 'Kies een team.' : 'Kies een bot.');
    this.checkGrant(userId, r.id, r.name, target, targetId);
    this.addGrant(userId, r, target, targetId);
    this.changed(userId, { id: r.id });
    return this.view(r);
  }

  revoke(userId: string, keyId: string, target: string, targetId: string): KeyView {
    const r = this.own(userId, keyId);
    const t: GrantTarget = target === 'team' ? 'team' : 'agent';
    this.ctx.store.exec('DELETE FROM script_key_grants WHERE key_id = ? AND target = ? AND target_id = ?', r.id, t, targetId);
    this.ctx.audit(userId, 'script-keys.revoked', { id: r.id, name: r.name, target: t, targetId }, t === 'agent' ? targetId : undefined);
    this.changed(userId, { id: r.id });
    return this.view(r);
  }

  agentDeleted(agentId: string, userId: string) {
    this.ctx.store.exec("DELETE FROM script_key_grants WHERE target = 'agent' AND target_id = ?", agentId);
    this.changed(userId);
  }

  // ---------------------------------------------------------------- what a bot gets

  /** Every key that reaches this bot, the bot's own grant before its team's, with the reason when it is blocked. */
  private reach(agent: Agent): { row: KeyRow; via: GrantTarget; teamId: string | null; blocked?: string }[] {
    const home: string | null = this.teams?.teamOf?.(agent.id) ?? null;
    const rows = this.ctx.store.all<KeyRow & { target: GrantTarget; target_id: string }>(
      `SELECT k.*, g.target, g.target_id FROM script_key_grants g JOIN script_keys k ON k.id = g.key_id
       WHERE k.user_id = ? AND ((g.target = 'agent' AND g.target_id = ?) OR (g.target = 'team' AND g.target_id = ?))
       ORDER BY CASE g.target WHEN 'agent' THEN 0 ELSE 1 END, k.name, k.created_at`,
      agent.user_id,
      agent.id,
      home || '',
    );
    const taken = new Set<string>();
    const out: ReturnType<ScriptKeys['reach']> = [];
    for (const r of rows) {
      const { target, target_id, ...row } = r;
      const scope = this.scope(row.id);
      let blocked: string | undefined;
      if (scope && scope !== home) blocked = `Alleen voor team “${this.teamName(scope)}”`;
      else if (!this.hasValue(row)) blocked = 'De waarde ontbreekt (gewist bij Beveiliging). Vul hem opnieuw in.';
      else if (taken.has(row.name)) blocked = `${agent.name} heeft al een eigen sleutel ${row.name}; die gaat voor.`;
      if (!blocked) taken.add(row.name);
      out.push({ row, via: target, teamId: target === 'team' ? target_id : null, blocked });
    }
    return out;
  }

  /** Not for a shared bot in a member's conversation, nor for one of another owner. */
  private eligible(agent: Agent | null | undefined): agent is Agent {
    return !!agent && !sharedRunOf(agent) && this.ctx.store.agent(agent.id)?.user_id === agent.user_id;
  }

  /** Names (and descriptions) this bot can use in its scripts; for the system prompt. Never a value. */
  namesFor(agent: Agent | null | undefined): { name: string; label: string }[] {
    if (!this.eligible(agent)) return [];
    return this.reach(agent)
      .filter((k) => !k.blocked)
      .map((k) => ({ name: k.row.name, label: k.row.label }));
  }

  /**
   * NAME → value for the environment of one of the bot's scripts (run_command, skill_run_script). Logged as names
   * only. Every value is also remembered for redact(), so a log line or audit entry never carries it.
   */
  envFor(agent: Agent | null | undefined, o: { tool?: string } = {}): Record<string, string> {
    if (!this.eligible(agent)) return {};
    const env: Record<string, string> = {};
    const used: string[] = [];
    for (const k of this.reach(agent)) {
      if (k.blocked) continue;
      const v = this.value(k.row);
      if (!v) continue;
      env[k.row.name] = rememberSecret(v);
      used.push(k.row.id);
    }
    if (used.length) {
      const t = now();
      for (const id of used) this.ctx.store.update('script_keys', id, { last_used_at: t });
      this.ctx.audit(agent.user_id, 'script-keys.used', { names: Object.keys(env), tool: o.tool || null }, agent.id);
    }
    return env;
  }

  private items(userId: string) {
    let c = this.cache.get(userId);
    if (!c || Date.now() - c.at > 15_000) {
      const items: { name: string; variants: string[] }[] = [];
      for (const r of this.rows(userId)) {
        const v = this.value(r);
        if (v) items.push({ name: r.name, variants: valueVariants(v) });
      }
      c = { at: Date.now(), items };
      this.cache.set(userId, c);
    }
    return c.items;
  }

  /** Replace every value of this owner's script keys in a text by `[verborgen: $NAME]` (all keys, not only granted ones). */
  scrub(userId: string | null | undefined, text: string): string {
    if (!userId || !text) return text;
    return scrubWith(text, this.items(userId));
  }

  /**
   * For output that is still coming in (the live progress of a command): scrubbed, and without a last piece that could be
   * the start of a value that is only half printed yet.
   */
  scrubLive(userId: string | null | undefined, text: string): string {
    if (!userId || !text) return text;
    const items = this.items(userId);
    return cutPartial(scrubWith(text, items), items);
  }

  /**
   * A piece cut out of longer output (head and tail of shortened server output): scrubbed, and at a cut edge without
   * the start (`end`) or the end (`start`) of a value that the cut split in two.
   */
  scrubPiece(userId: string | null | undefined, text: string, cut: { start?: boolean; end?: boolean } = {}): string {
    if (!userId || !text) return text;
    const items = this.items(userId);
    let out = scrubWith(text, items);
    if (cut.end) out = cutPartial(out, items);
    if (cut.start) out = cutLeading(out, items);
    return out;
  }

  /** The bot editor: the keys this bot gets, the others it could get, and whether it would use them now. */
  forAgent(userId: string, agentId: string): AgentKeysView {
    const a = this.agentOf(userId, agentId);
    if (!a) throw notFound('Bot niet gevonden');
    const reach = this.reach(a);
    const keys: AgentKeyView[] = reach.map((k) => ({
      id: k.row.id,
      name: k.row.name,
      label: k.row.label,
      via: k.via,
      ...(k.teamId ? { team_name: this.teamName(k.teamId) } : {}),
      has_value: this.hasValue(k.row),
      ...(k.blocked ? { blocked: k.blocked } : {}),
    }));
    const mine = new Set(reach.filter((k) => k.via === 'agent').map((k) => k.row.id));
    const others = this.rows(userId)
      .filter((r) => !mine.has(r.id))
      .map((r) => ({ id: r.id, name: r.name, label: r.label }));
    const home = this.teams?.teamOf?.(a.id) ?? null;
    return { keys, others, unusable: this.unusable(a), team: home ? this.teamOf(userId, home) : null };
  }

  /** Why this bot would not run a script with its keys now, in plain words (null: it would). */
  unusable(a: Agent): string | null {
    if (a.access_mode === 'chat') return `${a.name} staat op ‘Alleen chat’ en voert geen scripts of opdrachten uit. Kies bij Toegang ‘Vraagt toestemming’ of ruimer.`;
    if (a.access_mode === 'readonly') return `${a.name} staat op ‘Alleen lezen’ en voert geen scripts of opdrachten uit. Kies bij Toegang ‘Vraagt toestemming’ of ruimer.`;
    const groups = a.tool_groups || [];
    if (!['shell', 'skills', 'container', 'remote'].some((g) => groups.includes(g))) return `Zet bij Tools ‘Terminal’ aan (of ‘Skills’ voor skillscripts); anders gebruikt ${a.name} deze sleutels niet.`;
    return null;
  }

  /** Data export: names, descriptions and who has them; never a value. */
  exportUser(userId: string) {
    return {
      scriptKeys: this.list(userId).map((k) => ({ id: k.id, name: k.name, label: k.label, has_value: k.has_value, team_id: k.team_id, grants: k.grants.map((g) => ({ target: g.target, id: g.id, name: g.name })), created_at: k.created_at, last_used_at: k.last_used_at })),
    };
  }
}
