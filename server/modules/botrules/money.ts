import type { ParsedRule, RuleEffect, RuleMatch } from './parse.js';

/**
 * Rules about money, and which of two rules is the stricter one. Used by the tools with which bots set rules for the
 * owner (the main bot's bot_rules, every bot's propose_rule): a bot may add a rule about money or make it stricter,
 * never remove it or make it looser. That stays with the owner himself.
 */
const MONEY_WORDS =
  /\bgeld\b|\bbetaa?l|terugbeta|budget|korting|\bkoop|\bkopen\b|aankoop|aankopen|afreken|uitgeef|uitgeven|uitgave|\bpay|purchas|\bbuy|refund|\bmoney\b|discount|\bspend|[€$]/i;
const MONEY_APPS = new Set(['stripe', 'mollie', 'paypal']);

export function aboutMoney(text: string, match?: RuleMatch | null): boolean {
  return match?.verb === 'pay' || (!!match?.app && MONEY_APPS.has(match.app)) || MONEY_WORDS.test(String(text || ''));
}

export const MONEY_REFUSAL =
  'Geweigerd door TeamBot: een regel over geld haalt een bot nooit weg en maakt een bot nooit losser. Dat doet de eigenaar zelf, bij de regels van de bot of het team. Een strengere regel over geld toevoegen mag wel.';

const RANK: Record<RuleEffect, number> = { allow: 0, ask: 1, deny: 2 };
const shape = (r: Pick<ParsedRule, 'match' | 'review'>) => JSON.stringify([Object.entries(r.match || {}).filter(([, v]) => v !== undefined && v !== false).sort(([a], [b]) => a.localeCompare(b)), !!r.review]);

/** Replacing `from` by `to` keeps the bot at least as strict: about the same thing, and never a lighter effect. */
export function atLeastAsStrict(from: Pick<ParsedRule, 'effect' | 'match' | 'review'>, to: Pick<ParsedRule, 'effect' | 'match' | 'review'>): boolean {
  return RANK[to.effect] >= RANK[from.effect] && shape(from) === shape(to);
}

export const EFFECT_LABEL: Record<RuleEffect, string> = { deny: 'nooit', ask: 'eerst vragen', allow: 'mag zonder vragen' };
