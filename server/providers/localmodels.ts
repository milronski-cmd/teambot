import type { ChatMsg, ChatRequest, ChatResult, ModelInfo, ProviderAdapter, StreamEvent, ToolCall, ToolSpec } from '../core/types.js';
import { CHARS_PER_TOKEN } from '../core/tokens.js';
import { ERROR_TEXT, categoryOf, errorFromResponse, networkError, ProviderError, providerErrorFrom } from './common.js';
import { clampEffort, type Effort } from './capabilities.js';
import { ThinkSplitter } from './openai-compat.js';
import { repairTextToolCalls } from './toolcall-text.js';

/**
 * Local models (C-01, C-11, C-13). Ollama: what each model can do comes from Ollama itself (/api/show: tools, vision,
 * thinking, context length, layer sizes), and chats go through its native /api/chat, which — unlike its OpenAI layer —
 * takes the context window (options.num_ctx) and switches thinking on or off (think). LM Studio fixes the context
 * window when it loads a model, so TeamBot (re)loads the model with the chosen window. llama.cpp fixes it when the
 * server starts: TeamBot shows what it is and how to change it.
 *
 * All three fit every request into the window the model runs with (fitChat), so the server never cuts it silently,
 * and all three turn a tool call that a model wrote as plain text back into a real tool call (toolCallsFromText).
 * Ollama keeps its OpenAI layer when nothing needs the native API: a live check (Ollama 0.40.15, 9 November 2026, a
 * qwen3.6 35B-A3B GGUF) gave the same real tool call over /v1 and /api/chat, twice each.
 */

/** Context windows offered in the UI (tokens). */
export const CONTEXT_STEPS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
/** Below this a bot with tools and instructions runs out of room quickly. */
export const RECOMMENDED_CONTEXT = 16384;

export const originOf = (base: string) => {
  try {
    return new URL(base).origin;
  } catch {
    return base.replace(/\/v1\/?$/, '');
  }
};

async function json(url: string, init: RequestInit = {}, timeoutMs = 4000): Promise<any> {
  const r = await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
  if (!r.ok) throw new ProviderError(`HTTP ${r.status}`, r.status);
  return r.json();
}

/** The context window chosen for a model on this provider (config.contextWindows), or undefined = the server's own. */
export function chosenContext(config: Record<string, any> | undefined, model: string): number | undefined {
  const v = Number(config?.contextWindows?.[model]);
  return Number.isInteger(v) && v >= 1024 && v <= 4_194_304 ? v : undefined;
}

/** KV-cache bytes per token from Ollama's model_info (f16 cache): layers × kv-heads × (key + value length) × 2 bytes. */
export function kvBytesPerToken(info: Record<string, any> | undefined): number | undefined {
  if (!info) return undefined;
  const arch = String(info['general.architecture'] || '');
  const get = (k: string) => info[`${arch}.${k}`];
  const layers = Number(get('block_count'));
  const heads = Number(get('attention.head_count'));
  const embed = Number(get('embedding_length'));
  const kvRaw = get('attention.head_count_kv');
  const kLen = Number(get('attention.key_length')) || (heads ? embed / heads : 0);
  const vLen = Number(get('attention.value_length')) || kLen;
  if (!layers || !kLen) return undefined;
  // Some models give the kv-heads per layer (0 for layers without attention, e.g. hybrid models). Others say that only
  // every n-th layer has attention (Qwen3.5/3.6: full_attention_interval 4); the rest keep a small fixed state.
  const interval = Number(get('full_attention_interval'));
  const attnLayers = interval > 1 ? Math.ceil(layers / interval) : layers;
  const kvHeads = Array.isArray(kvRaw) ? kvRaw.reduce((s: number, x: any) => s + (Number(x) || 0), 0) : (Number(kvRaw) || heads) * attnLayers;
  if (!kvHeads) return undefined;
  return Math.round(kvHeads * (kLen + vLen) * 2);
}

const showCache = new Map<string, { digest: string; v: any }>();

/** Ollama's models with what Ollama says they can do; plus the window a loaded model runs with now (/api/ps). */
export async function ollamaModels(base: string): Promise<ModelInfo[]> {
  const o = originOf(base);
  const tags = await json(`${o}/api/tags`);
  const ps = await json(`${o}/api/ps`).catch(() => ({ models: [] }));
  const loaded = new Map<string, number>((ps?.models || []).map((m: any) => [String(m.name || m.model), Number(m.context_length) || 0]));
  const out: ModelInfo[] = [];
  for (const t of tags?.models || []) {
    const name = String(t.name || t.model || '');
    if (!name) continue;
    let show = showCache.get(name);
    if (!show || show.digest !== t.digest) {
      const v = await json(`${o}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model: name }) }, 8000).catch(() => null);
      show = { digest: String(t.digest || ''), v };
      if (v) showCache.set(name, show);
    }
    const caps: string[] = Array.isArray(t.capabilities) ? t.capabilities : Array.isArray(show?.v?.capabilities) ? show!.v.capabilities : [];
    if (caps.length && !caps.includes('completion')) continue; // embedding-only models
    const info = show?.v?.model_info;
    const arch = String(info?.['general.architecture'] || '');
    const context = Number(t.details?.context_length) || Number(info?.[`${arch}.context_length`]) || undefined;
    const thinking = caps.includes('thinking');
    // gpt-oss thinks in levels (low/medium/high), other thinking models switch it on or off.
    const levels: Effort[] = !caps.length ? [] : thinking ? (/gpt-oss/i.test(name) || /gptoss/i.test(arch) ? ['low', 'medium', 'high'] : ['none', 'on']) : [];
    out.push({
      id: name,
      label: [name, t.details?.parameter_size, t.details?.quantization_level].filter(Boolean).join(' · '),
      billing: 'local',
      free: true,
      context,
      tools: caps.length ? caps.includes('tools') : undefined,
      vision: caps.length ? caps.includes('vision') : undefined,
      reasoning: caps.length ? thinking : undefined,
      reasoningLevels: caps.length ? levels : undefined,
      memPerToken: kvBytesPerToken(info),
      loadedContext: loaded.get(name) || undefined,
      capSource: 'Ollama',
    });
  }
  return out.sort((a, b) => a.id.localeCompare(b.id));
}

/** Ollama's `think`: on/off, or a level for gpt-oss; nothing for models that do not think (Ollama refuses it). */
export function ollamaThink(effort: string | undefined, levels: string[] | undefined): boolean | string | undefined {
  if (!effort || !levels || !levels.length) return undefined;
  if (effort === 'none' || effort === 'minimal') return levels.includes('none') ? false : undefined;
  if (levels.includes('low')) return clampEffort(levels, effort === 'on' ? 'medium' : effort === 'xhigh' || effort === 'max' ? 'high' : effort);
  return true;
}

/** ChatMsg[] → Ollama's native messages (images as base64, tool calls with object arguments). */
export function toOllamaMessages(system: string, msgs: ChatMsg[]): any[] {
  const out: any[] = [];
  if (system) out.push({ role: 'system', content: system });
  for (const m of msgs) {
    const parts = typeof m.content === 'string' ? [{ type: 'text' as const, text: m.content }] : m.content;
    const text = parts.filter((p) => p.type === 'text').map((p: any) => p.text).join('\n');
    const images = parts.filter((p) => p.type === 'image').map((p: any) => p.data);
    if (m.role === 'tool') {
      out.push({ role: 'tool', content: text, tool_name: m.toolName });
      if (images.length) out.push({ role: 'user', content: images.length === 1 ? '[Afbeelding uit het tool-resultaat hierboven]' : '[Afbeeldingen uit het tool-resultaat hierboven]', images });
    } else if (m.role === 'assistant') {
      out.push({ role: 'assistant', content: text, ...(m.toolCalls?.length ? { tool_calls: m.toolCalls.map((c) => ({ function: { name: c.name, arguments: c.args ?? {} } })) } : {}) });
    } else out.push({ role: 'user', content: text, ...(images.length ? { images } : {}) });
  }
  return out;
}

// ------------------------------------------------------------------ fitting a request into the context window (B-18)

/** Room kept free for the answer: Ollama only checks that the prompt fits in num_ctx. */
const answerRoom = (window: number) => Math.min(4096, Math.max(512, Math.floor(window * 0.2)));
/** A tool result is never cut below this many characters: the model still sees what came back, and that there was more. */
const MIN_TOOL_CHARS = 1500;
/** The chat template's own text around tools and messages (Qwen's tool preamble alone is ~350 tokens). */
const TEMPLATE_TOKENS = 400;

const textOf = (m: ChatMsg) => (typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('\n'));
const charsOf = (m: ChatMsg) =>
  (typeof m.content === 'string' ? m.content.length : m.content.reduce((n, p) => n + (p.type === 'text' ? p.text.length : 2300), 0)) + (m.toolCalls ? JSON.stringify(m.toolCalls).length : 0) + 30;

function cutText(s: string, max: number): string {
  if (s.length <= max) return s;
  const keep = Math.max(400, max - 200);
  const head = Math.ceil(keep * 0.7);
  const tail = keep - head;
  return `${s.slice(0, head)}\n… (${s.length - head - tail} tekens weggelaten: de uitvoer past niet in het contextvenster van dit model; vraag gerichter) …\n${s.slice(s.length - tail)}`;
}

function cutTool(m: ChatMsg, max: number): ChatMsg {
  if (typeof m.content === 'string') return { ...m, content: cutText(m.content, max) };
  return { ...m, content: [{ type: 'text', text: cutText(textOf(m), max) }, ...m.content.filter((p) => p.type === 'image')] };
}

export interface WindowFit {
  messages: ChatMsg[];
  tools: ToolSpec[];
  /** Tool results of the current turn that were shortened. */
  cut: number;
  /** Messages of earlier turns that were left out. */
  dropped: number;
  /** Apps whose tools were left out for this model call. */
  leftOut: string[];
}

/**
 * Make a request fit the model's context window, so the server never has to. Ollama cuts a prompt that is too long
 * from the front, message by message; once the user's question is gone, a chat template that needs one raises
 * ("Jinja Exception: No user query found in messages", B-18), and a template that does not still answers without
 * knowing the question. Here the question always stays. In this order, until it fits:
 * 1. tool results of earlier turns are shortened (what mattered is in the answers that followed);
 * 2. tools of apps the conversation does not use (not called, not named in the question) go, biggest app first, while
 *    the tools and instructions take more than half of the room (B-20: 50 app tools in a 16k window);
 * 3. earlier turns go, oldest first, whole turns (the conversation keeps starting with a user message);
 * 4. more unused apps go;
 * 5. tool results of the current turn are shortened, the biggest first.
 * What still does not fit goes as it is: the server's error then says so (and the runner names the cause).
 */
export function fitToWindow(req: Pick<ChatRequest, 'system' | 'messages' | 'tools'>, window: number, o: { charsPerToken?: number } = {}): WindowFit {
  // Local tokenizers: about 4 characters per token for English prose, 3 for Dutch, code and JSON. Ollama says the
  // real count only after the call, so a request it still refuses is sent again with a stricter count (see below).
  const cpt = o.charsPerToken ?? CHARS_PER_TOKEN;
  const tokensFor = (chars: number) => Math.ceil(chars / cpt);
  const budget = window - answerRoom(window);
  let tools = req.tools;
  let msgs = req.messages;
  const fixed = () => tokensFor(req.system.length + JSON.stringify(tools).length) + TEMPLATE_TOKENS;
  const total = () => fixed() + msgs.reduce((n, m) => n + tokensFor(charsOf(m)), 0);
  const fits = () => total() <= budget;
  const res = { messages: msgs, tools, cut: 0, dropped: 0, leftOut: [] as string[] };
  if (fits()) return res;
  msgs = msgs.slice();
  let question = msgs.findLastIndex((m) => m.role === 'user');
  for (let i = 0; i < question; i++) if (msgs[i].role === 'tool' && charsOf(msgs[i]) > MIN_TOOL_CHARS + 200) msgs[i] = cutTool(msgs[i], MIN_TOOL_CHARS);

  const used = new Set(req.messages.flatMap((m) => m.toolCalls?.map((c) => c.name) || []));
  const asked = question >= 0 ? textOf(msgs[question]).toLowerCase() : '';
  const named = (app: string) => app.toLowerCase().split(/[^\p{L}\p{N}]+/u).some((w) => w.length >= 4 && asked.includes(w));
  const apps = new Map<string, ToolSpec[]>();
  for (const t of tools) if (t.app) apps.set(t.app, [...(apps.get(t.app) || []), t]);
  const spare = [...apps].filter(([app, list]) => !list.some((t) => used.has(t.name)) && !named(app)).sort((a, b) => JSON.stringify(b[1]).length - JSON.stringify(a[1]).length);
  const leaveOut = (more: () => boolean) => {
    while (spare.length && !fits() && more()) {
      const [app, list] = spare.shift()!;
      tools = tools.filter((t) => !list.includes(t));
      res.leftOut.push(app);
    }
  };
  leaveOut(() => fixed() > budget / 2);
  while (!fits() && question > 0) {
    const next = msgs.findIndex((m, i) => i > 0 && m.role === 'user');
    msgs = msgs.slice(next);
    res.dropped += next;
    question -= next;
  }
  leaveOut(() => true);
  const cut = new Set<number>();
  while (!fits()) {
    let big = -1;
    for (let i = question + 1; i < msgs.length; i++) if (msgs[i].role === 'tool' && charsOf(msgs[i]) > MIN_TOOL_CHARS + 300 && (big < 0 || charsOf(msgs[i]) > charsOf(msgs[big]))) big = i;
    if (big < 0) break;
    msgs[big] = cutTool(msgs[big], Math.max(MIN_TOOL_CHARS, charsOf(msgs[big]) - (total() - budget) * cpt - 300));
    cut.add(big);
  }
  return { ...res, messages: msgs, tools, cut: cut.size };
}

/** What the person reads about a fitted request (once per run): apps left out, tool output shortened. */
export function fitNotice(f: WindowFit | null): string | undefined {
  if (!f) return undefined;
  const out: string[] = [];
  if (f.leftOut.length === 1)
    out.push(`${f.leftOut[0]} past niet in het contextvenster van dit model; deze beurt kreeg de tools van die app niet. Noem de app in je vraag om hem toch te gebruiken, zet minder apps aan of kies een groter contextvenster.`);
  else if (f.leftOut.length > 1)
    out.push(`Niet alle apps passen in het contextvenster van dit model; deze beurt kreeg de tools van deze apps niet: ${f.leftOut.join(', ')}. Noem een app in je vraag om hem toch te gebruiken, zet minder apps aan of kies een groter contextvenster.`);
  if (f.cut) out.push('De tool-uitvoer paste niet in het contextvenster van dit model en is ingekort; het antwoord kan daardoor onvolledig zijn. Kies een groter contextvenster voor de volledige uitvoer.');
  return out.join(' ') || undefined;
}

/** TeamBot's estimate of the tokens a request takes, counted the way fitToWindow counts. */
export function requestTokens(req: Pick<ChatRequest, 'system' | 'messages' | 'tools'>, charsPerToken = CHARS_PER_TOKEN): number {
  const tokensFor = (chars: number) => Math.ceil(chars / charsPerToken);
  return tokensFor(req.system.length + JSON.stringify(req.tools).length) + TEMPLATE_TOKENS + req.messages.reduce((n, m) => n + tokensFor(charsOf(m)), 0);
}

const sizeOf = (f: Pick<WindowFit, 'messages' | 'tools'>) => f.messages.reduce((n, m) => n + charsOf(m), 0) + JSON.stringify(f.tools).length;

/** The window Ollama runs a model with: as loaded now (/api/ps), else the model's own num_ctx (Modelfile). */
export async function ollamaWindow(base: string, model: string): Promise<number | undefined> {
  const o = originOf(base);
  const full = model.includes(':') ? model : `${model}:latest`;
  const ps = await json(`${o}/api/ps`, {}, 2000).catch(() => null);
  const hit = (ps?.models || []).find((m: any) => m.name === full || m.model === full || m.name === model);
  if (Number(hit?.context_length) > 0) return Number(hit.context_length);
  const show = await json(`${o}/api/show`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model }) }, 4000).catch(() => null);
  const n = Number(String(show?.parameters || '').match(/(?:^|\n)\s*num_ctx\s+(\d+)/)?.[1]);
  return n > 0 ? n : undefined;
}

/**
 * One chat over Ollama's native /api/chat (NDJSON stream). `numGpu: 0` runs it on the processor and `keepAlive` says
 * how long Ollama keeps the model loaded afterwards (the tool test uses both, so it never pushes another model out).
 */
export async function ollamaChat(
  o: { base: string; label: string },
  req: ChatRequest,
  signal: AbortSignal,
  onEvent: (e: StreamEvent) => void,
  opts: { numCtx?: number; think?: boolean | string; numGpu?: number; keepAlive?: string | number },
): Promise<ChatResult> {
  const body: any = { model: req.model, stream: true, messages: toOllamaMessages(req.system, req.messages) };
  if (req.tools.length) body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.parameters } }));
  if (opts.think !== undefined) body.think = opts.think;
  if (opts.keepAlive !== undefined) body.keep_alive = opts.keepAlive;
  const options: any = {};
  if (opts.numCtx) options.num_ctx = opts.numCtx;
  if (opts.numGpu !== undefined) options.num_gpu = opts.numGpu;
  if (req.maxTokens) options.num_predict = req.maxTokens;
  if (Object.keys(options).length) body.options = options;
  let res: Response;
  try {
    res = await fetch(`${originOf(o.base)}/api/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal });
  } catch (e: any) {
    if (signal.aborted) throw e;
    throw networkError(o.label, e);
  }
  if (!res.ok || !res.body) throw await errorFromResponse(res, o.label);
  let text = '';
  let reasoning = '';
  const toolCalls: ToolCall[] = [];
  const usage = { input: 0, output: 0 };
  let doneReason = '';
  let model = req.model;
  // A model whose template leaves its thinking in the answer (<think>…</think>) is split like on the OpenAI layer.
  const split = new ThinkSplitter((kind, s) => {
    if (kind === 'text') {
      text += s;
      onEvent({ type: 'text', delta: s });
    } else {
      reasoning += s;
      onEvent({ type: 'reasoning', delta: s });
    }
  });
  const handle = (j: any) => {
    // An error inside the stream gets a category too (a template that raised, a context that is full, ...).
    if (j.error) throw providerErrorFrom(o.label, 400, JSON.stringify({ error: String(j.error) }));
    const msg = j.message || {};
    if (msg.thinking) {
      reasoning += msg.thinking;
      onEvent({ type: 'reasoning', delta: msg.thinking });
    }
    if (msg.content) split.push(msg.content);
    for (const c of msg.tool_calls || []) {
      const id = String(c.id || `call_${toolCalls.length}_${Math.random().toString(36).slice(2, 8)}`);
      const name = String(c.function?.name || '');
      let args = c.function?.arguments ?? {};
      if (typeof args === 'string') {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      onEvent({ type: 'tool_start', id, name });
      toolCalls.push({ id, name, args });
    }
    if (j.model) model = j.model;
    if (j.done) {
      usage.input = Number(j.prompt_eval_count) || 0;
      usage.output = Number(j.eval_count) || 0;
      doneReason = String(j.done_reason || '');
    }
  };
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) handle(JSON.parse(line));
    }
  }
  if (buf.trim()) handle(JSON.parse(buf.trim()));
  split.end();
  return { text, reasoning: reasoning || undefined, toolCalls, usage, stop: toolCalls.length ? 'tool_use' : doneReason === 'length' ? 'max_tokens' : 'end', model };
}

// ------------------------------------------------------------------ tool calls written as text

// JSON, Qwen3-Coder XML and slightly broken argument JSON: toolcall-text.ts (the OpenAI-compatible adapter uses it too).
export { repairTextToolCalls, toolCallsFromText } from './toolcall-text.js';

// ------------------------------------------------------------------ one fitted chat for every local server

/** How one local server is sent a request, and asked for the window a model runs with. */
export interface FitTarget {
  /** The server's name in a notice: "Ollama", "LM Studio", "llama.cpp". */
  server: string;
  /** The window the model runs with now; `fresh` looks again (the server may have loaded the model for this call). */
  windowOf(model: string, fresh?: boolean): Promise<number | undefined>;
  send(req: ChatRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<ChatResult>;
  /** The error that is left after the strict retry, in this server's words (Ollama: the question fell out). */
  explain?(err: any, req: ChatRequest): any;
}

/** What the person reads when a server had to cut a request whose window TeamBot could not know beforehand. */
export const cutNotice = (server: string) =>
  `Dit gesprek paste niet helemaal in het contextvenster van dit model; ${server} liet een deel ervan weg. De volgende stappen maakt TeamBot passend, zodat je vraag blijft. Kies een groter contextvenster als alles mee moet.`;

const NO_TOOLS_NOTE = 'Dit model ondersteunt geen tools; antwoord zonder tools gegeven.';

/**
 * A chat that fits every request into the model's window before it goes out (B-18), so a local server never has to
 * cut it silently, and that turns a tool call written as text into a real one. One per adapter, so per run: each
 * notice is said once. When the window is unknown before the first call (the server loads the model for it), TeamBot
 * looks afterwards: did it not fit, the person reads that it was cut, and the next calls of the run fit.
 */
export function fitChat(t: FitTarget): NonNullable<ProviderAdapter['chat']> {
  const said = new Set<string>();
  const checked = new Set<string>();
  const say = (out: ChatResult, note: string | undefined): ChatResult => {
    if (!note || said.has(note)) return out;
    said.add(note);
    return { ...out, notice: [out.notice, note].filter(Boolean).join(' ') };
  };
  return async (req, signal, onEvent) => {
    let streamed = false;
    const events = (e: StreamEvent) => {
      streamed = true;
      onEvent(e);
    };
    const send = async (f: WindowFit | null) => {
      const r = f ? { ...req, messages: f.messages, tools: f.tools } : req;
      return say(repairTextToolCalls(await t.send(r, signal, events), r.tools), fitNotice(f));
    };
    const window = await t.windowOf(req.model);
    const fit = window ? fitToWindow(req, window) : null;
    try {
      const out = await send(fit);
      if (window || checked.has(req.model)) return out;
      checked.add(req.model);
      const w = await t.windowOf(req.model, true);
      if (!w || requestTokens(req) <= w) return out;
      // Our count is an estimate: a server that evaluated clearly less than its window did not have to cut anything.
      const evaluated = Number(out.usage?.input) || 0;
      return evaluated > 0 && evaluated < w * 0.9 ? out : say(out, cutNotice(t.server));
    } catch (e: any) {
      if (signal.aborted || streamed || !['template', 'context'].includes(categoryOf(e))) throw e;
      // TeamBot's count is an estimate: once more with a strict count (also when the window only became known now,
      // because the server loaded the model for this call). Local servers refuse within a fraction of a second,
      // before they evaluate anything.
      let err = e;
      const w = await t.windowOf(req.model, true);
      const tighter = w ? fitToWindow(req, Math.floor(w * 0.8), { charsPerToken: 2.5 }) : null;
      if (tighter && sizeOf(tighter) < sizeOf(fit || req)) {
        try {
          return await send(tighter);
        } catch (e2: any) {
          if (signal.aborted || streamed) throw e2;
          err = e2;
        }
      }
      throw t.explain ? t.explain(err, req) : err;
    }
  };
}

/** Look a window up once per model and adapter (= per run); `fresh` looks again. */
function windowCache(lookup: (model: string) => Promise<number | undefined>) {
  const windows = new Map<string, Promise<number | undefined>>();
  return (model: string, fresh = false) => {
    if (fresh || !windows.has(model)) windows.set(model, lookup(model).catch(() => undefined));
    return windows.get(model)!;
  };
}

/**
 * Ollama provider: the OpenAI-compatible adapter for the key test, plus TeamBot's own model list and the native chat
 * (context window and thinking per model).
 */
export function ollamaAdapter(compat: ProviderAdapter, o: { base: string; label: string; config?: Record<string, any> }): ProviderAdapter {
  const caps = new Map<string, ModelInfo>();
  const listModels = async () => {
    try {
      const list = await ollamaModels(o.base);
      for (const m of list) caps.set(m.id, m);
      return list;
    } catch {
      return compat.listModels();
    }
  };
  const loaded = windowCache((model) => ollamaWindow(o.base, model));
  const chat = fitChat({
    server: 'Ollama',
    windowOf: async (model, fresh) => chosenContext(o.config, model) ?? (await loaded(model, fresh)),
    async send(r, signal, events) {
      const numCtx = chosenContext(o.config, r.model);
      if (r.reasoning && !caps.has(r.model)) await listModels().catch(() => []);
      const think = ollamaThink(r.reasoning, caps.get(r.model)?.reasoningLevels);
      // Ollama's OpenAI layer cannot carry a context window or switch thinking: only then the native API.
      if (numCtx === undefined && think === undefined) return compat.chat!(r, signal, events);
      const native = (x: ChatRequest) => ollamaChat({ base: o.base, label: o.label }, x, signal, events, { numCtx, think });
      try {
        return await native(r);
      } catch (e: any) {
        // A model without tools in its template: Ollama refuses the tools (the OpenAI adapter does the same retry).
        if (signal.aborted || !r.tools.length || !/does not support tools/i.test(String(e?.message))) throw e;
        const out = await native({ ...r, tools: [] });
        return { ...out, notice: [out.notice, NO_TOOLS_NOTE].filter(Boolean).join(' ') };
      }
    },
    explain(err, req) {
      // Ollama cut the conversation from the front and the question went with it: the conversation did not fit.
      if (categoryOf(err) === 'template' && /no user query/i.test(err.message) && req.messages.some((m) => m.role === 'user'))
        return new ProviderError(`${o.label}: ${err.status ? err.status + ' ' : ''}${ERROR_TEXT.context.title} — Ollama kortte het gesprek in omdat het niet in het contextvenster past, en daarbij viel de vraag weg (${err.message.replace(/\s+/g, ' ').slice(-120)})`, err.status, false, err.body, 'context');
      return err;
    },
  });
  return { ...compat, kind: 'ollama', listModels, chat };
}

/** LM Studio's models with their maximum and loaded context: REST API /api/v0, else the newer /api/v1 (LM Studio 0.4+). */
export async function lmstudioModels(base: string): Promise<ModelInfo[] | null> {
  const j = await json(`${originOf(base)}/api/v0/models`).catch(() => null);
  if (!Array.isArray(j?.data)) return lmstudioModelsV1(base);
  return j.data
    .filter((m: any) => m.type !== 'embeddings')
    .map((m: any) => ({
      id: String(m.id),
      billing: 'local' as const,
      free: true,
      context: Number(m.max_context_length) || undefined,
      loadedContext: m.state === 'loaded' ? Number(m.loaded_context_length) || undefined : undefined,
      vision: m.type === 'vlm' ? true : m.type === 'llm' ? false : undefined,
      tools: Array.isArray(m.capabilities) ? m.capabilities.includes('tool_use') : undefined,
      capSource: 'LM Studio',
    }));
}

/** LM Studio 0.4's own model list (/api/v1/models): `models[]` with `key`, `loaded_instances[].config.context_length`. */
async function lmstudioModelsV1(base: string): Promise<ModelInfo[] | null> {
  const j = await json(`${originOf(base)}/api/v1/models`).catch(() => null);
  if (!Array.isArray(j?.models)) return null;
  return j.models
    .filter((m: any) => m && !/embed/i.test(String(m.type || '')))
    .map((m: any) => {
      const caps = m.capabilities && typeof m.capabilities === 'object' && !Array.isArray(m.capabilities) ? m.capabilities : {};
      const inst = Array.isArray(m.loaded_instances) ? m.loaded_instances[0] : undefined;
      return {
        id: String(m.key || m.id || ''),
        billing: 'local' as const,
        free: true,
        context: Number(m.max_context_length) || undefined,
        loadedContext: Number(inst?.config?.context_length) || undefined,
        vision: typeof caps.vision === 'boolean' ? caps.vision : undefined,
        tools: typeof caps.trained_for_tool_use === 'boolean' ? caps.trained_for_tool_use : undefined,
        capSource: 'LM Studio',
      };
    })
    .filter((m: ModelInfo) => !!m.id);
}

/** The window LM Studio runs a model with now (only known while it is loaded). */
export async function lmstudioWindow(base: string, model: string): Promise<number | undefined> {
  const list = await lmstudioModels(base);
  return list?.find((m) => m.id === model)?.loadedContext;
}

/** The window llama-server was started with (-c), per slot: /props. */
export async function llamacppWindow(base: string): Promise<number | undefined> {
  const props = await json(`${originOf(base)}/props`, {}, 2000);
  return Number(props?.default_generation_settings?.n_ctx ?? props?.n_ctx) || undefined;
}

/**
 * LM Studio fixes the context window at load time: load the model with the chosen window when it is not loaded that
 * way yet (REST API /api/v1/models/load, LM Studio 0.4+). Returns a note when that is not possible.
 */
export async function ensureLmstudioContext(base: string, model: string, n: number): Promise<string | undefined> {
  const o = originOf(base);
  const list = await lmstudioModels(base).catch(() => null);
  const cur = list?.find((m) => m.id === model);
  if (cur?.loadedContext === n) return undefined;
  try {
    const r = await fetch(`${o}/api/v1/models/load`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ model, context_length: n }), signal: AbortSignal.timeout(180_000) });
    if (r.ok) return undefined;
    if (r.status === 404 || r.status === 405) return `Contextvenster niet ingesteld: deze versie van LM Studio kan dat niet via TeamBot. Zet "Context Length" in LM Studio op ${n} (of werk LM Studio bij).`;
    return `Contextvenster niet ingesteld: LM Studio antwoordde ${r.status}.`;
  } catch (e: any) {
    return `Contextvenster niet ingesteld: ${String(e?.message || e).slice(0, 120)}`;
  }
}

/**
 * LM Studio: the chosen window is set by (re)loading the model; every request is fitted into the window the model
 * runs with (the chosen one, else the one it is loaded with). LM Studio otherwise handles an overflow with its own
 * policy (cut the middle, or a rolling window) without saying so.
 */
export function lmstudioAdapter(compat: ProviderAdapter, o: { base: string; config?: Record<string, any> }): ProviderAdapter {
  const loaded = windowCache((model) => lmstudioWindow(o.base, model));
  /** Models that could not be loaded with the chosen window (an old LM Studio): their window is the loaded one. */
  const notSet = new Set<string>();
  const fitted = fitChat({
    server: 'LM Studio',
    windowOf: async (model, fresh) => (notSet.has(model) ? undefined : chosenContext(o.config, model)) ?? (await loaded(model, fresh)),
    send: (r, signal, events) => compat.chat!(r, signal, events),
  });
  return {
    ...compat,
    async listModels() {
      const own = await lmstudioModels(o.base).catch(() => null);
      return own?.length ? own : compat.listModels();
    },
    async chat(req, signal, onEvent) {
      const n = chosenContext(o.config, req.model);
      const note = n ? await ensureLmstudioContext(o.base, req.model, n) : undefined;
      if (note) notSet.add(req.model);
      const r = await fitted(req, signal, onEvent);
      return note ? { ...r, notice: [r.notice, note].filter(Boolean).join(' ') } : r;
    },
  };
}

const JINJA_NOTE = 'llama.cpp draait zonder --jinja en kan zo geen tools gebruiken; deze beurt ging zonder tools. Start llama-server met --jinja om tools te gebruiken.';

/**
 * llama.cpp: the window the server was started with (/props), fixed until the server restarts with another -c. Every
 * request is fitted into it (llama-server with --context-shift would otherwise drop the oldest tokens silently).
 */
export function llamacppAdapter(compat: ProviderAdapter, o: { base: string }): ProviderAdapter {
  const window = windowCache(() => llamacppWindow(o.base));
  const chat = fitChat({
    server: 'llama.cpp',
    windowOf: (model, fresh) => window(model, fresh),
    async send(r, signal, events) {
      try {
        return await compat.chat!(r, signal, events);
      } catch (e: any) {
        // llama-server without --jinja refuses tools ("tools param requires --jinja flag"); answer without them.
        if (signal.aborted || !r.tools.length || !/--jinja/i.test(`${e?.message} ${e?.body || ''}`)) throw e;
        const out = await compat.chat!({ ...r, tools: [] }, signal, events);
        return { ...out, notice: [out.notice, JINJA_NOTE].filter(Boolean).join(' ') };
      }
    },
  });
  return {
    ...compat,
    async listModels() {
      const list = await compat.listModels();
      const props = await json(`${originOf(o.base)}/props`).catch(() => null);
      const n = Number(props?.default_generation_settings?.n_ctx ?? props?.n_ctx) || undefined;
      const vision = props?.modalities ? !!props.modalities.vision : undefined;
      return list.map((m) => ({ ...m, billing: 'local' as const, free: true, context: n ?? m.context, loadedContext: n, contextFixed: true, vision: m.vision ?? vision, capSource: m.capSource || 'llama.cpp' }));
    },
    chat,
  };
}
