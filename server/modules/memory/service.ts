import crypto from 'node:crypto';
import type { Agent, Ctx, Thread } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { estimateTokens } from '../../core/tokens.js';
import { canonicalKey, clean, containment, ftsQuery, guessKey, jaccard, normalize, tokens } from './text.js';
import type {
  Actor,
  AgentMemorySettings,
  ItemStatus,
  MemoryItem,
  MemoryItemRow,
  Reader,
  Scope,
  TeamScope,
  UserMemorySettings,
} from './types.js';
import { ALL_TEAMS, REF_PREFIX, reviewInterval } from './types.js';
import { bytesText } from '../../core/i18n.js';
import { Semantic, family, isArchiveLine, type QVec } from './semantic.js';
import { builtinSynonyms, compoundHeads } from './synonyms.js';
import { matchingLines } from './living.js';

export const DEFAULT_SETTINGS: UserMemorySettings = {
  learnMode: 'auto',
  paused: false,
  extractor: 'own',
  autoApply: 'own',
  quietMin: 15,
  learnEvery: 20,
  engine: { providerId: null, model: null },
  nightly: true,
  briefTokens: 300,
  botWrites: 'direct',
  conflicts: 'ask',
  reviewEveryDays: 180,
  episodes: true,
  semantic: 'auto',
  semanticModel: null,
  budgetTokens: 1200,
  profileCap: 4000,
  trashDays: 30,
  /** At most this many background model calls per day; 0 = no limit (the default: no built-in brake). */
  modelDailyCap: 0,
  quotas: {
    about_you: { items: 300, bytes: 256_000 },
    agent: { items: 500, bytes: 512_000 },
    shared: { items: 500, bytes: 512_000 },
    dossier: { items: 2000, bytes: 2_000_000 },
    episode: { items: 2000, bytes: 4_000_000 },
    proposals: 200,
  },
  targets: { about_you: 200, agent: 250, shared: 400, dossier: 600, client: 40, clientEpisodesDays: 45 },
  archiveAfterDays: 180,
  dossierAuto: 'propose',
};

/** Server-wide maxima (admin can lower/raise via /api/memory/admin/limits). User quotas are clamped to these. */
export const DEFAULT_LIMITS = { items: 20_000, bytes: 20_000_000, budgetTokens: 8000, profileCap: 16_000, dossiers: 1000, dossiersTotal: 10_000 };

export const TABLE_OF: Record<string, string> = {
  item: 'memory_items',
  dossier: 'memory_dossiers',
  event: 'memory_records',
  decision: 'memory_records',
  action: 'memory_records',
  entity: 'memory_records',
  source: 'memory_sources',
  episode: 'memory_episodes',
};

const RETAINED: ItemStatus[] = ['active', 'proposed', 'archived', 'superseded'];
/** Up to this many live items in a bucket, `similar` compares with each of them (no FTS over the owner's whole memory). */
export const SIMILAR_SCAN = 400;
export const INDEXED_STATUSES = new Set<string>(['active', 'proposed', 'archived', 'superseded']);

/** One search result: `match` = how well it matches (words + meaning), `score` = match plus small tie-breakers. */
export interface SearchHit {
  row: MemoryItemRow;
  score: number;
  match: number;
  /** Found (also) by meaning. */
  meaning?: boolean;
  /** Cosine similarity with the question (when the model ran). */
  sim?: number;
  /** Word strength (bm25 next to the best word hit, weighed by coverage) and the share of search words it covers. */
  lex?: number;
  cov?: number;
}

/** Filled by searchItems for the per-turn block: the best similarity of the search and the model's gate (if any). */
export interface SearchInfo {
  bestSim?: number | null;
  gate?: number | null;
}

export interface ChangeInput {
  userId: string;
  kind: string;
  recordId: string;
  dossierId?: string | null;
  op: string;
  before?: any;
  after?: any;
  summary: string;
  reason?: string;
  actor: Actor;
  actorId?: string | null;
  batchId?: string | null;
  undoable?: boolean;
  /** Days this change can be undone (default 30; cleanup changes longer, so the monthly report can still undo them). */
  undoDays?: number;
  /** The capture this change came from (a message, a lesson about one event): the same capture never writes twice. */
  idemKey?: string | null;
  /** The chat message this was learned from (shown under that message, with undo). */
  source?: { threadId?: string | null; ref?: string | null } | null;
}

function rand36(n: number) {
  const bytes = crypto.randomBytes(n);
  let s = '';
  for (let i = 0; i < n; i++) s += 'abcdefghijkmnpqrstuvwxyz23456789'[bytes[i] % 32];
  return s;
}

/**
 * Core primitives of the memory module: settings, ACL, items, versioned changes with undo, tombstones, the derived
 * FTS index and quotas. Higher-level flows (pipeline, forget, context, dossiers, episodes, lifecycle) build on this.
 */
export class MemoryService {
  private hmacKey: Buffer | null = null;
  /** Search by meaning (derived vectors, local Ollama); see semantic.ts. */
  readonly semantic: Semantic;

  constructor(public ctx: Ctx) {
    this.semantic = new Semantic(this);
  }

  get store() {
    return this.ctx.store;
  }

  // ------------------------------------------------------------------ settings

  limits() {
    return { ...DEFAULT_LIMITS, ...(this.store.getSetting<any>('', 'memory.limits', {}) || {}) };
  }

  userSettings(userId: string): UserMemorySettings {
    const raw = this.store.getSetting<any>(userId, 'memory', {}) || {};
    const s: UserMemorySettings = {
      ...DEFAULT_SETTINGS,
      ...raw,
      quotas: { ...DEFAULT_SETTINGS.quotas, ...(raw.quotas || {}) },
    };
    const lim = this.limits();
    for (const k of ['about_you', 'agent', 'shared', 'dossier', 'episode'] as const) {
      const q = { ...DEFAULT_SETTINGS.quotas[k], ...(s.quotas[k] || {}) };
      s.quotas[k] = { items: Math.max(10, Math.min(lim.items, Number(q.items) || 0)), bytes: Math.max(10_000, Math.min(lim.bytes, Number(q.bytes) || 0)) };
    }
    s.quotas.proposals = Math.max(10, Math.min(2000, Number(s.quotas.proposals) || 200));
    s.budgetTokens = Math.max(0, Math.min(lim.budgetTokens, Number(s.budgetTokens) || 0));
    s.profileCap = Math.max(0, Math.min(lim.profileCap, Number(s.profileCap) || 0));
    s.trashDays = Math.max(1, Math.min(365, Number(s.trashDays) || 30));
    // (5000 was the old default, and its highest value: no limit then, so none now either.)
    s.modelDailyCap = Number(s.modelDailyCap) === 5000 ? 0 : Math.max(0, Math.min(100_000, Number(s.modelDailyCap) || 0));
    if (!['off', 'explicit', 'auto'].includes(s.learnMode)) s.learnMode = 'auto';
    if (!['heuristic', 'own', 'free', 'model'].includes(s.extractor)) s.extractor = 'own';
    if (!['own', 'never'].includes(s.autoApply)) s.autoApply = 'own';
    s.quietMin = Math.max(1, Math.min(240, Number(s.quietMin) || 15));
    s.learnEvery = Number.isFinite(Number(s.learnEvery)) ? Math.max(0, Math.min(500, Math.round(Number(s.learnEvery)))) : 20;
    s.engine = { providerId: typeof s.engine?.providerId === 'string' && s.engine.providerId ? s.engine.providerId : null, model: typeof s.engine?.model === 'string' && /^[\w.:/@+#-]{1,120}$/.test(s.engine.model) ? s.engine.model : null };
    s.nightly = s.nightly !== false;
    s.briefTokens = Math.max(0, Math.min(2000, Number.isFinite(Number(s.briefTokens)) ? Number(s.briefTokens) : 300));
    if (!['direct', 'propose'].includes(s.botWrites)) s.botWrites = 'direct';
    if (!['ask', 'replace'].includes(s.conflicts)) s.conflicts = 'ask';
    s.reviewEveryDays = reviewInterval(s.reviewEveryDays) ?? 180;
    s.paused = !!s.paused;
    s.episodes = s.episodes !== false;
    s.semantic = s.semantic === 'off' ? 'off' : 'auto';
    s.semanticModel = typeof s.semanticModel === 'string' && /^[\w.:/@+-]{1,120}$/.test(s.semanticModel) ? s.semanticModel : null;
    // Targets stay below the quota of their part (a target above it would never be reached before "vol").
    const t = { ...DEFAULT_SETTINGS.targets, ...(raw.targets || {}) };
    s.targets = {
      about_you: Math.max(20, Math.min(s.quotas.about_you.items - 10, Number(t.about_you) || DEFAULT_SETTINGS.targets.about_you)),
      agent: Math.max(20, Math.min(s.quotas.agent.items - 10, Number(t.agent) || DEFAULT_SETTINGS.targets.agent)),
      shared: Math.max(20, Math.min(s.quotas.shared.items - 10, Number(t.shared) || DEFAULT_SETTINGS.targets.shared)),
      dossier: Math.max(20, Math.min(s.quotas.dossier.items - 10, Number(t.dossier) || DEFAULT_SETTINGS.targets.dossier)),
      client: Math.max(10, Math.min(s.quotas.dossier.items - 10, Number(t.client) || DEFAULT_SETTINGS.targets.client)),
      clientEpisodesDays: Math.max(7, Math.min(3650, Number(t.clientEpisodesDays) || DEFAULT_SETTINGS.targets.clientEpisodesDays!)),
    };
    s.archiveAfterDays = Math.max(30, Math.min(3650, Number(s.archiveAfterDays) || DEFAULT_SETTINGS.archiveAfterDays));
    if (!['off', 'propose', 'create'].includes(s.dossierAuto)) s.dossierAuto = 'propose';
    return s;
  }

  saveUserSettings(userId: string, patch: Partial<UserMemorySettings>): UserMemorySettings {
    const cur = this.store.getSetting<any>(userId, 'memory', {}) || {};
    const before = this.userSettings(userId);
    const next: any = { ...cur };
    for (const k of ['learnMode', 'paused', 'extractor', 'autoApply', 'quietMin', 'learnEvery', 'engine', 'nightly', 'briefTokens', 'botWrites', 'conflicts', 'reviewEveryDays', 'episodes', 'semantic', 'semanticModel', 'budgetTokens', 'profileCap', 'trashDays', 'modelDailyCap', 'archiveAfterDays', 'dossierAuto'] as const) {
      if ((patch as any)[k] !== undefined) next[k] = (patch as any)[k];
    }
    if (patch.quotas && typeof patch.quotas === 'object') next.quotas = { ...(cur.quotas || {}), ...patch.quotas };
    if (patch.targets && typeof patch.targets === 'object') next.targets = { ...(cur.targets || {}), ...patch.targets };
    this.store.setSetting(userId, 'memory', next);
    const after = this.userSettings(userId);
    if (after.semantic !== before.semantic || after.semanticModel !== before.semanticModel) {
      this.semantic.forgetInfo(userId);
      // Off: the vectors are derived data with no use any more. On or another model: (re)made in the background.
      if (after.semantic === 'off') this.semantic.dropUser(userId);
      else this.semantic.kick();
    }
    return after;
  }

  agentSettings(agent: Agent): AgentMemorySettings {
    const m = (agent.settings?.memory || {}) as Partial<AgentMemorySettings>;
    return {
      learn: (['inherit', 'off', 'explicit', 'auto'].includes(m.learn as string) ? m.learn : 'inherit') as AgentMemorySettings['learn'],
      budgetTokens: m.budgetTokens === null || m.budgetTokens === undefined || (m.budgetTokens as any) === '' ? null : Number(m.budgetTokens),
      profileCap: m.profileCap === null || m.profileCap === undefined || (m.profileCap as any) === '' ? null : Number(m.profileCap),
      readShared: m.readShared !== false,
      readAboutYou: m.readAboutYou !== false,
      botWrites: (['inherit', 'direct', 'propose'].includes(m.botWrites as string) ? m.botWrites : 'inherit') as AgentMemorySettings['botWrites'],
    };
  }

  /** Effective settings for one bot (user defaults + bot overrides, clamped). */
  effective(agent: Agent) {
    const u = this.userSettings(agent.user_id);
    const a = this.agentSettings(agent);
    const lim = this.limits();
    const learn = a.learn === 'inherit' ? u.learnMode : a.learn;
    return {
      enabled: this.ctx.tools.groupEnabled(agent, 'memory'),
      hasTools: this.ctx.tools.groupEnabled(agent, 'memory') && agent.access_mode !== 'chat',
      learn: u.paused && learn === 'auto' ? ('explicit' as const) : learn,
      paused: u.paused,
      extractor: u.extractor,
      episodes: u.episodes,
      budgetTokens: Math.max(0, Math.min(lim.budgetTokens, a.budgetTokens ?? u.budgetTokens)),
      profileCap: Math.max(0, Math.min(lim.profileCap, a.profileCap ?? u.profileCap)),
      readShared: a.readShared,
      readAboutYou: a.readAboutYou,
      botWrites: a.botWrites === 'inherit' ? u.botWrites : a.botWrites,
    };
  }

  // ------------------------------------------------------------------ readers / audience

  /** Who can see a thread: private (owner only), room (owner + bots), public (other humans or external people). */
  audience(thread: Thread | null, ownerId: string): Reader['audience'] {
    if (!thread) return 'private';
    const members = ((thread.meta?.memberUserIds as string[]) || []).filter((u) => u && u !== ownerId);
    // 0.4.5: a channel conversation with an identified customer (private chat, customer mode, e-mail only with a
    // passed sender check) reads that customer's dossier and nothing else; every other channel thread stays public.
    if (thread.kind === 'channel' && !members.length && thread.user_id === ownerId && this.customerDossierOf(thread)) return 'customer';
    // The owner himself writing to his own bot on a channel (WhatsApp, Telegram …; the channel verified the sender in a
    // one-to-one chat): his bot knows there what it knows in the app, and keeps the dossiers up to date from there too.
    if (thread.kind === 'channel' && !members.length && thread.user_id === ownerId && this.ownerChannel(thread)) return 'private';
    if (thread.kind === 'channel' || members.length || thread.user_id !== ownerId) return 'public';
    if (thread.kind === 'room' || thread.room_id) return 'room';
    return 'private';
  }

  /** Is the latest incoming message of this channel thread from the verified owner, one-to-one (channels/manager.ts)? */
  ownerChannel(thread: Thread): boolean {
    const m = this.store.one<any>("SELECT author_type, parts FROM messages WHERE thread_id = ? AND role = 'user' ORDER BY seq DESC LIMIT 1", thread.id);
    if (!m || m.author_type !== 'external') return false;
    let ch: any = null;
    try {
      ch = (typeof m.parts === 'string' ? JSON.parse(m.parts) : m.parts)?.channel;
    } catch {
      return false;
    }
    return ch?.isOwner === true && ch?.private !== false && !ch?.outbound;
  }

  /** The dossier of the identified customer of a channel thread (customers.ts), or null. Set by the module. */
  customerDossierOf: (thread: Thread) => string | null = () => null;

  readerFor(agent: Agent, thread: Thread | null): Reader {
    const e = this.effective(agent);
    const audience = this.audience(thread, agent.user_id);
    const r: Reader = { userId: agent.user_id, agentId: agent.id, audience, readShared: e.readShared, readAboutYou: e.readAboutYou, teams: this.teamScope(agent) };
    // readShared/readAboutYou stay as they are for the owner's standing rules (system prompt, as in any channel
    // thread); for memory itself the customer wall in aclSql/readableDossiers ignores them.
    if (audience === 'customer') r.customerDossierId = this.customerDossierOf(thread!);
    return r;
  }

  userReader(userId: string): Reader {
    return { userId, agentId: null, audience: 'private', readShared: true, readAboutYou: true, asUser: true };
  }

  // ------------------------------------------------------------------ teams (0.4 B: memory per team)
  //
  // A bot note and shared knowledge carry a team (team_id: a team, '*' = all teams, NULL = the default team); a dossier
  // carries one too and its records, sources, document parts and notes follow it; conversation summaries carry the team
  // of their bot. "Over jou" is personal. A bot reads its home team plus the teams it may look into, and writes only in
  // its home team. The owner sees everything. Decided here, on the source rows; the derived stores never decide.

  /** The teams service, when the teams module is loaded. */
  get teams(): any | null {
    return this.ctx.services.teams || null;
  }

  /** The owner's teams: the default team (first), all ids and names; null when there are none (nothing is walled). */
  teamInfo(userId: string): { def: string; ids: Set<string>; names: Map<string, string>; multi: boolean } | null {
    const t = this.teams;
    if (!t || !userId) return null;
    const list = (t.list(userId) || []) as { id: string; name: string }[];
    if (!list.length) return null;
    return { def: list[0].id, ids: new Set(list.map((x) => x.id)), names: new Map(list.map((x) => [x.id, x.name])), multi: list.length > 1 };
  }

  /**
   * A bot's walls: its home team and the teams it may read. Null = no walls (no teams module or teams, or a shared bot
   * in a member's conversation, which reads the member's own memory). A bot the teams module does not know reaches
   * no team (fail closed).
   */
  teamScope(agent: Agent): TeamScope | null {
    const t = this.teams;
    if (!t || agent.settings?.sharedRun) return null;
    let read: string[] = [];
    try {
      read = (t.readableTeams(agent.id) || []) as string[];
    } catch {
      read = [];
    }
    const info = this.teamInfo(agent.user_id);
    if (!info) return null;
    read = read.filter((id) => info.ids.has(id));
    return { home: read[0] ?? null, read, def: info.def };
  }

  /** The home team a bot writes in (null: no walls). */
  homeTeam(agentOrId: Agent | string | null | undefined): string | null {
    const a = typeof agentOrId === 'string' ? this.store.agent(agentOrId) : agentOrId;
    return a ? (this.teamScope(a)?.home ?? null) : null;
  }

  /** A stored team value as a team: NULL = the default team, '*' stays; null when the owner has no teams. */
  resolveTeam(userId: string, teamId: string | null | undefined): string | null {
    if (teamId === ALL_TEAMS) return ALL_TEAMS;
    const info = this.teamInfo(userId);
    if (!info) return teamId ?? null;
    return teamId || info.def;
  }

  /** The team an item belongs to (null = personal "Over jou" or no teams; a dossier note follows its dossier). */
  itemTeam(row: { user_id: string; scope: string; team_id?: string | null; dossier_id?: string | null }): string | null {
    if (row.scope === 'about_you') return null;
    if (row.scope === 'dossier') {
      const d = this.store.one<any>('SELECT user_id, team_id FROM memory_dossiers WHERE id = ?', row.dossier_id);
      return d ? this.resolveTeam(d.user_id, d.team_id) : null;
    }
    return this.resolveTeam(row.user_id, row.team_id);
  }

  /** The name of a team for messages ("alle teams" for '*'). */
  teamName(userId: string, teamId: string | null | undefined): string {
    if (teamId === ALL_TEAMS) return 'alle teams';
    const t = this.resolveTeam(userId, teamId);
    return (t && this.teamInfo(userId)?.names.get(t)) || 'een ander team';
  }

  /** {id, name} of a team for the owner's views, only when he has two or more teams (one team = no team words). */
  teamTag(userId: string, teamId: string | null | undefined): { id: string; name: string } | null {
    const info = this.teamInfo(userId);
    if (!info?.multi) return null;
    if (teamId === ALL_TEAMS) return { id: ALL_TEAMS, name: 'Alle teams' };
    const t = teamId || info.def;
    return { id: t, name: info.names.get(t) || 'Team verwijderd' };
  }

  /** Is this a team value the owner may choose (one of his teams or '*')? */
  validTeam(userId: string, teamId: string | null | undefined): boolean {
    if (teamId === ALL_TEAMS) return true;
    return !!teamId && !!this.teamInfo(userId)?.ids.has(teamId);
  }

  /** SQL: the column is one of these teams (NULL counts as the default team; '*' only with allowAll). */
  teamIn(col: string, teams: string[], def: string | null, allowAll = false): { sql: string; params: any[] } {
    const parts: string[] = [];
    const params: any[] = [];
    if (teams.length) {
      parts.push(`${col} IN (${teams.map(() => '?').join(',')})`);
      params.push(...teams);
    }
    if (def && teams.includes(def)) parts.push(`${col} IS NULL`);
    if (allowAll) parts.push(`${col} = '${ALL_TEAMS}'`);
    return { sql: parts.length ? `(${parts.join(' OR ')})` : '0', params };
  }

  /** SQL: the column is this one team (a stored value; NULL and the default team are the same). '1' without teams. */
  teamEq(col: string, userId: string, teamId: string | null | undefined): { sql: string; params: any[] } {
    const info = this.teamInfo(userId);
    if (!info) return { sql: '1', params: [] };
    if (teamId === ALL_TEAMS) return { sql: `${col} = '${ALL_TEAMS}'`, params: [] };
    const t = teamId || info.def;
    return t === info.def ? { sql: `(${col} = ? OR ${col} IS NULL)`, params: [t] } : { sql: `${col} = ?`, params: [t] };
  }

  /** May this reader see data of this team (a stored value)? The owner and readers without walls always may. */
  readerSeesTeam(reader: Reader, teamId: string | null | undefined, allowAll = true): boolean {
    const tm = reader.teams;
    if (!tm) return true;
    if (teamId === ALL_TEAMS) return allowAll;
    const t = teamId || tm.def;
    return !!t && tm.read.includes(t);
  }

  /** May this bot write data of this team (a stored value)? Only its home team, never "alle teams" (the owner's). */
  botMayWriteTeam(agent: Agent, teamId: string | null | undefined): boolean {
    const tm = this.teamScope(agent);
    if (!tm) return true;
    if (teamId === ALL_TEAMS) return false;
    const t = teamId || tm.def;
    return !!tm.home && t === tm.home;
  }

  /** Why a bot may not write here (team walls), in words for the bot; null = it may. */
  teamWriteRefusal(agent: Agent, teamId: string | null | undefined): string | null {
    if (this.botMayWriteTeam(agent, teamId)) return null;
    if (teamId === ALL_TEAMS) return 'Geweigerd door TeamBot: dit geldt voor alle teams, en alleen de eigenaar past dat aan. Sla het op in je eigen team of vraag het de eigenaar.';
    return `Geweigerd door TeamBot: dit hoort bij team “${this.teamName(agent.user_id, teamId)}”, en ${agent.name} mag daar alleen meelezen, niet schrijven.`;
  }

  /** Why a bot may not write in this dossier (team walls; a dossier another person shared is decided by its ACL). */
  dossierWriteRefusal(agent: Agent, dossierId: string | null | undefined): string | null {
    const d = dossierId ? this.store.one<any>('SELECT user_id, team_id FROM memory_dossiers WHERE id = ?', dossierId) : null;
    if (!d || d.user_id !== agent.user_id) return null;
    return this.teamWriteRefusal(agent, d.team_id);
  }

  /** Why a bot may not change or forget this item (team walls), or null. "Over jou" stays a proposal as before. */
  itemWriteRefusal(agent: Agent, row: MemoryItemRow): string | null {
    if (row.user_id !== agent.user_id || row.scope === 'about_you') return null;
    if (row.scope === 'dossier') return this.dossierWriteRefusal(agent, row.dossier_id);
    return this.teamWriteRefusal(agent, row.team_id ?? null);
  }

  /** The owner's team filter (memory page): bot notes and shared knowledge of that team, and notes in its dossiers. */
  ownerItemTeamSql(userId: string, teamId: string, alias = 'i'): { sql: string; params: any[] } {
    const eq = this.teamEq(`${alias}.team_id`, userId, teamId);
    const deq = this.teamEq('d.team_id', userId, teamId);
    return {
      sql: `((${alias}.scope IN ('agent','shared') AND ${eq.sql}) OR (${alias}.scope = 'dossier' AND ${alias}.dossier_id IN (SELECT d.id FROM memory_dossiers d WHERE d.user_id = ? AND ${deq.sql})))`,
      params: [...eq.params, userId, ...deq.params],
    };
  }

  /** Dossier ids of one team of the owner (the team filter). */
  teamDossierIds(userId: string, teamId: string): Set<string> {
    const eq = this.teamEq('team_id', userId, teamId);
    return new Set(this.store.all<any>(`SELECT id FROM memory_dossiers WHERE user_id = ? AND ${eq.sql}`, userId, ...eq.params).map((r) => r.id));
  }

  // ------------------------------------------------------------------ crypto helpers

  private key(): Buffer {
    if (this.hmacKey) return this.hmacKey;
    // Install-wide key held by the core secret store (system user '' is never listed to anyone).
    let k = this.ctx.secrets.getByName('', 'memory:hmac-key');
    if (!k) {
      k = crypto.randomBytes(32).toString('base64');
      this.ctx.secrets.set('', 'memory:hmac-key', k);
    }
    this.hmacKey = Buffer.from(k, 'base64');
    return this.hmacKey;
  }

  hmac(userId: string, text: string, len = 32): string {
    return crypto.createHmac('sha256', this.key()).update(userId + '\u0000' + text).digest('hex').slice(0, len);
  }

  contentHash(userId: string, content: string): string {
    return this.hmac(userId, 'c:' + normalize(content));
  }

  tokenHashes(userId: string, text: string): string[] {
    return tokens(text, 40).map((t) => this.hmac(userId, 't:' + t, 12));
  }

  encrypt(s: string) {
    return this.ctx.secrets.encrypt(s);
  }

  decrypt(s: string): string {
    try {
      return this.ctx.secrets.decrypt(s);
    } catch {
      return '';
    }
  }

  // ------------------------------------------------------------------ refs

  newRef(table: string, userId: string): string {
    for (let i = 0; i < 30; i++) {
      const r = rand36(6);
      if (!this.store.one(`SELECT 1 FROM ${table} WHERE user_id = ? AND ref = ?`, userId, r)) return r;
    }
    return rand36(10);
  }

  refOf(kind: string, ref: string) {
    return `${(REF_PREFIX as any)[kind] || 'm'}:${ref}`;
  }

  /** Resolve "m:abc123", "[d:xyz]", a bare ref or a full id to a record the user may read. */
  resolve(userId: string, input: string): { kind: string; row: any } | null {
    const s = String(input || '').trim().replace(/^\[|\]$/g, '');
    if (!s) return null;
    const m = s.match(/^([a-z]{1,2}):([a-z0-9]{4,12})$/i);
    const prefixes: Record<string, string[]> = { m: ['item'], d: ['dossier'], e: ['episode'], g: ['event'], b: ['decision'], a: ['action'], p: ['entity'], s: ['source'] };
    const byRef = (kind: string, ref: string) => {
      const table = TABLE_OF[kind];
      const rows = this.store.all<any>(`SELECT * FROM ${table} WHERE ref = ?`, ref).map((r) => this.store.decode(table, r));
      for (const r of rows) {
        if (table === 'memory_records' && r.kind !== kind) continue;
        if (r.user_id === userId) return r;
        const dossierId = table === 'memory_dossiers' ? r.id : r.dossier_id;
        if (dossierId && this.dossierRole(userId, dossierId)) return r;
      }
      return null;
    };
    if (m) {
      for (const kind of prefixes[m[1].toLowerCase()] || []) {
        const row = byRef(kind, m[2].toLowerCase());
        if (row) return { kind, row };
      }
      return null;
    }
    const idPrefix: Record<string, string> = { mem_: 'item', dos_: 'dossier', rec_: 'record', src_: 'source', epi_: 'episode' };
    for (const [p, kind] of Object.entries(idPrefix)) {
      if (!s.startsWith(p)) continue;
      const table = kind === 'record' ? 'memory_records' : TABLE_OF[kind];
      const row = this.store.get<any>(table, s);
      if (!row) return null;
      const dossierId = table === 'memory_dossiers' ? row.id : row.dossier_id;
      if (row.user_id !== userId && !(dossierId && this.dossierRole(userId, dossierId))) return null;
      return { kind: kind === 'record' ? row.kind : kind, row };
    }
    if (/^[a-z0-9]{4,12}$/i.test(s)) {
      for (const kind of ['item', 'dossier', 'event', 'decision', 'action', 'entity', 'source', 'episode']) {
        const row = byRef(kind, s.toLowerCase());
        if (row) return { kind, row };
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ dossier access

  /** 'owner' | 'edit' | 'read' | null for a human user. */
  dossierRole(userId: string, dossierId: string | null | undefined): 'owner' | 'edit' | 'read' | null {
    if (!dossierId) return null;
    const d = this.store.one<any>('SELECT user_id, status FROM memory_dossiers WHERE id = ?', dossierId);
    if (!d || d.status === 'forgotten') return null;
    if (d.user_id === userId) return 'owner';
    if (d.status === 'trashed') return null;
    const acl = this.store.one<any>('SELECT role FROM memory_dossier_acl WHERE dossier_id = ? AND user_id = ?', dossierId, userId);
    return acl ? (acl.role === 'edit' ? 'edit' : 'read') : null;
  }

  /**
   * Dossier ids a reader (bot or human) may read. `archived` (0.4.4): also archived dossiers (a customer nobody worked on
   * for a long time) — for a bot's own search, never for its per-turn block.
   */
  readableDossiers(reader: Reader, o: { archived?: boolean } = {}): string[] {
    // A customer conversation (0.4.5): that customer's dossier only, within the bot's team walls.
    if (reader.audience === 'customer') {
      const d = reader.customerDossierId ? this.store.one<any>('SELECT id, team_id, status FROM memory_dossiers WHERE id = ? AND user_id = ?', reader.customerDossierId, reader.userId) : null;
      const ok = d && (['active', 'closed'].includes(d.status) || (o.archived && d.status === 'archived')) && this.readerSeesTeam(reader, d.team_id);
      return ok ? [d.id] : [];
    }
    if (reader.asUser) {
      return this.store
        .all<any>(
          `SELECT id FROM memory_dossiers WHERE user_id = ? AND status != 'forgotten'
           UNION SELECT d.id FROM memory_dossiers d JOIN memory_dossier_acl a ON a.dossier_id = d.id WHERE a.user_id = ? AND d.status IN ('active','closed','archived')`,
          reader.userId,
          reader.userId,
        )
        .map((r) => r.id);
    }
    // Team walls first (a dossier of a team the bot may not read is closed, whatever its bot list says), then the
    // dossier's own bot list (null = every bot that may read its team).
    const own = this.store
      .all<any>(`SELECT id, agent_ids, team_id, core FROM memory_dossiers WHERE user_id = ? AND status IN ('active','closed'${o.archived ? ",'archived'" : ''})`, reader.userId)
      .filter((d) => {
        // The owner's dossier is personal: not for a bot with "Over jou" off, never where strangers read along. A team's
        // overview and lessons are its shared knowledge: not for a bot that does not read that.
        if (d.core === 'owner' && (!reader.readAboutYou || reader.audience === 'public')) return false;
        if ((d.core === 'overview' || d.core === 'lessons') && !reader.readShared) return false;
        if (!this.readerSeesTeam(reader, d.team_id)) return false;
        let ids: any = d.agent_ids;
        if (typeof ids === 'string') {
          try {
            ids = JSON.parse(ids);
          } catch {
            ids = null;
          }
        }
        return !Array.isArray(ids) || ids.includes(reader.agentId);
      })
      .map((d) => d.id);
    if (!reader.readShared) return own;
    const shared = this.store
      .all<any>("SELECT d.id FROM memory_dossiers d JOIN memory_dossier_acl a ON a.dossier_id = d.id WHERE a.user_id = ? AND d.status IN ('active','closed')", reader.userId)
      .map((d) => d.id);
    return [...new Set([...own, ...shared])];
  }

  /** WHERE clause (alias i) restricting memory_items to what the reader may read. */
  aclSql(reader: Reader, alias = 'i', o: { history?: boolean; archived?: boolean } = {}): { sql: string; params: any[] } {
    const dossiers = this.readableDossiers(reader, { archived: o.archived });
    const dIn = dossiers.length ? `${alias}.dossier_id IN (${dossiers.map(() => '?').join(',')})` : '0';
    if (reader.asUser) return { sql: `(${alias}.user_id = ? OR (${alias}.scope = 'dossier' AND ${dIn}))`, params: [reader.userId, ...dossiers] };
    // The customer wall (0.4.5), the same pattern as the team walls: one dossier, in SQL, so no tool can cross it.
    // Nothing else: no "Over jou", no bot notes, no shared knowledge, no other dossier, nothing sensitive (his own
    // personal details, like his address, are what the dossier is for).
    if (reader.audience === 'customer') {
      const st = o.history ? `${alias}.status IN ('active','superseded')` : `${alias}.status = 'active'`;
      if (!dossiers.length) return { sql: '0', params: [] };
      return { sql: `${st} AND ${alias}.user_id = ? AND ${alias}.scope = 'dossier' AND ${alias}.dossier_id = ? AND ${alias}.sensitivity != 'sensitive'`, params: [reader.userId, dossiers[0]] };
    }
    const parts: string[] = [];
    const params: any[] = [];
    // "Over jou" is personal (no team); a bot note and shared knowledge only in a team the bot may read (shared also
    // "voor alle teams"); dossiers through readableDossiers, which applies the same walls.
    const tm = reader.teams;
    const own = tm ? this.teamIn(`${alias}.team_id`, tm.read, tm.def) : null;
    const shared = tm ? this.teamIn(`${alias}.team_id`, tm.read, tm.def, true) : null;
    if (reader.readAboutYou && reader.audience !== 'public') {
      parts.push(`(${alias}.user_id = ? AND ${alias}.scope = 'about_you')`);
      params.push(reader.userId);
    }
    parts.push(`(${alias}.user_id = ? AND ${alias}.scope = 'agent' AND ${alias}.agent_id = ?${own ? ` AND ${own.sql}` : ''})`);
    params.push(reader.userId, reader.agentId, ...(own?.params || []));
    if (reader.readShared) {
      parts.push(`(${alias}.user_id = ? AND ${alias}.scope = 'shared'${shared ? ` AND ${shared.sql}` : ''})`);
      params.push(reader.userId, ...(shared?.params || []));
    }
    if (dossiers.length) {
      parts.push(`(${alias}.scope = 'dossier' AND ${dIn})`);
      params.push(...dossiers);
    }
    // History (0.4.4): what no longer holds (old versions, ended facts, done tasks) only when the bot asks for it.
    let sql = `${o.history ? `${alias}.status IN ('active','superseded')` : `${alias}.status = 'active'`} AND (${parts.join(' OR ')})`;
    if (reader.audience === 'public') sql += ` AND ${alias}.sensitivity = 'normal'`;
    return { sql, params };
  }

  canReadItem(reader: Reader, row: MemoryItemRow | null): boolean {
    if (!row) return false;
    const acl = this.aclSql(reader);
    return !!this.store.one(`SELECT 1 FROM memory_items i WHERE i.id = ? AND ${acl.sql}`, row.id, ...acl.params);
  }

  // ------------------------------------------------------------------ items

  itemRow(id: string): MemoryItemRow | null {
    return this.store.get<MemoryItemRow>('memory_items', id);
  }

  contentOf(row: { content: string; content_enc?: string | null }): string {
    return row.content_enc ? this.decrypt(row.content_enc) : row.content;
  }

  view(row: MemoryItemRow | null, extra: { names?: boolean } = {}): MemoryItem | null {
    if (!row) return null;
    const { content_enc, hash, idem_key, ...rest } = row as any;
    const out: MemoryItem = { ...rest, content: this.contentOf(row), ref: row.ref };
    // Learned automatically from a conversation (0.4.5): from the owner's words, the bot's reply or a tool result.
    const k = String(idem_key || '');
    const from = /^(ml|mx|mu|h):/.test(k) ? 'owner' : k.startsWith('mb:') ? 'bot' : k.startsWith('mt:') ? 'tool' : null;
    if (from) out.learned_from = from;
    if (extra.names !== false) {
      if (row.agent_id) out.agent_name = this.store.one<any>('SELECT name FROM agents WHERE id = ?', row.agent_id)?.name ?? null;
      if (row.dossier_id) out.dossier_title = this.store.one<any>('SELECT title FROM memory_dossiers WHERE id = ?', row.dossier_id)?.title ?? null;
      if (row.source_thread_id) out.source_thread_title = this.store.one<any>('SELECT title FROM threads WHERE id = ?', row.source_thread_id)?.title ?? null;
      // The team, only with two or more teams (one team = no team words anywhere).
      if (row.scope !== 'about_you') {
        const team = row.scope === 'dossier' ? this.store.one<any>('SELECT team_id FROM memory_dossiers WHERE id = ?', row.dossier_id)?.team_id ?? null : row.team_id ?? null;
        out.team = this.teamTag(row.user_id, team);
      }
    }
    void content_enc;
    void hash;
    void idem_key;
    return out;
  }

  /** Content/encryption/hash fields for a (new) content value. */
  encodeContent(userId: string, content: string, sensitivity: string) {
    const c = clean(content);
    return {
      content: sensitivity === 'sensitive' ? '' : c,
      content_enc: sensitivity === 'sensitive' ? this.encrypt(c) : null,
      hash: this.contentHash(userId, c),
      bytes: Buffer.byteLength(c, 'utf8') + 64,
    };
  }

  insertItem(row: Partial<MemoryItemRow> & { user_id: string; scope: Scope; content: string }): MemoryItemRow {
    const ts = now();
    const enc = this.encodeContent(row.user_id, row.content, row.sensitivity || 'normal');
    const full: any = {
      id: newId('mem_'),
      ref: this.newRef('memory_items', row.user_id),
      agent_id: null,
      dossier_id: null,
      type: 'fact',
      canonical_key: null,
      key_norm: null,
      source_kind: 'user',
      source_trust: 'user',
      confidence: 0.8,
      sensitivity: 'normal',
      status: 'active',
      flags: [],
      pinned: false,
      version: 1,
      created_by: 'user',
      use_count: 0,
      created_at: ts,
      updated_at: ts,
      observed_at: ts,
      ...row,
      ...enc,
    };
    full.key_norm = canonicalKey(full.canonical_key);
    if (full.status === 'active' && !full.valid_from) full.valid_from = ts;
    this.store.insert('memory_items', full);
    const r = this.itemRow(full.id)!;
    this.syncIndex('item', r.id);
    return r;
  }

  /** Patch an item row (re-encrypts content when needed) and refresh its index entry. */
  patchItem(id: string, patch: Partial<MemoryItemRow> & { content?: string }) {
    const cur = this.itemRow(id);
    if (!cur) return null;
    const p: any = { ...patch, updated_at: now() };
    const sens = (patch.sensitivity || cur.sensitivity) as string;
    if (patch.content !== undefined || (patch.sensitivity && patch.sensitivity !== cur.sensitivity)) {
      const content = patch.content !== undefined ? patch.content : this.contentOf(cur);
      Object.assign(p, this.encodeContent(cur.user_id, content, sens));
    }
    if (patch.canonical_key !== undefined) p.key_norm = canonicalKey(patch.canonical_key);
    this.store.update('memory_items', id, p);
    this.syncIndex('item', id);
    return this.itemRow(id);
  }

  /**
   * The bucket of an item for dedup, conflicts and quotas: "Over jou" (personal, all teams), one bot's notes in one
   * team, shared knowledge of one team (or "alle teams"), one dossier. So a duplicate is only a duplicate within a
   * team and every team has its own quota; forget-blocks stay per owner (forgetting is global).
   */
  bucketWhere(row: { user_id: string; scope: string; agent_id?: string | null; dossier_id?: string | null; team_id?: string | null }, alias = '') {
    const p = alias ? `${alias}.` : '';
    if (row.scope === 'dossier') return { sql: `${p}scope = ? AND ${p}dossier_id = ?`, params: [row.scope, row.dossier_id] };
    if (row.scope === 'agent' || row.scope === 'shared') {
      const t = this.teamEq(`${p}team_id`, row.user_id, row.team_id ?? null);
      const agent = row.scope === 'agent' ? ` AND ${p}agent_id = ?` : '';
      return { sql: `${p}user_id = ? AND ${p}scope = ?${agent} AND ${t.sql}`, params: [row.user_id, row.scope, ...(row.scope === 'agent' ? [row.agent_id] : []), ...t.params] };
    }
    return { sql: `${p}user_id = ? AND ${p}scope = ?`, params: [row.user_id, row.scope] };
  }

  /** Active/proposed items in the same bucket with an identical normalised content hash. */
  exactDuplicate(userId: string, b: { scope: string; agent_id?: string | null; dossier_id?: string | null; team_id?: string | null }, hash: string): MemoryItemRow | null {
    const w = this.bucketWhere({ user_id: userId, ...b });
    const r = this.store.one<any>(`SELECT * FROM memory_items WHERE ${w.sql} AND hash = ? AND status IN ('active','proposed') ORDER BY status = 'active' DESC LIMIT 1`, ...w.params, hash);
    return r ? this.store.decode('memory_items', r) : null;
  }

  sameKey(userId: string, b: { scope: string; agent_id?: string | null; dossier_id?: string | null; team_id?: string | null }, keyNorm: string): MemoryItemRow | null {
    const w = this.bucketWhere({ user_id: userId, ...b });
    const r = this.store.one<any>(`SELECT * FROM memory_items WHERE ${w.sql} AND key_norm = ? AND status = 'active' ORDER BY updated_at DESC LIMIT 1`, ...w.params, keyNorm);
    return r ? this.store.decode('memory_items', r) : null;
  }

  /**
   * Similar items (token Jaccard) in the same bucket. A small bucket (a dossier, most bots) is compared item by item
   * through its index; a big one uses FTS to find candidates, and its sensitive items (not in FTS) are scanned.
   *
   * 0.4.5: before, every write ran the FTS query (the new text's words joined with OR) over all of the owner's items and
   * only then kept the bucket's: with 300 customer dossiers, words like "klant" matched almost every item of every
   * customer, so each new fact cost more than the one before (100 customers 18 s, 300 customers 138 s).
   */
  similar(userId: string, b: { scope: string; agent_id?: string | null; dossier_id?: string | null; team_id?: string | null }, content: string, limit = 5): { row: MemoryItemRow; sim: number }[] {
    const w = this.bucketWhere({ user_id: userId, ...b });
    const wi = this.bucketWhere({ user_id: userId, ...b }, 'i');
    const toks = tokens(content);
    if (!toks.length) return [];
    const cand = new Map<string, MemoryItemRow>();
    const live = `${w.sql} AND status IN ('active','proposed')`;
    const n = this.store.one<{ n: number }>(`SELECT COUNT(*) AS n FROM (SELECT 1 FROM memory_items WHERE ${live} LIMIT ${SIMILAR_SCAN + 1})`, ...w.params)?.n ?? 0;
    if (n <= SIMILAR_SCAN) {
      for (const r of this.store.all<any>(`SELECT * FROM memory_items WHERE ${live}`, ...w.params)) cand.set(r.id, this.store.decode('memory_items', r));
      return this.rankSimilar(toks, cand, limit);
    }
    const fq = ftsQuery(content, 16);
    if (fq) {
      for (const r of this.store.all<any>(
        `SELECT i.* FROM memory_fts f JOIN memory_items i ON i.id = f.rid WHERE memory_fts MATCH ? AND f.kind = 'item' AND f.user_id = ? AND i.status IN ('active','proposed') AND ${wi.sql} ORDER BY bm25(memory_fts) LIMIT 30`,
        fq,
        userId,
        ...wi.params,
      ))
        cand.set(r.id, this.store.decode('memory_items', r));
    }
    for (const r of this.store.all<any>(`SELECT * FROM memory_items WHERE ${w.sql} AND sensitivity = 'sensitive' AND status IN ('active','proposed') LIMIT 500`, ...w.params))
      cand.set(r.id, this.store.decode('memory_items', r));
    return this.rankSimilar(toks, cand, limit);
  }

  private rankSimilar(toks: string[], cand: Map<string, MemoryItemRow>, limit: number): { row: MemoryItemRow; sim: number }[] {
    const out: { row: MemoryItemRow; sim: number }[] = [];
    for (const row of cand.values()) {
      const sim = jaccard(toks, tokens(this.contentOf(row)));
      if (sim > 0) out.push({ row, sim });
    }
    return out.sort((a, b2) => b2.sim - a.sim).slice(0, limit);
  }

  // ------------------------------------------------------------------ changes & undo

  snapshot(kind: string, id: string): any {
    const table = TABLE_OF[kind] || 'memory_items';
    return this.store.get<any>(table, id);
  }

  recordChange(c: ChangeInput): string {
    const id = newId('mch_');
    const ts = now();
    this.store.insert('memory_changes', {
      id,
      user_id: c.userId,
      record_kind: c.kind,
      record_id: c.recordId,
      dossier_id: c.dossierId ?? null,
      op: c.op,
      before: c.before ?? null,
      after: c.after ?? null,
      before_hash: c.before?.hash ?? null,
      after_hash: c.after?.hash ?? null,
      summary: clean(c.summary, 300),
      reason: clean(c.reason || '', 300),
      actor: c.actor,
      actor_id: c.actorId ?? null,
      batch_id: c.batchId ?? null,
      undoable: c.undoable !== false,
      undo_until: c.undoable === false ? null : new Date(Date.now() + (c.undoDays || 30) * 864e5).toISOString(),
      redacted: false,
      ...(c.idemKey ? { idem_key: c.idemKey } : {}),
      ...(c.source?.threadId && c.source.ref ? { source_thread_id: c.source.threadId, source_ref: c.source.ref } : {}),
      created_at: ts,
    });
    return id;
  }

  /** Short label for history lists; sensitive content never appears in plain text. */
  label(row: { content?: string; content_enc?: string | null; sensitivity?: string; title?: string } | null): string {
    if (!row) return '';
    if (row.sensitivity === 'sensitive' || row.content_enc) return '(gevoelig item)';
    const t = row.content ?? row.title ?? '';
    return '“' + clean(t, 90) + '”';
  }

  /** Undo one change (or the whole batch it belongs to). */
  undo(userId: string, changeId: string, actorId: string): { undone: number; message: string } {
    const ch = this.store.get<any>('memory_changes', changeId);
    if (!ch || ch.user_id !== userId) throw new Error('Wijziging niet gevonden');
    const batch = ch.batch_id ? this.store.find<any>('memory_changes', { batch_id: ch.batch_id }, { order: 'created_at DESC, rowid DESC' }) : [ch];
    for (const c of batch) {
      if (c.undone_at) throw new Error('Deze wijziging is al ongedaan gemaakt');
      if (!c.undoable || c.redacted) throw new Error('Deze wijziging kan niet ongedaan worden gemaakt (bijv. vergeten of verlopen)');
      if (c.undo_until && c.undo_until < now()) throw new Error('De termijn om dit ongedaan te maken is verlopen');
      const later = this.store.one<any>(
        `SELECT id FROM memory_changes WHERE record_id = ? AND created_at > ? AND undone_at IS NULL AND op != 'undo' AND (batch_id IS NULL OR batch_id != ?) LIMIT 1`,
        c.record_id,
        c.created_at,
        c.batch_id ?? '',
      );
      if (later) throw new Error('Er is daarna nog iets aan dit item gewijzigd. Maak eerst die latere wijziging ongedaan.');
    }
    return this.store.tx(() => {
      const undoBatch = newId('mbt_');
      for (const c of batch) {
        const table = TABLE_OF[c.record_kind] || 'memory_items';
        const cur = this.store.get<any>(table, c.record_id);
        if (cur?.status === 'forgotten') throw new Error('Dit item is vergeten en kan niet worden teruggezet');
        if (c.before) {
          const snap = { ...c.before };
          delete snap.id;
          snap.updated_at = now();
          if (cur) this.store.update(table, c.record_id, snap);
          else this.store.insert(table, { ...c.before, updated_at: now() });
        } else if (cur) {
          // The change created the record: undo moves it to the trash (restorable for a while).
          this.store.update(table, c.record_id, { status: 'trashed', trashed_at: now(), updated_at: now() });
        }
        this.syncIndex(c.record_kind, c.record_id);
        this.store.update('memory_changes', c.id, { undone_at: now() });
        this.recordChange({
          userId,
          kind: c.record_kind,
          recordId: c.record_id,
          dossierId: c.dossier_id,
          op: 'undo',
          before: cur,
          after: this.store.get<any>(table, c.record_id),
          summary: `Ongedaan gemaakt: ${c.summary}`,
          actor: 'user',
          actorId,
          batchId: undoBatch,
          undoable: false,
        });
      }
      this.store.update('memory_changes', changeId, {});
      this.emit(userId, { op: 'undo', ids: batch.map((c: any) => c.record_id) });
      this.ctx.audit(userId, 'memory.undo', { change: changeId, count: batch.length });
      return { undone: batch.length, message: batch.length > 1 ? `${batch.length} wijzigingen ongedaan gemaakt` : 'Ongedaan gemaakt' };
    });
  }

  // ------------------------------------------------------------------ tombstones (hard forget blocks)

  tombstone(o: { userId: string; kind: 'forget' | 'reject'; recordKind: string; recordId: string | null; scope?: string | null; label: string; content: string; key?: string | null; days?: number }) {
    const id = newId('tmb_');
    this.store.insert('memory_tombstones', {
      id,
      user_id: o.userId,
      kind: o.kind,
      record_kind: o.recordKind,
      record_id: o.recordId,
      scope: o.scope ?? null,
      label: clean(o.label, 120),
      content_hash: o.content ? this.contentHash(o.userId, o.content) : null,
      key_hash: o.key ? this.hmac(o.userId, 'k:' + canonicalKey(o.key)) : null,
      tokens: o.content ? this.tokenHashes(o.userId, o.content) : [],
      created_at: now(),
      expires_at: o.days ? new Date(Date.now() + o.days * 864e5).toISOString() : null,
    });
    return id;
  }

  /** Does a forget-tombstone (or a recent rejection) block this content? */
  blockedBy(userId: string, content: string, key: string | null | undefined, kinds: ('forget' | 'reject')[] = ['forget']): any | null {
    const hash = this.contentHash(userId, content);
    const keyHash = key ? this.hmac(userId, 'k:' + canonicalKey(key)) : null;
    const th = this.tokenHashes(userId, content);
    const rows = this.store.all<any>(
      `SELECT * FROM memory_tombstones WHERE user_id = ? AND kind IN (${kinds.map(() => '?').join(',')}) AND (expires_at IS NULL OR expires_at > ?)`,
      userId,
      ...kinds,
      now(),
    );
    for (const r0 of rows) {
      const r = this.store.decode<any>('memory_tombstones', r0);
      if (r.content_hash && r.content_hash === hash) return r;
      if (r.kind === 'forget' && keyHash && r.key_hash && r.key_hash === keyHash && th.length) {
        // Same key: block when the content overlaps (a new, different value for the same key is allowed).
        if (jaccard(r.tokens, th) >= 0.5) return r;
      }
      const tt: string[] = r.tokens || [];
      if (tt.length >= 2 && th.length >= 2 && (jaccard(tt, th) >= 0.6 || (r.kind === 'forget' && containment(tt, th) >= 0.8))) return r;
    }
    return null;
  }

  /** True when a line of derived text (episode, summary) overlaps with something that was forgotten. */
  lineIsForgotten(userId: string, line: string): boolean {
    return !!this.blockedBy(userId, line, null, ['forget']);
  }

  // ------------------------------------------------------------------ FTS (derived, rebuildable)

  ftsText(kind: string, row: any): string {
    switch (kind) {
      case 'item': {
        if (row.sensitivity === 'sensitive') return [row.canonical_key || '', row.type].join(' ');
        // Keywords/synonyms from the learner and the built-in synonym list: word search also finds by meaning.
        const terms: string[] = Array.isArray(row.terms) ? row.terms : [];
        return [row.content, row.canonical_key || '', row.type, ...terms, ...builtinSynonyms([row.content, ...terms].join(' '))].join(' ');
      }
      case 'dossier':
        return [row.title, row.summary, row.body || '', ...(row.tags || []), ...builtinSynonyms(row.title || '', 12)].join(' ');
      case 'episode':
        return [row.title, row.summary, ...(row.decisions || []).map((d: any) => d.text), ...(row.actions || []).map((d: any) => d.text), ...(row.questions || []).map((d: any) => d.text)].join(' ');
      case 'source':
        return [row.title, row.target, row.excerpt].join(' ');
      case 'chunk':
        return row.text;
      default:
        // (A line of a dossier's archive is found like the note it once was: synonyms of what it says, not only its title.)
        // (Its subject too, as a note had its key: "Ik woon in Utrecht" is found with "woonplaats".)
        if (isArchiveLine(row)) {
          const keys = String(row.body || '').split('\n').map((l) => guessKey(l.replace(/^[\s>*-]+/, '')).key).filter(Boolean);
          return [row.title, row.body, ...keys, ...builtinSynonyms(`${row.body || ''} ${keys.join(' ')}`, 24)].join(' ');
        }
        return [row.title, row.body, row.owner || '', ...(row.data?.aliases || []), row.data?.question || '', ...builtinSynonyms(row.title || '', 12)].join(' ');
    }
  }

  /** Refresh the derived index entries of one record: its FTS row and (items) its vector. */
  /**
   * The FTS row of one record out, by rowid through memory_fts_rows (kind and rid are UNINDEXED in memory_fts: a
   * DELETE on them reads the whole table, which made every write slower as memory grew).
   */
  private ftsDrop(kind: string, id: string) {
    const r = this.store.one<{ row: number }>('SELECT row FROM memory_fts_rows WHERE kind = ? AND rid = ?', kind, id);
    if (!r) return;
    this.store.exec('DELETE FROM memory_fts WHERE rowid = ?', r.row);
    this.store.exec('DELETE FROM memory_fts_rows WHERE kind = ? AND rid = ?', kind, id);
  }

  private ftsAdd(kind: string, id: string, userId: string, text: string) {
    const res = this.store.exec('INSERT INTO memory_fts (text, kind, rid, user_id) VALUES (?, ?, ?, ?)', text, kind, id, userId);
    this.store.exec('INSERT OR REPLACE INTO memory_fts_rows (kind, rid, row, user_id) VALUES (?, ?, ?, ?)', kind, id, Number(res.lastInsertRowid), userId);
  }

  syncIndex(kind: string, id: string) {
    const ftsKind = TABLE_OF[kind] === 'memory_records' ? 'record' : kind;
    this.ftsDrop(ftsKind, id);
    const table = ftsKind === 'record' ? 'memory_records' : TABLE_OF[kind];
    if (!table) return;
    const row = this.store.get<any>(table, id);
    // The vector goes in the same transaction as the change (forget, trash, sensitive, new text).
    if (kind === 'item') this.semantic.sync('item', id, row || null);
    else if (ftsKind === 'record') this.semantic.sync('record', id, row || null);
    if (!row) return;
    const live = kind === 'item' ? INDEXED_STATUSES.has(row.status) : !['trashed', 'forgotten', 'rejected'].includes(row.status);
    if (!live) return;
    this.ftsAdd(ftsKind, id, row.user_id, this.ftsText(ftsKind === 'record' ? row.kind : kind, row));
  }

  indexChunk(id: string, userId: string, text: string) {
    this.ftsDrop('chunk', id);
    this.ftsAdd('chunk', id, userId, text);
    this.semantic.sync('chunk', id, { user_id: userId, text });
  }

  unindex(kind: string, id: string) {
    this.ftsDrop(kind, id);
    if (kind === 'item' || kind === 'chunk' || kind === 'record') this.semantic.drop(kind, id);
  }

  /** Every FTS row of one user (or of everyone) out, with the rowid map. */
  ftsClear(userId?: string) {
    if (userId) {
      this.store.exec('DELETE FROM memory_fts WHERE user_id = ?', userId);
      this.store.exec('DELETE FROM memory_fts_rows WHERE user_id = ?', userId);
    } else {
      this.store.exec('DELETE FROM memory_fts');
      this.store.exec('DELETE FROM memory_fts_rows');
    }
  }

  /**
   * Rebuild the whole derived index for one user (or everyone): FTS now; the vectors are emptied ('rebuild', the
   * Opslag button) or only checked against their records ('verify', after a restore), and the indexer makes the rest.
   */
  reindex(userId?: string, o: { vectors?: 'rebuild' | 'verify' } = {}): number {
    const n = this.store.tx(() => {
      this.ftsClear(userId);
      if ((o.vectors || 'rebuild') === 'rebuild') {
        if (userId) this.semantic.dropUser(userId);
        else this.store.exec('DELETE FROM memory_vectors');
      }
      let n = 0;
      const w = userId ? 'WHERE user_id = ?' : '';
      const p = userId ? [userId] : [];
      for (const r of this.store.all<any>(`SELECT id FROM memory_items ${w}`, ...p)) (this.syncIndex('item', r.id), n++);
      for (const r of this.store.all<any>(`SELECT id FROM memory_dossiers ${w}`, ...p)) (this.syncIndex('dossier', r.id), n++);
      for (const r of this.store.all<any>(`SELECT id, kind FROM memory_records ${w}`, ...p)) (this.syncIndex(r.kind, r.id), n++);
      for (const r of this.store.all<any>(`SELECT id FROM memory_sources ${w}`, ...p)) (this.syncIndex('source', r.id), n++);
      for (const r of this.store.all<any>(`SELECT id FROM memory_episodes ${w}`, ...p)) (this.syncIndex('episode', r.id), n++);
      for (const r of this.store.all<any>(`SELECT c.id, c.user_id, c.text FROM memory_chunks c JOIN memory_sources s ON s.id = c.source_id WHERE s.status = 'active' ${userId ? 'AND c.user_id = ?' : ''}`, ...p))
        (this.indexChunk(r.id, r.user_id, r.text), n++);
      if (o.vectors === 'verify') this.semantic.verify(userId);
      return n;
    });
    this.semantic.kick();
    return n;
  }

  ftsMatch(userIds: string[], q: string, kinds: string[], limit = 60): { kind: string; rid: string; pos: number; bm: number }[] {
    // Dutch compounds in the question also look for their head ("teamoverleg" → "overleg").
    const heads = compoundHeads(q);
    const fq = ftsQuery(heads.length ? `${q} ${heads.join(' ')}` : q, 12 + heads.length);
    if (!fq || !userIds.length || !kinds.length) return [];
    const rows = this.store.all<any>(
      `SELECT kind, rid, bm25(memory_fts) AS bm FROM memory_fts WHERE memory_fts MATCH ? AND user_id IN (${userIds.map(() => '?').join(',')}) AND kind IN (${kinds.map(() => '?').join(',')}) ORDER BY bm25(memory_fts) LIMIT ?`,
      fq,
      ...userIds,
      ...kinds,
      limit,
    );
    // bm25 is negative (lower = better); `bm` = how strong this hit is, positive.
    return rows.map((r, i) => ({ kind: r.kind, rid: r.rid, pos: i, bm: -Number(r.bm) || 0 }));
  }

  /** Share of the search words an item covers (its text, key, learned terms and built-in synonyms; word starts count). */
  coverage(qt: string[], row: MemoryItemRow): number {
    if (!qt.length) return 0;
    // A sensitive memory is not in the word index; its words are looked at in memory only (as in the decrypt-scan).
    const text = row.sensitivity === 'sensitive' || row.content_enc ? `${this.contentOf(row)} ${row.canonical_key || ''}` : this.ftsText('item', row);
    const have = tokens(text, 400);
    return qt.filter((t) => have.some((h) => h === t || (Math.min(h.length, t.length) >= 4 && (h.startsWith(t) || t.startsWith(h))))).length / qt.length;
  }

  // ------------------------------------------------------------------ search

  /**
   * Ranked search over items the reader may read: FTS (lexical, prefix) + a scan of encrypted sensitive items, and —
   * with a query vector (`qvec`, see searchItemsAsync) — similarity of meaning, blended with the lexical rank; then
   * reranked with recency, pinning, confidence and reuse. `meaning` = found (also) by meaning, not only by words.
   */
  searchItems(reader: Reader, q: string, o: { limit?: number; scope?: string; type?: string; status?: string; includeInactive?: boolean; archived?: boolean; history?: boolean; archivedDossiers?: boolean; qvec?: QVec | null; where?: { sql: string; params: any[] } | null; info?: SearchInfo } = {}): SearchHit[] {
    const acl = this.aclSql(reader, 'i', { history: !!o.history, archived: !!o.archivedDossiers });
    const limit = Math.min(200, o.limit || 20);
    const extra: string[] = [];
    const params: any[] = [];
    if (o.scope && o.scope !== 'all') (extra.push('i.scope = ?'), params.push(o.scope));
    if (o.type) (extra.push('i.type = ?'), params.push(o.type));
    // An extra condition (alias i), e.g. the owner's team filter.
    if (o.where) (extra.push(o.where.sql), params.push(...o.where.params));
    if (reader.asUser) {
      if (o.status && o.status !== 'all') (extra.push('i.status = ?'), params.push(o.status));
      // The owner's own search also finds the archive (out of every bot's context, but never lost to him).
      else if (o.archived) extra.push(`i.status IN ('active','proposed','archived'${o.history ? ",'superseded'" : ''})`);
      else if (o.history) extra.push("i.status IN ('active','proposed','superseded')");
      else if (!o.includeInactive) extra.push("i.status IN ('active','proposed')");
      else extra.push("i.status NOT IN ('forgotten','rejected')");
    }
    const where = [acl.sql, ...extra].join(' AND ');
    const owners = this.ownerIds(reader);
    const hits = this.ftsMatch(owners, q, ['item'], 200);
    // Words: how strong the hit is next to the best one (bm25: rare words count more than "heet" or "dagen").
    const lexOf = new Map<string, number>();
    const bestBm = hits.reduce((m, h) => Math.max(m, h.bm), 0) || 1;
    hits.forEach((h) => lexOf.set(h.rid, Math.max(lexOf.get(h.rid) || 0, Math.max(0.05, h.bm / bestBm))));
    const qt = tokens(q);
    if (qt.length) {
      for (const r of this.store.all<any>(`SELECT i.* FROM memory_items i WHERE ${where} AND i.sensitivity = 'sensitive' LIMIT 1000`, ...acl.params, ...params)) {
        const c = containment(qt, tokens(this.decrypt(r.content_enc || '') + ' ' + (r.canonical_key || '')));
        if (c > 0) lexOf.set(r.id, Math.max(lexOf.get(r.id) || 0, c));
      }
    }
    // Meaning: the closest 20 within the model's soft band around the best hit (semantic.scoreSims).
    const semOf = new Map<string, number>();
    let simOf = new Map<string, number>();
    let bestSim = -1;
    const fam = o.qvec ? family(o.qvec.model) : null;
    if (o.qvec) {
      const r = this.semantic.itemScores(o.qvec, where, [...acl.params, ...params]);
      for (const [id, s] of [...r.scores].sort((a, b) => b[1] - a[1]).slice(0, 20)) semOf.set(id, s);
      simOf = r.sims;
      bestSim = r.best;
    }
    if (o.info) Object.assign(o.info, { bestSim: o.qvec ? bestSim : null, gate: fam?.gate ?? null });
    const ids = [...new Set([...lexOf.keys(), ...semOf.keys()])];
    if (!ids.length) return [];
    const rows = this.store.all<any>(`SELECT i.* FROM memory_items i WHERE ${where} AND i.id IN (${ids.map(() => '?').join(',')})`, ...acl.params, ...params, ...ids).map((r) => this.store.decode<MemoryItemRow>('memory_items', r));
    const t = Date.now();
    // Fusion (0.4.4, measured on the memory benchmark): words weighed by how many of the search words a note covers (a
    // note that only shares "heet" with "hoe heet mijn huisdier" is a weak hit), plus meaning; both agreeing ranks
    // highest, meaning alone can win ("wagen" ↔ "auto" shares no word). `words` = the weight of a word hit next to
    // meaning for this model (without a model only words count).
    const wl = fam ? fam.words ?? 0.8 : 1;
    // Coverage weighs more next to meaning (a partial word hit is often a wrong note the model already ranks lower).
    const covW = fam ? 0.8 : 0.6;
    return rows
      .map((row) => {
        const lexRel = lexOf.get(row.id) || 0;
        const cov = qt.length ? this.coverage(qt, row) : 1;
        const lex = lexRel ? lexRel * (1 - covW + covW * cov) : 0;
        const sem = semOf.get(row.id) || 0;
        const match = wl * lex + sem;
        const ageDays = (t - Date.parse(row.last_confirmed_at || row.valid_from || row.updated_at)) / 864e5;
        // Small tie-breakers after the match: pinned, recent, sure, often used; an old version (history) last.
        const s = match + (row.pinned ? 0.2 : 0) + Math.max(0, 0.05 - ageDays / 1200) + 0.03 * (row.confidence || 0) + Math.min(10, row.use_count || 0) * 0.005 - (row.status === 'superseded' ? 0.5 : 0);
        return { row, score: s, match, lex, cov, ...(simOf.has(row.id) ? { sim: simOf.get(row.id) } : {}), ...(sem ? { meaning: true } : {}) };
      })
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /** searchItems with search by meaning when it is available (else exactly the word search). */
  async searchItemsAsync(reader: Reader, q: string, o: Parameters<MemoryService['searchItems']>[2] & { timeoutMs?: number } = {}) {
    const qvec = o.qvec !== undefined ? o.qvec : await this.semantic.queryVector(reader.userId, q, o.timeoutMs ?? 6000);
    return this.searchItems(reader, q, { ...o, qvec });
  }

  /**
   * Dossiers and their records for a query (memory_search), weighed like notes (searchItems): a word hit by how many
   * of the search words the text the bot will see covers (its matching lines; a record's title and text, synonyms
   * included), and a line of a dossier's archive also by meaning (what went out of a dossier's text is found like the
   * note it once was). Best first; the caller checks access per hit.
   */
  dossierMatch(userIds: string[], q: string, qvec: QVec | null | undefined, dossierIds: string[], limit = 20): { kind: 'dossier' | 'record'; rid: string; score: number }[] {
    const hits = this.ftsMatch(userIds, q, ['dossier', 'record'], 160);
    const bestBm = hits.reduce((m, h) => Math.max(m, h.bm), 0) || 1;
    const qt = tokens(q);
    const fam = qvec ? family(qvec.model) : null;
    const wl = fam ? fam.words ?? 0.8 : 1;
    const covW = fam ? 0.8 : 0.6;
    const cover = (text: string) => {
      if (!qt.length) return 1;
      const have = tokens(`${text} ${builtinSynonyms(text).join(' ')}`, 400);
      return qt.filter((t) => have.some((h) => h === t || (Math.min(h.length, t.length) >= 4 && (h.startsWith(t) || t.startsWith(h))))).length / qt.length;
    };
    const out = new Map<string, { kind: 'dossier' | 'record'; rid: string; lex: number; sem: number }>();
    for (const h of hits) {
      const row = h.kind === 'dossier' ? this.store.get<any>('memory_dossiers', h.rid) : this.store.get<any>('memory_records', h.rid);
      if (!row) continue;
      const seen = h.kind === 'dossier' ? (row.body ? matchingLines(String(row.body), q).join(' ') : `${row.title} ${row.summary || ''}`) : `${row.title} ${row.body || ''}`;
      out.set(h.rid, { kind: h.kind as 'dossier' | 'record', rid: h.rid, lex: Math.max(0.05, h.bm / bestBm) * (1 - covW + covW * cover(seen)), sem: 0 });
    }
    if (qvec)
      for (const [id, s] of [...this.semantic.recordScores(qvec, userIds, dossierIds)].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
        const cur = out.get(id) || { kind: 'record' as const, rid: id, lex: 0, sem: 0 };
        out.set(id, { ...cur, sem: s });
      }
    return [...out.values()]
      .map((x) => ({ kind: x.kind, rid: x.rid, score: wl * x.lex + x.sem }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Document chunks of these owners for a query: FTS rank blended with meaning (when `qvec`), best first. The caller
   * checks dossier access per chunk, as for words alone.
   */
  chunkMatch(userIds: string[], q: string, qvec: QVec | null | undefined, limit = 10, dossierId?: string | null, dossierIds?: string[] | Set<string> | null): { rid: string; meaning: boolean }[] {
    const score = new Map<string, number>();
    // `dossierIds` = the dossiers the reader may read: ranked among those only, so another team's documents never
    // crowd out the reader's own (the caller still checks every chunk).
    const allowed = dossierIds ? [...dossierIds] : null;
    if (allowed && !allowed.length) return [];
    const fq = ftsQuery(q);
    const hits: { rid: string; pos: number }[] =
      allowed && fq && userIds.length
        ? this.store
            .all<any>(
              `SELECT f.rid FROM memory_fts f JOIN memory_chunks c ON c.id = f.rid WHERE memory_fts MATCH ? AND f.kind = 'chunk' AND f.user_id IN (${userIds.map(() => '?').join(',')}) AND c.dossier_id IN (${allowed.map(() => '?').join(',')}) ORDER BY bm25(memory_fts) LIMIT ?`,
              fq,
              ...userIds,
              ...allowed,
              Math.max(limit * 3, 30),
            )
            .map((r, i) => ({ rid: r.rid, pos: i }))
        : this.ftsMatch(userIds, q, ['chunk'], Math.max(limit * 3, 30));
    for (const h of hits) {
      if (dossierId && this.store.one<any>('SELECT dossier_id FROM memory_chunks WHERE id = ?', h.rid)?.dossier_id !== dossierId) continue;
      score.set(h.rid, Math.max(score.get(h.rid) || 0, 1.2 / (1 + h.pos * 0.12)));
    }
    const meaning = new Set<string>();
    if (qvec) {
      for (const [id, s] of [...this.semantic.chunkScores(qvec, userIds, dossierId, allowed)].sort((a, b) => b[1] - a[1]).slice(0, Math.max(limit, 10))) {
        const lex = score.get(id) || 0;
        const m = 1.2 * s;
        score.set(id, Math.max(lex, m) + 0.25 * Math.min(lex, m));
        meaning.add(id);
      }
    }
    return [...score]
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([rid]) => ({ rid, meaning: meaning.has(rid) }));
  }

  /** User ids whose data the reader can see (self + owners of dossiers shared with them). */
  ownerIds(reader: Reader): string[] {
    const ids = new Set([reader.userId]);
    if (reader.asUser || reader.readShared)
      for (const r of this.store.all<any>('SELECT DISTINCT d.user_id FROM memory_dossiers d JOIN memory_dossier_acl a ON a.dossier_id = d.id WHERE a.user_id = ?', reader.userId)) ids.add(r.user_id);
    return [...ids];
  }

  // ------------------------------------------------------------------ quota

  bucketUsage(row: { user_id: string; scope: string; agent_id?: string | null; dossier_id?: string | null; team_id?: string | null }) {
    const w = this.bucketWhere(row);
    const r = this.store.one<any>(`SELECT COUNT(*) AS n, COALESCE(SUM(bytes),0) AS b FROM memory_items WHERE ${w.sql} AND status IN (${RETAINED.map(() => '?').join(',')})`, ...w.params, ...RETAINED);
    let n = r?.n || 0;
    let b = r?.b || 0;
    if (row.scope === 'dossier' && row.dossier_id) {
      const rr = this.store.one<any>("SELECT COUNT(*) AS n, COALESCE(SUM(LENGTH(title) + LENGTH(body) + LENGTH(data)),0) AS b FROM memory_records WHERE dossier_id = ? AND status NOT IN ('trashed','forgotten')", row.dossier_id);
      n += rr?.n || 0;
      b += rr?.b || 0;
    }
    return { items: n, bytes: b };
  }

  /** Null when there is room, else a Dutch explanation. */
  quotaProblem(row: { user_id: string; scope: string; agent_id?: string | null; dossier_id?: string | null; team_id?: string | null }, addBytes: number, proposal: boolean): string | null {
    const s = this.userSettings(row.user_id);
    if (proposal) {
      const p = this.store.one<any>("SELECT COUNT(*) AS n FROM memory_items WHERE user_id = ? AND status = 'proposed'", row.user_id)?.n || 0;
      if (p >= s.quotas.proposals) return `Er staan al ${p} voorstellen klaar om te beoordelen (maximum ${s.quotas.proposals}). Beoordeel eerst een paar in Geheugen › Te beoordelen.`;
    }
    const q = s.quotas[row.scope as 'about_you' | 'agent' | 'shared' | 'dossier'];
    if (!q) return null;
    const u = this.bucketUsage(row);
    // Shared knowledge has a quota per team (named with two or more teams).
    const team = row.scope === 'shared' ? this.teamTag(row.user_id, row.team_id ?? null) : null;
    const label = { about_you: 'Over jou', agent: 'het geheugen van deze bot', shared: team ? (team.id === ALL_TEAMS ? 'Gedeeld met alle teams' : `Gedeeld in team “${team.name}”`) : 'Gedeeld', dossier: 'dit dossier' }[row.scope] || row.scope;
    if (u.items + 1 > q.items) return `Het quotum voor ${label} is vol (${u.items}/${q.items} items). Ruim op of voeg samen via Geheugen › Opslag.`;
    if (u.bytes + addBytes > q.bytes) return `Het quotum voor ${label} is vol (${bytesText(u.bytes)} van ${bytesText(q.bytes)}). Ruim op of voeg samen via Geheugen › Opslag.`;
    return null;
  }

  private quotaNoticed = new Map<string, string>();
  /**
   * Something learned automatically did not fit (a full quota): tell the user, once a day per part of the memory, so
   * nothing is lost silently (A-46). What the user or a bot saves on purpose gets the quota message directly.
   */
  quotaFullNotice(row: { user_id: string; scope: string; agent_id?: string | null; dossier_id?: string | null; team_id?: string | null }) {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${row.user_id}:${row.scope}:${row.agent_id || ''}:${row.dossier_id || ''}:${row.team_id || ''}`;
    if (this.quotaNoticed.get(key) === day) return;
    this.quotaNoticed.set(key, day);
    const bot = row.scope === 'agent' && row.agent_id ? this.store.agent(row.agent_id)?.name : null;
    const dossier = row.scope === 'dossier' && row.dossier_id ? this.store.one<any>('SELECT title FROM memory_dossiers WHERE id = ?', row.dossier_id)?.title : null;
    const team = row.scope === 'shared' ? this.teamTag(row.user_id, row.team_id ?? null) : null;
    const body = team
      ? team.id === ALL_TEAMS
        ? 'Het geheugen "Gedeeld met alle teams" is vol. Wat de bots nu leren, wordt niet onthouden tot je opruimt of samenvoegt.'
        : `Het gedeelde geheugen van team “${team.name}” is vol. Wat de bots van dat team nu leren, wordt niet onthouden tot je opruimt of samenvoegt.`
      : bot
      ? `Het geheugen van ${bot} is vol. Wat ${bot} nu leert, wordt niet onthouden tot je opruimt of samenvoegt.`
      : dossier
        ? `Het dossier ${dossier} is vol. Wat er nu bij komt, wordt niet onthouden tot je opruimt of samenvoegt.`
        : row.scope === 'about_you'
          ? 'Het geheugen "Over jou" is vol. Wat de bots nu over je leren, wordt niet onthouden tot je opruimt of samenvoegt.'
          : 'Het gedeelde geheugen is vol. Wat de bots nu leren, wordt niet onthouden tot je opruimt of samenvoegt.';
    this.ctx.events.emit(row.user_id, 'notification', { title: 'Geheugen vol', body, link: '#/m/memory/opslag', kind: 'memory' });
  }

  // ------------------------------------------------------------------ misc

  /** A dossier's content changed (a document, a note, a record): it is read again against its facts (reread.ts). */
  markDossierChanged(dossierId: string | null | undefined) {
    if (!dossierId) return;
    this.store.exec('UPDATE memory_dossiers SET changed_at = ? WHERE id = ?', now(), dossierId);
    this.onDossierChanged?.();
  }
  /** Set by the module: a dossier changed, so the one planner is asked for a look after a moment (index.ts). */
  onDossierChanged: (() => void) | null = null;

  emit(userId: string, data: any) {
    this.ctx.events.emit(userId, 'memory.updated', data);
    const dossierId = data?.dossierId;
    if (dossierId) {
      for (const r of this.store.all<any>('SELECT user_id FROM memory_dossier_acl WHERE dossier_id = ?', dossierId)) if (r.user_id !== userId) this.ctx.events.emit(r.user_id, 'memory.updated', data);
      const owner = this.store.one<any>('SELECT user_id FROM memory_dossiers WHERE id = ?', dossierId)?.user_id;
      if (owner && owner !== userId) this.ctx.events.emit(owner, 'memory.updated', data);
    }
  }

  meta(userId: string): any {
    let m = this.store.get<any>('memory_meta', userId, 'user_id');
    if (!m) {
      this.store.insert('memory_meta', { user_id: userId, since_consolidation: 0, model_calls: 0 });
      m = this.store.get<any>('memory_meta', userId, 'user_id');
    }
    return m;
  }

  bumpMeta(userId: string, patch: Record<string, any>) {
    this.meta(userId);
    this.store.update('memory_meta', userId, patch, 'user_id');
  }

  tokensOf(s: string) {
    return estimateTokens(s);
  }

  agentName(id: string | null | undefined): string {
    if (!id) return '';
    return this.store.one<any>('SELECT name FROM agents WHERE id = ?', id)?.name || 'Bot';
  }
}
