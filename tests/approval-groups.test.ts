/** "Wacht op jou": requests of one bot for the same action are one block; everything else stays a card of its own. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { approvalBlocks } from '../shared/approvalGroups.js';

const a = (id: string, agent: string | null, tool: string, o: any = {}) => ({ id, agent_id: agent, kind: 'tool' as const, tool, ...o });

test('ten mails of one bot are one block with ten lines; other requests keep their own card and their place', () => {
  const list = [
    a('1', 'post', 'gmail_send'),
    a('2', 'klant', 'gmail_send'),
    a('3', 'post', 'gmail_send'),
    a('q', 'post', 'ask_user', { kind: 'question' }),
    a('4', 'post', 'gmail_send'),
    a('5', 'post', 'write_file'),
    a('6', 'post', 'gmail_send', { interrupted_at: '2026-11-20T01:00:00Z' }),
    a('7', null, 'gmail_send'),
  ];
  const blocks = approvalBlocks(list);
  assert.deepEqual(
    blocks.map((b) => (b.kind === 'group' ? `groep ${b.agentId}/${b.tool}: ${b.items.map((x) => x.id).join(',')}` : b.a.id)),
    ['groep post/gmail_send: 1,3,4', '2', 'q', '5', '6', '7'],
  );
  // Two of a kind are still two cards.
  assert.deepEqual(approvalBlocks([a('1', 'post', 'gmail_send'), a('2', 'post', 'gmail_send')]).map((b) => b.kind), ['one', 'one']);
  assert.deepEqual(approvalBlocks([]), []);
});
