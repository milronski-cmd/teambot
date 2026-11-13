import fs from 'node:fs';
import path from 'node:path';
import type { Agent, Ctx, Thread, User } from '../core/types.js';

/**
 * Shared bots (server mode, §21.3 P1 "gedeelde of persoonlijke bot, teaminbox", A-61).
 *
 * The owner (or an admin) of a server marks one of his own bots "Gedeeld met het team" (agent.settings.shared). Every
 * member then sees it under "Gedeeld" with the owner's name and talks to it in his OWN private conversations: the
 * thread belongs to the member (user_id), the owner cannot read it, the same as any other chat.
 *
 * In a member's conversation the bot runs as a narrowed copy of itself (`forMember`), never with the owner's
 * resources:
 *  - user_id is the member: memory (what he tells it is kept for him only), "Wacht op jou", notifications, approvals and
 *    questions, budget and usage all belong to the member; nothing of the owner is looked up through it;
 *  - its own private folder per member (data dir/shared-bots/<bot>/<member>), no extra folders, no team folder;
 *  - at most "Vraagt toestemming": everything with impact asks the member, the owner's "always allow" choices do not
 *    carry over (his "never" and "always ask" do);
 *  - only tools that work inside that private context (files in its own folder, internet, its own memory, questions to
 *    the member): no vault, channels, computer use, browser, terminal, the owner's routines, apps (MCP), skills, team
 *    database, websites or other bots of the owner; a CLI engine runs no commands and keeps to that folder;
 *  - the engine is the one the owner chose for the bot (sharing the bot is consent to that), with the member's own
 *    daily budget.
 * Owner-only actions (editing, sharing, routines of the bot, …) are refused with a plain explanation.
 */

/** Tools a shared bot keeps in a member's conversation; everything else does not exist for it there. */
export const SHARED_BOT_TOOLS = new Set([
  'ask_user',
  'ask_form',
  'notify_user',
  'plan_update',
  'show_html',
  'list_files',
  'read_file',
  'write_file',
  'edit_file',
  'search_files',
  'delete_file',
  'share_file',
  'read_document',
  'web_search',
  'web_fetch',
  'memory_search',
  'memory_get',
  'memory_remember',
  'memory_update',
  'memory_forget',
  'dossier_get',
  'dossier_add',
  'dossier_update',
  'dossier_note',
  'dossier_write',
]);

const ACCESS_RANK: Record<string, number> = { chat: 0, readonly: 1, ask: 2, auto: 3, full: 4 };

export interface SharedRun {
  ownerId: string;
  ownerName: string;
  memberId: string;
  memberName: string;
}

/** Shared bots exist only on a server (in desktop mode there is nobody to share with). */
export function sharingAvailable(ctx: Ctx): boolean {
  return ctx.config.mode === 'server';
}

export function isShared(ctx: Ctx, agent: Agent | null | undefined): boolean {
  return !!agent && sharingAvailable(ctx) && agent.settings?.shared === true && !agent.archived && !ctx.store.user(agent.user_id)?.disabled;
}

/** May this user talk to this bot (his own, or one shared with the team)? */
export function canTalkTo(ctx: Ctx, userId: string, agent: Agent | null | undefined): agent is Agent {
  if (!agent) return false;
  if (agent.user_id === userId) return true;
  const u = ctx.store.user(userId);
  return !!u && !u.disabled && isShared(ctx, agent);
}

/** The private folder of a shared bot for one member. */
export function sharedWorkspace(ctx: Ctx, agentId: string, memberId: string): string {
  const safe = (s: string) => s.replace(/[^a-zA-Z0-9_-]/g, '');
  return path.join(ctx.config.dataDir, 'shared-bots', safe(agentId), safe(memberId));
}

/** The member's run of a shared bot: who shares it with whom (null = the owner's own run). */
export function sharedRunOf(agent: Agent): SharedRun | null {
  const s = agent.settings?.sharedRun;
  return s && typeof s === 'object' && typeof s.ownerId === 'string' ? (s as SharedRun) : null;
}

/**
 * The bot as it runs in this thread. In the owner's own conversations: itself. In a member's conversation: the narrowed
 * copy described above. A bot that is not (or no longer) shared never runs in someone else's conversation.
 */
export function agentForThread(ctx: Ctx, agent: Agent, thread: Thread | null | undefined): Agent {
  if (!thread || thread.user_id === agent.user_id) return agent;
  if (!isShared(ctx, agent)) throw new Error(`${agent.name} is niet (meer) gedeeld met het team. Alleen ${ctx.store.user(agent.user_id)?.name || 'de eigenaar'} kan deze bot gebruiken.`);
  const member = ctx.store.user(thread.user_id);
  if (!member || member.disabled) throw new Error('Dit account is geblokkeerd.');
  return forMember(ctx, agent, member);
}

export function forMember(ctx: Ctx, agent: Agent, member: Pick<User, 'id' | 'name'>): Agent {
  const owner = ctx.store.user(agent.user_id);
  const workspace = sharedWorkspace(ctx, agent.id, member.id);
  try {
    fs.mkdirSync(workspace, { recursive: true });
  } catch {
    /* the file tools report a missing folder themselves */
  }
  // The owner's stricter choices stay; his "always allow" does not carry over to someone else's conversation.
  const tool_policy: Agent['tool_policy'] = {};
  for (const [k, v] of Object.entries(agent.tool_policy || {})) if (v === 'deny' || v === 'ask') tool_policy[k] = v;
  // The bot's own behaviour (memory, voice, thinking, limits …) stays; anything that widens access goes.
  const { extraRoots: _e, folders: _f, allowPrivateNetwork: _n, fullAccessExternal: _x, cli: rawCli, ...rest } = agent.settings || {};
  const cli = rawCli && typeof rawCli === 'object' ? { maxTurns: rawCli.maxTurns, timeoutMin: rawCli.timeoutMin, idleMin: rawCli.idleMin } : undefined;
  const settings: Record<string, any> = {
    ...rest,
    // No "own Claude Code settings/apps of the owner", no extra CLI arguments or pre-allowed CLI tools.
    ...(cli ? { cli } : {}),
    sharedRun: { ownerId: agent.user_id, ownerName: owner?.name || 'de eigenaar', memberId: member.id, memberName: member.name } satisfies SharedRun,
  };
  return {
    ...agent,
    user_id: member.id,
    workspace,
    access_mode: ACCESS_RANK[agent.access_mode] > ACCESS_RANK.ask ? 'ask' : agent.access_mode,
    tool_policy,
    skills: [],
    settings,
  };
}

/** For the system prompt of a member's conversation: who he is talking to and what the bot cannot do here. */
export function sharedPromptNote(agent: Agent): string {
  const s = sharedRunOf(agent);
  if (!s) return '';
  return [
    '## Gedeelde bot',
    `Je bent een gedeelde bot van ${s.ownerName}. Je praat nu met ${s.memberName}, een lid van het team, in een eigen gesprek dat ${s.ownerName} niet kan lezen.`,
    `Wat ${s.memberName} je vertelt, onthoud je alleen voor ${s.memberName}. Je werkt in een eigen map voor dit gesprek.`,
    `De mappen, kluis, kanalen, apps, computer, routines en andere bots van ${s.ownerName} zijn hier niet beschikbaar. Vraagt ${s.memberName} daarom, leg dan in gewone woorden uit dat alleen ${s.ownerName} dat kan.`,
  ].join('\n');
}

/** Plain refusal when a shared bot tries something only its owner can (a tool that does not exist here). */
export function ownerOnlyText(agent: Agent): string {
  const s = sharedRunOf(agent);
  const owner = s?.ownerName || 'de eigenaar';
  return `Dit kan alleen ${owner}. ${agent.name} is een gedeelde bot; in dit gesprek zijn de mappen, kluis, kanalen, apps, computer en routines van ${owner} niet beschikbaar. Leg dat in gewone woorden uit als erom gevraagd werd.`;
}
