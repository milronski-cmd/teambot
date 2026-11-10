import type { Agent, Message, Run, Thread, ToolContext, ToolOutput } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { usdText } from '../../core/i18n.js';
import { nameKey } from './routing.js';
import { TERMINAL_DELEGATION, TERMINAL_RUN, type Delegation, type Room, type TeamMeta } from './types.js';
import type { RoomService } from './service.js';

export const DELEGATION_LABEL: Record<string, string> = { queued: 'in de wachtrij', running: 'bezig', done: 'klaar', error: 'fout', cancelled: 'gestopt', timeout: 'time-out' };

const err = (text: string): ToolOutput => ({ text, isError: true });
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
          : d.kind === 'ask' && d.status === 'done' && d.follow_up && !d.delivered
            ? 'antwoord klaar (wordt bezorgd)'
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
    if (l.maxDelegationDepth === 0) return 'Delegeren staat uit (maximale delegatiediepte is 0).';
    if (chain.path.length > l.maxDelegationDepth) return `Maximale delegatiediepte van ${l.maxDelegationDepth} bereikt (${this.names(chain.path)}). Werk het zelf af.`;
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

  /** Rate (per bot, per pair: ping-pong) and budget limits for asynchronous messages. */
  askLimitError(t: ToolContext, target: Agent, chain: TeamMeta, room: Room | null): string | null {
    const userId = t.thread.user_id;
    const l = this.s.limits(room, userId);
    const since = new Date(Date.now() - 3_600_000).toISOString();
    const mine = this.ctx.store.one<{ n: number }>("SELECT COUNT(*) n FROM room_delegations WHERE user_id = ? AND from_agent_id = ? AND kind = 'ask' AND created_at >= ?", userId, t.agent.id, since)?.n ?? 0;
    if (mine >= l.maxAsksPerHour) return `Limiet bereikt: ${t.agent.name} stuurde het afgelopen uur al ${mine} berichten aan andere bots (maximaal ${l.maxAsksPerHour} per uur). Rond het zelf af of probeer het later.`;
    const pair = this.ctx.store.one<{ n: number }>("SELECT COUNT(*) n FROM room_delegations WHERE user_id = ? AND from_agent_id = ? AND to_agent_id = ? AND kind = 'ask' AND created_at >= ?", userId, t.agent.id, target.id, since)?.n ?? 0;
    if (pair >= l.maxAsksPerPairPerHour) return `Geweigerd om heen-en-weer te voorkomen: ${t.agent.name} stuurde ${target.name} het afgelopen uur al ${pair} berichten (maximaal ${l.maxAsksPerPairPerHour}). Bundel je vragen of werk het zelf af.`;
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
  async ask(t: ToolContext, a: any): Promise<ToolOutput> {
    const userId = t.thread.user_id;
    const room = this.s.roomForThread(t.thread);
    const shared = !!room && this.s.humanMembers(room).some((h: any) => h.accepted);
    const target = this.resolveBot(userId, a.bot, room);
    if (!target) return err(`Onbekende bot: ${a.bot}. Bots die je kunt aanspreken: ${this.botList(userId, shared ? room : null, t.agent.id)}.`);
    const message = String(a.message ?? '').slice(0, 20_000);
    if (!message.trim()) return err('Het bericht is leeg.');
    const chain = this.callerChain(t);
    const he = this.hopError(t, target, chain, room);
    if (he) return err(he);
    const le = this.askLimitError(t, target, chain, room);
    if (le) return err(le);
    const l = this.s.limits(room, userId);
    const g = this.s.gate({ room, userId, agentId: target.id, chain, needMember: false, turnCap: Math.max(l.maxAskTurns, l.maxTurnsPerMessage) });
    if (g) return err(g);
    const reply = a.reply !== false && a.reply !== 'false';
    // In a room with other people the exchange stays visible to them (a bot-to-bot thread), never in a private chat.
    const where: 'chat' | 'thread' = a.where === 'thread' || shared ? 'thread' : 'chat';
    const sub = where === 'chat' ? this.ctx.chat.threadForAgent(userId, target.id) : this.dmThread(t, target, room);
    const id = newId('dlg_');
    const ts = now();
    const path = [...chain.path, target.id];
    const d: Delegation = {
      id,
      user_id: userId,
      room_id: room?.id ?? null,
      kind: 'ask',
      group_id: null,
      parent_thread_id: t.thread.id,
      parent_run_id: t.run.id,
      tool_call_id: t.toolCallId,
      thread_id: sub.id,
      from_agent_id: t.agent.id,
      to_agent_id: target.id,
      task: message,
      expected: '',
      status: 'queued',
      result: null,
      error: null,
      run_id: null,
      chain_id: chain.chainId,
      path,
      depth: path.length - 1,
      wait: false,
      follow_up: reply,
      delivered: false,
      created_at: ts,
      updated_at: ts,
      finished_at: null,
    };
    this.ctx.store.insert('room_delegations', d);
    this.s.activity(room?.id, { type: 'agent', id: t.agent.id }, 'delegation.ask', `Bericht aan ${target.name}: ${oneLine(message).slice(0, 160)}`, { delegationId: id, threadId: sub.id, to: target.id });
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
          ? `Zodra ${target.name} antwoordt, word je automatisch gewekt met het antwoord als nieuwe beurt in dit gesprek. Wacht er niet op: rond je beurt af of stuur andere bots ook een bericht (antwoorden die binnenkomen terwijl je bezig bent krijg je gebundeld). `
          : 'Er komt geen automatisch antwoord terug. ') +
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
      this.ctx.store.update('room_delegations', d.id, { status: 'error', error: 'De bot of zijn gesprek bestaat niet meer', finished_at: now(), updated_at: now() });
      const fresh = this.get(d.id)!;
      this.emit(fresh);
      if (fresh.follow_up) this.deliver(fresh);
      return this.pumpAsks(threadId, agentId);
    }
    const from = this.s.agentName(d.from_agent_id);
    const msg = this.ctx.store.createMessage({
      thread_id: sub.id,
      role: 'user',
      author_type: 'agent',
      author_id: d.from_agent_id,
      author_name: from,
      content: `${d.follow_up ? `${from} vraagt` : `Bericht van ${from}`}:\n\n${d.task}`,
      parts: { kind: 'bot_ask', delegationId: d.id, from: d.from_agent_id, reply: d.follow_up },
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
      this.ctx.store.update('room_delegations', d.id, { status: 'error', error: 'Kon de bot niet starten', finished_at: now(), updated_at: now() });
      const fresh = this.get(d.id)!;
      this.emit(fresh);
      if (fresh.follow_up) this.deliver(fresh);
      return false;
    }
    this.ctx.store.update('room_delegations', d.id, { run_id: run.id, updated_at: now() });
    this.ctx.events.emit(d.user_id, 'thread.updated', this.ctx.store.thread(sub.id));
    this.emit(this.get(d.id)!);
    return true;
  }

  /** A bot finished a turn in a thread: bring it held answers first, otherwise the next waiting bot message. */
  onIdle(threadId: string, agentId: string) {
    if (this.busy(threadId, agentId)) return;
    if (this.flush(threadId, agentId)) return;
    this.pumpAsks(threadId, agentId);
  }

  /**
   * Withdraw an open request. Nobody is woken for it (wake=false), unless asked. Returns false when it already ended.
   */
  cancel(d: Delegation, reason: string, o: { wake?: boolean } = {}): boolean {
    if (TERMINAL_DELEGATION.has(d.status)) {
      if (!o.wake && !d.delivered) this.ctx.store.update('room_delegations', d.id, { delivered: true, updated_at: now() });
      return false;
    }
    if (!o.wake) this.ctx.store.update('room_delegations', d.id, { delivered: true, updated_at: now() });
    if (d.run_id) {
      this.stop(this.get(d.id)!, reason);
      return true;
    }
    this.ctx.store.update('room_delegations', d.id, { status: 'cancelled', error: reason, finished_at: now(), updated_at: now() });
    const fresh = this.get(d.id)!;
    this.emit(fresh);
    if (o.wake && fresh.follow_up) this.deliver(fresh);
    return true;
  }

  /** delegation_cancel: withdraw own open requests from this conversation (one by id, or all). */
  cancelTool(t: ToolContext, a: any): ToolOutput {
    const mine = (d: Delegation | null): d is Delegation => !!d && d.user_id === t.thread.user_id && d.from_agent_id === t.agent.id;
    const list = a?.id ? [this.get(String(a.id))].filter(mine) : a?.all === true || a?.all === 'true' ? this.forThread(t.thread.id).filter((d) => mine(d) && !TERMINAL_DELEGATION.has(d.status)) : [];
    if (!list.length) return a?.id ? err(`Geen open verzoek ${a.id} van jou gevonden.`) : err('Geef een id, of all=true om alle open verzoeken vanuit dit gesprek in te trekken.');
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
    const ts = now();
    const d: Delegation = {
      id,
      user_id: userId,
      room_id: o.room?.id ?? null,
      kind: o.kind,
      group_id: o.groupId ?? null,
      parent_thread_id: t.thread.id,
      parent_run_id: t.run.id,
      tool_call_id: t.toolCallId,
      thread_id: sub.id,
      from_agent_id: t.agent.id,
      to_agent_id: target.id,
      task: o.task,
      expected: o.expected,
      status: 'queued',
      result: null,
      error: null,
      run_id: null,
      chain_id: o.chain.chainId,
      path,
      depth: path.length - 1,
      wait: o.wait,
      follow_up: o.followUp,
      delivered: false,
      created_at: ts,
      updated_at: ts,
      finished_at: null,
    };
    this.ctx.store.insert('room_delegations', d);
    const meta: TeamMeta = { chainId: o.chain.chainId, path, handoffs: o.chain.handoffs, kind: o.kind === 'message' ? 'message' : 'delegation', roomId: o.room?.id ?? null, requestedBy: o.chain.requestedBy ?? null, delegationId: id };
    const run = this.ctx.runs.enqueue({ threadId: sub.id, agentId: target.id, userId, trigger: `team:${o.kind}`, inputMessageId: msg.id, meta: { team: meta } });
    this.ctx.store.update('room_delegations', id, { run_id: run.id });
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
      const timer = setTimeout(() => {
        // Switch to asynchronous delivery before anyone else can finalize.
        this.ctx.store.update('room_delegations', id, { follow_up: true, wait: false, updated_at: now() });
        finish('timeout');
      }, sec * 1000);
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
    if (!target) return err(`Onbekende bot: ${a.bot}. Bots die je kunt aanspreken: ${this.botList(userId, room && this.s.humanMembers(room).some((h: any) => h.accepted) ? room : null, t.agent.id)}.`);
    const chain = this.callerChain(t);
    const he = this.hopError(t, target, chain, room);
    if (he) return err(he);
    const g = this.s.gate({ room, userId, agentId: target.id, chain, needMember: false });
    if (g) return err(g);
    const task = String((kind === 'message' ? a.message : a.task) ?? '').slice(0, 20_000);
    if (!task.trim()) return err(kind === 'message' ? 'Het bericht is leeg.' : 'De taak is leeg.');
    const expected = kind === 'delegate' ? String(a.expected_output ?? '').slice(0, 4000) : '';
    const wait = kind === 'message' ? a.wait !== false && a.wait !== 'false' : a.wait === true || a.wait === 'true';
    const { d, sub } = this.spawn(t, target, { kind, task, expected, wait, followUp: !wait, chain, room, dm: kind === 'message' });
    if (!wait)
      return {
        text: `${kind === 'message' ? 'Bericht verstuurd aan' : 'Taak gedelegeerd aan'} ${target.name} (id ${d.id}). ${target.name} werkt in een eigen subgesprek (#/t/${sub.id}). Je krijgt het resultaat automatisch als vervolgbeurt; je kunt nu je beurt afronden of ander werk doen. Status opvragen: delegation_status.`,
        data: { delegationId: d.id, threadId: sub.id },
      };
    const sec = Math.min(900, Math.max(5, Number(a.wait_seconds) || (kind === 'message' ? 120 : 300)));
    const r = await this.waitFor(d.id, sec, t.signal);
    if (r === 'aborted') {
      const cur = this.get(d.id);
      if (cur?.run_id && !TERMINAL_DELEGATION.has(cur.status)) this.ctx.runs.cancel(cur.run_id, 'Gestopt: de opdrachtgever werd gestopt');
      return err('Gestopt voordat er een resultaat was.');
    }
    if (r === 'timeout') return { text: `${target.name} is na ${sec} s nog bezig (id ${d.id}). Je krijgt het resultaat automatisch als vervolgbeurt zodra het klaar is.`, data: { delegationId: d.id } };
    const fin = this.get(d.id)!;
    return { text: this.resultText(fin), isError: fin.status !== 'done', data: { delegationId: d.id, status: fin.status } };
  }

  async broadcast(t: ToolContext, a: any): Promise<ToolOutput> {
    const userId = t.thread.user_id;
    const room = this.s.roomForThread(t.thread);
    const l = this.s.limits(room, userId);
    const message = String(a.message ?? '').slice(0, 20_000);
    if (!message.trim()) return err('Het bericht is leeg.');
    const refs: any[] = Array.isArray(a.bots) ? a.bots : String(a.bots ?? '').split(',');
    const targets: Agent[] = [];
    const unknown: string[] = [];
    for (const ref of refs) {
      if (!String(ref).trim()) continue;
      const b = this.resolveBot(userId, ref, room);
      if (!b) unknown.push(String(ref));
      else if (b.id !== t.agent.id && !targets.some((x) => x.id === b.id)) targets.push(b);
    }
    if (unknown.length) return err(unknown.length === 1 ? `Onbekende bot: ${unknown[0]}. Beschikbaar: ${this.botList(userId, room, t.agent.id)}.` : `Onbekende bots: ${unknown.join(', ')}. Beschikbaar: ${this.botList(userId, room, t.agent.id)}.`);
    if (!targets.length) return err('Geen andere bots opgegeven.');
    if (targets.length > l.maxBroadcastTargets) return err(`Te veel ontvangers (${targets.length}); maximaal ${l.maxBroadcastTargets} per broadcast.`);
    const chain = this.callerChain(t);
    const blocked: string[] = [];
    const ok: Agent[] = [];
    for (const b of targets) {
      const he = this.hopError(t, b, chain, room);
      if (he) blocked.push(`${b.name}: ${he}`);
      else ok.push(b);
    }
    if (!ok.length) return err(`Niemand kon worden aangesproken:\n${blocked.join('\n')}`);
    const followUp = a.follow_up !== false && a.follow_up !== 'false';
    const g = this.s.gate({ room, userId, agentId: ok[0].id, chain, needMember: false, extra: ok.length + (followUp ? 1 : 0) });
    if (g) return err(g);
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
        const id = newId('dlg_');
        const ts = now();
        const path = [...chain.path, b.id];
        const d: Delegation = {
          id,
          user_id: userId,
          room_id: room!.id,
          kind: 'broadcast',
          group_id: groupId,
          parent_thread_id: t.thread.id,
          parent_run_id: t.run.id,
          tool_call_id: t.toolCallId,
          thread_id: room!.thread_id,
          from_agent_id: t.agent.id,
          to_agent_id: b.id,
          task: message,
          expected: '',
          status: 'queued',
          result: null,
          error: null,
          run_id: null,
          chain_id: chain.chainId,
          path,
          depth: path.length - 1,
          wait: false,
          follow_up: followUp,
          delivered: false,
          created_at: ts,
          updated_at: ts,
          finished_at: null,
        };
        this.ctx.store.insert('room_delegations', d);
        const r = this.s.dispatch(room!, t.thread, b.id, { inputMessageId: bmsg!.id, meta: { chainId: chain.chainId, path, handoffs: chain.handoffs, kind: 'broadcast', requestedBy: chain.requestedBy ?? null, delegationId: id }, silent: true });
        if (r.run) {
          this.ctx.store.update('room_delegations', id, { run_id: r.run.id });
          lines.push(`- ${b.name}: gestart in de groep`);
        } else {
          this.ctx.store.update('room_delegations', id, { status: 'cancelled', error: r.refused, finished_at: now() });
          lines.push(`- ${b.name}: niet gestart (${r.refused})`);
        }
        this.emit(this.get(id)!);
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
    if (!target) return err(`Onbekende bot: ${a.bot}. Beschikbaar: ${this.botList(userId, room, t.agent.id)}.`);
    if (target.id === t.agent.id) return err('Je kunt niet aan jezelf overdragen.');
    const te = this.teamError(t.agent.id, target.id);
    if (te) return err(te);
    const chain = this.callerChain(t);
    const l = this.s.limits(room, userId);
    if (chain.handoffs >= l.maxHandoffs) return err(`Maximum van ${l.maxHandoffs} overdrachten voor dit bericht bereikt. Rond het zelf af of vraag een mens.`);
    if (chain.path.includes(target.id)) return err(`Geweigerd om een lus te voorkomen: ${target.name} heeft dit werk al gehad in deze keten (${this.names(chain.path)}).`);
    const reason = String(a.reason ?? '').slice(0, 2000);
    const meta: TeamMeta = { chainId: chain.chainId, path: [...chain.path, target.id], handoffs: chain.handoffs + 1, kind: 'handoff', requestedBy: chain.requestedBy ?? null };
    const note = `${t.agent.name} draagt het werk over aan ${target.name}.${reason ? ` Reden: ${reason}` : ''}`;
    if (room && t.thread.id === room.thread_id) {
      const m = this.s.botMember(room, target.id);
      if (!m) return err(`${target.name} is geen lid van deze groep. Gebruik delegate_task om een bot buiten de groep een afgebakende subtaak te geven.`);
      if (m.paused) return err(`${target.name} is gepauzeerd in deze groep.`);
      const g = this.s.gate({ room, userId, agentId: target.id, chain, needMember: true });
      if (g) return err(g);
      this.ctx.store.update('rooms', room.id, { owner_agent_id: target.id, updated_at: now() });
      const sys = this.s.systemMessage(t.thread, note, { kind: 'handoff', from: t.agent.id, to: target.id });
      const r = this.s.dispatch(this.s.room(room.id)!, t.thread, target.id, { inputMessageId: sys.id, meta });
      if (!r.run) return err(r.refused || 'Overdracht mislukt');
      this.s.emitChanged(room);
    } else {
      const g = this.s.gate({ room, userId, agentId: target.id, chain, needMember: false });
      if (g) return err(g);
      const th = this.ctx.store.updateThread(t.thread.id, { agent_id: target.id });
      this.ctx.chat.emit(th, 'thread.updated', th);
      const sys = this.s.systemMessage(th, note, { kind: 'handoff', from: t.agent.id, to: target.id });
      const did = t.thread.kind === 'delegation' ? (t.run.meta?.team?.delegationId as string | undefined) || th.meta?.delegation?.id : undefined;
      const run = this.ctx.runs.enqueue({ threadId: th.id, agentId: target.id, userId, trigger: 'team:handoff', inputMessageId: sys.id, meta: { team: { ...meta, roomId: room?.id ?? null, delegationId: did } } });
      if (did) this.ctx.store.update('room_delegations', did, { to_agent_id: target.id, run_id: run.id, updated_at: now() });
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
    this.ctx.store.update('room_delegations', id, { status: 'running', updated_at: now() });
    this.emit(this.get(id)!);
  }

  async onRunTerminal(run: Run, _thread: Thread, _room: Room | null) {
    // Interrupted only to take a steering message (agent/queue.ts): its work goes on in the next turn.
    if (run.status === 'cancelled' && !run.meta?.steerInterrupt) {
      // Stopping a bot also stops the subtasks it is waiting for or that it started in this turn.
      for (const c of this.ctx.store.all<any>("SELECT * FROM room_delegations WHERE parent_run_id = ? AND status IN ('queued','running')", run.id)) {
        const cd = this.ctx.store.decode<Delegation>('room_delegations', c);
        // Bot messages it sent in this turn are withdrawn; it is not woken for them.
        if (cd.kind === 'ask') this.cancel(cd, 'Ingetrokken: de afzender werd gestopt');
        else if (cd.run_id) this.stop(cd, 'Gestopt: de opdrachtgever werd gestopt', { quiet: true });
      }
    }
    const did = run.meta?.team?.delegationId as string | undefined;
    const d = this.get(did);
    if (!d || d.run_id !== run.id || TERMINAL_DELEGATION.has(d.status)) return;
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
    this.finalize(d, run, true);
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
    if (path.length > max) out.push(`Dit werk is al ${max === 1 ? '1 keer' : `${max} keer`} doorgegeven, het maximum: je kunt het niet verder doorgeven. Doe het zelf.`);
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
    this.ctx.store.update('room_delegations', d.id, { status: 'running', updated_at: now() });
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
      this.ctx.store.update('room_delegations', c.id, { delivered: true, updated_at: now() });
      if (TERMINAL_DELEGATION.has(c.status)) continue;
      const fresh = this.get(c.id)!;
      if (fresh.kind === 'ask') this.cancel(fresh, reason);
      else this.stop(fresh, reason, { quiet: true });
    }
    if (o.quiet) this.ctx.store.update('room_delegations', d.id, { delivered: true });
    this.closeWaiting(this.get(d.id)!, reason, 'cancelled');
  }

  /** Close a waiting subtask without a new turn (stopped, or its follow-up turn could not start) and report upwards. */
  private closeWaiting(d: Delegation, reason: string, status: 'error' | 'cancelled' = 'error') {
    const last = d.run_id ? this.ctx.store.run(d.run_id) : null;
    const text = last ? this.finalText(last, d.thread_id) : '';
    this.ctx.store.update('room_delegations', d.id, { status, result: text || null, error: reason, finished_at: now(), updated_at: now() });
    const fresh = this.get(d.id)!;
    this.emit(fresh);
    this.s.activity(d.room_id, { type: 'agent', id: d.to_agent_id }, 'delegation.done', `Subtaak voor ${this.s.agentName(d.from_agent_id)}: ${DELEGATION_LABEL[status]}`, { delegationId: d.id, status });
    const sub = this.ctx.store.thread(d.thread_id);
    if (sub) this.s.event(sub, `Status teruggestuurd naar ${this.s.agentName(d.from_agent_id)} (${DELEGATION_LABEL[status]}): ${reason}`, { kind: 'delegation_returned', delegationId: d.id });
    const w = this.waiters.get(d.id);
    if (w) {
      this.ctx.store.update('room_delegations', d.id, { delivered: true });
      return w();
    }
    if (fresh.follow_up && !fresh.delivered) this.deliver(fresh);
  }

  private finalText(run: Run, threadId: string): string {
    return this.ctx.store.one<{ content: string }>("SELECT content FROM messages WHERE run_id = ? AND thread_id = ? AND role = 'assistant' AND deleted = 0 AND content != '' ORDER BY seq DESC LIMIT 1", run.id, threadId)?.content || '';
  }

  private finalize(d: Delegation, run: Run, deliver: boolean) {
    const timedOut = this.s.timedOut.has(run.id) || /^Time-out/.test(run.error || '');
    // A run the loop guard stopped (agent/loops.ts) did not finish the job: an honest "niet gelukt", with what it tried.
    const loop = run.status === 'done' ? (run.meta?.loopStop as { text?: string } | undefined) : undefined;
    const status: Delegation['status'] = loop ? 'error' : run.status === 'done' ? 'done' : run.status === 'cancelled' ? (timedOut ? 'timeout' : 'cancelled') : 'error';
    const text = this.finalText(run, d.thread_id);
    const result = status === 'done' ? text || '(geen tekstueel resultaat)' : text || null;
    const error = status === 'done' ? null : loop ? `gestopt omdat het steeds hetzelfde deed zonder vooruitgang (${loop.text || 'lus'})` : run.error || DELEGATION_LABEL[status];
    this.ctx.store.update('room_delegations', d.id, { status, result, error, finished_at: now(), updated_at: now() });
    const fresh = this.get(d.id)!;
    this.emit(fresh);
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
            : `Melding van ${from} afgehandeld (${DELEGATION_LABEL[status]}); er gaat geen antwoord terug.`
          : `${DELEGATION_LABEL[status] === 'klaar' ? 'Resultaat' : 'Status'} teruggestuurd naar ${from} (${DELEGATION_LABEL[status]}).`;
      if (sub) this.s.event(sub, note, { kind: 'delegation_returned', delegationId: d.id });
    }
    const w = this.waiters.get(d.id);
    if (w) {
      this.ctx.store.update('room_delegations', d.id, { delivered: true });
      w();
      return;
    }
    if (!deliver) return;
    if (fresh.group_id) return this.groupDone(fresh.group_id);
    if (fresh.follow_up && !fresh.delivered) this.deliver(fresh);
  }

  /**
   * Asynchronous result: a system note in the parent thread plus a follow-up turn for the owner bot. While that bot is
   * still busy in the parent conversation the result is held (it never lands in the middle of a running turn) and
   * delivered, bundled with other results, as soon as it is free (see flush/onIdle).
   */
  private deliver(d: Delegation) {
    if (this.busy(d.parent_thread_id, d.from_agent_id)) return;
    this.flush(d.parent_thread_id, d.from_agent_id);
  }

  private resultNote(d: Delegation): { text: string; parts: Record<string, any> } {
    const who = this.s.agentName(d.to_agent_id);
    const body = d.status === 'done' ? `${cap(d.result, 12_000)}${this.checkLine(d)}` : `Niet gelukt: ${d.error}${d.result ? `\n\nLaatste tekst:\n${cap(d.result, 2000)}` : ''}`;
    const head =
      d.kind === 'ask'
        ? d.status === 'done'
          ? `${who} antwoordde op je bericht`
          : `${who} kon je bericht niet beantwoorden (${DELEGATION_LABEL[d.status]})`
        : `${d.kind === 'message' ? 'Antwoord' : 'Resultaat van de gedelegeerde taak'} van ${who} (${this.statusWord(d)})`;
    return { text: `${head}:\n\n${body}`, parts: { kind: 'delegation_result', delegationId: d.id, status: d.status, threadId: d.thread_id, from: d.to_agent_id } };
  }

  /**
   * Deliver every finished, undelivered result for one bot in one conversation: one note per result (or broadcast)
   * and a single follow-up turn for all of them. Returns true when a follow-up turn was started.
   */
  flush(parentThreadId: string, fromAgentId: string): boolean {
    if (this.busy(parentThreadId, fromAgentId)) return false;
    const parent = this.ctx.store.thread(parentThreadId);
    if (!parent) return false;
    const done = [...TERMINAL_DELEGATION].map((s) => `'${s}'`).join(',');
    const singles = this.ctx.store
      .all<any>(`SELECT * FROM room_delegations WHERE parent_thread_id = ? AND from_agent_id = ? AND group_id IS NULL AND follow_up = 1 AND delivered = 0 AND status IN (${done}) ORDER BY finished_at, created_at`, parentThreadId, fromAgentId)
      .map((r) => this.ctx.store.decode<Delegation>('room_delegations', r));
    const groups = this.ctx.store.all<{ group_id: string }>('SELECT DISTINCT group_id FROM room_delegations WHERE parent_thread_id = ? AND from_agent_id = ? AND group_id IS NOT NULL AND delivered = 0', parentThreadId, fromAgentId).map((r) => r.group_id);
    let first: { d: Delegation; input: string; async: boolean } | null = null;
    for (const d of singles) {
      this.ctx.store.update('room_delegations', d.id, { delivered: true });
      const n = this.resultNote(d);
      const sys = this.s.systemMessage(parent, n.text, n.parts);
      if (!first) first = { d, input: sys.id, async: d.kind === 'ask' };
      else if (d.kind === 'ask') first.async = true;
    }
    for (const gid of groups) {
      const rows = this.ctx.store.find<Delegation>('room_delegations', { group_id: gid }, { order: 'created_at' });
      if (!rows.length || rows.some((r) => !TERMINAL_DELEGATION.has(r.status)) || rows.some((r) => r.delivered)) continue;
      this.ctx.store.exec('UPDATE room_delegations SET delivered = 1 WHERE group_id = ?', gid);
      if (!rows[0].follow_up) continue;
      const lines = rows.map((r) => `- ${this.s.agentName(r.to_agent_id)}: ${DELEGATION_LABEL[r.status]}${r.status === 'done' ? ` — ${cap(oneLine(r.result || ''), 1500)}` : r.error ? ` — ${r.error}` : ''}`);
      const sys = this.s.systemMessage(parent, `Alle antwoorden op je broadcast zijn binnen:\n${lines.join('\n')}`, { kind: 'broadcast_result', broadcastId: gid });
      if (!first) first = { d: rows[0], input: sys.id, async: false };
    }
    if (!first) return false;
    this.followUp(parent, first.d, first.input, first.async);
    return true;
  }

  private groupDone(groupId: string) {
    const rows = this.ctx.store.find<Delegation>('room_delegations', { group_id: groupId }, { order: 'created_at' });
    if (!rows.length || rows.some((r) => !TERMINAL_DELEGATION.has(r.status)) || rows.some((r) => r.delivered)) return;
    if (!rows[0].follow_up) return void this.ctx.store.exec('UPDATE room_delegations SET delivered = 1 WHERE group_id = ?', groupId);
    this.deliver(rows[0]);
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
    if (r.run) this.ctx.store.update('room_delegations', up.id, { run_id: r.run.id, updated_at: now() });
    else this.closeWaiting(up, r.refused || 'De vervolgbeurt kon niet starten');
  }

  /** After a restart: open delegations whose run already ended are closed without starting new turns. */
  reconcile() {
    for (const d of this.ctx.store.all<any>("SELECT * FROM room_delegations WHERE status IN ('queued','running')").map((r) => this.ctx.store.decode<Delegation>('room_delegations', r))) {
      const run = d.run_id ? this.ctx.store.run(d.run_id) : null;
      if (run && !TERMINAL_RUN.has(run.status)) continue;
      // A bot message that was still waiting for its recipient stays in the mailbox and is delivered when it is free.
      if (!run && d.kind === 'ask' && d.status === 'queued') continue;
      if (!run) {
        this.ctx.store.update('room_delegations', d.id, { status: 'error', error: 'Taak niet gevonden na herstart', finished_at: now() });
        continue;
      }
      this.finalize(d, run, false);
      const parent = this.ctx.store.thread(d.parent_thread_id);
      const fresh = this.get(d.id)!;
      if (parent && !fresh.delivered && (fresh.follow_up || fresh.kind !== 'ask')) {
        this.ctx.store.update('room_delegations', d.id, { delivered: true });
        if (fresh.kind === 'ask') {
          // Keep the answer (no automatic turn after a restart): the bot sees it the next time it works here.
          const n = this.resultNote(fresh);
          this.s.systemMessage(parent, `${n.text}\n\n(Afgesloten na een herstart van TeamBot; er is geen automatische vervolgbeurt gestart.)`, n.parts);
        } else this.s.event(parent, `Gedelegeerde taak aan ${this.s.agentName(d.to_agent_id)} is afgesloten na een herstart (${DELEGATION_LABEL[fresh.status]}). Er is geen automatische vervolgbeurt gestart.`, { kind: 'delegation_result', delegationId: d.id });
      }
    }
    // Held bot messages whose recipient is free now.
    for (const r of this.ctx.store.all<{ thread_id: string; to_agent_id: string }>("SELECT DISTINCT thread_id, to_agent_id FROM room_delegations WHERE kind = 'ask' AND status = 'queued' AND run_id IS NULL")) this.pumpAsks(r.thread_id, r.to_agent_id);
  }
}
