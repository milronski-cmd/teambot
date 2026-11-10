import type { TeamsService } from './service.js';

/**
 * "Alle teams": one overview for the owner and the main bot. Per team: the lead (optional), the bots, open tasks, what
 * waits for the owner, recent results, errors and missed routine runs of the last 7 days, and usage this week. Every
 * source is feature-detected (a table of a module that is not loaded counts as empty), so the page never fails because
 * a module is missing. Read-only: nothing here starts, changes or creates anything.
 */

const DAYS = 7;
const MAX = 5;

export interface OverviewItem {
  kind: 'approval' | 'question' | 'review' | 'proposal' | 'task' | 'delegation' | 'run' | 'routine' | 'missed';
  id: string;
  title: string;
  detail: string;
  who: string | null;
  at: string;
  link: string;
}

interface Spend {
  calls: number;
  tokens: number;
  cost: number;
  value: number | null;
}

const line = (s: any, n = 120) => {
  const v = String(s ?? '').replace(/\s+/g, ' ').trim();
  return v.length > n ? v.slice(0, n - 1) + '…' : v;
};
const byAt = (a: OverviewItem, b: OverviewItem) => b.at.localeCompare(a.at);
const zero = (): Spend => ({ calls: 0, tokens: 0, cost: 0, value: null });
function addSpend(into: Spend, s: any) {
  if (!s) return;
  into.calls += Number(s.calls) || 0;
  into.tokens += Number(s.tokens) || 0;
  into.cost += Number(s.cost) || 0;
  if (s.value !== null && s.value !== undefined) into.value = (into.value ?? 0) + (Number(s.value) || 0);
}

export function overview(svc: TeamsService, userId: string) {
  const store = svc.ctx.store;
  const since = new Date(Date.now() - DAYS * 86400_000).toISOString();
  const name = (id: string | null | undefined) => (id ? store.agent(id)?.name || 'Verwijderde bot' : '');
  const q = (ids: string[]) => ids.map(() => '?').join(',');
  const tasks = svc.hasTable('room_tasks') && svc.hasColumn('room_tasks', 'workspace_id');
  const delegations = svc.hasTable('room_delegations');
  const proposals = svc.hasTable('room_proposals');
  const routines = svc.hasTable('routine_runs') && svc.hasTable('routines');
  const mainId = svc.mainOf(userId);
  const owner = (type: string | null, id: string | null) => (type === 'agent' ? name(id) : type === 'user' ? store.one<{ name: string }>('SELECT name FROM users WHERE id = ?', id)?.name || null : null);

  /** What waits for the owner from these bots: approvals and questions, and hire proposals. */
  const waitingOf = (ids: string[]): OverviewItem[] => {
    if (!ids.length) return [];
    const out: OverviewItem[] = store
      .all<any>(`SELECT id, agent_id, thread_id, kind, summary, created_at FROM approvals WHERE user_id = ? AND status = 'pending' AND agent_id IN (${q(ids)}) ORDER BY created_at DESC LIMIT 50`, userId, ...ids)
      .map((r) => ({ kind: r.kind === 'question' ? 'question' : 'approval', id: r.id, title: line(r.summary) || (r.kind === 'question' ? 'Vraag' : 'Toestemming gevraagd'), detail: '', who: name(r.agent_id), at: r.created_at, link: r.thread_id ? `#/t/${r.thread_id}` : '#/inbox' }));
    if (proposals)
      for (const r of store.all<any>(`SELECT id, proposer_agent_id, profile, reason, created_at FROM room_proposals WHERE user_id = ? AND status = 'pending' AND proposer_agent_id IN (${q(ids)}) ORDER BY created_at DESC LIMIT 20`, userId, ...ids)) {
        let p: any = {};
        try {
          p = typeof r.profile === 'string' ? JSON.parse(r.profile) : r.profile || {};
        } catch {
          /* keep empty */
        }
        out.push({ kind: 'proposal', id: r.id, title: p?.name ? `Voorstel: ${line(p.name, 60)} erbij` : 'Voorstel voor een nieuw lid', detail: line(r.reason, 160), who: name(r.proposer_agent_id), at: r.created_at, link: '#/inbox' });
      }
    return out;
  };

  /** Errors of these bots in the last days: failed turns, failed subtasks and failed routine runs. */
  const errorsOf = (ids: string[]): OverviewItem[] => {
    if (!ids.length) return [];
    const out: OverviewItem[] = store
      .all<any>(`SELECT id, agent_id, thread_id, error, COALESCE(finished_at, created_at) AS at FROM runs WHERE user_id = ? AND status = 'error' AND agent_id IN (${q(ids)}) AND created_at >= ? ORDER BY created_at DESC LIMIT 20`, userId, ...ids, since)
      .map((r) => ({ kind: 'run', id: r.id, title: line(r.error) || 'Fout', detail: '', who: name(r.agent_id), at: r.at, link: `#/t/${r.thread_id}` }));
    if (delegations)
      for (const r of store.all<any>(`SELECT id, to_agent_id, thread_id, task, error, status, COALESCE(finished_at, updated_at) AS at FROM room_delegations WHERE user_id = ? AND status IN ('error','timeout') AND to_agent_id IN (${q(ids)}) AND created_at >= ? ORDER BY created_at DESC LIMIT 20`, userId, ...ids, since))
        out.push({ kind: 'delegation', id: r.id, title: line(r.task, 80), detail: line(r.error, 160), who: name(r.to_agent_id), at: r.at, link: `#/t/${r.thread_id}` });
    if (routines)
      for (const r of store.all<any>(`SELECT rr.id, rr.error, rr.summary, rr.thread_id, COALESCE(rr.finished_at, rr.created_at) AS at, ro.name, ro.agent_id FROM routine_runs rr JOIN routines ro ON ro.id = rr.routine_id WHERE rr.user_id = ? AND rr.status = 'error' AND ro.agent_id IN (${q(ids)}) AND rr.created_at >= ? ORDER BY rr.created_at DESC LIMIT 20`, userId, ...ids, since))
        out.push({ kind: 'routine', id: r.id, title: `Routine “${line(r.name, 60)}”`, detail: line(r.error || r.summary, 160), who: name(r.agent_id), at: r.at, link: r.thread_id ? `#/t/${r.thread_id}` : '#/m/routines' });
    return out.sort(byAt);
  };

  const missedOf = (ids: string[]): OverviewItem[] => {
    if (!ids.length || !routines) return [];
    return store
      .all<any>(`SELECT rr.id, rr.summary, rr.error, rr.created_at AS at, ro.name, ro.agent_id FROM routine_runs rr JOIN routines ro ON ro.id = rr.routine_id WHERE rr.user_id = ? AND rr.status = 'missed' AND ro.agent_id IN (${q(ids)}) AND rr.created_at >= ? ORDER BY rr.created_at DESC LIMIT 20`, userId, ...ids, since)
      .map((r) => ({ kind: 'missed', id: r.id, title: `Routine “${line(r.name, 60)}”`, detail: line(r.summary || r.error, 160), who: name(r.agent_id), at: r.at, link: '#/m/routines' }));
  };

  const usage = usageByTeam(svc, userId);

  const teams = svc.list(userId).map((t) => {
    const bots = svc
      .botsOf(t.id)
      .map((id) => store.agent(id)!)
      .filter((a) => a && !a.archived && a.id !== mainId)
      .sort((a, b) => (a.id === t.lead_agent_id ? -1 : b.id === t.lead_agent_id ? 1 : a.name.localeCompare(b.name)));
    const ids = svc.botsOf(t.id).filter((id) => id !== mainId);
    const lead = t.lead_agent_id ? store.agent(t.lead_agent_id) : null;

    let open: OverviewItem[] = [];
    let openCount = 0;
    const waiting = waitingOf(ids);
    const results: OverviewItem[] = [];
    if (tasks) {
      const rows = store.all<any>(`SELECT id, title, status, owner_type, owner_id, updated_at FROM room_tasks WHERE user_id = ? AND workspace_id = ? AND status != 'done' ORDER BY updated_at DESC`, userId, t.id);
      openCount = rows.length;
      open = rows.slice(0, MAX).map((r) => ({ kind: 'task', id: r.id, title: line(r.title), detail: r.status, who: owner(r.owner_type, r.owner_id), at: r.updated_at, link: '#/m/rooms/taken' }));
      for (const r of rows.filter((x) => x.status === 'review')) waiting.push({ kind: 'review', id: r.id, title: line(r.title), detail: '', who: owner(r.owner_type, r.owner_id), at: r.updated_at, link: '#/m/rooms/taken' });
      for (const r of store.all<any>(`SELECT id, title, result, owner_type, owner_id, updated_at FROM room_tasks WHERE user_id = ? AND workspace_id = ? AND status = 'done' AND updated_at >= ? ORDER BY updated_at DESC LIMIT ${MAX}`, userId, t.id, since))
        results.push({ kind: 'task', id: r.id, title: line(r.title), detail: line(r.result, 160), who: owner(r.owner_type, r.owner_id), at: r.updated_at, link: '#/m/rooms/taken' });
    }
    if (delegations && ids.length)
      for (const r of store.all<any>(`SELECT id, from_agent_id, to_agent_id, task, result, thread_id, finished_at FROM room_delegations WHERE user_id = ? AND status = 'done' AND kind != 'ask' AND to_agent_id IN (${q(ids)}) AND finished_at >= ? ORDER BY finished_at DESC LIMIT ${MAX}`, userId, ...ids, since))
        results.push({ kind: 'delegation', id: r.id, title: line(r.task, 80), detail: line(r.result, 160), who: name(r.to_agent_id), at: r.finished_at, link: `#/t/${r.thread_id}` });
    const errors = errorsOf(ids);
    const missed = missedOf(ids);
    waiting.sort(byAt);
    results.sort(byAt);
    return {
      id: t.id,
      name: t.name,
      color: t.color,
      isDefault: svc.list(userId)[0]?.id === t.id,
      lead: lead ? { id: lead.id, name: lead.name, avatar: lead.avatar, color: lead.color } : null,
      bots: bots.map((a) => ({ id: a.id, name: a.name, avatar: a.avatar, color: a.color, role: a.role, lead: a.id === t.lead_agent_id })),
      /** Bots of other teams that may give this team work (aansturen), the main bot first. */
      directedBy: store
        .agents(userId)
        .filter((a) => svc.teamOf(a.id) !== t.id && svc.access(a.id, t.id) === 'direct')
        .sort((a, b) => (a.id === mainId ? -1 : b.id === mainId ? 1 : a.name.localeCompare(b.name)))
        .map((a) => ({ id: a.id, name: a.name, main: a.id === mainId })),
      open: { count: openCount, items: open },
      waiting: { count: waiting.length, items: waiting.slice(0, MAX) },
      results: results.slice(0, MAX),
      errors: { count: errors.length, items: errors.slice(0, MAX) },
      missed: { count: missed.length, items: missed.slice(0, MAX) },
      usage: usage ? usage.teams.get(t.id) || { today: zero(), week: zero() } : null,
    };
  });

  const main = mainId ? store.agent(mainId) : null;
  const mainWaiting = main ? waitingOf([main.id]) : [];
  const mainErrors = main ? errorsOf([main.id]) : [];
  return {
    since,
    days: DAYS,
    main: main
      ? {
          id: main.id,
          name: main.name,
          avatar: main.avatar,
          color: main.color,
          role: main.role,
          archived: main.archived,
          homeTeamId: svc.teamOf(main.id),
          /** Teams the main bot may not give work to (the owner lowered its access); normally empty. */
          notDirected: svc.list(userId).filter((t) => !svc.canDirect(main.id, t.id)).map((t) => ({ id: t.id, name: t.name })),
          waiting: { count: mainWaiting.length, items: mainWaiting.slice(0, MAX) },
          errors: { count: mainErrors.length, items: mainErrors.slice(0, MAX) },
          usage: usage?.main || null,
        }
      : null,
    /** Bots other than the main bot that direct more than one team. */
    leaders: store
      .agents(userId)
      .filter((a) => svc.isLeader(a.id))
      .map((a) => ({ id: a.id, name: a.name, avatar: a.avatar, color: a.color, teams: svc.directableTeams(a.id) })),
    teams,
    usage: usage ? { source: usage.source } : null,
  };
}

/**
 * Usage per team this week. When the usage module groups by team itself (wave 3: `groupings` has 'team'), that is
 * used; otherwise the per-bot numbers are added up by each bot's current home team ("bots"). The main bot's own usage
 * is kept apart. Null when the usage module is not loaded.
 */
function usageByTeam(svc: TeamsService, userId: string): { source: 'team' | 'bots'; teams: Map<string, { today: Spend; week: Spend }>; main: { today: Spend; week: Spend } | null } | null {
  const u = svc.ctx.services.usage;
  if (typeof u?.breakdown !== 'function') return null;
  const mainId = svc.mainOf(userId);
  const teams = new Map<string, { today: Spend; week: Spend }>();
  const slot = (id: string) => {
    let s = teams.get(id);
    if (!s) teams.set(id, (s = { today: zero(), week: zero() }));
    return s;
  };
  try {
    const own = u.breakdown(userId, 'team');
    if (Array.isArray(own?.groupings) && own.groupings.includes('team') && own.by === 'team') {
      for (const r of own.rows || []) {
        const id = r.kind === 'team' ? r.id : typeof r.key === 'string' && r.key.startsWith('team:') ? r.key.slice(5) : null;
        if (!id) continue;
        addSpend(slot(id).today, r.today);
        addSpend(slot(id).week, r.week);
      }
      return { source: 'team', teams, main: null };
    }
  } catch {
    /* grouping by team not offered: add up per bot below */
  }
  try {
    const b = u.breakdown(userId, 'bot');
    const main = mainId ? { today: zero(), week: zero() } : null;
    for (const r of b?.rows || []) {
      if (r.kind !== 'bot' || !r.id) continue;
      if (r.id === mainId && main) {
        addSpend(main.today, r.today);
        addSpend(main.week, r.week);
        continue;
      }
      const tid = svc.teamOf(r.id);
      if (!tid) continue;
      addSpend(slot(tid).today, r.today);
      addSpend(slot(tid).week, r.week);
    }
    return { source: 'bots', teams, main };
  } catch {
    return null;
  }
}
