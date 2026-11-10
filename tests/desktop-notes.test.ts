import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { PendingNotes } from '../desktop/notes.js';

/**
 * PARITEIT 15.1: a Windows notification for an approval or a question goes away once it is decided elsewhere (the
 * paired phone, another window), instead of staying with buttons that no longer do anything.
 */

class FakeNote {
  closed = 0;
  close() {
    this.closed++;
  }
}

test('pending notes: closed when decided, not while pending, a newer one replaces an older one, forget after dismiss', () => {
  const p = new PendingNotes<FakeNote>();
  const a = new FakeNote();
  p.add('apr_1', a);
  assert.equal(p.approvalUpdated({ id: 'apr_1', status: 'pending' }), false);
  assert.equal(p.approvalUpdated(null), false);
  assert.equal(p.approvalUpdated({ id: 'apr_x', status: 'approved' }), false);
  assert.equal(a.closed, 0);
  const b = new FakeNote();
  p.add('apr_1', b);
  assert.equal(a.closed, 1, 'the older notification of the same approval is closed');
  assert.equal(p.approvalUpdated({ id: 'apr_1', status: 'denied' }), true);
  assert.equal(b.closed, 1);
  assert.equal(p.approvalUpdated({ id: 'apr_1', status: 'denied' }), false, 'once');
  const c = new FakeNote();
  p.add('apr_2', c);
  p.forget(c);
  assert.equal(p.approvalUpdated({ id: 'apr_2', status: 'approved' }), false);
  assert.equal(c.closed, 0);
  assert.equal(p.size, 0);
});

test('an approval approved on the paired phone and a question answered in another window close their Windows notification', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const notes = new PendingNotes<FakeNote>();
    const shown = new Map<string, FakeNote>();
    // What the desktop shell (desktop/status.ts) does with the server's events.
    t.app.ctx.events.subscribe((e) => {
      if (e.userId !== owner.id) return;
      if (e.type === 'notification' && e.data?.approvalId) {
        const n = new FakeNote();
        shown.set(e.data.approvalId, n);
        notes.add(e.data.approvalId, n);
      } else if (e.type === 'approval.updated') notes.approvalUpdated(e.data);
    });
    const a = await t.agent({ name: 'Ada' });
    const agent = t.app.ctx.store.agent(a.id)!;
    const ask = (kind: 'tool' | 'question') =>
      t.app.ctx.broker.request({ userId: owner.id, agent, thread: null, run: null, kind, tool: kind === 'question' ? 'ask_user' : 'write_file', input: kind === 'question' ? { question: 'Welke map?' } : { path: 'a.txt' }, summary: kind === 'question' ? 'Welke map?' : 'a.txt schrijven', risk: 'write' });
    const pendingIds = () => t.app.ctx.store.all<any>("SELECT id, kind FROM approvals WHERE user_id = ? AND status = 'pending'", owner.id);

    // 1. Approve on the phone (a paired device session, the phone's own API).
    const decided = ask('tool');
    const until = async (fn: () => boolean) => {
      for (let i = 0; i < 200 && !fn(); i++) await new Promise((r) => setTimeout(r, 10));
      assert.ok(fn());
    };
    await until(() => pendingIds().length === 1);
    const aprId = pendingIds()[0].id;
    await until(() => shown.has(aprId));
    assert.equal(shown.get(aprId)!.closed, 0, 'still open while it waits');
    const ticket = await t.api('POST', '/mobile/pair', { baseUrl: 'http://192.168.1.5:4748' });
    const secret = new URLSearchParams(new URL(ticket.url).hash.slice(1)).get('t')!;
    const claim = await fetch(`${t.app.url}/api/public/mobile/claim`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1' },
      body: JSON.stringify({ secret, name: 'Test-iPhone' }),
    });
    assert.equal(claim.status, 200);
    const phone = ((await claim.json()) as any).token as string;
    const res = await fetch(`${t.app.url}/api/approvals/${aprId}`, { method: 'POST', headers: { authorization: `Bearer ${phone}`, 'content-type': 'application/json' }, body: JSON.stringify({ decision: 'approve' }) });
    assert.equal(res.status, 200);
    await decided;
    assert.equal(t.app.ctx.store.get<any>('approvals', aprId)!.status, 'approved', 'decided on the phone');
    await until(() => shown.get(aprId)!.closed === 1);

    // 2. A question answered in another window (the owner's own session).
    const answered = ask('question');
    await until(() => pendingIds().length === 1);
    const qId = pendingIds()[0].id;
    await until(() => shown.has(qId));
    await t.api('POST', `/approvals/${qId}`, { decision: 'approve', answer: 'De map Facturen' });
    await answered;
    await until(() => shown.get(qId)!.closed === 1);
    assert.equal(notes.size, 0);
  } finally {
    await t.close();
  }
});
