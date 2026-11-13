import { mailsSomeone } from '../../tools/builtin/command-risk.js';
import { aboutMoney } from './money.js';
import type { CallInfo, StoredRule } from './match.js';

/**
 * Which steps the reviewer model looks at for a "review" rule (a rule TeamBot cannot pin down in code).
 *
 * The two rules every team starts with are about spending money and about an important message to someone else.
 * Checking them on every changing step cost a model call per file write and per command (273 in one night, each up
 * to a minute) and turned ordinary work into a question whenever the reviewer failed. A file write, a build, a git
 * push or a deploy can be neither a payment nor a message, so those pass at once, without a model call. Only a step
 * that can actually pay or send goes to the reviewer:
 *
 *  - a payment (tool impact "payment"), a form sent from the browser, a tool with pay/order/refund in its name;
 *  - a message out: channel_send, a mail/post/reply tool, a mail command in the terminal;
 *  - a change in one of the owner's apps (an MCP server) whose name or arguments are about money or sending;
 *  - a command that posts to a web address outside this computer (an API call can pay or send).
 *
 * A review rule about something else ("wees altijd beleefd") keeps the old behaviour: every changing step.
 */

export interface ReviewStep {
  pay: boolean;
  send: boolean;
  /** Clearly a payment or a message (not merely possible): when the reviewer fails, the owner is asked. */
  strong: boolean;
}

const PAY_CMD = /\b(?:stripe|mollie|paypal|adyen|braintree)\b/i;
const HTTP_WRITE =
  /\b(?:curl|wget|http|https|xh)\b[^|;&]*(?:\s-X\s*(?:POST|PUT|PATCH|DELETE)|\s--data(?:-\w+)?\b|\s-d\s|\s-F\s|--upload-file|--form|\s-T\s|\s--json\b)|\b(?:Invoke-WebRequest|Invoke-RestMethod|iwr|irm)\b[^|;&]*-Method\s+["']?(?:Post|Put|Patch|Delete)/i;
const LOCAL_HOST = /^(?:localhost|127(?:\.\d{1,3}){3}|0\.0\.0\.0|\[?::1\]?|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|[\w-]+\.(?:local|localhost|lan|internal|test))$/i;

const SEND_NAME = /(?:^|[_:.-])(?:send|reply|forward|mail|email|gmail|sms|whatsapp|telegram|post|publish|tweet|comment|invite|share|message|dm|notify_(?:contact|customer|external))(?:[_:.-]|$|s(?:[_:.-]|$))/i;
const PAY_NAME = /pay|checkout|purchase|buy|order|refund|invoice|charge|subscription|budget|campaign|discount|coupon|price|bid|payout|transfer|billing/i;
const MONEY_ARGS = /refund|payment|checkout|purchase|budget|campaign|discount|coupon|invoice|payout|"(?:price|amount|bid|total)"|terugbeta|betaal|korting|factuur|budget/i;
const SEND_TEXT = /\b(?:bericht|berichten|mail|mails|mailen|e-?mail|e-?mails|stuur|sturen|verstuur|versturen|verzend|verzenden|reageer|reageren|antwoord|beantwoord|message|messages|send|reply|post|posten|publiceer|contact|klant|klanten|customer|customers)\b/i;

/**
 * The parts whose tools only keep TeamBot's own books (a memory, a reminder, a routine, a task, a skill). Such a step
 * changes nothing outside TeamBot, so it can neither pay nor send; what a routine or a colleague does later is checked
 * when it runs. No review rule is read for them (without this every reminder cost a model call, and asked when that
 * call failed).
 */
const BOOKKEEPING = new Set(['core', 'memory', 'routines', 'team', 'skills']);

/** Every web address in the command points at this computer or the home network. */
function onlyLocalUrls(cmd: string): boolean {
  const hosts = [...cmd.matchAll(/\bhttps?:\/\/([^\s/'":]+|\[[^\]]+\])/gi)].map((m) => m[1]);
  return hosts.length > 0 && hosts.every((h) => LOCAL_HOST.test(h));
}

function argText(args: any): string {
  try {
    return JSON.stringify(args ?? {}).slice(0, 6000);
  } catch {
    return '';
  }
}

/** Can this step pay or send something? Null: it cannot, so no reviewer call for a money or message rule. */
export function reviewStep(c: CallInfo): ReviewStep | null {
  if (c.risk === 'read' || c.internal) return null;
  const name = String(c.name || '');
  const cmd = typeof c.args?.command === 'string' ? c.args.command : '';
  const app = /^mcp_/.test(name) || /(?:^|:)mcp__/.test(name);
  // A CLI engine's own tool ("claude-code:Write", "codex:shell"): only its command can reach outside.
  const cliNative = name.includes(':') && !app;
  let pay = c.impact === 'payment';
  let send = false;
  let strong = pay;
  if (cmd) {
    if (mailsSomeone(cmd)) send = strong = true;
    if (HTTP_WRITE.test(cmd) && !onlyLocalUrls(cmd)) {
      pay = send = true;
      if (PAY_CMD.test(cmd)) strong = true;
    } else if (PAY_CMD.test(cmd) && /(?:^|[;&|]\s*)(?:npx\s+)?(?:stripe|mollie|paypal)\s+\S/i.test(cmd)) pay = true;
  }
  if (!cliNative) {
    if (name === 'channel_send') send = strong = true;
    else if (name === 'browser_submit') pay = send = strong = true;
    else if (app) {
      const tool = name.replace(/^.*mcp__?/, '');
      if (SEND_NAME.test(tool)) send = strong = true;
      if (PAY_NAME.test(tool)) pay = strong = true;
      else if (MONEY_ARGS.test(argText(c.args))) pay = true;
    } else {
      // TeamBot's own tools: only a real message tool (publishing a site or sharing a file in the chat is not one).
      if (/(?:^|_)(?:send|reply|forward|mail|email|sms|whatsapp|telegram)(?:_|$)/i.test(name)) send = strong = true;
      if (/(?:^|_)(?:pay|checkout|purchase|buy|order|refund)(?:_|$)/i.test(name)) pay = strong = true;
    }
  }
  // To the owner himself (a tool that says so): not a message to someone else.
  if (c.impact === 'local' && !cmd) send = false;
  return pay || send ? { pay, send, strong: strong && (pay || send) } : null;
}

/** What a review rule is about: money, messages, or (null) something else that every changing step is checked for. */
export function ruleTopics(r: Pick<StoredRule, 'text' | 'match'>): { pay: boolean; send: boolean } | null {
  if (r.match?.verb === 'send') return { pay: false, send: true };
  if (r.match?.verb === 'pay') return { pay: true, send: false };
  const pay = aboutMoney(r.text, r.match);
  const send = SEND_TEXT.test(String(r.text || ''));
  return pay || send ? { pay, send } : null;
}

/**
 * The review rules that name this step, and whether a failed check should ask the owner. None for a step that only
 * reads, for team-internal work and for TeamBot's own bookkeeping.
 */
export function reviewRulesFor(rules: StoredRule[], c: CallInfo & { group?: string }): { texts: string[]; strong: boolean } {
  const review = rules.filter((r) => r.review);
  if (!review.length || c.risk === 'read' || c.internal || BOOKKEEPING.has(c.group || '')) return { texts: [], strong: false };
  const step = reviewStep(c);
  let other = false;
  const hit = review.filter((r) => {
    const t = ruleTopics(r);
    if (!t) return (other = true);
    return !!step && ((t.pay && step.pay) || (t.send && step.send));
  });
  return { texts: hit.map((r) => r.text), strong: hit.length > 0 && (other || !!step?.strong) };
}
