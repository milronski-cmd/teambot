// The look back after real work (server/modules/quality/skill-review.ts): a bot lays a way of working down as a skill,
// or improves the skill it used, without an extra turn. Taken over from Hermes, OpenBot and OpenClaw. Seen with a real
// team (22 nov 2026): in two months no bot wrote or improved a single skill itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { setShortCallFake } from '../server/agent/short-call.js';
import { REVIEW_AFTER_STEPS, resetSkillReview, skillReview } from '../server/modules/quality/skill-review.js';

const LOOK = /^Je kijkt terug op het werk/;
const answers: string[] = [];
const prompts: string[] = [];

/** The look back answers what the test lines up (else "niets"); every other short call gets nothing. */
async function app(): Promise<TestApp> {
  const t = await startTestApp();
  skillReview.enabled = true;
  resetSkillReview();
  answers.length = 0;
  prompts.length = 0;
  setShortCallFake((system, prompt) => {
    if (!LOOK.test(system)) return '';
    prompts.push(prompt);
    return answers.shift() ?? '{"besluit":"niets"}';
  });
  return t;
}

async function done(t: TestApp) {
  setShortCallFake(null);
  skillReview.enabled = false;
  await t.close();
}

async function worker(t: TestApp, extra: any = {}) {
  const a = await t.agent({ name: 'Bo', tool_groups: ['files', 'skills'], access_mode: 'auto', ...extra });
  const th = await t.api('POST', '/threads', { agentId: a.id });
  const ws = t.app.ctx.store.agent(a.id)!.workspace;
  fs.mkdirSync(ws, { recursive: true });
  return { a, th, ws };
}

/** A turn of work: first `before` (e.g. loading a skill), then `n` files written, then the answer. */
async function work(t: TestApp, threadId: string, o: { n?: number; ask?: string; before?: any[]; tool?: 'write_file' | 'read_file' } = {}) {
  const n = o.n ?? REVIEW_AFTER_STEPS;
  const tool = o.tool || 'write_file';
  const calls = Array.from({ length: n }, (_, i) => ({ name: tool, args: tool === 'write_file' ? { path: `rapport/deel-${i + 1}.md`, content: `Deel ${i + 1} van het rapport.` } : { path: `bron/deel-${i + 1}.md` } }));
  t.script.push(...(o.before || []), { toolCalls: calls }, { text: 'Het weekrapport staat in rapport/.' });
  await t.say(threadId, o.ask || 'Maak het weekrapport.');
  await t.waitIdle(threadId);
  await t.app.ctx.services.quality.drain();
}

const skill = (t: TestApp, name: string) => t.app.ctx.store.one<any>('SELECT * FROM skills WHERE name = ?', name);
const skillMd = (t: TestApp, name: string) => t.app.ctx.services.skills.library.readSkillMd(skill(t, name));
const events = (t: TestApp, threadId: string) => t.app.ctx.store.all<any>("SELECT content FROM messages WHERE thread_id = ? AND role = 'event' ORDER BY seq", threadId).map((m) => m.content as string);

test('after a turn of real work the bot lays its way of working down as a skill, active for the team at once and without an extra turn; a short turn gets no look back', async () => {
  const t = await app();
  try {
    const { th } = await worker(t);
    await work(t, th.id, { n: 2, ask: 'Schrijf twee notities.' });
    assert.equal(prompts.length, 0, 'two steps: nothing to look back on');

    answers.push(
      JSON.stringify({
        besluit: 'nieuw',
        naam: 'weekrapport-maken',
        omschrijving: 'Het weekrapport maken, als de eigenaar om het rapport van de week vraagt.',
        werkwijze: '1. Schrijf elk deel als eigen bestand in rapport/.\n2. Noem in het antwoord waar het staat.\n\nKlaar als: alle delen staan er.',
      }),
    );
    const calls = t.requests.length;
    await work(t, th.id);
    assert.equal(prompts.length, 1, 'one look back');
    assert.match(prompts[0], /<taak>\nMaak het weekrapport\./);
    assert.match(prompts[0], /<stappen aantal="8">[\s\S]*deel-8\.md/);
    assert.match(prompts[0], /<antwoord>\nHet weekrapport staat in rapport\//);
    const s = skill(t, 'weekrapport-maken');
    assert.equal(s?.status, 'active', 'active for the team at once');
    assert.match(skillMd(t, 'weekrapport-maken'), /Schrijf elk deel als eigen bestand/);
    assert.equal(t.requests.length - calls, 2, 'the bot got no extra turn: only the two steps of its work');
    assert.ok(events(t, th.id).some((e) => /Bo heeft deze werkwijze vastgelegd als skill “weekrapport-maken”/.test(e)), 'one line in the conversation');
    const audit = t.app.ctx.store.one<any>("SELECT data FROM audit WHERE kind = 'quality.skill_review' ORDER BY id DESC");
    assert.equal(JSON.parse(audit.data).decision, 'new');
  } finally {
    await done(t);
  }
});

test('the skill the bot used is in the look back with its text, and what the work showed becomes a new version; "niets" changes nothing', async () => {
  const t = await app();
  try {
    const { th } = await worker(t);
    t.script.push({ toolCalls: [{ name: 'skill_save', args: { name: 'weekrapport-maken', description: 'Het weekrapport maken.', instructions: '1. Schrijf het rapport in één bestand.' } }] }, { text: 'Vastgelegd.' });
    await t.say(th.id, 'Leg de werkwijze vast.');
    await t.waitIdle(th.id);
    assert.equal(skill(t, 'weekrapport-maken')?.active_rev, 1);

    answers.push(JSON.stringify({ besluit: 'verbeter', naam: 'weekrapport-maken', omschrijving: 'Het weekrapport maken, per deel een bestand.', werkwijze: '1. Schrijf elk deel als eigen bestand.\n2. Controleer of alle delen er staan.', wat: 'Per deel een bestand, en een controle aan het eind.' }));
    await work(t, th.id, { before: [{ toolCalls: [{ name: 'skill_load', args: { name: 'weekrapport-maken' } }] }] });
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /<skill naam="weekrapport-maken">[\s\S]*Schrijf het rapport in één bestand/, 'the text of the skill it used');
    assert.doesNotMatch(prompts[0], /<stappen[^>]*>[\s\S]*Skill laden/, 'loading the skill is no step of the work');
    assert.equal(skill(t, 'weekrapport-maken')?.active_rev, 2, 'a new version, the old one kept');
    assert.match(skillMd(t, 'weekrapport-maken'), /Controleer of alle delen er staan/);
    assert.ok(events(t, th.id).some((e) => /Bo heeft de skill “weekrapport-maken” verbeterd: Per deel een bestand/.test(e)));

    // The next look back (after the quarter of an hour) finds nothing to add: the skill stays as it is.
    resetSkillReview();
    answers.push('{"besluit":"niets"}');
    await work(t, th.id, { before: [{ toolCalls: [{ name: 'skill_load', args: { name: 'weekrapport-maken' } }] }] });
    assert.equal(prompts.length, 2);
    assert.equal(skill(t, 'weekrapport-maken')?.active_rev, 2);
  } finally {
    await done(t);
  }
});

test('a skill that writes to customers, and every skill of a bot that asks before it writes: a draft that waits for the owner', async () => {
  const t = await app();
  try {
    const { th } = await worker(t);
    answers.push(JSON.stringify({ besluit: 'nieuw', naam: 'offerte-opvolgen', omschrijving: 'Een offerte opvolgen.', werkwijze: '1. Zoek de offerte op.\n2. Stuur de klant een mail met de offerte.' }));
    await work(t, th.id);
    assert.equal(skill(t, 'offerte-opvolgen')?.status, 'draft', 'it writes to customers');
    assert.equal(events(t, th.id).filter((e) => /offerte-opvolgen/.test(e)).length, 0, 'no line "vastgelegd voor het hele team"');

    // "Vraagt toestemming" (the default for a new bot): what it lays down waits for the owner as well.
    const asks = await worker(t, { name: 'Vera', access_mode: 'ask' });
    for (let i = 1; i <= REVIEW_AFTER_STEPS; i++) fs.mkdirSync(path.join(asks.ws, 'bron'), { recursive: true }), fs.writeFileSync(path.join(asks.ws, 'bron', `deel-${i}.md`), `Bron ${i}.`);
    answers.push(JSON.stringify({ besluit: 'nieuw', naam: 'bronnen-nalopen', omschrijving: 'Bronnen nalopen voor een rapport.', werkwijze: '1. Lees elke bron in bron/.\n2. Vat ze samen.' }));
    await work(t, asks.th.id, { tool: 'read_file', ask: 'Loop de bronnen na.' });
    const s = skill(t, 'bronnen-nalopen');
    assert.equal(s?.status, 'draft');
    const audit = t.app.ctx.store.one<any>("SELECT data FROM audit WHERE kind = 'skill.draft_created' ORDER BY id DESC");
    assert.match(JSON.parse(audit.data).reason, /deze bot eerst toestemming vraagt/);
  } finally {
    await done(t);
  }
});

test('no look back when the owner switched it off for the bot, when the bot saved a skill itself in that turn, or again within a quarter of an hour', async () => {
  const t = await app();
  try {
    const { a, th } = await worker(t);
    // The bot saved one itself in this turn: nothing to add.
    await work(t, th.id, { before: [{ toolCalls: [{ name: 'skill_save', args: { name: 'eigen-werkwijze', description: 'Zelf vastgelegd.', instructions: '1. Doe het zo.' } }] }] });
    assert.equal(prompts.length, 0);

    // Once, and not again within the quarter of an hour.
    await work(t, th.id);
    assert.equal(prompts.length, 1);
    await work(t, th.id);
    assert.equal(prompts.length, 1, 'the second turn right after: no look back');

    // Off for this bot.
    resetSkillReview();
    const cur = t.app.ctx.store.agent(a.id)!;
    t.app.ctx.store.updateAgent(a.id, { settings: { ...cur.settings, quality: { ...(cur.settings?.quality || {}), skillReview: false } } });
    await work(t, th.id);
    assert.equal(prompts.length, 1);
  } finally {
    await done(t);
  }
});
