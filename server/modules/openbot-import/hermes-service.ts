import crypto from 'node:crypto';
import path from 'node:path';
import { encodeFace, traitsFor } from '../../../shared/botface.js';
import type { Ctx, ProviderConfig } from '../../core/types.js';
import { HttpError } from '../../core/http.js';
import { filesFromDir, findSkillRoots, subset } from '../skills/files.js';
import { type HermesEngineRef, type HermesProfile, type HermesSnapshot, detectHermes, mapHermesEngine, mapHermesSchedule, readHermes } from './hermes.js';
import { colorFor } from './mapping.js';
import { type Ledger, emptyLedger, mergeLedger, undoImport, undoPlan } from './undo.js';
import type { Detector, EngineStatus } from './service.js';

/**
 * "Overstappen uit Hermes Agent": the same flow as the OpenBot import (preview that writes nothing, one import, undo),
 * for a Hermes data folder. Every profile becomes a bot (SOUL.md as its instructions), its memories come along (the
 * agent's notes for that bot, what it knows about you under "Over jou"), skills go through the regular skills importer,
 * and scheduled jobs become routines that start switched off. Hermes itself is only read, never written; `.env` and
 * `auth.json` (keys and logins) are never opened.
 */

const TTL = 30 * 60_000;
const SETTING = 'hermesImport';
const PAUSE_REASON = 'Overgenomen uit Hermes Agent en uitgezet, zodat niets dubbel draait. Zet aan wanneer je Hermes stopt.';
/** Hermes works with its terminal and files; in TeamBot every command and change asks first ("Vraagt toestemming"). */
const TOOL_GROUPS = ['files', 'web', 'memory', 'team', 'skills', 'routines', 'shell', 'browser'];

interface EngineView {
  from: string;
  kind: string | null;
  label: string;
  status: EngineStatus;
  note: string;
  baseUrl?: string;
}

interface Staging {
  id: string;
  userId: string;
  createdAt: number;
  snap: HermesSnapshot;
  engines: Map<string, EngineView>;
  skillStagingId: string | null;
  skillKeys: Map<string, string>;
  skillScan: Map<string, { level: string; action: string; errors: string[] }>;
}

interface HermesLedger extends Ledger {
  /** "Over jou" memories the import wrote (they belong to no bot, so they go separately on undo). */
  memories: string[];
}

const engineKey = (r: HermesEngineRef) => `${r.from}|${r.kind || ''}|${r.baseUrl || ''}`;

export class HermesImport {
  private stagings = new Map<string, Staging>();
  constructor(private ctx: Ctx, private home: () => string, private detector: Detector) {}

  private sweep() {
    const t = Date.now();
    for (const [id, s] of this.stagings) if (t - s.createdAt > TTL) this.stagings.delete(id);
  }

  private state(userId: string): any {
    return this.ctx.store.getSetting<any>(userId, SETTING, {}) || {};
  }
  private setState(userId: string, patch: any) {
    this.ctx.store.setSetting(userId, SETTING, { ...this.state(userId), ...patch });
  }
  ledger(userId: string): HermesLedger {
    return { ...emptyLedger(), memories: [], ...(this.state(userId).ledger || {}) };
  }

  /** The folder to read: the one the owner typed (absolute) or the default (~/.hermes, HERMES_HOME). */
  private folder(raw: unknown): string {
    const v = typeof raw === 'string' ? raw.trim() : '';
    if (!v) return this.home();
    if (!path.isAbsolute(v) || v.length > 500) throw new HttpError(400, 'Geef het volledige pad van de Hermes-map, bijvoorbeeld C:\\Users\\jij\\.hermes of /home/jij/.hermes.');
    return path.resolve(v);
  }

  detect(userId: string) {
    const st = this.state(userId);
    const d = detectHermes(this.home());
    return { ...d, imported: st.last ? { at: st.last.at, counts: st.last.counts, undone: st.last.undone || null } : null, undoable: this.undoAvailable(userId) };
  }

  private importedBots(userId: string) {
    const out = new Map<string, { id: string; name: string }>();
    for (const a of this.ctx.store.agents(userId, { archived: true })) {
      const f = a.settings?.importedFrom;
      if (f?.app === 'hermes' && typeof f.id === 'string') out.set(f.id, { id: a.id, name: a.name });
    }
    return out;
  }

  private ownProvider(userId: string, kind: string): ProviderConfig | null {
    return this.ctx.providers.list(userId).find((p) => p.kind === kind && p.enabled && this.ctx.providers.canUse(userId, p)) || null;
  }

  private async engineView(userId: string, ref: HermesEngineRef): Promise<EngineView> {
    const base = { from: ref.from, kind: ref.kind, label: ref.label, ...(ref.baseUrl ? { baseUrl: ref.baseUrl } : {}) };
    if (!ref.kind) return { ...base, status: 'unknown', note: `TeamBot kent "${ref.label}" niet als engine; kies zelf een engine voor deze bot.` };
    const existing = this.ownProvider(userId, ref.kind);
    if (existing) return { ...base, status: 'ready', note: `Gekoppeld (${existing.name}).` };
    const k = this.ctx.providers.kind(ref.kind);
    if (!k) return { ...base, status: 'unknown', note: `${ref.label} is in deze TeamBot niet beschikbaar.` };
    if (k.needsKey && !k.keyOptional) return { ...base, status: 'reconnect', note: `Opnieuw verbinden: vul je ${ref.label}-sleutel in bij AI-diensten. Sleutels uit Hermes (.env) worden niet gekopieerd.` };
    let d: Awaited<ReturnType<Detector>> = null;
    try {
      d = await this.detector(ref.kind);
    } catch {
      d = null;
    }
    if (d?.installed && (k.type !== 'cli' || d.loggedIn !== false)) return { ...base, status: 'connect', note: `Gevonden op deze computer${d.version ? ` (${d.version})` : ''}; wordt gekoppeld.` };
    if (d?.installed && d.loggedIn === false) return { ...base, status: 'reconnect', note: `${ref.label} is geïnstalleerd maar niet ingelogd. Log in en koppel hem daarna bij AI-diensten.` };
    return { ...base, status: 'missing', note: `${ref.label} is niet gevonden op deze computer. Koppel hem later bij AI-diensten.` };
  }

  // ---------------- preview ----------------

  async preview(userId: string, body: any = {}) {
    this.sweep();
    const home = this.folder(body?.path);
    let snap: HermesSnapshot;
    try {
      snap = readHermes(home);
    } catch (e: any) {
      throw new HttpError(400, e?.message || String(e));
    }
    const engines = new Map<string, EngineView>();
    await Promise.all(
      snap.profiles.map(async (p) => {
        const ref = mapHermesEngine(p.provider, p.baseUrl);
        if (!engines.has(engineKey(ref))) engines.set(engineKey(ref), await this.engineView(userId, ref));
      }),
    );
    const st: Staging = { id: 'hmi_' + crypto.randomBytes(12).toString('hex'), userId, createdAt: Date.now(), snap, engines, skillStagingId: null, skillKeys: new Map(), skillScan: new Map() };
    this.stageSkills(userId, st);
    for (const [id, s] of this.stagings) if (s.userId === userId) this.stagings.delete(id);
    this.stagings.set(st.id, st);
    return this.view(st);
  }

  private stageSkills(userId: string, st: Staging) {
    const importer = this.ctx.services.skills?.importer;
    if (!importer) return;
    const items: any[] = [];
    const names: string[] = [];
    for (const sk of st.snap.skills) {
      try {
        const files = filesFromDir(sk.dir);
        const roots = findSkillRoots(files);
        items.push({ files: subset(files, '', roots), root: sk.name, source: { type: 'discover', label: `Hermes: ${sk.name}`, path: sk.dir }, fallbackName: sk.name });
        names.push(sk.name);
      } catch (e: any) {
        st.skillScan.set(sk.name, { level: 'error', action: 'error', errors: [e?.message || String(e)] });
      }
    }
    if (!items.length) return;
    const staging = importer.stage(userId, 'Hermes Agent', items);
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
    if (!s || s.userId !== userId) throw new HttpError(404, 'Deze voorvertoning is verlopen. Lees Hermes opnieuw in.');
    return s;
  }

  private tz(p: HermesProfile) {
    const tz = p.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    try {
      new Intl.DateTimeFormat('en', { timeZone: tz });
      return tz;
    } catch {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
    }
  }

  view(st: Staging) {
    const { snap } = st;
    const imported = this.importedBots(st.userId);
    const bots = snap.profiles.map((p) => {
      const eng = st.engines.get(engineKey(mapHermesEngine(p.provider, p.baseUrl)))!;
      const notes: string[] = [];
      if (!p.soul) notes.push('Geen SOUL.md gevonden: de bot begint zonder eigen instructies.');
      if (p.hasEnv) notes.push('De sleutels in .env worden niet overgenomen.');
      const existing = imported.get(p.id) || null;
      return {
        key: p.id,
        name: p.name,
        profile: p.id,
        folder: p.dir,
        engine: eng,
        model: p.model,
        face: encodeFace(traitsFor('hermes:' + p.id)),
        instructions: { chars: p.soul.length, source: p.soul ? 'SOUL.md' : '' },
        skills: p.skills.length,
        routines: p.jobs.length,
        memories: p.memories.length,
        userFacts: p.userFacts.length,
        existing,
        selected: !existing,
        notes,
      };
    });
    const nameOf = new Map(snap.profiles.map((p) => [p.id, p.name]));
    const engine = this.ctx.services.routines?.engine;
    const existingRoutines = new Set<string>();
    if (engine) for (const r of engine.routinesOf(st.userId)) existingRoutines.add(`${r.agent_id}|${r.name}`);
    const routines = snap.profiles.flatMap((p) =>
      p.jobs.map((j) => {
        const m = mapHermesSchedule(j.schedule, this.tz(p));
        const bot = imported.get(p.id);
        const existing = !!bot && existingRoutines.has(`${bot.id}|${j.name}`);
        const notes: string[] = [];
        if (j.script) notes.push('Een script-taak zonder opdracht komt niet mee: TeamBot-routines geven een bot een opdracht.');
        if (j.skills.length) notes.push(j.skills.length === 1 ? `Gebruikt in Hermes de skill ${j.skills[0]}; neem hem hieronder mee, dan heeft de bot hem ook.` : `Gebruikt in Hermes de skills ${j.skills.join(', ')}; neem ze hieronder mee, dan heeft de bot ze ook.`);
        if (j.deliver && !['local', 'origin'].includes(j.deliver.toLowerCase())) notes.push(`Hermes stuurde het resultaat naar ${j.deliver}. In TeamBot komt het in de chat van de bot; een kanaal koppel je zelf bij Kanalen.`);
        if (j.model) notes.push(`Eigen model voor deze taak (${j.model}) komt niet mee; de routine gebruikt het model van de bot.`);
        const ok = !('error' in m) && !j.script && !!j.prompt;
        return { key: j.key, botKey: p.id, botName: nameOf.get(p.id) || p.id, name: j.name, schedule: 'error' in m ? m.error : m.label, ok, wasActive: j.active, promptPreview: j.prompt.slice(0, 280), off: true as const, notes, existing, selected: ok && !existing };
      }),
    );
    const skills = snap.skills.map((s) => {
      const scan = st.skillScan.get(s.name);
      const importable = !!st.skillKeys.get(s.name);
      return {
        key: s.name,
        name: s.name,
        description: s.description,
        category: s.category,
        bundled: s.bundled,
        usedBy: s.profiles.map((id) => nameOf.get(id) || id),
        variants: s.variants,
        scan: scan?.level || null,
        action: scan?.action || null,
        reason: scan?.errors?.[0] ?? '',
        importable,
        // Your own skills are proposed; the ones Hermes ships itself (MIT) only when you tick them.
        selected: importable && !s.bundled && scan?.action !== 'unchanged',
      };
    });
    const memories = snap.profiles.reduce((n, p) => n + p.memories.length, 0);
    const userFacts = new Set(snap.profiles.flatMap((p) => p.userFacts)).size;

    const attention: { level: 'warn' | 'info'; text: string }[] = [];
    for (const e of st.engines.values()) if (e.status === 'reconnect' || e.status === 'missing' || e.status === 'unknown') attention.push({ level: 'warn', text: `${e.label}: ${e.note}` });
    for (const w of snap.warnings) attention.push({ level: 'warn', text: w });

    const mcp = [...new Set(snap.profiles.flatMap((p) => p.mcpServers))];
    const notImported: { what: string; why: string }[] = [
      { what: 'Gesprekken', why: 'Bewuste keuze: je begint in TeamBot met schone gesprekken. Ze blijven in Hermes staan.' },
      { what: 'Sleutels, tokens en logins (.env, auth.json)', why: 'Nooit: die bestanden worden niet eens geopend. Verbind je AI-diensten in TeamBot opnieuw.' },
      { what: 'Chat-apps (Telegram, Discord, Slack …)', why: 'Hun tokens staan in .env. Koppel ze opnieuw bij Kanalen.' },
    ];
    if (mcp.length) notImported.push({ what: `Apps (MCP): ${mcp.join(', ')}`, why: 'Opnieuw toevoegen bij Apps (hun sleutels worden niet gekopieerd).' });

    return {
      stagingId: st.id,
      expiresAt: new Date(st.createdAt + TTL).toISOString(),
      source: { home: snap.home, readAt: snap.readAt },
      bots,
      routines,
      skills,
      memories: { total: memories, userFacts },
      engines: [...st.engines.values()],
      notImported,
      undo: this.undoAvailable(st.userId),
      attention,
    };
  }

  // ---------------- commit ----------------

  async commit(userId: string, body: any) {
    const st = this.get(userId, String(body?.stagingId || ''));
    const snap = st.snap;
    const wantBots = new Set<string>(Array.isArray(body?.bots) ? body.bots.map(String) : []);
    const routineKeys = new Set<string>(Array.isArray(body?.routines) ? body.routines.map(String) : []);
    const skillNames = new Set<string>(Array.isArray(body?.skills) ? body.skills.map(String) : []);
    const memMode: 'active' | 'review' | 'off' = body?.memories === false || body?.memories === 'off' ? 'off' : body?.memories === 'review' ? 'review' : 'active';
    const imported = this.importedBots(userId);
    const ledger: HermesLedger = { ...emptyLedger(), memories: [] };
    const result = {
      bots: [] as { key: string; name: string; status: 'created' | 'skipped' | 'error'; agentId?: string; error?: string; notes: string[] }[],
      routines: [] as { key: string; name: string; bot: string; status: 'created' | 'skipped' | 'error'; routineId?: string; error?: string }[],
      skills: [] as { name: string; status: string; error?: string }[],
      providers: [] as { label: string; status: string; note: string }[],
      memories: { imported: 0, proposed: 0, duplicates: 0, failed: 0, reasons: {} as Record<string, number> },
      attention: [] as { level: 'warn' | 'info'; text: string }[],
    };

    // 1. Engines found on this computer are linked (no keys involved); the rest is "opnieuw verbinden".
    const providerFor = new Map<string, string | null>();
    for (const p of snap.profiles) {
      if (!wantBots.has(p.id) || imported.has(p.id)) continue;
      const ref = mapHermesEngine(p.provider, p.baseUrl);
      const key = engineKey(ref);
      if (providerFor.has(key)) continue;
      const e = st.engines.get(key)!;
      const existing = e.kind ? this.ownProvider(userId, e.kind) : null;
      if (existing) providerFor.set(key, existing.id);
      else if (e.kind && e.status === 'connect') {
        try {
          const cfg = this.ctx.providers.create(userId, { kind: e.kind, ...(e.baseUrl && e.kind === 'openai-compatible' ? { base_url: e.baseUrl } : {}) });
          if (!this.ctx.store.getSetting(userId, 'defaultProvider', null)) this.ctx.store.setSetting(userId, 'defaultProvider', cfg.id);
          this.ctx.events.emit(userId, 'provider.updated', this.ctx.providers.view(cfg, userId));
          providerFor.set(key, cfg.id);
          ledger.providers.push(cfg.id);
          result.providers.push({ label: e.label, status: 'linked', note: 'Gekoppeld (gebruikt wat op deze computer staat).' });
        } catch (err: any) {
          providerFor.set(key, null);
          result.providers.push({ label: e.label, status: 'error', note: err?.message || String(err) });
        }
      } else {
        providerFor.set(key, null);
        result.providers.push({ label: e.label, status: e.status, note: e.note });
        result.attention.push({ level: 'warn', text: `${e.label}: ${e.note}` });
      }
    }

    // 2. Skills (the regular skills importer: scan, publisher policy, versions).
    const skillIdByName = new Map<string, string>();
    const want = [...skillNames].filter((n) => st.skillKeys.has(n));
    if (want.length && st.skillStagingId && this.ctx.services.skills?.importer) {
      try {
        const r = this.ctx.services.skills.importer.commit(userId, st.skillStagingId, { keys: want.map((n) => st.skillKeys.get(n)!), acknowledge: !!body?.acknowledgeSkills, createdBy: 'hermes-import' });
        const byKey = new Map(want.map((n) => [st.skillKeys.get(n)!, n]));
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

    // 3. Bots: one per profile, with SOUL.md as instructions and its selected skills.
    const agentIdByProfile = new Map<string, string>();
    for (const [pid, a] of imported) agentIdByProfile.set(pid, a.id);
    for (const p of snap.profiles) {
      if (!wantBots.has(p.id)) continue;
      if (imported.has(p.id)) {
        result.bots.push({ key: p.id, name: p.name, status: 'skipped', agentId: imported.get(p.id)!.id, notes: ['Was al overgenomen.'] });
        continue;
      }
      const notes: string[] = [];
      try {
        const ref = mapHermesEngine(p.provider, p.baseUrl);
        const providerId = providerFor.get(engineKey(ref)) ?? null;
        if (!providerId) notes.push(`Kies een engine: ${ref.label} is nog niet gekoppeld.`);
        const agent = this.ctx.store.createAgent(userId, {
          name: p.name,
          description: p.id === 'default' ? 'Overgenomen uit Hermes Agent' : `Overgenomen uit Hermes Agent (profiel ${p.id})`,
          instructions: p.soul,
          color: colorFor('hermes:' + p.id, null),
          avatar: encodeFace(traitsFor('hermes:' + p.id)),
          provider_id: providerId,
          model: p.model,
          access_mode: 'ask',
          tool_groups: TOOL_GROUPS,
          skills: p.skills.map((n) => skillIdByName.get(n)).filter((x): x is string => !!x),
          settings: { importedFrom: { app: 'hermes', id: p.id, at: new Date().toISOString(), provider: p.provider, model: p.model, folder: p.dir } },
        });
        agentIdByProfile.set(p.id, agent.id);
        ledger.agents.push(agent.id);
        this.ctx.audit(userId, 'agent.imported', { from: 'hermes', name: agent.name, skills: agent.skills?.length || 0 }, agent.id);
        this.ctx.events.emit(userId, 'agent.updated', agent);
        result.bots.push({ key: p.id, name: agent.name, status: 'created', agentId: agent.id, notes });
      } catch (e: any) {
        result.bots.push({ key: p.id, name: p.name, status: 'error', error: e?.message || String(e), notes });
      }
    }

    // 4. Scheduled jobs → routines, always switched off (nothing runs twice next to Hermes).
    const engine = this.ctx.services.routines?.engine;
    const existingRoutines = new Set<string>();
    if (engine) for (const r of engine.routinesOf(userId)) existingRoutines.add(`${r.agent_id}|${r.name}`);
    for (const p of snap.profiles)
      for (const j of p.jobs) {
        if (!routineKeys.has(j.key)) continue;
        const agentId = agentIdByProfile.get(p.id);
        const row = { key: j.key, name: j.name, bot: p.name };
        if (!engine) {
          result.routines.push({ ...row, status: 'error', error: 'De routinemodule staat niet aan.' });
          continue;
        }
        if (!agentId) {
          result.routines.push({ ...row, status: 'skipped', error: 'De bot van deze taak is niet overgenomen.' });
          continue;
        }
        if (existingRoutines.has(`${agentId}|${j.name}`)) {
          result.routines.push({ ...row, status: 'skipped', error: 'Bestond al.' });
          continue;
        }
        const m = mapHermesSchedule(j.schedule, this.tz(p));
        if ('error' in m || !j.prompt) {
          result.routines.push({ ...row, status: 'error', error: 'error' in m ? m.error : 'Deze taak heeft geen opdracht.' });
          continue;
        }
        try {
          const created = engine.create(userId, { name: j.name, agent_id: agentId, prompt: j.prompt, timezone: this.tz(p), schedule: m.schedule, options: { missedPolicy: 'skip' } }, { status: 'paused', allowPastOnce: true });
          engine.setStatus(created, 'paused', PAUSE_REASON, 'system');
          existingRoutines.add(`${agentId}|${j.name}`);
          ledger.routines.push(created.id);
          result.routines.push({ ...row, status: 'created', routineId: created.id });
        } catch (e: any) {
          result.routines.push({ ...row, status: 'error', error: e?.message || String(e) });
        }
      }

    // 5. Memories: the agent's notes (MEMORY.md) for its bot, what it knows about you (USER.md) under "Over jou".
    //    In Hermes both are always in the prompt, so they come pinned. Secrets are still refused by the pipeline.
    const svc = this.ctx.services.memory?.svc;
    if (memMode !== 'off' && svc) {
      const { writeCandidate } = await import('../memory/pipeline.js');
      const gen = Number(this.state(userId).generation) || 0;
      const hash = (s: string) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 20);
      const write = (content: string, scope: 'agent' | 'about_you', agentId: string | null, key: string) => {
        try {
          const out = writeCandidate(svc, {
            userId,
            content,
            scope,
            ...(agentId ? { agentId } : {}),
            source: { kind: 'import', ref: 'hermes', trust: 'import' },
            origin: 'import',
            createdBy: 'import',
            pinned: true,
            ...(memMode === 'review' ? { forcePropose: true, proposalReason: 'import' } : { userApproved: true }),
            idemKey: `hermes:g${gen}:${key}:${hash(content)}`,
          } as any);
          if (out.action === 'inserted' || out.action === 'superseded') result.memories.imported++;
          else if (out.action === 'proposed' || out.action === 'conflict') result.memories.proposed++;
          else if (out.action === 'duplicate') result.memories.duplicates++;
          else {
            result.memories.failed++;
            result.memories.reasons[out.reason] = (result.memories.reasons[out.reason] || 0) + 1;
          }
          if (scope === 'about_you' && out.item?.id && out.action !== 'duplicate') ledger.memories.push(out.item.id);
        } catch {
          result.memories.failed++;
          result.memories.reasons.error = (result.memories.reasons.error || 0) + 1;
        }
      };
      const facts = new Set<string>();
      for (const p of snap.profiles) {
        const agentId = agentIdByProfile.get(p.id);
        if (agentId && wantBots.has(p.id)) for (const m of p.memories) write(m, 'agent', agentId, `${p.id}:memory`);
        if (wantBots.has(p.id)) for (const f of p.userFacts) facts.add(f);
      }
      for (const f of facts) write(f, 'about_you', null, 'user');
      if (result.memories.proposed) result.attention.push({ level: 'info', text: result.memories.proposed === 1 ? '1 herinnering staat klaar ter controle onder Geheugen → Te beoordelen.' : `${result.memories.proposed} herinneringen staan klaar ter controle onder Geheugen → Te beoordelen (in één keer goed te keuren).` });
      const why: Record<string, string> = { quota: 'het maximum aantal open voorstellen of het quotum is bereikt (beoordeel eerst en lees daarna opnieuw in)', secret: 'ze lijken op een wachtwoord of sleutel', injection: 'ze lijken op een instructie uit een externe bron', forgotten: 'ze zijn eerder bewust vergeten', rejected_before: 'je hebt ze eerder afgewezen' };
      for (const [reason, n] of Object.entries(result.memories.reasons)) result.attention.push({ level: 'warn', text: n === 1 ? `1 herinnering niet overgenomen: ${why[reason] || reason}.` : `${n} herinneringen niet overgenomen: ${why[reason] || reason}.` });
    }

    const createdRoutines = result.routines.filter((r) => r.status === 'created');
    if (createdRoutines.length) result.attention.unshift({ level: 'warn', text: createdRoutines.length === 1 ? '1 routine staat uit. Zet hem aan wanneer je Hermes stopt, anders draait hij dubbel.' : `${createdRoutines.length} routines staan uit. Zet ze aan wanneer je Hermes stopt, anders draaien ze dubbel.` });
    const summary = {
      at: new Date().toISOString(),
      source: snap.home,
      counts: {
        bots: result.bots.filter((b) => b.status === 'created').length,
        routines: createdRoutines.length,
        skills: result.skills.filter((s) => ['created', 'updated', 'version-added', 'unchanged'].includes(s.status)).length,
        memories: result.memories.imported + result.memories.proposed,
        providers: result.providers.filter((p) => p.status === 'linked').length,
      },
      ...result,
      routinesOff: createdRoutines.map((r) => ({ name: r.name, bot: r.bot })),
    };
    const before = this.ledger(userId);
    const all: HermesLedger = { ...mergeLedger(before, ledger), memories: [...new Set([...(before.memories || []), ...ledger.memories])] };
    this.setState(userId, { last: summary, ledger: { ...all, at: summary.at } });
    this.ctx.audit(userId, 'hermes.imported', summary.counts);
    this.stagings.delete(st.id);
    return { ...summary, undo: this.undoAvailable(userId) };
  }

  // ---------------- undo ----------------

  undoAvailable(userId: string): boolean {
    const l = this.ledger(userId);
    return !!(l.agents.length || l.routines.length || l.skills.length || l.providers.length || l.memories.length);
  }

  private liveMemories(userId: string, l: HermesLedger): string[] {
    if (!l.memories.length || !this.ctx.services.memory?.svc) return [];
    return l.memories.filter((id) => this.ctx.store.one("SELECT 1 FROM memory_items WHERE id = ? AND user_id = ? AND status IN ('active','proposed','archived')", id, userId));
  }

  undoPlan(userId: string) {
    const l = this.ledger(userId);
    const plan = undoPlan(this.ctx, userId, l);
    const memories = this.liveMemories(userId, l).length;
    return {
      ...plan,
      available: plan.available || memories > 0,
      memories,
      notes: [
        'Hermes zelf blijft precies zoals het is.',
        'Gesprekken die je sinds de import met deze bots had, worden ook verwijderd; hun herinneringen en wat de import onder Over jou zette, gaan naar de prullenbak (Geheugen).',
      ],
    };
  }

  async undo(userId: string) {
    const l = this.ledger(userId);
    if (!this.undoAvailable(userId)) throw new HttpError(400, 'Er is geen import om ongedaan te maken.');
    // No team data, team or main bot comes from Hermes, so the undo only removes bots, routines, skills and links.
    const res = await undoImport(this.ctx, userId, { ...l, teams: [], tables: [], teamRows: 0, main: null, legacyFolder: null }, { dataDir: this.home(), home: this.home() }, { teamData: false, from: 'hermes-undo' });
    const svc = this.ctx.services.memory?.svc;
    let memories = 0;
    if (svc)
      for (const id of this.liveMemories(userId, l)) {
        const before = svc.snapshot('item', id);
        svc.patchItem(id, { status: 'trashed', trashed_at: new Date().toISOString(), pinned: false });
        svc.recordChange({ userId, kind: 'item', recordId: id, op: 'trash', before, after: svc.snapshot('item', id), summary: `Naar prullenbak (import ongedaan gemaakt): ${svc.label(before)}`, actor: 'system' });
        memories++;
      }
    if (memories) svc?.emit(userId, { op: 'trash', ids: l.memories });
    const state = this.state(userId);
    this.setState(userId, { ledger: { ...emptyLedger(), memories: [] }, generation: (Number(state.generation) || 0) + 1, last: state.last ? { ...state.last, undone: new Date().toISOString() } : state.last });
    this.ctx.audit(userId, 'hermes.undone', { bots: res.bots, routines: res.routines, skills: res.skills, providers: res.providers, memories });
    return { ...res, memories };
  }
}
