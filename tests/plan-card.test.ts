import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers.js';
import { normalizePlan, planTool } from '../server/tools/builtin/plan.js';
import { handleCodexExecLine } from '../server/modules/cli-agents/codex.js';
import { handleClaudeLine } from '../server/modules/cli-agents/claude.js';
import { makeScope } from '../server/modules/cli-agents/context.js';
import { teambotTools } from '../server/modules/cli-agents/toolhost.js';
import { planProgress } from '../ui/src/lib/plan.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const FAKE_ACP = path.join(here, 'fixtures', 'cli-agents-fake-acp.mjs');

test('plan shapes of every engine become the same checklist', () => {
  // Codex exec todo_list, Codex app-server turn/plan, ACP plan entries, Claude TodoWrite, TeamBot's plan_update
  assert.deepEqual(normalizePlan([{ text: 'Lezen', completed: true }, { text: 'Schrijven', completed: false }]), [{ text: 'Lezen', status: 'completed' }, { text: 'Schrijven', status: 'pending' }]);
  assert.deepEqual(normalizePlan([{ step: 'Testen', status: 'inProgress' }]), [{ text: 'Testen', status: 'in_progress' }]);
  assert.deepEqual(normalizePlan([{ content: 'Stap 1', priority: 'high', status: 'in_progress' }]), [{ text: 'Stap 1', status: 'in_progress' }]);
  assert.deepEqual(normalizePlan([{ content: 'Bouwen', status: 'completed', activeForm: 'Bouwt' }]), [{ text: 'Bouwen', status: 'completed' }]);
  assert.equal(normalizePlan([{ text: '   ' }, 'x', null]), null);
  assert.equal(normalizePlan('geen lijst'), null);
  assert.equal(normalizePlan(Array.from({ length: 50 }, (_, i) => ({ text: `s${i}` })))!.length, 30);
  assert.deepEqual(planProgress([{ text: 'a', status: 'completed' }, { text: 'b', status: 'pending' }]), { done: 1, total: 2, percent: 50, label: '1 van 2 klaar' });
  assert.equal(planProgress([{ text: 'a', status: 'completed' }]).label, 'Alles klaar');
});

test('engines emit their own plans as plan events', () => {
  const events: any[] = [];
  const s: any = { emit: (e: any) => events.push(e), activity: () => {}, req: { sessionId: undefined }, apps: undefined };
  handleCodexExecLine(s, { text: '', reasoning: '', usage: { input: 0, output: 0 }, failed: null, sawThread: false }, JSON.stringify({ type: 'item.updated', item: { type: 'todo_list', items: [{ text: 'Lezen', completed: true }, { text: 'Samenvatten', completed: false }] } }));
  assert.deepEqual(events.at(-1), { type: 'plan', steps: [{ text: 'Lezen', status: 'completed' }, { text: 'Samenvatten', status: 'pending' }] });
  const st: any = { text: '', reasoning: '', streamedMsgs: new Set(), currentMsg: null, needSep: false, tools: new Map(), result: null, initSeen: true };
  handleClaudeLine(s, st, JSON.stringify({ type: 'assistant', message: { id: 'm1', content: [{ type: 'tool_use', id: 't1', name: 'TodoWrite', input: { todos: [{ content: 'Plannen', status: 'in_progress', activeForm: 'Plant' }] } }] } }));
  assert.deepEqual(events.at(-1), { type: 'plan', steps: [{ text: 'Plannen', status: 'in_progress' }] });
});

test('plan_update: an API bot shows one plan card per turn, on its latest message, without a tool chip of its own', async () => {
  const t = await startTestApp();
  try {
    assert.equal((await planTool().run({ steps: 'kapot' }, {} as any) as any).isError, true);
    const a = await t.agent({ access_mode: 'readonly' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push(
      { text: 'Ik maak een plan.', toolCalls: [{ name: 'plan_update', args: { steps: [{ text: 'Bronnen zoeken', status: 'in_progress' }, { text: 'Samenvatten', status: 'pending' }] } }] },
      { text: 'Bronnen gevonden.', toolCalls: [{ name: 'plan_update', args: { steps: [{ text: 'Bronnen zoeken', status: 'completed' }, { text: 'Samenvatten', status: 'in_progress' }] } }] },
      { text: 'Klaar.' },
    );
    const msgs = await t.say(th.id, 'Zoek iets uit');
    const withPlan = msgs.filter((m) => m.role === 'assistant' && m.parts.plan);
    assert.equal(withPlan.length, 1, 'one card per turn, moved along');
    assert.deepEqual(withPlan[0].parts.plan.steps, [{ text: 'Bronnen zoeken', status: 'completed' }, { text: 'Samenvatten', status: 'in_progress' }]);
    const tool = msgs.filter((m) => m.role === 'tool' && m.parts.toolResult?.name === 'plan_update');
    assert.deepEqual(tool.map((x) => x.content), ['Plan bijgewerkt: 0 van 2 klaar.', 'Plan bijgewerkt: 1 van 2 klaar.']);
  } finally {
    await t.close();
  }
});

test('ACP agent plan → plan card on the CLI answer, and plan_update is offered to CLI bots over MCP', async () => {
  const t = await startTestApp();
  const file = path.join(t.dir, 'fake-cli.log');
  process.env.FAKE_CLI_LOG = file;
  try {
    const p = await t.api('POST', '/providers', { kind: 'acp-custom', config: { command: FAKE_ACP, args: [] } });
    const a = await t.api('POST', '/agents', { name: 'AcpPlan', provider_id: p.id, model: '', access_mode: 'ask' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const msgs = await t.say(th.id, 'Doe iets');
    const m = msgs.filter((x) => x.role === 'assistant').at(-1)!;
    assert.deepEqual(m.parts.plan?.steps, [{ text: 'Stap 1', status: 'in_progress' }], 'the fake ACP agent sends a plan update');
    assert.ok(!m.parts.activity?.some((x: any) => x.kind === 'plan'), 'no extra step line for the plan');
    // plan_update is in the list of every CLI bot (its definition says when to use it).
    const scope = makeScope(t.app.ctx, t.app.ctx.providers.config(p.id)!, { model: '', system: '', prompt: 'x', attachments: [], workspace: a.workspace, accessMode: a.access_mode, agentId: a.id, threadId: th.id, runId: t.app.ctx.store.one<{ id: string }>('SELECT id FROM runs WHERE thread_id = ?', th.id)!.id, userId: a.user_id }, new AbortController().signal, () => {});
    for (const engine of ['acp', 'claude', 'codex'] as const) {
      const listed = await teambotTools(scope, { engine }).list();
      assert.match(listed.find((x) => x.name === 'plan_update')?.description || '', /drie of meer stappen/, `${engine}: plan_update is listed`);
    }
  } finally {
    delete process.env.FAKE_CLI_LOG;
    await t.close();
  }
});
