process.env.TEAMBOT_BROWSER_HEADLESS_ONLY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import ssh2 from 'ssh2';
import { startTestApp } from './helpers.js';
import { BASH, PASSWORD, SKIP_NO_BASH as SKIP, asUser, callTool, genKey, startSsh, svcOf, toolCtx } from './ssh-fixture.js';
import {
  cleanRemoteDir,
  cleanRemotePath,
  execScript,
  isFingerprint,
  remoteDockerArgs,
  scrub,
  shq,
  validateCredential,
  wrapSh,
} from '../server/modules/browser/remote.js';

const { utils } = ssh2;
const USER = 'bot';

/**
 * CMP-07 "Eigen server (SSH)" against the in-process ssh2 server from ssh-fixture.ts (bash in a temp home; Git Bash
 * on Windows). Skipped when no usable bash is found.
 */

// ---------------- unit ----------------

test('remote: quoting, path rules, folder rules, docker flags, credential checks', { timeout: 60_000 }, () => {
  for (const s of ["it's", "a'b'c", "'", '$HOME `id` $(id) "x" \\ ;|&', 'regel1\nregel2', '']) {
    const q = shq(s);
    assert.ok(q.startsWith("'") && q.endsWith("'"));
    if (BASH) assert.equal(spawnSync(BASH, ['-c', `printf '%s' ${q}`], { encoding: 'utf8', windowsHide: true }).stdout, s, `round trip ${JSON.stringify(s)}`);
  }
  assert.throws(() => shq('a\0b'));
  assert.deepEqual(cleanRemotePath('src/./main.c'), ['src', 'main.c']);
  assert.deepEqual(cleanRemotePath('src\\win.txt'), ['src', 'win.txt']);
  assert.deepEqual(cleanRemotePath('', { allowRoot: true }), []);
  for (const bad of ['../x', 'a/../../b', '/etc/passwd', '~/x', 'C:\\Windows', 'C:/x', 'a\nb', 'a/..', '..']) assert.throws(() => cleanRemotePath(bad), bad);
  assert.throws(() => cleanRemotePath(''), /bestandsnaam/);
  assert.equal(cleanRemoteDir('~/bots/een'), 'bots/een');
  assert.equal(cleanRemoteDir('/srv/teambot//x/'), '/srv/teambot/x');
  for (const bad of ['/', '~', '.', '../x', 'a/../b', 'a;b', 'a:b', '$HOME/x']) assert.throws(() => cleanRemoteDir(bad), bad);
  assert.equal(isFingerprint('SHA256:' + 'A'.repeat(43)), true);
  assert.equal(isFingerprint('MD5:aa:bb'), false);
  const args = remoteDockerArgs({ name: 'teambot-ag-1', image: 'debian:stable-slim', memoryMb: 512, cpus: 1 }).join(' ');
  for (const f of ['run --rm -i', '--network none', '--cap-drop ALL', '--security-opt no-new-privileges', '--memory 512m', '--cpus 1', '--pids-limit 512', '-v "$root":/workspace', '-w /workspace', "'debian:stable-slim'"]) assert.ok(args.includes(f), f);
  assert.match(execScript('teambot/ag_1', null), /"\$HOME"\/'teambot\/ag_1'/);
  assert.match(wrapSh('echo "$1"', "x'y"), /^sh -c 'echo "\$1"' tb 'x'\\''y'$/);
  // credentials: a real private key passes, garbage / public keys / encrypted keys do not (and are never echoed)
  const kp = genKey();
  assert.equal(validateCredential('key', kp.private).kind, 'key');
  assert.throws(() => validateCredential('key', kp.public), /publieke sleutel/);
  assert.throws(() => validateCredential('key', 'geen-sleutel-123'), (e: any) => /geen geldige privésleutel/.test(e.message) && !e.message.includes('geen-sleutel-123'));
  const enc = utils.generateKeyPairSync('ed25519', { passphrase: 'pw', cipher: 'aes256-ctr', rounds: 4 } as any);
  assert.throws(() => validateCredential('key', enc.private), /wachtwoordzin/);
  assert.throws(() => validateCredential('pin', 'x'));
  assert.equal(scrub(`fout bij ${PASSWORD}!`, PASSWORD).includes(PASSWORD), false);
  assert.equal(scrub(`-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END OPENSSH PRIVATE KEY-----`).includes('abc'), false);
});

// ---------------- integration ----------------

test('remote: explicit TOFU, tools after trust, limits, mismatch fails closed, secrets never leak', { skip: SKIP, timeout: 120_000 }, async (tc) => {
  const t = await startTestApp();
  tc.after(() => t.close().catch(() => {}));
  const home = fs.mkdtempSync(path.join(t.dir, 'remote-home-'));
  const binDir = path.join(t.dir, 'fakebin');
  const dockerLog = path.join(t.dir, 'docker.log');
  fs.mkdirSync(binDir);
  // a fake `docker` on the server: logs its arguments and runs the command on the host
  fs.writeFileSync(
    path.join(binDir, 'docker'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$TB_FAKE_DOCKER_LOG"',
      'case "$1" in version) echo 27.1.0; exit 0;; kill) exit 0;; run) ;; *) exit 1;; esac',
      'shift',
      'while [ $# -gt 0 ]; do case "$1" in --rm|-i) shift;; --name|--network|--cap-drop|--security-opt|--memory|--cpus|--pids-limit|--user|-v|-w) shift 2;; *) break;; esac; done',
      'shift',
      'exec "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const keys = genKey();
  // MSYS=winsymlinks:lnk lets Git Bash make real (emulated) symlinks, so the symlink checks run on Windows too
  const ssh = await startSsh({ home, publicKey: keys.public, binDir, env: { TB_FAKE_DOCKER_LOG: dockerLog, MSYS: 'winsymlinks:lnk' } });
  const events: string[] = [];
  const unsub = t.app.ctx.events.subscribe((e) => events.push(JSON.stringify(e)));
  const outputs: string[] = [];
  const keyLines = keys.private.split('\n').filter((l) => l.length > 20 && !l.startsWith('-----'));
  const noSecret = (label: string, s: string) => {
    assert.equal(s.includes(PASSWORD), false, `${label}: password leaked`);
    for (const l of keyLines) assert.equal(s.includes(l), false, `${label}: key leaked`);
  };
  try {
    const svc = svcOf(t);
    const a = await t.agent({ tool_groups: ['files'] });
    const remoteRoot = path.join(home, 'teambot', a.id);

    // mode needs a host + user
    await assert.rejects(t.api('PUT', `/computers/${a.id}/config`, { mode: 'remote' }), /adres en de gebruikersnaam/);
    await assert.rejects(t.api('PUT', `/computers/${a.id}/config`, { mode: 'remote', remote: { host: 'root@x', username: USER } }), /400/);
    const saved = await t.api('PUT', `/computers/${a.id}/config`, { mode: 'remote', remote: { host: '127.0.0.1', port: ssh.port, username: USER } });
    assert.ok(saved.agent.tool_groups.includes('remote'));
    assert.ok(saved.agent.tool_groups.includes('files'));
    assert.equal(saved.config.remote.fingerprint, null);
    assert.equal(saved.config.remote.has_secret, false);
    assert.equal(saved.config.remote.workdir, `teambot/${a.id}`);

    // credential: stored once, only the name comes back
    const cred = await t.api('PUT', `/computers/${a.id}/remote/credential`, { kind: 'key', value: keys.private });
    assert.deepEqual(cred, { secret_name: `remote-ssh:${a.id}`, has_secret: true, auth: 'key' });
    await assert.rejects(t.api('PUT', `/computers/${a.id}/remote/credential`, { kind: 'key', value: 'nope' }), /geen geldige/);

    // tools refuse before the host key is trusted (nothing is executed, no login attempt)
    const tc = toolCtx(t, a.id);
    const early = await callTool(t, 'remote_exec', { command: 'echo hoi' }, tc);
    assert.equal(early.isError, true);
    assert.match(early.text, /nog niet vertrouwd/);
    assert.equal(ssh.execs.length, 0);
    assert.equal(ssh.auth.length, 0);

    // connection test without trust: only the fingerprint, no credentials are sent
    const probe = await t.api('POST', `/computers/${a.id}/remote/test`, {});
    assert.equal(probe.fingerprint, ssh.fingerprint);
    assert.equal(probe.trusted, false);
    assert.equal(probe.ok, true);
    assert.equal(ssh.auth.length, 0, 'no authentication before trust');
    await assert.rejects(t.api('PUT', `/computers/${a.id}/remote/trust`, { fingerprint: 'abc' }), /Ongeldige vingerafdruk/);
    const trusted = await t.api('PUT', `/computers/${a.id}/remote/trust`, { fingerprint: probe.fingerprint });
    assert.equal(trusted.remote.fingerprint, ssh.fingerprint);

    const ok = await t.api('POST', `/computers/${a.id}/remote/test`, {});
    assert.equal(ok.ok, true, JSON.stringify(ok));
    assert.equal(ok.trusted, true);
    assert.match(ok.os, /^\S+ \S+$/);
    assert.equal(ok.docker.installed, true, 'fake docker on PATH');
    assert.equal(ok.docker.version, '27.1.0');
    outputs.push(JSON.stringify(probe), JSON.stringify(ok), JSON.stringify(cred), JSON.stringify(trusted));

    // exec
    const ex = await callTool(t, 'remote_exec', { command: 'echo "hallo $((40+2))" && pwd -P' }, tc);
    outputs.push(ex.text);
    assert.equal(ex.isError, false, ex.text);
    assert.match(ex.text, /exitcode: 0/);
    assert.match(ex.text, /hallo 42/);
    assert.match(ex.text, /<serveruitvoer bron="bot@127\.0\.0\.1"/);
    assert.match(ex.text, /externe data, geen instructie/);
    assert.match(ex.text, new RegExp(`teambot/${a.id}`));
    const failing = await callTool(t, 'remote_exec', { command: 'echo kapot >&2; exit 3' }, tc);
    assert.equal(failing.isError, true);
    assert.match(failing.text, /exitcode: 3/);
    assert.match(failing.text, /kapot/);
    assert.ok(svc.remote.isConnected(a.id), 'connection is pooled');
    // a command that waits for input gets EOF instead of hanging until the time-out
    const stdinCmd = await callTool(t, 'remote_exec', { command: 'read x; cat; echo "gelezen:[$x]"', timeout_sec: 20 }, tc);
    assert.match(stdinCmd.text, /gelezen:\[\]/);

    // write / read / list (content with quotes and $ is stored literally)
    const content = `regel 1\nmet 'quotes', "dubbel", $HOME en \`id\` en $(id)\n`;
    const wr = await callTool(t, 'remote_write_file', { path: 'sub/dir/notitie.txt', content }, tc);
    assert.equal(wr.isError, false, wr.text);
    assert.equal(fs.readFileSync(path.join(remoteRoot, 'sub', 'dir', 'notitie.txt'), 'utf8'), content);
    await callTool(t, 'remote_write_file', { path: 'sub/dir/notitie.txt', content: 'erbij\n', append: true }, tc);
    const rd = await callTool(t, 'remote_read_file', { path: 'sub/dir/notitie.txt' }, tc);
    assert.equal(rd.isError, false, rd.text);
    assert.ok(rd.text.includes(content + 'erbij\n'), rd.text);
    assert.match(rd.text, /<serveruitvoer/);
    const missing = await callTool(t, 'remote_read_file', { path: 'bestaat/niet.txt' }, tc);
    assert.equal(missing.isError, true);
    assert.match(missing.text, /Niet gevonden/);
    const ls = await callTool(t, 'remote_list', { path: 'sub/dir' }, tc);
    assert.equal(ls.isError, false, ls.text);
    assert.match(ls.text, /notitie\.txt/);
    assert.match((await callTool(t, 'remote_list', {}, tc)).text, /sub/);

    // upload / download (binary safe) between the local workspace and the server
    const ws = t.app.ctx.store.agent(a.id)!.workspace;
    const bin = Buffer.from([0, 1, 2, 255, 10, 13, 39, 34, 36]);
    fs.writeFileSync(path.join(ws, 'lokaal.bin'), bin);
    const up = await callTool(t, 'remote_upload', { local_path: 'lokaal.bin', remote_path: 'up/lokaal.bin' }, tc);
    assert.equal(up.isError, false, up.text);
    assert.deepEqual(fs.readFileSync(path.join(remoteRoot, 'up', 'lokaal.bin')), bin);
    const down = await callTool(t, 'remote_download', { remote_path: 'up/lokaal.bin', local_path: 'terug/kopie.bin' }, tc);
    assert.equal(down.isError, false, down.text);
    assert.deepEqual(fs.readFileSync(path.join(ws, 'terug', 'kopie.bin')), bin);
    const down2 = await callTool(t, 'remote_download', { remote_path: 'sub/dir/notitie.txt' }, tc);
    assert.equal(down2.isError, false, down2.text);
    assert.ok(fs.existsSync(path.join(ws, 'downloads', 'notitie.txt')));
    const binRead = await callTool(t, 'remote_read_file', { path: 'up/lokaal.bin' }, tc);
    assert.match(binRead.text, /binair/);

    // paths stay inside the folder on the server (refused before anything connects or runs)
    const before = ssh.execs.length;
    for (const p of ['../buiten.txt', '/etc/passwd', 'a/../../b', '~/.ssh/id_rsa', 'C:\\Windows\\win.ini']) {
      for (const tool of ['remote_read_file', 'remote_write_file', 'remote_download']) {
        const r = await callTool(t, tool, tool === 'remote_download' ? { remote_path: p } : { path: p, content: 'x' }, tc);
        assert.equal(r.isError, true, `${tool} ${p}`);
        assert.match(r.text, /niet toegestaan/, `${tool} ${p}`);
      }
    }
    assert.equal((await callTool(t, 'remote_list', { path: '../' }, tc)).isError, true);
    assert.equal((await callTool(t, 'remote_upload', { local_path: '../../buiten.txt', remote_path: 'x' }, tc)).isError, true);
    assert.equal((await callTool(t, 'remote_upload', { local_path: 'lokaal.bin', remote_path: '../x' }, tc)).isError, true);
    assert.equal(ssh.execs.length, before, 'refused paths never reach the server');
    assert.equal(fs.existsSync(path.join(home, 'teambot', 'buiten.txt')), false);
    // symlinks inside the folder are not followed (e.g. one made inside a container). Only checked where the platform
    // makes real links: Git Bash's ln -s copies instead, so the directory link is only tried after a file link worked.
    fs.writeFileSync(path.join(home, 'teambot', 'buiten.txt'), 'geheim-buiten');
    const ln = await callTool(t, 'remote_exec', { command: 'ln -s ../buiten.txt link.txt 2>/dev/null; [ -L link.txt ] && echo is-link || echo geen-link' }, tc);
    if (/is-link/.test(ln.text)) {
      const viaFile = await callTool(t, 'remote_read_file', { path: 'link.txt' }, tc);
      assert.equal(viaFile.isError, true);
      assert.match(viaFile.text, /symbolische link/);
      assert.doesNotMatch(viaFile.text, /geheim-buiten/);
      await callTool(t, 'remote_exec', { command: 'ln -s .. omhoog' }, tc);
      const viaDir = await callTool(t, 'remote_read_file', { path: 'omhoog/buiten.txt' }, tc);
      assert.match(viaDir.text, /symbolische link/);
      assert.equal((await callTool(t, 'remote_write_file', { path: 'omhoog/nieuw.txt', content: 'x' }, tc)).isError, true);
      assert.equal(fs.existsSync(path.join(home, 'teambot', 'nieuw.txt')), false);
    }

    // output cap
    await t.api('PUT', `/computers/${a.id}/config`, { remote: { limits: { maxOutputKb: 4 } } });
    const big = await callTool(t, 'remote_exec', { command: 'i=0; while [ $i -lt 400 ]; do echo "regel $i met wat opvulling om de uitvoer groot te maken"; i=$((i+1)); done' }, tc);
    assert.equal(big.isError, false, big.text);
    assert.match(big.text, /uitvoer ingekort/);
    assert.match(big.text, /regel 0 /);
    assert.match(big.text, /regel 399 /, 'the tail is kept');
    assert.doesNotMatch(big.text, /regel 200 /);
    assert.ok(big.text.length < 4096 + 1500, `capped (${big.text.length})`);

    // timeout kills the command (SSH signal KILL) and returns quickly
    await t.api('PUT', `/computers/${a.id}/config`, { remote: { limits: { timeoutSec: 1, maxOutputKb: 64 } } });
    const t0 = Date.now();
    const slow = await callTool(t, 'remote_exec', { command: 'sleep 8; echo nooit' }, tc);
    assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
    assert.equal(slow.isError, true);
    assert.match(slow.text, /time-out na 1 s/);
    assert.doesNotMatch(slow.text, /nooit/);
    assert.ok(ssh.signals.includes('KILL'), 'remote process was killed');

    // abort (run stopped) cancels the running command
    await t.api('PUT', `/computers/${a.id}/config`, { remote: { limits: { timeoutSec: 60 } } });
    const tc2 = toolCtx(t, a.id);
    const pending = callTool(t, 'remote_exec', { command: 'sleep 8; echo nooit' }, tc2);
    await new Promise((r) => setTimeout(r, 800));
    const t1 = Date.now();
    tc2.abort();
    const stopped = await pending;
    assert.ok(Date.now() - t1 < 6000);
    assert.match(stopped.text, /gestopt/);

    // Docker on the server: same tool, command wrapped in a locked-down docker run
    await t.api('PUT', `/computers/${a.id}/config`, { remote: { docker: { enabled: true } } });
    const dk = await callTool(t, 'remote_exec', { command: 'echo in-docker' }, tc);
    assert.equal(dk.isError, false, dk.text);
    assert.match(dk.text, /in-docker/);
    assert.match(dk.text, /in Docker op de server/);
    const logged = fs.readFileSync(dockerLog, 'utf8');
    for (const f of ['run --rm -i --name teambot-', '--network none', '--cap-drop ALL', '--security-opt no-new-privileges', '--memory 1024m', '--pids-limit 512', ':/workspace -w /workspace debian:stable-slim sh -c']) assert.ok(logged.includes(f), `${f} in ${logged}`);
    await t.api('PUT', `/computers/${a.id}/config`, { remote: { docker: { enabled: false } } });

    // password login works too; a wrong password is reported without echoing it
    await t.api('PUT', `/computers/${a.id}/remote/credential`, { kind: 'password', value: PASSWORD + 'x' });
    const wrong = await t.api('POST', `/computers/${a.id}/remote/test`, {});
    assert.equal(wrong.ok, false);
    assert.match(wrong.error, /weigert het inloggen/);
    const wrongTool = await callTool(t, 'remote_exec', { command: 'echo x' }, tc);
    assert.equal(wrongTool.isError, true);
    outputs.push(JSON.stringify(wrong), wrongTool.text);
    await t.api('PUT', `/computers/${a.id}/remote/credential`, { kind: 'password', value: PASSWORD });
    const pw = await callTool(t, 'remote_exec', { command: `echo ${PASSWORD}` }, tc);
    assert.equal(pw.isError, false, pw.text);
    assert.match(pw.text, /\[verborgen\]/, 'the password is scrubbed even when the server prints it');
    outputs.push(pw.text);

    // host key mismatch (possible MITM / reinstalled server): fail closed, no login attempt
    const authBefore = ssh.auth.length;
    await t.api('PUT', `/computers/${a.id}/remote/trust`, { fingerprint: 'SHA256:' + 'A'.repeat(43) });
    const execsBefore = ssh.execs.length;
    const mitm = await callTool(t, 'remote_exec', { command: 'echo mag-niet' }, tc);
    assert.equal(mitm.isError, true);
    assert.match(mitm.text, /klopt niet met de vertrouwde vingerafdruk/);
    assert.match(mitm.text, /man-in-the-middle/);
    const mitmTest = await t.api('POST', `/computers/${a.id}/remote/test`, {});
    assert.equal(mitmTest.mismatch, true);
    assert.equal(mitmTest.fingerprint, ssh.fingerprint);
    assert.equal(ssh.execs.length, execsBefore);
    assert.equal(ssh.auth.length, authBefore, 'no credentials sent to a server with the wrong key');
    assert.ok(events.some((e) => e.includes('serversleutel klopt niet')), 'the user is notified');
    // changing the host forgets the pinned key
    const moved = await t.api('PUT', `/computers/${a.id}/config`, { remote: { port: ssh.port + 1 } });
    assert.equal(moved.config.remote.fingerprint, null);

    // the key/password never appears in API responses, exports, events, logs or tool results
    const ag = (await t.api('GET', `/computers/${a.id}`)).config;
    assert.equal(ag.remote.secret_name, `remote-ssh:${a.id}`);
    assert.equal(ag.remote.has_secret, true);
    for (const [label, s] of [
      ['config', JSON.stringify(ag)],
      ['list', JSON.stringify(await t.api('GET', '/computers'))],
      ['export', JSON.stringify(await t.api('GET', '/export'))],
      ['agent export', JSON.stringify(await t.api('GET', `/agents/${a.id}/export`))],
      ['actions', JSON.stringify(await t.api('GET', `/computers/${a.id}/actions`))],
      ['secrets list', JSON.stringify(await t.api('GET', '/secrets'))],
      ['audit', JSON.stringify(t.app.ctx.store.all('SELECT * FROM audit'))],
      ['config rows', JSON.stringify(t.app.ctx.store.all('SELECT * FROM computer_configs'))],
      ['events', events.join('\n')],
      ['outputs', outputs.join('\n')],
    ] as const)
      noSecret(label, s);

    // deleting the bot removes its SSH secret
    await t.api('DELETE', `/agents/${a.id}`);
    assert.equal(t.app.ctx.secrets.getByName(a.user_id, `remote-ssh:${a.id}`), null);
  } finally {
    unsub();
    await t.close();
    await ssh.close();
  }
});

test('remote: a full chat run uses remote_exec, the system prompt explains the server', { skip: SKIP, timeout: 120_000 }, async (tc) => {
  const t = await startTestApp();
  tc.after(() => t.close().catch(() => {}));
  const home = fs.mkdtempSync(path.join(t.dir, 'remote-home-'));
  const keys = genKey();
  const ssh = await startSsh({ home, publicKey: keys.public });
  try {
    const a = await t.agent({ tool_groups: ['files'] });
    await t.api('PUT', `/computers/${a.id}/config`, { mode: 'remote', remote: { host: '127.0.0.1', port: ssh.port, username: USER, dir: 'werk/bot' } });
    await t.api('PUT', `/computers/${a.id}/remote/credential`, { kind: 'key', value: keys.private });
    await t.api('PUT', `/computers/${a.id}/remote/trust`, { fingerprint: ssh.fingerprint });
    const th = t.app.ctx.store.createThread({ user_id: a.user_id, agent_id: a.id });
    let system = '';
    t.script.push({ toolCalls: [{ name: 'remote_exec', args: { command: 'echo vanaf-de-server > bewijs.txt && cat bewijs.txt' } }], check: (req: any) => (system = JSON.stringify(req.system ?? req.messages?.[0] ?? '')) }, { text: 'klaar' });
    const msgs = await t.say(th.id, 'Maak een bestand op de server', 20_000);
    assert.match(system, /eigen server via SSH \(bot@127\.0\.0\.1\)/);
    assert.match(system, /werk\/bot/);
    assert.equal(fs.readFileSync(path.join(home, 'werk', 'bot', 'bewijs.txt'), 'utf8').trim(), 'vanaf-de-server');
    const all = JSON.stringify(msgs);
    assert.match(all, /vanaf-de-server/);
    assert.equal(all.includes(keys.private.split('\n')[2]), false);
    const st = await t.api('GET', `/computers/${a.id}`);
    assert.equal(st.status.remote.trusted, true);
    assert.equal(st.status.remote.hasSecret, true);
  } finally {
    await t.close();
    await ssh.close();
  }
});

test('remote: a chatty login shell (text from ~/.bashrc) does not break the test or corrupt files', { skip: SKIP, timeout: 120_000 }, async (tc) => {
  const t = await startTestApp();
  tc.after(() => t.close().catch(() => {}));
  const home = fs.mkdtempSync(path.join(t.dir, 'remote-home-'));
  const banner = path.join(t.dir, 'banner.sh');
  // bash reads $BASH_ENV for non-interactive shells, like ~/.bashrc for ssh exec sessions
  fs.writeFileSync(banner, 'echo "Welkom op de server! 12345"\n');
  const keys = genKey();
  const ssh = await startSsh({ home, publicKey: keys.public, env: { BASH_ENV: banner } });
  try {
    const a = await t.agent();
    await t.api('PUT', `/computers/${a.id}/config`, { mode: 'remote', remote: { host: '127.0.0.1', port: ssh.port, username: USER } });
    await t.api('PUT', `/computers/${a.id}/remote/credential`, { kind: 'key', value: keys.private });
    await t.api('PUT', `/computers/${a.id}/remote/trust`, { fingerprint: ssh.fingerprint });
    const r = await t.api('POST', `/computers/${a.id}/remote/test`, {});
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.match(r.os, /^\S+ \S+$/);
    const tc = toolCtx(t, a.id);
    const content = '42\nnog een regel\n';
    assert.equal((await callTool(t, 'remote_write_file', { path: 'data.txt', content }, tc)).isError, false);
    const rd = await callTool(t, 'remote_read_file', { path: 'data.txt' }, tc);
    assert.ok(rd.text.includes(`(${Buffer.byteLength(content)} bytes)`), rd.text);
    assert.ok(rd.text.includes(`\n${content}\n</serveruitvoer>`), rd.text);
    assert.doesNotMatch(rd.text, /Welkom/);
    const down = await callTool(t, 'remote_download', { remote_path: 'data.txt', local_path: 'data.txt' }, tc);
    assert.equal(down.isError, false, down.text);
    assert.equal(fs.readFileSync(path.join(t.app.ctx.store.agent(a.id)!.workspace, 'data.txt'), 'utf8'), content);
  } finally {
    await t.close();
    await ssh.close();
  }
});

test('remote: Windows / non-POSIX servers are refused by the connection test', { skip: SKIP, timeout: 120_000 }, async (tc) => {
  const t = await startTestApp();
  tc.after(() => t.close().catch(() => {}));
  const keys = genKey();
  const ssh = await startSsh({ home: t.dir, publicKey: keys.public, windows: true });
  try {
    const a = await t.agent();
    await t.api('PUT', `/computers/${a.id}/config`, { mode: 'remote', remote: { host: '127.0.0.1', port: ssh.port, username: USER } });
    await t.api('PUT', `/computers/${a.id}/remote/credential`, { kind: 'key', value: keys.private });
    await t.api('PUT', `/computers/${a.id}/remote/trust`, { fingerprint: ssh.fingerprint });
    const r = await t.api('POST', `/computers/${a.id}/remote/test`, {});
    assert.equal(r.ok, false);
    assert.equal(r.windows, true);
    assert.match(r.error, /Windows-server/);
  } finally {
    await t.close();
    await ssh.close();
  }
});

test('remote: restricted members only reach public hosts (checked at save and at every connection)', { timeout: 120_000 }, async (tc) => {
  const t = await startTestApp({ mode: 'server' });
  tc.after(() => t.close().catch(() => {}));
  try {
    const svc = svcOf(t);
    const answers: Record<string, string[]> = { 'publiek.example': ['93.184.215.14'], 'lan.example': ['10.0.0.7'], 'rebind.example': ['93.184.215.20'] };
    svc.remote.resolver = async (h) => {
      if (!answers[h]) throw new Error('ENOTFOUND');
      return answers[h];
    };
    const member = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@example.com', password: 'wachtwoord123', role: 'member' });
    const tok = t.app.ctx.auth.createSession(member.id).token;
    const mb = (await asUser(t, tok, 'POST', '/agents', { name: 'Ledenbot' })).body;
    for (const host of ['127.0.0.1', 'localhost', '10.1.2.3', '169.254.169.254', '::1', 'lan.example', 'nas.local']) {
      const r = await asUser(t, tok, 'PUT', `/computers/${mb.id}/config`, { mode: 'remote', remote: { host, username: 'bot' } });
      assert.equal(r.status, 403, `${host}: ${JSON.stringify(r.body)}`);
      assert.match(r.body.error, /openbare adressen/);
    }
    // a public host is fine
    const okPub = await asUser(t, tok, 'PUT', `/computers/${mb.id}/config`, { mode: 'remote', remote: { host: 'rebind.example', username: 'bot' } });
    assert.equal(okPub.status, 200, JSON.stringify(okPub.body));
    // DNS rebinding: the name now points to the server itself; every connection checks the resolved IP again
    answers['rebind.example'] = ['127.0.0.1'];
    await asUser(t, tok, 'PUT', `/computers/${mb.id}/remote/credential`, { kind: 'password', value: PASSWORD });
    await asUser(t, tok, 'PUT', `/computers/${mb.id}/remote/trust`, { fingerprint: 'SHA256:' + 'B'.repeat(43) });
    const test2 = await asUser(t, tok, 'POST', `/computers/${mb.id}/remote/test`, {});
    assert.equal(test2.status, 403);
    assert.match(test2.body.error, /openbare adressen/);
    const tc = toolCtx(t, mb.id);
    const r = await callTool(t, 'remote_exec', { command: 'id' }, tc);
    assert.equal(r.isError, true);
    assert.match(r.text, /openbare adressen/);
    // a row written behind the API's back is refused at connect time too
    t.app.ctx.store.exec("UPDATE computer_configs SET remote_host = '127.0.0.1' WHERE agent_id = ?", mb.id);
    assert.match((await callTool(t, 'remote_list', {}, tc)).text, /openbare adressen/);
    // other users cannot test, trust or set credentials for someone else's bot
    const ownerBot = await t.agent();
    for (const [m, p, b] of [
      ['POST', `/computers/${ownerBot.id}/remote/test`, {}],
      ['PUT', `/computers/${ownerBot.id}/remote/trust`, { fingerprint: 'SHA256:' + 'C'.repeat(43) }],
      ['PUT', `/computers/${ownerBot.id}/remote/credential`, { kind: 'password', value: 'x' }],
    ] as const)
      assert.equal((await asUser(t, tok, m, p, b)).status, 404, p);
    // the owner of the server may use a private address (e.g. a home server)
    const own = await t.api('PUT', `/computers/${ownerBot.id}/config`, { mode: 'remote', remote: { host: '192.168.1.20', username: 'bot' } });
    assert.equal(own.config.mode, 'remote');
    assert.equal(own.config.remote.host, '192.168.1.20');
  } finally {
    await t.close();
  }
});
