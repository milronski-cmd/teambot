import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

test('ask_form asks a structured question and returns JSON', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const a = await t.agent({ access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    // A field type outside the schema's enum is refused before anything is asked (full schema check, 0.4.4), with the
    // exact place; the corrected call goes through. The tool's own fallback to "text" stays as a second line of defence.
    t.script.push({ toolCalls: [{ name: 'ask_form', args: { title: 'Afspraak', fields: [{ name: 'datum', label: 'Datum', type: 'date', required: true }, { name: 'x y!', label: 'Raar', type: 'evil' }] } }] });
    t.script.push({ toolCalls: [{ name: 'ask_form', args: { title: 'Afspraak', fields: [{ name: 'datum', label: 'Datum', type: 'date', required: true }, { name: 'aantal', label: 'Aantal', type: 'number' }, { name: 'x y!', label: 'Raar', type: 'text' }] } }] });
    t.script.push({ text: 'Dank je' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'plan iets' });
    let pending: any[] = [];
    for (let i = 0; i < 100 && !pending.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      pending = await t.api('GET', '/approvals');
    }
    assert.equal(pending.length, 1);
    assert.equal(pending[0].tool, 'ask_form');
    assert.equal(pending[0].kind, 'question');
    assert.equal(pending[0].input.fields[2].type, 'text');
    assert.equal(pending[0].input.fields[2].name, 'x_y_', 'field names are sanitized');
    await t.api('POST', `/approvals/${pending[0].id}`, { decision: 'approve', answer: JSON.stringify({ datum: '2026-11-07', aantal: 3 }) });
    await t.waitIdle(th.id);
    const toolMsgs = t.app.ctx.store.messages(th.id).filter((m: any) => m.role === 'tool');
    assert.match(toolMsgs[0].content, /Argument fields\/1\/type moet een van deze waarden zijn/, 'unknown field type: corrected, not asked');
    assert.match(toolMsgs[1].content, /"datum":"2026-11-07"/);
  } finally {
    await t.close();
  }
});

test('show_html stores a sandboxed html attachment', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const a = await t.agent({ access_mode: 'readonly' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'show_html', args: { title: 'Grafiek', html: '<html><head></head><body><script>document.body.textContent="hi"</script></body></html>' } }] });
    t.script.push({ text: 'Klaar' });
    const msgs = await t.say(th.id, 'maak een grafiek');
    const toolMsg = msgs.find((m: any) => m.role === 'tool');
    const att = toolMsg!.parts.attachments![0];
    assert.equal(att.mime, 'text/html');
    const res = await fetch(`${t.app.url}/api/attachments/${att.id}`, { headers: { authorization: `Bearer ${t.token}` } });
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-security-policy') || '', /sandbox/);
    // Signed preview URL: works without session, has its own sandbox CSP, rejects tampering, and is per-user.
    const { url } = await t.api('POST', `/attachments/${att.id}/preview`);
    const p = await fetch(t.app.url + url);
    assert.equal(p.status, 200);
    const csp = p.headers.get('content-security-policy') || '';
    assert.match(csp, /sandbox allow-scripts/);
    assert.match(csp, /default-src 'none'/);
    assert.match(await p.text(), /document\.body/);
    assert.equal((await fetch(t.app.url + url.slice(0, -3) + 'abc')).status, 404);
    const other = t.app.ctx.auth.createUser({ name: 'Ander', email: 'a2@test.local', password: 'geheim1234', role: 'member' });
    const s2 = t.app.ctx.auth.createSession(other.id, 'web', 'x');
    assert.equal((await fetch(`${t.app.url}/api/attachments/${att.id}/preview`, { method: 'POST', headers: { authorization: `Bearer ${s2.token}` } })).status, 404);
  } finally {
    await t.close();
  }
});

test('own prices per provider make cost estimates work for any model', async () => {
  const { estimateCost } = await import('../server/providers/pricing.js');
  assert.equal(estimateCost('openai', 'some-new-model', 1_000_000, 0), null, 'unknown without own price');
  assert.equal(estimateCost('openai', 'some-new-model', 1_000_000, 1_000_000, 0, { prices: { 'some-new-model': [1, 4] } }), 5);
  assert.equal(estimateCost('openai', 'other', 2_000_000, 0, 0, { prices: { '*': [0.5, 2] } }), 1);
  assert.equal(estimateCost('openai', 'x', 1_000_000, 0, 0, { prices: { x: ['1', 2] } }), null, 'invalid price ignored');
  assert.equal(estimateCost('ollama', 'llama', 1_000_000, 1_000_000), 0, 'local is free');
});

test('the daily budget stops paid engines only: local, free and subscription bots keep working (acceptance round 4, B-70)', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const { mockAdapter } = await import('./helpers.js');
    for (const [id, extra] of [['mock-local', { type: 'api', billing: 'local' }], ['mock-cli', { type: 'cli', billing: 'subscription' }]] as const)
      t.app.ctx.providers.registerKind({ id, label: id, needsKey: false, description: 'test', models: ['mock-1'], defaultModel: 'mock-1', create: () => mockAdapter(t.script, t.requests), ...extra } as any);
    const owner = t.app.ctx.auth.owner()!.id;
    await t.api('PUT', '/settings', { dailyBudgetUsd: 0.3 });
    t.app.ctx.store.insert('usage_log', { user_id: owner, agent_id: null, provider_id: t.providerId, model: 'mock-1', input: 1, output: 1, cost: 0.4, created_at: new Date().toISOString() });
    const ask = async (providerId: string) => {
      const a = await t.agent({ provider_id: providerId, name: `Bot ${providerId.slice(-4)}` });
      const th = await t.api('POST', '/threads', { agentId: a.id });
      t.script.push({ text: 'Gelukt' });
      const msgs = await t.say(th.id, 'hallo');
      return msgs.filter((m: any) => m.role === 'assistant').at(-1)!;
    };
    // A paid engine is stopped …
    const paid = await ask(t.providerId);
    assert.match(paid.parts?.error || '', /Daglimiet/);
    // … a local engine and a CLI on its own subscription (never reported a cost) are not.
    const local = await t.api('POST', '/providers', { kind: 'mock-local' });
    const cli = await t.api('POST', '/providers', { kind: 'mock-cli' });
    for (const p of [local, cli]) {
      const m = await ask(p.id);
      assert.equal(m.parts?.error, undefined, `${p.kind} should not be stopped`);
      assert.equal(m.content, 'Gelukt');
    }
    // A CLI that reports costs (pay-per-use key) counts again.
    t.app.ctx.store.insert('usage_log', { user_id: owner, agent_id: null, provider_id: cli.id, model: 'mock-1', input: 1, output: 1, cost: 0.01, created_at: new Date().toISOString() });
    assert.match((await ask(cli.id)).parts?.error || '', /Daglimiet/);
  } finally {
    await t.close();
  }
});

test('a run that fails before answering shows the error in the chat (not silently)', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    await t.api('PUT', '/settings', { dailyBudgetUsd: 0.000001 });
    t.app.ctx.store.insert('usage_log', { user_id: t.app.ctx.auth.owner()!.id, agent_id: a.id, provider_id: t.providerId, model: 'mock-1', input: 1, output: 1, cost: 1, created_at: new Date().toISOString() });
    const msgs = await t.say(th.id, 'hallo');
    const err = msgs.find((m: any) => m.role === 'assistant' && m.status === 'error');
    assert.ok(err, 'error message visible in chat');
    assert.match(err!.parts.error!, /Daglimiet/);
    assert.equal(err!.author_id, a.id);
    // Retrying works once the cause is fixed, and the error bubble is not sent to the model as history.
    await t.api('PUT', '/settings', { dailyBudgetUsd: 0 });
    t.script.push({ text: 'Gelukt' });
    await t.api('POST', `/threads/${th.id}/retry`);
    await t.waitIdle(th.id);
    const req = t.requests[t.requests.length - 1];
    assert.ok(!req.messages.some((m) => m.role === 'assistant'), 'empty error bubble not replayed');
  } finally {
    await t.close();
  }
});

test('group threads freeze a separate turn context per bot', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const a = await t.agent({ name: 'Een' });
    const b = await t.agent({ name: 'Twee' });
    t.app.ctx.hooks.turnContext.push(({ agent }) => `context voor ${agent.name}`);
    const th = t.app.ctx.store.createThread({ user_id: t.app.ctx.auth.owner()!.id, agent_id: null, kind: 'room' });
    const u = t.app.ctx.auth.owner()!;
    const msg = t.app.ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: u.id, author_name: u.name, content: 'Hallo allebei' });
    t.script.push({ text: 'Ik ben Een' }, { text: 'Ik ben Twee' });
    const r1 = t.app.ctx.chat.startAgent(th, a.id, msg.id, 'test');
    await t.app.ctx.runs.waitFor(r1!.id, 5000);
    const r2 = t.app.ctx.chat.startAgent(th, b.id, msg.id, 'test');
    await t.app.ctx.runs.waitFor(r2!.id, 5000);
    const sent1 = JSON.stringify(t.requests[0].messages);
    const sent2 = JSON.stringify(t.requests[1].messages);
    assert.match(sent1, /context voor Een/);
    assert.doesNotMatch(sent1, /context voor Twee/);
    assert.match(sent2, /context voor Twee/);
    assert.doesNotMatch(sent2, /context voor Een/);
  } finally {
    await t.close();
  }
});

test('fork copies the conversation up to a message into a new thread, original untouched', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Antwoord 1' }, { text: 'Antwoord 2' });
    await t.say(th.id, 'Vraag 1');
    const msgs = await t.say(th.id, 'Vraag 2');
    const firstAnswer = msgs.find((m: any) => m.content === 'Antwoord 1');
    const fork = await t.api('POST', `/threads/${th.id}/fork`, { messageId: firstAnswer.id });
    const copied = t.app.ctx.store.messages(fork.id).filter((m: any) => m.role !== 'event').map((m: any) => m.content);
    assert.deepEqual(copied, ['Vraag 1', 'Antwoord 1']);
    assert.equal(t.app.ctx.store.messages(th.id).filter((m: any) => m.role !== 'event').length, 4, 'original untouched');
    t.script.push({ text: 'Antwoord in tak' });
    await t.say(fork.id, 'Andere vraag 2');
    const req = t.requests[t.requests.length - 1];
    assert.ok(!JSON.stringify(req.messages).includes('Vraag 2'), 'branch history does not contain the original continuation');
    assert.equal(await t.api('POST', `/threads/${th.id}/fork`, { messageId: 'nope' }).catch((e) => e.message.includes('400')), true);
  } finally {
    await t.close();
  }
});

test('danger tools always ask, even with a per-tool allow policy', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const b = t.app.ctx.broker;
    const agent: any = { access_mode: 'auto', tool_policy: { pay: 'allow', zap: 'deny', w: 'allow' } };
    assert.equal(b.decide(agent, { name: 'pay', risk: 'danger' }), 'ask');
    assert.equal(b.decide(agent, { name: 'zap', risk: 'danger' }), 'deny', 'deny still wins');
    assert.equal(b.decide(agent, { name: 'w', risk: 'write' }), 'allow');
    assert.equal(b.decide({ ...agent, access_mode: 'readonly' }, { name: 'w', risk: 'write' }), 'deny');
  } finally {
    await t.close();
  }
});

test('auto review: allowed actions run, suspicious ones become a human approval, errors fail closed', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const a = await t.agent({ access_mode: 'auto', tool_groups: ['files'], settings: { autoReview: true } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    // 1) reviewer says allow → write runs without asking
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'ok.txt', content: 'hoi' } }] }, { text: '{"verdict":"allow","reason":"past bij de opdracht"}' }, { text: 'Klaar' });
    await t.say(th.id, 'Schrijf hoi naar ok.txt');
    assert.equal((await t.api('GET', '/approvals')).length, 0);
    const req = t.requests[1];
    assert.match(req.system, /veiligheidscontroleur/);
    // 2) reviewer says ask → approval with the reason, nothing written before approval
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'stiekem.txt', content: 'x' } }] }, { text: '{"verdict":"ask","reason":"niet gevraagd door de gebruiker"}' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Lees de webpagina' });
    let ap: any[] = [];
    for (let i = 0; i < 100 && !ap.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      ap = await t.api('GET', '/approvals');
    }
    assert.equal(ap.length, 1);
    assert.match(ap[0].summary, /Automatische controle: niet gevraagd/);
    t.script.push({ text: 'Oké, niet gedaan' });
    await t.api('POST', `/approvals/${ap[0].id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
    const ws = t.app.ctx.store.agent(a.id)!.workspace;
    const fs = await import('node:fs');
    assert.ok(fs.existsSync(`${ws}/ok.txt`));
    assert.ok(!fs.existsSync(`${ws}/stiekem.txt`));
    // 3) reviewer garbage → fail closed (ask)
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'z.txt', content: 'z' } }] }, { text: 'ik weet het niet' });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'nog een' });
    ap = [];
    for (let i = 0; i < 100 && !ap.length; i++) {
      await new Promise((r) => setTimeout(r, 20));
      ap = await t.api('GET', '/approvals');
    }
    assert.equal(ap.length, 1, 'unparseable verdict asks the human');
    t.script.push({ text: 'ok' });
    await t.api('POST', `/approvals/${ap[0].id}`, { decision: 'deny' });
    await t.waitIdle(th.id);
  } finally {
    await t.close();
  }
});
