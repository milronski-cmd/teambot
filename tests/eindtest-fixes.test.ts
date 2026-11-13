/**
 * What the acceptance run with a real model (12 nov, a fresh install on the Claude subscription engine) showed did not
 * work, pinned here without a model:
 *  - a bot renames itself with my_settings ("voortaan heet je Max") and that is no shared lesson for the team;
 *  - skill_find takes the search word under the names a model guesses, never silently "the most popular";
 *  - a marketplace skill installs from the archive of its commit when the GitHub API is at its hourly limit;
 *  - the main bot is told to make exactly the colleagues asked for (team_add_bot in its own team), gets its colleagues
 *    next to every message of its owner, and a bot of a second team can hand work to the main bot;
 *  - Claude Code's own subagents are off for a bot that has colleagues;
 *  - a task with a very long title keeps all of it (as the description).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import AdmZip from 'adm-zip';
import { startTestApp } from './helpers.js';
import type { ToolOutput } from '../server/core/types.js';
import { isCorrection } from '../server/modules/quality/lessons.js';
import { findQuery } from '../server/modules/skills/tools.js';
import { githubAccess, gitBlobSha, treeFromZip } from '../server/modules/skills/curated-source.js';
import { WebError } from '../server/modules/skills/webcache.js';
import { CLAUDE_SUBAGENT_TOOLS, COLLEAGUES_NOTE, hasColleagues } from '../server/modules/cli-agents/claude.js';

async function setup() {
  const t = await startTestApp();
  const ctx = t.app.ctx;
  const userId = ctx.auth.owner()!.id;
  // `approved`: the call is the owner's own word (as when he typed it in this turn), so nothing waits on a card.
  const run = async (agentId: string, name: string, args: any = {}, approved = false): Promise<ToolOutput> => {
    const agent = ctx.store.agent(agentId)!;
    const thread = ctx.chat.threadForAgent(userId, agentId);
    const tool = (await ctx.tools.forAgent(agent, thread)).find((x) => x.name === name);
    assert.ok(tool, `${agent.name} has ${name}`);
    const out = await tool.run(args, { ctx, agent, thread, userId, run: null as any, signal: new AbortController().signal, toolCallId: 'c1', progress() {}, approved } as any);
    return typeof out === 'string' ? { text: out } : out;
  };
  return { t, ctx, userId, run };
}

test('a bot gives itself a new name and instructions with my_settings; a twin name is refused; no shared lesson from it', async () => {
  const e = await setup();
  try {
    const a = await e.t.agent({ name: 'Robin', role: 'Assistent' });
    const b = await e.t.agent({ name: 'Kim' });
    const out = await e.run(a.id, 'my_settings', { name: 'Max', instructions_add: 'Antwoord altijd in drie zinnen.' }, true);
    assert.ok(!out.isError, out.text);
    assert.match(out.text, /naam: Max/);
    const now = e.ctx.store.agent(a.id)!;
    assert.equal(now.name, 'Max');
    assert.match(now.instructions, /drie zinnen/);
    assert.match((await e.run(a.id, 'my_settings', { name: 'Kim' }, true)).text, /Er is al een bot die Kim heet/);
    assert.equal(e.ctx.store.agent(b.id)!.name, 'Kim');
    // How the bot itself is called or answers is its own setting, not a correction that becomes a lesson for everyone.
    assert.equal(isCorrection('voortaan antwoord je altijd in drie zinnen en heet je Max'), false);
    assert.equal(isCorrection('Volgende keer eerst even bellen voordat je iets verstuurt.'), true);
    assert.equal(isCorrection('Nee, zo doen we dat niet.'), true);
  } finally {
    await e.t.close();
  }
});

test('skill_find reads the search words under the names a model guesses', () => {
  assert.equal(findQuery({ query: 'copywriting' }), 'copywriting');
  assert.equal(findQuery({ word: 'commit' }), 'commit');
  assert.equal(findQuery({ q: ' git ' }), 'git');
  assert.equal(findQuery({ search: 'seo' }), 'seo');
  assert.equal(findQuery({}), '');
});

test('a marketplace skill is read from the archive of its commit when the GitHub API is at its limit', async () => {
  const zip = new AdmZip();
  const md = Buffer.from('---\nname: demo\ndescription: "Een voorbeeld."\n---\n\n# Demo\n');
  zip.addFile('repo-abc/skills/demo/SKILL.md', md);
  zip.addFile('repo-abc/LICENSE', Buffer.from('MIT License\n'));
  const buf = zip.toBuffer();
  const z = treeFromZip(buf);
  assert.deepEqual(z.tree.map((e) => e.path).sort(), ['LICENSE', 'skills/demo/SKILL.md']);
  assert.equal(z.tree.find((e) => e.path.endsWith('SKILL.md'))!.sha, gitBlobSha(md), 'the same blob hash git gives');

  const asked: string[] = [];
  const cache: any = {
    async json(_k: string, url: string) {
      asked.push(url);
      throw new WebError('Limiet bereikt bij api.github.com.', 429, 'rate-limited');
    },
    async buffer(_k: string, url: string) {
      asked.push(url);
      if (/codeload\.github\.com\/o\/r\/zip\//.test(url)) return { data: buf };
      throw new WebError('niet verwacht', 502, 'network');
    },
  };
  const access = githubAccess(cache, { headers: () => ({}), head: async () => ({ commit: null, error: null }) });
  const commit = 'a'.repeat(40);
  const tree = await access.tree('o/r', commit);
  assert.equal(tree.length, 2);
  const blob = await access.blob('o/r', commit, tree.find((e) => e.path.endsWith('SKILL.md'))!);
  assert.equal(blob.toString('utf8'), md.toString('utf8'));
  assert.ok(!asked.some((u) => /raw\.githubusercontent/.test(u)), 'the files come from the archive, no second download');
  // Not found stays not found (no archive guess for a commit that does not exist).
  const gone: any = { json: async () => { throw new WebError('Niet gevonden', 404, 'not-found'); }, buffer: async () => { throw new Error('no'); } };
  await assert.rejects(githubAccess(gone, { headers: () => ({}), head: async () => ({ commit: null, error: null }) }).tree('o/r', commit), /Niet gevonden/);
});

test('the main bot: colleagues beside each owner message, exact colleagues by team_add_bot in its own team, and reachable from a second team', async () => {
  const e = await setup();
  try {
    const main = await e.t.agent({ name: 'Baas', access_mode: 'full' });
    const th = e.ctx.chat.threadForAgent(e.userId, main.id);
    /** What the model was sent for the owner's last message (the turn context is part of it). */
    const turn = async (threadId: string, text: string) => {
      e.t.script.push({ text: 'ok' });
      await e.t.say(threadId, text);
      const req = e.t.requests.at(-1)!;
      return { sys: String(req.system || ''), msgs: JSON.stringify(req.messages) };
    };
    assert.doesNotMatch((await turn(th.id, 'Schrijf een slogan')).msgs, /Je collega's:/, 'alone: nothing to hand on');

    // "Maak een collega voor SEO en een voor teksten": two bots, in the main bot's own team, also without a team name.
    const second = await e.t.api('POST', '/teams', { name: 'Verkoop', starterRules: false });
    for (const [name, role] of [['Seo', 'SEO-specialist'], ['Teksten', 'Tekstschrijver']]) {
      const out = await e.run(main.id, 'team_add_bot', { name, role, instructions: `Jij doet ${role}.` });
      assert.ok(!out.isError, out.text);
    }
    const teams = e.ctx.services.teams;
    const made = e.ctx.store.agents(e.userId).filter((a) => ['Seo', 'Teksten'].includes(a.name));
    assert.equal(made.length, 2);
    for (const b of made) {
      assert.equal(teams.teamOf(b.id), teams.teamOf(main.id), `${b.name} is in the main bot's own team`);
      assert.equal(b.access_mode, 'full');
    }
    const { sys, msgs } = await turn(th.id, 'Schrijf een slogan voor de homepage');
    assert.match(msgs, /Je collega's: [^"]*Seo \(SEO-specialist\)[^"]*Teksten \(Tekstschrijver\)[^"]*delegate_task/);
    assert.doesNotMatch((await turn(e.ctx.chat.threadForAgent(e.userId, made[0].id).id, 'Schrijf een slogan')).msgs, /Je collega's:/, 'only the main bot');
    // The system prompt says the same, next to the bot list.
    assert.match(sys, /maak dan precies die bot of bots met team_add_bot in je eigen team/);
    assert.match(sys, /Een nieuw team maak je alleen als de eigenaar om een team vraagt/);

    // A bot of the second team can hand work back to the main bot (it is above all teams).
    const otto = await e.t.agent({ name: 'Otto', access_mode: 'full' });
    await e.t.api('PUT', `/teams/${second.id}/bots/${otto.id}`, {});
    assert.equal(teams.teamOf(otto.id), second.id);
    assert.equal(teams.delegateError(otto.id, main.id), null);
    assert.match(String(teams.delegateError(otto.id, made[0].id)), /Geweigerd door TeamBot/, 'the wall between the teams stays');
  } finally {
    await e.t.close();
  }
});

test('Claude Code: its own subagents are off for a bot that has colleagues it can give work to', () => {
  const ctx = (bots: any[]) => ({ store: { agents: () => bots } });
  const me = { id: 'a', user_id: 'u' };
  assert.equal(hasColleagues(ctx([me, { id: 'b' }]), me, ['delegate_task', 'ask_bot']), true);
  assert.equal(hasColleagues(ctx([me]), me, ['delegate_task']), false, 'alone');
  assert.equal(hasColleagues(ctx([me, { id: 'b', archived: true }]), me, ['delegate_task']), false, 'only an archived bot');
  assert.equal(hasColleagues(ctx([me, { id: 'b' }]), me, ['memory_search']), false, 'without the team tools');
  assert.deepEqual(CLAUDE_SUBAGENT_TOOLS, ['Task', 'Agent']);
  assert.match(COLLEAGUES_NOTE, /delegate_task/);
});

test('a task whose title is the whole job keeps all of it as the description', async () => {
  const e = await setup();
  try {
    const long = `Schrijf een meta-titel voor de homepage ${'en nog een heel lang stuk uitleg '.repeat(8)}in het bestand C:/werk/site/metatitel.txt`;
    const task = await e.t.api('POST', '/rooms/tasks', { title: long, start: false });
    assert.equal(task.title.length, 200);
    assert.equal(task.description, long, 'nothing is cut off for the bot that does it');
    const short = await e.t.api('POST', '/rooms/tasks', { title: 'Kort', description: 'Eigen uitleg', start: false });
    assert.equal(short.description, 'Eigen uitleg');
  } finally {
    await e.t.close();
  }
});
