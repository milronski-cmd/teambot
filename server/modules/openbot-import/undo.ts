import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx } from '../../core/types.js';
import { isInside as inside } from '../../tools/builtin/files.js';
import type { OpenBotPaths } from './reader.js';
import { type TeamFolderLike, mainBotBridge, teamDataBridge, teamsBridge } from './bridges.js';

/**
 * "Import ongedaan maken": everything the OpenBot imports made, kept in a ledger (user setting `openbotImport.ledger`)
 * and removed again on request: the bots (with their routines, conversations and memories), the team the import made,
 * the team lead and main bot it set, skills and engine links nobody else uses, the shared folder it set and the team
 * table rows it copied. OpenBot itself is never touched: a bot's workspace that points to an OpenBot folder stays.
 */

export interface LedgerTeam {
  id: string;
  /** The import made this team (then it goes when it is empty again). */
  created: boolean;
  /** The import set (or widened) this team's folder; `folderBefore` is what it was. */
  folderSet: boolean;
  folderBefore: TeamFolderLike | null;
  /** The bot the import made team lead. */
  leadSet: string | null;
}

export interface Ledger {
  teams: LedgerTeam[];
  agents: string[];
  routines: string[];
  /** Skills the import created (not ones that existed before). */
  skills: string[];
  /** Engine links the import made. */
  providers: string[];
  /** Team tables the import created (dropped again when empty). */
  tables: { name: string; owner: { type: 'agent' | 'system'; id: string; name: string }; teamId: string | null }[];
  teamRows: number;
  main: string | null;
  /** Without the teams module: the single team folder setting the import set, and what it was before. */
  legacyFolder: { path: string; before: any } | null;
  /** Channels the import made (switched off, without token). */
  channels: string[];
  /** Per routine the import made: was it on in OpenBot, does it handle customer messages (for "zet de routines aan"). */
  routineMeta: Record<string, { on: boolean; customer: boolean; ob?: string }>;
  at?: string;
}

export const emptyLedger = (): Ledger => ({ teams: [], agents: [], routines: [], skills: [], providers: [], tables: [], teamRows: 0, main: null, legacyFolder: null, channels: [], routineMeta: {} });

const union = (a: string[], b: string[]) => [...new Set([...(a || []), ...(b || [])])];

/** Add what one import made to what earlier imports made (undo removes all of it). */
export function mergeLedger(a: Ledger, b: Ledger): Ledger {
  const teams = new Map<string, LedgerTeam>();
  for (const t of a.teams || []) teams.set(t.id, { ...t });
  for (const t of b.teams || []) {
    const cur = teams.get(t.id);
    if (!cur) teams.set(t.id, { ...t });
    else teams.set(t.id, { id: t.id, created: cur.created || t.created, folderSet: cur.folderSet || t.folderSet, folderBefore: cur.folderSet ? cur.folderBefore : t.folderBefore, leadSet: t.leadSet ?? cur.leadSet });
  }
  const tables = [...(a.tables || [])];
  for (const t of b.tables || []) if (!tables.some((x) => x.name === t.name && x.teamId === t.teamId)) tables.push(t);
  return {
    teams: [...teams.values()],
    agents: union(a.agents, b.agents),
    routines: union(a.routines, b.routines),
    skills: union(a.skills, b.skills),
    providers: union(a.providers, b.providers),
    tables,
    teamRows: (a.teamRows || 0) + (b.teamRows || 0),
    main: b.main ?? a.main ?? null,
    legacyFolder: a.legacyFolder ?? b.legacyFolder ?? null,
    channels: union(a.channels, b.channels),
    routineMeta: { ...(a.routineMeta || {}), ...(b.routineMeta || {}) },
  };
}

const norm = (p: string) => {
  const r = path.resolve(p);
  return process.platform === 'win32' ? r.toLowerCase() : r;
};

function own(ctx: Ctx, userId: string, id: string): Agent | null {
  const a = ctx.store.agent(id);
  return a && a.user_id === userId ? a : null;
}

/** Bots that remain after the undo use this engine link (main engine or a reserve). */
function providerInUse(ctx: Ctx, userId: string, providerId: string, gone: Set<string>) {
  return ctx.store
    .agents(userId, { archived: true })
    .filter((a) => !gone.has(a.id))
    .some((a) => a.provider_id === providerId || a.fallback?.provider_id === providerId || (Array.isArray(a.settings?.fallbacks) && a.settings.fallbacks.some((f: any) => f?.provider_id === providerId)));
}

function skillInUse(ctx: Ctx, userId: string, skillId: string, gone: Set<string>) {
  return ctx.store
    .agents(userId, { archived: true })
    .filter((a) => !gone.has(a.id))
    .some((a) => Array.isArray(a.skills) && a.skills.includes(skillId));
}

/** Rows the imports copied into the team database (from its import bookkeeping), per table. */
function importedRows(ctx: Ctx, userId: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  if (!ctx.store.one("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'teamdata_imports'")) return out;
  for (const r of ctx.store.all<{ tbl: string; row_id: number | null }>('SELECT tbl, row_id FROM teamdata_imports WHERE user_id = ? AND source = ? AND row_id IS NOT NULL', userId, 'openbot')) {
    const list = out.get(r.tbl) || [];
    list.push(Number(r.row_id));
    out.set(r.tbl, list);
  }
  return out;
}

/** Channels the import made that still exist (views from the channels module, no secrets). */
export function importedChannels(ctx: Ctx, userId: string, l: Pick<Ledger, 'channels'>): any[] {
  const ids = new Set(l.channels || []);
  if (!ids.size || typeof ctx.services.channels?.bindings !== 'function') return [];
  return (ctx.services.channels.bindings(userId) as any[]).filter((b) => ids.has(b.id));
}

/** What "ongedaan maken" would remove, in words for the confirmation (nothing is changed). */
export function undoPlan(ctx: Ctx, userId: string, l: Ledger) {
  const teams = teamsBridge(ctx);
  const bots = l.agents.map((id) => own(ctx, userId, id)).filter((a): a is Agent => !!a);
  const gone = new Set(bots.map((a) => a.id));
  const lib = ctx.services.skills?.library;
  const skills = l.skills
    .map((id) => lib?.get(userId, id))
    .filter((s: any) => !!s)
    .map((s: any) => ({ id: s.id, name: s.name, remove: !skillInUse(ctx, userId, s.id, gone) }));
  const providers = l.providers
    .map((id) => ctx.providers.config(id))
    .filter((p): p is NonNullable<typeof p> => !!p && p.user_id === userId)
    .map((p) => ({ id: p.id, name: p.name, remove: !providerInUse(ctx, userId, p.id, gone) }));
  const engine = ctx.services.routines?.engine;
  const routines = engine ? l.routines.filter((id) => engine.routine(id)).length : 0;
  const teamList = teams
    ? l.teams
        .map((t) => ({ t, row: teams.team(t.id) }))
        .filter((x) => x.row && x.row.user_id === userId)
        .map(({ t, row }) => {
          const others = teams.botsOf(t.id).filter((id) => !gone.has(id));
          return { id: t.id, name: row!.name, remove: t.created && others.length === 0, folder: t.folderSet, note: t.created && others.length ? `Team ${row!.name} blijft: er staan nu ook andere bots in.` : '' };
        })
    : [];
  const rows = [...importedRows(ctx, userId).values()].reduce((n, x) => n + x.length, 0);
  const main = l.main ? own(ctx, userId, l.main) : null;
  const channels = importedChannels(ctx, userId, l);
  return {
    available: !!(bots.length || routines || skills.length || providers.length || teamList.length || rows || l.tables.length || l.legacyFolder || channels.length),
    at: l.at || null,
    bots: bots.map((a) => ({ id: a.id, name: a.name })),
    routines,
    channels: channels.map((c: any) => ({ id: c.id, name: c.name, adapter: c.adapter })),
    skills: skills.filter((s) => s.remove).map((s) => ({ id: s.id, name: s.name })),
    keepSkills: skills.filter((s) => !s.remove).map((s) => s.name),
    providers: providers.filter((p) => p.remove).map((p) => ({ id: p.id, name: p.name })),
    teams: teamList,
    teamRows: rows,
    tables: l.tables.map((t) => t.name),
    main: main ? main.name : null,
    folder: !!(l.legacyFolder || teamList.some((t) => t.folder)),
    notes: [
      'OpenBot zelf blijft precies zoals het is.',
      'Gesprekken die je sinds de import met deze bots had, worden ook verwijderd; hun herinneringen gaan naar de prullenbak (Geheugen).',
      'Een werkmap die naar de map van OpenBot verwijst, blijft staan; een gekopieerde of nieuwe werkmap in TeamBot wordt verwijderd.',
    ],
  };
}

function deleteAgent(ctx: Ctx, userId: string, a: Agent, ob: OpenBotPaths, from = 'openbot-undo') {
  for (const r of ctx.store.all<{ id: string }>("SELECT id FROM runs WHERE agent_id = ? AND status IN ('queued','running','waiting')", a.id)) ctx.runs.cancel(r.id, 'Import ongedaan gemaakt');
  for (const h of ctx.hooks.agentDeleted) {
    try {
      h({ agentId: a.id, userId });
    } catch (e) {
      ctx.log.error(e);
    }
  }
  ctx.store.deleteAgent(a.id);
  // A workspace the import made in TeamBot's data folder (copy or new) goes too; a folder of OpenBot never.
  const ws = a.workspace ? path.resolve(a.workspace) : '';
  const inOpenBot = !ws || inside(ws, ob.dataDir) || inside(ws, path.join(ob.home, 'OpenBot'));
  let filesDeleted = false;
  if (ws && !inOpenBot && inside(ws, path.join(ctx.config.dataDir, 'workspaces')) && norm(ws) !== norm(path.join(ctx.config.dataDir, 'workspaces'))) {
    fs.rmSync(ws, { recursive: true, force: true });
    filesDeleted = true;
  }
  ctx.audit(userId, 'agent.deleted', { name: a.name, filesDeleted, from }, a.id);
  ctx.events.emit(userId, 'agent.deleted', { id: a.id });
}

/** Remove the copied team table rows (and the tables the import created, when empty). */
async function undoTeamData(ctx: Ctx, userId: string, l: Ledger): Promise<{ rows: number; tables: string[]; notes: string[] }> {
  const td = ctx.services.teamdata;
  const notes: string[] = [];
  if (!td) return { rows: 0, tables: [], notes };
  // The team database's own undo (package B2), per team database the import filled: it knows every row it copied
  // there (also into tables that already existed, such as taken), removes them and drops a table the import created
  // once it is empty again.
  if (typeof td.undoImport === 'function') {
    const teamIds = new Set<string | null>([...l.tables.map((t) => t.teamId ?? null), ...(l.teams || []).map((t) => t.id)]);
    if (!teamIds.size) teamIds.add(null);
    let rows = 0;
    const dropped: string[] = [];
    for (const teamId of teamIds) {
      try {
        const r: any[] = (await td.undoImport(userId, 'openbot', { teamId })) || [];
        for (const x of Array.isArray(r) ? r : []) {
          rows += Number(x?.removed) || 0;
          if (x?.dropped) dropped.push(String(x.name));
          if (x?.error) notes.push(`Tabel ${x.name}: ${x.error}`);
        }
      } catch (e: any) {
        notes.push(`De overgenomen teamtabelrijen konden niet worden weggehaald: ${e?.message || e}`);
      }
    }
    return { rows, tables: dropped, notes };
  }
  const bridge = teamDataBridge(ctx);
  const byTable = importedRows(ctx, userId);
  if (bridge?.perTeam && byTable.size) {
    notes.push('De overgenomen teamtabelrijen kon TeamBot niet automatisch weghalen; verwijder ze zo nodig in Teamwerk.');
    return { rows: 0, tables: [], notes };
  }
  let rows = 0;
  const changed = new Set<string>();
  for (const [tbl, ids] of byTable) {
    if (!/^[A-Za-z_][A-Za-z0-9_]{0,62}$/.test(tbl)) continue;
    const q = `"${tbl}"`;
    try {
      for (let i = 0; i < ids.length; i += 400) {
        const chunk = ids.slice(i, i + 400);
        const [r] = await td.write(userId, [{ sql: `DELETE FROM ${q} WHERE rowid IN (${chunk.map(() => '?').join(', ')})`, params: chunk }]);
        rows += Number(r?.changes) || 0;
      }
      changed.add(tbl);
    } catch (e: any) {
      notes.push(`Tabel ${tbl}: ${e?.message || e}`);
    }
  }
  // The bookkeeping of what came from OpenBot goes too, so importing again copies these rows again.
  if (byTable.size) ctx.store.exec('DELETE FROM teamdata_imports WHERE user_id = ? AND source = ?', userId, 'openbot');
  const dropped: string[] = [];
  for (const t of l.tables) {
    try {
      const [r] = await td.rows(userId, `SELECT COUNT(*) AS n FROM "${t.name.replace(/"/g, '""')}"`, [], true);
      if (r === undefined) continue;
      if (Number(r.n) > 0) {
        notes.push(`Tabel ${t.name} blijft: er staan rijen in die niet uit OpenBot komen.`);
        continue;
      }
      // Dropped as the one who made it (its creator per the team database; the import made it on its behalf).
      await td.run(userId, t.owner, `DROP TABLE "${t.name.replace(/"/g, '""')}"`, [], 'execute');
      dropped.push(t.name);
      changed.add(t.name);
    } catch (e: any) {
      notes.push(`Tabel ${t.name}: ${e?.message || e}`);
    }
  }
  if (changed.size) ctx.events.emit(userId, 'teamdata.changed', { tables: [...changed], by: null });
  return { rows, tables: dropped, notes };
}

/**
 * `opts.teamData: false` (the Hermes import, which copies no team tables) leaves the team database alone; `opts.from`
 * names the import in the audit log. `ob` is the folder whose workspaces are never deleted.
 */
export async function undoImport(ctx: Ctx, userId: string, l: Ledger, ob: OpenBotPaths, opts: { teamData?: boolean; from?: string } = {}) {
  const notes: string[] = [];
  const teams = teamsBridge(ctx);
  const bots = l.agents.map((id) => own(ctx, userId, id)).filter((a): a is Agent => !!a);
  const gone = new Set(bots.map((a) => a.id));
  const from = opts.from || 'openbot-undo';

  // 1. Team tables first (a table the import created is dropped as its creator, a bot that still exists here).
  const td = opts.teamData === false ? { rows: 0, tables: [] as string[], notes: [] as string[] } : await undoTeamData(ctx, userId, l);
  notes.push(...td.notes);

  // 2. Main bot: the import made it, so it stops being the main bot before it goes.
  const mb = mainBotBridge(ctx);
  if (l.main && mb?.clear && mb.current(userId) === l.main) {
    try {
      mb.clear(userId);
    } catch (e: any) {
      notes.push(`Hoofdbot: ${e?.message || e}`);
    }
  }

  // 3. Routines the import made (also on bots of an earlier import), then the bots.
  const engine = ctx.services.routines?.engine;
  let routines = 0;
  if (engine)
    for (const id of l.routines) {
      const r = engine.routine(id);
      if (r && r.user_id === userId) {
        engine.remove(r);
        routines++;
      }
    }
  // Channels the import made (they were never given a token by the import; one the owner connected since goes too).
  let channels = 0;
  for (const c of importedChannels(ctx, userId, l)) {
    try {
      if (await ctx.services.channels.remove(userId, c.id)) channels++;
    } catch (e: any) {
      notes.push(`Kanaal ${c.name}: ${e?.message || e}`);
    }
  }
  for (const a of bots) deleteAgent(ctx, userId, a, ob, from);

  // 4. Skills the import created and engine links it made, when no remaining bot uses them.
  const lib = ctx.services.skills?.library;
  let skills = 0;
  if (lib)
    for (const id of l.skills) {
      const s = lib.get(userId, id);
      if (!s) continue;
      if (skillInUse(ctx, userId, id, gone)) {
        notes.push(`Skill ${s.name} blijft: een andere bot gebruikt hem.`);
        continue;
      }
      lib.remove(s);
      ctx.audit(userId, 'skill.deleted', { skill: s.name, from });
      ctx.events.emit(userId, 'skills.deleted', { id: s.id });
      skills++;
    }
  let providers = 0;
  for (const id of l.providers) {
    const p = ctx.providers.config(id);
    if (!p || p.user_id !== userId) continue;
    if (providerInUse(ctx, userId, id, gone)) {
      notes.push(`${p.name} blijft gekoppeld: een andere bot gebruikt hem.`);
      continue;
    }
    ctx.providers.remove(id, userId);
    if (ctx.store.getSetting(userId, 'defaultProvider', null) === id) ctx.store.setSetting(userId, 'defaultProvider', null);
    ctx.events.emit(userId, 'provider.deleted', { id });
    providers++;
  }

  // 5. Teams: lead and folder back as they were; a team the import made goes when it is empty again.
  let teamsRemoved = 0;
  if (teams)
    for (const t of l.teams) {
      const row = teams.team(t.id);
      if (!row || row.user_id !== userId) continue;
      if (t.leadSet && row.lead_agent_id === t.leadSet && !gone.has(t.leadSet)) {
        try {
          teams.setLead(userId, t.id, null);
        } catch {
          /* the owner changed it since */
        }
      }
      const others = teams.botsOf(t.id).filter((id) => !gone.has(id));
      if (t.created && !others.length) {
        try {
          teams.remove(userId, t.id);
          teamsRemoved++;
        } catch (e: any) {
          notes.push(`Team ${row.name} blijft: ${e?.message || e}`);
        }
        continue;
      }
      if (t.created) notes.push(`Team ${row.name} blijft: er staan nu ook andere bots in.`);
      if (t.folderSet) {
        try {
          teams.setFolder(userId, t.id, t.folderBefore);
        } catch (e: any) {
          notes.push(`Teammap van ${row.name}: ${e?.message || e}`);
        }
      }
    }
  if (l.legacyFolder) {
    const cur = ctx.store.getSetting<any>(userId, 'teamFolder', null);
    if (cur && typeof cur.path === 'string' && norm(cur.path) === norm(l.legacyFolder.path)) ctx.store.setSetting(userId, 'teamFolder', l.legacyFolder.before);
  }
  if (teamsRemoved || l.teams.length) ctx.events.emit(userId, 'teams.changed', {});
  ctx.events.emit(userId, 'folders.updated', {});

  return { bots: bots.length, routines, channels, skills, providers, teamRows: td.rows, tables: td.tables, teams: teamsRemoved, notes, left: emptyLedger() };
}
