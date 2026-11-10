import type { ChatMsg, ChatRequest, ChatResult, ProviderAdapter, StreamEvent, ToolCall } from '../core/types.js';
import { ERROR_TEXT, ProviderError, errorFromResponse, networkError, providerErrorFrom, readSSE, safeJson } from './common.js';
import { openaiInfo } from './capabilities.js';
import { parseToolArgs } from './tool-args.js';

/**
 * OpenAI Responses API (POST /v1/responses). OpenAI's current models only take tools together with reasoning here
 * (Chat Completions answers "set reasoning_effort to 'none'"), so the OpenAI provider uses this route for chat and
 * keeps Chat Completions for everything else and as a fallback for endpoints without /responses.
 * Stateless (store: false): reasoning items come back encrypted and are sent back unchanged within the tool loop.
 */

const RAW = 'oa-resp:openai';

function text(m: ChatMsg): string {
  return typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
}

export function toResponsesInput(msgs: ChatMsg[]): any[] {
  const out: any[] = [];
  let lastUser = -1;
  msgs.forEach((m, i) => {
    if (m.role === 'user') lastUser = i;
  });
  let pendingImages: any[] = [];
  const flush = () => {
    if (!pendingImages.length) return;
    out.push({ role: 'user', content: [{ type: 'input_text', text: pendingImages.length === 1 ? '[Afbeelding uit de tool-resultaten hierboven]' : '[Afbeeldingen uit de tool-resultaten hierboven]' }, ...pendingImages] });
    pendingImages = [];
  };
  msgs.forEach((m, i) => {
    if (m.role !== 'tool') flush();
    if (m.role === 'user') {
      out.push({ role: 'user', content: typeof m.content === 'string' ? [{ type: 'input_text', text: m.content }] : m.content.map((p) => (p.type === 'text' ? { type: 'input_text', text: p.text } : { type: 'input_image', image_url: `data:${p.mime};base64,${p.data}` })) });
    } else if (m.role === 'assistant') {
      const items: any[] | undefined = m.raw?.provider === RAW && Array.isArray(m.raw.data?.items) ? m.raw.data.items : undefined;
      if (items && i > lastUser) {
        // Same tool loop: the model's own items (encrypted reasoning, calls, text) go back unchanged.
        out.push(...items);
        return;
      }
      const t = text(m);
      if (t) out.push({ role: 'assistant', content: t });
      for (const c of m.toolCalls || []) out.push({ type: 'function_call', call_id: c.id, name: c.name, arguments: JSON.stringify(c.args ?? {}) });
    } else if (m.role === 'tool') {
      const output = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '[afbeelding: zie hieronder]')).join('\n');
      out.push({ type: 'function_call_output', call_id: m.toolCallId, output: output || '(leeg)' });
      if (typeof m.content !== 'string') for (const p of m.content) if (p.type === 'image') pendingImages.push({ type: 'input_image', image_url: `data:${p.mime};base64,${p.data}` });
    }
  });
  flush();
  return out;
}

export function openaiResponses(o: { label: string; baseUrl: string; key: string | null; fallback: ProviderAdapter }): ProviderAdapter {
  const base = o.baseUrl.replace(/\/+$/, '');
  /** Per model: what it refused (reasoning parameter, summaries), so the next turn does not repeat it. */
  const quirks = new Map<string, { noReasoning?: boolean; noSummary?: boolean }>();
  let unsupported = false;

  async function chat(req: ChatRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<ChatResult> {
    if (unsupported) return o.fallback.chat!(req, signal, onEvent);
    const q = quirks.get(req.model) || {};
    const body: any = { model: req.model, stream: true, store: false, input: toResponsesInput(req.messages) };
    if (req.system) body.instructions = req.system;
    if (req.tools.length) body.tools = req.tools.map((t) => ({ type: 'function', name: t.name, description: t.description, parameters: t.parameters, strict: false }));
    if (req.maxTokens) body.max_output_tokens = req.maxTokens;
    if (!q.noReasoning) {
      // xhigh and max only for a model whose page lists them (capabilities.ts); elsewhere they become high.
      const takes = openaiInfo(req.model)?.reasoningLevels || [];
      const e = (req.reasoning === 'xhigh' || req.reasoning === 'max') && !takes.includes(req.reasoning) ? 'high' : req.reasoning;
      body.reasoning = { ...(e && ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(e) ? { effort: e } : {}), ...(q.noSummary ? {} : { summary: 'auto' }) };
      body.include = ['reasoning.encrypted_content'];
    }
    let res: Response;
    try {
      res = await fetch(`${base}/responses`, { method: 'POST', headers: { 'content-type': 'application/json', ...(o.key ? { authorization: `Bearer ${o.key}` } : {}) }, body: JSON.stringify(body), signal, redirect: 'error' });
    } catch (e: any) {
      if (signal.aborted) throw e;
      throw networkError(o.label, e);
    }
    if (!res.ok) {
      const err = await errorFromResponse(res, o.label);
      const t = err.body || err.message;
      if (res.status === 404 && err.category !== 'model') {
        unsupported = true; // a proxy or server without /responses
        return o.fallback.chat!(req, signal, onEvent);
      }
      if (res.status === 400 && !q.noSummary && /summary/i.test(t) && body.reasoning?.summary) {
        quirks.set(req.model, { ...q, noSummary: true });
        return chat(req, signal, onEvent);
      }
      if (res.status === 400 && !q.noReasoning && /reasoning|encrypted_content|include/i.test(t)) {
        quirks.set(req.model, { ...q, noReasoning: true });
        return chat(req, signal, onEvent);
      }
      throw err;
    }

    let out = '';
    let reasoning = '';
    let status = '';
    let incomplete = '';
    const usage = { input: 0, output: 0, cacheRead: 0 } as { input: number; output: number; cacheRead: number; reasoning?: number };
    const items: any[] = [];
    const calls = new Map<string, { id: string; name: string; args: string }>();
    let model = req.model;
    for await (const ev of readSSE(res)) {
      const j = safeJson(ev.data);
      if (!j) continue;
      const type = j.type || ev.event;
      if (type === 'response.output_text.delta' && typeof j.delta === 'string') {
        out += j.delta;
        onEvent({ type: 'text', delta: j.delta });
      } else if ((type === 'response.reasoning_summary_text.delta' || type === 'response.reasoning_text.delta') && typeof j.delta === 'string') {
        reasoning += j.delta;
        onEvent({ type: 'reasoning', delta: j.delta });
      } else if (type === 'response.reasoning_summary_part.done' && reasoning && !reasoning.endsWith('\n\n')) {
        reasoning += '\n\n';
      } else if (type === 'response.output_item.added' && j.item?.type === 'function_call') {
        calls.set(j.item.id, { id: j.item.call_id, name: j.item.name, args: '' });
        onEvent({ type: 'tool_start', id: j.item.call_id, name: j.item.name });
      } else if (type === 'response.function_call_arguments.delta') {
        const c = calls.get(j.item_id);
        if (c) c.args += j.delta || '';
      } else if (type === 'response.output_item.done' && j.item) {
        items.push(j.item);
        if (j.item.type === 'function_call') calls.set(j.item.id, { id: j.item.call_id, name: j.item.name, args: j.item.arguments ?? calls.get(j.item.id)?.args ?? '' });
      } else if (type === 'response.completed' || type === 'response.incomplete' || type === 'response.failed') {
        const r = j.response || {};
        status = r.status || type.split('.')[1];
        if (r.model) model = r.model;
        incomplete = r.incomplete_details?.reason || '';
        const u = r.usage || {};
        usage.input = u.input_tokens ?? 0;
        usage.output = u.output_tokens ?? 0;
        usage.cacheRead = u.input_tokens_details?.cached_tokens ?? 0;
        if (typeof u.output_tokens_details?.reasoning_tokens === 'number') usage.reasoning = u.output_tokens_details.reasoning_tokens;
        if (type === 'response.failed') {
          const e = r.error || {};
          throw providerErrorFrom(o.label, /rate/i.test(e.code || '') ? 429 : /server|overload/i.test(e.code || '') ? 503 : 0, JSON.stringify({ error: { message: e.message || 'Het antwoord mislukte', code: e.code } }));
        }
      } else if (type === 'error') {
        throw providerErrorFrom(o.label, Number(j.status) || 0, JSON.stringify({ error: { message: j.message || j.error?.message, code: j.code || j.error?.code } }));
      }
    }
    if (!status) throw new ProviderError(`${o.label}: ${ERROR_TEXT.overloaded.title} — het antwoord brak af`, 0, true, '', 'overloaded');
    const toolCalls: ToolCall[] = [...calls.values()]
      .filter((c) => c.name)
      .map((c) => ({ id: c.id, name: c.name, args: parseToolArgs(c.args) }));
    const result: ChatResult = {
      text: out,
      reasoning: reasoning.trim() || undefined,
      toolCalls,
      usage,
      model,
      stop: toolCalls.length ? 'tool_use' : incomplete === 'max_output_tokens' ? 'max_tokens' : incomplete === 'content_filter' ? 'refusal' : 'end',
    };
    // Within the tool loop the model's own items (with encrypted reasoning) go back unchanged.
    if (toolCalls.length) result.raw = { provider: RAW, data: { items: items.filter((it) => it.type === 'reasoning' || it.type === 'function_call' || it.type === 'message') } };
    if (result.stop === 'refusal' && !out) result.notice = 'Het inhoudsfilter van de provider hield dit antwoord tegen.';
    return result;
  }

  return { kind: 'openai', listModels: () => o.fallback.listModels(), test: () => o.fallback.test(), chat };
}
