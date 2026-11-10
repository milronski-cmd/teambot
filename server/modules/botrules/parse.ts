/**
 * Own rules in plain words (package P6): one sentence of the owner ("Mail nooit naar klanten zonder mij te vragen",
 * "Mag altijd bestanden maken in de map Offertes") becomes a fixed rule the Broker checks in code: an effect (never,
 * ask first, may always) and what it is about (an action, an app, a folder, a website, a tool, and whether it is only
 * about others than the owner). What cannot be pinned down in code becomes a "review" rule: Auto Review reads it before
 * every action that changes something and asks the owner when the action goes against it or when it is unsure.
 * Deterministic on purpose: the same sentence always gives the same rule, and the screen shows what TeamBot made of it.
 */

export type RuleEffect = 'deny' | 'ask' | 'allow';
export type RuleVerb = 'any' | 'read' | 'change' | 'delete' | 'run' | 'send' | 'publish' | 'pay';

export interface RuleMatch {
  verb: RuleVerb;
  /** An app group id from APPS, or `mcp:<slug>` for one of the owner's own apps (MCP servers). */
  app?: string;
  /** A folder name or path below a working folder ("Offertes", "Klanten/2026"), matched on whole path segments. */
  folder?: string;
  /** A website ("example.com"); its subdomains count too. */
  domain?: string;
  /** An exact TeamBot tool name ("run_command"). */
  tool?: string;
  /** Only when it goes to or is about someone other than the owner (klanten, anderen). */
  others?: boolean;
}

export interface ParsedRule {
  effect: RuleEffect;
  match: RuleMatch;
  /** Not pinned down in code: Auto Review checks actions against the owner's words. */
  review: boolean;
}

export interface ParseError {
  error: string;
  code: 'empty' | 'effect' | 'allow_target' | 'allow_verb' | 'too_long';
}

interface AppGroup {
  /** Words in the owner's sentence. */
  words: string[];
  /** Tool names of this app (TeamBot tools, MCP tools `mcp_<server>_…`, CLI tools `ns:mcp__<server>__…`). */
  tool: RegExp;
  /** Chat channels of this kind (channel_send's binding adapter). */
  channels?: string[];
  /** Name on screen (not translated: a product name or a plain word). */
  label: string;
}

/** Apps the owner names in a rule. Product names stay as they are; "webshop" covers the common shop systems. */
export const APPS: Record<string, AppGroup> = {
  mail: { label: 'e-mail', words: ['mail', 'mails', 'e-mail', 'e-mails', 'email', 'emails', 'mailen', 'mailt', 'mailtje', 'gmail', 'outlook'], tool: /mail|gmail|outlook|smtp|imap/i, channels: ['email'] },
  whatsapp: { label: 'WhatsApp', words: ['whatsapp', 'appen', 'appje'], tool: /whatsapp/i, channels: ['whatsapp', 'whatsapp-web'] },
  telegram: { label: 'Telegram', words: ['telegram'], tool: /telegram/i, channels: ['telegram'] },
  slack: { label: 'Slack', words: ['slack'], tool: /slack/i, channels: ['slack'] },
  discord: { label: 'Discord', words: ['discord'], tool: /discord/i, channels: ['discord'] },
  webshop: { label: 'webshop', words: ['webshop', 'webwinkel', 'webshops', 'webwinkels', 'shop', 'winkel', 'online shop', 'store'], tool: /shopify|woocommerce|magento|lightspeed|prestashop|bigcommerce|wix|shop/i },
  shopify: { label: 'Shopify', words: ['shopify'], tool: /shopify/i },
  woocommerce: { label: 'WooCommerce', words: ['woocommerce'], tool: /woocommerce/i },
  github: { label: 'GitHub', words: ['github'], tool: /github/i },
  gitlab: { label: 'GitLab', words: ['gitlab'], tool: /gitlab/i },
  notion: { label: 'Notion', words: ['notion'], tool: /notion/i },
  drive: { label: 'Google Drive', words: ['google drive', 'drive'], tool: /gdrive|google_?drive|drive/i },
  calendar: { label: 'agenda', words: ['agenda', 'kalender', 'calendar', 'google agenda', 'google calendar'], tool: /calendar|agenda/i },
  stripe: { label: 'Stripe', words: ['stripe'], tool: /stripe/i },
  mollie: { label: 'Mollie', words: ['mollie'], tool: /mollie/i },
  paypal: { label: 'PayPal', words: ['paypal'], tool: /paypal/i },
  wordpress: { label: 'WordPress', words: ['wordpress'], tool: /wordpress|wp_/i },
  linkedin: { label: 'LinkedIn', words: ['linkedin'], tool: /linkedin/i },
  instagram: { label: 'Instagram', words: ['instagram'], tool: /instagram/i },
  facebook: { label: 'Facebook', words: ['facebook'], tool: /facebook/i },
  twitter: { label: 'X (Twitter)', words: ['twitter', 'tweet', 'tweeten'], tool: /twitter|tweet/i },
  hubspot: { label: 'HubSpot', words: ['hubspot'], tool: /hubspot/i },
  trello: { label: 'Trello', words: ['trello'], tool: /trello/i },
  jira: { label: 'Jira', words: ['jira'], tool: /jira/i },
  dropbox: { label: 'Dropbox', words: ['dropbox'], tool: /dropbox/i },
  onedrive: { label: 'OneDrive', words: ['onedrive'], tool: /onedrive/i },
  exact: { label: 'Exact Online', words: ['exact online', 'exact'], tool: /exact/i },
  moneybird: { label: 'Moneybird', words: ['moneybird'], tool: /moneybird/i },
};

/** A website in the sentence: "example.com", "www.shop.nl" (a file name like "offerte.pdf" is not one). */
const FILE_EXT = /\.(pdf|docx?|xlsx?|pptx?|csv|txt|md|json|png|jpe?g|gif|svg|zip|html?|js|ts|py|mp3|mp4|wav|odt|epub)$/i;

const MAX_TEXT = 300;

const norm = (s: string) =>
  ' ' +
  s
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/\s+/g, ' ')
    .trim() +
  ' ';

const has = (t: string, re: RegExp) => re.test(t);

// "zonder (het) (eerst) (aan) mij te vragen", "zonder toestemming", "without asking (me)", "without my approval"
const WITHOUT_ASKING =
  /\bzonder\s+(?:het\s+|dat\s+)?(?:eerst\s+)?(?:aan\s+)?(?:mij|me|ons|jou)?\s*(?:eerst\s+)?(?:te\s+)?(?:vragen|overleggen|melden|checken)\b|\bzonder\s+(?:mijn\s+|ons\s+|jouw\s+)?(?:toestemming|akkoord|goedkeuring|overleg|ok[eé]?)\b|\bwithout\s+(?:first\s+)?(?:asking|checking|my\s+(?:permission|approval|ok|okay|consent)|permission|approval|consent)\b/;
const NEGATION = /\b(?:nooit|niet|geen|niks|niets|never|not|don't|dont|do not|no)\b/;
const MAY_FREELY =
  /\b(?:mag|mogen|may|can|is allowed to|are allowed to)\b[^.]*\b(?:altijd|always|zonder\s+(?:te\s+)?vragen|without\s+asking|vrij|freely)\b|\bhoeft\s+(?:niet|nooit)\s+(?:eerst\s+)?te\s+vragen\b|\b(?:never|doesn't|does not|don't|do not)\s+(?:need|have)\s+to\s+ask\b|\b(?:altijd|always)\s+(?:toegestaan|allowed|ok[eé]?)\b/;
const ASK = /\b(?:vraag|vragen|vraagt|vraagje|toestemming|akkoord|overleg|overleggen|goedkeuring|ask|check with|checks with|permission|approval|confirm)\b/;
// The "may" sentence without asking ("mag … zonder te vragen") is free; "hoeft niet te vragen" is too, despite "niet".
const FREE_NEGATIONS = /\bhoeft\s+(?:niet|nooit)\s+(?:eerst\s+)?te\s+vragen\b|\b(?:never|doesn't|does not|don't|do not)\s+(?:need|have)\s+to\s+ask\b/;

const VERBS: [RuleVerb, RegExp][] = [
  ['pay', /\b(?:betaal|betalen|betaalt|betaling|betalingen|koop|kopen|koopt|bestel|bestellen|bestelt|aankoop|aankopen|afrekenen|pay|pays|paying|payment|payments|buy|buys|buying|purchase|purchases|checkout)\b/],
  ['publish', /\b(?:publiceer|publiceren|publiceert|online\s+zetten|zet\s+\S+\s+online|posten|post|plaats|plaatsen|publish|publishes|deploy|deployen|tweet|tweeten)\b/],
  ['send', /\b(?:mail|mails|mailen|mailt|e-?mail|e-?mailen|e-?mails|stuur|sturen|stuurt|versturen|verstuur|verstuurt|verzenden|verzend|verzendt|bericht|berichten|appen|reageer|reageren|beantwoord|beantwoorden|antwoord|send|sends|sending|message|messages|reply|replies|email|emails)\b/],
  ['delete', /\b(?:verwijder|verwijderen|verwijdert|wis|wissen|wist|weggooien|gooi\s+\S+\s+weg|delete|deletes|deleting|remove|removes|erase)\b/],
  ['run', /\b(?:opdracht|opdrachten|commando|commando's|terminal|script|scripts|uitvoeren|voer\s+\S+\s+uit|run|runs|execute|executes|command|commands|shell)\b/],
  [
    'change',
    /\b(?:verander|veranderen|verandert|wijzig|wijzigen|wijzigt|aanpassen|pas\s+[^.]*\baan|bewerk|bewerken|bewerkt|schrijf|schrijven|schrijft|maak|maken|maakt|aanmaken|opslaan|sla\s+[^.]*\bop|bewaar|bewaren|zet|zetten|neerzetten|change|changes|edit|edits|modify|modifies|update|updates|write|writes|create|creates|make|makes|save|saves|alter|touch)\b/,
  ],
  ['read', /\b(?:lees|lezen|leest|bekijk|bekijken|bekijkt|kijk|kijken|open|openen|opent|read|reads|view|views|look|looks|browse|bezoek|bezoeken)\b/],
];

const OTHERS =
  /\b(?:klant|klanten|klantje|anderen|ander|iemand\s+anders|derden|externe?|leveranciers?|relaties?|collega'?s|mensen|contacten|customers?|clients?|others|other\s+people|anyone\s+else|someone\s+else|third\s+parties|suppliers?|people|contacts)\b/;

/** Folder: "in de map Offertes", "map 'Klanten 2026'", "in the Quotes folder", "folder Invoices". */
function folderOf(raw: string): string | undefined {
  const s = raw.replace(/[’‘`]/g, "'").replace(/[“”]/g, '"');
  const quoted = s.match(/\b(?:map|folder|directory|submap)\s+["']([^"']{1,80})["']/i) || s.match(/["']([^"']{1,80})["']\s+(?:map|folder|directory)\b/i);
  const named =
    quoted ||
    // Without quotes a folder is one word or path ("Offertes", "Klanten/2026"), optionally with a number ("Klanten 2026").
    s.match(/\b(?:map|folder|directory|submap)\s+(?:met\s+de\s+naam\s+|called\s+|named\s+)?([\p{L}\d_][\p{L}\d_/\\-]{0,79}?(?:\.[\p{L}\d_-]+)*(?:\s+\d{1,6})?)(?=[\s,;:!?)]|\.(?:\s|$)|$)/iu) ||
    s.match(/\b(?:the|de|het)\s+([\p{L}\d_][\p{L}\d_-]{0,40})\s+(?:map|folder|directory)\b/iu);
  const v = named?.[1]?.trim().replace(/^(?:de|het|the)\s+/i, '').replace(/[\\/]+$/, '');
  if (!v || /^(?:de|het|the|een|a|deze|die|this|that)$/i.test(v)) return undefined;
  return v.slice(0, 80);
}

function domainOf(t: string): string | undefined {
  for (const m of t.matchAll(/(?<![@\w.-])((?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24})(?![\w-])/g)) {
    const d = m[1].replace(/^www\./, '');
    if (FILE_EXT.test(d) || /^\d+(?:\.\d+)+$/.test(d)) continue;
    if (!/\.[a-z]{2,24}$/.test(d)) continue;
    return d;
  }
  return undefined;
}

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const word = (w: string) => new RegExp(`(?<![\\p{L}\\d_-])${escape(w.toLowerCase())}(?![\\p{L}\\d_-])`, 'u');

/** Apps named in the sentence: the owner's own apps (MCP servers) first, then the known ones (longest word wins). */
function appOf(t: string, own: { slug: string; name: string }[]): string | undefined {
  for (const a of own) {
    const words = [a.name, a.slug, a.slug.replace(/[_-]+/g, ' ')].map((w) => w.trim().toLowerCase()).filter((w) => w.length >= 3);
    if (words.some((w) => word(w).test(t))) return `mcp:${a.slug}`;
  }
  let best: { id: string; len: number } | null = null;
  for (const [id, g] of Object.entries(APPS)) for (const w of g.words) if (word(w).test(t) && (!best || w.length > best.len)) best = { id, len: w.length };
  return best?.id;
}

export interface ParseOptions {
  /** The owner's own apps (MCP servers) by slug and name. */
  apps?: { slug: string; name: string }[];
  /** Tool names that exist (an exact name in the sentence becomes a tool rule). */
  tools?: string[];
}

export function parseRule(text: string, o: ParseOptions = {}): ParsedRule | ParseError {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (!raw) return { error: 'Schrijf een regel in gewone woorden, bijvoorbeeld: Mail nooit naar klanten zonder mij te vragen.', code: 'empty' };
  if (raw.length > MAX_TEXT) return { error: `Houd een regel kort: hoogstens ${MAX_TEXT} tekens. Schrijf meerdere regels als het meer is.`, code: 'too_long' };
  const t = norm(raw);

  let effect: RuleEffect | null = null;
  // "hoeft niet te vragen" is no "not": it frees.
  const negated = has(t.replace(FREE_NEGATIONS, ' '), NEGATION);
  if (has(t, WITHOUT_ASKING) && negated) effect = 'ask';
  else if (has(t, MAY_FREELY) && !negated) effect = 'allow';
  else if (has(t, ASK)) effect = 'ask';
  else if (negated) effect = 'deny';
  if (!effect) return { error: 'Ik zie niet wat de bot moet doen: iets nooit doen, eerst vragen, of het altijd mogen. Gebruik bijvoorbeeld “nooit”, “vraag eerst” of “mag altijd”.', code: 'effect' };

  const match: RuleMatch = { verb: 'any' };
  const toolName = (o.tools || []).find((n) => n.length >= 4 && word(n).test(t));
  if (toolName) match.tool = toolName;
  const folder = folderOf(raw);
  if (folder) match.folder = folder;
  const domain = folder ? undefined : domainOf(t);
  if (domain) match.domain = domain;
  // The folder's or website's own name says nothing about the app, the action or who it is for ("de map Klanten").
  const rest = norm([folder, domain].reduce((x: string, n) => (n ? x.split(n.toLowerCase()).join(' ') : x), t));
  const app = appOf(rest, o.apps || []);
  if (app) match.app = app;
  // The verb, without the words that only say how to decide ("vraag", "zonder te vragen") or name the app.
  const verbText = rest.replace(WITHOUT_ASKING, ' ').replace(/\b(?:vraag|vragen|vraagt)\b/g, ' ');
  for (const [v, re] of VERBS) if (re.test(verbText)) {
    match.verb = v;
    break;
  }
  // "Mail …" is sending by e-mail.
  if (match.app === 'mail' && match.verb === 'any') match.verb = 'send';
  if (has(rest, OTHERS)) match.others = true;

  const target = !!(match.tool || match.app || match.folder || match.domain);
  const review = !target && match.verb === 'any';

  if (effect === 'allow') {
    if (review || !target)
      return {
        error: 'Een regel die iets altijd toestaat, moet zeggen waar het mag: in een map, op een website, in een app of met één tool. Wil je dat de bot alles zonder vragen doet, kies dan bij Wat mag de bot? een ander niveau.',
        code: 'allow_target',
      };
    if (match.verb === 'send' || match.verb === 'publish' || match.verb === 'pay' || match.verb === 'delete')
      return { error: 'Versturen, publiceren, betalen en verwijderen kan een regel niet vrijgeven: daarvoor vraagt de bot het je altijd.', code: 'allow_verb' };
    // "Mag altijd … naar klanten" never loosens anything for others.
    if (match.others) return { error: 'Iets voor anderen (zoals klanten) kan een regel niet vrijgeven: daarvoor vraagt de bot het je altijd.', code: 'allow_verb' };
  }
  return { effect, match, review };
}

export const isParseError = (r: ParsedRule | ParseError): r is ParseError => 'error' in r;
