import type { Agent, Decision, ToolImpact, ToolRisk } from '../../core/types.js';
import { APPS, type RuleEffect, type RuleMatch } from './parse.js';

/**
 * Does one rule apply to one tool call, and what does that do to the Broker's decision (package P6)?
 * The rules can make every level stricter. "Mag altijd" only lifts a question that the bot's level ("Vragen") asks for
 * a change or a command; never a send, payment, publish, delete or anything else of impact (risk "danger"), never a
 * per-tool choice the owner made, and never chat or read-only bots.
 */

export interface StoredRule {
  id: string;
  user_id: string;
  agent_id: string | null;
  team_id: string | null;
  text: string;
  effect: RuleEffect;
  match: RuleMatch;
  review: boolean;
  created_at: string;
}

export interface CallInfo {
  name: string;
  risk: ToolRisk;
  /** Undefined: no concrete call (which tools a bot gets); rules about a folder, website or recipient do not apply. */
  args?: any;
  internal?: boolean;
  /** For the "others" condition: who it goes to (fail-safe external). */
  impact?: ToolImpact;
  /** Adapter of the chat channel a channel_send goes through; '?' when unknown. */
  channel?: string | null;
}

const PATH_KEYS = ['path', 'paths', 'file', 'files', 'file_path', 'filePath', 'dir', 'directory', 'folder', 'target', 'destination', 'dest', 'source', 'src', 'from', 'cwd', 'notebook_path'];
const URL_KEYS = ['url', 'urls', 'href', 'link', 'site', 'website', 'domain', 'page'];

function strings(v: any): string[] {
  if (typeof v === 'string') return [v];
  if (Array.isArray(v)) return v.filter((x) => typeof x === 'string');
  return [];
}

export function pathsOf(args: any): string[] {
  if (!args || typeof args !== 'object') return [];
  const out: string[] = [];
  for (const k of PATH_KEYS) out.push(...strings(args[k]));
  return out;
}

export function urlsOf(args: any): string[] {
  if (!args || typeof args !== 'object') return [];
  const out: string[] = [];
  for (const k of URL_KEYS) out.push(...strings(args[k]));
  return out;
}

function hostOf(u: string): string | null {
  try {
    return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(u) ? u : `https://${u}`).hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return null;
  }
}

/** Whole path segments: "Offertes" matches C:\…\Offertes\a.docx and offertes/b.txt, not "Offertes-oud". */
function inFolder(p: string, folder: string): boolean {
  const segs = p.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  const want = folder.replace(/\\/g, '/').toLowerCase().split('/').filter(Boolean);
  if (!want.length) return false;
  for (let i = 0; i + want.length <= segs.length; i++) if (want.every((w, j) => segs[i + j] === w)) return true;
  return false;
}

const DELETE_NAME = /delete|remove|trash|unlink|rmdir|erase|destroy|purge/i;
const DELETE_CMD = /(?:^|[\s;&|(])(?:rm|del|erase|rmdir|rd|remove-item|ri|shred|unlink)(?=\s|$)/i;
const RUN_NAME = /run_command|shell|bash|powershell|terminal|exec|skill_run_script/i;
const SEND_NAME = /send|reply|forward|mail|message|sms|whatsapp|telegram|post_?message|notify_?(?:contact|customer|external)/i;
const PUBLISH_NAME = /publish|deploy|post|tweet|upload|site/i;
const PUBLISH_CMD = /\b(?:npm|pnpm|yarn)\s+publish\b|\bgit\s+push\b|\bdeploy\b/i;
const PAY_NAME = /pay|checkout|purchase|buy|order/i;

function commandOf(args: any): string {
  return typeof args?.command === 'string' ? args.command : '';
}

function verbMatches(m: RuleMatch, c: CallInfo): boolean {
  switch (m.verb) {
    case 'any':
      return true;
    case 'read':
      return c.risk === 'read';
    case 'change':
      return c.risk !== 'read';
    case 'delete':
      return DELETE_NAME.test(c.name) || DELETE_CMD.test(commandOf(c.args));
    case 'run':
      return c.risk === 'exec' || RUN_NAME.test(c.name) || !!commandOf(c.args);
    case 'send':
      return !c.internal && (c.name === 'channel_send' || SEND_NAME.test(c.name));
    case 'publish':
      return !c.internal && (PUBLISH_NAME.test(c.name) || PUBLISH_CMD.test(commandOf(c.args)));
    case 'pay':
      return c.impact === 'payment' || PAY_NAME.test(c.name);
  }
}

/**
 * `strict`: a rule that asks or forbids applies when the app cannot be told (fail-safe); an "allow" rule only on a
 * positive match.
 */
function appMatches(app: string, c: CallInfo, strict: boolean): boolean {
  if (app.startsWith('mcp:')) {
    const slug = app.slice(4).toLowerCase();
    const n = c.name.toLowerCase();
    return n.startsWith(`mcp_${slug}_`) || n.includes(`mcp__${slug}__`) || n.includes(`mcp__${slug.replace(/_/g, '-')}__`);
  }
  const g = APPS[app];
  if (!g) return false;
  if (c.name === 'channel_send') {
    if (!g.channels) return false;
    if (c.channel === '?' || c.channel == null) return strict && c.args !== undefined;
    return g.channels.includes(c.channel);
  }
  return g.tool.test(c.name);
}

export function ruleMatches(r: Pick<StoredRule, 'effect' | 'match' | 'review'>, c: CallInfo): boolean {
  if (r.review) return false;
  const m = r.match;
  const strict = r.effect !== 'allow';
  // Without a concrete call only rules that need nothing of the call itself apply (which tools a bot gets).
  if (c.args === undefined && (m.folder || m.domain || m.others)) return false;
  if (m.tool && c.name !== m.tool && !c.name.endsWith(`:${m.tool}`)) return false;
  if (m.app && !appMatches(m.app, c, strict)) return false;
  if (m.folder && !pathsOf(c.args).some((p) => inFolder(p, m.folder!))) return false;
  if (m.domain) {
    const d = m.domain.toLowerCase();
    if (!urlsOf(c.args).some((u) => {
      const h = hostOf(u);
      return !!h && (h === d || h.endsWith('.' + d));
    }))
      return false;
  }
  if (m.others && c.impact !== 'external') return false;
  if (!verbMatches(m, c)) return false;
  // "Mag altijd" lifts only a change in the named place: every path of the call must be in that folder.
  if (!strict && m.folder && !pathsOf(c.args).every((p) => inFolder(p, m.folder!))) return false;
  return true;
}

/**
 * The Broker's decision after the owner's rules. `modeDecision` is what the access mode and per-tool choices gave.
 * Strictest wins: never > ask > allow. Returns the rule that decided it, for the audit line and the approval card.
 */
export function applyRules(agent: Agent, c: CallInfo, modeDecision: Decision, rules: StoredRule[]): { decision: Decision; rule?: StoredRule } {
  if (modeDecision === 'deny' || !rules.length) return { decision: modeDecision };
  const hits = rules.filter((r) => ruleMatches(r, c));
  const deny = hits.find((r) => r.effect === 'deny');
  if (deny) return { decision: 'deny', rule: deny };
  const ask = hits.find((r) => r.effect === 'ask');
  if (ask) return { decision: 'ask', rule: modeDecision === 'allow' ? ask : undefined };
  if (modeDecision !== 'ask') return { decision: modeDecision };
  // "Mag altijd": only within the bot's level. Its level is "Vragen" (changes and commands ask); a per-tool choice of
  // the owner, and anything of impact, keep asking.
  const liftable = agent.access_mode === 'ask' && (c.risk === 'write' || c.risk === 'exec') && !agent.tool_policy?.[c.name];
  if (!liftable) return { decision: modeDecision };
  const allow = hits.find((r) => r.effect === 'allow');
  return allow ? { decision: 'allow', rule: allow } : { decision: modeDecision };
}
