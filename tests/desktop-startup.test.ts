// A start that fails is never silent (desktop/boot.ts, desktop/startup-errors.ts): the error is in
// <data>/logs/desktop.log and the owner reads what to do. Also: a module that cannot start is in the diagnostics.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DESKTOP_LOG, isDamagedInstall, recordCrash, startFailureText } from '../desktop/startup-errors.js';
import { createApp } from '../server/app.js';
import { modules } from '../server/modules/index.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tb-startup-'));

test('a missing file or dependency is a damaged install; a database error is a failed start', () => {
  assert.equal(isDamagedInstall(Object.assign(new Error("Cannot find package 'express' imported from main.js"), { code: 'ERR_MODULE_NOT_FOUND' })), true);
  assert.equal(isDamagedInstall(new SyntaxError('Unexpected end of input')), true);
  assert.equal(isDamagedInstall(new Error('Cannot find module C:\\app\\dist\\desktop\\shell.js')), true);
  assert.equal(isDamagedInstall(new Error('database disk image is malformed')), false);
  assert.equal(isDamagedInstall(Object.assign(new Error('listen EADDRINUSE'), { code: 'EADDRINUSE' })), false);
});

test('the log gets the whole error, and stays small', () => {
  const dir = path.join(tmp(), 'logs');
  const file = recordCrash(dir, 'START', new Error('database disk image is malformed'), new Date('2026-11-09T10:00:00Z'));
  assert.equal(file, path.join(dir, DESKTOP_LOG));
  const text = fs.readFileSync(file!, 'utf8');
  assert.match(text, /^2026-11-09T10:00:00\.000Z START Error: database disk image is malformed\n\s+at /);
  fs.writeFileSync(file!, 'x'.repeat(60) + '\n' + 'oud\n'.repeat(300_000));
  recordCrash(dir, 'ERROR', 'kort');
  const after = fs.readFileSync(file!, 'utf8');
  assert.ok(after.length < 700_000, `halved: ${after.length}`);
  assert.match(after, / ERROR kort\n$/);
  // A folder that cannot be written: no exception on top of the one being reported.
  const blocked = path.join(tmp(), 'bestand');
  fs.writeFileSync(blocked, '');
  assert.equal(recordCrash(path.join(blocked, 'logs'), 'START', new Error('x')), null);
});

test('what the owner reads: what to do, the first line of the error, where the log is', () => {
  const damaged = startFailureText(Object.assign(new Error("Cannot find package 'ws'"), { code: 'ERR_MODULE_NOT_FOUND' }), { damaged: true, logFile: 'C:\\data\\logs\\desktop.log' });
  assert.equal(damaged.title, 'TeamBot kon niet starten');
  assert.match(damaged.message, /beschadigd of onvolledig.*Installeer TeamBot opnieuw; je gegevens blijven bewaard/);
  assert.match(damaged.detail, /^Error: Cannot find package 'ws'\n\n.*C:\\data\\logs\\desktop\.log$/);
  assert.doesNotMatch(damaged.detail, /\n\s+at /, 'no stack trace in the message');
  assert.deepEqual(damaged.buttons, ['Opnieuw proberen', 'Logboek openen', 'Afsluiten']);
  const plain = startFailureText(new Error('database disk image is malformed'), { damaged: false, logFile: null }, (s) => `[${s}]`);
  assert.equal(plain.message, '[Er ging iets mis bij het starten van TeamBot.]');
  assert.deepEqual(plain.buttons, ['[Opnieuw proberen]', '[Afsluiten]'], 'no log, no button for it');
});

test('a module that cannot start does not stop the others and is named in the diagnostics', async () => {
  const dataDir = tmp();
  const broken = { id: 'kapot', label: 'Kapot', init: () => Promise.reject(new Error('tabel ontbreekt')) };
  const app = await createApp({ dataDir, mode: 'desktop', listen: false, quiet: true, modules: [broken as any, ...modules.filter((m) => m.id === 'usage')] });
  try {
    assert.deepEqual(app.ctx.services.startupProblems, [{ module: 'kapot', phase: 'init', error: 'tabel ontbreekt' }]);
    assert.ok(app.ctx.services.usage, 'the next module started');
    assert.match(fs.readFileSync(path.join(dataDir, 'logs', 'server.log'), 'utf8'), /\[module kapot\] init failed/);
  } finally {
    await app.close();
  }
});
