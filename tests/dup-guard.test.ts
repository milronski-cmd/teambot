/**
 * Guard against things growing back double (duplication audit, 12 nov 2026). Part of `npm run dup:check`:
 *  - no tool name is registered or provided twice (the second one would silently replace the first);
 *  - the number of tools a bot on "Volledige toegang" is SENT with every step stays small (tools/selection.ts: the core,
 *    tools_find and tools_call). A tool only goes into that list when bots use it daily: then raise the number HERE,
 *    in the same change, on purpose. Every other new tool is found on demand and costs a step nothing;
 *  - the number of tools such a bot HAS does not grow past today's number unnoticed. A new tool is fine when it replaces
 *    one or when the owner asked for it: then raise that number here too.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { onDemand } from '../server/tools/selection.js';

/** Sent with every step to a model over an API (12 nov 2026, a fresh install): 22 of the bot's own plus tools_find and tools_call. A CLI engine gets 8 fewer (it has files, terminal and search itself). */
const MAX_SENT_FULL_ACCESS = 24;
const MAX_SENT_MAIN_BOT = 26;
/**
 * What the bot has in all (the same day, nothing connected). Lower it when tools are merged.
 * 111: every bot now has teambot_find and teambot_do, the two the main bot already had ("een bot kan alles wat de
 * gebruiker in het scherm kan"). They are on demand for it, so the number SENT above did not move.
 */
const MAX_TOOLS_FULL_ACCESS = 111;
const MAX_TOOLS_MAIN_BOT = 118;

test('tools: no name twice, and a full-access bot does not get more tools than today', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const userId = ctx.auth.owner()!.id;
    const main = await t.agent({ name: 'Baas', access_mode: 'full' });
    const bot = await t.agent({ name: 'Rik', access_mode: 'full' });
    const defsOf = (id: string) => ctx.tools.forAgent(ctx.store.agent(id)!, ctx.chat.threadForAgent(userId, id));
    const toolsOf = async (id: string) => (await defsOf(id)).map((x) => x.name);
    const sentOf = async (id: string) => onDemand({ tools: await defsOf(id), groups: ctx.tools.groups, guides: [], who: { agent: ctx.store.agent(id)!, thread: ctx.chat.threadForAgent(userId, id), userId }, on: true, told: new Set() }).listed.length;
    const mine = await toolsOf(bot.id);
    const mains = await toolsOf(main.id);
    assert.equal(ctx.services.teams.mainOf(userId), main.id, 'the first bot is the main bot');

    assert.deepEqual([...ctx.tools.duplicates], [], 'a tool name registered or provided twice');
    assert.equal(new Set(mine).size, mine.length);
    assert.equal(new Set(ctx.tools.list().map((x) => x.name)).size, ctx.tools.list().length);

    const [sent, sentMain] = [await sentOf(bot.id), await sentOf(main.id)];
    if (process.env.DUP_PRINT) console.log(`tools: bot ${mine.length} (${sent} sent), main bot ${mains.length} (${sentMain} sent)`);
    const sentMore = (n: number, max: number, who: string) => `${who} krijgt bij elke stap ${n} tools mee, meer dan de ${max} van nu. Zet de nieuwe tool op afroep (hij staat dan vanzelf in tools_find), of verhoog het getal in tests/dup-guard.test.ts als bots hem echt dagelijks gebruiken.`;
    assert.ok(sent <= MAX_SENT_FULL_ACCESS, sentMore(sent, MAX_SENT_FULL_ACCESS, 'Een bot met volledige toegang'));
    assert.ok(sentMain <= MAX_SENT_MAIN_BOT, sentMore(sentMain, MAX_SENT_MAIN_BOT, 'De hoofdbot'));
    const more = (n: number, max: number, who: string) => `${who} heeft ${n} tools, meer dan de ${max} van nu. Voeg een taak toe aan een bestaande tool, of haal er een weg; alleen als het echt een nieuwe taak is: verhoog het getal in tests/dup-guard.test.ts.`;
    assert.ok(mine.length <= MAX_TOOLS_FULL_ACCESS, more(mine.length, MAX_TOOLS_FULL_ACCESS, 'Een bot met volledige toegang'));
    assert.ok(mains.length <= MAX_TOOLS_MAIN_BOT, more(mains.length, MAX_TOOLS_MAIN_BOT, 'De hoofdbot'));
  } finally {
    await t.close();
  }
});
