import Anthropic from '@anthropic-ai/sdk';
import { clampEffort, claudeInfo } from './capabilities.js';
import type { ChatMsg, ChatRequest, ChatResult, ModelInfo, ProviderAdapter, StreamEvent, ToolCall } from '../core/types.js';
import { ProviderError, categoryOf, explain, modelsAvailable, providerMessage } from './common.js';
import { rememberListPrices } from './pricing.js';

/** Models that predate adaptive thinking / effort. */
const LEGACY = /claude-(3|instant)|claude-(opus|sonnet|haiku)-4-[0-5](\b|$)|claude-(opus|sonnet)-4$|claude-(opus|sonnet)-4-0/;
/** Models where the server-side refusal fallback ("default" form) is documented. */
const FALLBACK_MODELS = new Set(['claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);
const EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);

export function toAnthropicMessages(msgs: ChatMsg[], stripThinking: boolean): any[] {
  const out: any[] = [];
  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    // Merge consecutive same-role turns so all tool_results of one turn sit in one user message.
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  for (const m of msgs) {
    if (m.role === 'user') {
      const blocks =
        typeof m.content === 'string'
          ? m.content
            ? [{ type: 'text', text: m.content }]
            : []
          : m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } }));
      push('user', blocks);
    } else if (m.role === 'assistant') {
      if (m.raw?.provider === 'anthropic' && Array.isArray(m.raw.data)) {
        // Replay provider-native blocks unchanged (keeps thinking signatures valid).
        let blocks = m.raw.data;
        if (stripThinking) blocks = blocks.filter((b: any) => b.type !== 'thinking' && b.type !== 'redacted_thinking');
        push('assistant', blocks);
      } else {
        const blocks: any[] = [];
        const text = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
        if (text) blocks.push({ type: 'text', text });
        for (const c of m.toolCalls || []) blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args ?? {} });
        push('assistant', blocks);
      }
    } else if (m.role === 'tool') {
      push('user', [
        {
          type: 'tool_result',
          tool_use_id: m.toolCallId,
          content:
            typeof m.content === 'string'
              ? m.content || '(leeg)'
              : m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text || '(leeg)' } : { type: 'image', source: { type: 'base64', media_type: p.mime, data: p.data } })),
          ...(m.isError ? { is_error: true } : {}),
        },
      ]);
    }
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: [{ type: 'text', text: '(vervolg van eerder gesprek)' }] });
  return out;
}

/** Content blocks a cache breakpoint may sit on (never a thinking block). */
const CACHEABLE = new Set(['text', 'image', 'tool_use', 'tool_result', 'document']);

/**
 * Prompt caching (TeamBot 0.4, package Y). An explicit breakpoint at the end of the stable part — tools and system
 * prompt, which TeamBot keeps byte-identical between calls — so that part stays a cache hit whatever changes later in
 * the conversation (a shortened older tool output, a summary). For the growing conversation: on Anthropic's own API
 * the automatic breakpoint (top-level `cache_control`); an Anthropic-compatible endpoint (own base URL: a proxy,
 * LiteLLM, another vendor's Messages API) may not know that field and then cached nothing at all, so there the last
 * block of the last message gets an explicit breakpoint instead (2 of the 4 allowed).
 */
export function cacheParams(system: string, messages: any[], compatible: boolean): { system?: any; messages: any[]; cache_control?: any } {
  const out: { system?: any; messages: any[]; cache_control?: any } = { messages };
  if (system) out.system = [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }];
  if (!compatible) {
    out.cache_control = { type: 'ephemeral' };
    return out;
  }
  const last = messages[messages.length - 1];
  if (last && Array.isArray(last.content)) {
    const i = last.content.findLastIndex((b: any) => CACHEABLE.has(b?.type));
    if (i >= 0) {
      const content = last.content.slice();
      content[i] = { ...content[i], cache_control: { type: 'ephemeral' } };
      out.messages = [...messages.slice(0, -1), { ...last, content }];
    }
  }
  return out;
}

/** SDK errors → ProviderError with a plain-language category (auth, quota, rate_limit, context, overloaded, ...). */
export function anthropicError(label: string, e: any): ProviderError {
  const status = typeof e?.status === 'number' ? e.status : 0;
  const category = categoryOf(e);
  const text = String(e?.error?.error?.message || e?.error?.message || e?.message || e).replace(/^\d{3}\s+/, '');
  const ra = Number(e?.headers?.get?.('retry-after') ?? e?.headers?.['retry-after']);
  const err = new ProviderError(providerMessage(label, status, category, text, Number.isFinite(ra) && ra > 0 ? Math.ceil(ra) : undefined), status, status === 429 || status >= 500 || category === 'overloaded' || category === 'network', JSON.stringify(e?.error ?? '').slice(0, 2000), category);
  if (Number.isFinite(ra) && ra > 0) err.retryAfter = Math.ceil(ra);
  return err;
}

export function anthropicAdapter(o: { key: string | null; baseUrl?: string; label?: string; refusalFallback?: boolean; keyUrl?: string; maxRetries?: number }): ProviderAdapter {
  const label = o.label || 'Anthropic';
  const client = new Anthropic({ apiKey: o.key || undefined, baseURL: o.baseUrl || undefined, maxRetries: o.maxRetries ?? 2, fetch: ((url: any, init: any) => fetch(url, { ...init, redirect: 'error' })) as any });

  async function chatOnce(req: ChatRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void, stripThinking: boolean): Promise<ChatResult> {
    const legacy = LEGACY.test(req.model);
    const params: any = {
      model: req.model,
      max_tokens: req.maxTokens ?? (legacy ? 32000 : 64000),
      ...cacheParams(req.system, toAnthropicMessages(req.messages, stripThinking), !!o.baseUrl),
    };
    if (req.tools.length)
      params.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters, eager_input_streaming: true }));
    if (!legacy) {
      params.thinking = { type: 'adaptive', display: 'summarized' };
      // Only a level this model takes (xhigh on Opus 4.6 becomes high), see capabilities.ts.
      params.output_config = { effort: (EFFORTS.has(req.reasoning || '') && clampEffort(claudeInfo(req.model)?.reasoningLevels, req.reasoning)) || 'medium' };
    }
    const useFallback = o.refusalFallback !== false && FALLBACK_MODELS.has(req.model) && !o.baseUrl;
    const stream = useFallback
      ? (client.beta.messages as any).stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }, { signal })
      : client.messages.stream(params, { signal });

    for await (const ev of stream as AsyncIterable<any>) {
      if (ev.type === 'content_block_start' && ev.content_block?.type === 'tool_use') onEvent({ type: 'tool_start', id: ev.content_block.id, name: ev.content_block.name });
      else if (ev.type === 'content_block_delta') {
        if (ev.delta?.type === 'text_delta') onEvent({ type: 'text', delta: ev.delta.text });
        else if (ev.delta?.type === 'thinking_delta' && ev.delta.thinking) onEvent({ type: 'reasoning', delta: ev.delta.thinking });
      }
    }
    const final: any = await stream.finalMessage();

    let text = '';
    let reasoning = '';
    const toolCalls: ToolCall[] = [];
    for (const b of final.content || []) {
      if (b.type === 'text') text += b.text;
      else if (b.type === 'thinking' && b.thinking) reasoning += b.thinking;
      else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, args: b.input && typeof b.input === 'object' ? b.input : { __invalid_json: String(b.input ?? '') } });
    }
    const u = final.usage || {};
    const stopReason = final.stop_reason;
    let notice: string | undefined;
    if (stopReason === 'refusal') notice = `Het model weigerde dit verzoek${final.stop_details?.category ? ` (categorie: ${final.stop_details.category})` : ''}.`;
    const fb = (final.content || []).find((b: any) => b.type === 'fallback');
    if (fb) notice = `${fb.from?.model} weigerde; ${fb.to?.model} heeft het antwoord gegeven.`;

    return {
      text,
      reasoning: reasoning || undefined,
      // A refusal can cut a tool_use off mid-input: never run that turn's tools.
      toolCalls: stopReason === 'refusal' ? [] : toolCalls,
      usage: {
        input: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0),
        output: u.output_tokens || 0,
        cacheRead: u.cache_read_input_tokens || 0,
      },
      stop: stopReason === 'refusal' ? 'refusal' : stopReason === 'max_tokens' ? 'max_tokens' : toolCalls.length ? 'tool_use' : 'end',
      raw: { provider: 'anthropic', data: final.content },
      model: final.model || req.model,
      notice,
    };
  }

  return {
    kind: 'anthropic',
    async listModels(): Promise<ModelInfo[]> {
      const out: ModelInfo[] = [];
      try {
        for await (const m of client.models.list({ limit: 100 } as any) as any) {
          out.push({ id: m.id, label: m.display_name, context: m.max_input_tokens, vision: m.capabilities?.image_input ?? true, tools: true, reasoning: !LEGACY.test(m.id) });
        }
      } catch (e: any) {
        throw e instanceof ProviderError ? e : anthropicError(label, e);
      }
      rememberListPrices('anthropic', out);
      return out;
    },
    async test() {
      try {
        const m = await this.listModels();
        return { ok: true, verified: true, detail: `Sleutel werkt — ${modelsAvailable(m.length, 'Claude-modellen')}` };
      } catch (e: any) {
        const x = explain(e, { keyUrl: o.keyUrl });
        return { ok: false, detail: e?.message || String(e), hint: x.hint, category: x.category };
      }
    },
    async chat(req, signal, onEvent) {
      try {
        return await chatOnce(req, signal, onEvent, !!req.historyTruncated);
      } catch (e: any) {
        if (signal.aborted) throw e;
        // History edited (e.g. after trimming or an agent prompt change): retry without replayed thinking.
        if (e instanceof Anthropic.BadRequestError && /thinking|signature|prefix/i.test(e.message) && !req.historyTruncated) {
          return await chatOnce(req, signal, onEvent, true);
        }
        if (e instanceof ProviderError) throw e;
        if (e instanceof Anthropic.APIError || typeof e?.status === 'number' || /connection|fetch failed|ECONN/i.test(String(e?.message || e))) throw anthropicError(label, e);
        throw e;
      }
    },
  };
}
