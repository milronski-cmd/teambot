import { api } from '../../lib/api';

export type EngineStatus = 'ready' | 'connect' | 'reconnect' | 'missing' | 'unknown';
export type WorkspaceChoice = 'reference' | 'copy' | 'new';

export interface EngineView {
  from: string;
  kind: string | null;
  label: string;
  status: EngineStatus;
  note: string;
}

export interface PlanBot {
  key: string;
  name: string;
  description: string;
  engine: EngineView;
  model: string;
  reasoning: string;
  backups: { from: string; label: string; kind: string | null; model: string; status: EngineStatus }[];
  access: { from: string; to: 'chat' | 'readonly' | 'ask' | 'auto' | 'full'; note: string };
  computerUse: boolean;
  toolGroups: string[];
  /** The bot face it gets in TeamBot (`face:{…}`), stable from OpenBot's avatar seed. */
  face?: string;
  color: string;
  workspace: { path: string; exists: boolean; files?: number; bytes?: number; capped?: boolean; sizeLabel: string; canCopy: boolean; default: WorkspaceChoice };
  instructions: { chars: number; source: string };
  skills: string[];
  skippedSkills: string[];
  routines: number;
  memories: number;
  essential: number;
  pinned: boolean;
  existing: { id: string; name: string } | null;
  selected: boolean;
  notes: string[];
}

export interface PlanRoutine {
  key: string;
  botKey: string;
  botName: string;
  name: string;
  schedule: string;
  ok: boolean;
  wasActive: boolean;
  timezone: string;
  promptPreview: string;
  /** Always: every routine comes in switched off. */
  off: true;
  /** Reads or answers customers: stays off until the owner approved a test run. */
  customer: boolean;
  notes: string[];
  existing: boolean;
  selected: boolean;
}

export type TeamChoice = { mode: 'new'; name: string } | { mode: 'existing'; id: string };

export interface Source {
  label: string;
  url?: string;
}

/** The team the imported bots go into (0.4: teams as workspaces). */
export interface PlanTeam {
  /** False when this TeamBot has no teams module. */
  available: boolean;
  /** Proposed name for a new team (from the OpenBot workspace, else "Mijn team"). */
  name: string;
  nameFromOpenBot: boolean;
  workspaceName: string;
  /** Proposed: a new team, or an existing one (an earlier import's team, or the one empty team). */
  choice: TeamChoice | null;
  existing: { id: string; name: string; bots: number; folder: string | null; lead: string | null; earlier: boolean }[];
  /** The team tables go into this team (false: still one team database for all teams). */
  tablesPerTeam: boolean;
}

export interface PlanSpecialist {
  key: string;
  name: string;
  field: string;
  sources: Source[];
  rounds: string[];
  reason: string;
  selected: boolean;
}

export interface PlanRoles {
  /** This TeamBot has the main-bot role (hoofdbot). */
  mainAvailable: boolean;
  /** The owner's main bot, when there is one (there can be only one). */
  currentMain: { id: string; name: string } | null;
  leadAvailable: boolean;
  boss: { key: string; name: string; reason: string } | null;
  bossReason: string;
  /** OpenBot agent id proposed as main bot / team lead. */
  main: string | null;
  lead: string | null;
  note: string;
  specialistsAvailable: boolean;
  specialistsNote: string;
  specialists: PlanSpecialist[];
}

export interface PlanSkill {
  key: string;
  name: string;
  description: string;
  klass: 'own' | 'permissive' | 'openbot' | 'unknown';
  license: string;
  reason: string;
  scope: 'team' | 'agent' | 'local';
  usedBy: string[];
  variants: number;
  scan: string | null;
  action: string | null;
  importable: boolean;
  selected: boolean;
}

export interface Attention {
  level: 'warn' | 'info';
  text: string;
}

export interface Plan {
  stagingId: string;
  expiresAt: string;
  source: { dataDir: string; home: string; readAt: string };
  team: PlanTeam;
  roles: PlanRoles;
  bots: PlanBot[];
  routines: PlanRoutine[];
  channels?: PlanChannel[];
  skills: PlanSkill[];
  memories: { total: number; essential: number };
  shared: { path: string; exists: boolean; entries: string[]; current: { path: string } | null; selected: boolean };
  /** Shared team tables in OpenBot's agent-data.db (taken, beslissingen, logboek …). */
  teamData: null | { path: string; available: boolean; perTeam?: boolean; tables: { name: string; rows: number; standard: boolean; owner: string | null; imported: number }[]; selected: boolean };
  engines: EngineView[];
  /** What does not come over, and why (said before anything is written). */
  notImported: { what: string; why: string }[];
  /** An earlier import can be undone. */
  undo: boolean;
  attention: Attention[];
}

export interface ImportResult {
  at: string;
  source: string;
  undone?: string | null;
  undo?: boolean;
  team?: { id: string; name: string; created: boolean } | null;
  roles?: {
    main: null | { name: string; status: 'set' | 'lead' | 'skipped'; note: string };
    lead: null | { name: string; status: 'set' | 'skipped'; note: string };
    specialists: { name: string; status: 'specialist' | 'bot'; field: string; sources: number; note: string }[];
  };
  /** Every routine the import made: "staan uit tot jij ze aanzet". */
  routinesOff?: { name: string; bot: string; customer: boolean }[];
  counts: { bots: number; routines: number; skills: number; memories: number; providers: number; teamRows?: number; channels?: number };
  channels?: { key: string; label: string; bot: string; status: 'created' | 'skipped' | 'relink' | 'error'; bindingId?: string; note: string }[];
  bots: { key: string; name: string; status: 'created' | 'skipped' | 'error'; agentId?: string; workspace?: string; notes: string[]; error?: string }[];
  routines: { key: string; name: string; bot: string; status: 'created' | 'skipped' | 'error'; error?: string }[];
  skills: { name: string; status: string; error?: string }[];
  providers: { label: string; status: string; note: string }[];
  memories: { imported: number; proposed: number; duplicates: number; skipped: number; failed: number; reasons: Record<string, number> };
  shared: null | { path: string; status: string; note?: string };
  teamData?: null | { name: string; created: boolean; inserted: number; skipped: number; renumbered: number; error?: string }[];
  attention: Attention[];
}

export interface Detect {
  available: boolean;
  found: boolean;
  dataDir?: string;
  workspaces?: number;
  sharedDir?: string | null;
  imported?: { at: string; counts: ImportResult['counts']; undone?: string | null } | null;
  /** There is something from OpenBot to undo. */
  undoable?: boolean;
  dismissed?: boolean;
}

/** What "ongedaan maken" would remove (nothing changes until it is confirmed). */
export interface UndoPlan {
  available: boolean;
  at: string | null;
  bots: { id: string; name: string }[];
  routines: number;
  channels?: { id: string; name: string; adapter: string }[];
  skills: { id: string; name: string }[];
  keepSkills: string[];
  providers: { id: string; name: string }[];
  teams: { id: string; name: string; remove: boolean; folder: boolean; note: string }[];
  teamRows: number;
  tables: string[];
  main: string | null;
  folder: boolean;
  notes: string[];
}

export interface UndoResult {
  bots: number;
  routines: number;
  channels?: number;
  skills: number;
  providers: number;
  teamRows: number;
  tables: string[];
  teams: number;
  notes: string[];
}

/** A chat channel of OpenBot: comes over switched off and without a token (or is linked again, e.g. WhatsApp). */
export interface PlanChannel {
  key: string;
  platform: string;
  name: string;
  label: string;
  botKey: string | null;
  bot: string;
  enabledInOpenBot: boolean;
  senders: number;
  /** TeamBot channel type, or null = link it again at the switch moment. */
  adapter: string | null;
  off: true;
  existing: boolean;
  selected: boolean;
  note: string;
}

export type StepStatus = 'done' | 'now' | 'later' | 'info';
export interface CutoverChannel {
  key: string;
  label: string;
  bot: string;
  relink: boolean;
  /** On in OpenBot at the last look (null = not looked yet). */
  openbot: boolean | null;
  teambot: { id: string; enabled: boolean; status: string; health: string | null } | null;
  phase: 'openbot' | 'switch' | 'teambot' | 'both';
}
export interface Cutover {
  steps: (
    | { id: 'backup'; status: StepStatus; teambot: { at: string; name: string } | null; openbotConfirmedAt: string | null }
    | { id: 'import'; status: StepStatus; at: string | null; counts: ImportResult['counts'] | null }
    | { id: 'check'; status: StepStatus; days: number; checkedAt: string | null; channelsOn: number }
    | { id: 'channels'; status: StepStatus; items: CutoverChannel[] }
    | { id: 'routines'; status: StepStatus; total: number; wasOn: number; on: number; customer: string[]; openbotActive: number | null }
    | { id: 'back'; status: StepStatus; undoable: boolean }
  )[];
  openbot: null | { checkedAt: string; found: boolean; running: boolean; heartbeatAt: string | null; version: string; routinesActive: number | null; channelsOn: number };
}

export const obApi = {
  cutover: () => api.get<Cutover>('/openbot-import/cutover'),
  checkOpenBot: () => api.post<Cutover>('/openbot-import/cutover/check'),
  mark: (step: 'backup' | 'check', done: boolean) => api.post<Cutover>('/openbot-import/cutover/mark', { step, done }),
  resumeRoutines: () => api.post<{ started: string[]; skipped: { name: string; why: string }[]; status: Cutover }>('/openbot-import/cutover/routines'),
  detect: () => api.get<Detect>('/openbot-import/detect'),
  dismiss: (dismissed = true) => api.post('/openbot-import/dismiss', { dismissed }),
  preview: () => api.post<Plan>('/openbot-import/preview'),
  commit: (body: any) => api.post<ImportResult>('/openbot-import/commit', body),
  last: () => api.get<ImportResult | null>('/openbot-import/last'),
  undoPlan: () => api.get<UndoPlan>('/openbot-import/undo'),
  undo: () => api.post<UndoResult>('/openbot-import/undo'),
};

// ---------------- Hermes Agent ----------------

export interface HermesDetect {
  available: boolean;
  found: boolean;
  home?: string;
  profiles?: number;
  imported?: { at: string; counts: { bots: number; routines: number; skills: number; memories: number }; undone: string | null } | null;
  undoable?: boolean;
}

export interface HermesPlanBot {
  key: string;
  name: string;
  profile: string;
  folder: string;
  engine: EngineView;
  model: string;
  face: string;
  instructions: { chars: number; source: string };
  skills: number;
  routines: number;
  memories: number;
  userFacts: number;
  existing: { id: string; name: string } | null;
  selected: boolean;
  notes: string[];
}

export interface HermesPlan {
  stagingId: string;
  expiresAt: string;
  source: { home: string; readAt: string };
  bots: HermesPlanBot[];
  routines: { key: string; botKey: string; botName: string; name: string; schedule: string; ok: boolean; wasActive: boolean; promptPreview: string; notes: string[]; existing: boolean; selected: boolean }[];
  skills: { key: string; name: string; description: string; category: string; bundled: boolean; usedBy: string[]; variants: number; scan: 'ok' | 'warn' | 'danger' | 'error' | null; action: string | null; reason: string; importable: boolean; selected: boolean }[];
  memories: { total: number; userFacts: number };
  engines: EngineView[];
  notImported: { what: string; why: string }[];
  undo: boolean;
  attention: Attention[];
}

export interface HermesResult {
  at: string;
  source: string;
  counts: { bots: number; routines: number; skills: number; memories: number; providers: number };
  bots: { key: string; name: string; status: 'created' | 'skipped' | 'error'; agentId?: string; error?: string; notes: string[] }[];
  routines: { key: string; name: string; bot: string; status: 'created' | 'skipped' | 'error'; error?: string }[];
  skills: { name: string; status: string; error?: string }[];
  providers: { label: string; status: string; note: string }[];
  attention: Attention[];
  routinesOff: { name: string; bot: string }[];
  undo: boolean;
}

export const hermesApi = {
  detect: () => api.get<HermesDetect>('/openbot-import/hermes/detect'),
  preview: (path?: string) => api.post<HermesPlan>('/openbot-import/hermes/preview', path ? { path } : {}),
  commit: (body: any) => api.post<HermesResult>('/openbot-import/hermes/commit', body),
  undoPlan: () => api.get<UndoPlan & { memories?: number }>('/openbot-import/hermes/undo'),
  undo: () => api.post<UndoResult & { memories?: number }>('/openbot-import/hermes/undo'),
};

/** Where the import reads from. Grok Bot has no export and keeps nothing on this computer, so it is only explained. */
export type ImportSource = 'openbot' | 'hermes' | 'grok';
