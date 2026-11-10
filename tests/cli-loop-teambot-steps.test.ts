// The loop guard of a CLI engine and TeamBot's own tools. Live in 0.4.4: four bots were stopped with "3× achter elkaar
// dezelfde stap (Las een document)" while they read different documents: the engine's step for a TeamBot tool only says
// "Leest een document" until TeamBot's result (with the document's name) is on it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { makeScope } from '../server/modules/cli-agents/context.js';
import { handleClaudeLine } from '../server/modules/cli-agents/claude.js';
import { CliLoopWatch } from '../server/agent/loops.js';

test('three TeamBot tool calls at once are not "the same step three times" before their results are in', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const watch = new CliLoopWatch({ repeat: 3, idle: 6 });
    let stopped: any = null;
    const s = makeScope(t.app.ctx, { id: 'p', kind: 'claude-code' } as any, { agentId: a.id, threadId: th.id, runId: 'run_x', userId: 'u', prompt: '' } as any, new AbortController().signal, (e) => {
      if (e.type === 'activity') stopped = watch.add(e.item) || stopped;
    });
    const st: any = { text: '', reasoning: '', streamedMsgs: new Set(), currentMsg: null, needSep: false, tools: new Map(), result: null, sessionId: 's', initSeen: true, context: null };
    const use = (ids: string[], name: string, input: (id: string) => any) =>
      handleClaudeLine(s, st, JSON.stringify({ type: 'assistant', message: { id: 'm' + ids[0], content: ids.map((id) => ({ type: 'tool_use', id, name, input: input(id) })) }, parent_tool_use_id: null }));
    const result = (id: string) => handleClaudeLine(s, st, JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: id, content: 'ok' }] }, parent_tool_use_id: null }));

    // Three different documents in one go.
    use(['a', 'b', 'c'], 'mcp__teambot__read_document', (id) => ({ path: `${id}.pdf` }));
    assert.equal(stopped, null, 'steps that wait for TeamBot do not count yet');
    for (const id of ['a', 'b', 'c']) {
      s.teambotResult!('read_document', 'tool_result', `TeamBot · Document lezen: ${id}.pdf`, 'tekst');
      result(id);
    }
    assert.equal(stopped, null, 'three different documents are three different steps');

    // The same document three times is still a loop.
    use(['d', 'e', 'f'], 'mcp__teambot__read_document', () => ({ path: 'a.pdf' }));
    assert.equal(stopped, null);
    for (const id of ['d', 'e', 'f']) {
      s.teambotResult!('read_document', 'tool_result', 'TeamBot · Document lezen: a.pdf', 'tekst');
      result(id);
    }
    assert.equal((stopped as any)?.kind, 'repeat');

    // A step the engine finished without TeamBot's result no longer waits.
    use(['g'], 'mcp__teambot__read_document', () => ({ path: 'g.pdf' }));
    assert.equal(st.tools.get('g').item.pending, true);
    result('g');
    assert.equal(st.tools.get('g').item.pending, undefined);
  } finally {
    await t.close();
  }
});
