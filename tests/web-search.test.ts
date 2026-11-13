// Web search (0.4.5): the chain of free sources (Keenable → Parallel → own keys → DuckDuckGo → Wikipedia), quiet
// fallbacks and limits, the settings and status routes, and reading pages (pdf.js, Jina Reader only when switched on).
// Every HTTP call is mocked: no test needs a real service (tests/e2e/web-search-live.mjs does one real call each).
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { startTestApp } from './helpers.js';
import { fetchPage, isThinText, parallelResults, resetSearchState, rpcAnswer, searchChain, searchSettings, webSearchDetailed, webTools } from '../server/tools/builtin/web.js';

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: any;
}

/** Replace fetch: `route` answers every request (undefined = 404); the calls are recorded. */
function mockFetch(route: (c: Call) => Response | Promise<Response> | undefined) {
  const real = globalThis.fetch;
  const calls: Call[] = [];
  globalThis.fetch = (async (u: any, init: any = {}) => {
    const headers: Record<string, string> = {};
    new Headers(init.headers || {}).forEach((v, k) => (headers[k] = v));
    let body: any = init.body;
    try {
      body = typeof body === 'string' ? JSON.parse(body) : body;
    } catch {
      /* form body */
    }
    const c = { url: String(u), method: String(init.method || 'GET'), headers, body };
    calls.push(c);
    if (init.signal?.aborted) throw new DOMException('aborted', 'AbortError');
    return (await route(c)) ?? new Response('', { status: 404 });
  }) as any;
  return { calls, restore: () => (globalThis.fetch = real) };
}

const json = (v: unknown, status = 200, headers: Record<string, string> = {}) => new Response(JSON.stringify(v), { status, headers: { 'content-type': 'application/json', ...headers } });
const sse = (v: unknown, headers: Record<string, string> = {}) => new Response(`event: message\ndata: ${JSON.stringify(v)}\n\n`, { status: 200, headers: { 'content-type': 'text/event-stream', ...headers } });

const KEENABLE = { query: 'q', mode: 'pro', results: [{ title: 'Rijksmuseum', url: 'https://rijksmuseum.nl/nl/bezoek', snippet: 'Elke dag\n\nopen van 9 tot 17 uur.' }] };
const parallelTool = (results: unknown[]) => ({ content: [{ type: 'text', text: JSON.stringify({ search_id: 's1', results }) }] });

/** A Parallel MCP server: initialize (session), initialized (202), tools/call web_search. */
function parallelServer(o: { results?: unknown[]; gone?: () => boolean } = {}) {
  let sessions = 0;
  return (c: Call): Response | undefined => {
    if (!c.url.startsWith('https://mcp.parallel.ai/mcp')) return undefined;
    if (c.body?.method === 'initialize') return sse({ jsonrpc: '2.0', id: c.body.id, result: { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'Parallel MCP' } } }, { 'mcp-session-id': `sess-${++sessions}` });
    if (c.body?.method === 'notifications/initialized') return new Response(null, { status: 202 });
    if (c.body?.method === 'tools/call') {
      if (o.gone?.()) return new Response('unknown session', { status: 404 });
      return sse({ jsonrpc: '2.0', id: c.body.id, result: parallelTool(o.results ?? [{ url: 'https://parallel.example/a', title: 'Parallel A', excerpts: ['eerste stuk', 'tweede stuk'] }]) });
    }
    return undefined;
  };
}

/** A fake ctx with settings and secrets in memory (no app needed for the chain). */
function fakeCtx(settings: any = null, secrets: Record<string, string> = {}) {
  const logs: string[] = [];
  return {
    ctx: { store: { getSetting: (uid: string, k: string) => (uid === 'u' && k === 'search' ? settings : null) }, secrets: { getByName: (_u: string, n: string) => secrets[n] ?? null }, log: { info: (s: string) => logs.push(s) } } as any,
    logs,
  };
}

const ddgBlocked = (c: Call) => (c.url.includes('duckduckgo') ? new Response('<html>anomaly challenge</html>', { status: 202 }) : undefined);

beforeEach(() => resetSearchState());

test('no settings: Keenable answers first, keyless, with the app name and without a key', async () => {
  const m = mockFetch((c) => (c.url === 'https://api.keenable.ai/v1/search/public' ? json(KEENABLE) : undefined));
  try {
    const { ctx, logs } = fakeCtx();
    const o = await webSearchDetailed(ctx, 'u', 'openingstijden rijksmuseum', 5);
    assert.equal(o.source, 'keenable');
    assert.equal(o.results[0].url, 'https://rijksmuseum.nl/nl/bezoek');
    assert.equal(o.results[0].snippet, 'Elke dag open van 9 tot 17 uur.', 'one line, for the numbered list');
    assert.equal(m.calls.length, 1);
    assert.equal(m.calls[0].method, 'POST');
    assert.equal(m.calls[0].headers['x-keenable-title'], 'TeamBot');
    assert.equal(m.calls[0].headers['x-api-key'], undefined);
    assert.deepEqual(m.calls[0].body, { query: 'openingstijden rijksmuseum', max_results: 5, snippet_max_length: 600 });
    assert.deepEqual(logs, ['[search] answered by keenable'], 'the log names the source, never the search terms');
  } finally {
    m.restore();
  }
});

test('Keenable at its limit: Parallel answers over MCP, and Keenable is left alone until Retry-After', async () => {
  const m = mockFetch((c) => (c.url.includes('keenable') ? json({ code: 'public_rate_limit_hourly' }, 429, { 'retry-after': '120' }) : parallelServer()(c)));
  try {
    const { ctx, logs } = fakeCtx();
    const o = await webSearchDetailed(ctx, 'u', 'nieuws', 5);
    assert.equal(o.source, 'parallel');
    assert.deepEqual(o.tried, [{ source: 'keenable', reason: 'limit' }]);
    assert.equal(o.results[0].snippet, 'eerste stuk … tweede stuk');
    const mcp = m.calls.filter((c) => c.url.includes('parallel'));
    assert.deepEqual(
      mcp.map((c) => c.body.method),
      ['initialize', 'notifications/initialized', 'tools/call'],
    );
    assert.equal(mcp[2].headers['mcp-session-id'], 'sess-1');
    assert.match(mcp[2].headers.accept, /text\/event-stream/);
    assert.equal(mcp[2].headers.authorization, undefined, 'keyless');
    assert.deepEqual(mcp[2].body.params, { name: 'web_search', arguments: { objective: 'nieuws', search_queries: ['nieuws'] } });
    assert.equal(logs[0], '[search] answered by parallel; skipped keenable=limit');

    // The next search: Keenable is skipped without a request, Parallel keeps its session.
    m.calls.length = 0;
    const o2 = await webSearchDetailed(ctx, 'u', 'weer', 5);
    assert.equal(o2.source, 'parallel');
    assert.deepEqual(o2.tried, [{ source: 'keenable', reason: 'paused' }]);
    assert.ok(!m.calls.some((c) => c.url.includes('keenable')));
    assert.deepEqual(
      m.calls.map((c) => c.body.method),
      ['tools/call'],
    );
  } finally {
    m.restore();
  }
});

test('an expired Parallel session is opened again once', async () => {
  let gone = true;
  const m = mockFetch((c) => (c.url.includes('keenable') ? new Response('', { status: 503 }) : parallelServer({ gone: () => (gone ? ((gone = false), true) : false) })(c)));
  try {
    const { ctx } = fakeCtx();
    // First search: a session is made; the call says it is gone; a new session answers.
    const o = await webSearchDetailed(ctx, 'u', 'x', 3);
    assert.equal(o.source, 'parallel');
    const methods = m.calls.filter((c) => c.url.includes('parallel')).map((c) => c.body.method);
    assert.deepEqual(methods, ['initialize', 'notifications/initialized', 'tools/call', 'initialize', 'notifications/initialized', 'tools/call']);
  } finally {
    m.restore();
  }
});

test('own free keys: Tavily, then Exa, each with its key in a header (never in the URL); then DuckDuckGo and Wikipedia', async () => {
  const m = mockFetch((c) => {
    if (c.url.includes('keenable')) return new Response('', { status: 500 });
    if (c.url.includes('parallel')) return new Response('', { status: 502 });
    if (c.url === 'https://api.tavily.com/search') return json({ detail: { error: 'This request exceeds your plan’s set usage limit.' } }, 432);
    if (c.url === 'https://api.exa.ai/search') return json({ results: [{ title: 'Exa A', url: 'https://exa.example/a', highlights: ['een passage'] }] });
    return undefined;
  });
  try {
    const { ctx } = fakeCtx({ v: 2, provider: 'auto' }, { search_tavily: 'tvly-GEHEIM', search_exa: 'exa-GEHEIM' });
    const o = await webSearchDetailed(ctx, 'u', 'zoek', 4);
    assert.equal(o.source, 'exa');
    assert.deepEqual(
      o.tried.map((t) => `${t.source}:${t.reason}`),
      ['keenable:down', 'parallel:down', 'tavily:limit'],
    );
    const tav = m.calls.find((c) => c.url.includes('tavily'))!;
    assert.equal(tav.headers.authorization, 'Bearer tvly-GEHEIM');
    assert.equal(tav.body.api_key, undefined);
    const ex = m.calls.find((c) => c.url.includes('exa.ai'))!;
    assert.equal(ex.headers['x-api-key'], 'exa-GEHEIM');
    assert.equal(ex.body.numResults, 4);
    assert.deepEqual(ex.body.contents, { highlights: { maxCharacters: 600 } });
    for (const c of m.calls) assert.ok(!c.url.includes('GEHEIM'), c.url);
  } finally {
    m.restore();
  }
});

test('nothing answers: Wikipedia, with an honest note naming every source', async () => {
  const m = mockFetch((c) => {
    if (c.url.includes('wikipedia.org/w/api.php')) return json({ query: { search: [{ title: 'Lima (stad)', snippet: 'hoofdstad van <span>Peru</span>' }] } });
    if (c.url.includes('keenable')) return json({}, 429);
    return ddgBlocked(c);
  });
  try {
    const { ctx } = fakeCtx();
    const o = await webSearchDetailed(ctx, 'u', 'hoofdstad van Peru', 5);
    assert.equal(o.source, 'wikipedia');
    assert.equal(o.results[0].url, 'https://nl.wikipedia.org/wiki/Lima_(stad)');
    assert.match(o.note!, /Keenable: limiet bereikt; Parallel: niet bereikbaar; DuckDuckGo: blokkeert/);
    assert.match(o.note!, /Tavily of Exa/);
  } finally {
    m.restore();
  }
});

test('a source that answers with nothing found is the answer when no other finds anything', async () => {
  const m = mockFetch((c) => (c.url.includes('keenable') ? json({ results: [] }) : c.url.includes('parallel') ? parallelServer({ results: [] })(c) : c.url.includes('duckduckgo') ? new Response('<html><body>geen resultaten</body></html>', { status: 200 }) : undefined));
  try {
    const { ctx } = fakeCtx();
    const o = await webSearchDetailed(ctx, 'u', 'qwxzv', 5);
    assert.equal(o.results.length, 0);
    assert.equal(o.source, 'keenable');
    assert.equal(o.note, undefined);
    assert.ok(!m.calls.some((c) => c.url.includes('wikipedia')), 'no Wikipedia when the services simply found nothing');
  } finally {
    m.restore();
  }
});

test('the chosen source goes first; a keyed choice without a key, or an empty SearXNG, means Automatisch', () => {
  const s = (o: any) => ({ jinaReader: false, keyOwner: 'u', ...o });
  const keys = (...k: string[]) => (p: string) => k.includes(p);
  assert.deepEqual(searchChain(s({ choice: 'auto' }), keys()), ['keenable', 'parallel', 'duckduckgo']);
  assert.deepEqual(searchChain(s({ choice: 'auto' }), keys('exa', 'tavily')), ['keenable', 'parallel', 'tavily', 'exa', 'duckduckgo']);
  assert.deepEqual(searchChain(s({ choice: 'exa' }), keys('exa')), ['exa', 'keenable', 'parallel', 'duckduckgo']);
  assert.deepEqual(searchChain(s({ choice: 'tavily' }), keys()), ['keenable', 'parallel', 'duckduckgo']);
  assert.deepEqual(searchChain(s({ choice: 'duckduckgo' }), keys()), ['duckduckgo', 'keenable', 'parallel']);
  assert.deepEqual(searchChain(s({ choice: 'parallel' }), keys()), ['parallel', 'keenable', 'duckduckgo']);
  assert.deepEqual(searchChain(s({ choice: 'searxng', url: 'http://zoek.lan' }), keys('tavily')), ['searxng'], 'an own SearXNG never falls back to the internet');
  assert.deepEqual(searchChain(s({ choice: 'searxng' }), keys()), ['keenable', 'parallel', 'duckduckgo']);
});

test('settings of before 0.4.5: DuckDuckGo becomes Automatisch, the old Tavily key still works', async () => {
  const a = fakeCtx({ provider: 'duckduckgo' });
  assert.equal(searchSettings(a.ctx, 'u').choice, 'auto');
  assert.equal(searchSettings(fakeCtx({ v: 2, provider: 'duckduckgo' }).ctx, 'u').choice, 'duckduckgo', 'chosen on purpose since 0.4.5');
  const m = mockFetch((c) => (c.url.includes('tavily') ? json({ results: [{ title: 'T', url: 'https://t.example/', content: 'inhoud' }] }) : undefined));
  try {
    const { ctx } = fakeCtx({ provider: 'tavily', secretName: 'search_key' }, { search_key: 'tvly-OUD' });
    const o = await webSearchDetailed(ctx, 'u', 'x', 3);
    assert.equal(o.source, 'tavily');
    assert.equal(m.calls[0].headers.authorization, 'Bearer tvly-OUD');
  } finally {
    m.restore();
  }
});

test('an own SearXNG that fails keeps its error: the search goes nowhere else', async () => {
  const m = mockFetch(() => new Response('', { status: 500 }));
  try {
    const { ctx } = fakeCtx({ v: 2, provider: 'searxng', url: 'http://93.184.216.34' });
    await assert.rejects(webSearchDetailed(ctx, 'u', 'x', 3), /SearXNG: HTTP 500/);
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});

test('stop: an aborted search does not go on to the next source', async () => {
  const ctl = new AbortController();
  const m = mockFetch((c) => {
    if (c.url.includes('keenable')) {
      ctl.abort();
      throw new DOMException('aborted', 'AbortError');
    }
    return undefined;
  });
  try {
    await assert.rejects(webSearchDetailed(fakeCtx().ctx, 'u', 'x', 3, ctl.signal));
    assert.equal(m.calls.length, 1);
  } finally {
    m.restore();
  }
});

test('MCP answers: JSON or an event stream; a tool error about a limit counts as a limit', () => {
  assert.deepEqual(rpcAnswer('event: message\ndata: {"jsonrpc":"2.0","id":7,"result":{"ok":1}}\n\n', 7, 'text/event-stream'), { jsonrpc: '2.0', id: 7, result: { ok: 1 } });
  assert.deepEqual(rpcAnswer('{"jsonrpc":"2.0","id":3,"result":{}}', 3, 'application/json'), { jsonrpc: '2.0', id: 3, result: {} });
  assert.equal(rpcAnswer('event: message\ndata: {"id":1}\n\n', 2, 'text/event-stream'), null);
  assert.throws(
    () => parallelResults({ isError: true, content: [{ type: 'text', text: 'Rate limit exceeded' }] }, 5),
    (e: any) => e.status === 429,
  );
  assert.deepEqual(parallelResults(parallelTool([{ url: 'javascript:alert(1)', title: 'x' }, { url: 'https://ok.example/', title: '', excerpts: [] }]), 5), [{ title: 'https://ok.example/', url: 'https://ok.example/', snippet: '' }], 'only web addresses');
});

test('web_search names the source under the quoted results', async () => {
  const m = mockFetch((c) => (c.url.includes('keenable') ? json(KEENABLE) : undefined));
  try {
    const [search] = webTools();
    const out = String(await search.run({ query: 'x' }, { ctx: fakeCtx().ctx, userId: 'u', agent: { settings: {} }, signal: new AbortController().signal } as any));
    assert.ok(out.startsWith('<webinhoud bron="zoekresultaten">'));
    assert.ok(out.endsWith('</webinhoud>\nZoekdienst: Keenable'), out);
  } finally {
    m.restore();
  }
});

test('settings route: the new choices, Jina on/off, the old key moved once; status shows keys as yes/no only', async () => {
  const t = await startTestApp({ modules: [] });
  try {
    const uid = t.app.ctx.store.one<{ id: string }>("SELECT id FROM users WHERE role = 'owner'")!.id;
    // A setting of before 0.4.5 with its key under the old name.
    t.app.ctx.store.setSetting(uid, 'search', { provider: 'tavily', secretName: 'search_key' });
    await t.api('PUT', '/secrets/search_key', { value: 'tvly-OUD-123' });
    const r = await t.api('PUT', '/settings', { search: { provider: 'auto', jinaReader: true } });
    assert.deepEqual(r.search, { v: 2, provider: 'auto', jinaReader: true });
    assert.equal(t.app.ctx.secrets.getByName(uid, 'search_tavily'), 'tvly-OUD-123', 'the old key now has the fixed name');
    let st = await t.api('GET', '/web-search/status');
    assert.deepEqual(st, { choice: 'auto', url: null, jinaReader: true, keys: { tavily: true, exa: false, brave: false }, last: null });
    assert.ok(!JSON.stringify(st).includes('tvly-'), 'never the key itself');
    // Only the fields sent change.
    await t.api('PUT', '/settings', { search: { provider: 'exa' } });
    assert.deepEqual(t.app.ctx.store.getSetting(uid, 'search', null), { v: 2, provider: 'exa', jinaReader: true });
    const bad = await fetch(`${t.app.url}/api/settings`, { method: 'PUT', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ search: { provider: 'google' } }) });
    assert.equal(bad.status, 400);
    // After a search the status names the source that answered.
    const m = mockFetch((c) => (c.url.includes('keenable') ? json(KEENABLE) : undefined));
    try {
      await webSearchDetailed(t.app.ctx, uid, 'x', 3);
    } finally {
      m.restore();
    }
    st = await t.api('GET', '/web-search/status');
    assert.equal(st.last.source, 'keenable');
    assert.equal(st.choice, 'exa');
  } finally {
    await t.close();
  }
});

// ---------------------------------------------------------------- reading pages

const SHELL = '<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script><noscript>Schakel JavaScript in</noscript></body></html>';
const PUBLIC = 'http://93.184.216.34/app';

test('thin text: links and markup do not count as text', () => {
  assert.equal(isThinText('# Titel\n\n[Inloggen](https://x/a) · [Menu](https://x/b)'), true);
  assert.equal(isThinText('Dit is een gewone alinea. '.repeat(20)), false);
});

test('a short page that is complete is not called a JavaScript page (example.com, a tracking pixel in noscript)', async () => {
  // example.com as it is served since November 2026: one sentence and a script tag.
  const EXAMPLE = '<!doctype html><html lang=en><head><meta charset=utf-8><title>Example Domain</title><style>body{font:16px system-ui}</style></head><body><p>This domain is for use in documentation examples without needing permission. This is not a service; avoid relying on it for testing and monitoring purposes.</p><script src=/s.js></script></body></html>';
  const PIXEL = '<html><head><title>Open</title><script>track()</script></head><body><h1>Openingstijden</h1><p>Elke werkdag van 9 tot 17 uur open.</p><noscript><img src="https://px.example/p.gif"></noscript></body></html>';
  const BARE = '<html><head><title>App</title></head><body><div id="app"></div><script type="module" src="/main.js"></script></body></html>';
  const page = (body: string) => new Response(body, { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const m = mockFetch((c) => (c.url === 'http://93.184.216.34/' ? page(EXAMPLE) : c.url === 'http://93.184.216.34/open' ? page(PIXEL) : c.url === 'http://93.184.216.34/bare' ? page(BARE) : undefined));
  try {
    const ex = await fetchPage('http://93.184.216.34/', 10_000, false);
    assert.match(ex.text, /documentation examples/);
    assert.equal(ex.note, undefined, 'a complete short page gets no warning');
    const open = await fetchPage('http://93.184.216.34/open', 10_000, false);
    assert.match(open.text, /van 9 tot 17 uur/);
    assert.equal(open.note, undefined, 'an image in <noscript> is not a "turn on JavaScript" notice');
    // An empty element that a script fills, without any notice: that one is a JavaScript page.
    const bare = await fetchPage('http://93.184.216.34/bare', 10_000, false);
    assert.match(bare.note || '', /JavaScript/);
    assert.ok(!m.calls.some((c) => c.url.includes('jina')));
  } finally {
    m.restore();
  }
});

test('a page built by JavaScript: Jina Reader only when switched on, with DNT; off, an honest note', async () => {
  const m = mockFetch((c) => {
    if (c.url === PUBLIC) return new Response(SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
    if (c.url === `https://r.jina.ai/${PUBLIC}`) return json({ code: 200, data: { title: 'De echte app', url: PUBLIC, content: 'Alle inhoud die JavaScript opbouwt.' } });
    return undefined;
  });
  try {
    const off = await fetchPage(PUBLIC, 10_000, false);
    assert.equal(off.via, undefined);
    assert.match(off.note!, /JavaScript/);
    assert.match(off.note!, /Jina/, 'the tip names the switch and that the address would go to Jina');
    assert.match(off.note!, /“Pagina’s lezen via Jina als het zelf niet lukt” \(Instellingen › Meer mogelijkheden › Zoeken op internet\)/, 'the switch and its place as the screens name them');
    assert.ok(!m.calls.some((c) => c.url.includes('jina')), 'off: nothing goes to Jina');

    m.calls.length = 0;
    const on = await fetchPage(PUBLIC, 10_000, false, undefined, { jina: true });
    assert.equal(on.via, 'jina');
    assert.equal(on.text, 'Alle inhoud die JavaScript opbouwt.');
    assert.equal(on.title, 'De echte app');
    assert.equal(on.note, undefined);
    const j = m.calls.find((c) => c.url.startsWith('https://r.jina.ai/'))!;
    assert.equal(j.headers.dnt, '1');
    assert.equal(j.headers.accept, 'application/json');
  } finally {
    m.restore();
  }
});

test('Jina never gets an address in your own network, and a normal article never goes to Jina', async () => {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'text/html');
    res.end(req.url === '/app' ? SHELL : `<html><body><article><h1>Artikel</h1><p>${'Een echte alinea met tekst. '.repeat(30)}</p></article><script>x()</script></body></html>`);
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  const base = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;
  const real = globalThis.fetch;
  const seen: string[] = [];
  globalThis.fetch = ((u: any, init?: any) => (seen.push(String(u)), real(u, init))) as any;
  try {
    const p = await fetchPage(`${base}/app`, 10_000, true, undefined, { jina: true });
    assert.equal(p.via, undefined);
    assert.match(p.note!, /JavaScript/);
    assert.doesNotMatch(p.note!, /Jina/);
    const a = await fetchPage(`${base}/artikel`, 10_000, true, undefined, { jina: true });
    assert.match(a.text, /Een echte alinea/);
    assert.equal(a.note, undefined);
    assert.ok(!seen.some((u) => u.includes('jina')), seen.join(' '));
  } finally {
    globalThis.fetch = real;
    srv.close();
  }
});

/** A small valid pdf with text per page (as in tests/read-document.test.ts). */
function makePdf(pages: string[][]): Buffer {
  const objs: string[] = [];
  const add = (s: string) => objs.push(s);
  const catalog = add('<< /Type /Catalog /Pages 2 0 R >>');
  add('PAGES');
  const font = add('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>');
  const kids: number[] = [];
  for (const lines of pages) {
    const body = ['BT', '/F1 24 Tf', '72 760 Td', ...lines.flatMap((l, i) => (i ? ['0 -36 Td', `(${l}) Tj`] : [`(${l}) Tj`])), 'ET'].join('\n');
    const content = add(`<< /Length ${Buffer.byteLength(body)} >>\nstream\n${body}\nendstream`);
    kids.push(add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${content} 0 R >>`));
  }
  objs[1] = `<< /Type /Pages /Kids [${kids.map((k) => `${k} 0 R`).join(' ')}] /Count ${kids.length} >>`;
  let out = '%PDF-1.4\n';
  const offs: number[] = [];
  objs.forEach((o, i) => {
    offs.push(Buffer.byteLength(out));
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = Buffer.byteLength(out);
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offs.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

test('a pdf is read on this computer; a scan goes to Jina only when switched on', async () => {
  const text = makePdf([['De offerte is geldig tot 1 december en bevat alle kosten voor het plaatsen van de zonnepanelen op het dak.', 'Betaling binnen dertig dagen na oplevering van het werk, inclusief btw en montage door een erkend installateur.', 'Garantie: twaalf jaar op de omvormer en vijfentwintig jaar op de panelen zelf, volgens de voorwaarden.']]);
  const scan = makePdf([[]]);
  const m = mockFetch((c) => {
    if (c.url === 'http://93.184.216.34/offerte.pdf') return new Response(new Uint8Array(text), { status: 200, headers: { 'content-type': 'application/pdf' } });
    if (c.url === 'http://93.184.216.34/scan.pdf') return new Response(new Uint8Array(scan), { status: 200, headers: { 'content-type': 'application/pdf' } });
    if (c.url.startsWith('https://r.jina.ai/')) return json({ data: { title: 'scan.pdf', url: 'http://93.184.216.34/scan.pdf', content: 'Tekst uit de scan' } });
    return undefined;
  });
  try {
    const p = await fetchPage('http://93.184.216.34/offerte.pdf', 20_000, false, undefined, { jina: true });
    assert.match(p.text, /De offerte is geldig tot 1 december/);
    assert.equal(p.via, undefined);
    assert.ok(!m.calls.some((c) => c.url.includes('jina')), 'a readable pdf stays on this computer');

    const off = await fetchPage('http://93.184.216.34/scan.pdf', 20_000, false);
    assert.match(off.note!, /geen leesbare tekst/);
    const on = await fetchPage('http://93.184.216.34/scan.pdf', 20_000, false, undefined, { jina: true });
    assert.equal(on.via, 'jina');
    assert.equal(on.text, 'Tekst uit de scan');
  } finally {
    m.restore();
  }
});

test('web_fetch follows the Jina switch of the user and says when Jina read the page', async () => {
  const m = mockFetch((c) => {
    if (c.url === PUBLIC) return new Response(SHELL, { status: 200, headers: { 'content-type': 'text/html' } });
    if (c.url.startsWith('https://r.jina.ai/')) return json({ data: { title: 'App', url: PUBLIC, content: 'Gelezen door Jina.' } });
    return undefined;
  });
  try {
    const [, fetchTool] = webTools();
    const run = (settings: any) => fetchTool.run({ url: PUBLIC }, { ctx: fakeCtx(settings).ctx, userId: 'u', agent: { settings: {} }, signal: new AbortController().signal } as any).then(String);
    const off = await run({ v: 2, provider: 'auto' });
    assert.match(off, /\[Let op: Deze pagina gaf bijna geen tekst/);
    assert.ok(off.trimEnd().endsWith('</webinhoud>'));
    const on = await run({ v: 2, provider: 'auto', jinaReader: true });
    assert.match(on, /^URL: http:\/\/93\.184\.216\.34\/app\nStatus: 200\nTitel: App\nGelezen via: Jina Reader \(r\.jina\.ai\)/);
    assert.match(on, /Gelezen door Jina\./);
  } finally {
    m.restore();
  }
});
