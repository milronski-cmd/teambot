import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { startTestApp } from './helpers.js';
import { CATALOG, type CatalogEntry, catalogEntry } from '../server/modules/mcp/catalog.js';
import { oneClick } from '../server/modules/mcp/api.js';
import { ownAppNeeded } from '../server/modules/mcp/oauth.js';
import { bareSystemPath, fakeNpm, serve, withPath } from './toolchain-fixture.js';
import { sri } from './runtime-fixture.js';

/**
 * One click in Apps (POST /mcp/quick): an app that needs no account is made for every bot, tested, and its tools are
 * there for the bots from their next turn; an npx app on a PC without Node gets TeamBot's own npx on the way.
 */

process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';
const FIXTURE = path.resolve('tests/mcp-fixture-server.ts');
const TSX = import.meta.resolve('tsx');

/** A catalogue app for this test only (the real catalogue reaches the internet). */
function addEntry(e: Partial<CatalogEntry> & { id: string }) {
  const base = catalogEntry('fetch')!;
  CATALOG.splice(CATALOG.length - 1, 0, { ...base, env: undefined, headers: undefined, argsPrompt: undefined, name: e.id, ...e } as CatalogEntry);
  return () => CATALOG.splice(CATALOG.findIndex((x) => x.id === e.id), 1);
}

const mcpTools = async (t: Awaited<ReturnType<typeof startTestApp>>, agentId: string) => {
  const th = await t.api('POST', '/threads', { agentId });
  return (await t.app.ctx.tools.forAgent(t.app.ctx.store.agent(agentId)!, t.app.ctx.store.thread(th.id)!)).filter((x) => x.name.startsWith('mcp_')).map((x) => x.name);
};

test('catalogue: each app says what one click does', async () => {
  assert.equal(oneClick(catalogEntry('fetch')!), 'connect');
  assert.equal(oneClick(catalogEntry('context7')!), 'connect');
  assert.equal(oneClick(catalogEntry('filesystem')!), 'connect');
  assert.equal(oneClick(catalogEntry('notion')!), 'login');
  assert.equal(oneClick(catalogEntry('github')!), 'form');
  assert.equal(oneClick(catalogEntry('slack')!), 'form');
  assert.equal(oneClick(catalogEntry('custom')!), 'form');
  const t = await startTestApp();
  try {
    const cat = await t.api('GET', '/mcp/catalog');
    const fetchApp = cat.find((e: any) => e.id === 'fetch');
    assert.equal(fetchApp.oneClick, 'connect');
    assert.equal(fetchApp.runtime, 'uv');
    assert.equal(cat.find((e: any) => e.id === 'notion').oneClick, 'login');
  } finally {
    await t.close();
  }
});

test('one click: an app without account is made for every bot, tested, and the bots have its tools next turn; removing it removes it for all', async () => {
  const drop = addEntry({ id: 't-local', transport: 'stdio', command: process.execPath, args: ['--import', TSX, FIXTURE], auth: 'none' });
  const t = await startTestApp();
  try {
    const a = await t.agent({ name: 'Een' });
    const b = await t.agent({ name: 'Twee' });
    const r = await t.api('POST', '/mcp/quick', { catalog_id: 't-local' });
    assert.equal(r.ok, true, r.error);
    assert.ok(r.connection.counts.total > 0);
    assert.deepEqual([...r.connection.agents].sort(), [a.id, b.id].sort());
    for (const id of [a.id, b.id]) assert.ok((await mcpTools(t, id)).some((n) => /echo$/.test(n)), 'echo tool for every bot');
    // A bot made later gets it too (defaults.ts).
    const c = await t.agent({ name: 'Drie' });
    assert.ok((await mcpTools(t, c.id)).some((n) => /echo$/.test(n)));
    await t.api('DELETE', `/mcp/connections/${r.connection.id}`);
    for (const id of [a.id, b.id, c.id]) assert.deepEqual(await mcpTools(t, id), []);
  } finally {
    await t.close();
    drop();
  }
});

test('one click on a PC without Node: TeamBot gets its own npx first, then the app works', async () => {
  const pkg = fakeNpm();
  const srv = await serve({ '/npm.tgz': pkg });
  const drop = addEntry({ id: 't-npx', transport: 'stdio', command: 'npx', args: ['-y', 'fixture-server@1.0.0', '--import', TSX, FIXTURE], auth: 'none' });
  process.env.TEAMBOT_TOOLCHAIN_SOURCES = JSON.stringify({ node: { version: '0.0.1-fixture', url: `${srv.url}/npm.tgz`, integrity: sri(pkg) } });
  const t = await startTestApp();
  try {
    await withPath(bareSystemPath(), async () => {
      const bot = await t.agent({ name: 'Een' });
      const entry = (await t.api('GET', '/mcp/catalog')).find((e: any) => e.id === 't-npx');
      assert.equal(entry.commandFound, false, 'npx is not on this PC');
      assert.equal(entry.runtime, 'node');
      // Made by hand before Node is there: the test names what is missing instead of a crash loop.
      const hand = await t.api('POST', '/mcp/connections', { catalog_id: 't-npx', trust_command: true, agentIds: [bot.id] });
      const before = await t.api('POST', `/mcp/connections/${hand.id}/test`, {});
      assert.equal(before.ok, false);
      assert.equal(before.needsRuntime, 'node');
      assert.match(before.error, /Installeren/);
      const progress: string[] = [];
      const off = t.app.ctx.events.on('mcp.runtime', (e: any) => progress.push(e.data?.phase));
      const r = await t.api('POST', '/mcp/quick', { catalog_id: 't-npx' });
      off();
      assert.equal(r.ok, true, r.error);
      assert.ok(r.connection.counts.total > 0);
      assert.ok(progress.includes('done'), progress.join(','));
      assert.equal((await t.api('GET', '/mcp/runtimes/node')).source, 'teambot');
      assert.equal((await t.api('GET', '/mcp/catalog')).find((e: any) => e.id === 't-npx').commandFound, true);
      // The connection made before works now too.
      assert.equal((await t.api('POST', `/mcp/connections/${hand.id}/test`, {})).ok, true);
      assert.ok((await mcpTools(t, bot.id)).some((n) => /echo$/.test(n)));
    });
  } finally {
    delete process.env.TEAMBOT_TOOLCHAIN_SOURCES;
    await t.close();
    await srv.close();
    drop();
  }
});

test('one click asks for the form when the app needs a key or an own OAuth app; nothing half-made stays', async () => {
  const t = await startTestApp();
  try {
    assert.deepEqual(await t.api('POST', '/mcp/quick', { catalog_id: 'github' }), { needs: 'form' });
    assert.deepEqual(await t.api('POST', '/mcp/quick', { catalog_id: 'hubspot' }), { needs: 'form' });
    assert.equal((await t.api('GET', '/mcp/connections')).length, 0);
  } finally {
    await t.close();
  }
});

test('a service without automatic registration: a short, true answer instead of a technical one', () => {
  const conn = (catalog_id: string, name: string) => ({ id: 'mcp_x', catalog_id, name, label: '', transport: 'http' }) as any;
  const redirect = 'http://127.0.0.1:4747/api/public/mcp/oauth/callback';
  const hub = ownAppNeeded(conn('hubspot', 'HubSpot (CRM)'), redirect);
  assert.match(hub, /^HubSpot \(CRM\) laat apps zoals TeamBot zich niet zelf aanmelden/);
  assert.match(hub, /eigen app bij HubSpot/);
  assert.ok(hub.includes(redirect));
  assert.match(hub, /Apps › HubSpot \(CRM\) › Inloggen/);
  const gmail = ownAppNeeded(conn('google-gmail', 'Gmail (Google)'), redirect);
  assert.match(gmail, /client-ID en het clientgeheim/);
  assert.match(gmail, /kaart Google bovenaan Apps/);
  assert.doesNotMatch(ownAppNeeded(conn('slack', 'Slack'), redirect), /kaart Google/);
});
