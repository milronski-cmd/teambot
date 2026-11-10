import { ApiError, api, getToken, UNREACHABLE } from '../../lib/api';

export type DeviceKind = 'phone' | 'computer' | 'browser';

export interface RemoteSessionInfo {
  id: string;
  deviceKind: DeviceKind;
  deviceName: string;
  view: boolean;
  since: string;
  lastInputAt: string | null;
  controlling: boolean;
  mine: boolean;
}

export interface RemoteState {
  enabled: boolean;
  control: boolean;
  idleMinutes: number;
  changedAt: string | null;
  available: boolean;
  unavailable: 'platform' | 'app' | null;
  here: boolean;
  sessions: RemoteSessionInfo[];
}

export interface MonitorInfo {
  index: number;
  w: number;
  h: number;
  primary: boolean;
}

export interface SessionStart {
  id: string;
  view: boolean;
  monitor: number;
  monitors: MonitorInfo[];
  control: boolean;
  idleMinutes: number;
  idleLeftMs: number;
}

export interface SessionStatus extends SessionStart {
  bot: { agentId: string | null; agentName: string | null; active: boolean; paused: boolean } | null;
  tookOverFrom: string | null;
}

export type RemoteInput =
  | { type: 'click'; x: number; y: number; button?: 'left' | 'right' | 'middle'; count?: number }
  | { type: 'move'; x: number; y: number }
  | { type: 'drag'; x: number; y: number; x2: number; y2: number }
  | { type: 'scroll'; x: number; y: number; dx: number; dy: number }
  | { type: 'type'; text: string }
  | { type: 'key'; keys: string };

export const IDLE_CHOICES = [5, 10, 15, 30, 60];

const S = (id: string) => `/remote-desktop/sessions/${encodeURIComponent(id)}`;

export const remote = {
  state: () => api.get<RemoteState>('/remote-desktop'),
  configure: (body: Partial<Pick<RemoteState, 'enabled' | 'control' | 'idleMinutes'>>) => api.put<RemoteState>('/remote-desktop/switch', body),
  off: () => api.post<RemoteState>('/remote-desktop/off', {}),
  start: (o: { monitor?: number; view?: boolean } = {}) => api.post<SessionStart>('/remote-desktop/sessions', o),
  status: (id: string) => api.get<SessionStatus>(S(id)),
  input: (id: string, monitor: number, i: RemoteInput) => api.post<{ ok: true; idleLeftMs: number; tookOverFrom: string | null }>(`${S(id)}/input`, { ...i, monitor }),
  view: (id: string, view: boolean) => api.post<{ view: boolean }>(`${S(id)}/view`, { view }),
  keepalive: (id: string) => api.post<{ idleLeftMs: number }>(`${S(id)}/keepalive`, {}),
  end: (id: string) => api.del<{ ok: boolean }>(S(id)),
  /** The existing "Geef terug" of computer use: the bot that was paused may continue. */
  giveBack: (agentId: string) => api.post(`/computers/${encodeURIComponent(agentId)}/screen/resume`, {}),
};

export interface Frame {
  /** null = unchanged since `etag` (304) */
  blob: Blob | null;
  etag: string;
  cursor: { x: number; y: number } | null;
  idleLeftMs: number | null;
  bytes: number;
}

/**
 * One picture of the screen. The token goes in the header (never in a URL); the ETag makes an unchanged screen cost
 * a few bytes. Errors are ApiErrors with the server's code (`remote_<reason>` when the session ended).
 */
export async function fetchFrame(id: string, o: { monitor: number; side: number; q: number; etag: string; signal?: AbortSignal }): Promise<Frame> {
  const t = getToken();
  const headers: Record<string, string> = t ? { authorization: `Bearer ${t}` } : {};
  if (o.etag) headers['if-none-match'] = o.etag;
  const res = await fetch(`/api${S(id)}/frame?m=${o.monitor}&w=${o.side}&q=${o.q}`, { headers, cache: 'no-store', signal: o.signal }).catch((e) => {
    if (e?.name === 'AbortError') throw e;
    throw new ApiError(UNREACHABLE, 0);
  });
  const cur = res.headers.get('x-tb-cursor') || '';
  const [cx, cy] = cur.split(',').map(Number);
  const idle = Number(res.headers.get('x-tb-idle'));
  const meta = { etag: res.headers.get('etag') || o.etag, cursor: cur && Number.isFinite(cx) && Number.isFinite(cy) ? { x: cx, y: cy } : null, idleLeftMs: Number.isFinite(idle) && res.headers.has('x-tb-idle') ? idle : null };
  if (res.status === 304) return { blob: null, bytes: 0, ...meta };
  if (!res.ok) {
    const j: any = await res.json().catch(() => ({}));
    throw new ApiError(j?.error || res.statusText || `Fout ${res.status}`, res.status, j?.code);
  }
  const blob = await res.blob();
  return { blob, bytes: blob.size, ...meta };
}

/** The session ended on the server: why (the code is `remote_<reason>`). */
export function endedReason(e: any): string | null {
  const c = String(e?.code || '');
  if (e?.status === 410 && c.startsWith('remote_')) return c.slice(7);
  if (e?.status === 404 && c === 'remote_unknown') return 'unknown';
  return null;
}
