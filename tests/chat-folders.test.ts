import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp, type TestApp } from './helpers.js';

/**
 * PARITEIT 4.2: folders for chats, per team. A folder belongs to one team; a bot or group only goes into a folder of
 * its own team; deleting a folder puts its chats back in the list; another user cannot see or touch your folders.
 */

async function member(t: TestApp, name: string) {
  const auth = t.app.ctx.auth;
  const u = auth.createUser({ name, email: `${name.toLowerCase()}@test.local`, password: 'geheim1234', role: 'member' });
  const tok = auth.createSession(u.id, 'web', 'x').token;
  return async (method: string, p: string, body?: any) => {
    const r = await fetch(`${t.app.url}/api${p}`, { method, headers: { authorization: `Bearer ${tok}`, 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, body: (await r.json().catch(() => ({}))) as any };
  };
}

test('chat folders: create, rename, move in and out, collapse, delete keeps the chats', async () => {
  const t = await startTestApp();
  try {
    const owner = t.app.ctx.auth.owner()!;
    const events: string[] = [];
    t.app.ctx.events.subscribe((e) => e.userId === owner.id && e.type === 'chatFolders.changed' && events.push(e.type));
    const ada = await t.agent({ name: 'Ada' });
    const bas = await t.agent({ name: 'Bas' });
    const empty = await t.api('GET', '/chat-folders');
    assert.deepEqual(empty.folders, []);

    await assert.rejects(t.api('POST', '/chat-folders', { name: '   ' }), /naam/);
    // "Nieuwe map…" from "Verplaats naar map": the chat moves in at once.
    const klanten = await t.api('POST', '/chat-folders', { name: 'Klanten', item: { kind: 'agent', id: ada.id } });
    assert.equal(klanten.name, 'Klanten');
    assert.deepEqual(klanten.items, [{ kind: 'agent', id: ada.id }]);
    assert.ok(klanten.teamId, 'the folder belongs to the bot’s team');
    await assert.rejects(t.api('POST', '/chat-folders', { name: 'klanten' }), /al een map/);

    const werk = await t.api('POST', '/chat-folders', { name: 'Werk' });
    assert.equal(werk.teamId, klanten.teamId, 'without a chat: the default team');
    await t.api('PUT', '/chat-folders/items', { kind: 'agent', id: bas.id, folderId: werk.id });
    // A chat is in one folder at a time: moving Ada to Werk takes her out of Klanten.
    await t.api('PUT', '/chat-folders/items', { kind: 'agent', id: ada.id, folderId: werk.id });
    let list = (await t.api('GET', '/chat-folders')).folders;
    assert.deepEqual(list.map((f: any) => [f.name, f.items.length]), [['Klanten', 0], ['Werk', 2]]);

    const renamed = await t.api('PATCH', `/chat-folders/${werk.id}`, { name: 'Werk 2026', collapsed: true });
    assert.equal(renamed.name, 'Werk 2026');
    assert.equal(renamed.collapsed, true, 'collapsed is remembered on the server (every device)');
    await assert.rejects(t.api('PATCH', `/chat-folders/${werk.id}`, { name: 'Klanten' }), /al een map/);

    // Out of the folder.
    await t.api('PUT', '/chat-folders/items', { kind: 'agent', id: bas.id, folderId: null });
    list = (await t.api('GET', '/chat-folders')).folders;
    assert.deepEqual(list.find((f: any) => f.id === werk.id).items, [{ kind: 'agent', id: ada.id }]);

    // A group goes into a folder too.
    const room = await t.api('POST', '/rooms', { name: 'Overleg', agentIds: [ada.id, bas.id] });
    const roomId = room.room.id;
    await t.api('PUT', '/chat-folders/items', { kind: 'room', id: roomId, folderId: klanten.id });
    list = (await t.api('GET', '/chat-folders')).folders;
    assert.deepEqual(list.find((f: any) => f.id === klanten.id).items, [{ kind: 'room', id: roomId }]);

    // Deleting a folder deletes no chat: the bot and the group are still there and back in the list.
    await t.api('DELETE', `/chat-folders/${werk.id}`);
    await t.api('DELETE', `/chat-folders/${klanten.id}`);
    assert.deepEqual((await t.api('GET', '/chat-folders')).folders, []);
    assert.ok(t.app.ctx.store.agent(ada.id));
    assert.ok(t.app.ctx.store.get('rooms', roomId));
    assert.equal(t.app.ctx.store.all('SELECT * FROM chat_folder_items').length, 0);

    // A deleted bot leaves its folder.
    const f = await t.api('POST', '/chat-folders', { name: 'Tijdelijk', item: { kind: 'agent', id: bas.id } });
    await t.api('DELETE', `/agents/${bas.id}`);
    list = (await t.api('GET', '/chat-folders')).folders;
    assert.deepEqual(list.find((x: any) => x.id === f.id).items, []);
    assert.ok(events.length >= 8, 'every change is sent live to the other windows and the phone');
  } finally {
    await t.close();
  }
});

test('chat folders per team: a chat only goes into a folder of its own team; a removed team takes its folders along', async () => {
  const t = await startTestApp();
  try {
    const ada = await t.agent({ name: 'Ada' });
    const teams = await t.api('GET', '/teams');
    const home = teams[0];
    const sales = await t.api('POST', '/teams', { name: 'Verkoop' });
    const vera = await t.agent({ name: 'Vera' });
    await t.api('PUT', `/teams/${sales.id}/bots/${vera.id}`);

    const inSales = await t.api('POST', '/chat-folders', { name: 'Offertes', item: { kind: 'agent', id: vera.id } });
    assert.equal(inSales.teamId, sales.id);
    const inHome = await t.api('POST', '/chat-folders', { name: 'Offertes', teamId: home.id });
    assert.equal(inHome.teamId, home.id, 'the same name in another team is fine');
    await assert.rejects(t.api('PUT', '/chat-folders/items', { kind: 'agent', id: ada.id, folderId: inSales.id }), /ander team/);
    // The chat decides the team of a folder made for it, not the team in view.
    const mix = await t.api('POST', '/chat-folders', { name: 'Mix', teamId: home.id, item: { kind: 'agent', id: vera.id } });
    assert.equal(mix.teamId, sales.id);
    await assert.rejects(t.api('POST', '/chat-folders', { name: 'Vreemd', teamId: 'tm_nietvanmij' }), /Team niet gevonden/);

    // A bot that moves to another home team leaves the folder of its old team.
    await t.api('PUT', '/chat-folders/items', { kind: 'agent', id: ada.id, folderId: inHome.id });
    await t.api('PUT', `/teams/${sales.id}/bots/${ada.id}`);
    let list = (await t.api('GET', '/chat-folders')).folders;
    assert.deepEqual(list.find((f: any) => f.id === inHome.id).items, []);

    // Removing a team: its folders go, its chats are not touched.
    await t.api('PUT', `/teams/${home.id}/bots/${ada.id}`);
    await t.api('PUT', `/teams/${home.id}/bots/${vera.id}`);
    await t.api('DELETE', `/teams/${sales.id}`);
    list = (await t.api('GET', '/chat-folders')).folders;
    assert.deepEqual(list.map((f: any) => f.id), [inHome.id], 'Offertes and Mix of Verkoop are gone');
    assert.ok(t.app.ctx.store.agent(vera.id));
  } finally {
    await t.close();
  }
});

test('chat folders: another user cannot see, change or fill your folders, nor file your chats', async () => {
  const t = await startTestApp({ mode: 'server' });
  try {
    const ada = await t.agent({ name: 'Ada' });
    const mine = await t.api('POST', '/chat-folders', { name: 'Privé', item: { kind: 'agent', id: ada.id } });
    const lisa = await member(t, 'Lisa');
    assert.deepEqual((await lisa('GET', '/chat-folders')).body.folders, []);
    assert.equal((await lisa('PATCH', `/chat-folders/${mine.id}`, { name: 'Van Lisa' })).status, 404);
    assert.equal((await lisa('DELETE', `/chat-folders/${mine.id}`)).status, 404);
    assert.equal((await lisa('PUT', '/chat-folders/items', { kind: 'agent', id: ada.id, folderId: null })).status, 404, 'not her chat');
    const hers = await lisa('POST', '/chat-folders', { name: 'Lisa' });
    assert.equal(hers.status, 200);
    assert.equal((await lisa('PUT', '/chat-folders/items', { kind: 'agent', id: ada.id, folderId: hers.body.id })).status, 404);
    assert.equal((await lisa('POST', '/chat-folders', { name: 'Stiekem', item: { kind: 'agent', id: ada.id } })).status, 404);
    const list = (await t.api('GET', '/chat-folders')).folders;
    assert.deepEqual(list.map((f: any) => [f.name, f.items.length]), [['Privé', 1]]);
    assert.equal((await lisa('PUT', '/chat-folders/items', { kind: 'thread', id: 'x', folderId: null })).status, 400);
  } finally {
    await t.close();
  }
});
