import os from 'node:os';
import crypto from 'node:crypto';
import { encodeFace, traitsFor } from '../../../shared/botface.js';
import type { Agent, Ctx } from '../../core/types.js';
import { HttpError, ah, requireRole, user } from '../../core/http.js';
import { isRestricted } from '../../api/member-policy.js';
import { filesFromDir, findSkillRoots, subset } from '../skills/files.js';
import { parseImport } from '../memory/io.js';
import { colorFor } from './mapping.js';
import { type OcSnapshot, type OpenClawPaths, defaultOpenClawPaths, detectOpenClaw, mapOcSchedule, ocPrompt, readOpenClaw } from './openclaw-reader.js';

/**
 * "Overstappen uit OpenClaw" (0.4.4, item 13): the owner's own OpenClaw on this computer becomes TeamBot bots. Same
 * shape as the OpenBot import next to it (preview that writes nothing, one import, undo), in its own files so the two
 * stay apart:
 *  - per OpenClaw agent a bot: name (IDENTITY.md or the config), instructions from AGENTS.md plus the persona of SOUL.md,
 *    the model, and the engine when the owner already connected one of that family (never a key);
 *  - USER.md becomes proposals for "Over jou", MEMORY.md proposals in the bot's memory (Geheugen › Te beoordelen);
 *  - skills go through the regular importer (scan, publisher policy) and stay switched off;
 *  - scheduled jobs become routines that stay off; commands and scripts are never taken over;
 *  - keys, tokens, channel accounts and conversations never come along. OpenClaw itself is never changed.
 *
 *   GET  /api/openbot-import/openclaw/detect
 *   POST /api/openbot-import/openclaw/preview                 → plan (stagingId, 30 min)
 *   POST /api/openbot-import/openclaw/commit  { stagingId, bots?, skills?, routines?, memories?: 'review'|'off' }
 *   GET  /api/openbot-import/openclaw/undo   (what would go)   POST …/undo (do it)
 */

const TTL = 30 * 60_000;
const PAUSE_REASON = 'Overgenomen uit OpenClaw en uitgezet, zodat niets dubbel draait. Zet aan wanneer je OpenClaw stopt.';

/** Model family prefix in OpenClaw ("anthropic/claude-…") → TeamBot engine kinds that serve it, best first. */
const FAMILY_KINDS: Record<string, string[]> = {
  anthropic: ['anthropic', 'claude-code'],
  openai: ['openai', 'codex-cli'],
  'openai-codex': ['codex-cli', 'openai'],
  codex: ['codex-cli', 'openai'],
  google: ['gemini', 'gemini-cli'],
  gemini: ['gemini', 'gemini-cli'],
  'google-gemini-cli': ['gemini-cli', 'gemini'],
  openrouter: ['openrouter'],
  ollama: ['ollama'],
  lmstudio: ['lmstudio'],
  deepseek: ['deepseek'],
  groq: ['groq'],
  mistral: ['mistral'],
  xai: ['xai'],
  opencode: ['opencode'],
};

interface Ledger {
  agents: string[];
  routines: string[];
  skills: string[];
  memoryRefs: string[];
}
const emptyLedger = (): Ledger => ({
  agents: [],
  routines: [],
  skills: [],
  memoryRefs: [],
});

interface Staging {
  id: string;
  userId: string;
  at: number;
  snap: OcSnapshot;
  skillStagingId: string | null;
  skillKeys: Map<string, string>;
  skillScan: Map<string, { level: string; action: string; errors: string[] }>;
}

export class OpenClawImport {
  private stagings = new Map<string, Staging>();
  constructor(
    private ctx: Ctx,
    private paths: () => OpenClawPaths,
  ) {}

  private state(userId: string): any {
    return this.ctx.store.getSetting<any>(userId, 'openclawImport', {}) || {};
  }
  private setState(userId: string, patch: any) {
    this.ctx.store.setSetting(userId, 'openclawImport', {
      ...this.state(userId),
      ...patch,
    });
  }
  ledger(userId: string): Ledger {
    return { ...emptyLedger(), ...(this.state(userId).ledger || {}) };
  }
  detect(userId: string) {
    const d = detectOpenClaw(this.paths());
    const st = this.state(userId);
    return {
      ...d,
      imported: st.last ? { at: st.last.at, counts: st.last.counts } : null,
      undoable: this.undoAvailable(userId),
    };
  }

  /** Bots of an earlier OpenClaw import, by OpenClaw agent id. */
  private imported(userId: string): Map<string, Agent> {
    const m = new Map<string, Agent>();
    for (const a of this.ctx.store.agents(userId, { archived: true })) if (a.settings?.importedFrom?.app === 'openclaw' && a.settings.importedFrom.id) m.set(String(a.settings.importedFrom.id), a);
    return m;
  }

  /** The owner's engine for an OpenClaw model ("anthropic/claude-sonnet-4-6"), never a key. */
  private engineFor(
    userId: string,
    model: string,
  ): {
    providerId: string | null;
    kind: string | null;
    family: string;
    model: string;
    label: string;
  } {
    const [fam, ...rest] = String(model || '').split('/');
    const family = rest.length ? fam.toLowerCase() : '';
    const m = rest.length ? rest.join('/') : String(model || '');
    const kinds = FAMILY_KINDS[family] || [];
    for (const k of kinds) {
      const cfg = this.ctx.providers.list(userId).find((p) => p.kind === k && p.enabled && this.ctx.providers.canUse(userId, p));
      if (cfg)
        return {
          providerId: cfg.id,
          kind: k,
          family,
          model: m,
          label: cfg.name,
        };
    }
    return {
      providerId: null,
      kind: kinds[0] || null,
      family,
      model: m,
      label: kinds[0] ? this.ctx.providers.kind(kinds[0])?.label || kinds[0] : family || 'onbekend',
    };
  }

  private sweep() {
    const t = Date.now();
    for (const [id, s] of this.stagings) if (t - s.at > TTL) this.stagings.delete(id);
  }
  private get(userId: string, id: unknown): Staging {
    this.sweep();
    const s = this.stagings.get(String(id || ''));
    if (!s || s.userId !== userId) throw new HttpError(404, 'Deze voorvertoning is verlopen. Lees OpenClaw opnieuw in.');
    return s;
  }

  private stageSkills(userId: string, st: Staging) {
    const importer = this.ctx.services.skills?.importer;
    if (!importer) return;
    const items: any[] = [];
    const names: string[] = [];
    const seen = new Set<string>();
    for (const sk of [...st.snap.sharedSkills, ...st.snap.agents.flatMap((a) => a.skills)]) {
      if (seen.has(sk.name)) continue;
      seen.add(sk.name);
      try {
        const files = filesFromDir(sk.dir);
        const roots = findSkillRoots(files);
        items.push({
          files: subset(files, '', roots),
          root: sk.name,
          source: {
            type: 'discover',
            label: `OpenClaw: ${sk.name}`,
            path: sk.dir,
          },
          fallbackName: sk.name,
        });
        names.push(sk.name);
      } catch (e: any) {
        st.skillScan.set(sk.name, {
          level: 'error',
          action: 'error',
          errors: [e?.message || String(e)],
        });
      }
    }
    if (!items.length) return;
    const staging = importer.stage(userId, 'OpenClaw', items);
    st.skillStagingId = staging.id;
    importer.view(userId, staging).candidates.forEach((c: any, i: number) => {
      st.skillKeys.set(names[i], c.key);
      st.skillScan.set(names[i], {
        level: c.scan?.level || 'ok',
        action: c.action,
        errors: c.errors || [],
      });
    });
  }

  preview(userId: string) {
    const p = this.paths();
    if (!detectOpenClaw(p).found) throw new HttpError(404, `OpenClaw is niet gevonden op deze computer (gezocht in ${p.stateDir}).`);
    const snap = readOpenClaw(p, os.tmpdir());
    const st: Staging = {
      id: 'ocs_' + crypto.randomBytes(9).toString('hex'),
      userId,
      at: Date.now(),
      snap,
      skillStagingId: null,
      skillKeys: new Map(),
      skillScan: new Map(),
    };
    this.stageSkills(userId, st);
    this.sweep();
    this.stagings.set(st.id, st);
    return this.view(st);
  }

  private view(st: Staging) {
    const { snap } = st;
    const imported = this.imported(st.userId);
    const bots = snap.agents.map((a) => {
      const e = this.engineFor(st.userId, a.model);
      const existing = imported.get(a.id) || null;
      return {
        key: a.id,
        name: a.name,
        emoji: a.emoji,
        model: a.model,
        engine: {
          label: e.label,
          linked: !!e.providerId,
          note: e.providerId ? `Gekoppeld aan ${e.label}.` : a.model ? `Koppel ${e.label} bij AI-providers en kies daarna de engine van de bot.` : 'Geen model in OpenClaw; kies zelf een engine.',
        },
        workspace: a.workspace,
        workspaceExists: a.workspaceExists,
        instructions: {
          chars: a.instructions.length,
          files: a.instructionFiles,
        },
        memories: a.memory ? parseImport(a.memory).length : 0,
        dailyLogs: a.dailyLogs,
        skills: a.skills.map((s) => s.name),
        routines: snap.jobs.filter((j) => j.agentId === a.id).length,
        existing: existing ? { id: existing.id, name: existing.name } : null,
        selected: !existing,
      };
    });
    const aboutYou = snap.agents.reduce((n, a) => n + (a.userFacts ? parseImport(a.userFacts).length : 0), 0);
    const skills = [...new Set([...snap.sharedSkills, ...snap.agents.flatMap((a) => a.skills)].map((s) => s.name))].map((name) => {
      const scan = st.skillScan.get(name);
      const users = snap.agents.filter((a) => a.skills.some((s) => s.name === name)).map((a) => a.name);
      return {
        name,
        shared: snap.sharedSkills.some((s) => s.name === name),
        bots: users,
        scan: scan?.level || 'unknown',
        action: scan?.action || 'error',
        errors: scan?.errors || [],
        selected: !!scan && scan.action !== 'error' && !scan.errors?.length,
      };
    });
    const routines = snap.jobs.map((j) => {
      const s = mapOcSchedule(j.schedule);
      const pr = ocPrompt(j.payload);
      const bot = snap.agents.find((a) => a.id === j.agentId)?.name || j.agentId;
      const error = 'error' in s ? s.error : 'error' in pr ? pr.error : '';
      return {
        key: j.id,
        name: j.name,
        bot,
        wasOn: j.enabled,
        schedule: 'error' in s ? '' : s.label,
        prompt: 'error' in pr ? '' : pr.prompt.slice(0, 200),
        error,
        selected: !error,
      };
    });
    const notImported = [
      'Gesprekken: die blijven in OpenClaw (schone start).',
      'Sleutels, tokens en wachtwoorden: nooit. Koppel je AI en apps opnieuw in TeamBot.',
      snap.seen.channels.length ? `Kanalen (${snap.seen.channels.join(', ')}): koppel ze opnieuw onder Instellingen › Kanalen.` : 'Kanalen: koppel ze opnieuw onder Instellingen › Kanalen.',
      ...(snap.seen.dailyLogs ? [`Het dagboek van OpenClaw (memory/…md, ${snap.seen.dailyLogs} dagen): blijft in OpenClaw.`] : []),
      'Geplande taken die een opdracht of script uitvoeren, en HEARTBEAT.md, TOOLS.md en BOOTSTRAP.md.',
    ];
    return {
      stagingId: st.id,
      dir: snap.paths.stateDir,
      bots,
      aboutYou,
      skills,
      routines,
      notImported,
      warnings: snap.warnings,
      memoryAvailable: !!this.ctx.services.memory?.svc,
      undo: this.undoAvailable(st.userId),
    };
  }

  async commit(userId: string, body: any) {
    const st = this.get(userId, body?.stagingId);
    const { snap } = st;
    const want = (list: any, all: string[]) => (Array.isArray(list) ? new Set(list.map(String)) : new Set(all));
    const plan = this.view(st);
    const botKeys = want(
      body?.bots,
      plan.bots.filter((b) => b.selected).map((b) => b.key),
    );
    const skillNames = want(
      body?.skills,
      plan.skills.filter((s) => s.selected).map((s) => s.name),
    );
    const routineKeys = want(
      body?.routines,
      plan.routines.filter((r) => r.selected).map((r) => r.key),
    );
    const memories = body?.memories === 'off' ? 'off' : 'review';
    const ledger = emptyLedger();
    const gen = Number(this.state(userId).generation) || 0;
    const result: any = {
      bots: [],
      skills: [],
      routines: [],
      memories: { proposed: 0, duplicates: 0, failed: 0 },
      attention: [] as string[],
    };
    const imported = this.imported(userId);

    // 1. Skills through the regular importer (scan, publisher policy), then switched off: the owner turns them on.
    const lib = this.ctx.services.skills?.library;
    const skillIdByName = new Map<string, string>();
    const keys = [...skillNames].map((n) => st.skillKeys.get(n)).filter((k): k is string => !!k);
    if (keys.length && st.skillStagingId && this.ctx.services.skills?.importer) {
      try {
        const r = this.ctx.services.skills.importer.commit(userId, st.skillStagingId, {
          keys,
          acknowledge: body?.acknowledgeSkills === true,
          createdBy: 'openclaw-import',
        });
        for (const x of r.results) {
          if (x.skillId && ['created', 'updated', 'version-added', 'unchanged'].includes(x.status)) skillIdByName.set(x.name, x.skillId);
          if (x.skillId && x.status === 'created') {
            ledger.skills.push(x.skillId);
            const s = lib?.get(userId, x.skillId);
            if (s && s.status === 'active') lib!.setStatus(s, 'disabled');
          }
          result.skills.push({
            name: x.name,
            status: x.status,
            error: x.error || null,
          });
        }
      } catch (e: any) {
        result.attention.push(`Skills: ${e?.message || String(e)}`);
      }
    }

    // 2. Bots (one per OpenClaw agent), with the skills attached but switched off.
    const agentIdByOc = new Map<string, string>();
    for (const [k, a] of imported) agentIdByOc.set(k, a.id);
    for (const a of snap.agents) {
      if (!botKeys.has(a.id)) continue;
      if (imported.has(a.id)) {
        result.bots.push({
          key: a.id,
          name: a.name,
          status: 'skipped',
          note: 'Was al overgenomen.',
        });
        continue;
      }
      try {
        const e = this.engineFor(userId, a.model);
        const skills = a.skills.map((s) => skillIdByName.get(s.name)).filter((x): x is string => !!x);
        const agent = this.ctx.store.createAgent(userId, {
          id: 'ag_' + crypto.randomBytes(9).toString('hex'),
          name: a.name,
          description: a.emoji ? `${a.emoji} Overgenomen uit OpenClaw` : 'Overgenomen uit OpenClaw',
          instructions: a.instructions,
          color: colorFor(a.id, null),
          avatar: encodeFace(traitsFor(`openclaw:${a.id}`)),
          provider_id: e.providerId,
          model: e.model || undefined,
          access_mode: 'ask',
          skills,
          ...(a.workspaceExists ? { workspace: a.workspace } : {}),
          settings: {
            importedFrom: {
              app: 'openclaw',
              id: a.id,
              at: new Date().toISOString(),
              model: a.model,
              workspace: a.workspaceExists ? 'reference' : 'new',
              files: a.instructionFiles,
            },
          },
        } as any);
        ledger.agents.push(agent.id);
        agentIdByOc.set(a.id, agent.id);
        this.ctx.audit(userId, 'agent.imported', { from: 'openclaw', name: agent.name, skills: skills.length }, agent.id);
        this.ctx.events.emit(userId, 'agent.updated', agent);
        result.bots.push({
          key: a.id,
          name: agent.name,
          status: 'created',
          agentId: agent.id,
          engine: e.providerId ? e.label : null,
        });
        if (!e.providerId) result.attention.push(`${agent.name}: kies een engine (${e.label} is nog niet gekoppeld).`);
      } catch (err: any) {
        result.bots.push({
          key: a.id,
          name: a.name,
          status: 'error',
          error: err?.message || String(err),
        });
      }
    }

    // 3. Routines, always off (nothing runs twice next to OpenClaw).
    const engine = this.ctx.services.routines?.engine;
    for (const j of snap.jobs) {
      if (!routineKeys.has(j.id)) continue;
      const botName = snap.agents.find((a) => a.id === j.agentId)?.name || j.agentId;
      const agentId = agentIdByOc.get(j.agentId);
      const s = mapOcSchedule(j.schedule);
      const pr = ocPrompt(j.payload);
      if (!engine)
        result.routines.push({
          key: j.id,
          name: j.name,
          bot: botName,
          status: 'error',
          error: 'De routinemodule staat niet aan.',
        });
      else if (!agentId)
        result.routines.push({
          key: j.id,
          name: j.name,
          bot: botName,
          status: 'skipped',
          error: 'De bot van deze taak is niet overgenomen.',
        });
      else if ('error' in s || 'error' in pr)
        result.routines.push({
          key: j.id,
          name: j.name,
          bot: botName,
          status: 'skipped',
          error: 'error' in s ? s.error : (pr as any).error,
        });
      else if (engine.routinesOf(userId).some((r: any) => r.agent_id === agentId && r.name === j.name))
        result.routines.push({
          key: j.id,
          name: j.name,
          bot: botName,
          status: 'skipped',
          error: 'Bestond al.',
        });
      else {
        try {
          const created = engine.create(
            userId,
            {
              name: j.name,
              agent_id: agentId,
              prompt: pr.prompt,
              timezone: j.timezone || undefined,
              schedule: s.schedule,
              options: { missedPolicy: 'skip' },
            },
            { status: 'paused', allowPastOnce: true },
          );
          engine.setStatus(created, 'paused', PAUSE_REASON, 'system');
          ledger.routines.push(created.id);
          result.routines.push({
            key: j.id,
            name: j.name,
            bot: botName,
            status: 'created',
            routineId: created.id,
          });
        } catch (e: any) {
          result.routines.push({
            key: j.id,
            name: j.name,
            bot: botName,
            status: 'error',
            error: e?.message || String(e),
          });
        }
      }
    }

    // 4. Memory: USER.md → proposals for "Over jou", MEMORY.md → proposals in the bot's memory. Never active right away.
    const svc = this.ctx.services.memory?.svc;
    if (memories !== 'off' && svc) {
      const { writeCandidate } = await import('../memory/pipeline.js');
      const ref = `openclaw:g${gen}`;
      ledger.memoryRefs.push(ref);
      const write = (content: string, scope: 'about_you' | 'agent', agentId: string | null, type?: any) => {
        try {
          const out = writeCandidate(svc, {
            userId,
            content,
            scope,
            agentId,
            type,
            source: { kind: 'import', ref, trust: 'import' },
            origin: 'import',
            createdBy: 'import',
            forcePropose: true,
            proposalReason: 'import',
            idemKey: `openclaw:g${gen}:${scope}:${agentId || ''}:${svc.hmac(userId, content, 20)}`,
          });
          if (out.action === 'proposed' || out.action === 'conflict') result.memories.proposed++;
          else if (out.action === 'duplicate') result.memories.duplicates++;
          else result.memories.failed++;
        } catch {
          result.memories.failed++;
        }
      };
      for (const a of snap.agents) {
        if (!botKeys.has(a.id)) continue;
        for (const p of a.userFacts ? parseImport(a.userFacts) : []) write(p.content, 'about_you', null, p.type);
        const agentId = agentIdByOc.get(a.id);
        if (agentId) for (const p of a.memory ? parseImport(a.memory) : []) write(p.content, 'agent', agentId, p.type);
      }
      if (result.memories.proposed)
        result.attention.push(
          result.memories.proposed === 1
            ? '1 herinnering staat klaar ter controle onder Geheugen › Te beoordelen.'
            : `${result.memories.proposed} herinneringen staan klaar ter controle onder Geheugen › Te beoordelen.`,
        );
    }
    const off = result.routines.filter((r: any) => r.status === 'created').length;
    if (off)
      result.attention.unshift(
        off === 1
          ? '1 routine staat uit. Zet hem aan wanneer je OpenClaw stopt, anders draait hij dubbel.'
          : `${off} routines staan uit. Zet ze aan wanneer je OpenClaw stopt, anders draaien ze dubbel.`,
      );
    const skillsOff = ledger.skills.length;
    if (skillsOff)
      result.attention.push(
        skillsOff === 1
          ? '1 skill staat uit. Zet hem aan onder Marktplaats › Mijn skills als je hem vertrouwt.'
          : `${skillsOff} skills staan uit. Zet ze aan onder Marktplaats › Mijn skills als je ze vertrouwt.`,
      );

    const counts = {
      bots: result.bots.filter((b: any) => b.status === 'created').length,
      routines: off,
      skills: skillsOff,
      memories: result.memories.proposed,
    };
    const prev = this.ledger(userId);
    const all: Ledger = {
      agents: [...prev.agents, ...ledger.agents],
      routines: [...prev.routines, ...ledger.routines],
      skills: [...prev.skills, ...ledger.skills],
      memoryRefs: [...new Set([...prev.memoryRefs, ...ledger.memoryRefs])],
    };
    const summary = {
      at: new Date().toISOString(),
      source: snap.paths.stateDir,
      counts,
    };
    this.setState(userId, { last: summary, ledger: all });
    this.ctx.audit(userId, 'openclaw.imported', counts);
    this.stagings.delete(st.id);
    return { ...summary, ...result, undo: this.undoAvailable(userId) };
  }

  undoAvailable(userId: string): boolean {
    const l = this.ledger(userId);
    return l.agents.some((id) => this.ctx.store.agent(id)?.user_id === userId) || l.routines.length > 0 || l.skills.length > 0 || this.memoryItems(userId, l).length > 0;
  }

  private memoryItems(userId: string, l: Ledger) {
    if (!l.memoryRefs.length) return [];
    return this.ctx.store.all<any>(
      `SELECT id FROM memory_items WHERE user_id = ? AND source_kind = 'import' AND source_ref IN (${l.memoryRefs.map(() => '?').join(',')}) AND status IN ('proposed','active','archived')`,
      userId,
      ...l.memoryRefs,
    );
  }

  undoPlan(userId: string) {
    const l = this.ledger(userId);
    const engine = this.ctx.services.routines?.engine;
    const lib = this.ctx.services.skills?.library;
    return {
      bots: l.agents
        .map((id) => this.ctx.store.agent(id))
        .filter((a): a is Agent => !!a && a.user_id === userId)
        .map((a) => a.name),
      routines: engine ? l.routines.filter((id) => engine.routine(id)).length : 0,
      skills: lib ? l.skills.map((id) => lib.get(userId, id)?.name).filter(Boolean) : [],
      memories: this.memoryItems(userId, l).length,
    };
  }

  async undo(userId: string) {
    const l = this.ledger(userId);
    const engine = this.ctx.services.routines?.engine;
    let routines = 0;
    if (engine)
      for (const id of l.routines) {
        const r = engine.routine(id);
        if (r && r.user_id === userId) {
          engine.remove(r);
          routines++;
        }
      }
    // Memory first (the bots' own memories go with the bots too, but "Over jou" stays otherwise).
    let memories = 0;
    const svc = this.ctx.services.memory?.svc;
    if (svc) {
      const { undoImportItems } = await import('../memory/assistant-import.js');
      memories = undoImportItems(svc, userId, this.memoryItems(userId, l)).removed;
    }
    let bots = 0;
    for (const id of l.agents) {
      const a = this.ctx.store.agent(id);
      if (!a || a.user_id !== userId) continue;
      for (const r of this.ctx.store.all<{ id: string }>("SELECT id FROM runs WHERE agent_id = ? AND status IN ('queued','running','waiting')", a.id))
        this.ctx.runs.cancel(r.id, 'Import ongedaan gemaakt');
      for (const h of this.ctx.hooks.agentDeleted) {
        try {
          h({ agentId: a.id, userId });
        } catch (e) {
          this.ctx.log.error(e);
        }
      }
      // The bot's workspace is OpenClaw's own folder: never deleted.
      this.ctx.store.deleteAgent(a.id);
      this.ctx.audit(userId, 'agent.deleted', { name: a.name, filesDeleted: false, from: 'openclaw-undo' }, a.id);
      this.ctx.events.emit(userId, 'agent.deleted', { id: a.id });
      bots++;
    }
    const lib = this.ctx.services.skills?.library;
    let skills = 0;
    const kept: string[] = [];
    if (lib)
      for (const id of l.skills) {
        const s = lib.get(userId, id);
        if (!s) continue;
        if (this.ctx.store.agents(userId, { archived: true }).some((a) => (a.skills || []).includes(id))) {
          kept.push(s.name);
          continue;
        }
        lib.remove(s);
        this.ctx.audit(userId, 'skill.deleted', {
          skill: s.name,
          from: 'openclaw-undo',
        });
        this.ctx.events.emit(userId, 'skills.deleted', { id: s.id });
        skills++;
      }
    const st = this.state(userId);
    this.setState(userId, {
      ledger: {
        ...emptyLedger(),
        skills: l.skills.filter((id) => lib?.get(userId, id)),
      },
      generation: (Number(st.generation) || 0) + 1,
      last: st.last ? { ...st.last, undone: new Date().toISOString() } : null,
    });
    this.ctx.audit(userId, 'openclaw.import_undone', {
      bots,
      routines,
      skills,
      memories,
    });
    return { bots, routines, skills, memories, kept };
  }
}

/** The routes (owner only, like the OpenBot import: it reads folders on this computer). */
export function openClawRoutes(ctx: Ctx, paths: () => OpenClawPaths = defaultOpenClawPaths) {
  const svc = new OpenClawImport(ctx, paths);
  ctx.services.openclawImport = svc;
  const api = ctx.api;
  api.get(
    '/openbot-import/openclaw/detect',
    ah(async (req) => {
      const u = user(req);
      if (u.role !== 'owner' || isRestricted(ctx, u)) return { available: false, found: false };
      return { available: true, ...svc.detect(u.id) };
    }),
  );
  api.post(
    '/openbot-import/openclaw/preview',
    ah(async (req) => svc.preview(requireRole(req, 'owner').id)),
  );
  api.post(
    '/openbot-import/openclaw/commit',
    ah(async (req) => svc.commit(requireRole(req, 'owner').id, req.body || {})),
  );
  api.get(
    '/openbot-import/openclaw/undo',
    ah(async (req) => svc.undoPlan(requireRole(req, 'owner').id)),
  );
  api.post(
    '/openbot-import/openclaw/undo',
    ah(async (req) => svc.undo(requireRole(req, 'owner').id)),
  );
  return svc;
}
