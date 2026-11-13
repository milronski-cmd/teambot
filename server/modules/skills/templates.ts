import type { Agent, Ctx } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { sanitizeNewAgentFor } from '../../api/member-policy.js';
import { defaultToolGroups } from '../../agent/new-bot.js';
import { checksumOf } from './files.js';
import { slugify } from './format.js';
import { type Placement, type SkillLibrary, type SkillRow, analyze } from './library.js';
import { type FileContent, filesToMap, mapToFiles, templateAvatar } from './catalog.js';
import { ownerLooksFirst, redactSecrets } from './scan.js';
import { type InlinePackage, type PackageVerification } from '../../../packages/teambot-sdk/src/index.js';
import { type PackageInfo, infoSummary, verifyInline } from './publishers.js';

export const TEMPLATE_FORMAT = 'teambot.bot-template/v1';

/**
 * A bot package (`{ manifest, files: { 'bot.json': … } }`): verify it and read the template from bot.json.
 * The caller decides with the publisher policy whether it may be installed.
 */
export function templateFromPackage(ctx: Ctx, p: InlinePackage): { template: BotTemplate; warnings: string[]; verification: PackageVerification } {
  const { files, verification } = verifyInline(ctx, p, 'bot');
  const raw = files.get('bot.json');
  if (!raw) throw new HttpError(400, 'Dit bot-pakket bevat geen bot.json.');
  let json: any;
  try {
    json = JSON.parse(Buffer.from(raw).toString('utf8'));
  } catch {
    throw new HttpError(400, 'bot.json in dit pakket is geen geldige JSON.');
  }
  const n = normalizeTemplate(json);
  return { ...n, verification };
}
const ACCESS = new Set(['chat', 'readonly', 'ask', 'auto', 'full']);
const SAFE_SETTINGS = ['maxTurns', 'vision'];

export interface TemplateSkill {
  name: string;
  title?: string;
  version: string;
  checksum: string;
  license?: string;
  files: Record<string, FileContent>;
  catalog?: { catalogId: string; itemId: string; verified: boolean } | null;
}

export interface BotTemplate {
  format: typeof TEMPLATE_FORMAT;
  name: string;
  role: string;
  description: string;
  instructions: string;
  avatar: string;
  color: string;
  access_mode: string;
  tool_groups: string[];
  reasoning: string;
  busy_policy: 'queue' | 'steer' | 'interrupt';
  settings: Record<string, any>;
  model_hint: string;
  skills: TemplateSkill[];
  routines: any[];
  meta: Record<string, any>;
}

const str = (v: any, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');

/**
 * Export a bot as a portable template. Never included: conversations, memory, secrets, provider
 * choice or keys, tool-policy overrides, workspace path or files. Secrets that slipped into texts
 * are removed (reported in `warnings`).
 */
export async function exportTemplate(ctx: Ctx, lib: SkillLibrary, agent: Agent): Promise<{ template: BotTemplate; warnings: string[] }> {
  const warnings: string[] = [];
  let removed = 0;
  const clean = (v: string) => {
    const r = redactSecrets(v || '');
    removed += r.count;
    return r.text;
  };
  const skills: TemplateSkill[] = [];
  for (const sk of lib.enabledFor(agent)) {
    const files = lib.readFiles(sk);
    for (const [p, b] of files) {
      if (b.includes(0)) continue;
      const r = redactSecrets(b.toString('utf8'));
      if (r.count) {
        files.set(p, Buffer.from(r.text, 'utf8'));
        warnings.push(r.count === 1 ? `Skill ${sk.name}: 1 mogelijk geheim verwijderd uit ${p}.` : `Skill ${sk.name}: ${r.count} mogelijke geheimen verwijderd uit ${p}.`);
      }
    }
    const ref = sk.catalog_ref ? sk.catalog_ref.split('/') : null;
    skills.push({ name: sk.name, version: sk.version, checksum: checksumOf(files), license: sk.license || undefined, files: mapToFiles(files), catalog: ref ? { catalogId: ref[0], itemId: ref.slice(1).join('/'), verified: ref[0] === 'builtin' } : null });
  }
  let routines: any[] = [];
  const svc = ctx.services.routines;
  if (svc && typeof svc.exportForAgent === 'function') {
    try {
      const defs = await svc.exportForAgent(agent.user_id, agent.id);
      if (Array.isArray(defs)) {
        const r = redactSecrets(JSON.stringify(defs));
        removed += r.count;
        routines = JSON.parse(r.text);
      }
    } catch (e: any) {
      warnings.push(`Routines konden niet worden meegenomen: ${e?.message || e}`);
    }
  }
  const settings: Record<string, any> = {};
  for (const k of SAFE_SETTINGS) if (agent.settings?.[k] !== undefined) settings[k] = agent.settings[k];
  const template: BotTemplate = {
    format: TEMPLATE_FORMAT,
    name: clean(agent.name),
    role: clean(agent.role),
    description: clean(agent.description),
    instructions: clean(agent.instructions),
    avatar: templateAvatar(agent.avatar),
    color: agent.color,
    access_mode: agent.access_mode,
    tool_groups: agent.tool_groups,
    reasoning: agent.reasoning,
    busy_policy: agent.busy_policy,
    settings,
    model_hint: agent.model || '',
    skills,
    routines,
    meta: { app: ctx.config.appName, app_version: ctx.config.version, template_version: '1.0.0', exported_at: new Date().toISOString() },
  };
  if (removed) warnings.unshift(removed === 1 ? '1 mogelijk geheim verwijderd uit de instructies of routines.' : `${removed} mogelijke geheimen verwijderd uit de instructies of routines.`);
  return { template, warnings };
}

/** Accept our template format (and the core `teambot.agent/v1` profile) from an untrusted file. */
export function normalizeTemplate(raw: any): { template: BotTemplate; warnings: string[] } {
  const warnings: string[] = [];
  if (!raw || typeof raw !== 'object') throw new HttpError(400, 'Geen geldig sjabloon.');
  if (raw.format !== TEMPLATE_FORMAT && raw.format !== 'teambot.agent/v1') throw new HttpError(400, `Onbekend sjabloonformaat. Verwacht "${TEMPLATE_FORMAT}".`);
  if (raw.format === 'teambot.agent/v1' && Array.isArray(raw.skills) && raw.skills.some((x: any) => typeof x === 'string')) warnings.push('Dit profiel verwijst naar skills van een andere installatie; die worden niet meegenomen.');
  const skills: TemplateSkill[] = [];
  for (const x of Array.isArray(raw.skills) ? raw.skills.slice(0, 30) : []) {
    if (!x || typeof x !== 'object' || !x.files || typeof x.files !== 'object') continue;
    skills.push({
      name: slugify(str(x.name, 64)),
      title: str(x.title, 120) || undefined,
      version: str(x.version, 40),
      checksum: str(x.checksum, 64),
      license: str(x.license, 120) || undefined,
      files: x.files,
      catalog: x.catalog && typeof x.catalog === 'object' ? { catalogId: str(x.catalog.catalogId, 80), itemId: str(x.catalog.itemId, 120), verified: false } : null,
    });
  }
  const settings: Record<string, any> = {};
  for (const k of SAFE_SETTINGS) if (raw.settings?.[k] !== undefined && typeof raw.settings[k] !== 'object') settings[k] = raw.settings[k];
  // A specialist field with suggested sources (package S, e.g. from a team template): kept as bounded data. The
  // specialists module checks it again when the bot is made (no instructions in the field, safe sources) and keeps the
  // learning round off until the owner turns it on.
  const spec = raw.settings?.specialist ?? raw.specialist ?? raw.meta?.specialist;
  if (spec && typeof spec === 'object' && typeof spec.field === 'string' && spec.field.trim()) {
    const sources = (Array.isArray(spec.suggestedSources) ? spec.suggestedSources : [])
      .slice(0, 20)
      .map((s: any) => (typeof s === 'string' ? str(s, 500) : s && typeof s === 'object' ? { url: str(s.url ?? s.target, 500), ...(s.kind ? { kind: str(s.kind, 20) } : {}), ...(s.label ? { label: str(s.label, 120) } : {}) } : null))
      .filter((s: any) => (typeof s === 'string' ? !!s.trim() : !!s?.url));
    settings.specialist = { field: str(spec.field, 300), suggestedSources: sources };
  }
  const t: BotTemplate = {
    format: TEMPLATE_FORMAT,
    name: str(raw.name, 80).trim() || 'Nieuwe bot',
    role: str(raw.role, 200),
    description: str(raw.description, 2000),
    instructions: str(raw.instructions, 60_000),
    avatar: templateAvatar(raw.avatar),
    color: /^#[0-9a-fA-F]{6}$/.test(str(raw.color, 7)) ? raw.color : '#6366f1',
    access_mode: ACCESS.has(raw.access_mode) ? raw.access_mode : 'ask',
    tool_groups: Array.isArray(raw.tool_groups) ? raw.tool_groups.map((g: any) => str(g, 40)).filter(Boolean).slice(0, 30) : [],
    reasoning: str(raw.reasoning, 20),
    busy_policy: raw.busy_policy === 'interrupt' || raw.busy_policy === 'steer' ? raw.busy_policy : 'queue',
    settings,
    model_hint: str(raw.model_hint ?? raw.model, 100),
    skills,
    routines: Array.isArray(raw.routines) ? raw.routines.slice(0, 50) : [],
    meta: raw.meta && typeof raw.meta === 'object' ? { ...raw.meta } : {},
  };
  return { template: t, warnings };
}

/** The skills of a template, each matched with the skill of that name the new bot's team already has (package B4). */
function planSkills(lib: SkillLibrary, userId: string, t: BotTemplate, placement: Placement = lib.placementFor(userId, '')) {
  return t.skills.map((ts, i) => {
    let files;
    try {
      files = filesToMap(ts.files);
    } catch (e: any) {
      return { index: i, name: ts.name, action: 'error' as const, error: e.message, files: null, analysis: null, existing: null as SkillRow | null };
    }
    const a = analyze(files, ts.name);
    const name = a.parsed.meta.name || ts.name;
    const existing = name ? lib.existingFor(userId, name, placement) : null;
    const checksumOk = !ts.checksum || ts.checksum === a.checksum;
    let action: 'create' | 'use-existing' | 'use-existing-different' | 'error' = 'create';
    if (a.errors.length) action = 'error';
    else if (existing) action = existing.checksum === a.checksum ? 'use-existing' : 'use-existing-different';
    return { index: i, name, action, error: a.errors[0] || (!checksumOk ? 'Checksum klopt niet met de inhoud.' : undefined), checksumOk, files, analysis: a, existing };
  });
}

/** The template's parts plus the bot's own browser — not for a bot that only chats or only reads. */
function withBrowser(ctx: Ctx, t: BotTemplate): string[] {
  const works = t.access_mode !== 'chat' && t.access_mode !== 'readonly';
  return works && ctx.tools.groups.has('browser') && !t.tool_groups.includes('browser') ? [...t.tool_groups, 'browser'] : t.tool_groups;
}

/**
 * The access level a bot from a template that ships with TeamBot starts with: "Volledige toegang" for the owner of
 * this installation (the same condition as the bot editor, api/agents.ts checkFullAccess), "Automatisch" for anyone
 * else. A template that only chats or only reads keeps that. Used by the preview and by the install, so both agree.
 */
export function ownStartAccess(ctx: Ctx, userId: string, mode: string): Agent['access_mode'] {
  if (mode === 'chat' || mode === 'readonly') return mode;
  return ctx.store.user(userId)?.role === 'owner' ? 'full' : 'auto';
}

/**
 * A new bot from TeamBot's own templates (team templates, the built-in bots, the main bot made with a team) starts at
 * "Volledige toegang", also for sending to others: it does its work without a question per step. Paying always asks
 * (tools/broker.ts), and its routines stay paused. Only for the installation owner, and logged as `agent.full_access`
 * like the switch in the bot editor. A template from someone else never comes here (previewTemplate caps it at "vragen").
 * Owner, 10 nov: "ik wil gewoon dat de bots alles kunnen doen zonder mij te vragen, alleen geld beslissingen en
 * belangrijke mails". Returns the changed bot, or null when nothing changed (read-only, chat, already there).
 */
export function startOwnBot(ctx: Ctx, userId: string, agentId: string, from: string): Agent | null {
  const cur = ctx.store.agent(agentId);
  if (!cur || cur.user_id !== userId || (cur.access_mode !== 'ask' && cur.access_mode !== 'auto')) return null;
  const mode = ownStartAccess(ctx, userId, cur.access_mode);
  if (mode === cur.access_mode) return null;
  // The same start as any new bot of the owner (agent/new-bot.ts): every part it can use, on top of the template's own.
  const next = ctx.store.updateAgent(agentId, mode === 'full' ? { access_mode: 'full', tool_groups: [...new Set([...(cur.tool_groups || []), ...defaultToolGroups(ctx)])], settings: { ...(cur.settings || {}), fullAccessExternal: true } } : { access_mode: mode }) || cur;
  if (mode === 'full') ctx.audit(userId, 'agent.full_access', { on: true, external: true, from }, agentId);
  ctx.events.emit(userId, 'agent.updated', next);
  return next;
}

export function previewTemplate(ctx: Ctx, lib: SkillLibrary, userId: string, t: BotTemplate, extraWarnings: string[] = [], placement?: Placement) {
  const warnings = [...extraWarnings];
  // Every bot from a template gets its own browser where this installation has one, also when the template does not
  // list it: the owner can watch along from the chat (the globe in the chat header).
  const groupIds = withBrowser(ctx, t);
  const groups = groupIds.map((id) => ({ id, label: ctx.tools.groups.get(id)?.label || id, description: ctx.tools.groups.get(id)?.description || '', known: ctx.tools.groups.has(id) }));
  for (const g of groups.filter((g) => !g.known)) warnings.push(`Toolgroep "${g.id}" bestaat niet in deze installatie en wordt overgeslagen.`);
  const access = t.access_mode === 'auto' || t.access_mode === 'full' ? 'ask' : t.access_mode;
  if (t.access_mode === 'auto' || t.access_mode === 'full') warnings.push(`Het sjabloon vraagt de modus "${t.access_mode === 'full' ? 'volledige toegang' : 'automatisch'}"; de bot start veilig in "vragen". Je kunt dat later zelf aanpassen.`);
  const plan = planSkills(lib, userId, t, placement);
  const domains = new Set<string>();
  for (const p of plan) for (const d of p.analysis?.scan.domains || []) domains.add(d);
  for (const p of plan) if (p.action === 'use-existing-different') warnings.push(`Je hebt al een skill "${p.name}" met andere inhoud; je eigen versie wordt gebruikt.`);
  for (const p of plan) if (p.action === 'error' || p.checksumOk === false) warnings.push(`Skill "${p.name}" wordt overgeslagen: ${p.error}`);
  const routinesSupported = typeof ctx.services.routines?.importForAgent === 'function';
  if (t.routines.length && !routinesSupported)
    warnings.push(t.routines.length === 1 ? 'Het sjabloon bevat 1 routine, maar de routinemodule is niet beschikbaar; die wordt niet geïnstalleerd.' : `Het sjabloon bevat ${t.routines.length} routines, maar de routinemodule is niet beschikbaar; die worden niet geïnstalleerd.`);
  return {
    bot: { name: t.name, role: t.role, description: t.description, instructions: t.instructions, avatar: t.avatar, color: t.color, access_mode: access, requested_access_mode: t.access_mode, tool_groups: groups, model_hint: t.model_hint },
    skills: plan.map((p) => ({
      name: p.name,
      action: p.checksumOk === false ? 'error' : p.action,
      error: p.error,
      existingId: p.existing?.id || null,
      description: p.analysis?.parsed.meta.description || '',
      version: p.analysis?.parsed.meta.version || '',
      license: p.analysis?.parsed.meta.license || '',
      checksum: p.analysis?.checksum || '',
      scan: p.analysis ? { level: p.analysis.scan.level, kind: p.analysis.scan.kind, labels: p.analysis.scan.labels, findings: p.analysis.scan.findings.slice(0, 20) } : null,
      permissions: p.analysis?.permissions || null,
    })),
    routines: { count: t.routines.length, supported: routinesSupported },
    externalCalls: [...domains].sort(),
    needsAcknowledge: plan.some((p) => p.action === 'create' && !!p.analysis && ownerLooksFirst(p.analysis.scan)),
    warnings,
  };
}

export async function installTemplate(
  ctx: Ctx,
  lib: SkillLibrary,
  userId: string,
  t: BotTemplate,
  o: {
    provider_id?: string | null;
    model?: string;
    name?: string;
    acknowledge?: boolean;
    source: { type: 'template' | 'catalog'; catalogId?: string; itemId?: string; verified?: boolean; label?: string; publisher?: string };
    /** Publisher snapshot of the bot package; skills created from it record "via bot". */
    packageInfo?: PackageInfo | null;
    /** The new bot's home team (package B4): its new skills are installed there. Default: the default team. */
    teamId?: string | null;
  },
) {
  const placement = lib.placementFor(userId, o.teamId || '');
  const preview = previewTemplate(ctx, lib, userId, t, [], placement);
  if (preview.needsAcknowledge && !o.acknowledge) throw new HttpError(409, 'Een of meer skills in dit sjabloon hebben ernstige waarschuwingen. Bekijk ze en bevestig.');
  let providerId = o.provider_id || null;
  let model = String(o.model || '');
  if (providerId) {
    if (!ctx.providers.canUse(userId, ctx.providers.config(providerId))) throw new HttpError(400, 'Onbekende provider');
  } else {
    providerId = ctx.store.getSetting<string | null>(userId, 'defaultProvider', null);
    if (providerId) model = model || ctx.store.getSetting(userId, 'defaultModel', '');
  }
  const created: SkillRow[] = [];
  const skillIds: string[] = [];
  try {
    for (const p of planSkills(lib, userId, t, placement)) {
      if (p.action === 'error' || p.checksumOk === false || !p.files || !p.analysis) continue;
      if (p.existing) {
        skillIds.push(p.existing.id);
        continue;
      }
      const ts = t.skills[p.index];
      const catalogRef = ts.catalog?.catalogId && ts.catalog.itemId ? `${ts.catalog.catalogId}/${ts.catalog.itemId}` : null;
      if (o.packageInfo && o.packageInfo.state !== 'unsigned') p.analysis.package = { ...infoSummary(o.packageInfo)!, via: 'bot', viaName: t.name };
      const s = lib.create(userId, p.files, p.analysis, {
        source: { type: o.source.type, label: o.source.label || t.name, catalogId: ts.catalog?.catalogId || o.source.catalogId, itemId: ts.catalog?.itemId, verified: !!o.source.verified && !!ts.catalog?.verified },
        createdBy: 'template',
        catalogRef,
        placement,
      });
      lib.installed(s);
      created.push(s);
      skillIds.push(s.id);
    }
    const groups = [...new Set([...withBrowser(ctx, t).filter((g) => ctx.tools.groups.has(g)), ...(skillIds.length ? ['skills'] : [])])].filter((g) => ctx.tools.groups.has(g));
    const agent = ctx.store.createAgent(userId, sanitizeNewAgentFor(ctx, userId, {
      name: str(o.name, 80).trim() || t.name,
      avatar: t.avatar,
      color: t.color,
      role: t.role,
      description: t.description,
      instructions: t.instructions,
      provider_id: providerId,
      model,
      reasoning: t.reasoning,
      access_mode: preview.bot.access_mode as Agent['access_mode'],
      tool_groups: groups,
      skills: skillIds,
      busy_policy: t.busy_policy,
      settings: { ...t.settings, ...(placement.scope === 'team' && placement.teamId && o.teamId ? { homeTeam: placement.teamId } : {}), template: { source: o.source.type, catalogId: o.source.catalogId, itemId: o.source.itemId, version: t.meta?.template_version || '' } },
    }));
    const notes: string[] = [...preview.warnings];
    if (t.routines.length && typeof ctx.services.routines?.importForAgent === 'function') {
      try {
        await ctx.services.routines.importForAgent(userId, agent.id, t.routines);
      } catch (e: any) {
        notes.push(`Routines niet geïnstalleerd: ${e?.message || e}`);
      }
    }
    ctx.audit(userId, 'agent.created', { name: agent.name, from: 'template' }, agent.id);
    ctx.audit(userId, 'template.installed', { name: t.name, source: o.source, skills: skillIds.length, routines: t.routines.length, signature: o.packageInfo?.state || 'unsigned', fingerprint: o.packageInfo?.publisher?.fingerprint }, agent.id);
    ctx.events.emit(userId, 'agent.updated', agent);
    if (created.length) ctx.events.emit(userId, 'skills.updated', { ids: created.map((s) => s.id) });
    return { agent, skillsCreated: created.map((s) => ({ id: s.id, name: s.name })), skillIds, warnings: notes };
  } catch (e) {
    // No partial install: remove skills we created in this attempt.
    for (const s of created) {
      try {
        lib.remove(s);
      } catch {
        /* ignore */
      }
    }
    throw e;
  }
}
