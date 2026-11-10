/** Pure helpers for room routing: modes, limits and @-mention parsing. No ctx access (unit-testable). */

export type RoomMode = 'lead' | 'round_robin' | 'everyone' | 'mention';
export const MODES: RoomMode[] = ['lead', 'round_robin', 'everyone', 'mention'];

export const MODE_LABEL: Record<RoomMode, string> = {
  lead: 'Lead: de lead-bot antwoordt en verdeelt het werk',
  round_robin: 'Om de beurt: bots antwoorden na elkaar en zien elkaars bijdragen',
  everyone: 'Iedereen: alle bots antwoorden tegelijk',
  mention: 'Alleen op vermelding: alleen aangesproken bots antwoorden',
};

export interface Limits {
  /** Bot turns one human message may cause (incl. sequential turns, mentions, delegations, follow-ups). */
  maxTurnsPerMessage: number;
  /** Maximum delegation hops (A→B→C = 2). 0 disables delegation. */
  maxDelegationDepth: number;
  /** Ownership transfers per message chain. */
  maxHandoffs: number;
  /** Bots one broadcast may address. */
  maxBroadcastTargets: number;
  /** Model calls (steps) one bot turn may take inside this room. */
  maxStepsPerTurn: number;
  /** A bot turn that runs longer than this (excluding time waiting for a human) is stopped. */
  turnTimeoutSec: number;
  /** A delegated subtask that runs longer than this is stopped. */
  delegationTimeoutSec: number;
  /** Total spend cap for the room in USD (0 = no cap). Only models with known prices count. */
  maxCostUsd: number;
  /** Total token cap for the room (0 = no cap). Counts every model, also those without price info. */
  maxTokens: number;
  /** Bots may wake other bots with @name in their answer. */
  allowBotMentions: boolean;
  /** Bot turns one chain with asynchronous bot messages (ask_bot + answers that wake the sender) may cause. */
  maxAskTurns: number;
  /** Asynchronous messages one bot may send per hour (all recipients together). */
  maxAsksPerHour: number;
  /** Asynchronous messages from one bot to the same other bot per hour (ping-pong guard). */
  maxAsksPerPairPerHour: number;
  /** Spend cap for one chain of asynchronous bot messages in USD (0 = no cap; models with known prices). */
  maxChainCostUsd: number;
  /** Token cap for one chain of asynchronous bot messages (0 = no cap; counts every model, also subscriptions). */
  maxChainTokens: number;
}

export const DEFAULT_LIMITS: Limits = {
  maxTurnsPerMessage: 8,
  maxDelegationDepth: 3,
  maxHandoffs: 3,
  maxBroadcastTargets: 6,
  maxStepsPerTurn: 25,
  turnTimeoutSec: 600,
  delegationTimeoutSec: 900,
  maxCostUsd: 5,
  maxTokens: 2_000_000,
  allowBotMentions: true,
  maxAskTurns: 40,
  maxAsksPerHour: 60,
  maxAsksPerPairPerHour: 20,
  maxChainCostUsd: 3,
  maxChainTokens: 3_000_000,
};

const RANGES: Record<Exclude<keyof Limits, 'allowBotMentions'>, [number, number]> = {
  maxTurnsPerMessage: [1, 50],
  maxDelegationDepth: [0, 6],
  maxHandoffs: [0, 10],
  maxBroadcastTargets: [1, 20],
  maxStepsPerTurn: [1, 100],
  turnTimeoutSec: [1, 7200],
  delegationTimeoutSec: [1, 14_400],
  maxCostUsd: [0, 10_000],
  maxTokens: [0, 1_000_000_000],
  maxAskTurns: [1, 300],
  maxAsksPerHour: [1, 1000],
  maxAsksPerPairPerHour: [1, 500],
  maxChainCostUsd: [0, 10_000],
  maxChainTokens: [0, 1_000_000_000],
};

/** Validate/clamp a (partial) limits object; unknown keys are dropped. */
export function cleanLimits(input: any): Partial<Limits> {
  const out: Partial<Limits> = {};
  if (!input || typeof input !== 'object') return out;
  for (const [k, [lo, hi]] of Object.entries(RANGES) as [keyof typeof RANGES, [number, number]][]) {
    if (input[k] === undefined || input[k] === null || input[k] === '') continue;
    const n = Number(input[k]);
    if (!Number.isFinite(n)) continue;
    (out as any)[k] = Math.min(hi, Math.max(lo, k === 'maxCostUsd' || k === 'maxChainCostUsd' ? Math.round(n * 10000) / 10000 : Math.round(n)));
  }
  if (input.allowBotMentions !== undefined) out.allowBotMentions = !!input.allowBotMentions;
  return out;
}

export function effectiveLimits(...layers: (Partial<Limits> | null | undefined)[]): Limits {
  const out = { ...DEFAULT_LIMITS };
  for (const l of layers) Object.assign(out, cleanLimits(l));
  return out;
}

export interface Named {
  id: string;
  name: string;
}

const ALL_WORDS = new Set(['iedereen', 'allemaal', 'allen', 'all', 'everyone', 'everybody', 'alle']);

/** Case/accent/space-insensitive key for comparing names ("Data Analist" == "@data_analist"). */
export function nameKey(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[\s_.\-]+/g, '');
}

/** Remove code blocks, inline code and quoted lines so "@x" inside code never triggers anyone. */
export function stripCode(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`\n]*`/g, ' ')
    .split('\n')
    .filter((l) => !/^\s*>/.test(l))
    .join('\n');
}

export interface Mentions {
  /** Mentioned ids in order of first appearance. */
  ids: string[];
  /** @iedereen / @all was used. */
  all: boolean;
}

/**
 * Find who a message addresses. Supports "@Naam", "@Twee Woorden", "@twee_woorden", "@iedereen"/"@all" and
 * (when leading is true) a leading address such as "Ada, kun je…" or "Ada: …".
 */
export function findMentions(text: string, people: Named[], opts: { leading?: boolean } = {}): Mentions {
  const clean = stripCode(text || '');
  const ids: string[] = [];
  let all = false;
  const byKey = new Map<string, string>();
  for (const p of people) if (p.name) byKey.set(nameKey(p.name), p.id);
  const add = (id: string) => {
    if (!ids.includes(id)) ids.push(id);
  };
  const re = /(^|[^\p{L}\p{N}_@])@([\p{L}\p{N}_.\-]+(?:[ \t][\p{L}\p{N}_.\-]+){0,3})/gu;
  for (const m of clean.matchAll(re)) {
    const words = m[2].split(/[ \t]+/);
    for (let k = words.length; k >= 1; k--) {
      const key = nameKey(words.slice(0, k).join(' '));
      if (!key) continue;
      if (ALL_WORDS.has(key)) {
        all = true;
        break;
      }
      const id = byKey.get(key);
      if (id) {
        add(id);
        break;
      }
    }
  }
  if (opts.leading) {
    const lead = clean.match(/^\s*([\p{L}\p{N}_.\- ]{1,48}?)\s*[,:]\s/u);
    if (lead) {
      const key = nameKey(lead[1]);
      if (ALL_WORDS.has(key)) all = true;
      else if (byKey.has(key)) add(byKey.get(key)!);
    }
  }
  return { ids, all };
}

/** Rank of access modes; a higher rank means more autonomy. */
export const ACCESS_RANK: Record<string, number> = { chat: 0, readonly: 1, ask: 2, auto: 3 };
