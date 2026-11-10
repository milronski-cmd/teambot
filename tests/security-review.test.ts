import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

async function member(t: any, name = 'Lid') {
  const u = t.app.ctx.auth.createUser({ name, email: `${name.toLowerCase()}${Date.now()}@test.local`, password: 'geheim1234', role: 'member' });
  const tok = t.app.ctx.auth.createSession(u.id, 'web', 'x').token;
  const as = async (method: string, p: string, body?: any) => {
    const r = await fetch(`${t.app.url}/api${p}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
  return { u, as };
}

test('a member can never run the owner\'s bot (resume/retry with a foreign agentId)', async () => {
  const t = await startTestApp({ modules: [], mode: 'server' });
  try {
    await t.api('PATCH', `/providers/${t.providerId}`, { shared: true });
    const ownerBot = await t.agent({ name: 'Eigenaarsbot', access_mode: 'auto', tool_groups: ['files'] });
    const m = await member(t);
    const mine = (await m.as('POST', '/threads', {})).body;
    await m.as('POST', `/threads/${mine.id}/messages`, { content: 'hallo' });
    const before = t.requests.length;
    for (const path of ['resume', 'retry']) await m.as('POST', `/threads/${mine.id}/${path}`, { agentId: ownerBot.id });
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(t.requests.length, before, 'the owner bot never ran');
    const runs = t.app.ctx.store.all('SELECT * FROM runs WHERE agent_id = ?', ownerBot.id);
    assert.equal(runs.length, 0);
  } finally {
    await t.close();
  }
});

test('owner-only message parts (memory context, raw) never reach other viewers', async () => {
  const { publicView } = await import('../server/agent/chat.js');
  const m: any = { id: 'x', parts: { context: 'geheim', contextByAgent: { a: 'geheim' }, raw: { provider: 'p', data: 1 }, toolCalls: [] } };
  const v: any = publicView(m);
  assert.equal(v.parts.context, undefined);
  assert.equal(v.parts.contextByAgent, undefined);
  assert.equal(v.parts.raw, undefined);
  assert.deepEqual(v.parts.toolCalls, []);
  assert.equal(m.parts.context, 'geheim', 'original untouched');
});

test('uploaded SVG/HTML (any letter case) is never served inline without a sandbox', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    for (const ct of ['image/SVG+XML', 'text/HTML', 'application/xhtml+xml']) {
      const up = await fetch(`${t.app.url}/api/attachments?name=x`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': ct }, body: '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>' });
      const a: any = await up.json();
      const r = await fetch(`${t.app.url}/api/attachments/${a.id}`, { headers: { authorization: `Bearer ${t.token}` } });
      assert.match(r.headers.get('content-security-policy') || '', /sandbox/, ct);
      assert.match(r.headers.get('content-disposition') || '', /^attachment/, ct);
    }
    const png = await fetch(`${t.app.url}/api/attachments?name=p.png`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'image/png' }, body: Buffer.from('iVBORw0KGgo=', 'base64') });
    const p: any = await png.json();
    const r = await fetch(`${t.app.url}/api/attachments/${p.id}`, { headers: { authorization: `Bearer ${t.token}` } });
    assert.match(r.headers.get('content-disposition') || '', /^inline/);
  } finally {
    await t.close();
  }
});
