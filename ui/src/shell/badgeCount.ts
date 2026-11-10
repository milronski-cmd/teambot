// Structural shapes (the parts of Agent, Thread and Approval from lib/types that are used), so this file has no imports
// and the node tests can load it directly.
type BotLike = { id: string; archived: boolean };
type ThreadLike = { agent_id: string | null; room_id: string | null; kind: string; archived: boolean; updated_at: string };
type ApprovalLike = { agent_id: string | null };

/**
 * How many chats have something new for the owner, the way the chat list shows it: per bot its latest chat (not a
 * group or an archived chat), unread, and no approval of that bot waiting (that one is already in "wacht op jou").
 * Pure (the unread check is passed in), so it is unit-tested; used for the taskbar badge of the desktop app.
 */
export function unreadChats<T extends ThreadLike>(agents: BotLike[], threads: T[], approvals: ApprovalLike[], isUnread: (t: T) => boolean): number {
  const latest = new Map<string, T>();
  for (const t of threads) {
    if (t.archived || !t.agent_id || t.room_id || t.kind === 'room') continue;
    const cur = latest.get(t.agent_id);
    if (!cur || t.updated_at > cur.updated_at) latest.set(t.agent_id, t);
  }
  const waiting = new Set(approvals.map((a) => a.agent_id).filter(Boolean));
  let n = 0;
  for (const a of agents) {
    if (a.archived || waiting.has(a.id)) continue;
    const t = latest.get(a.id);
    if (t && isUnread(t)) n++;
  }
  return n;
}
