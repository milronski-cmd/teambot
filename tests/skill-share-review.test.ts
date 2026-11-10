import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

const SKILL = `---
name: weekplanner
description: Maakt een weekplanning uit losse taken.
license: MIT
---
# Weekplanner

Zet de taken in een tabel per dag. Lees daarna https://example.com/tips voor extra tips.
`;

test('sharing on the server (B-11): a member submits, an admin sees the scan and content and approves or rejects; others see only approved items', async () => {
  const t = await startTestApp({ mode: 'server' });
  try {
    const auth = t.app.ctx.auth;
    const mk = (name: string, email: string) => {
      const u = auth.createUser({ name, email, password: 'geheim1234', role: 'member' });
      const tok = auth.createSession(u.id, 'web', 'x').token;
      const as = async (method: string, p: string, body?: any) => {
        const r = await fetch(`${t.app.url}/api${p}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
        return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
      };
      return { u, as };
    };
    const lid = mk('Lid', 'lid@test.local');
    const ander = mk('Ander', 'ander@test.local');
    const notes: any[] = [];
    const off = t.app.ctx.events.on('notification', (e: any) => notes.push({ to: e.userId, ...e.data }));

    const pv = await lid.as('POST', '/skills/import/preview', { kind: 'paste', text: SKILL });
    const c = await lid.as('POST', '/skills/import/commit', { stagingId: pv.body.stagingId });
    const skillId = c.body.results[0].skillId;
    const shared = await lid.as('POST', '/skills/shares', { type: 'skill', skillId });
    assert.equal(shared.status, 200);
    assert.equal(shared.body.status, 'pending', 'a member\'s share is submitted, not published');
    const owner = t.app.ctx.auth.owner()!;
    assert.ok(notes.some((n) => n.to === owner.id && /Ter beoordeling: weekplanner/.test(n.title) && /Lid wil een skill delen/.test(n.body)), 'the owner is told there is something to review');

    // Nobody sees it yet, the submitter sees "wacht op beoordeling".
    const visible = async (who: { as: any }) => ((await who.as('GET', '/skills/market/skills?q=weekplanner')).body.items || []).some((i: any) => i.title === 'weekplanner' && i.catalogId === 'server');
    assert.equal(await visible(ander), false);
    assert.equal((await lid.as('GET', '/skills/shares')).body[0].status, 'pending');
    // Members cannot review.
    assert.equal((await ander.as('GET', '/skills/shares/review')).status, 404);

    // The owner sees the scan and the content.
    const queue = await t.api('GET', '/skills/shares/review');
    assert.equal(queue.length, 1);
    assert.equal(queue[0].by, 'Lid');
    assert.ok(queue[0].scan && Array.isArray(queue[0].scan.findings), 'scan shown');
    assert.ok(queue[0].scan.domains.includes('example.com'), 'external addresses shown');
    assert.match(queue[0].skillMd, /Zet de taken in een tabel per dag/);
    assert.ok(queue[0].files.some((f: any) => f.path === 'SKILL.md'));

    // Rejecting needs a reason, which the submitter gets.
    await assert.rejects(t.api('POST', `/skills/shares/${queue[0].id}/review`, { decision: 'reject' }), /reden/);
    await t.api('POST', `/skills/shares/${queue[0].id}/review`, { decision: 'reject', reason: 'Verwijs niet naar externe tips' });
    assert.equal(await visible(ander), false);
    const mine = (await lid.as('GET', '/skills/shares')).body[0];
    assert.equal(mine.status, 'rejected');
    assert.equal(mine.review.reason, 'Verwijs niet naar externe tips');
    assert.ok(notes.some((n) => n.to === lid.u.id && /Niet gedeeld: weekplanner/.test(n.title) && /externe tips/.test(n.body)));

    // Submitting again (e.g. after a fix) goes back into the queue; approval makes it visible to everyone.
    assert.equal((await lid.as('POST', '/skills/shares', { type: 'skill', skillId })).body.status, 'pending');
    const again = await t.api('GET', '/skills/shares/review');
    await t.api('POST', `/skills/shares/${again[0].id}/review`, { decision: 'approve' });
    assert.equal(await visible(ander), true, 'approved: others find it in the marketplace');
    assert.ok(notes.some((n) => n.to === lid.u.id && /Gedeeld: weekplanner/.test(n.title)));
    await assert.rejects(t.api('POST', `/skills/shares/${again[0].id}/review`, { decision: 'approve' }), /al beoordeeld/);

    // The owner's own share needs no second look.
    const op = await t.api('POST', '/skills/import/preview', { kind: 'paste', text: SKILL.replace(/weekplanner/g, 'dagplanner') });
    const oc = await t.api('POST', '/skills/import/commit', { stagingId: op.stagingId });
    assert.equal((await t.api('POST', '/skills/shares', { type: 'skill', skillId: oc.results[0].skillId })).status, 'approved');
    const kinds = t.app.ctx.store.all<any>('SELECT kind FROM audit').map((r) => r.kind);
    for (const k of ['market.share_submitted', 'market.share_rejected', 'market.share_approved', 'market.shared']) assert.ok(kinds.includes(k), k);
    off();
  } finally {
    await t.close();
  }
});
