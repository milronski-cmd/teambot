import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startTestApp } from './helpers.js';

const ROOT = path.parse(process.cwd()).root;

test('members on a shared server cannot escape their bot folder, get a terminal, hit private URLs or exceed the budget cap', async () => {
  const t = await startTestApp({ modules: [], mode: 'server' });
  try {
    const auth = t.app.ctx.auth;
    const m = auth.createUser({ name: 'Vriend', email: 'vriend@test.local', password: 'geheim1234', role: 'member' });
    const tok = auth.createSession(m.id, 'web', 'x').token;
    const as = async (method: string, p: string, body?: any) => {
      const r = await fetch(`${t.app.url}/api${p}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
    };
    // Shared provider from the owner, usable by the member.
    await t.api('PATCH', `/providers/${t.providerId}`, { shared: true });

    // Custom workspace refused, shell group stripped, extra roots stripped.
    assert.equal((await as('POST', '/agents', { name: 'X', workspace: ROOT })).status, 400);
    const a = (await as('POST', '/agents', { name: 'Y', provider_id: t.providerId, model: 'mock-1', tool_groups: ['files', 'shell', 'web'], settings: { extraRoots: [ROOT], allowPrivateNetwork: true } })).body;
    assert.deepEqual(a.tool_groups, ['files', 'web']);
    assert.equal(a.settings.extraRoots, undefined);
    assert.equal(a.settings.allowPrivateNetwork, undefined);
    assert.equal((await as('PATCH', `/agents/${a.id}`, { workspace: path.join(ROOT, "Windows") })).status, 400);

    // Even if the database is tampered with, the runtime filter removes shell and file tools outside the own folder.
    t.app.ctx.store.update('agents', a.id, { tool_groups: ['files', 'shell'], workspace: ROOT });
    const tools = await t.app.ctx.tools.forAgent(t.app.ctx.store.agent(a.id)!, t.app.ctx.store.createThread({ user_id: m.id, agent_id: a.id, kind: 'chat' }));
    assert.ok(!tools.some((x) => x.group === 'shell' || x.group === 'files'), 'no shell/files tools');

    // Provider base URL pointing at a private address is refused for members.
    assert.equal((await as('POST', '/providers', { kind: 'openai-compatible', base_url: 'http://127.0.0.1:11434/v1' })).status, 400);
    assert.equal((await as('POST', '/providers', { kind: 'ollama' })).status, 400, 'default local base URL of ollama refused too');

    // Budget: admin cap applies even if the member sets 0 (= unlimited) or a higher value.
    await t.api('PUT', '/admin/member-policy', { dailyBudgetUsd: 0.5, maxAgents: 2 });
    await as('PUT', '/settings', { dailyBudgetUsd: 0 });
    assert.equal((await as('GET', '/my-limits')).body.dailyBudgetUsd, 0.5);
    await as('PUT', '/settings', { dailyBudgetUsd: 100 });
    assert.equal((await as('GET', '/my-limits')).body.dailyBudgetUsd, 0.5);
    await as('PUT', '/settings', { dailyBudgetUsd: 0.1 });
    assert.equal((await as('GET', '/my-limits')).body.dailyBudgetUsd, 0.1);
    // Max agents.
    assert.equal((await as('POST', '/agents', { name: 'Z' })).status, 200);
    const z = await as('POST', '/agents', { name: 'Te veel' });
    assert.equal(z.status, 400);
    // ...also not via duplicate (or templates / hire proposals, which use the same check).
    const mine = (await as('GET', '/agents')).body.filter((x: any) => x.user_id === m.id);
    assert.equal((await as('POST', `/agents/${mine[0].id}/duplicate`)).status, 400);
    // Members can't change the policy; the owner is unaffected by it.
    assert.equal((await as('PUT', '/admin/member-policy', { allowShell: true })).status, 403);
    const ownerBot = await t.api('POST', '/agents', { name: 'Eigenaar', tool_groups: ['shell'], workspace: t.dir });
    assert.deepEqual(ownerBot.tool_groups, ['shell']);
  } finally {
    await t.close();
  }
});
