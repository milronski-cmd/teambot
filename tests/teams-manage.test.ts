/**
 * "De hoofdbot moet alles kunnen": teambot_find and teambot_do (server/modules/teams/manage.ts), as the main bot uses
 * them. What every other bot does with them, and the walls around that, is in teams-every-bot.test.ts.
 *  - the main bot has them in its list; every other bot has them on demand (tools_find, tools_call);
 *  - looking (GET) runs without a question, a change (POST, PATCH, PUT) changes something real as the owner;
 *  - deleting asks the owner first, with a plain Dutch line on the card;
 *  - keys, sessions, back-up restore, the main-bot designation and approval cards never go through the tool;
 *  - anything about money asks at every access level, also "Volledige toegang" with versturen naar anderen;
 *  - more access for a bot asks the owner even when the gate would not;
 *  - the route list is made from the registered routes and finds a call by a word.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownerTurn, startTestApp, type TestApp } from './helpers.js';
import { MANAGE_DO, MANAGE_FIND, MANAGE_TOOL_NAMES, planCall, refusal, routesOf } from '../server/modules/teams/manage.js';
import { callAsUser } from '../server/modules/teams/inner.js';
import { CALL_NAME, FIND_NAME } from '../server/tools/selection.js';
import { checkinSettings } from '../server/modules/teams/proactive.js';
import { callRisk } from '../server/tools/broker.js';
import type { ToolDef, ToolOutput } from '../server/core/types.js';
import { fillWords } from '../shared/i18n-core.js';

async function setup() {
  const t: TestApp = await startTestApp();
  const ctx = t.app.ctx;
  const userId = ctx.auth.owner()!.id;
  const main = await t.agent({ name: 'Baas' });
  await t.api('PUT', `/teams/main/${main.id}`);
  const other = await t.agent({ name: 'Rik', role: 'Schrijver' });
  const tools: ToolDef[] = ctx.services.teams.manageTools;
  const tool = (name: string) => tools.find((x) => x.name === name)!;
  const thread = ctx.chat.threadForAgent(userId, main.id);
  /** Run a tool as a bot in a turn the owner started, the way the runner calls it after the gate (`approved`: the owner said yes on the card). */
  const run = async (agentId: string, name: string, args: any = {}, approved = false): Promise<ToolOutput> => {
    const agent = ctx.store.agent(agentId)!;
    const out = await tool(name).run(args, { ctx, agent, thread: ctx.chat.threadForAgent(userId, agentId), userId, run: ownerTurn(ctx, userId, agentId), signal: new AbortController().signal, toolCallId: 'c1', progress() {}, approved });
    return typeof out === 'string' ? { text: out } : out;
  };
  /** What the gate decides for one call of a bot (the runner's own steps: refuse, risk per call, decide). */
  const gate = (agentId: string, args: any) => {
    const agent = ctx.store.agent(agentId)!;
    const def = tool(MANAGE_DO);
    const who = { agent, thread: ctx.chat.threadForAgent(userId, agentId), userId };
    const refused = def.refuse!(args, who);
    const risk = callRisk(def, args, who);
    return { refused, risk, decision: ctx.broker.decide(agent, { name: def.name, risk, impact: def.impact }, args), summary: fillWords(def.summarize!(args, { agent })) };
  };
  const pending = async () => (await t.api('GET', '/approvals')).filter((x: any) => x.status === 'pending');
  const card = async (): Promise<any> => {
    for (let i = 0; i < 200; i++) {
      const c = (await pending())[0];
      if (c) return c;
      await new Promise((r) => setTimeout(r, 25));
    }
    throw new Error('no card');
  };
  return { t, ctx, userId, main, other, tools, tool, thread, run, gate, pending, card };
}

test('the main bot has teambot_find and teambot_do in its list; every other bot has them too, on demand', async () => {
  const e = await setup();
  try {
    assert.deepEqual(e.tools.map((x) => x.name), [...MANAGE_TOOL_NAMES]);
    const names = async (id: string) => (await e.ctx.tools.forAgent(e.ctx.store.agent(id)!, e.ctx.chat.threadForAgent(e.userId, id))).map((x) => x.name);
    for (const n of MANAGE_TOOL_NAMES) {
      assert.ok((await names(e.main.id)).includes(n), `the main bot has ${n}`);
      assert.ok((await names(e.other.id)).includes(n), `Rik has ${n}`);
    }
    // What a model is sent with every call: the main bot the two tools themselves, Rik only their names in tools_find.
    e.t.script.push({ text: 'Hallo.' });
    await e.t.say(e.thread.id, 'Hoi');
    const sent = e.t.requests.at(-1)!;
    for (const n of MANAGE_TOOL_NAMES) assert.ok(sent.tools.some((x) => x.name === n), `the main bot is listed ${n}`);
    // The main bot's job says so, in plain Dutch.
    const sys = JSON.stringify(sent);
    assert.match(sys, /Alles wat de eigenaar in TeamBot zelf kan doen, doe jij voor hem/);
    assert.match(sys, /teambot_find en voer haar uit met teambot_do/);
    assert.match(sys, /Geld blijft bij de eigenaar/);
    e.t.script.push({ text: 'Hallo.' });
    await e.t.say(e.ctx.chat.threadForAgent(e.userId, e.other.id).id, 'Hoi');
    const rik = e.t.requests.at(-1)!;
    for (const n of MANAGE_TOOL_NAMES) assert.ok(!rik.tools.some((x) => x.name === n), `Rik is not listed ${n} with every call`);
    assert.ok(rik.tools.some((x) => x.name === CALL_NAME));
    assert.match(rik.tools.find((x) => x.name === FIND_NAME)!.description, /\bteambot_find, teambot_do\b/, 'named where Rik looks for a tool');
    assert.match(rik.system, /doe jij voor hem met teambot_find en teambot_do/);
  } finally {
    await e.t.close();
  }
});

test('through the runner: looking and changing run without a question and change something real; deleting asks first', async () => {
  const e = await setup();
  try {
    const routine = await e.t.api('POST', '/routines', { name: 'Dagoverzicht', agent_id: e.other.id, prompt: 'Vat de dag samen.', timezone: 'Europe/Amsterdam', schedule: { kind: 'none' }, options: { notify: 'never' } });
    const sessions = e.ctx.store.all('SELECT id FROM sessions').length;
    e.t.script.push(
      {
        toolCalls: [
          { name: MANAGE_DO, args: { method: 'GET', path: '/agents' } },
          { name: MANAGE_DO, args: { method: 'POST', path: '/api/rooms/tasks', body: { title: 'Offerte nabellen' } } },
          { name: MANAGE_DO, args: { method: 'POST', path: `/routines/${routine.id}/pause` } },
          { name: MANAGE_DO, args: { method: 'PATCH', path: `/agents/${e.other.id}`, body: { name: 'Rikkert' } } },
        ],
      },
      { text: 'Gedaan.' },
    );
    await e.t.say(e.thread.id, 'Zet een taak klaar, pauzeer het dagoverzicht en noem Rik voortaan Rikkert.');
    assert.equal(e.ctx.store.all('SELECT id FROM approvals').length, 0, 'no question for looking or for an ordinary change');
    const outs = e.ctx.store.messages(e.thread.id).filter((m) => m.role === 'tool').map((m) => m.content);
    assert.equal(outs.length, 4);
    assert.match(outs[0], /^Bot bekijken — gelukt\.\n\[/);
    assert.match(outs[0], /"name": "Rik"/);
    assert.match(outs[1], /^Taak ‘Offerte nabellen’ maken — gelukt\./);
    assert.match(outs[2], /^Routine ‘Dagoverzicht’ pauzeren — gelukt\./);
    assert.match(outs[3], /^Bot ‘Rik’ aanpassen: naam “Rikkert” — gelukt\./);
    const task = (await e.t.api('GET', '/rooms/tasks')).find((x: any) => x.title === 'Offerte nabellen');
    assert.ok(task, 'the task is on the board');
    assert.equal((await e.t.api('GET', `/routines/${routine.id}`)).status, 'paused');
    assert.equal(e.ctx.store.agent(e.other.id)!.name, 'Rikkert');
    // In-process and as the owner: no session was made for it and no phone appeared.
    assert.equal(e.ctx.store.all('SELECT id FROM sessions').length, sessions);
    assert.equal(e.ctx.store.all('SELECT session_id FROM mobile_devices').length, 0);

    // Deleting: the owner gets a card first, in plain words; Ja deletes.
    e.t.script.push({ toolCalls: [{ name: MANAGE_DO, args: { method: 'DELETE', path: `/rooms/tasks/${task.id}` } }] }, { text: 'Weg.' });
    await e.t.api('POST', `/threads/${e.thread.id}/messages`, { content: 'Gooi die taak weer weg.' });
    const c = await e.card();
    assert.deepEqual([c.kind, c.tool, c.risk, c.summary], ['tool', MANAGE_DO, 'danger', 'Taak ‘Offerte nabellen’ verwijderen']);
    assert.ok((await e.t.api('GET', '/rooms/tasks')).some((x: any) => x.id === task.id), 'still there while the card is open');
    await e.t.api('POST', `/approvals/${c.id}`, { decision: 'approve' });
    await e.t.waitIdle(e.thread.id);
    assert.equal((await e.t.api('GET', '/rooms/tasks')).some((x: any) => x.id === task.id), false);
  } finally {
    await e.t.close();
  }
});

test('keys, sessions, back-up restore, the main-bot designation and approval cards never go through the tool', async () => {
  const e = await setup();
  try {
    await e.t.api('PUT', '/secrets/SHOP_KEY', { value: 'sk-test-1234567890abcdefghij' }).catch(() => undefined);
    const never: [any, RegExp][] = [
      [{ method: 'GET', path: '/secrets' }, /sleutels en tokens gaan nooit via een bot/],
      [{ method: 'PUT', path: '/secrets/SHOP_KEY', body: { value: 'x' } }, /sleutels en tokens/],
      [{ method: 'GET', path: '/computers/vault' }, /kluis met wachtwoorden/],
      [{ method: 'GET', path: '/sessions' }, /inlogsessies, gekoppelde apparaten/],
      [{ method: 'POST', path: '/pairing' }, /koppelen/],
      [{ method: 'GET', path: '/mobile/devices' }, /gekoppelde apparaten/],
      [{ method: 'PATCH', path: '/me', body: { name: 'Iemand anders' } }, /eigen account/],
      [{ method: 'GET', path: '/export' }, /alles exporteren/],
      [{ method: 'GET', path: '/memory/export' }, /alles exporteren/],
      [{ method: 'POST', path: '/backups/teambot-2026-11-10.zip/restore' }, /back-up terugzetten doet de eigenaar zelf/],
      [{ method: 'DELETE', path: '/backups/teambot-2026-11-10.zip' }, /back-up weggooien/],
      [{ method: 'PUT', path: '/backups/offsite', body: { path: 'D:/kopie' } }, /tweede plek voor back-ups/],
      [{ method: 'POST', path: '/app-update/install' }, /TeamBot bijwerken doet de eigenaar zelf/],
      [{ method: 'GET', path: '/admin/users' }, /beheer van gebruikers/],
      [{ method: 'PUT', path: `/teams/main/${e.other.id}` }, /wie de hoofdbot is bepaalt alleen de eigenaar/],
      [{ method: 'DELETE', path: '/teams/main' }, /wie de hoofdbot is/],
      [{ method: 'POST', path: '/approvals/apr_1', body: { decision: 'approve' } }, /beantwoordt alleen de eigenaar/],
      [{ method: 'POST', path: '/bot-rules/loosen', body: { text: 'Mag altijd betalen' } }, /bot_rules/],
      [{ method: 'POST', path: '/providers', body: { kind: 'openai', apiKey: 'sk-test-1234567890abcdefghij' } }, /sleutel, token of wachtwoord gaat nooit via een bot/],
      [{ method: 'PUT', path: '/settings', body: { closedFolders: [] } }, /mappen dicht zijn voor bots/],
      [{ method: 'PUT', path: '/remote-desktop/switch', body: { enabled: true } }, /bureaublad op afstand/],
      [{ method: 'GET', path: '/API/Secrets/' }, /sleutels en tokens/],
    ];
    for (const [args, why] of never) {
      const g = e.gate(e.main.id, args);
      assert.match(g.refused || '', why, `${args.method} ${args.path}: refused before any card`);
      assert.match(g.refused || '', /^Geweigerd door TeamBot: .*Zeg de eigenaar eerlijk dat hij dit zelf doet in TeamBot\.$/);
      const out = await e.run(e.main.id, MANAGE_DO, args, true);
      assert.equal(out.isError, true, `${args.method} ${args.path}: refused when run, also after a yes`);
      assert.doesNotMatch(out.text, /sk-test/);
    }
    assert.equal((await e.pending()).length, 0);
    assert.equal((await e.t.api('GET', '/teams/main')).main.id, e.main.id);
    // Looking at who the main bot is, and at the back-ups, is fine.
    assert.equal(e.gate(e.main.id, { method: 'GET', path: '/teams/main' }).refused, null);
    assert.equal(e.gate(e.main.id, { method: 'GET', path: '/backups' }).refused, null);
    // A path that is not a route of TeamBot, or one that tries to slip past the list.
    for (const path of ['/bestaat-niet', '/agents/../secrets', '/agents//x', '/agents/%2e%2e/secrets']) {
      const out = await e.run(e.main.id, MANAGE_DO, { method: 'GET', path });
      assert.equal(out.isError, true, path);
    }
    // The same caller is refused by the routes that refuse a paired phone, and what a route answers is redacted.
    const owner = e.ctx.store.user(e.userId)!;
    const direct = await callAsUser(e.ctx, owner, { method: 'PUT', url: '/app-update/channel', body: { url: 'https://example.com' } });
    assert.equal(direct.status, 403);
    assert.match(direct.body.toString(), /mobile_denied/);
    assert.equal(refusal('GET', '/routines/triggers/tr_1/secret'), refusal('GET', '/routines/triggers/tr_1/secret'));
    assert.match(refusal('GET', '/routines/triggers/tr_1/secret') || '', /sleutels, wachtwoorden en inloggen/);
  } finally {
    await e.t.close();
  }
});

test('money asks at every access level, also Volledige toegang; more access for a bot asks the owner himself', async () => {
  const e = await setup();
  try {
    const team = (await e.t.api('GET', '/teams'))[0];
    e.ctx.store.updateAgent(e.main.id, { access_mode: 'full', settings: { ...e.ctx.store.agent(e.main.id)!.settings, fullAccessExternal: true } });
    const money: any[] = [
      { method: 'PUT', path: '/settings', body: { dailyBudgetUsd: 50 } },
      { method: 'PATCH', path: `/teams/${team.id}`, body: { dailyBudgetUsd: 25 } },
      { method: 'PUT', path: '/usage/alerts', body: { enabled: false } },
      { method: 'PUT', path: '/engine-chain/settings', body: { enabled: true } },
    ];
    for (const args of money) {
      const g = e.gate(e.main.id, args);
      assert.deepEqual([g.refused, g.risk, g.decision], [null, 'danger', 'ask'], `${args.method} ${args.path}: asks at Volledige toegang`);
      assert.match(g.summary, /\(gaat over geld\)$/);
      assert.equal(e.tool(MANAGE_DO).impact instanceof Function && (e.tool(MANAGE_DO).impact as any)(args, e.ctx.store.agent(e.main.id)!), 'payment');
    }
    assert.equal(e.gate(e.main.id, money[0]).summary, 'Instellingen aanpassen: Dagbudget 50 (gaat over geld)');
    // At this level everything else of TeamBot runs without a question, deleting included (the owner allowed that).
    assert.equal(e.gate(e.main.id, { method: 'GET', path: '/usage' }).decision, 'allow');
    assert.equal(e.gate(e.main.id, { method: 'PUT', path: '/settings', body: { theme: 'dark' } }).decision, 'allow');
    assert.equal(e.gate(e.main.id, { method: 'DELETE', path: '/routines/rt_1' }).decision, 'allow');
    // Without "versturen naar anderen": deleting and sending ask.
    e.ctx.store.updateAgent(e.main.id, { settings: { ...e.ctx.store.agent(e.main.id)!.settings, fullAccessExternal: false } });
    assert.deepEqual([e.gate(e.main.id, { method: 'DELETE', path: '/routines/rt_1' }).risk, e.gate(e.main.id, { method: 'DELETE', path: '/routines/rt_1' }).decision], ['danger', 'ask']);
    assert.equal(e.gate(e.main.id, { method: 'POST', path: '/channels/conversations/cv_1/send', body: { text: 'Hoi' } }).decision, 'ask');
    assert.equal(e.gate(e.main.id, { method: 'POST', path: '/rooms/tasks', body: { title: 'X' } }).decision, 'allow');
    // Looking never asks, at any level; a read-only main bot changes nothing.
    e.ctx.store.updateAgent(e.main.id, { access_mode: 'ask' });
    assert.equal(e.gate(e.main.id, { method: 'GET', path: '/routines' }).decision, 'allow');
    assert.equal(e.gate(e.main.id, { method: 'POST', path: '/rooms/tasks', body: { title: 'X' } }).decision, 'ask');
    e.ctx.store.updateAgent(e.main.id, { access_mode: 'readonly' });
    assert.equal(e.gate(e.main.id, { method: 'GET', path: '/routines' }).decision, 'allow');
    assert.equal(e.gate(e.main.id, { method: 'POST', path: '/rooms/tasks', body: { title: 'X' } }).decision, 'deny');

    // More access for a bot: danger for the gate, and the tool asks the owner itself when the gate did not.
    e.ctx.store.updateAgent(e.main.id, { access_mode: 'full', settings: { ...e.ctx.store.agent(e.main.id)!.settings, fullAccessExternal: true } });
    const wider = { method: 'PATCH', path: `/agents/${e.other.id}`, body: { access_mode: 'full' } };
    const g = e.gate(e.main.id, wider);
    assert.equal(g.risk, 'danger');
    assert.equal(g.summary, 'Bot ‘Rik’ aanpassen: toegang “full” — geeft meer toegang: Volledige toegang (doet zijn werk zonder te vragen)');
    // Several kinds of more access read as one list ("A, B en C", shared formatList), never "A en B en C".
    const three = e.gate(e.main.id, { method: 'PATCH', path: `/agents/${e.other.id}`, body: { access_mode: 'full', settings: { fullAccessExternal: true }, workspace: 'elders' } });
    assert.match(three.summary, / — geeft meer toegang: [^,]+, [^,]+ en [^,]+$/, three.summary);
    assert.doesNotMatch(three.summary, / en .* en /, three.summary);
    const asking = e.run(e.main.id, MANAGE_DO, wider);
    const c = await e.card();
    assert.deepEqual([c.kind, c.options], ['question', ['Ja', 'Nee']]);
    assert.match(c.summary, /^Baas wil meer toegang geven: Volledige toegang .* Goed\?$/);
    await e.t.api('POST', `/approvals/${c.id}`, { decision: 'approve', answer: 'Nee' });
    const out = await asking;
    assert.equal(out.isError, true);
    assert.match(out.text, /De eigenaar wil dit niet\. Er is niets veranderd\./);
    assert.equal(e.ctx.store.agent(e.other.id)!.access_mode, 'auto');
    // Less access is an ordinary change.
    assert.equal(e.gate(e.main.id, { method: 'PATCH', path: `/agents/${e.other.id}`, body: { access_mode: 'ask' } }).risk, 'write');
    const ok = await e.run(e.main.id, MANAGE_DO, { method: 'PATCH', path: `/agents/${e.other.id}`, body: { access_mode: 'ask' } });
    assert.ok(!ok.isError, ok.text);
    assert.equal(e.ctx.store.agent(e.other.id)!.access_mode, 'ask');
  } finally {
    await e.t.close();
  }
});

test('the route list comes from the registered routes and finds a call by a word; the check-in is set through it', async () => {
  const e = await setup();
  try {
    const routes = routesOf(e.ctx);
    assert.ok(routes.length > 300, `${routes.length} routes`);
    assert.ok(routes.some((r) => r.method === 'POST' && r.path === '/routines/:id/pause' && r.text === 'Routine pauzeren'));
    const all = await e.run(e.main.id, MANAGE_FIND);
    assert.match(all.text, /TeamBot kent \d+ acties in \d+ onderdelen/);
    assert.match(all.text, /- routines — Routine \(\d+\)/);
    assert.doesNotMatch(all.text, /- secrets|- sessions|- admin|- mobile/);
    const found = await e.run(e.main.id, MANAGE_FIND, { word: 'routines pauzeren' });
    assert.match(found.text, /- POST \/routines\/:id\/pause — Routine pauzeren/);
    assert.doesNotMatch(found.text, /\/agents/);
    assert.ok(found.data.routes.every((r: any) => /routine/i.test(r.path + r.text)));
    assert.match((await e.run(e.main.id, MANAGE_FIND, { word: 'taak' })).text, /- POST \/rooms\/tasks — Taak maken/);
    assert.match((await e.run(e.main.id, MANAGE_FIND, { word: 'check-in' })).text, /- PUT \/proactive\/checkin — Dagelijkse check-in van de hoofdbot aanpassen/);
    // "Wat staat er gepland?": the one list of what starts by itself, and the same question answered.
    assert.match((await e.run(e.main.id, MANAGE_FIND, { word: 'gepland' })).text, /- GET \/routines\/planned — Alles wat gepland staat en vanzelf start \(routines, herinneringen, vaste taken\) bekijken/);
    assert.match((await e.run(e.main.id, MANAGE_DO, { method: 'GET', path: '/routines/planned' })).text, /^Alles wat gepland staat en vanzelf start \(routines, herinneringen, vaste taken\) bekijken — gelukt\.\n\{\n "planned": \[/);
    assert.doesNotMatch((await e.run(e.main.id, MANAGE_FIND, { word: 'secret' })).text, /\/secrets/);
    assert.match((await e.run(e.main.id, MANAGE_FIND, { word: 'xyzzy' })).text, /Niets gevonden/);

    // The main bot's own check-in: on or off and the hour, like the owner's switch.
    assert.deepEqual(checkinSettings(e.ctx, e.userId), { enabled: false, time: '09:00' }, 'off until the owner turns it on (tests/planner.test.ts)');
    const args = { method: 'PUT', path: '/proactive/checkin', body: { enabled: false, time: '08:30' } };
    const g = e.gate(e.main.id, args);
    assert.deepEqual([g.risk, g.decision, g.summary], ['write', 'allow', 'Dagelijkse check-in van de hoofdbot aanpassen: uit, tijd “08:30”']);
    const out = await e.run(e.main.id, MANAGE_DO, args);
    assert.ok(!out.isError, out.text);
    assert.deepEqual(checkinSettings(e.ctx, e.userId), { enabled: false, time: '08:30' });
    assert.match((await e.run(e.main.id, MANAGE_DO, { method: 'GET', path: '/proactive/checkin' })).text, /"time": "08:30"/);

    // A query goes along; an unknown id says so; other lines for the log.
    const q = planCall(e.ctx, e.userId, { method: 'GET', path: '/rooms/tasks?status=todo', query: { limit: 5 } });
    assert.ok('url' in q && q.url === '/rooms/tasks?status=todo&limit=5');
    const gone = await e.run(e.main.id, MANAGE_DO, { method: 'POST', path: '/routines/rt_bestaatniet/pause' });
    assert.equal(gone.isError, true);
    assert.match(gone.text, /^Niet gelukt \(Routine pauzeren\): /);
    const line = (a: any) => e.gate(e.main.id, a).summary;
    assert.equal(line({ method: 'POST', path: '/routines', body: { name: 'Weekrapport', agent_id: e.other.id } }), 'Routine ‘Weekrapport’ maken: agent_id “' + e.other.id + '”');
    assert.equal(line({ method: 'DELETE', path: `/agents/${e.other.id}` }), 'Bot ‘Rik’ verwijderen');
    assert.equal(line({ method: 'PUT', path: '/notifications/prefs', body: { sound: false } }), 'Voorkeuren voor meldingen aanpassen: Geluid bij een melding “Uit”', 'a setting of the screens with its own words (shared/settings.ts)');
    assert.equal(line({ method: 'POST', path: '/stop-all' }), 'Alle bots stoppen');
  } finally {
    await e.t.close();
  }
});
