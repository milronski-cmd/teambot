import type { Ctx, Thread } from '../core/types.js';
import { ah, bad, notFound, user } from '../core/http.js';

/**
 * Branch a conversation (CHT-10): "continue from here" creates a new thread with copies of all messages up to and
 * including the chosen one. The original thread is untouched. Provider sessions (CLI agents) are not carried over —
 * the new branch starts a fresh session with the copied history as context.
 */
export function forkRoutes(ctx: Ctx, canSee: (userId: string, t: Thread | null) => boolean) {
  ctx.api.post(
    '/threads/:id/fork',
    ah(async (req) => {
      const u = user(req);
      const src = ctx.store.thread(req.params.id as string);
      if (!canSee(u.id, src) || src!.user_id !== u.id) throw notFound('Gesprek niet gevonden');
      const upto = ctx.store.message(String(req.body?.messageId || ''));
      if (!upto || upto.thread_id !== src!.id) throw bad('Kies een bericht in dit gesprek');
      const t = ctx.store.createThread({ user_id: u.id, agent_id: src!.agent_id, kind: src!.kind === 'room' ? 'room' : 'chat', title: `${src!.title || 'Gesprek'} (vertakking)` });
      const meta = { ...t.meta, forkedFrom: { threadId: src!.id, messageId: upto.id, at: upto.created_at } };
      if (src!.room_id) ctx.store.update('threads', t.id, { room_id: src!.room_id });
      ctx.store.update('threads', t.id, { meta });
      const map = new Map<string, string>();
      ctx.store.tx(() => {
        for (const m of ctx.store.messages(src!.id, { limit: 100_000 })) {
          if (m.seq > upto.seq) break;
          if (m.deleted || m.status === 'streaming') continue;
          const parts = { ...m.parts };
          delete (parts as any).raw; // provider-native replay blocks are tied to the original session
          const copy = ctx.store.createMessage({
            thread_id: t.id,
            role: m.role,
            author_type: m.author_type,
            author_id: m.author_id,
            author_name: m.author_name,
            content: m.content,
            parts,
            status: m.status === 'error' ? 'error' : 'done',
            usage: null,
            reply_to: m.reply_to ? map.get(m.reply_to) ?? null : null,
          });
          map.set(m.id, copy.id);
        }
      });
      const fresh = ctx.store.thread(t.id)!;
      ctx.chat.addEvent(fresh, `Vertakt van "${src!.title || 'gesprek'}" — alles tot en met het gekozen bericht is gekopieerd. Het originele gesprek blijft ongewijzigd.`, { fork: true });
      ctx.audit(u.id, 'thread.forked', { from: src!.id, upto: upto.id, to: t.id }, src!.agent_id);
      ctx.events.emit(u.id, 'thread.updated', ctx.store.thread(t.id));
      return ctx.store.thread(t.id);
    }),
  );
}
