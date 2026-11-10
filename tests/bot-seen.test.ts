import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import seen, { titleFacts } from '../server/modules/seen/index.js';
import folders from '../server/modules/folders/index.js';
import { acpFacts, cliFacts, teambotFacts } from '../server/modules/cli-agents/activity-labels.js';

// A-58 "Wat heeft deze bot gezien en gedaan" and A-35 the bot's own files: from the steps and tool calls TeamBot keeps.

test('facts from the engines\' own tool calls', () => {
  assert.deepEqual(cliFacts('Read', { file_path: 'C:\\w\\a.txt' }), [{ op: 'read', target: 'C:\\w\\a.txt' }]);
  assert.deepEqual(cliFacts('Write', { file_path: '/w/plan.md', content: 'x' }), [{ op: 'write', target: '/w/plan.md' }]);
  assert.deepEqual(cliFacts('Bash', { command: 'python tel.py' }), [{ op: 'exec', target: 'python tel.py' }]);
  assert.deepEqual(cliFacts('WebFetch', { url: 'https://example.org/x' }), [{ op: 'web', target: 'https://example.org/x' }]);
  assert.deepEqual(cliFacts('WebSearch', { query: 'weer utrecht' }), [{ op: 'search', target: 'weer utrecht' }]);
  assert.deepEqual(cliFacts('mcp__github__create_issue', {}), [{ op: 'app', target: 'github' }]);
  assert.equal(cliFacts('TodoWrite', { todos: [] }), undefined);
  assert.deepEqual(acpFacts({ kind: 'read', locations: [{ path: '/w/b.pdf' }] }), [{ op: 'read', target: '/w/b.pdf' }]);
  assert.deepEqual(acpFacts({ kind: 'execute', rawInput: { command: 'cd "/w" && ls' } }, '/w'), [{ op: 'exec', target: 'ls' }]);
  assert.deepEqual(acpFacts({ title: 'websearch', rawInput: { query: 'q' } }), [{ op: 'search', target: 'q' }]);
  assert.deepEqual(teambotFacts('write_file', { path: 'a/b.txt' }), [{ op: 'write', target: 'a/b.txt' }]);
  assert.deepEqual(teambotFacts('x', {}, 'Bestanden'), [{ op: 'app', target: 'Bestanden' }]);
  // Older steps without facts: TeamBot's own step titles are read back.
  assert.deepEqual(titleFacts({ kind: 'tool', title: 'Las een webpagina: https://a.nl', ts: '' }), [{ op: 'web', target: 'https://a.nl' }]);
  assert.deepEqual(titleFacts({ kind: 'tool', title: 'Paste plan.md aan', ts: '' }), [{ op: 'write', target: 'plan.md' }]);
  assert.deepEqual(titleFacts({ kind: 'files', title: 'Bestanden gewijzigd', detail: 'add: /w/x.py\ndelete: /w/y.py', ts: '' }), [{ op: 'write', target: '/w/x.py' }, { op: 'delete', target: '/w/y.py' }]);
});

test('per bot: files read and written, pages, commands, apps and approvals; per conversation for the side panel', async () => {
  const t = await startTestApp({ modules: [folders, seen] });
  try {
    const a = await t.agent({ name: 'Doener', access_mode: 'full' });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    // An API bot writes and reads a file with TeamBot's own tools.
    t.script.push({ toolCalls: [{ name: 'write_file', args: { path: 'notities/plan.md', content: '# Plan\n' } }] }, { toolCalls: [{ name: 'read_file', args: { path: 'notities/plan.md' } }] }, { text: 'Klaar' });
    await t.say(th.id, 'Maak een plan');
    // A CLI bot's answer (as the cli-agents module stores it): steps with facts.
    const ws = a.workspace as string;
    fs.writeFileSync(path.join(ws, 'tel.py'), 'print(1)\n');
    const st = t.app.ctx.store;
    const th2 = await t.api('POST', '/threads', { agentId: a.id });
    st.createMessage({
      thread_id: th2.id,
      role: 'assistant',
      author_type: 'agent',
      author_id: a.id,
      author_name: a.name,
      content: 'Gedaan',
      status: 'done',
      parts: {
        activity: [
          { kind: 'tool', title: 'Schreef tel.py', ts: new Date().toISOString(), facts: [{ op: 'write', target: path.join(ws, 'tel.py') }] },
          { kind: 'tool', title: 'Voerde uit: python tel.py', ts: new Date().toISOString(), facts: [{ op: 'exec', target: 'python tel.py' }] },
          { kind: 'tool', title: 'Las een webpagina: https://example.org/tarief', ts: new Date().toISOString(), facts: [{ op: 'web', target: 'https://example.org/tarief' }] },
          { kind: 'tool', title: 'Gebruikte GitHub', ts: new Date().toISOString(), facts: [{ op: 'app', target: 'GitHub' }] },
          { kind: 'tool', title: 'Zocht op internet: tarieven 2026', ts: new Date().toISOString() },
        ],
      },
    } as any);
    st.insert('approvals', { id: 'apr_test1', user_id: a.user_id, agent_id: a.id, thread_id: th2.id, kind: 'tool', tool: 'Write', input: {}, summary: 'Bestand schrijven: tel.py', risk: 'write', status: 'approved', created_at: new Date().toISOString() });

    const all = await t.api('GET', `/agents/${a.id}/seen`);
    assert.deepEqual(all.written.map((f: any) => f.name).sort(), ['plan.md', 'tel.py']);
    const plan = all.written.find((f: any) => f.name === 'plan.md');
    assert.equal(plan.root, 0);
    assert.equal(plan.rel, 'notities/plan.md');
    assert.equal(plan.exists, true);
    assert.equal(all.read[0].rel, 'notities/plan.md');
    assert.deepEqual(all.commands.map((c: any) => c.target), ['python tel.py']);
    assert.deepEqual(all.pages.map((c: any) => c.target), ['https://example.org/tarief']);
    assert.deepEqual(all.searches.map((c: any) => c.target), ['tarieven 2026'], 'older step without facts');
    assert.deepEqual(all.apps.map((c: any) => c.target), ['GitHub']);
    assert.equal(all.approvals[0].summary, 'Bestand schrijven: tel.py');
    assert.equal(all.approvals[0].status, 'approved');

    // Per conversation (side panel): only that conversation's files.
    const one = await t.api('GET', `/agents/${a.id}/seen?thread=${th.id}`);
    assert.deepEqual(one.written.map((f: any) => f.name), ['plan.md']);
    assert.equal(one.approvals.length, 0);
    // The preview goes through the folders module with the root and path from this view.
    const prev = await t.api('GET', `/folders/file?agentId=${a.id}&root=${plan.root}&path=${encodeURIComponent(plan.rel)}`);
    assert.match(prev.text, /# Plan/);

    // Someone else cannot look at this bot.
    const other = t.app.ctx.auth.createUser({ name: 'Ander', email: 'ander@test.local', password: 'geheim1234', role: 'member' });
    const s2 = t.app.ctx.auth.createSession(other.id, 'web', 'x');
    const r = await fetch(`${t.app.url}/api/agents/${a.id}/seen`, { headers: { authorization: `Bearer ${s2.token}` } });
    assert.equal(r.status, 404);
  } finally {
    await t.close();
  }
});
