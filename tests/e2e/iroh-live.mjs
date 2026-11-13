// Live check of the TeamBot connection (iroh) with the real n0 relays and lookup service: a Node "phone" pairs,
// calls the API and opens the live WebSocket, first the normal way (direct where possible), then with a forced relay
// (the sockets of computer and phone bound so that no direct path exists). Prints the connection times.
//
//   npm run iroh:live                     (port 4803; TEAMBOT_LIVE_PORT=… for another)
//   npm run iroh:live -- --rounds 5       (more rounds for the median)
//
// Needs internet. Uses its own temporary data folder; nothing of an installed TeamBot is touched.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { WebSocket } from 'ws';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-iroh-live-'));
process.env.APPDATA = path.join(tmp, 'appdata');
process.env.TEAMBOT_DATA = path.join(tmp, 'data');
fs.mkdirSync(process.env.APPDATA, { recursive: true });
delete process.env.TEAMBOT_IROH_PRESET;

const { createApp } = await import('./server.mjs');
const { startIrohPhone } = await import('../iroh-phone.ts');

const args = process.argv.slice(2);
const rounds = Number(args[args.indexOf('--rounds') + 1]) || 3;
const port = Number(process.env.TEAMBOT_LIVE_PORT) || 4803;
if (port === 4747 || port === 4748) throw new Error('Poort 4747/4748 is van de geïnstalleerde TeamBot');

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const fails = [];
const fail = (m) => (fails.push(m), console.log('  FOUT: ' + m));

async function call(base, token, method, p, body) {
  const res = await fetch(base + p, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* not json */
  }
  return { status: res.status, body: json, text };
}

/** Addresses for a forced relay: the computer on the wifi IPv4 + ::1, the phone on 127.0.0.1 + a global IPv6. */
function forcedBinds() {
  const all = Object.values(os.networkInterfaces()).flat().filter(Boolean);
  const v4 = all.find((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.') && !a.address.startsWith('100.'));
  const v6 = all.find((a) => a.family === 'IPv6' && !a.internal && /^[23]/.test(a.address));
  return { pc: [`${v4?.address || '127.0.0.2'}:0`, '[::1]:0'], phone: ['127.0.0.1:0', v6 ? `[${v6.address}]:0` : '[::1]:0'], sure: !!v4 && !!v6 };
}

async function startPc(bind) {
  if (bind) process.env.TEAMBOT_IROH_BIND = bind.join(',');
  else delete process.env.TEAMBOT_IROH_BIND;
  const app = await createApp({ dataDir: process.env.TEAMBOT_DATA, port, host: '127.0.0.1', mode: 'desktop', quiet: true });
  const owner = app.ctx.auth.ensureLocalOwner();
  const api = async (method, p, body) => {
    const r = await call(app.url, owner, method, '/api' + p, body);
    if (r.status >= 400) throw new Error(`${method} ${p} → ${r.status} ${r.text}`);
    return r.body;
  };
  const t0 = Date.now();
  const reach = await api('PUT', '/mobile/iroh', { enabled: true });
  const onlineMs = Date.now() - t0;
  return { app, owner, api, reach, onlineMs };
}

async function round(pc, label, phoneOpts, target) {
  const t0 = Date.now();
  const phone = await startIrohPhone(target, { timeoutMs: 30000, ...phoneOpts });
  try {
    const hello = await call(phone.base, null, 'POST', '/api/public/mobile/hello', { device: 'abcd1234', nonce: 'n'.repeat(24) });
    const firstMs = Date.now() - t0;
    if (hello.status !== 200) fail(`${label}: hello ${hello.status}`);
    const ticket = await pc.api('POST', '/mobile/pair', { baseUrl: 'iroh' });
    const secret = new URLSearchParams(ticket.url.slice(ticket.url.indexOf('#') + 1)).get('t');
    const claim = await call(phone.base, null, 'POST', '/api/public/mobile/claim', { secret, name: `${label} ${Date.now()}`, platform: 'ios', client: 'ios-app' });
    if (claim.status !== 200) fail(`${label}: koppelen ${claim.status} ${claim.text}`);
    const token = claim.body?.token;
    const st = await call(phone.base, token, 'GET', '/api/mobile/status');
    if (st.status !== 200 || st.body?.iroh?.id !== pc.reach.iroh.id) fail(`${label}: status ${st.status}`);
    if ((await call(phone.base, pc.owner, 'GET', '/api/me')).status !== 403) fail(`${label}: eigenaar-token kwam erdoor`);
    // live WebSocket over the same link (a signed /ws URL, like the web app makes it)
    const wsUrl = phone.base.replace('http:', 'ws:') + signedPath(pc.app, token, '/ws');
    const wsOk = await new Promise((resolve) => {
      const ws = new WebSocket(wsUrl);
      const timer = setTimeout(() => (ws.terminate(), resolve(false)), 10000);
      ws.once('message', (d) => (clearTimeout(timer), ws.close(), resolve(JSON.parse(String(d)).type === 'hello')));
      ws.once('error', () => (clearTimeout(timer), resolve(false)));
    });
    if (!wsOk) fail(`${label}: WebSocket`);
    // a few small requests in a row (keep-alive over one stream)
    const t1 = Date.now();
    for (let i = 0; i < 5; i++) await call(phone.base, token, 'GET', '/api/me');
    const reqMs = Math.round((Date.now() - t1) / 5);
    await new Promise((r) => setTimeout(r, 1500));
    return { connectMs: phone.connectMs, firstMs, reqMs, path: phone.path(), rttMs: phone.rttMs() };
  } finally {
    await phone.close();
  }
}

/** The same signature the web app puts on /ws (tests/helpers.ts `signed`). */
function signedPath(app, token, p) {
  const sid = app.ctx.store.one('SELECT id FROM sessions WHERE token_hash = ?', crypto.createHash('sha256').update(token).digest('hex')).id;
  return app.ctx.auth.signUrl(sid, p);
}

function report(label, rs) {
  const paths = [...new Set(rs.map((r) => r.path))].join('/');
  console.log(
    `${label}: verbinden mediaan ${median(rs.map((r) => r.connectMs))} ms (${rs.map((r) => r.connectMs).join(', ')}), eerste antwoord mediaan ${median(rs.map((r) => r.firstMs))} ms, ` +
      `daarna ${median(rs.map((r) => r.reqMs))} ms per verzoek, pad ${paths}, rtt ${median(rs.map((r) => r.rttMs ?? 0))} ms`,
  );
}

let pc;
try {
  // 1. normal: direct where possible (on one computer: always direct)
  pc = await startPc(null);
  console.log(`pc: TeamBot-verbinding aan in ${pc.onlineMs} ms, relay ${pc.reach.iroh.relay.home}, online ${pc.reach.iroh.relay.online}`);
  if (!pc.reach.iroh.relay.online) fail('pc niet online bij de relay van n0');
  const id = pc.reach.iroh.id;
  const normal = [];
  // Only the key, like a QR code with n0 relays: the phone finds the computer through n0's lookup service.
  for (let i = 0; i < rounds; i++) normal.push(await round(pc, 'normaal', {}, { id }));
  report('normaal (alleen sleutel, n0-lookup)', normal);
  await pc.app.close();

  // 2. forced relay
  const b = forcedBinds();
  pc = await startPc(b.pc);
  console.log(`pc (geforceerde relay, sockets ${b.pc.join(' ')}): aan in ${pc.onlineMs} ms, relay ${pc.reach.iroh.relay.home}`);
  const relayed = [];
  for (let i = 0; i < rounds; i++) relayed.push(await round(pc, 'relay', { bind: b.phone }, { id, relay: pc.reach.iroh.relay.home }));
  report(`geforceerde relay (telefoon ${b.phone.join(' ')})`, relayed);
  if (relayed.some((r) => r.path !== 'relay')) (b.sure ? fail : console.log)(`relay niet afgedwongen: paden ${relayed.map((r) => r.path).join(', ')}`);
  if (pc.reach.iroh.id !== id) fail('sleutel veranderd na herstart');
} catch (e) {
  fail(String(e?.stack || e));
} finally {
  await pc?.app.close().catch(() => undefined);
  fs.rmSync(tmp, { recursive: true, force: true });
}
console.log(fails.length ? `MISLUKT (${fails.length})` : 'OK');
process.exit(fails.length ? 1 : 0);
