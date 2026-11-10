import type { Agent, Ctx } from '../../core/types.js';
import { now } from '../../core/db.js';
import type { Binding } from './types.js';

type BotRef = Pick<Agent, 'id' | 'user_id'> & { name?: string };

/**
 * Channels per team (0.4, package B4). A channel belongs to one team: the home team of the bot it is bound to, or the
 * team of its group (`rooms.workspace_id`); a channel from before teams gets that team at start (`sync`), and it moves
 * along when its bot moves to another team. Only bots of that team answer on it or send through it (`channel_send`,
 * a routine's delivery); bots with meekijken or aansturen on that team see it in `channel_list`, read-only. A channel's
 * tokens also follow `keyAllowed(bot, 'channel', bindingId)`.
 *
 * With one team nothing changes: there is no wall to keep (like `delegateError`), only the key check.
 */
export class ChannelTeams {
  private syncing = false;

  constructor(private ctx: Ctx) {}

  private get svc(): any {
    return this.ctx.services.teams;
  }

  /** Two or more teams for this owner: only then are there walls between channels. */
  multi(userId: string): boolean {
    try {
      return !!this.svc?.multi?.(userId);
    } catch {
      return false;
    }
  }

  /** The team a channel should have from what it is bound to (its bot, or its group), or null when neither says. */
  targetTeam(b: Pick<Binding, 'user_id' | 'agent_id' | 'room_id'>): string | null {
    const t = this.svc;
    if (!t) return null;
    if (b.agent_id) {
      const id = t.teamOf(b.agent_id);
      if (id) return id;
    }
    if (b.room_id) {
      try {
        const r = this.ctx.store.one<{ workspace_id: string | null }>('SELECT workspace_id FROM rooms WHERE id = ? AND user_id = ?', b.room_id, b.user_id);
        if (r?.workspace_id && t.team(r.workspace_id)?.user_id === b.user_id) return r.workspace_id;
      } catch {
        /* no rooms table (rooms module off) */
      }
    }
    return null;
  }

  /**
   * The team id a channel belongs to: that of its bot or group right now (so it follows a bot that moved), else the
   * stored one (a channel whose bot was deleted), else the default team. Null without the teams module or any team.
   */
  teamOf(b: Binding): string | null {
    const t = this.svc;
    if (!t) return null;
    const live = this.targetTeam(b);
    if (live) return live;
    if (b.team_id && t.team(b.team_id)?.user_id === b.user_id) return b.team_id;
    return t.defaultTeam(b.user_id)?.id ?? null;
  }

  teamName(teamId: string | null): string {
    return (teamId && this.svc?.team(teamId)?.name) || '';
  }

  /** May this bot answer on, or send through, this channel? Bots of the channel's team, within the key's scope. */
  usable(agent: BotRef, b: Binding): boolean {
    const t = this.svc;
    if (!t) return true;
    if (t.keyAllowed(agent, 'channel', b.id) === false) return false;
    if (!this.multi(b.user_id)) return true;
    const team = this.teamOf(b);
    return !team || t.teamOf(agent.id) === team;
  }

  /** May this bot see the channel (channel_list)? Its own team's channels, and those of teams it may look into. */
  readable(agent: BotRef, b: Binding): boolean {
    if (this.usable(agent, b)) return true;
    const t = this.svc;
    const team = this.teamOf(b);
    return !!t && !!team && this.multi(b.user_id) && t.canRead(agent.id, team) && t.keyAllowed(agent, 'channel', b.id) !== false;
  }

  /** Why this bot may not answer on or send through this channel (Dutch, for the bot and the chat), or null. */
  refusal(agent: BotRef, b: Binding): string | null {
    if (this.usable(agent, b)) return null;
    const t = this.svc;
    const name = agent.name || this.ctx.store.agent(agent.id)?.name || 'Deze bot';
    const team = this.teamOf(b);
    if (!this.multi(b.user_id) || !team) return `Geweigerd door TeamBot: kanaal “${b.name}” is alleen voor één team, en ${name} mag het niet gebruiken.`;
    const home = t.teamOf(agent.id);
    const r = t.access(agent.id, team);
    const look = r === 'read' ? ' (alleen meekijken)' : r === 'direct' ? ' (aansturen: werk geven aan dat team, niet zelf versturen)' : '';
    return `Geweigerd door TeamBot: kanaal “${b.name}” hoort bij team “${this.teamName(team)}”, en ${name} hoort bij team “${this.teamName(home)}”${look}. Alleen bots van dat team antwoorden en versturen via dit kanaal.`;
  }

  /**
   * Give every channel of this owner (or of everyone) the team of its bot or group: the migration of channels from
   * before teams, and a bot or group that moved to another team takes its channels along. Returns the changed ids.
   */
  sync(userId?: string): string[] {
    const t = this.svc;
    if (!t || this.syncing) return [];
    this.syncing = true;
    const changed: string[] = [];
    try {
      const rows = userId
        ? this.ctx.store.find<Binding>('channel_bindings', { user_id: userId })
        : this.ctx.store.find<Binding>('channel_bindings', {});
      for (const b of rows) {
        const want = this.teamOf(b);
        if (!want || want === b.team_id) continue;
        this.ctx.store.update('channel_bindings', b.id, { team_id: want, updated_at: now() });
        changed.push(b.id);
      }
    } catch (e: any) {
      this.ctx.log.warn('[channels] team sync failed', e?.message || e);
    } finally {
      this.syncing = false;
    }
    return changed;
  }

  /** The team's business profile as approved knowledge lines (customer mode, when the owner chose that). */
  profileLines(b: Binding): string[] {
    const team = this.teamOf(b);
    const p = team ? this.svc?.team(team)?.profile : null;
    if (!p || typeof p !== 'object') return [];
    const out: string[] = [];
    const add = (label: string, v: any) => {
      for (const line of String(v || '').split(/\r?\n/).map((x) => x.trim()).filter(Boolean)) out.push(`${label}: ${line}`.slice(0, 1000));
    };
    add('Bedrijf', p.company);
    add('Wat we doen', p.about);
    add('Toon', p.tone);
    add('Regel', p.rules);
    return out.slice(0, 60);
  }
}
