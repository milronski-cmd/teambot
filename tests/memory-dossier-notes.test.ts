/**
 * A dossier's tab "Notities" (ui/src/modules/memory/dossiers.tsx) lists every note that belongs to the dossier, and as
 * many as the dossier itself counts ("2 notities"). Lessons are team notes (scope shared) linked to the dossier
 * "Lessen": the tab asks for scope=dossier with the dossier's id, and found none of them.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { coreDossiers } from '../server/modules/memory/living.js';
import { recordLesson } from '../server/modules/memory/lessons.js';

process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

test('a dossier\'s Notities tab shows every note of the dossier, lessons included, and the count matches', async () => {
  const t = await startTestApp();
  try {
    const svc = t.app.ctx.services.memory.svc;
    const a = await t.agent({ name: 'Lien', tool_groups: ['memory', 'team'] });
    const agent = t.app.ctx.store.agent(a.id)!;
    for (const [i, rule] of ['Sla het bestand op en controleer dat het er staat voordat je een taak als klaar meldt', 'Vraag bij een offerte altijd eerst naar het budget'].entries()) {
      const r = await recordLesson(svc, { agent, wrong: `Fout ${i + 1}`, rule, source: { kind: 'run', trust: 'system' }, idemKey: `lesson:tab:${i}` });
      assert.equal(r?.action, 'inserted');
    }
    const lessons = coreDossiers(svc, agent).find((d: any) => d.core === 'lessons')!;
    const full = await t.api('GET', `/memory/dossiers/${lessons.id}`);
    assert.equal(full.items.length, 2, 'the dossier counts its two lessons');
    // Exactly what the tab asks (ItemList with base { scope: 'dossier', dossierId }).
    const tab = await t.api('GET', `/memory/items?scope=dossier&dossierId=${encodeURIComponent(lessons.id)}`);
    assert.equal(tab.total, 2, 'the tab lists both lessons');
    assert.deepEqual(tab.items.map((x: any) => x.id).sort(), full.items.map((x: any) => x.id).sort());
    // Elsewhere the scope filter still holds: a dossier note is not a team note.
    const shared = await t.api('GET', '/memory/items?scope=shared');
    assert.ok(shared.items.every((x: any) => x.scope === 'shared'));
  } finally {
    await t.close();
  }
});
