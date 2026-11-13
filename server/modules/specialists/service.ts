/**
 * Specialists: a bot with a field (one sentence) and sources learns by itself in a learning round run by the routines
 * engine. Its knowledge base is a dossier of the bot in the memory module (facts with source and date, dedup and
 * conflicts by memory's own pipeline). This file holds profiles, sources, the routine, the knowledge base view,
 * learning goals, reports with undo and the team rules; the round itself is in round.ts.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, Run, Thread } from '../../core/types.js';
import { newId, now } from '../../core/db.js';
import { HttpError } from '../../core/http.js';
import { resolveInWorkspace } from '../../tools/builtin/files.js';
import { type FetchFn, politeFetch, sha } from './fetch.js';
import { engineFor } from './engine.js';
import { clip, jaccard, looksLikeInstruction, ownWords, saysUnknown, tokens } from './guard.js';
import { defaultSourcesFor, fieldOf, onTopic, primaryScore, roleHead, sourceQueries, specialismOf, subjectWords, topicHits } from './defaults.js';

export type SourceKind = 'web' | 'feed' | 'docs' | 'file';
export type Cadence = 'hourly' | 'daily' | 'weekly';
export const CADENCES: Cadence[] = ['hourly', 'daily', 'weekly'];
export type BudgetId = 'none' | 'small' | 'normal' | 'large';

export const SOURCE_KINDS: SourceKind[] = ['web', 'feed', 'docs', 'file'];
export const SOURCE_LABEL: Record<SourceKind, string> = { web: 'Website', feed: 'RSS- of Atom-feed', docs: 'Documentatie', file: 'Eigen bestand of map' };
/** Tokens (in + out, estimated) and model calls per round. */
export const BUDGETS: Record<BudgetId, { tokens: number; calls: number; label: string }> = {
  // No limit of its own (the default): a round learns everything that is new; the owner's usage limits still hold.
  none: { tokens: 1e9, calls: 1e6, label: 'Geen limiet' },
  small: { tokens: 15_000, calls: 6, label: 'Klein' },
  normal: { tokens: 40_000, calls: 15, label: 'Normaal' },
  large: { tokens: 100_000, calls: 30, label: 'Groot' },
};
export const MAX_SOURCES = 30;
export const MAX_OPEN_GOALS = 30;
const WEEK = 7 * 864e5;

export interface ProfileRow {
  agent_id: string;
  user_id: string;
  enabled: boolean;
  field: string;
  learn_on: boolean;
  cadence: Cadence;
  budget: BudgetId;
  self_test: boolean;
  routine_id: string | null;
  dossier_id: string | null;
  settings: Record<string, any>;
  learn_since: string | null;
  last_round_at: string | null;
  last_selftest_at: string | null;
  last_report_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SourceRow {
  id: string;
  agent_id: string;
  user_id: string;
  kind: SourceKind;
  target: string;
  label: string;
  enabled: boolean;
  suggested: boolean;
  state: Record<string, any>;
  last_checked_at: string | null;
  last_status: string | null;
  last_error: string | null;
  sort: number;
  created_at: string;
  updated_at: string;
}

export interface RoundLine {
  /**
   * `updated` = a newer source replaced what was known (the old version is in the history); `confirmed` = re-checked
   * against its source and still true; `retired` = no longer in its source: out of use, with the reason.
   */
  kind: 'new' | 'updated' | 'confirmed' | 'retired' | 'duplicate' | 'conflict' | 'proposed' | 'ignored' | 'rejected' | 'error' | 'unchanged' | 'skipped' | 'goal';
  text: string;
  source?: string;
  sourceLabel?: string;
  published?: string | null;
  itemId?: string;
  ref?: string;
  changeId?: string | null;
  existing?: { ref?: string; text: string } | null;
  goalId?: string;
  undone?: boolean;
}

export interface GoalRow {
  id: string;
  agent_id: string;
  user_id: string;
  question: string;
  origin: 'gap' | 'selftest' | 'owner' | 'bot';
  status: 'open' | 'done' | 'dropped';
  hits: number;
  tries: number;
  thread_id: string | null;
  message_id: string | null;
  answer_ref: string | null;
  answer_text: string | null;
  note: string | null;
  created_at: string;
  updated_at: string;
  done_at: string | null;
}

/** A web search for what changed in a field (default: TeamBot's own search chain, which works without a key). */
export type SearchFn = (userId: string, query: string, count: number) => Promise<{ title: string; url: string; snippet?: string }[]>;

export interface SpecialistOptions {
  /** Pause between two requests to the same host during a round (ms). */
  hostDelayMs?: number;
  fetch?: FetchFn;
  search?: SearchFn;
}

const bad = (m: string) => new HttpError(400, m);

export class SpecialistService {
  readonly opts: Required<SpecialistOptions>;
  /** Rounds in flight per bot (one at a time). */
  readonly running = new Map<string, Promise<any>>();

  constructor(
    public ctx: Ctx,
    opts: SpecialistOptions = {},
  ) {
    this.opts = {
      hostDelayMs: opts.hostDelayMs ?? 2000,
      fetch: opts.fetch ?? politeFetch,
      // (Under the test runner nothing leaves the machine unless a test injects its own search.)
      search: opts.search ?? (async (userId, query, count) => (process.env.NODE_TEST_CONTEXT ? [] : (await import('../../tools/builtin/web.js')).webSearch(ctx, userId, query, count))),
    };
  }

  setOptions(o: SpecialistOptions) {
    if (o.hostDelayMs !== undefined) this.opts.hostDelayMs = Math.max(0, Number(o.hostDelayMs) || 0);
    if (o.fetch) this.opts.fetch = o.fetch;
    if (o.search) this.opts.search = o.search;
  }

  get store() {
    return this.ctx.store;
  }

  emit(userId: string, agentId: string, what = 'profile') {
    this.ctx.events.emit(userId, 'specialists.changed', { agentId, what });
  }

  // ------------------------------------------------------------------ profiles

  profile(agentId: string | null | undefined): ProfileRow | null {
    return agentId ? this.store.get<ProfileRow>('specialist_profiles', agentId, 'agent_id') : null;
  }

  /** The bot is a specialist (switched on, with a field). */
  active(agentId: string | null | undefined): ProfileRow | null {
    const p = this.profile(agentId);
    return p && p.enabled && p.field ? p : null;
  }

  profiles(userId: string): ProfileRow[] {
    return this.store.find<ProfileRow>('specialist_profiles', { user_id: userId }, { order: 'created_at' });
  }

  ownAgent(userId: string, agentId: string): Agent {
    const a = this.store.agent(agentId);
    if (!a || a.user_id !== userId) throw new HttpError(404, 'Bot niet gevonden');
    return a;
  }

  private ensureProfile(agent: Agent): ProfileRow {
    const p = this.profile(agent.id);
    if (p) return p;
    const ts = now();
    this.store.insert('specialist_profiles', { agent_id: agent.id, user_id: agent.user_id, enabled: false, field: '', learn_on: true, cadence: 'daily', budget: 'none', self_test: false, settings: {}, created_at: ts, updated_at: ts });
    return this.profile(agent.id)!;
  }

  sources(agentId: string): SourceRow[] {
    return this.store.find<SourceRow>('specialist_sources', { agent_id: agentId }, { order: 'sort, created_at' });
  }

  /** Check one source from the owner (or a template). Throws a Dutch reason. */
  cleanSource(agent: Agent, s: any): { kind: SourceKind; target: string; label: string; enabled: boolean } {
    const kind = (SOURCE_KINDS.includes(s?.kind) ? s.kind : '') as SourceKind;
    if (!kind) throw bad('Kies het soort bron: website, feed, documentatie of eigen bestand.');
    const target = String(s?.target ?? s?.url ?? s?.path ?? '').trim().slice(0, 1000);
    if (!target) throw bad('Vul het adres of pad van de bron in.');
    if (kind === 'file') {
      try {
        resolveInWorkspace(agent, target);
      } catch (e: any) {
        throw bad(`Dit bestand of deze map kan ${agent.name} niet lezen: ${e?.message || e}`);
      }
    } else {
      let u: URL;
      try {
        u = new URL(target);
      } catch {
        throw bad(`Dit is geen geldig webadres: ${clip(target, 80)}`);
      }
      if (!['http:', 'https:'].includes(u.protocol)) throw bad('Alleen webadressen met http:// of https:// kunnen een bron zijn.');
      if (u.username || u.password) throw bad('Zet geen gebruikersnaam of wachtwoord in het adres van een bron.');
    }
    return { kind, target, label: clip(String(s?.label || ''), 80), enabled: s?.enabled !== false };
  }

  /**
   * Save the Specialisme card. `sources` replaces the list (a source with the same kind and address keeps what was
   * fetched before). Switching the specialism on makes the knowledge dossier, gives the bot the knowledge tools and
   * sets up its learning routine: on by default (daily, on the specialist's own model, no limit of its own), so a specialist keeps itself current without
   * any setup. A specialist without sources gets the default ones of its field (defaults.ts), marked "voorgesteld".
   */
  save(userId: string, agentId: string, body: any) {
    const agent = this.ownAgent(userId, agentId);
    const cur = this.ensureProfile(agent);
    const patch: Partial<ProfileRow> = {};
    if (body?.field !== undefined) {
      const f = clip(String(body.field || ''), 300);
      if (f && looksLikeInstruction(f)) throw bad('Beschrijf het vakgebied in gewone woorden, zonder opdrachten.');
      patch.field = f;
    }
    if (body?.enabled !== undefined) patch.enabled = !!body.enabled;
    if (body?.learnOn !== undefined) patch.learn_on = !!body.learnOn;
    if (body?.cadence !== undefined) patch.cadence = CADENCES.includes(body.cadence) ? body.cadence : 'daily';
    if (body?.budget !== undefined) patch.budget = (Object.keys(BUDGETS).includes(body.budget) ? body.budget : 'none') as BudgetId;
    // "Leert met": the specialist's own model (default) or a cheaper (free or local) one.
    if (body?.learnWith !== undefined) patch.settings = { ...cur.settings, learnWith: body.learnWith === 'cheap' ? 'cheap' : 'own' };
    if (body?.selfTest !== undefined) patch.self_test = !!body.selfTest;
    const next = { ...cur, ...patch };
    if (next.enabled && !next.field) throw bad('Beschrijf eerst in één zin het vakgebied van deze specialist.');
    let srcs: ReturnType<SpecialistService['cleanSource']>[] | null = null;
    if (Array.isArray(body?.sources)) {
      if (body.sources.length > MAX_SOURCES) throw bad(`Een specialist kan hoogstens ${MAX_SOURCES} bronnen hebben.`);
      srcs = body.sources.map((s: any) => this.cleanSource(agent, s));
    }
    if ((patch.learn_on && !cur.learn_on) || (next.enabled && next.learn_on && !cur.learn_since)) patch.learn_since = now();
    // No sources at all: the official ones for this field (the owner can remove them).
    let raw: any[] = body?.sources;
    if (next.enabled && !(srcs ? srcs.length : this.sources(agentId).length)) {
      const defs = defaultSourcesFor(`${next.field} ${agent.name} ${agent.role || ''}`);
      if (defs.length) {
        srcs = defs.map((d) => ({ ...d, enabled: true }));
        raw = defs.map(() => ({ suggested: true }));
      }
    }
    this.store.tx(() => {
      this.store.update('specialist_profiles', agentId, { ...patch, updated_at: now() }, 'agent_id');
      if (srcs) this.replaceSources(agent, srcs, raw || []);
    });
    const p = this.profile(agentId)!;
    if (p.enabled) this.activate(agent);
    this.dropRoutine(agent);
    this.emit(userId, agentId);
    return this.view(this.store.agent(agentId)!);
  }

  private replaceSources(agent: Agent, list: ReturnType<SpecialistService['cleanSource']>[], raw: any[]) {
    const old = this.sources(agent.id);
    const keep = new Set<string>();
    const ts = now();
    list.forEach((s, i) => {
      const prev = old.find((o) => o.kind === s.kind && o.target === s.target && !keep.has(o.id));
      if (prev) {
        keep.add(prev.id);
        this.store.update('specialist_sources', prev.id, { label: s.label, enabled: s.enabled, sort: i, suggested: prev.suggested && raw[i]?.suggested !== false, updated_at: ts });
      } else {
        const id = newId('sps_');
        keep.add(id);
        this.store.insert('specialist_sources', { id, agent_id: agent.id, user_id: agent.user_id, kind: s.kind, target: s.target, label: s.label, enabled: s.enabled, suggested: !!raw[i]?.suggested, state: {}, sort: i, created_at: ts, updated_at: ts });
      }
    });
    for (const o of old)
      if (!keep.has(o.id)) {
        this.store.exec('DELETE FROM specialist_pages WHERE source_id = ?', o.id);
        this.store.remove('specialist_sources', o.id);
      }
  }

  /** A specialist gets its knowledge dossier and the knowledge tools. */
  activate(agent: Agent) {
    this.kbDossier(agent, true);
    if (!agent.tool_groups.includes('specialist')) {
      const a = this.store.updateAgent(agent.id, { tool_groups: [...agent.tool_groups, 'specialist'] });
      this.ctx.events.emit(agent.user_id, 'agent.updated', a);
    }
  }

  /**
   * The bot's knowledge dossier ("Kennisbank van …", only this bot reads it through memory). Made when missing; a
   * dossier the owner threw away is replaced by a new one. Null when the memory module is not there.
   */
  kbDossier(agent: Agent, create: boolean): string | null {
    const mem = this.ctx.services.memory;
    if (!mem?.dossiers) return null;
    const p = this.ensureProfile(agent);
    if (p.dossier_id) {
      const d = mem.dossiers.get(agent.user_id, p.dossier_id)?.dossier;
      if (d && ['active', 'closed', 'archived'].includes(d.status)) return p.dossier_id;
    }
    if (!create) return null;
    const summary = p.field ? `Wat ${agent.name} leert over: ${p.field}. Elk feit heeft een bron en een datum.` : `Wat ${agent.name} leert, met bron en datum.`;
    for (let i = 1; i <= 5; i++) {
      const title = i === 1 ? `Kennisbank van ${agent.name}` : `Kennisbank van ${agent.name} (${i})`;
      const r = mem.dossiers.create(agent.user_id, { title, summary, kind: 'topic', agentIds: [agent.id] });
      const ids = r?.dossier?.agent_ids;
      const mine = !r.existed || (Array.isArray(ids) && ids.length === 1 && ids[0] === agent.id && !this.store.one('SELECT 1 FROM specialist_profiles WHERE dossier_id = ? AND agent_id != ?', r.dossier.id, agent.id));
      if (mine) {
        this.store.update('specialist_profiles', agent.id, { dossier_id: r.dossier.id, updated_at: now() }, 'agent_id');
        return r.dossier.id;
      }
    }
    return null;
  }

  // ------------------------------------------------------------------ the learning round's own schedule

  /**
   * Earlier versions ran the round through a routine: every round started a run on the bot's own engine (its
   * subscription) just to call the learning tool. That routine is removed; the round is scheduled here (roundsDue)
   * and makes only the short, tool-less calls of the round itself.
   */
  dropRoutine(agent: Agent) {
    const p = this.profile(agent.id);
    if (!p?.routine_id) return;
    try {
      const eng = this.ctx.services.routines?.engine;
      const r = eng?.routine(p.routine_id);
      if (r && r.user_id === agent.user_id && r.agent_id === agent.id) eng.remove(r, { deleteThread: false });
    } catch (e) {
      this.ctx.log.warn('[specialists] oude leerroutine niet verwijderd', String(e));
    }
    const { routineSig: _sig, ...settings } = p.settings || {};
    this.store.update('specialist_profiles', agent.id, { routine_id: null, settings, updated_at: now() }, 'agent_id');
  }

  /**
   * A specialist without sources finds its own, for any field: a web search, then per candidate a quick check that it
   * is a primary source (primaryScore: official or the subject's own site; never a forum, shop or encyclopedia) and
   * that it answers with real text. The best few become its sources, marked "voorgesteld", and the owner is told once.
   * At most once a week per bot; never for a bot set to private (its field would leave the computer).
   */
  /** What this bot's work is about, in words (see defaults.ts › subjectWords). */
  workWords(agent: Agent, field: string): string[] {
    // (A known specialism also brings the words of its own search for what changed and of its standard sources.)
    const sp = specialismOf(`${field} ${agent.name} ${agent.role || ''}`);
    return subjectWords(field, agent.role, agent.description, sp?.news, ...(sp?.sources || []).map((x) => x.label));
  }

  /** What the owner is busy with, in words: from the owner's dossier and the overview of the bot's team (memory). */
  ownerWordsOf(agent: Agent): string[] {
    try {
      const core: any[] = this.ctx.services.memory?.living?.core?.(agent.id) || [];
      return subjectWords(...core.filter((d) => d.core === 'owner' || d.core === 'overview').map((d) => String(d.body || '')));
    } catch {
      return [];
    }
  }

  /**
   * Is a page about this bot's work? (Its title or link names a word of the field, role or description.) The one
   * question every place asks that judges a source without a model: defaults.ts › onTopic with this bot's words.
   */
  aboutWork(agent: Agent, field: string, title: string, url: string): boolean {
    return onTopic(url, title, this.workWords(agent, field));
  }

  /**
   * Once per install (the upgrade to sources that must be about the bot's work; no model, no network): a source
   * TeamBot found itself with a search — never a preset, a template's source or one the owner or a bot added —
   * whose title and link name nothing of the bot's work is switched off, and the facts learned from exactly that
   * source go to the archive (one batch per owner: one undo in Geheugen › Geschiedenis brings them back; the source
   * can be switched on again). Small and conservative on purpose: in doubt everything stays as it is.
   */
  pruneUnfitSources(): { sources: number; facts: number } {
    const out = { sources: 0, facts: 0 };
    if (this.store.getSetting<any>('', 'specialists.fitChecked', null)) return out;
    const mem = this.ctx.services.memory?.svc;
    for (const p of this.store.find<ProfileRow>('specialist_profiles', {})) {
      const agent = this.store.agent(p.agent_id);
      const found = Date.parse(p.settings?.discoveredAt || '');
      if (!agent || !p.field || !found) continue;
      const presets = new Set(defaultSourcesFor(p.field, 50).map((d) => d.target));
      let batch: string | null = null;
      for (const s of this.sources(agent.id)) {
        if (!s.enabled || !s.suggested || s.kind === 'file' || presets.has(s.target) || (Date.parse((s as any).created_at || '') || 0) < found) continue;
        const pages = this.store.all<any>('SELECT url, title FROM specialist_pages WHERE source_id = ?', s.id);
        if ([{ url: s.target, title: s.label }, ...pages].some((x) => this.aboutWork(agent, p.field!, x.title || '', String(x.url || '')))) continue;
        this.store.update('specialist_sources', s.id, { enabled: false, last_error: 'Zelf gevonden met zoeken, maar de titel gaat niet over het vakgebied: uitgezet. Je kunt deze bron weer aanzetten of weghalen.', updated_at: now() });
        out.sources++;
        const urls = [...new Set([s.target, ...pages.map((x) => String(x.url))])];
        const rows = mem && p.dossier_id ? this.store.all<any>(`SELECT id FROM memory_items WHERE dossier_id = ? AND status = 'active' AND pinned = 0 AND created_by != 'user' AND source_kind = 'url' AND source_ref IN (${urls.map(() => '?').join(',')})`, p.dossier_id, ...urls) : [];
        for (const r of rows) {
          batch = batch || newId('mbt_');
          const before = mem.snapshot('item', r.id);
          mem.patchItem(r.id, { status: 'archived' });
          mem.recordChange({ userId: p.user_id, kind: 'item', recordId: r.id, dossierId: p.dossier_id, op: 'archive', before, after: mem.snapshot('item', r.id), summary: `Naar het archief (bron ging niet over het vakgebied): ${mem.label(before)}`, reason: `bron uitgezet: ${clip(s.label || s.target, 120)}`, actor: 'system', actorId: 'specialists-fit', batchId: batch, undoDays: 365 });
          out.facts++;
        }
        this.ctx.log.info(`[specialists] bron van ${agent.name} uitgezet (gaat niet over het vakgebied): ${clip(s.label || s.target, 100)}; ${rows.length} feiten naar het archief (terug te draaien in Geheugen › Geschiedenis)`);
        this.emit(p.user_id, agent.id, 'knowledge');
      }
    }
    this.store.setSetting('', 'specialists.fitChecked', now());
    return out;
  }

  async discoverSources(agent: Agent, o: { replace?: boolean } = {}): Promise<number> {
    const p = this.active(agent.id);
    const have = this.sources(agent.id);
    // (`replace`: a suggested source stopped answering — look for another one next to what is there.)
    if (!p || (have.length && !o.replace) || agent.settings?.private === true) return 0;
    if (Date.now() - (Date.parse(p.settings?.discoveredAt || '') || 0) < WEEK) return 0;
    this.store.update('specialist_profiles', agent.id, { settings: { ...p.settings, discoveredAt: now() } }, 'agent_id');
    const seen = new Set<string>(have.map((x) => { try { return new URL(x.target).host; } catch { return ''; } }));
    const cands: { url: string; title: string; score: number }[] = [];
    // A search hit becomes a source only when it is about this bot's work (its field, role and description), and one
    // that also names what the owner is busy with (the owner's and the team's overview dossier) goes first. An
    // official site about something else is not a source.
    const world = this.ownerWordsOf(agent);
    for (const q of sourceQueries(p.field)) {
      let hits: { title: string; url: string }[] = [];
      try {
        hits = await this.opts.search(agent.user_id, q, 8);
      } catch (e) {
        this.ctx.log.info?.(`[specialists] bronnen zoeken lukte niet: ${String(e)}`);
      }
      for (const h of hits) {
        let host = '';
        try {
          host = new URL(h.url).host;
        } catch {
          continue;
        }
        // (primaryScore is 0 for a page that is not about the field: the same check as `aboutWork`, on the field alone.)
        const primary = primaryScore(h.url, h.title || '', p.field);
        const score = primary && primary + Math.min(2, topicHits(h.url, h.title || '', world));
        // (One page per site, the first one the search gave.)
        if (!score || seen.has(host) || !/^https?:$/.test(new URL(h.url).protocol)) continue;
        seen.add(host);
        cands.push({ url: h.url, title: clip(h.title || host, 80), score });
      }
    }
    const found: { kind: SourceKind; target: string; label: string; enabled: boolean }[] = [];
    for (const c of cands.sort((a, b) => b.score - a.score).slice(0, 8)) {
      if (found.length >= (o.replace ? 2 : 4)) break;
      try {
        const f = await this.opts.fetch(c.url, { allowPrivate: !!agent.settings?.allowPrivateNetwork, timeoutMs: 15_000 });
        if (f.status >= 400 || String(f.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').length < 400) continue;
        found.push({ ...this.cleanSource(agent, { kind: /<(rss|feed)[\s>]/i.test(String(f.text).slice(0, 600)) ? 'feed' : 'web', target: c.url, label: c.title }), enabled: true });
      } catch {
        /* does not answer: not a source */
      }
    }
    if (!found.length) return 0;
    const keep = have.map((x) => ({ kind: x.kind, target: x.target, label: x.label, enabled: x.enabled }));
    this.store.tx(() => this.replaceSources(agent, [...keep, ...found], [...have.map((x) => ({ suggested: x.suggested })), ...found.map(() => ({ suggested: true }))]));
    this.ctx.events.emit(agent.user_id, 'notification', { title: `${agent.name} vond zelf bronnen om van te leren`, body: `${found.map((f) => f.label).join(', ')}. Bekijk ze bij de bot onder Specialisme; je kunt ze weghalen of vervangen.`, link: `#/m/specialists/${agent.id}/bronnen`, kind: 'memory', agentId: agent.id });
    this.emit(agent.user_id, agent.id);
    return found.length;
  }

  /** How long between two rounds (a little under a week / a day, so the round keeps its weekday and hour). */
  private period(p: ProfileRow): number {
    return p.cadence === 'weekly' ? 6.5 * 864e5 : p.cadence === 'hourly' ? 55 * 60e3 : 20 * 3600e3;
  }

  /** When the next round is due (null: learning is off). A round that found no free model is tried again after six hours. */
  nextRoundAt(p: ProfileRow): string | null {
    if (!p.enabled || !p.field || !p.learn_on) return null;
    const last = Date.parse(p.last_round_at || '') || 0;
    const skipped = Date.parse(p.settings?.autoSkip?.at || '') || 0;
    const first = Date.parse(p.learn_since || p.created_at) || Date.now();
    return new Date(Math.max(last ? last + this.period(p) : first, skipped ? skipped + 6 * 3600e3 : 0)).toISOString();
  }

  /**
   * Rounds that are due, one after the other (checked every ten minutes). When there is nothing to learn with now (the
   * owner chose "goedkoper model" and none is available, or the bot has no engine) the round is skipped quietly — a
   * note on the bot's Specialisme card, no notification — and tried again later.
   */
  async roundsDue(nowMs = Date.now()): Promise<number> {
    let ran = 0;
    for (const p of this.store.find<ProfileRow>('specialist_profiles', { enabled: true, learn_on: true })) {
      const agent = this.store.agent(p.agent_id);
      const next = this.nextRoundAt(p);
      if (!agent || agent.archived || !next || Date.parse(next) > nowMs || this.running.has(p.agent_id)) continue;
      try {
        // No sources yet (any field without a preset): the specialist finds its own first.
        if (!this.sources(p.agent_id).length) await this.discoverSources(agent);
        if (!this.sources(p.agent_id).some((x) => x.enabled)) continue;
        const { runRound } = await import('./round.js');
        if (await runRound(this, p.user_id, p.agent_id, { trigger: 'auto' })) ran++;
      } catch (e) {
        this.ctx.log.warn('[specialists] leerronde mislukt', String(e));
      }
    }
    return ran;
  }

  /** "Nu leren": the round now, in the background . */
  async learnNow(userId: string, agentId: string): Promise<{ started: true }> {
    const agent = this.ownAgent(userId, agentId);
    if (!this.active(agentId)) throw bad('Maak deze bot eerst specialist: zet Specialisme aan en beschrijf het vakgebied.');
    if (!this.sources(agentId).length) await this.discoverSources(agent);
    if (!this.sources(agentId).some((s) => s.enabled)) throw bad('Er zijn nog geen bronnen gevonden voor dit vakgebied. Voeg er zelf minstens één toe.');
    if (this.running.has(agentId)) throw bad('Er loopt al een leerronde voor deze bot; wacht tot die klaar is.');
    const { runRound } = await import('./round.js');
    void runRound(this, userId, agentId, { trigger: 'manual' }).catch((e) => this.ctx.log.warn('[specialists] leerronde mislukt', String(e)));
    return { started: true };
  }

  // ------------------------------------------------------------------ views

  view(agent: Agent) {
    const p = this.profile(agent.id) || ({ enabled: false, field: '', learn_on: true, cadence: 'daily', budget: 'none', self_test: false, routine_id: null, dossier_id: null, last_round_at: null, settings: {} } as any as ProfileRow);
    const e = engineFor(this.ctx, agent, p.settings?.learnWith === 'cheap');
    const counts = this.counts(agent);
    const lastRound = this.store.one<any>("SELECT id, status, summary, finished_at, started_at FROM specialist_rounds WHERE agent_id = ? ORDER BY started_at DESC LIMIT 1", agent.id);
    return {
      agentId: agent.id,
      agentName: agent.name,
      enabled: !!p.enabled,
      field: p.field || '',
      learnOn: !!p.learn_on,
      cadence: p.cadence,
      budget: p.budget,
      learnWith: p.settings?.learnWith === 'cheap' ? 'cheap' : 'own',
      selfTest: !!p.self_test,
      sources: this.sources(agent.id).map((s) => this.sourceView(s)),
      // When the next round runs by itself, and why the last one was skipped (no free or local model to learn with).
      nextRoundAt: this.nextRoundAt(p),
      skipped: p.settings?.autoSkip || null,
      dossierId: p.dossier_id,
      engine: { kind: e.kind, label: e.label, billing: e.billing, problem: e.problem || null },
      canUseTools: agent.access_mode !== 'chat',
      counts,
      // How full the knowledge base is against its budget (memory keeps it at or under the target), and the newest
      // "wat is er nieuw en wat verandert er daardoor" of a learning round.
      size: this.kbSize(agent),
      lastNews: p.settings?.lastNews || null,
      lastRound: lastRound || null,
      budgets: Object.entries(BUDGETS).map(([id, b]) => ({ id, label: b.label, tokens: b.tokens, calls: b.calls })),
    };
  }

  sourceView(s: SourceRow) {
    return { id: s.id, kind: s.kind, target: s.target, label: s.label, enabled: s.enabled, suggested: s.suggested, lastCheckedAt: s.last_checked_at, lastStatus: s.last_status, lastError: s.last_error };
  }

  counts(agent: Agent) {
    const p = this.profile(agent.id);
    const n = (sql: string, ...a: any[]) => this.store.one<{ n: number }>(sql, ...a)?.n || 0;
    return {
      facts: p?.dossier_id ? n("SELECT COUNT(*) n FROM memory_items WHERE dossier_id = ? AND status = 'active'", p.dossier_id) : 0,
      retired: p?.dossier_id ? n("SELECT COUNT(*) n FROM memory_items WHERE dossier_id = ? AND status = 'superseded' AND flags LIKE '%\"retired\"%'", p.dossier_id) : 0,
      review: p?.dossier_id ? n("SELECT COUNT(*) n FROM memory_items WHERE dossier_id = ? AND status = 'proposed'", p.dossier_id) : 0,
      goals: n("SELECT COUNT(*) n FROM specialist_goals WHERE agent_id = ? AND status = 'open'", agent.id),
      reportsUnseen: n('SELECT COUNT(*) n FROM specialist_reports WHERE agent_id = ? AND seen_at IS NULL', agent.id),
    };
  }

  /** Active facts against the knowledge base's target size (memory's budget for one dossier). */
  kbSize(agent: Agent): { active: number; target: number } | null {
    const p = this.profile(agent.id);
    const mem = this.ctx.services.memory;
    return p?.dossier_id && mem?.dossierSize ? mem.dossierSize(agent.user_id, p.dossier_id) : null;
  }

  /** Overview of all specialists of the owner (for the Kennisbank list and the chat header). */
  list(userId: string) {
    return this.profiles(userId)
      .map((p) => {
        const a = this.store.agent(p.agent_id);
        if (!a || a.archived) return null;
        return { agentId: a.id, agentName: a.name, avatar: a.avatar, enabled: p.enabled, field: p.field, learnOn: p.learn_on, cadence: p.cadence, lastRoundAt: p.last_round_at, counts: this.counts(a) };
      })
      .filter(Boolean);
  }

  /** Line metadata of learned facts (change id for undo, published date, source label) per memory item id. */
  private lineIndex(agentId: string): Map<string, RoundLine & { roundId: string; index: number }> {
    const out = new Map<string, RoundLine & { roundId: string; index: number }>();
    for (const r of this.store.all<any>('SELECT id, lines FROM specialist_rounds WHERE agent_id = ? ORDER BY started_at DESC LIMIT 200', agentId)) {
      const lines: RoundLine[] = this.store.decode<any>('specialist_rounds', r).lines || [];
      lines.forEach((l, index) => {
        if (l.itemId && !out.has(l.itemId)) out.set(l.itemId, { ...l, roundId: r.id, index });
      });
    }
    return out;
  }

  /** The knowledge base: facts (with source and date) and what is "te controleren" (conflicts and other proposals). */
  knowledge(userId: string, agentId: string) {
    const agent = this.ownAgent(userId, agentId);
    const p = this.profile(agentId);
    const mem = this.ctx.services.memory;
    if (!p?.dossier_id || !mem?.dossiers) return { dossierId: null, dossierStatus: null, facts: [], review: [], retired: [], size: null };
    const d = mem.dossiers.get(userId, p.dossier_id);
    if (!d) return { dossierId: null, dossierStatus: null, facts: [], review: [], retired: [], size: null };
    const idx = this.lineIndex(agent.id);
    const items: any[] = d.items || [];
    const fv = (i: any) => {
      const l = idx.get(i.id);
      return {
        id: i.id,
        ref: i.ref,
        content: i.content,
        status: i.status,
        sourceKind: i.source_kind,
        source: i.source_ref,
        quote: i.source_excerpt,
        learnedAt: i.observed_at || i.created_at,
        // Freshness: when a source (or the owner) last confirmed it, and when it is looked at again.
        confirmedAt: i.last_confirmed_at || i.valid_from || i.created_at,
        reviewAt: i.review_at || null,
        check: (i.flags || []).includes('check'),
        published: l?.published || null,
        sourceLabel: l?.sourceLabel || null,
        by: i.created_by === 'user' ? 'owner' : i.created_by_agent === agentId ? 'self' : i.agent_name || null,
        reason: i.proposal_reason,
        changeId: l && !l.undone ? l.changeId || null : null,
        roundId: l?.roundId || null,
        lineIndex: l?.index ?? null,
      };
    };
    const facts = items.filter((i) => i.status === 'active').map(fv);
    const review = items
      .filter((i) => i.status === 'proposed')
      .map((i) => {
        const other = i.conflict_with ? items.find((x) => x.id === i.conflict_with) : null;
        const l = idx.get(i.id);
        return { ...fv(i), existing: other ? { id: other.id, ref: other.ref, content: other.content, source: other.source_ref, learnedAt: other.observed_at || other.created_at } : l?.existing ? { ref: l.existing.ref, content: l.existing.text } : null };
      });
    // What no longer holds (newest first): the bot is told not to use these any more.
    const retired = mem.retired ? mem.retired(userId, p.dossier_id, 50) : [];
    return { dossierId: p.dossier_id, dossierStatus: d.dossier?.status || null, facts, review, retired, size: this.kbSize(agent) };
  }

  /**
   * "Werkt niet meer": retire one fact of a knowledge base with the reason, by the owner (Kennisbank page), by the
   * specialist itself or a bot of its home team (knowledge_retire), or by the learning round (gone from its source).
   */
  retireFact(userId: string, specialistId: string, ref: string, reason: string, by: { type: 'user' | 'agent' | 'system'; id?: string | null }) {
    const agent = this.ownAgent(userId, specialistId);
    const p = this.profile(specialistId);
    const mem = this.ctx.services.memory;
    if (!p?.dossier_id || !mem?.retire) throw bad('Het geheugen is niet beschikbaar.');
    const row = mem.svc.resolve(userId, ref)?.row || mem.svc.itemRow(ref);
    if (!row || row.dossier_id !== p.dossier_id) throw new HttpError(404, `Dit feit staat niet in de kennisbank van ${agent.name}.`);
    const why = clip(String(reason || ''), 300);
    if (why.length < 3) throw bad('Zeg kort waarom dit niet meer klopt.');
    if (looksLikeInstruction(why)) throw bad('Schrijf de reden als een feit, niet als een opdracht.');
    const out = mem.retire(userId, row.id, { reason: why, actor: by.type, actorId: by.id ?? null });
    this.recordManual(agent, { kind: 'retired', text: mem.svc.contentOf(row), itemId: row.id, ref: row.ref, changeId: out.changeId, existing: { text: why } }, by.type === 'user' ? 'owner' : 'bot');
    this.emit(userId, specialistId, 'knowledge');
    return out;
  }

  // ------------------------------------------------------------------ team rules

  /** Who may read a specialist's knowledge base: the bot itself, bots of its home team, bots with meekijken/aansturen. */
  canRead(callerId: string, specialistId: string): boolean {
    if (callerId === specialistId) return true;
    const caller = this.store.agent(callerId);
    const spec = this.store.agent(specialistId);
    if (!caller || !spec || caller.user_id !== spec.user_id) return false;
    const teams = this.ctx.services.teams;
    if (!teams?.teamOf) return true; // no teams module: one team, every bot of the owner
    try {
      const home = teams.teamOf(spec.id);
      return !!home && !!teams.canRead(caller.id, home);
    } catch {
      return false; // fail closed
    }
  }

  /** Who may add to it: the bot itself and bots whose home team is the specialist's home team. */
  canWrite(callerId: string, specialistId: string): boolean {
    if (callerId === specialistId) return true;
    const caller = this.store.agent(callerId);
    const spec = this.store.agent(specialistId);
    if (!caller || !spec || caller.user_id !== spec.user_id) return false;
    const teams = this.ctx.services.teams;
    if (!teams?.teamOf) return true;
    try {
      const home = teams.teamOf(spec.id);
      return !!home && !!teams.canWrite(caller.id, home);
    } catch {
      return false;
    }
  }

  /** Facts of one specialist's knowledge base that match a query (memory's own search, limited to that dossier). */
  searchKb(userId: string, specialistId: string, query: string, limit = 8): any[] {
    const p = this.active(specialistId);
    const mem = this.ctx.services.memory;
    if (!p?.dossier_id || !mem?.search || !String(query || '').trim()) return [];
    return (mem.search(userId, query, { agentId: specialistId, scope: 'dossier', limit: Math.max(limit * 3, 20) }) as any[]).filter((x) => x.dossier_id === p.dossier_id).slice(0, limit);
  }

  /** Specialists whose knowledge base this bot may read (itself first). */
  readableSpecialists(caller: Agent): ProfileRow[] {
    return this.profiles(caller.user_id)
      .filter((p) => p.enabled && p.field && p.dossier_id && this.canRead(caller.id, p.agent_id))
      .sort((a, b) => (a.agent_id === caller.id ? -1 : b.agent_id === caller.id ? 1 : 0));
  }

  // ------------------------------------------------------------------ facts added by hand or by a bot

  /**
   * Add one fact to a knowledge base through the memory pipeline (dedup, conflicts, secrets, quotas). `by` is the
   * owner (from the Kennisbank page) or a bot of the home team (knowledge_add).
   */
  addFact(userId: string, specialistId: string, o: { content: string; source?: string | null; replaces?: string | null; by: { type: 'user' } | { type: 'agent'; id: string; tainted?: boolean; runId?: string; callId?: string } }) {
    const agent = this.ownAgent(userId, specialistId);
    if (!this.active(specialistId)) throw bad(`${agent.name} is nog geen specialist.`);
    const content = clip(String(o.content || ''), 600);
    if (content.length < 8) throw bad('Schrijf het feit in een hele zin.');
    if (looksLikeInstruction(content)) throw bad('Dit lijkt een opdracht en geen feit; een kennisbank bewaart alleen feiten.');
    const dossierId = this.kbDossier(agent, true);
    const mem = this.ctx.services.memory;
    if (!dossierId || !mem?.remember) throw bad('Het geheugen is niet beschikbaar.');
    let src: { kind: string; ref: string | null; trust: string; excerpt?: string | null } = { kind: o.by.type === 'user' ? 'user' : 'tool', ref: null, trust: o.by.type === 'user' ? 'user' : 'agent' };
    if (o.source) {
      const s = String(o.source).trim().slice(0, 1000);
      src = { ...src, kind: /^https?:\/\//i.test(s) ? 'url' : 'file', ref: s };
    }
    // The fact this one replaces (the same subject, newer): must be in this knowledge base.
    const old = o.replaces ? mem.svc?.resolve(userId, String(o.replaces).replace(/^\[|\]$/g, ''))?.row : null;
    const out = mem.remember(userId, {
      content,
      scope: 'dossier',
      dossierId,
      type: 'fact',
      replacesId: old && old.dossier_id === dossierId ? old.id : null,
      reviewKind: mem.reviewKindOf?.(content) || 'practice',
      source: src,
      createdBy: o.by.type === 'user' ? 'user' : 'agent',
      createdByAgent: o.by.type === 'agent' ? o.by.id : null,
      idemKey: o.by.type === 'agent' && o.by.callId ? `t:${o.by.callId}` : null,
      // A bot that read outside content in this task proposes instead of storing (memory's own rule for bot notes).
      forcePropose: o.by.type === 'agent' && !!o.by.tainted,
      proposalReason: o.by.type === 'agent' && o.by.tainted ? 'tainted' : undefined,
    });
    if (out?.item) {
      const line: RoundLine = { kind: out.action === 'inserted' ? 'new' : out.action === 'superseded' ? 'updated' : out.action === 'conflict' ? 'conflict' : out.action === 'duplicate' ? 'duplicate' : 'proposed', text: content, source: src.ref || undefined, itemId: out.item.id, ref: out.item.ref, changeId: out.changeId || null, existing: out.existing ? { ref: out.existing.ref, text: out.existing.content } : null };
      this.recordManual(agent, line, o.by.type === 'user' ? 'owner' : 'bot');
    }
    this.emit(userId, specialistId, 'knowledge');
    return out;
  }

  /** Facts added outside a round are kept in a "round" of their own per day, so they have undo like the rest. */
  private recordManual(agent: Agent, line: RoundLine, who: 'owner' | 'bot') {
    const day = now().slice(0, 10);
    const trigger = who === 'owner' ? 'owner' : 'bot';
    const r = this.store.one<any>("SELECT * FROM specialist_rounds WHERE agent_id = ? AND trigger = ? AND substr(started_at, 1, 10) = ? AND status = 'done' LIMIT 1", agent.id, trigger, day);
    if (r) {
      const row = this.store.decode<any>('specialist_rounds', r);
      const lines = [...(row.lines || []), line].slice(-200);
      const stats = { ...(row.stats || {}) };
      if (line.kind === 'new') stats.newFacts = (stats.newFacts || 0) + 1;
      if (line.kind === 'conflict') stats.conflicts = (stats.conflicts || 0) + 1;
      this.store.update('specialist_rounds', r.id, { lines, stats, finished_at: now() });
    } else {
      const ts = now();
      this.store.insert('specialist_rounds', { id: newId('spr_'), agent_id: agent.id, user_id: agent.user_id, trigger, status: 'done', engine: null, stats: { newFacts: line.kind === 'new' ? 1 : 0, conflicts: line.kind === 'conflict' ? 1 : 0 }, lines: [line], summary: who === 'owner' ? 'Zelf toegevoegd' : 'Door een bot toegevoegd', started_at: ts, finished_at: ts });
    }
  }

  // ------------------------------------------------------------------ learning goals

  goals(agentId: string, status?: string): GoalRow[] {
    return this.store.find<GoalRow>('specialist_goals', status ? { agent_id: agentId, status } : { agent_id: agentId }, { order: 'created_at DESC', limit: 200 });
  }

  /** Add a learning goal (a similar open goal counts once more instead). Null when the list is full or empty. */
  addGoal(agent: Agent, o: { question: string; origin: GoalRow['origin']; threadId?: string | null; messageId?: string | null }): { goal: GoalRow; created: boolean } | null {
    const q = clip(ownWords(o.question), 300);
    if (tokens(q).length < 2 || looksLikeInstruction(q)) return null;
    const open = this.goals(agent.id, 'open');
    const t = tokens(q);
    const same = open.find((g) => jaccard(t, tokens(g.question)) >= 0.6);
    if (same) {
      this.store.update('specialist_goals', same.id, { hits: same.hits + 1, updated_at: now() });
      return { goal: this.store.get<GoalRow>('specialist_goals', same.id)!, created: false };
    }
    if (open.length >= MAX_OPEN_GOALS) return null;
    const ts = now();
    const id = newId('spg_');
    this.store.insert('specialist_goals', { id, agent_id: agent.id, user_id: agent.user_id, question: q, origin: o.origin, status: 'open', hits: 1, tries: 0, thread_id: o.threadId ?? null, message_id: o.messageId ?? null, created_at: ts, updated_at: ts });
    this.emit(agent.user_id, agent.id, 'goals');
    return { goal: this.store.get<GoalRow>('specialist_goals', id)!, created: true };
  }

  updateGoal(userId: string, goalId: string, patch: any) {
    const g = this.store.get<GoalRow>('specialist_goals', goalId);
    if (!g || g.user_id !== userId) throw new HttpError(404, 'Leerdoel niet gevonden');
    const status = ['open', 'done', 'dropped'].includes(patch?.status) ? patch.status : g.status;
    this.store.update('specialist_goals', goalId, { status, note: status === 'dropped' && !g.note ? 'Weggehaald door jou' : g.note, done_at: status === 'open' ? null : g.done_at || now(), updated_at: now() });
    this.emit(userId, g.agent_id, 'goals');
    return this.store.get<GoalRow>('specialist_goals', goalId);
  }

  removeGoal(userId: string, goalId: string) {
    const g = this.store.get<GoalRow>('specialist_goals', goalId);
    if (!g || g.user_id !== userId) throw new HttpError(404, 'Leerdoel niet gevonden');
    this.store.remove('specialist_goals', goalId);
    this.emit(userId, g.agent_id, 'goals');
    return { ok: true };
  }

  /**
   * After a chat with the owner: when the specialist said it does not know, the owner's question becomes a learning
   * goal for the next round (with a short note in the chat, so nothing changes silently).
   */
  noteGap(agent: Agent, thread: Thread, run: Run, finalText: string) {
    const p = this.active(agent.id);
    if (!p || thread.kind !== 'chat' || thread.room_id || thread.user_id !== agent.user_id) return;
    if (!['user', 'retry'].includes(run.trigger) || !saysUnknown(finalText)) return;
    const input = this.store.message(run.input_message_id);
    if (!input || input.role !== 'user' || input.author_type !== 'user' || input.author_id !== thread.user_id) return;
    const r = this.addGoal(agent, { question: input.content, origin: 'gap', threadId: thread.id, messageId: input.id });
    if (!r) return;
    const q = clip(r.goal.question, 120);
    const text = !r.created
      ? `Dit stond al als leerdoel van ${agent.name}: “${q}”.`
      : p.learn_on
        ? `Leerdoel voor de volgende leerronde van ${agent.name}: “${q}”.`
        : `Leerdoel genoteerd voor ${agent.name}: “${q}”. Zet de leerronde aan om het op te zoeken.`;
    this.ctx.chat.addEvent(thread, text, { kind: 'specialist_goal', goalId: r.goal.id, agentId: agent.id });
  }

  // ------------------------------------------------------------------ rounds, reports, undo

  rounds(agentId: string, limit = 30) {
    return this.store.find<any>('specialist_rounds', { agent_id: agentId }, { order: 'started_at DESC', limit });
  }

  reports(agentId: string, limit = 20) {
    return this.store.find<any>('specialist_reports', { agent_id: agentId }, { order: 'created_at DESC', limit });
  }

  private memUndo(userId: string, changeId: string) {
    const mem = this.ctx.services.memory;
    if (typeof mem?.undo === 'function') return mem.undo(userId, changeId);
    if (typeof mem?.svc?.undo === 'function') return mem.svc.undo(userId, changeId, userId);
    throw new Error('Ongedaan maken kan nu niet: het geheugen is niet beschikbaar.');
  }

  /** Undo what one round learned (one line, or every line). Returns how many were undone and what failed. */
  undoRound(userId: string, roundId: string, index?: number | null) {
    const r = this.store.get<any>('specialist_rounds', roundId);
    if (!r || r.user_id !== userId) throw new HttpError(404, 'Leerverslag niet gevonden');
    const lines: RoundLine[] = r.lines || [];
    let undone = 0;
    const failed: string[] = [];
    lines.forEach((l, i) => {
      if (index !== undefined && index !== null && i !== index) return;
      if (l.undone || !l.changeId || !['new', 'updated', 'retired', 'conflict', 'proposed'].includes(l.kind)) return;
      try {
        this.memUndo(userId, l.changeId);
        l.undone = true;
        undone++;
      } catch (e: any) {
        // Already undone in Geheugen (or forgotten): the line simply says so now.
        if (/al ongedaan/i.test(String(e?.message))) l.undone = true;
        else failed.push(`${clip(l.text, 60)}: ${e?.message || e}`);
      }
    });
    this.store.update('specialist_rounds', roundId, { lines });
    this.emit(userId, r.agent_id, 'knowledge');
    return { undone, failed };
  }

  /** Undo everything a weekly report lists. */
  undoReport(userId: string, reportId: string) {
    const rep = this.store.get<any>('specialist_reports', reportId);
    if (!rep || rep.user_id !== userId) throw new HttpError(404, 'Leerverslag niet gevonden');
    let undone = 0;
    const failed: string[] = [];
    for (const rid of rep.data?.roundIds || []) {
      try {
        const r = this.undoRound(userId, rid);
        undone += r.undone;
        failed.push(...r.failed);
      } catch {
        /* round gone */
      }
    }
    return { undone, failed };
  }

  /**
   * The weekly learning report: what the specialist learned since the last report, with sources, as a card in the
   * Kennisbank, a timeline entry in its knowledge dossier (Geheugen) and a notification. `force` makes it now.
   */
  weeklyReport(userId: string, agentId: string, o: { force?: boolean } = {}) {
    const agent = this.ownAgent(userId, agentId);
    const p = this.active(agentId);
    if (!p) return null;
    const since = p.last_report_at || p.learn_since || p.created_at;
    if (!o.force && Date.now() - Date.parse(since) < WEEK) return null;
    const rounds = this.store.all<any>("SELECT * FROM specialist_rounds WHERE agent_id = ? AND started_at > ? AND finished_at IS NOT NULL ORDER BY started_at", agentId, since).map((r) => this.store.decode<any>('specialist_rounds', r));
    if (!rounds.length && !o.force) return null;
    const facts: any[] = [];
    const conflicts: any[] = [];
    const errors: string[] = [];
    const gone: any[] = [];
    const sources = new Map<string, string>();
    let ignored = 0;
    let duplicates = 0;
    for (const r of rounds) {
      (r.lines as RoundLine[]).forEach((l, index) => {
        if ((l.kind === 'new' || l.kind === 'updated') && !l.undone) facts.push({ text: l.text, ref: l.ref, source: l.source, sourceLabel: l.sourceLabel, roundId: r.id, index, was: l.kind === 'updated' ? l.existing?.text : undefined });
        if (l.kind === 'retired' && !l.undone) gone.push({ text: l.text, ref: l.ref, reason: l.existing?.text, roundId: r.id, index });
        if (l.kind === 'conflict' && !l.undone) conflicts.push({ text: l.text, ref: l.ref, existing: l.existing, source: l.source, roundId: r.id, index });
        if (l.kind === 'ignored') ignored++;
        if (l.kind === 'duplicate') duplicates++;
        const err = l.kind === 'error' ? clip(`${l.sourceLabel || l.source || ''}: ${l.text}`, 200) : '';
        if (err && errors.length < 10 && !errors.includes(err)) errors.push(err);
        if ((l.kind === 'new' || l.kind === 'conflict') && l.source && sources.size < 20) sources.set(l.source, l.sourceLabel || l.source);
      });
    }
    const goalsDone = this.store.all<any>("SELECT id, question, answer_ref FROM specialist_goals WHERE agent_id = ? AND status = 'done' AND done_at > ?", agentId, since);
    const n = facts.length;
    const c = conflicts.length;
    const first = n === 0 ? `${agent.name} leerde deze week niets nieuws.` : n === 1 ? `${agent.name} leerde deze week 1 nieuw feit.` : `${agent.name} leerde deze week ${n} nieuwe feiten.`;
    const second = c === 0 ? '' : c === 1 ? ' 1 feit botst met wat hij al wist en is te controleren.' : ` ${c} feiten botsen met wat hij al wist en zijn te controleren.`;
    const third = goalsDone.length === 0 ? '' : goalsDone.length === 1 ? ' 1 leerdoel is beantwoord.' : ` ${goalsDone.length} leerdoelen zijn beantwoord.`;
    const fourth = gone.length === 0 ? '' : gone.length === 1 ? ' 1 feit klopt niet meer en is vervallen.' : ` ${gone.length} feiten kloppen niet meer en zijn vervallen.`;
    const summary = first + second + third + fourth;
    const ts = now();
    let recordId: string | null = null;
    const mem = this.ctx.services.memory;
    const dossierId = this.kbDossier(agent, false);
    if (dossierId && mem?.dossiers?.addEvent) {
      const ev = { title: clip(`Leerverslag: ${summary}`, 300), body: clip(facts.map((f) => `- ${f.text}${f.source ? ` (bron: ${f.source})` : ''}`).join('\n'), 3800), facts: facts.slice(0, 10).map((f) => clip(f.text, 280)), sources: [...sources.keys()].slice(0, 10).map((s) => ({ kind: /^https?:/i.test(s) ? 'url' : 'file', ref: s, title: sources.get(s) || s })) };
      try {
        recordId = mem.dossiers.addEvent(userId, dossierId, ev, agentId)?.record?.id ?? null;
      } catch {
        try {
          recordId = mem.dossiers.addEvent(userId, dossierId, { title: ev.title }, agentId)?.record?.id ?? null;
        } catch (e) {
          this.ctx.log.warn('[specialists] report not in dossier', String(e));
        }
      }
    }
    const id = newId('sprp_');
    this.store.insert('specialist_reports', {
      id,
      agent_id: agentId,
      user_id: userId,
      period_from: since,
      period_to: ts,
      summary,
      data: { roundIds: rounds.map((r) => r.id), facts: facts.slice(0, 100), conflicts: conflicts.slice(0, 50), retired: gone.slice(0, 50), news: rounds.map((r) => r.news).filter((x) => x && (x.nieuw || x.gevolg)).slice(-5), goalsDone, errors, ignored, duplicates, rounds: rounds.length, sources: [...sources.entries()].map(([url, label]) => ({ url, label })) },
      record_id: recordId,
      created_at: ts,
    });
    this.store.update('specialist_profiles', agentId, { last_report_at: ts, updated_at: ts }, 'agent_id');
    this.ctx.events.emit(userId, 'notification', { title: `Leerverslag van ${agent.name}`, body: summary, link: `#/m/specialists/${agentId}/verslagen`, kind: 'memory', agentId });
    this.emit(userId, agentId, 'reports');
    return this.store.get<any>('specialist_reports', id);
  }

  /** Hourly: weekly reports that are due. */
  reportsDue() {
    for (const p of this.store.all<any>("SELECT agent_id, user_id FROM specialist_profiles WHERE enabled = 1 AND learn_on = 1")) {
      try {
        this.weeklyReport(p.user_id, p.agent_id);
      } catch (e) {
        this.ctx.log.warn('[specialists] weekly report failed', String(e));
      }
    }
  }

  // ------------------------------------------------------------------ templates, export, deletion

  /**
   * A template (package R) may bring `specialist: { field, suggestedSources[] }` per bot. The bot becomes a specialist
   * with these sources (and the default ones of its field) marked "voorgesteld", and the learning round on.
   */
  importForAgent(userId: string, agentId: string, spec: any): boolean {
    if (!spec || typeof spec !== 'object') return false;
    const agent = this.store.agent(agentId);
    if (!agent || agent.user_id !== userId) return false;
    const field = clip(String(spec.field || ''), 300);
    if (!field || looksLikeInstruction(field)) return false;
    const cur = this.profile(agentId);
    if (cur?.enabled) return false;
    const list: any[] = [];
    for (const s of (Array.isArray(spec.suggestedSources) ? spec.suggestedSources : []).slice(0, MAX_SOURCES)) {
      const url = typeof s === 'string' ? s : String(s?.url || s?.target || '');
      const kind: SourceKind = SOURCE_KINDS.includes(s?.kind) && s.kind !== 'file' ? s.kind : /(\.xml|\.rss|\.atom|\/feed\/?|\/rss\/?)(\?|$)/i.test(url) ? 'feed' : 'web';
      try {
        list.push({ ...this.cleanSource(agent, { kind, target: url, label: typeof s === 'object' ? s?.label : '' }), suggested: true });
      } catch {
        /* a bad suggestion is left out */
      }
    }
    // Next to what the template suggests: where the platform itself announces changes (defaults.ts).
    for (const d of defaultSourcesFor(`${field} ${agent.name} ${agent.role || ''}`)) {
      if (list.length >= MAX_SOURCES) break;
      if (!list.some((x) => x.target === d.target)) list.push({ ...d, enabled: true, suggested: true });
    }
    // The learning round stays off: it costs model calls, so it starts only when the owner (or a bot on his word) switches it on.
    this.save(userId, agentId, { enabled: true, field, learnOn: false, sources: list });
    return true;
  }

  /**
   * A bot whose name or role says it is a specialist in something — any subject ("Belastingadviseur",
   * "TikTok-specialist"), or one of the presets — and that was never set up: it becomes a specialist by itself, with
   * the learning round OFF (nothing that costs model calls starts by itself); once the round is switched on, its
   * sources are the preset's or the ones it finds itself (discoverSources). Once only: a
   * bot the owner switched the specialism off for (it has a profile) is never adopted again.
   */
  adopt(agent: Agent): boolean {
    if (agent.archived || this.profile(agent.id) || agent.settings?.specialist === false) return false;
    const field = fieldOf(agent.name, agent.role || '');
    if (!field || looksLikeInstruction(field)) return false;
    try {
      this.save(agent.user_id, agent.id, { enabled: true, field, learnOn: false });
      this.ctx.audit(agent.user_id, 'specialists.adopted', { agent: agent.name, field, preset: specialismOf(`${agent.name} ${roleHead(agent.role || '')}`)?.id || null }, agent.id);
      return true;
    } catch (e) {
      this.ctx.log.warn('[specialists] bot niet vanzelf specialist gemaakt', String(e));
      return false;
    }
  }

  /**
   * At start: a round that was running when TeamBot stopped is over (live, 0.4.4: two rounds stayed "bezig" for ever
   * after a restart, as the bot's last round). It did not count as a round, so the next check starts it again.
   */
  closeInterrupted(): number {
    const rows = this.store.all<{ id: string; agent_id: string; user_id: string }>("SELECT id, agent_id, user_id FROM specialist_rounds WHERE status = 'running'").filter((r) => !this.running.has(r.agent_id));
    const text = 'Onderbroken: TeamBot stopte tijdens deze leerronde. De volgende ronde begint opnieuw.';
    for (const r of rows) this.store.update('specialist_rounds', r.id, { status: 'error', error: text, summary: text, finished_at: now() });
    return rows.length;
  }

  /**
   * Once per specialist, after the update: a source the bot found by itself (discoverSources) that is not about its
   * field is switched off. Not removed: it stays in the list with the reason, and the owner can switch it on again.
   * Sources of a preset, of a template and the ones the owner added are never touched. Returns how many went off.
   */
  pruneOffTopic(agent: Agent): number {
    const p = this.profile(agent.id);
    if (!p?.enabled || !p.field || p.settings?.prunedAt) return 0;
    const found = Date.parse(p.settings?.discoveredAt || '') || 0;
    const known = new Set(defaultSourcesFor(`${p.field} ${agent.name} ${agent.role || ''}`).map((d) => d.target));
    const off: string[] = [];
    if (found) {
      for (const s of this.sources(agent.id)) {
        if (!s.suggested || !s.enabled || s.kind === 'file' || known.has(s.target) || (Date.parse(s.created_at) || 0) < found - 1000) continue;
        if (this.aboutWork(agent, p.field, s.label || '', s.target)) continue;
        this.store.update('specialist_sources', s.id, { enabled: false, last_error: 'Uitgezet door TeamBot: deze bron gaat niet over het vakgebied van de bot.', updated_at: now() });
        this.ctx.audit(agent.user_id, 'specialists.source_off', { agent: agent.name, source: s.target, label: s.label, reason: 'niet over het vakgebied' }, agent.id);
        off.push(s.label || s.target);
      }
    }
    this.store.update('specialist_profiles', agent.id, { settings: { ...p.settings, prunedAt: now() } }, 'agent_id');
    if (off.length) {
      // One whole sentence per form, never "een bron" or "hem"/"ze" as a value.
      const sources = off.map((x) => clip(x, 80)).join(', ');
      this.ctx.events.emit(agent.user_id, 'notification', { title: off.length === 1 ? `${agent.name} leert niet meer van een bron buiten zijn vak` : `${agent.name} leert niet meer van ${off.length} bronnen buiten zijn vak`, body: off.length === 1 ? `${sources}. Uitgezet, niet weggehaald: je vindt hem bij de bot onder Specialisme.` : `${sources}. Uitgezet, niet weggehaald: je vindt ze bij de bot onder Specialisme.`, link: `#/m/specialists/${agent.id}/bronnen`, kind: 'memory', agentId: agent.id });
      this.emit(agent.user_id, agent.id);
    }
    return off.length;
  }

  /** At start: adopt known specialists and make every learning routine match its profile (after an update). */
  syncAll() {
    for (const a of this.store.all<any>('SELECT id FROM agents')) {
      const agent = this.store.agent(a.id);
      if (!agent || agent.archived) continue;
      try {
        this.pruneOffTopic(agent);
        if (!this.adopt(agent)) this.dropRoutine(agent);
      } catch (e) {
        this.ctx.log.warn('[specialists] leerroutine niet bijgewerkt', String(e));
      }
    }
  }

  /** For a bot or team template: field and sources, never what was learned. */
  exportForAgent(userId: string, agentId: string) {
    const p = this.profile(agentId);
    if (!p || p.user_id !== userId || !p.enabled || !p.field) return null;
    return { field: p.field, suggestedSources: this.sources(agentId).filter((s) => s.kind !== 'file').map((s) => ({ url: s.target, kind: s.kind, label: s.label || undefined })) };
  }

  exportUser(userId: string) {
    const strip = (rows: any[]) => rows.map(({ user_id, ...r }) => (void user_id, r));
    return {
      specialists: {
        profiles: strip(this.store.find<any>('specialist_profiles', { user_id: userId })),
        sources: strip(this.store.find<any>('specialist_sources', { user_id: userId })).map(({ state, ...s }) => (void state, s)),
        goals: strip(this.store.find<any>('specialist_goals', { user_id: userId })),
        rounds: strip(this.store.find<any>('specialist_rounds', { user_id: userId }, { order: 'started_at DESC', limit: 500 })),
        reports: strip(this.store.find<any>('specialist_reports', { user_id: userId })),
        proposals: strip(this.store.find<any>('specialist_proposals', { user_id: userId })),
      },
    };
  }

  /** A bot was deleted: its specialist rows go (its routine goes with the routines module; the dossier stays in Geheugen). */
  agentDeleted(agentId: string) {
    this.store.tx(() => {
      for (const t of ['specialist_pages', 'specialist_sources', 'specialist_goals', 'specialist_rounds', 'specialist_reports', 'specialist_procedures', 'specialist_proposals']) this.store.exec(`DELETE FROM ${t} WHERE agent_id = ?`, agentId);
      this.store.exec('DELETE FROM specialist_profiles WHERE agent_id = ?', agentId);
    });
  }

  /** Read a text file (or the text files of a folder) of the bot, within its own folders. */
  readOwnFiles(agent: Agent, target: string): { url: string; title: string; text: string }[] {
    const p = resolveInWorkspace(agent, target);
    const st = fs.statSync(p);
    const files = st.isDirectory()
      ? fs
          .readdirSync(p, { withFileTypes: true })
          .filter((e) => e.isFile() && /\.(md|markdown|txt|text|html?|csv|json|xml|rst|adoc)$/i.test(e.name))
          .slice(0, 20)
          .map((e) => path.join(p, e.name))
      : [p];
    const out: { url: string; title: string; text: string }[] = [];
    let total = 0;
    for (const f of files) {
      const size = fs.statSync(f).size;
      if (size > 1_000_000 || total + size > 3_000_000) continue;
      total += size;
      out.push({ url: f, title: path.basename(f), text: fs.readFileSync(f, 'utf8') });
    }
    return out;
  }
}
