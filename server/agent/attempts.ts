/**
 * What stays of an answer that did not finish: the steps it really took, and how a failed attempt looks in the chat
 * when another engine takes over or the work pauses.
 */
import type { Ctx, Message, Thread } from '../core/types.js';
import { redact } from '../core/secrets.js';
import { toolLabel } from '../../shared/toolLabels.js';
import { crashDetail } from './fallback.js';

/** The raw text of a CLI that stopped unexpectedly, without secrets, for "Details" under the plain error. */
export function redactDetail(e: any): string | undefined {
  const d = crashDetail(e);
  return d ? redact(d) : undefined;
}

/** Steps that did something: not the session lines ("OpenCode-sessie gestart", "Verder in het vorige gesprek"). */
function realSteps(m: Message): any[] {
  return (m.parts?.activity || []).filter((a: any) => a && a.kind !== 'session' && a.kind !== 'mode');
}

/** Steps of an answer that really happened: a CLI's steps, or an API turn's tool calls that finished. In words. */
export function doneSteps(m: Message): string[] {
  const out: string[] = [];
  for (const a of m.parts?.activity || []) if (a?.title && !['session', 'cli_session', 'settings', 'question'].includes(a.kind)) out.push(a.title);
  for (const c of m.parts?.toolCalls || []) if (c.status === 'done') out.push(c.summary ? `${toolLabel(c, false)}: ${c.summary}` : toolLabel(c, false));
  return out;
}

/** The failed attempt when another engine takes over (or the work pauses): gone when it has nothing to show. */
export function hideAttempt(ctx: Ctx, thread: Thread, messageId: string) {
  const m = ctx.store.message(messageId);
  if (!m) return;
  // Only "OpenCode-sessie gestart" and the like is nothing to show either (C-06: an empty "1 stap" block).
  const empty = !m.content?.trim() && !realSteps(m).length && !m.parts.attachments?.length && !m.parts.toolCalls?.length;
  // (switched on the removed one too: the open chat hides it instead of showing "Bericht verwijderd")
  const patch = empty ? { deleted: true, parts: { ...m.parts, switched: true } } : { status: 'cancelled' as const, parts: { ...m.parts, switched: true, notice: undefined, error: undefined } };
  ctx.chat.emitMessage(thread, ctx.store.updateMessage(m.id, patch as any), 'message.updated');
}

/** A failed answer whose only steps are "OpenCode-sessie gestart" and the like: those go (nothing was done). */
export function dropSessionOnlySteps(ctx: Ctx, thread: Thread, messageId: string) {
  const m = ctx.store.message(messageId);
  if (!m?.parts.activity?.length || realSteps(m).length) return;
  ctx.chat.emitMessage(thread, ctx.store.updateMessage(m.id, { parts: { ...m.parts, activity: undefined } }), 'message.updated');
}
