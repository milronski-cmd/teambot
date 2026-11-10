import type { ChatMsg, ChatRequest, ChatResult, ModelInfo, ProviderAdapter, StreamEvent, ToolCall } from '../core/types.js';
import { ERROR_TEXT, ProviderError, categoryOf, errorFromResponse, explain, fetchJson, modelsAvailable, networkError, providerErrorFrom, readSSE, safeJson, type ErrorCategory } from './common.js';
import { rememberListPrices } from './pricing.js';
import { answerError, emptyError, errorInAnswer, stallGuard, truncatedError } from './answer-check.js';
import { parseToolArgs } from './tool-args.js';
import { repairTextToolCalls } from './toolcall-text.js';

/** Errors that are about the key or the account: never hidden behind the built-in model list. */
const KEY_PROBLEMS = new Set<ErrorCategory>(['auth', 'forbidden', 'quota']);
/** Errors that only mean "this address has no usable model list" (the server answered, the key was not refused). */
const NO_LIST = new Set<ErrorCategory>(['endpoint', 'model', 'bad_request', 'other']);

/** How a provider wants to be asked for reasoning ("denkniveau"). */
export type ReasoningStyle =
  | 'effort' // reasoning_effort: low|medium|high (OpenAI, Gemini, Groq, Cerebras, Fireworks, Together, ...)
  | 'openrouter' // reasoning: { effort }
  | 'xai' // reasoning_effort on Grok 4.5+ and the mini models; older Grok 4 always reasons and rejects it
  | 'deepseek' // reasoning_effort low|high|max, thinking:{type:'disabled'} to turn it off
  | 'zai' // thinking: { type: enabled|disabled }
  | 'qwen' // enable_thinking: true|false
  | 'none';

export interface KeyCheckResult {
  ok: boolean;
  detail: string;
  /** The key was really checked (not just a public model list). */
  verified: boolean;
  /** Plain-language credit/limit info, e.g. "Tegoed: $4.20". */
  credit?: string;
  category?: string;
  hint?: string;
}

export interface OpenAICompatOptions {
  kind: string;
  label: string;
  baseUrl: string;
  /** API key, or a function that returns a fresh bearer token (Vertex AI). */
  key: string | null | (() => Promise<string>);
  headers?: Record<string, string>;
  /** Send stream_options.include_usage (most hosted APIs support it). */
  usageInStream?: boolean;
  /** How to ask for reasoning; null/undefined = never send a reasoning parameter. */
  reasoning?: ReasoningStyle | null;
  /** @deprecated use `reasoning` */
  reasoningParam?: 'reasoning_effort' | null;
  /** Filter for /models output. */
  modelFilter?: (id: string) => boolean;
  /** Fallback model list when /models is unavailable. */
  staticModels?: string[];
  /** Use "api-key" header instead of Authorization (Azure). */
  apiKeyHeader?: string;
  /** Extra fields from one /models entry: price, free, context, vision, tools. null = hide the entry. */
  parseModel?: (raw: any) => Partial<ModelInfo> | null;
  /** Replace the /models call (Cloudflare, GitHub Models catalog, Bedrock ...). */
  listModels?: (h: { base: string; headers: () => Promise<Record<string, string>> }) => Promise<ModelInfo[]>;
  /** Send reasoning_content back: 'loop' = assistant turns of the current tool loop (Kimi, GLM), 'all' = every earlier tool turn (DeepSeek returns 400 otherwise). */
  replayReasoning?: 'loop' | 'all' | boolean;
  /** Extra fields for every chat request (e.g. MiniMax reasoning_split). */
  extraBody?: Record<string, any>;
  /** Free key/credit check (OpenRouter /key, DeepSeek /user/balance, ...). Falls back to the model list. */
  keyCheck?: (h: { base: string; headers: () => Promise<Record<string, string>>; label: string }) => Promise<KeyCheckResult>;
  /** Model list needs no key, so it does not prove the key works. */
  publicModelList?: boolean;
  keyUrl?: string;
  /** Use max_completion_tokens (OpenAI, Azure). */
  maxCompletionTokens?: boolean;
  /**
   * Free/flaky providers (answer-check.ts): an error text inside a "successful" answer, an empty answer, a stream that
   * ends without its end marker or goes quiet all count as a failure. Text is held back until it clearly is no error.
   */
  answerCheck?: boolean;
  /** Silence limits for answerCheck (ms); default STALL_MS. */
  stallMs?: { first: number; idle: number };
  /** Sees the status and headers of every chat response (rate-limit headers for the free-models module). */
  onResponse?: (r: { status: number; headers: Headers; model: string }) => void;
}

/** With answerCheck: this much text is held back before it is shown (an error message is shorter). */
const HOLD_CHARS = 600;

/** Marker for provider-native extras we replay to the same kind only (never to another provider). */
const rawTag = (kind: string) => `oa:${kind}`;

export function toOpenAIMessages(system: string, msgs: ChatMsg[], opts: { kind?: string; model?: string; replayReasoning?: 'loop' | 'all' | boolean } = {}): any[] {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });
  let pendingImages: any[] = [];
  const flushImages = () => {
    if (!pendingImages.length) return;
    out.push({ role: 'user', content: [{ type: 'text', text: pendingImages.length === 1 ? '[Afbeelding uit de tool-resultaten hierboven]' : '[Afbeeldingen uit de tool-resultaten hierboven]' }, ...pendingImages] });
    pendingImages = [];
  };
  // Only the assistant turns after the last user message belong to the current tool loop.
  let lastUser = -1;
  msgs.forEach((m, i) => {
    if (m.role === 'user') lastUser = i;
  });
  msgs.forEach((m, i) => {
    if (m.role !== 'tool') flushImages();
    if (m.role === 'user') {
      if (typeof m.content === 'string') out.push({ role: 'user', content: m.content });
      else
        out.push({
          role: 'user',
          content: m.content.map((p) => (p.type === 'text' ? { type: 'text', text: p.text } : { type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } })),
        });
    } else if (m.role === 'assistant') {
      const text = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      const msg: any = { role: 'assistant', content: text || null };
      const own = !!opts.kind && m.raw?.provider === rawTag(opts.kind) ? m.raw.data || {} : null;
      if (m.toolCalls?.length)
        msg.tool_calls = m.toolCalls.map((c, idx) => {
          const tc: any = { id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args ?? {}) } };
          const extra = own?.toolExtras?.[c.id];
          if (extra) tc.extra_content = extra;
          // Gemini 3 refuses a function call without a thought signature; calls made by another engine get the
          // documented placeholder that skips the check (only on the first call of a turn).
          else if ((opts.kind === 'google' || opts.kind === 'vertex') && idx === 0 && /gemini-[3-9]/.test(opts.model || '')) tc.extra_content = { google: { thought_signature: 'skip_thought_signature_validator' } };
          return tc;
        });
      if (own && opts.replayReasoning && (opts.replayReasoning === 'all' || i > lastUser) && typeof own.reasoning_content === 'string' && own.reasoning_content) msg.reasoning_content = own.reasoning_content;
      // OpenRouter: reasoning_details go back unchanged so Gemini 3 / Claude keep their reasoning across tool calls.
      if (own && Array.isArray(own.reasoning_details) && own.reasoning_details.length) msg.reasoning_details = own.reasoning_details;
      if (!msg.content && !msg.tool_calls) msg.content = '';
      out.push(msg);
    } else if (m.role === 'tool') {
      if (typeof m.content === 'string') out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content });
      else {
        out.push({ role: 'tool', tool_call_id: m.toolCallId, content: m.content.map((p) => (p.type === 'text' ? p.text : '[afbeelding: zie hieronder]')).join('\n') });
        for (const p of m.content) if (p.type === 'image') pendingImages.push({ type: 'image_url', image_url: { url: `data:${p.mime};base64,${p.data}` } });
      }
    }
  });
  flushImages();
  return out;
}

/** Splits a leading <think>…</think> block (DeepSeek-R1 distills, Qwen3, MiniMax, Perplexity reasoning) from the answer. */
export class ThinkSplitter {
  private mode: 'start' | 'think' | 'text' = 'start';
  private buf = '';
  constructor(private emit: (kind: 'text' | 'reasoning', s: string) => void) {}
  push(s: string) {
    if (this.mode === 'text') return this.emit('text', s);
    this.buf += s;
    if (this.mode === 'start') {
      const t = this.buf.replace(/^\s+/, '');
      if (!t) return;
      if ('<think>'.startsWith(t) && t.length < 7) return; // wait for more
      if (t.startsWith('<think>')) {
        this.mode = 'think';
        this.buf = t.slice(7);
      } else {
        this.mode = 'text';
        const b = this.buf;
        this.buf = '';
        return this.emit('text', b);
      }
    }
    if (this.mode === 'think') {
      const end = this.buf.indexOf('</think>');
      if (end >= 0) {
        if (end > 0) this.emit('reasoning', this.buf.slice(0, end));
        const rest = this.buf.slice(end + 8).replace(/^\s+/, '');
        this.buf = '';
        this.mode = 'text';
        if (rest) this.emit('text', rest);
      } else if (this.buf.length > 8) {
        // Keep a tail that could be the start of "</think>".
        const keep = 8;
        this.emit('reasoning', this.buf.slice(0, -keep));
        this.buf = this.buf.slice(-keep);
      }
    }
  }
  end() {
    if (this.buf) this.emit(this.mode === 'think' ? 'reasoning' : 'text', this.buf);
    this.buf = '';
  }
}

type Retry = { tokenParam?: 'max_tokens' | 'max_completion_tokens'; noUsage?: boolean; noReasoning?: boolean; effortNone?: boolean };

/**
 * What a model refused before (per provider kind + base URL + model), so the next turn does not repeat a failing
 * request: e.g. OpenAI's gpt-6 models refuse tools together with reasoning in Chat Completions.
 */
const QUIRKS = new Map<string, Retry>();
export function clearModelQuirks() {
  QUIRKS.clear();
}

function reasoningBody(style: ReasoningStyle | null | undefined, effort: string | undefined, model: string): Record<string, any> {
  if (!style || style === 'none' || !effort) return {};
  const e = effort === 'xhigh' || effort === 'max' ? 'high' : effort;
  if (!['minimal', 'low', 'medium', 'high', 'none'].includes(e)) return {};
  switch (style) {
    case 'effort':
      return { reasoning_effort: e };
    case 'openrouter':
      return { reasoning: e === 'none' ? { enabled: false } : { effort: e === 'minimal' ? 'low' : e } };
    case 'xai': {
      if (/mini/i.test(model)) return e === 'low' || e === 'high' ? { reasoning_effort: e } : {};
      // Versions read as decimals: grok-4.20 is older than grok-4.5.
      const v = /^grok-(\d+(?:\.\d+)?)/.exec(model);
      const newer = !!v && parseFloat(v[1]) >= 4.5;
      return newer && e !== 'none' && e !== 'minimal' ? { reasoning_effort: effort === 'xhigh' ? 'xhigh' : e } : {};
    }
    case 'deepseek':
      if (e === 'none' || e === 'minimal') return { thinking: { type: 'disabled' } };
      return { reasoning_effort: effort === 'xhigh' || effort === 'max' ? 'max' : e === 'medium' ? 'high' : e };
    case 'zai':
      return { thinking: { type: e === 'none' || e === 'minimal' ? 'disabled' : 'enabled' } };
    case 'qwen':
      return { enable_thinking: !(e === 'none' || e === 'minimal') };
  }
  return {};
}

export function openaiCompat(o: OpenAICompatOptions): ProviderAdapter {
  const base = o.baseUrl.replace(/\/+$/, '');
  const reasoningStyle: ReasoningStyle | null = o.reasoning !== undefined ? o.reasoning : o.reasoningParam ? 'effort' : null;
  const headers = async (): Promise<Record<string, string>> => {
    const h: Record<string, string> = { 'content-type': 'application/json', ...(o.headers || {}) };
    const key = typeof o.key === 'function' ? await o.key() : o.key;
    if (key) {
      if (o.apiKeyHeader) h[o.apiKeyHeader] = key;
      else h.authorization = `Bearer ${key}`;
    }
    return h;
  };

  // "Test verbinding" and the model picker ask right after each other: one request is enough.
  let memo: { at: number; list: ModelInfo[] } | null = null;
  /** The model picker: the live list, or the built-in list when the provider has no (reachable) list — but never
   *  when the provider says the key is wrong: then the error is the answer. */
  async function listModels(): Promise<ModelInfo[]> {
    try {
      return await liveModels();
    } catch (e) {
      if (o.staticModels?.length && !KEY_PROBLEMS.has(categoryOf(e))) return o.staticModels.map((id) => ({ id }));
      throw e;
    }
  }
  /** The provider's own model list (no fallback): this is what "Test verbinding" relies on. */
  async function liveModels(): Promise<ModelInfo[]> {
    if (memo && Date.now() - memo.at < 10_000) return memo.list;
    {
      let list: ModelInfo[];
      if (o.listModels) list = await o.listModels({ base, headers });
      else {
        const j = await fetchJson(`${base}/models`, { headers: await headers() }, o.label);
        const arr: any[] = Array.isArray(j) ? j : j.data || j.models || [];
        list = arr
          .map((m: any): ModelInfo | null => {
            const id = String(m.id || m.name || '').replace(/^models\//, '');
            const extra = o.parseModel ? o.parseModel(m) : {};
            if (extra === null) return null;
            const base: ModelInfo = { id, label: m.name && m.name !== m.id && !String(m.name).startsWith('models/') ? m.name : undefined, context: m.context_length || m.context_window || m.max_model_len || undefined };
            for (const [k, v] of Object.entries(extra)) if (v !== undefined) (base as any)[k] = v;
            return base;
          })
          .filter((m): m is ModelInfo => !!m && !!m.id && (!o.modelFilter || o.modelFilter(m.id)));
      }
      list.sort((a, b) => a.id.localeCompare(b.id));
      rememberListPrices(o.kind, list);
      memo = { at: Date.now(), list };
      return list;
    }
  }

  async function chat(req: ChatRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void, withTools = true, retryIn: Retry = {}): Promise<ChatResult> {
    const quirkKey = `${o.kind}\u0000${base}\u0000${req.model}`;
    const retry: Retry = { ...(QUIRKS.get(quirkKey) || {}), ...retryIn };
    const remember = (r: Retry) => QUIRKS.set(quirkKey, { ...(QUIRKS.get(quirkKey) || {}), ...r });
    const body: any = {
      model: req.model,
      stream: true,
      messages: toOpenAIMessages(req.system, req.messages, { kind: o.kind, model: req.model, replayReasoning: o.replayReasoning }),
    };
    if (withTools && req.tools.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
    if (o.usageInStream !== false && !retry.noUsage) body.stream_options = { include_usage: true };
    if (o.extraBody) Object.assign(body, o.extraBody);
    if (!retry.noReasoning) Object.assign(body, reasoningBody(reasoningStyle, req.reasoning, req.model));
    // The model only takes tools with reasoning switched off (OpenAI gpt-6 family in Chat Completions).
    if (retry.effortNone && body.tools) body.reasoning_effort = 'none';
    // OpenAI's current models only accept max_completion_tokens; most other compatible servers want max_tokens.
    const tokenParam = retry.tokenParam || (o.maxCompletionTokens || /api\.openai\.com/.test(base) ? 'max_completion_tokens' : 'max_tokens');
    if (req.maxTokens) body[tokenParam] = req.maxTokens;

    const guard = o.answerCheck ? stallGuard(signal, o.stallMs) : null;
    let res: Response;
    try {
      res = await fetch(`${base}/chat/completions`, { method: 'POST', headers: await headers(), body: JSON.stringify(body), signal: guard?.signal || signal, redirect: 'error' });
    } catch (e: any) {
      guard?.done();
      if (guard?.stalled) throw guard.error(o.label);
      if (signal.aborted) throw e;
      throw networkError(o.label, e);
    }
    try {
      o.onResponse?.({ status: res.status, headers: res.headers, model: req.model });
    } catch {
      /* an observer never breaks a chat */
    }
    if (!res.ok) {
      guard?.done();
      const err = await errorFromResponse(res, o.label);
      const text = err.body || err.message;
      // A server that rejects the token-limit parameter name: retry once with the other name.
      if (res.status === 400 && req.maxTokens && !retry.tokenParam && /max_(completion_)?tokens/i.test(text)) {
        const t: Retry = { tokenParam: tokenParam === 'max_tokens' ? 'max_completion_tokens' : 'max_tokens' };
        remember(t);
        return chat(req, signal, onEvent, withTools, { ...retry, ...t });
      }
      // "Function tools with reasoning_effort are not supported ... set reasoning_effort to 'none'": keep the tools.
      if (res.status === 400 && body.tools && !retry.effortNone && /reasoning_effort/i.test(text) && /'none'|"none"|\bnone\b/i.test(text)) {
        remember({ effortNone: true, noReasoning: true });
        return chat(req, signal, onEvent, withTools, { ...retry, effortNone: true, noReasoning: true });
      }
      // A model that does not take the reasoning parameter (e.g. a non-reasoning model on the same provider).
      if (res.status === 400 && !retry.noReasoning && /reasoning|thinking|enable_thinking/i.test(text) && Object.keys(reasoningBody(reasoningStyle, req.reasoning, req.model)).length) {
        remember({ noReasoning: true });
        return chat(req, signal, onEvent, withTools, { ...retry, noReasoning: true });
      }
      // Some local/small models do not support tool calling: retry once without tools.
      if (withTools && body.tools && res.status >= 400 && res.status < 500 && /tool|function/i.test(text) && !/reasoning_effort/i.test(text) && err.category !== 'auth' && err.category !== 'quota' && err.category !== 'rate_limit') {
        const r = await chat(req, signal, onEvent, false, retry);
        r.notice = `Dit model ondersteunt geen tools; antwoord zonder tools gegeven.`;
        return r;
      }
      // Retry without stream_options for providers that reject it.
      if (body.stream_options && res.status === 400 && /stream_options|include_usage/i.test(text)) {
        remember({ noUsage: true });
        return chat(req, signal, onEvent, withTools, { ...retry, noUsage: true });
      }
      throw err;
    }

    let text = '';
    let reasoning = '';
    const images: { mime: string; data: string }[] = [];
    const calls = new Map<number, { id: string; name: string; args: string; extra?: any }>();
    const details: any[] = [];
    let finish = '';
    const usage: { input: number; output: number; cacheRead: number; cost?: number; reasoning?: number } = { input: 0, output: 0, cacheRead: 0 };
    let model = req.model;
    // answerCheck: the first text is held back until it clearly is no error message (then it is never shown).
    let held: string | null = o.answerCheck ? '' : null;
    const release = () => {
      if (held) onEvent({ type: 'text', delta: held });
      held = null;
    };
    const split = new ThinkSplitter((kind, s) => {
      if (kind === 'text') {
        text += s;
        if (held === null) onEvent({ type: 'text', delta: s });
        else if ((held += s).length >= HOLD_CHARS) release();
      } else {
        reasoning += s;
        onEvent({ type: 'reasoning', delta: s });
      }
    });
    const addReasoning = (s: string) => {
      reasoning += s;
      onEvent({ type: 'reasoning', delta: s });
    };
    const addImage = (url: string) => {
      const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(url || '');
      if (m) images.push({ mime: m[1], data: m[2] });
    };

    const handle = (j: any) => {
      if (j.error) {
        const status = typeof j.error.code === 'number' ? j.error.code : Number(j.error.status) || 0;
        throw providerErrorFrom(o.label, status, JSON.stringify(j));
      }
      const br = j.base_resp;
      if (br && typeof br.status_code === 'number' && br.status_code !== 0) throw providerErrorFrom(o.label, 0, JSON.stringify(j));
      if (j.model) model = j.model;
      if (j.usage) {
        const u = j.usage;
        usage.input = u.prompt_tokens ?? u.input_tokens ?? usage.input;
        usage.output = u.completion_tokens ?? u.output_tokens ?? usage.output;
        usage.cacheRead = u.prompt_tokens_details?.cached_tokens ?? u.prompt_cache_hit_tokens ?? u.cached_tokens ?? usage.cacheRead;
        if (typeof u.cost === 'number') usage.cost = u.cost; // OpenRouter (credits = USD)
        else if (typeof u.cost_in_usd_ticks === 'number') usage.cost = u.cost_in_usd_ticks / 1e10; // xAI
        const rt = u.completion_tokens_details?.reasoning_tokens;
        if (typeof rt === 'number') usage.reasoning = rt;
      }
      for (const ch of j.choices || []) {
        if ((ch.index ?? 0) !== 0) continue;
        const d = ch.delta || ch.message || {};
        if (typeof d.content === 'string' && d.content) split.push(d.content);
        else if (Array.isArray(d.content)) {
          // Mistral (Magistral) streams typed chunks: text and thinking.
          for (const part of d.content) {
            if (part?.type === 'text' && part.text) split.push(part.text);
            else if (part?.type === 'thinking') {
              const t = Array.isArray(part.thinking) ? part.thinking.map((x: any) => x?.text || '').join('') : String(part.thinking || '');
              if (t) addReasoning(t);
            } else if (part?.type === 'image_url' && part.image_url?.url) addImage(part.image_url.url);
          }
        }
        const rc = d.reasoning_content ?? d.reasoning;
        if (typeof rc === 'string' && rc) addReasoning(rc);
        if (Array.isArray(d.reasoning_details)) {
          for (const r of d.reasoning_details) {
            if (!r || typeof r !== 'object') continue;
            if (!rc && r.type === 'reasoning.text' && r.text) addReasoning(r.text);
            else if (!rc && r.type === 'reasoning.summary' && r.summary) addReasoning(r.summary);
            // Streamed pieces of one detail share type + index: join them so they can be sent back whole.
            const prev = details.find((x) => x.type === r.type && (x.index ?? 0) === (r.index ?? 0));
            if (!prev) details.push({ ...r });
            else
              for (const k of ['text', 'summary', 'data']) if (typeof r[k] === 'string') prev[k] = (prev[k] || '') + r[k];
            if (prev && r.signature) prev.signature = r.signature;
          }
        }
        if (Array.isArray(d.images)) for (const im of d.images) addImage(im?.image_url?.url || im?.url);
        if (Array.isArray(d.tool_calls)) {
          for (const tc of d.tool_calls) {
            const idx = tc.index ?? calls.size;
            let c = calls.get(idx);
            if (!c) {
              c = { id: tc.id || `call_${idx}_${Date.now()}`, name: '', args: '' };
              calls.set(idx, c);
            }
            if (tc.id) c.id = tc.id;
            if (tc.extra_content) c.extra = tc.extra_content;
            if (tc.function?.name) {
              // Most servers send the name once; a few repeat it in every chunk.
              c.name = c.name && tc.function.name.startsWith(c.name) ? tc.function.name : c.name === tc.function.name ? c.name : c.name + tc.function.name;
              release(); // a tool call: the text before it is no error message
              onEvent({ type: 'tool_start', id: c.id, name: c.name });
            }
            if (tc.function?.arguments !== undefined) c.args += typeof tc.function.arguments === 'string' ? tc.function.arguments : JSON.stringify(tc.function.arguments);
          }
        }
        if (ch.finish_reason) finish = ch.finish_reason;
      }
    };

    const ctype = res.headers.get('content-type') || '';
    let complete = false; // the [DONE] marker or a whole JSON answer arrived
    try {
      if (/application\/json/i.test(ctype) && !/event-stream/i.test(ctype)) {
        // Server ignored stream:true and answered in one piece.
        const j = safeJson(await res.text());
        if (!j) throw new ProviderError(`${o.label}: ${ERROR_TEXT.bad_request.title} — onleesbaar antwoord`, res.status, false, '', 'bad_request');
        handle(j);
        complete = true;
      } else {
        for await (const ev of readSSE(res)) {
          guard?.touch();
          if (ev.data === '[DONE]') {
            complete = true;
            break;
          }
          const j = safeJson(ev.data);
          if (!j) continue;
          if (ev.event === 'error' && !j.error) j.error = j;
          handle(j);
        }
      }
    } catch (e) {
      if (guard?.stalled) throw guard.error(o.label);
      throw e;
    } finally {
      guard?.done();
    }
    split.end();
    if (finish === 'error') throw new ProviderError(`${o.label}: ${ERROR_TEXT.overloaded.title} — het antwoord brak af`, 0, true, '', 'overloaded');
    if (o.answerCheck) {
      if (!complete && !finish) throw truncatedError(o.label);
      if (!calls.size) {
        const bad = errorInAnswer(text);
        if (bad) throw answerError(o.label, bad, text);
        if (!text.trim() && !images.length && finish !== 'length' && finish !== 'content_filter' && finish !== 'SAFETY') throw emptyError(o.label);
      }
      release();
    }

    const toolCalls: ToolCall[] = [...calls.values()]
      .filter((c) => c.name)
      .map((c) => ({ id: c.id, name: c.name, args: parseToolArgs(c.args, finish === 'length') }));
    const extras: Record<string, any> = {};
    for (const c of calls.values()) if (c.extra && c.name) extras[c.id] = c.extra;
    const rawData: any = {};
    if (Object.keys(extras).length) rawData.toolExtras = extras;
    if (o.replayReasoning && reasoning && toolCalls.length) rawData.reasoning_content = reasoning;
    if (details.length && toolCalls.length) rawData.reasoning_details = details;

    const result: ChatResult = {
      text,
      reasoning: reasoning || undefined,
      toolCalls,
      usage,
      model,
      stop: toolCalls.length ? 'tool_use' : finish === 'length' ? 'max_tokens' : finish === 'content_filter' || finish === 'SAFETY' ? 'refusal' : 'end',
    };
    if (Object.keys(rawData).length) result.raw = { provider: rawTag(o.kind), data: rawData };
    if (images.length) result.images = images;
    if (result.stop === 'refusal' && !text) result.notice = 'Het inhoudsfilter van de provider hield dit antwoord tegen.';
    // A tool call the model wrote as text (free and local models: JSON, Qwen3-Coder XML) becomes a real one.
    return withTools ? repairTextToolCalls(result, req.tools) : result;
  }

  async function test(): Promise<{ ok: boolean; detail: string; hint?: string; category?: string; verified?: boolean; credit?: string }> {
    try {
      if (o.keyCheck) {
        const r = await o.keyCheck({ base, headers, label: o.label });
        if (!r.ok) return r;
        let n = 0;
        try {
          n = (await listModels()).length;
        } catch {
          /* key check passed; the list is optional */
        }
        return { ...r, detail: `${r.detail}${n ? ` — ${modelsAvailable(n)}` : ''}` };
      }
      // The live list, never the built-in one: a wrong key must never look like "Sleutel werkt".
      let m: ModelInfo[];
      try {
        m = await liveModels();
      } catch (e) {
        // No list at this address (404, odd answer), but the provider was reached and did not reject the key: the
        // built-in list is usable, and we say honestly that the key itself is not checked yet.
        if (!o.staticModels?.length || !NO_LIST.has(categoryOf(e))) throw e;
        const n = o.staticModels.length;
        return {
          ok: true,
          verified: false,
          detail:
            n === 1
              ? `Verbonden, maar ${o.label} gaf geen modellenlijst; TeamBot gebruikt zijn eigen lijst (1 model). De sleutel zelf wordt pas bij het eerste bericht gecontroleerd.`
              : `Verbonden, maar ${o.label} gaf geen modellenlijst; TeamBot gebruikt zijn eigen lijst (${n} modellen). De sleutel zelf wordt pas bij het eerste bericht gecontroleerd.`,
        };
      }
      const verified = !o.publicModelList && !!(o.key || typeof o.key === 'function');
      return {
        ok: true,
        verified,
        detail: `${verified ? 'Sleutel werkt' : 'Verbonden'}${m.length ? ` — ${modelsAvailable(m.length)}` : ''}${o.publicModelList ? '. De sleutel zelf wordt pas bij het eerste bericht gecontroleerd (gratis controle bestaat hier niet).' : ''}`,
      };
    } catch (e: any) {
      const x = explain(e, { keyUrl: o.keyUrl });
      return { ok: false, detail: e?.message || String(e), hint: x.hint, category: x.category, verified: false };
    }
  }

  return {
    kind: o.kind,
    listModels,
    test,
    chat: (req, signal, onEvent) => chat(req, signal, onEvent, true),
  };
}
