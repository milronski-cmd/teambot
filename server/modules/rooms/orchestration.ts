import type { Agent, Message, Run, Thread, ToolContext, ToolOutput } from '../../core/types.js';
import { toolError } from '../../tools/registry.js';
import { newId, now } from '../../core/db.js';
import { usdText } from '../../core/i18n.js';
import { stoppedByOwner } from '../../agent/runs.js';
import { nameKey } from './routing.js';
import { TASK_LABEL, type Task } from './board.js';
import { TERMINAL_DELEGATION, TERMINAL_RUN, type Delegation, type Room, type TeamMeta } from './types.js';
import type { RoomService } from './service.js';
import { progressSince } from './progress.js';
import type { Words } from '../../../shared/i18n-core.js';

export const DELEGATION_LABEL: Record<string, string> = { queued: 'in de wachtrij', running: 'bezig', done: 'klaar', error: 'fout', cancelled: 'gestopt', timeout: 'time-out' };

const oneLine = (s: string) => s.replace(/\s+/g, ' ').trim();
const cap = (s: string | null | undefined, n: number) => {
  const v = s || '';
  return v.length > n ? v.slice(0, n) + `\n… (${v.length - n} tekens ingekort; volledig resultaat staat in het subgesprek)` : v;
};

/**
 * Bot-to-bot work: delegation into separate subthreads (kind "delegation", parent_id), broadcasts with
 * separately tracked runs, ownership handoff and direct bot messages. Every hop is checked for cycles,
 * depth, turn budget and spend; results return to the owner as a tool result (wait) or follow-up turn.
 */
export class Orchestrator {
  private waiters = new Map<string, () => void>();

  constructor(private s: RoomService) {}

  private get ctx() {
    return this.s.ctx;
  }

  get(id: string | null | undefined): Delegation | null {
    return id ? this.ctx.store.get<Delegation>('room_delegations', id) : null;
  }

  // ------------------------------------------------------------------ the record: one life cycle, written here

  /**
   * Every piece of work a bot gives to another bot is one row of room_delegations, whatever tool gave it
   * (delegate_task, message_bot, ask_bot, broadcast, a task on the board with an owner). Its life:
   *
   *   gevraagd (queued) → bezig (running) → terug (done) | niet gelukt (error, timeout, cancelled)
   *                                        | gestopt door de eigenaar (cancelled with his reason: stoppedByOwner)
   *
   * and then "verteld" (delivered): the giver has the outcome. What was asked for (wait, follow_up) never changes:
   * whether somebody waits inside its turn right now is only known in memory (waiters), so an outcome whose waiter is
   * gone (its turn was stopped, the wait ran out, TeamBot started again) simply goes the normal way back.
   * The four functions below are the only ones that write the row; everything else reads it.
   */
  private open(o: Pick<Delegation, 'user_id' | 'room_id' | 'kind' | 'parent_thread_id' | 'thread_id' | 'from_agent_id' | 'to_agent_id' | 'task' | 'path'> & Partial<Delegation>): Delegation {
    const ts = now();
    const d: Delegation = { id: newId('dlg_'), group_id: null, parent_run_id: null, tool_call_id: null, expected: '', status: 'queued', result: null, error: null, run_id: null, chain_id: null, depth: o.path.length - 1, wait: false, follow_up: true, delivered: false, task_id: null, created_at: ts, updated_at: ts, finished_at: null, ...o };
    this.ctx.store.insert('room_delegations', d);
    if (d.status === 'queued') this.stallCheck(d);
    return d;
  }

  /** Requests between the same two bots in one chain (about twice as many turns) after which the owner hears it. */
  static readonly STALL_REQUESTS = 15;
  private stallsTold = new Set<string>();

  /**
   * Two bots that keep talking without anything changing. The loop rule does not catch them when they put it in other
   * words each round (a different answer is progress there), and nothing stops them: that is up to the owner. So he
   * hears it, once per chain and pair: the STALL_REQUESTS-th request between them in this chain, with no real progress
   * since the first of those (progress.ts; a different wording is not progress here). Nothing is refused.
   */
  private stallCheck(d: Delegation) {
    try {
      if (!d.chain_id) return;
      const [a, b] = [d.from_agent_id, d.to_agent_id].sort();
      const key = `${d.chain_id}:${a}:${b}`;
      if (this.stallsTold.has(key)) return;
      const first = this.ctx.store.one<{ created_at: string }>(
        'SELECT created_at FROM room_delegations WHERE chain_id = ? AND user_id = ? AND ((from_agent_id = ? AND to_agent_id = ?) OR (from_agent_id = ? AND to_agent_id = ?)) ORDER BY created_at DESC, rowid DESC LIMIT 1 OFFSET ?',
        d.chain_id,
        d.user_id,
        a,
        b,
        b,
        a,
        Orchestrator.STALL_REQUESTS - 1,
      );
      if (!first || progressSince(this.ctx, d.user_id, d.chain_id, first.created_at)) return;
      this.stallsTold.add(key);
      // Told before TeamBot started again: not twice.
      if (this.ctx.store.one("SELECT 1 FROM audit WHERE user_id = ? AND kind = 'team.stall' AND json_extract(data, '$.key') = ? LIMIT 1", d.user_id, key)) return;
      const from = this.s.agentName(d.from_agent_id);
      const to = this.s.agentName(d.to_agent_id);
      const turns = 2 * Orchestrator.STALL_REQUESTS;
      this.s.notify(d.user_id, {
        roomId: d.room_id,
        kind: 'stall',
        title: `${from} en ${to} overleggen al ${turns} beurten zonder dat er iets verandert`,
        body: `${Orchestrator.STALL_REQUESTS} verzoeken in dit werk, zonder dat er iets werd geschreven, verstuurd of uitgevoerd of een taak verder kwam. Ze gaan door: kijk of dit de bedoeling is.`,
        link: `#/t/${d.parent_thread_id}`,
      });
      this.ctx.audit(d.user_id, 'team.stall', { key, chainId: d.chain_id, from, to, requests: Orchestrator.STALL_REQUESTS, task: oneLine(d.task).slice(0, 300) }, d.from_agent_id);
    } catch (e) {
      this.ctx.log.warn('[rooms] stall check', e);
    }
  }

  /**
   * The receiver's turn that works on it: the first, one that goes on after a restart, a follow-up turn, the turn of
   * the bot it was handed to (`to`). `again`: a closed record whose work is finished after all in a later turn.
   */
  private turn(id: string, run: Run | null, o: { status?: 'queued' | 'running'; to?: string; again?: boolean } = {}) {
    this.ctx.store.update('room_delegations', id, {
      ...(run ? { run_id: run.id } : {}),
      ...(o.status ? { status: o.status } : {}),
      ...(o.to ? { to_agent_id: o.to } : {}),
      ...(o.again ? { status: 'running', error: null, delivered: false, finished_at: null } : {}),
      updated_at: now(),
    });
  }

  /** The end of its life: terug (done), niet gelukt (error, timeout, cancelled) or gestopt door de eigenaar. */
  private close(id: string, status: 'done' | 'error' | 'cancelled' | 'timeout', o: { result?: string | null; error?: string | null } = {}): Delegation {
    const ts = now();
    this.ctx.store.update('room_delegations', id, { status, ...('result' in o ? { result: o.result } : {}), error: status === 'done' ? null : o.error ?? null, finished_at: ts, updated_at: ts });
    const d = this.get(id)!;
    this.emit(d);
    return d;
  }

  /** The giver has the outcome, or will not be told (it withdrew the request, it was stopped itself, it is gone). */
  private told(id: string) {
    this.ctx.store.update('room_delegations', id, { delivered: true, updated_at: now() });
  }

  view(d: Delegation) {
    const th = this.ctx.store.thread(d.thread_id);
    const held = d.kind === 'ask' && d.status === 'queued' && !d.run_id;
    const waitsFor = this.waiting(d) ? [...new Set(this.openChildren(d).map((c) => this.s.agentName(c.to_agent_id)))] : [];
    return {
      ...d,
      fromName: this.s.agentName(d.from_agent_id),
      toName: this.s.agentName(d.to_agent_id),
      statusLabel: held
        ? `wacht tot ${this.s.agentName(d.to_agent_id)} vrij is`
        : waitsFor.length
          ? `wacht op ${waitsFor.join(', ')}`
          : TERMINAL_DELEGATION.has(d.status) && d.follow_up && !d.delivered
            ? `${d.status === 'done' ? 'antwoord klaar' : this.statusWord(d)} (wordt bezorgd)`
            : this.statusWord(d),
      threadTitle: th?.title || '',
      threadExists: !!th,
      check: this.check(d),
    };
  }

  forThread(threadId: string): Delegation[] {
    return this.ctx.store.find<Delegation>('room_delegations', { parent_thread_id: threadId }, { order: 'created_at DESC', limit: 200 });
  }

  forRoom(roomId: string): Delegation[] {
    return this.ctx.store.find<Delegation>('room_delegations', { room_id: roomId }, { order: 'created_at DESC', limit: 300 });
  }

  resolveBot(userId: string, ref: any, room: Room | null = null): Agent | null {
    const r = String(ref ?? '').trim().replace(/^@/, '');
    if (!r) return null;
    // Security: when other people take part in a room, its bots may only reach the room's own bots — never the
    // owner's other bots (with their own tools, files and memory) on behalf of a room member.
    const allowed = room && this.s.humanMembers(room).some((h: any) => h.accepted) ? new Set(this.s.botMembers(room).map((m) => m.ref_id)) : null;
    const ok = (a: Agent | null | undefined) => !!a && a.user_id === userId && !a.archived && (!allowed || allowed.has(a.id));
    const byId = this.ctx.store.agent(r);
    if (ok(byId)) return byId!;
    const key = nameKey(r);
    return this.ctx.store.agents(userId).find((a) => nameKey(a.name) === key && ok(a)) || null;
  }

  /** Bots the caller can reach: in a room its members, otherwise the owner's bots (with teams: only reachable ones). */
  botList(userId: string, room: Room | null, fromId?: string): string {
    const ids = room ? this.s.botMembers(room).map((m) => m.ref_id) : this.ctx.store.agents(userId).map((a) => a.id);
    const names = ids.filter((id) => !fromId || id === fromId || !this.teamError(fromId, id)).map((id) => this.s.agentName(id));
    return names.slice(0, 30).join(', ') || '(geen)';
  }

  /** Teams (module teams): giving work to a bot of another team needs aansturen on that team. */
  teamError(fromId: string, toId: string): string | null {
    try {
      return this.ctx.services.teams?.delegateError?.(fromId, toId) ?? null;
    } catch {
      return 'Geweigerd door TeamBot: de teamtoegang kon niet worden gecontroleerd.';
    }
  }

  /** The chain of the calling run; runs that were not started by us become a fresh chain rooted at their input. */
  callerChain(t: ToolContext): TeamMeta {
    const m = t.run.meta?.team as TeamMeta | undefined;
    if (m?.chainId) return { ...m, path: m.path?.length ? m.path : [t.agent.id] };
    const input = this.ctx.store.message(t.run.input_message_id);
    return { chainId: t.run.input_message_id || t.run.id, path: [t.agent.id], handoffs: 0, kind: 'turn', untracked: true, requestedBy: input?.author_type === 'user' ? input.author_id : null };
  }

  private names(ids: string[]) {
    return ids.map((i) => this.s.agentName(i)).join(' → ');
  }

  /** Cycle, depth and permission checks for one new hop from the calling bot to target. */
  hopError(t: ToolContext, target: Agent, chain: TeamMeta, room: Room | null): string | null {
    if (target.id === t.agent.id) return 'Je kunt geen taak aan jezelf geven.';
    const te = this.teamError(t.agent.id, target.id);
    if (te) return te;
    if (chain.path.includes(target.id))
      return `Geweigerd om een lus te voorkomen: ${target.name} zit al in deze keten (${this.names(chain.path)} → ${target.name}). Werk het zelf af of leg het voor aan een mens.`;
    const l = this.s.limits(room, t.thread.user_id);
    // Settings of the owner, off unless he set them: -1 = bots may not give each other work, a number = that many hops.
    if (l.maxDelegationDepth < 0) return 'Werk doorgeven aan andere bots staat uit (ingesteld door de eigenaar).';
    if (l.maxDelegationDepth > 0 && chain.path.length > l.maxDelegationDepth) return `Maximale delegatiediepte van ${l.maxDelegationDepth} bereikt (${this.names(chain.path)}). Werk het zelf af.`;
    if (room) {
      const m = this.s.botMember(room, t.agent.id);
      if (m && !this.s.perms(m).delegate) return 'Je hebt in deze groep geen toestemming om werk aan andere bots te geven.';
    }
    return null;
  }

  private subAudience(room: Room | null): string[] {
    return room ? this.s.humanMembers(room).filter((m) => m.role !== 'guest').map((m) => m.ref_id) : [];
  }

  /** The read-only bot-to-bot thread between the calling bot and target (reused per pair and room). */
  private dmThread(t: ToolContext, target: Agent, room: Room | null): Thread {
    const userId = t.thread.user_id;
    const key = `${room?.id || '-'}:${t.agent.id}:${target.id}`;
    const row = this.ctx.store.one<any>("SELECT * FROM threads WHERE user_id = ? AND kind = 'delegation' AND json_extract(meta, '$.dmKey') = ?", userId, key);
    if (row) return this.ctx.store.decode<Thread>('threads', row);
    return this.ctx.store.createThread({
      user_id: userId,
      agent_id: target.id,
      room_id: room?.id ?? null,
      kind: 'delegation',
      parent_id: t.thread.id,
      title: `${t.agent.name} → ${target.name}`,
      meta: { dm: true, dmKey: key, delegation: { from: t.agent.id, to: target.id, parentThreadId: t.thread.id }, memberUserIds: this.subAudience(room) },
    });
  }

  /** The agent has a queued, running or waiting run in this thread (or the owner's queued message is being posted). */
  busy(threadId: string, agentId: string): boolean {
    if (this.ctx.services.queue?.isDraining?.(threadId)) return true;
    return !!this.ctx.store.one("SELECT id FROM runs WHERE thread_id = ? AND agent_id = ? AND status IN ('queued','running','waiting') LIMIT 1", threadId, agentId);
  }

  // ------------------------------------------------------------------ asynchronous bot messages (mailbox)

  /** Spend of a chain so far: every run of the chain plus the (untracked) root run that started it. */
  chainSpend(userId: string, chainId: string, rootRunId: string): { cost: number; tokens: number } {
    const r = this.ctx.store.one<{ c: number; i: number; o: number }>(
      "SELECT COALESCE(SUM(json_extract(usage,'$.cost')),0) c, COALESCE(SUM(json_extract(usage,'$.input')),0) i, COALESCE(SUM(json_extract(usage,'$.output')),0) o FROM runs WHERE user_id = ? AND (json_extract(meta, '$.team.chainId') = ? OR id = ?)",
      userId,
      chainId,
      rootRunId,
    );
    return { cost: r?.c || 0, tokens: (r?.i || 0) + (r?.o || 0) };
  }

  private loopsTold = new Set<string>();

  /**
   * Loop protection: the one thing that stops work between bots by itself. Not a count of turns, hops or messages (a
   * busy team makes many; those caps are settings that are off), but the same thing going round with nothing changing.
   * In one chain (one origin), the same bot gives the same colleague the same request for the third time, the two times
   * before came back with the same outcome, and nothing happened in between that counts as progress (progress.ts: a
   * step that wrote, sent, ran or used an app, on any engine, or a task on the board that moved on).
   * Then that third time is refused, with why in one sentence, and the owner hears it once. A request that comes back
   * differently, or with something changed in between, is never a loop, however often it is made.
   */
  loopError(t: ToolContext, target: Agent, chain: TeamMeta, text: string): string | null {
    const userId = t.thread.user_id;
    const same = oneLine(text);
    const before = this.ctx.store
      .all<any>("SELECT * FROM room_delegations WHERE user_id = ? AND chain_id = ? AND from_agent_id = ? AND to_agent_id = ? AND status IN ('done','error','cancelled','timeout') ORDER BY finished_at DESC, rowid DESC LIMIT 20", userId, chain.chainId, t.agent.id, target.id)
      .map((r) => this.ctx.store.decode<Delegation>('room_delegations', r))
      .filter((d) => oneLine(d.task) === same && !stoppedByOwner(d));
    if (before.length < 2) return null;
    const outcome = (d: Delegation) => `${d.status}:${oneLine(d.result || d.error || '')}`;
    if (outcome(before[0]) !== outcome(before[1])) return null;
    if (progressSince(this.ctx, userId, chain.chainId, before[1].finished_at || before[1].created_at)) return null;
    const owner = this.s.userName(userId);
    const key = `${chain.chainId}:${t.agent.id}:${target.id}`;
    if (!this.loopsTold.has(key)) {
      this.loopsTold.add(key);
      this.s.notify(userId, { roomId: this.s.roomForThread(t.thread)?.id ?? null, kind: 'loop', title: `Lus gestopt tussen ${t.agent.name} en ${target.name}`, body: `${t.agent.name} gaf ${target.name} drie keer hetzelfde en kreeg twee keer hetzelfde terug, zonder dat er iets veranderde: “${same.slice(0, 160)}”. De derde keer is niet gestart.`, link: `#/t/${t.thread.id}` });
      this.ctx.audit(userId, 'team.loop', { from: t.agent.name, to: target.name, chainId: chain.chainId, task: same.slice(0, 300) }, t.agent.id);
    }
    return `Gestopt om een lus te voorkomen: je gaf ${target.name} dit al twee keer, het kwam twee keer hetzelfde terug en er is in de tussentijd niets veranderd. Geef het niet nog een keer zo: pak het anders aan, doe het zelf of leg het voor aan ${owner}.`;
  }

  /** Rate (per bot, per pair: ping-pong) and budget limits for asynchronous messages. */
  askLimitError(t: ToolContext, target: Agent, chain: TeamMeta, room: Room | null): string | null {
    const userId = t.thread.user_id;
    const l = this.s.limits(room, userId);
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const mine = this.ctx.store.one<{ n: number }>("SELECT COUNT(*) n FROM room_delegations WHERE user_id = ? AND from_agent_id = ? AND kind = 'ask' AND created_at >= ?", userId, t.agent.id, since)?.n ?? 0;
    if (l.maxAsksPerHour > 0 && mine >= l.maxAsksPerHour) return `Limiet bereikt: ${t.agent.name} stuurde het afgelopen uur al ${mine} berichten aan andere bots (maximaal ${l.maxAsksPerHour} per uur). Rond het zelf af of probeer het later.`;
    const pair = this.ctx.store.one<{ n: number }>("SELECT COUNT(*) n FROM room_delegations WHERE user_id = ? AND from_agent_id = ? AND to_agent_id = ? AND kind = 'ask' AND created_at >= ?", userId, t.agent.id, target.id, since)?.n ?? 0;
    if (l.maxAsksPerPairPerHour > 0 && pair >= l.maxAsksPerPairPerHour) return `Geweigerd om heen-en-weer te voorkomen: ${t.agent.name} stuurde ${target.name} het afgelopen uur al ${pair} berichten (maximaal ${l.maxAsksPerPairPerHour}). Bundel je vragen of werk het zelf af.`;
    const spent = this.chainSpend(userId, chain.chainId, t.run.id);
    if (l.maxChainCostUsd > 0 && spent.cost >= l.maxChainCostUsd) return `Budget van deze keten is op: ${usdText(spent.cost)} van maximaal ${usdText(l.maxChainCostUsd)}. Vat samen wat je hebt; een nieuw bericht van de gebruiker start een nieuwe keten.`;
    if (l.maxChainTokens > 0 && spent.tokens >= l.maxChainTokens) return `Tokenbudget van deze keten is op: ${spent.tokens.toLocaleString('nl-NL')} van maximaal ${l.maxChainTokens.toLocaleString('nl-NL')} tokens. Vat samen wat je hebt.`;
    return null;
  }

  /**
   * ask_bot: send a message/task to another bot without waiting. It is delivered in the target's own chat (or a
   * bot-to-bot thread) as soon as the target is free; its answer is delivered back to the sender's conversation as a
   * new turn. Several answers that arrive while the sender is busy are bundled into one follow-up turn.
   */
  async ask(t: ToolContext, a: any, o: { taskId?: string } = {}): Promise<ToolOutput> {
    const userId = t.thread.user_id;
    const room = this.s.roomForThread(t.thread);
    const shared = !!room && this.s.humanMembers(room).some((h: any) => h.accepted);
    const target = this.resolveBot(userId, a.bot, room);
    if (!target) return toolError(`Onbekende bot: ${a.bot}. Bots die je kunt aanspreken: ${this.botList(userId, shared ? room : null, t.agent.id)}.`);
    const message = String(a.message ?? '').slice(0, 20_000);
    if (!message.trim()) return toolError('Het bericht is leeg.');
    // A task on the board with a colleague as owner is given like all other work: a hop in the chain of the turn it was
    // given in. So the one rule holds for it too: its outcome goes back up the chain, and a stop goes down it.
    const chain = this.callerChain(t);
    const he = this.hopError(t, target, chain, room);
    if (he) return toolError(he);
    const le = this.askLimitError(t, target, chain, room) || this.loopError(t, target, chain, message);
    if (le) return toolError(le);
    const l = this.s.limits(room, userId);
    const g = this.s.gate({ room, userId, agentId: target.id, chain, needMember: false, turnCap: this.s.turnCap(l, { async: true }) });
    if (g) return toolError(g);
    const reply = !!o.taskId || (a.reply !== false && a.reply !== 'false');
    // In a room with other people the exchange stays visible to them (a bot-to-bot thread), never in a private chat.
    const where: 'chat' | 'thread' = a.where === 'thread' || shared ? 'thread' : 'chat';
    const sub = where === 'chat' ? this.ctx.chat.threadForAgent(userId, target.id) : this.dmThread(t, target, room);
    const { id } = this.open({ user_id: userId, room_id: room?.id ?? null, kind: 'ask', parent_thread_id: t.thread.id, parent_run_id: t.run.id, tool_call_id: t.toolCallId, thread_id: sub.id, from_agent_id: t.agent.id, to_agent_id: target.id, task: message, chain_id: chain.chainId, path: [...chain.path, target.id], follow_up: reply, task_id: o.taskId ?? null });
    this.s.activity(room?.id,{ type: 'agent', id: t.agent.id }, 'delegation.ask',`${o.taskId ? 'Taak voor' : 'Bericht aan'} ${target.name}: ${oneLine(message).slice(0, 160)}`, { delegationId: id, threadId: sub.id, to: target.id });
    this.ctx.audit(userId, 'team.ask', { from: t.agent.name, to: target.name, delegationId: id, where, reply, message: oneLine(message).slice(0, 300) }, t.agent.id);
    this.emit(this.get(id)!);
    this.pumpAsks(sub.id, target.id);
    const fresh = this.get(id)!;
    const waiting = !fresh.run_id && fresh.status === 'queued';
    return {
      text:
        `Bericht verstuurd aan ${target.name} (id ${id}, ${where === 'chat' ? `in de chat van ${target.name}` : 'in een bot-tot-botgesprek'}). ` +
        (waiting ? `${target.name} is nog met iets anders bezig; het bericht wordt opgepakt zodra ${target.name} vrij is. ` : '') +
        (reply
          ? `Zodra ${target.name} antwoordt, word je automatisch gewekt met het antwoord als nieuwe beurt in dit gesprek; ook als het niet lukt, met de reden. Wacht er niet op: rond je beurt af of stuur andere bots ook een bericht (antwoorden die binnenkomen terwijl je bezig bent krijg je gebundeld). `
          : `Je wordt niet gewekt als het lukt: wat ${target.name} deed staat daarna als notitie in dit gesprek. Lukt het niet, dan word je wel gewekt, met de reden. `) +
        'Intrekken kan met delegation_cancel.',
      data: { delegationId: id, threadId: sub.id, where },
    };
  }

  /** Post the oldest waiting message for `agentId` in `threadId` and start its turn, when that bot is free there. */
  pumpAsks(threadId: string, agentId: string): boolean {
    if (this.busy(threadId, agentId)) return false;
    const row = this.ctx.store.one<any>("SELECT * FROM room_delegations WHERE thread_id = ? AND to_agent_id = ? AND kind = 'ask' AND status = 'queued' AND run_id IS NULL ORDER BY created_at LIMIT 1", threadId, agentId);
    if (!row) return false;
    const d = this.ctx.store.decode<Delegation>('room_delegations', row);
    const sub = this.ctx.store.thread(threadId);
    const target = this.ctx.store.agent(agentId);
    if (!sub || !target || target.archived) {
      this.deliver(this.close(d.id, 'error', { error: 'De bot of zijn gesprek bestaat niet meer' }));
      return this.pumpAsks(threadId, agentId);
    }
    const from = this.s.agentName(d.from_agent_id);
    const msg = this.ctx.store.createMessage({
      thread_id: sub.id,
      role: 'user',
      author_type: 'agent',
      author_id: d.from_agent_id,
      author_name: from,
      content: d.task_id ? d.task : `${d.follow_up ? `${from} vraagt` : `Bericht van ${from}`}:\n\n${d.task}`,
      parts: { kind: 'bot_ask', delegationId: d.id, from: d.from_agent_id, reply: d.follow_up, ...(d.task_id ? { taskId: d.task_id } : {}) },
    });
    this.ctx.chat.emitMessage(sub, msg);
    const prun = d.parent_run_id ? this.ctx.store.run(d.parent_run_id) : null;
    const pteam = prun?.meta?.team as TeamMeta | undefined;
    const pinput = prun ? this.ctx.store.message(prun.input_message_id) : null;
    const meta: TeamMeta = {
      chainId: d.chain_id || msg.id,
      path: d.path,
      handoffs: pteam?.handoffs ?? 0,
      kind: 'ask',
      roomId: d.room_id,
      requestedBy: pteam?.requestedBy ?? (pinput?.author_type === 'user' ? pinput.author_id : null),
      delegationId: d.id,
      async: true,
    };
    const run = this.ctx.chat.startAgent(sub, agentId, msg.id, 'team:ask', { team: meta });
    if (!run) {
      this.deliver(this.close(d.id, 'error', { error: 'Kon de bot niet starten' }));
      return false;
    }
    this.turn(d.id, run);
    this.ctx.events.emit(d.user_id, 'thread.updated', this.ctx.store.thread(sub.id));
    this.emit(this.get(d.id)!);
    return true;
  }

  /**
   * A bot finished a turn in a thread: bring it held answers first, otherwise the next waiting bot message.
   * `stopped`: the owner stopped that turn (or stopped this bot elsewhere and it had no turn since). Then nothing
   * starts here because of it: only what he stopped is noted; answers and bot messages that were waiting for this bot
   * wait until its next turn has ended.
   */
  onIdle(threadId: string, agentId: string, stopped = false) {
    if (this.busy(threadId, agentId)) return;
    if (this.flush(threadId, agentId, stopped) || stopped || this.ctx.runs.ownerStopped(agentId) !== null) return;
    this.pumpAsks(threadId, agentId);
  }

  /**
   * "Alles stoppen": bot messages that still wait for their recipient are work in the queue; they are stopped too, so
   * nothing of before the stop starts later. Whoever sent one finds the note of a stop by the owner (see flush).
   */
  stopQueued(userId: string): number {
    const rows = this.ctx.store.all<any>("SELECT * FROM room_delegations WHERE user_id = ? AND kind = 'ask' AND status = 'queued' AND run_id IS NULL", userId);
    for (const r of rows) this.cancel(this.ctx.store.decode<Delegation>('room_delegations', r), 'Alles gestopt', { wake: true });
    return rows.length;
  }

  /**
   * Withdraw an open request. Nobody is woken for it (wake=false), unless asked. Returns false when it already ended.
   */
  cancel(d: Delegation, reason: string, o: { wake?: boolean } = {}): boolean {
    if (TERMINAL_DELEGATION.has(d.status)) {
      if (!o.wake && !d.delivered) this.told(d.id);
      return false;
    }
    if (!o.wake) this.told(d.id);
    if (d.run_id) {
      this.stop(this.get(d.id)!, reason);
      return true;
    }
    const fresh = this.close(d.id, 'cancelled', { error: reason });
    if (o.wake) this.deliver(fresh);
    return true;
  }

  /** delegation_cancel: withdraw own open requests from this conversation (one by id, or all). */
  cancelTool(t: ToolContext, a: any): ToolOutput {
    const mine = (d: Delegation | null): d is Delegation => !!d && d.user_id === t.thread.user_id && d.from_agent_id === t.agent.id;
    const list = a?.id ? [this.get(String(a.id))].filter(mine) : a?.all === true || a?.all === 'true' ? this.forThread(t.thread.id).filter((d) => mine(d) && !TERMINAL_DELEGATION.has(d.status)) : [];
    if (!list.length) return a?.id ? toolError(`Geen open verzoek ${a.id} van jou gevonden.`) : toolError('Geef een id, of all=true om alle open verzoeken vanuit dit gesprek in te trekken.');
    const lines = list.map((d) => `- ${d.id} (${this.s.agentName(d.to_agent_id)}): ${this.cancel(d, `Ingetrokken door ${t.agent.name}`) ? 'ingetrokken' : `was al ${DELEGATION_LABEL[d.status]}`}`);
    return { text: `Verzoeken ingetrokken; je wordt er niet meer voor gewekt:\n${lines.join('\n')}` };
  }

  /** Create a subthread (or reuse a direct-message thread), post the task and start the target's run. */
  private spawn(
    t: ToolContext,
    target: Agent,
    o: { kind: Delegation['kind']; task: string; expected: string; groupId?: string | null; wait: boolean; followUp: boolean; chain: TeamMeta; room: Room | null; dm?: boolean },
  ): { d: Delegation; sub: Thread } {
    const userId = t.thread.user_id;
    const id = newId('dlg_');
    const path = [...o.chain.path, target.id];
    let sub: Thread | null = null;
    if (o.dm) {
      sub = this.dmThread(t, target, o.room);
    } else {
      sub = this.ctx.store.createThread({
        user_id: userId,
        agent_id: target.id,
        room_id: o.room?.id ?? null,
        kind: 'delegation',
        parent_id: t.thread.id,
        title: `↳ ${target.name}: ${oneLine(o.task).slice(0, 60)}`,
        meta: { delegation: { id, from: t.agent.id, to: target.id, parentThreadId: t.thread.id }, memberUserIds: this.subAudience(o.room) },
      });
    }
    const parentTitle = t.thread.title || (o.room ? o.room.name : 'een gesprek');
    const content =
      o.kind === 'message'
        ? `Bericht van ${t.agent.name}:\n\n${o.task}`
        : `Gedelegeerde taak van ${t.agent.name} (vanuit “${parentTitle}”):\n\n${o.task}${o.expected ? `\n\nVerwachte uitvoer: ${o.expected}` : ''}${this.trail(path, o.room, userId)}`;
    const msg = this.ctx.store.createMessage({ thread_id: sub.id, role: 'user', author_type: 'agent', author_id: t.agent.id, author_name: t.agent.name, content, parts: { kind: o.kind === 'message' ? 'bot_message' : 'delegation_task', delegationId: id } });
    this.ctx.chat.emitMessage(sub, msg);
    this.open({ id, user_id: userId, room_id: o.room?.id ?? null, kind: o.kind, group_id: o.groupId ?? null, parent_thread_id: t.thread.id, parent_run_id: t.run.id, tool_call_id: t.toolCallId, thread_id: sub.id, from_agent_id: t.agent.id, to_agent_id: target.id, task: o.task, expected: o.expected, chain_id: o.chain.chainId, path, wait: o.wait, follow_up: o.followUp });
    const meta: TeamMeta = { chainId: o.chain.chainId, path, handoffs: o.chain.handoffs, kind: o.kind === 'message' ? 'message' : 'delegation', roomId: o.room?.id ?? null, requestedBy: o.chain.requestedBy ?? null, delegationId: id };
    const run = this.ctx.runs.enqueue({ threadId: sub.id, agentId: target.id, userId, trigger: `team:${o.kind}`, inputMessageId: msg.id, meta: { team: meta } });
    this.turn(id, run);
    this.ctx.events.emit(userId, 'thread.updated', this.ctx.store.thread(sub.id));
    this.s.activity(o.room?.id, { type: 'agent', id: t.agent.id }, `delegation.${o.kind}`, `${o.kind === 'message' ? 'Bericht aan' : 'Taak aan'} ${target.name}: ${oneLine(o.task).slice(0, 160)}`, { delegationId: id, threadId: sub.id, to: target.id });
    this.ctx.audit(userId, `team.${o.kind}`, { from: t.agent.name, to: target.name, delegationId: id, task: oneLine(o.task).slice(0, 300) }, t.agent.id);
    const fresh = this.get(id)!;
    this.emit(fresh);
    return { d: fresh, sub: this.ctx.store.thread(sub.id)! };
  }

  private emit(d: Delegation) {
    const parent = this.ctx.store.thread(d.parent_thread_id);
    const v = this.view(d);
    for (const uid of this.ctx.chat.audience(parent, d.user_id)) this.ctx.events.emit(uid, 'rooms.delegation', v);
  }

  /** Resolve when the delegation finished, the wait expired or the calling run was stopped. */
  private waitFor(id: string, sec: number, signal: AbortSignal): Promise<'done' | 'timeout' | 'aborted'> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = (v: 'done' | 'timeout' | 'aborted') => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.waiters.delete(id);
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      };
      // The wait ran out: nobody waits any more, so the outcome comes the normal way back (a note and a turn).
      const timer = setTimeout(() => finish('timeout'), sec * 1000);
      const onAbort = () => finish('aborted');
      if (signal.aborted) return onAbort();
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiters.set(id, () => finish('done'));
      const d = this.get(id);
      if (d && TERMINAL_DELEGATION.has(d.status)) finish('done');
    });
  }

  private resultText(d: Delegation): string {
    const who = this.s.agentName(d.to_agent_id);
    if (d.status === 'done') return `${d.kind === 'message' ? `Antwoord van ${who}` : `Resultaat van ${who}`}:\n\n${cap(d.result, 20_000)}${this.checkLine(d)}`;
    return `${who} heeft de ${d.kind === 'message' ? 'vraag' : 'taak'} niet afgerond (${DELEGATION_LABEL[d.status]}): ${d.error || 'onbekende reden'}`;
  }

  // ------------------------------------------------------------------ tools

  async delegate(t: ToolContext, a: any, kind: 'delegate' | 'message'): Promise<ToolOutput> {
    const userId = t.thread.user_id;
    const room = this.s.roomForThread(t.thread);
    const target = this.resolveBot(userId, a.bot, room);
    if (!target) return toolError(`Onbekende bot: ${a.bot}. Bots die je kunt aanspreken: ${this.botList(userId, room && this.s.humanMembers(room).some((h: any) => h.accepted) ? room : null, t.agent.id)}.`);
    const chain = this.callerChain(t);
    const he = this.hopError(t, target, chain, room);
    if (he) return toolError(he);
    const g = this.s.gate({ room, userId, agentId: target.id, chain, needMember: false });
    if (g) return toolError(g);
    const task = String((kind === 'message' ? a.message : a.task) ?? '').slice(0, 20_000);
    if (!task.trim()) return toolError(kind === 'message' ? 'Het bericht is leeg.' : 'De taak is leeg.');
    const lo = this.loopError(t, target, chain, task);
    if (lo) return toolError(lo);
    const expected = kind === 'delegate' ? String(a.expected_output ?? '').slice(0, 4000) : '';
    const wait = kind === 'message' ? a.wait !== false && a.wait !== 'false' : a.wait === true || a.wait === 'true';
    const { d, sub } = this.spawn(t, target, { kind, task, expected, wait, followUp: true, chain, room, dm: kind === 'message' });
    if (!wait)
      return {
        text: `${kind === 'message' ? 'Bericht verstuurd aan' : 'Taak gedelegeerd aan'} ${target.name} (id ${d.id}). ${target.name} werkt in een eigen subgesprek (#/t/${sub.id}). Je krijgt het resultaat automatisch als vervolgbeurt, ook als het niet lukt (met de reden). ${target.name} mag er zo lang over doen als het werk vraagt; wacht er niet op: rond je beurt af of doe ander werk. Status opvragen: delegation_status.`,
        data: { delegationId: d.id, threadId: sub.id },
      };
    const sec = Math.min(900, Math.max(5, Number(a.wait_seconds) || (kind === 'message' ? 120 : 300)));
    const r = await this.waitFor(d.id, sec, t.signal);
    if (r === 'aborted') return this.waitCutOff(t, d.id, target, kind);
    if (r === 'timeout') return { text: `${target.name} is na ${sec} s nog bezig (id ${d.id}). Je krijgt het resultaat automatisch als vervolgbeurt zodra het klaar is.`, data: { delegationId: d.id } };
    const fin = this.get(d.id)!;
    return { text: this.resultText(fin), isError: fin.status !== 'done', data: { delegationId: d.id, status: fin.status } };
  }

  /**
   * The giver's turn ended while it waited inside it for the answer (live, 12 nov: after "Alles stoppen" the giver said
   * it had not handed the work over, because all it had was "gestopt voordat er een resultaat was"). The work was given,
   * so the call says that. Nobody waits in a turn for it any more: its outcome comes back like every other, as a note.
   * What happens to the work is the one rule for a turn that is stopped (onRunTerminal), not decided here.
   */
  private waitCutOff(t: ToolContext, id: string, target: Agent, kind: 'delegate' | 'message'): ToolOutput {
    const what = kind === 'message' ? `Je bericht was al bij ${target.name} aangekomen` : `Het werk was al aan ${target.name} gegeven`;
    const again = kind === 'message' ? 'Opnieuw sturen kan.' : 'Opnieuw geven kan met delegate_task.';
    const reason = String((t.signal.reason as any)?.message || t.signal.reason || '');
    if (stoppedByOwner({ status: 'cancelled', error: reason }))
      return toolError(`Gestopt door de eigenaar terwijl je op ${target.name} wachtte. ${what} (id ${id}) en is met jouw beurt gestopt: het is niet af en blijft van ${target.name}. ${again}`);
    if (this.ctx.store.run(t.run.id)?.meta?.steerInterrupt) return toolError(`Je beurt is onderbroken voor een nieuw bericht terwijl je op ${target.name} wachtte. ${what} (id ${id}) en loopt door; de uitkomst krijg je in dit gesprek.`);
    return toolError(`Het wachten op ${target.name} is afgebroken. ${what} (id ${id}); wat ermee gebeurt lees je in dit gesprek.`);
  }

  async broadcast(t: ToolContext, a: any): Promise<ToolOutput> {
    const userId = t.thread.user_id;
    const room = this.s.roomForThread(t.thread);
    const l = this.s.limits(room, userId);
    const message = String(a.message ?? '').slice(0, 20_000);
    if (!message.trim()) return toolError('Het bericht is leeg.');
    const refs: any[] = Array.isArray(a.bots) ? a.bots : String(a.bots ?? '').split(',');
    const targets: Agent[] = [];
    const unknown: string[] = [];
    for (const ref of refs) {
      if (!String(ref).trim()) continue;
      const b = this.resolveBot(userId, ref, room);
      if (!b) unknown.push(String(ref));
      else if (b.id !== t.agent.id && !targets.some((x) => x.id === b.id)) targets.push(b);
    }
    if (unknown.length) return toolError(unknown.length === 1 ? `Onbekende bot: ${unknown[0]}. Beschikbaar: ${this.botList(userId, room, t.agent.id)}.` : `Onbekende bots: ${unknown.join(', ')}. Beschikbaar: ${this.botList(userId, room, t.agent.id)}.`);
    if (!targets.length) return toolError('Geen andere bots opgegeven.');
    if (l.maxBroadcastTargets > 0 && targets.length > l.maxBroadcastTargets) return toolError(`Te veel ontvangers (${targets.length}); maximaal ${l.maxBroadcastTargets} per broadcast.`);
    const chain = this.callerChain(t);
    const blocked: string[] = [];
    const ok: Agent[] = [];
    for (const b of targets) {
      const he = this.hopError(t, b, chain, room) || this.loopError(t, b, chain, message);
      if (he) blocked.push(`${b.name}: ${he}`);
      else ok.push(b);
    }
    if (!ok.length) return toolError(`Niemand kon worden aangesproken:\n${blocked.join('\n')}`);
    const followUp = a.follow_up !== false && a.follow_up !== 'false';
    const g = this.s.gate({ room, userId, agentId: ok[0].id, chain, needMember: false, extra: ok.length + (followUp ? 1 : 0) });
    if (g) return toolError(g);
    const groupId = newId('bc_');
    const inMain = !!room && t.thread.id === room.thread_id;
    let bmsg: Message | null = null;
    if (inMain) {
      bmsg = this.ctx.store.createMessage({
        thread_id: room!.thread_id,
        role: 'user',
        author_type: 'agent',
        author_id: t.agent.id,
        author_name: t.agent.name,
        content: message,
        parts: { kind: 'broadcast', broadcastId: groupId, targets: ok.map((b) => b.id) },
      });
      this.ctx.chat.emitMessage(t.thread, bmsg);
    }
    const lines: string[] = [];
    for (const b of ok) {
      if (inMain && this.s.botMember(room!, b.id)) {
        const path = [...chain.path, b.id];
        const { id } = this.open({ user_id: userId, room_id: room!.id, kind: 'broadcast', group_id: groupId, parent_thread_id: t.thread.id, parent_run_id: t.run.id, tool_call_id: t.toolCallId, thread_id: room!.thread_id, from_agent_id: t.agent.id, to_agent_id: b.id, task: message, chain_id: chain.chainId, path, follow_up: followUp });
        const r = this.s.dispatch(room!, t.thread, b.id, { inputMessageId: bmsg!.id, meta: { chainId: chain.chainId, path, handoffs: chain.handoffs, kind: 'broadcast', requestedBy: chain.requestedBy ?? null, delegationId: id }, silent: true });
        if (r.run) {
          this.turn(id, r.run);
          this.emit(this.get(id)!);
          lines.push(`- ${b.name}: gestart in de groep`);
        } else {
          this.close(id, 'cancelled', { error: r.refused });
          lines.push(`- ${b.name}: niet gestart (${r.refused})`);
        }
      } else {
        const { d, sub } = this.spawn(t, b, { kind: 'broadcast', task: message, expected: '', groupId, wait: false, followUp, chain, room });
        lines.push(`- ${b.name}: gestart in subgesprek #/t/${sub.id} (id ${d.id})`);
      }
    }
    this.s.activity(room?.id, { type: 'agent', id: t.agent.id }, 'broadcast', `Broadcast aan ${ok.map((b) => b.name).join(', ')}: ${oneLine(message).slice(0, 160)}`, { groupId });
    this.ctx.audit(userId, 'team.broadcast', { from: t.agent.name, to: ok.map((b) => b.name), groupId }, t.agent.id);
    if (!this.ctx.store.find<Delegation>('room_delegations', { group_id: groupId }).some((d) => !TERMINAL_DELEGATION.has(d.status))) this.groupDone(groupId);
    return {
      text: `Broadcast verstuurd (id ${groupId}); elke bot werkt als aparte, gevolgde beurt:\n${lines.join('\n')}${blocked.length ? `\nNiet verstuurd:\n${blocked.join('\n')}` : ''}\n${followUp ? 'Je krijgt een vervolgbeurt zodra iedereen klaar is.' : ''}`,
      data: { broadcastId: groupId },
    };
  }

  async handoff(t: ToolContext, a: any): Promise<ToolOutput> {
    const userId = t.thread.user_id;
    const room = this.s.roomForThread(t.thread);
    const target = this.resolveBot(userId, a.bot, room);
    if (!target) return toolError(`Onbekende bot: ${a.bot}. Beschikbaar: ${this.botList(userId, room, t.agent.id)}.`);
    if (target.id === t.agent.id) return toolError('Je kunt niet aan jezelf overdragen.');
    const te = this.teamError(t.agent.id, target.id);
    if (te) return toolError(te);
    const chain = this.callerChain(t);
    const l = this.s.limits(room, userId);
    if (l.maxHandoffs < 0) return toolError('Werk overdragen staat uit (ingesteld door de eigenaar).');
    if (l.maxHandoffs > 0 && chain.handoffs >= l.maxHandoffs) return toolError(`Maximum van ${l.maxHandoffs} overdrachten voor dit bericht bereikt. Rond het zelf af of vraag een mens.`);
    if (chain.path.includes(target.id)) return toolError(`Geweigerd om een lus te voorkomen: ${target.name} heeft dit werk al gehad in deze keten (${this.names(chain.path)}).`);
    const reason = String(a.reason ?? '').slice(0, 2000);
    const meta: TeamMeta = { chainId: chain.chainId, path: [...chain.path, target.id], handoffs: chain.handoffs + 1, kind: 'handoff', requestedBy: chain.requestedBy ?? null };
    const note = `${t.agent.name} draagt het werk over aan ${target.name}.${reason ? ` Reden: ${reason}` : ''}`;
    // The owner sees the same, with the reason as the bot wrote it.
    const words: Words = reason ? { text: '{0} draagt het werk over aan {1}. Reden: {2}', values: [t.agent.name, target.name, reason] } : { text: '{0} draagt het werk over aan {1}.', values: [t.agent.name, target.name] };
    if (room && t.thread.id === room.thread_id) {
      const m = this.s.botMember(room, target.id);
      if (!m) return toolError(`${target.name} is geen lid van deze groep. Gebruik delegate_task om een bot buiten de groep een afgebakende subtaak te geven.`);
      if (m.paused) return toolError(`${target.name} is gepauzeerd in deze groep.`);
      const g = this.s.gate({ room, userId, agentId: target.id, chain, needMember: true });
      if (g) return toolError(g);
      this.ctx.store.update('rooms', room.id, { owner_agent_id: target.id, updated_at: now() });
      const sys = this.s.systemMessage(t.thread, note, { kind: 'handoff', from: t.agent.id, to: target.id, note: words });
      const r = this.s.dispatch(this.s.room(room.id)!, t.thread, target.id, { inputMessageId: sys.id, meta });
      if (!r.run) return toolError(r.refused || 'Overdracht mislukt');
      this.s.emitChanged(room);
    } else {
      const g = this.s.gate({ room, userId, agentId: target.id, chain, needMember: false });
      if (g) return toolError(g);
      const th = this.ctx.store.updateThread(t.thread.id, { agent_id: target.id });
      this.ctx.chat.emit(th, 'thread.updated', th);
      const sys = this.s.systemMessage(th, note, { kind: 'handoff', from: t.agent.id, to: target.id, note: words });
      const did = t.thread.kind === 'delegation' ? (t.run.meta?.team?.delegationId as string | undefined) || th.meta?.delegation?.id : undefined;
      const run = this.ctx.runs.enqueue({ threadId: th.id, agentId: target.id, userId, trigger: 'team:handoff', inputMessageId: sys.id, meta: { team: { ...meta, roomId: room?.id ?? null, delegationId: did } } });
      if (did) this.turn(did, run, { to: target.id });
    }
    this.s.activity(room?.id, { type: 'agent', id: t.agent.id }, 'handoff', note, { to: target.id });
    this.ctx.audit(userId, 'team.handoff', { from: t.agent.name, to: target.name, reason: reason.slice(0, 300) }, t.agent.id);
    return { text: `Overgedragen aan ${target.name}. Rond je beurt nu kort af; ${target.name} neemt het over en is de nieuwe taakeigenaar.`, data: { to: target.id } };
  }

  status(t: ToolContext, a: any): ToolOutput {
    const list = a?.id ? [this.get(String(a.id))].filter((d): d is Delegation => !!d && d.user_id === t.thread.user_id) : this.forThread(t.thread.id).filter((d) => d.from_agent_id === t.agent.id).slice(0, 20);
    if (!list.length) return { text: 'Geen gedelegeerde taken gevonden.' };
    return {
      text: list
        .map((d) => `- ${d.id} · ${this.s.agentName(d.to_agent_id)} · ${DELEGATION_LABEL[d.status]} · ${oneLine(d.task).slice(0, 80)}${d.status === 'done' ? `\n  Resultaat: ${oneLine(d.result || '').slice(0, 400)}` : d.error ? `\n  ${d.error}` : ''}`)
        .join('\n'),
    };
  }

  // ------------------------------------------------------------------ completion

  markRunning(id: string, run: Run) {
    const d = this.get(id);
    if (!d || d.run_id !== run.id || d.status !== 'queued') return;
    this.turn(id, null, { status: 'running' });
    this.emit(this.get(id)!);
  }

  /**
   * The one way back: a turn ended. What that bot gave away in it stops with it when it was stopped; and when the
   * turn worked on a record, the record is closed with what the turn gave and the outcome goes to the giver.
   */
  async onRunTerminal(run: Run, thread: Thread, _room: Room | null) {
    // Interrupted only to take a steering message (agent/queue.ts): its work goes on in the next turn.
    if (run.status === 'cancelled' && !run.meta?.steerInterrupt) {
      // Stopping a bot also stops the subtasks it is waiting for or that it started in this turn. Stopped by the owner:
      // they end as stopped by the owner too, so the bot finds a note of each (it is not woken; see flush).
      const byOwner = stoppedByOwner(run) ? String(run.error) : '';
      for (const c of this.ctx.store.all<any>("SELECT * FROM room_delegations WHERE parent_run_id = ? AND status IN ('queued','running')", run.id)) {
        const cd = this.ctx.store.decode<Delegation>('room_delegations', c);
        // Bot messages it sent in this turn are withdrawn; it is not woken for them.
        if (cd.kind === 'ask') this.cancel(cd, byOwner || 'Ingetrokken: de afzender werd gestopt', { wake: !!byOwner });
        else if (cd.run_id) this.stop(cd, byOwner || 'Gestopt: de opdrachtgever werd gestopt', { quiet: !byOwner });
      }
    }
    const d = this.recordOf(run, thread);
    if (d) await this.settle(d, run);
  }

  /**
   * The record a turn worked on: the one it was started for, or the record of the subtask conversation it ran in. The
   * second is a turn that was not started for the record: after the work failed or was stopped, the owner pressed
   * "Opnieuw proberen" or "Hervatten" there or wrote there, or a reserve engine took over. When that turn finishes the
   * work after all, the record lives again and ends like any other.
   */
  private recordOf(run: Run, thread: Thread): Delegation | null {
    const did = run.meta?.team?.delegationId as string | undefined;
    if (did) {
      const d = this.get(did);
      return d && d.run_id === run.id && !TERMINAL_DELEGATION.has(d.status) ? d : null;
    }
    if (run.status !== 'done' || thread.kind !== 'delegation' || thread.meta?.dm) return null;
    const d = this.get(thread.meta?.delegation?.id);
    if (!d || d.thread_id !== thread.id || d.to_agent_id !== run.agent_id || (d.status !== 'error' && d.status !== 'timeout' && !stoppedByOwner(d))) return null;
    if (!this.finalText(run, thread.id)) return null;
    this.turn(d.id, run, { again: true });
    return this.get(d.id);
  }

  /**
   * Close a record with what its turn gave and bring the outcome to the giver. The same rule when the turn ends and
   * when TeamBot starts again and finds the turn ended (reconcile; `deliver` false there: it brings everything at once).
   */
  private async settle(d: Delegation, run: Run, deliver = true) {
    // Results flow back up the same chain: a bot that passed (part of) its subtask on is not done yet. Its result goes
    // back once the answers it waits for are in and its follow-up turn has ended (followUp ties that turn to it).
    if (run.status === 'done' && d.kind === 'delegate') {
      const open = this.openChildren(d);
      if (open.length) return this.hold(d, open);
    }
    // A delegated job that comes back "done" gets the second look first (quality module): fresh context, the expected
    // output as "klaar als", the steps of its run as evidence. The verdict travels with the result.
    const q = this.ctx.services.quality;
    if (d.kind === 'delegate' && run.status === 'done' && !run.meta?.loopStop && q?.checkDelegation) {
      try {
        await q.checkDelegation({ userId: d.user_id, delegationId: d.id, worker: this.ctx.store.agent(d.to_agent_id), task: d.task, expected: d.expected, result: this.finalText(run, d.thread_id), runId: run.id });
      } catch (e: any) {
        this.ctx.log.warn('[rooms] delegation check', e?.message || e);
      }
      const cur = this.get(d.id);
      if (!cur || cur.run_id !== run.id || TERMINAL_DELEGATION.has(cur.status)) return;
    }
    this.finalize(d, run, deliver);
  }

  /** The second look on a delegated job (quality module), for the result text and the cards; null = none. */
  check(d: Delegation): { state: string; label: string; reason: string } | null {
    if (d.kind !== 'delegate') return null;
    const v = this.ctx.services.quality?.view?.(d.user_id, 'delegation', d.id);
    return v && v.check.state !== 'none' ? { state: v.check.state, label: v.check.label, reason: v.check.reason } : null;
  }

  /** "klaar", or what the second look said instead ("te controleren", "kon het niet"). */
  private statusWord(d: Delegation): string {
    const c = d.status === 'done' ? this.check(d) : null;
    return c?.state === 'review' ? 'te controleren' : c?.state === 'cant' ? 'kon het niet' : DELEGATION_LABEL[d.status] || d.status;
  }

  private checkLine(d: Delegation): string {
    const c = this.check(d);
    if (!c) return '';
    if (c.state === 'review') return `\n\nControle met een frisse blik: TE CONTROLEREN — ${c.reason}\nNeem dit niet over als klaar: laat het verbeteren, doe het zelf, of zeg eerlijk wat er nog niet klopt.`;
    if (c.state === 'cant') return `\n\n${this.s.agentName(d.to_agent_id)} kon het niet: ${c.reason}`;
    if (c.state === 'passed') return `\n\nControle met een frisse blik: klaar — ${c.reason}`;
    return '';
  }

  // ------------------------------------------------------------------ chains: results back up, trail, stopping

  /** "Keten: A → B → C" for a task that was passed on more than once, and a note when it cannot be passed on further. */
  private trail(path: string[], room: Room | null, userId: string): string {
    const max = this.s.limits(room, userId).maxDelegationDepth;
    const out: string[] = [];
    if (path.length > 2) out.push(`Keten: ${this.names(path)}.`);
    if (max > 0 && path.length > max) out.push(`Dit werk is al ${max === 1 ? '1 keer' : `${max} keer`} doorgegeven, het maximum: je kunt het niet verder doorgeven. Doe het zelf.`);
    return out.length ? `\n\n${out.join(' ')}` : '';
  }

  /** Answers a delegated bot still waits for: requests it sent from its subtask conversation in the same chain. */
  openChildren(d: Delegation): Delegation[] {
    return this.ctx.store
      .all<any>('SELECT * FROM room_delegations WHERE parent_thread_id = ? AND from_agent_id = ? AND chain_id IS ? AND follow_up = 1 AND delivered = 0 AND id != ?', d.thread_id, d.to_agent_id, d.chain_id, d.id)
      .map((r) => this.ctx.store.decode<Delegation>('room_delegations', r));
  }

  /** A delegated subtask whose bot ended its turn but still waits for answers of bots it passed the work on to. */
  waiting(d: Delegation): boolean {
    if (d.kind !== 'delegate' || TERMINAL_DELEGATION.has(d.status) || !d.run_id) return false;
    const r = this.ctx.store.run(d.run_id);
    return (!r || TERMINAL_RUN.has(r.status)) && this.openChildren(d).length > 0;
  }

  /** The waiting subtask of `agentId` in this subtask conversation and chain (its follow-up turn finishes it). */
  private waitingParent(threadId: string, agentId: string, chainId: string | null): Delegation | null {
    const row = this.ctx.store.one<any>("SELECT * FROM room_delegations WHERE thread_id = ? AND to_agent_id = ? AND chain_id IS ? AND kind = 'delegate' AND status IN ('queued','running') ORDER BY created_at DESC LIMIT 1", threadId, agentId, chainId);
    if (!row) return null;
    const d = this.ctx.store.decode<Delegation>('room_delegations', row);
    const r = d.run_id ? this.ctx.store.run(d.run_id) : null;
    return !r || TERMINAL_RUN.has(r.status) ? d : null;
  }

  private hold(d: Delegation, open: Delegation[]) {
    const who = [...new Set(open.map((c) => this.s.agentName(c.to_agent_id)))].join(', ');
    this.turn(d.id, null, { status: 'running' });
    const sub = this.ctx.store.thread(d.thread_id);
    if (sub) this.s.event(sub, `${this.s.agentName(d.to_agent_id)} wacht op ${who}; daarna gaat het resultaat terug naar ${this.s.agentName(d.from_agent_id)}.`, { kind: 'delegation_waiting', delegationId: d.id });
    this.emit(this.get(d.id)!);
  }

  /**
   * Stop a subtask: its running turn, or, when it waits for bots it passed the work on to, those requests (nobody is
   * woken for them) and then the subtask itself. `quiet`: the sender is not woken either (it was stopped itself).
   */
  stop(d: Delegation, reason: string, o: { quiet?: boolean } = {}) {
    const r = d.run_id ? this.ctx.store.run(d.run_id) : null;
    if (r && !TERMINAL_RUN.has(r.status)) return void this.ctx.runs.cancel(r.id, reason);
    if (!this.waiting(d)) return;
    for (const c of this.openChildren(d)) {
      this.told(c.id);
      if (TERMINAL_DELEGATION.has(c.status)) continue;
      const fresh = this.get(c.id)!;
      if (fresh.kind === 'ask') this.cancel(fresh, reason);
      else this.stop(fresh, reason, { quiet: true });
    }
    if (o.quiet) this.told(d.id);
    this.closeWaiting(this.get(d.id)!, reason, 'cancelled');
  }

  /** Close a waiting subtask without a new turn (stopped, or its follow-up turn could not start) and report upwards. */
  private closeWaiting(d: Delegation, reason: string, status: 'error' | 'cancelled' = 'error') {
    const last = d.run_id ? this.ctx.store.run(d.run_id) : null;
    const text = last ? this.finalText(last, d.thread_id) : '';
    const fresh = this.close(d.id, status, { result: text || null, error: reason });
    this.s.activity(d.room_id, { type: 'agent', id: d.to_agent_id }, 'delegation.done', `Subtaak voor ${this.s.agentName(d.from_agent_id)}: ${DELEGATION_LABEL[status]}`, { delegationId: d.id, status });
    const sub = this.ctx.store.thread(d.thread_id);
    if (sub) this.s.event(sub, `Status teruggestuurd naar ${this.s.agentName(d.from_agent_id)} (${DELEGATION_LABEL[status]}): ${reason}`, { kind: 'delegation_returned', delegationId: d.id });
    this.handBack(fresh);
  }

  /** A closed record goes to whoever waits inside its turn for it; otherwise the normal way back (deliver). */
  private handBack(d: Delegation) {
    const w = this.waiters.get(d.id);
    if (w) {
      this.told(d.id);
      return w();
    }
    if (d.group_id) return this.groupDone(d.group_id, d);
    if (!d.delivered) this.deliver(d);
  }

  /**
   * The worker's final answer of a run. An API engine writes one message per step, so the last one with text is the
   * answer. A CLI engine writes one message for the whole turn, with everything it said between its steps; there the
   * answer is the text after its last step (parts.answer, agent/cli-loop.ts).
   */
  finalText(run: Run, threadId: string): string {
    const m = this.ctx.store.one<{ content: string; answer: string | null }>(
      "SELECT content, json_extract(parts, '$.answer') AS answer FROM messages WHERE run_id = ? AND thread_id = ? AND role = 'assistant' AND deleted = 0 AND content != '' ORDER BY seq DESC LIMIT 1",
      run.id,
      threadId,
    );
    return (typeof m?.answer === 'string' && m.answer.trim()) || m?.content || '';
  }

  private finalize(d: Delegation, run: Run, deliver: boolean) {
    const timedOut = this.s.timedOut.has(run.id) || /^Time-out/.test(run.error || '');
    // A run the loop guard stopped (agent/loops.ts) did not finish the job: an honest "niet gelukt", with what it tried.
    const loop = run.status === 'done' ? (run.meta?.loopStop as { text?: string } | undefined) : undefined;
    const status: Delegation['status'] = loop ? 'error' : run.status === 'done' ? 'done' : run.status === 'cancelled' ? (timedOut ? 'timeout' : 'cancelled') : 'error';
    const text = this.finalText(run, d.thread_id);
    const result = status === 'done' ? text || '(geen tekstueel resultaat)' : text || null;
    const error = status === 'done' ? null : loop ? `gestopt omdat het steeds hetzelfde deed zonder vooruitgang (${loop.text || 'lus'})` : run.error || DELEGATION_LABEL[status];
    const fresh = this.close(d.id, status, { result, error });
    this.s.activity(d.room_id, { type: 'agent', id: d.to_agent_id }, 'delegation.done', `${d.kind === 'message' || d.kind === 'ask' ? 'Antwoord' : 'Subtaak'} voor ${this.s.agentName(d.from_agent_id)}: ${DELEGATION_LABEL[status]}`, { delegationId: d.id, status });
    if (fresh.thread_id !== fresh.parent_thread_id) {
      const sub = this.ctx.store.thread(fresh.thread_id);
      const from = this.s.agentName(fresh.from_agent_id);
      const note =
        d.kind === 'ask'
          ? fresh.follow_up
            ? fresh.delivered && status !== 'done'
              ? `Vraag van ${from} ${DELEGATION_LABEL[status]}; ${from} wordt er niet voor gewekt.`
              : `${status === 'done' ? 'Antwoord' : 'Status'} teruggestuurd naar ${from} (${DELEGATION_LABEL[status]}).`
            : fresh.delivered
              ? `Melding van ${from}: ${DELEGATION_LABEL[status]}.`
              : `Melding van ${from} afgehandeld (${DELEGATION_LABEL[status]}); ${from} ${status === 'done' ? 'krijgt er een notitie van' : 'hoort dat het niet lukte'}.`
          : `${DELEGATION_LABEL[status] === 'klaar' ? 'Resultaat' : 'Status'} teruggestuurd naar ${from} (${DELEGATION_LABEL[status]}).`;
      if (sub) this.s.event(sub, note, { kind: 'delegation_returned', delegationId: d.id });
    }
    if (deliver) this.handBack(fresh);
  }

  /**
   * The outcome always goes back to the bot that asked: a system note in the parent thread plus a follow-up turn for
   * it, on success and on failure (error, time-out), with the reason. While that bot is still busy in the parent
   * conversation the result is held (it never lands in the middle of a running turn) and delivered, bundled with other
   * results, as soon as it is free (see flush/onIdle). A bot message sent as "only tell" (reply=false) that went well
   * is a note without a turn; one that failed wakes its sender.
   *
   * One exception: work the owner stopped by hand (stoppedByOwner). After his stop nothing starts by itself, so that
   * outcome is a note without a turn. The note only states facts: what was stopped, that it is not finished, that it
   * is still the colleague's and with which tool it is given again. What the bot does with that is up to the bot and
   * its owner's instructions. It reads the note at its next turn, whatever starts that turn.
   */
  private deliver(d: Delegation) {
    if (this.busy(d.parent_thread_id, d.from_agent_id)) return;
    this.flush(d.parent_thread_id, d.from_agent_id, stoppedByOwner(d));
  }

  /** The note for work the owner stopped: facts in TeamBot's own words (nothing the stopped bot wrote is in it). */
  private stoppedNote(d: Delegation): { text: string; parts: Record<string, any> } {
    const who = this.s.agentName(d.to_agent_id);
    const t = d.task_id ? this.ctx.store.get<Task>('room_tasks', d.task_id) : null;
    const what = `“${oneLine(d.task).slice(0, 200)}”`;
    // The giver's own turn was stopped too, maybe with the call still going: its own memory of that turn may say the
    // call never came through, so the note says it did (a waiting bot message that never reached its recipient: not).
    const own = d.parent_run_id && d.run_id && stoppedByOwner(this.ctx.store.run(d.parent_run_id));
    const given = own ? (t || d.kind === 'delegate' ? ' Het doorgeven was gelukt voordat de eigenaar ook jouw beurt stopte.' : ' Het was aangekomen voordat de eigenaar ook jouw beurt stopte.') : '';
    const text = t
      ? `Gestopt door de eigenaar: de taak “${t.title}” die je aan ${who} gaf.${given} De taak is niet af, staat op ${TASK_LABEL[t.status] || t.status} en blijft van ${who}. Opnieuw starten kan met task_update (id ${t.id}, owner ${who}).`
      : d.kind === 'delegate'
        ? `Gestopt door de eigenaar: het werk dat je aan ${who} gaf (${what}).${given} Het is niet af en blijft van ${who}. Opnieuw geven kan met delegate_task.`
        : `Gestopt door de eigenaar: je bericht aan ${who} (${what}).${given} Er komt geen antwoord op. Opnieuw sturen kan.`;
    // The owner sees what happened, plainly; how to give it again is for the bot.
    const giver = this.s.agentName(d.from_agent_id);
    const task = oneLine(d.task).slice(0, 200);
    const note: Words = t
      ? { text: 'Gestopt: de taak “{0}” die {1} aan {2} gaf. Hij is niet af.', values: [t.title, giver, who] }
      : d.kind === 'delegate'
        ? { text: 'Gestopt: het werk dat {0} aan {1} gaf (“{2}”). Het is niet af.', values: [giver, who, task] }
        : { text: 'Gestopt: het bericht van {0} aan {1} (“{2}”). Er komt geen antwoord op.', values: [giver, who, task] };
    return { text, parts: { kind: 'delegation_cancelled', delegationId: d.id, status: d.status, threadId: d.thread_id, from: d.to_agent_id, ...(d.task_id ? { taskId: d.task_id } : {}), note } };
  }

  /** Work given in this turn that reached the colleague and that the owner stopped (cli-agents/context.ts asks). */
  stoppedGiven(runId: string): number {
    return this.ctx.store
      .all<any>("SELECT status, error FROM room_delegations WHERE parent_run_id = ? AND run_id IS NOT NULL AND status = 'cancelled'", runId)
      .filter((d) => stoppedByOwner(d)).length;
  }

  /** Where the task stands that a bot message was about (a task that started its owner by being assigned). */
  private taskNote(d: Delegation): string {
    const t = d.task_id ? this.ctx.store.get<Task>('room_tasks', d.task_id) : null;
    if (!t) return '';
    const open = t.status === 'todo' || t.status === 'doing';
    return `\n\nDe taak “${t.title}” staat nu op: ${TASK_LABEL[t.status] || t.status}.${open ? ` Hij is dus nog niet af: volg hem op bij ${this.s.agentName(d.to_agent_id)}, of geef hem aan een andere bot.` : ''}`;
  }

  private resultNote(d: Delegation): { text: string; parts: Record<string, any> } {
    const who = this.s.agentName(d.to_agent_id);
    const body = d.status === 'done' ? `${cap(d.result, 12_000)}${this.checkLine(d)}` : `Niet gelukt: ${d.error || DELEGATION_LABEL[d.status]}${d.result ? `\n\nLaatste tekst:\n${cap(d.result, 2000)}` : ''}`;
    const head = d.task_id
      ? d.status === 'done'
        ? `${who} meldt over de taak die je gaf`
        : `${who} kon de taak die je gaf niet doen (${DELEGATION_LABEL[d.status]})`
      : d.kind === 'ask'
        ? d.status === 'done'
          ? d.follow_up
            ? `${who} antwoordde op je bericht`
            : `${who} heeft je melding afgehandeld`
          : `${who} kon je bericht niet ${d.follow_up ? 'beantwoorden' : 'afhandelen'} (${DELEGATION_LABEL[d.status]})`
        : `${d.kind === 'message' ? 'Antwoord' : 'Resultaat van de gedelegeerde taak'} van ${who} (${this.statusWord(d)})`;
    return { text: `${head}:\n\n${body}${this.taskNote(d)}`, parts: { kind: 'delegation_result', delegationId: d.id, status: d.status, threadId: d.thread_id, from: d.to_agent_id, ...(d.task_id ? { taskId: d.task_id } : {}), ...this.resultView(d) } };
  }

  /**
   * What the owner sees of a result note; the bot reads the note's text, with what to do next. One plain line in
   * TeamBot's words with the names in it, the colleague's own answer (shown as its message), and what the second look
   * said. The chat shows the line in the owner's language and the colleague's words as written (shell/SystemNote.tsx).
   */
  private resultView(d: Delegation): { note: Words; said?: string; cut?: boolean; reason?: string; check?: { state: string; reason: string } } {
    const who = this.s.agentName(d.to_agent_id);
    const t = d.task_id ? this.ctx.store.get<Task>('room_tasks', d.task_id) : null;
    const done = d.status === 'done';
    const note: Words = t
      ? { text: done ? '{0} meldt over de taak “{1}”' : '{0} kon de taak “{1}” niet doen', values: [who, t.title] }
      : d.kind === 'ask' && !d.follow_up
        ? { text: done ? '{0} heeft de melding afgehandeld' : '{0} kon de melding niet afhandelen', values: [who] }
        : d.kind === 'delegate'
          ? { text: done ? 'Resultaat van {0}' : '{0} kon het werk niet afmaken', values: [who] }
          : { text: done ? 'Antwoord van {0}' : '{0} kon het bericht niet beantwoorden', values: [who] };
    const said = (d.result || '').trim();
    const max = done ? 12_000 : 2000;
    const c = done ? this.check(d) : null;
    return {
      note,
      ...(said ? { said: said.slice(0, max), ...(said.length > max ? { cut: true } : {}) } : {}),
      ...(!done ? { reason: d.error || DELEGATION_LABEL[d.status] || d.status } : {}),
      ...(c && c.state !== 'none' ? { check: { state: c.state, reason: c.reason } } : {}),
    };
  }

  /** Nothing can be delivered to this bot in this conversation right now (a paused group or bot): it stays waiting. */
  private heldBack(parent: Thread, agentId: string): boolean {
    const room = this.s.roomForThread(parent);
    if (!room) return false;
    if (room.status === 'paused' || room.archived) return true;
    return !!this.s.botMember(room, agentId)?.paused;
  }

  /**
   * The way back to the giver, for every kind of request: every closed record it was not told about yet, in one
   * conversation: one note per outcome (or broadcast) and a single follow-up turn for all of them. A giver that is busy
   * there gets them bundled when its turn ends (onIdle). Returns true when a follow-up turn was started.
   * Work the owner stopped is a note and never a reason for a turn. `quiet`: a stop of the owner brought us here, or
   * he stopped this bot itself and it had no turn since (RunManager.ownerStopped). Then only what he stopped is told
   * now; real results stay waiting until the bot's next turn has ended, also across a restart (flushPending).
   */
  flush(parentThreadId: string, fromAgentId: string, quiet = false): boolean {
    if (this.busy(parentThreadId, fromAgentId)) return false;
    quiet ||= this.ctx.runs.ownerStopped(fromAgentId) !== null;
    const parent = this.ctx.store.thread(parentThreadId);
    if (!parent) return false;
    // A paused group (or bot): the results wait and are delivered when it is resumed (flushPending).
    if (this.heldBack(parent, fromAgentId)) return false;
    const done = [...TERMINAL_DELEGATION].map((s) => `'${s}'`).join(',');
    const singles = this.ctx.store
      .all<any>(`SELECT * FROM room_delegations WHERE parent_thread_id = ? AND from_agent_id = ? AND group_id IS NULL AND (follow_up = 1 OR kind = 'ask') AND delivered = 0 AND status IN (${done}) ORDER BY finished_at, created_at`, parentThreadId, fromAgentId)
      .map((r) => this.ctx.store.decode<Delegation>('room_delegations', r));
    const groups = this.ctx.store.all<{ group_id: string }>('SELECT DISTINCT group_id FROM room_delegations WHERE parent_thread_id = ? AND from_agent_id = ? AND group_id IS NOT NULL AND delivered = 0', parentThreadId, fromAgentId).map((r) => r.group_id);
    const asker = this.ctx.store.agent(fromAgentId);
    const gone = !asker || asker.archived;
    let first: { d: Delegation; input: string; async: boolean } | null = null;
    let stopped: Delegation | null = null;
    for (const d of singles) {
      const byOwner = stoppedByOwner(d);
      if (quiet && !byOwner) continue;
      this.told(d.id);
      if (gone) continue;
      const n = byOwner ? this.stoppedNote(d) : this.resultNote(d);
      const sys = this.s.systemMessage(parent, n.text, n.parts);
      // Stopped by the owner: the note is enough, nothing starts because of his stop.
      if (byOwner) {
        stopped = d;
        continue;
      }
      // "Only tell" that went well: the note is enough. Anything that failed wakes the sender.
      if (!d.follow_up && d.status === 'done') continue;
      if (!first) first = { d, input: sys.id, async: d.kind === 'ask' };
      else if (d.kind === 'ask') first.async = true;
    }
    for (const gid of groups) {
      const rows = this.ctx.store.find<Delegation>('room_delegations', { group_id: gid }, { order: 'created_at' });
      if (!rows.length || rows.some((r) => !TERMINAL_DELEGATION.has(r.status)) || rows.some((r) => r.delivered)) continue;
      // A broadcast is complete when its last answer is in. Was that last one a stop by the owner, then his stop
      // completed it: a note, no turn.
      const last = rows.reduce((a, b) => ((b.finished_at || '') > (a.finished_at || '') ? b : a));
      const byOwner = stoppedByOwner(last);
      if (quiet && !byOwner) continue;
      for (const r of rows) this.told(r.id);
      if (!rows[0].follow_up || gone) continue;
      const lines = rows.map((r) => `- ${this.s.agentName(r.to_agent_id)}: ${stoppedByOwner(r) ? 'gestopt door de eigenaar' : `${DELEGATION_LABEL[r.status]}${r.status === 'done' ? ` — ${cap(oneLine(r.result || ''), 1500)}` : r.error ? ` — ${r.error}` : ''}`}`);
      const head = byOwner ? 'Gestopt door de eigenaar: je broadcast, voordat iedereen klaar was.' : 'Alle antwoorden op je broadcast zijn binnen:';
      // The owner: one plain line, and every answer as the bot wrote it (shell/SystemNote.tsx).
      const giver = this.s.agentName(fromAgentId);
      const note: Words = byOwner ? { text: 'Gestopt: het bericht van {0} aan meerdere bots, voordat iedereen klaar was.', values: [giver] } : { text: 'Alle bots hebben geantwoord op het bericht van {0}', values: [giver] };
      const answers = rows.map((r) => ({ from: r.to_agent_id, status: stoppedByOwner(r) ? 'stopped' : r.status, ...(r.status === 'done' && r.result?.trim() ? { said: r.result.trim().slice(0, 1500) } : {}), ...(r.status !== 'done' && r.error && !stoppedByOwner(r) ? { reason: r.error } : {}) }));
      const sys = this.s.systemMessage(parent, `${head}\n${lines.join('\n')}`, { kind: 'broadcast_result', broadcastId: gid, note, answers });
      if (byOwner) stopped = stopped || last;
      else if (!first) first = { d: rows[0], input: sys.id, async: false };
    }
    if (!first) {
      // A subtask that waited only for what the owner stopped is stopped with it, so the stop goes up the chain.
      const up = stopped ? this.waitingParent(parent.id, fromAgentId, stopped.chain_id) : null;
      if (up && !this.openChildren(up).length) this.closeWaiting(up, stopped!.error || DELEGATION_LABEL.cancelled, 'cancelled');
      return false;
    }
    this.followUp(parent, first.d, first.input, first.async);
    return true;
  }

  /**
   * Deliver everything that still waits for its sender, in every conversation (or only those of one group): after a
   * restart of TeamBot, and when a paused group or bot is resumed. Nothing a bot finished for another bot is lost.
   */
  flushPending(roomId?: string): number {
    const done = [...TERMINAL_DELEGATION].map((s) => `'${s}'`).join(',');
    const rows = this.ctx.store.all<{ parent_thread_id: string; from_agent_id: string }>(
      `SELECT DISTINCT parent_thread_id, from_agent_id FROM room_delegations WHERE delivered = 0 AND status IN (${done}) AND (follow_up = 1 OR kind = 'ask')${roomId ? ' AND room_id = ?' : ''}`,
      ...(roomId ? [roomId] : []),
    );
    let n = 0;
    for (const r of rows) {
      try {
        if (this.flush(r.parent_thread_id, r.from_agent_id)) n++;
      } catch (e) {
        this.ctx.log.error('[rooms] flush pending', e);
      }
    }
    return n;
  }

  /**
   * A result for a bot without a request of its own behind it: a task on the board that bot created was finished (or
   * given up) by another bot. Delivered like every other result: a note and a follow-up turn where the task was made.
   */
  report(o: { userId: string; roomId: string | null; fromAgentId: string; toAgentId: string; parentThreadId: string; threadId: string; taskId: string; task: string; ok: boolean; text: string }): boolean {
    const parent = this.ctx.store.thread(o.parentThreadId);
    const from = this.ctx.store.agent(o.fromAgentId);
    if (!parent || parent.user_id !== o.userId || !from || from.archived || from.user_id !== o.userId) return false;
    // (Born closed: the work was not asked for through a request, only its outcome goes back.)
    const d = this.open({ user_id: o.userId, room_id: o.roomId, kind: 'ask', parent_thread_id: parent.id, thread_id: o.threadId, from_agent_id: o.fromAgentId, to_agent_id: o.toAgentId, task: o.task, status: o.ok ? 'done' : 'error', result: o.ok ? o.text : null, error: o.ok ? null : o.text, chain_id: `${o.taskId}:${newId('c_')}`, path: [o.fromAgentId, o.toAgentId], task_id: o.taskId, finished_at: now() });
    this.emit(d);
    this.deliver(d);
    return true;
  }

  /**
   * This task was given to this bot by a colleague, and that hand-over is still going: its turn runs or waits, or its
   * outcome still waits for the bot that gave it. The start of the task is the hand-over's, once; the work loop leaves
   * the task alone until the giver has the outcome (routines/duties/work.ts).
   */
  handedOver(taskId: string, toAgentId: string): boolean {
    return !!this.ctx.store.one('SELECT id FROM room_delegations WHERE task_id = ? AND to_agent_id = ? AND delivered = 0 LIMIT 1', taskId, toAgentId);
  }

  /** A request about this task is still on its way back to the bot that gave it (its result will tell the outcome). */
  taskPending(taskId: string, fromAgentId: string): boolean {
    return !!this.ctx.store.one('SELECT id FROM room_delegations WHERE task_id = ? AND from_agent_id = ? AND delivered = 0 LIMIT 1', taskId, fromAgentId);
  }

  /** `by`: the answer that completed the broadcast (a stop by the owner completes it without waking anyone). */
  private groupDone(groupId: string, by?: Delegation) {
    const rows = this.ctx.store.find<Delegation>('room_delegations', { group_id: groupId }, { order: 'created_at' });
    if (!rows.length || rows.some((r) => !TERMINAL_DELEGATION.has(r.status)) || rows.some((r) => r.delivered)) return;
    if (!rows[0].follow_up) return rows.forEach((r) => this.told(r.id));
    this.deliver(by || rows[0]);
  }

  private followUp(parent: Thread, d: Delegation, inputId: string, async = false) {
    const room = this.s.roomForThread(parent);
    const prun = d.parent_run_id ? this.ctx.store.run(d.parent_run_id) : null;
    const pteam = prun?.meta?.team as TeamMeta | undefined;
    const path = d.path.slice(0, -1);
    const meta: TeamMeta = { chainId: d.chain_id || inputId, path: path.length ? path : [d.from_agent_id], handoffs: pteam?.handoffs ?? 0, kind: 'followup', requestedBy: pteam?.requestedBy ?? null };
    if (async || pteam?.async) meta.async = true;
    // The bot was working on a subtask that it passed on: this turn finishes that subtask, so its result goes up.
    const up = this.waitingParent(parent.id, d.from_agent_id, d.chain_id);
    if (up) meta.delegationId = up.id;
    const r = this.s.dispatch(room, parent, d.from_agent_id, { inputMessageId: inputId, meta });
    if (!up) return;
    if (r.run) this.turn(up.id, r.run);
    else this.closeWaiting(up, r.refused || 'De vervolgbeurt kon niet starten');
  }

  /** How often a subtask that a restart of TeamBot cut off is started again by itself. */
  static MAX_RESTARTS = 2;

  /**
   * TeamBot starts again: no turn ends to bring the open records forward, so each is looked at once, with the same
   * rule as at the end of a turn (settle). Nothing is lost: a turn the restart cut off goes on where it was (at most
   * MAX_RESTARTS times, then it is reported as failed), an outcome the giver was not told yet is brought to it, and
   * bot messages still in the mailbox are picked up. Whoever waited inside its turn is gone with the restart; its
   * outcome comes the normal way.
   */
  async reconcile() {
    for (const d of this.ctx.store.all<any>("SELECT * FROM room_delegations WHERE status IN ('queued','running')").map((r) => this.ctx.store.decode<Delegation>('room_delegations', r))) {
      try {
        const run = d.run_id ? this.ctx.store.run(d.run_id) : null;
        if (run && !TERMINAL_RUN.has(run.status)) continue;
        // A bot message that was still waiting for its recipient stays in the mailbox and is delivered when it is free.
        if (!run && d.kind === 'ask' && d.status === 'queued') continue;
        if (!run) {
          this.close(d.id, 'error', { error: 'De beurt van deze opdracht is na een herstart van TeamBot niet teruggevonden' });
          continue;
        }
        // Its turn ended well and it waits for bots it passed the work on to: it still waits.
        if (run.status === 'done' && d.kind === 'delegate' && this.openChildren(d).length) continue;
        // Cut off by a restart: a crash (interrupted) or a normal close of the app (cancelled with "Server gestopt").
        const cut = run.status === 'interrupted' || (run.status === 'cancelled' && /^Server gestopt/.test(run.error || ''));
        if (cut && this.resume(d, run)) continue;
        await this.settle(d, run, false);
      } catch (e) {
        this.ctx.log.error('[rooms] reconcile', e);
      }
    }
    try {
      // Every result that still waits for its sender (also broadcasts whose last answer came in right before the restart).
      this.flushPending();
      // Held bot messages whose recipient is free now (not a bot the owner stopped: those wait for its next turn).
      for (const r of this.ctx.store.all<{ thread_id: string; to_agent_id: string }>("SELECT DISTINCT thread_id, to_agent_id FROM room_delegations WHERE kind = 'ask' AND status = 'queued' AND run_id IS NULL"))
        if (this.ctx.runs.ownerStopped(r.to_agent_id) === null) this.pumpAsks(r.thread_id, r.to_agent_id);
    } catch (e) {
      this.ctx.log.error('[rooms] reconcile', e);
    }
  }

  /** Start the turn of an open subtask again after a restart cut it off. False: not possible (it is closed as failed). */
  private resume(d: Delegation, run: Run): boolean {
    const team = (run.meta?.team || {}) as TeamMeta & { restarts?: number };
    const restarts = team.restarts ?? 0;
    const sub = this.ctx.store.thread(d.thread_id);
    const worker = this.ctx.store.agent(d.to_agent_id);
    if (!sub || !worker || worker.archived || restarts >= Orchestrator.MAX_RESTARTS) return false;
    if (!this.ctx.store.thread(d.parent_thread_id)) return false;
    const room = this.s.room(d.room_id);
    if (room && (room.archived || room.status === 'paused')) return false;
    const from = this.s.agentName(d.from_agent_id);
    const sys = this.s.systemMessage(sub, `TeamBot is opnieuw gestart terwijl je aan deze opdracht van ${from} werkte. Ga verder waar je gebleven was. Controleer eerst wat al gedaan is en herhaal geen stappen die al gelukt zijn. Je antwoord gaat terug naar ${from}.`, { kind: 'delegation_resumed', delegationId: d.id, note: { text: 'TeamBot is opnieuw gestart: {0} gaat verder met de opdracht van {1}.', values: [this.s.agentName(d.to_agent_id), from] } });
    const next = this.ctx.runs.enqueue({ threadId: sub.id, agentId: worker.id, userId: d.user_id, trigger: `team:${d.kind}`, inputMessageId: sys.id, meta: { team: { ...team, restarts: restarts + 1 }, resumeOf: run.id } });
    this.turn(d.id, next, { status: 'queued' });
    this.emit(this.get(d.id)!);
    return true;
  }
}
