process.env.TEAMBOT_BROWSER_HEADLESS_ONLY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { PASSWORD, SKIP_NO_BASH as SKIP, callTool, genKey, startSsh, svcOf, toolCtx } from './ssh-fixture.js';
import { ContainerRuntime } from '../server/modules/browser/container.js';
import { OutputCollector, envBlock, execScript, remoteDockerArgs } from '../server/modules/browser/remote.js';
import { cutLeading, valueVariants } from '../server/modules/script-keys/service.js';
import { promptNote, scriptKeysOf } from '../server/modules/script-keys/index.js';

/**
 * "Sleutels voor scripts" in the private container (computer_exec) and on the bot's own server (remote_exec): the
 * value reaches the command's environment, never a command line, and every output shows [verborgen: $NAME].
 */

const VALUE = 'shpat_' + 'Zq9Xw8Vu7Ts6Rq5Po4Nm';
const HIDDEN = '[verborgen: $SHOPIFY_TOKEN]';

function fakeCaps(docker: 'available' | 'missing') {
  const cap = (id: string, status: any, isolation: any = 'none') => ({ id, label: id, status, detail: `${id} ${status}`, isolation });
  return {
    platform: 'win32',
    osName: 'Windows 11 Home',
    edition: 'Core',
    isWindowsHome: true,
    appMode: 'desktop',
    detectedAt: new Date().toISOString(),
    browsers: [],
    caps: { browser: cap('browser', 'missing', 'process'), hyperv: cap('hyperv', 'unsupported', 'vm'), sandbox: cap('sandbox', 'unsupported', 'vm'), wsl: cap('wsl', 'missing'), docker: cap('docker', docker, 'container'), host: cap('host', 'missing'), visible: cap('visible', 'unsupported', 'process') },
  } as any;
}

test('script keys on a command line: never; container by name (-e NAME), server over the channel input', () => {
  // container: docker exec gets the names, the docker CLI process the values
  const calls: { args: string[]; env?: Record<string, string> }[] = [];
  const rt = new ContainerRuntime(async (args, o) => (calls.push({ args, env: o.env }), { code: 0, out: '', timedOut: false }));
  return rt.exec('ag_1', 'echo hoi', { timeoutMs: 1000, env: { SHOPIFY_TOKEN: VALUE, 'bad name': 'x' } }).then(() => {
    assert.deepEqual(calls[0].args.slice(0, 3), ['exec', '-e', 'SHOPIFY_TOKEN']);
    assert.ok(!calls[0].args.join(' ').includes(VALUE), 'no value in the docker arguments');
    assert.ok(!calls[0].args.includes('bad name'));
    assert.deepEqual(calls[0].env, { SHOPIFY_TOKEN: VALUE });
    // server: the block is shell code sent as input; the script only knows its size
    const block = envBlock({ SHOPIFY_TOKEN: VALUE, QUOTE_KEY: "it's a 'test'" })!;
    assert.equal(block.toString(), `export SHOPIFY_TOKEN='${VALUE}'\nexport QUOTE_KEY='it'\\''s a '\\''test'\\'''\n`);
    assert.equal(envBlock({}), null);
    const script = execScript('teambot/ag_1', null, { names: ['SHOPIFY_TOKEN'], bytes: block.length });
    assert.match(script, new RegExp(`dd bs=1 count=${block.length}`));
    assert.ok(!script.includes(VALUE));
    assert.deepEqual(remoteDockerArgs({ name: 'n', image: 'debian', memoryMb: 512, cpus: 1 }, ['SHOPIFY_TOKEN', 'x;rm']).slice(5, 7), ['-e', 'SHOPIFY_TOKEN']);
    assert.ok(!remoteDockerArgs({ name: 'n', image: 'debian', memoryMb: 512, cpus: 1 }, ['x;rm']).includes('x;rm'));
    // shortened output: half a value at the gap is dropped on both sides
    const items = [{ name: 'SHOPIFY_TOKEN', variants: valueVariants(VALUE) }];
    assert.equal(cutLeading(VALUE.slice(-9) + ' rest', items), ' rest');
    assert.equal(cutLeading('gewoon', items), 'gewoon');
    const col = new OutputCollector(40);
    col.push(Buffer.from('a'.repeat(14) + VALUE + 'b'.repeat(30) + VALUE.slice(0, 3) + VALUE + 'c'.repeat(6)));
    const svcLike = (x: string, cut: { start?: boolean; end?: boolean }) => {
      let out = x.split(VALUE).join(HIDDEN);
      if (cut.end) out = out.replace(new RegExp(`${VALUE.slice(0, 4)}.*$`), '');
      if (cut.start) out = cutLeading(out, items);
      return out;
    };
    assert.ok(!col.text(svcLike).includes(VALUE.slice(0, 6)), col.text(svcLike));
  });
});

test('computer_exec: the container command gets the keys, the result and the live output only the name', async () => {
  const t = await startTestApp();
  try {
    const svc = svcOf(t);
    svc.setCapabilities(fakeCaps('available'));
    const runs: { args: string[]; env?: Record<string, string> }[] = [];
    (svc.container as any).run = async (args: string[], o: any) => {
      runs.push({ args, env: o.env });
      if (args[0] === 'inspect') return { code: 0, out: 'true', timedOut: false };
      // the "container" prints what it got from its environment
      const name = args[args.indexOf('-e') + 1];
      const v = o.env?.[name] || '';
      o.onData?.(`waarde=${v}\n`);
      return { code: 0, out: `waarde=${v}\nlengte=${v.length}\n`, timedOut: false };
    };
    const a = await t.agent({ name: 'Containerbot', tool_groups: ['files'] });
    t.app.ctx.store.insert('computer_configs', { agent_id: a.id, user_id: a.user_id, mode: 'container', allow_domains: [], deny_domains: [], host_apps: [], container: {}, limits: {}, updated_at: new Date().toISOString() });
    await t.api('POST', '/script-keys', { name: 'SHOPIFY_TOKEN', value: VALUE, label: 'Webwinkel', agent_id: a.id });
    const progress: string[] = [];
    const tc = { ...toolCtx(t, a.id), progress: (s: string) => progress.push(s) };
    const r = await callTool(t, 'computer_exec', { command: 'echo "waarde=$SHOPIFY_TOKEN"' }, tc as any);
    assert.equal(r.isError, false, r.text);
    assert.match(r.text, /lengte=26/, 'the command really had the value');
    assert.ok(r.text.includes(`waarde=${HIDDEN}`), r.text);
    assert.ok(!r.text.includes(VALUE));
    assert.ok(progress.length && progress.every((p) => !p.includes(VALUE)), 'live output hidden');
    const exec = runs.find((x) => x.args[0] === 'exec')!;
    assert.ok(!exec.args.join(' ').includes(VALUE));
    assert.deepEqual(exec.env, { SHOPIFY_TOKEN: VALUE });
    // logged as names only
    const audit = t.app.ctx.store.all<any>("SELECT data FROM audit WHERE kind = 'script-keys.used'").map((x) => String(x.data));
    assert.ok(audit.some((x) => x.includes('computer_exec')));
    assert.ok(audit.every((x) => !x.includes(VALUE)));
    // the prompt tells the bot where the keys are; a bot with only the container tools uses them (not "unusable")
    const svcK = scriptKeysOf(t.app.ctx)!;
    assert.match(promptNote(t.app.ctx, svcK, t.app.ctx.store.agent(a.id)!)!, /computer_exec \(je privé-container\) en remote_exec \(je eigen server\)/);
    assert.equal(svcK.unusable({ ...t.app.ctx.store.agent(a.id)!, tool_groups: ['container'] }), null);
  } finally {
    await t.close();
  }
});

test('remote_exec: keys reach the command on the server (also in Docker there), never its command line or the output', { skip: SKIP, timeout: 120_000 }, async (tc) => {
  const t = await startTestApp();
  tc.after(() => t.close().catch(() => {}));
  const home = fs.mkdtempSync(path.join(t.dir, 'remote-home-'));
  const binDir = path.join(t.dir, 'fakebin');
  const dockerLog = path.join(t.dir, 'docker.log');
  fs.mkdirSync(binDir);
  // a fake `docker` on the server: logs its arguments, checks -e NAME is in its environment, runs the command
  fs.writeFileSync(
    path.join(binDir, 'docker'),
    [
      '#!/bin/sh',
      'printf "%s\\n" "$*" >> "$TB_FAKE_DOCKER_LOG"',
      'case "$1" in version) echo 27.1.0; exit 0;; kill) exit 0;; run) ;; *) exit 1;; esac',
      'shift',
      'while [ $# -gt 0 ]; do case "$1" in --rm|-i) shift;; -e) printf "env %s gezet: %s\\n" "$2" "$(eval "[ -n \\"\\${$2}\\" ] && echo ja || echo nee")" >> "$TB_FAKE_DOCKER_LOG"; shift 2;; --name|--network|--cap-drop|--security-opt|--memory|--cpus|--pids-limit|--user|-v|-w) shift 2;; *) break;; esac; done',
      'shift',
      'exec "$@"',
      '',
    ].join('\n'),
    { mode: 0o755 },
  );
  const keys = genKey();
  const ssh = await startSsh({ home, publicKey: keys.public, binDir, env: { TB_FAKE_DOCKER_LOG: dockerLog } });
  tc.after(() => ssh.close().catch(() => {}));
  const a = await t.agent({ tool_groups: ['files'] });
  await t.api('PUT', `/computers/${a.id}/config`, { mode: 'remote', remote: { host: '127.0.0.1', port: ssh.port, username: 'bot' } });
  await t.api('PUT', `/computers/${a.id}/remote/credential`, { kind: 'key', value: keys.private });
  const probe = await t.api('POST', `/computers/${a.id}/remote/test`, {});
  await t.api('PUT', `/computers/${a.id}/remote/trust`, { fingerprint: probe.fingerprint });
  await t.api('POST', '/script-keys', { name: 'SHOPIFY_TOKEN', value: VALUE, agent_id: a.id });
  await t.api('POST', '/script-keys', { name: 'QUOTE_KEY', value: "it's a 'test' $HOME `x`", agent_id: a.id });

  const progress: string[] = [];
  const ctx = { ...toolCtx(t, a.id), progress: (s: string) => progress.push(s) };
  const cmd = 'echo "waarde=$SHOPIFY_TOKEN"; printf %s "$SHOPIFY_TOKEN" | wc -c; printf "%s\\n" "$QUOTE_KEY" | wc -c; echo "na: $(pwd -P)"';
  const r = await callTool(t, 'remote_exec', { command: cmd }, ctx as any);
  assert.equal(r.isError, false, r.text);
  assert.ok(r.text.includes(`waarde=${HIDDEN}`), r.text);
  assert.ok(!r.text.includes(VALUE), r.text);
  assert.match(r.text, /\b26\b/, 'the value arrived in full');
  assert.match(r.text, /\b24\b/, 'quotes, $ and backticks arrived as they are');
  assert.match(r.text, /na: \S*teambot/, 'the command still ran in the bot folder');
  assert.ok(ssh.execs.every((x) => !x.includes(VALUE) && !x.includes('Zq9Xw8')), 'no value on the command line');
  assert.ok(progress.every((p) => !p.includes(VALUE)));

  // Docker on the server: -e NAME only, the value comes from the shell
  await t.api('PUT', `/computers/${a.id}/config`, { remote: { docker: { enabled: true } } });
  const dk = await callTool(t, 'remote_exec', { command: 'echo "in-docker=$SHOPIFY_TOKEN"' }, ctx as any);
  assert.equal(dk.isError, false, dk.text);
  assert.ok(dk.text.includes(`in-docker=${HIDDEN}`), dk.text);
  const logged = fs.readFileSync(dockerLog, 'utf8');
  assert.match(logged, /-e SHOPIFY_TOKEN/);
  assert.match(logged, /env SHOPIFY_TOKEN gezet: ja/);
  assert.ok(!logged.includes(VALUE));
  assert.ok(!logged.includes(PASSWORD));
});
