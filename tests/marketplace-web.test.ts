import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import AdmZip from 'adm-zip';
import { startTestApp } from './helpers.js';
import { classifyId, classifyText, resolveSkillLicense, categorize } from '../server/modules/skills/licenses.js';
import { WebCache } from '../server/modules/skills/webcache.js';
import { type FetchResult, type Fetcher, defaultFetcher } from '../server/modules/skills/fetch.js';
import { ICON_MAX_BYTES, acceptableIcon, imageInfo } from '../server/modules/mcp/icons.js';
import { filesFromZip } from '../server/modules/skills/files.js';
import { normalizeServer, entryFor, pickIcon } from '../server/modules/mcp/registry.js';
import { monogram } from '../ui/src/lib/monogram.js';

// Recorded responses of the real services (trimmed); no test here touches the network.
const FX = path.resolve('tests/fixtures/market');
const fx = (name: string) => JSON.parse(fs.readFileSync(path.join(FX, name), 'utf8'));
const MIT = 'MIT License\n\nCopyright (c) 2026 Acme\n\nPermission is hereby granted, free of charge, to any person obtaining a copy of this software...\n';
const md = (name: string, description: string, extra = '', body = 'Werk stap voor stap.') => `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\n${body}\n`;
const ok = (url: string, body: Buffer | string | object, headers: Record<string, string> = {}): FetchResult => ({
  status: 200,
  contentType: 'application/json',
  url,
  body: Buffer.isBuffer(body) ? body : Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)),
  headers,
});
const status = (url: string, s: number, headers: Record<string, string> = {}): FetchResult => ({ status: s, contentType: '', url, body: Buffer.alloc(0), headers });

// ------------------------------------------------------------------ licences

test('licences: licence files, frontmatter, SPDX expressions; restrictive and unknown are not open', () => {
  assert.deepEqual(classifyText(MIT), { spdx: 'MIT', status: 'open' });
  assert.equal(classifyText('Apache License\nVersion 2.0, January 2004\nhttp://www.apache.org/licenses/').spdx, 'Apache-2.0');
  assert.equal(classifyText('Copyright (c) Microsoft Corporation. All rights reserved.\n\n' + MIT).status, 'open', 'an MIT text with a copyright line stays MIT');
  assert.equal(classifyText('Business Source License 1.1\n\nLicensor: Acme').status, 'restricted');
  assert.equal(classifyText('Use of these skills is governed by the Acme Developer Terms.').status, 'restricted');
  assert.equal(classifyText('Attribution-NonCommercial 4.0 International').status, 'restricted');
  assert.equal(classifyText('Feel free to do whatever.').status, 'unknown');
  assert.equal(classifyId('MIT')?.status, 'open');
  assert.equal(classifyId('apache-2.0')?.spdx, 'Apache-2.0');
  assert.equal(classifyId('MIT OR Apache-2.0')?.status, 'open');
  assert.equal(classifyId('Proprietary. LICENSE.txt has complete terms')?.status, 'restricted');
  assert.equal(classifyId('Complete terms in LICENSE.txt'), null, 'a pointer to a file is not a licence by itself');
  assert.equal(classifyId('CC-BY-NC-4.0')?.status, 'restricted');

  const files = (o: Record<string, string>) => new Map(Object.entries(o).map(([k, v]) => [k, Buffer.from(v)]));
  // The skill's own licence file wins over an open repository licence.
  const own = resolveSkillLicense({ skillFiles: files({ 'SKILL.md': 'x', 'LICENSE.txt': '© Acme. All rights reserved. Proprietary.' }), frontmatter: 'Complete terms in LICENSE.txt', repoFiles: [{ path: 'LICENSE', text: MIT }] });
  assert.equal(own.status, 'restricted');
  assert.equal(own.source, 'skill-file');
  const repo = resolveSkillLicense({ skillFiles: files({ 'SKILL.md': 'x' }), repoFiles: [{ path: 'LICENSE', text: MIT }] });
  assert.deepEqual([repo.spdx, repo.source], ['MIT', 'repo-file']);
  const fm = resolveSkillLicense({ skillFiles: files({ 'SKILL.md': 'x' }), frontmatter: 'MIT' });
  assert.deepEqual([fm.status, fm.source], ['open', 'frontmatter']);
  assert.equal(resolveSkillLicense({ skillFiles: files({ 'SKILL.md': 'x' }) }).status, 'unknown');
  assert.equal(resolveSkillLicense({ skillFiles: files({ 'SKILL.md': 'x' }), githubSpdx: 'Apache-2.0' }).source, 'github');
  assert.equal(categorize('postgres-best-practices', 'Query tuning for Postgres databases'), 'Data & analyse');
});

// ------------------------------------------------------------------ zip handling

test('repository archives: lenient mode skips symlinks and oversized entries without extracting them', () => {
  const z = new AdmZip();
  z.addFile('repo-HEAD/skills/a/SKILL.md', Buffer.from(md('a', 'A')));
  z.addFile('repo-HEAD/skills/a/link', Buffer.from('/etc/passwd'));
  z.getEntry('repo-HEAD/skills/a/link')!.attr = (0o120777 << 16) >>> 0;
  z.addFile('repo-HEAD/docs/big.bin', Buffer.alloc(10));
  const buf = z.toBuffer();
  assert.throws(() => filesFromZip(buf), /Symbolische koppeling/);
  const skipped: string[] = [];
  const files = filesFromZip(buf, { lenient: true, skipped, include: (p) => p.includes('/skills/') });
  assert.deepEqual([...files.keys()], ['repo-HEAD/skills/a/SKILL.md']);
  assert.deepEqual(skipped, ['repo-HEAD/skills/a/link']);
});

// ------------------------------------------------------------------ web cache

test('web cache: TTL, revalidation, stale copy on errors and offline, rate-limit backoff', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-cache-'));
  let calls = 0;
  let mode: 'ok' | 'fail' | 'limit' | 'not-modified' = 'ok';
  const seen: Record<string, string>[] = [];
  const fetcher: Fetcher = async (url, o) => {
    calls++;
    seen.push(o.headers || {});
    if (mode === 'fail') throw new Error('netwerk weg');
    if (mode === 'limit') return status(url, 429, { 'retry-after': '120' });
    if (mode === 'not-modified') return status(url, 304);
    return ok(url, { n: calls }, { etag: `"v${calls}"` });
  };
  try {
    const c = new WebCache(dir, () => fetcher);
    const a = await c.json('k', 'https://example.org/a', { ttlMs: 60_000 });
    assert.deepEqual([a.data.n, a.stale], [1, false]);
    assert.equal((await c.json('k', 'https://example.org/a', { ttlMs: 60_000 })).data.n, 1, 'fresh: no network');
    assert.equal(calls, 1);
    mode = 'not-modified';
    const b = await c.json('k', 'https://example.org/a', { ttlMs: 0 });
    assert.equal(b.data.n, 1);
    assert.equal(seen.at(-1)!['if-none-match'], '"v1"', 'revalidates with the ETag');
    mode = 'fail';
    const s = await c.json('k', 'https://example.org/a', { ttlMs: 0 });
    assert.deepEqual([s.data.n, s.stale], [1, true]);
    await assert.rejects(c.json('other', 'https://example.org/b', { ttlMs: 0 }), /netwerk weg/);
    process.env.TEAMBOT_OFFLINE = '1';
    const before = calls;
    assert.equal((await c.json('k', 'https://example.org/a', { ttlMs: 0 })).stale, true);
    assert.equal(calls, before, 'offline: never fetches');
    await assert.rejects(c.json('none', 'https://example.org/c', { ttlMs: 0 }), /offline/);
    delete process.env.TEAMBOT_OFFLINE;
    mode = 'limit';
    await assert.rejects(c.json('x', 'https://limited.example/x', { ttlMs: 0 }), /Limiet/);
    const n = calls;
    await assert.rejects(c.json('y', 'https://limited.example/y', { ttlMs: 0 }), /Limiet/);
    assert.equal(calls, n, 'a rate-limited host is left alone until its reset');
    assert.ok(c.blockedHost('limited.example'));
  } finally {
    delete process.env.TEAMBOT_OFFLINE;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ------------------------------------------------------------------ MCP Registry records

test('registry records: validation, install options and pinned templates; unsafe records are refused', () => {
  const ctx7 = normalizeServer(fx('registry-context7-latest.json'))!;
  assert.equal(ctx7.name, 'io.github.upstash/context7');
  assert.equal(ctx7.publisher, 'github.com/upstash');
  const remote = ctx7.options.find((o) => o.kind === 'remote')!;
  assert.equal(remote.transport, 'http');
  assert.ok(remote.headers.some((h) => h.name === 'Authorization' && h.secret));
  const npm = ctx7.options.find((o) => o.kind === 'npm')!;
  assert.equal(npm.supported, true);
  assert.deepEqual([npm.command, ...(npm.args || [])], ['npx', '-y', `@upstash/context7-mcp@${npm.version}`]);
  assert.ok(npm.env.some((e) => e.name === 'CONTEXT7_API_KEY' && e.secret));
  assert.equal(ctx7.options.find((o) => o.kind === 'mcpb')!.supported, false);
  const gh = normalizeServer(fx('registry-github-latest.json'))!;
  const oci = gh.options.find((o) => o.kind === 'oci')!;
  assert.equal(oci.command, 'docker');
  assert.deepEqual(oci.args!.slice(0, 3), ['run', '-i', '--rm']);
  assert.ok(oci.args!.some((a) => a.startsWith('ghcr.io/github/github-mcp-server')));
  // `-e TOKEN={secret}` in the record becomes `-e TOKEN` plus a vault-backed environment variable.
  assert.ok(!oci.args!.some((a) => a.includes('{token}')));
  assert.ok(oci.env.some((e) => e.name === 'GITHUB_PERSONAL_ACCESS_TOKEN' && e.secret));
  assert.equal(oci.args![oci.args!.indexOf('GITHUB_PERSONAL_ACCESS_TOKEN') - 1], '-e');

  const base = (server: any) => ({ server: { $schema: 'x', name: 'io.github.acme/demo', description: 'Demo', version: '1.0.0', ...server }, _meta: {} });
  const opt = (server: any) => normalizeServer(base(server))!.options[0];
  assert.equal(normalizeServer(base({ name: '../evil' })), null);
  assert.equal(opt({ packages: [{ registryType: 'npm', identifier: '--require=/tmp/x', version: '1.0.0', transport: { type: 'stdio' } }] }).supported, false, 'argument injection via the package name');
  assert.equal(opt({ packages: [{ registryType: 'npm', identifier: 'ok-pkg', version: '1.0.0', registryBaseUrl: 'https://npm.evil.example', transport: { type: 'stdio' } }] }).supported, false);
  assert.equal(opt({ packages: [{ registryType: 'pypi', identifier: 'ok', version: '1.0.0', transport: { type: 'streamable-http' } }] }).supported, false);
  assert.match(opt({ packages: [{ registryType: 'npm', identifier: 'ok', version: '1.0.0', transport: { type: 'stdio' }, packageArguments: [{ type: 'named', name: '--token', isSecret: true, isRequired: true }] }] }).reason || '', /geheim/);
  assert.equal(opt({ packages: [{ registryType: 'npm', identifier: 'ok', version: '1.0.0', transport: { type: 'stdio' }, packageArguments: [{ type: 'positional', value: 'a\nrm -rf /' }] }] }).supported, false);
  assert.equal(opt({ remotes: [{ type: 'streamable-http', url: 'http://plain.example/mcp' }] }).supported, false, 'remote must be https');
  const py = opt({ packages: [{ registryType: 'pypi', identifier: 'mcp-thing', version: '0.4.0', transport: { type: 'stdio' }, packageArguments: [{ type: 'positional', valueHint: 'folder', isRequired: true, description: 'Map' }] }] });
  assert.deepEqual([py.command, ...(py.args || [])], ['uvx', 'mcp-thing==0.4.0', '{folder}']);
  const item = normalizeServer(base({ remotes: [{ type: 'streamable-http', url: 'https://{region}.mcp.example.com/mcp', variables: { region: { description: 'Regio', isRequired: true } } }] }))!;
  assert.throws(() => entryFor(item, 'remote:0', {}), /Regio/);
  assert.equal(entryFor(item, 'remote:0', { region: 'eu' }).entry.url, 'https://eu.mcp.example.com/mcp');
  assert.throws(() => entryFor(item, 'remote:0', { region: 'evil.example/x?' }), /ongeldig/, 'a value cannot change the host');
  const tenant = normalizeServer(base({ remotes: [{ type: 'streamable-http', url: 'https://mcp.example.com/{tenant}/mcp' }] }))!;
  assert.equal(entryFor(tenant, 'remote:0', { tenant: 'a/../b' }).entry.url, 'https://mcp.example.com/a%2F..%2Fb/mcp', 'URL parts are encoded');
  assert.throws(() => entryFor({ ...item, status: 'deleted' }, 'remote:0', { region: 'eu' }), /verwijderd/);
  const pyItem = normalizeServer(base({ packages: [{ registryType: 'pypi', identifier: 'mcp-thing', version: '0.4.0', transport: { type: 'stdio' }, packageArguments: [{ type: 'positional', valueHint: 'folder', isRequired: true }] }] }))!;
  assert.deepEqual(entryFor(pyItem, 'package:0', { folder: 'C:\\data' }).entry.args, ['mcp-thing==0.4.0', 'C:\\data']);
  assert.throws(() => entryFor(pyItem, 'package:0', { folder: 'a\nb' }), /Ongeldige/);
  // An optional named argument left empty is dropped together with its flag.
  const optItem = normalizeServer(base({ packages: [{ registryType: 'npm', identifier: 'thing', version: '2.0.0', transport: { type: 'stdio' }, packageArguments: [{ type: 'named', name: '--root', value: '{root}', variables: { root: { description: 'Map' } } }] }] }))!;
  assert.deepEqual(entryFor(optItem, 'package:0', {}).entry.args, ['-y', 'thing@2.0.0']);
  assert.deepEqual(entryFor(optItem, 'package:0', { root: '/data' }).entry.args, ['-y', 'thing@2.0.0', '--root', '/data']);
});

// ------------------------------------------------------------------ MCP Registry over HTTP

function registryFetcher(over: Record<string, () => FetchResult> = {}): Fetcher & { urls: string[] } {
  const R = 'https://registry.modelcontextprotocol.io/v0.1';
  const urls: string[] = [];
  const f = (async (url: string) => {
    urls.push(url);
    if (over[url]) return over[url]();
    if (url.startsWith(`${R}/servers?`) && url.includes('search=microsoft-learn')) return ok(url, fx('registry-search-microsoft-learn.json'));
    // "latest" and the exact version of the recorded record both resolve to it.
    if (url.startsWith(`${R}/servers/${encodeURIComponent('com.microsoft/microsoft-learn-mcp')}/versions/`)) return ok(url, fx('registry-learn-latest.json'));
    if (url.startsWith(`${R}/servers/${encodeURIComponent('io.github.upstash/context7')}/versions/`)) return ok(url, fx('registry-context7-latest.json'));
    if (url.endsWith('/versions') && url.includes('context7')) return ok(url, { servers: [fx('registry-context7-latest.json')], metadata: { count: 1 } });
    if (url.startsWith('https://registry.npmjs.org/@upstash%2Fcontext7-mcp/')) return ok(url, fx('npm-context7-mcp-4.5.1.json'));
    return status(url, 404);
  }) as unknown as Fetcher & { urls: string[] };
  f.urls = urls;
  return f;
}

test('MCP Registry: featured and search, install pins the template server-side, secrets to the vault, update, takedown', async () => {
  const t = await startTestApp();
  try {
    const fetcher = registryFetcher();
    t.app.ctx.services.mcp.setRegistryFetcher(fetcher);
    const featured = await t.api('GET', '/mcp/registry/servers');
    assert.equal(featured.mode, 'featured');
    assert.deepEqual(featured.items.map((i: any) => i.name).sort(), ['com.microsoft/microsoft-learn-mcp', 'io.github.upstash/context7'], 'unknown featured names are skipped');
    await assert.rejects(t.api('GET', '/mcp/registry/servers?q=ab'), /3 tekens/);
    const found = await t.api('GET', '/mcp/registry/servers?q=microsoft-learn');
    assert.equal(found.items[0].name, 'com.microsoft/microsoft-learn-mcp');
    assert.equal(found.items[0].publisher, 'microsoft.com');
    // The registry sorts by name: look-alikes first, the official server not on the page. A hand-picked server that
    // matches comes first (from the cache, no extra request), without a duplicate.
    const lookAlike = (n: string) => {
      const r = fx('registry-context7-latest.json');
      r.server.name = n;
      r.server.title = `Context7 kloon ${n.slice(-1)}`;
      return r;
    };
    const R = 'https://registry.modelcontextprotocol.io/v0.1';
    const before = fetcher.urls.length;
    t.app.ctx.services.mcp.setRegistryFetcher(
      registryFetcher({ [`${R}/servers?search=context7&version=latest&limit=30`]: () => ok(`${R}/servers?search=context7`, { servers: [lookAlike('ai.smithery/a-context7-1'), lookAlike('ai.smithery/b-context7-2'), fx('registry-context7-latest.json')], metadata: { count: 3 } }) }),
    );
    const ranked = await t.api('GET', '/mcp/registry/servers?q=context7');
    assert.deepEqual(ranked.items.map((i: any) => i.name), ['io.github.upstash/context7', 'ai.smithery/a-context7-1', 'ai.smithery/b-context7-2'], 'the hand-picked server first, once');
    assert.equal(fetcher.urls.length, before, 'no extra requests on the old fetcher');
    // The namespace does not count: "upstash" is in io.github.upstash/context7 but that is not its name or title.
    const R2 = `${R}/servers?search=upst&version=latest&limit=30`;
    t.app.ctx.services.mcp.setRegistryFetcher(registryFetcher({ [R2]: () => ok(R2, { servers: [lookAlike('ai.smithery/upstash-thing-1')], metadata: { count: 1 } }) }));
    assert.deepEqual((await t.api('GET', '/mcp/registry/servers?q=upst')).items.map((i: any) => i.name), ['ai.smithery/upstash-thing-1']);
    t.app.ctx.services.mcp.setRegistryFetcher(fetcher);

    const d = await t.api('GET', '/mcp/registry/server?name=io.github.upstash/context7');
    assert.equal(d.license, 'MIT');
    assert.equal(d.licenseSource, 'npm');
    const npm = d.options.find((o: any) => o.kind === 'npm');
    const entry = await t.api('POST', '/mcp/registry/entry', { name: d.name, version: d.version, option: npm.key });
    assert.equal(entry.entry.command, 'npx');
    assert.equal(entry.entry.signature.state, 'unsigned');
    // The browser cannot change what is installed: command/args/url come from the registry record.
    const c = await t.api('POST', '/mcp/connections', { registry: entry.registry, command: 'evil.exe', args: ['--pwn'], env: [{ name: 'CONTEXT7_API_KEY', value: 'ctx7-secret-value-123', secret: true }] });
    assert.equal(c.command, 'npx');
    assert.deepEqual(c.args, ['-y', `@upstash/context7-mcp@${d.version}`]);
    assert.equal(c.trusted, false, 'a registry command is never trusted without the owner');
    assert.equal(c.registry.name, 'io.github.upstash/context7');
    const row = t.app.ctx.store.get<any>('mcp_connections', c.id);
    assert.ok(!JSON.stringify(row).includes('ctx7-secret-value-123'), 'secret lives in the vault, not in the row');
    assert.equal(row.registry.template.id, 'registry');
    const blockedTest = await t.api('POST', `/mcp/connections/${c.id}/test`, {});
    assert.equal(blockedTest.ok, false);
    assert.match(blockedTest.error, /vertrouw/);

    // Remote option: auth chosen explicitly (no probe in tests), URL pinned.
    const learn = await t.api('GET', '/mcp/registry/server?name=com.microsoft/microsoft-learn-mcp');
    const r = await t.api('POST', '/mcp/registry/entry', { name: learn.name, version: learn.version, option: learn.options[0].key, auth: 'none' });
    const rc = await t.api('POST', '/mcp/connections', { registry: r.registry, url: 'https://attacker.example/mcp' });
    assert.equal(rc.url, 'https://learn.microsoft.com/api/mcp');
    const listed = await t.api('GET', '/mcp/registry/servers?q=microsoft-learn');
    assert.equal(listed.items[0].installed.length, 1, 'marked as installed');

    // Update: an older installed version is detected and replaced; trust and the read-only test start over.
    t.app.ctx.store.update('mcp_connections', c.id, { registry: { ...row.registry, version: '0.0.1' }, args: ['-y', '@upstash/context7-mcp@0.0.1'], trusted_at: new Date().toISOString() });
    const upd = await t.api('POST', '/mcp/registry/check-updates', {});
    assert.ok(upd.updates.some((u: any) => u.id === c.id && u.latest === d.version));
    const ur = await t.api('POST', `/mcp/connections/${c.id}/registry-update`, {});
    assert.equal(ur.to, d.version);
    assert.equal(ur.needsTrust, true);
    assert.deepEqual(ur.connection.args, ['-y', `@upstash/context7-mcp@${d.version}`]);
    assert.equal(ur.connection.verified_at, null);

    // Takedown by an admin hides the server and refuses installs.
    await t.api('POST', '/skills/market/blocks', { type: 'app', catalogId: 'mcp-registry', itemId: 'com.microsoft/microsoft-learn-mcp', reason: 'test' });
    assert.equal((await t.api('GET', '/mcp/registry/servers?q=microsoft-learn')).items.length, 0);
    await assert.rejects(t.api('POST', '/mcp/registry/entry', { name: learn.name, option: learn.options[0].key, auth: 'none' }), /geblokkeerd/);

    // Strict publisher policy: registry records are unsigned, so the owner must override explicitly.
    await t.api('PUT', '/skills/publishers/policy', { policy: 'signed-only' });
    await assert.rejects(t.api('POST', '/mcp/connections', { registry: entry.registry }), /409/);
    const forced = await t.api('POST', '/mcp/connections', { registry: entry.registry, overridePolicy: true });
    assert.equal(forced.registry.name, 'io.github.upstash/context7');

    // Offline: everything that was fetched before still works from the cache.
    process.env.TEAMBOT_OFFLINE = '1';
    const n = fetcher.urls.length;
    assert.equal((await t.api('GET', '/mcp/registry/server?name=io.github.upstash/context7')).name, 'io.github.upstash/context7');
    assert.equal(fetcher.urls.length, n);
    // A search that was never cached looks through the cached servers by name instead of failing.
    const off = await t.api('GET', '/mcp/registry/servers?q=upstash');
    assert.deepEqual(off.items.map((i: any) => i.name), ['io.github.upstash/context7']);
    assert.equal(off.stale, true);
    assert.equal(fetcher.urls.length, n, 'offline: never fetches');
  } finally {
    delete process.env.TEAMBOT_OFFLINE;
    await t.close();
  }
});

// ------------------------------------------------------------------ app icons via TeamBot

const png = (w: number, h: number, size = 64) => {
  const b = Buffer.alloc(Math.max(33, size));
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(b, 0);
  b.writeUInt32BE(13, 8);
  b.write('IHDR', 12, 'latin1');
  b.writeUInt32BE(w, 16);
  b.writeUInt32BE(h, 20);
  return b;
};

test('icon checks: only small PNG/JPEG/WebP by their header, within byte and pixel limits', () => {
  assert.deepEqual(imageInfo(png(64, 48)), { type: 'image/png', width: 64, height: 48 });
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x20, 0x00, 0x40, 0x03, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  assert.deepEqual(imageInfo(jpeg), { type: 'image/jpeg', width: 64, height: 32 });
  const webp = Buffer.alloc(32);
  webp.write('RIFF', 0, 'latin1');
  webp.write('WEBPVP8L', 8, 'latin1');
  webp[20] = 0x2f;
  webp.writeUInt32LE(99 | (49 << 14), 21);
  assert.deepEqual(imageInfo(webp), { type: 'image/webp', width: 100, height: 50 });
  assert.equal(acceptableIcon(png(64, 64)), 'image/png');
  assert.equal(acceptableIcon(png(5000, 64)), null, 'too many pixels (decompression bomb)');
  assert.equal(acceptableIcon(png(64, 64, ICON_MAX_BYTES + 1)), null, 'too many bytes');
  for (const bad of ['<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>', '<!doctype html><html><body>hi</body></html>', 'GIF89a' + 'x'.repeat(40)]) assert.equal(acceptableIcon(Buffer.from(bad)), null);
});

test('app icons: a sensible size from the record, otherwise a monogram for the app', () => {
  const ic = (src: string, mimeType: string, sizes?: string[]) => ({ src, mimeType, ...(sizes ? { sizes } : {}) });
  // a 16 px favicon first (Supabase-style): the smallest icon of at least 64 px wins
  const fav = [16, 32, 48, 96, 128, 196].map((n) => ic(`https://x.example/f-${n}.png`, 'image/png', [`${n}x${n}`]));
  assert.equal(pickIcon(fav)?.src, 'https://x.example/f-96.png');
  // SVG is never used, the PNG next to it is (Linear-style)
  assert.equal(pickIcon([ic('https://x.example/i.svg', 'image/svg+xml', ['any']), ic('https://x.example/i-256.png', 'image/png', ['256x256'])])?.src, 'https://x.example/i-256.png');
  // only small sizes: the largest; no sizes: the first usable one
  assert.equal(pickIcon([ic('https://x.example/a.png', 'image/png', ['16x16']), ic('https://x.example/b.png', 'image/png', ['32x32'])])?.src, 'https://x.example/b.png');
  assert.equal(pickIcon([ic('http://x.example/a.png', 'image/png'), ic('https://x.example/b.webp', 'image/webp')])?.src, 'https://x.example/b.webp', 'https only');
  assert.equal(pickIcon([ic('https://x.example/a.svg', 'image/svg+xml')]), null);
  assert.equal(pickIcon(undefined), null);
  // the record keeps that choice
  const rec = normalizeServer({ server: { name: 'com.supabase/mcp', version: '1.0.0', description: 'x', icons: fav } });
  assert.equal(rec?.icon, 'https://x.example/f-96.png');

  // monograms: initials without filler words, CamelCase capitals, a name-only record
  assert.equal(monogram('Microsoft Learn MCP', 'com.microsoft/microsoft-learn-mcp'), 'ML');
  assert.equal(monogram('Azure MCP Server', 'com.microsoft/azure'), 'A');
  assert.equal(monogram('GitHub', 'io.github.github/github-mcp-server'), 'GH');
  assert.equal(monogram('Hugging Face', 'co.huggingface/hf-mcp-server'), 'HF');
  assert.equal(monogram('Context7', 'io.github.upstash/context7'), 'C');
  assert.equal(monogram('MCP', 'com.notion/mcp'), 'N');
  assert.equal(monogram('', 'io.github.blazickjp/arxiv-mcp-server'), 'A');
});

test('MCP Registry icons load through TeamBot: no publisher URL in the browser, cached, validated, SSRF-checked, fallback', async () => {
  const t = await startTestApp();
  const ICON = 'https://cdn.publisher.example/context7.png';
  const EVIL = 'https://127.0.0.1/evil.png';
  try {
    const base = registryFetcher();
    const iconCalls: string[] = [];
    let iconBody = () => ok(ICON, png(64, 64));
    const withIcon = (r: FetchResult, src: string) => {
      const j = JSON.parse(r.body.toString('utf8'));
      j.server.icons = [{ src, mimeType: 'image/png' }];
      return { ...r, body: Buffer.from(JSON.stringify(j)) };
    };
    const f = (async (url: string, o: any) => {
      if (url === ICON) {
        iconCalls.push(url);
        return iconBody();
      }
      if (url === EVIL) return defaultFetcher(url, o); // the real downloader: SSRF check before any connection
      const r = await base(url, o);
      if (url.includes(`/servers/${encodeURIComponent('io.github.upstash/context7')}/versions/`)) return withIcon(r, ICON);
      if (url.includes(`/servers/${encodeURIComponent('com.microsoft/microsoft-learn-mcp')}/versions/`)) return withIcon(r, EVIL);
      return r;
    }) as unknown as Fetcher;
    t.app.ctx.services.mcp.setRegistryFetcher(f);
    const featured = await t.api('GET', '/mcp/registry/servers');
    assert.ok(!JSON.stringify(featured).includes('publisher.example') && !JSON.stringify(featured).includes('127.0.0.1'), 'the browser never gets the publisher’s icon URL');
    const ctx7 = featured.items.find((i: any) => i.name === 'io.github.upstash/context7');
    assert.match(ctx7.icon, /^\/mcp\/registry\/icon\?name=io\.github\.upstash%2Fcontext7&v=[0-9a-f]{10}$/);
    assert.equal(iconCalls.length, 0, 'browsing fetches no icons by itself');

    const get = (p: string, auth = true) => fetch(t.app.url + (auth ? t.signed(`/api${p}`) : `/api${p}`));
    let res = await get(ctx7.icon);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    assert.match(res.headers.get('cache-control') || '', /private/);
    assert.deepEqual(Buffer.from(await res.arrayBuffer()), png(64, 64));
    await get(ctx7.icon);
    assert.equal(iconCalls.length, 1, 'cached on disk after the first download');
    assert.equal((await get(ctx7.icon, false)).status, 401, 'only for signed-in users');

    // A private-network icon URL is refused by the SSRF check → fallback icon, nothing reaches the address.
    const learn = featured.items.find((i: any) => i.name === 'com.microsoft/microsoft-learn-mcp');
    res = await get(learn.icon);
    assert.equal(res.headers.get('x-teambot-icon'), 'fallback');
    assert.match(res.headers.get('content-type') || '', /^image\/svg\+xml/);
    // the marketplace asks for "none" instead: a 1x1 picture (no failed request in the console), then draws a monogram
    res = await get(learn.icon + '&miss=none');
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-teambot-icon'), 'none');
    assert.equal(res.headers.get('content-type'), 'image/png');
    const tiny = Buffer.from(await res.arrayBuffer());
    assert.equal(tiny.readUInt32BE(16), 1, '1 px wide');
    assert.equal(tiny.readUInt32BE(20), 1, '1 px high');
    assert.deepEqual(Buffer.from(await (await get(ctx7.icon + '&miss=none')).arrayBuffer()), png(64, 64), 'a usable icon is still served');
    // (older pages: a 404)
    assert.equal((await get(learn.icon + '&miss=404')).status, 404);
    // Known to be unusable now: the next listing gives that app no icon at all, so the browser does not ask again.
    const again = await t.api('GET', '/mcp/registry/servers');
    assert.equal(again.items.find((i: any) => i.name === 'com.microsoft/microsoft-learn-mcp').icon, null);
    assert.match(again.items.find((i: any) => i.name === 'io.github.upstash/context7').icon, /^\/mcp\/registry\/icon\?/, 'a working icon keeps its path');
    const card = fs.readFileSync(path.join(process.cwd(), 'ui', 'src', 'modules', 'skills', 'AppIcon.tsx'), 'utf8');
    assert.match(card, /miss=none/);
    assert.match(card, /naturalWidth <= 1/);
    // Unknown or invalid names never trigger a download of anything but the registry record.
    for (const n of ['io.github.nobody/none', '../../etc', 'x']) assert.equal((await get(`/mcp/registry/icon?name=${encodeURIComponent(n)}`)).headers.get('x-teambot-icon'), 'fallback');

    // Not an image (HTML/SVG from the publisher) → fallback, and not retried for a while.
    t.app.ctx.services.mcp.registry.cache.drop(`icon:${ICON}`);
    const reg2 = t.app.ctx.services.mcp.registry;
    (reg2 as any).badIcons.clear();
    iconBody = () => ({ ...ok(ICON, '<svg onload="alert(1)"/>'), contentType: 'image/png' });
    res = await get(ctx7.icon);
    assert.equal(res.headers.get('x-teambot-icon'), 'fallback');
    const n = iconCalls.length;
    await get(ctx7.icon);
    assert.equal(iconCalls.length, n, 'a bad icon is not fetched again right away');

    // Takedown by an admin: no icon either.
    (reg2 as any).badIcons.clear();
    iconBody = () => ok(ICON, png(64, 64));
    await t.api('POST', '/skills/market/blocks', { type: 'app', catalogId: 'mcp-registry', itemId: 'io.github.upstash/context7', reason: 'test' });
    assert.equal((await get(ctx7.icon)).headers.get('x-teambot-icon'), 'fallback');
  } finally {
    await t.close();
  }
});
