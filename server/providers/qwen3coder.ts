/**
 * Qwen3-Coder tool calls written as text:
 *
 *   <function=read_file>
 *   <parameter=path>
 *   campagnes.csv
 *   </parameter>
 *   </function>
 *
 * Ported to TypeScript from Ollama's `model/parsers/qwen3coder.go` (MIT, Copyright (c) Ollama; main at commit
 * 64a901e713e376e674663f8ebd53e1a3ec74e289, 2026-10-23), see `third_party/ollama/LICENSE` and THIRD_PARTY_NOTICES.txt.
 * Ollama turns the call into XML and runs Go's XML decoder over it; this port walks the same four tags directly and
 * keeps Ollama's rules: only a `</parameter>` ends a parameter (a literal `</function>` inside a value is text), a
 * single newline after the opening tag and before the closing tag is dropped, and a value becomes the type the tool's
 * JSON schema declares (boolean → integer → number → array → object → string, `null` first).
 *
 * Differences from Ollama, on purpose (TeamBot never runs a call it cannot read for sure):
 *  - a parameter inside a parameter, a stray `</parameter>`, an unclosed parameter or function, or text that is not
 *    whitespace between parameters is refused instead of being read leniently;
 *  - an invalid boolean stays the text the model wrote (Ollama makes it `false`), so the schema check names it;
 *  - JSON in an array or object parameter may be repaired (jsonrepair) when it is only slightly broken.
 */
import { parseJsonValue } from './tool-args.js';

export interface QwenCall {
  name: string;
  args: Record<string, any>;
}

/** A Qwen3-Coder call that cannot be read; `name` when the function name was readable. */
export class QwenCallError extends Error {
  constructor(
    message: string,
    public readonly fn?: string,
  ) {
    super(message);
  }
}

/** The four tags of the format; `</parameter=x>` and the like are not tags (Ollama treats them as text too). */
const TAG = /<(\/?)(function|parameter)(=([^>]*))?>/g;

interface Tag {
  start: number;
  end: number;
  close: boolean;
  kind: 'function' | 'parameter';
  value?: string;
}

function tags(s: string, from = 0): Tag[] {
  const out: Tag[] = [];
  TAG.lastIndex = from;
  for (let m: RegExpExecArray | null; (m = TAG.exec(s)); ) {
    const close = m[1] === '/';
    const hasValue = m[3] !== undefined;
    // An opening tag needs a name (`<function=x>`); a closing tag has none (`</function>`).
    if (close === hasValue) continue;
    if (!close && !m[4]) continue;
    out.push({ start: m.index, end: m.index + m[0].length, close, kind: m[2] as Tag['kind'], value: m[4] });
  }
  return out;
}

/**
 * Reads one call that starts at `from` (at `<function=`). Returns the call and where it ended (after `</function>`);
 * throws QwenCallError when it is malformed.
 */
export function readQwenCall(s: string, from: number, types: (name: string, param: string) => string[] = () => []): { call: QwenCall; end: number } {
  const all = tags(s, from);
  const open = all[0];
  if (!open || open.start !== from || open.close || open.kind !== 'function') throw new QwenCallError('de aanroep begint niet met <function=naam>');
  const name = open.value!.trim();
  const args: Record<string, any> = {};
  let param: Tag | null = null;
  let at = open.end;
  for (let i = 1; i < all.length; i++) {
    const t = all[i];
    if (param) {
      if (t.kind === 'parameter' && t.close) {
        args[param.value!.trim()] = parseValue(s.slice(param.end, t.start), types(name, param.value!.trim()));
        param = null;
        at = t.end;
      } else if (t.kind === 'parameter') throw new QwenCallError(`parameter ${param.value} is niet afgesloten met </parameter>`, name);
      // <function=…> or </function> inside a value: text of that value (only </parameter> ends it).
      continue;
    }
    if (s.slice(at, t.start).trim()) throw new QwenCallError('er staat tekst buiten een <parameter=…>', name);
    if (t.kind === 'function' && t.close) return { call: { name, args }, end: t.end };
    if (t.kind === 'function') throw new QwenCallError('een nieuwe <function=…> voordat de vorige met </function> is afgesloten', name);
    if (t.close) throw new QwenCallError('een </parameter> zonder <parameter=…>', name);
    param = t;
  }
  if (param) throw new QwenCallError(`parameter ${param.value} is niet afgesloten met </parameter>`, name);
  throw new QwenCallError('de aanroep is niet afgesloten met </function>', name);
}

/** Types a schema property declares (`type`, a type list, or the types of its anyOf/oneOf branches). */
export function propertyTypes(schema: any, param: string): string[] {
  const prop = schema?.properties?.[param];
  if (!prop || typeof prop !== 'object') return [];
  const of = (p: any): string[] => (Array.isArray(p?.type) ? p.type.map(String) : typeof p?.type === 'string' ? [p.type] : []);
  const union = [...(Array.isArray(prop.anyOf) ? prop.anyOf : []), ...(Array.isArray(prop.oneOf) ? prop.oneOf : [])];
  return union.length ? union.flatMap(of) : of(prop);
}

/** Ollama's parseValue: drop one leading and one trailing newline, then the declared type. */
export function parseValue(raw: string, types: string[]): any {
  let v = raw.replace(/\r\n/g, '\n');
  if (v.startsWith('\n')) v = v.slice(1);
  if (v.endsWith('\n')) v = v.slice(0, -1);
  return typedValue(v, types);
}

function typedValue(raw: string, types: string[]): any {
  if (raw.toLowerCase() === 'null') return null;
  if (!types.length) return raw;
  const set = new Set(types);
  const only = types.length === 1;
  if (set.has('boolean')) {
    const l = raw.trim().toLowerCase();
    if (l === 'true') return true;
    if (l === 'false') return false;
    if (only) return raw;
  }
  if (set.has('integer')) {
    if (/^[+-]?\d+$/.test(raw.trim())) return Number(raw.trim());
    if (only) return raw;
  }
  if (set.has('number')) {
    const t = raw.trim();
    const n = Number(t);
    if (t !== '' && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t) && Number.isFinite(n)) return n;
    if (only) return raw;
  }
  if (set.has('array')) {
    const v = parseJsonValue(raw);
    if (Array.isArray(v)) return v;
    if (only) return raw;
  }
  if (set.has('object')) {
    const v = parseJsonValue(raw);
    if (v && typeof v === 'object' && !Array.isArray(v)) return v;
    if (only) return raw;
  }
  return raw;
}
