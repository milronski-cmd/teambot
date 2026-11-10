import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { spokenNamesHint } from '../server/modules/voice/names-hint.js';

/**
 * B-52 (acceptance round 4): "Vraag aan Onderzoeker …" was heard as "Vraag en onderzoeken …" in a one-to-one call, and
 * the bot said it did not know which bot was meant. A spoken message now tells the bot its colleagues' names.
 */

test('the hint lists the other bots, not the bot itself or archived ones', () => {
  const h = spokenNamesHint('a1', [
    { id: 'a1', name: 'Assistent' },
    { id: 'a2', name: 'Onderzoeker' },
    { id: 'a3', name: 'Codex' },
    { id: 'a4', name: 'Oud', archived: 1 },
  ])!;
  assert.match(h, /Onderzoeker, Codex\./);
  assert.doesNotMatch(h, /Assistent|Oud/);
  assert.equal(spokenNamesHint('a1', [{ id: 'a1', name: 'Assistent' }]), null);
  const many = spokenNamesHint('x', Array.from({ length: 30 }, (_, i) => ({ id: `b${i}`, name: `Bot ${i}` })), 25)!;
  assert.match(many, /Bot 24 \(en 5 meer\)/);
});

test('a spoken message gives a bot with team tools the names of its colleagues; a typed one does not', async () => {
  const t = await startTestApp();
  try {
    const self = await t.agent({ name: 'Assistent', tool_groups: ['team'] });
    await t.agent({ name: 'Onderzoeker' });
    const solo = await t.agent({ name: 'Solo', tool_groups: [] });
    const thread = await t.api('POST', '/threads', { agentId: self.id });
    const ctxOf = async (agent: any, input: any) => {
      const out: string[] = [];
      for (const h of t.app.ctx.hooks.turnContext) {
        const r = await h({ agent, thread, userId: agent.user_id, input });
        if (r) out.push(r);
      }
      return out.join('\n');
    };
    const spoken = { role: 'user', content: 'Vraag en onderzoeken wat de hoofdstad van Duitsland is', parts: { voice: { via: 'call' } } };
    const typed = { role: 'user', content: 'Vraag aan Onderzoeker wat de hoofdstad van Duitsland is', parts: {} };
    const a = t.app.ctx.store.agent(self.id)!;
    assert.match(await ctxOf(a, spoken), /collega-bots heten: Onderzoeker, Solo\./);
    assert.doesNotMatch(await ctxOf(a, typed), /collega-bots/);
    // Without the team tools the bot cannot hand work on, so no list.
    assert.doesNotMatch(await ctxOf(t.app.ctx.store.agent(solo.id)!, spoken), /collega-bots/);
  } finally {
    await t.close();
  }
});
