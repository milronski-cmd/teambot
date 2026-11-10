// "Citeren" in a page a bot made: the page gets a one-way selection helper and stays in the same sandbox.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startTestApp } from './helpers.js';
import { withQuoteHelper } from '../server/api/preview.js';

test('pages get the one-way selection helper for "Citeren", inside the same sandbox', async () => {
  assert.match(withQuoteHelper('<html><body><p>x</p></body></html>'), /<p>x<\/p><script>.*tb:"selection".*<\/script><\/body><\/html>$/s);
  assert.match(withQuoteHelper('<p>zonder body</p>'), /^<p>zonder body<\/p><script>/);
  const t = await startTestApp({ modules: [] });
  try {
    const th = await t.api('POST', '/threads', {});
    const up = await fetch(`${t.app.url}/api/attachments?name=p.html&threadId=${th.id}`, { method: 'POST', headers: { authorization: `Bearer ${t.token}`, 'content-type': 'text/html' }, body: '<html><body><h1>Pagina</h1></body></html>' }).then((r) => r.json());
    const { url } = await t.api('POST', `/attachments/${up.id}/preview`);
    const res = await fetch(t.app.url + url);
    assert.match(res.headers.get('content-security-policy') || '', /^sandbox allow-scripts; default-src 'none'/);
    const html = await res.text();
    assert.match(html, /<h1>Pagina<\/h1><script>/);
    assert.match(html, /parent\.postMessage\(\{tb:"selection"/);
    assert.doesNotMatch(html, /addEventListener\("message"/, 'the page never listens to the window');
  } finally {
    await t.close();
  }
});
