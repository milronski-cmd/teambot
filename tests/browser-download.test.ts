process.env.TEAMBOT_BROWSER_HEADLESS_ONLY = '1'; // never open GUI windows in tests

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PolicyProxy } from '../server/modules/browser/proxy.js';
import { DownloadError, downloadViaProxy, fileNameFor } from '../server/modules/browser/download.js';
import type { UrlPolicy } from '../server/modules/browser/policy.js';
import { browserCandidates, realProbes } from '../server/modules/browser/capabilities.js';
import { startTestApp } from './helpers.js';
import type { ComputerService } from '../server/modules/browser/service.js';

/**
 * B-32/B-35: downloading a file by its address (also on another site, where a browser shows a picture instead of
 * downloading it) works through the bot's policy proxy, with a size limit, connect/idle timeouts, progress and stop —
 * proven against local test servers.
 */

const PNG = Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), Buffer.alloc(3000, 9)]);

function filesServer() {
  const hits: string[] = [];
  const srv = http.createServer((req, res) => {
    hits.push(req.url || '');
    const u = req.url || '';
    if (u === '/foto.png') {
      res.writeHead(200, { 'content-type': 'image/png', 'content-length': PNG.length });
      return res.end(PNG);
    }
    if (u === '/factuur') {
      res.writeHead(200, { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename*=UTF-8''Factuur%20m%C3%A4rz.pdf` });
      return res.end('%PDF-1.4\n%%EOF\n');
    }
    if (u === '/plaatje-zonder-naam') {
      res.writeHead(200, { 'content-type': 'image/jpeg' });
      return res.end(Buffer.alloc(100, 1));
    }
    if (u === '/groot.bin') {
      // declared size above the limit: refused before any body is read
      res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': 50 * 1024 * 1024 });
      res.write(Buffer.alloc(1024));
      return; // never finishes on its own
    }
    if (u === '/stroom') {
      // no length: keeps sending until the client stops
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      const t = setInterval(() => {
        if (!res.write(Buffer.alloc(64 * 1024, 2))) return;
      }, 5);
      res.on('close', () => clearInterval(t));
      return;
    }
    if (u === '/hangt') {
      res.writeHead(200, { 'content-type': 'application/zip', 'content-length': 100_000 });
      res.write(Buffer.alloc(10_000, 3));
      return; // stalls
    }
    if (u === '/stuur-door') {
      res.writeHead(302, { location: '/foto.png' });
      return res.end();
    }
    if (u.startsWith('/naar-verboden')) {
      res.writeHead(302, { location: `http://localhost:${(srv.address() as net.AddressInfo).port}/geheim` });
      return res.end();
    }
    if (u === '/weg') {
      res.writeHead(404, { 'content-type': 'text/plain' });
      return res.end('nee');
    }
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<h1>ok</h1>');
  });
  return { srv, hits };
}

async function listen(srv: http.Server | net.Server) {
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  return (srv.address() as net.AddressInfo).port;
}

test('download through the policy proxy: cross-site file, name, progress, size limit, timeouts, redirects, stop', async () => {
  const { srv, hits } = filesServer();
  const port = await listen(srv);
  // A server that accepts the connection but never answers.
  const silent = net.createServer((sock) => sock.on('error', () => {}));
  const silentPort = await listen(silent);
  const proxy = new PolicyProxy();
  await proxy.start();
  const policy: UrlPolicy = { allow: [], deny: ['localhost'], allowPrivate: true };
  let reason: string | null = null;
  const creds = proxy.register({ policy: () => policy, onBlock: (_u, why) => (reason = why) });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-dl-'));
  const base = `http://127.0.0.1:${port}`;
  const opts = (url: string, extra: Partial<Parameters<typeof downloadViaProxy>[0]> = {}) => ({ url, proxy: { port: proxy.port, ...creds }, dir, maxBytes: 1024 * 1024, blockedReason: () => reason, ...extra });
  const leftovers = () => fs.readdirSync(dir).filter((f) => f.endsWith('.deel'));
  try {
    // A picture on another site: saved as a file, quickly, with progress.
    const progress: number[] = [];
    const t0 = Date.now();
    const r = await downloadViaProxy(opts(`${base}/foto.png`, { onProgress: (n) => progress.push(n) }));
    assert.ok(Date.now() - t0 < 3000, 'no 60 s wait');
    assert.equal(r.name, 'foto.png');
    assert.deepEqual(fs.readFileSync(r.file), PNG);
    assert.equal(progress.at(-1), PNG.length);
    // Name from Content-Disposition (RFC 5987), and an extension from the type when the URL has none.
    assert.equal((await downloadViaProxy(opts(`${base}/factuur`))).name, 'Factuur märz.pdf');
    assert.equal((await downloadViaProxy(opts(`${base}/plaatje-zonder-naam`))).name, 'plaatje-zonder-naam.jpg');
    // A redirect is followed (each hop through the proxy).
    assert.equal((await downloadViaProxy(opts(`${base}/stuur-door`))).name, 'foto (1).png');

    const fails = async (url: string, code: string, re: RegExp, extra = {}) => {
      const t1 = Date.now();
      await assert.rejects(downloadViaProxy(opts(url, extra)), (e: any) => e instanceof DownloadError && e.code === code && re.test(e.message));
      return Date.now() - t1;
    };
    // Size limit: a declared size above it is refused right away; a stream without a size is cut off at the limit.
    assert.ok((await fails(`${base}/groot.bin`, 'too_big', /te groot \(50 MB; limiet 1,0 MB\)\.$/)) < 3000, 'the tool says "Niet gedownload" once, in front');
    await fails(`${base}/stroom`, 'too_big', /meer dan 1,0 MB/);
    // Stalled transfer and a silent server: clear timeouts instead of waiting forever.
    const idle = await fails(`${base}/hangt`, 'timeout', /stond 1 s stil/, { idleTimeoutMs: 1000 });
    assert.ok(idle >= 900 && idle < 4000, `idle ${idle}`);
    await fails(`http://127.0.0.1:${silentPort}/x`, 'timeout', /Geen antwoord/, { connectTimeoutMs: 700 });
    // Errors of the website in words.
    await fails(`${base}/weg`, 'http', /niet gevonden/);
    // A redirect to a denied host is blocked at the proxy; the target is never contacted.
    reason = null;
    await fails(`${base}/naar-verboden`, 'blocked', /Geblokkeerd door TeamBot/);
    assert.ok(!hits.includes('/geheim'));
    // https goes through a CONNECT tunnel, checked by the same policy.
    reason = null;
    await fails('https://localhost:9/x.zip', 'blocked', /Geblokkeerd door TeamBot/);
    // Stop (the user presses Stop): aborted at once, nothing kept.
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 300);
    await fails(`${base}/stroom`, 'aborted', /Gestopt/, { signal: ac.signal, maxBytes: 1024 ** 3 });
    assert.deepEqual(leftovers(), [], 'no partial files stay behind');
  } finally {
    proxy.unregister(creds.username);
    await proxy.stop();
    srv.closeAllConnections();
    srv.close();
    silent.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('file names are safe and sensible', () => {
  assert.equal(fileNameFor('https://x.test/a/../../etc/passwd', undefined, 'text/plain'), 'passwd.txt');
  assert.equal(fileNameFor('https://x.test/dl', 'attachment; filename="..\\\\..\\\\boot.ini"', 'text/plain'), 'boot.ini');
  assert.equal(fileNameFor('https://x.test/', undefined, 'image/png'), 'download.png');
  assert.equal(fileNameFor('https://x.test/rapport%202026.pdf?x=1', undefined, 'application/pdf'), 'rapport 2026.pdf');
});

const installed = browserCandidates(realProbes);

test('real browser: browser_download of a picture on another site (by url and by link), with limits', { skip: installed.length ? false : 'Geen Edge/Chrome/Chromium gevonden op dit apparaat' }, async () => {
  const files = filesServer();
  const filesPort = await listen(files.srv);
  // The page is on a different origin than the files (the case that timed out after 60 s).
  const page = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><title>Winkel</title><h1>Foto's</h1><a href="http://127.0.0.1:${filesPort}/foto.png">Bekijk de foto</a> <a href="http://127.0.0.1:${filesPort}/groot.bin">Groot bestand</a>`);
  });
  const pagePort = await listen(page);
  const t = await startTestApp();
  try {
    const svc: ComputerService = t.app.ctx.services.computers._service;
    const a = await t.agent({ tool_groups: ['files'] });
    await t.api('PUT', `/computers/${a.id}/config`, { mode: 'browser', allow_private: true, limits: { downloadMb: 1 } });
    const agent = t.app.ctx.store.agent(a.id)!;
    const thread = t.app.ctx.store.createThread({ user_id: agent.user_id, agent_id: agent.id });
    const run = t.app.ctx.store.createRun({ thread_id: thread.id, agent_id: agent.id, user_id: agent.user_id, status: 'running' });
    const progress: string[] = [];
    const tc: any = { ctx: t.app.ctx, agent, thread, run, userId: agent.user_id, signal: new AbortController().signal, toolCallId: 'c1', progress: (x: string) => progress.push(x) };
    const call = async (name: string, args: any) => {
      const r: any = await t.app.ctx.tools.get(name)!.run(args, { ...tc, agent: t.app.ctx.store.agent(a.id)! });
      svc.leases.releaseHolder(run.id);
      return typeof r === 'string' ? { text: r } : r;
    };
    const opened = await call('browser_open', { url: `http://127.0.0.1:${pagePort}/` });
    assert.equal(opened.isError, undefined, opened.text);
    // By url, on another site: no 60 s wait.
    const t0 = Date.now();
    const byUrl = await call('browser_download', { url: `http://127.0.0.1:${filesPort}/foto.png` });
    assert.equal(byUrl.isError, undefined, byUrl.text);
    assert.ok(Date.now() - t0 < 10_000, `took ${Date.now() - t0} ms`);
    assert.match(byUrl.text, /Gedownload naar downloads[\\/]foto\.png/);
    assert.deepEqual(fs.readFileSync(path.join(agent.workspace, 'downloads', 'foto.png')), PNG);
    assert.ok(progress.some((p) => /^Downloaden/.test(p)), progress.join(' | '));
    // By the link on the page (its ref), also cross-site.
    const snap = await call('browser_snapshot', {});
    const ref = snap.text.match(/\[(e\d+)\][^\n]*Bekijk de foto/)![1];
    const byRef = await call('browser_download', { ref });
    assert.equal(byRef.isError, undefined, byRef.text);
    assert.match(byRef.text, /foto \(1\)\.png/);
    // The limit of this bot (1 MB) is enforced: refused with the reason, nothing kept.
    const bigRef = snap.text.match(/\[(e\d+)\][^\n]*Groot bestand/)![1];
    const big = await call('browser_download', { ref: bigRef });
    assert.equal(big.isError, true);
    assert.match(big.text, /te groot \(50 MB; limiet 1,0 MB\)/);
    assert.ok(!fs.readdirSync(path.join(agent.workspace, 'downloads')).some((f) => f.startsWith('groot')));
    // The step log says what was downloaded in words (no element codes like e12).
    const acts = await t.api('GET', `/computers/${a.id}/actions`);
    const dl = acts.filter((x: any) => x.tool === 'browser_download').map((x: any) => x.summary);
    assert.ok(dl.some((s: string) => /de link “Bekijk de foto”/.test(s)), dl.join(' | '));
    assert.ok(!dl.some((s: string) => /\be\d+\b/.test(s)), dl.join(' | '));
  } finally {
    await t.close();
    files.srv.closeAllConnections();
    files.srv.close();
    page.close();
  }
});
