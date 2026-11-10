import type { Queryable } from './db.js';
import { newId } from './crypto.js';
import type { Clock } from './util.js';

export type Actor = 'user' | 'operator' | 'system' | 'stripe';

export interface AuditEntry {
  actor: Actor;
  actorId?: string | null;
  kind: string;
  workspaceId?: string | null;
  ip?: string | null;
  data?: Record<string, unknown>;
}

const SECRET_KEY = /pass|token|secret|key|hash|cookie|authorization/i;

/** Drop anything that looks like a secret before it reaches the audit table. */
export function scrub(data: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(data)) {
    if (SECRET_KEY.test(k)) continue;
    out[k] = typeof v === 'string' ? v.slice(0, 500) : v;
  }
  return out;
}

export async function audit(q: Queryable, clock: Clock, e: AuditEntry): Promise<void> {
  await q.query('INSERT INTO audit (id, at, actor, actor_id, kind, workspace_id, ip, data) VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)', [
    newId('aud_'),
    clock.now().toISOString(),
    e.actor,
    e.actorId ?? null,
    e.kind,
    e.workspaceId ?? null,
    e.ip ?? null,
    JSON.stringify(scrub(e.data)),
  ]);
}
