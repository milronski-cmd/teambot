// LIVE smoke check of the keyless search and reading sources of web_search / web_fetch (server/tools/builtin/web.ts):
// one real search at Keenable, one at Parallel (MCP) and one page through Jina Reader. No key, no account, free;
// three requests in all, far below every limit. Nothing is stored (no TeamBot data dir is used).
//   node --import tsx tests/e2e/web-search-live.mjs
const { webSearchDetailed, jinaRead, resetSearchState } = await import('../../server/tools/builtin/web.ts');

const results = [];
const check = (name, ok, detail = '') => {
  results.push(ok);
  console.log(`${ok ? '✔' : '✖'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const ctxFor = (provider) => ({ store: { getSetting: (uid, k) => (uid === 'live' && k === 'search' ? { v: 2, provider } : null) }, secrets: { getByName: () => null }, log: { info: (s) => console.log(`  ${s}`) } });

for (const provider of ['keenable', 'parallel']) {
  resetSearchState();
  const started = Date.now();
  try {
    const o = await webSearchDetailed(ctxFor(provider), 'live', 'openingstijden Rijksmuseum Amsterdam', 5);
    check(`${provider}: antwoordt zelf`, o.source === provider, `${o.source}, ${o.results.length} resultaten, ${Date.now() - started} ms`);
    check(`${provider}: Nederlandse resultaten met adres en fragment`, o.results.length > 0 && o.results.every((r) => /^https?:\/\//.test(r.url)) && o.results.some((r) => /rijksmuseum/i.test(r.url) && r.snippet.length > 20), o.results[0]?.url);
  } catch (e) {
    check(`${provider}: zoeken`, false, e.message);
  }
}

const page = await jinaRead('https://www.w3.org/WAI/ER/tests/xhtml/testfiles/resources/pdf/dummy.pdf');
check('Jina Reader: leest een pdf zonder sleutel', !!page && /Dummy PDF file/i.test(page.text), page ? page.text.slice(0, 60) : 'geen antwoord');

const ok = results.every(Boolean);
console.log(ok ? '\nAlles werkt.' : '\nNiet alles werkt (zie ✖).');
process.exit(ok ? 0 : 1);
