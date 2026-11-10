import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { createRoutinesModule } from '../server/modules/routines/index.js';
import channels from '../server/modules/channels/index.js';
import type { RoutineEngine } from '../server/modules/routines/engine.js';

// Parity 0.4.2 (audit §9, triggers): an e-mail trigger with an account filter gets the channels module's EmailEvent
// (channels/types.ts: bindingId, bindingName, from {address, name}, to []). Before, the filter read `accountId` (never
// set) and the sender became "[object Object]".

function mail(o: Record<string, any> = {}) {
  return {
    bindingId: 'chb_werk',
    bindingName: 'Werkmail',
    messageId: `<m${Math.random()}@x.nl>`,
    from: { address: 'jan@klant.nl', name: 'Jan de Klant' },
    to: ['info@fietsen.nl', 'sanne@fietsen.nl'],
    subject: 'Offerte',
    text: 'Kunt u een offerte sturen?',
    date: '2026-11-09T08:00:00Z',
    attachments: [],
    authenticated: true,
    allowed: true,
    automated: false,
    ...o,
  };
}

test('e-mail trigger: the account filter matches the channel by id or name; the sender is a readable address', async () => {
  const t = await startTestApp({ modules: [createRoutinesModule({ tickMs: 0 }), channels] });
  try {
    const engine: RoutineEngine = t.app.ctx.services.routines.engine;
    const bot = await t.agent({ name: 'Klantenservice' });
    const mk = async (name: string, accountId: string) => {
      const r = await t.api('POST', '/routines', { name, agent_id: bot.id, prompt: 'Beantwoord de mail als concept.', schedule: { kind: 'none' } });
      const trg = (await t.api('POST', `/routines/${r.id}/triggers`, { kind: 'email', config: { accountId } })).trigger;
      return { r, trg };
    };
    const byId = await mk('Op id', 'chb_werk');
    const byName = await mk('Op naam', 'werkmail');
    const other = await mk('Ander account', 'Privémail');
    const all = await mk('Alle mail', '');
    const owner = t.app.ctx.auth.owner()!;
    engine.handleEmail(mail({ userId: owner.id }));
    const events = (trgId: string) => t.app.ctx.store.all<any>('SELECT status, summary FROM routine_events WHERE trigger_id = ?', trgId);
    assert.equal(events(byId.trg.id).filter((e) => e.status === 'accepted').length, 1, 'account filter on the binding id');
    assert.equal(events(byName.trg.id).filter((e) => e.status === 'accepted').length, 1, 'account filter on the binding name (any case)');
    assert.equal(events(other.trg.id).length, 0, 'another account: nothing');
    assert.equal(events(all.trg.id).filter((e) => e.status === 'accepted').length, 1, 'no filter: all e-mail');
    const summary = events(byId.trg.id)[0].summary;
    assert.match(summary, /Jan de Klant <jan@klant\.nl>/);
    assert.ok(!/\[object Object\]/.test(summary), summary);
    const run = t.app.ctx.store.all<any>('SELECT payload FROM routine_runs WHERE routine_id = ?', byId.r.id)[0];
    const payload = JSON.stringify(run?.payload || '');
    assert.match(payload, /info@fietsen\.nl, sanne@fietsen\.nl/, 'recipients as a list of addresses');
  } finally {
    await t.close();
  }
});
