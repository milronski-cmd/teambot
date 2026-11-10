import type { ChatRequest, ChatResult, ProviderAdapter, ToolCall, ToolSpec } from '../../core/types.js';
import { ollamaChat, ollamaThink, toolCallsFromText } from '../../providers/localmodels.js';
import type { PsModel } from './ollama.js';

/**
 * "Werken tools echt?" One small local request with three tools and one question that needs one of them. A model
 * passes when it really calls get_time for Amsterdam. Guides say small local models often ignore tools, print the
 * call as text, or pick the wrong tool among several; this tells them apart. Cheap: one call, no thinking, a short
 * answer limit, a 4k window, and cached per model (and per download, via Ollama's digest).
 */

export const PROBE_TOOLS: ToolSpec[] = [
  { name: 'get_time', description: 'Geeft de huidige tijd in een stad.', parameters: { type: 'object', properties: { city: { type: 'string', description: 'Naam van de stad' } }, required: ['city'] } },
  { name: 'get_weather', description: 'Geeft het weerbericht voor een stad.', parameters: { type: 'object', properties: { city: { type: 'string', description: 'Naam van de stad' } }, required: ['city'] } },
  { name: 'save_note', description: 'Bewaart een korte notitie.', parameters: { type: 'object', properties: { text: { type: 'string', description: 'De notitie' } }, required: ['text'] } },
];

export const probeRequest = (model: string): ChatRequest => ({
  model,
  system: 'Je bent een assistent met tools. Gebruik een tool als die bij de vraag past, en verzin geen antwoord.',
  messages: [{ role: 'user', content: 'Hoe laat is het nu in Amsterdam? Gebruik de juiste tool.' }],
  tools: PROBE_TOOLS,
  maxTokens: 400,
});

/** tools = "tools werken"; text = "alleen tekst"; unreliable = calls a tool, but the wrong one; error = test failed. */
export type ProbeVerdict = 'tools' | 'text' | 'unreliable' | 'error';
export type ProbeDetail =
  | 'ok' // a real tool call, the right one
  | 'as_text' // the call came back as text; TeamBot turns it into a real call
  | 'no_call' // answered in words, no tool
  | 'wrong_call' // called another tool, or without the city
  | 'no_tools' // the server says the model has no tools
  | 'jinja' // llama-server without --jinja
  | 'error';

export interface ProbeOutcome {
  verdict: ProbeVerdict;
  detail: ProbeDetail;
  message?: string;
}

const right = (c: ToolCall) => c.name === 'get_time' && /amsterdam/i.test(JSON.stringify(c.args ?? {}));

export function classifyProbe(r: ChatResult | null, err?: any): ProbeOutcome {
  if (err || !r) {
    const msg = String(err?.message || err || 'geen antwoord');
    if (/does not support tools|ondersteunt geen tools/i.test(msg)) return { verdict: 'text', detail: 'no_tools' };
    if (/--jinja/i.test(msg)) return { verdict: 'text', detail: 'jinja' };
    return { verdict: 'error', detail: 'error', message: msg.replace(/\s+/g, ' ').slice(0, 240) };
  }
  if (/ondersteunt geen tools/i.test(r.notice || '')) return { verdict: 'text', detail: 'no_tools' };
  if (/--jinja/.test(r.notice || '')) return { verdict: 'text', detail: 'jinja' };
  let calls = r.toolCalls;
  let asText = false;
  if (!calls.length) {
    calls = toolCallsFromText(r.text, PROBE_TOOLS) || [];
    asText = calls.length > 0;
  }
  // An adapter that repaired a text call already (fitChat) leaves an empty text and a call id "call_text_…".
  if (calls.some((c) => c.id.startsWith('call_text_'))) asText = true;
  if (!calls.length) return { verdict: 'text', detail: 'no_call' };
  if (calls.some(right)) return { verdict: 'tools', detail: asText ? 'as_text' : 'ok' };
  return { verdict: 'unreliable', detail: 'wrong_call', message: calls.map((c) => c.name).join(', ').slice(0, 120) };
}

export type ProbeWhere = 'loaded' | 'gpu' | 'cpu';

/**
 * How to run the test on Ollama without disturbing what runs: a loaded model with the window it is loaded with (no
 * reload); a model that would push a loaded one off the video card runs on the processor (num_gpu 0); a model loaded
 * only for the test is unloaded again after 30 seconds.
 */
export function probePlan(model: string, ps: PsModel[], vram: number | null, need: number): { numCtx?: number; numGpu?: number; keepAlive?: string; where: ProbeWhere } {
  const full = model.includes(':') ? model : `${model}:latest`;
  const hit = ps.find((m) => m.name === model || m.name === full);
  if (hit) return { numCtx: hit.context || undefined, where: 'loaded' };
  const used = ps.reduce((n, m) => n + m.sizeVram, 0);
  const free = vram === null ? (ps.length ? 0 : Infinity) : vram - used;
  if (ps.length && need > free) return { numCtx: 4096, numGpu: 0, keepAlive: '30s', where: 'cpu' };
  return { numCtx: 4096, keepAlive: '30s', where: 'gpu' };
}

/** The `think` that switches thinking off for the test (gpt-oss cannot: it thinks briefly with "low"). */
export function probeThink(caps: string[] | undefined, levels: string[] | undefined): boolean | string | undefined {
  if (!caps?.includes('thinking')) return undefined;
  return ollamaThink('none', levels) ?? (levels?.includes('low') ? 'low' : undefined);
}

export async function probeOllama(
  o: { base: string; label: string; model: string; think?: boolean | string; plan: ReturnType<typeof probePlan> },
  signal: AbortSignal,
): Promise<ProbeOutcome> {
  try {
    const r = await ollamaChat({ base: o.base, label: o.label }, probeRequest(o.model), signal, () => {}, { think: o.think, numCtx: o.plan.numCtx, numGpu: o.plan.numGpu, keepAlive: o.plan.keepAlive });
    return classifyProbe(r);
  } catch (e) {
    return classifyProbe(null, e);
  }
}

/** LM Studio, llama.cpp and other OpenAI-compatible servers: through TeamBot's own adapter, as a bot would. */
export async function probeAdapter(adapter: ProviderAdapter, model: string, signal: AbortSignal): Promise<ProbeOutcome> {
  if (!adapter.chat) return { verdict: 'error', detail: 'error', message: 'Deze provider heeft geen chat.' };
  try {
    return classifyProbe(await adapter.chat(probeRequest(model), signal, () => {}));
  } catch (e) {
    return classifyProbe(null, e);
  }
}
