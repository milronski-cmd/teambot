/** Shared types of the memory module. */

export type Scope = 'about_you' | 'agent' | 'dossier' | 'shared';
export const SCOPES: Scope[] = ['about_you', 'agent', 'dossier', 'shared'];

export type ItemType = 'fact' | 'preference' | 'instruction' | 'decision' | 'person' | 'event' | 'task' | 'lesson' | 'note';
export const ITEM_TYPES: ItemType[] = ['fact', 'preference', 'instruction', 'decision', 'person', 'event', 'task', 'lesson', 'note'];

export type Sensitivity = 'normal' | 'personal' | 'sensitive';

/** Allowed review intervals in days: never, every month, 3 months, 6 months, year. */
export const REVIEW_INTERVALS = [0, 30, 90, 180, 365];
export function reviewInterval(v: any): number | null {
  const n = Math.round(Number(v));
  return REVIEW_INTERVALS.includes(n) ? n : null;
}
/** The next check date for an interval (null = no recurring check). */
export function nextReview(everyDays: number | null | undefined, fromMs = Date.now()): string | null {
  return everyDays && everyDays > 0 ? new Date(fromMs + everyDays * 864e5).toISOString() : null;
}
export const SENSITIVITIES: Sensitivity[] = ['normal', 'personal', 'sensitive'];

export type ItemStatus = 'active' | 'proposed' | 'archived' | 'superseded' | 'trashed' | 'rejected' | 'forgotten';
/** `customer` (0.4.5): an identified customer's own words on a channel, about himself (data, never an instruction). */
export type Trust = 'user' | 'agent' | 'external' | 'import' | 'system' | 'customer';
export type SourceKind = 'message' | 'file' | 'url' | 'user' | 'import' | 'tool' | 'run' | 'consolidation' | 'attachment';
export type Actor = 'user' | 'agent' | 'system' | 'import';

export interface MemoryItemRow {
  id: string;
  ref: string;
  user_id: string;
  scope: Scope;
  agent_id: string | null;
  dossier_id: string | null;
  type: ItemType;
  canonical_key: string | null;
  key_norm: string | null;
  content: string;
  content_enc: string | null;
  hash: string;
  source_kind: SourceKind;
  source_ref: string | null;
  source_thread_id: string | null;
  source_excerpt: string | null;
  source_trust: Trust;
  confidence: number;
  sensitivity: Sensitivity;
  status: ItemStatus;
  proposal_reason: string | null;
  conflict_with: string | null;
  merge_of: string[] | null;
  flags: string[];
  pinned: boolean;
  observed_at: string | null;
  valid_from: string | null;
  valid_to: string | null;
  expires_at: string | null;
  review_at: string | null;
  /** Review interval in days (30, 90, 180, 365); null/0 = no recurring check. */
  review_every_days: number | null;
  last_confirmed_at: string | null;
  version: number;
  supersedes_id: string | null;
  superseded_by: string | null;
  created_by: Actor;
  created_by_agent: string | null;
  origin_run_id: string | null;
  origin_call_id: string | null;
  idem_key: string | null;
  use_count: number;
  last_used_at: string | null;
  bytes: number;
  trashed_at: string | null;
  created_at: string;
  updated_at: string;
  /**
   * Team of a bot note or shared knowledge (scope agent/shared): a team id, ALL_TEAMS ('*', shared knowledge for every
   * team) or null (the owner's default team). "Over jou" is personal and dossier notes follow their dossier.
   */
  team_id?: string | null;
  /** The original of a copy made with "vakkennis meenemen" (forget follows the whole family). */
  copy_of?: string | null;
  /** Keywords and synonyms (NL/EN) added when learning; indexed for word search, never shown as the memory itself. */
  terms?: string[] | null;
  /** What kind of fact changes over time (price, version, rule, agreement, hours, contact): it has a review date. */
  review_kind?: ReviewKind | null;
  /** Why this memory is "te controleren" (shown in Te beoordelen › Klopt dit nog?). */
  review_note?: string | null;
  /** Why it no longer holds (0.4.4): the newer fact that ended it, "afgerond", a changed document. */
  invalid_reason?: string | null;
  /** When it was checked against what was already known (consolidate.ts). */
  consolidated_at?: string | null;
}

/** Facts that change over time and how often they are looked at again (days). */
export type ReviewKind = 'price' | 'version' | 'rule' | 'agreement' | 'hours' | 'contact' | 'practice';
export const REVIEW_KINDS: Record<ReviewKind, { days: number; label: string }> = {
  price: { days: 90, label: 'prijs' },
  version: { days: 60, label: 'versie' },
  rule: { days: 180, label: 'regel' },
  agreement: { days: 90, label: 'afspraak' },
  hours: { days: 180, label: 'openingstijden' },
  contact: { days: 365, label: 'contactgegevens' },
  // A technique, best practice or platform guideline (what a specialist knows): it works until the platform changes.
  practice: { days: 120, label: 'werkwijze' },
};

/** Item as returned to callers (content decrypted, internals removed). */
export interface MemoryItem extends Omit<MemoryItemRow, 'content_enc' | 'hash' | 'idem_key'> {
  agent_name?: string | null;
  dossier_title?: string | null;
  source_thread_title?: string | null;
  /** The item's team as the owner sees it (default team resolved; '*' = all teams; null = personal / no teams). */
  team?: { id: string; name: string } | null;
  /** Learned automatically from a conversation (0.4.5): from the owner's words, the bot's reply or a tool result. */
  learned_from?: 'owner' | 'bot' | 'tool';
}

/** Shared knowledge or a dossier "voor alle teams" (the owner's explicit choice). */
export const ALL_TEAMS = '*';

/**
 * What a bot may reach per team (null = no walls: the teams module is off, the owner has no teams, or a shared bot
 * runs in a member's conversation and reads the member's own memory). `read` = home team first, then the teams it
 * may look into (meekijken/aansturen); `def` = the owner's default team (team_id NULL).
 */
export interface TeamScope {
  home: string | null;
  read: string[];
  def: string | null;
}

export interface SourceInput {
  kind: SourceKind;
  ref?: string | null;
  threadId?: string | null;
  excerpt?: string | null;
  trust: Trust;
}

export type Origin = 'explicit' | 'auto' | 'model' | 'tool' | 'user_ui' | 'import' | 'consolidation' | 'service';

export interface Candidate {
  userId: string;
  content: string;
  scope: Scope;
  agentId?: string | null;
  dossierId?: string | null;
  type?: ItemType;
  key?: string | null;
  sensitivity?: Sensitivity;
  confidence?: number;
  source: SourceInput;
  origin: Origin;
  createdBy: Actor;
  createdByAgent?: string | null;
  runId?: string | null;
  callId?: string | null;
  idemKey?: string | null;
  expiresAt?: string | null;
  reviewAt?: string | null;
  /** Review interval in days (0 = never); undefined = the owner's default for facts that can change. */
  reviewEveryDays?: number | null;
  /** Keywords/synonyms for word search (from the learner, same call). */
  terms?: string[] | null;
  /** The learner (or the text) says this fact changes over time: it gets a review date for its kind. */
  reviewKind?: ReviewKind | null;
  observedAt?: string | null;
  pinned?: boolean;
  /** The human explicitly approved this exact write (UI, approval card, explicit "onthoud dit"). */
  userApproved?: boolean;
  /** Force a review proposal regardless of other rules. */
  forcePropose?: boolean;
  /** Extra flags (external, tainted, ...). */
  flags?: string[];
  /**
   * Automatically recognised from the owner's own words (heuristic pattern or model with a literal quote): applied
   * directly (with undo) when the owner allows that (settings.autoApply = 'own'), else a proposal.
   */
  ownStatement?: boolean;
  /** Check this new fact against what is known with the patterns right after writing (default true; consolidate.ts). */
  consolidate?: boolean;
  /** Item this candidate corrects (the learner saw it and says it is outdated). Must be active and in the same bucket. */
  replacesId?: string | null;
  /**
   * 0.4.5: learned automatically from the conversation, and from what: the owner's own words, the bot's reply (work it
   * did in that turn) or a tool result. A changed fact is then updated directly (new version, history and undo); a
   * review card only when the old note is pinned, or when a bot or tool contradicts what the owner said himself.
   */
  learned?: 'owner' | 'bot' | 'tool';
  /**
   * The caller already compared this fact with what is known (a specialist's round asks its model "same / contradicts"
   * per fact): a merely similar note is no conflict, the fact is kept next to it.
   */
  compared?: boolean;
  /** Explicitly lift a forget-block (only from the UI, after the user confirmed). */
  overrideBlock?: boolean;
  proposalReason?: string;
  /**
   * Team for shared knowledge, the owner's choice: a team id or ALL_TEAMS. Ignored for bot writes (a bot always writes
   * in its home team) and for other scopes (a bot note is in its bot's team, a dossier note in its dossier's).
   */
  teamId?: string | null;
}

export type OutcomeAction = 'inserted' | 'proposed' | 'duplicate' | 'superseded' | 'conflict' | 'blocked' | 'suppressed' | 'rejected' | 'quota' | 'invalid';

export interface Outcome {
  action: OutcomeAction;
  item?: MemoryItem | null;
  existing?: MemoryItem | null;
  changeId?: string | null;
  reason: string;
  /** Short Dutch message for tool output / UI. */
  message: string;
}

export interface UserMemorySettings {
  learnMode: 'off' | 'explicit' | 'auto';
  paused: boolean;
  /**
   * How learning reads a conversation. own (default, 0.4.5) = the bot's own engine and model when that costs nothing
   * extra (its subscription CLI, a local or free model), else another free engine, else patterns; free = an engine
   * without extra cost with a light model (Claude Code: haiku); heuristic = fixed patterns only; model = the bot's own
   * engine also when it costs money.
   */
  extractor: 'heuristic' | 'own' | 'free' | 'model';
  /** What is learned automatically (the owner's words, the bot's work) is applied directly with undo ('own'), or always proposed. */
  autoApply: 'own' | 'never';
  /** Learn after a conversation has been quiet this long (minutes). */
  quietMin: number;
  /** And every this many turns (bot replies) of a conversation, without waiting for the quiet period; 0 = only after quiet. */
  learnEvery: number;
  /** Chosen learning engine (null = automatic: the bot's own free engine, else another free one). */
  engine: { providerId: string | null; model: string | null };
  /** Nightly maintenance (merge, contradictions, stale, dossier roll-up, brief). */
  nightly: boolean;
  /** Always-loaded brief of core facts kept by maintenance (tokens, 0 = off). */
  briefTokens: number;
  botWrites: 'direct' | 'propose';
  /**
   * A new memory contradicts an existing one: 'ask' = review card first (Beoordelen), except an explicit correction
   * by the owner in his own words ("ik woon nu in …", "niet meer …") or a change he makes himself in the memory page;
   * 'replace' = replace directly (old version kept in the history, with undo).
   */
  conflicts: 'ask' | 'replace';
  /** Default review interval (days) for facts that can change (where you live/work …); 0 = never. */
  reviewEveryDays: number;
  episodes: boolean;
  /** Search by meaning with an embedding model in the owner's local Ollama ('auto'), or by words only ('off'). */
  semantic: 'auto' | 'off';
  /** Chosen embedding model (null = automatic: the best installed multilingual one). */
  semanticModel: string | null;
  budgetTokens: number;
  profileCap: number;
  trashDays: number;
  modelDailyCap: number;
  quotas: Record<'about_you' | 'agent' | 'shared' | 'dossier' | 'episode', { items: number; bytes: number }> & { proposals: number };
  /**
   * Target size (active memories) per part: "Over jou", per bot per team, shared knowledge per team, per dossier.
   * Maintenance keeps each part at or under its target by summarising and archiving what is least worth keeping
   * (never pinned, owner-confirmed or often used memories). Always below the quota. `client` (0.4.4) is the smaller
   * target of one customer's dossier (customer service with many customers); an archived customer keeps a quarter.
   */
  targets: Record<'about_you' | 'agent' | 'shared' | 'dossier' | 'client', number> & {
    /** 0.4.5: a customer's conversation summaries go to the archive after this many days without contact (45). */
    clientEpisodesDays?: number;
  };
  /** A memory unused and unconfirmed this long, with little value, goes to the archive (out of the context). */
  archiveAfterDays: number;
  /** A recurring client/project/subject without a dossier: propose one (default), make it for the bot's team, or off. */
  dossierAuto: 'off' | 'propose' | 'create';
}

export interface AgentMemorySettings {
  learn: 'inherit' | 'off' | 'explicit' | 'auto';
  budgetTokens: number | null;
  profileCap: number | null;
  readShared: boolean;
  readAboutYou: boolean;
  botWrites: 'inherit' | 'direct' | 'propose';
}

/** Who reads memory, and in which conversation setting (controls what may be shown). */
export interface Reader {
  userId: string;
  agentId: string | null;
  /**
   * private = owner only; room = owner + several bots; public = other humans or external people can see the thread;
   * customer (0.4.5) = a private channel conversation with an identified customer: only that customer's dossier.
   */
  audience: 'private' | 'room' | 'public' | 'customer';
  /** With audience `customer`: the one dossier this reader may read (the wall is `dossier_id = ?` in SQL). */
  customerDossierId?: string | null;
  readShared: boolean;
  readAboutYou: boolean;
  /** The human user in the UI: sees everything they own plus what was shared with them. */
  asUser?: boolean;
  /** Team walls of a bot (see TeamScope); absent/null for the owner and when there are no walls. */
  teams?: TeamScope | null;
}

export type RecordKind = 'event' | 'decision' | 'action' | 'entity';
export const RECORD_KINDS: RecordKind[] = ['event', 'decision', 'action', 'entity'];

export const REF_PREFIX = {
  item: 'm',
  dossier: 'd',
  episode: 'e',
  event: 'g',
  decision: 'b',
  action: 'a',
  entity: 'p',
  source: 's',
} as const;

/** Someone outside the owner's own circle can read this conversation (other people, a channel, a customer). */
export const outside = (a: Reader['audience']): boolean => a === 'public' || a === 'customer';
