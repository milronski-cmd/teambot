import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { cliPrompt } from '../server/agent/prompt.js';

/**
 * Messages sent quickly after each other, each cutting off the turn of the one before (seen 20 nov 2026: four
 * messages in two seconds to a bot on Claude Code; the turns of the first three ended within a second, before the
 * engine had started, and the bot only ever got the fourth). Every one of them must reach the bot.
 */
test('messages that cut each other off before the engine began all reach the bot with the one that got its turn', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const a = await t.api('POST', '/agents', { name: 'Ada', provider_id: t.providerId, model: 'mock' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const agent = ctx.store.agent(a.id)!;
    const thread = ctx.store.thread(th.id)!;
    const say = (content: string) => ctx.store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: agent.user_id, author_name: 'Eigenaar', content } as any);
    const answer = (input: any, o: { status: string; content?: string; steer?: boolean; activity?: any[] }) => {
      const run = ctx.store.createRun({ thread_id: th.id, agent_id: agent.id, user_id: agent.user_id, status: o.status === 'done' ? 'done' : 'cancelled', trigger: 'user', input_message_id: input.id, meta: o.steer ? { steerInterrupt: true } : {} } as any);
      return ctx.store.createMessage({ thread_id: th.id, role: 'assistant', author_type: 'agent', author_id: agent.id, author_name: agent.name, content: o.content || '', status: o.status, run_id: run.id, parts: { activity: o.activity || [] } } as any);
    };
    const started = [{ kind: 'session', title: 'Bijgewerkte instructies meegegeven' }];

    answer(say('Maak een overzicht.'), { status: 'done', content: 'Het overzicht staat klaar.' });
    answer(say('Niets overslaan, het moet goed worden opgelost.'), { status: 'cancelled', steer: true, activity: started });
    answer(say('Beslissing 24: ik geef een seintje.'), { status: 'cancelled', steer: true, activity: started });
    answer(say('Hij logt niet in.'), { status: 'cancelled', steer: true, activity: started });
    const last = say('Hij zegt: deze browser is mogelijk niet veilig.');

    const prompt = cliPrompt(ctx, agent, thread, last);
    for (const line of ['Niets overslaan, het moet goed worden opgelost.', 'Beslissing 24: ik geef een seintje.', 'Hij logt niet in.']) assert.ok(prompt.includes(line), `the bot gets “${line}”`);
    assert.ok(prompt.includes('Hij zegt: deze browser is mogelijk niet veilig.'));
    assert.ok(!prompt.includes('Maak een overzicht.'), 'what was answered is not sent again');
    assert.ok(prompt.indexOf('Niets overslaan') < prompt.indexOf('Hij logt niet in.') && prompt.indexOf('Hij logt niet in.') < prompt.indexOf('niet veilig'), 'in the order they were sent');

    // A turn that was cut off after the bot had begun (text, or steps) did reach the engine: not sent again.
    answer(last, { status: 'cancelled', steer: true, content: 'Het werkt via je eigen Chrome: ik kijk de andere twee sites ook na.' });
    const next = say('Waarom heb je nog Search Console nodig?');
    const p2 = cliPrompt(ctx, agent, thread, next);
    assert.ok(!p2.includes('Hij logt niet in.') && !p2.includes('niet veilig'), 'already with the engine');
    assert.ok(p2.includes('Waarom heb je nog Search Console nodig?'));

    // A turn the owner stopped himself before it began stays as it was: that task does not come back.
    answer(next, { status: 'done', content: 'Voor de handmatige acties.' });
    answer(say('Schrijf alle pagina’s opnieuw.'), { status: 'cancelled', activity: started });
    const p3 = cliPrompt(ctx, agent, thread, say('Laat maar, doe alleen de homepage.'));
    assert.ok(!p3.includes('Schrijf alle pagina’s opnieuw.'), 'stopped by the owner: not taken up again');
  } finally {
    await t.close();
  }
});
