// Prullenbak and run snapshots (plan 0.4 §G): a file a bot deletes or overwrites comes back with one click; a run's
// changes can be put back as a whole; a bot never deletes a file for good without its own approval card.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp, type TestApp } from './helpers.js';
import { createFoldersModule } from '../server/modules/folders/index.js';
import { Trash } from '../server/modules/folders/trash.js';

async function say(t: TestApp, threadId: string, content: string, approve?: 'approve' | 'deny') {
  await t.api('POST', `/threads/${threadId}/messages`, { content });
  for (let i = 0; i < 400; i++) {
    if (approve) for (const ap of await t.api('GET', '/approvals')) if (ap.status === 'pending') await t.api('POST', `/approvals/${ap.id}`, { decision: approve });
    if (!t.app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId).length && i > 2) break;
    await new Promise((r) => setTimeout(r, 25));
  }
  return t.app.ctx.store.messages(threadId);
}

const toolTexts = (msgs: any[]) => msgs.filter((m) => m.role === 'tool').map((m) => m.content as string);
const lastRunId = (t: TestApp, threadId: string) => t.app.ctx.store.one<{ id: string }>('SELECT id FROM runs WHERE thread_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1', threadId)!.id;

test('a file a bot deletes goes to the Prullenbak and comes back with one click (no card in Automatisch)', async () => {
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const a = await t.agent({ tool_groups: ['files'], access_mode: 'auto' });
    const file = path.join(a.workspace, 'offerte.md');
    fs.mkdirSync(a.workspace, { recursive: true });
    fs.writeFileSync(file, '# Offerte\nPrijs: 1200 euro\n');
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'delete_file', args: { path: 'offerte.md' } }] }, { text: 'Opgeruimd.' });
    const msgs = await say(t, th.id, 'ruim offerte.md op');
    assert.match(toolTexts(msgs)[0], /^Naar de prullenbak: offerte\.md\. De gebruiker kan het 30 dagen lang terughalen/);
    assert.equal(fs.existsSync(file), false, 'gone from the folder');
    assert.equal((await t.api('GET', '/approvals?status=all')).length, 0, 'reversible: no card in Automatisch');
    const tool = t.app.ctx.store.one<any>("SELECT data FROM audit WHERE kind = 'tool.call' ORDER BY id DESC LIMIT 1");
    assert.equal(JSON.parse(tool.data).risk, 'write', 'a delete into the trash is a normal change, not a danger action');

    const list = await t.api('GET', '/folders/trash');
    assert.equal(list.items.length, 1);
    const e = list.items[0];
    assert.equal(e.kind, 'deleted');
    assert.equal(e.rel, 'offerte.md');
    assert.equal(e.agent_name, 'Testbot');
    assert.equal(e.has_copy, true);
    assert.ok(Date.parse(e.expires_at) - Date.parse(e.created_at) >= 29 * 86_400_000, 'kept 30 days');
    assert.ok(list.usage.bytes > 0 && list.usage.maxBytes === 2 * 1024 ** 3);

    const r = await t.api('POST', `/folders/trash/${e.id}/restore`, {});
    assert.equal(r.ok, true);
    assert.equal(fs.readFileSync(file, 'utf8'), '# Offerte\nPrijs: 1200 euro\n', 'the same content is back');
    assert.equal((await t.api('GET', '/folders/trash')).items.length, 0, 'restored entries leave the list');
    assert.ok(t.app.ctx.store.one("SELECT id FROM audit WHERE kind = 'trash.restored'"));
  } finally {
    await t.close();
  }
});

test('in Vraagt toestemming the card says where the file goes: the Prullenbak', async () => {
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const a = await t.agent({ tool_groups: ['files'], access_mode: 'ask' });
    fs.mkdirSync(a.workspace, { recursive: true });
    fs.writeFileSync(path.join(a.workspace, 'oud.txt'), 'oud');
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'delete_file', args: { path: 'oud.txt' } }] }, { text: 'ok' });
    await say(t, th.id, 'weg ermee', 'approve');
    const cards = await t.api('GET', '/approvals?status=all');
    assert.equal(cards.length, 1);
    assert.equal(cards[0].summary, 'Naar de prullenbak: oud.txt');
    assert.equal(cards[0].risk, 'write');
    assert.equal((await t.api('GET', '/folders/trash')).items.length, 1);
  } finally {
    await t.close();
  }
});

test('an overwritten file keeps its version from before the run; restoring puts the current one in the trash first', async () => {
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const a = await t.agent({ tool_groups: ['files'], access_mode: 'auto' });
    const file = path.join(a.workspace, 'notities.md');
    fs.mkdirSync(a.workspace, { recursive: true });
    fs.writeFileSync(file, 'versie 1');
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push(
      { toolCalls: [{ name: 'write_file', args: { path: 'notities.md', content: 'versie 2' } }] },
      { toolCalls: [{ name: 'edit_file', args: { path: 'notities.md', old_text: 'versie 2', new_text: 'versie 3' } }] },
      { text: 'Bijgewerkt.' },
    );
    const msgs = await say(t, th.id, 'werk notities bij');
    assert.match(toolTexts(msgs)[0], /De vorige versie staat in de prullenbak\.$/);
    assert.equal(fs.readFileSync(file, 'utf8'), 'versie 3');
    const items = (await t.api('GET', '/folders/trash')).items;
    assert.equal(items.length, 1, 'once per run: the version from before the run');
    assert.equal(items[0].kind, 'overwritten');
    await t.api('POST', `/folders/trash/${items[0].id}/restore`, {});
    assert.equal(fs.readFileSync(file, 'utf8'), 'versie 1');
    const after = (await t.api('GET', '/folders/trash')).items;
    assert.equal(after.length, 1, 'the version that was there (versie 3) is in the trash now');
    await t.api('POST', `/folders/trash/${after[0].id}/restore`, {});
    assert.equal(fs.readFileSync(file, 'utf8'), 'versie 3', 'and can come back too: nothing is ever lost');
  } finally {
    await t.close();
  }
});

test('snapshot of a run: only the files it touched, restorable with one click (edited, overwritten, new, deleted)', async () => {
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const a = await t.agent({ tool_groups: ['files'], access_mode: 'auto' });
    const ws = a.workspace;
    fs.mkdirSync(path.join(ws, 'sub'), { recursive: true });
    fs.writeFileSync(path.join(ws, 'a.txt'), 'A-origineel');
    fs.writeFileSync(path.join(ws, 'b.txt'), 'B-origineel');
    fs.writeFileSync(path.join(ws, 'sub', 'd.txt'), 'D-origineel');
    fs.writeFileSync(path.join(ws, 'blijft.txt'), 'niet aangeraakt');
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push(
      { toolCalls: [{ name: 'edit_file', args: { path: 'a.txt', old_text: 'origineel', new_text: 'gewijzigd' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'b.txt', content: 'B-nieuw' } }] },
      { toolCalls: [{ name: 'write_file', args: { path: 'c.txt', content: 'C-nieuw' } }] },
      { toolCalls: [{ name: 'delete_file', args: { path: 'sub/d.txt' } }] },
      { text: 'Alles aangepast.' },
    );
    await say(t, th.id, 'pas alles aan');
    const runId = lastRunId(t, th.id);
    const snap = await t.api('GET', `/folders/trash/runs/${runId}`);
    assert.deepEqual(snap.changes.map((c: any) => [c.rel, c.kind]).sort(), [['a.txt', 'overwritten'], ['b.txt', 'overwritten'], ['c.txt', 'created'], ['sub/d.txt', 'deleted']]);
    assert.ok(snap.changes.every((c: any) => c.restorable));
    // The owner changes something else meanwhile: restoring the run leaves it alone.
    fs.writeFileSync(path.join(ws, 'blijft.txt'), 'door de eigenaar aangepast');

    const r = await t.api('POST', `/folders/trash/runs/${runId}/restore`, {});
    assert.equal(r.failed.length, 0, JSON.stringify(r.failed));
    assert.equal(r.restored.length, 4);
    assert.equal(fs.readFileSync(path.join(ws, 'a.txt'), 'utf8'), 'A-origineel');
    assert.equal(fs.readFileSync(path.join(ws, 'b.txt'), 'utf8'), 'B-origineel');
    assert.equal(fs.existsSync(path.join(ws, 'c.txt')), false, 'the new file is taken away …');
    assert.ok((await t.api('GET', '/folders/trash')).items.some((e: any) => e.rel === 'c.txt' && e.kind === 'deleted'), '… into the trash, not gone');
    assert.equal(fs.readFileSync(path.join(ws, 'sub', 'd.txt'), 'utf8'), 'D-origineel');
    assert.equal(fs.readFileSync(path.join(ws, 'blijft.txt'), 'utf8'), 'door de eigenaar aangepast');
    const again = await t.api('GET', `/folders/trash/runs/${runId}`);
    assert.ok(again.changes.every((c: any) => c.restored), 'the snapshot says it was put back');
  } finally {
    await t.close();
  }
});

test('a file too big for the trash is never deleted without its own approval card (also in Volledige toegang)', async () => {
  const t = await startTestApp({ modules: [createFoldersModule({ trash: { maxFile: 1024 } })] });
  try {
    const a = await t.agent({ tool_groups: ['files'], access_mode: 'full' });
    fs.mkdirSync(a.workspace, { recursive: true });
    const big = path.join(a.workspace, 'groot.bin');
    fs.writeFileSync(big, Buffer.alloc(4096, 1));
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'delete_file', args: { path: 'groot.bin' } }] }, { text: 'ok' });
    let msgs = await say(t, th.id, 'verwijder groot.bin', 'deny');
    assert.match(toolTexts(msgs).at(-1)!, /^Niet verwijderd: Dit bestand is te groot voor de prullenbak .*Definitief verwijderen mocht niet\./);
    assert.ok(fs.existsSync(big), 'the owner said no: the file stays');
    const card = (await t.api('GET', '/approvals?status=all'))[0];
    assert.equal(card.tool, 'delete_file:definitief');
    assert.equal(card.risk, 'danger');
    assert.match(card.summary, /^DEFINITIEF VERWIJDEREN \(past niet in de prullenbak, terughalen kan niet\): /);

    t.script.push({ toolCalls: [{ name: 'delete_file', args: { path: 'groot.bin' } }] }, { text: 'ok' });
    msgs = await say(t, th.id, 'toch verwijderen', 'approve');
    assert.match(toolTexts(msgs).at(-1)!, /^Definitief verwijderd: groot\.bin/);
    assert.equal(fs.existsSync(big), false);
  } finally {
    await t.close();
  }
});

test('retention and size cap: old entries expire, the oldest go first when the trash is full; purge and empty', async () => {
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const a = await t.agent({ tool_groups: ['files'] });
    const agent = t.app.ctx.store.agent(a.id)!;
    fs.mkdirSync(agent.workspace, { recursive: true });
    const trash = new Trash(t.app.ctx, { maxBytes: 250, maxFile: 200, days: 30 });
    const put = (name: string, size: number) => {
      const f = path.join(agent.workspace, name);
      fs.writeFileSync(f, Buffer.alloc(size, 65));
      return trash.moveToTrash({ agent, file: f, source: 'test' });
    };
    assert.equal(put('een.txt', 100).kept, true);
    assert.equal(put('twee.txt', 100).kept, true);
    assert.equal(put('drie.txt', 100).kept, true, 'room is made …');
    const names = () => trash.list(a.user_id).map((e) => e.rel).sort();
    assert.deepEqual(names(), ['drie.txt', 'twee.txt'], '… by dropping the oldest');
    assert.equal(put('reus.txt', 300).kept, false, 'bigger than the per-file limit: not taken');
    assert.ok(fs.existsSync(path.join(agent.workspace, 'reus.txt')), 'and not deleted either');
    // An entry past its 30 days goes, with its copy.
    const old = trash.list(a.user_id).find((e) => e.rel === 'twee.txt')!;
    t.app.ctx.store.update('folder_trash', old.id, { expires_at: new Date(Date.now() - 1000).toISOString() });
    assert.equal(trash.cleanup(), 1);
    assert.deepEqual(names(), ['drie.txt']);
    assert.equal(trash.blobPath(old), null);
    const last = trash.list(a.user_id)[0];
    assert.ok(trash.blobPath(last));
    assert.equal(trash.purge(a.user_id, last.id), true);
    assert.equal(trash.blobPath(last), null);
    put('vier.txt', 50);
    assert.equal(trash.empty(a.user_id), 1);
    assert.equal(trash.list(a.user_id).length, 0);
  } finally {
    await t.close();
  }
});

test('trash routes: only your own entries; download serves the kept copy as a file', async () => {
  const t = await startTestApp({ modules: [createFoldersModule()] });
  try {
    const a = await t.agent({ tool_groups: ['files'], access_mode: 'auto' });
    fs.mkdirSync(a.workspace, { recursive: true });
    fs.writeFileSync(path.join(a.workspace, 'x.html'), '<script>alert(1)</script>');
    const th = await t.api('POST', '/threads', { agentId: a.id });
    t.script.push({ toolCalls: [{ name: 'delete_file', args: { path: 'x.html' } }] }, { text: 'ok' });
    await say(t, th.id, 'weg');
    const e = (await t.api('GET', '/folders/trash')).items[0];
    const res = await fetch(`${t.app.url}${t.signed(`/api/folders/trash/${e.id}/raw`)}`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-disposition') || '', /^attachment/);
    assert.match(res.headers.get('content-security-policy') || '', /sandbox/);
    assert.equal(await res.text(), '<script>alert(1)</script>');
    await assert.rejects(t.api('POST', '/folders/trash/trs_bestaatniet/restore', {}), /404/);
    // Someone else's entry is not found for this user.
    t.app.ctx.store.update('folder_trash', e.id, { user_id: 'usr_ander' });
    await assert.rejects(t.api('POST', `/folders/trash/${e.id}/restore`, {}), /404/);
    await assert.rejects(t.api('DELETE', `/folders/trash/${e.id}`), /404/);
  } finally {
    await t.close();
  }
});
