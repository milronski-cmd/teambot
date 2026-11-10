import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { nextReview, reviewInterval } from '../server/modules/memory/types.js';

/** A-44: a review interval per memory item ("elke 3 maanden nakijken") plus a default in the memory settings. */

const DAY = 864e5;
const days = (iso: string | null) => (iso ? Math.round((Date.parse(iso) - Date.now()) / DAY) : null);

test('interval values and the next check date', () => {
  assert.deepEqual([0, 30, 90, 180, 365].map(reviewInterval), [0, 30, 90, 180, 365]);
  assert.equal(reviewInterval(45), null, 'only the offered choices');
  assert.equal(reviewInterval('abc'), null);
  assert.equal(nextReview(0), null, 'never = no check date');
  assert.equal(nextReview(null), null);
  assert.equal(nextReview(90, Date.parse('2026-11-07T10:00:00Z')), '2027-02-05T10:00:00.000Z');
});

test('default for facts that can change, per-item choice, due list, "Klopt nog" reschedules, export/import keep it', async () => {
  const t = await startTestApp();
  try {
    assert.equal((await t.api('GET', '/memory/settings')).reviewEveryDays, 180);
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'ok' }, { text: 'ok' });
    await t.say(th.id, 'Onthoud dat ik in Utrecht woon');
    let it = (await t.api('GET', '/memory/items?scope=about_you')).items[0];
    assert.equal(it.review_every_days, 180, 'a fact that can change gets the default');
    assert.equal(days(it.review_at), 180);

    // The owner's default applies to new facts; a preference without a key gets no check.
    await t.api('PUT', '/memory/settings', { reviewEveryDays: 365 });
    await assert.rejects(t.api('PUT', '/memory/settings', { reviewEveryDays: 12 }), /elke maand/);
    await t.say(th.id, 'Onthoud dat ik bij Bol.com werk');
    const work = (await t.api('GET', '/memory/items?scope=about_you')).items.find((i: any) => /Bol/.test(i.content));
    assert.equal(work.review_every_days, 365);
    const pref = await t.api('POST', '/memory/items', { content: 'Ik hou van jazz', scope: 'about_you' });
    assert.equal(pref.item.review_every_days ?? null, null);
    assert.equal(pref.item.review_at, null);
    // Chosen when adding it yourself.
    const own = await t.api('POST', '/memory/items', { content: 'De sleutel van de schuur ligt in de keukenla', scope: 'about_you', review_every_days: 30 });
    assert.equal(own.item.review_every_days, 30);
    assert.equal(days(own.item.review_at), 30);

    // Per item: "elke 3 maanden" starts today; "Nooit" clears the date; an invalid value is refused.
    it = (await t.api('PATCH', `/memory/items/${it.id}`, { review_every_days: 90 })).item;
    assert.equal(it.review_every_days, 90);
    assert.equal(days(it.review_at), 90);
    await assert.rejects(t.api('PATCH', `/memory/items/${it.id}`, { review_every_days: 7 }), /elke maand/);
    const never = (await t.api('PATCH', `/memory/items/${pref.item.id}`, { review_every_days: 0 })).item;
    assert.equal(never.review_at, null);

    // Due: the check date has passed → "Klopt dit nog?" in Beoordelen (and the overview count).
    t.app.ctx.store.update('memory_items', it.id, { review_at: new Date(Date.now() - 60_000).toISOString() });
    let review = await t.api('GET', '/memory/review');
    assert.deepEqual(review.due.map((i: any) => i.id), [it.id]);
    assert.equal((await t.api('GET', '/memory/overview')).due, 1);
    // "Klopt nog" reschedules with the item's own interval and leaves the list.
    const conf = (await t.api('POST', `/memory/items/${it.id}/confirm`, {})).item;
    assert.equal(days(conf.review_at), 90);
    assert.ok(conf.last_confirmed_at);
    review = await t.api('GET', '/memory/review');
    assert.equal(review.due.length, 0);

    // Export keeps the interval; importing that export into a fresh app keeps it on the proposal and after approval.
    const exp = await t.api('GET', '/memory/export?format=json');
    const row = exp.items.find((i: any) => i.id === it.id);
    assert.equal(row.review_every_days, 90);
    const t2 = await startTestApp();
    try {
      const imp = await t2.api('POST', '/memory/import', { text: JSON.stringify(exp) });
      assert.ok(imp.proposed >= 1);
      const prop = (await t2.api('GET', '/memory/review')).proposals.find((p: any) => /Utrecht/.test(p.item.content));
      assert.equal(prop.item.review_every_days, 90);
      const ok = await t2.api('POST', `/memory/items/${prop.item.id}/approve`, {});
      assert.equal(ok.item.review_every_days, 90);
      assert.equal(days(ok.item.review_at), 90);
    } finally {
      await t2.close();
    }
  } finally {
    await t.close();
  }
});
