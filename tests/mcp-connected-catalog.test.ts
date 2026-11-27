import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';

/**
 * An app you already connected is not offered again under "Meer apps" (Apps page) and counts as "Toegevoegd" in the
 * Marktplaats; with the built-in Google login the separate Google apps (Gmail, Drive, Ads ...) count as connected too.
 */

process.env.TEAMBOT_TEST_NO_AUTO_MAIN = '1';

test('catalogue: connected apps and the apps behind the Google login are marked connected', async () => {
  const t = await startTestApp();
  try {
    const store = t.app.ctx.store;
    const ts = new Date().toISOString();
    const owner = store.one<any>('SELECT id FROM users LIMIT 1')!.id;

    // Nothing connected yet: nothing is marked.
    let cat = await t.api('GET', '/mcp/catalog');
    assert.equal(cat.filter((e: any) => e.connected).length, 0);
    assert.equal(t.app.ctx.services.mcp.catalog(owner).filter((e: any) => e.installed).length, 0);

    store.insert('mcp_connections', { id: 'mc_notion', user_id: owner, catalog_id: 'notion', name: 'Notion', label: '', slug: 'notion', transport: 'http', url: 'https://mcp.notion.invalid/mcp', verified_at: ts, created_at: ts, updated_at: ts });
    store.insert('mcp_connections', { id: 'mc_google', user_id: owner, catalog_id: 'google', name: 'Google', label: '', slug: 'google', transport: 'builtin', verified_at: ts, created_at: ts, updated_at: ts });

    cat = await t.api('GET', '/mcp/catalog');
    const on = (id: string) => cat.find((e: any) => e.id === id)?.connected === true;
    assert.ok(on('notion'), 'a connected app is marked');
    for (const id of ['google-gmail', 'google-drive', 'google-ads', 'search-console']) assert.ok(on(id), `${id} is covered by the Google login`);
    assert.ok(!on('fetch'), 'an app that is not connected stays on offer');

    // The Marktplaats reads the same through the service.
    const market = t.app.ctx.services.mcp.catalog(owner);
    assert.equal(market.find((e: any) => e.id === 'notion').installed, true);
    assert.equal(market.find((e: any) => e.id === 'google-gmail').installed, true);
    assert.equal(market.find((e: any) => e.id === 'fetch').installed, false);
  } finally {
    await t.close();
  }
});
