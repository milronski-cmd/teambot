import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { linuxBackendIsSecure, loadProtectedKey, type KeyProtector } from '../desktop/keystore.js';

// SEC-07: the same never-lock-out logic for DPAPI (Windows), Keychain (macOS) and the Linux secret service.
const wrap = crypto.randomBytes(32);
const fake = (name = 'keychain'): KeyProtector => ({
  name,
  protect: (d) => Buffer.concat([Buffer.from('TB1'), Buffer.from(d.map((b, i) => b ^ wrap[i % 32]))]),
  unprotect: (b) => {
    if (b.subarray(0, 3).toString() !== 'TB1') throw new Error('kluis weigert');
    return Buffer.from(b.subarray(3).map((x, i) => x ^ wrap[i % 32]));
  },
});

test('master key: migrated from the plain file after a verified round-trip, then read from the OS store', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-key-'));
  try {
    const plainKey = crypto.randomBytes(32);
    fs.writeFileSync(path.join(dir, 'master.key'), plainKey.toString('base64'));
    const r1 = await loadProtectedKey(dir, fake(), {});
    assert.equal(r1.storage, 'protected');
    assert.ok(r1.key!.equals(plainKey), 'same key, so existing secrets stay readable');
    assert.equal(fs.existsSync(path.join(dir, 'master.key')), false, 'plain file removed after migration');
    assert.ok(fs.existsSync(path.join(dir, 'master.key.keychain')));
    assert.equal(fs.readFileSync(path.join(dir, 'master.key.keychain')).includes(plainKey), false, 'stored wrapped, not in clear');
    const r2 = await loadProtectedKey(dir, fake(), {});
    assert.ok(r2.key!.equals(plainKey));
    assert.equal(r2.warning, undefined);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('master key: an unreadable wrapped key never locks the user out; broken protector keeps the plain file', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-key-'));
  try {
    fs.writeFileSync(path.join(dir, 'master.key.keychain'), 'kapot');
    const r = await loadProtectedKey(dir, fake(), {});
    assert.equal(r.storage, 'protected');
    assert.equal(r.key!.length, 32);
    assert.match(r.warning!, /opnieuw invoeren/);
    assert.ok(fs.readdirSync(dir).some((f) => f.startsWith('master.key.keychain.onleesbaar-')), 'old file kept for recovery');

    // A protector whose round-trip fails: nothing is migrated, the plain key file stays the source of truth.
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-key-'));
    const plainKey = crypto.randomBytes(32);
    fs.writeFileSync(path.join(dir2, 'master.key'), plainKey.toString('base64'));
    const liar: KeyProtector = { name: 'secret-service', protect: (d) => d, unprotect: () => crypto.randomBytes(32) };
    const r2 = await loadProtectedKey(dir2, liar, {});
    assert.equal(r2.storage, 'plain-file');
    assert.equal(r2.key, undefined);
    assert.ok(fs.existsSync(path.join(dir2, 'master.key')));
    fs.rmSync(dir2, { recursive: true, force: true });

    // No protector (e.g. Linux without libsecret) or an explicit env key: leave it to the server.
    assert.equal((await loadProtectedKey(dir, null, {})).storage, 'plain-file');
    assert.equal((await loadProtectedKey(dir, fake(), { TEAMBOT_MASTER_KEY: 'x' })).storage, 'env');
    // Existing Windows installs keep their file name (master.key.dpapi).
    const r3 = await loadProtectedKey(dir, fake('dpapi'), {});
    assert.ok(fs.existsSync(path.join(dir, 'master.key.dpapi')) && r3.key);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('master key: a protector that answers later (DPAPI in its own PowerShell) works the same, also when it fails', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-key-'));
  try {
    const later = (f: (d: Buffer) => Buffer) => (d: Buffer) => new Promise<Buffer>((res, rej) => setTimeout(() => {
      try {
        res(f(d));
      } catch (e) {
        rej(e);
      }
    }, 5));
    const sync = fake('dpapi');
    const slow: KeyProtector = { name: 'dpapi', protect: later((d) => sync.protect(d) as Buffer), unprotect: later((d) => sync.unprotect(d) as Buffer) };
    const r1 = await loadProtectedKey(dir, slow, {});
    assert.equal(r1.storage, 'protected');
    const r2 = await loadProtectedKey(dir, slow, {});
    assert.ok(r2.key!.equals(r1.key!), 'the same key the next start');

    fs.writeFileSync(path.join(dir, 'master.key.dpapi'), 'kapot');
    const r3 = await loadProtectedKey(dir, slow, {});
    assert.equal(r3.key!.length, 32);
    assert.match(r3.warning!, /opnieuw invoeren/, 'a rejected promise is an unreadable key, never a crash');

    const dead: KeyProtector = { name: 'dpapi', protect: () => Promise.reject(new Error('powershell.exe ontbreekt')), unprotect: () => Promise.reject(new Error('x')) };
    const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-key-'));
    assert.equal((await loadProtectedKey(dir2, dead, {})).storage, 'plain-file', 'no protector right now: the plain 0600 file');
    fs.rmSync(dir2, { recursive: true, force: true });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('linux: only a real secret service counts, never the basic_text fallback', () => {
  assert.equal(linuxBackendIsSecure('gnome_libsecret'), true);
  assert.equal(linuxBackendIsSecure('kwallet5'), true);
  assert.equal(linuxBackendIsSecure('basic_text'), false);
  assert.equal(linuxBackendIsSecure('unknown'), false);
  assert.equal(linuxBackendIsSecure(undefined), false);
});
