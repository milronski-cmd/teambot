// Run in a fresh process (tests/network-proxy.test.ts, bundled as CommonJS and run with plain node): undici's global
// dispatchers do not exist yet, as in a CommonJS host such as Electron's main process at startup (an ESM default import
// of node:http touches its lazy WebSocket export, which starts undici). Applying the proxy must still keep loopback and
// the no-proxy list direct and send other hosts via the proxy.
import http from 'node:http';
import net from 'node:net';
import { applyProxy, makeUpstream } from '../../server/modules/network/proxy.js';

async function main() {
const seen: string[] = [];
const target = http.createServer((req, res) => res.end(`doel ${req.headers.host}`));
await new Promise<void>((r) => target.listen(0, '127.0.0.1', r));
const tport = (target.address() as net.AddressInfo).port;
const direct = new http.Agent();
const proxy = http.createServer((req, res) => {
  seen.push(req.url || '');
  const u = new URL(req.url || '');
  http.get({ agent: direct, host: '127.0.0.1', port: tport, path: u.pathname, headers: req.headers }, (r) => (res.writeHead(r.statusCode || 502, r.headers), r.pipe(res)));
});
proxy.on('connect', (req, sock: net.Socket) => {
  seen.push('CONNECT ' + req.url);
  const up = net.connect(tport, '127.0.0.1', () => (sock.write('HTTP/1.1 200 OK\r\n\r\n'), up.pipe(sock), sock.pipe(up)));
});
await new Promise<void>((r) => proxy.listen(0, '127.0.0.1', r));
const before = { s1: typeof (globalThis as any)[Symbol.for('undici.globalDispatcher.1')], s2: typeof (globalThis as any)[Symbol.for('undici.globalDispatcher.2')] };
const r = applyProxy(makeUpstream({ url: `http://127.0.0.1:${(proxy.address() as net.AddressInfo).port}`, noProxy: ['10.0.0.0/8'], browser: true }));
const loop = await (await fetch(`http://127.0.0.1:${tport}/lokaal`)).text();
const afterLoop = seen.length;
const via = await (await fetch('http://via.proxy.test/x')).text();
// on the no-proxy list as CIDR (Node's own NO_PROXY for fetch knows no CIDR): must be tried directly, never via the proxy
await fetch('http://10.255.255.1:9/', { signal: AbortSignal.timeout(400) }).catch(() => {});
console.log(JSON.stringify({ before, applied: r.applied, loop, afterLoop, via, seen }));
applyProxy(null);
proxy.close();
target.close();
process.exit(0);
}
main();
