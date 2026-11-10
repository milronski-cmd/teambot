import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { Broker } from '../server/tools/broker.js';
import { commandImpact, gate } from '../server/modules/cli-agents/permissions.js';
import type { Agent } from '../server/core/types.js';

const bot = (over: Partial<Agent> = {}): Agent => ({ id: 'ag_1', user_id: 'u1', name: 'Bot', access_mode: 'full', tool_policy: {}, settings: {}, tool_groups: [], ...over }) as Agent;

test('Volledige toegang: normal work without asking, sending to others and payments still ask, deny policy wins', () => {
  const b = new Broker(() => null as any);
  const full = bot();
  assert.equal(b.decide(full, { name: 'read_file', risk: 'read' }), 'allow');
  assert.equal(b.decide(full, { name: 'write_file', risk: 'write' }), 'allow');
  assert.equal(b.decide(full, { name: 'run_command', risk: 'exec' }), 'allow');
  assert.equal(b.decide(full, { name: 'delete_file', risk: 'danger', impact: 'local' }), 'allow', 'local danger (workspace, own desktop) runs');
  assert.equal(b.decide(full, { name: 'mcp_gmail_send', risk: 'danger' }), 'ask', 'unknown danger counts as external');
  const send = { name: 'channel_send', risk: 'danger' as const, impact: (a: any) => (a.to === 'me' ? 'local' : 'external') as any };
  assert.equal(b.decide(full, send, { to: 'me' }), 'allow', 'a message to the owner himself');
  assert.equal(b.decide(full, send, { to: 'klant' }), 'ask', 'a message to someone else');
  const ext = bot({ settings: { fullAccessExternal: true } });
  assert.equal(b.decide(ext, send, { to: 'klant' }), 'allow', 'owner also allowed sending to others');
  assert.equal(b.decide(ext, { name: 'browser_submit', risk: 'danger', impact: 'payment' }), 'ask', 'payments always ask');
  assert.equal(b.decide(bot({ tool_policy: { run_command: 'deny' } }), { name: 'run_command', risk: 'exec' }), 'deny');
  assert.equal(b.decide(bot({ tool_policy: { write_file: 'ask' } }), { name: 'write_file', risk: 'write' }), 'ask', 'explicit per-tool ask is kept');
  assert.equal(b.decide(bot({ settings: {} }), { name: 'x', risk: 'danger', impact: () => { throw new Error('boom'); } }), 'ask', 'impact errors fail safe');
  // other modes unchanged
  assert.equal(b.decide(bot({ access_mode: 'auto' }), { name: 'delete_file', risk: 'danger', impact: 'local' }), 'ask');
  assert.equal(b.decide(bot({ access_mode: 'ask' }), { name: 'write_file', risk: 'write' }), 'ask');
});

test('Volledige toegang for CLI commands: local destruction runs, pushing/publishing asks, the blocklist and the workspace still hold', async () => {
  assert.equal(commandImpact('rm -rf build'), 'local');
  assert.equal(commandImpact('git reset --hard HEAD~1'), 'local');
  assert.equal(commandImpact('git push origin main'), 'external');
  assert.equal(commandImpact('rm -rf dist && npm publish'), 'external');
  assert.equal(commandImpact('ls'), 'local');
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'full' });
    const agent = t.app.ctx.store.agent(a.id)!;
    const gs = { ctx: t.app.ctx, agent, thread: null, run: null, userId: a.user_id, signal: new AbortController().signal, ns: 'claude-code' };
    assert.equal((await gate(gs, { tool: 'Bash', risk: 'danger', summary: 'rm', input: {}, command: 'rm -rf build' })).allow, true);
    assert.equal((await gate(gs, { tool: 'Bash', risk: 'exec', summary: 'x', input: {}, command: 'format c:' })).allow, false, 'hard blocklist');
    assert.equal((await gate(gs, { tool: 'Write', risk: 'write', summary: 'x', input: {}, paths: [path.resolve(a.workspace, '..', '..', 'buiten.txt')] })).allow, false, 'outside the workspace');
    const ac = new AbortController();
    const p = gate({ ...gs, signal: ac.signal }, { tool: 'Bash', risk: 'danger', summary: 'push', input: {}, command: 'git push' });
    const ap = await (async () => {
      for (let i = 0; i < 200; i++) {
        const x = (await t.api('GET', '/approvals')).find((y: any) => y.status === 'pending');
        if (x) return x;
        await new Promise((r) => setTimeout(r, 25));
      }
    })();
    assert.ok(ap, 'git push still asks');
    await t.api('POST', `/approvals/${ap.id}`, { decision: 'deny' });
    assert.equal((await p).allow, false);
  } finally {
    await t.close();
  }
});

test('Volledige toegang: owner only, audited; a full bot deletes in its workspace without an approval card', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ access_mode: 'full', tool_groups: ['files'] });
    assert.equal(a.access_mode, 'full');
    const audit = t.app.ctx.store.all<any>("SELECT * FROM audit WHERE kind = 'agent.full_access'");
    assert.equal(audit.length, 1);
    fs.writeFileSync(path.join(a.workspace, 'oud.txt'), 'weg ermee');
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'delete_file', args: { path: 'oud.txt' } }] }, { text: 'Verwijderd.' });
    await t.say(th.id, 'ruim oud.txt op');
    assert.equal(fs.existsSync(path.join(a.workspace, 'oud.txt')), false);
    assert.equal((await t.api('GET', '/approvals?status=all')).length, 0, 'no approval card');
    // A member can never turn it on.
    const u = t.app.ctx.store.user(a.user_id)!;
    t.app.ctx.store.exec("UPDATE users SET role = 'member' WHERE id = ?", u.id);
    await assert.rejects(t.api('PATCH', `/agents/${a.id}`, { settings: { fullAccessExternal: true } }), /eigenaar/);
    const b = await t.agent({ access_mode: 'ask' }).catch(() => null);
    if (b) await assert.rejects(t.api('PATCH', `/agents/${b.id}`, { access_mode: 'full' }), /eigenaar/);
  } finally {
    await t.close();
  }
});
