import type { Ctx, User } from '../../../core/types.js';
import { SpeechSplitter } from '../sentences.js';
import { runResult, stopInterruptedAnswer } from '../calls.js';
import type { Brain } from './session.js';

/**
 * The bot itself is the brain: each turn is a normal message in its real chat and a normal run (its own engine, model,
 * tools, memory, team and approvals; the free engine chain when the bot uses it). The answer is followed while it is
 * written and handed to the voice sentence by sentence. Talking over it stops the run, and the answer in the chat is
 * cut to what you heard.
 */
export function agentBrain(ctx: Ctx, o: { user: Pick<User, 'id' | 'name'>; call: { id: string; thread_id: string; agent_id: string; user_id: string; status: string }; lang: string }): Brain {
  let lastRun: string | null = null;
  return {
    async reply(text, { onSentence, signal }) {
      const thread = ctx.store.thread(o.call.thread_id);
      const agent = ctx.store.agent(o.call.agent_id);
      if (!thread || !agent || thread.user_id !== o.user.id || agent.user_id !== o.user.id) throw new Error('Gesprek of bot niet gevonden');
      const msg = await ctx.chat.postUserMessage({ thread, user: o.user, content: text.slice(0, 8000), parts: { voice: { via: 'call', callId: o.call.id, duplex: true } }, route: false });
      const run = ctx.chat.startAgent(thread, agent.id, msg.id, 'voice', { voiceCallId: o.call.id, voiceRequest: text.slice(0, 300) });
      if (!run) throw new Error('Bot niet gevonden');
      lastRun = run.id;
      ctx.store.exec('UPDATE voice_calls SET asks = asks + 1 WHERE id = ?', o.call.id);
      const splitter = new SpeechSplitter(o.lang);
      const msgs = new Set<string>();
      let spoke = false;
      const out = (list: string[]) => list.forEach((s) => ((spoke = true), onSentence(s)));
      const off = ctx.events.subscribe((e) => {
        if (e.userId !== o.user.id || signal.aborted) return;
        const d = e.data;
        if (e.type === 'message.created' && d?.run_id === run.id && d.role === 'assistant') {
          msgs.add(d.id);
          if (d.content) out(splitter.push(d.content));
        } else if (e.type === 'message.delta' && msgs.has(d?.messageId) && d.text) out(splitter.push(d.text));
      });
      const stop = () => stopInterruptedAnswer(ctx, ctx.store.get<any>('voice_calls', o.call.id) || o.call, run.id);
      signal.addEventListener('abort', stop, { once: true });
      try {
        await Promise.race([ctx.runs.waitFor(run.id), new Promise((r) => signal.addEventListener('abort', r, { once: true }))]);
      } finally {
        off();
        signal.removeEventListener('abort', stop);
      }
      if (signal.aborted) return;
      out(splitter.end());
      // An engine that does not stream (or a message written in one go): read the final answer.
      if (!spoke) {
        const r = runResult(ctx, run.id);
        const fin = new SpeechSplitter(o.lang);
        out([...fin.push(r.status === 'done' ? r.text : r.status === 'waiting_approval' ? 'Ik wacht op je goedkeuring in de app.' : r.text || ''), ...fin.end()]);
      }
    },
    interrupted(heard) {
      if (!lastRun) return;
      const runId = lastRun;
      // The run stops first (stopInterruptedAnswer); then the answer in the chat keeps only what was heard.
      void ctx.runs.waitFor(runId, 15_000).then(() => {
        const thread = ctx.store.thread(o.call.thread_id);
        if (!thread) return;
        for (const r of ctx.store.all<{ id: string }>("SELECT id FROM messages WHERE run_id = ? AND role = 'assistant' AND deleted = 0", runId)) {
          const m = ctx.store.message(r.id);
          if (!m) continue;
          const full = String(m.content || '');
          const content = heard ? heard : '…';
          if (full === content) continue;
          const fresh = ctx.store.updateMessage(m.id, { content, parts: { ...m.parts, voiceInterrupted: true, voiceHeardOnly: true, voiceUnheard: full.slice(0, 8000) } });
          ctx.chat.emitMessage(thread, fresh, 'message.updated');
        }
      }).catch(() => {});
    },
  };
}
