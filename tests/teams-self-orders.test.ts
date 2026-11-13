/**
 * One place for what the owner told a bot: its own Werknotities, under "Opdrachten van de eigenaar" (the memory rule).
 * The bot hears it in two places, its prompt (teams/index.ts) and the description of my_settings (teams/selftools.ts):
 * both must name the same place, or a bot gets two answers to one question. A name and a model are settings; its
 * instructions stay the owner's own text.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { OWNER_ORDERS_PLACE, SELF_SETTINGS } from '../server/modules/teams/selftools.js';

/** Words that would send an order of the owner somewhere else than its working notes. */
const ELSEWHERE = /niet in een dossier|leg dat hier vast|in je instructies vast/i;

test('the prompt of every bot and my_settings name the same place for an order of the owner', async () => {
  const t = await startTestApp();
  try {
    const main = await t.agent({ name: 'Baas' });
    const kim = await t.agent({ name: 'Kim' });
    assert.equal(t.app.ctx.services.teams.mainOf(t.app.ctx.auth.owner()!.id), main.id, 'Baas is the main bot');
    const tool = (t.app.ctx.services.teams.selfTools as any[]).find((x) => x.name === SELF_SETTINGS)!;
    const desc = String(tool.description);
    assert.match(OWNER_ORDERS_PLACE, /werknotities onder “Opdrachten van de eigenaar”/);
    const said = desc.split(/(?<=[.!?])\s+/).find((s) => s.includes(OWNER_ORDERS_PLACE));
    assert.ok(said && /opdraagt/.test(said) && /niet hier/.test(said), `my_settings sends an order of the owner to the working notes: ${desc}`);
    assert.match(desc, /^Bekijk of verander je EIGEN instellingen, zoals je naam en model/, 'a name and a model are settings');
    assert.doesNotMatch(desc, ELSEWHERE);
    for (const bot of [main, kim]) {
      const thread = await t.api('POST', '/threads', { agentId: bot.id });
      t.script.push({ text: 'Hallo.' });
      await t.say(thread.id, 'Hoi');
      const system = t.requests.at(-1)!.system;
      const rule = system.split(/(?<=[.!?])\s+/).find((s) => s.includes(OWNER_ORDERS_PLACE));
      assert.ok(rule && /opdraagt/.test(rule), `${bot.name}: the prompt names the same place`);
      assert.doesNotMatch(system, ELSEWHERE, `${bot.name}: no second place in the prompt`);
    }
  } finally {
    await t.close();
  }
});
