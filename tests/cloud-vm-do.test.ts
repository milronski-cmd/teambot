process.env.TEAMBOT_BROWSER_HEADLESS_ONLY = '1';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import YAML from 'yaml';
import { startTestApp, type TestApp } from './helpers.js';
import { SKIP_NO_BASH, asUser, callTool, fpOf, startSsh, svcOf, toolCtx, type FakeSsh } from './ssh-fixture.js';
import { DigitalOceanProvider, doError, vmTag } from '../server/modules/browser/cloudvm/digitalocean.js';
import { genKeyPair } from '../server/modules/browser/cloudvm/cloudinit.js';
import type { CloudVmService } from '../server/modules/browser/cloudvm/service.js';

/**
 * CMP-07 Cloud-VM, second provider: DigitalOcean (droplets, incl. GPU sizes) against a fake API v2 (node:http) that
 * records every request. The droplet "boots" as the in-process ssh2 server with the host key from TeamBot's cloud-init.
 */

const TOKENS = { good: 'dop_v1_GOOD-geheim-a1b2c3d4', readonly: 'dop_v1_READONLY-token', quota: 'dop_v1_QUOTA-token', nogpu: 'dop_v1_NOGPU-token', rate: 'dop_v1_RATE-token', slow: 'dop_v1_SLOW-token' };

interface Droplet {
  id: number;
  name: string;
  status: string;
  tags: string[];
  body: any;
}

interface FakeDo {
  url: string;
  reqs: { method: string; path: string; auth: string; body: any }[];
  droplets: Map<number, Droplet>;
  ip: string;
  createThenFail: boolean;
  close(): Promise<void>;
}

async function startFakeDo(): Promise<FakeDo> {
  const st: FakeDo = { url: '', reqs: [], droplets: new Map(), ip: '127.0.0.1', createThenFail: false, close: async () => {} };
  let nextId = 900_001;
  let rateHits = 0;
  const view = (d: Droplet) => ({
    id: d.id,
    name: d.name,
    status: d.status,
    tags: d.tags,
    networks: d.status === 'new' ? { v4: [], v6: [] } : { v4: [{ ip_address: '10.110.0.5', type: 'private' }, { ip_address: st.ip, type: 'public' }], v6: [{ ip_address: '2a03:b0c0::1', type: 'public' }] },
  });
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
        res.end(obj === undefined ? '' : JSON.stringify(obj));
      };
      if (!Object.values(TOKENS).includes(tok)) return send(401, { id: 'unauthorized', message: 'Unable to authenticate you' });
      if (tok === TOKENS.slow) return send(429, { id: 'too_many_requests', message: 'API Rate limit exceeded.' }, { 'ratelimit-reset': String(Math.floor(Date.now() / 1000) + 120) });
      if (tok === TOKENS.rate && rateHits++ < 1) return send(429, { id: 'too_many_requests', message: 'API Rate limit exceeded.' }, { 'retry-after': '1' });
      const page = Number(url.searchParams.get('page') || 1);
      const list = (key: string, items: any[], more = false) => send(200, { [key]: items, links: more ? { pages: { next: `https://evil.example/v2${p}?page=${page + 1}` } } : {}, meta: { total: items.length } });
      if (req.method === 'GET' && p === '/v2/account') return send(200, { account: { droplet_limit: 10, status: 'active', email_verified: true } });
      if (req.method === 'GET' && p === '/v2/regions')
        return page === 1
          ? list('regions', [{ slug: 'ams3', name: 'Amsterdam 3', available: true }, { slug: 'fra1', name: 'Frankfurt 1', available: true }, { slug: 'sfo1', name: 'San Francisco 1', available: false }], true)
          : list('regions', [{ slug: 'nyc2', name: 'New York 2', available: true }, { slug: 'tor1', name: 'Toronto 1', available: true }]);
      if (req.method === 'GET' && p === '/v2/sizes')
        return list('sizes', [
          { slug: 's-1vcpu-1gb', memory: 1024, vcpus: 1, disk: 25, price_monthly: 6, price_hourly: 0.00893, regions: ['ams3', 'fra1', 'nyc2'], available: true, description: 'Basic' },
          { slug: 's-1vcpu-2gb', memory: 2048, vcpus: 1, disk: 50, price_monthly: 12, price_hourly: 0.01786, regions: ['ams3', 'fra1', 'nyc2', 'tor1', 'sfo1'], available: true, description: 'Basic' },
          { slug: 's-2vcpu-4gb', memory: 4096, vcpus: 2, disk: 80, price_monthly: 24, price_hourly: 0.03571, regions: ['ams3'], available: false, description: 'Basic' },
          { slug: 'gpu-h100x1-80gb', memory: 245760, vcpus: 20, disk: 720, price_monthly: 2522.88, price_hourly: 3.39, regions: ['nyc2', 'tor1'], available: true, description: 'H100 GPU - 1X', gpu_info: { count: 1, vram: { amount: 80, unit: 'gib' }, model: 'nvidia_h100' } },
        ]);
      if (req.method === 'GET' && p === '/v2/images')
        return list('images', [
          { id: 1, slug: 'ubuntu-22-04-x64', distribution: 'Ubuntu', name: '22.04 (LTS) x64', public: true, status: 'available' },
          { id: 2, slug: 'ubuntu-24-04-x64', distribution: 'Ubuntu', name: '24.04 (LTS) x64', public: true, status: 'available' },
          { id: 3, slug: 'debian-12-x64', distribution: 'Debian', name: '12 x64', public: true, status: 'available' },
          { id: 4, slug: 'fedora-40-x64', distribution: 'Fedora', name: '40 x64', public: true, status: 'available' },
        ]);
      if (req.method === 'POST' && p === '/v2/droplets') {
        if (tok === TOKENS.readonly) return send(403, { id: 'forbidden', message: 'You do not have access for the attempted action.' });
        if (tok === TOKENS.quota) return send(422, { id: 'unprocessable_entity', message: 'creating this/these droplet(s) will exceed your droplet limit' });
        if (tok === TOKENS.nogpu && /^gpu-/.test(body.size)) return send(422, { id: 'unprocessable_entity', message: 'GPU Droplets are not enabled for this account' });
        const d: Droplet = { id: nextId++, name: body.name, status: 'new', tags: body.tags || [], body };
        st.droplets.set(d.id, d);
        if (st.createThenFail) return send(503, { id: 'service_unavailable', message: 'upstream timeout' });
        return send(202, { droplet: view(d), links: { actions: [{ id: 1, rel: 'create' }] } });
      }
      if (req.method === 'GET' && p === '/v2/droplets') return list('droplets', [...st.droplets.values()].filter((d) => !url.searchParams.get('tag_name') || d.tags.includes(url.searchParams.get('tag_name')!)).map(view));
      const m = p.match(/^\/v2\/droplets\/(\d+)(\/actions)?$/);
      if (m) {
        const d = st.droplets.get(Number(m[1]));
        if (!d) return send(404, { id: 'not_found', message: 'The resource you were accessing could not be found.' });
        if (req.method === 'GET' && !m[2]) return send(200, { droplet: view(d) });
        if (req.method === 'DELETE' && !m[2]) {
          st.droplets.delete(d.id);
          return send(204, undefined);
        }
        if (req.method === 'POST' && m[2]) {
          if (body?.type === 'shutdown' || body?.type === 'power_off') d.status = 'off';
          if (body?.type === 'power_on') d.status = 'active';
          return send(201, { action: { id: 77, status: 'in-progress', type: body?.type } });
        }
      }
      send(404, { id: 'not_found', message: 'no such route' });
    });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  st.url = `http://127.0.0.1:${(srv.address() as any).port}`;
  st.close = () => new Promise((r) => srv.close(() => r()));
  return st;
}

function cloudOf(t: TestApp, fake: FakeDo): CloudVmService {
  const c = svcOf(t).cloud!;
  c.providers.digitalocean = new DigitalOceanProvider({ baseUrl: `${fake.url}/v2` });
  c.allowPrivateIps = true; // the fake hands out 127.0.0.1; production refuses that
  c.pollMs = 30;
  return c;
}

async function waitFor<T>(what: string, fn: () => Promise<T | null | undefined | false>, ms = 15_000): Promise<T> {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v as T;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`timeout waiting for ${what}`);
}

/** Every unencrypted OpenSSH ed25519 key starts with the same base64 line (format header): only the rest is secret. */
const COMMON = new Set([...genKeyPair('a').private.split('\n'), ...genKeyPair('b').private.split('\n')].filter((l, i, all) => all.indexOf(l) !== i));
const secretLines = (key: string) => key.split('\n').filter((l) => l.length > 20 && !l.startsWith('-----') && !COMMON.has(l));

// ---------------- unit ----------------

test('cloud-vm/do: error messages are Dutch and specific; the VM tag is safe', () => {
  assert.match(doError(401, { id: 'unauthorized' }).message, /DigitalOcean weigert de API-token/);
  assert.match(doError(403, { id: 'forbidden', message: 'You do not have access' }).message, /mag dit niet/);
  assert.equal(doError(422, { message: 'creating this/these droplet(s) will exceed your droplet limit' }).code, 'quota');
  assert.equal(doError(422, { message: 'GPU Droplets are not enabled for this account' }).code, 'gpu');
  assert.match(doError(429, { id: 'too_many_requests', message: 'API Rate limit exceeded.' }, 42).message, /over 42 seconden/);
  assert.equal(doError(422, { message: 'You specified an invalid size for Droplet creation.' }).code, 'unavailable');
  assert.equal(doError(503, {}).transient, true);
  assert.equal(vmTag({ 'teambot-vm': 'cvm_abc$%^' }), 'teambot-vm-cvm_abc');
});

// ---------------- integration ----------------

test('cloud-vm/do: droplet with a pinned host key, GPU sizes, power, errors, lost create, delete; token never leaks', { skip: SKIP_NO_BASH, timeout: 120_000 }, async () => {
  const fake = await startFakeDo();
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

    // tokens per provider; refused ones give clear Dutch messages
    await assert.rejects(t.api('PUT', '/computers/cloud/digitalocean/token', { token: 'dop_v1_fout' }), /DigitalOcean weigert de API-token/);
    await assert.rejects(t.api('PUT', '/computers/cloud/digitalocean/token', { token: TOKENS.slow }), /429.*over 1[12]\d seconden opnieuw/);
    assert.equal((await call('PUT', '/computers/cloud/digitalocean/token', { token: TOKENS.rate })).has_token, true, 'a short Retry-After is waited out');
    assert.equal((await call('PUT', '/computers/cloud/digitalocean/token', { token: TOKENS.good })).has_token, true);
    const provs = await call('GET', '/computers/cloud/providers');
    assert.deepEqual(provs.map((p: any) => [p.id, p.has_token]), [['hetzner', false], ['digitalocean', true]], 'each provider has its own token');
    assert.ok(fake.reqs.some((r) => r.path === '/v2/account' && r.auth === TOKENS.good));

    // options from the API: all pages (by page number, never by the "next" URL), unavailable regions/sizes left out
    const o = await call('GET', '/computers/cloud/digitalocean/options');
    assert.equal(fake.reqs.some((r) => r.path.includes('evil')), false);
    assert.deepEqual(o.locations.map((l: any) => [l.name, l.country]), [['ams3', 'NL'], ['fra1', 'DE'], ['nyc2', 'US'], ['tor1', 'CA']]);
    assert.deepEqual(o.types.map((x: any) => x.name), ['s-1vcpu-1gb', 's-1vcpu-2gb', 'gpu-h100x1-80gb']);
    const gpu = o.types.find((x: any) => x.name === 'gpu-h100x1-80gb');
    assert.equal(gpu.group, 'gpu');
    assert.deepEqual(gpu.gpu, { count: 1, model: 'nvidia h100', vramGb: 80 });
    assert.deepEqual(Object.keys(gpu.prices), ['nyc2', 'tor1'], 'GPU only where DigitalOcean offers it');
    assert.equal(o.types.find((x: any) => x.name === 's-1vcpu-2gb').prices.sfo1, undefined, 'no prices for unavailable regions');
    assert.deepEqual(o.images.map((x: any) => x.name), ['ubuntu-24-04-x64', 'ubuntu-22-04-x64', 'debian-12-x64']);
    assert.deepEqual([o.currency, o.pricesIncludeTax, o.ipv4Included], ['USD', false, true]);
    assert.deepEqual(o.defaults, { location: 'ams3', serverType: 's-1vcpu-2gb', image: 'ubuntu-24-04-x64' }, 'small, EU, never a GPU by default');
    const est = await call('GET', '/computers/cloud/digitalocean/estimate?type=s-1vcpu-2gb&location=ams3');
    assert.deepEqual([est.totalMonthlyGross, est.confirm, est.taxIncluded, est.ipv4Included, est.ipv4MonthlyGross, est.gpu], [12, '12.00', false, true, 0, false]);
    const estGpu = await call('GET', '/computers/cloud/digitalocean/estimate?type=gpu-h100x1-80gb&location=nyc2');
    assert.deepEqual([estGpu.totalMonthlyGross, estGpu.gpu, estGpu.hourlyGross], [2522.88, true, 3.39]);
    await assert.rejects(t.api('GET', '/computers/cloud/digitalocean/estimate?type=gpu-h100x1-80gb&location=ams3'), /niet beschikbaar op deze locatie/);

    // create: confirmed cost, our cloud-init, tags, no DO SSH keys, no web-console agent
    const body = { provider: 'digitalocean', server_type: 's-1vcpu-2gb', location: 'ams3', image: 'ubuntu-24-04-x64', docker: false };
    await assert.rejects(t.api('POST', `/computers/${a.id}/cloud`, body), /409.*Bevestig eerst de kosten: ongeveer USD 12.00/);
    const vm = await call('POST', `/computers/${a.id}/cloud`, { ...body, confirmCost: '12.00' });
    assert.equal(vm.provider, 'digitalocean');
    assert.equal(vm.status, 'creating');
    const post = fake.reqs.find((r) => r.method === 'POST' && r.path === '/v2/droplets')!;
    assert.equal(post.auth, TOKENS.good);
    assert.equal(post.body.ssh_keys, undefined, 'no DigitalOcean SSH keys (they would give root access)');
    assert.equal(post.body.with_droplet_agent, false);
    assert.deepEqual([post.body.region, post.body.size, post.body.image], ['ams3', 's-1vcpu-2gb', 'ubuntu-24-04-x64']);
    assert.deepEqual(post.body.tags, ['teambot', `teambot-vm-${vm.id}`]);
    const ud = String(post.body.user_data);
    const cfg = YAML.parse(ud);
    assert.equal(fpOf(cfg.ssh_keys.ed25519_public), vm.host_fingerprint, 'host key generated by TeamBot, fingerprint pinned');
    assert.equal(cfg.ssh_deletekeys, true);
    assert.ok(cfg.runcmd.some((c: string) => /169\.254\.169\.254.*uid-owner teambot/.test(c)), 'DO metadata service blocked for the bot user');
    for (const tk of Object.values(TOKENS)) assert.equal(ud.includes(tk), false, 'no token in user_data');
    const clientPrivate = t.app.ctx.secrets.getByName(a.user_id, `cloudvm-key:${vm.id}`)!;
    for (const l of secretLines(clientPrivate)) assert.equal(ud.includes(l), false, 'no client private key in user_data');
    const hostLines = secretLines(cfg.ssh_keys.ed25519_private);

    // boot: the droplet answers SSH with exactly that host key → bot works on it, no trust step
    const home = fs.mkdtempSync(path.join(t.dir, 'droplet-home-'));
    ssh = await startSsh({ home, username: 'teambot', hostKey: cfg.ssh_keys.ed25519_private, publicKey: cfg.users[0].ssh_authorized_keys[0] });
    cloud.sshPort = ssh.port;
    fake.droplets.get(Number(vm.provider_id))!.status = 'active';
    const ready = await waitFor('droplet running', async () => {
      const r = (await t.api('GET', `/computers/${a.id}/cloud`)).vm;
      return r.status === 'running' ? r : null;
    });
    assert.equal(ready.ip, '127.0.0.1', 'the public address, not the private one');
    const st = await call('GET', `/computers/${a.id}`);
    assert.deepEqual([st.config.mode, st.config.remote.username, st.config.remote.fingerprint], ['remote', 'teambot', vm.host_fingerprint]);
    const tc = toolCtx(t, a.id);
    const ex = await callTool(t, 'remote_exec', { command: 'echo "droplet $((20+22))"' }, tc);
    assert.equal(ex.isError, false, ex.text);
    assert.match(ex.text, /droplet 42/);

    // power actions via droplet actions
    await call('POST', `/computers/cloud/vms/${vm.id}/poweroff`);
    assert.ok(fake.reqs.some((r) => r.method === 'POST' && r.path === `/v2/droplets/${vm.provider_id}/actions` && r.body?.type === 'shutdown'));
    await waitFor('off', async () => (await t.api('GET', `/computers/${a.id}/cloud`)).vm.status === 'off');
    assert.match((await callTool(t, 'remote_exec', { command: 'echo x' }, tc)).text, /staat uit/);
    await call('POST', `/computers/cloud/vms/${vm.id}/poweron`);
    assert.ok(fake.reqs.some((r) => r.body?.type === 'power_on'));
    await waitFor('running again', async () => (await t.api('GET', `/computers/${a.id}/cloud`)).vm.status === 'running');

    // errors from the API on a second bot: read-only, droplet limit, GPU not enabled for the account
    const b = await t.agent({ name: 'Tweede' });
    await call('PUT', '/computers/cloud/digitalocean/token', { token: TOKENS.readonly });
    await assert.rejects(t.api('POST', `/computers/${b.id}/cloud`, { ...body, confirmCost: '12.00' }), /403.*mag dit niet/);
    await call('PUT', '/computers/cloud/digitalocean/token', { token: TOKENS.quota });
    await assert.rejects(t.api('POST', `/computers/${b.id}/cloud`, { ...body, confirmCost: '12.00' }), /400.*limiet voor droplets/);
    await call('PUT', '/computers/cloud/digitalocean/token', { token: TOKENS.nogpu });
    await assert.rejects(t.api('POST', `/computers/${b.id}/cloud`, { ...body, server_type: 'gpu-h100x1-80gb', location: 'nyc2', confirmCost: '2522.88' }), /400.*GPU-droplets zijn \(nog\) niet vrijgegeven/);
    await call('PUT', '/computers/cloud/digitalocean/token', { token: TOKENS.good });

    // a create whose answer was lost (503 after the droplet was made) is found again by its unique tag
    fake.createThenFail = true;
    const found = await call('POST', `/computers/${b.id}/cloud`, { ...body, server_type: 's-1vcpu-1gb', location: 'fra1', confirmCost: '6.00' });
    fake.createThenFail = false;
    assert.equal(found.status, 'creating');
    assert.ok(fake.reqs.some((r) => r.method === 'GET' && r.path === `/v2/droplets?tag_name=teambot-vm-${found.id}`));
    assert.ok(fake.droplets.has(Number(found.provider_id)));

    // delete (typed name); DELETE answers 204; afterwards the bot no longer points at the droplet
    await call('POST', `/computers/cloud/vms/${vm.id}/delete`, { confirm: vm.name });
    assert.ok(fake.reqs.some((r) => r.method === 'DELETE' && r.path === `/v2/droplets/${vm.provider_id}`));
    await waitFor('deleted', async () => (await t.api('GET', `/computers/${a.id}/cloud`)).vm === null);
    assert.equal((await call('GET', `/computers/${a.id}`)).config.mode, 'workspace');
    await call('POST', `/computers/cloud/vms/${found.id}/delete`, { confirm: found.name });
    await waitFor('second deleted', async () => (await t.api('GET', '/computers/cloud/vms')).length === 0);
    assert.equal(fake.droplets.size, 0);
    const audits = t.app.ctx.store.all<any>("SELECT kind FROM audit WHERE kind LIKE 'cloudvm.%'").map((r) => r.kind);
    for (const k of ['cloudvm.token_set', 'cloudvm.created', 'cloudvm.ready', 'cloudvm.poweroff', 'cloudvm.poweron', 'cloudvm.deleted', 'cloudvm.create_failed']) assert.ok(audits.includes(k), k);

    // token and private keys: never in API responses, the export, events or the database
    responses.push(JSON.stringify(await t.api('GET', '/export')));
    const tables = t.app.ctx.store.all<any>("SELECT name FROM sqlite_master WHERE type = 'table'").map((r) => r.name);
    const dump = tables.map((n) => JSON.stringify(t.app.ctx.store.all(`SELECT * FROM "${n}"`))).join('\n');
    for (const [label, s] of [
      ['responses', responses.join('\n')],
      ['events', events.join('\n')],
      ['database', dump],
    ] as const) {
      for (const tk of Object.values(TOKENS)) assert.equal(s.includes(tk), false, `${label}: token leaked`);
      for (const l of [...hostLines, ...secretLines(clientPrivate)]) assert.equal(s.includes(l), false, `${label}: private key leaked`);
    }
  } finally {
    unsub();
    await t.close();
    await ssh?.close();
    await fake.close();
  }
});

test('cloud-vm/do: members need the owner\'s permission (same flag) and use their own DigitalOcean token', { timeout: 60_000 }, async () => {
  const fake = await startFakeDo();
  const t = await startTestApp({ mode: 'server' });
  try {
    cloudOf(t, fake);
    await t.api('PUT', '/computers/cloud/digitalocean/token', { token: TOKENS.good });
    const member = t.app.ctx.auth.createUser({ name: 'Lid', email: 'lid-do@example.com', password: 'wachtwoord123', role: 'member' });
    const tok = t.app.ctx.auth.createSession(member.id).token;
    const mb = (await asUser(t, tok, 'POST', '/agents', { name: 'Ledenbot' })).body;
    assert.equal((await asUser(t, tok, 'PUT', '/computers/cloud/digitalocean/token', { token: TOKENS.good })).status, 403);
    assert.equal((await asUser(t, tok, 'GET', '/computers/cloud/digitalocean/options')).status, 403);
    assert.equal((await asUser(t, tok, 'POST', `/computers/${mb.id}/cloud`, { provider: 'digitalocean', server_type: 's-1vcpu-1gb', location: 'ams3', image: 'ubuntu-24-04-x64', confirmCost: '6.00' })).status, 403);
    await t.api('PUT', '/admin/member-policy', { allowCloudVm: true });
    const prov = (await asUser(t, tok, 'GET', '/computers/cloud/providers')).body;
    assert.equal(prov.find((p: any) => p.id === 'digitalocean').has_token, false, "the owner's token is not shared with members");
    assert.equal((await asUser(t, tok, 'PUT', '/computers/cloud/digitalocean/token', { token: TOKENS.good })).status, 200);
    assert.equal((await asUser(t, tok, 'GET', '/computers/cloud/digitalocean/options')).status, 200);
  } finally {
    await t.close();
    await fake.close();
  }
});
