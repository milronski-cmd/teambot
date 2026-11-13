/**
 * A memory as the server keeps it (server/modules/memory: its row narrows these fields and adds what it keeps to
 * itself) and the Geheugen page shows it (ui/src/modules/memory). Types only.
 */

export type Scope = 'about_you' | 'agent' | 'dossier' | 'shared';
export type ItemType = 'fact' | 'preference' | 'instruction' | 'decision' | 'person' | 'event' | 'task' | 'lesson' | 'note';
export type Sensitivity = 'normal' | 'personal' | 'sensitive';
export type ItemStatus = 'active' | 'proposed' | 'archived' | 'superseded' | 'trashed' | 'rejected' | 'forgotten';

/** The fields of a memory both sides know. */
export interface MemoryItemFields {
  id: string;
  ref: string;
  user_id: string;
  scope: Scope;
  agent_id: string | null;
  dossier_id: string | null;
  type: ItemType;
  canonical_key: string | null;
  content: string;
  source_kind: string;
  source_ref: string | null;
  source_thread_id: string | null;
  source_excerpt: string | null;
  source_trust: string;
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
  review_every_days?: number | null;
  /** What kind of fact changes over time (price, version, rule, agreement, hours, contact): it has a review date. */
  review_kind?: string | null;
  /** Why this memory is "te controleren" (shown in Te beoordelen › Klopt dit nog?). */
  review_note?: string | null;
  last_confirmed_at: string | null;
  version: number;
  supersedes_id: string | null;
  superseded_by: string | null;
  created_by: string;
  created_by_agent: string | null;
  use_count: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

/** What the server adds when it gives a memory to the page: the names that go with it and the team as the owner sees it. */
export interface MemoryItemShown {
  agent_name?: string | null;
  dossier_title?: string | null;
  source_thread_title?: string | null;
  /** The item's team as the owner sees it (default team resolved; '*' = all teams; null = personal / no teams). */
  team?: { id: string; name: string } | null;
  /** Learned automatically from a conversation (0.4.5): from the owner's words, the bot's reply or a tool result. */
  learned_from?: 'owner' | 'bot' | 'tool';
}
