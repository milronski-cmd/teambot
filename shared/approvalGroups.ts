/**
 * "Wacht op jou": several requests of one bot for the same action (ten mails to send) are one block with a line per
 * request, so the owner sees all of them at a glance and decides each one. Live (20 Nov 2026): fifteen loose cards,
 * approved on a sample of three. Pure: used by the page and tested without it.
 */
export interface GroupableApproval {
  id: string;
  agent_id: string | null;
  kind: 'tool' | 'question';
  tool: string;
  interrupted_at?: string | null;
}

export type ApprovalBlock<A extends GroupableApproval> = { kind: 'one'; a: A } | { kind: 'group'; key: string; agentId: string; tool: string; items: A[] };

/** From this many requests of one bot for one action they are shown as one block. */
export const GROUP_FROM = 3;

/**
 * The pending requests in the order they came, with requests of the same bot for the same action taken together (at
 * the place of the first one). Questions, requests after a restart and requests without a bot stay on their own.
 */
export function approvalBlocks<A extends GroupableApproval>(list: A[], from = GROUP_FROM): ApprovalBlock<A>[] {
  const keyOf = (a: A) => (a.kind === 'tool' && a.agent_id && !a.interrupted_at ? `${a.agent_id}\n${a.tool}` : null);
  const sizes = new Map<string, number>();
  for (const a of list) {
    const k = keyOf(a);
    if (k) sizes.set(k, (sizes.get(k) || 0) + 1);
  }
  const out: ApprovalBlock<A>[] = [];
  const groups = new Map<string, A[]>();
  for (const a of list) {
    const k = keyOf(a);
    if (!k || (sizes.get(k) || 0) < from) {
      out.push({ kind: 'one', a });
      continue;
    }
    let items = groups.get(k);
    if (!items) {
      items = [];
      groups.set(k, items);
      out.push({ kind: 'group', key: k, agentId: a.agent_id!, tool: a.tool, items });
    }
    items.push(a);
  }
  return out;
}
