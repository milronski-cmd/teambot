/** What the owner answered once is not asked again: the bot gets his earlier answer, and he sees and corrects it per bot. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { answeredContext, earlierAnswers, plainAnswer, sameQuestion } from '../server/tools/answered.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('an answered question comes back as its answer; again: true asks anyway; the owner corrects or forgets it', async () => {
  const t = await startTestApp();
  try {
    const ctx = t.app.ctx;
    const userId = ctx.auth.owner()!.id;
    const kim = ctx.store.agent((await t.agent({ name: 'Kim', role: 'Klantenservice' })).id)!;
    const bo = ctx.store.agent((await t.agent({ name: 'Bo', role: 'Webshop' })).id)!;
    const ask = ctx.tools.get('ask_user')!;
    const run = async (agent: any, args: any) => {
      const thread = ctx.chat.threadForAgent(userId, agent.id);
      const out = await ask.run(args, { ctx, agent, thread, userId, run: null as any, signal: new AbortController().signal, toolCallId: 'c', progress() {} });
      return typeof out === 'string' ? out : out.text;
    };
    const answer = async (text: string) => {
      for (let i = 0; i < 200; i++) {
        const c = (await t.api('GET', '/approvals')).find((x: any) => x.status === 'pending');
        if (c) return t.api('POST', `/approvals/${c.id}`, { decision: 'approve', answer: text });
        await sleep(20);
      }
      throw new Error('no card');
    };
    const pending = async () => (await t.api('GET', '/approvals')).filter((x: any) => x.status === 'pending').length;

    // 1. The first time he is asked and answers.
    const q = 'Mag een klant een bestelling retourneren na 30 dagen als de verpakking nog dicht is?';
    const first = run(kim, { question: q });
    await answer('Ja, tot 60 dagen als de verpakking dicht is. Daarna alleen met mijn akkoord.');
    assert.match(await first, /Antwoord van de gebruiker: Ja, tot 60 dagen/);

    // 2. The same question again, in other words: no card, his answer comes back.
    const again = await run(kim, { question: 'Mag een klant na 30 dagen nog een bestelling retourneren als de verpakking dicht is?' });
    assert.match(again, /^Dit vroeg je eerder \(\d{4}-\d\d-\d\d\): “Mag een klant een bestelling retourneren.*Antwoord van je eigenaar: “Ja, tot 60 dagen/);
    assert.match(again, /again: true/);
    assert.equal(await pending(), 0);
    // A colleague need not ask it either, and hears who asked.
    assert.match(await run(bo, { question: q }), /^Kim vroeg dit eerder/);
    // Another question is asked.
    assert.equal(sameQuestion(ctx, kim, 'Welke vervoerder gebruiken we voor pakketten naar België?'), null);

    // 3. Not sure it holds here: again: true asks him anyway.
    const sure = run(kim, { question: q, again: true });
    await answer('Voor maatwerk geldt dit niet.');
    assert.match(await sure, /Voor maatwerk geldt dit niet/);

    // 4. A turn about it gets the answers along; small talk gets nothing.
    const th = ctx.chat.threadForAgent(userId, kim.id);
    const msg = (content: string) => ({ content }) as any;
    const along = answeredContext(ctx, kim, th, msg('Klant wil een bestelling retourneren na 30 dagen, de verpakking is nog dicht. Mag dat?'))!;
    assert.match(along, /^Eerder beantwoord door je eigenaar/);
    assert.match(along, /tot 60 dagen/);
    assert.equal(answeredContext(ctx, kim, th, msg('Goedemorgen, hoe staat het ervoor?')), null);

    // 5. Per bot for the owner; he corrects an answer and the bots work with the new one; forgotten is asked again.
    const view = (await t.api('GET', '/approvals/answers')).bots;
    const ofKim = view.find((b: any) => b.name === 'Kim');
    assert.equal(ofKim.answers.length, 2);
    assert.ok(ofKim.askedWeek >= 2 && ofKim.open === 0);
    const firstId = ofKim.answers.find((a: any) => /60 dagen/.test(a.answer)).id;
    const otherId = ofKim.answers.find((a: any) => /maatwerk/.test(a.answer)).id;
    await t.api('PUT', `/approvals/${otherId}/answer`, { forget: true });
    await t.api('PUT', `/approvals/${firstId}/answer`, { answer: 'Ja, tot 90 dagen.' });
    assert.match(await run(kim, { question: q }), /Antwoord van je eigenaar: “Ja, tot 90 dagen\.”/);
    await t.api('PUT', `/approvals/${firstId}/answer`, { forget: true });
    assert.equal(earlierAnswers(ctx, kim, q).length, 0);
    assert.equal((await t.api('GET', '/approvals/answers')).bots.find((b: any) => b.name === 'Kim').answers.length, 0);

    assert.equal(plainAnswer('{"naam":"Sanne","seizoen":"herfst"}'), 'naam: Sanne; seizoen: herfst');
  } finally {
    await t.close();
  }
});
