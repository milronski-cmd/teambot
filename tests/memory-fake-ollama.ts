/**
 * A small stand-in for Ollama on 127.0.0.1 (tests never talk to a real model): /api/tags, /api/embed with a
 * deterministic "meaning" (words grouped into concepts, so "wagen" and "auto" are close and "koffie" is far), /api/pull
 * with NDJSON progress, and an OpenAI-compatible /v1/chat/completions that streams a scripted answer.
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { normalize } from '../server/modules/memory/text.js';

const CONCEPTS: string[][] = [
  ['auto', 'wagen', 'car', 'voertuig', 'volvo', 'bolide', 'automobiel'],
  ['hond', 'dog', 'viervoeter', 'puppy', 'bram'],
  ['kleur', 'blauw', 'blauwe', 'rood', 'rode', 'color', 'colour'],
  ['koffie', 'espresso', 'coffee', 'cappuccino'],
  ['zonnepanelen', 'panelen', 'zonne', 'energie', 'solar', 'zonnestroom'],
  ['prijs', 'kosten', 'euro', 'bedrag', 'kost', 'duur'],
  ['garantie', 'waarborg', 'warranty'],
  ['verwijder', 'verwijderen', 'wissen', 'wis', 'delete'],
];
const NOISE = 24;

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return Math.abs(h);
}

/** The fake model's vector for a text (prefixes such as "search_query: " are ignored). */
export function fakeVector(text: string): number[] {
  const v = new Array(CONCEPTS.length + NOISE).fill(0);
  for (const w of normalize(text).split(' ').filter((x) => x.length > 2)) {
    const c = CONCEPTS.findIndex((list) => list.some((x) => w === x || (x.length >= 5 && w.startsWith(x))));
    if (c >= 0) v[c] += 1;
    else v[CONCEPTS.length + (hash(w) % NOISE)] += 0.25;
  }
  if (v.every((x) => x === 0)) v[CONCEPTS.length] = 1;
  return v;
}

export interface FakeOllama {
  url: string;
  port: number;
  /** Embedding models in /api/tags (a chat model is always listed too). */
  embedModels: string[];
  calls: { embed: number; texts: number; pull: number; chat: number };
  /** Scripted chat answers (OpenAI-compatible endpoint), first in first out. */
  chat: string[];
  chatRequests: any[];
  close(): Promise<void>;
}

export async function startFakeOllama(o: { embedModels?: string[] } = {}): Promise<FakeOllama> {
  const state: FakeOllama = { url: '', port: 0, embedModels: o.embedModels ?? ['bge-m3:latest'], calls: { embed: 0, texts: 0, pull: 0, chat: 0 }, chat: [], chatRequests: [], close: async () => {} };
  const body = (req: http.IncomingMessage) =>
    new Promise<any>((resolve) => {
      let b = '';
      req.on('data', (c) => (b += c));
      req.on('end', () => {
        try {
          resolve(JSON.parse(b || '{}'));
        } catch {
          resolve({});
        }
      });
    });
  const srv = http.createServer(async (req, res) => {
    const url = req.url || '';
    const json = (code: number, v: any) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    if (req.method === 'GET' && url === '/api/version') return json(200, { version: '0.0.0-test' });
    if (req.method === 'GET' && url === '/api/tags')
      return json(200, { models: [{ name: 'qwen-test:latest', capabilities: ['completion', 'tools'] }, ...state.embedModels.map((name) => ({ name, capabilities: ['embedding'] }))] });
    if (req.method === 'GET' && url === '/api/ps') return json(200, { models: [] });
    if (req.method === 'POST' && url === '/api/show') return json(404, { error: 'not found' });
    if (req.method === 'POST' && url === '/api/embed') {
      const b = await body(req);
      if (!state.embedModels.includes(b.model)) return json(404, { error: `model "${b.model}" not found, try pulling it first` });
      const input: string[] = Array.isArray(b.input) ? b.input : [String(b.input || '')];
      state.calls.embed++;
      state.calls.texts += input.length;
      return json(200, { model: b.model, embeddings: input.map((t) => fakeVector(String(t).replace(/^[a-z_ ]+: /i, ''))) });
    }
    if (req.method === 'POST' && url === '/api/pull') {
      const b = await body(req);
      state.calls.pull++;
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      res.write(JSON.stringify({ status: 'pulling manifest' }) + '\n');
      for (const done of [0, 400, 800, 1000]) res.write(JSON.stringify({ status: 'downloading', digest: 'sha256:x', total: 1000, completed: done }) + '\n');
      res.write(JSON.stringify({ status: 'success' }) + '\n');
      const name = String(b.model).includes(':') ? String(b.model) : `${b.model}:latest`;
      if (!state.embedModels.includes(name)) state.embedModels.push(name);
      return res.end();
    }
    if (req.method === 'POST' && url === '/v1/chat/completions') {
      const b = await body(req);
      state.calls.chat++;
      state.chatRequests.push(b);
      const text = state.chat.shift() ?? 'ok';
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const chunk = (delta: any, finish: string | null = null) => res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: b.model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
      chunk({ role: 'assistant', content: '' });
      for (const part of text.match(/.{1,12}/gs) || []) chunk({ content: part });
      chunk({}, 'stop');
      res.write(`data: ${JSON.stringify({ id: 'x', object: 'chat.completion.chunk', model: b.model, choices: [], usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 } })}\n\n`);
      res.write('data: [DONE]\n\n');
      return res.end();
    }
    if (req.method === 'POST' && url === '/api/chat') {
      // Native chat (TeamBot uses it when a context window is set): NDJSON, one message chunk per line.
      const b = await body(req);
      state.calls.chat++;
      state.chatRequests.push(b);
      const text = state.chat.shift() ?? 'ok';
      res.writeHead(200, { 'content-type': 'application/x-ndjson' });
      for (const part of text.match(/.{1,12}/gs) || []) res.write(JSON.stringify({ model: b.model, message: { role: 'assistant', content: part }, done: false }) + '\n');
      res.write(JSON.stringify({ model: b.model, message: { role: 'assistant', content: '' }, done: true, done_reason: 'stop', prompt_eval_count: 20, eval_count: 5 }) + '\n');
      return res.end();
    }
    if (req.method === 'GET' && url === '/v1/models') return json(200, { data: [{ id: 'qwen-test:latest' }] });
    json(404, { error: 'not found' });
  });
  await new Promise<void>((r) => srv.listen(0, '127.0.0.1', r));
  state.port = (srv.address() as AddressInfo).port;
  state.url = `http://127.0.0.1:${state.port}`;
  state.close = () => new Promise<void>((r) => (srv.closeAllConnections?.(), srv.close(() => r())));
  return state;
}
