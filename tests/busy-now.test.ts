/** "Nu ook bezig": a bot's turn carries who else works right now and on what, so two bots do not do the same thing. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { busyNow } from '../server/modules/rooms/prompt.js';

test('a turn says which colleagues are working now and on what; nothing when nobody is, and never a private bot', async () => {
  const t = await startTestApp();
  try {
    const st = t.app.ctx.store;
    const ada = st.agent((await t.agent({ name: 'Ada', role: 'Mail' })).id)!;
    const bo = await t.agent({ name: 'Bo', role: 'Sites bouwen' });
    const cas = await t.agent({ name: 'Cas', role: 'Geheim', settings: { private: true } });
    const s: any = { ctx: t.app.ctx, orch: { teamError: () => null } };
    const th = st.thread((await t.api('POST', '/threads', { agentId: ada.id })).id)!;
    const input = st.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', content: 'Mail de afnemer over het tarief' });
    assert.equal(busyNow(s, ada, th, input), null, 'nobody else is working');

    const running = (agentId: string, text: string) => {
      const bth = st.thread(t.app.ctx.chat.threadForAgent(ada.user_id, agentId).id)!;
      const m = st.createMessage({ thread_id: bth.id, role: 'system', author_type: 'system', content: text });
      return st.createRun({ thread_id: bth.id, agent_id: agentId, user_id: ada.user_id, status: 'running', input_message_id: m.id });
    };
    const r1 = running(bo.id, '↳ Bo: Zet de nieuwe prijspagina van de dakensite live\nKlaar als: de pagina antwoordt met 200.');
    running(cas.id, 'Iets wat niemand hoort te zien');
    const text = busyNow(s, ada, th, input)!;
    assert.match(text, /^Nu ook bezig/);
    assert.match(text, /- Bo: Zet de nieuwe prijspagina van de dakensite live\n/);
    assert.doesNotMatch(text, /Cas|niemand hoort/);
    assert.match(text, /stem dan eerst met die collega af/);
    // Bo itself does not read its own line, and a finished turn is gone.
    assert.equal(busyNow(s, st.agent(bo.id)!, st.thread(r1.thread_id)!, input), null);
    st.updateRun(r1.id, { status: 'done' });
    assert.equal(busyNow(s, ada, th, input), null);
  } finally {
    await t.close();
  }
});
