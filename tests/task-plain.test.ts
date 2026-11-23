// A task in plain words (server/modules/rooms/plain.ts): TeamBot itself puts what the owner sees on the Taken page into
// plain words, keeps them with a fingerprint of the task, and makes them again only when the task changes. Seen with a
// real team (23 nov 2026): tasks full of paths and codes, "hele vage uitleg".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { setShortCallFake } from '../server/agent/short-call.js';
import { taskPlain } from '../server/modules/rooms/plain.js';

test('a task in plain words: made once by TeamBot, kept, made again when the task changes; the bot text is data', async () => {
  const t = await startTestApp();
  taskPlain.enabled = true;
  const prompts: string[] = [];
  setShortCallFake((system, prompt) => {
    if (!/legt een taak van een AI-team uit aan de eigenaar/.test(system)) return '';
    prompts.push(prompt);
    return /Nameting/.test(prompt)
      ? '{"wat":"Over een week opnieuw tellen hoeveel echte aanvragen er binnenkwamen.","waarom":"Zo zie je of de nieuwe telling klopt.","wacht":"Wacht tot 28 november."}'
      : '{"wat":"De herkomst van aanvragen weer meten op drie websites.","waarom":"Nu staat bij elke aanvraag onbekend.","wacht":""}';
  });
  try {
    await t.agent({ name: 'Milo' });
    const items = [
      { ref: 'b:1', title: "lb-landing (landingPath/lead_bron) op airco-radar", description: "Het <head>-script dat 'lb-landing' zet ontbreekt.", status: 'todo' },
      { ref: 't:7', title: 'Nameting unieke-leadtelling op 28 november', description: 'Herhaal leadmeting-7dagen.mjs.', status: 'blocked' },
    ];
    const events: any[] = [];
    const off = t.app.ctx.events.subscribe((e: any) => e.type === 'tasks.plain' && events.push(e.data));
    const first = await t.api('POST', '/tasks/plain', { items });
    assert.deepEqual(first.plain, {}, 'nothing yet: it is made in the background');
    await t.app.ctx.services.taskPlainer.drain();
    assert.equal(prompts.length, 2);
    assert.match(prompts[0], /<titel>lb-landing/);
    assert.equal(events.length, 2, 'each comes to the page as an event');

    const second = await t.api('POST', '/tasks/plain', { items });
    assert.equal(second.plain['b:1'].wat, 'De herkomst van aanvragen weer meten op drie websites.');
    assert.equal(second.plain['t:7'].wacht, 'Wacht tot 28 november.');
    await t.app.ctx.services.taskPlainer.drain();
    assert.equal(prompts.length, 2, 'kept: not asked again');

    // The task changed: the old words no longer fit, they are made again.
    const third = await t.api('POST', '/tasks/plain', { items: [{ ...items[0], status: 'done', description: 'Script staat er nu op alle drie.' }] });
    assert.equal(third.plain['b:1'], undefined, 'old words are not shown for a changed task');
    await t.app.ctx.services.taskPlainer.drain();
    assert.equal(prompts.length, 3);
    off?.();
  } finally {
    setShortCallFake(null);
    taskPlain.enabled = false;
    await t.close();
  }
});
