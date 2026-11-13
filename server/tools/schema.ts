import { Validator, type OutputUnit, type SchemaDraft } from '@cfworker/json-schema';

/**
 * Tool arguments checked against the tool's full JSON schema (nested objects, array items, enums, ranges, required
 * fields at every depth, $ref/$defs) with `@cfworker/json-schema` (MIT; no code generation, so it is safe in Electron).
 *
 * Lenient steps first, because models (small ones most of all) write values as text, and a model that does not have
 * the schema in front of it (a CLI engine loads tool schemas late) guesses the name of an argument:
 *  - coercion along the schema: "5" → 5 for a number, "true" → true for a boolean, '["a"]' → ["a"] for an array, and
 *    plain text where a list of texts is asked becomes a list of one;
 *  - an optional argument that is null is left out (the tool sees it as not given), unless the schema allows null;
 *  - a required argument under a guessed name (`task_id` for `id`, `skill` for `name`) is put under its own name
 *    (guessedNames below).
 * `format` (uri, date-time, …) is not enforced: tools read those themselves and are often more forgiving.
 * The error names the exact place (`items/0/qty`) in a sentence the model can act on.
 */

export interface ArgsCheck {
  /** The arguments after coercion (the tool runs with these). */
  args: any;
  /** A correction for the model, or null when the arguments fit. */
  error: string | null;
}

const MAX_DEPTH = 32;
const compiled = new WeakMap<object, Validator | null>();

function draftOf(schema: any): SchemaDraft {
  const s = String(schema?.$schema || '');
  if (/draft-0[34]/.test(s)) return '4';
  if (/draft-0[67]/.test(s)) return '7';
  if (/2019-09/.test(s)) return '2019-09';
  return '2020-12';
}

/** Schema keywords whose value is one schema, a list of schemas, or a map of schemas. */
const ONE = ['additionalProperties', 'unevaluatedProperties', 'items', 'additionalItems', 'unevaluatedItems', 'contains', 'propertyNames', 'not', 'if', 'then', 'else'];
const LIST = ['allOf', 'anyOf', 'oneOf', 'prefixItems', 'items'];
const MAP = ['properties', 'patternProperties', '$defs', 'definitions', 'dependentSchemas'];

/** A copy without `format` (the validator also writes its own bookkeeping into the schema, never into the tool's). */
function prepared(schema: any, depth = 0): any {
  if (!schema || typeof schema !== 'object' || Array.isArray(schema) || depth > MAX_DEPTH) return schema;
  const out: any = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'format') continue;
    if (MAP.includes(k) && v && typeof v === 'object' && !Array.isArray(v)) out[k] = Object.fromEntries(Object.entries(v).map(([n, s]) => [n, prepared(s, depth + 1)]));
    else if (LIST.includes(k) && Array.isArray(v)) out[k] = v.map((s) => prepared(s, depth + 1));
    else if (ONE.includes(k)) out[k] = prepared(v, depth + 1);
    else out[k] = v;
  }
  return out;
}

function validatorFor(schema: any): Validator | null {
  if (compiled.has(schema)) return compiled.get(schema)!;
  let v: Validator | null = null;
  try {
    v = new Validator(prepared(schema), draftOf(schema), false);
  } catch {
    v = null; // a schema the validator cannot read: the shallow check below still runs
  }
  compiled.set(schema, v);
  return v;
}

const typesOf = (s: any): string[] => (Array.isArray(s?.type) ? s.type.map(String) : typeof s?.type === 'string' ? [s.type] : []);
const allows = (s: any, t: string) => {
  const own = typesOf(s);
  const branches = [...(Array.isArray(s?.anyOf) ? s.anyOf : []), ...(Array.isArray(s?.oneOf) ? s.oneOf : [])].flatMap(typesOf);
  return own.includes(t) || branches.includes(t) || (t === 'number' && (own.includes('integer') || branches.includes('integer')));
};

/** A local `$ref` ("#/$defs/item") followed to the schema it points at. */
function deref(root: any, s: any): any {
  for (let hops = 0; s && typeof s === 'object' && typeof s.$ref === 'string' && s.$ref.startsWith('#') && hops < 10; hops++) {
    let t = root;
    for (const p of s.$ref.slice(1).split('/').filter(Boolean)) t = t?.[decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~')];
    if (!t || typeof t !== 'object') return s;
    s = t;
  }
  return s;
}

/** The JSON-schema types a schema allows (its own and those of its anyOf/oneOf branches); empty = any. */
const allowedTypes = (s: any) => new Set([...typesOf(s), ...[...(s?.anyOf || []), ...(s?.oneOf || [])].flatMap(typesOf)]);

/** Does a value have a type this schema allows (after coercion)? A schema without types allows everything. */
function fits(schema: any, v: any): boolean {
  const types = allowedTypes(schema);
  if (!types.size) return true;
  const t = Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v === 'number' && Number.isInteger(v) ? 'integer' : typeof v;
  return types.has(t) || (t === 'integer' && types.has('number'));
}

/** The words of an argument name: "task_id", "taskId" and "task-id" → task, id. */
const nameWords = (k: string) =>
  k
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

/**
 * A required argument that was given under a name the tool does not know. Only when it is clear which one was meant:
 * the unknown name holds the missing one as a word (`task_id`, `taskId`, `skill_name`), or exactly one required
 * argument is missing and exactly one unknown argument was given (`skill` for `name`, `file` for `path`). The value must
 * have the type the tool asks for. Such a call would fail anyway; this way it does what the model meant.
 */
function guessedNames(props: Record<string, any>, required: Set<string>, value: Record<string, any>, root: any, depth: number): Record<string, any> {
  const has = (k: string) => value[k] !== undefined && value[k] !== null;
  const missing = [...required].filter((r) => !has(r) && Object.hasOwn(props, r));
  if (!missing.length) return value;
  let stray = Object.keys(value).filter((k) => !Object.hasOwn(props, k) && has(k));
  if (!stray.length) return value;
  const out = { ...value };
  const take = (to: string, from: string) => {
    const p = deref(root, props[to]);
    if (!fits(p, coerceArgs(p, value[from], depth + 1, root))) return false;
    out[to] = value[from];
    delete out[from];
    stray = stray.filter((k) => k !== from);
    return true;
  };
  const left: string[] = [];
  for (const m of missing) {
    const words = nameWords(m);
    const named = stray.filter((k) => {
      const w = nameWords(k);
      return !!w.length && !!words.length && (words.every((x) => w.includes(x)) || w.every((x) => words.includes(x)));
    });
    if (named.length !== 1 || !take(m, named[0])) left.push(m);
  }
  if (left.length === 1 && stray.length === 1) take(left[0], stray[0]);
  return out;
}

/** "5" → 5, "true" → true, '["a"]' → ["a"] where the schema asks for that type; nested along properties and items. */
export function coerceArgs(schemaIn: any, value: any, depth = 0, root: any = schemaIn): any {
  const schema = deref(root, schemaIn);
  if (!schema || typeof schema !== 'object' || depth > MAX_DEPTH) return value;
  const types = allowedTypes(schema);
  if (typeof value === 'string' && types.size && !types.has('string')) {
    const t = value.trim();
    if ((types.has('integer') && /^[+-]?\d+$/.test(t)) || (types.has('number') && t !== '' && Number.isFinite(Number(t)) && /^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t))) return Number(t);
    if (types.has('boolean') && /^(true|false)$/i.test(t)) return t.toLowerCase() === 'true';
    if ((types.has('array') && t.startsWith('[')) || (types.has('object') && t.startsWith('{'))) {
      try {
        const j = JSON.parse(t);
        if (Array.isArray(j) ? types.has('array') : j && typeof j === 'object' && types.has('object')) return coerceArgs(schema, j, depth + 1, root);
      } catch {
        /* stays text; the check names it */
      }
      return value;
    }
    // Plain text where a list of texts is asked ("rapport.md" for evidence, one name for a list of bots): a list of one.
    const items = schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items) ? deref(root, schema.items) : null;
    if (t && types.has('array') && (!items || fits(items, value))) return [value];
    return value;
  }
  if (Array.isArray(value)) {
    const items = schema.items && typeof schema.items === 'object' && !Array.isArray(schema.items) ? schema.items : null;
    const prefix = Array.isArray(schema.prefixItems) ? schema.prefixItems : Array.isArray(schema.items) ? schema.items : null;
    return value.map((v, i) => coerceArgs(prefix?.[i] ?? items, v, depth + 1, root));
  }
  if (value && typeof value === 'object') {
    const props = schema.properties && typeof schema.properties === 'object' ? schema.properties : null;
    if (!props) return value;
    const required = new Set<string>(Array.isArray(schema.required) ? schema.required : []);
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(guessedNames(props, required, value, root, depth))) {
      const p = Object.hasOwn(props, k) ? deref(root, props[k]) : undefined;
      if (v === null && !required.has(k) && p && typeof p === 'object' && (typesOf(p).length || p.anyOf || p.oneOf) && !allows(p, 'null')) continue;
      out[k] = p ? coerceArgs(p, v, depth + 1, root) : v;
    }
    return out;
  }
  return value;
}

/** JSON pointer "#/items/0/qty" → "items/0/qty" (top level → ""). */
function place(loc: string): string {
  return loc
    .replace(/^#\/?/, '')
    .split('/')
    .map((p) => {
      try {
        return decodeURIComponent(p).replace(/~1/g, '/').replace(/~0/g, '~');
      } catch {
        return p;
      }
    })
    .join('/');
}

/** Keywords that only say "something inside did not match"; the inner error says what. */
const WRAPPING = new Set(['properties', 'patternProperties', 'items', 'prefixItems', 'additionalItems', 'unevaluatedItems', 'contains', 'allOf', '$ref', '$recursiveRef', 'dependentSchemas', 'dependencies', 'if', 'then', 'else', 'propertyNames', 'false']);

function sentence(e: OutputUnit, schema: any): string {
  const at = place(e.instanceLocation);
  const where = at ? `Argument ${at}` : 'De argumenten';
  switch (e.keyword) {
    case 'required': {
      const m = /required property "([^"]+)"/.exec(e.error);
      const name = m ? (at ? `${at}/${m[1]}` : m[1]) : at;
      // What the argument is, in the tool's own words: a model without the schema in front of it can then fill it in.
      const what = String(schemaAt(schema, name)?.description || '').replace(/\s+/g, ' ').trim().slice(0, 200);
      return `Verplicht argument ontbreekt: ${name}${what ? ` — ${what.replace(/\.$/, '')}.` : ''}`;
    }
    case 'type': {
      const m = /Instance type "([^"]+)" is invalid\. Expected "([^"]+)"/.exec(e.error);
      return m ? `${where} moet type ${m[2].replace(/", "/g, ' of ')} hebben, maar is ${m[1]}.` : `${where} heeft het verkeerde type.`;
    }
    case 'enum':
    case 'const': {
      const m = /any of (\[.*\])\.$/.exec(e.error) || /does not match (.*)\.$/.exec(e.error);
      return `${where} moet een van deze waarden zijn: ${(m?.[1] || '').slice(0, 300)}.`;
    }
    case 'additionalProperties':
    case 'unevaluatedProperties': {
      const m = /Property "([^"]+)"/.exec(e.error);
      const allowed = Object.keys(schemaAt(schema, at)?.properties || {});
      return `Onbekend argument: ${m ? (at ? `${at}/${m[1]}` : m[1]) : at}.${allowed.length ? ` Toegestaan: ${allowed.join(', ')}.` : ''}`;
    }
    case 'minLength':
    case 'maxLength':
    case 'minimum':
    case 'maximum':
    case 'exclusiveMinimum':
    case 'exclusiveMaximum':
    case 'minItems':
    case 'maxItems':
    case 'pattern':
    case 'multipleOf':
    case 'uniqueItems':
    case 'minProperties':
    case 'maxProperties':
      return `${where} past niet in het schema (${e.keyword}): ${e.error}`;
    case 'anyOf':
    case 'oneOf':
      return `${where} past bij geen van de toegestane vormen (${e.keyword}).`;
    default:
      return `${where} past niet in het schema: ${e.error}`;
  }
}

/** The sub-schema at a plain path (for "Toegestaan: …"); only through properties and items. */
function schemaAt(schema: any, at: string): any {
  let s = schema;
  for (const p of at ? at.split('/') : []) {
    if (!s || typeof s !== 'object') return null;
    s = s.properties?.[p] ?? (/^\d+$/.test(p) ? (Array.isArray(s.prefixItems) ? s.prefixItems[Number(p)] : s.items) : undefined);
  }
  return s;
}

/** The old shallow check, for a schema the validator cannot read: required fields and primitive types at the top. */
function shallow(schema: any, args: any): string | null {
  for (const r of schema.required || []) if (args[r] === undefined || args[r] === null) return `Verplicht argument ontbreekt: ${r}`;
  for (const [k, def] of Object.entries<any>(schema.properties || {})) {
    const v = args[k];
    if (v === undefined || v === null || !def?.type) continue;
    const t = def.type;
    const ok = t === 'string' ? typeof v === 'string' : t === 'number' || t === 'integer' ? typeof v === 'number' : t === 'boolean' ? typeof v === 'boolean' : t === 'array' ? Array.isArray(v) : t === 'object' ? typeof v === 'object' : true;
    if (!ok) return `Argument ${k} moet type ${t} hebben.`;
  }
  return null;
}

/** Coerce, then check against the whole schema. At most three problems are named, most specific first. */
export function checkArgs(schema: any, args: any): ArgsCheck {
  if (!schema || typeof schema !== 'object' || schema.type !== 'object') return { args, error: null };
  if (args === null || typeof args !== 'object' || Array.isArray(args)) return { args, error: 'Argumenten moeten een object zijn.' };
  const fixed = coerceArgs(schema, args);
  const v = validatorFor(schema);
  if (!v) return { args: fixed, error: shallow(schema, fixed) };
  let res;
  try {
    res = v.validate(fixed);
  } catch {
    return { args: fixed, error: shallow(schema, fixed) };
  }
  if (res.valid) return { args: fixed, error: null };
  const leaves = res.errors.filter((e) => !WRAPPING.has(e.keyword));
  const picked = (leaves.length ? leaves : res.errors).sort((a, b) => b.instanceLocation.length - a.instanceLocation.length);
  const lines = [...new Set(picked.map((e) => sentence(e, schema)))].slice(0, 3);
  return { args: fixed, error: lines.join(' ') || 'De argumenten passen niet in het schema van deze tool.' };
}

/** Kept for callers that only need the verdict: the correction, or null when the arguments fit. */
export function validateArgs(schema: any, args: any): string | null {
  return checkArgs(schema, args).error;
}
