// LIVE check of the Google Workspace MCP connectors (Gmail, Agenda, Drive, Sheets) through TeamBot's own OAuth discovery:
// public metadata only. A temporary TeamBot data dir and a fake client ID are used; nothing is authorized and no
// Google account or real OAuth client is needed. Free.
//   node --import tsx tests/e2e/google-mcp-live.mjs
const { startTestApp } = await import('../helpers.ts');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};

const t = await startTestApp();
try {
  for (const id of ['google-gmail', 'google-calendar', 'google-drive', 'google-sheets']) {
    const c = await t.api('POST', '/mcp/connections', { catalog_id: id });
    let prep;
    try {
      prep = await t.api('POST', `/mcp/connections/${c.id}/oauth/prepare`);
    } catch (e) {
      check(`${id}: discovery`, false, e.message);
      continue;
    }
    check(`${id}: autorisatieserver accounts.google.com`, prep.authorizationServer === 'accounts.google.com', prep.authorizationServer);
    check(`${id}: geen automatische registratie (eigen client nodig)`, prep.registration === 'missing', prep.registration);
    check(`${id}: PKCE S256`, prep.pkce === true);
    check(`${id}: inloggen nodig volgens TeamBot`, prep.authRequired === true);
    const row = t.app.ctx.store.get('mcp_connections', c.id);
    console.log(`  resource: ${row.oauth?.discovery?.resourceMetadata?.resource} · scopes: ${prep.scopes.filter((s) => s.default).map((s) => s.name.split('/').pop()).join(', ')}`);
    await t.api('PATCH', `/mcp/connections/${c.id}`, { oauth_client_id: 'fake-client.apps.googleusercontent.com', oauth_client_secret: 'fake-secret' });
    try {
      const r = await t.api('POST', `/mcp/connections/${c.id}/oauth/start`, { scopes: prep.scopes.filter((s) => s.default).map((s) => s.name) });
      const u = new URL(r.authorizationUrl);
      check(`${id}: inlog-URL bij Google`, u.host === 'accounts.google.com', `${u.origin}${u.pathname} · ${[...u.searchParams.keys()].join(',')}`);
    } catch (e) {
      check(`${id}: inlog-URL`, false, e.message);
    }
  }
} catch (e) {
  check('onverwachte fout', false, e.message);
} finally {
  await t.close();
}
const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed}/${results.length} geslaagd`);
process.exit(failed ? 1 : 0);
