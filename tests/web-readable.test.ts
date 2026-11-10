import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fetchPage, htmlToMarkdown, pageToMarkdown } from '../server/tools/builtin/web.js';
import { readableArticle } from '../server/tools/builtin/readable.js';
import { readable } from '../server/modules/specialists/fetch.js';

/** A bot reading a web page gets the article (Readability + linkedom), not the menu, banner, ads and footer. */

const HTML = fs.readFileSync(path.join(import.meta.dirname, 'fixtures', 'documents', 'artikel.html'), 'utf8');

test('the article of a page, without cookie banner, menu, sidebar and footer', () => {
  const a = readableArticle(HTML);
  assert.ok(a);
  assert.match(a.title, /Zonnepanelen in de winter/);
  const md = pageToMarkdown(HTML, 'https://blog.example.org/artikelen/winter');
  assert.match(md, /Ook in de winter leveren zonnepanelen stroom\./);
  assert.match(md, /## Wat je wel kunt doen/);
  assert.match(md, /Koude is juist goed voor zonnepanelen/);
  for (const noise of ['cookies', 'Alles accepteren', 'Over ons', 'warmtepomp met 40% korting', 'Populair:', 'Algemene voorwaarden', 'window.track']) assert.ok(!md.includes(noise), `no "${noise}"`);
  // Relative links become absolute against the page address.
  assert.match(md, /\[onze uitleg over storingen\]\(https:\/\/blog\.example\.org\/hulp\/storing\)/);
  // The old way kept the noise (why this was added).
  assert.match(htmlToMarkdown(HTML), /warmtepomp met 40% korting/);
  // Specialists read pages the same way.
  assert.doesNotMatch(readable(HTML, 'text/html').text, /warmtepomp/);
});

test('a page without a clear article (an index, a tiny page) keeps the whole page', () => {
  const index = '<html><body><nav><a href="/a">Nieuws</a></nav><main><ul><li><a href="/1">Eén</a></li><li><a href="/2">Twee</a></li></ul></main></body></html>';
  assert.equal(readableArticle(index), null);
  assert.match(pageToMarkdown(index, 'https://x.example/'), /\[Eén\]\(https:\/\/x\.example\/1\)/);
  assert.equal(readableArticle(''), null);
  assert.equal(readableArticle('<<<>>> not html'), null);
});

test('web_fetch (fetchPage) gives the article of a served page', async () => {
  const srv = http.createServer((_req, res) => res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(HTML));
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', () => r()));
  try {
    const url = `http://127.0.0.1:${(srv.address() as any).port}/artikelen/winter`;
    const p = await fetchPage(url, 30_000, true);
    assert.equal(p.status, 200);
    assert.match(p.title || '', /Zonnepanelen in de winter/);
    assert.match(p.text, /Sneeuw op de panelen/);
    assert.doesNotMatch(p.text, /cookies|Nieuwsbrief/);
    assert.match(p.text, new RegExp(`\\(${url.replace(/\/artikelen\/winter$/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/hulp/storing\\)`));
  } finally {
    srv.close();
  }
});
