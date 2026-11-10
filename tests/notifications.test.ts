import test from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { cleanPrefs, decide, isImportant, mergePrefs, DEFAULT_PREFS } from '../server/modules/notifications/policy.js';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString();

test('policy: what is important, levels per bot, prefs are cleaned', () => {
  assert.equal(isImportant({ kind: 'approval' }), true);
  assert.equal(isImportant({ kind: 'question' }), true);
  assert.equal(isImportant({ kind: 'limit', level: 'warn' }), true);
  assert.equal(isImportant({ kind: 'limit', level: 'reset' }), false);
  assert.equal(isImportant({ kind: 'routine', level: 'error' }), true);
  assert.equal(isImportant({ kind: 'routine' }), false);
  assert.equal(isImportant({ kind: 'agent' }), false);
  assert.equal(isImportant(null), false);

  const p = cleanPrefs({ sound: false, other: 'important', bots: { a1: 'none', a2: 'important', a3: 'all', a4: 'luid' }, extra: 1 });
  assert.deepEqual(p, { sound: false, other: 'important', bots: { a1: 'none', a2: 'important' } });
  assert.deepEqual(cleanPrefs(undefined), DEFAULT_PREFS);

  assert.deepEqual(decide(p, { agentId: 'a1', important: true }), { alert: false, muted: true, level: 'none' });
  assert.deepEqual(decide(p, { agentId: 'a2', important: false }), { alert: false, muted: true, level: 'important' });
  assert.equal(decide(p, { agentId: 'a2', important: true }).alert, true);
  assert.equal(decide(p, { agentId: 'onbekend', important: false }).alert, true, 'a bot without an entry gets everything');
  assert.equal(decide(p, { agentId: null, important: false }).alert, false, 'without a bot: the "other" level');

  const m = mergePrefs(p, { sound: true, bots: { a1: null, a2: 'all', a5: 'none', vreemd: 'none' }, other: 'x' }, (id) => id !== 'vreemd');
  assert.deepEqual(m, { sound: true, other: 'important', bots: { a5: 'none' } });
});

test('notification centre: history, coalescing, read, levels per bot, runs, approvals, channels, push and desktop respect it', async () => {
  const t = await startTestApp();
  try {
    const { ctx } = t.app;
    const owner = ctx.auth.owner()!;
    const added: any[] = [];
    const reads: any[] = [];
    ctx.events.subscribe((e) => {
      if (e.type === 'notification.added') added.push(e.data);
      if (e.type === 'notifications.read') reads.push(e.data);
    });
    const a = await t.agent({ name: 'Onderzoeker' });
    const b = await t.agent({ name: 'Stille' });
    const th = ctx.store.createThread({ user_id: owner.id, agent_id: a.id, kind: 'chat' });
    const list = async (f = 'all') => t.api('GET', `/notifications?filter=${f}`);

    // notify_user-style notification → in the history, unread, alerts.
    ctx.events.emit(owner.id, 'notification', { title: 'Rapport klaar', body: 'Staat in je werkmap', link: `#/t/${th.id}`, kind: 'agent', agentId: a.id });
    let r = await list();
    assert.equal(r.items.length, 1);
    assert.equal(r.unread, 1);
    assert.equal(r.items[0].agent_id, a.id);
    assert.equal(r.items[0].read_at, null);
    assert.equal(added.at(-1).alert, true);
    assert.equal(added.at(-1).sound, true);

    // The same warning twice: one line with a count. An unsafe link is dropped.
    ctx.events.emit(owner.id, 'notification', { title: 'Apps: opnieuw inloggen', body: 'Verlopen', link: '#/m/mcp/c/x', kind: 'mcp' });
    ctx.events.emit(owner.id, 'notification', { title: 'Apps: opnieuw inloggen', body: 'Nog steeds verlopen', link: '#/m/mcp/c/x', kind: 'mcp' });
    ctx.events.emit(owner.id, 'notification', { title: 'Phish', link: 'https://evil.example', kind: 'agent' });
    r = await list();
    const relogin = r.items.find((n: any) => n.title === 'Apps: opnieuw inloggen');
    assert.equal(relogin.count, 2);
    assert.equal(relogin.body, 'Nog steeds verlopen');
    assert.equal(r.items.find((n: any) => n.title === 'Phish').link, '');
    assert.equal(r.unread, 3);

    // An approval: important, a question shows as "question"; resolving it marks the line read.
    ctx.store.insert('approvals', { id: 'apr_q1', user_id: owner.id, agent_id: a.id, thread_id: th.id, kind: 'question', tool: 'ask_user', input: {}, summary: 'Welke kleur?', risk: 'read', status: 'pending', created_at: iso(0) });
    ctx.events.emit(owner.id, 'notification', { title: 'Onderzoeker heeft een vraag', body: 'Welke kleur?', link: `#/t/${th.id}`, kind: 'approval', approvalId: 'apr_q1' });
    ctx.events.emit(owner.id, 'notification', { title: 'Onderzoeker heeft een vraag', body: 'Welke kleur?', link: `#/t/${th.id}`, kind: 'approval', approvalId: 'apr_q1' });
    r = await list('important');
    assert.equal(r.items.length, 1, 'the same approval never twice');
    assert.equal(r.items[0].kind, 'question');
    assert.equal(r.items[0].important, true);
    ctx.events.emit(owner.id, 'approval.updated', { id: 'apr_q1', status: 'approved' });
    r = await list('important');
    assert.ok(r.items[0].read_at, 'answered → read');

    // Levels: "alleen belangrijk" for one bot, "niets" for another; validation of the prefs.
    const prefs = await t.api('PUT', '/notifications/prefs', { sound: false, bots: { [a.id]: 'important', [b.id]: 'none', nietmijn: 'none' } });
    assert.deepEqual(prefs.bots, { [a.id]: 'important', [b.id]: 'none' });
    const svc = ctx.services.notifications;
    assert.equal(svc.shouldAlert(owner.id, { kind: 'agent', agentId: a.id }), false);
    assert.equal(svc.shouldAlert(owner.id, { kind: 'agent', link: `#/t/${th.id}` }), false, 'the bot is found via the chat link');
    assert.equal(svc.shouldAlert(owner.id, { kind: 'approval', agentId: a.id }), true, 'important still alerts');
    assert.equal(svc.shouldAlert(owner.id, { kind: 'approval', agentId: b.id }), false, 'niets: nothing alerts');
    assert.equal(svc.shouldAlert(owner.id, { kind: 'limit', level: 'warn' }), true, 'not a bot: "other" = all');

    const before = (await list()).unread;
    ctx.events.emit(owner.id, 'notification', { title: 'Kleine update', body: 'x', kind: 'agent', agentId: a.id });
    assert.equal(added.at(-1).alert, false);
    assert.equal(added.at(-1).sound, false);
    r = await list();
    const quiet = r.items.find((n: any) => n.title === 'Kleine update');
    assert.equal(quiet.muted, true);
    assert.ok(quiet.read_at, 'muted lines do not count as unread');
    assert.equal(r.unread, before);
    ctx.events.emit(owner.id, 'notification', { title: 'Mislukt', kind: 'agent', level: 'error', agentId: a.id });
    assert.equal(added.at(-1).alert, true);
    assert.equal(added.at(-1).sound, false, 'sound off');

    // Phone push asks the same question (no push for a muted bot, silent when sound is off).
    const push = ctx.services.mobile?.instance?.push;
    if (push) {
      assert.equal((push as any).fromNotification(owner.id, { title: 'x', kind: 'agent', agentId: b.id }), null);
      const ok = (push as any).fromNotification(owner.id, { title: 'Vraag', kind: 'approval', agentId: a.id, link: '#/inbox' });
      assert.equal(ok.msg.silent, true);
    }

    // Runs: a failure and a long task are recorded once; a short one is not.
    const run = (status: string, ms: number, extra: any = {}) => ({ id: `run_${status}_${ms}`, thread_id: th.id, agent_id: a.id, user_id: owner.id, status, trigger: 'user', error: status === 'error' ? 'Model gaf een fout' : null, started_at: iso(ms), finished_at: iso(0), ...extra });
    ctx.events.emit(owner.id, 'run.updated', run('done', 5_000));
    ctx.events.emit(owner.id, 'run.updated', run('error', 2_000));
    ctx.events.emit(owner.id, 'run.updated', run('error', 2_000));
    ctx.events.emit(owner.id, 'run.updated', run('done', 120_000));
    ctx.events.emit(owner.id, 'run.updated', run('done', 120_000, { id: 'run_routine', trigger: 'routine' }));
    r = await list();
    const runs = r.items.filter((n: any) => n.kind === 'run');
    assert.deepEqual(runs.map((n: any) => n.title).sort(), ['Onderzoeker is klaar', 'Onderzoeker liep vast']);
    assert.equal(runs.find((n: any) => n.title.endsWith('vast')).important, true);
    assert.equal(runs.find((n: any) => n.title.endsWith('vast')).body, 'Model gaf een fout');
    // An engine's own English error reads as the same plain sentence as in the chat (acceptance round 4, B-68).
    ctx.events.emit(owner.id, 'run.updated', run('error', 1_000, { id: 'run_oc_limit', error: 'OpenCode gaf een fout: Internal error: Free usage limit reached. Connect a provider or subscribe to OpenCode Go to keep going, or switch models.' }));
    const limitNote = (await list()).items.find((n: any) => n.ref === 'run:run_oc_limit' || (n.kind === 'run' && /gratis limiet/.test(n.body || '')));
    assert.match(limitNote.body, /^De gratis limiet van .+ is bereikt/);
    assert.doesNotMatch(limitNote.body, /Free usage|Connect a provider/);

    // A channel message: quietly in the history, one line per chat.
    const ch = ctx.store.createThread({ user_id: owner.id, agent_id: a.id, kind: 'channel', title: 'Jan' });
    const inbound = (content: string) => ctx.store.createMessage({ thread_id: ch.id, role: 'user', author_type: 'external', author_id: 'ext:1', author_name: 'Jan (Telegram)', content, parts: { channel: { adapterLabel: 'Telegram' } } });
    const n0 = added.length;
    svc.instance.onMessage({ message: inbound('Hoi'), thread: ch });
    svc.instance.onMessage({ message: inbound('Ben je er?'), thread: ch });
    assert.equal(added.length, n0 + 2);
    assert.equal(added.at(-1).alert, false);
    r = await list();
    const chan = r.items.filter((n: any) => n.kind === 'channel');
    assert.equal(chan.length, 1);
    assert.equal(chan[0].count, 2);
    assert.equal(chan[0].body, 'Ben je er?');

    // Mark read: by id and all; a device (phone) may do the same.
    const one = (await list('unread')).items[0];
    const rr = await t.api('POST', '/notifications/read', { ids: [one.id] });
    assert.equal(rr.unread, (await list('unread')).items.length);
    assert.deepEqual(reads.at(-1).ids, [one.id]);
    const phone = ctx.auth.createSession(owner.id, 'device', 'Telefoon').token;
    const pr = await fetch(`${t.app.url}/api/notifications/read`, { method: 'POST', headers: { authorization: `Bearer ${phone}`, 'content-type': 'application/json' }, body: JSON.stringify({ all: true }) });
    assert.equal(pr.status, 200);
    assert.equal((await list()).unread, 0);
    assert.equal((await fetch(`${t.app.url}/api/notifications`, { headers: { authorization: `Bearer ${phone}` } })).status, 200);

    // Another user sees nothing of this; export includes it; deleting a bot forgets its level.
    const other = ctx.auth.createUser({ name: 'Ander', email: 'ander@example.com', password: 'wachtwoord1' });
    const tokO = ctx.auth.createSession(other.id, 'web', 'B').token;
    const ro = await fetch(`${t.app.url}/api/notifications`, { headers: { authorization: `Bearer ${tokO}` } }).then((x) => x.json() as Promise<any>);
    assert.equal(ro.items.length, 0);
    assert.ok(svc.exportUser(owner.id).notifications.history.length > 3);
    await t.api('DELETE', `/agents/${b.id}`);
    await sleep(20);
    assert.equal((await t.api('GET', '/notifications/prefs')).bots[b.id], undefined);

    // Clear the history.
    await t.api('DELETE', '/notifications');
    assert.equal((await list()).items.length, 0);
  } finally {
    await t.close();
  }
});
