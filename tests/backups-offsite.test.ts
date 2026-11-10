import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { createApp } from '../server/app.js';
import backups from '../server/modules/backups/index.js';
import { readEncrypted, readHeader, writeEncrypted } from '../server/modules/backups/offsite.js';

/** Backups to a second place, encrypted (AES-256-GCM, key from the owner's password with scrypt), and back. */

const write = (f: string, s: string | Buffer) => (fs.mkdirSync(path.dirname(f), { recursive: true }), fs.writeFileSync(f, s));
const tmp = (p: string) => fs.mkdtempSync(path.join(os.tmpdir(), p));

test('encrypted file: everything of a set comes back; a wrong password or a changed byte leaves nothing behind', async () => {
  const src = tmp('tb-off-src-');
  const dst = tmp('tb-off-dst-');
  const out = tmp('tb-off-out-');
  try {
    const name = 'teambot-20261109-120000.db';
    write(path.join(src, name), Buffer.from('SQLite format 3\0 geheime inhoud: appelflap'));
    write(path.join(src, 'teambot-20261109-120000.json'), '{"format":1}');
    write(path.join(src, 'teambot-20261109-120000.teamdata', 'u_x.db'), 'team');
    write(path.join(src, 'teambot-20261109-120000.files', 'attachments', 'u', 'brief.txt'), 'Beste Mo');
    write(path.join(src, 'teambot-20261109-120000.files', 'leeg.txt'), '');
    write(path.join(src, 'teambot-20261109-120000.files', 'groot.bin'), Buffer.alloc(3 * 1024 * 1024, 7));
    // Another set next to it is not taken along.
    write(path.join(src, 'teambot-20261108-120000.db'), 'ander');
    const file = path.join(dst, 'teambot-20261109-120000.teambotbackup');
    const bytes = await writeEncrypted(src, name, file, 'correct paard batterij', { version: '0.4.4', createdAt: '2026-11-09T12:00:00.000Z' });
    assert.ok(bytes > 0 && bytes < 3 * 1024 * 1024, 'compressed');
    const raw = fs.readFileSync(file);
    assert.ok(!raw.includes(Buffer.from('appelflap')) && !raw.includes(Buffer.from('Beste Mo')), 'no plain text in the file');
    // The header says what it is, without the password.
    const h = readHeader(file).header;
    assert.deepEqual([h.name, h.version, h.kdf.alg], [name, '0.4.4', 'scrypt']);

    await assert.rejects(readEncrypted(file, 'verkeerd wachtwoord!', out), /Het wachtwoord klopt niet/);
    assert.deepEqual(fs.readdirSync(out), [], 'nothing written with a wrong password');
    const broken = path.join(dst, 'kapot.teambotbackup');
    const b2 = Buffer.from(raw);
    b2[b2.length - 40] ^= 1;
    fs.writeFileSync(broken, b2);
    await assert.rejects(readEncrypted(broken, 'correct paard batterij', out), /Het wachtwoord klopt niet, of het bestand is beschadigd/);
    assert.deepEqual(fs.readdirSync(out), []);

    assert.equal(await readEncrypted(file, 'correct paard batterij', out), name);
    assert.equal(fs.readFileSync(path.join(out, name), 'utf8'), 'SQLite format 3\0 geheime inhoud: appelflap');
    assert.equal(fs.readFileSync(path.join(out, 'teambot-20261109-120000.files', 'attachments', 'u', 'brief.txt'), 'utf8'), 'Beste Mo');
    assert.equal(fs.readFileSync(path.join(out, 'teambot-20261109-120000.files', 'leeg.txt'), 'utf8'), '');
    assert.equal(fs.statSync(path.join(out, 'teambot-20261109-120000.files', 'groot.bin')).size, 3 * 1024 * 1024);
    assert.equal(fs.readFileSync(path.join(out, 'teambot-20261109-120000.teamdata', 'u_x.db'), 'utf8'), 'team');
    assert.ok(!fs.existsSync(path.join(out, 'teambot-20261108-120000.db')));
    assert.ok(!fs.readdirSync(out).some((f) => f.startsWith('.import-')), 'temporary folder cleaned up');
  } finally {
    for (const d of [src, dst, out]) fs.rmSync(d, { recursive: true, force: true });
  }
});

test('second place: set up, copy after every backup, lost disk → import with the password → restore works', async () => {
  const t = await startTestApp({ modules: [backups] });
  const usb = tmp('tb-usb-');
  const dir = t.dir;
  let agentId = '';
  try {
    const a = await t.agent({ name: 'Voor back-up' });
    agentId = a.id;
    // Honest refusals.
    await assert.rejects(t.api('PUT', '/backups/offsite', { folder: path.join(dir, 'backups') }), /buiten de map van TeamBot/);
    await assert.rejects(t.api('PUT', '/backups/offsite', { folder: path.join(usb, 'bestaat-niet') }), /bestaat niet/);
    await assert.rejects(t.api('PUT', '/backups/offsite', { folder: 'relatief\\pad' }), /volledige pad/);
    await assert.rejects(t.api('PUT', '/backups/offsite', { password: 'kort' }), /minstens 12 tekens/);
    await assert.rejects(t.api('POST', '/backups/offsite/copy', {}), /Kies eerst een map/);
    const v = await t.api('PUT', '/backups/offsite', { folder: usb, password: 'mijn lange wachtwoord' });
    assert.deepEqual([v.folder, v.auto, v.hasPassword, v.reachable], [path.resolve(usb), true, true, true]);
    assert.ok(!JSON.stringify(v).includes('mijn lange wachtwoord'), 'the password never comes back');
    assert.ok(!fs.readFileSync(path.join(dir, 'backups', 'offsite.json'), 'utf8').includes('mijn lange wachtwoord'));

    // A backup → automatically an encrypted copy on the second place.
    const b = (await t.api('POST', '/backups', { wait: true })).backup;
    let files: any[] = [];
    for (let i = 0; i < 100 && !files.length; i++) {
      await new Promise((r) => setTimeout(r, 100));
      files = (await t.api('GET', '/backups/offsite')).files;
    }
    assert.equal(files.length, 1);
    assert.equal(files[0].name, b.name);
    assert.ok(fs.existsSync(path.join(usb, 'TeamBot-backups', b.name.replace(/\.db$/, '.teambotbackup'))));
    assert.equal((await t.api('GET', '/backups')).offsite.lastCopy.backup, b.name);
    // "Nu een kopie maken" works too (same file again).
    const c = await t.api('POST', '/backups/offsite/copy', {});
    assert.equal(c.backup, b.name);

    // The disk of this computer breaks: the local backup is gone, the data changed.
    await t.api('PATCH', `/agents/${a.id}`, { name: 'Na back-up' });
    await t.api('DELETE', `/backups/${b.name}`);
    assert.equal((await t.api('GET', '/backups')).items.length, 0);
    await assert.rejects(t.api('POST', '/backups/offsite/import', { file: files[0].file, password: 'niet het goede wachtwoord' }), /Het wachtwoord klopt niet/);
    assert.equal((await t.api('GET', '/backups')).items.length, 0, 'nothing appeared with a wrong password');
    const imp = await t.api('POST', '/backups/offsite/import', { file: files[0].file, password: 'mijn lange wachtwoord' });
    assert.equal(imp.backup.name, b.name);
    assert.equal((await t.api('GET', '/backups')).items[0].name, b.name);
    await t.api('POST', `/backups/${b.name}/restore`);
    await t.app.close();
  } catch (e) {
    await t.app.close().catch(() => {});
    fs.rmSync(usb, { recursive: true, force: true });
    throw e;
  }
  const app2 = await createApp({ dataDir: dir, port: 0, host: '127.0.0.1', mode: 'desktop', quiet: true, modules: [backups] });
  try {
    assert.equal(app2.ctx.store.agent(agentId)?.name, 'Voor back-up', 'restored from the encrypted copy');
  } finally {
    await app2.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(usb, { recursive: true, force: true });
  }
});
