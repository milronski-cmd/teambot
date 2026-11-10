import type { Agent, Ctx } from '../../core/types.js';
import { redact } from '../../core/secrets.js';

/**
 * Tell the owner something on his own chat app (WhatsApp, Telegram …), when one is connected: through a channel of
 * this bot, else one of the bot's team. Only ever to the owner himself ("Dit ben ik" on that channel), never to
 * anyone else. Returns where it went (channel names) and, when nothing worked, why.
 *
 * This is on top of the normal `notification` event (the app, the desktop and the phone push); it does not replace it.
 */
export async function tellOwner(ctx: Ctx, o: { userId: string; agent: Pick<Agent, 'id' | 'name'>; text: string; teamId?: string | null }): Promise<{ sent: string[]; error: string }> {
  const ch = ctx.services.channels;
  if (typeof ch?.bindings !== 'function' || typeof ch?.deliver !== 'function') return { sent: [], error: '' };
  let list: any[] = [];
  try {
    list = ch.bindings(o.userId) || [];
  } catch {
    return { sent: [], error: '' };
  }
  const usable = list.filter((b) => b.enabled !== false && (b.agent_id === o.agent.id || (!!o.teamId && b.team_id === o.teamId)));
  // The bot's own channel first.
  usable.sort((a, b) => Number(b.agent_id === o.agent.id) - Number(a.agent_id === o.agent.id));
  let error = '';
  for (const b of usable.slice(0, 3)) {
    try {
      await ch.deliver({ userId: o.userId, bindingId: b.id, owner: true, text: o.text.slice(0, 3500), senderName: o.agent.name, agentId: o.agent.id });
      return { sent: [String(b.name || b.adapter || 'kanaal')], error: '' };
    } catch (e: any) {
      error = redact(String(e?.message || e)).slice(0, 200);
    }
  }
  return { sent: [], error };
}
