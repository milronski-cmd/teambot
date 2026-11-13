import type { AccessMode, Agent, Ctx, User } from '../../core/types.js';
import { inputLine, inputText } from '../../core/util.js';
import { applySharedModel } from '../../api/provider-policy.js';
import { findPart, partList } from '../../tools/builtin/selfserve.js';
import { EFFORT_ORDER } from '../../providers/capabilities.js';
import { patchBot, routeAs } from './inner.js';

/**
 * One way to change what the owner would otherwise click for a bot, shared by the main bot's `bot_settings` (any bot,
 * several at once) and every bot's own `my_settings` (itself): access, parts, model and thinking level, name, role,
 * description, instructions, skills, the notification level and the connected apps.
 *  - `planBotChange` reads the arguments for one bot and says what would change and what of it gives the bot more
 *    access than it has now (the owner is always asked for that). Cheap and synchronous: the gate calls it too.
 *  - `applyBotChange` does it through the routes the screens use, as the owner: the bot's own fields with the save of
 *    the bot editor (`patchBot` in inner.ts: the one way a tool writes a bot, with a version of the bot as it was),
 *    skills, notifications and apps with their own routes.
 */
export const ACCESS: Record<string, string> = { chat: 'Alleen praten', readonly: 'Alleen lezen', ask: 'Vraagt toestemming', auto: 'Automatisch', full: 'Volledige toegang' };
const ACCESS_ORDER = ['chat', 'readonly', 'ask', 'auto', 'full'];
const NOTIFY: Record<string, string> = { all: 'alles melden', important: 'alleen belangrijke meldingen', none: 'niets melden' };

export const names = (v: unknown): string[] => (Array.isArray(v) ? v : typeof v === 'string' && v.trim() ? v.split(',') : []).map((x) => inputLine(x, 80)).filter(Boolean);
const isAll = (list: string[]) => list.length === 1 && /^(alle|alles|all|\*)$/i.test(list[0]);
const key = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

export interface BotChange {
  bot: Agent;
  /** Fields of the bot itself. */
  patch: Partial<Agent>;
  /** The bot's new list of skills, when it changes. */
  skills: string[] | null;
  notify: 'all' | 'important' | 'none' | null;
  apps: { id: string; name: string; on: boolean }[];
  /** What changes, in words. */
  done: string[];
  /** What gives the bot more access than it has now. */
  widen: string[];
}

/**
 * What of new fields for a bot gives it MORE access than it has now. A bot (or the main bot for it) can always make
 * access smaller; larger always goes to the owner on a card, through whichever tool (my_settings, bot_settings,
 * teambot_do): a higher access level, sending to others without asking, a tool it no longer has to ask for, another
 * work folder. `parts`: a part switched on counts too, for a bot that still asks (on "Volledige toegang" it has every
 * part already). `cur` is null for a bot that is being made: only "Volledige toegang" is more than a new bot gets.
 * `next` may be a request body as a model wrote it: every field is checked before it is read.
 */
export function moreAccess(ctx: Ctx, cur: Agent | null, next: any, o: { parts?: boolean } = {}): string[] {
  const out: string[] = [];
  if (!next || typeof next !== 'object') return out;
  const level = ACCESS_ORDER.indexOf(next.access_mode);
  if (level > (cur ? ACCESS_ORDER.indexOf(cur.access_mode) : ACCESS_ORDER.indexOf('auto'))) out.push(next.access_mode === 'full' ? 'Volledige toegang (doet zijn werk zonder te vragen)' : `een hoger toegangsniveau (${ACCESS[next.access_mode]})`);
  if (next.settings?.fullAccessExternal === true && cur?.settings?.fullAccessExternal !== true) out.push('ook versturen naar anderen zonder te vragen');
  const policy = next.tool_policy && typeof next.tool_policy === 'object' && !Array.isArray(next.tool_policy) ? next.tool_policy : {};
  const free = Object.keys(policy).filter((k) => policy[k] === 'allow' && cur?.tool_policy?.[k] !== 'allow');
  if (free.length) out.push(`voortaan zonder vragen: ${free.slice(0, 6).join(', ')}`);
  if (next.workspace !== undefined && cur && JSON.stringify(next.workspace) !== JSON.stringify(cur.workspace)) out.push('een andere werkmap');
  if (o.parts && cur && cur.access_mode !== 'full' && Array.isArray(next.tool_groups)) {
    const added = next.tool_groups.filter((g: unknown): g is string => typeof g === 'string' && !cur.tool_groups.includes(g)).map((g: string) => ctx.tools.groups.get(g)?.label || g);
    if (added.length) out.push(`${added.join(', ')} aan`);
  }
  return out;
}

/** The fields both tools take (JSON schema properties), so their descriptions stay the same. */
export const CHANGE_PROPS = {
  access: { type: 'string', enum: Object.keys(ACCESS), description: 'Het toegangsniveau.' },
  send_to_others: { type: 'boolean', description: 'Bij volledige toegang: ook versturen naar anderen zonder te vragen.' },
  parts_on: { type: 'array', items: { type: 'string' }, description: 'Onderdelen om aan te zetten, zoals browser, shell of channels.' },
  parts_off: { type: 'array', items: { type: 'string' }, description: 'Onderdelen om uit te zetten.' },
  model: { type: 'string', description: 'Het model, met de exacte naam.' },
  reasoning: { type: 'string', description: 'Hoe diep het model nadenkt: low, medium, high, xhigh of max. “standaard” = de keuze van het model zelf.' },
  role: { type: 'string', description: 'De rol in een paar woorden.' },
  description: { type: 'string', description: 'Eén zin: wat de bot doet.' },
  instructions: { type: 'string', description: 'De volledige nieuwe instructies (vervangt wat er stond).' },
  instructions_add: { type: 'string', description: 'Tekst die achter de bestaande instructies komt.' },
  skills_on: { type: 'array', items: { type: 'string' }, description: 'Skills om aan te zetten (naam), of ["alle"].' },
  skills_off: { type: 'array', items: { type: 'string' }, description: 'Skills om uit te zetten (naam), of ["alle"].' },
  notifications: { type: 'string', enum: Object.keys(NOTIFY), description: 'Meldingen van deze bot aan de eigenaar: all (alles), important (alleen vragen, fouten en limieten) of none (niets).' },
  apps_on: { type: 'array', items: { type: 'string' }, description: 'Gekoppelde apps die de bot mag gebruiken (naam), of ["alle"].' },
  apps_off: { type: 'array', items: { type: 'string' }, description: 'Gekoppelde apps die de bot niet meer gebruikt.' },
} as const;

/** True when the arguments ask for any change (and not only to look). */
export const asksChange = (a: any) => !!a && [...Object.keys(CHANGE_PROPS), 'name'].some((k) => a[k] !== undefined && a[k] !== null && a[k] !== '' && !(Array.isArray(a[k]) && !a[k].length));

const skillLib = (ctx: Ctx) => ctx.services.skills?.library as any;
/** Skills this bot can have (not drafts, within its team's reach). */
function skillsFor(ctx: Ctx, bot: Agent): { id: string; name: string; status: string }[] {
  const lib = skillLib(ctx);
  if (!lib) return [];
  try {
    return (lib.list(bot.user_id) as any[]).filter((s) => s.status !== 'draft' && lib.reach(bot, s) !== 'none');
  } catch {
    return [];
  }
}
/** The owner's connected apps with whether this bot has them. */
function appsFor(ctx: Ctx, bot: Agent): { id: string; name: string; bound: boolean }[] {
  try {
    const bound = new Set(ctx.store.all<{ connection_id: string }>('SELECT connection_id FROM mcp_bindings WHERE agent_id = ?', bot.id).map((r) => r.connection_id));
    return ctx.store.all<any>('SELECT id, name, label FROM mcp_connections WHERE user_id = ? ORDER BY name, label', bot.user_id).map((c) => ({ id: c.id, name: c.label ? `${c.name} (${c.label})` : c.name, bound: bound.has(c.id) }));
  } catch {
    return []; // module off
  }
}
const notifyOf = (ctx: Ctx, bot: Agent): string => {
  try {
    return ctx.services.notifications?.prefs?.(bot.user_id)?.bots?.[bot.id] || 'all';
  } catch {
    return 'all';
  }
};

/** Pick items by name or id from `all`; an unknown one is an error with the names there are. */
function pick<T extends { id: string; name: string }>(all: T[], want: string[], what: string): T[] | string {
  if (isAll(want)) return all;
  const out: T[] = [];
  for (const w of want) {
    const hit = all.find((x) => x.id === w) || all.find((x) => x.name.toLowerCase() === w.toLowerCase()) || all.find((x) => key(x.name) === key(w));
    if (!hit) return `Er is geen ${what} “${w}”. Wel: ${all.map((x) => x.name).join(', ') || 'nog geen'}.`;
    out.push(hit);
  }
  return out;
}

/**
 * What these arguments would change for this bot. `o.rename`: the name may change too. `o.parts`: a part that is
 * switched on counts as more access (a bot changing itself; see `moreAccess`).
 */
export function planBotChange(ctx: Ctx, bot: Agent, a: any, o: { rename?: boolean; parts?: boolean } = {}): BotChange | { error: string } {
  const patch: Partial<Agent> = {};
  const done: string[] = [];
  const userId = bot.user_id;
  if (a?.access !== undefined && a.access !== null && a.access !== '') {
    const m = inputLine(a.access, 20).toLowerCase();
    if (!ACCESS[m]) return { error: `Onbekende toegang “${inputLine(a.access, 20)}”. Kies uit: ${Object.entries(ACCESS).map(([k, l]) => `${k} (${l})`).join(', ')}.` };
    if (m !== bot.access_mode) {
      patch.access_mode = m as AccessMode;
      done.push(`toegang: ${ACCESS[m]}`);
    }
  }
  const ext = a?.send_to_others === true || a?.send_to_others === 'true' ? true : a?.send_to_others === false || a?.send_to_others === 'false' ? false : undefined;
  if (ext !== undefined && ext !== (bot.settings?.fullAccessExternal === true)) {
    patch.settings = { ...bot.settings, fullAccessExternal: ext };
    done.push(ext ? 'mag ook versturen naar anderen zonder te vragen' : 'vraagt weer voordat hij iets naar anderen verstuurt');
  }
  const groups = new Set(bot.tool_groups);
  for (const [list, on] of [[names(a?.parts_on), true], [names(a?.parts_off), false]] as const)
    for (const n of list) {
      const g = findPart(ctx, n);
      if (!g || g.always) return { error: g ? `${g.label} staat altijd aan en kan niet aan of uit.` : `Er is geen onderdeel “${n}”. Onderdelen: ${partList(ctx)}.` };
      if (on === groups.has(g.id)) continue;
      if (on) groups.add(g.id);
      else groups.delete(g.id);
      done.push(`${g.label} ${on ? 'aan' : 'uit'}`);
    }
  if (groups.size !== bot.tool_groups.length || bot.tool_groups.some((g) => !groups.has(g))) patch.tool_groups = [...groups];
  const model = inputLine(a?.model, 200);
  if (model && model !== bot.model) {
    try {
      const cfg = bot.provider_id ? ctx.providers.config(bot.provider_id) : null;
      if (cfg) applySharedModel(cfg, userId, model);
    } catch (e: any) {
      return { error: String(e?.message || e) };
    }
    patch.model = model;
    done.push(`model: ${model}`);
  }
  if (typeof a?.reasoning === 'string' && a.reasoning.trim()) {
    const r = inputLine(a.reasoning, 20).toLowerCase();
    const v = /^(standaard|default|auto)$/.test(r) ? '' : r;
    if (v && !(EFFORT_ORDER as readonly string[]).includes(v)) return { error: `Onbekend denkniveau “${r}”. Kies uit: low, medium, high, xhigh, max of standaard.` };
    if (v !== (bot.reasoning || '')) {
      patch.reasoning = v;
      done.push(`denkniveau: ${v || 'standaard'}`);
    }
  }
  if (o.rename && inputLine(a?.name, 80) && inputLine(a.name, 80) !== bot.name) {
    const name = inputLine(a.name, 80);
    const twin = ctx.store.agents(userId, { archived: true }).find((x) => x.id !== bot.id && x.name.trim().toLowerCase() === name.toLowerCase());
    if (twin) return { error: `Er is al een bot die ${twin.name} heet. Kies een andere naam.` };
    patch.name = name;
    done.push(`naam: ${name}`);
  }
  if (typeof a?.role === 'string' && inputLine(a.role, 120) !== (bot.role || '')) {
    patch.role = inputLine(a.role, 120);
    done.push(`rol: ${patch.role || 'leeg'}`);
  }
  if (typeof a?.description === 'string' && inputLine(a.description, 400) !== (bot.description || '')) {
    patch.description = inputLine(a.description, 400);
    done.push('omschrijving aangepast');
  }
  const add = inputText(a?.instructions_add, 20_000);
  if (typeof a?.instructions === 'string' && a.instructions.trim() && add) return { error: 'Geef instructions (alles vervangen) of instructions_add (erachter zetten), niet allebei.' };
  if (typeof a?.instructions === 'string' && a.instructions.trim() && inputText(a.instructions, 60_000) !== (bot.instructions || '').trim()) {
    patch.instructions = inputText(a.instructions, 60_000);
    done.push('instructies vervangen');
  } else if (add && !(bot.instructions || '').includes(add)) {
    patch.instructions = `${(bot.instructions || '').trimEnd()}${bot.instructions?.trim() ? '\n\n' : ''}${add}`;
    done.push('instructies aangevuld');
  }

  let skills: string[] | null = null;
  const sOn = names(a?.skills_on);
  const sOff = names(a?.skills_off);
  if (sOn.length || sOff.length) {
    const all = skillsFor(ctx, bot);
    if (!skillLib(ctx)) return { error: 'Skills staan uit in deze TeamBot.' };
    const on = pick(all.filter((s) => s.status === 'active' || !isAll(sOn)), sOn, 'skill');
    if (typeof on === 'string') return { error: on };
    const off = pick(all, sOff, 'skill');
    if (typeof off === 'string') return { error: off };
    const cur = new Set((bot.skills || []).filter((id) => all.some((s) => s.id === id)));
    const next = new Set(cur);
    for (const s of on) next.add(s.id);
    for (const s of off) next.delete(s.id);
    const added = on.filter((s) => !cur.has(s.id));
    const removed = off.filter((s) => cur.has(s.id) && !next.has(s.id));
    if (added.length || removed.length) {
      skills = [...next];
      if (added.length) done.push(`skills aan: ${added.map((s) => s.name).join(', ')}`);
      if (removed.length) done.push(`skills uit: ${removed.map((s) => s.name).join(', ')}`);
    }
  }

  let notify: BotChange['notify'] = null;
  if (a?.notifications !== undefined && a.notifications !== null && a.notifications !== '') {
    const n = inputLine(a.notifications, 20).toLowerCase();
    if (!NOTIFY[n]) return { error: `Onbekend niveau voor meldingen “${n}”. Kies uit: all (alles), important (alleen belangrijke) of none (niets).` };
    if (n !== notifyOf(ctx, bot)) {
      notify = n as BotChange['notify'];
      done.push(`meldingen: ${NOTIFY[n]}`);
    }
  }

  const apps: BotChange['apps'] = [];
  const aOn = names(a?.apps_on);
  const aOff = names(a?.apps_off);
  if (aOn.length || aOff.length) {
    const all = appsFor(ctx, bot);
    for (const [want, on] of [[aOn, true], [aOff, false]] as const) {
      const hit = pick(all, want, 'gekoppelde app');
      if (typeof hit === 'string') return { error: hit };
      for (const c of hit) if (c.bound !== on && !apps.some((x) => x.id === c.id)) apps.push({ id: c.id, name: c.name, on });
    }
    const added = apps.filter((x) => x.on);
    const removed = apps.filter((x) => !x.on);
    if (added.length) done.push(`apps erbij: ${added.map((x) => x.name).join(', ')}`);
    if (removed.length) done.push(`apps eraf: ${removed.map((x) => x.name).join(', ')}`);
  }
  return { bot, patch, skills, notify, apps, done, widen: moreAccess(ctx, bot, patch, { parts: o.parts }) };
}

export const changesSomething = (c: BotChange) => Object.keys(c.patch).length > 0 || !!c.skills || !!c.notify || c.apps.length > 0;

/** The settings of a bot as lines: for looking, and after a change. */
export function settingsLines(ctx: Ctx, bot: Agent, o: { instructions?: boolean } = {}): string[] {
  const all = [...ctx.tools.groups.values()].filter((g) => !g.always);
  const on = all.filter((g) => ctx.tools.groupEnabled(bot, g.id));
  const off = all.filter((g) => !ctx.tools.groupEnabled(bot, g.id));
  const cfg = bot.provider_id ? ctx.providers.config(bot.provider_id) : null;
  const skills = skillsFor(ctx, bot);
  const has = new Set(bot.skills || []);
  const apps = appsFor(ctx, bot);
  const lines = [
    `Instellingen van ${bot.name}${bot.role ? ` (${bot.role})` : ''}:`,
    `- Toegang (access): ${bot.access_mode} — ${ACCESS[bot.access_mode] || bot.access_mode}`,
    `- Ook versturen naar anderen zonder te vragen (send_to_others): ${bot.settings?.fullAccessExternal === true ? 'ja' : 'nee'}${bot.access_mode === 'full' ? '' : ' (telt alleen bij Volledige toegang)'}`,
    `- Onderdelen aan: ${on.map((g) => `${g.id} (${g.label})`).join(', ') || 'geen'}`,
    `- Onderdelen uit: ${off.map((g) => `${g.id} (${g.label})`).join(', ') || 'geen'}`,
    `- AI: ${cfg?.name || 'nog niet gekozen'}${bot.model ? `, model ${bot.model}` : ''}${bot.reasoning ? `, denkniveau ${bot.reasoning}` : ''}`,
  ];
  if (skills.length) {
    lines.push(`- Skills aan: ${skills.filter((s) => has.has(s.id) && s.status === 'active').map((s) => s.name).join(', ') || 'geen'}`);
    const rest = skills.filter((s) => !has.has(s.id) && s.status === 'active');
    if (rest.length) lines.push(`- Skills uit: ${rest.map((s) => s.name).join(', ')}`);
  }
  if (apps.length) lines.push(`- Gekoppelde apps: ${apps.filter((x) => x.bound).map((x) => x.name).join(', ') || 'geen'}${apps.some((x) => !x.bound) ? ` (niet voor deze bot: ${apps.filter((x) => !x.bound).map((x) => x.name).join(', ')})` : ''}`);
  lines.push(`- Meldingen aan de eigenaar (notifications): ${notifyOf(ctx, bot)} — ${NOTIFY[notifyOf(ctx, bot)] || ''}`);
  if (bot.description) lines.push(`- Omschrijving: ${bot.description}`);
  if (o.instructions) lines.push('- Instructies:', bot.instructions?.trim() ? bot.instructions.trim().slice(0, 12_000) : '(nog leeg)');
  return lines;
}

/**
 * Do it, through the routes the screens use, as the owner. Throws nothing: returns the bot as it is now, or `error`
 * with a sentence (what was done before the error stays done).
 */
export async function applyBotChange(ctx: Ctx, owner: User, c: BotChange, signal?: AbortSignal): Promise<{ bot: Agent; error?: string }> {
  const id = c.bot.id;
  const step = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run();
    } catch (e: any) {
      throw new Error(`${what}${e?.message || e}`);
    }
  };
  try {
    if (Object.keys(c.patch).length) await step('', () => patchBot(ctx, owner, id, c.patch, signal));
    if (c.skills) await step('Skills: ', () => routeAs(ctx, owner, 'PUT', `/skills/agents/${id}`, { skillIds: c.skills }, signal));
    if (c.notify) await step('Meldingen: ', () => routeAs(ctx, owner, 'PUT', '/notifications/prefs', { bots: { [id]: c.notify } }, signal));
    for (const app of c.apps) await step(`App ${app.name}: `, () => routeAs(ctx, owner, 'PUT', `/mcp/agents/${id}/${app.id}`, { enabled: app.on }, signal));
    return { bot: ctx.store.agent(id) || c.bot };
  } catch (e: any) {
    return { bot: ctx.store.agent(id) || c.bot, error: String(e?.message || e) };
  }
}
