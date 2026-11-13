import { engineRank, type EngineFacts } from '../newbot/choices.js';

/**
 * The ONE main button of the first screen (pages/Home.tsx, Welcome), for every situation a real PC can be in: nothing
 * found, Claude Code or Codex found (logged in or not), Ollama or another engine found, an AI connected with a key, an
 * OpenBot installation found, and any mix of these. Every other way in stays on the screen as a quiet choice with its
 * own button. No imports besides choices.ts, so it is unit-tested directly (tests/welcome-main-action.test.ts).
 *
 * Order:
 *  1. An OpenBot installation (not taken over, not put away with "Niet nu"): "Bekijken wat er overkomt". It brings the
 *     whole team along, with the AI it used; "Niet nu" hands the main button to the AI below.
 *  2. The best AI that works right now (newbot/choices.ts order): own subscription, OpenCode, a local model, a free
 *     tier, a key.
 *  3. Claude Code or Codex on this PC, not logged in yet: "Inloggen".
 *  4. Nothing here (TeamBot has looked): "Gratis starten" (OpenCode with free models; TeamBot sets it up itself).
 */

/** Claude Code or Codex on this PC, as GET /api/cli-agents/subscriptions reports it. */
export interface SubscriptionFacts {
  id: string;
  installed: boolean;
  loggedIn?: boolean;
  billing: 'subscription' | 'api' | 'unknown';
}

/** A subscription engine that can be used right now. */
export const subscriptionReady = (it: SubscriptionFacts) => it.installed && it.loggedIn !== false;

/** Rank of a ready subscription engine for the "recommended" choice (see newbot/choices.ts). */
export const subscriptionRank = (it: SubscriptionFacts) => engineRank({ kind: it.id, type: 'cli', billing: it.billing === 'api' ? 'paid' : 'subscription' }) + (it.billing === 'api' ? 40 : 0);

type KindFacts = { type?: string; billing?: string; group?: string };

export interface StartSituation {
  /** An OpenBot installation on this PC that was neither taken over nor put away. */
  openbot: boolean;
  /** Claude Code and Codex on this PC; null while TeamBot is still looking. */
  subs: SubscriptionFacts[] | null;
  /** Free engines connected or found here (StartOptions.freeOptions): key `p:<provider>` or `k:<kind>`. */
  free: { key: string; kind: string }[];
  /** AI connected with a key (or another program): `p:<provider>`. */
  keyed: { id: string; kind: string; type?: string; billing?: string }[];
  /** What each kind of AI is (type, billing, group). */
  kinds: Map<string, KindFacts>;
}

const rank = (kind: string, type?: string, billing?: string, group?: string) => engineRank({ kind, type: type as EngineFacts['type'], billing: billing as EngineFacts['billing'], group });

/** `openbot`, `sub:<id>`, `p:<provider>`, `k:<kind>`, `free-start`, or null while TeamBot still looks. */
export type MainAction = string | null;

export function mainAction(s: StartSituation): MainAction {
  if (s.openbot) return 'openbot';
  const ready: { id: string; rank: number }[] = [];
  for (const it of s.subs || []) if (subscriptionReady(it)) ready.push({ id: `sub:${it.id}`, rank: subscriptionRank(it) });
  for (const o of s.free) {
    const k = s.kinds.get(o.kind);
    ready.push({ id: o.key, rank: rank(o.kind, k?.type || (o.kind === 'opencode' ? 'cli' : 'api'), k?.billing, k?.group) });
  }
  for (const p of s.keyed) {
    const k = s.kinds.get(p.kind);
    ready.push({ id: `p:${p.id}`, rank: rank(p.kind, p.type, p.billing ?? k?.billing, k?.group) });
  }
  const best = ready.sort((a, b) => a.rank - b.rank)[0]?.id;
  if (best) return best;
  const login = s.subs?.find((it) => it.installed && it.loggedIn === false);
  if (login) return `sub:${login.id}`;
  return s.subs ? 'free-start' : null;
}
