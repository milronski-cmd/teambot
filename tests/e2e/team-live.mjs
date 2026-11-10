// LIVE test of the team features with a real CLI engine (Claude Code, logged in on this computer):
//  1. asynchronous bot messages: a lead asks two Claude Code bots at once, keeps working, and is woken once with both
//     real answers; a Claude Code lead is woken with an answer too
//  2. steering: a running Claude Code turn is interrupted with a steering message (the CLI session continues) and a
//     queued message follows afterwards
//  3. a routine in the bot's main chat uses the chat's context, and a quiet run leaves no trace in the chat
// Uses a temporary TeamBot data folder; Claude Code uses its own login (subscription limits apply, small prompts).
//   npm run team:live            (TEAMBOT_LIVE_MODEL=haiku by default)
import fs from 'node:fs';

const { startTestApp } = await import('../helpers.ts');
const { team, settle, until, msgs, answers } = await import('../team-mock.ts');
const MODEL = process.env.TEAMBOT_LIVE_MODEL || 'haiku';
const results = [];
const check = (name, ok, detail = '') => {
  results.push(!!ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${String(detail).replace(/\s+/g, ' ').slice(0, 220)}` : ''}`);
};
const t = await startTestApp();
const started = Date.now();
try {
  const cli = await t.api('GET', '/cli-agents').catch(() => null);
  const claude = Array.isArray(cli) ? cli.find((c) => c.id === 'claude-code') : cli?.agents?.find?.((c) => c.id === 'claude-code');
  if (claude && !claude.installed) {
    console.log('Claude Code is niet gevonden; installeer en log in (claude auth login).');
    process.exit(0);
  }
  const m = await team(t);
  const prov = await t.api('POST', '/providers', { kind: 'claude-code' });
  const claudeBot = (name, role) => t.api('POST', '/agents', { name, role, provider_id: prov.id, model: MODEL, access_mode: 'readonly', instructions: 'Antwoord kort, in het Nederlands, zonder tools te gebruiken.' });
  const baas = await m.bot('Baas'); // scripted lead (API engine) that uses ask_bot
  const ops = await claudeBot('Operations', 'Operations');
  const ks = await claudeBot('Klantenservice', 'Klantenservice');

  // ---------------------------------------------------------------- 1. asynchronous bot messages
  console.log('\n1. Bot-tot-botberichten (asynchroon)');
  let followUpSaw = '';
  m.script(
    'Baas',
    {
      toolCalls: [
        { name: 'ask_bot', args: { bot: 'Operations', message: 'Noem in één korte zin één manier om de levertijd van webshoporders te verkorten.' } },
        { name: 'ask_bot', args: { bot: 'Klantenservice', message: 'Noem in één korte zin één manier om sneller op klantmails te antwoorden.' } },
      ],
    },
    { text: 'Ik heb Operations en Klantenservice gevraagd; ik wacht niet en ga verder.' },
    // Answers that arrive while the lead is free wake it right away; answers that arrive while it works are bundled.
    { text: 'Antwoord verwerkt.', check: (req) => (followUpSaw += JSON.stringify(req.messages)) },
    { text: 'Antwoord verwerkt.', check: (req) => (followUpSaw += JSON.stringify(req.messages)) },
  );
  const bth = await t.api('POST', '/threads', { agentId: baas.id });
  const t0 = Date.now();
  await t.api('POST', `/threads/${bth.id}/messages`, { content: 'Vraag het team om één verbeterpunt.' });
  await until(() => t.app.ctx.store.one("SELECT id FROM runs WHERE thread_id = ? AND status IN ('done') AND agent_id = ?", bth.id, baas.id), 30_000);
  const leadDone = Date.now() - t0;
  await settle(t, 240_000);
  const ds = t.app.ctx.store.all('SELECT * FROM room_delegations ORDER BY created_at').map((r) => t.app.ctx.store.decode('room_delegations', r));
  check('lead was klaar voordat de antwoorden binnen waren (niet blokkerend)', leadDone < Math.min(...ds.map((d) => Date.parse(d.finished_at) - t0)), `lead ${leadDone} ms`);
  check('beide Claude Code-bots antwoordden', ds.length === 2 && ds.every((d) => d.status === 'done' && (d.result || '').length > 5), ds.map((d) => `${d.status}: ${d.result}`).join(' | '));
  const opsChat = t.app.ctx.chat.threadForAgent(baas.user_id, ops.id);
  check('vraag en antwoord staan in de eigen chat van Operations', msgs(t, opsChat.id).some((x) => x.parts.kind === 'bot_ask' && /^Baas vraagt/.test(x.content)) && answers(t, opsChat.id).length > 0);
  const notes = msgs(t, bth.id).filter((x) => x.parts.kind === 'delegation_result');
  check('lead kreeg beide antwoorden ("… antwoordde")', notes.length === 2 && notes.every((n) => /antwoordde/.test(n.content)));
  const leadRuns = t.app.ctx.store.all('SELECT * FROM runs WHERE thread_id = ? AND agent_id = ? ORDER BY created_at', bth.id, baas.id).map((r) => t.app.ctx.store.decode('runs', r));
  check(
    'lead werd gewekt met de antwoorden (één vervolgbeurt per moment dat hij vrij was, nooit midden in een beurt)',
    leadRuns.length >= 2 && leadRuns.length <= 3 && leadRuns.slice(1).every((r) => r.meta?.team?.kind === 'followup' && r.status === 'done') && /antwoordde op je bericht/.test(followUpSaw) && ds.every((d) => d.delivered),
    `${leadRuns.length - 1} vervolgbeurt(en)`,
  );

  // A Claude Code lead (CLI engines get ask_bot through the MCP bridge; here the tool is called on its behalf).
  const lead2 = await claudeBot('Planner', 'Planner');
  const pth = await t.api('POST', '/threads', { agentId: lead2.id });
  await t.api('POST', `/threads/${pth.id}/messages`, { content: 'Straks krijg je van Operations een getal. Herhaal dat getal dan in je antwoord. Zeg nu alleen: begrepen.' });
  await settle(t, 120_000);
  const s = t.app.ctx.store;
  const prun = s.all('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at DESC LIMIT 1', pth.id).map((r) => s.decode('runs', r))[0];
  await t.app.ctx.tools.get('ask_bot').run({ bot: 'Operations', message: 'Hoeveel dagen heeft een week? Antwoord met alleen het getal.' }, { ctx: t.app.ctx, agent: s.agent(lead2.id), thread: s.thread(pth.id), run: prun, userId: lead2.user_id, signal: new AbortController().signal, toolCallId: 'live_call', progress() {} });
  await settle(t, 180_000);
  const wake = s.all('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at', pth.id).map((r) => s.decode('runs', r));
  const last = answers(t, pth.id).at(-1);
  check('Claude Code-lead werd gewekt en gebruikte het antwoord', wake.length === 2 && wake[1].status === 'done' && wake[1].meta?.team?.kind === 'followup' && /\b7\b|zeven/i.test(last?.content || ''), last?.content);

  // ---------------------------------------------------------------- 2. steering + queue on a CLI engine
  console.log('\n2. Bijsturen en wachtrij (Claude Code)');
  const sth = await t.api('POST', '/threads', { agentId: ops.id });
  await t.api('POST', `/threads/${sth.id}/queue`, { content: 'Schrijf een gedicht van twintig regels over koffie.' });
  await until(() => s.one("SELECT id FROM runs WHERE thread_id = ? AND status = 'running'", sth.id), 30_000);
  const q1 = await t.api('POST', `/threads/${sth.id}/queue`, { content: 'Hoeveel regels had je gedicht? Antwoord met alleen het getal.' });
  check('tweede bericht staat in de wachtrij (niet in het gesprek)', q1.mode === 'queued' && !msgs(t, sth.id).some((x) => x.content.startsWith('Hoeveel regels')));
  const st = await t.api('POST', `/threads/${sth.id}/steer`, { content: 'Stop, maak er een gedicht van twee regels over thee van.', interrupt: true });
  check('bijsturen onderbreekt de CLI-beurt', st.mode === 'interrupted');
  await settle(t, 240_000);
  const sruns = s.all('SELECT status FROM runs WHERE thread_id = ? ORDER BY created_at', sth.id).map((r) => r.status);
  check('beurten: onderbroken, bijgestuurd, wachtrij', JSON.stringify(sruns) === JSON.stringify(['cancelled', 'done', 'done']), sruns.join(','));
  const sa = answers(t, sth.id).filter((x) => x.status === 'done').map((x) => x.content);
  check('antwoord volgt de bijsturing (thee)', /thee/i.test(sa.at(-2) || ''), sa.at(-2));
  check('vervolgvraag uit de wachtrij beantwoord met context', /\b2\b|twee/i.test(sa.at(-1) || ''), sa.at(-1));

  // ---------------------------------------------------------------- 3. routine in the main chat
  console.log('\n3. Routine in de hoofdchat');
  const kchat = t.app.ctx.chat.threadForAgent(baas.user_id, ks.id);
  await t.api('POST', `/threads/${kchat.id}/messages`, { content: 'Onthoud dit codewoord voor straks: pelikaan. Zeg alleen: onthouden.' });
  await settle(t, 120_000);
  const r1 = await t.api('POST', '/routines', { name: 'Codewoord', agent_id: ks.id, prompt: 'Welk codewoord gaf ik je eerder in deze chat? Antwoord met alleen dat woord.', schedule: { kind: 'none' }, options: { runIn: 'main' } });
  const rr1 = await t.api('POST', `/routines/${r1.id}/run`, { test: false });
  await settle(t, 120_000);
  await t.app.ctx.services.routines.engine.idle(60_000);
  const row1 = t.app.ctx.services.routines.engine.getRun(rr1.id);
  check('routine draaide in de hoofdchat en kende de context', row1.status === 'done' && row1.thread_id === kchat.id && /pelikaan/i.test(row1.summary), row1.summary || row1.error);
  const r2 = await t.api('POST', '/routines', { name: 'Stil', agent_id: ks.id, prompt: 'Er is niets nieuws. Antwoord met precies: ROUTINE_NO_UPDATE', schedule: { kind: 'none' }, options: { runIn: 'main' } });
  const before = msgs(t, kchat.id).length;
  const rr2 = await t.api('POST', `/routines/${r2.id}/run`, { test: false });
  await settle(t, 120_000);
  await t.app.ctx.services.routines.engine.idle(60_000);
  const row2 = t.app.ctx.services.routines.engine.getRun(rr2.id);
  check('stille routine-run laat de hoofdchat leeg', row2.status === 'no_update' && msgs(t, kchat.id).length === before, `${row2.status}`);
} catch (e) {
  check('onverwachte fout', false, e?.stack || e?.message || e);
} finally {
  await t.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd in ${Math.round((Date.now() - started) / 1000)} s`);
process.exit(failed ? 1 : 0);
