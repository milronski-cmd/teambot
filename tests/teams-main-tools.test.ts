/**
 * The main bot (hoofdbot) sets up teams and bots itself: four tools, only for the owner's main bot.
 *  - team_templates, team_from_template, team_profile and team_add_bot each refuse any other bot, and say why;
 *  - only the main bot gets them in its tool list;
 *  - a team from a template through the tool is the same install as in the app: bots, exactly one team lead, routines
 *    paused, no second main bot;
 *  - the profile is filled through the tool: by the template's question keys (added to what is there, a waiting routine
 *    text gets the answer) and by the plain fields; reading shows what is still open;
 *  - one extra bot lands in the right team on the lead's AI.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';
import rooms from '../server/modules/rooms/index.js';
import skills from '../server/modules/skills/index.js';
import routines from '../server/modules/routines/index.js';
import teams from '../server/modules/teams/index.js';
import templates from '../server/modules/templates/index.js';
import memory from '../server/modules/memory/index.js';
import { MAIN_TOOL_NAMES } from '../server/modules/teams/maintools.js';
import { templateDef } from '../server/modules/templates/registry.js';
import type { ToolDef, ToolOutput } from '../server/core/types.js';
import { fillWords } from '../shared/i18n-core.js';

async function setup() {
  const t: TestApp = await startTestApp({ modules: [memory, skills, routines, teams, rooms, templates] });
  const ctx = t.app.ctx;
  const userId = ctx.auth.owner()!.id;
  const main = await t.agent({ name: 'Baas' });
  await t.api('PUT', `/teams/main/${main.id}`);
  const other = await t.agent({ name: 'Rik', role: 'Schrijver' });
  const tools: ToolDef[] = ctx.services.teams.mainTools;
  const tool = (name: string) => tools.find((x) => x.name === name)!;
  /** Run a tool as a bot, the way the runner calls it. */
  const run = async (agentId: string, name: string, args: any = {}): Promise<ToolOutput> => {
    const agent = ctx.store.agent(agentId)!;
    const out = await tool(name).run(args, { ctx, agent, thread: ctx.chat.threadForAgent(userId, agentId), userId, run: {} as any, signal: new AbortController().signal, toolCallId: 'c1', progress() {} });
    return typeof out === 'string' ? { text: out } : out;
  };
  return { t, ctx, userId, main, other, tools, tool, run };
}

test('each tool is only for the main bot: any other bot is refused with the reason, and does not get the tools', async () => {
  const e = await setup();
  try {
    assert.deepEqual(e.tools.map((x) => x.name), [...MAIN_TOOL_NAMES]);
    const rik = e.ctx.store.agent(e.other.id)!;
    const baas = e.ctx.store.agent(e.main.id)!;
    const thread = e.ctx.chat.threadForAgent(e.userId, rik.id);
    const args: Record<string, any> = {
      team_templates: {},
      team_from_template: { template: 'webshop' },
      team_profile: { company: 'Stiekem BV' },
      team_add_bot: { name: 'Sluiper', role: 'Niets', instructions: 'Doe niets.' },
      bot_settings: { bot: 'Baas', access: 'readonly' },
      bot_rules: { action: 'add', bot: 'Baas', text: 'Verwijder nooit bestanden' },
    };
    for (const name of MAIN_TOOL_NAMES) {
      const def = e.tool(name);
      assert.match(def.refuse!(args[name], { agent: rik, thread, userId: e.userId }) || '', /Geweigerd door TeamBot: alleen de hoofdbot van de eigenaar .* Rik is niet de hoofdbot/, `${name}: refused before any approval`);
      assert.equal(def.refuse!(args[name], { agent: baas, thread, userId: e.userId }), null, `${name}: the main bot may`);
      const out = await e.run(rik.id, name, args[name]);
      assert.equal(out.isError, true, `${name}: refused when run`);
      assert.match(out.text, /alleen de hoofdbot/);
      assert.ok(fillWords(def.summarize!(args[name])).length > 5, `${name}: a line for the log`);
      assert.ok(name === 'team_templates' ? def.risk === 'read' : def.risk === 'write', `${name}: nothing here sends, pays or deletes`);
    }
    assert.equal(e.tool('team_profile').riskFor!({ team: 'X' }, { agent: baas, thread, userId: e.userId }), 'read', 'only looking is reading');
    assert.equal(e.tool('team_profile').riskFor!({ answers: { naam: 'X' } }, { agent: baas, thread, userId: e.userId }), 'write');
    // Nothing was made by the refused calls.
    assert.equal((await e.t.api('GET', '/teams')).some((x: any) => x.profile.company === 'Stiekem BV' || x.name === 'Webshop'), false);
    assert.equal((await e.t.api('GET', '/agents')).some((x: any) => x.name === 'Sluiper'), false);

    const names = async (id: string) => (await e.ctx.tools.forAgent(e.ctx.store.agent(id)!, e.ctx.chat.threadForAgent(e.userId, id))).map((x) => x.name);
    for (const n of MAIN_TOOL_NAMES) assert.ok((await names(baas.id)).includes(n), `the main bot has ${n}`);
    for (const n of MAIN_TOOL_NAMES) assert.ok(!(await names(rik.id)).includes(n), `Rik does not have ${n}`);
    // The main bot's job names them, in plain Dutch.
    e.t.script.push({ text: 'Hallo.' });
    await e.t.say(e.ctx.chat.threadForAgent(e.userId, baas.id).id, 'Hoi');
    const sys = JSON.stringify(e.t.requests.at(-1));
    assert.match(sys, /vaste voordeur van de eigenaar/);
    assert.match(sys, /doe dan zelf een voorstel/);
    assert.match(sys, /één vraag per bericht/);
    assert.match(sys, /team_from_template/);
    assert.match(sys, /team_add_bot/);
  } finally {
    await e.t.close();
  }
});

test('the main bot lists the templates and makes a team from one: bots, one team lead, no second main bot', async () => {
  const e = await setup();
  try {
    const list = await e.run(e.main.id, 'team_templates');
    assert.match(list.text, /- webshop — Webshop: /);
    assert.match(list.text, /Winkelchef \([^)]*teamleider\)/);
    assert.equal(list.data.templates.length, 16);
    assert.ok(list.data.templates.every((x: any) => x.bots.filter((b: any) => b.lead).length === 1));

    const d = templateDef('webshop')!;
    const name = d.questions.find((q) => q.profile === 'name')!;
    const out = await e.run(e.main.id, 'team_from_template', { template: 'webshop', name: 'Bakkerij', answers: { [name.key]: 'De Korenaar' } });
    assert.ok(!out.isError, out.text);
    assert.match(out.text, /Team “Bakkerij” is gemaakt\. Teamleider: Winkelchef\./);
    assert.deepEqual(out.data.bots.map((b: any) => b.name).sort(), d.bots.map((b) => b.name).sort());
    assert.equal(out.data.lead.name, 'Winkelchef');
    // What is still to ask comes back with it; what was given is filled in.
    assert.doesNotMatch(out.text, new RegExp(`- ${name.key} — `));
    for (const q of d.questions.filter((x) => x.key !== name.key)) assert.ok(out.text.includes(`- ${q.key} — ${q.label}`));
    const team = (await e.t.api('GET', '/teams')).find((x: any) => x.id === out.data.team.id);
    assert.deepEqual([team.name, team.leadName, team.profile.company], ['Bakkerij', 'Winkelchef', 'De Korenaar']);
    assert.equal(team.bots.length, d.bots.length);
    assert.equal((await e.t.api('GET', '/teams/main')).main.id, e.main.id, 'the owner keeps his main bot');
    assert.ok(!(await e.t.api('GET', '/agents')).some((x: any) => x.name === 'Hoofdbot'));
    assert.ok(e.ctx.store.all<any>('SELECT status FROM routines').every((r) => r.status === 'paused'));
    assert.equal(e.ctx.store.all('SELECT id FROM runs').length, 0, 'making a team starts no run');

    const bad = await e.run(e.main.id, 'team_from_template', { template: 'bestaat-niet' });
    assert.equal(bad.isError, true);
    assert.match(bad.text, /Er is geen teamsjabloon “bestaat-niet”\. Sjablonen: webshop, /);
  } finally {
    await e.t.close();
  }
});

test('the profile is filled through the tool: by question key, one answer at a time, and by the plain fields', async () => {
  const e = await setup();
  try {
    const d = templateDef('webshop')!;
    const made = await e.run(e.main.id, 'team_from_template', { template: 'webshop' });
    const teamId = made.data.team.id;
    const profile = async () => (await e.t.api('GET', '/teams')).find((x: any) => x.id === teamId).profile;
    assert.deepEqual(await profile(), { company: '', about: '', tone: '', rules: '' });

    // Reading: empty, every question open.
    const read = await e.run(e.main.id, 'team_profile', { team: 'Webshop' });
    assert.match(read.text, /Bedrijf \(company\): nog leeg/);
    for (const q of d.questions) assert.ok(read.text.includes(`- ${q.key} — ${q.label}`));

    // One answer at a time; earlier answers stay.
    const key = (f: string) => d.questions.find((q) => q.profile === f)!.key;
    let out = await e.run(e.main.id, 'team_profile', { team: 'webshop', answers: { [key('name')]: 'De Korenaar' } });
    assert.match(out.text, new RegExp(`Opgeschreven: ${key('name')}\\.`));
    out = await e.run(e.main.id, 'team_profile', { team: teamId, answers: { [key('business')]: 'Brood en gebak, door heel Nederland', website: 'https://www.voorbeeld.nl', bestaatniet: 'x' } });
    assert.match(out.text, /Onbekende sleutel overgeslagen: bestaatniet/);
    let p = await profile();
    assert.equal(p.company, 'De Korenaar');
    assert.match(p.about, /^Brood en gebak, door heel Nederland\nWebwinkel: https:\/\/www\.voorbeeld\.nl$/);
    assert.doesNotMatch(out.text, new RegExp(`- ${key('name')} — `), 'answered questions are no longer open');
    // A routine that waited for the web address now has it.
    const prompts = e.ctx.store.all<any>('SELECT prompt FROM routines').map((r) => r.prompt).join('\n');
    assert.match(prompts, /Controleer de webshop op dit adres: https:\/\/www\.voorbeeld\.nl\./);
    assert.ok(e.ctx.store.all<any>('SELECT status FROM routines').every((r) => r.status === 'paused'), 'and it is still paused');
    // The answers are kept with the team's group chat too (as an install with answers does).
    const room = await e.t.api('GET', `/team-templates/profile/${made.data.roomId}`);
    assert.equal(room.profile.name, 'De Korenaar');

    // A secret never lands in the profile.
    out = await e.run(e.main.id, 'team_profile', { team: 'Webshop', answers: { [key('business')]: 'Brood. Sleutel: sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefghij' } });
    assert.match(out.text, /wachtwoord of sleutel/);
    assert.doesNotMatch((await profile()).about, /sk-ant/);

    // The plain fields replace a field; a team that is not from a template has no question keys.
    out = await e.run(e.main.id, 'team_profile', { team: 'Webshop', tone: 'Warm en kort', rules: 'Nooit korting beloven' });
    assert.match(out.text, /Bijgewerkt: tone, rules\./);
    p = await profile();
    assert.deepEqual([p.company, p.tone, p.rules], ['De Korenaar', 'Warm en kort', 'Nooit korting beloven']);
    const own = await e.t.api('POST', '/teams', { name: 'Eigen' });
    out = await e.run(e.main.id, 'team_profile', { team: 'Eigen', answers: { naam: 'X' } });
    assert.equal(out.isError, true);
    assert.match(out.text, /komt niet uit een sjabloon/);
    out = await e.run(e.main.id, 'team_profile', { team: 'Eigen', company: 'Eigen BV' });
    assert.equal((await e.t.api('GET', `/teams/${own.id}`)).profile.company, 'Eigen BV');
    // More than one team: say which one.
    out = await e.run(e.main.id, 'team_profile', {});
    assert.equal(out.isError, true);
    assert.match(out.text, /Zeg welk team je bedoelt/);
  } finally {
    await e.t.close();
  }
});

test('one extra bot in a team: in that team, on the AI of the team lead, and a taken name is refused', async () => {
  const e = await setup();
  try {
    const made = await e.run(e.main.id, 'team_from_template', { template: 'webshop' });
    const out = await e.run(e.main.id, 'team_add_bot', { team: 'Webshop', name: 'Nieuwsbrief', role: 'Nieuwsbrieven schrijven', description: 'Schrijft elke maand de nieuwsbrief.', instructions: 'Je schrijft de nieuwsbrief. Je verstuurt niets zelf.' });
    assert.ok(!out.isError, out.text);
    assert.match(out.text, /Nieuwsbrief \(Nieuwsbrieven schrijven\) is gemaakt in team “Webshop”\. Teamleider Winkelchef kan hem werk geven\./);
    const bot = e.ctx.store.agent(out.data.bot.id)!;
    const lead = e.ctx.store.agent(made.data.lead.id)!;
    assert.deepEqual([bot.provider_id, bot.model, bot.access_mode, bot.settings.fullAccessExternal], [lead.provider_id, lead.model, 'full', true]);
    assert.equal(bot.instructions, 'Je schrijft de nieuwsbrief. Je verstuurt niets zelf.');
    assert.equal(e.ctx.services.teams.teamOf(bot.id), made.data.team.id);
    assert.ok(bot.tool_groups.includes('team'));
    assert.equal(e.ctx.services.teams.isMain(bot.id), false);

    const twin = await e.run(e.main.id, 'team_add_bot', { team: 'Webshop', name: 'nieuwsbrief', role: 'X', instructions: 'Y' });
    assert.equal(twin.isError, true);
    assert.match(twin.text, /Er is al een bot die Nieuwsbrief heet/);
    const empty = await e.run(e.main.id, 'team_add_bot', { team: 'Webshop', name: 'Leeg' });
    assert.match(empty.text, /Geef een naam, een rol en instructies/);
    const where = await e.run(e.main.id, 'team_add_bot', { team: 'Bestaat niet', name: 'Los', role: 'X', instructions: 'Y' });
    assert.match(where.text, /Er is geen team “Bestaat niet”/);
  } finally {
    await e.t.close();
  }
});
