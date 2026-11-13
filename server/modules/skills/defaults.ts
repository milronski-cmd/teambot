import type { Agent, Ctx, Migration } from '../../core/types.js';
import type { SkillLibrary, SkillRow } from './library.js';

/**
 * The per-bot list (`agent.skills`) is what the screens show and edit: taking a skill off it takes the skill away from
 * that one bot. Which skills a bot has is decided in one place, library `enabledFor` (the active skills of its team,
 * minus what was taken away); this file only keeps the list complete, so that "not on the list" can mean "taken away".
 *
 * How: a skill a bot has and that was never on its list is put on it once, and that is kept (table skill_offers). A
 * skill that was on the list and no longer is, was taken away from that bot by the owner or by the bot itself, on
 * whatever path: it stays away. Runs at start (for data from before this rule), and when a bot or a skill changes.
 */
export const skillOfferMigrations: Migration[] = [
  {
    id: 'skills-offers-001',
    sql: `CREATE TABLE skill_offers (agent_id TEXT NOT NULL, skill_id TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (agent_id, skill_id));`,
  },
];

export class SkillDefaults {
  private busy = false;
  constructor(
    private ctx: Ctx,
    private lib: SkillLibrary,
  ) {}

  private active(userId: string): SkillRow[] {
    return this.ctx.store.all<any>("SELECT * FROM skills WHERE user_id = ? AND status = 'active' ORDER BY name", userId).map((r) => this.ctx.store.decode<SkillRow>('skills', r));
  }

  /** Offer one bot what it was not offered yet. Returns the bot as stored now. `active`: the owner's active skills. */
  offer(agent: Pick<Agent, 'id' | 'user_id'>, active?: SkillRow[]): Agent | null {
    const store = this.ctx.store;
    const cur = store.agent(agent.id);
    // A shared bot in a member's conversation is a copy with the member's id: only the stored bot of its owner counts.
    if (!cur || cur.user_id !== agent.user_id) return null;
    // Nothing for a bot that is archived, or that the teams module has not given its team yet (library `placed`).
    if (cur.archived || this.busy || !this.lib.placed(cur)) return cur;
    const list = active || this.active(cur.user_id);
    if (!list.length) return cur;
    const seen = new Set(store.all<{ skill_id: string }>('SELECT skill_id FROM skill_offers WHERE agent_id = ?', cur.id).map((r) => r.skill_id));
    const fresh = list.filter((s) => !seen.has(s.id) && this.lib.reach(cur, s) === 'use');
    if (!fresh.length) return cur;
    const have = new Set(Array.isArray(cur.skills) ? cur.skills : []);
    const add = fresh.filter((s) => !have.has(s.id)).map((s) => s.id);
    const ts = new Date().toISOString();
    this.busy = true;
    try {
      store.tx(() => {
        for (const s of fresh) store.exec('INSERT OR IGNORE INTO skill_offers (agent_id, skill_id, created_at) VALUES (?, ?, ?)', cur.id, s.id, ts);
        // Not a profile change by the owner: no new `updated_at`, no version.
        if (add.length) store.update('agents', cur.id, { skills: [...have, ...add] });
      });
      const next = store.agent(cur.id) || cur;
      if (add.length) this.ctx.events.emit(cur.user_id, 'agent.updated', next);
      return next;
    } finally {
      this.busy = false;
    }
  }

  /** Every bot of one owner. */
  offerAll(userId: string): number {
    if (this.busy) return 0;
    const active = this.active(userId);
    if (!active.length) return 0;
    let n = 0;
    for (const a of this.ctx.store.agents(userId)) {
      const before = (a.skills || []).length;
      const next = this.offer(a, active);
      if (next && (next.skills || []).length !== before) n++;
    }
    return n;
  }

  /** At start: every owner with bots. */
  upgrade(): number {
    let n = 0;
    for (const r of this.ctx.store.all<{ user_id: string }>('SELECT DISTINCT user_id FROM agents WHERE archived = 0')) n += this.offerAll(r.user_id);
    return n;
  }

  forget(o: { agentId?: string; skillId?: string }) {
    if (o.agentId) this.ctx.store.exec('DELETE FROM skill_offers WHERE agent_id = ?', o.agentId);
    if (o.skillId) this.ctx.store.exec('DELETE FROM skill_offers WHERE skill_id = ?', o.skillId);
  }
}
