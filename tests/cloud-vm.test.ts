process.env.TEAMBOT_BROWSER_HEADLESS_ONLY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import YAML from 'yaml';
import { startTestApp, type TestApp } from './helpers.js';
import { SKIP_NO_BASH, asUser, callTool, fpOf, startSsh, svcOf, toolCtx, type FakeSsh } from './ssh-fixture.js';
import { HetznerProvider } from '../server/modules/browser/cloudvm/hetzner.js';
import { buildCloudInit, genKeyPair } from '../server/modules/browser/cloudvm/cloudinit.js';
import { defaultChoice, estimate } from '../server/modules/browser/cloudvm/provider.js';
import type { CloudVmService } from '../server/modules/browser/cloudvm/service.js';

/**
 * CMP-07 part 2 "Cloud-VM": a fake Hetzner Cloud API (node:http) records every request; the VM "boots" as the
 * in-process ssh2 server from ssh-fixture.ts, started with the host key TeamBot put into the cloud-init.
 */

const TOKENS = { good: 'hcloud-GOOD-7Qx9-geheim-token', readonly: 'hcloud-READONLY-token', quota: 'hcloud-QUOTA-token', rate: 'hcloud-RATE-token', slow: 'hcloud-SLOWRATE-token' };
const ROOT_PASSWORD = 'ROOTPW-mag-nergens-staan-31';

interface FakeServer {
  id: number;
  name: string;
  status: string;
  ip: string;
  body: any;
}

interface FakeHetzner {
  url: string;
  reqs: { method: string; path: string; auth: string; body: any }[];
  servers: Map<number, FakeServer>;
  /** IPv4 the fake hands out (tests only: 127.0.0.1) */
  ip: string;
  /** create the server but answer 503 (a response lost in transit) */
  createThenFail: boolean;
  close(): Promise<void>;
}

const price = (net: string, gross: string, location: string) => ({ location, price_hourly: { net: String(Number(net) / 730), gross: String(Number(gross) / 730) }, price_monthly: { net, gross } });

async function startFakeHetzner(): Promise<FakeHetzner> {
  const st: FakeHetzner = { url: '', reqs: [], servers: new Map(), ip: '127.0.0.1', createThenFail: false, close: async () => {} };
  let nextId = 4711;
  let rateHits = 0;
  const srv = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const url = new URL(req.url || '/', 'http://fake');
      const p = url.pathname;
      const tok = String(req.headers.authorization || '').replace(/^Bearer /, '');
      st.reqs.push({ method: req.method || '', path: p + url.search, auth: tok, body });
      const send = (status: number, obj: any, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(JSON.stringify(obj));
      };
      if (!Object.values(TOKENS).includes(tok)) return send(401, { error: { code: 'unauthorized', message: 'unable to authenticate' } });
      if (tok === TOKENS.slow) return send(429, { error: { code: 'rate_limit_exceeded', message: 'limit reached' } }, { 'retry-after': '120' });
      if (tok === TOKENS.rate && rateHits++ < 1) return send(429, { error: { code: 'rate_limit_exceeded', message: 'limit reached' } }, { 'retry-after': '1' });
      const page = Number(url.searchParams.get('page') || 1);
      const one = (key: string, items: any[], next: number | null = null) => send(200, { [key]: items, meta: { pagination: { page, next_page: next } } });
      if (req.method === 'GET' && p === '/locations')
        return one('locations', [
          { id: 1, name: 'fsn1', description: 'Falkenstein DC Park 1', country: 'DE', city: 'Falkenstein' },
          { id: 2, name: 'nbg1', description: 'Nuremberg DC Park 1', country: 'DE', city: 'Nuremberg' },
          { id: 4, name: 'ash', description: 'Ashburn, VA', country: 'US', city: 'Ashburn' },
        ]);
      if (req.method === 'GET' && p === '/server_types')
        return page === 1
          ? one(
              'server_types',
              [
                { id: 22, name: 'cx22', description: 'CX22', cores: 2, memory: 4, disk: 40, architecture: 'x86', deprecation: null, prices: [price('3.7900', '4.5101', 'fsn1'), price('3.7900', '4.5101', 'nbg1')] },
                { id: 1, name: 'cx11', description: 'CX11 (oud)', cores: 1, memory: 2, disk: 20, architecture: 'x86', deprecation: { announced: '2024-01-01', unavailable_after: '2024-06-01' }, prices: [price('3.29', '3.92', 'nbg1')] },
                { id: 45, name: 'cax11', description: 'CAX11', cores: 2, memory: 4, disk: 40, architecture: 'arm', deprecation: null, prices: [price('3.29', '3.92', 'nbg1')] },
              ],
              2,
            )
          : one('server_types', [{ id: 96, name: 'cpx11', description: 'CPX11', cores: 2, memory: 2, disk: 40, architecture: 'x86', deprecation: null, prices: [price('4.35', '5.18', 'nbg1'), price('4.35', '5.18', 'ash')] }]);
      if (req.method === 'GET' && p === '/images')
        return one('images', [
          { id: 1, name: 'ubuntu-22.04', description: 'Ubuntu 22.04', os_flavor: 'ubuntu', os_version: '22.04', architecture: 'x86', deprecated: null },
          { id: 2, name: 'ubuntu-24.04', description: 'Ubuntu 24.04', os_flavor: 'ubuntu', os_version: '24.04', architecture: 'x86', deprecated: null },
          { id: 3, name: 'debian-12', description: 'Debian 12', os_flavor: 'debian', os_version: '12', architecture: 'x86', deprecated: null },
          { id: 4, name: 'fedora-40', description: 'Fedora 40', os_flavor: 'fedora', os_version: '40', architecture: 'x86', deprecated: null },
        ]);
      if (req.method === 'GET' && p === '/pricing') return send(200, { pricing: { currency: 'EUR', vat_rate: '19.00', primary_ips: [{ type: 'ipv4', prices: [price('0.5000', '0.5950', 'fsn1'), price('0.5000', '0.5950', 'nbg1')] }] } });
      if (req.method === 'POST' && p === '/servers') {
        if (tok === TOKENS.readonly) return send(403, { error: { code: 'forbidden', message: 'insufficient permissions' } });
        if (tok === TOKENS.quota) return send(403, { error: { code: 'resource_limit_exceeded', message: 'server limit reached' } });
        const s: FakeServer = { id: nextId++, name: body.name, status: 'initializing', ip: st.ip, body };
        st.servers.set(s.id, s);
        if (st.createThenFail) return send(503, { error: { code: 'unavailable', message: 'gateway timeout' } });
        return send(201, { server: view(s), action: { id: 1, status: 'running' }, root_password: ROOT_PASSWORD });
      }
      if (req.method === 'GET' && p === '/servers') return one('servers', [...st.servers.values()].filter((s) => !url.searchParams.get('name') || s.name === url.searchParams.get('name')).map(view));
      const m = p.match(/^\/servers\/(\d+)(?:\/actions\/(\w+))?$/);
      if (m) {
        const s = st.servers.get(Number(m[1]));
        if (!s) return send(404, { error: { code: 'not_found', message: 'server not found' } });
        if (req.method === 'GET' && !m[2]) return send(200, { server: view(s) });
        if (req.method === 'DELETE' && !m[2]) {
          st.servers.delete(s.id);
          return send(200, { action: { id: 9, status: 'running' } });
        }
        if (req.method === 'POST' && m[2]) {
          if (m[2] === 'shutdown' || m[2] === 'poweroff') s.status = 'off';
          if (m[2] === 'poweron') s.status = 'running';
          return send(201, { action: { id: 7, command: m[2], status: 'running' } });
        }
      }
      send(404, { error: { code: 'not_found', message: 'no such route' } });
    });
  });
  const view = (s: FakeServer) => ({ id: s.id, name: s.name, status: s.status, public_net: { ipv4: { ip: s.ip }, ipv6: { ip: '2a01:4f8::/64' } } });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  st.url = `http://127.0.0.1:${(srv.address() as any).port}`;
  st.close = () => new Promise((r) => srv.close(() => r()));
  return st;
}

function cloudOf(t: TestApp, fake: FakeHetzner): CloudVmService {
  const c = svcOf(t).cloud!;
  c.providers.hetzner = new HetznerProvider({ baseUrl: fake.url });
  c.allowPrivateIps = true; // the fake hands out 127.0.0.1; production refuses that (see the test below)
  c.pollMs = 30;
  return c;
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 15_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timeout waiting for ${what}`);
}

const userDataOf = (fake: FakeHetzner) => String(fake.reqs.filter((r) => r.method === 'POST' && r.path === '/servers').pop()?.body?.user_data || '');

/** Every unencrypted OpenSSH ed25519 key starts with the same base64 line (format header): only the rest is secret. */
const COMMON = new Set([...genKeyPair('a').private.split('\n'), ...genKeyPair('b').private.split('\n')].filter((l, i, all) => all.indexOf(l) !== i));
const secretLines = (key: string) => key.split('\n').filter((l) => l.length > 20 && !l.startsWith('-----') && !COMMON.has(l));

// ---------------- unit ----------------

test('cloud-vm: cloud-init pins TeamBot\'s own host key, one user without sudo, no passwords; estimate and defaults', () => {
  const host = genKeyPair('teambot-host');
  const client = genKeyPair('teambot-ag_x');
  assert.equal(host.fingerprint, fpOf(host.public));
  for (let i = 0; i < 30; i++) assert.match(genKeyPair('x').private, /BEGIN OPENSSH PRIVATE KEY/); // generator retries bad keys
  const ud = buildCloudInit({ hostKey: host, clientPublicKey: client.public, docker: true, label: 'Bot\nmet regel' });
  assert.ok(ud.startsWith('#cloud-config\n'));
  const cfg = YAML.parse(ud);
  assert.equal(cfg.ssh_deletekeys, true);
  assert.deepEqual(cfg.ssh_genkeytypes, []);
  assert.equal(cfg.ssh_keys.ed25519_public, host.public);
  assert.equal(cfg.ssh_keys.ed25519_private.trim(), host.private.trim());
  assert.equal(cfg.ssh_pwauth, false);
  assert.equal(cfg.disable_root, true);
  assert.equal(cfg.users.length, 1);
  assert.equal(cfg.users[0].name, 'teambot');
  assert.equal(cfg.users[0].lock_passwd, true);
  assert.equal(cfg.users[0].sudo, undefined, 'no sudo');
  assert.deepEqual(cfg.users[0].ssh_authorized_keys, [client.public]);
  assert.deepEqual(cfg.users[0].groups, ['docker']);
  assert.deepEqual(cfg.packages, ['docker.io']);
  assert.match(cfg.write_files[0].content, /PasswordAuthentication no/);
  assert.match(cfg.write_files[0].content, /PermitRootLogin no/);
  assert.match(cfg.write_files[0].content, /AllowUsers teambot/);
  assert.ok(cfg.runcmd.some((c: string) => /passwd -l root/.test(c)));
  assert.ok(cfg.runcmd.some((c: string) => /169\.254\.169\.254.*uid-owner teambot/.test(c)), 'metadata blocked for the bot user');
  assert.ok(cfg.runcmd.some((c: string) => /rm -f .*user-data\.txt/.test(c)) && cfg.runcmd.some((c: string) => /systemd-run --on-active/.test(c)), 'user data copies removed after boot');
  assert.ok(secretLines(client.private).length >= 3);
  for (const l of secretLines(client.private)) assert.equal(ud.includes(l), false, 'the client private key is never in the user data');
  assert.equal((ud.match(/PRIVATE KEY-----/g) || []).length, 2, 'exactly one private key (the host key: BEGIN + END)');
  const noDocker = YAML.parse(buildCloudInit({ hostKey: host, clientPublicKey: client.public, docker: false, label: 'b' }));
  assert.equal(noDocker.users[0].groups, undefined);
  assert.equal(noDocker.packages, undefined);

  const o = {
    currency: 'EUR',
    locations: [{ name: 'ash', description: '', city: '', country: 'US' }, { name: 'fsn1', description: '', city: '', country: 'DE' }],
    types: [
      { name: 'cpx11', description: '', cores: 2, memoryGb: 2, diskGb: 40, architecture: 'x86', prices: { fsn1: { monthlyNet: 4.35, monthlyGross: 5.18, hourlyGross: 0.0071 } } },
      { name: 'cx22', description: '', cores: 2, memoryGb: 4, diskGb: 40, architecture: 'x86', prices: { fsn1: { monthlyNet: 3.79, monthlyGross: 4.5101, hourlyGross: 0.0062 } } },
    ],
    images: [{ name: 'debian-12', description: '' }, { name: 'ubuntu-24.04', description: '' }],
    ipv4: { fsn1: { monthlyNet: 0.5, monthlyGross: 0.595, hourlyGross: 0.0008 } },
  };
  assert.deepEqual(defaultChoice(o), { location: 'fsn1', serverType: 'cx22', image: 'ubuntu-24.04' });
  const e = estimate(o, 'cx22', 'fsn1')!;
  assert.equal(e.totalMonthlyGross, 5.11);
  assert.equal(e.confirm, '5.11');
  assert.equal(e.ipv4MonthlyGross, 0.6);
  assert.equal(estimate(o, 'cx22', 'ash'), null, 'not offered there');
});

// ---------------- integration ----------------

test('cloud-vm: create with a pinned host key (no TOFU), tools work at once, power off/on, delete; secrets never leak', { skip: SKIP_NO_BASH, timeout: 120_000 }, async () => {
  const fake = await startFakeHetzner();
  const t = await startTestApp();
  let ssh: FakeSsh | null = null;
  const events: string[] = [];
  const unsub = t.app.ctx.events.subscribe((e) => events.push(JSON.stringify(e)));
  const responses: string[] = [];
  const call = async (m: string, p: string, b?: any) => {
    const r = await t.api(m, p, b);
    responses.push(JSON.stringify(r));
    return r;
  };
  try {
    const cloud = cloudOf(t, fake);
    const a = await t.agent({ tool_groups: ['files'] });

    // token: refused ones produce clear Dutch messages and are not stored
    assert.deepEqual((await call('GET', '/computers/cloud/providers')).map((p: any) => [p.id, p.has_token, p.allowed]), [['hetzner', false, true], ['digitalocean', false, true]]);
    await assert.rejects(t.api('PUT', '/computers/cloud/hetzner/token', { token: 'hcloud-fout' }), /Hetzner weigert de API-token/);
    await assert.rejects(t.api('PUT', '/computers/cloud/hetzner/token', { token: TOKENS.slow }), /429.*over 120 seconden opnieuw/);
    assert.equal((await call('PUT', '/computers/cloud/hetzner/token', { token: TOKENS.rate })).has_token, true, 'a short Retry-After is waited out automatically');
    assert.equal((await call('PUT', '/computers/cloud/hetzner/token', { token: TOKENS.good })).has_token, true);
    assert.equal((await call('GET', '/computers/cloud/providers'))[0].has_token, true);

    // options from the API (all pages), without deprecated types, ARM or other OS images
    const o = await call('GET', '/computers/cloud/hetzner/options');
    assert.deepEqual(o.types.map((x: any) => x.name).sort(), ['cax11', 'cpx11', 'cx22']);
    assert.deepEqual(o.images.map((x: any) => x.name), ['ubuntu-24.04', 'ubuntu-22.04', 'debian-12']);
    assert.deepEqual(o.defaults, { location: 'nbg1', serverType: 'cx22', image: 'ubuntu-24.04' });
    const est = await call('GET', '/computers/cloud/hetzner/estimate?type=cx22&location=nbg1');
    assert.equal(est.confirm, '5.11');
    assert.equal(est.ipv4MonthlyGross, 0.6);

    // create: the cost has to be confirmed (current price)
    const body = { provider: 'hetzner', server_type: 'cx22', location: 'nbg1', image: 'ubuntu-24.04', docker: false };
    await assert.rejects(t.api('POST', `/computers/${a.id}/cloud`, body), /409.*Bevestig eerst de kosten/);
    await assert.rejects(t.api('POST', `/computers/${a.id}/cloud`, { ...body, confirmCost: '4.51' }), /409/);
    await assert.rejects(t.api('POST', `/computers/${a.id}/cloud`, { ...body, location: 'ash', confirmCost: '5.11' }), /niet beschikbaar op deze locatie/);
    const vm = await call('POST', `/computers/${a.id}/cloud`, { ...body, confirmCost: '5.11' });
    assert.equal(vm.status, 'creating');
    assert.match(vm.name, /^teambot-testbot-[a-z0-9]{4}$/);
    await assert.rejects(t.api('POST', `/computers/${a.id}/cloud`, { ...body, confirmCost: '5.11' }), /409.*al een cloud-VM/);

    // what went to Hetzner: our cloud-init, no provider SSH keys, no token or client private key in the user data
    const post = fake.reqs.find((r) => r.method === 'POST' && r.path === '/servers')!;
    assert.equal(post.auth, TOKENS.good);
    assert.equal(post.body.ssh_keys, undefined, 'no provider SSH keys (they would give root access)');
    assert.deepEqual([post.body.server_type, post.body.location, post.body.image, post.body.labels['managed-by']], ['cx22', 'nbg1', 'ubuntu-24.04', 'teambot']);
    const ud = userDataOf(fake);
    const cfg = YAML.parse(ud);
    const hostPrivate = cfg.ssh_keys.ed25519_private;
    const clientPublic = cfg.users[0].ssh_authorized_keys[0];
    assert.equal(fpOf(cfg.ssh_keys.ed25519_public), vm.host_fingerprint, 'the pinned fingerprint is that of the generated host key');
    for (const tk of Object.values(TOKENS)) assert.equal(ud.includes(tk), false, 'no API token in the user data');
    const clientPrivate = t.app.ctx.secrets.getByName(a.user_id, `cloudvm-key:${vm.id}`)!;
    assert.match(clientPrivate, /BEGIN OPENSSH PRIVATE KEY/);
    for (const line of secretLines(clientPrivate)) assert.equal(ud.includes(line), false, 'no client private key in the user data');
    const hostLines = secretLines(hostPrivate);

    // before the VM is up the tools say so honestly
    const tc = toolCtx(t, a.id);
    const early = await callTool(t, 'remote_exec', { command: 'echo te-vroeg' }, tc);
    assert.equal(early.isError, true);
    assert.match(early.text, /wordt nog aangemaakt/);
    assert.equal((await call('GET', `/computers/${a.id}/cloud`)).vm.status, 'creating');

    // the VM boots: an SSH server with exactly the host key and the authorized key from the cloud-init
    const home = fs.mkdtempSync(path.join(t.dir, 'vm-home-'));
    ssh = await startSsh({ home, username: 'teambot', hostKey: hostPrivate, publicKey: clientPublic });
    assert.equal(ssh.fingerprint, vm.host_fingerprint);
    cloud.sshPort = ssh.port;
    fake.servers.get(Number(vm.provider_id))!.status = 'running';
    const ready = await waitFor('vm running', async () => {
      const r = (await t.api('GET', `/computers/${a.id}/cloud`)).vm;
      return r.status === 'running' ? r : null;
    });
    assert.equal(ready.ip, '127.0.0.1');
    assert.ok(ready.ready_at);

    // the bot's remote config points at the VM with the fingerprint already pinned: no "Vertrouwen" needed
    const st = await call('GET', `/computers/${a.id}`);
    assert.equal(st.config.mode, 'remote');
    assert.deepEqual([st.config.remote.host, st.config.remote.port, st.config.remote.username, st.config.remote.fingerprint, st.config.remote.has_secret], ['127.0.0.1', ssh.port, 'teambot', vm.host_fingerprint, true]);
    assert.ok(t.app.ctx.store.agent(a.id)!.tool_groups.includes('remote'));
    assert.equal(st.status.remote.cloud, true);
    const authBefore = ssh.auth.length;
    const ex = await callTool(t, 'remote_exec', { command: 'echo "hallo van de vm $((6*7))"' }, tc);
    assert.equal(ex.isError, false, ex.text);
    assert.match(ex.text, /hallo van de vm 42/);
    assert.ok(ssh.auth.slice(authBefore).every((x) => x.username === 'teambot' && ['none', 'publickey'].includes(x.method)), 'logged in with the generated key only');
    assert.equal(events.some((e) => e.includes('cloudvm.updated') && e.includes('"running"')), true);
    assert.ok(events.some((e) => e.includes('is klaar')), 'the user is told the VM is ready');

    // the managed SSH settings can't be changed by hand
    await assert.rejects(t.api('PUT', `/computers/${a.id}/remote/trust`, { fingerprint: 'SHA256:' + 'A'.repeat(43) }), /409.*cloud-VM/);
    await assert.rejects(t.api('PUT', `/computers/${a.id}/remote/credential`, { kind: 'password', value: 'x' }), /409/);
    await assert.rejects(t.api('PUT', `/computers/${a.id}/config`, { remote: { host: '10.0.0.1' } }), /409/);
    assert.equal((await t.api('PUT', `/computers/${a.id}/config`, { remote: { limits: { timeoutSec: 30 } } })).config.remote.limits.timeoutSec, 30, 'limits stay editable');

    // the list shows it with its cost (Computers page)
    const list = await call('GET', '/computers/cloud/vms');
    assert.equal(list.length, 1);
    assert.equal(list[0].price.confirm, '5.11');

    // power off → tools refuse honestly; power on → ready again
    const off = await call('POST', `/computers/cloud/vms/${vm.id}/poweroff`);
    assert.equal(off.status, 'stopping');
    assert.ok(fake.reqs.some((r) => r.method === 'POST' && r.path === `/servers/${vm.provider_id}/actions/shutdown`));
    await waitFor('vm off', async () => (await t.api('GET', `/computers/${a.id}/cloud`)).vm.status === 'off');
    const whileOff = await callTool(t, 'remote_exec', { command: 'echo x' }, tc);
    assert.equal(whileOff.isError, true);
    assert.match(whileOff.text, /staat uit/);
    await assert.rejects(t.api('POST', `/computers/cloud/vms/${vm.id}/poweroff`), /409/);
    const on = await call('POST', `/computers/cloud/vms/${vm.id}/poweron`);
    assert.equal(on.status, 'starting');
    await waitFor('vm running again', async () => (await t.api('GET', `/computers/${a.id}/cloud`)).vm.status === 'running');
    assert.equal((await callTool(t, 'remote_exec', { command: 'echo weer-aan' }, tc)).isError, false);

    // errors from the API: read-only token and quota, clear Dutch messages (on a second bot)
    const b = await t.agent({ name: 'Tweede' });
    await call('PUT', '/computers/cloud/hetzner/token', { token: TOKENS.readonly });
    await assert.rejects(t.api('POST', `/computers/${b.id}/cloud`, { ...body, confirmCost: '5.11' }), /403.*alleen leesrechten/);
    await call('PUT', '/computers/cloud/hetzner/token', { token: TOKENS.quota });
    await assert.rejects(t.api('POST', `/computers/${b.id}/cloud`, { ...body, confirmCost: '5.11' }), /403.*limiet/);
    assert.equal(t.app.ctx.store.all("SELECT * FROM secrets WHERE name LIKE 'cloudvm-key:%'").length, 1, 'no key left behind for a failed create');
    await call('PUT', '/computers/cloud/hetzner/token', { token: TOKENS.good });

    // delete: typed confirmation, then the bot no longer points at the address
    await assert.rejects(t.api('POST', `/computers/cloud/vms/${vm.id}/delete`, { confirm: 'ja' }), /Typ de naam van de VM/);
    const del = await call('POST', `/computers/cloud/vms/${vm.id}/delete`, { confirm: vm.name });
    assert.equal(del.status, 'deleting');
    assert.ok(fake.reqs.some((r) => r.method === 'DELETE' && r.path === `/servers/${vm.provider_id}`));
    await waitFor('vm deleted', async () => (await t.api('GET', `/computers/${a.id}/cloud`)).vm === null);
    const after = await call('GET', `/computers/${a.id}`);
    assert.equal(after.config.mode, 'workspace');
    assert.equal(after.config.remote.host, '');
    assert.equal(after.config.remote.fingerprint, null);
    assert.equal(t.app.ctx.secrets.getByName(a.user_id, `cloudvm-key:${vm.id}`), null);
    assert.equal(t.app.ctx.secrets.getByName(a.user_id, `remote-ssh:${a.id}`), null);
    assert.equal((await call('GET', '/computers/cloud/vms')).length, 0);
    const audits = t.app.ctx.store.all<any>("SELECT kind FROM audit WHERE kind LIKE 'cloudvm.%'").map((r) => r.kind);
    for (const k of ['cloudvm.token_set', 'cloudvm.created', 'cloudvm.ready', 'cloudvm.poweroff', 'cloudvm.poweron', 'cloudvm.deleted', 'cloudvm.create_failed']) assert.ok(audits.includes(k), k);

    // the token, the root password Hetzner returned and the private keys appear nowhere: API, export, events, database
    responses.push(JSON.stringify(await t.api('GET', '/export')));
    const tables = t.app.ctx.store.all<any>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    const dump = tables.map((n) => JSON.stringify(t.app.ctx.store.all(`SELECT * FROM "${n}"`))).join('\n');
    for (const [label, s] of [
      ['responses', responses.join('\n')],
      ['events', events.join('\n')],
      ['database', dump],
    ] as const) {
      for (const tk of Object.values(TOKENS)) assert.equal(s.includes(tk), false, `${label}: token leaked`);
      assert.equal(s.includes(ROOT_PASSWORD), false, `${label}: root password leaked`);
      for (const l of hostLines) assert.equal(s.includes(l), false, `${label}: host private key leaked`);
      for (const l of secretLines(clientPrivate)) assert.equal(s.includes(l), false, `${label}: client key leaked`);
    }
  } finally {
    unsub();
    await t.close();
    await ssh?.close();
    await fake.close();
  }
});

test('cloud-vm: deleting the bot keeps its VM (never silently deleted) and tells the user', { timeout: 60_000 }, async () => {
  const fake = await startFakeHetzner();
  const t = await startTestApp();
  try {
    cloudOf(t, fake);
    const events: any[] = [];
    const unsub = t.app.ctx.events.subscribe((e) => events.push(e));
    const a = await t.agent({ name: 'Weg' });
    await t.api('PUT', '/computers/cloud/hetzner/token', { token: TOKENS.good });
    const vm = await t.api('POST', `/computers/${a.id}/cloud`, { provider: 'hetzner', server_type: 'cx22', location: 'fsn1', image: 'debian-12', docker: true, confirmCost: '5.11' });
    assert.equal(YAML.parse(userDataOf(fake)).packages[0], 'docker.io');
    await t.api('DELETE', `/agents/${a.id}`);
    const list = await t.api('GET', '/computers/cloud/vms');
    assert.equal(list.length, 1);
    assert.equal(list[0].id, vm.id);
    assert.equal(list[0].agent_id, null);
    assert.equal(list[0].agent_name, 'Weg');
    assert.ok(fake.servers.has(Number(vm.provider_id)), 'nothing was deleted at the provider');
    assert.ok(events.some((e) => e.type === 'notification' && /bestaat nog/.test(e.data.title) && /kost geld/.test(e.data.body)));
    unsub();
    // it can still be managed and deleted from the Computers page
    await t.api('POST', `/computers/cloud/vms/${vm.id}/delete`, { confirm: vm.name });
    await waitFor('deleted', async () => (await t.api('GET', '/computers/cloud/vms')).length === 0);
    assert.equal(fake.servers.size, 0);

    // a create whose answer is lost (503 after the server was made) still tracks the server: it costs money
    fake.createThenFail = true;
    const b = await t.agent({ name: 'Zoek' });
    const found = await t.api('POST', `/computers/${b.id}/cloud`, { provider: 'hetzner', server_type: 'cx22', location: 'fsn1', image: 'debian-12', confirmCost: '5.11' });
    assert.equal(found.status, 'creating');
    assert.equal(Number(found.provider_id), [...fake.servers.keys()][0]);
    assert.ok(fake.reqs.some((r) => r.method === 'GET' && r.path.startsWith('/servers?name=')));
    fake.createThenFail = false;
  } finally {
    await t.close();
    await fake.close();
  }
});

test('cloud-vm: production refuses a non-public VM address; members need the owner\'s permission', { timeout: 60_000 }, async () => {
  const fake = await startFakeHetzner();
  const t = await startTestApp({ mode: 'server' });
  try {
    const cloud = cloudOf(t, fake);
    cloud.allowPrivateIps = false; // production behaviour
    await t.api('PUT', '/computers/cloud/hetzner/token', { token: TOKENS.good });
    const a = await t.agent();
    const vm = await t.api('POST', `/computers/${a.id}/cloud`, { provider: 'hetzner', server_type: 'cx22', location: 'nbg1', image: 'ubuntu-24.04', confirmCost: '5.11' });
    fake.servers.get(Number(vm.provider_id))!.status = 'running';
    const bad = await waitFor('error', async () => {
      const r = (await t.api('GET', `/computers/${a.id}/cloud`)).vm;
      return r.status === 'error' ? r : null;
    });
    assert.match(bad.detail, /geen openbaar IPv4-adres/);
    assert.notEqual(t.app.ctx.store.agent(a.id)!.tool_groups.includes('remote'), true, 'the bot is not pointed at it');
    // the VM still exists (and costs money): it is listed and can be deleted
    assert.equal((await t.api('GET', '/computers/cloud/vms')).length, 1);

    // members: off by default
    const member = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid@example.com', password: 'wachtwoord123', role: 'member' });
    const tok = t.app.ctx.auth.createSession(member.id).token;
    const mb = (await asUser(t, tok, 'POST', '/agents', { name: 'Ledenbot' })).body;
    const prov = await asUser(t, tok, 'GET', '/computers/cloud/providers');
    assert.equal(prov.body[0].allowed, false);
    assert.match(prov.body[0].reason, /staan op deze server uit voor leden/);
    assert.equal((await asUser(t, tok, 'PUT', '/computers/cloud/hetzner/token', { token: TOKENS.good })).status, 403);
    assert.equal((await asUser(t, tok, 'GET', '/computers/cloud/hetzner/options')).status, 403);
    assert.equal((await asUser(t, tok, 'POST', `/computers/${mb.id}/cloud`, { provider: 'hetzner', server_type: 'cx22', location: 'nbg1', image: 'ubuntu-24.04', confirmCost: '5.11' })).status, 403);
    // members never see or manage someone else's VM
    assert.equal((await asUser(t, tok, 'GET', '/computers/cloud/vms')).body.length, 0);
    assert.equal((await asUser(t, tok, 'POST', `/computers/cloud/vms/${vm.id}/poweroff`)).status, 404);
    assert.equal((await asUser(t, tok, 'POST', `/computers/cloud/vms/${vm.id}/delete`, { confirm: vm.name })).status, 404);
    // the owner allows it: then with the member's own token (the owner's token is not shared)
    await t.api('PUT', '/admin/member-policy', { allowCloudVm: true });
    assert.equal((await asUser(t, tok, 'GET', '/computers/cloud/providers')).body[0].has_token, false);
    assert.equal((await asUser(t, tok, 'GET', '/computers/cloud/hetzner/options')).status, 400);
    assert.equal((await asUser(t, tok, 'PUT', '/computers/cloud/hetzner/token', { token: TOKENS.good })).status, 200);
    assert.equal((await asUser(t, tok, 'GET', '/computers/cloud/hetzner/options')).status, 200);
    await t.api('POST', `/computers/cloud/vms/${vm.id}/delete`, { confirm: vm.name });
  } finally {
    await t.close();
    await fake.close();
  }
});
