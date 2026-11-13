import { agentById } from '../lib/store';
import type { Approval } from '../lib/types';
import { BotAvatar } from '../components/BotFace';
import { timeAgo } from '../components/ui';

/**
 * The line above every card that waits for the owner (a permission, a question, a login choice): which bot, what it
 * does ("vraagt", "wacht op jou"), how long ago, and outside the conversation a link to it. `avatar`: the bot's face in
 * front (by default only outside the conversation).
 */
export function ApprovalMeta({ a, showThreadLink, verb, avatar = showThreadLink }: { a: Approval; showThreadLink?: boolean; verb: string; avatar?: boolean }) {
  const agent = agentById(a.agent_id);
  return (
    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
      {avatar && <BotAvatar bot={agent || { id: a.agent_id || 'bot', name: 'bot' }} size={20} mood="waiting" />}
      <span>
        <span className="font-semibold text-fg">{agent?.name || 'Bot'}</span> {verb}
      </span>
      <span aria-hidden>·</span>
      <span>{timeAgo(a.created_at)}</span>
      {showThreadLink && a.thread_id && (
        <>
          <span aria-hidden>·</span>
          <a className="font-semibold underline underline-offset-2 hover:text-fg" href={`#/t/${a.thread_id}`}>
            naar gesprek
          </a>
        </>
      )}
    </div>
  );
}
