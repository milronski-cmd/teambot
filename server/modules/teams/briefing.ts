import type { Ctx } from '../../core/types.js';
import { userTz } from '../../agent/prompt.js';
import { oneLine } from '../../core/util.js';
import { redact } from '../../core/secrets.js';
import { tellOwner } from '../notifications/owner.js';
import { plannerOf, type Planned } from '../routines/planner.js';
import { nextRunAfter, startOfDay } from '../routines/schedule.js';
import type { TeamsService } from './service.js';

/**
 * The briefing: every day (or week) the main bot tells the owner, short, what was done, what changed (numbers) and
 * what waits on him. And once a week the top 3 opportunities.
 *
 * Written by TeamBot from its own data, without a model call: it costs no tokens and cannot make anything up. What
 * "changed" is the difference with the state at the previous briefing (kept as the setting `proactive.briefing`), so
 * it does not depend on clocks or on what a bot says it did:
 *  - tasks that became klaar, new problems the vaste taken found, problems that are gone;
 *  - numbers the checks measured that are different now (a site's status, pages in the sitemap, number of faults);
 *  - projects that moved a step;
 *  - what waits: decisions, tasks to check, approvals, opportunities, vaste taken that wait for a connection.
 *
 * With a main bot the briefing is a message in his chat (and on the owner's chat app when one is connected) plus one
 * notification; without one it is the notification, and the text stays readable on the page Werk.
 *
 * It has no clock of its own: it is a source of the one planner (routines/planner.ts, source `briefing`) and is looked
 * at once a minute on the planner's clock. Off until the owner (or his main bot) turns it on: the setting `briefing`
 * of Werk (`dag`, `week` or `uit`; a new install starts at `uit`). It comes at the one hour the owner has for his main
 * bot (`mainHour`, also the hour of the check-in).
 *
 * One message, not two: while the main bot's own check-in is on (proactive.ts), the overview is not posted by itself
 * for that owner (`takenOver`). The check-in then asks for the same overview with `hold` (built and kept, not posted)
 * and gives it to the main bot as the facts of its turn.
 */

const KEY = 'proactive.briefing';
const MAX_ITEMS = 5;
/** The owner's setting for when his main bot comes to him by itself: { enabled, time } (enabled: the check-in of proactive.ts). */
export const CHECKIN_KEY = 'proactive.checkin';
export const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The one hour ('UU:MM', the owner's time zone) at which the main bot comes to the owner: the check-in, or else the overview. */
export function mainHour(ctx: Ctx, userId: string): string {
  const t = ctx.store.getSetting<{ time?: unknown } | null>(userId, CHECKIN_KEY, null)?.time;
  return typeof t === 'string' && TIME.test(t) ? t : '09:00';
}

interface Snapshot {
  /** When the last briefing was made (ms); its local date says whether today's is done. */
  at: number;
  /** ISO week of the last top 3. */
  week: string;
  /** team key → task id → status. */
  tasks: Record<string, Record<string, string>>;
  /** team key → project id → fase. */
  projects: Record<string, Record<string, string>>;
  /** duty routine id → numbers of its last measurement. */
  numbers: Record<string, Record<string, number>>;
  /** What the vaste taken waited for at the last briefing (told again only when it changes, and on Mondays). */
  needs: string[];
  /** The last briefing as text (shown on the page Werk). */
  text: string;
}

const EMPTY: Snapshot = { at: 0, week: '', tasks: {}, projects: {}, numbers: {}, needs: [], text: '' };
const CLOSED = ['klaar', 'geannuleerd', 'kon_niet', 'vervallen'];

const count = (n: number, one: string, many: string) => (n === 1 ? `1 ${one}` : `${n} ${many}`);

export function localParts(ms: number, tz: string) {
  const p: Record<string, string> = {};
  for (const x of new Intl.DateTimeFormat('en-GB', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', weekday: 'short' }).formatToParts(new Date(ms))) p[x.type] = x.value;
  return { day: `${p.year}-${p.month}-${p.day}`, time: `${p.hour}:${p.minute}`, weekday: p.weekday };
}

/** ISO week of a local date ('2026-W46'). */
export function isoWeek(day: string): string {
  const d = new Date(`${day}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - dow + 3);
  const first = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round(((d.getTime() - first.getTime()) / 86_400_000 - 3 + ((first.getUTCDay() + 6) % 7)) / 7);
  return `${d.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}

export interface BriefingResult {
  text: string;
  messageId: string | null;
  sent: string[];
  quiet: boolean;
}

export class Briefing {
  private off: (() => void) | null = null;
  private busy = false;
  /** The planner's clock (a test may set its own). */
  clock = () => plannerOf(this.ctx)?.now() ?? Date.now();
  /** The main bot's check-in (proactive.ts) brings the overview itself for this owner: he is skipped here. */
  takenOver: (userId: string) => boolean = () => false;

  constructor(
    private ctx: Ctx,
    private svc: TeamsService,
  ) {}

  /** Register with the planner: a look once a minute, and what is planned for its list. */
  start() {
    this.stop();
    this.off = plannerOf(this.ctx)?.register({ id: 'briefing', everyMs: 60_000, look: () => this.tick(), planned: (userId) => this.planned(userId) }) ?? null;
  }

  stop() {
    this.off?.();
    this.off = null;
  }

  /** How often the owner wants the overview (the setting of Werk); `uit` until he chooses. */
  private often(userId: string): 'dag' | 'week' | 'uit' {
    return this.ctx.services.routines?.duties?.settings?.(userId)?.briefing || 'uit';
  }

  private snap(userId: string): Snapshot {
    return { ...EMPTY, ...(this.ctx.store.getSetting<Partial<Snapshot>>(userId, KEY, {}) || {}) };
  }

  /** Local date of the last briefing ('' when there was none). */
  private dayOf(s: Snapshot, tz: string): string {
    return s.at ? localParts(s.at, tz).day : '';
  }

  /**
   * For the planner's list: when the next overview comes by itself. Nothing while it is off or while the check-in
   * brings it. (No model call: TeamBot writes it from its own data.)
   */
  planned(userId: string): Planned[] {
    const often = this.often(userId);
    if (often === 'uit' || this.takenOver(userId)) return [];
    const tz = userTz(this.ctx, userId);
    const at = this.clock();
    const today = localParts(at, tz).day;
    const prev = this.snap(userId);
    const done = often === 'dag' ? this.dayOf(prev, tz) === today : prev.week === isoWeek(today);
    const hour = (days: number[], from: number) => nextRunAfter({ kind: 'weekly', days, times: [mainHour(this.ctx, userId)] }, tz, from);
    const all = [0, 1, 2, 3, 4, 5, 6];
    // Still to come today (this week): today's hour, also when it has just passed. Done: the next day, or the next Monday.
    const todayAt = hour(all, startOfDay(at, tz) - 1);
    const next = done ? hour(often === 'dag' ? all : [1], Math.max(at, todayAt ?? at)) : todayAt;
    if (next === null) return [];
    return [{ kind: 'briefing', id: 'briefing', userId, agentId: this.svc.mainOf(userId), title: 'Overzicht van de hoofdbot', at: new Date(next).toISOString(), model: false, link: '#/m/routines/werk' }];
  }

  /** The last briefing (text and when), for the page Werk. */
  last(userId: string): { text: string; at: number } {
    const s = this.snap(userId);
    return { text: s.text, at: s.at };
  }

  /** Is the weekly top 3 still to come this week (for the check-in that takes the overview over)? */
  weekDue(userId: string): boolean {
    return this.snap(userId).week !== isoWeek(localParts(this.clock(), userTz(this.ctx, userId)).day);
  }

  /** A look of the planner: whoever is due gets his briefing, and on the first briefing moment of a week the top 3. */
  async tick(): Promise<BriefingResult[]> {
    if (this.busy) return [];
    this.busy = true;
    const out: BriefingResult[] = [];
    try {
      for (const { user_id } of this.ctx.store.all<{ user_id: string }>('SELECT DISTINCT user_id FROM agents WHERE archived = 0')) {
        try {
          if (this.takenOver(user_id)) continue;
          const often = this.often(user_id);
          const tz = userTz(this.ctx, user_id);
          const now = localParts(this.clock(), tz);
          if (now.time < mainHour(this.ctx, user_id)) continue;
          const prev = this.snap(user_id);
          const week = isoWeek(now.day);
          const dueWeek = prev.week !== week;
          const dueDay = often === 'dag' ? this.dayOf(prev, tz) !== now.day : often === 'week' ? dueWeek : false;
          if (!dueDay && !dueWeek) continue;
          const r = await this.send(user_id, { weekly: dueWeek, briefing: dueDay });
          if (r) out.push(r);
        } catch (e: any) {
          this.ctx.log.warn('[teams] overzicht', redact(String(e?.message || e)));
        }
      }
    } finally {
      this.busy = false;
    }
    return out;
  }

  /**
   * Build and deliver the briefing now. `weekly` also offers the top 3 opportunities. `hold`: build it and keep the
   * state, but post nothing (the main bot's check-in tells it in its own words).
   */
  async send(userId: string, o: { weekly?: boolean; briefing?: boolean; hold?: boolean } = { briefing: true }): Promise<BriefingResult | null> {
    const ctx = this.ctx;
    const prev = this.snap(userId);
    const first = !prev.at;
    const td = ctx.services.teamdata;
    const routines = ctx.services.routines;
    const teams = this.svc.list(userId);
    const multi = teams.length > 1;
    const nowLocal = localParts(this.clock(), userTz(this.ctx, userId));
    const next: Snapshot = { at: this.clock(), week: o.weekly ? isoWeek(nowLocal.day) : prev.week, tasks: {}, projects: {}, numbers: {}, needs: [], text: '' };

    const done: string[] = [];
    const changed: string[] = [];
    const waits: string[] = [];
    let doneCount = 0;
    let waitTasks = 0;

    // Tasks and projects, per team: the difference with the previous briefing.
    for (const t of teams.length ? teams : [{ id: null as any, name: '' }]) {
      const tk = t.id || '';
      const tag = multi && t.name ? `${t.name}: ` : '';
      const rows: any[] = td ? await td.rows(userId, 'SELECT id, titel, eigenaar, status, resultaat, bron FROM taken ORDER BY id DESC LIMIT 2000', [], true, t.id) : [];
      const before = prev.tasks[tk] || {};
      next.tasks[tk] = {};
      const fresh: any[] = [];
      for (const r of rows) {
        next.tasks[tk][r.id] = r.status;
        const was = before[r.id];
        if (r.status === 'klaar' && was !== 'klaar' && !first) {
          doneCount++;
          if (done.length < MAX_ITEMS) done.push(`${tag}${oneLine(r.titel, 80)}${r.resultaat ? ` — ${oneLine(r.resultaat, 90)}` : ''} (${r.eigenaar || 'bot'})`);
        }
        if (!was && !first && !CLOSED.includes(r.status) && String(r.bron || '').startsWith('vaste-taak:')) fresh.push(r);
        if (String(r.status).startsWith('wacht_op')) waitTasks++;
      }
      if (fresh.length) changed.push(`${tag}${count(fresh.length, 'nieuw probleem', 'nieuwe problemen')} gevonden: ${fresh.slice(0, 3).map((r) => oneLine(r.titel, 70)).join('; ')}${fresh.length > 3 ? ` en nog ${fresh.length - 3}` : ''}`);

      const projects: any[] = ctx.services.projects ? await ctx.services.projects.list(userId, t.id || undefined) : [];
      const pb = prev.projects[tk] || {};
      next.projects[tk] = {};
      for (const p of projects) {
        if (!multi || p.teamId === t.id) {
          next.projects[tk][p.id] = `${p.status}:${p.fase}`;
          const was = pb[p.id];
          if (first || was === `${p.status}:${p.fase}`) continue;
          if (p.status === 'tiptop') done.push(`${tag}project “${oneLine(p.naam, 60)}” is tip-top`);
          else if (p.status === 'sprint') changed.push(`${tag}project “${oneLine(p.naam, 60)}”: ${was ? `${was.split(':')[1]} → ` : 'gestart, '}${p.fase}${p.tasks.total ? ` (${p.tasks.done} van ${p.tasks.total} taken klaar)` : ''}`);
        }
      }
    }

    // Numbers the checks measured, against the previous briefing.
    const duties: any[] = routines?.duties ? await routines.duties.views(userId) : [];
    const needs = new Set<string>();
    for (const d of duties) {
      if (d.needs && (d.status === 'active' || d.parked)) needs.add(d.needs);
      const last = ctx.store.one<{ meta: string }>("SELECT meta FROM routine_runs WHERE routine_id = ? AND json_extract(meta, '$.duty.numbers') IS NOT NULL ORDER BY created_at DESC, rowid DESC LIMIT 1", d.id);
      let nums: Record<string, number> = {};
      try {
        nums = JSON.parse(last?.meta || '{}')?.duty?.numbers || {};
      } catch {
        /* keep empty */
      }
      next.numbers[d.id] = nums;
      const was = prev.numbers[d.id];
      if (!was || first) continue;
      const diffs = Object.keys(nums)
        .filter((k) => !/ ms$/.test(k) && k !== 'paginas' && k !== 'websites' && was[k] !== undefined && was[k] !== nums[k])
        .map((k) => `${k} ${was[k]} → ${nums[k]}`);
      if (diffs.length) changed.push(`${oneLine(d.name, 50)}: ${diffs.slice(0, 4).join(', ')}`);
    }

    // What the planner did since the previous briefing.
    const since = new Date(prev.at || this.clock() - 86_400_000).toISOString();
    const runs = ctx.store.one<{ quiet: number; model: number }>(
      "SELECT SUM(CASE WHEN json_extract(meta, '$.duty') IS NOT NULL AND COALESCE(json_extract(meta, '$.duty.model'), 0) = 0 AND status = 'no_update' THEN 1 ELSE 0 END) quiet, SUM(CASE WHEN json_extract(meta, '$.duty.model') = 1 THEN 1 ELSE 0 END) model FROM routine_runs WHERE user_id = ? AND created_at >= ?",
      userId,
      since,
    ) || { quiet: 0, model: 0 };

    // What waits on the owner.
    const sum = td ? await td.summary(userId).catch(() => null) : null;
    const approvals = ctx.store.one<{ n: number }>("SELECT COUNT(*) n FROM approvals WHERE user_id = ? AND status = 'pending'", userId)?.n || 0;
    const kansen = ctx.services.kansen;
    const top: any[] = o.weekly && kansen ? await kansen.propose(userId) : [];
    const waitingKansen: any[] = kansen ? await kansen.waiting(userId) : [];
    if (sum?.openDecisions) waits.push(count(sum.openDecisions, 'beslissing', 'beslissingen'));
    if (approvals) waits.push(count(approvals, 'toestemming of vraag', 'toestemmingen en vragen'));
    if (waitTasks) waits.push(count(waitTasks, 'taak die op jou wacht', 'taken die op jou wachten'));
    if (waitingKansen.length) waits.push(count(waitingKansen.length, 'kans om over te beslissen', 'kansen om over te beslissen'));

    next.needs = [...needs].sort();
    const needsNew = next.needs.some((x) => !(prev.needs || []).includes(x));
    const tellNeeds = needs.size > 0 && (needsNew || !!o.weekly);
    const nothing = !done.length && !changed.length && !waits.length && !top.length && !needsNew;
    const parts: string[] = [];
    if (o.briefing || top.length) {
      if (done.length) parts.push(`**Gedaan**\n${done.map((x) => `- ${x}`).join('\n')}${doneCount > done.length ? `\n- en nog ${count(doneCount - done.length, 'taak', 'taken')} klaar` : ''}`);
      if (changed.length) parts.push(`**Veranderd**\n${changed.slice(0, 8).map((x) => `- ${x}`).join('\n')}`);
      if (waits.length) parts.push(`**Wacht op jou**\n- ${waits.join(', ')}`);
      if (top.length) parts.push(`**Kansen van deze week**\n${top.map((k, i) => `${i + 1}. ${oneLine(k.titel, 90)} (score ${k.score}/100). Waarom nu: ${oneLine(k.waarom_nu, 160)} Bron: ${k.bronnen[0].url} (${k.bronnen[0].datum}). Mini-test: ${oneLine(k.minitest, 140)}`).join('\n')}\nJe beslist in Wacht op jou: ja (mini-test), nee of later.`);
      if (tellNeeds) parts.push(`**Nodig van jou**\n${[...needs].slice(0, 4).map((x) => `- ${x}`).join('\n')}`);
      const foot = [`${count(Number(runs.quiet) || 0, 'controle', 'controles')} zonder AI in orde`, Number(runs.model) ? `${count(Number(runs.model), 'botbeurt', 'botbeurten')} proactief werk` : ''].filter(Boolean).join(', ');
      if (!first && (Number(runs.quiet) || Number(runs.model))) parts.push(`_${foot}._`);
    }
    // Nothing happened and nothing waits: no message (a quiet day is quiet). The state is still kept for next time.
    const quiet = nothing || !parts.length;
    const text = quiet ? '' : parts.join('\n\n');
    next.text = text || prev.text;
    ctx.store.setSetting(userId, KEY, next);
    if (quiet) return { text: '', messageId: null, sent: [], quiet: true };
    if (o.hold) return { text, messageId: null, sent: [], quiet: false };

    const mainId = this.svc.mainOf(userId);
    const main = mainId ? ctx.store.agent(mainId) : null;
    let messageId: string | null = null;
    let link = '#/m/routines/werk';
    let sent: string[] = [];
    if (main && !main.archived) {
      const thread = ctx.chat.threadForAgent(userId, main.id);
      const m = ctx.chat.addAgentMessage(thread, main, text, { briefing: { weekly: !!o.weekly, kansen: top.map((k) => ({ id: k.id, teamId: k.teamId })) } } as any);
      messageId = m.id;
      link = top.length ? '#/inbox' : `#/t/${thread.id}`;
      sent = (await tellOwner(ctx, { userId, agent: main, text: text.replace(/\*\*/g, '*'), teamId: this.svc.teamOf(main.id) })).sent;
    }
    ctx.events.emit(userId, 'notification', {
      title: top.length ? `Top ${top.length} kansen van deze week` : main ? `${main.name}: overzicht` : 'Overzicht van je team',
      body: oneLine([done.length ? count(doneCount || done.length, 'ding gedaan', 'dingen gedaan') : '', changed.length ? count(changed.length, 'verandering', 'veranderingen') : '', waits.length ? `wacht op jou: ${waits.join(', ')}` : '', top.length ? top.map((k) => k.titel).join('; ') : ''].filter(Boolean).join(' · '), 280),
      link,
      kind: top.length || waits.length ? 'warning' : 'info',
      ...(top.length || waits.length ? { level: 'important' } : {}),
      agentId: main?.id,
      ref: `briefing:${nowLocal.day}`,
    });
    ctx.audit(userId, 'teams.briefing', { done: doneCount, changed: changed.length, waits: waits.length, kansen: top.length }, main?.id);
    return { text, messageId, sent, quiet: false };
  }
}
