import crypto from 'node:crypto';
import type { ToolRisk } from '../../core/types.js';

export const RISKS: ToolRisk[] = ['read', 'write', 'exec', 'danger'];

export function riskRank(r: string | null | undefined): number {
  const i = RISKS.indexOf(r as ToolRisk);
  return i < 0 ? RISKS.length - 1 : i;
}

export function isRisk(r: any): r is ToolRisk {
  return RISKS.includes(r);
}

/** The stricter of two risks. */
export function stricter(a: ToolRisk, b: ToolRisk | null | undefined): ToolRisk {
  if (!b) return a;
  return riskRank(a) >= riskRank(b) ? a : b;
}

/** Verbs that mean sending, publishing, deleting or paying — always "danger" (DEVELOPING.md). */
const DANGER_VERBS = new Set([
  'send', 'post', 'publish', 'delete', 'del', 'remove', 'rm', 'destroy', 'drop', 'purge', 'truncate', 'pay', 'purchase', 'buy', 'order',
  'transfer', 'merge', 'deploy', 'push', 'email', 'mail', 'message', 'invite', 'share', 'reply', 'forward', 'tweet', 'comment',
  'approve', 'refund', 'charge', 'wipe', 'erase', 'revoke', 'kill', 'terminate', 'unpublish', 'release', 'submit',
]);
/** Verbs that run code or commands. */
const EXEC_VERBS = new Set(['run', 'exec', 'execute', 'eval', 'evaluate', 'shell', 'spawn', 'invoke']);

function firstVerb(name: string): string {
  const parts = name
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  return parts[0] || '';
}

/**
 * Map MCP tool annotations to a TeamBot risk. Annotations are hints from an
 * untrusted server, so a name heuristic can only make the result stricter:
 *  - readOnlyHint            → read
 *  - destructiveHint         → danger
 *  - openWorldHint (explicit, not read-only, not explicitly non-destructive) → danger
 *  - no readOnlyHint/destructiveHint at all, and the name or description clearly only reads → read, marked as a
 *    guess ("waarschijnlijk alleen lezen", see guessReadOnly)
 *  - otherwise               → write
 * Then: a first verb like send/delete/publish/pay → danger; run/execute → exec.
 */
export function riskFromAnnotations(annotations: any, name: string, description = ''): ToolRisk {
  return riskOf(annotations, name, description).risk;
}

/** The risk plus whether it is TeamBot's own guess (no annotations; the owner can still correct it). */
export function riskOf(annotations: any, name: string, description = '', guess = true): { risk: ToolRisk; guessed: boolean } {
  const a = annotations && typeof annotations === 'object' ? annotations : {};
  let r: ToolRisk;
  let guessed = false;
  if (a.readOnlyHint === true) r = 'read';
  else if (a.destructiveHint === true) r = 'danger';
  else if (a.openWorldHint === true && a.destructiveHint !== false) r = 'danger';
  else if (guess && guessReadOnly(a, name, description)) {
    r = 'read';
    guessed = true;
  } else r = 'write';
  const verb = firstVerb(name);
  if (DANGER_VERBS.has(verb)) r = stricter(r, 'danger');
  else if (EXEC_VERBS.has(verb)) r = stricter(r, 'exec');
  if (r !== 'read') guessed = false;
  return { risk: r, guessed };
}

/** Verbs a tool that only reads starts with ("read_wiki_contents", "Get a list of …", "Ask any question …"). */
const READ_VERBS = new Set(['get', 'list', 'search', 'read', 'fetch', 'query', 'find', 'describe', 'ask']);
const READ_START = /^(gets?|lists?|search(es)?|reads?|fetch(es)?|quer(y|ies)|finds?|describes?|asks?)\b/i;
/**
 * Words that mean the tool changes, sends or runs something. One of them anywhere in the name or the description and
 * it is no read tool, however it starts ("Get the file and delete it", "list_and_update").
 */
const CHANGE_WORDS = new RegExp(
  '(^|[^a-z])(' +
    [
      'writes?', 'writing', 'delet(e|es|ing)', 'send(s|ing)?', 'sent', 'creat(e|es|ing)', 'updat(e|es|ing)', 'remov(e|es|ing)',
      'edit(s|ing)?', 'modif(y|ies|ying)', 'insert(s|ing)?', 'upload(s|ing)?', 'sav(e|es|ing)', 'mov(e|es|ing)', 'renam(e|es|ing)',
      'set(s|ting)?', 'put(s|ting)?', 'patch(es|ing)?', 'replac(e|es|ing)', 'overwrit(e|es|ing)', 'append(s|ing)?', 'add(s|ing)?',
      'post(s|ing)?', 'publish(es|ing)?', 'submit(s|ting)?', 'pay(s|ing|ment)?', 'purchas(e|es|ing)', 'buy(s|ing)?', 'order(s|ing)?',
      'transfer(s|ring)?', 'merg(e|es|ing)', 'deploy(s|ing)?', 'push(es|ing)?', 'e-?mail(s|ing)?', 'invit(e|es|ing)', 'shar(e|es|ing)',
      'repl(y|ies|ying)', 'forward(s|ing)?', 'comment(s|ing)?', 'approv(e|es|ing)', 'cancel(s|led|ling)?', 'archiv(e|es|ing)',
      'drop(s|ping)?', 'destroy(s|ing)?', 'truncat(e|es|ing)', 'wip(e|es|ing)', 'eras(e|es|ing)', 'revok(e|es|ing)', 'kill(s|ing)?',
      'terminat(e|es|ing)', 'run(s|ning)?', 'execut(e|es|ing)', 'eval', 'shell', 'spawn(s|ing)?', 'invok(e|es|ing)', 'install(s|ing)?',
      'uninstall', 'start(s|ing)?', 'stop(s|ping)?', 'restart(s|ing)?', 'enabl(e|es|ing)', 'disabl(e|es|ing)', 'lock(s|ing)?', 'unlock',
      'book(s|ing)?', 'schedul(e|es|ing)', 'assign(s|ing)?', 'commit(s|ting)?', 'refund(s|ing)?', 'charg(e|es|ing)',
    ].join('|') +
    ')([^a-z]|$)',
  'i',
);

/**
 * TeamBot's own careful guess for a tool whose server says nothing about what it does (no readOnlyHint, no
 * destructiveHint): its name or description starts with get/list/search/read/fetch/query/find/describe/ask, and
 * nothing in the name or description speaks of writing, deleting, sending, creating, updating or running. Never used
 * when the server made an explicit statement: an explicit readOnlyHint=false stays "schrijven".
 */
export function guessReadOnly(annotations: any, name: string, description = ''): boolean {
  const a = annotations && typeof annotations === 'object' ? annotations : {};
  if (a.readOnlyHint !== undefined || a.destructiveHint !== undefined || a.openWorldHint === true) return false;
  const desc = String(description || '').trim();
  const words = name.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[^A-Za-z0-9]+/g, ' ');
  if (!READ_VERBS.has(firstVerb(name)) && !READ_START.test(desc)) return false;
  return !CHANGE_WORDS.test(words) && !CHANGE_WORDS.test(desc);
}

/** Stable hash of what the model sees of a tool; a change means the user must re-approve it. */
export function toolHash(t: { description?: string; inputSchema?: any; annotations?: any }): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([t.description || '', t.inputSchema || {}, t.annotations || {}]))
    .digest('hex')
    .slice(0, 32);
}

export const RISK_LABEL: Record<ToolRisk, string> = {
  read: 'lezen',
  write: 'schrijven',
  exec: 'uitvoeren',
  danger: 'gevaarlijk',
};
