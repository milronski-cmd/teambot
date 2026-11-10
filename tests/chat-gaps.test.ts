import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { msgs, runsOf, settle, team, until } from './team-mock.js';

/** Chat gaps from acceptance round 2: resume after a manual stop, busy policy, message versions, export, bot order. */

const running = (t: any, threadId: string) => t.app.ctx.store.one("SELECT * FROM runs WHERE thread_id = ? AND status = 'running'", threadId);

test('Hervatten after a manual stop: offered, resumes with its own instruction, gone after a new message or a steer', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    m.script('Ada', { text: 'lange taak', delayMs: 2000 }, { text: 'verder gegaan' });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'doe iets langs' });
    await until(() => running(t, th.id));
    assert.equal((await t.api('GET', `/threads/${th.id}`)).canResume, false, 'not while it runs');
    await t.api('POST', `/threads/${th.id}/stop`);
    await settle(t);
    const after = await t.api('GET', `/threads/${th.id}`);
    assert.equal(after.canResume, true);
    assert.equal(after.resumeReason, 'stopped');
    await t.api('POST', `/threads/${th.id}/resume`);
    await settle(t);
    const sys = msgs(t, th.id).filter((x) => x.role === 'system').at(-1)!;
    assert.match(sys.content, /gestopt/);
    assert.equal(runsOf(t, th.id).at(-1).trigger, 'resume');
    assert.equal((await t.api('GET', `/threads/${th.id}`)).canResume, false, 'the resumed run finished normally');

    // A stop followed by a new message: nothing to resume any more.
    m.script('Ada', { text: 'nog een', delayMs: 2000 }, { text: 'nieuw antwoord' });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'tweede taak' });
    await until(() => running(t, th.id));
    await t.api('POST', `/threads/${th.id}/stop`);
    await settle(t);
    assert.equal((await t.api('GET', `/threads/${th.id}`)).canResume, true);
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'iets anders' });
    await settle(t);
    assert.equal((await t.api('GET', `/threads/${th.id}`)).canResume, false);

    // Interrupting to steer is not a stop: the steering message continues the work.
    m.script('Ada', { text: 'bezig', delayMs: 2000 }, { text: 'bijgestuurd' });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'derde taak' });
    await until(() => running(t, th.id));
    await t.api('POST', `/threads/${th.id}/steer`, { content: 'anders', interrupt: true });
    await settle(t);
    assert.equal((await t.api('GET', `/threads/${th.id}`)).canResume, false);
  } finally {
    await t.close();
  }
});

test('busy policy: queue (default), steer (API: into the running turn) and interrupt (stop + send now)', async () => {
  const t = await startTestApp();
  try {
    const m = await team(t);
    const ada = await m.bot('Ada');
    const th = await t.api('POST', '/threads', { agentId: ada.id });
    // queue
    m.script('Ada', { text: 'een', delayMs: 400 }, { text: 'twee' });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'eerste' });
    await until(() => running(t, th.id));
    assert.equal((await t.api('POST', `/threads/${th.id}/queue`, { content: 'tweede' })).mode, 'queued');
    await settle(t);
    // steer
    await t.api('PATCH', `/agents/${ada.id}`, { busy_policy: 'steer' });
    m.script('Ada', { text: 'stap', delayMs: 400 }, { text: 'met bijsturing', check: (req) => assert.match(String(req.messages.at(-1)!.content), /korter/) });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'schrijf iets' });
    await until(() => running(t, th.id));
    const s = await t.api('POST', `/threads/${th.id}/queue`, { content: 'korter graag' });
    assert.equal(s.mode, 'steered');
    await settle(t);
    // interrupt
    await t.api('PATCH', `/agents/${ada.id}`, { busy_policy: 'interrupt' });
    m.script('Ada', { text: 'lang', delayMs: 3000 }, { text: 'meteen' });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'lange klus' });
    const r = await until(() => running(t, th.id));
    const i = await t.api('POST', `/threads/${th.id}/queue`, { content: 'stop en doe dit' });
    assert.equal(i.mode, 'interrupted');
    await settle(t);
    assert.equal(t.app.ctx.store.run(r.id)!.status, 'cancelled');
    // An explicit mode from the composer wins over the bot's rule.
    m.script('Ada', { text: 'lang', delayMs: 600 }, { text: 'daarna' });
    await t.api('POST', `/threads/${th.id}/queue`, { content: 'weer lang' });
    await until(() => running(t, th.id));
    assert.equal((await t.api('POST', `/threads/${th.id}/queue`, { content: 'later', mode: 'queue' })).mode, 'queued');
    await settle(t);
    await assert.rejects(t.api('PATCH', `/agents/${ada.id}`, { busy_policy: 'automatisch' }), /Ongeldig/);
  } finally {
    await t.close();
  }
});

test('editing a message keeps the earlier versions (newest last); export as Markdown and JSON', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent();
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'ok' });
    const all = await t.say(th.id, 'versie een');
    const mine = all.find((x: any) => x.role === 'user')!;
    await t.api('PATCH', `/messages/${mine.id}`, { content: 'versie twee' });
    const v3 = await t.api('PATCH', `/messages/${mine.id}`, { content: 'versie drie' });
    assert.equal(v3.content, 'versie drie');
    assert.deepEqual(v3.parts.versions.map((x: any) => x.content), ['versie een', 'versie twee']);
    assert.ok(v3.edited_at);
    // Same text again: no new version.
    assert.equal((await t.api('PATCH', `/messages/${mine.id}`, { content: 'versie drie' })).parts.versions.length, 2);

    const res = await fetch(`${t.app.url}/api/threads/${th.id}/export?format=json`, { headers: { authorization: `Bearer ${t.token}` } });
    assert.match(res.headers.get('content-disposition') || '', /\.json"/);
    const j: any = await res.json();
    assert.equal(j.format, 'teambot.thread/v1');
    assert.equal(j.thread.provider_state, undefined, 'no engine session state in the export');
    assert.ok(j.messages.some((x: any) => x.content === 'versie drie' && x.parts.versions.length === 2));
    const md = await (await fetch(`${t.app.url}/api/threads/${th.id}/export?format=md`, { headers: { authorization: `Bearer ${t.token}` } })).text();
    assert.match(md, /versie drie/);
    assert.match(md, /bewerkt/);
  } finally {
    await t.close();
  }
});

// Acceptance round 3 (A-28): a Claude Code chat exported as Markdown had no steps at all (CLI engines keep them as
// activity lines, the export only knew API tool calls), and the attachment list ran into the next author's line.
test('Markdown export: steps of CLI engines, redacted, and lists that end before the next message', async () => {
  const { threadToMarkdown } = await import('../server/api/threads.js');
  const ctx: any = { config: { appName: 'TeamBot' } };
  const at = new Date().toISOString();
  const md = threadToMarkdown(ctx, { title: 'Test' } as any, [
    { role: 'user', author_name: 'Eigenaar', content: 'Lees de pdf', created_at: at, parts: { attachments: [{ name: 'offerte.pdf' }] } },
    { role: 'assistant', author_name: 'Mila', content: 'Klaar.', created_at: at, parts: { activity: [{ kind: 'session', title: 'Claude Code gestart' }, { kind: 'tool', title: 'Las uploads/offerte.pdf' }, { kind: 'tool', title: 'Voerde uit: curl -H "Authorization: Bearer sk-ant-api03-ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789" x' }, { kind: 'mode', title: 'Modus: x' }] } },
  ] as any);
  assert.match(md, /- 📎 offerte\.pdf\n\n\*\*Mila\*\*/, 'a blank line ends the attachment list');
  assert.match(md, /_3 stappen:_\n- 🔧 Claude Code gestart\n- 🔧 Las uploads\/offerte\.pdf/);
  assert.doesNotMatch(md, /sk-ant-api03-ABCDEF/, 'no key in the export');
  assert.doesNotMatch(md, /Modus: x/);
});

test('own bot order: POST /agents/order sets the positions, ignores foreign ids; delete preview counts what goes', async () => {
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Een' });
    const b = await t.agent({ name: 'Twee' });
    const c = await t.agent({ name: 'Drie' });
    const r = await t.api('POST', '/agents/order', { ids: [c.id, 'ag_vreemd', a.id, b.id] });
    assert.deepEqual(r.order, [c.id, a.id, b.id]);
    const list = await t.api('GET', '/agents');
    assert.deepEqual(list.map((x: any) => x.name), ['Drie', 'Een', 'Twee']);
    assert.equal(list.find((x: any) => x.id === a.id).updated_at, a.updated_at, 'reordering is not a profile change');
    await assert.rejects(t.api('POST', '/agents/order', { ids: [] }), /volgorde/);

    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ text: 'hoi' });
    await t.say(th.id, 'hallo');
    const p = await t.api('GET', `/agents/${a.id}/delete-preview`);
    assert.equal(p.threads, 1);
    assert.equal(p.messages, 2);
    assert.equal(p.running, 0);
    assert.equal(typeof p.workspaceInData, 'boolean');
  } finally {
    await t.close();
  }
});
