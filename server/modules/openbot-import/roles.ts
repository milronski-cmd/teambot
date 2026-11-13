import type { ObAgent, ObRoutine, ObSkill } from './reader.js';
import { listText } from '../../core/i18n.js';

/**
 * Proposals for the 0.4 team model, from what the owner built in OpenBot: which bot is the boss (main bot or team
 * lead), which bots are specialists (a knowledge round), and which routines answer customers. Only proposals: the
 * owner sees and changes them in the preview. Plain heuristics on names, descriptions, instructions and routine names;
 * when two bots look equally like the boss, none is proposed (never guess).
 */

export const DEFAULT_TEAM_NAME = 'Mijn team';
/** Second choice when the proposed name is already one of the owner's teams. */
const FALLBACK_TEAM_NAME = 'Team uit OpenBot';

const norm = (s: string) =>
  String(s || '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

/** A team name for the import: OpenBot's workspace name, else "Mijn team"; never one the owner already has. */
export function proposeTeamName(workspaceName: string, taken: string[]): { name: string; fromOpenBot: boolean } {
  const used = new Set(taken.map(norm));
  const free = (n: string) => !used.has(norm(n));
  const base = workspaceName.trim();
  if (base && free(base)) return { name: base, fromOpenBot: true };
  if (free(DEFAULT_TEAM_NAME)) return { name: DEFAULT_TEAM_NAME, fromOpenBot: false };
  if (free(FALLBACK_TEAM_NAME)) return { name: FALLBACK_TEAM_NAME, fromOpenBot: false };
  for (let i = 2; i < 100; i++) if (free(`${FALLBACK_TEAM_NAME} ${i}`)) return { name: `${FALLBACK_TEAM_NAME} ${i}`, fromOpenBot: false };
  return { name: `${FALLBACK_TEAM_NAME} ${Date.now() % 1000}`, fromOpenBot: false };
}

// ---------------------------------------------------------------- the boss

/** Names that mean "the boss of the team" on their own (the whole name, so "Baas Live" is not one). */
const BOSS_NAMES = new Set(['baas', 'de baas', 'boss', 'the boss', 'hoofdbot', 'hoofd', 'hoofdagent', 'hoofd-agent', 'lead', 'leider', 'teamleider', 'teamlead', 'team lead', 'chief', 'chief of staff', 'orchestrator', 'coordinator', 'coördinator', 'manager', 'ceo', 'directeur', 'regisseur']);
/** Words in a description or instructions that say the bot leads the team. */
const BOSS_WORDS = /(hoofd-?agent|hoofdbot|teamleider|team ?lead\b|chief of staff|orchestrator|leidt het team|baas van|bewaakt het geheel|verdeelt (?:het )?werk|co[oö]rdineert het team)/i;
/** A variant of a bot (voice line, test, copy) is never the boss itself. */
const VARIANT = /\b(live|voice|stem|spraak|spraaklijn|test|kopie|copy|backup|reserve)\b/i;

export interface BossPick {
  /** OpenBot agent id of the proposed boss, or null. */
  key: string | null;
  /** Why (Dutch, short), for the preview. */
  reason: string;
}

function bossScore(a: ObAgent): { score: number; why: string[] } {
  if (VARIANT.test(a.name)) return { score: 0, why: [] };
  let score = 0;
  const why: string[] = [];
  if (a.lead) {
    score += 4;
    why.push('in OpenBot gemarkeerd als leider');
  }
  if (BOSS_NAMES.has(norm(a.name))) {
    score += 3;
    why.push(`de naam “${a.name}”`);
  }
  if (BOSS_WORDS.test(a.description)) {
    score += 2;
    why.push('de beschrijving');
  } else if (BOSS_WORDS.test(a.instructions.slice(0, 1500))) {
    score += 1;
    why.push('de instructies');
  }
  return { score, why };
}

/** The bot that is clearly the boss: the best score of at least 3, and better than every other bot. */
export function pickBoss(agents: ObAgent[]): BossPick {
  const scored = agents.map((a) => ({ a, ...bossScore(a) })).sort((x, y) => y.score - x.score);
  const [best, second] = scored;
  if (!best || best.score < 3) return { key: null, reason: 'Geen bot is duidelijk de baas van het team.' };
  if (second && second.score === best.score) return { key: null, reason: `${best.a.name} en ${second.a.name} lijken allebei de baas; kies zelf.` };
  return { key: best.a.id, reason: `Voorgesteld vanwege ${listText(best.why)}.` };
}

// ---------------------------------------------------------------- specialists

/** Routine names of a learning round: knowledge, research, news, trends, opportunities. */
const ROUND = /(kennis|leerronde|research|onderzoeksronde|nieuwsronde|trendronde|bronnenronde|kansenronde|learning|knowledge)/i;
const SPECIALIST_NAME = /\b(kennis|knowledge|research|onderzoek|onderzoeker|expert|specialist|analist|analyst)\b/i;
const LEARNS = /(kennis|kennisbank|bronnen|nieuwe kennis|leert|vakkennis|research|onderzoekt)/i;

export interface Source {
  label: string;
  url?: string;
}

export interface SpecialistPick {
  key: string;
  /** The field (vakgebied), one sentence. */
  field: string;
  sources: Source[];
  /** Routines that are the bot's learning round (names). */
  rounds: string[];
  reason: string;
}

/** Strip markdown and keep the first sentence (max. 200 characters). */
export function firstSentence(s: string): string {
  const t = String(s || '')
    .replace(/[*_`#>]+/g, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
  const m = t.match(/^(.+?[.!?])(\s|$)/);
  const one = (m ? m[1] : t).trim();
  return one.length > 200 ? one.slice(0, 199).trimEnd() + '…' : one;
}

/** The field from the instructions: a "Vakgebied:" line, else the first plain sentence; else the description. */
export function fieldOf(a: Pick<ObAgent, 'instructions' | 'description'>): string {
  const explicit = a.instructions.match(/^\s*[-*]?\s*\**\s*(vakgebied|vak|expertise|specialisme|domein|field|focus)\s*\**\s*[:：]\s*(.{4,})$/im);
  if (explicit) return firstSentence(explicit[2]);
  let fence = false;
  for (const line of a.instructions.split(/\r?\n/)) {
    const l = line.trim();
    if (l.startsWith('```')) {
      fence = !fence;
      continue;
    }
    if (fence || !l || l.startsWith('#') || /^([-*+>|]|\d+[.)])\s/.test(l) || l.startsWith('---')) continue;
    const s = firstSentence(l);
    if (s.length >= 12) return s;
  }
  return firstSentence(a.description);
}

const URL_RE = /https?:\/\/[^\s<>()"'`\]\\{}|]+/g;
/** Links that are tools, not sources: logins, tokens, APIs, webhooks, this computer. */
const NOT_A_SOURCE = /(oauth|\btokens?\b|\bauth\b|\blogin\b|signin|sign-in|password|wachtwoord|webhook|\/api(\/|$)|^api\.|\.local$|^localhost$|^127\.|^0\.0\.0\.0$|^\[?::1\]?$)/i;
const SUBREDDIT = /(?:^|[\s(,;])r\/([A-Za-z0-9_]{2,21})\b/g;
const SOURCES_LINE = /^\s*[-*]?\s*\**\s*(bronnen|sources|bron)\s*\**\s*[:：]\s*(.+)$/gim;

/** Sources the bot learns from: links, subreddits and the items of a "Bronnen:" line (instructions, routines, skills). */
export function sourcesOf(texts: string[], max = 25): Source[] {
  const out: Source[] = [];
  const seen = new Set<string>();
  const add = (s: Source) => {
    const k = (s.url || s.label).toLowerCase().replace(/\/+$/, '');
    if (!k || seen.has(k) || out.length >= max) return;
    seen.add(k);
    out.push(s);
  };
  for (const t of texts) {
    for (const m of t.matchAll(SOURCES_LINE)) {
      // "Google Search Central, SE Roundtable, Reddit (via de browser), nieuwsbrieven. Blokkeert…" → items of the first sentence.
      const first = m[2].split(/\.\s+(?=\p{Lu})/u)[0].replace(/\([^)]*\)/g, '');
      for (const item of first.split(/[,;]/)) {
        const label = item.replace(/[`*_]+/g, '').replace(/\s+/g, ' ').replace(/[.:]+$/, '').trim();
        if (label.length >= 2 && label.length <= 80 && !/^https?:/i.test(label)) add({ label });
      }
    }
  }
  for (const t of texts) {
    for (const m of t.matchAll(URL_RE)) {
      // A link template ("https://www.reddit.com/r/<sub>/…") is no source.
      if (/[<{]/.test(t[(m.index ?? 0) + m[0].length] || '')) continue;
      const url = m[0].replace(/[.,;:!?)\]]+$/, '');
      let label = url;
      try {
        const u = new URL(url);
        if (NOT_A_SOURCE.test(u.hostname) || NOT_A_SOURCE.test(u.pathname) || u.username || u.password) continue;
        label = u.hostname.replace(/^www\./, '') + (u.pathname.length > 1 ? u.pathname.replace(/\/+$/, '') : '');
      } catch {
        continue;
      }
      add({ label, url });
    }
    for (const m of t.matchAll(SUBREDDIT)) add({ label: `r/${m[1]}`, url: `https://www.reddit.com/r/${m[1]}/` });
  }
  return out;
}

/**
 * Bots that run a knowledge round (a routine named after knowledge, research, news, trends or opportunities) and look
 * like a learner by name or description. The boss is never a specialist.
 */
export function pickSpecialists(agents: ObAgent[], routines: ObRoutine[], skills: ObSkill[], skillText: (s: ObSkill) => string, bossKey: string | null): SpecialistPick[] {
  const out: SpecialistPick[] = [];
  for (const a of agents) {
    if (a.id === bossKey) continue;
    const mine = routines.filter((r) => r.agentId === a.id);
    const rounds = mine.filter((r) => ROUND.test(r.name));
    if (!rounds.length) continue;
    const named = SPECIALIST_NAME.test(a.name);
    const score = rounds.length + (named ? 2 : 0) + (LEARNS.test(a.description) ? 1 : 0);
    if (score < 3) continue;
    const ownSkills = skills.filter((s) => s.usedBy.includes(a.id) && s.klass !== 'openbot');
    const sources = sourcesOf([a.instructions, ...mine.map((r) => r.instruction), ...ownSkills.map(skillText)]);
    out.push({
      key: a.id,
      field: fieldOf(a),
      sources,
      rounds: rounds.map((r) => r.name),
      reason: rounds.length === 1 ? `Heeft een leerronde in OpenBot: ${rounds[0].name}.` : `Heeft leerrondes in OpenBot: ${rounds.map((r) => r.name).join(', ')}.`,
    });
  }
  return out;
}

// ---------------------------------------------------------------- customer routines

const SUPPORT_BOT = /(klant|customer|support|service|helpdesk)/i;
const CUSTOMER_WORK = /(inbox|mail|whatsapp|ticket|helpdesk|bericht|beantwoord|klant|customer)/i;

/** A routine of a customer service bot that reads or answers customers (stays off until a test run is approved). */
export function isCustomerRoutine(r: Pick<ObRoutine, 'name' | 'instruction'>, botName: string): boolean {
  return SUPPORT_BOT.test(botName) && (CUSTOMER_WORK.test(r.name) || CUSTOMER_WORK.test(r.instruction.slice(0, 800)));
}
