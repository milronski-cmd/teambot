/**
 * The bot page shows, right with Instructies, what the owner told the bot in a conversation: the lines under
 * "Opdrachten van de eigenaar" in its Werknotities (ui/src/pages/AgentOrders.tsx reads them with agentRows.ownerOrders
 * from GET /memory/place). One spot for everything this bot must do; editing is on its Geheugen page.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { ORDERS_HEADING, ownerOrders } from '../ui/src/pages/agentRows.js';
import { ORDERS } from '../server/modules/memory/pipeline.js';

process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

test('owner orders: the lines under the heading, up to the next one; nothing when there are none', () => {
  // The page reads the heading the memory module writes.
  assert.equal(ORDERS_HEADING, ORDERS);
  const notes = ['Hoe ik werk: kort.', '', '## Opdrachten van de eigenaar', '- Noem prijzen altijd inclusief btw.', '- Offertes als PDF.', '', '## Bezig met', '- Offerte voor Jansen'].join('\n');
  assert.equal(ownerOrders(notes), '- Noem prijzen altijd inclusief btw.\n- Offertes als PDF.');
  assert.equal(ownerOrders('## Opdrachten van de eigenaar\r\n- Eén regel\r\n### Detail\r\n- hoort erbij'), '- Eén regel\n### Detail\n- hoort erbij');
  assert.equal(ownerOrders('## Bezig met\n- iets'), '');
  assert.equal(ownerOrders(''), '');
  assert.equal(ownerOrders(null), '');
});

test('an order given once in the chat is what the bot page shows next to Instructies', async () => {
  const t = await startTestApp();
  try {
    const bot = await t.agent({ name: 'Sam', instructions: 'Antwoord in het Nederlands.' });
    const place = async () => (await t.api('GET', `/memory/place?scope=agent&agentId=${bot.id}`)) as { dossiers: { core?: string; body: string }[] };
    const shown = async () => {
      const p = await place();
      return ownerOrders(p.dossiers.find((d) => d.core === 'notes')?.body ?? p.dossiers[0]?.body);
    };
    assert.equal(await shown(), '', 'a new bot has no orders yet');
    const th = await t.api('POST', '/threads', { agentId: bot.id });
    t.script.push({ text: 'Begrepen.' });
    await t.say(th.id, 'Vanaf nu is dit je vaste taak: je beantwoordt vragen over bestellingen.');
    assert.match(await shown(), /^- Vanaf nu is dit je vaste taak: je beantwoordt vragen over bestellingen\.$/m);
    // Its instructions stay its instructions: the order is not copied into them.
    assert.equal(t.app.ctx.store.agent(bot.id)!.instructions, 'Antwoord in het Nederlands.');
  } finally {
    await t.close();
  }
});
