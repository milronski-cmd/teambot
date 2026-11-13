import fs from 'node:fs';
import path from 'node:path';
import type { ActivityItem, Agent, Ctx, Module, StepFact } from '../../core/types.js';
import { ah, own, str, user } from '../../core/http.js';
import { agentRootList } from '../../tools/builtin/files.js';
import { teambotFacts } from '../cli-agents/activity-labels.js';
import { canSeeThread } from '../../api/threads.js';
import type { SeenFile, SeenItem, SeenOp, SeenView } from '../../../shared/seen.js';

/**
 * "Wat heeft deze bot gezien en gedaan" (A-58) and the bot's own files in the side panel (A-35): files it read and
 * wrote, pages it visited, searches, commands, apps it used and what it asked approval for. Everything comes from
 * what TeamBot already keeps: the steps of each answer (CLI engines, with their facts), the tool calls of API bots
 * and the approvals. Nothing new is logged; deleting a conversation removes its part of this view too.
 */

/** Older steps (before facts were stored): the step titles TeamBot itself writes, read back. Names only. */
export function titleFacts(item: ActivityItem): StepFact[] {
  if (item.facts?.length) return item.facts;
  const t = String(item.title || '').replace(/^Deeltaak · /, '');
  const m = (re: RegExp) => re.exec(t)?.[1]?.trim();
  let v: string | undefined;
  if (item.kind === 'files' && item.detail) {
    return item.detail
      .split('\n')
      .map((l) => /^(\w+):\s*(.+)$/.exec(l.trim()))
      .filter((x): x is RegExpExecArray => !!x)
      .map((x) => ({ op: x[1] === 'delete' || x[1] === 'verwijderd' ? 'delete' : 'write', target: x[2] }) as StepFact);
  }
  if (item.kind !== 'tool') return [];
  if ((v = m(/^(?:Las een webpagina|Webpagina lezen): (.+)$/))) return [{ op: 'web', target: v }];
  if ((v = m(/^(?:Zocht|Zoeken) op internet: (.+)$/))) return [{ op: 'search', target: v }];
  if ((v = m(/^(?:Voerde uit|Opdracht): (.+)$/))) return [{ op: 'exec', target: v }];
  if ((v = m(/^Las (?!een bestand$)(.+)$/))) return [{ op: 'read', target: v }];
  if ((v = m(/^Schreef (?!een bestand$)(.+)$/)) || (v = m(/^Paste (?!een bestand )(.+) aan$/))) return [{ op: 'write', target: v }];
  if ((v = m(/^Verwijderde (?!een bestand$)(.+)$/))) return [{ op: 'delete', target: v }];
  if ((v = m(/^Gebruikte (.+)$/))) return [{ op: 'app', target: v }];
  return [];
}

const MAX_MESSAGES = 3000;
/** File tools that do nothing when they fail (refused by a folder or team wall, a missing file): never "seen or done". */
const FILE_TOOLS = new Set(['read_file', 'list_files', 'write_file', 'edit_file', 'delete_file']);

export function collectSeen(ctx: Ctx, agent: Agent, o: { threadId?: string | null; days?: number } = {}): SeenView {
  const days = Math.max(1, Math.min(365, Math.round(o.days || 90)));
  const since = new Date(Date.now() - days * 864e5).toISOString();
  const rows = ctx.store.all<any>(
    `SELECT id, thread_id, parts, created_at FROM messages WHERE author_id = ? AND role = 'assistant' AND deleted = 0 AND created_at >= ?${o.threadId ? ' AND thread_id = ?' : ''} ORDER BY created_at DESC LIMIT ${MAX_MESSAGES}`,
    agent.id,
    since,
    ...(o.threadId ? [o.threadId] : []),
  );
  const acc = new Map<string, SeenItem>();
  let steps = 0;
  const add = (f: StepFact, at: string, threadId: string, messageId: string) => {
    const target = f.op === 'read' || f.op === 'write' || f.op === 'delete' ? resolveFile(agent, f.target) : f.target.replace(/\s+/g, ' ').trim();
    if (!target) return;
    const key = `${f.op}\u0000${process.platform === 'win32' && f.op !== 'exec' && f.op !== 'search' ? target.toLowerCase() : target}`;
    const cur = acc.get(key);
    if (cur) cur.count++;
    // Rows are newest first: the first one seen is the latest use.
    else acc.set(key, { op: f.op, target, count: 1, last: at, threadId, messageId });
  };
  for (const r of rows) {
    let parts: any;
    try {
      parts = typeof r.parts === 'string' ? JSON.parse(r.parts) : r.parts || {};
    } catch {
      continue;
    }
    for (const item of (Array.isArray(parts.activity) ? parts.activity : []) as ActivityItem[]) {
      const facts = titleFacts(item);
      if (facts.length) steps++;
      for (const f of facts) add(f, item.ts || r.created_at, r.thread_id, r.id);
    }
    for (const c of Array.isArray(parts.toolCalls) ? parts.toolCalls : []) {
      if (!c?.name || c.status === 'denied' || c.status === 'pending') continue;
      if (c.status === 'error' && FILE_TOOLS.has(String(c.name))) continue;
      const facts = teambotFacts(String(c.name), c.args || {}, ctx.tools.get(String(c.name))?.app);
      if (facts?.length) steps++;
      for (const f of facts || []) add(f, r.created_at, r.thread_id, r.id);
    }
  }
  const list = [...acc.values()].sort((a, b) => b.last.localeCompare(a.last));
  const roots = agentRootList(agent);
  const file = (x: SeenItem): SeenFile => {
    const abs = path.isAbsolute(x.target) ? x.target : null;
    let root: number | null = null;
    let rel: string | null = null;
    if (abs) {
      const n = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
      for (let i = 0; i < roots.length; i++) {
        const r = path.relative(n(roots[i].path), n(abs));
        if (r && !r.startsWith('..') && !path.isAbsolute(r)) {
          root = i;
          rel = path.relative(roots[i].path, abs).split(path.sep).join('/');
          break;
        }
      }
    }
    let st: fs.Stats | undefined;
    // Only files inside the bot's own folders are looked at on disk (and can be previewed).
    if (abs && root !== null) st = fs.statSync(abs, { throwIfNoEntry: false });
    return { ...x, name: path.basename(x.target.replace(/[\\/]+$/, '')) || x.target, root, rel, exists: !!st?.isFile(), size: st?.isFile() ? st.size : null, mtime: st ? st.mtime.toISOString() : null };
  };
  const approvals = ctx.store
    .all<any>(
      `SELECT id, summary, status, risk, created_at, thread_id FROM approvals WHERE agent_id = ? AND user_id = ? AND created_at >= ?${o.threadId ? ' AND thread_id = ?' : ''} ORDER BY created_at DESC LIMIT 200`,
      agent.id,
      agent.user_id,
      since,
      ...(o.threadId ? [o.threadId] : []),
    )
    .map((a) => ({ id: a.id, summary: a.summary || 'Actie', status: a.status, risk: a.risk, at: a.created_at, threadId: a.thread_id }));
  const of = (op: SeenOp) => list.filter((x) => x.op === op);
  return {
    agent: { id: agent.id, name: agent.name },
    threadId: o.threadId || null,
    days,
    read: of('read').map(file),
    written: of('write').map(file),
    deleted: of('delete').map(file),
    pages: of('web'),
    searches: of('search'),
    commands: of('exec'),
    apps: of('app'),
    approvals,
    steps,
  };
}

/** A tool path as an absolute path: relative ones are relative to the bot's working folder. */
function resolveFile(agent: Agent, p: string): string {
  const t = String(p || '').trim();
  if (!t) return '';
  if (path.isAbsolute(t)) return path.resolve(t);
  // A bare name from an older step title ("notities/plan.md") stays as it is: it cannot be placed reliably.
  if (!agent.workspace) return t;
  return path.resolve(agent.workspace, t);
}

const mod: Module = {
  id: 'seen',
  label: 'Gezien en gedaan',
  init(ctx) {
    ctx.api.get(
      '/agents/:id/seen',
      ah(async (req) => {
        const u = user(req);
        const agent = own(req, ctx.store.agent(req.params.id as string), 'Bot niet gevonden');
        const threadId = str(req.query.thread, 80) || null;
        if (threadId) {
          const t = ctx.store.thread(threadId);
          if (!t || !canSeeThread(u.id, t)) return collectSeen(ctx, agent, { threadId: '-', days: 1 });
        }
        return collectSeen(ctx, agent, { threadId, days: Number(req.query.days) || 90 });
      }),
    );
  },
};

export default mod;
