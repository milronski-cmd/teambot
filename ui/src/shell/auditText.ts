/**
 * The security log (Instellingen › Beveiliging › Logboek) in plain Dutch: one sentence per event that says who did
 * what ("Codeerhulp heeft een bestand geschreven: notities/test.txt"), plus — where it applies — who approved it
 * ("Goedgekeurd door jou", "Automatisch toegestaan door het toegangsniveau"). Never the raw kind
 * ("cli.permission"), JSON, ids (ag_…, apr_…, prop_…), `null` or technical tool ids ("claude-code:Write").
 *
 * Every audit kind the server writes (grep "audit(" server) has an explicit sentence or a family sentence per
 * prefix; tests/audit-text.test.ts scans the server source to keep it that way. Pure (no React).
 */
import { approvalEngine, approvalWhat } from './approvalLabels.js';
import { toolLabel } from './toolLabels.js';
import { LABEL as FIELD_LABEL } from '../lib/historyText.js';
import { stripRefs } from '../lib/preview.js';
import { formatMoney, formatUsd, interfaceLocale, tFragment, tText } from '../lib/format.js';

export interface AuditRow {
  id: number;
  user_id: string | null;
  agent_id: string | null;
  /** The bot's current name (from the server; null when the bot no longer exists). */
  agent_name?: string | null;
  kind: string;
  data: any;
  created_at: string;
}

export interface AuditContext {
  /** The signed-in user (approvals decided by this id read "door jou"). */
  meId?: string | null;
  /** Name of a bot by id (e.g. from the app store), when the row itself has none. */
  agentName?(id: string): string | undefined;
}

export type AuditCategory = 'bots' | 'approvals' | 'access' | 'connections' | 'memory' | 'routines' | 'data';
export type AuditTone = 'neutral' | 'ok' | 'warn' | 'danger';

export interface AuditEntry {
  /** "Jij", the bot's name, or "TeamBot" (things TeamBot did on its own). */
  actor: string;
  actorKind: 'you' | 'bot' | 'system';
  /** The sentence without the actor: "heeft een bestand geschreven: notities/test.txt". */
  text: string;
  /** The whole sentence, with a full stop: "Codeerhulp heeft een bestand geschreven: notities/test.txt." */
  sentence: string;
  /** Who allowed it (or that it was blocked), when the event went through a permission decision. */
  approval?: { text: string; tone: AuditTone };
  category: AuditCategory;
  tone: AuditTone;
  /** Only the last-resort sentence matched (no explicit or family sentence): never for a kind the server writes. */
  generic?: boolean;
}

export const AUDIT_CATEGORIES: { id: AuditCategory; label: string }[] = [
  { id: 'bots', label: 'Bots en acties' },
  { id: 'approvals', label: 'Goedkeuringen' },
  { id: 'access', label: 'Toegang en beveiliging' },
  { id: 'connections', label: 'Koppelingen' },
  { id: 'memory', label: 'Geheugen' },
  { id: 'routines', label: 'Routines' },
  { id: 'data', label: 'Gegevens' },
];

export function categoryLabel(c: AuditCategory): string {
  return AUDIT_CATEGORIES.find((x) => x.id === c)?.label || '';
}

// ------------------------------------------------------------------ value helpers

/** Ids as TeamBot makes them (newId: prefix + 22 hex), also inside paths ("workspaces\ag_…\notities"). */
const ID_RE = /\b[a-z]{1,6}_[0-9a-f]{12,}\b/g;

/** Plain, short text for a value: no ids, no "null"/"undefined", collapsed whitespace. '' when nothing is left. */
export function clean(v: unknown, max = 90): string {
  if (v === null || v === undefined || typeof v === 'object') return '';
  let s = String(v)
    .replace(ID_RE, '')
    .replace(/\b(null|undefined|NaN)\b/g, '')
    .replace(/\s+/g, ' ')
    .replace(/\(\s*\)/g, '')
    .trim();
  if (s.length > max) s = s.slice(0, max - 1).trimEnd() + '…';
  return s;
}

/** A path as the owner knows it: relative to the bot's work folder, else the last few parts. */
export function shortPath(v: unknown): string {
  const raw = typeof v === 'string' ? v : '';
  if (!raw) return '';
  const ws = raw.match(/[\\/]workspaces[\\/][^\\/]+[\\/](.+)$/i);
  let p = ws ? ws[1] : raw;
  p = p.replace(/^uploads[\\/][0-9a-f]{6}-/i, 'uploads/');
  const parts = p.split(/[\\/]+/).filter(Boolean);
  if (/^([a-z]:|\\\\|\/)/i.test(p) && parts.length > 3) p = '…/' + parts.slice(-3).join('/');
  else p = parts.join('/');
  return clean(p, 120);
}

/** “Naam” in Dutch quotes, or '' when there is no name. */
const q = (v: unknown, max = 60) => {
  const s = clean(v, max);
  return s ? `“${s}”` : '';
};
const num = (v: unknown) => (typeof v === 'number' && isFinite(v) ? v : Number(v) || 0);
/** An amount in a currency the provider gave ("EUR", "USD"; "€"/"$" as symbols), in the reader's notation. */
const money = (n: number, currency: string) => {
  const code = ({ '€': 'EUR', $: 'USD' } as Record<string, string>)[currency] || currency.toUpperCase();
  try {
    return formatMoney(n, code, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  } catch {
    return `${currency} ${formatUsd(n).replace(/[^\d.,\s]/g, '').trim()}`;
  }
};
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
/** ": detail" or '' — for sentences that end with what exactly. */
const colon = (v: string) => (v ? `: ${v}` : '');
const paren = (v: string) => (v ? ` (${v})` : '');
const list = (v: unknown, max = 3) => {
  const a = (Array.isArray(v) ? v : []).map((x) => clean(x, 40)).filter(Boolean);
  if (!a.length) return '';
  return a.length > max ? `${a.slice(0, max).join(', ')} en ${a.length - max} meer` : a.length > 1 ? `${a.slice(0, -1).join(', ')} en ${a[a.length - 1]}` : a[0];
};

const ADAPTERS: Record<string, string> = { telegram: 'Telegram', whatsapp: 'WhatsApp', 'whatsapp-web': 'WhatsApp', discord: 'Discord', slack: 'Slack', email: 'e-mail', imap: 'e-mail', signal: 'Signal', matrix: 'Matrix', sms: 'sms', webhook: 'webhook' };
const adapter = (v: unknown) => ADAPTERS[String(v || '').toLowerCase()] || clean(v, 30) || 'een kanaal';

const KINDS: Record<string, string> = {
  openai: 'OpenAI', anthropic: 'Anthropic', google: 'Google Gemini', gemini: 'Google Gemini', ollama: 'Ollama', lmstudio: 'LM Studio', openrouter: 'OpenRouter', mistral: 'Mistral', deepseek: 'DeepSeek', groq: 'Groq', xai: 'xAI',
  'openai-compatible': 'een eigen endpoint', custom: 'een eigen endpoint', hetzner: 'Hetzner', digitalocean: 'DigitalOcean', mock: 'een testprovider',
  cloudflare: 'Cloudflare Workers AI', zai: 'Z.ai GLM', kilo: 'Kilo Gateway',
};
/** "Claude Code", "OpenAI" … for a provider/engine kind; never the raw id. */
export function engineName(kind: unknown): string {
  const k = String(kind || '');
  if (!k) return '';
  return approvalEngine(`${k}:x`) || KINDS[k.toLowerCase()] || clean(k.replace(/[-_]+/g, ' '), 30);
}

const SESSION_REASON: Record<string, string> = { limit: 'limiet bereikt', rate_limit: 'te veel verzoeken', quota: 'tegoed op', auth: 'niet ingelogd', error: 'storing', timeout: 'geen antwoord', overloaded: 'overbelast', unavailable: 'niet bereikbaar' };

/** Field names of a bot ("instructies, model"), from the profile history labels. */
function fields(v: unknown): string {
  const a = (Array.isArray(v) ? v : []).map((f) => FIELD_LABEL[String(f)] || ({ pinned: 'vastzetten', archived: 'archief', sort: 'volgorde' } as Record<string, string>)[String(f)] || '').filter(Boolean);
  return list([...new Set(a)], 4);
}

const SEPARABLE = ['klaar', 'terug', 'over', 'door', 'mee', 'vast', 'weg', 'uit', 'aan', 'toe', 'los', 'bij', 'op', 'in', 'af'];
/** "een bestand schrijven" → "een bestand te schrijven"; "een opdracht uitvoeren" → "een opdracht uit te voeren". */
export function teInfinitive(phrase: string): string {
  const m = phrase.match(/^(.*?)(\S+)$/);
  if (!m) return phrase;
  const [, head, w] = m;
  const pre = SEPARABLE.find((p) => w.startsWith(p) && w.length - p.length > 3);
  return `${head}${pre ? `${pre} te ${w.slice(pre.length)}` : `te ${w}`}`;
}

/**
 * A text the server stored in the language of that moment (a routine's schedule in words): shown when the interface
 * reads Dutch or the dictionary knows it; an older Dutch text in another language is left out rather than shown.
 */
function keptText(s: string): string {
  if (!s || /^nl\b/.test(interfaceLocale())) return s;
  return /\b(elke?|om|en|dag|maand|uur|minuten|werkdag|handmatig|eenmalig|maandag|dinsdag|woensdag|donderdag|vrijdag|zaterdag|zondag)\b/i.test(s) ? '' : s;
}

/**
 * "een bestand te schrijven" after "om …" in Dutch; in another language the phrase's own translation ("write a
 * file"), since a translated sentence puts its own "to" in front.
 */
function toInfinitive(phrase: string): string {
  const own = tFragment(phrase);
  return own !== phrase ? own : teInfinitive(phrase);
}

/** A tool call as a short past-tense phrase: "schreef een bestand". '' for a name we have no words for. */
function toolPast(name: string): string {
  const raw = toolLabel({ name }, false);
  if (!raw || raw === name.replace(/_/g, ' ') || raw === 'Gebruikte een hulpmiddel') return '';
  // The step's own words in the interface language ("Schreef een bestand" → "wrote a file"), then lower case.
  const l = tFragment(raw);
  return l.charAt(0).toLocaleLowerCase() + l.slice(1);
}

/** The useful part of a tool summary ("Bestand schrijven: notities/test.txt" → "notities/test.txt"); never raw "tool({…})". */
function summaryDetail(v: unknown): string {
  const s = typeof v === 'string' ? v : '';
  if (!s || /^[\w.-]+\s*\(/.test(s) || /^[\w-]+:[\w-]+/.test(s)) return '';
  const after = s.includes(': ') ? s.slice(s.indexOf(': ') + 2) : s;
  // Memory codes ("m:p968gz") mean nothing in the log: "Schrijver vergat iets: m:p968gz" (acceptance round 3).
  return clean(stripRefs(after.replace(/[A-Z]:\\[^\s"]*?[\\/]workspaces[\\/][^\\/\s]+[\\/]/gi, '').replace(/[`*]/g, '')), 110);
}

// ------------------------------------------------------------------ sentences

type By = 'you' | 'bot' | 'system';
/**
 * A sentence as a Dutch template with its values (tpl`{h} de routine ${name} gemaakt${paren(…)}`), so the interface
 * translates the template as a whole ("hebt de routine {0} gemaakt{1}") and each value on its own (a name stays, a
 * Dutch fragment such as " (na een herstart)" or " voor 3 bots" is translated). In Dutch it is the same sentence.
 */
interface Tpl {
  tpl: string;
  values: string[];
}
const tpl = (parts: TemplateStringsArray, ...values: unknown[]): Tpl => ({
  tpl: parts.reduce((out, p, i) => out + (i ? `{${i - 1}}` : '') + p, ''),
  values: values.map((v) => (v === null || v === undefined ? '' : String(v))),
});

interface Spec {
  by: By;
  /** May contain {h} (hebt/heeft) and {is} (bent/is), filled in for the actor. */
  text: string | Tpl;
  /** Overrides the actor's name (e.g. the asking bot of a team event). */
  actor?: string;
  approval?: { text: string; tone: AuditTone };
  tone?: AuditTone;
  category?: AuditCategory;
}
interface X {
  /** The bot of this row in words ("Codeerhulp", or "een bot"). */
  bot: string;
  me: (id: unknown) => boolean;
}
type Fn = (d: any, x: X) => Spec;

const you = (text: string | Tpl, o: Partial<Spec> = {}): Spec => ({ by: 'you', text, ...o });
const bot = (text: string | Tpl, o: Partial<Spec> = {}): Spec => ({ by: 'bot', text, ...o });
const sys = (text: string | Tpl, o: Partial<Spec> = {}): Spec => ({ by: 'system', text, ...o });

const BY_YOU: { text: string; tone: AuditTone } = { text: 'Goedgekeurd door jou', tone: 'ok' };
const DENIED_YOU: { text: string; tone: AuditTone } = { text: 'Geweigerd door jou', tone: 'danger' };
const AUTO: { text: string; tone: AuditTone } = { text: 'Automatisch toegestaan door het toegangsniveau', tone: 'neutral' };
const BLOCKED: { text: string; tone: AuditTone } = { text: 'Geblokkeerd door het toegangsniveau', tone: 'danger' };

/** The device of a remote-desktop session: the phone's own name, or what kind of device it was. */
const remoteDevice = (d: any) => {
  const v = String(d?.device || '');
  if (!v || v === 'phone') return 'je telefoon';
  if (v === 'computer') return 'deze computer';
  if (v === 'browser') return 'een browser';
  return q(v, 40);
};
const REMOTE_END: Record<string, string> = {
  ended: 'beëindigd',
  stopped_here: 'gestopt op de computer',
  off: 'gestopt omdat het werd uitgezet',
  idle: 'vanzelf gestopt omdat er niets gebeurde',
  gone: 'gestopt omdat de verbinding weg was',
  unavailable: 'gestopt omdat de TeamBot-app op de computer stopte',
  shutdown: 'gestopt omdat TeamBot stopte',
  signed_out: 'gestopt omdat het apparaat was uitgelogd',
};

/** Explicit sentences for the kinds that matter most (by exact kind). */
const EXACT: Record<string, Fn> = {
  // ---- approvals
  'approval.approved': (d, x) => you(tpl`{h} ${x.bot} toestemming gegeven${colon(summaryDetail(d.summary) || approvalWhat({ tool: d.tool, risk: 'write' }))}${d.afterRestart ? ' (na een herstart)' : ''}`, { approval: BY_YOU, category: 'approvals' }),
  'approval.denied': (d, x) => you(tpl`{h} een verzoek van ${x.bot} geweigerd${colon(summaryDetail(d.summary) || approvalWhat({ tool: d.tool, risk: 'write' }))}${d.afterRestart ? ' (na een herstart)' : ''}`, { approval: DENIED_YOU, category: 'approvals' }),
  'approval.carried_over': (d, x) =>
    sys(tpl`{h} na een herstart jouw eerdere ${d.approved ? 'toestemming' : 'weigering'} gebruikt voor ${x.bot}${colon(summaryDetail(d.summary) || approvalWhat({ tool: d.tool, risk: 'write' }))}`, { approval: d.approved ? BY_YOU : DENIED_YOU, category: 'approvals' }),
  'policy.always_allow': (d, x) => you(tpl`{h} ${x.bot} toegestaan om voortaan zonder te vragen ${toInfinitive(approvalWhat({ tool: d.tool, risk: 'write' }))}`, { approval: { text: 'Voortaan zonder vragen', tone: 'warn' }, tone: 'warn', category: 'approvals' }),
  'autoreview.allow': (d, x) => sys(tpl`{h} een actie van ${x.bot} automatisch gecontroleerd en in orde bevonden${colon(clean(d.reason, 120))}`, { approval: { text: 'Automatisch gecontroleerd', tone: 'neutral' }, category: 'approvals' }),
  'autoreview.ask': (d, x) => sys(tpl`{h} bij een actie van ${x.bot} getwijfeld en het aan jou voorgelegd${colon(clean(d.reason, 120))}`, { approval: { text: 'Aan jou gevraagd', tone: 'warn' }, category: 'approvals' }),
  'cli.permission': (d) => {
    const what = approvalWhat({ tool: String(d.tool || ''), risk: 'write' });
    const detail = summaryDetail(d.summary);
    const approval = d.allowed ? (d.asked ? BY_YOU : AUTO) : d.asked ? DENIED_YOU : { text: 'Geblokkeerd door TeamBot', tone: 'danger' as AuditTone };
    const why = !d.allowed && !d.asked ? clean(d.reason, 120) : '';
    return bot(tpl`wilde ${what}${colon(detail)}${why ? ` — ${why}` : ''}`, { approval, category: 'approvals', tone: d.allowed ? 'neutral' : 'warn' });
  },
  'cli.unapproved_action': (d) => bot(tpl`deed iets zonder dat TeamBot vooraf toestemming kon vragen${colon(clean(d.title, 100))}`, { tone: 'danger', category: 'approvals' }),
  'channels.approval_via_channel': (d, x) =>
    you(tpl`{h} via ${adapter(d.adapter)} een verzoek van ${x.bot} ${d.decision === 'deny' ? 'geweigerd' : 'goedgekeurd'}`, { approval: d.decision === 'deny' ? DENIED_YOU : BY_YOU, category: 'approvals' }),

  // ---- the bot's own work
  'tool.call': (d, x) => {
    const name = String(d.tool || '');
    const detail = summaryDetail(d.summary);
    const impactful = !!d.risk && d.risk !== 'read';
    const approval = d.denied ? (d.asked ? DENIED_YOU : BLOCKED) : d.asked && d.approved ? (x.me(d.by) || !d.by ? BY_YOU : { text: 'Goedgekeurd', tone: 'ok' as AuditTone }) : impactful && !d.error ? AUTO : undefined;
    // Refused: what it wanted ("wilde een bestand schrijven"); done: what it did ("schreef een bestand").
    if (d.denied) return bot(tpl`wilde ${approvalWhat({ tool: name, risk: d.risk || 'write' })}${colon(detail)}`, { approval, tone: 'warn', category: d.asked ? 'approvals' : 'bots' });
    const what = toolPast(name) || '{h} een hulpmiddel gebruikt';
    return bot(tpl`${what}${colon(detail)}${d.error ? ' (mislukt)' : ''}`, { approval });
  },
  'file.write': (d) => bot(tpl`{h} een bestand geschreven${colon(shortPath(d.path))}`),
  'file.edit': (d) => bot(tpl`{h} een bestand aangepast${colon(shortPath(d.path))}`),
  'file.delete': (d) => bot(tpl`{h} een bestand verwijderd${colon(shortPath(d.path))}`, { tone: 'warn' }),
  // ---- Prullenbak (folders/trash.ts)
  'trash.kept': (d) => bot(tpl`{h} ${d.kind === 'deleted' ? 'een bestand naar de prullenbak verplaatst' : 'de vorige versie van een bestand in de prullenbak bewaard'}${colon(shortPath(d.path))}`),
  'trash.restored': (d) => you(tpl`{h} een bestand uit de prullenbak teruggezet${colon(shortPath(d.path))}`),
  'trash.run_restored': (d) => you(tpl`{h} de bestanden van een taak teruggezet zoals ze ervoor waren${d.restored !== undefined ? ` (${plural(num(d.restored), 'bestand', 'bestanden')})` : ''}`),
  'trash.dropped': (d) => (d.why === 'full' ? sys(tpl`{h} een oud bestand uit de volle prullenbak gehaald${colon(shortPath(d.path))}`, { tone: 'warn' }) : you(tpl`{h} een bestand definitief uit de prullenbak verwijderd${colon(shortPath(d.path))}`, { tone: 'warn' })),
  'trash.emptied': () => you('{h} de prullenbak geleegd', { tone: 'warn' }),
  'shell.run': (d) => bot(tpl`{h} een opdracht uitgevoerd${colon(clean(d.command, 110))}${num(d.code) !== 0 && d.code !== undefined && d.code !== null ? ' (mislukt)' : ''}`),
  'container.exec': (d) => bot(tpl`{h} een opdracht uitgevoerd in zijn afgeschermde computer${colon(clean(d.command, 100))}`),
  'cli.run': (d) => bot(tpl`{h} een beurt gedaan met ${engineName(d.cli) || 'zijn AI-engine'}${d.resume ? ' (verder in hetzelfde gesprek)' : ''}`),
  'cli.fs_write': (d) => bot(tpl`{h} een bestand geschreven${colon(shortPath(d.path))}`),
  'cli.session_reset': (_d, x) => you(tpl`{h} een nieuwe sessie gestart voor ${x.bot}`),
  'cli.safety_reset': (d) => you(tpl`{h} de veiligheidsinstellingen van ${engineName(d.cli) || 'een AI-engine'} teruggezet`, { category: 'access' }),
  'cli.install': (d) => you(tpl`{h} ${engineName(d.cli) || 'een AI-engine'} geïnstalleerd`, { category: 'connections' }),
  'cli.version_changed': (d) => sys(tpl`{h} gezien dat ${engineName(d.cli) || 'een AI-engine'} is bijgewerkt${d.to ? ` naar ${clean(d.to, 30)}` : ''}`, { category: 'connections' }),
  'cli.version_check': (d) => sys(tpl`{h} ${engineName(d.cli) || 'een AI-engine'}${d.version ? ` ${clean(d.version, 30)}` : ''} kort getest (zonder prompt): ${d.ok === false ? 'mislukt' : 'geslaagd'}`, { category: 'connections', tone: d.ok === false ? 'warn' : 'neutral' }),
  'cli.version_accepted': (d) => you(tpl`{h} gekozen om ${engineName(d.cli) || 'een AI-engine'}${d.version ? ` ${clean(d.version, 30)}` : ''} toch te blijven gebruiken`, { category: 'connections', tone: 'warn' }),
  'cli.path_set': (d) => you(d.path ? tpl`{h} ingesteld waar ${engineName(d.cli) || 'de AI-engine'} op deze computer staat` : tpl`{h} het eigen pad naar ${engineName(d.cli) || 'de AI-engine'} weggehaald`, { category: 'connections' }),
  'thread.compacted': (_d, x) => sys(tpl`{h} het oudere deel van een gesprek met ${x.bot} samengevat (de originele berichten blijven bewaard)`),
  'thread.forked': (_d, x) => you(tpl`{h} een gesprek met ${x.bot} vertakt naar een nieuw gesprek`),
  'queue.added': (_d, x) => you(tpl`{h} een bericht in de wachtrij gezet voor ${x.bot}`),
  'queue.message-steered': (d, x) => you(d.interrupt ? tpl`{h} de beurt van ${x.bot} onderbroken om bij te sturen` : tpl`{h} ${x.bot} bijgestuurd tijdens het werk`),
  'queue.answered': (_d, x) => you(tpl`{h} een vraag van ${x.bot} beantwoord`),
  'agent.fallback': (d, x) => sys(tpl`{h} ${x.bot} laten overstappen op de reserve-engine${d.toModel ? ` (${clean(d.toModel, 40)})` : ''}${SESSION_REASON[String(d.reason)] ? `: ${SESSION_REASON[String(d.reason)]}` : ''}`),
  // Package D2 (Gratis doorschakelen, modules/engine-chain).
  'agent.paused': (_d, x) => sys(tpl`{h} belangrijk werk van ${x.bot} gepauzeerd tot de limiet voorbij is, in plaats van het op een zwakker model te doen`, { tone: 'warn' }),
  'agent.pause_continue': (_d, x) => you(tpl`{h} gepauzeerd werk van ${x.bot} nu laten doorgaan als gewoon werk`),
  'agent.pause_cancel': (_d, x) => you(tpl`{h} gekozen gepauzeerd werk van ${x.bot} niet te hervatten`),
  'agent.weekly_reserve': (d, x) => sys(tpl`{h} gewoon werk van ${x.bot} op een ander model gezet, omdat de weeklimiet${num(d.percent) ? ` voor ${num(d.percent)}%` : ''} gebruikt was`),
  'engine_chain.settings': () => you('{h} de instellingen voor gratis doorschakelen gewijzigd'),
  // Package B4: a team's own chain settings.
  'engine_chain.team_settings': (d) => you(d.cleared ? '{h} de eigen instellingen voor gratis doorschakelen van een team weggehaald' : '{h} de instellingen voor gratis doorschakelen van een team gewijzigd'),
  'security.cross_owner_run_blocked': () => sys('{h} geblokkeerd dat een bot van iemand anders in jouw gesprek werkte', { tone: 'danger', category: 'access' }),

  // ---- bots
  'agent.created': (d, x) => you(tpl`{h} de bot ${q(d.name) || x.bot} gemaakt${d.via === 'hire_proposal' ? ' na een voorstel in een groep' : d.from === 'template' ? ' vanuit een sjabloon' : ''}`),
  'agent.updated': (d, x) => you(tpl`{h} ${x.bot} aangepast${colon(fields(d.fields))}`),
  'agent.provider_changed': (d, x) => you(tpl`{h} de AI-engine van ${x.bot} gewijzigd${d.model ? ` (model ${clean(d.model, 40)})` : ''}`),
  'agent.deleted': (d, x) =>
    d.from === 'openbot-undo' || d.from === 'hermes-undo' || d.from === 'openclaw-undo'
      ? you(tpl`{h} de bot ${q(d.name) || x.bot} verwijderd bij het ongedaan maken van de ${d.from === 'openclaw-undo' ? 'OpenClaw' : d.from === 'hermes-undo' ? 'Hermes' : 'OpenBot'}-import${d.filesDeleted ? ', met de bestanden in de werkmap' : '; de bestanden in de werkmap bleven bewaard'}`, { tone: 'warn', category: 'data' })
      : you(tpl`{h} de bot ${q(d.name) || x.bot} verwijderd${d.filesDeleted ? ', met de bestanden in de werkmap' : '; de bestanden in de werkmap bleven bewaard'}`, { tone: 'danger' }),
  'agent.imported': (d, x) => you(tpl`{h} de bot ${q(d.name) || x.bot} geïmporteerd${d.from === 'openbot' ? ' uit OpenBot' : d.from === 'hermes' ? ' uit Hermes Agent' : d.from === 'openclaw' ? ' uit OpenClaw' : ''}${num(d.skills) ? ` met ${plural(num(d.skills), 'skill', 'skills')}` : ''}`),
  'agent.restored': (_d, x) => you(tpl`{h} een eerdere versie van ${x.bot} teruggezet`),
  'agent.reordered': (d) => you(tpl`{h} de volgorde van je bots aangepast${num(d.count) ? ` (${plural(num(d.count), 'bot', 'bots')})` : ''}`),
  'agent.skills_changed': (d, x) => you(tpl`{h} de skills van ${x.bot} aangepast${d.skills !== undefined ? ` (nu ${plural(num(d.skills), 'skill', 'skills')})` : ''}`),
  'agent.shared': (d, x) => you(tpl`{h} ${x.bot !== 'een bot' ? x.bot : q(d.name) || 'een bot'} gedeeld met het team`, { category: 'access', tone: 'warn' }),
  'agent.unshared': (d, x) => you(tpl`{h} ${x.bot !== 'een bot' ? x.bot : q(d.name) || 'een bot'} niet meer gedeeld met het team`, { category: 'access' }),
  'voice.call.interrupted': (d, x) => you(tpl`{h} in een spraakgesprek ${x.bot !== 'een bot' ? `${x.bot} ` : 'de bot '}onderbroken door te praten`, { category: 'bots' }),
  'agent.full_access': (d, x) =>
    d.on === true
      ? you(tpl`{h} Volledige toegang aangezet voor ${x.bot}${d.external ? ', ook voor versturen naar anderen' : ''}`, { tone: 'danger', category: 'access' })
      : d.on === false
        ? you(tpl`{h} Volledige toegang uitgezet voor ${x.bot}`, { category: 'access' })
        : you(tpl`{h} ${x.bot} toegestaan om zonder vragen naar anderen te versturen`, { tone: 'danger', category: 'access' }),

  // Own rules in plain words (module botrules): a rule that allows more, or removing a strict one, makes a bot looser.
  'botrules.added': (d, x) =>
    d.teamId
      ? you(tpl`{h} een eigen regel voor alle bots van een team toegevoegd: ${q(d.text, 160) || 'zonder tekst'}`, { category: 'access', tone: d.effect === 'allow' ? 'warn' : undefined })
      : you(tpl`{h} een eigen regel voor ${x.bot} toegevoegd: ${q(d.text, 160) || 'zonder tekst'}`, { category: 'access', tone: d.effect === 'allow' ? 'warn' : undefined }),
  'botrules.removed': (d, x) =>
    d.teamId
      ? you(tpl`{h} een eigen regel voor alle bots van een team weggehaald: ${q(d.text, 160) || 'zonder tekst'}`, { category: 'access', tone: d.effect === 'allow' ? undefined : 'warn' })
      : you(tpl`{h} een eigen regel voor ${x.bot} weggehaald: ${q(d.text, 160) || 'zonder tekst'}`, { category: 'access', tone: d.effect === 'allow' ? undefined : 'warn' }),

  // ---- access and security
  'secret.set': (d) => you(tpl`{h} het geheim ${q(d.name, 40) || 'zonder naam'} opgeslagen (de waarde staat versleuteld op de server)`, { category: 'access' }),
  'secret.deleted': (d) => you(tpl`{h} het geheim ${q(d.name, 40) || 'zonder naam'} gewist`, { category: 'access', tone: 'warn' }),
  'admin.member_policy': () => you('{h} de regels voor leden gewijzigd', { category: 'access' }),
  'admin.member_budget': (d) => you(d.dailyBudgetUsd === null || d.dailyBudgetUsd === undefined ? '{h} het eigen dagbudget van een lid weggehaald' : tpl`{h} het dagbudget van een lid op ${formatUsd(num(d.dailyBudgetUsd))} gezet`, { category: 'access' }),
  'mobile.pair.created': () => you('{h} een koppelcode voor een telefoon gemaakt', { category: 'access' }),
  'mobile.device.paired': (d) => sys(tpl`{h} een apparaat gekoppeld${q(d.name, 40) ? `: ${q(d.name, 40)}` : ''}${d.via === 'qr' ? ' via de QR-code' : d.via === 'code' ? ' met een koppelcode' : ''}`, { category: 'access' }),
  'mobile.device.revoked': () => you('{h} een gekoppeld apparaat ontkoppeld; het kan direct niets meer', { category: 'access', tone: 'warn' }),
  'mobile.gateway.enabled': () => you('{h} toegang vanaf de telefoon via het netwerk aangezet', { category: 'access' }),
  'mobile.gateway.disabled': () => you('{h} toegang vanaf de telefoon via het netwerk uitgezet', { category: 'access' }),
  'mobile.tailscale.serve': (d) => you(tpl`{h} Tailscale ingesteld voor de telefoon${d.ok === false ? ' (mislukt)' : ''}`, { category: 'access' }),
  'network.proxy.update': (d) => you(d.enabled ? tpl`{h} de proxy ingesteld${d.proxy ? ` (${clean(d.proxy, 60)})` : ''}` : '{h} de proxy uitgezet', { category: 'connections' }),
  'network.proxy.test': (d) => you(tpl`{h} de proxyverbinding getest: ${d.ok ? 'werkt' : 'werkt niet'}`, { category: 'connections', tone: d.ok ? 'neutral' : 'warn' }),
  'site.publish': (d) => bot(tpl`{h} de website ${q(d.title) || 'zonder titel'} gepubliceerd${num(d.files) ? ` (${plural(num(d.files), 'bestand', 'bestanden')})` : ''}`, { category: 'data' }),
  'site.republish': (d) => bot(tpl`{h} de website ${q(d.title) || 'zonder titel'} opnieuw gepubliceerd`, { category: 'data' }),
  'site.unpublish': (d) => bot(tpl`{h} de website ${q(d.title) || 'zonder titel'} offline gehaald`, { category: 'data' }),
  'site.expire': (d) => bot(tpl`{h} de website ${q(d.title) || 'zonder titel'} is verlopen en offline`, { category: 'data' }),
  'site.delete': (d) => bot(tpl`{h} de website ${q(d.title) || 'zonder titel'} verwijderd`, { category: 'data', tone: 'warn' }),
  'mobile.push.subscribed': (d) => you(tpl`{h} meldingen aangezet op ${q(d.label, 40) || 'een apparaat'}`, { category: 'access' }),
  'sso.login': () => you('{h} ingelogd via de identiteitsprovider (SSO)', { category: 'access' }),
  'sso.linked': () => you('{h} je account gekoppeld aan de identiteitsprovider (SSO)', { category: 'access' }),
  'sso.provisioned': () => sys('{h} je account aangemaakt via de identiteitsprovider (SSO)', { category: 'access' }),
  'sso.refused': (d) => sys(tpl`{h} een aanmelding via SSO geweigerd${({ disabled: ': het account is geblokkeerd', handoff: ': de aanmelding was verlopen of al gebruikt', provider: ': de identiteitsprovider gaf een fout' } as Record<string, string>)[String(d.reason)] || ''}`, { category: 'access', tone: 'warn' }),
  'sso.config': () => you('{h} de instellingen voor inloggen via SSO gewijzigd', { category: 'access' }),
  'remote.hostkey_mismatch': (d) => sys(tpl`{h} de verbinding met ${clean(d.host, 60) || 'een server'} geweigerd: de server gaf een andere vingerafdruk dan eerder`, { tone: 'danger', category: 'access' }),
  'remote.trusted': (d, x) => you(tpl`{h} de server ${clean(d.host, 60) || ''} vertrouwd voor ${x.bot}`, { category: 'access' }),
  'remote.untrusted': (d, x) => you(tpl`{h} het vertrouwen in de server ${clean(d.host, 60) || ''} ingetrokken voor ${x.bot}`, { category: 'access' }),
  'remote.credential_set': (_d, x) => you(tpl`{h} inloggegevens voor de externe computer van ${x.bot} opgeslagen`, { category: 'access' }),
  'remote.credential_deleted': (_d, x) => you(tpl`{h} de inloggegevens voor de externe computer van ${x.bot} gewist`, { category: 'access' }),
  'vault.created': (d) => you(tpl`{h} inloggegevens in de kluis gezet${d.origins ? ` voor ${list(d.origins, 2)}` : ''}${num(d.bots) ? ` (voor ${plural(num(d.bots), 'bot', 'bots')})` : ''}`, { category: 'access' }),
  'vault.updated': () => you('{h} inloggegevens in de kluis aangepast', { category: 'access' }),
  'vault.deleted': (d) => you(tpl`{h} inloggegevens uit de kluis verwijderd${d.origins ? ` (${list(d.origins, 2)})` : ''}`, { category: 'access', tone: 'warn' }),
  'vault.grant_added': (d, x) => you(tpl`{h} ${x.bot} toegang gegeven tot inloggegevens uit de kluis${d.origin ? ` voor ${clean(d.origin, 60)}` : ''}`, { category: 'access' }),
  'vault.grant_revoked': (d, x) => you(tpl`{h} ${x.bot} de toegang tot inloggegevens uit de kluis afgenomen${d.origin ? ` voor ${clean(d.origin, 60)}` : ''}`, { category: 'access' }),
  'vault.login': (d) => bot(d.ok ? tpl`{h} ingelogd op ${clean(d.origin, 60) || 'een website'} met inloggegevens uit de kluis` : tpl`kon niet inloggen op ${clean(d.origin, 60) || 'een website'}${d.reason === 'origin' ? ': het adres hoort niet bij deze inloggegevens' : ''}`, { category: 'access', tone: d.ok ? 'neutral' : 'warn' }),
  'vault.login_denied': (d) => bot(tpl`mocht niet inloggen op ${clean(d.origin, 60) || 'een website'}: geen toegang tot die inloggegevens`, { category: 'access', tone: 'warn' }),
  'computer.host_optin': (_d, x) => you(tpl`{h} ${x.bot} toegang gegeven tot je bureaublad`, { category: 'access', tone: 'warn' }),
  'computer.host_level': (d, x) => you(tpl`{h} de bureaubladtoegang van ${x.bot} gewijzigd${d.label ? ` naar ${q(d.label)}` : ''}`, { category: 'access' }),
  'computer.host_all_apps': (_d, x) => you(tpl`{h} ${x.bot} toegang gegeven tot alle programma's op je bureaublad`, { category: 'access', tone: 'danger' }),
  'computer.takeover': (_d, x) => you(tpl`{h} de bediening van de computer van ${x.bot} overgenomen`),
  'computer.host_resumed': (d, x) => you(d.all ? '{h} de bots je bureaublad weer laten bedienen' : tpl`{h} ${x.bot} je bureaublad weer laten bedienen`),
  'computer.desktop_stop': () => you('{h} de noodstop voor je bureaublad gebruikt', { tone: 'warn' }),
  'computer.emergency_stop': (_d, x) => you(tpl`{h} de noodstop gebruikt voor ${x.bot}`, { tone: 'warn' }),
  'computer.agent_cleanup': (_d, x) => sys(tpl`{h} de computer van ${x.bot} opgeruimd`),
  'desktop.launch': (d) => bot(tpl`{h} het programma ${q(d.app, 40) || ''} gestart op je bureaublad`),
  'desktop.grant': (d, x) => sys(tpl`{h} ${x.bot} toegang gegeven tot je bureaublad${d.minutes ? ` voor ${plural(num(d.minutes), 'minuut', 'minuten')}` : ''}${d.goal ? `: ${clean(d.goal, 80)}` : ''}`, { category: 'access', approval: { text: 'Na jouw toestemming', tone: 'ok' } }),
  // ---- remote desktop from the phone / another PC (server/modules/remote-desktop)
  'remote_desktop.on': (d) => you(d.control === false ? '{h} bureaublad op afstand aangezet (alleen meekijken)' : '{h} bureaublad op afstand aangezet', { category: 'access', tone: 'warn' }),
  'remote_desktop.options': (d) => you(d.control === false ? '{h} bureaublad op afstand op alleen meekijken gezet' : '{h} de instellingen van bureaublad op afstand gewijzigd', { category: 'access' }),
  'remote_desktop.off': (d) =>
    you(
      d.source === 'stopknop'
        ? '{h} bureaublad op afstand gestopt en uitgezet met de stopknop op het scherm'
        : d.source === 'sneltoets'
          ? '{h} bureaublad op afstand gestopt en uitgezet met de noodstop'
          : d.source === 'systeemvak'
            ? '{h} bureaublad op afstand gestopt en uitgezet via het systeemvak'
            : d.source === 'telefoon'
              ? '{h} bureaublad op afstand uitgezet vanaf je telefoon'
              : '{h} bureaublad op afstand uitgezet',
      { category: 'access' },
    ),
  'remote_desktop.start': (d) => you(tpl`{h} bureaublad op afstand geopend vanaf ${remoteDevice(d)}${d.view ? ' (alleen kijken)' : ''}`, { category: 'access', tone: 'warn' }),
  'remote_desktop.end': (d) => {
    const how = REMOTE_END[String(d.reason)] || 'beëindigd';
    const s = Math.max(0, Math.round(num(d.seconds)));
    const long = s < 60 ? plural(s, 'seconde', 'seconden') : plural(Math.round(s / 60), 'minuut', 'minuten');
    const text = tpl`{h} bureaublad op afstand vanaf ${remoteDevice(d)} ${how} na ${long}`;
    return d.reason === 'ended' ? you(text, { category: 'access' }) : sys(text, { category: 'access' });
  },
  'publishers.policy': () => you('{h} het beleid voor uitgevers van pakketten gewijzigd', { category: 'access' }),
  'publishers.trusted_added': (d) => you(tpl`{h} de uitgever ${q(d.name, 40)} vertrouwd`, { category: 'access' }),
  'publishers.trusted_removed': (d) => you(tpl`{h} de uitgever ${q(d.name, 40)} niet langer vertrouwd`, { category: 'access' }),
  'package.policy_override': (d) => you(tpl`{h} ${q(d.item, 40) || 'een pakket'} toch toegestaan, ook al was de handtekening niet in orde`, { category: 'access', tone: 'warn' }),
  'package.publisher_changed': (d) => sys(tpl`{h} gemerkt dat de uitgever van ${q(d.item, 40) || 'een pakket'} veranderd is`, { category: 'access', tone: 'warn' }),

  // ---- connections
  'provider.created': (d) => you(tpl`{h} de AI-provider ${q(d.name) || engineName(d.kind)} gekoppeld`, { category: 'connections' }),
  'provider.updated': () => you('{h} een AI-provider aangepast', { category: 'connections' }),
  'provider.deleted': (d) => you(tpl`{h} de AI-provider ${engineName(d.kind) || ''} ontkoppeld`, { category: 'connections', tone: 'warn' }),
  'provider.default_auto': (d) => sys(tpl`{h} ${engineName(d.kind) || 'een AI-provider'} gekozen als standaard`, { category: 'connections' }),
  'model_catalog.refresh_setting': (d) => you(d.on ? '{h} het dagelijks bijwerken van de modelgegevens aangezet' : '{h} het dagelijks bijwerken van de modelgegevens uitgezet', { category: 'connections' }),
  'model_catalog.refresh': (d) => you('{h} de modelgegevens laten bijwerken via models.dev', { category: 'connections', tone: d.error ? 'warn' : 'neutral' }),
  'free_models.source': (d) =>
    you(d.on === false ? tpl`{h} ${engineName(d.kind) || 'een gratis bron'} uitgezet bij Gratis modellen` : d.on === true ? tpl`{h} ${engineName(d.kind) || 'een gratis bron'} aangezet bij Gratis modellen` : tpl`{h} de sleutel van ${engineName(d.kind) || 'een gratis bron'} vervangen bij Gratis modellen`, { category: 'connections' }),
  'free_models.model_gone': (d) => sys(tpl`{h} een gratis model${d.model ? ` (${clean(d.model, 60)})` : ''} uit de keten gehaald, omdat ${engineName(d.kind) || 'de aanbieder'} het niet meer aanbiedt`, { category: 'connections' }),
  'localmodels.pull': (d) => you(tpl`{h} het lokale model ${q(d.model) || ''} laten downloaden in Ollama`, { category: 'connections' }),
  'localmodels.use': (d) => you(tpl`{h} ${q(d.model) || 'een lokaal model'} gekozen als standaardmodel van Ollama voor nieuwe bots`, { category: 'connections' }),
  'folders.team_set': (d) => you(tpl`{h} de teammap ingesteld${d.path ? `: ${shortPath(d.path)}` : ''}${d.agents === 'all' ? ' (voor alle bots)' : d.agents !== undefined ? ` (voor ${plural(num(d.agents), 'bot', 'bots')})` : ''}${d.from === 'openbot-import' ? ' bij de OpenBot-import' : ''}`, { category: 'connections' }),
  'folders.team_removed': () => you('{h} de teammap losgekoppeld', { category: 'connections' }),
  'channels.binding_created': (d, x) => you(tpl`{h} ${adapter(d.adapter)} gekoppeld aan ${x.bot}${d.name ? ` als ${q(d.name, 40)}` : ''}`, { category: 'connections' }),
  'channels.binding_deleted': (d, x) => you(tpl`{h} ${adapter(d.adapter)} losgekoppeld van ${x.bot}`, { category: 'connections', tone: 'warn' }),
  'channels.send': (d) => bot(tpl`{h} een bericht verstuurd via ${adapter(d.adapter)}${d.owner ? ' naar jou' : d.to ? ` naar ${clean(d.to, 60)}` : ''}`, { category: 'connections', approval: d.preApproved ? { text: 'Toegestaan door een verzendregel', tone: 'neutral' } : undefined }),
  'channels.owner_send': (d, x) => you(tpl`{h} via ${adapter(d.adapter)} een bericht gestuurd in het gesprek van ${x.bot}`, { category: 'connections' }),
  'mcp.connection.created': (d) => you(tpl`{h} de app ${q(d.label || d.name)} gekoppeld${d.host ? ` (${clean(d.host, 50)})` : ''}`, { category: 'connections' }),
  'mcp.connection.deleted': (d) => you(tpl`{h} de app ${q(d.label || d.name)} ontkoppeld${d.revokedAtService ? ' en de toegang bij de dienst ingetrokken' : ''}`, { category: 'connections', tone: 'warn' }),
  'mcp.binding.added': (d, x) => you(tpl`{h} ${x.bot} toegang gegeven tot de app ${q(d.name)}`, { category: 'connections' }),
  'mcp.binding.removed': (d, x) => you(tpl`{h} ${x.bot} de toegang tot de app ${q(d.name)} afgenomen`, { category: 'connections' }),
  'mcp.tool.risk_loosened': (d) => you(tpl`{h} een actie van een app als minder riskant ingesteld${d.tool ? `: ${q(String(d.tool).replace(/[_-]+/g, ' '), 40)}` : ''}`, { category: 'connections', tone: 'warn' }),
  'mcp.crashed': (d) => sys(tpl`{h} gemerkt dat de app ${q(d.name)} is vastgelopen${num(d.crashes) > 1 ? ` (${num(d.crashes)}×)` : ''}`, { category: 'connections', tone: 'warn' }),
  'cloudvm.created': (d) => bot(tpl`{h} een cloudcomputer ${q(d.name, 40)} gemaakt bij ${engineName(d.provider)}${d.monthly ? ` (± ${money(num(d.monthly), clean(d.currency, 4) || 'EUR')} per maand)` : ''}`, { category: 'connections', tone: 'warn' }),
  'cloudvm.deleted': (d) => you(tpl`{h} de cloudcomputer ${q(d.name, 40)} verwijderd`, { category: 'connections', tone: 'warn' }),
  'mcp.tool.risk_guessed': (d) =>
    sys(tpl`{h} ${Array.isArray(d.tools) && d.tools.length > 1 ? `${d.tools.length} acties van een app` : 'een actie van een app'} als waarschijnlijk alleen lezen herkend${Array.isArray(d.tools) && d.tools.length === 1 ? `: ${q(String(d.tools[0]).replace(/[_-]+/g, ' '), 40)}` : ''} (de app gaf er geen informatie over)`, { category: 'connections' }),

  // ---- memory
  'memory.created': (d) => (d.origin === 'user' ? you : bot)(tpl`{h} iets onthouden${d.scope === 'about_you' ? ' over jou' : d.scope === 'shared' ? ' voor alle bots' : ''}`, { category: 'memory' }),
  'memory.proposed': () => bot('{h} voorgesteld iets te onthouden (staat bij Beoordelen)', { category: 'memory' }),
  'memory.approved': () => you('{h} een geheugenvoorstel goedgekeurd', { category: 'memory', approval: BY_YOU }),
  'memory.rejected': () => you('{h} een geheugenvoorstel afgewezen', { category: 'memory', approval: DENIED_YOU }),
  'memory.superseded': () => bot('{h} een herinnering vervangen door een nieuwere versie (de oude blijft in de geschiedenis)', { category: 'memory' }),
  'memory.forgotten': (d) => (d.by === 'agent' ? bot : you)(tpl`{h} ${num(d.count) > 1 ? `${num(d.count)} herinneringen` : d.kind === 'dossier' ? 'een dossier' : 'een herinnering'} definitief vergeten${d.alsoSource ? ', met het bronbericht' : ''}`, { category: 'memory', tone: 'warn' }),
  'memory.deleted_all': () => you('{h} het hele geheugen gewist', { category: 'memory', tone: 'danger' }),
  'memory.secret_rejected': () => sys('{h} geweigerd iets te onthouden dat op een wachtwoord of sleutel leek', { category: 'memory', tone: 'warn' }),
  'memory.injection_rejected': () => sys('{h} geweigerd iets te onthouden dat op een verborgen opdracht leek', { category: 'memory', tone: 'warn' }),
  'memory.imported': (d) => you(tpl`{h} ${num(d.total) ? plural(num(d.total), 'herinnering', 'herinneringen') : 'herinneringen'} geïmporteerd`, { category: 'memory' }),
  'memory.dossier_created': (_d, x) => (x.bot !== 'een bot' ? bot : you)('{h} een dossier gemaakt', { category: 'memory' }),
  'memory.record_created': (d) => bot(tpl`{h} ${({ decision: 'een besluit', action: 'een actie', fact: 'een feit', note: 'een notitie', question: 'een open vraag', source: 'een bron' } as Record<string, string>)[String(d.kind)] || 'iets'} toegevoegd aan een dossier`, { category: 'memory' }),
  'memory.dossiers_imported': (d) =>
    you(tpl`{h} ${num(d.created) ? plural(num(d.created), 'dossier', 'dossiers') : 'dossiers'} geïmporteerd uit Markdown-bestanden${num(d.skipped) ? ` (${plural(num(d.skipped), 'bestand', 'bestanden')} overgeslagen)` : ''}`, { category: 'memory' }),
  'memory.trash_emptied': (d) => you(tpl`{h} de prullenbak van het geheugen geleegd${num(d.count) ? ` (${plural(num(d.count), 'item', 'items')})` : ''}`, { category: 'memory', tone: 'warn' }),
  'memory.undo': () => you('{h} een wijziging in het geheugen ongedaan gemaakt', { category: 'memory' }),

  // ---- routines
  'routine.created': (d) => (d.by === 'agent' ? bot : you)(tpl`{h} de routine ${q(d.name)} gemaakt${keptText(clean(d.schedule, 60)) ? ` (${keptText(clean(d.schedule, 60))})` : ''}${d.status === 'draft' ? ' als concept' : ''}`, { category: 'routines' }),
  'routine.paused': (d) => (d.by === 'system' ? sys : you)(tpl`{h} een routine gepauzeerd${d.reason ? `: ${clean(d.reason, 100)}` : ''}`, { category: 'routines' }),
  'routine.resumed': () => you('{h} een routine weer aangezet', { category: 'routines' }),
  'routine.deleted': (d) => you(tpl`{h} de routine ${q(d.name)} verwijderd`, { category: 'routines', tone: 'warn' }),
  'routine.confirmed': () => you('{h} een routine bevestigd zodat hij gaat draaien', { category: 'routines', approval: { text: 'Bevestigd door jou', tone: 'ok' } }),
  'routine.run.manual': () => you('{h} een routine nu laten draaien', { category: 'routines' }),
  'routine.run.after': () => you('{h} een routine ingepland na de reset van de limiet', { category: 'routines' }),
  'task.start_after': () => you('{h} een taak ingepland na de reset van de limiet', { category: 'routines' }),
  'routine.run.cancelled': () => you('{h} een lopende routine gestopt', { category: 'routines' }),
  // 0.4.4: the main bot reports stuck work (teams/stuck.ts), Opnieuw proberen under it, the watchdog's message on or off.
  'teams.stuck_reported': (d, x) => sys(tpl`{h} via ${x.bot} gemeld dat er werk stil ligt`, { tone: 'warn' }),
  'teams.stuck_retry': () => you('{h} vastgelopen werk opnieuw laten proberen'),
  // The main bot's overview of the team (teams/briefing.ts): what was done, what waits for the owner, the top kansen.
  'teams.briefing': (d) => sys(tpl`{h} het overzicht van je team gestuurd${num(d.kansen) ? ` (met ${plural(num(d.kansen), 'kans', 'kansen')})` : ''}`),
  'health.watchdog': (d) => you(d.notify === false ? '{h} de melding van de wachter buiten de app uitgezet' : '{h} de melding van de wachter buiten de app aangezet'),
  'routine.not_run': (d) => sys(tpl`{h} gemeld dat een geplande routine-run niet draaide${colon(clean(d.reason, 100))}`, { category: 'routines', tone: 'warn' }),
  'routine.stop_all': (d) => you(tpl`{h} met Alles stoppen ook wachtende routine-runs gestopt${d.cancelled !== undefined ? ` (${plural(num(d.cancelled), 'run', 'runs')})` : ''}`, { category: 'routines' }),
  'routine.trigger.secret_rotated': (d) =>
    you(tpl`{h} het geheim van een webhook vernieuwd${num(d.graceMinutes) > 0 ? `; het oude werkt nog ${plural(num(d.graceMinutes), 'minuut', 'minuten')}` : '; het oude werkt meteen niet meer'}`, { category: 'routines' }),
  'routine.trigger.secret_set': () => you('{h} een geheim voor een webhook ingesteld', { category: 'routines' }),
  'routine.trigger.previous_secret_revoked': () => you('{h} het oude geheim van een webhook meteen ingetrokken', { category: 'routines' }),
  'routine.waitpoint': (d) => bot(tpl`{h} een wachtpunt gezet${({ file: ' voor een bestand', message: ' voor een chatbericht', webhook: ' voor een webhook', time: ' voor een tijdstip' } as Record<string, string>)[String(d.kind)] || ''}`, { category: 'routines' }),
  'power.keep_awake': (d) => you(d.enabled ? '{h} gezet dat de pc wakker blijft terwijl routines of taken lopen' : '{h} uitgezet dat de pc wakker blijft terwijl routines of taken lopen'),

  // ---- team and groups
  'team.ask': (d, x) => bot(tpl`{h} ${clean(d.to, 40) || 'een andere bot'} iets gevraagd${colon(clean(d.message, 100))}`, { actor: clean(d.from, 40) || x.bot }),
  'team.delegate': (d, x) => bot(tpl`{h} ${clean(d.to, 40) || 'een andere bot'} een taak gegeven${colon(clean(d.task, 100))}`, { actor: clean(d.from, 40) || x.bot }),
  'team.message': (d, x) => bot(tpl`{h} ${clean(d.to, 40) || 'een andere bot'} een bericht gestuurd${colon(clean(d.task, 100))}`, { actor: clean(d.from, 40) || x.bot }),
  'team.broadcast': (d, x) => bot(tpl`{h} het team iets gevraagd${d.to ? ` (${list(d.to)})` : ''}`, { actor: clean(d.from, 40) || x.bot }),
  'team.handoff': (d, x) => bot(tpl`{h} het werk overgedragen aan ${clean(d.to, 40) || 'een andere bot'}${colon(clean(d.reason, 100))}`, { actor: clean(d.from, 40) || x.bot }),
  'team.hire_approved': (d) => you(tpl`{h} het voorstel goedgekeurd om ${q(d.name) || 'een nieuw lid'} aan het team toe te voegen`, { approval: BY_YOU, category: 'approvals' }),
  'team.hire_denied': (d) => you(tpl`{h} het voorstel afgewezen om ${q(d.name) || 'een nieuw lid'} aan het team toe te voegen`, { approval: DENIED_YOU, category: 'approvals' }),
  'team.created': (d) => you(tpl`{h} het team ${q(d.name)} gemaakt`),
  'team.installed': (d) => you(tpl`{h} het team ${q(d.name)} gemaakt uit een ${d.source === 'sjabloon' ? 'sjabloon' : 'teampakket'}${num(d.bots) ? ` (${plural(num(d.bots), 'bot', 'bots')})` : ''}`),
  'team.exported': (d) => you(tpl`{h} een groep geëxporteerd als teampakket${num(d.bots) ? ` (${plural(num(d.bots), 'bot', 'bots')})` : ''}${d.removedSecrets ? '; geheimen zijn eruit gehaald' : ''}`),
  'team.deleted': () => you('{h} een team verwijderd', { tone: 'warn' }),
  'room.created': (d) => you(tpl`{h} een groep gemaakt${num(d.agents) ? ` met ${plural(num(d.agents), 'bot', 'bots')}` : ''}`),
  'room.deleted': (d) => you(tpl`{h} de groep ${q(d.name)} verwijderd`, { tone: 'warn' }),
  'room.stopped': (d) => you(tpl`{h} het werk in een groep gestopt${num(d.runs) ? ` (${plural(num(d.runs), 'taak', 'taken')})` : ''}`),
  'room.file_write': (d, x) => bot(tpl`{h} een bestand in de groepsmap geschreven${colon(shortPath(d.path))}`, { actor: clean(d.by, 40) || x.bot }),
  'room.file_delete': (d, x) => bot(tpl`{h} een bestand uit de groepsmap verwijderd${colon(shortPath(d.path))}`, { actor: clean(d.by, 40) || x.bot, tone: 'warn' }),
  'teamdata.schema': (d, x) => bot(tpl`{h} de opbouw van de teamdatabase gewijzigd${d.table ? ` (tabel ${q(d.table, 40)})` : ''}`, { actor: clean(d.by, 40) || x.bot, category: 'data' }),
  'teamdata.decision': (d) => you(tpl`{h} een beslissing genomen in Teamwerk${colon(clean(d.answer, 80))}`, { category: 'approvals' }),
  'teamdata.imported': () => you('{h} de teamdatabase uit OpenBot geïmporteerd', { category: 'data' }),
  // ---- work that is really done (quality module)
  'quality.check': (d, x) =>
    sys(tpl`{h} het werk van ${x.bot} met een tweede blik nagekeken${d.state === 'passed' ? ' (klaar)' : d.state === 'cant' ? ' (kon niet)' : ' (te controleren)'}${colon(clean(d.task, 80))}`, { tone: d.state === 'passed' ? undefined : 'warn' }),
  'quality.report': (d) => bot(tpl`{h} een taak afgemeld${d.state === 'passed' ? ' (gecontroleerd: klaar)' : d.state === 'skipped' ? ' (klaar, zonder controle)' : d.state === 'cant' ? ' (kon niet)' : d.state ? ' (te controleren)' : ''}${colon(clean(d.task, 80))}`),
  'quality.cant': (d) => bot(tpl`{h} gemeld dat een taak niet lukte${colon(clean(d.task, 80))}`, { tone: 'warn' }),
  // A second look that met its engine's limit waits for the reset, and runs again then (0.4.5).
  'quality.check_wait': (d, x) => sys(tpl`{h} de tweede blik op het werk van ${x.bot} uitgesteld tot na de limiet van ${clean(d.engine, 40) || 'de engine'}${colon(clean(d.task, 80))}`, { tone: 'warn' }),
  'quality.recheck': (d, x) =>
    sys(tpl`{h} het werk van ${x.bot} na de limiet alsnog nagekeken${d.state === 'passed' ? ' (klaar)' : d.state === 'cant' ? ' (kon niet)' : ' (te controleren)'}${colon(clean(d.task, 80))}`, { tone: d.state === 'passed' ? undefined : 'warn' }),
  'quality.lesson': (_d, x) => sys(tpl`{h} uit jouw correctie een les voor ${x.bot} onthouden`),
  'quality.skill_accepted': (d, x) => you(tpl`{h} ${x.bot} gevraagd een skill voor te stellen${colon(clean(d.title, 80))}`),
  'quality.skill_dismissed': (d) => you(tpl`{h} een voorstel voor een skill weggelegd${colon(clean(d.title, 80))}`),
  'agent.loop_stop': (_d, x) => sys(tpl`{h} ${x.bot} laten stoppen: steeds dezelfde stap zonder vooruitgang`, { tone: 'warn' }),

  // ---- data
  'workflow.created': (d) => you(tpl`{h} de workflow ${clean(d.name, 80) || 'zonder naam'} gemaakt`),
  'workflow.deleted': (d) => you(tpl`{h} de workflow ${clean(d.name, 80) || 'zonder naam'} verwijderd`),
  'workflow.webhook_on': () => you('{h} voor een workflow de start via een webadres aangezet', { tone: 'warn' }),
  'workflow.webhook_off': () => you('{h} voor een workflow de start via een webadres uitgezet'),
  'workflow.started': (d) => sys(d.trigger === 'webhook' ? '{h} een workflow gestart via het webadres' : '{h} een workflow gestart'),
  'workflow.resumed': () => you('{h} een workflow die wachtte laten doorgaan'),
  'image.generated': (d) => sys(tpl`{h} een afbeelding gemaakt${d.model ? ` met ${clean(d.model, 60)}` : ''}`),
  'specialists.adopted': (d) => sys(tpl`{h} ${clean(d.agent, 60) || 'een bot'} als specialist ingesteld, omdat de naam of rol een vakgebied noemt`),
  'backup.created': () => you('{h} een back-up gemaakt', { category: 'data' }),
  'backup.restore_staged': () => you('{h} een back-up klaargezet; die wordt teruggezet bij de volgende start', { category: 'data', tone: 'warn' }),
  'backup.deleted': () => you('{h} een back-up verwijderd', { category: 'data' }),
  'backup.settings': (d) => you(d.auto === false ? '{h} de automatische back-ups uitgezet' : tpl`{h} de instellingen van de back-ups gewijzigd${num(d.keep) ? ` (de laatste ${num(d.keep)} bewaren)` : ''}`, { category: 'data' }),
  'backup.restored': (d) => sys(d.reason === 'rollback' ? '{h} de back-up van vlak voor de update teruggezet' : '{h} een back-up teruggezet; wat vergeten was, bleef vergeten', { category: 'data', tone: 'warn' }),
  'backup.app_updated': (d) => sys(tpl`{h} gemerkt dat TeamBot is bijgewerkt${d.to ? ` naar versie ${clean(d.to, 30)}` : ''}${d.backup ? '; vooraf was een back-up gemaakt' : ''}`, { category: 'data' }),
  'backup.rollback': (d) => sys(tpl`{h} gemerkt dat TeamBot terug is${d.to ? ` op versie ${clean(d.to, 30)}` : ' op een vorige versie'}`, { category: 'data', tone: 'warn' }),
  'backup.rollback_started': (d) => you(tpl`{h} gekozen om terug te gaan${d.to ? ` naar versie ${clean(d.to, 30)}` : ' naar de vorige versie'}`, { category: 'data', tone: 'warn' }),
  'backup.offsite_settings': () => you('{h} de tweede plek voor back-ups ingesteld', { category: 'data' }),
  'backup.offsite_cleared': () => you('{h} gestopt met kopieën op de tweede plek', { category: 'data', tone: 'warn' }),
  'backup.offsite_copy': () => you('{h} een versleutelde kopie van een back-up op de tweede plek gezet', { category: 'data' }),
  'backup.offsite_import': () => you('{h} een versleutelde kopie terug bij de back-ups gezet', { category: 'data', tone: 'warn' }),
  'ocr.download': () => you('{h} de taaldata voor het lezen van scans laten downloaden', { category: 'data' }),
  'ocr.removed': () => you('{h} de taaldata voor het lezen van scans verwijderd', { category: 'data' }),
  'teamdata.import_file': (d) => you(tpl`{h} een CSV- of Excel-bestand in de teamdatabase gezet${d.table ? ` (tabel ${q(d.table, 40)})` : ''}`, { category: 'data' }),

  // Updates of TeamBot itself (server/modules/backups/app-update.ts).
  'app.update_now': () => you('{h} gekozen om TeamBot nu bij te werken', { category: 'data' }),
  'app.update_settings': (d) => you(d.auto === 'off' ? '{h} automatisch bijwerken uitgezet' : d.auto === 'notify' ? '{h} gekozen dat TeamBot nieuwe versies alleen meldt' : '{h} automatisch bijwerken aangezet', { category: 'data' }),
  'app.update_channel': (d) => you(typeof d.channel === 'string' && d.channel ? tpl`{h} het updatekanaal ingesteld op ${clean(d.channel, 120)}` : '{h} het eigen updatekanaal weggehaald', { category: 'data', tone: 'warn' }),
  'history.deleted': (d, x) =>
    you(
      d.scope === 'room'
        ? tpl`{h} de geschiedenis van de groep ${q(d.name) || 'een groep'} gewist${num(d.messages) ? ` (${plural(num(d.messages), 'bericht', 'berichten')})` : ''}`
        : tpl`{h} de geschiedenis van ${x.bot !== 'een bot' ? x.bot : q(d.name) || 'een bot'} gewist${num(d.messages) ? ` (${plural(num(d.messages), 'bericht', 'berichten')})` : ''}`,
      { tone: 'warn', category: 'data' },
    ),
  'history.reapplied': (d, x) =>
    sys(d.scope === 'room' ? tpl`{h} na het terugzetten van een back-up de gewiste geschiedenis van de groep ${q(d.name) || 'een groep'} opnieuw gewist` : tpl`{h} na het terugzetten van een back-up de gewiste geschiedenis van ${x.bot !== 'een bot' ? x.bot : q(d.name) || 'een bot'} opnieuw gewist`, { category: 'data' }),
  'openbot.imported': (d) => you(tpl`{h} je team uit OpenBot geïmporteerd${num(d.agents) ? ` (${plural(num(d.agents), 'bot', 'bots')})` : ''}`, { category: 'data' }),
  'hermes.imported': (d) => you(tpl`{h} je bots uit Hermes Agent geïmporteerd${num(d.bots) ? ` (${plural(num(d.bots), 'bot', 'bots')})` : ''}`, { category: 'data' }),
  'hermes.undone': (d) => you(tpl`{h} de import uit Hermes Agent ongedaan gemaakt${num(d.bots) ? ` (${plural(num(d.bots), 'bot', 'bots')} weg)` : ''}`, { category: 'data', tone: 'warn' }),
  'openclaw.imported': (d) => you(tpl`{h} je agents uit OpenClaw geïmporteerd${num(d.bots) ? ` (${plural(num(d.bots), 'bot', 'bots')})` : ''}`, { category: 'data' }),
  'openclaw.import_undone': (d) => you(tpl`{h} de import uit OpenClaw ongedaan gemaakt${num(d.bots) ? ` (${plural(num(d.bots), 'bot', 'bots')} weg)` : ''}`, { category: 'data', tone: 'warn' }),
  'openbot.undone': (d) => you(tpl`{h} de import uit OpenBot ongedaan gemaakt${num(d.bots) ? ` (${plural(num(d.bots), 'bot', 'bots')} weg)` : ''}`, { category: 'data', tone: 'warn' }),
  'memory.exported': () => you('{h} het geheugen geëxporteerd', { category: 'data' }),
  'template.exported': (d, x) => you(tpl`{h} ${x.bot} geëxporteerd als sjabloon${d.removedSecrets ? ' (geheimen weggelaten)' : ''}`, { category: 'data' }),
  'template.installed': (d) => you(tpl`{h} het sjabloon ${q(d.name)} geïnstalleerd`, { category: 'connections' }),
};

/** One sentence per family (prefix up to the first dot, or two parts for mcp/routine/skill…), with the last part as hint. */
function family(kind: string, d: any, x: X): Spec | null {
  const [p, ...rest] = kind.split('.');
  const last = rest[rest.length - 1] || '';
  const verb = (map: Record<string, string>, fallback: string) => map[last] || fallback;
  const common: Record<string, string> = {
    created: 'aangemaakt', updated: 'aangepast', deleted: 'verwijderd', removed: 'verwijderd', added: 'toegevoegd', set: 'ingesteld', changed: 'gewijzigd',
    enabled: 'aangezet', disabled: 'uitgezet', started: 'gestart', ended: 'beëindigd', installed: 'geïnstalleerd', imported: 'geïmporteerd', exported: 'geëxporteerd',
    revoked: 'ingetrokken', connected: 'verbonden', shared: 'gedeeld', unshared: 'niet meer gedeeld', paused: 'gepauzeerd', resumed: 'hervat', applied: 'toegepast',
    restored: 'teruggezet', wiped: 'leeggemaakt', pinned: 'vastgezet', unpinned: 'losgemaakt', blocked: 'geblokkeerd', unblocked: 'gedeblokkeerd', linked: 'gekoppeld',
    unlinked: 'losgekoppeld', refreshed: 'vernieuwd', reported: 'gemeld', downloaded: 'gedownload', published: 'gepubliceerd', edited: 'bewerkt', trusted: 'vertrouwd', untrusted: 'niet meer vertrouwd',
  };
  const done = (fallback = 'gewijzigd') => verb(common, fallback);
  switch (p) {
    case 'approval':
      return you(tpl`{h} een verzoek van ${x.bot} afgehandeld`, { category: 'approvals' });
    case 'autoreview':
      return sys(tpl`{h} een actie van ${x.bot} automatisch gecontroleerd`, { category: 'approvals' });
    case 'policy':
      return you(tpl`{h} het toolbeleid van ${x.bot} gewijzigd`, { category: 'approvals' });
    case 'agent':
      return you(tpl`{h} ${x.bot} ${done()}`);
    case 'tool':
    case 'file':
      return bot(tpl`{h} ${p === 'file' ? 'een bestand' : 'een hulpmiddel'} gebruikt${colon(shortPath(d.path) || summaryDetail(d.summary))}`);
    case 'shell':
    case 'container':
      return bot(tpl`{h} een opdracht uitgevoerd${colon(clean(d.command, 100))}`);
    case 'cli':
      return x.bot !== 'een bot' ? bot(tpl`{h} iets gedaan met ${engineName(d.cli) || 'zijn AI-engine'}`) : you(tpl`{h} een instelling van ${engineName(d.cli) || 'een AI-engine'} gewijzigd`, { category: 'connections' });
    case 'thread':
      return you(tpl`{h} een gesprek ${done()}`);
    case 'queue':
      return you(tpl`{h} de wachtrij van ${x.bot} gewijzigd`);
    case 'security':
      return sys('{h} een onveilige actie tegengehouden', { tone: 'danger', category: 'access' });
    case 'secret':
      return you(tpl`{h} een geheim ${done()}`, { category: 'access' });
    case 'admin':
      return you('{h} een beheerinstelling gewijzigd', { category: 'access' });
    case 'sso':
      return you('{h} iets gewijzigd aan inloggen via SSO', { category: 'access' });
    case 'scim': {
      if (rest[0] === 'config') return you('{h} de gebruikerssynchronisatie (SCIM) ingesteld', { category: 'access' });
      if (rest[0] === 'token') return you(tpl`{h} de sleutel voor de gebruikerssynchronisatie (SCIM) ${last === 'revoked' ? 'ingetrokken' : 'aangemaakt'}`, { category: 'access' });
      if (kind === 'scim.group.mapping') return you(tpl`{h} ingesteld wat leden van de groep ${q(d.group, 40) || 'uit de identiteitsprovider'} krijgen`, { category: 'access' });
      if (kind === 'scim.mapping.reapplied') return you(tpl`{h} de groepsregels opnieuw toegepast${num(d.users) ? ` op ${plural(num(d.users), 'gebruiker', 'gebruikers')}` : ''}`, { category: 'access' });
      if (rest[0] === 'user') {
        const uv = ({ created: 'aangemaakt', deactivated: 'gedeactiveerd', reactivated: 'weer geactiveerd', updated: 'bijgewerkt', restored: 'teruggezet', deleted: 'verwijderd' } as Record<string, string>)[last] || done();
        return sys(tpl`{h} je account ${uv} via de gebruikerssynchronisatie (SCIM)`, { category: 'access', tone: last === 'deactivated' || last === 'deleted' ? 'warn' : 'neutral' });
      }
      const what = rest[0] === 'user' ? 'een gebruiker' : rest[0] === 'group' ? `de groep ${q(d.group || d.to, 40) || ''}`.trim() : rest[0] === 'token' ? 'de SCIM-sleutel' : rest[0] === 'mapping' ? 'de koppeling van groepen aan rollen' : 'de gebruikerssynchronisatie';
      const v = ({ deactivated: 'gedeactiveerd', reactivated: 'weer geactiveerd', members: 'bijgewerkt (leden)', renamed: 'hernoemd', reapplied: 'opnieuw toegepast', mapping: 'ingesteld', config: 'ingesteld' } as Record<string, string>)[last] || done();
      return sys(tpl`{h} ${what} ${v} via de gebruikerssynchronisatie (SCIM)`, { category: 'access' });
    }
    case 'mobile':
      return you(tpl`{h} iets gewijzigd aan de telefoontoegang`, { category: 'access' });
    case 'vault':
      return you(tpl`{h} de kluis met inloggegevens ${done()}`, { category: 'access' });
    case 'publishers':
    case 'package':
      return you('{h} het vertrouwen in een uitgever van pakketten gewijzigd', { category: 'access' });
    case 'computer':
      return you(tpl`{h} de computer van ${x.bot} ${done('ingesteld')}`);
    case 'desktop': {
      const act = ({ click: 'geklikt', double_click: 'dubbelgeklikt', triple_click: 'geklikt', right_click: 'rechts geklikt', type: 'getypt', key: 'een toets ingedrukt', scroll: 'gescrold', drag: 'gesleept', move: 'de muis bewogen', focus: 'een venster geactiveerd', close: 'een venster gesloten' } as Record<string, string>)[last] || 'iets gedaan';
      const where = clean(d.process, 40) || clean(d.title, 60);
      return bot(tpl`{h} op je bureaublad ${act}${where ? ` in ${where}` : ''}`, { tone: d.danger ? 'warn' : 'neutral' });
    }
    case 'browser': {
      if (last === 'download') return bot(tpl`{h} een bestand gedownload in de browser${d.path ? `: ${shortPath(d.path)}` : ''}`);
      if (last === 'upload') return bot(tpl`{h} een bestand geüpload naar een website${d.path ? `: ${shortPath(d.path)}` : ''}`, { tone: 'warn' });
      if (last === 'submit') return bot(tpl`{h} een formulier verstuurd${d.description ? `: ${clean(d.description, 80)}` : ''}`, { tone: 'warn' });
      if (last === 'logout_site') return you(tpl`{h} ${x.bot} uitgelogd bij ${clean(d.site, 60) || 'een website'}`, { category: 'access' });
      if (last === 'profile_members') return you('{h} ingesteld wie een browserprofiel mag gebruiken', { category: 'connections' });
      const pv = ({ profile_created: 'aangemaakt', profile_deleted: 'verwijderd', profile_wiped: 'leeggemaakt (ingelogde sites en cookies gewist)', profile_shared: 'gedeeld' } as Record<string, string>)[last] || done();
      return you(tpl`{h} een browserprofiel${d.name ? ` ${q(d.name, 40)}` : ''} ${pv}`, { category: 'connections' });
    }
    case 'remote': {
      if (last === 'exec') return bot(tpl`{h} een opdracht uitgevoerd op ${clean(d.host, 50) || 'de externe computer'}${colon(clean(d.command, 90))}`);
      if (last === 'write') return bot(tpl`{h} een bestand geschreven op ${clean(d.host, 50) || 'de externe computer'}${colon(shortPath(d.path))}`);
      if (last === 'upload') return bot(tpl`{h} een bestand naar ${clean(d.host, 50) || 'de externe computer'} gezet${colon(shortPath(d.remote))}`);
      if (last === 'download') return bot(tpl`{h} een bestand van ${clean(d.host, 50) || 'de externe computer'} gehaald${colon(shortPath(d.remote))}`);
      return you(tpl`{h} de externe computer van ${x.bot} ${done('ingesteld')}`, { category: 'access' });
    }
    case 'cloudvm': {
      const v = ({ token_set: 'de sleutel voor cloudcomputers opgeslagen', token_deleted: 'de sleutel voor cloudcomputers gewist', poweroff: `de cloudcomputer ${q(d.name, 40)} uitgezet`, poweron: `de cloudcomputer ${q(d.name, 40)} aangezet` } as Record<string, string>)[last];
      if (v) return you(tpl`{h} ${v}${d.provider ? ` (${engineName(d.provider)})` : ''}`, { category: 'connections' });
      const s = ({ gone: 'bestaat niet meer bij de aanbieder', ready: 'is klaar voor gebruik', error: 'kreeg een privé-adres en is niet gebruikt', orphaned: 'hoort niet meer bij een bot', create_failed: 'kon niet worden gemaakt' } as Record<string, string>)[last] || done();
      return sys(tpl`{h} gemeld: de cloudcomputer ${q(d.name, 40) || (d.provider ? `bij ${engineName(d.provider)}` : '')} ${s}`, { category: 'connections', tone: last === 'create_failed' || last === 'error' ? 'warn' : 'neutral' });
    }
    case 'provider':
      return you(tpl`{h} een AI-provider ${done()}`, { category: 'connections' });
    case 'folders':
      return you(tpl`{h} de teammap ${done()}`, { category: 'connections' });
    case 'channels': {
      const a = adapter(d.adapter);
      // Whole sentences with {h} (a template where a value is in it), so each language translates the sentence. The
      // parts used to be glued to {h} at run time and came out half translated in English (acceptance round 5, C-15:
      // You hebt een koppelcode voor een kanaal gemaakt; TeamBot heeft een nieuwe afzender via webhook connected).
      const v = ({
        owner_linked: tpl`{h} je account in ${a} gekoppeld aan ${x.bot}`, sender_paired: tpl`{h} een nieuwe afzender via ${a} gekoppeld`, pair_code_created: tpl`{h} een koppelcode voor ${a} gemaakt`, binding_updated: tpl`{h} de koppeling met ${a} aangepast`,
        connect: '{h} een kanaal verbonden', disconnect: '{h} een kanaal losgekoppeld', sender_added: '{h} een afzender toegevoegd', sender_updated: '{h} een afzender aangepast', sender_removed: '{h} een afzender verwijderd',
        conversation_paused: '{h} een kanaalgesprek gepauzeerd', conversation_resumed: '{h} een kanaalgesprek hervat', resend: '{h} een bericht opnieuw verstuurd', whatsapp_link: '{h} WhatsApp gekoppeld met een QR-code',
        whatsapp_pair_code: '{h} een koppelcode voor WhatsApp gemaakt', whatsapp_unlinked: '{h} WhatsApp losgekoppeld', send_rule_owner_on: tpl`{h} ${x.bot} toegestaan om jou zonder vragen berichten te sturen`,
        send_rule_owner_off: tpl`{h} ${x.bot} weer laten vragen voordat hij jou berichten stuurt`, send_rule_added: tpl`{h} een verzendregel voor ${x.bot} toegevoegd${d.target ? ` (naar ${clean(d.target, 50)})` : ''}`, send_rule_removed: tpl`{h} een verzendregel van ${x.bot} verwijderd`,
      } as Record<string, string | Tpl>)[last];
      const by: By = last === 'owner_linked' || last === 'sender_paired' ? 'system' : 'you';
      return { by, text: v || tpl`{h} een kanaal ${done()}`, category: 'connections', tone: last.includes('owner_on') ? 'warn' : 'neutral' };
    }
    case 'mcp': {
      const app = q(d.label || d.name || d.tokenName) || 'een app';
      if (rest[0] === 'server') {
        if (last === 'ask') return sys(tpl`{h} ${x.bot} een vraag doorgegeven van een extern programma${d.tokenName ? ` (${clean(d.tokenName, 40)})` : ''}`, { category: 'connections' });
        // Whole sentences per action, so each language translates the sentence, not a loose participle.
        const tv = ({ token_created: "{h} een toegangssleutel voor externe programma's aangemaakt", token_updated: "{h} een toegangssleutel voor externe programma's aangepast", token_revoked: "{h} een toegangssleutel voor externe programma's ingetrokken" } as Record<string, string>)[last] || `{h} een toegangssleutel voor externe programma's ${done()}`;
        return you(tpl`${tv}${d.name ? ` (${clean(d.name, 40)})` : ''}`, { category: 'access', tone: last === 'token_created' ? 'warn' : 'neutral' });
      }
      if (rest[0] === 'import') return you(last === 'applied' ? tpl`{h} ${num(d.created) ? plural(num(d.created), 'app', 'apps') : 'apps'} geïmporteerd uit andere programma's` : tpl`{h} gezocht naar apps in andere programma's`, { category: 'connections' });
      if (rest[0] === 'oauth') {
        const o = { category: 'connections' as AuditCategory };
        if (last === 'started') return you(tpl`{h} de aanmelding bij ${app} gestart`, o);
        if (last === 'connected') return you(tpl`{h} de aanmelding bij ${app} afgerond`, o);
        if (last === 'refreshed') return sys(tpl`{h} de aanmelding bij ${app} vernieuwd`, o);
        if (last === 'revoked') return you(tpl`{h} de aanmelding bij ${app} ingetrokken`, o);
        return you(tpl`{h} de aanmelding bij ${app} ${done()}`, o);
      }
      if (rest[0] === 'actions') return you(tpl`{h} de acties van ${app} ${done()}`, { category: 'connections' });
      if (rest[0] === 'tool') return you(last === 'approved' ? '{h} acties van een app goedgekeurd' : '{h} het risico van een actie van een app aangepast', { category: 'connections' });
      if (rest[0] === 'binding') return you('{h} ingesteld welke bots een app mogen gebruiken', { category: 'connections' });
      if (last === 'verified') return sys(tpl`{h} de app ${app} gecontroleerd${num(d.tools) ? ` (${plural(num(d.tools), 'actie', 'acties')})` : ''}`, { category: 'connections' });
      if (last === 'restart') return you(tpl`{h} een app opnieuw gestart${d.ok === false ? ' (mislukt)' : ''}`, { category: 'connections' });
      return you(tpl`{h} de app ${app} ${last === 'registry_updated' || last === 'package_updated' ? 'bijgewerkt' : done()}`, { category: 'connections' });
    }
    case 'skill': {
      const name = q(d.skill, 40) || 'een skill';
      if (last === 'loaded') return bot(tpl`{h} de skill ${name} gebruikt`);
      if (last === 'scripts_prepared') return bot(tpl`{h} de scripts van de skill ${name} klaargezet`);
      if (last === 'draft_created') return bot(tpl`{h} een concept voor de skill ${name} geschreven`);
      if (last === 'agents_changed') return you('{h} ingesteld welke bots een skill gebruiken', { category: 'connections' });
      if (last === 'rev_activated') return you(tpl`{h} een andere versie van de skill ${name} in gebruik genomen`, { category: 'connections' });
      if (last === 'status') return you(tpl`{h} de skill ${name} ${d.status === 'disabled' ? 'uitgezet' : 'aangezet'}`, { category: 'connections' });
      if (last === 'draft_discarded') return you(tpl`{h} het concept voor de skill ${name} weggegooid`, { category: 'connections' });
      if (last === 'team') return you(d.to === '*' ? tpl`{h} de skill ${name} voor alle teams gezet` : tpl`{h} de skill ${name} naar een ander team gezet`, { category: 'connections' });
      if (last === 'tests_saved') return you(tpl`{h} de testvragen van de skill ${name} bewaard`, { category: 'connections' });
      if (last === 'tests_started') return you(tpl`{h} de testvragen van de skill ${name} laten draaien`, { category: 'connections' });
      if (last === 'tests_finished') return sys(tpl`{h} de test van de skill ${name} afgerond${num(d.total) ? ` (${num(d.goed)} van ${num(d.total)} goed)` : ''}`, { category: 'connections' });
      if (last === 'made_from_document') return you(tpl`{h} de skill ${name} gemaakt van een document`, { category: 'connections' });
      return you(tpl`{h} de skill ${name} ${last === 'imported' ? 'geïnstalleerd' : done()}`, { category: 'connections', tone: last === 'trusted' ? 'warn' : 'neutral' });
    }
    case 'market':
    case 'catalog': {
      const v = ({ app_installed: '{h} een app uit de marktplaats geïnstalleerd', reported: '{h} iets in de marktplaats gemeld', report_resolved: '{h} een melding over de marktplaats afgehandeld', blocked: '{h} iets in de marktplaats geblokkeerd', unblocked: '{h} iets in de marktplaats weer toegestaan', shared: '{h} iets gedeeld in de marktplaats', unshared: '{h} iets uit de marktplaats gehaald', web_skill_staged: '{h} een skill van internet klaargezet om te bekijken', github_token_set: '{h} een GitHub-sleutel voor de marktplaats opgeslagen', github_token_removed: '{h} de GitHub-sleutel voor de marktplaats gewist', removed: '{h} een catalogus verwijderd' } as Record<string, string>)[last];
      const o = { category: (last.startsWith('github_token') ? 'access' : 'connections') as AuditCategory };
      if (last === 'added') return you(tpl`{h} een catalogus toegevoegd${d.url ? ` (${clean(String(d.url).replace(/^https?:\/\//, ''), 50)})` : ''}`, o);
      return you(v || tpl`{h} de marktplaats ${done()}`, o);
    }
    case 'template':
      return you(tpl`{h} een sjabloon ${done()}`, { category: 'connections' });
    case 'memory': {
      const v = ({ archive: '{h} een herinnering gearchiveerd', restore: '{h} een herinnering teruggezet', trash: '{h} een herinnering naar de prullenbak verplaatst', pin: '{h} een herinnering vastgezet', unpin: '{h} een herinnering losgemaakt', confirm: '{h} een herinnering bevestigd als nog juist', share: '{h} een herinnering gedeeld', move: '{h} een herinnering verplaatst', update: '{h} een herinnering bewerkt' } as Record<string, string>)[last];
      if (v) return you(v, { category: 'memory' });
      if (last === 'dossier_shared' || last === 'dossier_unshared') return you(tpl`{h} een dossier ${last === 'dossier_shared' ? 'gedeeld' : 'niet meer gedeeld'}`, { category: 'memory' });
      if (last === 'block_lifted') return you('{h} een blokkade op vergeten informatie opgeheven', { category: 'memory', tone: 'warn' });
      if (last === 'assistant_imported') return you(tpl`{h} geheugen uit een andere assistent overgenomen${num(d.proposed) ? ` (${plural(num(d.proposed), 'voorstel', 'voorstellen')})` : ''}`, { category: 'memory' });
      if (last === 'import_undone') return you(tpl`{h} een geheugenimport ongedaan gemaakt${num(d.removed) ? ` (${plural(num(d.removed), 'herinnering', 'herinneringen')} weg)` : ''}`, { category: 'memory', tone: 'warn' });
      if (last === 'settings' || last === 'admin_limits') return you(tpl`{h} de ${last === 'settings' ? 'geheugeninstellingen' : 'geheugenlimieten voor leden'} gewijzigd`, { category: 'memory' });
      return you(tpl`{h} het geheugen ${done()}`, { category: 'memory' });
    }
    case 'routine':
    case 'routines': {
      if (p === 'routines') return you('{h} de algemene instellingen voor routines gewijzigd', { category: 'routines' });
      if (rest[0] === 'trigger') return you(tpl`{h} een trigger van een routine ${done()}${paren(({ webhook: 'webhook', schedule: 'schema', feed: 'feed', folder: 'map', email: 'e-mail', page: 'pagina', chain: 'keten' } as Record<string, string>)[String(d.kind)] || '')}`, { category: 'routines' });
      return you(tpl`{h} een routine ${done()}`, { category: 'routines' });
    }
    case 'team':
      return bot(tpl`{h} een andere bot iets gevraagd`, { actor: clean(d.from, 40) || x.bot });
    case 'room': {
      const v = ({ updated: '{h} de instellingen van een groep aangepast', invite: '{h} iemand uitgenodigd voor een groep', person_role: '{h} de rol van iemand in een groep aangepast', left: '{h} een groep verlaten', revoke: '{h} iemand uit een groep gehaald', person_added: '{h} iemand aan een groep toegevoegd' } as Record<string, string>)[last];
      return you(v || tpl`{h} een groep ${done()}`);
    }
    case 'teamdata':
      return you('{h} de teamdatabase gewijzigd', { category: 'data' });
    case 'rehearsal':
      return (last === 'started' ? bot : you)(({ started: '{h} een oefenkopie van de werkmap gemaakt', applied: '{h} de geoefende wijzigingen overgenomen in de werkmap', reverted: '{h} de geoefende wijzigingen teruggedraaid', discarded: '{h} de oefenkopie weggegooid' } as Record<string, string>)[last] || '{h} een oefenkopie gewijzigd');
    case 'snapshot':
      return (d.auto || last === 'created' ? bot : you)(
        last === 'created' ? tpl`{h} een herstelpunt van de werkmap gemaakt${d.label ? ` (${clean(d.label, 40)})` : ''}` : ({ restored: '{h} de werkmap teruggezet naar een herstelpunt', deleted: '{h} een herstelpunt verwijderd' } as Record<string, string>)[last] || '{h} een herstelpunt gewijzigd',
        { category: 'data', tone: last === 'restored' ? 'warn' : 'neutral' },
      );
    case 'backup':
      return you(tpl`{h} een back-up ${done()}`, { category: 'data' });
    case 'openbot':
      return you('{h} gegevens uit OpenBot geïmporteerd', { category: 'data' });
    case 'usage': {
      const title = clean(d.title, 100);
      return sys(last === 'limit_limit' ? tpl`{h} gemeld dat een gebruikslimiet bereikt is${colon(title)}` : tpl`{h} gemeld dat een gebruikslimiet bijna bereikt is${colon(title)}`, { category: 'data', tone: 'warn' });
    }
    case 'voice': {
      const o = { category: (last === 'started' || last === 'ended' ? 'bots' : 'data') as AuditCategory };
      const mins = last === 'ended' && num(d.durationSec) ? ` (${Math.max(1, Math.round(num(d.durationSec) / 60))} min)` : '';
      const named = x.bot !== 'een bot';
      if (last === 'started') return you(named ? tpl`{h} een spraakgesprek met ${x.bot} gestart` : '{h} een spraakgesprek gestart', o);
      if (last === 'ended') return you(named ? tpl`{h} een spraakgesprek met ${x.bot} beëindigd${mins}` : tpl`{h} een spraakgesprek beëindigd${mins}`, o);
      const v = ({ deleted: '{h} een spraakgesprek verwijderd', installed: '{h} lokale spraakmodellen geïnstalleerd', removed: '{h} een lokaal spraakmodel verwijderd', updated: '{h} de spraakinstellingen gewijzigd', audio_deleted: '{h} de opname van een spraakbericht verwijderd', cleared: '{h} de voorleescache leeggemaakt' } as Record<string, string>)[last];
      return you(v || '{h} iets gewijzigd aan spraak', o);
    }
  }
  return null;
}

/** Category by kind prefix, unless the sentence chose one. */
function categoryOf(kind: string): AuditCategory {
  const p = kind.split('.')[0];
  if (/^(approval|policy|autoreview)$/.test(p) || kind === 'cli.permission' || kind === 'cli.unapproved_action') return 'approvals';
  if (/^(secret|security|sso|scim|mobile|vault|admin|publishers|package)$/.test(p) || kind === 'agent.full_access') return 'access';
  if (/^(mcp|channels|provider|cloudvm|folders|skill|market|catalog|template)$/.test(p)) return 'connections';
  if (p === 'memory') return 'memory';
  if (p === 'routine' || p === 'routines') return 'routines';
  if (/^(backup|openbot|teamdata|usage|snapshot)$/.test(p)) return 'data';
  return 'bots';
}

const cap = (s: string) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** The sentence for one log row. Never throws; an unknown kind still gets a plain sentence (marked `generic`). */
export function describeAudit(row: AuditRow, ctx: AuditContext = {}): AuditEntry {
  const d = row.data && typeof row.data === 'object' ? row.data : {};
  const name = clean(row.agent_name, 40) || (row.agent_id ? clean(ctx.agentName?.(row.agent_id), 40) : '') || (row.kind.startsWith('agent.') ? clean(d.name, 40) : '');
  const x: X = { bot: name || 'een bot', me: (id) => !!id && !!ctx.meId && id === ctx.meId };
  let spec: Spec | null = null;
  let generic = false;
  try {
    spec = EXACT[row.kind]?.(d, x) || family(row.kind, d, x);
  } catch {
    spec = null;
  }
  if (!spec) {
    generic = true;
    spec = row.agent_id ? bot('{h} iets gedaan') : you('{h} een instelling gewijzigd');
  }
  const actorKind: AuditEntry['actorKind'] = spec.by;
  const dutchActor = cap(spec.actor || (actorKind === 'you' ? 'Jij' : actorKind === 'system' ? 'TeamBot' : x.bot));
  const isYou = dutchActor === 'Jij';
  // "Jij" and "Een bot" in the interface language; a bot's name stays as it is.
  const actor = spec.actor || actorKind === 'bot' ? (name ? dutchActor : cap(tFragment(dutchActor))) : tText(dutchActor);
  const hb = (s: string) => s.replace(/\{h\}/g, isYou ? 'hebt' : 'heeft').replace(/\{is\}/g, isYou ? 'bent' : 'is');
  const T = typeof spec.text === 'string' ? { tpl: spec.text, values: [] as string[] } : spec.text;
  // In the interface language: the template as one text ("hebt de routine {0} gemaakt{1}"), every value as a fragment
  // of it (a name stays, " (na een herstart)" or " voor 3 bots" is translated). In Dutch the same sentence as before.
  const text = tText(hb(T.tpl), ...T.values.map((v) => tFragment(hb(v))))
    .replace(/\s+([,.:;)])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
  return {
    actor,
    actorKind,
    text,
    sentence: `${actor} ${text}`.replace(/[.\s]*$/, '') + '.',
    approval: spec.approval,
    category: spec.category || categoryOf(row.kind),
    tone: spec.tone || 'neutral',
    generic: generic || undefined,
  };
}

/** A tool's own detail row and the tool call it belongs to (the tool call carries who approved it). */
const DETAIL_OF: Record<string, string[]> = {
  'file.write': ['write_file'],
  'file.edit': ['edit_file'],
  'file.delete': ['delete_file'],
  'shell.run': ['run_command'],
};

/**
 * One action, one line: a bot's `file.write` (or edit/delete/command) right next to the `tool.call` it came from
 * is the same action twice; keep the tool call (which says who approved it) and drop the detail row.
 */
export function collapseDuplicates<T extends AuditRow>(rows: T[]): T[] {
  return rows.filter((r, i) => {
    const tools = DETAIL_OF[r.kind];
    if (!tools || !r.agent_id) return true;
    const at = Date.parse(r.created_at);
    const key = r.kind === 'shell.run' ? String(r.data?.command || '').slice(0, 40) : String(r.data?.path || '').split(/[\\/]/).pop() || '';
    for (const j of [i - 1, i + 1, i - 2, i + 2]) {
      const o = rows[j];
      if (!o || o.kind !== 'tool.call' || o.agent_id !== r.agent_id || !tools.includes(String(o.data?.tool))) continue;
      if (Math.abs(Date.parse(o.created_at) - at) > 10_000) continue;
      if (!key || String(o.data?.summary || '').includes(key)) return false;
    }
    return true;
  });
}
