import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

// PRV-06: provider fleet policy (models per shared provider, per-person cap) and team usage allocation.
test('shared provider policy: allowed models and daily cap per person, per-member budgets, admin usage overview', async () => {
  const t = await startTestApp({ modules: [], mode: 'server' });
  try {
    const auth = t.app.ctx.auth;
    const store = t.app.ctx.store;
    const m = auth.createUser({ name: 'Vriend', email: 'vriend@test.local', password: 'geheim1234', role: 'member' });
    const tok = auth.createSession(m.id, 'web', 'x').token;
    const as = async (method: string, p: string, body?: any) => {
      const r = await fetch(`${t.app.url}/api${p}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
      return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
    };

    // The owner shares the provider: members may only use "mock-2", max $0.50 per person per day.
    const prov = await t.api('PATCH', `/providers/${t.providerId}`, { shared: true, config: { memberModels: 'mock-2, ', memberDailyUsd: 0.5 } });
    assert.deepEqual(prov.config.memberModels, ['mock-2']);
    assert.equal(prov.config.memberDailyUsd, 0.5);

    // Saving a bot with another model is refused with a clear message; the allowed model works.
    const bad = await as('POST', '/agents', { name: 'X', provider_id: t.providerId, model: 'mock-1' });
    assert.equal(bad.status, 400);
    assert.match(bad.body.error, /niet toegestaan.*mock-2/);
    const ok = (await as('POST', '/agents', { name: 'Y', provider_id: t.providerId, model: 'mock-2' })).body;
    assert.equal(ok.model, 'mock-2');
    assert.equal((await as('PATCH', `/agents/${ok.id}`, { model: 'mock-1' })).status, 400);

    // A bot without a model gets the first allowed one at run time (even if the database says otherwise).
    store.update('agents', ok.id, { model: '' });
    const th = (await as('POST', '/threads', { agentId: ok.id })).body;
    let usedModel = '';
    t.script.push({ text: 'hoi', check: (r) => (usedModel = r.model) });
    await as('POST', `/threads/${th.id}/messages`, { content: 'hallo' });
    await t.waitIdle(th.id);
    assert.equal(usedModel, 'mock-2');
    // Tampered model in the database is refused at run time.
    store.update('agents', ok.id, { model: 'mock-1' });
    await as('POST', `/threads/${th.id}/messages`, { content: 'nog eens' });
    await t.waitIdle(th.id);
    let last = store.all<any>('SELECT status, error FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', th.id)[0];
    assert.match(String(last.error), /niet toegestaan/);

    // Per-person daily cap on the shared provider.
    store.update('agents', ok.id, { model: 'mock-2' });
    store.insert('usage_log', { user_id: m.id, agent_id: ok.id, provider_id: t.providerId, model: 'mock-2', input: 1, output: 1, cost: 0.6, created_at: new Date().toISOString() });
    await as('POST', `/threads/${th.id}/messages`, { content: 'en nu?' });
    await t.waitIdle(th.id);
    last = store.all<any>('SELECT status, error FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', th.id)[0];
    // Stored with the amount in the source notation ("US$ 0,50"); the page shows it in the reader's (C-17).
    assert.match(String(last.error), /daglimiet van US\$\s0,50 op de gedeelde provider/);

    // The cap holds on a reserve engine too, and is said in the chat (acceptance round 5, C-12: the reserve was
    // skipped silently, the member only saw the main engine's error).
    const broken = await t.api('POST', '/providers', { kind: 'mock', name: 'Kapot gedeeld', shared: true });
    const rb = await as('POST', '/agents', { name: 'R', provider_id: broken.id, model: 'mock-1', settings: { fallbacks: [{ provider_id: t.providerId, model: 'mock-2' }] } });
    assert.equal(rb.status, 200, JSON.stringify(rb.body));
    const rth = (await as('POST', '/threads', { agentId: rb.body.id })).body;
    let reserveCalled = false;
    t.script.push({ error: { message: 'Service unavailable', status: 503 } }, { text: 'mag niet', check: () => (reserveCalled = true) });
    await as('POST', `/threads/${rth.id}/messages`, { content: 'hallo reserve' });
    await t.waitIdle(rth.id);
    assert.equal(reserveCalled, false, 'the reserve on the shared provider is not used over the cap');
    t.script.length = 0;
    const evs = store.messages(rth.id).filter((x: any) => x.role === 'event').map((x: any) => x.content);
    assert.ok(evs.some((x: string) => /^Reserve .+ niet gebruikt: je daglimiet op die gedeelde provider is bereikt\.$/.test(x)), evs.join(' | '));

    // The owner of the provider is not bound by the member policy.
    const own = await t.agent({ model: 'mock-1' });
    const oth = await t.api('POST', '/threads', { agentId: own.id });
    t.script.push({ text: 'prima' });
    const msgs = await t.say(oth.id, 'hallo');
    assert.equal(msgs.at(-1).content, 'prima');

    // Members can't set policy fields on their own providers.
    const mine = await as('POST', '/providers', { kind: 'mock', config: { memberModels: ['x'], memberDailyUsd: 3, defaultModel: 'mock-1' } });
    assert.equal(mine.status, 200);
    assert.equal(mine.body.config.memberModels, undefined);
    assert.equal(mine.body.config.memberDailyUsd, undefined);

    // Team usage allocation: a personal budget overrides the policy default.
    assert.equal((await as('GET', '/admin/usage')).status, 403);
    const set = await t.api('PUT', `/admin/usage/budget/${m.id}`, { dailyBudgetUsd: 2.5 });
    assert.equal(set.budget, 2.5);
    assert.equal((await as('GET', '/my-limits')).body.dailyBudgetUsd, 2.5);
    const usage = await t.api('GET', '/admin/usage?days=7');
    const row = usage.users.find((u: any) => u.id === m.id);
    assert.equal(row.budgetOverride, 2.5);
    assert.ok(row.cost >= 0.6);
    assert.ok(row.providers.some((p: any) => p.id === t.providerId && p.shared));
    // Owner/admins keep their own limit; removing the override falls back to the policy default.
    const owner = auth.owner()!;
    await assert.rejects(t.api('PUT', `/admin/usage/budget/${owner.id}`, { dailyBudgetUsd: 1 }), /alleen voor leden/);
    await t.api('PUT', `/admin/usage/budget/${m.id}`, { dailyBudgetUsd: null });
    assert.equal((await as('GET', '/my-limits')).body.dailyBudgetUsd, 1);
  } finally {
    await t.close();
  }
});

// Acceptance round 5 (C-12): "Modelgegevens" said "Prijs: onbekend" on a shared own endpoint with an own price, for the
// owner's members too. The allowed models now come with that price and its source.
test('shared provider with a model policy: members see the owner\'s own price for the allowed models', async () => {
  const t = await startTestApp({ modules: [], mode: 'server' });
  try {
    const m = t.app.ctx.auth.createUser({ name: 'Sanne', email: 'sanne@test.local', password: 'geheim1234', role: 'member' });
    const tok = t.app.ctx.auth.createSession(m.id, 'web', 'x').token;
    await t.api('PATCH', `/providers/${t.providerId}`, { shared: true, config: { prices: { '*': [100, 500] }, memberModels: 'mock-2' } });
    const own = await t.api('GET', `/providers/${t.providerId}/models`);
    assert.equal(own.find((x: any) => x.id === 'mock-1')?.priceSource, 'eigen');
    const r = await fetch(`${t.app.url}/api/providers/${t.providerId}/models`, { headers: { authorization: `Bearer ${tok}` } });
    const list = (await r.json()) as any[];
    assert.deepEqual(list.map((x) => x.id), ['mock-2'], 'only the allowed model');
    assert.deepEqual(list[0].price, [100, 500]);
    assert.equal(list[0].priceSource, 'eigen');
  } finally {
    await t.close();
  }
});
