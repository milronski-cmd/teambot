import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { usesMemory } from '../server/modules/memory/implied.js';

test('an answer uses a memory when it says what the memory holds and the question did not (A-42)', () => {
  // The case from acceptance round 5: Ollama answered right but cited nothing.
  assert.equal(usesMemory('Mijn hond heet Bram', 'Je hond heet Bram.', 'Hoe heet mijn hond?'), true);
  assert.equal(usesMemory('Ik woon in Utrecht', 'Je woont in Utrecht.', 'Waar woon ik?'), true);
  assert.equal(usesMemory('Bram is mijn hond', 'Je hond heet **Bram**!', 'Hoe heet mijn hond?'), true);
  assert.equal(usesMemory('Ik ben geboren in 1985', 'Je bent geboren in 1985.', 'Wanneer ben ik geboren?'), true);
  // One word of the memory, but the memory is clearly about the question (live with Ollama: "Je kat eet graag vis.").
  assert.equal(usesMemory('Mijn kat heet Mo en eet graag vis', 'Je kat eet graag vis.', 'En wat eet mijn kat graag?'), true);
  // …while a memory that shares only one word with the question needs more than one common word in the answer.
  assert.equal(usesMemory('Mijn kat heet Mo en eet graag vis', 'Je hond heet Bram en eet graag brokken.', 'Hoe heet mijn hond?'), false);
  // Not about the question's words, but the answer repeats most of it.
  assert.equal(usesMemory('Mijn hond heet Bram', 'Je hebt een hond die Bram heet.', 'Wat weet je over mij?'), true);

  // In the context but not used: another pet, a profile line that only shares a name with a general answer.
  assert.equal(usesMemory('Mijn kat heet Mo en eet graag vis', 'Je hond heet Bram.', 'Hoe heet mijn hond?'), false);
  assert.equal(usesMemory('Ik woon in Amsterdam', 'De hoofdstad van Nederland is Amsterdam.', 'Wat is de hoofdstad van Nederland?'), false);
  assert.equal(usesMemory('Antwoord altijd kort en in het Nederlands', 'Kort gezegd: het regent morgen.', 'Wat voor weer wordt het?'), false);
  // The question already said it: repeating it is no evidence.
  assert.equal(usesMemory('Mijn hond heet Bram', 'Ja, je hond heet Bram.', 'Heet mijn hond Bram?'), false);
  // A capital at the start of a sentence or line is no name.
  assert.equal(usesMemory('Mijn tuin is groot', 'Groot nieuws: de zon schijnt.', 'Hoe is het weer?'), false);
});

test('answer-sources: the memory a local model used without citing it, and only that one', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Genoteerd!' }, { text: 'Genoteerd!' });
    await t.say(th.id, 'Onthoud dat mijn hond Bram heet.');
    await t.say(th.id, 'Onthoud dat mijn kat Mo heet.');
    const items = (await t.api('GET', '/memory/items?scope=about_you')).items;
    const dog = items.find((i: any) => /Bram/.test(i.content));
    const cat = items.find((i: any) => /Mo\b/.test(i.content));
    assert.ok(dog && cat, JSON.stringify(items.map((i: any) => i.content)));

    // A new conversation: both memories go into the context, the answer only uses the dog and cites nothing.
    const th2 = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'Je hond heet Bram.' });
    const msgs = await t.say(th2.id, 'Hoe heet mijn hond?');
    const ctxText = msgs.filter((m: any) => m.role === 'user').at(-1).parts.context as string;
    assert.match(ctxText, new RegExp(`\\[m:${dog.ref}\\]`));
    const answer = msgs.filter((m: any) => m.role === 'assistant').at(-1);
    const r = await t.api('GET', `/memory/thread/${th2.id}/answer-sources`);
    assert.ok(r.upto >= answer.seq);
    assert.deepEqual(
      (r.byMessage[answer.id] || []).map((c: any) => c.id),
      [dog.id],
    );
    assert.equal(r.byMessage[answer.id][0].kind, 'item');

    // An answer that cites shows its own sources: nothing implied for it. An answer about something else: none.
    t.script.push({ text: `Je hond heet Bram [m:${dog.ref}].` }, { text: 'Morgen wordt het zonnig.' });
    const more = await t.say(th2.id, 'En nog eens: hoe heet mijn hond?');
    const cited = more.filter((m: any) => m.role === 'assistant').at(-1);
    const weather = (await t.say(th2.id, 'Wat voor weer wordt het?')).filter((m: any) => m.role === 'assistant').at(-1);
    const r2 = await t.api('GET', `/memory/thread/${th2.id}/answer-sources`);
    assert.equal(r2.byMessage[cited.id], undefined);
    assert.equal(r2.byMessage[weather.id], undefined);
    assert.deepEqual(r2.byMessage[answer.id].map((c: any) => c.id), [dog.id]);

    // Someone else's thread: not found.
    await assert.rejects(t.api('GET', `/memory/thread/nope/answer-sources`), /404|niet gevonden/i);
  } finally {
    await t.close();
  }
});
