import { api, authUrl, getBytes } from '../../lib/api';
import type { PreviewKind } from '../../components/FilePreview';
import { formatBytes } from '../../lib/format';

export interface FolderRoot {
  index: number;
  path: string;
  mode: 'rw' | 'ro';
  kind: 'workspace' | 'extra' | 'team';
  label: string;
  exists: boolean;
}

export interface TeamFolder {
  path: string;
  label: string;
  mode: 'rw' | 'ro';
  agents: 'all' | string[];
}

export interface TeamState {
  folder: TeamFolder | null;
  exists: boolean;
  restricted: boolean;
  suggestion: string;
  /** The team this folder belongs to (teams module), and all of the owner's teams for a picker. */
  teamId?: string | null;
  teams?: { id: string; name: string; color: string }[];
  /** The bots of that team (without teams: all bots). */
  agents: { id: string; name: string; avatar: string; color: string; member: boolean }[];
}

export interface Listing {
  root: FolderRoot;
  path: string;
  entries: { name: string; dir: boolean; size: number; mtime: string; locked: boolean }[];
  total: number;
  truncated: boolean;
  missing?: boolean;
}

export interface Preview {
  name: string;
  size: number;
  mtime: string;
  /** pdf, image, audio, video, markdown, text or binary (older servers: absent). */
  kind?: PreviewKind;
  binary: boolean;
  truncated: boolean;
  text: string;
}

/** Extra folder of a bot as stored in agent.settings.folders. */
export interface ExtraFolder {
  path: string;
  mode: 'rw' | 'ro';
  label?: string;
}

/** A file in the Prullenbak: deleted by a bot, or the version from before a bot overwrote it. */
export interface TrashItem {
  id: string;
  kind: 'deleted' | 'overwritten' | 'created';
  path: string;
  rel: string;
  root_label: string;
  size: number;
  is_dir: boolean;
  agent_id: string | null;
  agent_name: string | null;
  run_id: string | null;
  thread_id: string | null;
  source: string;
  note: string | null;
  has_copy: boolean;
  exists_now: boolean;
  created_at: string;
  expires_at: string;
  restored_at: string | null;
}

export interface TrashUsage {
  bytes: number;
  count: number;
  maxBytes: number;
  maxFile: number;
  days: number;
}

/** One file a task (run) touched, with what was there before the task. */
export interface RunChange {
  id: string;
  path: string;
  rel: string;
  root_label: string;
  kind: 'deleted' | 'overwritten' | 'created';
  size: number;
  restored: boolean;
  restorable: boolean;
  note: string | null;
  exists: boolean;
}

export const trashApi = {
  list: (agentId?: string) => api.get<{ items: TrashItem[]; usage: TrashUsage }>(`/folders/trash${agentId ? `?agentId=${encodeURIComponent(agentId)}` : ''}`),
  restore: (id: string) => api.post<{ ok: boolean; path: string; message: string }>(`/folders/trash/${id}/restore`, {}),
  purge: (id: string) => api.del(`/folders/trash/${id}`),
  empty: () => api.post<{ removed: number }>('/folders/trash/empty', {}),
  downloadUrl: (id: string) => authUrl(`/folders/trash/${id}/raw`),
  runChanges: (runId: string) => api.get<{ runId: string; changes: RunChange[] }>(`/folders/trash/runs/${encodeURIComponent(runId)}`),
  restoreRun: (runId: string) => api.post<{ restored: { path: string; message: string }[]; failed: { path: string; message: string }[] }>(`/folders/trash/runs/${encodeURIComponent(runId)}/restore`, {}),
};

/** `agentId` is a bot id, null for the default team's folder, or "team:<teamId>" for the folder of one team. */
const q = (agentId: string | null, extra: Record<string, string | number> = {}) => {
  const p = new URLSearchParams();
  if (agentId?.startsWith('team:')) p.set('teamId', agentId.slice(5));
  else if (agentId) p.set('agentId', agentId);
  for (const [k, v] of Object.entries(extra)) p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : '';
};

export const foldersApi = {
  team: (teamId?: string | null) => api.get<TeamState>(`/folders/team${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''}`),
  setTeam: (body: { path: string; label?: string; mode: 'rw' | 'ro'; agents: 'all' | string[]; create?: boolean; teamId?: string | null }) =>
    api.put<{ folder: TeamFolder }>('/folders/team', { ...body, teamId: body.teamId || undefined, agents: body.agents === 'all' ? undefined : body.agents }),
  removeTeam: (teamId?: string | null) => api.del(`/folders/team${teamId ? `?teamId=${encodeURIComponent(teamId)}` : ''}`),
  /** missing: the path is fine but does not exist yet; warning: the folder belongs to another app (OpenBot). */
  check: (path: string) => api.post<{ ok: boolean; error?: string; path?: string; label?: string; missing?: boolean; warning?: string }>('/folders/check', { path }),
  roots: (agentId: string | null) => api.get<{ agent: { id: string; name: string } | null; roots: FolderRoot[] }>(`/folders/roots${q(agentId)}`),
  browse: (agentId: string | null, root: number, path: string) => api.get<Listing>(`/folders/browse${q(agentId, { root, path })}`),
  file: (agentId: string | null, root: number, path: string) => api.get<Preview>(`/folders/file${q(agentId, { root, path })}`),
  /** Signed link to the file itself (preview, "Openen", "Downloaden"); never the session token in the URL. */
  rawUrl: (agentId: string | null, root: number, path: string, download = false) => authUrl(`/folders/raw${q(agentId, download ? { root, path, download: 1 } : { root, path })}`),
  rawBytes: (agentId: string | null, root: number, path: string) => getBytes(`/folders/raw${q(agentId, { root, path })}`),
};

export function formatSize(n: number) {
  return formatBytes(n);
}
