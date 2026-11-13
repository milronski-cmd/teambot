import type { Message, Run, Thread } from '../core/types.js';

/**
 * The one place that says whether words come from the owner himself. Used by memory ("onthoud dat …" only counts from
 * the owner) and by the tools with which a bot changes itself or other bots (teams/selftools.ts, teams/maintools.ts):
 * text a bot READ on a web page, in a file or in a mail must never be able to rewrite its instructions for good.
 */

/** Is this message written by the thread owner in their own words (not external, forwarded or a system note)? */
export function isOwnerMessage(m: Message | null, thread: Thread): boolean {
  if (!m || m.role !== 'user' || m.deleted) return false;
  return (m.author_type === 'user' && m.author_id === thread.user_id) || ownerOnChannel(m, thread);
}

/**
 * The owner writing to his own bot through a channel (WhatsApp, Telegram, e-mail …): the channel marks the message
 * `isOwner` only for the owner's own verified sender in a one-to-one conversation (channels/manager.ts). His words
 * there count like his words in the app: "onthoud dat …" works and the conversation is learned from.
 */
export function ownerOnChannel(m: Message | null, thread: Thread | null): boolean {
  const ch = (m?.parts as any)?.channel;
  return !!m && !!thread && thread.kind === 'channel' && m.role === 'user' && m.author_type === 'external' && !m.deleted && ch?.isOwner === true && ch?.private !== false && !ch?.outbound;
}

const FORWARDED = /^\s*(doorgestuurd van|forwarded from)/i;

/**
 * Strict: was THIS turn started by a message the owner typed himself (in the app, or as the verified owner on a
 * channel)? False for a routine, webhook, feed, delegation from another bot, a message from someone else, a forwarded
 * message, and a turn TeamBot started itself (resume after a card, check-in, work loop). Unknown counts as no.
 */
export function turnFromOwner(store: { message(id: string | null): Message | null | undefined }, run: Run | null | undefined, thread: Thread): boolean {
  if (!run || !run.input_message_id) return false;
  const viaChannel = run.trigger === 'channel';
  if (!['user', 'retry', 'steer'].includes(run.trigger) && !viaChannel) return false;
  const input = store.message(run.input_message_id) || null;
  if (!input || FORWARDED.test(input.content || '')) return false;
  return viaChannel ? ownerOnChannel(input, thread) : isOwnerMessage(input, thread);
}
