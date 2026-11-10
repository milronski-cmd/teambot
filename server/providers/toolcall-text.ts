import type { ChatResult, ToolCall, ToolSpec } from '../core/types.js';
import { QwenCallError, propertyTypes, readQwenCall } from './qwen3coder.js';
import { parseJsonValue } from './tool-args.js';

/**
 * Tool calls a model wrote as plain text instead of as a real tool call. Local servers and some templates do this:
 * Ollama's OpenAI layer, imported GGUFs without a PARSER line, LM Studio and llama.cpp with some chat templates.
 * Three forms are read:
 *  - JSON: `{"name": …, "arguments": …}` (also `parameters`/`args`, an OpenAI `{type, function}` object, a list, or
 *    `{tool_calls: […]}`), bare or inside `<tool_call>`, `<|tool_call_start|>` or `<function_calls>`;
 *  - Qwen3-Coder: `<function=name><parameter=key>value</parameter></function>` (qwen3coder.ts, ported from Ollama),
 *    with or without `<tool_call>` around it — Ollama sometimes eats the opening special token and leaves only
 *    `</tool_call>` (the ads-roas-campagnes quality task, docs/quality);
 *  - argument JSON that is only slightly broken, repaired with jsonrepair (tool-args.ts).
 *
 * Rules: only calls of tools that were offered; bare JSON only when the whole answer is the call; marked-up calls
 * (`<tool_call>`, `<function=`) may follow a short sentence ("Ik lees het bestand."), never precede more text. When a
 * marked-up call cannot be read for sure (unknown tool, unclosed tag, broken JSON) nothing runs: the model gets one
 * call back that the tool gate refuses with a correction (`__invalid_call`), so it can try again instead of the raw
 * markup ending up as the answer. The Broker still asks before anything that does run.
 */

/** What a text answer holds: real calls (plus any sentence before them), one that cannot be read, or nothing. */
export type TextCalls = { calls: ToolCall[]; prose: string } | { error: string; name?: string; prose: string } | null;

/** Wrappers some chat templates leave around a call the server did not parse: [open, close]. */
const WRAPPERS: [string, string][] = [
  ['<tool_call>', '</tool_call>'],
  ['<|tool_call_start|>', '<|tool_call_end|>'],
  ['<function_calls>', '</function_calls>'],
  ['<function_call>', '</function_call>'],
];
/** Markup that says "this is meant as a tool call". */
const MARKUP = /<tool_call>|<\/tool_call>|<\|tool_call_start\|>|<function_calls?>|<function=/;
const PREFIX = /^(?:<\|python_tag\|>|\[TOOL_CALLS\]|functools)\s*/;
const MAX_TEXT = 200_000;
const NAME_OK = /^[a-zA-Z0-9_-]{1,64}$/;

const newId = (i: number) => `call_text_${i}_${Math.random().toString(36).slice(2, 8)}`;

class Unreadable extends Error {
  constructor(
    message: string,
    public readonly fn?: string,
  ) {
    super(message);
  }
}

/** JSON call objects → calls; throws Unreadable for an unknown tool or arguments that are not an object. */
function fromJson(x: any, names: Set<string>, out: ToolCall[]): boolean {
  if (Array.isArray(x)) return x.length > 0 && x.every((y) => fromJson(y, names, out));
  if (!x || typeof x !== 'object') return false;
  if (Array.isArray(x.tool_calls)) return fromJson(x.tool_calls, names, out);
  const f = x.function && typeof x.function === 'object' ? x.function : x;
  if (typeof f.name !== 'string' || !f.name) return false;
  const name = f.name;
  if (!names.has(name)) throw new Unreadable(`de tool "${name}" bestaat hier niet`, name);
  let args = f.arguments ?? f.parameters ?? f.args ?? {};
  if (typeof args === 'string') {
    args = args.trim() ? parseJsonValue(args) : {};
    if (args === undefined) throw new Unreadable('de argumenten zijn geen geldige JSON', name);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Unreadable('de argumenten zijn geen JSON-object', name);
  out.push({ id: newId(out.length), name, args });
  return true;
}

/** One chunk of call text (inside a wrapper, or bare): JSON or Qwen3-Coder XML. */
function readChunk(chunk: string, tools: ToolSpec[], names: Set<string>, out: ToolCall[], marked: boolean): boolean {
  const t = chunk.trim();
  if (t.startsWith('<function=')) {
    const schemaOf = (n: string) => tools.find((x) => x.name === n)?.parameters;
    let at = 0;
    while (at < t.length) {
      let r;
      try {
        r = readQwenCall(t, at, (fn, p) => propertyTypes(schemaOf(fn), p));
      } catch (e) {
        if (e instanceof QwenCallError) throw new Unreadable(e.message, e.fn);
        throw e;
      }
      if (!names.has(r.call.name)) throw new Unreadable(`de tool "${r.call.name}" bestaat hier niet`, r.call.name);
      out.push({ id: newId(out.length), name: r.call.name, args: r.call.args });
      at = r.end;
      while (at < t.length && /\s/.test(t[at])) at++;
      if (at < t.length && !t.startsWith('<function=', at)) throw new Unreadable('er staat tekst na </function>', r.call.name);
    }
    return true;
  }
  if (!/^[[{]/.test(t)) {
    if (marked) throw new Unreadable('er staat geen JSON en geen <function=…> in de aanroep');
    return false;
  }
  const j = parseJsonValue(t);
  if (j === undefined) {
    if (marked) throw new Unreadable('de aanroep is geen geldige JSON');
    return false;
  }
  return fromJson(j, names, out);
}

/** Where a Qwen3-Coder block that starts at `from` ends (after its </function>); throws Unreadable when it does not. */
function qwenEnd(s: string, from: number): number {
  try {
    return readQwenCall(s, from).end;
  } catch (e) {
    if (e instanceof QwenCallError) throw new Unreadable(e.message, e.fn);
    throw e;
  }
}

/**
 * Splits marked-up call text into chunks: wrapped ones, bare `<function=…>` blocks, and stray wrapper tags (skipped).
 * Returns null when text that is not a call follows a call.
 */
function markedChunks(body: string): string[] | null {
  const chunks: string[] = [];
  let i = 0;
  const skipWs = () => {
    while (i < body.length && /\s/.test(body[i])) i++;
  };
  for (skipWs(); i < body.length; skipWs()) {
    const w = WRAPPERS.find(([open]) => body.startsWith(open, i));
    if (w) {
      const start = i + w[0].length;
      let inner = start;
      while (inner < body.length && /\s/.test(body[inner])) inner++;
      // A Qwen3-Coder block inside: its own end, so a </tool_call> inside a parameter value cannot cut it.
      const end = body.startsWith('<function=', inner) ? qwenEnd(body, inner) : body.indexOf(w[1], start) < 0 ? body.length : body.indexOf(w[1], start);
      chunks.push(body.slice(start, end));
      i = end;
      skipWs();
      if (body.startsWith(w[1], i)) i += w[1].length;
      continue;
    }
    const stray = WRAPPERS.find(([, close]) => body.startsWith(close, i));
    if (stray) {
      i += stray[1].length;
      continue;
    }
    if (body.startsWith('<function=', i)) {
      const end = qwenEnd(body, i);
      chunks.push(body.slice(i, end));
      i = end;
      continue;
    }
    return null;
  }
  return chunks;
}

/**
 * Reads the tool calls in a text answer. `cut`: the answer stopped at its token limit (a call in it may be cut off;
 * it is then never read as complete).
 */
export function readTextToolCalls(text: string, tools: ToolSpec[], cut = false): TextCalls {
  if (!tools?.length || !text || text.length > MAX_TEXT) return null;
  const names = new Set(tools.map((t) => t.name));
  let s = text.trim();
  let m = MARKUP.exec(s);
  // Only a closing </tool_call> (the server ate the opening special token): the call is everything before it.
  if (m && m[0] === '</tool_call>') {
    s = `<tool_call>${s}`;
    m = MARKUP.exec(s);
  }
  const prose = m ? s.slice(0, m.index).trim() : '';
  const calls: ToolCall[] = [];
  try {
    if (m) {
      const chunks = markedChunks(s.slice(m.index));
      if (!chunks) return null; // more text after the call: leave the answer as the model wrote it
      if (!chunks.length) return null;
      if (cut) throw new Unreadable('het antwoord stopte op de tokenlimiet, de aanroep is niet compleet');
      for (const c of chunks) readChunk(c, tools, names, calls, true);
      return calls.length ? { calls, prose } : null;
    }
    const bare = s
      .replace(/^```(?:json|tool_call|tool)?\s*/i, '')
      .replace(/\s*```$/, '')
      .replace(PREFIX, '')
      .trim();
    const marked = PREFIX.test(s);
    if (cut) return null;
    if (!readChunk(bare, tools, names, calls, marked)) return null;
    return calls.length ? { calls, prose: '' } : null;
  } catch (e) {
    if (!(e instanceof Unreadable)) throw e;
    // Bare JSON without markup that names no offered tool may simply be an answer: leave it.
    if (!m && !PREFIX.test(s)) return null;
    return { error: e.message, name: e.fn, prose };
  }
}

/** The calls in a text answer, or null (unreadable or no call: the answer stays text). */
export function toolCallsFromText(text: string, tools: ToolSpec[]): ToolCall[] | null {
  const r = readTextToolCalls(text, tools);
  return r && 'calls' in r ? r.calls : null;
}

/** The correction the model reads when its text call could not be read. Nothing ran. */
export function invalidCallText(reason: string, name: string | undefined, tools: ToolSpec[]): string {
  const known = name && tools.some((t) => t.name === name);
  const list = tools.map((t) => t.name).slice(0, 40).join(', ');
  return [
    `INVALID_TOOL_CALL: je schreef een toolaanroep als tekst${name ? ` (${name})` : ''} en die kon niet worden gelezen: ${reason}. Er is niets uitgevoerd.`,
    known ? '' : `Beschikbare tools: ${list}${tools.length > 40 ? ', …' : ''}.`,
    'Roep de tool opnieuw aan als echte toolaanroep, met geldige argumenten (in de tekstvorm: elke <parameter=…> afgesloten met </parameter> en de functie met </function>).',
  ]
    .filter(Boolean)
    .join(' ');
}

/**
 * The result with a text-written tool call turned into a real one (unchanged when there is none). A marked-up call
 * that cannot be read becomes one call the tool gate refuses with a correction, so nothing malformed ever runs.
 */
export function repairTextToolCalls(r: ChatResult, tools: ToolSpec[] | undefined): ChatResult {
  if (r.toolCalls.length || !tools?.length || !r.text) return r;
  const found = readTextToolCalls(r.text, tools, r.stop === 'max_tokens');
  if (!found) return r;
  if ('calls' in found) return { ...r, text: found.prose, toolCalls: found.calls, stop: 'tool_use' };
  const name = found.name && NAME_OK.test(found.name) ? found.name : 'tool_call';
  return { ...r, text: found.prose, toolCalls: [{ id: newId(0), name, args: { __invalid_call: invalidCallText(found.error, found.name, tools) } }], stop: 'tool_use' };
}
