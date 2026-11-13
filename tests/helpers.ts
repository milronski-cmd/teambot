import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createApp, type AppHandle } from '../server/app.js';
import type { ChatRequest, ChatResult, Module, ProviderAdapter, StreamEvent } from '../server/core/types.js';

/** Scripted responses for the "mock" provider. Push before sending a message. */
export interface MockStep {
  text?: string;
  toolCalls?: { name: string; args: any }[];
  /** Throw this error instead of answering (e.g. to test fallback). */
  error?: { message: string; status?: number; category?: import('../server/providers/common.js').ErrorCategory };
  /** Inspect the request the runner sent. */
  check?: (req: ChatRequest) => void;
}

export function mockAdapter(script: MockStep[], requests: ChatRequest[]): ProviderAdapter {
  return {
    kind: 'mock',
    async listModels() {
      return [{ id: 'mock-1' }];
    },
    async test() {
      return { ok: true, detail: 'mock' };
    },
    async chat(req: ChatRequest, _signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<ChatResult> {
      requests.push(req);
      const step = script.shift();
      step?.check?.(req);
      if (step?.error) {
        const { ProviderError } = await import('../server/providers/common.js');
        throw new ProviderError(step.error.message, step.error.status ?? 500, (step.error.status ?? 500) >= 500 || step.error.status === 429, '', step.error.category);
      }
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user');
      const text = step ? step.text ?? '' : `echo: ${typeof lastUser?.content === 'string' ? lastUser.content : '[multi]'}`;
      for (const ch of text.match(/.{1,8}/gs) || []) onEvent({ type: 'text', delta: ch });
      const toolCalls = (step?.toolCalls || []).map((c, i) => ({ id: `call_${Date.now()}_${i}`, name: c.name, args: c.args }));
      return { text, toolCalls, usage: { input: 10, output: 5 }, stop: toolCalls.length ? 'tool_use' : 'end', model: req.model };
    },
  };
}

export interface TestApp {
  app: AppHandle;
  token: string;
  dir: string;
  script: MockStep[];
  requests: ChatRequest[];
  providerId: string;
  api<T = any>(method: string, p: string, body?: any): Promise<T>;
  /** Signed path+query for a link, image or stream (`/api/...` or `/ws`), like the app makes it; default: owner token. */
  signed(fullPath: string, tok?: string): string;
  /** Create an agent bound to the mock provider. */
  agent(data?: any): Promise<any>;
  /** Post a message and wait until all runs of the thread are finished. */
  say(threadId: string, content: string, timeoutMs?: number): Promise<any[]>;
  waitIdle(threadId: string, timeoutMs?: number): Promise<void>;
  close(): Promise<void>;
}

export async function startTestApp(opts: { modules?: Module[]; mode?: 'desktop' | 'server' } = {}): Promise<TestApp> {
  // The implicit first team gets no starting rules in tests (teams/service.ts ensureDefault): the money rule makes
  // every outward step wait for a reviewer, which the mock AI is not. Tests about those rules make a team themselves.
  process.env.TEAMBOT_TEST_NO_STARTER_RULES = '1';
  // An e2e script on this helper (no node --test around it) never fetches the 124 MB search model by itself either.
  process.env.TEAMBOT_NO_AUTO_DOWNLOAD ??= '1';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-test-'));
  const script: MockStep[] = [];
  const requests: ChatRequest[] = [];
  // TEAMBOT_TEST_PORT: a fixed port for live runs on a pc where other TeamBots run (default: any free port).
  const app = await createApp({ dataDir: dir, port: Number(process.env.TEAMBOT_TEST_PORT) || 0, host: '127.0.0.1', mode: opts.mode ?? 'desktop', quiet: true, modules: opts.modules });
  app.ctx.providers.registerKind({
    id: 'mock',
    label: 'Mock',
    type: 'api',
    needsKey: false,
    description: 'test',
    models: ['mock-1'],
    defaultModel: 'mock-1',
    create: () => mockAdapter(script, requests),
  });
  const token = app.ctx.auth.ensureLocalOwner();
  const api = async (method: string, p: string, body?: any): Promise<any> => {
    const res = await fetch(app.url + '/api' + p, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${method} ${p} -> ${res.status}: ${(j as any).error}`);
    return j;
  };
  const prov = await api('POST', '/providers', { kind: 'mock' });
  const t: TestApp = {
    app,
    token,
    dir,
    script,
    requests,
    providerId: prov.id,
    api,
    // By the session row (also for a revoked session: the server must then refuse the link).
    signed: (fullPath, tok = token) => app.ctx.auth.signUrl(app.ctx.store.one<{ id: string }>('SELECT id FROM sessions WHERE token_hash = ?', crypto.createHash('sha256').update(tok).digest('hex'))!.id, fullPath),
    agent: (data = {}) => api('POST', '/agents', { name: 'Testbot', provider_id: prov.id, model: 'mock-1', access_mode: 'auto', ...data }),
    async waitIdle(threadId, timeoutMs = 10_000) {
      const start = Date.now();
      await new Promise((r) => setTimeout(r, 30));
      while (Date.now() - start < timeoutMs) {
        const busy = app.ctx.store.all("SELECT id FROM runs WHERE thread_id = ? AND status IN ('queued','running','waiting')", threadId);
        if (!busy.length) return;
        await new Promise((r) => setTimeout(r, 25));
      }
      throw new Error('timeout waiting for runs');
    },
    async say(threadId, content, timeoutMs) {
      await api('POST', `/threads/${threadId}/messages`, { content });
      await t.waitIdle(threadId, timeoutMs);
      return app.ctx.store.messages(threadId);
    },
    async close() {
      await app.close();
      // Windows keeps a file locked a little longer after a child process (voice engine, CLI) exits: retry, and never
      // fail a finished test only because its temp folder could not be removed yet.
      try {
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        /* left in the temp folder */
      }
    },
  };
  return t;
}

/**
 * A finished turn the owner started by typing in his chat with this bot: what a tool sees as `t.run` when the owner
 * asked for something himself (tools that change a bot only do so on the owner's own word: agent/owner-turn.ts).
 */
export function ownerTurn(ctx: any, userId: string, agentId: string) {
  const thread = ctx.chat.threadForAgent(userId, agentId);
  const msg = ctx.store.createMessage({ thread_id: thread.id, role: 'user', author_type: 'user', author_id: userId, content: 'Doe dit voor mij.' });
  return ctx.store.createRun({ thread_id: thread.id, agent_id: agentId, user_id: userId, status: 'done', trigger: 'user', input_message_id: msg.id });
}
