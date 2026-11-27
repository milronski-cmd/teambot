import type { Ctx } from '../../core/types.js';
import { now } from '../../core/db.js';
import type { ConnectionRow, ToolRow } from './db.js';
import type { McpManager } from './runtime.js';
import { label } from './runtime.js';
import { effectiveRisk, logCall } from './tools.js';
import { cleanError } from './util.js';

/**
 * The daily check of the owner's apps (25 Nov 2026, the owner: "dagelijkse koppelingscheck"). Every enabled app that
 * passed its test once is called again with the same read tool it was tested with. Unlike the test button this
 * approves nothing: a changed or new tool stays waiting for the owner. A failing app gets its error on the app card
 * and one notification per app (coalesced by ref), so an expired login is seen the same day, not when a bot needs it.
 */

export const CHECK_EVERY_MS = 24 * 3600_000;
/** First check this long after start: the app is up and logins are refreshed before anything is called. */
export const FIRST_CHECK_MS = 10 * 60_000;
const CALL_TIMEOUT_MS = 60_000;

export interface HealthResult {
  id: string;
  name: string;
  tool: string | null;
  ok: boolean;
  skipped?: string;
  error?: string;
  ms: number;
}

/** The read tool an app was last tested with, if it is still there and still read-only. */
export function sampleTool(ctx: Ctx, c: ConnectionRow): ToolRow | null {
  const name = (c as any).verify_result?.sample?.tool;
  if (!name) return null;
  const t = ctx.store.one<any>('SELECT * FROM mcp_tools WHERE connection_id = ? AND name = ? AND present = 1', c.id, String(name));
  const row = t ? ctx.store.decode<ToolRow>('mcp_tools', t) : null;
  return row && effectiveRisk(row) === 'read' ? row : null;
}

export async function checkConnection(ctx: Ctx, mgr: McpManager, c: ConnectionRow): Promise<HealthResult> {
  const started = Date.now();
  const base = { id: c.id, name: label(c) };
  const tool = sampleTool(ctx, c);
  if (!tool) return { ...base, tool: null, ok: true, skipped: 'geen leestest bekend', ms: 0 };
  try {
    const res: any = await mgr.use(c, (cl) => cl.callTool({ name: tool.name, arguments: {} }, { timeout: Math.min(CALL_TIMEOUT_MS, (c.timeout_sec || 60) * 1000) }));
    const ms = Date.now() - started;
    const text = (res?.content || []).map((p: any) => (p?.type === 'text' ? p.text : '')).join(' ').slice(0, 300);
    const ok = !res?.isError;
    logCall(ctx, { userId: c.user_id, connId: c.id, kind: 'health', tool: tool.name, risk: 'read', summary: 'dagelijkse controle', ok, error: ok ? null : text, ms });
    return ok ? { ...base, tool: tool.name, ok, ms } : { ...base, tool: tool.name, ok, error: text || 'De app gaf een fout terug.', ms };
  } catch (e: any) {
    const ms = Date.now() - started;
    const error = cleanError(e);
    logCall(ctx, { userId: c.user_id, connId: c.id, kind: 'health', tool: tool.name, risk: 'read', summary: 'dagelijkse controle', ok: false, error, ms });
    return { ...base, tool: tool.name, ok: false, error, ms };
  }
}

/** Check every enabled app (of one user, or of everyone) once; failures are written on the app and notified. */
export async function checkAll(ctx: Ctx, mgr: McpManager, userId?: string): Promise<HealthResult[]> {
  const out: HealthResult[] = [];
  const rows = userId ? ctx.store.all<any>('SELECT id FROM mcp_connections WHERE enabled = 1 AND user_id = ?', userId) : ctx.store.all<any>('SELECT id FROM mcp_connections WHERE enabled = 1');
  const conns = rows.map((r) => ctx.store.get<ConnectionRow>('mcp_connections', r.id)).filter(Boolean) as ConnectionRow[];
  for (const c of conns) {
    const r = await checkConnection(ctx, mgr, c);
    out.push(r);
    if (r.skipped) continue;
    const fresh = ctx.store.get<ConnectionRow>('mcp_connections', c.id);
    if (!fresh) continue;
    if (r.ok) {
      if (fresh.last_error) ctx.store.update('mcp_connections', c.id, { last_error: null, updated_at: now() });
      continue;
    }
    ctx.store.update('mcp_connections', c.id, { last_error: r.error, updated_at: now() });
    ctx.events.emit(c.user_id, 'notification', {
      title: `${r.name} werkt niet meer`,
      body: `De dagelijkse controle kreeg een fout: ${r.error}. Open Apps › ${r.name} en log zo nodig opnieuw in.`,
      link: '#/m/mcp/',
      kind: 'warning',
      important: true,
      ref: `mcp-health:${c.id}`,
    });
  }
  ctx.log.info?.(`[mcp] daily check: ${out.filter((r) => r.ok && !r.skipped).length} ok, ${out.filter((r) => !r.ok).length} failing, ${out.filter((r) => r.skipped).length} skipped`);
  return out;
}

/** Starts the daily check; returns the stop function. */
export function startDailyCheck(ctx: Ctx, mgr: McpManager, o: { firstMs?: number; everyMs?: number } = {}): () => void {
  let busy = false;
  const run = async () => {
    if (busy) return;
    busy = true;
    try {
      await checkAll(ctx, mgr);
    } catch (e) {
      ctx.log.error('[mcp] daily check failed', e);
    } finally {
      busy = false;
    }
  };
  const first = setTimeout(run, o.firstMs ?? FIRST_CHECK_MS);
  const every = setInterval(run, o.everyMs ?? CHECK_EVERY_MS);
  first.unref?.();
  every.unref?.();
  return () => {
    clearTimeout(first);
    clearInterval(every);
  };
}
