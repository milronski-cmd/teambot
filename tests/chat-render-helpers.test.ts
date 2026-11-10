import { test } from 'node:test';
import assert from 'node:assert/strict';
import { endsInOpenFence, isMermaidLang, looksLikeMermaid, shouldDrawMermaid, svgSize } from '../ui/src/lib/mermaidBlock.js';
import { stripKindPrefix, threadSubtitle } from '../ui/src/lib/threadTitle.js';
import { botModelText, isDefaultModel, prettyModel } from '../shared/modelLabel.js';
import { startTestApp } from './helpers.js';

/** Mermaid in bot answers: which code blocks are drawn, and when (not while the block is still streaming). */

test('mermaid: language detection', () => {
  assert.equal(isMermaidLang('language-mermaid'), true);
  assert.equal(isMermaidLang('hljs language-Mermaid'), true);
  assert.equal(isMermaidLang('language-mmd'), true);
  assert.equal(isMermaidLang('language-js'), false);
  assert.equal(isMermaidLang('language-mermaid-js'), false);
  assert.equal(isMermaidLang(undefined), false);
});

test('mermaid: an open fence at the end (still streaming) is not drawn yet', () => {
  const closed = 'Kijk:\n\n```mermaid\ngraph TD\n  A --> B\n```\n';
  const open = 'Kijk:\n\n```mermaid\ngraph TD\n  A --> B';
  assert.equal(endsInOpenFence(closed), false);
  assert.equal(endsInOpenFence(open), true);
  assert.equal(endsInOpenFence('```js\nx\n```\n\n~~~\nopen'), true);
  // A longer or different fence does not close a block; a fence with an info string opens a new one.
  assert.equal(endsInOpenFence('````mermaid\ngraph TD\n```\nA-->B\n````'), false);
  assert.equal(endsInOpenFence('```mermaid\ngraph TD\n~~~\n'), true);
  const code = 'graph TD\n  A --> B';
  assert.equal(shouldDrawMermaid({ className: 'language-mermaid', code, markdown: closed, isLastBlock: true }), true);
  assert.equal(shouldDrawMermaid({ className: 'language-mermaid', code, markdown: open, isLastBlock: true }), false);
  // An earlier, closed block is drawn even while a later one is still open.
  assert.equal(shouldDrawMermaid({ className: 'language-mermaid', code, markdown: closed + '\n```python\nprint(1)', isLastBlock: false }), true);
  assert.equal(shouldDrawMermaid({ className: 'language-js', code, markdown: closed, isLastBlock: false }), false);
});

test('mermaid: only text that starts like a diagram is tried', () => {
  assert.equal(looksLikeMermaid('flowchart LR\n a-->b'), true);
  assert.equal(looksLikeMermaid('%% comment\nsequenceDiagram\n A->>B: hi'), true);
  assert.equal(looksLikeMermaid('---\ntitle: Plan\n---\ngantt\n title x'), true);
  assert.equal(looksLikeMermaid('pie title Huisdieren\n "Honden" : 3'), true);
  assert.equal(looksLikeMermaid('hello world'), false);
  assert.equal(looksLikeMermaid(''), false);
  assert.equal(shouldDrawMermaid({ className: 'language-mermaid', code: 'x'.repeat(50_001), markdown: '', isLastBlock: false }), false);
});

test('mermaid: image size from the viewBox', () => {
  assert.deepEqual(svgSize('<svg id="a" width="100%" viewBox="0 0 412.5 230" style="max-width: 412.5px;">'), { width: 412.5, height: 230 });
  assert.deepEqual(svgSize("<svg viewBox='-8 -8 100,50'>"), { width: 100, height: 50 });
  assert.equal(svgSize('<svg width="10">'), null);
});

test('routine header: "Routine · Weekmenu", never "Routine · Routine · Weekmenu"', () => {
  assert.equal(threadSubtitle('Routine', 'Routine · Weekmenu'), 'Routine · Weekmenu');
  assert.equal(threadSubtitle('Routine', 'Weekmenu'), 'Routine · Weekmenu');
  assert.equal(threadSubtitle('Routine', 'Routine · Routine · Weekmenu'), 'Routine · Weekmenu');
  assert.equal(threadSubtitle('Routine', ''), 'Routine');
  assert.equal(threadSubtitle('Routine', 'Routine'), 'Routine');
  assert.equal(threadSubtitle('Subtaak', 'Zoek een recept'), 'Subtaak · Zoek een recept');
  assert.equal(stripKindPrefix('Routine · Weekmenu', 'Routine'), 'Weekmenu');
  assert.equal(stripKindPrefix('Routinematig werk', 'Routine'), 'Routinematig werk');
  assert.equal(stripKindPrefix(null, 'Routine'), '');
});

test('bot card model: the chosen model in words; "default" shows the model really used, never "default"', () => {
  assert.equal(prettyModel('claude-opus-5-5'), 'Opus 5.5');
  assert.equal(prettyModel('claude-haiku-4-5-20251001'), 'Haiku 4.5');
  assert.equal(prettyModel('claude-sonnet-4-6[1m]'), 'Sonnet 4.6 (1M)');
  assert.equal(prettyModel('claude-3-7-sonnet-20250219'), 'Sonnet 3.7');
  assert.equal(prettyModel('opus'), 'Opus');
  assert.equal(prettyModel('gpt-5.4-mini'), 'gpt-5.4-mini');
  assert.equal(isDefaultModel('default'), true);
  assert.equal(isDefaultModel(''), true);
  assert.equal(isDefaultModel('opus'), false);
  assert.equal(botModelText('default', 'claude-opus-5-5'), 'Opus 5.5');
  assert.equal(botModelText('default'), 'standaardmodel');
  assert.equal(botModelText('', 'default'), 'standaardmodel');
  assert.equal(botModelText('opus', 'claude-opus-5-5'), 'Opus');
  // Acceptance round 4: "opencode/big-pickle" in the limit line, "claude-sonnet-5-5" in the OpenBot import preview.
  assert.equal(botModelText('opencode/big-pickle'), 'Big Pickle');
  assert.equal(prettyModel('claude-sonnet-5-5'), 'Sonnet 5.5');
  assert.equal(prettyModel('opencode/glm-5.3-flash-free'), 'GLM-5.3 Flash');
  assert.equal(prettyModel('opencode/deepseek-v4.1-flash-free'), 'DeepSeek V4.1 Flash');
  assert.equal(prettyModel('opencode/flint-40b-free'), 'Flint 40B');
  assert.equal(prettyModel('opencode/nemotron-3.5-super-vl-free'), 'Nemotron 3.5 Super VL');
  assert.equal(prettyModel('anthropic/claude-sonnet-4-5'), 'Sonnet 4.5');
  assert.equal(prettyModel('ollama/qwen3.6-uncensored-snel:latest'), 'qwen3.6-uncensored-snel');
  assert.equal(prettyModel('qwen3.6:latest'), 'qwen3.6');
  assert.equal(prettyModel('openai/gpt-5.4-mini'), 'gpt-5.4-mini', "the vendor's own name stays");
  assert.equal(prettyModel('gpt-6.1-terra'), 'gpt-6.1-terra');
  for (const id of ['opencode/big-pickle', 'opencode/beam-free', 'anthropic/claude-opus-5-5', 'ollama/llama3:latest']) assert.doesNotMatch(prettyModel(id), /\/|:latest|-free$/, id);
});

test('bot cards: /agents/last-models gives the model each bot really used last (own bots only)', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Kaartbot', model: 'default' });
    const b = await t.agent({ name: 'Stille bot' });
    const ins = (model: string, at: string, agentId = a.id, userId = a.user_id) =>
      t.app.ctx.store.insert('usage_log', { user_id: userId, agent_id: agentId, provider_id: t.providerId, model, input: 1, output: 1, cost: 0, value: null, created_at: at });
    const t0 = Date.now();
    ins('claude-sonnet-4-6', new Date(t0 - 3600_000).toISOString());
    ins('claude-opus-5-5', new Date(t0 - 60_000).toISOString());
    ins('claude-haiku-4-5', new Date(t0 - 40 * 86400_000).toISOString(), b.id); // older than 30 days: not shown
    ins('gpt-x', new Date(t0).toISOString(), a.id, 'u_someone_else');
    assert.deepEqual(await t.api('GET', '/agents/last-models'), { [a.id]: 'claude-opus-5-5' });
    // the list and single-bot routes still work next to it
    assert.ok((await t.api('GET', '/agents')).some((x: any) => x.id === a.id));
    assert.equal((await t.api('GET', `/agents/${a.id}`)).name, 'Kaartbot');
  } finally {
    await t.close();
  }
});
