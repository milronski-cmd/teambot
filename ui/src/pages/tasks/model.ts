/**
 * One task board for the owner (#/tasks), over the two places bots keep tasks:
 *
 * - the board of TeamBot itself (`room_tasks`, server/modules/rooms/board.ts): bots use task_create / task_update /
 *   task_list (tool group "team"), the owner adds tasks here; statuses todo, doing, review, done, blocked;
 * - the table `taken` in the team database (server/modules/teamdata): bots write it with team_execute, the way the
 *   OpenBot team skills do (and tasks taken over from OpenBot live there); statuses open, bezig, wacht_op_…, klaar,
 *   geannuleerd.
 *
 * Both are shown as one board with the same five columns; a card remembers where it came from, so moving it writes the
 * right status back. Fields that a newer server adds to tasks ("klaar als", evidence, claimed by, the check before
 * "klaar") are shown when they are there (feature-detected by name); TeamBot's own board has them under `quality`
 * (package C1, modules/quality: `QualityLike` below mirrors the fields used here). No imports, so it is unit-tested
 * directly (tests/task-board.test.ts).
 */

export type ColumnId = 'todo' | 'doing' | 'review' | 'done' | 'blocked';
export type Place = ColumnId | 'stopped';

export const COLUMNS: { id: ColumnId; label: string; hint: string }[] = [
  { id: 'todo', label: 'Te doen', hint: 'Nog niet opgepakt' },
  { id: 'doing', label: 'Bezig', hint: 'Een bot werkt eraan' },
  { id: 'review', label: 'Te controleren', hint: 'Klaar volgens de bot, of er is iets van jou nodig' },
  { id: 'done', label: 'Klaar', hint: 'Met resultaat en bewijs' },
  { id: 'blocked', label: 'Geblokkeerd', hint: 'Kan nu niet verder' },
];
const COLUMN_IDS = COLUMNS.map((c) => c.id) as string[];

/** On a phone one column at a time: first what needs you, then what is stuck or running. */
export const PHONE_ORDER: ColumnId[] = ['review', 'blocked', 'doing', 'todo', 'done'];

/** Where a status of the team database lands on the board ("wacht_op_…" = waits for you: to check). */
export function columnOfTeamStatus(s: unknown): Place {
  const v = String(s ?? '').trim().toLowerCase();
  if (!v || v === 'open' || v === 'te_doen' || v === 'todo' || v === 'nieuw') return 'todo';
  if (v === 'bezig' || v === 'doing' || v === 'in_uitvoering' || v === 'loopt') return 'doing';
  // "kon_niet": the bot honestly could not (package C1); that waits for the owner too.
  if (v.startsWith('wacht_op') || v === 'kon_niet' || v === 'te_controleren' || v === 'ter_controle' || v === 'review') return 'review';
  if (v === 'klaar' || v === 'done' || v === 'gedaan' || v === 'afgerond') return 'done';
  if (v === 'geblokkeerd' || v === 'blocked' || v === 'vast') return 'blocked';
  return 'stopped';
}

/** The status written to the team database when the owner moves a card there. */
export const TEAM_STATUS_FOR: Record<ColumnId, string> = { todo: 'open', doing: 'bezig', review: 'wacht_op_eigenaar', done: 'klaar', blocked: 'geblokkeerd' };

export interface EvidenceItem {
  label: string;
  text: string;
}

/**
 * The quality record of a board task (`taskView.quality`, server/modules/quality; full type: QualityView in
 * ui/src/modules/quality/api.ts): "klaar als", who claimed it, the evidence TeamBot found and the second look.
 */
export interface QualityLike {
  doneWhen: string;
  claim: { name: string } | null;
  evidence: { type: string; value: string; note?: string }[];
  check: { state: string; label: string; reason: string };
  /** Waits for the owner's decision ("te controleren", "kon niet"). */
  open: boolean;
}

const EVIDENCE_TYPE: Record<string, string> = { file: 'bestand', link: 'link', message: 'bericht', attachment: 'bijlage', screenshot: 'schermafbeelding', output: 'uitvoer', text: '' };

const qualityOf = (t: Record<string, any>): QualityLike | null => (t.quality && typeof t.quality === 'object' && typeof t.quality.check === 'object' ? (t.quality as QualityLike) : null);

export interface BoardTask {
  /** Unique over both sources: `b:<id>` (board) or `t:<id>` (team database). */
  key: string;
  source: 'board' | 'team';
  id: string;
  title: string;
  column: Place;
  /** The raw status (for a stopped task: what it says, e.g. "geannuleerd"). */
  status: string;
  /** Someone is waiting for the owner: a task for him, or a team-database task "wacht_op_…". */
  waitsForYou: boolean;
  owner: string;
  ownerType: 'agent' | 'user' | null;
  ownerId: string | null;
  requestedBy: string;
  group: { name: string; threadId: string | null } | null;
  site: string;
  deadline: string;
  description: string;
  result: string;
  evidence: EvidenceItem[];
  doneWhen: string;
  claimedBy: string;
  check: string;
  sourceThreadId: string | null;
  /** Belangrijk (board tasks only, engine-chain): its work never runs below the minimum level and pauses instead. */
  important: boolean;
  /** The quality record of a board task (package C1), when the server has it; team-database tasks fetch theirs. */
  quality: QualityLike | null;
  created: string;
  updated: string;
  /** Columns of the team database the board does not show itself (a bot may add its own). */
  extra: [string, string][];
}

const filled = (v: unknown) => v !== undefined && v !== null && v !== '' && !(Array.isArray(v) && !v.length);
function first(o: Record<string, any>, keys: string[]): any {
  for (const k of keys) if (filled(o?.[k])) return o[k];
  return undefined;
}
/** A JSON list or object stored as text (a TEXT column), else the value itself. */
function unpack(v: any): any {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  if (!/^[[{]/.test(s)) return v;
  try {
    return JSON.parse(s);
  } catch {
    return v;
  }
}
function words(v: any): string {
  if (!filled(v)) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(words).filter(Boolean).join('\n');
  if (typeof v === 'object') return words(first(v, ['text', 'summary', 'result', 'verdict', 'note', 'name', 'label', 'value'])) || JSON.stringify(v);
  return String(v);
}

// Names a newer server may use for the fields of package C ("klaar als", evidence, claiming, the check before "klaar").
const DONE_WHEN = ['doneWhen', 'done_when', 'klaarAls', 'klaar_als', 'acceptance', 'acceptance_criteria', 'criteria'];
const EVIDENCE = ['evidence', 'bewijs', 'proof', 'proofs'];
const CLAIM = ['claimedByName', 'claimed_by_name', 'claimedBy', 'claimed_by', 'claim'];
const CHECK = ['checkResult', 'check_result', 'reviewNote', 'review_note', 'controle', 'verification', 'check'];
const DETECTED = new Set([...DONE_WHEN, ...EVIDENCE, ...CLAIM, ...CHECK, 'claimed_at', 'claimedAt']);

export const doneWhenOf = (raw: Record<string, any>): string => words(unpack(first(raw, DONE_WHEN)));
export const checkOf = (raw: Record<string, any>): string => words(unpack(first(raw, CHECK)));

/** Evidence as a list: a text (links are made clickable on screen), a list of texts, or items {label, url|path|text}. */
export function evidenceOf(raw: Record<string, any>): EvidenceItem[] {
  const v = unpack(first(raw, EVIDENCE));
  if (!filled(v)) return [];
  const list = Array.isArray(v) ? v : [v];
  return list
    .map((x) => {
      if (x && typeof x === 'object' && !Array.isArray(x)) {
        const text = words(first(x, ['url', 'href', 'link', 'path', 'file', 'text', 'value', 'summary'])) || JSON.stringify(x);
        return { label: words(first(x, ['label', 'title', 'kind', 'type'])), text };
      }
      return { label: '', text: words(x) };
    })
    .filter((x) => x.text.trim());
}

/** Who claimed the task: a name, or an id that `nameOf` knows (a bot), or an object with a name. */
export function claimOf(raw: Record<string, any>, nameOf: (id: string) => string | undefined = () => undefined): string {
  const v = unpack(first(raw, CLAIM));
  if (!filled(v)) return '';
  if (typeof v === 'object' && !Array.isArray(v)) return words(first(v, ['name', 'agentName', 'agent_name'])) || nameOf(String(v.id ?? v.agentId ?? v.agent_id ?? '')) || '';
  const s = String(v);
  return nameOf(s) || s;
}

/** Times as bots write them ("2026-11-06 23:06:03", local) or ISO, as a number for sorting (0 = unknown). */
export function timeValue(s: unknown): number {
  const v = String(s ?? '').trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(v)) return 0;
  const n = Date.parse(v.length === 10 ? `${v}T00:00:00` : v.replace(' ', 'T'));
  return Number.isNaN(n) ? 0 : n;
}

export interface Lookup {
  /** The signed-in user (a board task for him waits for him). */
  meId?: string;
  /** A bot's name by id. */
  agentName?(id: string): string | undefined;
}

/** A task of TeamBot's own board (GET /api/rooms/tasks). */
export function fromBoardTask(t: Record<string, any>, look: Lookup = {}): BoardTask {
  const column: Place = COLUMN_IDS.includes(t.status) ? t.status : 'todo';
  const ownerType = t.owner_type === 'agent' || t.owner_type === 'user' ? t.owner_type : null;
  const q = qualityOf(t);
  const checked = q && q.check.state !== 'none' ? (q.check.reason ? `${q.check.label}: ${q.check.reason}` : q.check.label) : '';
  return {
    key: `b:${t.id}`,
    source: 'board',
    id: String(t.id),
    title: String(t.title ?? ''),
    column,
    status: String(t.status ?? ''),
    waitsForYou: (ownerType === 'user' && !!look.meId && t.owner_id === look.meId && column !== 'done') || !!q?.open,
    owner: String(t.ownerName ?? ''),
    ownerType,
    ownerId: t.owner_id ?? null,
    requestedBy: String(t.created_by_name ?? ''),
    group: t.roomName ? { name: String(t.roomName), threadId: t.roomThreadId ?? null } : null,
    site: '',
    deadline: String(t.deadline ?? ''),
    description: String(t.description ?? ''),
    result: String(t.result ?? ''),
    evidence: q?.evidence.length ? q.evidence.map((e) => ({ label: EVIDENCE_TYPE[e.type] ?? '', text: e.note ? `${e.value} (${e.note})` : e.value })).filter((e) => e.text.trim()) : evidenceOf(t),
    doneWhen: q?.doneWhen || doneWhenOf(t),
    claimedBy: q?.claim?.name || claimOf(t, look.agentName),
    check: checked || checkOf(t),
    sourceThreadId: t.source_thread_id ?? null,
    important: t.important === true || t.important === 1,
    quality: q,
    created: String(t.created_at ?? ''),
    updated: String(t.updated_at ?? t.created_at ?? ''),
    extra: [],
  };
}

const TEAM_KNOWN = new Set(['id', 'titel', 'eigenaar', 'aangevraagd_door', 'site', 'status', 'resultaat', 'bewijs', 'aangemaakt', 'bijgewerkt', 'deadline', 'beschrijving', 'omschrijving']);

/** A row of the table `taken` in the team database (GET /api/teamdata/tasks). */
export function fromTeamRow(r: Record<string, any>, look: Lookup = {}): BoardTask {
  const status = String(r.status ?? '').trim();
  const column = columnOfTeamStatus(status);
  return {
    key: `t:${r.id}`,
    source: 'team',
    id: String(r.id),
    title: String(r.titel ?? r.title ?? ''),
    column,
    status,
    waitsForYou: status.toLowerCase().startsWith('wacht_op') || status.toLowerCase() === 'kon_niet',
    owner: String(r.eigenaar ?? '').trim(),
    ownerType: null,
    ownerId: null,
    requestedBy: String(r.aangevraagd_door ?? '').trim(),
    group: null,
    site: String(r.site ?? ''),
    deadline: String(r.deadline ?? ''),
    description: String(r.beschrijving ?? r.omschrijving ?? ''),
    result: String(r.resultaat ?? ''),
    evidence: evidenceOf(r),
    doneWhen: doneWhenOf(r),
    claimedBy: claimOf(r, look.agentName),
    check: checkOf(r),
    sourceThreadId: null,
    important: false,
    quality: null,
    created: String(r.aangemaakt ?? ''),
    updated: String(r.bijgewerkt || r.aangemaakt || ''),
    extra: Object.entries(r)
      .filter(([k, v]) => !TEAM_KNOWN.has(k) && !DETECTED.has(k) && filled(v))
      .map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)] as [string, string]),
  };
}

/** Both sources as one list, most recently changed first. */
export function mergeTasks(board: Record<string, any>[], team: Record<string, any>[], look: Lookup = {}): BoardTask[] {
  return [...board.map((t) => fromBoardTask(t, look)), ...team.map((r) => fromTeamRow(r, look))].sort((a, b) => timeValue(b.updated) - timeValue(a.updated));
}

/** Search over the words on a card (all terms must match). */
export function matches(t: BoardTask, q: string): boolean {
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return true;
  const hay = [t.title, t.result, t.owner, t.requestedBy, t.site, t.group?.name, t.description, t.doneWhen, t.claimedBy, `#${t.id}`].join('\n').toLowerCase();
  return terms.every((w) => hay.includes(w));
}

export function byPlace(list: BoardTask[]): Record<Place, BoardTask[]> {
  const out: Record<Place, BoardTask[]> = { todo: [], doing: [], review: [], done: [], blocked: [], stopped: [] };
  for (const t of list) out[t.column].push(t);
  return out;
}
