import type { Agent, AttachmentRef, Ctx, Message, MessageParts, Thread, User } from '../core/types.js';
import { canTalkTo } from './shared.js';

/** High-level chat operations shared by the HTTP API, channels, routines and rooms. */
/** Strip owner-only parts (memory/turn context, provider-native replay data) before a message reaches anyone else. */
export function publicView<T>(data: T): T {
  const m = data as any;
  if (!m || typeof m !== 'object' || !m.parts || typeof m.parts !== 'object') return data;
  const { context, contextByAgent, raw, ...parts } = m.parts;
  if (context === undefined && contextByAgent === undefined && raw === undefined) return data;
  return { ...m, parts } as T;
}

export class ChatService {
  constructor(private getCtx: () => Ctx) {}

  /** Every user that should receive live events for a thread. */
  audience(thread: Thread | null, fallbackUserId?: string): string[] {
    const ids = new Set<string>();
    if (thread) ids.add(thread.user_id);
    if (fallbackUserId) ids.add(fallbackUserId);
    for (const u of (thread?.meta?.memberUserIds as string[]) || []) ids.add(u);
    return [...ids];
  }

  emit(thread: Thread, type: string, data: any) {
    const ctx = this.getCtx();
    for (const uid of this.audience(thread)) ctx.events.emit(uid, type, uid === thread.user_id ? data : publicView(data));
  }

  emitMessage(thread: Thread, m: Message, type: 'message.created' | 'message.updated' = 'message.created') {
    this.emit(thread, type, m);
    if (type === 'message.created') for (const h of this.getCtx().hooks.messageCreated) {
      try {
        h({ message: m, thread });
      } catch (e) {
        this.getCtx().log.error('[hooks.messageCreated]', e);
      }
    }
  }

  /** Most recent open chat thread with an agent, or a new one. */
  threadForAgent(userId: string, agentId: string, kind: Thread['kind'] = 'chat'): Thread {
    const ctx = this.getCtx();
    const existing = ctx.store.threads(userId, { agentId, kind, limit: 1 }).find((t) => !t.room_id);
    return existing || ctx.store.createThread({ user_id: userId, agent_id: agentId, kind });
  }

  /**
   * Post a message from a human (or an external channel user) and route it to
   * whoever should answer. Returns the stored message.
   */
  async postUserMessage(o: {
    thread: Thread;
    user: Pick<User, 'id' | 'name'>;
    content: string;
    attachments?: AttachmentRef[];
    replyTo?: string | null;
    authorType?: 'user' | 'external';
    authorName?: string;
    parts?: MessageParts;
    route?: boolean;
    trigger?: string;
  }): Promise<Message> {
    const ctx = this.getCtx();
    const m = ctx.store.createMessage({
      thread_id: o.thread.id,
      role: 'user',
      author_type: o.authorType || 'user',
      author_id: o.user.id,
      author_name: o.authorName || o.user.name,
      content: o.content,
      parts: { ...(o.parts || {}), ...(o.attachments?.length ? { attachments: o.attachments } : {}) },
      reply_to: o.replyTo ?? null,
    });
    if (!o.thread.title && o.content) ctx.store.updateThread(o.thread.id, { title: o.content.replace(/\s+/g, ' ').slice(0, 60) });
    this.emitMessage(o.thread, m);
    if (o.route !== false) await this.route(m, o.thread, o.trigger);
    return m;
  }

  async route(m: Message, thread: Thread, trigger = 'user') {
    const ctx = this.getCtx();
    for (const h of ctx.hooks.route) {
      if (await h({ message: m, thread, userId: thread.user_id })) return;
    }
    if (thread.agent_id) this.startAgent(thread, thread.agent_id, m.id, trigger);
  }

  /** Enqueue a run for an agent, honouring its busy policy (queue vs interrupt). */
  startAgent(thread: Thread, agentId: string, inputMessageId: string | null, trigger = 'user', meta: Record<string, any> = {}) {
    const ctx = this.getCtx();
    const agent = ctx.store.agent(agentId);
    if (!agent) return null;
    // Security: a bot only ever runs in conversations of its own owner (room members post into the owner's room
    // thread; nobody can make someone else's bot run with that person's tools, files and keys).
    // A bot shared with the team may answer in a member's own 1:1 conversation (as its narrowed copy, agent/shared.ts).
    const sharedChat = thread.kind === 'chat' && !thread.room_id && agent.user_id !== thread.user_id && canTalkTo(ctx, thread.user_id, agent);
    if (agent.user_id !== thread.user_id && !sharedChat) {
      // A member's own conversation with a bot that is no longer shared: say why it stays quiet.
      if (thread.meta?.sharedBot && thread.kind === 'chat') {
        const owner = ctx.store.user(agent.user_id)?.name || 'de eigenaar';
        this.addEvent(thread, `${agent.name} is niet meer gedeeld met het team. Alleen ${owner} kan deze bot nu gebruiken.`, { kind: 'shared_off', agentId: agent.id });
        return null;
      }
      ctx.log.warn(`[chat] geweigerd: bot ${agent.id} hoort niet bij de eigenaar van gesprek ${thread.id}`);
      ctx.audit(thread.user_id, 'security.cross_owner_run_blocked', { agentId: agent.id, threadId: thread.id });
      return null;
    }
    // A blocked/deactivated account's bots never run (routines, channels, rooms included).
    if (ctx.store.user(agent.user_id)?.disabled) {
      ctx.log.warn(`[chat] geweigerd: bot ${agent.id} hoort bij een geblokkeerd account`);
      return null;
    }
    if (agent.busy_policy === 'interrupt' && ctx.runs.isBusy(thread.id, agentId)) ctx.runs.cancelThread(thread.id, agentId, 'Onderbroken door nieuw bericht');
    return ctx.runs.enqueue({ threadId: thread.id, agentId, userId: thread.user_id, trigger, inputMessageId, meta });
  }

  addEvent(thread: Thread, text: string, parts: MessageParts = {}): Message {
    const ctx = this.getCtx();
    const m = ctx.store.createMessage({ thread_id: thread.id, role: 'event', author_type: 'system', author_name: 'TeamBot', content: text, parts });
    this.emitMessage(thread, m);
    return m;
  }

  /** A message spoken by an agent without a model call (e.g. routine summary, handoff note). */
  addAgentMessage(thread: Thread, agent: Agent, content: string, parts: MessageParts = {}): Message {
    const ctx = this.getCtx();
    const m = ctx.store.createMessage({ thread_id: thread.id, role: 'assistant', author_type: 'agent', author_id: agent.id, author_name: agent.name, content, parts });
    this.emitMessage(thread, m);
    return m;
  }
}
