import type { AgentRunRequest, ChatRequest, ChatResult, StreamEvent } from '../server/core/types.js';
import type { TestApp } from './helpers.js';

/** One scripted step of a fake engine. */
export interface BotStep {
  text?: string;
  toolCalls?: { name: string; args: any }[];
  delayMs?: number;
  /** Text streamed before the delay (a half answer while the model is still generating). */
  lead?: string;
  /** Throw this error instead of answering. */
  error?: string;
  /** HTTP status of that error for API engines (default 429, a usage limit). */
  errorStatus?: number;
  /** CLI engines: steps reported before answering or failing (what the CLI did). */
  activity?: { kind: string; title: string }[];
  /** Inspect the request (API engines). */
  check?: (req: ChatRequest) => void;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let callSeq = 0;

function wait(ms: number, signal: AbortSignal) {
  return new Promise<void>((res, rej) => {
    const tm = setTimeout(res, ms);
    signal.addEventListener('abort', () => (clearTimeout(tm), rej(signal.reason || new Error('aborted'))), { once: true });
  });
}

/**
 * Fake engines that serve several bots: each bot (recognised by its name in the system prompt) has its own script.
 * kind 'mockteam' is an API engine (in-process tool loop); 'mockcli' is a CLI engine (own loop via runAgent).
 */
export async function team(t: TestApp) {
  const scripts = new Map<string, BotStep[]>();
  const calls: { bot: string; req: ChatRequest; at: number }[] = [];
  const cliCalls: { bot: string; req: AgentRunRequest; at: number }[] = [];
  const botOf = (system: string) => /^Je bent (.+?)(?: — |, een AI-agent)/.exec(system)?.[1] || '?';
  t.app.ctx.providers.registerKind({
    id: 'mockteam',
    label: 'Mock team',
    type: 'api',
    needsKey: false,
    description: 'test',
    models: ['mock-1'],
    defaultModel: 'mock-1',
    create: () => ({
      kind: 'mockteam',
      async listModels() {
        return [{ id: 'mock-1' }];
      },
      async test() {
        return { ok: true, detail: 'mock' };
      },
      async chat(req: ChatRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<ChatResult> {
        const bot = botOf(req.system);
        calls.push({ bot, req, at: Date.now() });
        const step = scripts.get(bot)?.shift();
        step?.check?.(req);
        if (step?.lead) onEvent({ type: 'text', delta: step.lead });
        if (step?.delayMs) await wait(step.delayMs, signal);
        if (step?.error) {
          const { ProviderError } = await import('../server/providers/common.js');
          const status = step.errorStatus ?? 429;
          throw new ProviderError(step.error, status, status === 429 || status >= 500);
        }
        const text = (step?.lead || '') + (step ? step.text ?? '' : `${bot}: ok`);
        if (text) onEvent({ type: 'text', delta: text.slice(step?.lead?.length || 0) });
        const toolCalls = (step?.toolCalls || []).map((c) => ({ id: `call_${++callSeq}`, name: c.name, args: c.args }));
        return { text, toolCalls, usage: { input: 10, output: 5 }, stop: toolCalls.length ? 'tool_use' : 'end', model: req.model };
      },
    }),
  });
  t.app.ctx.providers.registerKind({
    id: 'mockcli',
    label: 'Mock CLI',
    type: 'cli',
    needsKey: false,
    description: 'test',
    models: ['cli-1'],
    defaultModel: 'cli-1',
    create: () => ({
      kind: 'mockcli',
      async listModels() {
        return [{ id: 'cli-1' }];
      },
      async test() {
        return { ok: true, detail: 'mock' };
      },
      async runAgent(req: AgentRunRequest, signal: AbortSignal, onEvent) {
        const bot = botOf(req.system);
        cliCalls.push({ bot, req, at: Date.now() });
        const step = scripts.get(bot)?.shift();
        onEvent({ type: 'session', sessionId: `sess-${bot}` });
        for (const a of step?.activity || []) onEvent({ type: 'activity', item: { ...a, ts: new Date().toISOString() } });
        if (step?.delayMs) await wait(step.delayMs, signal);
        if (step?.error) return { text: '', usage: { input: 3, output: 1 }, error: step.error };
        const text = step ? step.text ?? '' : `${bot}: ok`;
        if (text) onEvent({ type: 'text', delta: text });
        return { text, usage: { input: 20, output: 7, cost: 0 }, sessionId: `sess-${bot}` };
      },
    }),
  });
  const api = await t.api('POST', '/providers', { kind: 'mockteam' });
  const cli = await t.api('POST', '/providers', { kind: 'mockcli' });
  return {
    scripts,
    calls,
    cliCalls,
    apiProviderId: api.id as string,
    cliProviderId: cli.id as string,
    bot: (name: string, data: any = {}) => t.api('POST', '/agents', { name, provider_id: api.id, model: 'mock-1', access_mode: 'auto', ...data }),
    cliBot: (name: string, data: any = {}) => t.api('POST', '/agents', { name, provider_id: cli.id, model: 'cli-1', access_mode: 'auto', ...data }),
    script(name: string, ...steps: BotStep[]) {
      scripts.set(name, [...(scripts.get(name) || []), ...steps]);
    },
    /** All request text a bot received over the API (system excluded). */
    seen(name: string) {
      return calls.filter((c) => c.bot === name).map((c) => JSON.stringify(c.req.messages));
    },
  };
}

/** Wait until no run is active anywhere for a few quiet ticks (follow-ups start right after a run ends). */
export async function settle(t: TestApp, ms = 10_000) {
  const start = Date.now();
  let quiet = 0;
  while (Date.now() - start < ms) {
    const busy = t.app.ctx.store.all("SELECT id FROM runs WHERE status IN ('queued','running','waiting')");
    if (!busy.length) {
      if (++quiet >= 4) return;
    } else quiet = 0;
    await sleep(25);
  }
  throw new Error('timeout waiting for runs to settle');
}

export async function until(fn: () => any, ms = 5000) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    const v = await fn();
    if (v) return v;
    await sleep(15);
  }
  throw new Error('condition not met in time');
}

export const msgs = (t: TestApp, threadId: string) => t.app.ctx.store.messages(threadId, { limit: 1000 });
export const answers = (t: TestApp, threadId: string) => msgs(t, threadId).filter((m) => m.role === 'assistant' && m.content);
export const runsOf = (t: TestApp, threadId: string, agentId?: string) =>
  t.app.ctx.store.all<any>('SELECT * FROM runs WHERE thread_id = ? ORDER BY created_at', threadId).filter((r) => !agentId || r.agent_id === agentId);
