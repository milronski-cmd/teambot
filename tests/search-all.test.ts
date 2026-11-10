import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { ftsPrefixQuery, markSnippet } from '../server/modules/search/index.js';

const now = () => new Date().toISOString();

test('ftsPrefixQuery and markSnippet', () => {
  assert.equal(ftsPrefixQuery('basispak'), '"basispak"*');
  assert.equal(ftsPrefixQuery('de "zeppelin" landt'), '"de" "zeppelin" "landt"*');
  assert.equal(ftsPrefixQuery('a'), '"a"', 'a single letter is not a prefix (too many hits)');
  assert.equal(ftsPrefixQuery('*(:)'), '');
  assert.equal(markSnippet('De prijs is 49 euro per maand', 'euro'), 'De prijs is 49 [euro] per maand');
});

// Ctrl+K "zoek alles": one call over messages, channels, skills, apps, routines, memory and file names.
test('GET /search/all finds channels, skills, apps, routines, memory, files and messages (prefix while typing)', async () => {
  const t = await startTestApp();
  try {
    const { store } = t.app.ctx;
    const owner = t.app.ctx.auth.owner()!;
    const a = await t.agent({ name: 'Assistent' });

    // A Telegram channel, a skill, an app, a routine.
    store.insert('channel_bindings', { id: 'chb_1', user_id: owner.id, adapter: 'telegram', name: 'Klantenservice', agent_id: a.id, created_at: now(), updated_at: now() });
    store.insert('skills', { id: 'skl_1', user_id: owner.id, name: 'brand-guidelines', description: 'Huisstijl: kleuren en lettertypes', created_at: now(), updated_at: now() });
    store.insert('skills', { id: 'skl_2', user_id: owner.id, name: 'kladje', description: 'concept', status: 'draft', created_at: now(), updated_at: now() });
    store.insert('mcp_connections', { id: 'mcp_1', user_id: owner.id, name: 'Microsoft Learn', label: 'Microsoft Learn', slug: 'microsoft-learn', transport: 'http', created_at: now(), updated_at: now() });
    store.insert('routines', { id: 'rtn_1', user_id: owner.id, agent_id: a.id, name: 'Ochtendnieuws', prompt: 'Vat het nieuws samen', created_at: now(), updated_at: now() });

    // Files: the team folder and the bot's workspace (secrets are never listed).
    const team = path.join(t.dir, 'teammap');
    fs.mkdirSync(path.join(team, 'klanten', 'node_modules'), { recursive: true });
    fs.writeFileSync(path.join(team, 'klanten', 'afspraken.md'), 'x');
    fs.writeFileSync(path.join(team, 'klanten', 'node_modules', 'afspraken-pakket.js'), 'x');
    fs.writeFileSync(path.join(team, '.env'), 'GEHEIM=1');
    store.setSetting(owner.id, 'teamFolder', { path: team, label: 'Teammap', mode: 'rw', agents: 'all' });
    const agent = store.agent(a.id)!;
    fs.mkdirSync(agent.workspace, { recursive: true });
    fs.writeFileSync(path.join(agent.workspace, 'offerte-2026.txt'), 'x');

    // A message and a memory item.
    const th = store.createThread({ user_id: owner.id, agent_id: a.id, kind: 'chat' });
    const msg = store.createMessage({ thread_id: th.id, role: 'user', author_type: 'user', author_id: owner.id, author_name: 'Ik', content: 'Wat kost het basispakket per maand?' });
    await t.app.ctx.services.memory?.remember(owner.id, { content: 'Ronald drinkt zijn koffie zwart', scope: 'shared' });

    const q = async (s: string) => (await t.api('GET', `/search/all?q=${encodeURIComponent(s)}`)).hits as any[];

    const tg = await q('telegram');
    assert.ok(tg.some((h) => h.kind === 'channel' && h.title === 'Klantenservice' && h.href === '#/m/channels/chb_1' && /Telegram/.test(h.subtitle)), 'adapter label finds the channel');
    assert.ok((await q('klantenserv')).some((h) => h.kind === 'channel'));

    const sk = await q('huisstijl');
    assert.deepEqual(sk.filter((h) => h.kind === 'skill').map((h) => h.href), ['#/m/skills/mine/skl_1'], 'description matches; drafts are not listed');

    assert.ok((await q('learn')).some((h) => h.kind === 'app' && h.href === '#/m/mcp/c/mcp_1'));
    const rt = await q('ochtend');
    assert.ok(rt.some((h) => h.kind === 'routine' && h.href === '#/m/routines/r/rtn_1' && /Assistent/.test(h.subtitle)));

    const files = await q('afspraken');
    const f = files.find((h) => h.kind === 'file' && h.title === 'afspraken.md');
    assert.ok(f, JSON.stringify(files));
    assert.equal(f.href, '#/m/folders/team?root=0&path=klanten&open=afspraken.md');
    assert.ok(!files.some((h) => h.title === 'afspraken-pakket.js'), 'node_modules is skipped');
    assert.ok(!(await q('.env')).some((h) => h.kind === 'file'), 'secret files are never listed');
    const ws = (await q('offerte')).find((h) => h.kind === 'file');
    assert.ok(ws && ws.href.startsWith(`#/m/folders/${a.id}?root=0`) && /Assistent · werkmap/.test(ws.subtitle), JSON.stringify(ws));

    const msgs = await q('basispak');
    const m = msgs.find((h) => h.kind === 'message');
    assert.ok(m, 'prefix match while typing');
    assert.equal(m.id, msg.id);
    assert.equal(m.href, `#/t/${th.id}`);
    assert.match(m.snippet, /\[basispakket\]/);

    const mem = (await q('koffie')).filter((h) => h.kind === 'memory');
    assert.equal(mem.length, 1);
    assert.equal(mem[0].title, 'Ronald drinkt zijn koffie zwart');
    assert.match(mem[0].href, /^#\/m\/memory\/item\/mem_/);
    assert.match(mem[0].snippet, /\[koffie\]/);

    // Too short or odd input: no error, no hits.
    assert.deepEqual(await q('k'), []);
    assert.ok(Array.isArray(await q('"(*')));

    // Another user sees none of this.
    const b = t.app.ctx.auth.createUser({ name: 'Ander', email: 'ander@example.com', password: 'wachtwoord1' });
    const tokB = t.app.ctx.auth.createSession(b.id, 'web', 'B').token;
    const rB = await fetch(`${t.app.url}/api/search/all?q=telegram`, { headers: { authorization: `Bearer ${tokB}` } }).then((r) => r.json() as Promise<any>);
    assert.deepEqual(rB.hits, []);

    // A paired phone may search, but only sources it may open. Since 0.4.1 that is everything except the computer-only
    // list (server/modules/mobile/policy.ts): files (the Files page, read-only) and memory (the Geheugen page) too.
    const tokP = t.app.ctx.auth.createSession(owner.id, 'device', 'Telefoon').token;
    const rP = await fetch(`${t.app.url}/api/search/all?q=afspraken`, { headers: { authorization: `Bearer ${tokP}` } });
    assert.equal(rP.status, 200);
    const pHits = ((await rP.json()) as any).hits as any[];
    assert.deepEqual(pHits.filter((h) => h.kind === 'file').map((h) => h.title), files.filter((h: any) => h.kind === 'file').map((h: any) => h.title), 'the same file names as on the computer');
    const pMem = await fetch(`${t.app.url}/api/search/all?q=koffie`, { headers: { authorization: `Bearer ${tokP}` } }).then((r) => r.json() as Promise<any>);
    assert.ok(pMem.hits.some((h: any) => h.kind === 'memory'), 'memory is searchable on the phone (the Geheugen page works there)');
    const policy = t.app.ctx.services.mobile.instance.policy;
    assert.equal(policy.allows('GET', '/memory/items'), true);
    assert.equal(policy.allows('GET', '/secrets'), false, 'a computer-only route stays out of a search on the phone');
    const pMsg = await fetch(`${t.app.url}/api/search/all?q=basispakket`, { headers: { authorization: `Bearer ${tokP}` } }).then((r) => r.json() as Promise<any>);
    assert.ok(pMsg.hits.some((h: any) => h.kind === 'message'), 'messages are searchable on the phone');
  } finally {
    await t.close();
  }
});
