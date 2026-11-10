import { useCallback, useEffect, useRef, useState } from 'react';
import { api, on } from '../../lib/api';
import { t, translate, uiLocale } from '../../lib/i18n';
import { formatBytes } from '../../lib/format';

// ---- shapes returned by /api/memory (mirrors server/modules/memory/types.ts) ----

export type Scope = 'about_you' | 'agent' | 'dossier' | 'shared';
export type ItemType = 'fact' | 'preference' | 'instruction' | 'decision' | 'person' | 'event' | 'task' | 'lesson' | 'note';
export type Sensitivity = 'normal' | 'personal' | 'sensitive';

export interface MemItem {
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
  status: 'active' | 'proposed' | 'archived' | 'superseded' | 'trashed' | 'rejected' | 'forgotten';
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
  /** A fact that changes over time (price, version, rule, agreement, hours, contact): it has a review date. */
  review_kind?: string | null;
  /** Why it is "te controleren" (maintenance could not confirm it). */
  review_note?: string | null;
  /** Learned automatically from a conversation (0.4.5): from your own words, the bot's answer or a tool result. */
  learned_from?: 'owner' | 'bot' | 'tool';
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
  agent_name?: string | null;
  dossier_title?: string | null;
  source_thread_title?: string | null;
  changeId?: string | null;
  /** The team (only sent with two or more teams; '*' = Alle teams). */
  team?: TeamTag | null;
}

/** A team as the memory page shows it (id '*' = "Alle teams"). */
export interface TeamTag {
  id: string;
  name: string;
}

export interface Change {
  id: string;
  record_kind: string;
  record_id: string;
  dossier_id: string | null;
  op: string;
  summary: string;
  reason: string;
  actor: string;
  actor_id: string | null;
  actor_name: string;
  created_at: string;
  undone_at: string | null;
  undoable: boolean;
  redacted: boolean;
  before_content: string | null;
  after_content: string | null;
  before_status: string | null;
  after_status: string | null;
  fields: string[];
  receipt: any;
}

export interface Dossier {
  id: string;
  ref: string;
  user_id: string;
  title: string;
  kind: string;
  summary: string;
  status: string;
  agent_ids: string[] | null;
  agent_names: string[] | null;
  tags: string[];
  pinned: boolean;
  role: 'owner' | 'edit' | 'read' | null;
  owner_name: string | null;
  open_actions: number;
  records: number;
  notes: number;
  sources: number;
  last_activity_at: string;
  created_at: string;
  updated_at: string;
  team?: TeamTag | null;
}

export interface DossierRecord {
  id: string;
  ref: string;
  dossier_id: string;
  kind: 'event' | 'decision' | 'action' | 'entity';
  title: string;
  body: string;
  occurred_at: string | null;
  owner: string | null;
  due_at: string | null;
  status: string;
  data: any;
  sources: { kind: string; ref: string | null; threadId?: string | null; title?: string | null }[];
  author_type: string;
  author_name: string;
  created_at: string;
  updated_at: string;
}

// ---- labels ----

export const SCOPE_LABEL: Record<string, string> = { about_you: 'Over jou', agent: 'Bot', dossier: 'Dossier', shared: 'Gedeeld' };
export const TYPE_LABEL: Record<string, string> = { fact: 'Feit', preference: 'Voorkeur', instruction: 'Instructie', decision: 'Besluit', person: 'Persoon', event: 'Gebeurtenis', task: 'Taak', lesson: 'Les', note: 'Notitie' };
export const STATUS_LABEL: Record<string, string> = { active: 'Actief', proposed: 'Voorstel', archived: 'Gearchiveerd', superseded: 'Vervangen', trashed: 'Prullenbak', rejected: 'Afgewezen', forgotten: 'Vergeten' };
export const SENS_LABEL: Record<string, string> = { normal: 'Normaal', personal: 'Persoonlijk', sensitive: 'Gevoelig' };
export const SOURCE_LABEL: Record<string, string> = { message: 'Chatbericht', url: 'Webpagina', file: 'Bestand', attachment: 'Bijlage', user: 'Zelf ingevoerd', import: 'Import', tool: 'Bot', run: 'Bot', consolidation: 'Samengevoegd' };
export const REASON_LABEL: Record<string, string> = {
  conflict: 'Botst met bestaand',
  update: 'Wijzigingsvoorstel',
  sensitive: 'Gevoelig',
  external: 'Externe bron',
  injection: 'Lijkt op instructie',
  auto: 'Automatisch herkend',
  model: 'Automatisch herkend',
  import: 'Import',
  consolidation: 'Samenvoegen',
  about_you: 'Over jou (door bot)',
  shared: 'Delen met alle bots',
  tainted: 'Na externe inhoud',
  instruction: 'Instructie',
  bot: 'Botvoorstel',
  scope: 'Voor wie?',
  review: 'Te controleren',
  explicit: 'op verzoek in de chat',
  user_ui: 'handmatig',
  tool: 'door een bot',
  service: 'door een module',
  user_correction: 'correctie van jou',
  confirmed_proposal: 'bevestigd',
  ok: '',
};
export const OP_LABEL: Record<string, string> = {
  create: 'Aangemaakt',
  propose: 'Voorgesteld',
  approve: 'Goedgekeurd',
  reject: 'Afgewezen',
  update: 'Bewerkt',
  supersede: 'Vervangen',
  merge: 'Samengevoegd',
  archive: 'Gearchiveerd',
  restore: 'Teruggezet',
  trash: 'Prullenbak',
  forget: 'Vergeten',
  pin: 'Vastgezet',
  unpin: 'Losgemaakt',
  confirm: 'Bevestigd',
  share: 'Gedeeld',
  move: 'Verplaatst',
  expire: 'Verlopen',
  complete: 'Afgerond',
  invalidate: 'Klopt niet meer',
  access: 'Toegang',
  undo: 'Ongedaan',
};
export const RECORD_LABEL: Record<string, string> = { event: 'Gebeurtenis', decision: 'Besluit', action: 'Actie', entity: 'Persoon/organisatie' };
export const DOSSIER_KIND_LABEL: Record<string, string> = { project: 'Project', client: 'Klant', person: 'Persoon', topic: 'Onderwerp', team: 'Team' };

/** "Nakijken": how often a memory comes back in Beoordelen as "Klopt dit nog?" (server: memory/types.ts REVIEW_INTERVALS). */
export const REVIEW_OPTIONS: { days: number; label: string }[] = [
  { days: 0, label: 'Nooit' },
  { days: 30, label: 'Elke maand' },
  { days: 90, label: 'Elke 3 maanden' },
  { days: 180, label: 'Elke 6 maanden' },
  { days: 365, label: 'Elk jaar' },
];
export function reviewLabel(days: number | null | undefined): string {
  return REVIEW_OPTIONS.find((o) => o.days === (days || 0))?.label || t('{0, plural, one {Elke dag} other {Elke # dagen}}', days || 0);
}
/** The check date in words: "vandaag", "nu (te laat)" or a date. */
export function reviewWhen(iso: string | null | undefined): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (t <= Date.now()) return 'nu';
  return fmtDate(iso);
}

export function fmtDate(iso: string | null | undefined, withTime = false): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString(uiLocale(), withTime ? { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return iso.slice(0, 10);
  }
}

/** What the owner sees after "Onthouden": never the internal [m:…] reference the bot gets. */
export function rememberToast(action?: string): string {
  if (action === 'proposed' || action === 'conflict') return 'Klaargezet als voorstel. Je vindt het onder Geheugen › Te beoordelen.';
  if (action === 'duplicate') return 'Stond er al in';
  if (action === 'superseded') return 'Bijgewerkt (oude versie bewaard)';
  return 'Onthouden';
}

export function fmtBytes(n: number): string {
  return formatBytes(n);
}

/**
 * A memory engine's label from the server ("Claude Code · haiku (abonnement, geen extra kosten)") with the billing
 * note in the interface language: the name and model stay, the note between brackets is translated.
 */
export const engineLabel = (label: string) => String(label || '').replace(/\(([^()]*)\)$/, (_, note: string) => `(${translate(note)})`);

export function confLabel(c: number): string {
  return c >= 0.85 ? 'zeker' : c >= 0.6 ? 'waarschijnlijk' : 'onzeker';
}

export function toDateInput(iso: string | null | undefined): string {
  return iso ? iso.slice(0, 10) : '';
}
export function fromDateInput(v: string): string | null {
  return v ? new Date(v + 'T23:59:00').toISOString() : null;
}

export const memPath = (p = '') => `#/m/memory/${p}`;

/** Fetch a memory endpoint and refresh it when the server reports a memory change (debounced). */
export function useMem<T>(path: string | null, deps: any[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(!!path);
  const seq = useRef(0);
  const load = useCallback(async () => {
    if (!path) return;
    const n = ++seq.current;
    setLoading(true);
    try {
      const r = await api.get<T>(path);
      if (n === seq.current) {
        setData(r);
        setError(null);
      }
    } catch (e: any) {
      if (n === seq.current) setError(e?.message || String(e));
    } finally {
      if (n === seq.current) setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    let t: any = null;
    const off = on('memory.updated', () => {
      clearTimeout(t);
      t = setTimeout(load, 250);
    });
    return () => {
      clearTimeout(t);
      off();
    };
  }, [load]);
  return { data, error, loading, reload: load, setData };
}

// ---- teams (0.4 B): memory per team; team choices appear only with two or more teams ----

/** Shared knowledge or a dossier for every team. */
export const ALL_TEAMS = '*';

export interface MemTeams {
  multi: boolean;
  /** `bots`: ids of the bots whose home team it is. */
  teams: { id: string; name: string; color: string; isDefault: boolean; bots: string[] }[];
}

// One shared copy for the whole page (many components ask), refreshed when the teams change.
let teamsCache: MemTeams | null = null;
let teamsLoading = false;
let teamsWired = false;
const teamsSubs = new Set<() => void>();
function loadTeams() {
  teamsLoading = true;
  api
    .get<MemTeams>('/memory/teams')
    .then((r) => {
      teamsCache = r;
      for (const f of teamsSubs) f();
    })
    .catch(() => {
      /* no teams module: one team, no team choices */
    })
    .finally(() => {
      teamsLoading = false;
    });
}

/** The owner's teams for the memory page (refreshed when teams change). */
export function useMemTeams(): MemTeams {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((n) => n + 1);
    teamsSubs.add(f);
    if (!teamsWired) {
      teamsWired = true;
      on('teams.changed', () => loadTeams());
    }
    if (!teamsCache && !teamsLoading) loadTeams();
    return () => {
      teamsSubs.delete(f);
    };
  }, []);
  return teamsCache || { multi: false, teams: [] };
}

const TEAM_KEY = 'tb_mem_team';
const TEAM_EVENT = 'tb-mem-team';
const readTeam = () => {
  try {
    return localStorage.getItem(TEAM_KEY) || '';
  } catch {
    return '';
  }
};

/**
 * The team filter of the memory page ('' = alle teams, '*' = alleen "voor alle teams", else a team id), remembered
 * per browser and shared by every list on the page. Ignored (empty) while there is only one team.
 */
export function useTeamFilter(): [string, (v: string) => void] {
  const { multi, teams } = useMemTeams();
  const [v, setV] = useState(readTeam);
  useEffect(() => {
    const f = () => setV(readTeam());
    window.addEventListener(TEAM_EVENT, f);
    return () => window.removeEventListener(TEAM_EVENT, f);
  }, []);
  const set = useCallback((x: string) => {
    try {
      localStorage.setItem(TEAM_KEY, x);
    } catch {
      /* private mode */
    }
    setV(x);
    window.dispatchEvent(new Event(TEAM_EVENT));
  }, []);
  const valid = multi && (v === ALL_TEAMS || teams.some((t) => t.id === v)) ? v : '';
  return [valid, set];
}

/** "&teamId=…" for a list or search under the team filter (nothing for alle teams). */
export const teamQuery = (teamId: string) => (teamId ? `&teamId=${encodeURIComponent(teamId)}` : '');

/** The team new shared knowledge goes to: the filter's team, else the default team. */
export function defaultTeamFor(filter: string, t: MemTeams): string {
  return filter || t.teams.find((x) => x.isDefault)?.id || t.teams[0]?.id || '';
}

/** Tiny word-level diff (LCS) for history views. */
export function wordDiff(a: string, b: string): { t: 'same' | 'add' | 'del'; s: string }[] {
  const A = (a || '').split(/(\s+)/);
  const B = (b || '').split(/(\s+)/);
  if (A.length * B.length > 250_000) return [{ t: 'del', s: a }, { t: 'add', s: b }];
  const dp: number[][] = Array.from({ length: A.length + 1 }, () => new Array(B.length + 1).fill(0));
  for (let i = A.length - 1; i >= 0; i--) for (let j = B.length - 1; j >= 0; j--) dp[i][j] = A[i] === B[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1]);
  const out: { t: 'same' | 'add' | 'del'; s: string }[] = [];
  let i = 0;
  let j = 0;
  const push = (t: 'same' | 'add' | 'del', s: string) => {
    const last = out[out.length - 1];
    if (last && last.t === t) last.s += s;
    else out.push({ t, s });
  };
  while (i < A.length && j < B.length) {
    if (A[i] === B[j]) (push('same', A[i]), i++, j++);
    else if (dp[i + 1][j] >= dp[i][j + 1]) push('del', A[i++]);
    else push('add', B[j++]);
  }
  while (i < A.length) push('del', A[i++]);
  while (j < B.length) push('add', B[j++]);
  return out;
}
