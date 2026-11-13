/**
 * Organisation (0.4, package C): the main bot (hoofdbot), leaders and team leads. With the mock provider:
 *  - the owner makes the main bot (a single-use choice in the new-bot flow); only one is allowed, a template never makes one;
 *  - the main bot hands a request to the lead of the right team (of two), the lead passes part on to a bot of its team,
 *    and the result comes back up the same chain with its evidence (not the lead's interim "I passed it on");
 *  - a leader with aansturen on two teams directs both leads;
 *  - a bot without aansturen cannot direct another team, also not through a leader or the main bot (refused in code);
 *  - a 4th hop and an A→B→A cycle are refused with a clear message;
 *  - one team with the main bot and specialists without a team lead: the main bot gives work straight to the bot whose
 *    role fits, and nothing nags about a missing lead;
 *  - the overview "Alle teams" shows both teams correctly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import type { ChatRequest, ChatResult, StreamEvent } from '../server/core/types.js';

interface BotStep {
  text?: string;
  toolCalls?: { name: string; args: any }[];
  delayMs?: number;
}

let seq = 0;

/** One mock provider for several bots: each bot (by its name in the system prompt) has its own script. */
async function org(t: TestApp) {
  const scripts = new Map<string, BotStep[]>();
  const calls: { bot: string; req: ChatRequest }[] = [];
  t.app.ctx.providers.registerKind({
    id: 'mockorg',
    label: 'Mock org',
    type: 'api',
    needsKey: false,
    description: 'test',
    models: ['mock-1'],
    defaultModel: 'mock-1',
    create: () => ({
      kind: 'mockorg',
      async listModels() {
        return [{ id: 'mock-1' }];
      },
      async test() {
        return { ok: true, detail: 'mock' };
      },
      async chat(req: ChatRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<ChatResult> {
        const bot = /^Je bent (.+?)(?: — |, een AI-agent)/.exec(req.system)?.[1] || '?';
        calls.push({ bot, req });
        const step = scripts.get(bot)?.shift();
        if (step?.delayMs)
          await new Promise<void>((res, rej) => {
            const tm = setTimeout(res, step.delayMs);
            signal.addEventListener('abort', () => (clearTimeout(tm), rej(signal.reason || new Error('aborted'))), { once: true });
          });
        const text = step ? step.text ?? '' : `${bot}: ok`;
        if (text) onEvent({ type: 'text', delta: text });
        const toolCalls = (step?.toolCalls || []).map((c) => ({ id: `call_org_${++seq}`, name: c.name, args: c.args }));
        return { text, toolCalls, usage: { input: 10, output: 5 }, stop: toolCalls.length ? 'tool_use' : 'end', model: req.model };
      },
    }),
  });
  const prov = await t.api('POST', '/providers', { kind: 'mockorg' });
  return {
    calls,
    bot: (name: string, data: any = {}) => t.api('POST', '/agents', { name, provider_id: prov.id, model: 'mock-1', access_mode: 'auto', tool_groups: ['team'], ...data }),
    script(name: string, ...steps: BotStep[]) {
      scripts.set(name, [...(scripts.get(name) || []), ...steps]);
    },
    systemOf: (name: string) => calls.filter((c) => c.bot === name).at(-1)?.req.system || '',
  };
}

/** Wait until no run is active anywhere (follow-ups start right after a run ends, so require a few quiet ticks). */
async function settle(t: TestApp, ms = 15_000) {
  const start = Date.now();
  let quiet = 0;
  while (Date.now() - start < ms) {
    const busy = t.app.ctx.store.all("SELECT id FROM runs WHERE status IN ('queued','running','waiting')");
    if (!busy.length) {
      if (++quiet >= 5) return;
    } else quiet = 0;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('timeout waiting for runs to settle');
}

const msgs = (t: TestApp, threadId: string) => t.app.ctx.store.messages(threadId);
const answers = (t: TestApp, threadId: string) => msgs(t, threadId).filter((m) => m.role === 'assistant' && m.content);
const toolOf = (t: TestApp, who: string) => t.app.ctx.store.all<{ content: string }>("SELECT content FROM messages WHERE role = 'tool' AND author_name = ? ORDER BY created_at, seq", who).map((x) => x.content);
const deleg = (t: TestApp, to: string) => t.app.ctx.store.all<any>('SELECT * FROM room_delegations WHERE to_agent_id = ? ORDER BY created_at', to);

/** Two teams: Webshop (lead Lea, Kim, leader Lars) and Bouw (lead Bob, Ben, Bea); the main bot Baas, made by the owner. */
async function company() {
  const t = await startTestApp();
  const o = await org(t);
  const lea = await o.bot('Lea', { role: 'Teamleider webshop' });
  const [def] = await t.api('GET', '/teams');
  const webshop = await t.api('PATCH', `/teams/${def.id}`, { name: 'Webshop' });
  const bouw0 = await t.api('POST', '/teams', { name: 'Bouw' });
  const kim = await o.bot('Kim', { role: 'Technische SEO' });
  const lars = await o.bot('Lars', { role: 'Operationeel leider' });
  const bob = await o.bot('Bob', { role: 'Teamleider bouw', settings: { homeTeam: bouw0.id } });
  const ben = await o.bot('Ben', { role: 'Bouwer', settings: { homeTeam: bouw0.id } });
  const bea = await o.bot('Bea', { role: 'Tester', settings: { homeTeam: bouw0.id } });
  await t.api('PATCH', `/teams/${webshop.id}`, { leadAgentId: lea.id });
  const bouw = await t.api('PATCH', `/teams/${bouw0.id}`, { leadAgentId: bob.id });
  // Lars is a leader: home team Webshop and aansturen on Bouw.
  await t.api('PUT', `/teams/${bouw.id}/access/${lars.id}`, { level: 'direct' });

  // The owner makes the main bot in the new-bot flow: the choice is a single-use token in settings.mainBot.
  const { token } = await t.api('POST', '/teams/main/intent', {});
  const baas = await o.bot('Baas', { role: 'Hoofdbot', settings: { mainBot: token } });
  return { t, o, webshop, bouw, lea, kim, lars, bob, ben, bea, baas };
}

test('the owner makes one main bot; a second one, a reused choice or a template flag never makes one', async () => {
  const c = await company();
  const { t, o } = c;
  try {
    const main = await t.api('GET', '/teams/main');
    assert.equal(main.main?.id, c.baas.id);
    // The flag is gone from the bot (never exported or copied with it).
    assert.equal(t.app.ctx.store.agent(c.baas.id)!.settings.mainBot, undefined);
    const bv = await t.api('GET', `/teams/bots/${c.baas.id}`);
    assert.equal(bv.main, true);
    // It directs every team, also one made later.
    const later = await t.api('POST', '/teams', { name: 'Later' });
    assert.ok(t.app.ctx.services.teams.canDirect(c.baas.id, c.bouw.id));
    assert.ok(t.app.ctx.services.teams.canDirect(c.baas.id, later.id));
    // …but writes nothing there: aansturen includes meekijken, never schrijven.
    assert.equal(t.app.ctx.services.teams.canWrite(c.baas.id, c.bouw.id), false);
    await t.api('DELETE', `/teams/${later.id}`);

    // Only one main bot, always: another bot that becomes it takes the role over (nothing to undo first).
    const swap = await t.api('PUT', `/teams/main/${c.kim.id}`, {});
    assert.equal(swap.main.id, c.kim.id);
    assert.match(swap.notes.join(' '), /Baas is nu een gewone bot/);
    assert.equal(t.app.ctx.services.teams.canDirect(c.baas.id, c.bouw.id), false, 'the old main bot no longer directs other teams');
    assert.equal((await t.api('PUT', `/teams/main/${c.baas.id}`, {})).main.id, c.baas.id);
    // A template that carries the flag, or a used token, makes a normal bot.
    const tpl = await t.api('POST', '/agents/import', { format: 'teambot.agent/v1', name: 'Sjabloon', settings: { mainBot: true } });
    assert.equal(t.app.ctx.services.teams.isMain(tpl.id), false);
    assert.equal(t.app.ctx.store.agent(tpl.id)!.settings.mainBot, undefined);
    // "Gewone bot maken": there is always a main bot, so the oldest bot that leads no team takes over.
    assert.equal((await t.api('DELETE', '/teams/main')).main.id, c.kim.id);
    assert.equal(t.app.ctx.services.teams.canDirect(c.baas.id, c.bouw.id), false);
    // An existing bot becomes the main bot; a lead stops being lead, and says so.
    const r = await t.api('PUT', `/teams/main/${c.lea.id}`, {});
    assert.equal(r.main.id, c.lea.id);
    assert.match(r.notes.join(' '), /Lea is geen teamleider meer van team “Webshop”/);
    assert.equal((await t.api('GET', `/teams/${c.webshop.id}`)).leadAgentId, null);
    // The main bot stands above the teams: made team lead, it hands the main role to another bot.
    await t.api('PATCH', `/teams/${c.webshop.id}`, { leadAgentId: c.lea.id });
    assert.equal((await t.api('GET', `/teams/${c.webshop.id}`)).leadAgentId, c.lea.id);
    assert.equal((await t.api('GET', '/teams/main')).main.id, c.kim.id);
    // An unknown or used token makes a normal bot.
    const used = await o.bot('Nog een', { settings: { mainBot: 'mbi_onbekend' } });
    assert.equal(t.app.ctx.services.teams.isMain(used.id), false);
    // A bot without the team tools gets them when it becomes the main bot (it must hand work on), and is told so.
    const plain = await o.bot('Zonder tools', { tool_groups: ['files'] });
    const r2 = await t.api('PUT', `/teams/main/${plain.id}`, {});
    assert.ok(r2.notes.some((n: string) => /‘Team & samenwerking’ staan nu aan voor Zonder tools/.test(n)));
    assert.ok(t.app.ctx.store.agent(plain.id)!.tool_groups.includes('team'));
  } finally {
    await t.close();
  }
});

test('the main bot hands a request to the lead of the right team; the result comes back up the chain with evidence', async () => {
  const c = await company();
  const { t, o } = c;
  try {
    o.script(
      'Baas',
      { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bob', task: 'Bouw een landingspagina voor de actie.', expected_output: 'Klaar als: de pagina staat online. Bewijs: de link.' } }] },
      { text: 'Ik heb het aan Bob van team Bouw gegeven.' },
      { text: 'Klaar: de landingspagina staat online. Bewijs: https://example.com/actie (gebouwd door Ben, gecontroleerd door Bob).' },
    );
    o.script(
      'Bob',
      { toolCalls: [{ name: 'delegate_task', args: { bot: 'Ben', task: 'Schrijf index.html voor de actiepagina.', expected_output: 'Klaar als: het bestand bestaat. Bewijs: de bestandsnaam.' } }] },
      { text: 'Ben is ermee bezig.' },
      { text: 'Gecontroleerd: de pagina staat online. Bewijs: https://example.com/actie en index.html van Ben.' },
    );
    o.script('Ben', { text: 'index.html geschreven. Bewijs: bestand index.html (2 kB).' });
    const th = await t.api('POST', '/threads', { agentId: c.baas.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Maak een landingspagina voor de actie.' });
    await settle(t);

    // The main bot's prompt: its job and both teams with their lead and bots (with their role); never itself.
    const sys = o.systemOf('Baas');
    assert.match(sys, /## Hoofdbot\nJij bent de hoofdbot/);
    assert.match(sys, /“Klaar als: …”/);
    assert.match(sys, /Doe het werk van een team of een specialist nooit zelf/);
    assert.match(sys, /### Team “Webshop”\n- Lea \(Teamleider webshop\) — teamleider/);
    assert.match(sys, /### Team “Bouw”\n- Bob \(Teamleider bouw\) — teamleider\n- Bea \(Tester\)\n- Ben \(Bouwer\)/);
    assert.doesNotMatch(sys, /- Baas/);
    // The lead's prompt says it is the lead with the last word.
    assert.match(o.systemOf('Bob'), /## Teamleider\nJij bent de teamleider van team “Bouw” en hebt het laatste woord/);

    const [toBob] = deleg(t, c.bob.id);
    const [toBen] = deleg(t, c.ben.id);
    assert.equal(toBob.status, 'done');
    assert.equal(toBen.status, 'done');
    // Bob's result is his checked answer after Ben's work, not his interim "Ben is ermee bezig".
    assert.match(toBob.result, /Gecontroleerd: de pagina staat online\. Bewijs: https:\/\/example\.com\/actie/);
    assert.equal(toBen.parent_thread_id, toBob.thread_id);
    assert.deepEqual(JSON.parse(toBen.path), [c.baas.id, c.bob.id, c.ben.id]);
    // Every hop is visible: Ben's task names the chain, Bob's subtask says what it waits for.
    const benTask = msgs(t, toBen.thread_id).find((m) => m.parts?.kind === 'delegation_task')!;
    assert.match(benTask.content, /Keten: Baas → Bob → Ben\./);
    assert.ok(msgs(t, toBob.thread_id).some((m) => m.parts?.kind === 'delegation_waiting' && /Bob wacht op Ben; daarna gaat het resultaat terug naar Baas/.test(m.content)));
    // The main bot got exactly one result (with the evidence) and reported it in plain words.
    const notes = msgs(t, th.id).filter((m) => m.parts?.kind === 'delegation_result');
    assert.equal(notes.length, 1);
    assert.match(notes[0].content, /Bewijs: https:\/\/example\.com\/actie/);
    assert.doesNotMatch(notes[0].content, /Ben is ermee bezig/);
    assert.match(answers(t, th.id).at(-1)!.content, /Klaar: de landingspagina staat online\. Bewijs: https:\/\/example\.com\/actie/);

    // The overview "Alle teams" shows both teams correctly.
    const ov = await t.api('GET', '/teams/overview');
    assert.equal(ov.main.id, c.baas.id);
    assert.deepEqual(ov.main.notDirected, []);
    assert.deepEqual(
      ov.leaders.map((l: any) => [l.name, l.teams]),
      [['Lars', [c.webshop.id, c.bouw.id]]],
    );
    const [w, b] = ov.teams;
    assert.equal(w.name, 'Webshop');
    assert.equal(w.lead.name, 'Lea');
    assert.deepEqual(w.bots.map((x: any) => x.name), ['Lea', 'Kim', 'Lars']);
    assert.equal(b.name, 'Bouw');
    assert.equal(b.lead.name, 'Bob');
    assert.deepEqual(b.bots.map((x: any) => x.name), ['Bob', 'Bea', 'Ben']);
    assert.deepEqual(b.directedBy.map((x: any) => x.name), ['Baas', 'Lars']);
    assert.ok(b.directedBy[0].main);
    assert.deepEqual(b.results.map((x: any) => x.who).sort(), ['Ben', 'Bob']);
    assert.equal(w.results.length, 0);
    assert.ok(!w.bots.some((x: any) => x.id === c.baas.id), 'the main bot stands above the teams');
  } finally {
    await t.close();
  }
});

test('a leader with aansturen on two teams directs both leads', async () => {
  const c = await company();
  const { t, o } = c;
  try {
    o.script(
      'Lars',
      {
        toolCalls: [
          { name: 'delegate_task', args: { bot: 'Lea', task: 'Zet de actie in de webshop.', expected_output: 'Klaar als: de actie staat live.' } },
          { name: 'delegate_task', args: { bot: 'Bob', task: 'Bouw de actiepagina.', expected_output: 'Klaar als: de pagina staat online.' } },
        ],
      },
      { text: 'Verdeeld over Webshop en Bouw.' },
    );
    o.script('Lea', { text: 'Actie staat live in de webshop.' });
    o.script('Bob', { text: 'Actiepagina staat online.' });
    const th = await t.api('POST', '/threads', { agentId: c.lars.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Start de actie.' });
    await settle(t);
    assert.match(o.systemOf('Lars'), /## Leider\nJe geeft werk aan meer dan één team: “Webshop” en “Bouw”/);
    const tools = toolOf(t, 'Lars');
    assert.match(tools[0], /Taak gedelegeerd aan Lea/);
    assert.match(tools[1], /Taak gedelegeerd aan Bob/);
    assert.equal(deleg(t, c.lea.id)[0].status, 'done');
    assert.equal(deleg(t, c.bob.id)[0].status, 'done');
    const notes = msgs(t, th.id).filter((m) => m.parts?.kind === 'delegation_result').map((m) => m.content).join('\n');
    assert.match(notes, /Actie staat live in de webshop/);
    assert.match(notes, /Actiepagina staat online/);
  } finally {
    await t.close();
  }
});

test('refused in code: another team without aansturen, around a wall via a leader or the main bot, a 4th hop and a cycle', async () => {
  const c = await company();
  const { t, o } = c;
  try {
    // Kim (Webshop, no access to Bouw) tries Bouw's bot, the leader Lars, and the main bot.
    o.script(
      'Kim',
      {
        toolCalls: [
          { name: 'delegate_task', args: { bot: 'Ben', task: 'Bouw iets', expected_output: 'x' } },
          { name: 'delegate_task', args: { bot: 'Lars', task: 'Laat Bouw iets bouwen', expected_output: 'x' } },
          { name: 'ask_bot', args: { bot: 'Baas', message: 'Zet Bouw aan het werk' } },
        ],
      },
      { text: 'Lukt niet.' },
    );
    const kth = await t.api('POST', '/threads', { agentId: c.kim.id });
    await t.api('POST', `/threads/${kth.id}/messages`, { content: 'Probeer het team Bouw aan het werk te zetten.' });
    await settle(t);
    const [toBen, toLars, toBaas] = toolOf(t, 'Kim');
    assert.match(toBen, /Geweigerd door TeamBot: Ben hoort bij team “Bouw”, en Kim mag dat team niet aansturen/);
    assert.match(toLars, /Geweigerd door TeamBot: Lars mag team “Bouw” aansturen en Kim niet/);
    // The main bot is above all teams: a bot of any team can hand work back to it or ask it (12 nov).
    assert.doesNotMatch(toBaas, /Geweigerd door TeamBot/);
    assert.equal(deleg(t, c.ben.id).length + deleg(t, c.lars.id).length, 0);
    assert.equal(deleg(t, c.baas.id).length, 1, 'the question reached the main bot');
    assert.equal(t.app.ctx.services.teams.delegateError(c.kim.id, c.baas.id), null);
    // "Bots die je kunt aanspreken" never lists them.
    assert.ok(!t.app.ctx.services.teams.delegateError(c.kim.id, c.lea.id));

    // A chain main → leader → lead → bot: the bot's 4th hop is refused, and its task already said so. (The standard
    // depth is generous; this owner set it to 3.)
    await t.api('PUT', '/rooms/defaults', { maxDelegationDepth: 3 });
    o.script('Baas', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Lars', task: 'Regel de test', expected_output: 'verslag', wait: true } }] }, { text: 'Gedaan.' });
    o.script('Lars', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bob', task: 'Regel de test', expected_output: 'verslag', wait: true } }] }, { text: 'Bob regelde het.' });
    o.script('Bob', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Ben', task: 'Test de pagina', expected_output: 'verslag', wait: true } }] }, { text: 'Ben testte het.' });
    o.script('Ben', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Bea', task: 'Test jij het', expected_output: 'verslag', wait: true } }] }, { text: 'Zelf getest: alles werkt.' });
    const bth = await t.api('POST', '/threads', { agentId: c.baas.id });
    await t.api('POST', `/threads/${bth.id}/messages`, { content: 'Laat de pagina testen.' });
    await settle(t);
    assert.match(toolOf(t, 'Ben')[0], /delegatiediepte van 3 bereikt \(Baas → Lars → Bob → Ben\)/);
    assert.equal(deleg(t, c.bea.id).length, 0);
    const benTask = msgs(t, deleg(t, c.ben.id)[0].thread_id).find((m) => m.parts?.kind === 'delegation_task')!;
    assert.match(benTask.content, /Keten: Baas → Lars → Bob → Ben\. Dit werk is al 3 keer doorgegeven, het maximum/);
    assert.match(answers(t, bth.id).at(-1)!.content, /Gedaan/);

    // A → B → A: Lea gives Kim work, Kim tries to give it back.
    o.script('Lea', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Kim', task: 'Check de titels', expected_output: 'lijst', wait: true } }] }, { text: 'Kim heeft gekeken.' });
    o.script('Kim', { toolCalls: [{ name: 'delegate_task', args: { bot: 'Lea', task: 'Doe jij het maar', expected_output: 'lijst', wait: true } }] }, { text: 'Titels gecheckt.' });
    const lth = await t.api('POST', '/threads', { agentId: c.lea.id });
    await t.api('POST', `/threads/${lth.id}/messages`, { content: 'Check de titels.' });
    await settle(t);
    assert.match(toolOf(t, 'Kim').at(-1)!, /Geweigerd om een lus te voorkomen: Lea zit al in deze keten \(Lea → Kim → Lea\)/);
    assert.equal(deleg(t, c.lea.id).length, 0);
  } finally {
    await t.close();
  }
});

test('one team, the main bot and specialists without a team lead: work goes straight to the right specialist', async () => {
  const t = await startTestApp();
  const o = await org(t);
  try {
    await o.bot('Rik', { role: 'Researcher' });
    await o.bot('Sam', { role: 'Technische SEO' });
    await o.bot('Cor', { role: 'Content NL' });
    const { token } = await t.api('POST', '/teams/main/intent', {});
    const baas = await o.bot('Baas', { settings: { mainBot: token } });
    const [team] = await t.api('GET', '/teams');
    assert.equal(team.leadAgentId, null);
    o.script(
      'Baas',
      { toolCalls: [{ name: 'delegate_task', args: { bot: 'Sam', task: 'Controleer de laadtijd van de homepage.', expected_output: 'Klaar als: laadtijd gemeten. Bewijs: het meetrapport.' } }] },
      { text: 'Sam kijkt ernaar.' },
      { text: 'Sam heeft het gemeten: 1,2 s. Bewijs: meetrapport-homepage.txt.' },
    );
    o.script('Sam', { text: 'Laadtijd 1,2 s. Bewijs: meetrapport-homepage.txt' });
    const th = await t.api('POST', '/threads', { agentId: baas.id });
    await t.api('POST', `/threads/${th.id}/messages`, { content: 'Is de homepage snel genoeg?' });
    await settle(t);
    const sys = o.systemOf('Baas');
    assert.match(sys, /Bots in je team \(met hun rol\):\n- Cor \(Content NL\)\n- Rik \(Researcher\)\n- Sam \(Technische SEO\)/);
    assert.match(sys, /Heeft het team geen teamleider, geef elke taak dan zelf aan de bot wiens rol het best past/);
    // One team: no team words for the specialists, and no lead block anywhere.
    assert.equal(o.systemOf('Sam').includes('## Teams'), false);
    assert.equal(o.systemOf('Sam').includes('## Teamleider'), false);
    assert.equal(deleg(t, t.app.ctx.store.agents(baas.user_id).find((a) => a.name === 'Sam')!.id)[0].status, 'done');
    assert.match(answers(t, th.id).at(-1)!.content, /Bewijs: meetrapport-homepage\.txt/);
    // The overview simply shows the main bot above the bots: no lead, no warning.
    const ov = await t.api('GET', '/teams/overview');
    assert.equal(ov.main.name, 'Baas');
    assert.equal(ov.teams.length, 1);
    assert.equal(ov.teams[0].lead, null);
    assert.deepEqual(ov.teams[0].bots.map((b: any) => b.name), ['Cor', 'Rik', 'Sam']);
    assert.equal(ov.teams[0].results[0].who, 'Sam');
    assert.deepEqual(ov.leaders, []);
    assert.doesNotMatch(JSON.stringify(ov), /teamleider/i);
  } finally {
    await t.close();
  }
});

test('the overview counts open tasks, what waits for you, errors and missed runs per team', async () => {
  const c = await company();
  const { t } = c;
  try {
    const store = t.app.ctx.store;
    // A task for Bob (Bouw) that waits for the owner's check, and an open task for Kim (Webshop).
    await t.api('POST', '/rooms/tasks', { title: 'Pagina nakijken', ownerType: 'agent', ownerId: c.bob.id, status: 'review' });
    await t.api('POST', '/rooms/tasks', { title: 'Titels verbeteren', ownerType: 'agent', ownerId: c.kim.id });
    // A failed turn of Ben, and a missed routine run of Bea.
    const th = await t.api('POST', '/threads', { agentId: c.ben.id });
    const ts = new Date().toISOString();
    store.insert('runs', { id: 'run_fout', thread_id: th.id, agent_id: c.ben.id, user_id: c.ben.user_id, status: 'error', trigger: 'user', error: 'De engine gaf een fout', usage: { input: 0, output: 0 }, meta: {}, created_at: ts, finished_at: ts });
    if (store.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'routine_runs'")) {
      store.exec("INSERT INTO routines (id, user_id, agent_id, name, created_at, updated_at) VALUES ('rt_1', ?, ?, 'Dagelijkse test', ?, ?)", c.bea.user_id, c.bea.id, ts, ts);
      store.exec("INSERT INTO routine_runs (id, routine_id, user_id, run_key, trigger, status, summary, created_at) VALUES ('rr_1', 'rt_1', ?, 'rt_1@missed', 'schedule', 'missed', '1 geplande run gemist', ?)", c.bea.user_id, ts);
    }
    const ov = await t.api('GET', '/teams/overview');
    const w = ov.teams.find((x: any) => x.name === 'Webshop');
    const b = ov.teams.find((x: any) => x.name === 'Bouw');
    assert.equal(w.open.count, 1);
    assert.equal(w.open.items[0].title, 'Titels verbeteren');
    assert.equal(w.waiting.count, 0);
    assert.equal(b.open.count, 1);
    assert.equal(b.waiting.count, 1);
    assert.equal(b.waiting.items[0].kind, 'review');
    assert.equal(b.errors.count, 1);
    assert.match(b.errors.items[0].title, /De engine gaf een fout/);
    assert.equal(w.errors.count, 0);
    if (store.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'routine_runs'")) {
      assert.equal(b.missed.count, 1);
      assert.match(b.missed.items[0].title, /Dagelijkse test/);
    }
    // Usage: since package B2 the usage module groups by team itself (before that the bots' numbers were added up).
    if (ov.usage) assert.equal(ov.usage.source, 'team');
    for (const x of ov.teams) assert.ok(typeof x.usage?.today?.calls === 'number' && typeof x.usage?.week?.cost === 'number', `${x.name}: usage per team`);
  } finally {
    await t.close();
  }
});
