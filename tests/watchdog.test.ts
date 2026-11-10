// 0.4.4 P14 "Gezondheid buiten de app": the server writes a heartbeat (server/modules/health/heartbeat.ts) and the real
// watchdog script (build/watchdog.ps1, Windows PowerShell 5.1) finds: runs and answers, hangs, down, stopped on purpose.
// Only a crash or a hang counts; it asks once per incident; never in the middle of a fullscreen program or game.
// The script runs with a temporary data folder and -NoPopup or -Answer: no window, and only a child process of this
// test is ever stopped. The owner's TeamBot is untouched.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { startTestApp } from './helpers.js';
import { markStopped, stoppedFile } from '../server/modules/health/heartbeat.js';

const root = path.resolve(import.meta.dirname, '..');
const script = path.join(root, 'build', 'watchdog.ps1');
const win = process.platform !== 'win32';

// Asynchronous: the server in this process must keep answering /healthz while the script asks.
async function watch(dataDir: string, args: string[] = ['-NoPopup']) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-watch-home-'));
  await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-DataDir', dataDir, '-ConfirmSeconds', '0', ...args], { env: { ...process.env, APPDATA: path.join(home, 'Roaming'), LOCALAPPDATA: path.join(home, 'Local') }, timeout: 60_000, windowsHide: true });
  return JSON.parse(fs.readFileSync(path.join(dataDir, 'health', 'watchdog.json'), 'utf8').replace(/^﻿/, ''));
}
const iso = (msAgo = 0) => new Date(Date.now() - msAgo).toISOString();

test('heartbeat: written at the start with pid, port and the owner choice; "stopped" on a normal quit', async () => {
  const t = await startTestApp();
  const file = path.join(t.dir, 'health', 'heartbeat.json');
  try {
    t.app.ctx.services.health.heartbeat().beat();
    const hb = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(hb.pid, process.pid);
    assert.equal(hb.port, Number(new URL(t.app.url).port));
    assert.equal(hb.notify, true);
    assert.equal(hb.stopped, false);
    // Only these facts: no keys, no names, no content.
    assert.deepEqual(Object.keys(hb).sort(), ['at', 'boot', 'exe', 'notify', 'pid', 'port', 'stopped', 'v', 'version']);
    assert.deepEqual(await t.api('PUT', '/health/watchdog', { notify: false }), { notify: false });
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).notify, false);
    const h = await t.api('GET', '/health');
    assert.equal(h.watchdog.notify, false);
    assert.equal(h.watchdog.finding, null, 'the watchdog never ran here');
    assert.equal(h.watchdog.task, 'none', "a test never looks at the owner's scheduled tasks");
  } finally {
    const dir = t.dir;
    await t.app.close();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).stopped, true);
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5 });
  }
});

test('watchdog script: ok while TeamBot answers (also with an old heartbeat after sleep), hang when it does not, down without the process', { skip: win }, async () => {
  const t = await startTestApp();
  const file = path.join(t.dir, 'health', 'heartbeat.json');
  try {
    t.app.ctx.services.health.heartbeat().beat();
    let f = await watch(t.dir);
    assert.equal(f.status, 'ok', JSON.stringify(f));
    assert.equal((await t.api('GET', '/health')).watchdog.finding.status, 'ok', 'the server shows what the watchdog found');

    const hb = JSON.parse(fs.readFileSync(file, 'utf8'));
    // From here the test writes the heartbeat itself (the server's own timer would overwrite it).
    t.app.ctx.services.health.heartbeat().stop();
    // The pc just woke up: the heartbeat is old, but TeamBot answers. Not a hang.
    fs.writeFileSync(file, JSON.stringify({ ...hb, at: iso(40 * 60_000) }));
    assert.equal((await watch(t.dir)).status, 'ok');
    // Runs, but does not answer (also not on the second try).
    fs.writeFileSync(file, JSON.stringify({ ...hb, port: 9 }));
    f = await watch(t.dir);
    assert.equal(f.status, 'hang');
    assert.equal(f.detail, 'TeamBot draait, maar antwoordt niet.');
    fs.writeFileSync(file, JSON.stringify({ ...hb, port: 9, at: iso(10 * 60_000) }));
    assert.equal((await watch(t.dir)).detail, 'TeamBot draait, maar de hartslag staat stil.');
    // The process is gone (a PID nobody has): down.
    fs.writeFileSync(file, JSON.stringify({ ...hb, pid: 4_000_000 }));
    f = await watch(t.dir);
    assert.equal(f.status, 'down');
    assert.equal(f.detail, 'Het programma draait niet meer.');
    assert.equal(f.since, hb.at);
    assert.equal(f.asked, false, '-NoPopup never asks');
  } finally {
    await t.close();
  }
});

test('deliberate stop is never a crash: Afsluiten, update, Windows shutting down, the installer, a restarted pc; the next start clears it', { skip: win }, async () => {
  const t = await startTestApp();
  const dir = t.dir;
  const file = path.join(dir, 'health', 'heartbeat.json');
  try {
    t.app.ctx.services.health.heartbeat().beat();
    const hb = JSON.parse(fs.readFileSync(file, 'utf8'));
    t.app.ctx.services.health.heartbeat().stop();
    // A crash: the process is gone and the heartbeat does not say stopped.
    const crashed = { ...hb, pid: 4_000_000, stopped: false };
    fs.writeFileSync(file, JSON.stringify(crashed));
    assert.equal((await watch(dir)).status, 'down');

    // The desktop app quits (before-quit) or Windows signs off (session-end): "bewust gestopt", then hard gone.
    for (const reason of ['quit', 'update', 'restart', 'shutdown'] as const) {
      t.app.ctx.services.health.markStopped(reason);
      assert.equal(JSON.parse(fs.readFileSync(stoppedFile(dir), 'utf8')).reason, reason);
      const f = await watch(dir, ['-Answer', 'Yes']);
      assert.equal(f.status, 'stopped', reason);
      assert.equal(f.asked, false, `${reason}: nothing asked`);
    }
    // The installer leaves the same marker before it closes TeamBot (build/installer.nsh customInit, its exact text).
    const nsh = fs.readFileSync(path.join(root, 'build', 'installer.nsh'), 'utf8');
    const written = /FileWrite \$R7 '(.*)'/.exec(nsh)![1];
    fs.writeFileSync(stoppedFile(dir), written);
    assert.equal((await watch(dir, ['-Answer', 'Yes'])).status, 'stopped');
    // A marker of an earlier run of TeamBot does not cover this run.
    const before = new Date(Date.parse(hb.boot) - 60 * 60_000);
    fs.utimesSync(stoppedFile(dir), before, before);
    assert.equal((await watch(dir)).status, 'down');
    // Nor a stop that did not happen: TeamBot went on beating long after the marker.
    markStopped(dir, 'quit');
    const old = new Date(Date.now() - 10 * 60_000);
    fs.utimesSync(stoppedFile(dir), old, old);
    fs.writeFileSync(file, JSON.stringify({ ...crashed, at: iso() }));
    assert.equal((await watch(dir)).status, 'down');
    // The pc was restarted since the last heartbeat: Windows went away, not TeamBot.
    fs.rmSync(stoppedFile(dir));
    fs.writeFileSync(file, JSON.stringify({ ...crashed, at: '2020-01-01T08:00:00.000Z', boot: '2020-01-01T07:00:00.000Z' }));
    const f = await watch(dir, ['-Answer', 'Yes']);
    assert.deepEqual([f.status, f.detail, f.asked], ['stopped', 'De pc is opnieuw opgestart.', false]);

    // TeamBot starts again: the marker of the last stop is removed, so a later crash counts again.
    markStopped(dir, 'quit');
    t.app.ctx.services.health.heartbeat().start(3_600_000);
    assert.equal(fs.existsSync(stoppedFile(dir)), false);
    t.app.ctx.services.health.heartbeat().stop();

    // The desktop app writes the marker in both places (Electron itself cannot run in this test).
    const main = fs.readFileSync(path.join(root, 'desktop', 'main.ts'), 'utf8');
    const quit = main.slice(main.indexOf("app.on('before-quit'"), main.indexOf("app.on('window-all-closed'"));
    assert.match(quit, /markStopped\?\.\(restarting \? 'restart' : rollingBack \|\| updater\?\.state\.phase === 'ready' \? 'update' : 'quit'\)/);
    const end = main.slice(main.indexOf("win.on('session-end'"), main.indexOf("win.on('session-end'") + 300);
    assert.match(end, /markStopped\?\.\('shutdown'\)/);
  } finally {
    await t.close();
  }
});

test('watchdog asks once per incident: No is not asked again every 10 minutes; not during a fullscreen program or game; Yes stops only the hanging process', { skip: win }, async () => {
  const t = await startTestApp();
  const dir = t.dir;
  const file = path.join(dir, 'health', 'heartbeat.json');
  // A stand-in for a hanging TeamBot: a child process of this test that answers nothing.
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', windowsHide: true });
  try {
    t.app.ctx.services.health.heartbeat().stop();
    const hang = { v: 1, at: iso(), boot: iso(), pid: child.pid, port: 9, version: 'test', exe: path.join(dir, 'bestaat-niet.exe'), notify: true, stopped: false };
    fs.writeFileSync(file, JSON.stringify(hang));

    // A game or a fullscreen program (2, 3) or a presentation (4): not now, and not counted as asked.
    for (const busy of ['2', '3', '4']) {
      const f = await watch(dir, ['-Answer', 'No', '-BusyState', busy]);
      assert.deepEqual([f.status, f.asked], ['hang', false], `screen state ${busy}`);
    }
    // Normal screen: asked once. The owner says No.
    let f = await watch(dir, ['-Answer', 'No', '-BusyState', '5']);
    assert.deepEqual([f.status, f.asked, f.answer], ['hang', true, 'No']);
    // Ten minutes later, and later still: the same incident, not asked again (also not when it turns into "down").
    for (let i = 0; i < 2; i++) assert.equal((await watch(dir, ['-Answer', 'No', '-BusyState', '5'])).asked, false);
    fs.writeFileSync(file, JSON.stringify({ ...hang, pid: 4_000_000 }));
    f = await watch(dir, ['-Answer', 'No', '-BusyState', '5']);
    assert.deepEqual([f.status, f.asked], ['down', false]);
    // The owner switched the message off: never asked.
    fs.writeFileSync(file, JSON.stringify({ ...hang, boot: iso(-1000), notify: false }));
    assert.equal((await watch(dir, ['-Answer', 'No', '-BusyState', '5'])).asked, false);

    // TeamBot ran normally again: a new hang is a new incident.
    t.app.ctx.services.health.heartbeat().beat();
    t.app.ctx.services.health.heartbeat().stop();
    const ok = JSON.parse(fs.readFileSync(file, 'utf8'));
    fs.writeFileSync(file, JSON.stringify({ ...ok, stopped: false }));
    assert.equal((await watch(dir)).status, 'ok');
    fs.writeFileSync(file, JSON.stringify({ ...hang, boot: new Date(Date.now() - 2000).toISOString() }));
    // Yes: only the process of the heartbeat (checked by its start time) is stopped; the missing program is not started.
    const gone = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
    f = await watch(dir, ['-Answer', 'Yes', '-BusyState', '5']);
    assert.deepEqual([f.status, f.asked, f.answer], ['hang', true, 'Yes']);
    await Promise.race([gone, new Promise((_r, rej) => setTimeout(() => rej(new Error('the hanging process was not stopped')), 10_000))]);
  } finally {
    if (child.exitCode === null) child.kill();
    await t.close();
  }
});
