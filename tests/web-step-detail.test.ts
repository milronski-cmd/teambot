import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startTestApp } from './helpers.js';
import { stepDetail } from '../shared/preview.js';

const FAKE_ACP = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'cli-agents-fake-acp.mjs');

test('a CLI reads a page with TeamBot\'s "Pagina lezen": its step shows the page in words (Q-03)', async () => {
  const site = http.createServer((req, res) => {
    res.writeHead(req.url === '/proef' ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    res.end(req.url === '/proef' ? '<html><head><title>Proefpagina</title></head><body><p>Dit is een proefpagina.</p></body></html>' : '<html><head><title>Niet gevonden</title></head><body>Weg</body></html>');
  });
  await new Promise<void>((r) => site.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${(site.address() as any).port}`;
  const t = await startTestApp();
  try {
    const p = await t.api('POST', '/providers', { kind: 'opencode', config: { path: FAKE_ACP, defaultModel: 'opencode/big-pickle' } });
    const a = await t.api('POST', '/agents', { name: 'Lezer', provider_id: p.id, model: '', access_mode: 'auto', settings: { allowPrivateNetwork: true } });
    const th = await t.api('POST', '/threads', { agentId: a.id });
    const steps = async (url: string) => {
      await t.say(th.id, `SCENARIO:webfetch ${url}`, 30_000);
      const m = t.app.ctx.store.messages(th.id).filter((x) => x.role === 'assistant').at(-1)!;
      const step = (m.parts.activity || []).find((x: any) => /Pagina lezen/.test(x.title || ''));
      assert.ok(step, 'the step is there');
      return String(step.detail || '');
    };
    const ok = await steps(`${base}/proef`);
    assert.match(ok, /^URL: .*\nStatus: 200\nTitel: Proefpagina/, 'the bot still gets the full head');
    assert.equal(stepDetail(ok), '“Proefpagina” — Dit is een proefpagina.');
    assert.equal(stepDetail(await steps(`${base}/weg`)), 'Deze pagina bestaat niet (meer). “Niet gevonden” — Weg');
  } finally {
    await t.close();
    site.close();
  }
});
