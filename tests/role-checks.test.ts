// The ready-made checks of a bot's role (duties/catalog.ts): a bot switches one on by its title and gets the real
// check, and what TeamBot measures of the team's websites stands on the owner's dashboard.
// Seen 21 nov 2026: 4.15.1 told a bot to "switch the check on with the same title", and duty_set then made a copy that
// only carried the name (key `eigen`, source `team`): never measured by TeamBot itself, and reported as off for ever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setup, teamWithSite, page, type Env } from './proactive-helpers.js';

process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

const TECH = 'Websites: technische fouten en indexeerbaarheid';

const tool = async (env: Env, agent: any, name: string, args: any) => {
  const th = await env.t.api('POST', '/threads', { agentId: agent.id });
  env.t.script.push({ toolCalls: [{ name, args }] }, { text: 'ok' });
  const msgs = await env.t.say(th.id, name);
  return String(msgs.filter((m: any) => m.role === 'tool').at(-1)?.content || '');
};
const own = { role: 'system', parts: { work: { refs: ['own:1'] } } } as any;

test('a bot switches a ready-made check of its role on by its title alone: the real check, and a copy with that name is replaced', async () => {
  const env = await setup();
  try {
    const sem = await env.t.agent({ name: 'Sem', role: 'Technische SEO', tool_groups: ['team'] });
    const mine = () => env.duties.duties(env.userId, sem.id);

    // No websites at the team: no check of the role can measure yet, so the bot is not told to switch anything on.
    let said = (await env.work.stand(sem.id, own))!;
    assert.doesNotMatch(said, /nog uit staan/);
    // And switching one on is refused with what is missing, leaving nothing behind.
    assert.match(await tool(env, sem, 'duty_set', { title: TECH }), /kan nog niets meten: Vul bij het team het adres van je website in/);
    assert.equal(mine().length, 0);

    // With a website the site check can measure; the two that read Search Console still wait for the app.
    await teamWithSite(env);
    said = (await env.work.stand(sem.id, own))!;
    assert.match(said, new RegExp(`controles die bij je rol horen en nog uit staan: ${TECH} \\(aanzetten: duty_set met alleen die titel\\)`));
    assert.doesNotMatch(said, /Posities en klikken in Google|Indexering in Google/, 'what cannot measure yet is not something to switch on');

    // The copy 4.15.1 led to: the same name, but not the check. It counts as there (by its name), so the bot is not sent
    // round in a circle.
    env.duties.create(env.userId, sem.id, { key: 'eigen', title: TECH, check: 'Zijn de sites in orde?', source: 'team', okWhen: '', onProblem: 'fix' } as any);
    assert.doesNotMatch((await env.work.stand(sem.id, own))!, /nog uit staan/);

    // By its title alone: the ready-made check itself, measured by TeamBot, in place of the copy.
    const out = await tool(env, sem, 'duty_set', { title: TECH.toLowerCase() });
    assert.match(out, new RegExp(`Vaste taak “${TECH}” staat aan`));
    assert.deepEqual(mine().map((r) => r.options.duty!.key), ['seo.techniek'], 'one duty: the built-in one');
    const duty = env.duty(sem.id, 'seo.techniek');
    assert.equal(duty.name, TECH);
    assert.equal(duty.options.duty.source, 'site');
    assert.match(duty.options.duty.check, /bereikbaar en indexeerbaar/);
    assert.deepEqual(duty.schedule.times, ['06:30']);
    assert.doesNotMatch((await env.work.stand(sem.id, own))!, /nog uit staan/);

    // The bot's own times and action go with it; the check stays the ready-made one.
    await tool(env, sem, 'duty_set', { title: TECH, check: 'iets anders', times: ['09:15'], on_problem: 'task' });
    const again = env.duty(sem.id, 'seo.techniek');
    assert.deepEqual(again.schedule.times, ['09:15']);
    assert.equal(again.options.duty.onProblem, 'task');
    assert.match(again.options.duty.check, /bereikbaar en indexeerbaar/);
    assert.equal(mine().length, 1);

    // One the owner paused is not missing either.
    env.engine.setStatus(again, 'paused', 'even niet', 'user');
    assert.doesNotMatch((await env.work.stand(sem.id, own))!, /nog uit staan/);

    // A name of the bot's own is still a duty of its own.
    await tool(env, sem, 'duty_set', { title: 'Kapotte links nalopen', check: 'Zijn er kapotte links?', ok_when: 'geen', on_problem: 'fix' });
    assert.equal(mine().find((r) => r.name === 'Kapotte links nalopen')!.options.duty!.key, 'eigen');
    assert.match(await tool(env, sem, 'duty_set', { title: 'Zonder check' }), /Geef een title en check/);
  } finally {
    await env.t.close();
  }
});

test('the main bot sees per bot which checks are off and which cannot measure yet', async () => {
  const env = await setup();
  try {
    const ctx = env.t.app.ctx;
    await env.t.agent({ name: 'Sem', role: 'Technische SEO', tool_groups: ['team'] });
    const baas = await env.t.agent({ name: 'Baas', role: 'Leiding' });
    await ctx.services.teamdata.ensure(env.userId);
    ctx.services.teams.setMain?.(env.userId, baas.id);

    // Without websites: said once, as what the team lacks; the site check is not listed again as waiting for it.
    let lead = (await env.work.stand(baas.id, own))!;
    assert.match(lead, /bij het team staan geen websites ingevuld/);
    assert.doesNotMatch(lead, /uit staan/);
    assert.match(lead, /controles die nog niets kunnen meten: Sem, Posities en klikken in Google en Indexering in Google: Koppel Search Console .* en zet de app aan bij Sem\.\n/);
    assert.doesNotMatch(lead, new RegExp(TECH));

    await teamWithSite(env);
    lead = (await env.work.stand(baas.id, own))!;
    assert.match(lead, /websites bij het team: 1, en geen vaste taak die ze meet/);
    assert.match(lead, new RegExp(`controles die bij de rollen van je team horen en uit staan \\(de bot zet ze zelf aan: duty_set met alleen die titel\\): Sem: ${TECH}\\n`));
    assert.match(lead, /controles die nog niets kunnen meten: Sem, Posities en klikken in Google en Indexering in Google: Koppel/);
  } finally {
    await env.t.close();
  }
});

test('what TeamBot measures of the websites stands on the dashboard: how many are in order, and which are not', async () => {
  const env = await setup();
  try {
    const sem = await env.t.agent({ name: 'Sem', role: 'Technische SEO', tool_groups: ['team'] });
    const bo = await env.t.agent({ name: 'Bo', role: 'Websitebouwer', tool_groups: ['team'] });
    await teamWithSite(env, undefined, ['https://raamwinkel.test', 'https://accufix.test']);
    env.site.pages['https://raamwinkel.test'] = { body: page({ noindex: true }) };
    await env.t.api('POST', '/proactive/duties', { agentId: sem.id, key: 'seo.techniek' });
    await env.t.api('POST', '/proactive/duties', { agentId: bo.id, key: 'site.bereikbaar' });
    const tile = async (key: string) => (await env.t.app.ctx.services.teamdata.rows(env.userId, 'SELECT * FROM dashboard WHERE sleutel = ?', [key], true))[0];

    // 06:30 (local 07:30 is 06:30 UTC in winter): the full check. One site hides itself, the other does not answer.
    env.t.script.push({ text: 'Ik pak het op.' }, { text: 'Ik pak het op.' }, { text: 'Ik pak het op.' }, { text: 'Ik pak het op.' });
    await env.at('2026-11-09T05:31:00Z');
    let full = await tile('websites-in-orde');
    assert.equal(full.titel, 'Websites in orde');
    assert.equal(full.groep, 'Websites');
    assert.equal(full.waarde, '0');
    assert.equal(full.eenheid, 'van 2');
    assert.match(full.toelichting, /^Niet in orde: (raamwinkel\.test, accufix\.test|accufix\.test, raamwinkel\.test)$/);
    assert.equal(full.bot, null, 'TeamBot’s own measurement: not a bot’s own number');
    assert.equal(full.maximum, null, 'a number, not a meter of use');

    // Both in order again: the next measurement says so.
    env.site.pages['https://raamwinkel.test'] = { body: page() };
    for (const [k, v] of Object.entries(env.site.pages)) if (k.startsWith('https://raamwinkel.test')) env.site.pages[k.replace('raamwinkel.test', 'accufix.test')] = { ...v, body: String(v.body || '').replace(/raamwinkel\.test/g, 'accufix.test') };
    await env.at('2026-11-10T05:31:00Z');
    full = await tile('websites-in-orde');
    assert.equal(full.waarde, '2');
    assert.equal(full.toelichting, 'Elke website is bereikbaar en indexeerbaar');
    const up = await tile('websites-bereikbaar');
    assert.equal(up.titel, 'Websites bereikbaar');
    assert.equal(up.waarde, '2');
    assert.equal(up.eenheid, 'van 2');
  } finally {
    await env.t.close();
  }
});
