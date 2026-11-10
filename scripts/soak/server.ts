// The TeamBot server of the soak test (scripts/soak.mjs starts it as its own process): the real app with every module,
// a temporary data folder (TEAMBOT_DATA, APPDATA and HOME are set by the driver) and a fake engine instead of an AI.
// Nothing on this PC is used: no CLI engine, no Ollama or other local model server (their addresses point to a closed
// port), no internet for the marketplace. Prints one JSON line {ready, url, token} on stdout for the driver.
import { createApp } from '../../server/app.js';
import type { ChatRequest, ChatResult, ProviderAdapter, StreamEvent } from '../../server/core/types.js';

const port = Number(process.argv[process.argv.indexOf('--port') + 1]) || 4765;
const WORDS = 'planning klant offerte project budget leverancier campagne verslag notulen besluit actiepunt website rapport analyse cijfers kwartaal omzet afspraak factuur levering'.split(' ');
let turn = 0;

/** A fake engine: streams a 40–160 word answer over ~0.5–1.5 s; now and then searches or saves memory first. */
function fakeEngine(): ProviderAdapter {
  return {
    kind: 'soak-fake',
    async listModels() {
      return [{ id: 'fake-1' }];
    },
    async test() {
      return { ok: true, detail: 'soak' };
    },
    async chat(req: ChatRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<ChatResult> {
      const n = turn++;
      const last = req.messages[req.messages.length - 1];
      const has = (name: string) => req.tools.some((t) => t.name === name);
      if (last?.role === 'user' && n % 5 === 0 && has('memory_search')) return { text: '', toolCalls: [{ id: `c${n}`, name: 'memory_search', args: { query: WORDS[n % WORDS.length] } }], usage: { input: 900, output: 20 }, stop: 'tool_use', model: req.model };
      if (last?.role === 'user' && n % 7 === 0 && has('memory_remember')) return { text: '', toolCalls: [{ id: `c${n}`, name: 'memory_remember', args: { content: `De ${WORDS[n % WORDS.length]} van week ${n % 52} is besproken.`, scope: 'agent' } }], usage: { input: 900, output: 30 }, stop: 'tool_use', model: req.model };
      const len = 40 + ((n * 37) % 120);
      const text = Array.from({ length: len }, (_, i) => WORDS[(n * 7 + i * 13) % WORDS.length]).join(' ') + '.';
      const chunks = text.match(/.{1,24}/gs) || [];
      const delay = Math.max(2, Math.round(800 / chunks.length));
      for (const c of chunks) {
        if (signal.aborted) break;
        onEvent({ type: 'text', delta: c });
        await new Promise((r) => setTimeout(r, delay));
      }
      return { text, toolCalls: [], usage: { input: 1200, output: len * 2 }, stop: 'end', model: req.model };
    },
  };
}

const app = await createApp({ port, host: '127.0.0.1', mode: 'desktop', quiet: true });
for (const k of app.ctx.providers.kinds.values()) {
  if (k.detect) k.detect = async () => ({ installed: false, detail: 'soak' });
  if (typeof k.baseUrl === 'string' && /\/\/(127\.0\.0\.1|localhost)[:/]/.test(k.baseUrl)) k.baseUrl = 'http://127.0.0.1:9/v1';
}
app.ctx.providers.registerKind({ id: 'soak-fake', label: 'Nep-engine (duurtest)', type: 'api', needsKey: false, description: 'soak', models: ['fake-1'], defaultModel: 'fake-1', create: () => fakeEngine() });
const token = app.ctx.auth.ensureLocalOwner();
process.stdout.write(JSON.stringify({ ready: true, url: app.url, pid: process.pid, token }) + '\n');

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  await app.close();
  process.exit(0);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.stdin.on('data', (d) => String(d).includes('stop') && void shutdown());
