import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startTestApp } from './helpers.js';
import { checkAll } from '../server/modules/mcp/health.js';
import { mcpManager } from '../server/modules/mcp/index.js';

/**
 * The daily check of the apps: it calls the read tool each app was tested with, approves nothing, writes a failure on
 * the app and notifies once per app (coalesced), and clears the error when the app works again.
 */
const TOKEN = 'fe-test-token-1234567890';

async function fakeForwardEmail() {
  let up = true;
  const server = http.createServer((req, res) => {
    const json = (code: number, v: any) => (res.writeHead(code, { 'content-type': 'application/json' }), res.end(JSON.stringify(v)));
    if (!up) return json(401, { statusCode: 401, error: 'Unauthorized', message: 'Invalid API token.' });
    const p = new URL(req.url || '/', 'http://x').pathname;
    if (p === '/v1/account') return json(200, { id: 'u1', email: 'eigenaar@voorbeeld.nl' });
    if (p === '/v1/domains') return json(200, [{ id: 'd1', name: 'voorbeeld.nl', has_mx_record: true, has_txt_record: true, has_dkim_record: true }]);
    json(404, { message: 'nee' });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, setUp: (v: boolean) => (up = v), close: () => new Promise<void>((r) => server.close(() => r())) };
}

test('daily app check: calls the tested read tool, approves nothing, notifies a failure once and clears it again', async () => {
  const f = await fakeForwardEmail();
  process.env.TEAMBOT_FORWARDEMAIL_BASE = f.base;
  const t = await startTestApp({ mode: 'desktop' });
  try {
    const s = await t.api('PUT', '/mcp/forwardemail', { token: TOKEN });
    const id = s.connection.id;
    await t.api('POST', `/mcp/connections/${id}/test`, { tool: 'forwardemail_domains' });
    const store = t.app.ctx.store;
    // A tool that changed since: the daily check must leave it waiting for the owner.
    store.exec('UPDATE mcp_tools SET approved = 0, changed = 1 WHERE connection_id = ? AND name = ?', id, 'forwardemail_aliases');
    const mgr = mcpManager(t.app.ctx)!;

    const ok = await checkAll(t.app.ctx, mgr);
    const mine = ok.find((r) => r.id === id)!;
    assert.equal(mine.ok, true);
    assert.equal(mine.tool, 'forwardemail_domains');
    assert.equal(store.one<any>('SELECT approved FROM mcp_tools WHERE connection_id = ? AND name = ?', id, 'forwardemail_aliases').approved, 0, 'nothing approved');
    const calls = () => store.all<any>("SELECT * FROM mcp_calls WHERE connection_id = ? AND kind = 'health'", id);
    assert.equal(calls().length, 1);

    f.setUp(false);
    await checkAll(t.app.ctx, mgr);
    await checkAll(t.app.ctx, mgr);
    const c = store.one<any>('SELECT last_error FROM mcp_connections WHERE id = ?', id);
    assert.ok(c.last_error, 'the error is on the app');
    const notes = store.all<any>('SELECT * FROM notifications WHERE ref = ?', `mcp-health:${id}`);
    assert.equal(notes.length, 1, 'one line per app');
    assert.equal(notes[0].count, 2);
    assert.match(notes[0].title, /werkt niet meer/);
    assert.equal(notes[0].important, 1);

    f.setUp(true);
    await checkAll(t.app.ctx, mgr);
    assert.equal(store.one<any>('SELECT last_error FROM mcp_connections WHERE id = ?', id).last_error, null, 'cleared when it works again');
  } finally {
    await t.close();
    await f.close();
    delete process.env.TEAMBOT_FORWARDEMAIL_BASE;
  }
});
