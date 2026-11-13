/** Mirrors of /api/backups and /api/backups/updates (server/modules/backups). */

export interface BackupItem {
  name: string;
  createdAt: string;
  kind: 'manual' | 'auto' | 'update' | 'replaced';
  label?: string;
  version?: string;
  bytes: number;
  includesWork: boolean;
  dataOnly: boolean;
  legacy: boolean;
  update?: { from: string; to: string };
}

export interface PartView {
  id: string;
  label: string;
  kind: 'always' | 'optional' | 'excluded';
  reason?: string;
  exists: boolean;
  bytes: number;
  files: number;
  truncated: boolean;
  unknown: boolean;
}

export interface BackupJob {
  phase: 'database' | 'files' | 'done' | 'error';
  kind: string;
  done: number;
  total: number;
  startedAt: string;
  name?: string;
  error?: string;
}

export interface BackupsView {
  items: BackupItem[];
  settings: { auto: boolean; keep: number; includeWork: boolean };
  plan: PartView[];
  job: BackupJob | null;
  pending: { name: string; at: string; reason?: string } | null;
  lastRestore: { name: string; appliedAt: string; parts: string[]; reason?: string; safety?: string | null } | null;
  keys: { kind: string; text: string };
  /** The database and team databases now (the part that is always in a backup). */
  dbBytes: number;
  mode: 'desktop' | 'server';
  dataDir: string;
  /** The encrypted copy on a second place (server/modules/backups/offsite.ts). */
  offsite?: OffsiteView;
}

export interface OffsiteView {
  folder: string;
  auto: boolean;
  hasPassword: boolean;
  reachable: boolean;
  busy: boolean;
  lastCopy: { at: string; file: string; bytes: number; backup: string } | null;
  lastError: { at: string; message: string } | null;
  files: { file: string; name: string; createdAt: string | null; version: string | null; kind: string | null; bytes: number }[];
}

export interface ChangeRelease {
  version: string;
  date?: string;
  intro: string;
  sections: { title: string; groups: { title?: string; items: string[] }[] }[];
}

export interface UpdatesView {
  version: string;
  last?: { kind: 'update' | 'rollback'; from: string; to: string; at: string; backup?: string } | null;
  history?: { kind: 'update' | 'rollback'; from: string; to: string; at: string; backup?: string }[];
  failed?: { kind: 'update' | 'rollback'; from: string; to: string; at: string } | null;
  whatsNew: ChangeRelease[];
  seen: boolean;
  rollback?: { available: boolean; to?: string; backup?: string; since?: string; reason?: string; installer?: { version: string; size: number; source: string } };
}

/** The desktop bridge (desktop/preload.ts); absent in a browser or on a phone. */
export interface DesktopBridge {
  restart?(): Promise<boolean>;
  update?: { rollback?(): Promise<{ ok: boolean; to: string }> };
}
export const desktopBridge = (): DesktopBridge | undefined => (window as any).teambotDesktop;
