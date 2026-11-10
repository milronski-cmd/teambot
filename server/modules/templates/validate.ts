import YAML from 'yaml';
import { COLORS, EXTRAS, EYES, MOUTHS, SHAPES } from '../../../shared/botface.js';
import { nameKey } from '../rooms/routing.js';
import { normalizeSchedule } from '../routines/schedule.js';
import { findSecrets } from '../skills/scan.js';
import { botInstructions, teamInstructions } from './render.js';
import { placeholdersIn } from './profile.js';
import type { TemplateDef } from './types.js';

/**
 * Checks a template definition before it is offered (tests run this over every template). Returns plain problem
 * descriptions; an empty list means the template is fine. Developer-facing, so in English.
 */

/** Tool groups a template may ask for. Never: routines (bots could plan runs themselves), channels, browser, desktop. */
export const TEMPLATE_TOOL_GROUPS = new Set(['files', 'web', 'memory', 'skills', 'team', 'shell']);
/** Tool groups a bot that talks with customers directly may not have. */
const NOT_FOR_CUSTOMER_BOTS = new Set(['shell', 'web']);
/** Keys that would carry personal state or an AI choice; never in a template. */
const FORBIDDEN_KEYS = new Set(['provider', 'provider_id', 'providerId', 'model', 'workspace', 'workspace_path', 'secrets', 'secret', 'apiKey', 'api_key', 'memory_items', 'messages', 'conversations', 'threads', 'channels']);

const SLUG = /^[a-z0-9][a-z0-9-]{1,40}$/;
const SKILL_ID = /^([a-z0-9][a-z0-9-]{0,40}\/)?[a-z0-9][a-z0-9-]{0,63}$/;
const KEY = /^[a-z][a-z0-9_]{1,23}$/;
/** One word for @naam: letters (with accents), digits and hyphens. */
const BOT_NAME = /^[\p{L}][\p{L}\p{N}-]{1,23}$/u;
const MAX_LINE = 240;
const MAX_INSTRUCTIONS = 4500;

/**
 * Safe as a plain YAML scalar (a skill or catalogue frontmatter line): one line, no quoting needed, and it reads back
 * unchanged.
 */
export function yamlSafe(s: string): boolean {
  if (!s || s !== s.trim() || /[\r\n\t]/.test(s)) return false;
  try {
    const out = YAML.stringify(s, { lineWidth: 0 }).trimEnd();
    return out === s && YAML.parse(out) === s;
  } catch {
    return false;
  }
}

/** A plain public https link: no login in it, no query string (no tokens), a real host name. */
export function publicHttps(u: string): boolean {
  try {
    const x = new URL(u);
    return x.protocol === 'https:' && !x.username && !x.password && !x.search && !x.hash && /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(x.hostname) && !/^(localhost|.*\.local)$/i.test(x.hostname);
  } catch {
    return false;
  }
}

function walkKeys(v: unknown, path: string, out: string[]) {
  if (!v || typeof v !== 'object') return;
  for (const [k, x] of Object.entries(v)) {
    if (FORBIDDEN_KEYS.has(k)) out.push(`${path}.${k}: not allowed in a template`);
    walkKeys(x, `${path}.${k}`, out);
  }
}

export function validateTemplate(def: TemplateDef): string[] {
  const p: string[] = [];
  const at = (s: string) => `${def?.id || '?'}: ${s}`;
  if (!def || typeof def !== 'object') return ['not a template'];
  if (!SLUG.test(def.id || '')) p.push(at('id must be a lowercase slug'));
  if (!/^\d+\.\d+\.\d+$/.test(def.version || '')) p.push(at('version must be semver'));
  if (!['new', 'refreshed'].includes(def.status)) p.push(at('status must be new or refreshed'));
  if (!['bedrijf', 'prive', 'algemeen'].includes(def.category)) p.push(at('category must be bedrijf, prive or algemeen'));
  if (!def.name || def.name.length < 3 || def.name.length > 40) p.push(at('name: 3–40 characters'));
  if (!def.description || def.description.length < 30 || def.description.length > 200) p.push(at('description: 30–200 characters'));
  else if (!yamlSafe(def.description)) p.push(at('description is not YAML-safe'));
  if (def.note !== undefined && (!def.note || def.note.length > 200)) p.push(at('note: one short tip of at most 200 characters'));
  if (!def.goal || def.goal.length > MAX_LINE) p.push(at('goal: one short sentence'));
  for (const r of def.rules || []) if (!r || r.length > MAX_LINE) p.push(at(`rule too long or empty: ${r}`));

  // Questions: 3–5, unique keys; name and business exactly once, tone and rules at most once.
  const qs = Array.isArray(def.questions) ? def.questions : [];
  if (qs.length < 3 || qs.length > 5) p.push(at('3–5 profile questions'));
  const keys = new Set<string>();
  for (const q of qs) {
    if (!KEY.test(q.key || '')) p.push(at(`question key "${q.key}" must be a short lowercase key`));
    if (keys.has(q.key)) p.push(at(`question key "${q.key}" twice`));
    keys.add(q.key);
    if (!q.label || q.label.length > 120 || !q.label.endsWith('?')) p.push(at(`question "${q.key}" needs a short label that is a question`));
    if (!['text', 'textarea'].includes(q.kind)) p.push(at(`question "${q.key}": kind must be text or textarea`));
    if (q.profile === 'extra' && !q.short) p.push(at(`question "${q.key}": an extra answer needs a short label`));
  }
  for (const f of ['name', 'business'] as const) {
    const n = qs.filter((q) => q.profile === f).length;
    if (n !== 1) p.push(at(`exactly one question must fill the profile field "${f}" (found ${n})`));
  }
  for (const f of ['tone', 'rules'] as const) if (qs.filter((q) => q.profile === f).length > 1) p.push(at(`at most one question may fill the profile field "${f}"`));
  if (!qs.some((q) => q.profile === 'tone' || q.profile === 'rules')) p.push(at('ask for the tone or the rules (or both)'));

  const ex = Array.isArray(def.examples) ? def.examples : [];
  if (ex.length < 2 || ex.length > 4) p.push(at('2–4 examples with "klaar als"'));
  for (const e of ex) if (!e.task || !e.done || e.task.length > 120 || e.done.length > MAX_LINE) p.push(at(`example "${e.task}" needs a short task and "klaar als"`));

  // Bots: one lead and 2–4 helpers, unique one-word names, complete instructions.
  const bots = Array.isArray(def.bots) ? def.bots : [];
  const leads = bots.filter((b) => b.lead);
  if (leads.length !== 1) p.push(at(`exactly one team lead (found ${leads.length})`));
  if (def.minimal ? bots.length !== 1 : bots.length < 3 || bots.length > 5) p.push(at(def.minimal ? 'the simplest team has only its team lead' : 'a team lead and 2–4 bots'));
  if (bots.some((b) => b.customer === 'direct' && !b.lead)) p.push(at('only the team lead may talk with customers directly'));
  const names = new Set<string>();
  for (const b of bots) {
    const who = (s: string) => at(`${b.name}: ${s}`);
    if (!BOT_NAME.test(b.name || '')) p.push(who('name must be one word (letters, digits, hyphen), 2–24 characters'));
    if (names.has(nameKey(b.name))) p.push(who('name used twice'));
    names.add(nameKey(b.name));
    if (!b.role || b.role.length > 60) p.push(who('role: a few words'));
    if (!b.description || b.description.length > 160) p.push(who('description: one sentence of at most 160 characters'));
    else if (!yamlSafe(b.description)) p.push(who('description is not YAML-safe'));
    const f = b.face;
    if (!f || !(SHAPES as readonly string[]).includes(f.shape) || !(COLORS as readonly string[]).includes(f.color) || !(EYES as readonly string[]).includes(f.eyes) || !(MOUTHS as readonly string[]).includes(f.mouth) || !(EXTRAS as readonly string[]).includes(f.extra) || typeof f.cheeks !== 'boolean') p.push(who('face has an unknown trait'));
    for (const g of b.tools || []) if (!TEMPLATE_TOOL_GROUPS.has(g)) p.push(who(`tool group "${g}" is not allowed in a template`));
    if (!(b.tools || []).includes('team')) p.push(who('needs the team tool group'));
    if (b.customer === 'direct') for (const g of b.tools || []) if (NOT_FOR_CUSTOMER_BOTS.has(g)) p.push(who(`talks with customers directly, so no "${g}"`));
    if (!b.intro || b.intro.length > MAX_LINE) p.push(who('intro: one or two short sentences'));
    const sections: [string, string[] | undefined, number][] = [
      ['does', b.does, 2],
      ['may', b.may, 1],
      ['mayNot', b.mayNot, 1],
      ['askWhen', b.askWhen, b.lead ? 2 : 1],
    ];
    for (const [k, v, min] of sections) {
      if (!Array.isArray(v) || v.length < min) p.push(who(`${k}: at least ${min}`));
      for (const x of v || []) if (!x || x.length > MAX_LINE) p.push(who(`${k}: item too long or empty`));
    }
    if (!Array.isArray(b.doneWhen) || b.doneWhen.length < (b.lead ? 2 : 1)) p.push(who(b.lead ? 'doneWhen: a team lead needs two "klaar als" examples' : 'doneWhen: needs a "klaar als" example'));
    for (const d of b.doneWhen || []) if (!d.task || !d.done || `${d.task}: ${d.done}`.length > MAX_LINE) p.push(who(`doneWhen "${d.task}" too long or empty`));
    for (const s of b.skills || []) {
      if (!SKILL_ID.test(s.id || '')) p.push(who(`skill id "${s.id}" is not a stable catalogue id`));
      if (!s.why || s.why.length > 120 || !yamlSafe(s.why)) p.push(who(`skill "${s.id}": the reason must be one short, YAML-safe line`));
    }
    if (b.specialist) {
      const sp = b.specialist;
      if (!sp.field || sp.field.length < 3 || sp.field.length > 80 || !yamlSafe(sp.field)) p.push(who('specialist field: one short, YAML-safe line'));
      const src = Array.isArray(sp.suggestedSources) ? sp.suggestedSources : [];
      if (!Array.isArray(sp.suggestedSources) || src.length > 5) p.push(who('specialist: at most 5 suggested sources'));
      if (new Set(src).size !== src.length) p.push(who('specialist: a source is listed twice'));
      for (const u of src) if (!publicHttps(u)) p.push(who(`specialist source "${u}" must be a plain public https link`));
    }
    for (const r of b.routines || []) {
      if (!r.name || r.name.length > 80) p.push(who('routine name: at most 80 characters'));
      if (!r.prompt || r.prompt.length > 2000) p.push(who(`routine "${r.name}": prompt missing or too long`));
      for (const k of placeholdersIn(r.prompt || '')) if (!keys.has(k)) p.push(who(`routine "${r.name}": unknown placeholder {${k}}`));
      try {
        normalizeSchedule(r.schedule, 'Europe/Amsterdam', Date.now());
      } catch (e: any) {
        p.push(who(`routine "${r.name}": ${e?.message || e}`));
      }
      if (r.options?.missedPolicy === 'catchup') p.push(who(`routine "${r.name}": a suggested routine skips missed runs`));
    }
    let text = '';
    try {
      text = botInstructions(def, b);
    } catch (e: any) {
      p.push(who(`instructions do not render: ${e?.message || e}`));
    }
    if (text.length > MAX_INSTRUCTIONS) p.push(who(`instructions are too long (${text.length} > ${MAX_INSTRUCTIONS})`));
    if (/\b(TODO|lorem|ipsum)\b/i.test(text)) p.push(who('instructions contain a placeholder text'));
  }
  try {
    teamInstructions(def);
  } catch (e: any) {
    p.push(at(`team instructions do not render: ${e?.message || e}`));
  }

  // Nothing personal and no secrets anywhere.
  walkKeys(def, def.id, p);
  const secrets = findSecrets(JSON.stringify(def));
  if (secrets.length) p.push(at(`looks like a secret: ${secrets.join(', ')}`));
  return p;
}

/** All templates together: unique ids, and bot names unique across templates (teams can live side by side). */
export function validateRegistry(defs: readonly TemplateDef[]): string[] {
  const p = defs.flatMap((d) => validateTemplate(d));
  const ids = new Set<string>();
  const botNames = new Map<string, string>();
  for (const d of defs) {
    if (ids.has(d.id)) p.push(`${d.id}: id used twice`);
    ids.add(d.id);
    for (const b of d.bots || []) {
      const k = nameKey(b.name || '');
      const other = botNames.get(k);
      if (other && other !== d.id) p.push(`${d.id}: bot name "${b.name}" is also used in ${other}`);
      botNames.set(k, d.id);
    }
  }
  return p;
}
