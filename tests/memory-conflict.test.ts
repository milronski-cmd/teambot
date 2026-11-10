import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { isCorrection } from '../server/modules/memory/text.js';

/** A-46: a memory that contradicts an existing one goes to Beoordelen first (owner setting), not replaced silently. */

const about = async (t: any) => (await t.api('GET', '/memory/items?scope=about_you&status=all')).items as any[];

test('recognises an explicit correction in the owner\'s own words, not a plain statement', () => {
  for (const s of ['Ik woon niet meer in Utrecht maar in Amersfoort', 'Mijn kat heet nu Max', 'Onthoud dat ik inmiddels in Delft woon', 'Correctie: ik werk vier dagen', 'Sinds deze maand werk ik bij Bol.com', 'We stappen over van Vimexx naar TransIP', 'Ik drink tegenwoordig geen melk meer in mijn koffie'])
    assert.ok(isCorrection(s), s);
  for (const s of ['Mijn kat heet Max', 'Onthoud dat ik in Amsterdam woon', 'Kun je nu even kijken wat mijn kat eet?', '> ik woon niet meer in Utrecht (citaat uit een mail)'])
    assert.ok(!isCorrection(s), s);
});

test('default "eerst aan mij vragen": a contradiction becomes a review card with old vs new; old / new / both', async () => {
  const t = await startTestApp();
  try {
    assert.equal((await t.api('GET', '/memory/settings')).conflicts, 'ask', 'the sensible default asks first');
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'ok' }, { text: 'ok' }, { text: 'ok' }, { text: 'ok' }, { text: 'ok' });
    await t.say(th.id, 'Onthoud dat mijn kat Mo heet');
    const mo = (await about(t)).find((i) => /Mo/.test(i.content));
    assert.equal(mo.status, 'active');

    await t.say(th.id, 'Onthoud dat mijn kat Max heet');
    let items = await about(t);
    const max = items.find((i) => /Max/.test(i.content));
    assert.equal(max.status, 'proposed', 'not replaced directly');
    assert.equal(max.proposal_reason, 'conflict');
    assert.equal(items.find((i) => i.id === mo.id).status, 'active', 'the old memory stays until the owner chooses');
    const review = await t.api('GET', '/memory/review');
    const card = review.proposals.find((p: any) => p.item.id === max.id);
    assert.equal(card.conflict.id, mo.id, 'the card shows old vs new');
    // Under the owner's message: what it contradicts, with the way to Beoordelen.
    const map = await t.api('GET', `/memory/thread/${th.id}/learned-map`);
    const line = Object.values<any>(map.byMessage).flat().find((x: any) => x.id === max.id);
    assert.equal(line.conflict.content, mo.content);

    // "Oude houden": the new one is refused, the old one stays.
    await t.api('POST', `/memory/items/${max.id}/reject`, {});
    items = await about(t);
    assert.equal(items.find((i) => i.id === mo.id).status, 'active');
    assert.ok(!items.some((i) => i.status === 'active' && /Max/.test(i.content)));

    // Said again explicitly → a new card; "Beide houden" keeps both (e.g. two cats).
    await t.say(th.id, 'Onthoud dat mijn kat Max heet');
    const max2 = (await about(t)).find((i) => /Max/.test(i.content) && i.status === 'proposed');
    assert.ok(max2, 'explicitly said again: a new review card');
    await t.api('POST', `/memory/items/${max2.id}/approve`, { mode: 'keep_both' });
    items = await about(t);
    assert.equal(items.find((i) => i.id === mo.id).status, 'active');
    assert.equal(items.find((i) => i.id === max2.id).status, 'active');

    // An explicit correction ("nu") replaces directly, with history and undo.
    await t.say(th.id, 'Onthoud dat mijn kat nu Pip heet');
    items = await about(t);
    const pip = items.find((i) => /Pip/.test(i.content));
    assert.equal(pip.status, 'active');
    assert.equal(pip.content, 'Mijn kat heet nu Pip');
    assert.ok(pip.supersedes_id, 'replaces the latest version');
    assert.equal(items.find((i) => i.id === pip.supersedes_id).status, 'superseded');
  } finally {
    await t.close();
  }
});

test('"Direct vervangen": the owner\'s contradiction replaces the old memory at once; a bot\'s never does', async () => {
  const t = await startTestApp();
  try {
    const s = await t.api('PUT', '/memory/settings', { conflicts: 'replace' });
    assert.equal(s.conflicts, 'replace');
    await assert.rejects(t.api('PUT', '/memory/settings', { conflicts: 'nooit' }), /Ongeldige keuze/);
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'ok' }, { text: 'ok' });
    await t.say(th.id, 'Onthoud dat mijn kat Mo heet');
    await t.say(th.id, 'Onthoud dat mijn kat Max heet');
    const items = await about(t);
    const max = items.find((i) => /Max/.test(i.content));
    const mo = items.find((i) => /Mo\b/.test(i.content));
    assert.equal(max.status, 'active');
    assert.equal(mo.status, 'superseded');
    assert.equal(max.supersedes_id, mo.id);
    // A bot's inference that contradicts stays a review card, also with this setting.
    t.script.push({ toolCalls: [{ name: 'memory_remember', args: { content: 'Mijn kat heet Tijger', scope: 'about_you', key: 'kat' } }] }, { text: 'ok' });
    await t.say(th.id, 'iets anders');
    const tijger = (await about(t)).find((i) => /Tijger/.test(i.content));
    assert.equal(tijger.status, 'proposed');
    assert.equal((await about(t)).find((i) => i.id === max.id).status, 'active');
  } finally {
    await t.close();
  }
});
