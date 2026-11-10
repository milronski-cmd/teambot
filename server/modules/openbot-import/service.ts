import fs from 'node:fs';
import { encodeFace, traitsFor } from '../../../shared/botface.js';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AccessMode, Agent, Ctx, ProviderConfig } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { bytesText } from '../../core/i18n.js';
import { filesFromDir, findSkillRoots, subset } from '../skills/files.js';
import { type ObAgent, type ObLive, type ObSkill, type ObSnapshot, type OpenBotPaths, folderSize, readOpenBot, readOpenBotLive, skillText } from './reader.js';
import { type EngineRef, adaptSkillText, colorFor, mapAccess, mapEngine, mapReasoning, mapSchedule, routineNotes, toolGroupsFor } from './mapping.js';
import { type BossPick, type Source, type SpecialistPick, isCustomerRoutine, pickBoss, pickSpecialists, proposeTeamName } from './roles.js';
import { type TeamLike, currentMain, mainBotBridge, specialistsBridge, teamDataBridge, teamsBridge } from './bridges.js';
import { type Ledger, emptyLedger, importedChannels, mergeLedger, undoImport, undoPlan } from './undo.js';
import { STANDARD } from '../teamdata/schema.js';

export type EngineStatus = 'ready' | 'connect' | 'reconnect' | 'missing' | 'unknown';
export type WorkspaceChoice = 'reference' | 'copy' | 'new';
export type TeamChoice = { mode: 'new'; name: string } | { mode: 'existing'; id: string };

export interface DetectResult {
  installed: boolean;
  loggedIn?: boolean;
  version?: string;
  detail?: string;
}
export type Detector = (kindId: string) => Promise<DetectResult | null>;

export interface EngineView {
  from: string;
  kind: string | null;
  label: string;
  status: EngineStatus;
  note: string;
  providerId: string | null;
  baseUrl?: string;
}

/** What the import proposes for the 0.4 team model (computed once per preview, the owner changes it in the page). */
interface Proposal {
  teamName: string;
  teamNameFromOpenBot: boolean;
  team: TeamChoice | null;
  boss: BossPick;
  /** OpenBot agent id proposed as main bot / team lead. */
  main: string | null;
  lead: string | null;
  rolesNote: string;
  specialists: SpecialistPick[];
}

interface Staging {
  id: string;
  userId: string;
  createdAt: number;
  snap: ObSnapshot;
  engines: Map<string, EngineView>;
  skillStagingId: string | null;
  /** Skill name → candidate key in the skills staging. */
  skillKeys: Map<string, string>;
  skillScan: Map<string, { level: string; action: string; errors: string[] }>;
  proposal: Proposal;
}

const TTL = 30 * 60_000;
const COPY_MAX_BYTES = 1024 ** 3;
const PAUSE_REASON = 'Overgenomen uit OpenBot en uitgezet, zodat niets dubbel draait. Zet aan wanneer je OpenBot stopt.';
const CUSTOMER_PAUSE_REASON = 'Overgenomen uit OpenBot en uitgezet, zodat niets dubbel draait. Deze routine leest of beantwoordt klantberichten: zet hem pas aan wanneer je OpenBot stopt en je een testrun hebt bekeken en goedgekeurd.';
const CUSTOMER_NOTE = 'Klantberichten: blijft uit tot jij een testrun hebt bekeken en goedgekeurd. Versturen naar klanten vraagt in TeamBot altijd eerst jouw toestemming.';

/** OpenBot chat platform → TeamBot channel adapter (null adapter = linked again at the switch moment). */
const CHANNEL_MAP: Record<string, { adapter: string | null; label: string; note: string }> = {
  telegram: { adapter: 'telegram', label: 'Telegram', note: '' },
  discord: { adapter: 'discord', label: 'Discord', note: '' },
  slack: { adapter: 'slack', label: 'Slack', note: '' },
  whatsapp: { adapter: null, label: 'WhatsApp', note: 'WhatsApp koppel je in TeamBot opnieuw met een nieuwe QR-scan, op het overstapmoment (Kanalen → Kanaal toevoegen). Zet het eerst uit in OpenBot.' },
};

const engineKey = (from: string) => from.toLowerCase();
const nameKey = (s: string) =>
  String(s || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** "1.234 bestanden, 1,5 GB" in the source notation (the page builds its own from files/bytes in the reader's). */
function sizeLabel(files: number, bytes: number, capped: boolean) {
  const count = files === 1 ? '1 bestand' : `${files.toLocaleString('nl-NL')} bestanden`;
  return `${capped ? 'meer dan ' : ''}${count}, ${capped ? '≥ ' : ''}${bytesText(bytes)}`;
}

function cleanSources(v: any, fallback: Source[]): Source[] {
  if (!Array.isArray(v)) return fallback;
  const out: Source[] = [];
  for (const x of v.slice(0, 40)) {
    const label = String(x?.label ?? x ?? '')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120);
    const url = typeof x?.url === 'string' && /^https?:\/\/[^\s]+$/i.test(x.url.trim()) ? x.url.trim().slice(0, 500) : undefined;
    if (label || url) out.push({ label: label || url!, ...(url ? { url } : {}) });
  }
  return out;
}

export class OpenBotImport {
  private stagings = new Map<string, Staging>();
  /** The last look at what runs in OpenBot, per user (switch-over status). */
  private live = new Map<string, ObLive & { checkedAt: string }>();
  constructor(private ctx: Ctx, private paths: () => OpenBotPaths, private detector: Detector) {}

  private sweep() {
    const t = Date.now();
    for (const [id, s] of this.stagings) if (t - s.createdAt > TTL) this.stagings.delete(id);
  }

  private tmpRoot() {
    return path.join(this.ctx.config.dataDir, 'tmp');
  }

  private state(userId: string): any {
    return this.ctx.store.getSetting<any>(userId, 'openbotImport', {}) || {};
  }
  private setState(userId: string, patch: any) {
    this.ctx.store.setSetting(userId, 'openbotImport', { ...this.state(userId), ...patch });
  }
  /** Everything earlier imports made (for "ongedaan maken"). */
  ledger(userId: string): Ledger {
    return { ...emptyLedger(), ...(this.state(userId).ledger || {}) };
  }

  /** Bots already imported from this OpenBot agent id. */
  private importedAgents(userId: string): Map<string, Agent> {
    const out = new Map<string, Agent>();
    for (const a of this.ctx.store.agents(userId, { archived: true })) {
      const f = a.settings?.importedFrom;
      if (f?.app === 'openbot' && typeof f.id === 'string') out.set(f.id, a);
    }
    return out;
  }

  private ownProvider(userId: string, kind: string): ProviderConfig | null {
    return this.ctx.providers.list(userId).find((p) => p.kind === kind && p.enabled && this.ctx.providers.canUse(userId, p)) || null;
  }

  /** How a TeamBot engine for an OpenBot provider can be made available (never copies keys). */
  private async engineView(userId: string, ref: EngineRef): Promise<EngineView> {
    const base = { from: ref.from, kind: ref.kind, label: ref.label, providerId: null as string | null, baseUrl: ref.baseUrl };
    if (!ref.kind) return { ...base, status: 'unknown', note: `TeamBot kent "${ref.from}" niet; kies zelf een engine voor deze bot.` };
    const existing = this.ownProvider(userId, ref.kind);
    if (existing) return { ...base, status: 'ready', note: `Gekoppeld (${existing.name}).`, providerId: existing.id };
    const k = this.ctx.providers.kind(ref.kind);
    if (!k) return { ...base, status: 'unknown', note: `${ref.label} is in deze TeamBot niet beschikbaar.` };
    if (k.needsKey && !k.keyOptional) return { ...base, status: 'reconnect', note: `Opnieuw verbinden: vul je ${ref.label}-sleutel in bij AI-diensten. Sleutels worden niet uit OpenBot gekopieerd.` };
    let d: DetectResult | null = null;
    try {
      d = await this.detector(ref.kind);
    } catch {
      d = null;
    }
    if (d?.installed && (k.type !== 'cli' || d.loggedIn !== false)) return { ...base, status: 'connect', note: `Gevonden op deze computer${d.version ? ` (${d.version})` : ''}; wordt gekoppeld.` };
    if (d?.installed && d.loggedIn === false) return { ...base, status: 'reconnect', note: `${ref.label} is geïnstalleerd maar niet ingelogd. Log in en koppel hem daarna bij AI-diensten.` };
    if (k.type === 'cli') return { ...base, status: 'missing', note: `${ref.label} is niet gevonden. Installeer en log in, en koppel hem daarna bij AI-diensten.` };
    return { ...base, status: 'missing', note: `${ref.label} reageert nu niet (staat hij aan?). Koppel hem later bij AI-diensten.` };
  }

  /**
   * The chat channels of OpenBot and what happens to each: Telegram, Discord and Slack come over switched off and
   * without a token (bot and allowlist kept); WhatsApp and unknown platforms are linked again at the switch moment.
   */
  private channelPlan(userId: string, snap: ObSnapshot, imported: Map<string, Agent>) {
    const nameOf = new Map(snap.agents.map((a) => [a.id, a.name]));
    const existing = new Set<string>();
    const chSvc = this.ctx.services.channels;
    if (typeof chSvc?.bindings === 'function') for (const b of chSvc.bindings(userId) as any[]) if (b?.config?.importedFrom?.app === 'openbot' && b.config.importedFrom.id) existing.add(String(b.config.importedFrom.id));
    const available = typeof chSvc?.importPaused === 'function';
    return snap.channels.map((c) => {
      const m = CHANNEL_MAP[c.platform] || null;
      const label = `${m?.label || c.platform || 'Kanaal'}${c.name ? ` · ${c.name}` : ''}`;
      const bot = c.agentId ? nameOf.get(c.agentId) || '' : '';
      const adapter = m?.adapter && available ? m.adapter : null;
      const note = !m
        ? `TeamBot kent ${c.platform || 'dit kanaal'} niet; kies bij Kanalen een ander kanaal.`
        : !m.adapter
          ? m.note
          : !available
            ? 'Kanalen staan in deze TeamBot niet aan.'
            : !c.agentId
              ? 'Geen bot gekoppeld in OpenBot; kies er een bij Kanalen.'
              : `Komt binnen op pauze, zonder token${c.senders.length ? ` en met ${c.senders.length === 1 ? '1 toegestane afzender' : `${c.senders.length} toegestane afzenders`}` : ''}. Zet het pas aan op het overstapmoment: eerst uit in OpenBot, dan de token invullen in TeamBot.`;
      return {
        key: c.id,
        platform: c.platform,
        name: c.name,
        label,
        botKey: c.agentId,
        bot,
        enabledInOpenBot: c.enabled,
        senders: c.senders.length,
        senderList: c.senders.map((s) => ({ id: s.id, label: s.name || s.kind || '' })),
        adapter,
        /** Always switched off in TeamBot. */
        off: true as const,
        existing: existing.has(c.id),
        /** On by default when its bot comes along (or came with an earlier import). */
        selected: !!adapter && !!c.agentId && !existing.has(c.id) && (snap.agents.some((a) => a.id === c.agentId) || imported.has(c.agentId)),
        note,
      };
    });
  }

  // ======================================================================
  // preview (dry run: reads, writes nothing in TeamBot or OpenBot)
  // ======================================================================

  async preview(userId: string) {
    this.sweep();
    const p = this.paths();
    let snap: ObSnapshot;
    try {
      snap = readOpenBot(p, this.tmpRoot());
    } catch (e: any) {
      throw new HttpError(400, e?.message || String(e));
    }
    const engines = new Map<string, EngineView>();
    const refs = new Map<string, EngineRef>();
    for (const a of snap.agents) for (const prov of [a.provider, ...a.backups.map((b) => b.provider)]) if (prov && !refs.has(engineKey(prov))) refs.set(engineKey(prov), mapEngine(prov, snap.customProviders));
    await Promise.all([...refs].map(async ([key, ref]) => engines.set(key, await this.engineView(userId, ref))));

    const st: Staging = { id: 'obi_' + crypto.randomBytes(12).toString('hex'), userId, createdAt: Date.now(), snap, engines, skillStagingId: null, skillKeys: new Map(), skillScan: new Map(), proposal: this.propose(userId, snap) };
    this.stageSkills(userId, st);
    for (const [id, s] of this.stagings) if (s.userId === userId) this.stagings.delete(id);
    this.stagings.set(st.id, st);
    return this.view(st);
  }

  /** The team, main bot, team lead and specialists this import proposes (the owner can change all of it). */
  private propose(userId: string, snap: ObSnapshot): Proposal {
    const teams = teamsBridge(this.ctx);
    const imported = this.importedAgents(userId);
    const owned = teams ? teams.list(userId) : [];
    const { name: teamName, fromOpenBot } = proposeTeamName(snap.workspaceName, owned.map((t) => t.name));
    let team: TeamChoice | null = null;
    if (teams) {
      // Importing again: into the team of the earlier import. One empty team (e.g. made with a team folder): use that.
      const earlier = this.ledger(userId).teams.map((t) => t.id).find((id) => teams.team(id)?.user_id === userId);
      const ofBots = [...imported.values()].map((a) => teams.teamOf(a.id)).find((id): id is string => !!id && teams.team(id)?.user_id === userId);
      const empty = owned.length === 1 && teams.botsOf(owned[0].id).length === 0 ? owned[0].id : null;
      const id = earlier || ofBots || empty;
      team = id ? { mode: 'existing', id } : { mode: 'new', name: teamName };
    }
    const boss = pickBoss(snap.agents);
    const bossIsNew = !!boss.key && !imported.has(boss.key);
    const name = boss.key ? snap.agents.find((a) => a.id === boss.key)!.name : '';
    const mainBridge = mainBotBridge(this.ctx);
    const existingMain = currentMain(this.ctx, userId);
    let main: string | null = null;
    let lead: string | null = null;
    let rolesNote = '';
    if (bossIsNew) {
      if (mainBridge && !existingMain) {
        main = boss.key;
        rolesNote = `${name} wordt je hoofdbot: hij staat boven de teams en kan elk team werk geven. Het team krijgt daarom geen aparte teamleider; kies er zelf een als je wilt.`;
      } else if (existingMain) {
        lead = boss.key;
        rolesNote = `Je hebt al een hoofdbot (${existingMain.name}) en er kan er maar één zijn. ${name} wordt teamleider van het team.`;
      } else {
        lead = teams ? boss.key : null;
        rolesNote = teams ? `De hoofdbot staat in deze TeamBot niet aan. ${name} wordt teamleider van het team.` : `${name} komt als gewone bot: teams en rollen staan in deze TeamBot niet aan.`;
      }
    } else if (boss.key) rolesNote = `${name} was al overgenomen; zijn rol blijft zoals hij is.`;
    const specialists = pickSpecialists(snap.agents, snap.routines, snap.skills, skillText, boss.key).filter((s) => !imported.has(s.key));
    return { teamName, teamNameFromOpenBot: fromOpenBot, team, boss, main, lead, rolesNote, specialists };
  }

  /** Stage importable skills through the regular skills importer (scan, checksum, publisher policy). */
  private stageSkills(userId: string, st: Staging) {
    const importer = this.ctx.services.skills?.importer;
    if (!importer) return;
    const items: any[] = [];
    const names: string[] = [];
    for (const sk of st.snap.skills) {
      if (sk.klass === 'openbot') continue;
      try {
        const files = filesFromDir(sk.dir);
        // The imported copy speaks TeamBot: OpenBot's data tools become the team database tools.
        for (const [rel, buf] of files) {
          if (!rel.toLowerCase().endsWith('.md')) continue;
          const text = buf.toString('utf8');
          const adapted = adaptSkillText(text);
          if (adapted !== text) files.set(rel, Buffer.from(adapted, 'utf8'));
        }
        const roots = findSkillRoots(files);
        items.push({ files: subset(files, '', roots), root: sk.name, source: { type: 'discover', label: `OpenBot: ${sk.name}`, path: sk.dir }, fallbackName: sk.name });
        names.push(sk.name);
      } catch (e: any) {
        st.skillScan.set(sk.name, { level: 'error', action: 'error', errors: [e?.message || String(e)] });
      }
    }
    if (!items.length) return;
    const staging = importer.stage(userId, 'OpenBot', items);
    st.skillStagingId = staging.id;
    const view = importer.view(userId, staging);
    view.candidates.forEach((c: any, i: number) => {
      st.skillKeys.set(names[i], c.key);
      st.skillScan.set(names[i], { level: c.scan?.level || 'ok', action: c.action, errors: c.errors || [] });
    });
  }

  private get(userId: string, id: string): Staging {
    this.sweep();
    const s = this.stagings.get(String(id));
    if (!s || s.userId !== userId) throw new HttpError(404, 'Deze voorvertoning is verlopen. Lees OpenBot opnieuw in.');
    return s;
  }

  private botView(st: Staging, a: ObAgent, imported: Map<string, Agent>) {
    const snap = st.snap;
    const eng = st.engines.get(engineKey(a.provider))!;
    const access = mapAccess(a.access);
    const size = a.workspaceExists ? folderSize(a.workspacePath) : { files: 0, bytes: 0, capped: false };
    const canCopy = a.workspaceExists && !size.capped && size.bytes <= COPY_MAX_BYTES;
    const skills = snap.skills.filter((s) => s.usedBy.includes(a.id));
    const mems = snap.memories.filter((m) => m.agentId === a.id);
    const notes: string[] = [];
    if (access.note) notes.push(access.note);
    if (a.computerUse) {
      notes.push('Computer Use → "Mijn bureaublad": alleen apps op de toegestane lijst, en elke klik of toetsaanslag vraagt toestemming.');
      // Not only "every click asks": the levels "one approval per task" and "Volledige toegang" exist (screen-policy.ts).
      notes.push('Standaard krijg je elke klik of toetsaanslag eerst te zien met een schermvoorbeeld. Daarna kun je een ander toegangsniveau kiezen (één keer per taak, of volledige toegang).');
    }
    if (!a.instructions.trim()) notes.push('Geen instructies gevonden (geen AGENTS.md in de werkmap).');
    if (a.workspaceExists && (eng.kind === 'codex-cli' || eng.kind === 'opencode') && a.instructionsSource === 'AGENTS.md') notes.push(`${eng.label} leest AGENTS.md in de werkmap ook zelf; de instructies staan nu ook in TeamBot.`);
    const unmappedBackups = a.backups.filter((b) => !st.engines.get(engineKey(b.provider))?.kind);
    if (unmappedBackups.length) notes.push(unmappedBackups.length === 1 ? `Reserve-engine zonder TeamBot-equivalent: ${unmappedBackups[0].provider}.` : `Reserve-engines zonder TeamBot-equivalent: ${unmappedBackups.map((b) => b.provider).join(', ')}.`);
    // The whole ordered list becomes settings.fallbacks (agent/fallback.ts: up to 5, CLI engines included).
    if (a.backups.length > 1) notes.push('De reserve-engines komen mee in dezelfde volgorde; bij een limiet of storing schakelt TeamBot vanzelf door, ook bij Claude Code en Codex.');
    const existing = imported.get(a.id);
    return {
      key: a.id,
      name: a.name,
      description: a.description,
      engine: eng,
      model: a.model,
      reasoning: mapReasoning(a.reasoning) || a.reasoning,
      backups: a.backups.map((b) => {
        const e = st.engines.get(engineKey(b.provider))!;
        return { from: b.provider, label: e.label, kind: e.kind, model: b.model, status: e.status };
      }),
      access: { from: a.access, to: access.mode, note: access.note },
      computerUse: a.computerUse,
      toolGroups: toolGroupsFor(a),
      color: colorFor(a.avatarSeed || a.id, a.avatarHue),
      /** The face the bot gets in TeamBot (stable: from OpenBot's own avatar seed). */
      face: encodeFace(traitsFor(a.avatarSeed || a.id)),
      workspace: {
        path: a.workspacePath,
        exists: a.workspaceExists,
        files: size.files,
        bytes: size.bytes,
        sizeLabel: a.workspaceExists ? sizeLabel(size.files, size.bytes, size.capped) : 'map niet gevonden',
        capped: size.capped,
        canCopy,
        default: (a.workspaceExists ? 'reference' : 'new') as WorkspaceChoice,
      },
      instructions: { chars: a.instructions.length, source: a.instructionsSource },
      skills: skills.filter((s) => s.klass !== 'openbot').map((s) => s.name),
      skippedSkills: skills.filter((s) => s.klass === 'openbot').map((s) => s.name),
      routines: snap.routines.filter((r) => r.agentId === a.id).length,
      memories: mems.length,
      essential: mems.filter((m) => m.inclusion === 'essential').length,
      pinned: a.pinned,
      existing: existing ? { id: existing.id, name: existing.name } : null,
      selected: !existing,
      notes,
    };
  }

  view(st: Staging) {
    const { snap, proposal } = st;
    const userId = st.userId;
    const imported = this.importedAgents(userId);
    const bots = snap.agents.map((a) => this.botView(st, a, imported));
    const nameOf = new Map(snap.agents.map((a) => [a.id, a.name]));
    const engine = this.ctx.services.routines?.engine;
    const existingRoutines = new Set<string>();
    if (engine) for (const r of engine.routinesOf(userId)) existingRoutines.add(`${r.agent_id}|${r.name}`);
    const routines = snap.routines.map((r) => {
      const m = mapSchedule(r.schedule);
      const tbAgent = imported.get(r.agentId);
      const existing = !!tbAgent && existingRoutines.has(`${tbAgent.id}|${r.name}`);
      const customer = isCustomerRoutine(r, nameOf.get(r.agentId) || '');
      return {
        key: r.id,
        botKey: r.agentId,
        botName: nameOf.get(r.agentId) || 'onbekende bot',
        name: r.name,
        schedule: 'error' in m ? m.error : m.label,
        ok: !('error' in m) && nameOf.has(r.agentId),
        wasActive: r.active,
        timezone: r.timezone,
        promptPreview: r.instruction.slice(0, 280),
        /** Always switched off in TeamBot; the owner switches it on. */
        off: true as const,
        /** Reads or answers customers: stays off until a test run is approved. */
        customer,
        notes: [...routineNotes(r), ...(customer ? [CUSTOMER_NOTE] : [])],
        existing,
        selected: !('error' in m) && nameOf.has(r.agentId) && !existing,
      };
    });
    const channels = this.channelPlan(userId, snap, imported);
    const skills = snap.skills.map((s: ObSkill) => {
      const scan = st.skillScan.get(s.name);
      const importable = s.klass !== 'openbot' && !!st.skillKeys.get(s.name);
      return {
        key: s.name,
        name: s.name,
        description: s.description,
        klass: s.klass,
        license: s.license,
        reason: s.reason || (scan?.errors?.[0] ?? ''),
        scope: s.scope,
        usedBy: s.usedBy.map((id) => nameOf.get(id) || id),
        variants: s.variants,
        scan: scan?.level || null,
        action: scan?.action || null,
        importable,
        selected: importable && (s.klass === 'own' || s.klass === 'permissive') && scan?.action !== 'unchanged',
      };
    });

    // Team (0.4): one team for the imported bots, with the shared folder and the team tables.
    const teams = teamsBridge(this.ctx);
    const tdb = teamDataBridge(this.ctx);
    const owned = teams ? teams.list(userId) : [];
    const chosen = proposal.team?.mode === 'existing' ? teams?.team(proposal.team.id) || null : null;
    const legacyFolder = this.ctx.services.folders?.team(userId) || null;
    const folderOf = (t: TeamLike | null) => (t && teams ? teams.teamFolder(t.id) : !teams ? legacyFolder : null);
    const team = {
      available: !!teams,
      name: proposal.teamName,
      nameFromOpenBot: proposal.teamNameFromOpenBot,
      workspaceName: snap.workspaceName,
      choice: proposal.team,
      existing: owned.map((t) => ({ id: t.id, name: t.name, bots: teams!.botsOf(t.id).length, folder: teams!.teamFolder(t.id)?.path || null, lead: t.lead_agent_id ? this.ctx.store.agent(t.lead_agent_id)?.name || null : null, earlier: this.ledger(userId).teams.some((x) => x.id === t.id) })),
      /** False until the team database keeps data per team (package B2): then the tables go into this team. */
      tablesPerTeam: !!tdb?.perTeam,
    };

    // Roles: main bot (hoofdbot) or team lead, and specialists.
    const mainBridge = mainBotBridge(this.ctx);
    const existingMain = currentMain(this.ctx, userId);
    const spec = specialistsBridge(this.ctx);
    const roles = {
      mainAvailable: !!mainBridge,
      currentMain: existingMain ? { id: existingMain.id, name: existingMain.name } : null,
      leadAvailable: !!teams,
      boss: proposal.boss.key ? { key: proposal.boss.key, name: nameOf.get(proposal.boss.key) || '', reason: proposal.boss.reason } : null,
      bossReason: proposal.boss.reason,
      main: proposal.main,
      lead: proposal.lead,
      note: proposal.rolesNote,
      specialistsAvailable: !!spec,
      specialistsNote: spec ? '' : 'Specialisten staan in deze TeamBot niet aan. Deze bot komt als gewone bot; zijn vakgebied en bronnen worden bij de bot bewaard en zijn leerrondes komen uit te staan.',
      /** Proposed specialists. Without the specialists part they come as normal bots, with field and sources kept. */
      specialists: proposal.specialists.map((s) => ({ key: s.key, name: nameOf.get(s.key) || '', field: s.field, sources: s.sources, rounds: s.rounds, reason: s.reason, selected: true })),
    };

    const attention: { level: 'warn' | 'info'; text: string }[] = [];
    for (const e of st.engines.values()) if (e.status === 'reconnect' || e.status === 'missing' || e.status === 'unknown') attention.push({ level: 'warn', text: `${e.label}: ${e.note}` });
    const waiting = snap.routines.filter((r) => r.limitPolicy === 'wait').length;
    if (waiting) attention.push({ level: 'info', text: waiting === 1 ? '1 routine wacht in OpenBot op de reset als hij een gebruikslimiet raakt. In TeamBot doet hij dat ook: een run die een limiet raakt, wacht op de reset (max. 12 uur) en gaat dan verder.' : `${waiting} routines wachten in OpenBot op de reset als ze een gebruikslimiet raken. In TeamBot doen ze dat ook: een run die een limiet raakt, wacht op de reset (max. 12 uur) en gaat dan verder.` });
    const td = snap.teamData;
    const done: Record<string, number> = tdb ? tdb.importedCounts(userId, chosen?.id ?? null) : {};
    for (const w of snap.warnings) attention.push({ level: 'warn', text: w });

    // What does not come over (said before anything is written).
    const notImported: { what: string; why: string }[] = [
      { what: 'Gesprekken en bijlagen', why: 'Bewuste keuze: je begint in TeamBot met schone gesprekken. Ze blijven in OpenBot staan; je bestanden blijven in hun mappen.' },
      { what: 'Sleutels, tokens en wachtwoorden', why: 'Nooit: koppelingen die een sleutel nodig hebben, verbind je in TeamBot opnieuw.' },
    ];
    const relink = channels.filter((c) => !c.adapter);
    if (relink.length) notImported.push({ what: `Kanalen: ${relink.map((c) => c.label).join(', ')}`, why: relink.some((c) => c.platform === 'whatsapp') ? 'WhatsApp koppel je in TeamBot opnieuw met een nieuwe QR-scan, op het moment dat je overstapt (Kanalen → Kanaal toevoegen).' : 'Opnieuw verbinden bij Kanalen (tokens worden niet gekopieerd).' });
    if (snap.mcpServers.length) notImported.push({ what: `Apps (MCP): ${snap.mcpServers.map((m) => m.name).join(', ')}`, why: 'Opnieuw toevoegen bij Apps (hun sleutels worden niet gekopieerd).' });
    const skipped = snap.skills.filter((s) => s.klass === 'openbot');
    if (skipped.length) notImported.push({ what: skipped.length === 1 ? '1 skill van OpenBot zelf' : `${skipped.length} skills van OpenBot zelf`, why: 'Beheerd door OpenBot of onder de OpenBot-licentie. Je eigen skills komen wel mee; zoek voor de rest een alternatief in de TeamBot-marktplaats.' });
    if (snap.workflows) notImported.push({ what: 'Workflows', why: snap.workflows === 1 ? '1 workflow wordt niet overgenomen; TeamBot heeft (nog) geen workflow-canvas.' : `${snap.workflows} workflows worden niet overgenomen; TeamBot heeft (nog) geen workflow-canvas.` });
    notImported.push({ what: 'De takenlijst en browserprofielen van OpenBot', why: 'De gedeelde teamtabellen (taken, beslissingen …) komen wel mee als je ze aanvinkt.' });
    if (snap.phonePaired) notImported.push({ what: 'Je telefoonkoppeling', why: 'Koppel je telefoon opnieuw via Instellingen → Telefoon.' });
    // Own providers (e.g. LM Studio) that no bot uses: nothing to link for the bots; the owner adds one when he wants it.
    const usedProviders = new Set(snap.agents.flatMap((a) => [a.provider, ...a.backups.map((b) => b.provider)]).map(engineKey));
    const unused = snap.customProviders.filter((p) => !usedProviders.has(engineKey(p.id)) && !usedProviders.has(engineKey(p.name)));
    if (unused.length) notImported.push({ what: `Eigen AI-dienst: ${unused.map((p) => p.name || p.id).join(', ')}`, why: 'Geen bot gebruikt hem. Koppel hem zo nodig zelf bij AI-diensten (er is geen sleutel nodig voor een lokale dienst).' });
    notImported.push({ what: 'Instellingen van de OpenBot-app zelf', why: 'Venster, logokleur, op de achtergrond doordraaien en wakker blijven stel je in TeamBot zelf in (Instellingen › Algemeen; wakker blijven bij Routines).' });

    return {
      stagingId: st.id,
      expiresAt: new Date(st.createdAt + TTL).toISOString(),
      source: { dataDir: snap.paths.dataDir, home: snap.paths.home, readAt: snap.readAt },
      team,
      roles,
      bots,
      routines,
      /** Chat connections: they come over switched off and without a token; the owner moves each one at its own moment. */
      channels,
      skills,
      memories: { total: snap.memories.length, essential: snap.memories.filter((m) => m.inclusion === 'essential').length },
      shared: { path: snap.shared.path, exists: snap.shared.exists, entries: snap.shared.entries, current: folderOf(chosen), selected: snap.shared.exists && (!folderOf(chosen) || norm(folderOf(chosen)!.path) === norm(snap.shared.path)) },
      engines: [...st.engines.values()],
      teamData: td
        ? {
            path: td.path,
            available: !!tdb,
            perTeam: !!tdb?.perTeam,
            tables: td.tables.map((t) => ({ name: t.name, rows: t.total, standard: STANDARD.has(t.name), owner: t.ownerAgentId ? nameOf.get(t.ownerAgentId) || null : null, imported: done[t.name] || 0 })),
            selected: !!tdb && td.tables.some((t) => t.total > (done[t.name] || 0)),
          }
        : null,
      notImported,
      undo: this.undoAvailable(userId),
      attention,
    };
  }

  // ======================================================================
  // commit
  // ======================================================================

  /** The team the import lands in, checked before anything is written (a wrong name is a 400 that changes nothing). */
  private resolveTeam(userId: string, st: Staging, body: any, needed: boolean): { team: TeamLike | null; create: string | null } {
    const teams = teamsBridge(this.ctx);
    if (!teams || !needed) return { team: null, create: null };
    const raw = body?.team && typeof body.team === 'object' ? body.team : st.proposal.team;
    if (raw?.mode === 'existing') {
      const t = teams.team(String(raw.id || ''));
      if (!t || t.user_id !== userId) throw new HttpError(400, 'Dit team bestaat niet meer. Lees OpenBot opnieuw in.');
      return { team: t, create: null };
    }
    const name = String(raw?.name ?? st.proposal.teamName)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 60);
    if (!name) throw new HttpError(400, 'Geef het team een naam.');
    const same = teams.list(userId).find((t) => nameKey(t.name) === nameKey(name));
    if (same) throw new HttpError(400, `Er is al een team “${same.name}”. Kies een andere naam, of kies bij “In welk team” dat team.`);
    return { team: null, create: name };
  }

  async commit(userId: string, body: any) {
    const st = this.get(userId, String(body?.stagingId || ''));
    const snap = st.snap;
    const bodyBots = body?.bots && typeof body.bots === 'object' ? body.bots : {};
    const routineKeys = new Set<string>(Array.isArray(body?.routines) ? body.routines.map(String) : []);
    const skillNames = new Set<string>(Array.isArray(body?.skills) ? body.skills.map(String) : []);
    const memMode: 'active' | 'review' | 'off' = body?.memories === false || body?.memories === 'off' ? 'off' : body?.memories === 'review' ? 'review' : 'active';
    const withShared = !!body?.shared;
    const withTeamData = !!body?.teamData;
    const imported = this.importedAgents(userId);
    const selectedBots = snap.agents.filter((a) => bodyBots[a.id]?.selected && !imported.has(a.id));
    const teams = teamsBridge(this.ctx);
    const target = this.resolveTeam(userId, st, body, selectedBots.length > 0 || withShared || withTeamData);
    const ledger = emptyLedger();
    const result = {
      team: null as null | { id: string; name: string; created: boolean },
      roles: { main: null as null | { name: string; status: 'set' | 'lead' | 'skipped'; note: string }, lead: null as null | { name: string; status: 'set' | 'skipped'; note: string }, specialists: [] as { name: string; status: 'specialist' | 'bot'; field: string; sources: number; note: string }[] },
      bots: [] as { key: string; name: string; status: 'created' | 'skipped' | 'error'; agentId?: string; workspace?: string; notes: string[]; error?: string }[],
      routines: [] as { key: string; name: string; bot: string; status: 'created' | 'skipped' | 'error'; routineId?: string; error?: string; customer?: boolean; wasActive?: boolean }[],
      channels: [] as { key: string; label: string; bot: string; status: 'created' | 'skipped' | 'relink' | 'error'; bindingId?: string; note: string }[],
      skills: [] as { name: string; status: string; error?: string }[],
      providers: [] as { label: string; status: string; note: string }[],
      memories: { imported: 0, proposed: 0, duplicates: 0, skipped: 0, failed: 0, reasons: {} as Record<string, number> },
      shared: null as null | { path: string; status: string; note?: string },
      teamData: null as null | { name: string; created: boolean; inserted: number; skipped: number; renumbered: number; error?: string }[],
      attention: [] as { level: 'warn' | 'info'; text: string }[],
    };

    // 1. Engines: link what is on this computer (no secrets involved); everything else is "opnieuw verbinden".
    const providerFor = new Map<string, string | null>();
    const needed = new Set<string>();
    for (const a of selectedBots) for (const prov of [a.provider, ...a.backups.map((b) => b.provider)]) needed.add(engineKey(prov));
    for (const key of needed) {
      const e = st.engines.get(key);
      if (!e?.kind) {
        providerFor.set(key, null);
        continue;
      }
      const existing = this.ownProvider(userId, e.kind);
      if (existing) {
        providerFor.set(key, existing.id);
        continue;
      }
      if (e.status === 'connect') {
        try {
          const cfg = this.ctx.providers.create(userId, { kind: e.kind, ...(e.baseUrl && e.kind !== 'lmstudio' && e.kind !== 'ollama' ? { base_url: e.baseUrl } : {}) });
          if (!this.ctx.store.getSetting(userId, 'defaultProvider', null)) this.ctx.store.setSetting(userId, 'defaultProvider', cfg.id);
          this.ctx.events.emit(userId, 'provider.updated', this.ctx.providers.view(cfg, userId));
          providerFor.set(key, cfg.id);
          ledger.providers.push(cfg.id);
          result.providers.push({ label: e.label, status: 'linked', note: 'Gekoppeld (gebruikt de login op deze computer).' });
          continue;
        } catch (err: any) {
          result.providers.push({ label: e.label, status: 'error', note: err?.message || String(err) });
        }
      } else {
        result.providers.push({ label: e.label, status: e.status, note: e.note });
        result.attention.push({ level: 'warn', text: `${e.label}: ${e.note}` });
      }
      providerFor.set(key, null);
    }

    // 2. Skills (through the regular skills importer: scan, policy, versions).
    const skillIdByName = new Map<string, string>();
    const lib = this.ctx.services.skills?.library;
    const wantSkills = [...skillNames].filter((n) => st.skillKeys.has(n) && snap.skills.find((s) => s.name === n)?.klass !== 'openbot');
    if (wantSkills.length && st.skillStagingId && this.ctx.services.skills?.importer) {
      try {
        const r = this.ctx.services.skills.importer.commit(userId, st.skillStagingId, { keys: wantSkills.map((n) => st.skillKeys.get(n)!), acknowledge: !!body?.acknowledgeSkills, createdBy: 'openbot-import' });
        const byKey = new Map(wantSkills.map((n) => [st.skillKeys.get(n)!, n]));
        for (const x of r.results) {
          const name = byKey.get(x.key) || x.name;
          result.skills.push({ name, status: x.status, error: x.error });
          if (x.skillId && ['created', 'updated', 'version-added', 'unchanged'].includes(x.status)) skillIdByName.set(name, x.skillId);
          if (x.skillId && x.status === 'created') ledger.skills.push(x.skillId);
          if (x.error) result.attention.push({ level: 'warn', text: `Skill ${name}: ${x.error}` });
        }
      } catch (e: any) {
        result.attention.push({ level: 'warn', text: `Skills: ${e?.message || String(e)}` });
      }
    }
    // Skills that already exist in TeamBot (same name) are linked too.
    if (lib) for (const sk of snap.skills) if (!skillIdByName.has(sk.name) && sk.klass !== 'openbot') {
      const ex = lib.getByName(userId, sk.name);
      if (ex && ex.status === 'active' && skillNames.has(sk.name)) skillIdByName.set(sk.name, ex.id);
    }

    // 3. The team: a new one (name from the preview), or the one the owner picked.
    let team: TeamLike | null = target.team;
    if (teams && target.create) {
      team = teams.create(userId, { name: target.create });
      ledger.teams.push({ id: team.id, created: true, folderSet: false, folderBefore: null, leadSet: null });
    } else if (team) ledger.teams.push({ id: team.id, created: false, folderSet: false, folderBefore: null, leadSet: null });
    if (team) result.team = { id: team.id, name: team.name, created: !!target.create };
    const teamEntry = team ? ledger.teams[ledger.teams.length - 1] : null;

    // Roles chosen in the preview (an OpenBot agent id each); a role for a bot that is not imported now is dropped.
    const pickKey = (v: any, fallback: string | null) => (v === undefined ? fallback : typeof v === 'string' && v ? v : null);
    let mainKey = pickKey(body?.mainBot, st.proposal.main);
    let leadKey = pickKey(body?.lead, st.proposal.lead);
    const specChoice: Record<string, any> = body?.specialists && typeof body.specialists === 'object' ? body.specialists : {};
    const specs = new Map<string, { field: string; sources: Source[]; selected: boolean }>();
    for (const sp of st.proposal.specialists) {
      const c = specChoice[sp.key];
      specs.set(sp.key, { field: typeof c?.field === 'string' && c.field.trim() ? c.field.trim().slice(0, 300) : sp.field, sources: cleanSources(c?.sources, sp.sources), selected: c ? c.selected !== false : true });
    }
    const spBridge = specialistsBridge(this.ctx);

    // 4. Bots, in the import's team.
    const agentIdByOb = new Map<string, string>();
    for (const [obId, a] of imported) agentIdByOb.set(obId, a.id);
    const createdNow = new Set<string>();
    for (const a of selectedBots) {
      const choice: WorkspaceChoice = ['reference', 'copy', 'new'].includes(bodyBots[a.id]?.workspace) ? bodyBots[a.id].workspace : a.workspaceExists ? 'reference' : 'new';
      const notes: string[] = [];
      try {
        const main = st.engines.get(engineKey(a.provider))!;
        const providerId = providerFor.get(engineKey(a.provider)) ?? null;
        if (!providerId) notes.push(`Kies een engine: ${main.label} is nog niet gekoppeld.`);
        const backups = a.backups.map((b) => ({ from: b.provider, kind: st.engines.get(engineKey(b.provider))?.kind ?? null, model: b.model, provider_id: providerFor.get(engineKey(b.provider)) ?? null }));
        const firstUsable = backups.find((b) => b.provider_id && b.provider_id !== null);
        const access = mapAccess(a.access);
        const id = 'ag_' + crypto.randomBytes(9).toString('hex');
        let workspace: string | undefined;
        if (choice === 'reference' && a.workspaceExists) workspace = a.workspacePath;
        else if (choice === 'copy' && a.workspaceExists) {
          const size = folderSize(a.workspacePath);
          if (size.capped || size.bytes > COPY_MAX_BYTES) throw new Error('De werkmap is te groot om te kopiëren; kies "bestaande map gebruiken".');
          workspace = this.ctx.store.defaultWorkspace(id);
          await fs.promises.cp(a.workspacePath, workspace, { recursive: true, errorOnExist: false, force: false, verbatimSymlinks: true });
          notes.push('Werkmap gekopieerd naar TeamBot.');
        }
        const skills = a.skills.map((n) => skillIdByName.get(n)).filter((x): x is string => !!x);
        const sp = specs.get(a.id);
        const asSpecialist = !!sp?.selected && !!spBridge;
        const role = a.id === mainKey ? 'main' : a.id === leadKey ? 'lead' : sp?.selected ? 'specialist' : null;
        const agent = this.ctx.store.createAgent(userId, {
          id,
          name: a.name,
          description: a.description,
          instructions: a.instructions,
          color: colorFor(a.avatarSeed || a.id, a.avatarHue),
          avatar: encodeFace(traitsFor(a.avatarSeed || a.id)),
          provider_id: providerId,
          model: a.model,
          reasoning: mapReasoning(a.reasoning),
          access_mode: access.mode as AccessMode,
          tool_groups: toolGroupsFor(a),
          skills,
          fallback: firstUsable ? { provider_id: firstUsable.provider_id!, model: firstUsable.model } : null,
          pinned: a.pinned,
          sort: a.sort,
          ...(workspace ? { workspace } : {}),
          settings: {
            /** Ordered reserve engines (TeamBot switches through them on limits/outages, CLI engines included). */
            fallbacks: backups.filter((b) => b.provider_id).map((b) => ({ provider_id: b.provider_id!, model: b.model })),
            /** Home team (teams module, read when the bot is created). */
            ...(team ? { homeTeam: team.id } : {}),
            /** A specialist that learns (package S): its learning round stays off until the owner switches it on. */
            ...(asSpecialist ? { specialist: { field: sp!.field, sources: sp!.sources, learning: 'off', from: 'openbot' } } : {}),
            importedFrom: {
              app: 'openbot',
              id: a.id,
              at: new Date().toISOString(),
              provider: a.provider,
              access: a.access,
              computerUse: a.computerUse,
              avatarSeed: a.avatarSeed,
              avatarHue: a.avatarHue,
              instructionsSource: a.instructionsSource,
              workspace: choice,
              /** Ordered backup list as configured in OpenBot (the linked ones are settings.fallbacks above). */
              backups,
              backupsAutomatic: a.backupsAutomatic,
              ...(role ? { role } : {}),
              /** Field and sources as proposed (kept for when specialists are there, also when this bot is a normal bot). */
              ...(sp?.selected ? { specialist: { field: sp.field, sources: sp.sources } } : {}),
            },
          },
        });
        agentIdByOb.set(a.id, agent.id);
        createdNow.add(a.id);
        ledger.agents.push(agent.id);
        this.ctx.audit(userId, 'agent.imported', { from: 'openbot', name: agent.name, workspace: choice, skills: skills.length }, agent.id);
        this.ctx.events.emit(userId, 'agent.updated', agent);
        // The teams module files a new bot under settings.homeTeam; make sure it really landed in the import's team.
        if (team && teams && teams.teamOf(agent.id) !== team.id) teams.setHome(userId, team.id, agent.id);
        if (a.backups.length && !firstUsable) notes.push('Geen van de reserve-engines is al gekoppeld.');
        result.bots.push({ key: a.id, name: agent.name, status: 'created', agentId: agent.id, workspace: agent.workspace, notes });
      } catch (e: any) {
        result.bots.push({ key: a.id, name: a.name, status: 'error', error: e?.message || String(e), notes });
      }
    }
    for (const a of snap.agents) if (bodyBots[a.id]?.selected && imported.has(a.id)) result.bots.push({ key: a.id, name: a.name, status: 'skipped', agentId: imported.get(a.id)!.id, notes: ['Was al overgenomen.'] });

    // 5. Roles. At most one main bot, ever: with one already there (or without the main-bot part), the boss leads the team.
    const obName = (k: string) => snap.agents.find((a) => a.id === k)?.name || '';
    if (mainKey && !createdNow.has(mainKey)) mainKey = null;
    if (mainKey) {
      const agentId = agentIdByOb.get(mainKey)!;
      const mb = mainBotBridge(this.ctx);
      const cur = currentMain(this.ctx, userId);
      let why = '';
      if (!mb) why = 'De hoofdbot staat in deze TeamBot niet aan.';
      else if (cur && cur.id !== agentId) why = `Je hebt al een hoofdbot (${cur.name}) en er kan er maar één zijn.`;
      else {
        try {
          const r = mb.set(userId, agentId);
          ledger.main = agentId;
          result.roles.main = { name: obName(mainKey), status: 'set', note: [`${obName(mainKey)} is je hoofdbot.`, ...r.notes].join(' ') };
        } catch (e: any) {
          why = e?.message || String(e);
        }
      }
      if (why) {
        // Not the main bot: the boss leads the import's team instead (unless the owner picked another lead).
        const asLead = !!team && (!leadKey || leadKey === mainKey);
        if (asLead) leadKey = mainKey;
        result.roles.main = { name: obName(mainKey), status: asLead ? 'lead' : 'skipped', note: asLead ? `${why} ${obName(mainKey)} wordt teamleider van ${team!.name}.` : `${why} ${obName(mainKey)} komt als gewone bot.` };
        result.attention.push({ level: 'info', text: result.roles.main.note });
        mainKey = null;
      }
    }
    if (leadKey && (!createdNow.has(leadKey) || leadKey === mainKey)) {
      if (leadKey === mainKey) result.roles.lead = { name: obName(leadKey), status: 'skipped', note: 'De hoofdbot staat boven de teams en is geen teamleider.' };
      leadKey = null;
    }
    if (leadKey && team && teams) {
      const agentId = agentIdByOb.get(leadKey)!;
      const cur = teams.team(team.id);
      const curLead = cur?.lead_agent_id ? this.ctx.store.agent(cur.lead_agent_id) : null;
      if (curLead && curLead.id !== agentId) result.roles.lead = { name: obName(leadKey), status: 'skipped', note: `${team.name} heeft al een teamleider (${curLead.name}); die blijft.` };
      else {
        try {
          teams.setLead(userId, team.id, agentId);
          teamEntry!.leadSet = agentId;
          result.roles.lead = { name: obName(leadKey), status: 'set', note: `${obName(leadKey)} is teamleider van ${team.name}.` };
        } catch (e: any) {
          result.roles.lead = { name: obName(leadKey), status: 'skipped', note: e?.message || String(e) };
          result.attention.push({ level: 'warn', text: `Teamleider: ${result.roles.lead.note}` });
        }
      }
    }
    for (const [key, sp] of specs) {
      if (!sp.selected || !createdNow.has(key)) continue;
      const agent = this.ctx.store.agent(agentIdByOb.get(key)!)!;
      let status: 'specialist' | 'bot' = 'bot';
      let note = 'Specialisten staan in deze TeamBot niet aan: komt als gewone bot, met vakgebied en bronnen bewaard. Zijn leerrondes staan uit.';
      if (spBridge) {
        try {
          spBridge.make(userId, agent, { field: sp.field, sources: sp.sources, learning: 'off', from: 'openbot' });
          status = 'specialist';
          note = 'Specialist. Zijn leerronde staat uit tot jij hem aanzet.';
        } catch (e: any) {
          note = `Kon niet als specialist worden ingesteld (${e?.message || e}); komt als gewone bot.`;
          result.attention.push({ level: 'warn', text: `${agent.name}: ${note}` });
        }
      }
      result.roles.specialists.push({ name: agent.name, status, field: sp.field, sources: sp.sources.length, note });
    }

    // 6. Shared team folder: the team's folder, referenced (the same folder as in OpenBot), never copied.
    if (withShared && snap.shared.exists) {
      const problem = this.ctx.services.folders?.problem?.(snap.shared.path) || null;
      const ids = [...agentIdByOb.values()];
      if (problem) {
        result.shared = { path: snap.shared.path, status: 'skipped', note: problem };
        result.attention.push({ level: 'warn', text: `Teammap: ${problem}` });
      } else if (team && teams) {
        const cur = teams.teamFolder(team.id);
        try {
          if (!cur) {
            // A new team holds only imported bots: the folder is for the whole team. In an existing team, only for them.
            teams.setFolder(userId, team.id, { path: snap.shared.path, label: 'Gedeelde teammap', mode: 'rw', agents: target.create ? 'all' : ids });
            teamEntry!.folderSet = true;
            teamEntry!.folderBefore = null;
            result.shared = { path: snap.shared.path, status: 'set' };
          } else if (norm(cur.path) === norm(snap.shared.path)) {
            if (cur.agents !== 'all') {
              teamEntry!.folderSet = true;
              teamEntry!.folderBefore = cur;
              teams.setFolder(userId, team.id, { ...cur, agents: [...new Set([...cur.agents, ...ids])] });
            }
            result.shared = { path: snap.shared.path, status: 'updated' };
          } else {
            result.shared = { path: snap.shared.path, status: 'skipped', note: `${team.name} heeft al een andere teammap (${cur.path}). Voeg ${snap.shared.path} eventueel als extra map toe bij de bots.` };
            result.attention.push({ level: 'warn', text: result.shared.note! });
          }
        } catch (e: any) {
          result.shared = { path: snap.shared.path, status: 'skipped', note: e?.message || String(e) };
          result.attention.push({ level: 'warn', text: `Teammap: ${result.shared.note}` });
        }
      } else if (!teams) {
        // Without the teams module: the single team folder setting, as before.
        const cur = this.ctx.services.folders?.team(userId);
        if (!cur) {
          ledger.legacyFolder = { path: snap.shared.path, before: null };
          this.ctx.store.setSetting(userId, 'teamFolder', { path: snap.shared.path, label: 'Gedeelde teammap', mode: 'rw', agents: ids });
          result.shared = { path: snap.shared.path, status: 'set' };
        } else if (norm(cur.path) === norm(snap.shared.path)) {
          ledger.legacyFolder = { path: snap.shared.path, before: cur };
          const agents = cur.agents === 'all' ? 'all' : [...new Set([...cur.agents, ...ids])];
          this.ctx.store.setSetting(userId, 'teamFolder', { ...cur, agents });
          result.shared = { path: snap.shared.path, status: 'updated' };
        } else {
          result.shared = { path: snap.shared.path, status: 'skipped', note: `Er is al een andere teammap ingesteld (${cur.path}). Voeg ${snap.shared.path} eventueel als extra map toe bij de bots.` };
          result.attention.push({ level: 'warn', text: result.shared.note! });
        }
      }
      if (result.shared && result.shared.status !== 'skipped') {
        this.ctx.audit(userId, 'folders.team_set', { path: snap.shared.path, from: 'openbot-import', agents: ids.length, teamId: team?.id ?? null });
        this.ctx.events.emit(userId, 'folders.updated', { teamId: team?.id ?? null });
      }
    }

    // 7. Shared team tables: copied into TeamBot's team database (into the import's team once the team database keeps
    //    data per team), each OpenBot row once (importing again adds only new rows). OpenBot's agent-data.db was read
    //    from a private copy and is never changed.
    const tdb = teamDataBridge(this.ctx);
    if (withTeamData && snap.teamData && tdb) {
      const owner = (table: string) => {
        const obId = snap.teamData!.tables.find((x) => x.name === table)?.ownerAgentId;
        const agent = obId ? this.ctx.store.agent(agentIdByOb.get(obId) || '') : null;
        return agent && agent.user_id === userId ? { type: 'agent' as const, id: agent.id, name: agent.name } : { type: 'system' as const, id: '', name: 'TeamBot' };
      };
      try {
        const tables = await tdb.importTables(userId, team?.id ?? null, snap.teamData.tables.map((t) => ({ name: t.name, sql: t.sql, rows: t.rows })), owner);
        result.teamData = tables;
        for (const t of tables) if (t.created) ledger.tables.push({ name: t.name, owner: owner(t.name), teamId: team?.id ?? null });
        ledger.teamRows += tables.reduce((n, t) => n + t.inserted, 0);
        for (const t of tables) if (t.error) result.attention.push({ level: 'warn', text: `Teamtabel ${t.name}: ${t.error}` });
        const renumbered = tables.reduce((n: number, t: any) => n + t.renumbered, 0);
        if (renumbered) result.attention.push({ level: 'info', text: renumbered === 1 ? '1 rij kreeg een nieuw nummer omdat dat nummer in TeamBot al bestond.' : `${renumbered} rijen kregen een nieuw nummer omdat dat nummer in TeamBot al bestond.` });
        this.ctx.audit(userId, 'teamdata.imported', { from: 'openbot', teamId: tdb.perTeam ? team?.id ?? null : null, tables: tables.map((t: any) => ({ name: t.name, inserted: t.inserted, skipped: t.skipped })) });
      } catch (e: any) {
        result.attention.push({ level: 'warn', text: `Teamtabellen: ${e?.message || String(e)}` });
      }
    }

    // 8. Routines, always switched off (nothing runs twice next to OpenBot). Customer routines get their own reason.
    const engine = this.ctx.services.routines?.engine;
    const existingRoutines = new Set<string>();
    if (engine) for (const r of engine.routinesOf(userId)) existingRoutines.add(`${r.agent_id}|${r.name}`);
    for (const r of snap.routines) {
      if (!routineKeys.has(r.id)) continue;
      const botName = snap.agents.find((a) => a.id === r.agentId)?.name || '';
      const agentId = agentIdByOb.get(r.agentId);
      const customer = isCustomerRoutine(r, botName);
      if (!engine) {
        result.routines.push({ key: r.id, name: r.name, bot: botName, status: 'error', error: 'De routinemodule staat niet aan.' });
        continue;
      }
      if (!agentId) {
        result.routines.push({ key: r.id, name: r.name, bot: botName, status: 'skipped', error: 'De bot van deze routine is niet overgenomen.' });
        continue;
      }
      if (existingRoutines.has(`${agentId}|${r.name}`)) {
        result.routines.push({ key: r.id, name: r.name, bot: botName, status: 'skipped', error: 'Bestond al.' });
        continue;
      }
      const m = mapSchedule(r.schedule);
      if ('error' in m) {
        result.routines.push({ key: r.id, name: r.name, bot: botName, status: 'error', error: m.error });
        continue;
      }
      try {
        const created = engine.create(
          userId,
          // run_in "chat" (OpenBot: in the agent's main chat) = TeamBot's "In de hoofdchat van de bot" (runIn 'main').
          { name: r.name, agent_id: agentId, prompt: r.instruction, timezone: r.timezone, schedule: m.schedule, options: { missedPolicy: r.missedPolicy === 'run-once' ? 'catchup' : 'skip', ...(r.runIn === 'chat' ? { runIn: 'main' } : {}) } },
          { status: 'paused', allowPastOnce: true },
        );
        engine.setStatus(created, 'paused', customer ? CUSTOMER_PAUSE_REASON : PAUSE_REASON, 'system');
        existingRoutines.add(`${agentId}|${r.name}`);
        ledger.routines.push(created.id);
        ledger.routineMeta[created.id] = { on: r.active, customer, ob: r.id };
        result.routines.push({ key: r.id, name: r.name, bot: botName, status: 'created', routineId: created.id, customer, wasActive: r.active });
      } catch (e: any) {
        result.routines.push({ key: r.id, name: r.name, bot: botName, status: 'error', error: e?.message || String(e) });
      }
    }

    // 8b. Chat channels, always switched off and without a token: nothing polls or logs in next to OpenBot (a
    //     Telegram token can only be read by one app; WhatsApp gets a new QR scan). The allowlist comes along.
    const chanPlan = this.channelPlan(userId, snap, this.importedAgents(userId));
    const chanKeys = Array.isArray(body?.channels) ? new Set<string>(body.channels.map(String)) : new Set(chanPlan.filter((c) => c.selected).map((c) => c.key));
    const chSvc = this.ctx.services.channels;
    for (const c of chanPlan) {
      if (!c.adapter) {
        result.channels.push({ key: c.key, label: c.label, bot: c.bot, status: 'relink', note: c.note });
        continue;
      }
      if (!chanKeys.has(c.key)) continue;
      if (c.existing) {
        result.channels.push({ key: c.key, label: c.label, bot: c.bot, status: 'skipped', note: 'Bestond al.' });
        continue;
      }
      const agentId = c.botKey ? agentIdByOb.get(c.botKey) || this.importedAgents(userId).get(c.botKey)?.id : null;
      if (!agentId || typeof chSvc?.importPaused !== 'function') {
        result.channels.push({ key: c.key, label: c.label, bot: c.bot, status: 'skipped', note: !agentId ? 'De bot van dit kanaal is niet overgenomen; verbind het later zelf bij Kanalen.' : 'Kanalen staan in deze TeamBot niet aan.' });
        continue;
      }
      try {
        const v = await chSvc.importPaused({ userId, adapter: c.adapter, name: c.name || c.label, agentId, senders: c.senderList, importedFrom: { app: 'openbot', id: c.key, at: new Date().toISOString() } });
        ledger.channels.push(v.id);
        result.channels.push({ key: c.key, label: c.label, bot: c.bot, status: 'created', bindingId: v.id, note: c.note });
      } catch (e: any) {
        result.channels.push({ key: c.key, label: c.label, bot: c.bot, status: 'error', note: e?.message || String(e) });
      }
    }

    // 9. Memories of the bot (scope "agent"). "active" (default): they were live in OpenBot, so the owner's choice
    //    in the preview counts as approval and "essential" ones are pinned; the pipeline still refuses secrets and
    //    turns conflicts into review cards. "review": everything becomes a proposal (TeamBot caps open proposals).
    const svc = this.ctx.services.memory?.svc;
    if (memMode !== 'off' && svc) {
      const { writeCandidate } = await import('../memory/pipeline.js');
      // Each memory once per import generation; an undo starts a new one, so importing again brings them back.
      const gen = Number(this.state(userId).generation) || 0;
      for (const mem of snap.memories) {
        const agentId = agentIdByOb.get(mem.agentId);
        if (!agentId) {
          result.memories.skipped++;
          continue;
        }
        try {
          const out = writeCandidate(svc, {
            userId,
            content: mem.text,
            scope: 'agent',
            agentId,
            source: { kind: 'import', ref: 'openbot', trust: 'import' },
            origin: 'import',
            createdBy: 'import',
            pinned: mem.inclusion === 'essential',
            ...(memMode === 'review' ? { forcePropose: true, proposalReason: 'import' } : { userApproved: true }),
            idemKey: gen ? `openbot:g${gen}:${mem.id}` : `openbot:${mem.id}`,
          });
          if (out.action === 'inserted' || out.action === 'superseded') result.memories.imported++;
          else if (out.action === 'proposed' || out.action === 'conflict') result.memories.proposed++;
          else if (out.action === 'duplicate') result.memories.duplicates++;
          else {
            result.memories.failed++;
            result.memories.reasons[out.reason] = (result.memories.reasons[out.reason] || 0) + 1;
          }
        } catch {
          result.memories.failed++;
          result.memories.reasons.error = (result.memories.reasons.error || 0) + 1;
        }
      }
      if (result.memories.proposed) result.attention.push({ level: 'info', text: result.memories.proposed === 1 ? '1 herinnering staat klaar ter controle onder Geheugen → Te beoordelen.' : `${result.memories.proposed} herinneringen staan klaar ter controle onder Geheugen → Te beoordelen (in één keer goed te keuren).` });
      const why: Record<string, string> = { quota: 'het maximum aantal open voorstellen of het quotum is bereikt (beoordeel eerst en lees daarna opnieuw in)', secret: 'ze lijken op een wachtwoord of sleutel', injection: 'ze lijken op een instructie uit een externe bron', forgotten: 'ze zijn eerder bewust vergeten', rejected_before: 'je hebt ze eerder afgewezen' };
      for (const [reason, n] of Object.entries(result.memories.reasons)) result.attention.push({ level: 'warn', text: n === 1 ? `1 herinnering niet overgenomen: ${why[reason] || reason}.` : `${n} herinneringen niet overgenomen: ${why[reason] || reason}.` });
    }

    const createdRoutines = result.routines.filter((r) => r.status === 'created');
    if (createdRoutines.length) result.attention.unshift({ level: 'warn', text: createdRoutines.length === 1 ? '1 routine staat uit. Zet hem aan wanneer je OpenBot stopt, anders draait hij dubbel (bijv. klantmails).' : `${createdRoutines.length} routines staan uit. Zet ze aan wanneer je OpenBot stopt, anders draaien ze dubbel (bijv. klantmails).` });
    const customerOff = createdRoutines.filter((r) => r.customer);
    if (customerOff.length) result.attention.splice(1, 0, { level: 'warn', text: customerOff.length === 1 ? `De klantenservice-routine ${customerOff[0].name} blijft uit tot jij een testrun hebt bekeken en goedgekeurd.` : `De klantenservice-routines (${customerOff.map((r) => r.name).join(', ')}) blijven uit tot jij een testrun hebt bekeken en goedgekeurd.` });
    for (const e of [...st.engines.values()]) if (e.status === 'unknown' && selectedBots.some((a) => engineKey(a.provider) === engineKey(e.from))) result.attention.push({ level: 'warn', text: `${e.label}: ${e.note}` });
    const chOff = result.channels.filter((c) => c.status === 'created');
    if (chOff.length) result.attention.splice(1, 0, { level: 'warn', text: chOff.length === 1 ? `Kanaal ${chOff[0].label} staat uit en heeft nog geen token. Zet het aan op het overstapmoment: eerst uit in OpenBot, dan aan in TeamBot.` : `${chOff.length} kanalen staan uit en hebben nog geen token. Zet ze één voor één aan op het overstapmoment: eerst uit in OpenBot, dan aan in TeamBot.` });
    for (const c of result.channels.filter((x) => x.status === 'relink' || x.status === 'error')) result.attention.push({ level: 'warn', text: `${c.label}: ${c.note}` });

    const summary = {
      at: new Date().toISOString(),
      source: snap.paths.dataDir,
      counts: {
        bots: result.bots.filter((b) => b.status === 'created').length,
        routines: createdRoutines.length,
        skills: result.skills.filter((s) => ['created', 'updated', 'version-added', 'unchanged'].includes(s.status)).length,
        memories: result.memories.imported + result.memories.proposed,
        providers: result.providers.filter((p) => p.status === 'linked').length,
        teamRows: (result.teamData || []).reduce((n, t) => n + t.inserted, 0),
        channels: result.channels.filter((c) => c.status === 'created').length,
      },
      ...result,
      /** "staan uit tot jij ze aanzet": every routine this import made. */
      routinesOff: createdRoutines.map((r) => ({ name: r.name, bot: r.bot, customer: !!r.customer })),
    };
    const all = mergeLedger(this.ledger(userId), ledger);
    this.setState(userId, { last: summary, dismissed: true, ledger: { ...all, at: summary.at } });
    this.ctx.audit(userId, 'openbot.imported', { ...summary.counts, teamId: result.team?.id ?? null });
    this.stagings.delete(st.id);
    return { ...summary, undo: this.undoAvailable(userId) };
  }

  // ======================================================================
  // undo: remove what the imports made
  // ======================================================================

  undoAvailable(userId: string): boolean {
    const l = this.ledger(userId);
    return !!(l.agents.length || l.routines.length || l.skills.length || l.providers.length || l.teams.length || l.teamRows || l.tables.length || l.legacyFolder || l.channels.length);
  }

  // ======================================================================
  // switch-over ("Overstappen", step by step): status per step and the two actions that change something
  // ======================================================================

  /** What runs in OpenBot right now (a private copy is read; nothing in OpenBot changes). Kept for the status page. */
  checkOpenBot(userId: string): ObLive & { checkedAt: string } {
    const live = { ...readOpenBotLive(this.paths(), this.tmpRoot()), checkedAt: new Date().toISOString() };
    this.live.set(userId, live);
    return live;
  }

  /** The owner confirms (or takes back) a step TeamBot cannot see itself: the OpenBot backup, the bots checked. */
  markStep(userId: string, step: string, done: boolean) {
    if (step !== 'backup' && step !== 'check') throw new HttpError(400, 'Onbekende stap.');
    const cut = { ...(this.state(userId).cutover || {}) };
    cut[step === 'backup' ? 'openbotBackupAt' : 'checkedAt'] = done ? new Date().toISOString() : null;
    this.setState(userId, { cutover: cut });
    return this.cutover(userId);
  }

  /**
   * "Zet de routines aan": switches on the routines this import made that were on in OpenBot. Customer routines never
   * (a test run first, at Routines). Refused while OpenBot runs with the same routines still on: they would run twice.
   */
  resumeRoutines(userId: string) {
    const engine = this.ctx.services.routines?.engine;
    if (!engine) throw new HttpError(400, 'De routinemodule staat niet aan.');
    const l = this.ledger(userId);
    const live = this.checkOpenBot(userId);
    // Matched by OpenBot's routine id (names repeat across bots, e.g. "Startaudit").
    const stillOn = new Set(live.running ? live.routines.filter((r) => r.active).map((r) => r.id) : []);
    const started: string[] = [];
    const skipped: { name: string; why: string }[] = [];
    for (const id of l.routines) {
      const r = engine.routine(id);
      const meta = l.routineMeta?.[id];
      if (!r || r.user_id !== userId || r.status !== 'paused' || !meta?.on) continue;
      if (meta.customer) {
        skipped.push({ name: r.name, why: 'klantenservice: eerst een testrun bekijken en goedkeuren bij Routines' });
        continue;
      }
      if (meta.ob && stillOn.has(meta.ob)) {
        skipped.push({ name: r.name, why: 'staat in OpenBot nog aan terwijl OpenBot draait' });
        continue;
      }
      try {
        engine.setStatus(r, 'active', null, 'user');
        started.push(r.name);
      } catch (e: any) {
        skipped.push({ name: r.name, why: e?.message || String(e) });
      }
    }
    if (started.length) {
      this.ctx.audit(userId, 'openbot.routines_resumed', { count: started.length });
      this.ctx.events.emit(userId, 'routines.changed', {});
    }
    return { started, skipped, status: this.cutover(userId) };
  }

  /** Status per step of the switch-over (TeamBot's own state plus the last look at OpenBot; reads nothing new). */
  cutover(userId: string) {
    const state = this.state(userId);
    const cut = state.cutover || {};
    const last = state.last && !state.last.undone ? state.last : null;
    const l = this.ledger(userId);
    const live = this.live.get(userId) || null;

    // 1. Back-ups: TeamBot's newest backup (seen here), OpenBot's confirmed by the owner (TeamBot cannot see it).
    let newest: { at: string; name: string } | null = null;
    try {
      const list: any[] = this.ctx.services.backups?.list?.() || [];
      if (list[0]) newest = { at: String(list[0].createdAt), name: String(list[0].name) };
    } catch {
      newest = null;
    }
    const backupDone = !!newest && !!cut.openbotBackupAt;

    // 2. Import.
    const importDone = !!last;

    // 3. Side by side: how long, and are any of the imported channels connected already (should not be, yet).
    const channels = importedChannels(this.ctx, userId, l);
    const days = last ? Math.floor((Date.now() - Date.parse(last.at)) / 86_400_000) : 0;

    // 4. Channels: per OpenBot channel where it is now (OpenBot from the last look, TeamBot from its own state).
    const fromLast: any[] = Array.isArray(last?.channels) ? last.channels : [];
    const byKey = new Map<string, any>();
    for (const c of channels) if (c.config?.importedFrom?.id) byKey.set(String(c.config.importedFrom.id), c);
    const keys = new Set<string>([...fromLast.map((c) => String(c.key)), ...(live?.channels || []).map((c) => c.id)]);
    const items = [...keys].map((key) => {
      const ob = live?.channels.find((c) => c.id === key) || null;
      const imp = fromLast.find((c) => String(c.key) === key) || null;
      const tb = (imp?.bindingId ? channels.find((x: any) => x.id === imp.bindingId) : null) || byKey.get(key) || null;
      const tbOn = !!tb?.enabled;
      const obOn = ob ? ob.enabled : null;
      const phase = tbOn && obOn ? 'both' : tbOn ? 'teambot' : obOn === false ? 'switch' : 'openbot';
      return {
        key,
        label: imp?.label || `${ob?.platform || 'Kanaal'}${ob?.name ? ` · ${ob.name}` : ''}`,
        bot: imp?.bot || '',
        relink: imp?.status === 'relink' || (!tb && !!ob && ob.platform === 'whatsapp'),
        openbot: obOn,
        teambot: tb ? { id: tb.id, enabled: tbOn, status: tb.status || 'stopped', health: tb.health?.state || null } : null,
        phase,
      };
    });
    const channelsDone = importDone && items.every((c) => c.phase === 'teambot');

    // 5. Routines that were on in OpenBot.
    const engine = this.ctx.services.routines?.engine;
    const mine = engine ? l.routines.map((id) => engine.routine(id)).filter((r: any) => r && r.user_id === userId) : [];
    const wasOn = mine.filter((r: any) => l.routineMeta?.[r.id]?.on);
    const onNow = wasOn.filter((r: any) => r.status === 'active');
    const customer = wasOn.filter((r: any) => l.routineMeta?.[r.id]?.customer);
    const obActive = live ? live.routines.filter((r) => r.active).length : null;
    const routinesDone = importDone && wasOn.length > 0 && onNow.length === wasOn.length;

    const status = (done: boolean, open: boolean) => (done ? 'done' : open ? 'now' : 'later');
    const steps = [
      { id: 'backup', status: status(backupDone, true), teambot: newest, openbotConfirmedAt: cut.openbotBackupAt || null },
      { id: 'import', status: status(importDone, backupDone || importDone), at: last?.at || null, counts: last?.counts || null },
      { id: 'check', status: status(!!cut.checkedAt && importDone, importDone), days, checkedAt: cut.checkedAt || null, channelsOn: channels.filter((c) => c.enabled).length },
      { id: 'channels', status: status(channelsDone, importDone && !!cut.checkedAt), items },
      { id: 'routines', status: status(routinesDone, importDone && !!cut.checkedAt), total: mine.length, wasOn: wasOn.length, on: onNow.length, customer: customer.map((r: any) => r.name), openbotActive: obActive },
      { id: 'back', status: 'info', undoable: this.undoAvailable(userId) },
    ];
    return {
      steps,
      openbot: live ? { checkedAt: live.checkedAt, found: live.found, running: live.running, heartbeatAt: live.heartbeatAt, version: live.version, routinesActive: obActive, channelsOn: live.channels.filter((c) => c.enabled).length } : null,
    };
  }

  undoPlan(userId: string) {
    return undoPlan(this.ctx, userId, this.ledger(userId));
  }

  async undo(userId: string) {
    const ledger = this.ledger(userId);
    if (!this.undoAvailable(userId)) throw new HttpError(400, 'Er is geen import om ongedaan te maken.');
    const res = await undoImport(this.ctx, userId, ledger, this.paths());
    const state = this.state(userId);
    this.setState(userId, { ledger: res.left, generation: (Number(state.generation) || 0) + 1, last: state.last ? { ...state.last, undone: new Date().toISOString() } : state.last });
    this.ctx.audit(userId, 'openbot.undone', { bots: res.bots, routines: res.routines, skills: res.skills, providers: res.providers, teamRows: res.teamRows, teams: res.teams });
    return res;
  }
}

function norm(p: string) {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
}
