/**
 * Computer use on the owner's own Windows desktop ("Mijn bureaublad"): pure decision logic, no I/O, so every rule can
 * be unit-tested without a desktop. The PowerShell driver (screen.ps1.ts) enforces the same allow/block rules again
 * right before it sends any input; this module decides what the bot may see, which actions need a human and how
 * screenshot coordinates map to real screen pixels.
 */

// ---------------- access levels ----------------

/**
 * How much the bot may do on its own within the allowed apps.
 * - every: every click/keystroke asks first (with a preview of the screen and the target marked)
 * - task:  one approval per task (goal, apps, time limit); inside that scope the bot works on its own
 * - auto:  "Volledige toegang": on its own within the allowed scope (like OpenBot's "Full access"), no per-action asks
 * Whatever the level: blocked apps/pages, password fields and credential prompts are never touched, and actions
 * with an external side effect (send, pay, delete, publish) always ask explicitly.
 */
export type HostLevel = 'every' | 'task' | 'auto';
export const HOST_LEVELS: HostLevel[] = ['every', 'task', 'auto'];

export const LEVEL_LABEL: Record<HostLevel, string> = {
  every: 'Vraag bij elke actie',
  task: 'Vraag één keer per taak',
  auto: 'Volledige toegang (zelfstandig)',
};

export function cleanLevel(v: unknown): HostLevel {
  return HOST_LEVELS.includes(v as HostLevel) ? (v as HostLevel) : 'every';
}

/** Per-bot options for computer use on the desktop (stored as JSON in computer_configs.host_options). */
export interface HostOptions {
  /** What the bot sees: only the allowed apps (everything else blacked out) or the whole screen (minus blocked windows). */
  screen: 'apps' | 'full';
  /** Pause the bot as soon as the owner moves the mouse while the bot is working. */
  pauseOnInput: boolean;
  /** Default and maximum length of a task approval (level "task"), minutes. */
  taskMinutes: number;
  /** Extra words that block a window when they appear in its title (on top of the built-in list). */
  blockWords: string[];
  /** Safety valve against runaway loops: mutating actions per minute. */
  maxPerMinute: number;
  /** Monitor the bot works on (0 = primary). */
  monitor: number;
  /** Scope "all apps except the always-blocked ones" instead of an allowlist (owner, explicit confirmation). */
  allApps: boolean;
}

export const DEFAULT_HOST_OPTIONS: HostOptions = { screen: 'apps', pauseOnInput: true, taskMinutes: 30, blockWords: [], maxPerMinute: 60, monitor: 0, allApps: false };

export function cleanHostOptions(v: any, cur: HostOptions = DEFAULT_HOST_OPTIONS): HostOptions {
  const o = v && typeof v === 'object' ? v : {};
  const num = (x: any, min: number, max: number, def: number) => (Number.isFinite(Number(x)) && x !== null && x !== '' ? Math.min(max, Math.max(min, Math.round(Number(x)))) : def);
  return {
    screen: o.screen === 'full' ? 'full' : o.screen === 'apps' ? 'apps' : cur.screen,
    pauseOnInput: o.pauseOnInput === undefined ? cur.pauseOnInput : !!o.pauseOnInput,
    taskMinutes: num(o.taskMinutes, 5, 240, cur.taskMinutes),
    blockWords: Array.isArray(o.blockWords)
      ? [...new Set(o.blockWords.map((w: any) => String(w || '').trim().toLowerCase().replace(/\s+/g, ' ').slice(0, 40)).filter((w: string) => w.length >= 3))].slice(0, 50) as string[]
      : cur.blockWords,
    maxPerMinute: num(o.maxPerMinute, 5, 240, cur.maxPerMinute),
    monitor: num(o.monitor, 0, 8, cur.monitor),
    allApps: o.allApps === undefined ? cur.allApps : !!o.allApps,
  };
}

// ---------------- always blocked ----------------

/** Processes a bot may never see or touch, whatever the allowlist says. */
export const ALWAYS_BLOCKED_APPS = [
  // TeamBot itself (approvals, settings, the emergency stop) and Windows security surfaces
  'teambot',
  'electron',
  'consent',
  'credentialuibroker',
  'lockapp',
  'logonui',
  'useraccountcontrolsettings',
  'securityhealthsystray',
  'securityhealthhost',
  'windowsdefender',
  'msmpeng',
  'userpromptservice',
  // password managers and authenticators
  '1password',
  'bitwarden',
  'keepass',
  'keepassxc',
  'lastpass',
  'dashlane',
  'keeper',
  'keeperpasswordmanager',
  'enpass',
  'roboform',
  'nordpass',
  'protonpass',
  'proton pass',
  'passwordsafe',
  'pwsafe',
  'authy',
  'authy desktop',
  'winauth',
  'yubico authenticator',
  'yubioath-desktop',
  'bitwarden-desktop',
  // crypto wallets
  'ledger live',
  'exodus',
  'electrum',
];

/** Window titles that block a window (banking, payments, password managers, credential prompts, crypto). */
export const BLOCKED_TITLE_WORDS = [
  // banking (NL/BE + common international)
  'internetbankieren',
  'mobiel bankieren',
  'online banking',
  'online bankieren',
  'mijn ing',
  'ing bankieren',
  'rabobank',
  'rabo internetbankieren',
  'abn amro',
  'sns bank',
  'asn bank',
  'regiobank',
  'triodos',
  'bunq',
  'knab',
  'revolut',
  'kbc',
  'belfius',
  'bnp paribas',
  'argenta',
  'n26',
  'wise.com',
  'chase.com',
  'bank of america',
  'wells fargo',
  'hsbc',
  'barclays',
  'deutsche bank',
  'commerzbank',
  'sparkasse',
  // payments / checkout
  'paypal',
  'kies uw bank',
  'kies je bank',
  'ideal betaling',
  'ideal betalen',
  'betalen met ideal',
  'klarna',
  'stripe checkout',
  'afrekenen',
  'checkout',
  'betaalpagina',
  'betaling voltooien',
  'betaalverzoek',
  'tikkie',
  'payconiq',
  'adyen',
  'mollie',
  '3d secure',
  '3-d secure',
  'visa secure',
  'mastercard identity check',
  'creditcardgegevens',
  'card details',
  // password managers / credentials
  '1password',
  'bitwarden',
  'keepass',
  'lastpass',
  'dashlane',
  'nordpass',
  'proton pass',
  'wachtwoordbeheer',
  'password manager',
  'windows-beveiliging',
  'windows security',
  'gebruikersaccountbeheer',
  'user account control',
  'referentiebeheer',
  'credential manager',
  // crypto
  'coinbase',
  'binance',
  'bitvavo',
  'kraken',
  'metamask',
  'ledger live',
  'trezor',
];

export interface WinLike {
  process: string;
  title: string;
}

export function normApp(s: string): string {
  return String(s || '')
    .trim()
    .toLowerCase()
    .replace(/\.exe$/, '')
    .replace(/[^a-z0-9_.\- ]/g, '')
    .slice(0, 60);
}

const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Title pattern (also sent to the driver; .NET and JS agree on this simple form). Word boundaries are expressed with
 * explicit character classes so "paypal" matches "PayPal: Inloggen" but not "paypalfan".
 */
export function blockedTitlePattern(extra: string[] = []): string {
  const words = [...new Set([...BLOCKED_TITLE_WORDS, ...extra.map((w) => w.toLowerCase())])].filter(Boolean);
  return `(^|[^a-z0-9])(${words.map(esc).join('|')})($|[^a-z0-9])`;
}

/** Why a window may never be touched or seen (null = not blocked). */
export function blockedReason(w: WinLike, extraWords: string[] = []): string | null {
  const p = normApp(w.process);
  if (ALWAYS_BLOCKED_APPS.includes(p)) return p === 'teambot' || p === 'electron' ? 'TeamBot zelf' : `beveiligd programma (${p})`;
  const title = String(w.title || '').toLowerCase();
  if (/teambot/.test(title)) return 'TeamBot zelf';
  const m = title.match(new RegExp(blockedTitlePattern(extraWords), 'i'));
  if (m) return `gevoelige pagina of app ("${m[2]}")`;
  return null;
}

/** May the bot act in this window? (allowlisted - or scope "all apps" - and never blocked) */
export function appAllowed(w: WinLike, allow: string[], o: Pick<HostOptions, 'blockWords'> & { allApps?: boolean } = { blockWords: [] }): boolean {
  if (blockedReason(w, o.blockWords)) return false;
  return !!o.allApps || allow.includes(normApp(w.process));
}

/** May the bot see this window? Allowed apps, or with screen "full" everything that is not blocked. */
export function appVisible(w: WinLike, allow: string[], o: Pick<HostOptions, 'screen' | 'blockWords'> & { allApps?: boolean }): boolean {
  if (blockedReason(w, o.blockWords)) return false;
  return o.screen === 'full' || !!o.allApps || allow.includes(normApp(w.process));
}

/** What the driver needs to mask and verify by itself (it re-checks right before every input). */
export interface DriverPolicy {
  allow: string[];
  full: boolean;
  /** every app that is not blocked may receive input (scope "all apps") */
  all: boolean;
  block: string[];
  blockTitle: string;
}

export function driverPolicy(allow: string[], o: Pick<HostOptions, 'screen' | 'blockWords'> & { allApps?: boolean }): DriverPolicy {
  return { allow: allow.map(normApp), full: o.screen === 'full' || !!o.allApps, all: !!o.allApps, block: ALWAYS_BLOCKED_APPS, blockTitle: blockedTitlePattern(o.blockWords) };
}

// ---------------- external side effects ----------------

/** Words that indicate an irreversible / external side effect (NL + EN). Kept in line with policy.ts DANGER_WORDS. */
/** The part of SIDE_EFFECT_RE that pays or sends something to someone else: what still asks on "Volledige toegang". */
export const PAY_SEND_RE =
  /(^|[^a-z])(koop|kopen|bestel|bestellen|betaal|betalen|afrekenen|checkout|pay|pay now|buy|buy now|purchase|order now|place order|verstuur|versturen|verzend|verzenden|send|transfer|overmaken|overboeken|doneer|donate|subscribe|abonneer)($|[^a-z])/i;

export const SIDE_EFFECT_RE =
  /(^|[^a-z])(koop|kopen|bestel|bestellen|betaal|betalen|afrekenen|checkout|pay|pay now|buy|buy now|purchase|order now|place order|verstuur|versturen|verzend|verzenden|send|submit|post|plaats|plaatsen|publiceer|publiceren|publish|tweet|share|delen|delete|verwijder|verwijderen|remove|wissen|prullenbak|empty trash|bevestig|bevestigen|confirm|transfer|overmaken|overboeken|doneer|donate|subscribe|abonneer|sign up|registreer|onderteken|ondertekenen|merge|deploy|install|installeer|uninstall|formatteren|reset|opzeggen|cancel subscription)($|[^a-z])/i;

const SIDE_EFFECT_ALL = SIDE_EFFECT_RE;

/** Confirm-type buttons that inherit the risk of their dialog ("Ja" in "Bestand verwijderen?"). */
const CONFIRM_RE = /^(ja|yes|ok|oké|doorgaan|continue|akkoord|agree|bevestig|confirm|allow|toestaan|uitvoeren|run|go)$/i;

/** Apps where Enter (or a newline) in the message box sends a message to someone else. */
export const MESSAGING_APPS = ['whatsapp', 'whatsapp.root', 'teams', 'ms-teams', 'msteams', 'slack', 'discord', 'telegram', 'signal', 'outlook', 'olk', 'hxoutlook', 'thunderbird', 'skype', 'messenger', 'element', 'zoom', 'mailspring', 'hxmail'];

export interface ActionTarget {
  /** process of the window that would receive the input */
  process?: string;
  windowTitle?: string;
  /** UI Automation element under the point / with focus */
  elementType?: string;
  elementName?: string;
  /** title of the nearest dialog/window around the element */
  dialogTitle?: string;
}

export interface DesktopActionInput {
  action: 'click' | 'double_click' | 'triple_click' | 'right_click' | 'middle_click' | 'drag' | 'scroll' | 'type' | 'key' | 'launch' | 'focus' | 'move';
  target?: ActionTarget;
  /** parsed key combos for key actions: names like ["ctrl","enter"] */
  keys?: string[][];
  text?: string;
  /** the bot declared an external effect ("verstuurt de e-mail aan Jan") */
  external?: string;
}

/**
 * Does this action probably cause an external side effect? Then it always asks explicitly, whatever the access
 * level. Deliberately on the cautious side: a false "yes" costs one click from the owner, a false "no" could send
 * an e-mail.
 */
export function classifySideEffect(a: DesktopActionInput, o: { full?: boolean } = {}): { danger: boolean; reason?: string } {
  // "Volledige toegang": only paying and sending to someone else ask; deleting, installing, publishing and confirming
  // a dialog are the bot's ordinary work there.
  const SIDE_EFFECT_RE = o.full ? PAY_SEND_RE : SIDE_EFFECT_ALL;
  if (a.external && String(a.external).trim() && (!o.full || PAY_SEND_RE.test(String(a.external)) || /bericht|mail|message|klant|customer|geld|money|€|\$/i.test(String(a.external))))
    return { danger: true, reason: `De bot meldt: ${String(a.external).trim().slice(0, 200)}` };
  const t = a.target || {};
  const proc = normApp(t.process || '');
  const name = String(t.elementName || '').trim();
  const dialog = String(t.dialogTitle || '').trim();
  const clicky = a.action === 'click' || a.action === 'double_click' || a.action === 'triple_click';
  if (clicky) {
    if (name && SIDE_EFFECT_RE.test(name)) return { danger: true, reason: `"${name.slice(0, 60)}" lijkt iets te versturen, kopen, publiceren of verwijderen` };
    if (name && CONFIRM_RE.test(name) && dialog && SIDE_EFFECT_RE.test(dialog)) return { danger: true, reason: `"${name}" bevestigt "${dialog.slice(0, 80)}"` };
  }
  if (a.action === 'key' && a.keys?.length) {
    for (const combo of a.keys) {
      const s = new Set(combo);
      const main = combo[combo.length - 1];
      const mods = combo.slice(0, -1);
      if (main === 'enter' && (s.has('ctrl') || s.has('alt'))) return { danger: true, reason: `${combo.join('+')} verstuurt vaak een bericht of formulier` };
      if (main === 's' && mods.length === 1 && s.has('alt')) return { danger: true, reason: 'Alt+S verstuurt in veel mailprogramma’s het bericht' };
      if (!o.full && main === 'delete' && s.has('shift')) return { danger: true, reason: 'Shift+Delete verwijdert definitief' };
      if (!o.full && main === 'delete' && !mods.length && proc === 'explorer') return { danger: true, reason: 'Delete in Verkenner verwijdert bestanden' };
      if (main === 'enter' && !mods.length) {
        if (name && SIDE_EFFECT_RE.test(name)) return { danger: true, reason: `Enter op "${name.slice(0, 60)}"` };
        if (MESSAGING_APPS.includes(proc)) return { danger: true, reason: `Enter verstuurt in ${proc} het bericht` };
      }
    }
  }
  if (a.action === 'type' && a.text && /\n/.test(a.text) && MESSAGING_APPS.includes(proc)) return { danger: true, reason: `Een nieuwe regel verstuurt in ${proc} het bericht` };
  return { danger: false };
}

// ---------------- approvals ----------------

export interface TaskGrant {
  id: string;
  agentId: string;
  threadId: string;
  goal: string;
  apps: string[];
  createdAt: number;
  until: number;
  actions: number;
  maxActions: number;
  by: string;
}

export function grantCovers(g: TaskGrant | null | undefined, q: { agentId: string; threadId: string; app: string; now: number }): boolean {
  if (!g) return false;
  if (g.agentId !== q.agentId || g.threadId !== q.threadId) return false;
  if (q.now >= g.until) return false;
  if (g.actions >= g.maxActions) return false;
  return g.apps.includes('*') || g.apps.includes(normApp(q.app));
}

export type ApprovalNeed = 'none' | 'action' | 'scope' | 'danger';

/**
 * Which approval an input action needs.
 * - danger: external side effect, always asks (also at level "auto", also inside a task scope)
 * - action: level "every" (unless the tool runner already asked for this exact call)
 * - scope:  level "task" without a grant that covers this app
 * A grant (task approval, or "Altijd toestaan" on a single action = the rest of this task) skips the per-action ask.
 */
export function approvalNeed(o: { level: HostLevel; danger: boolean; grantOk: boolean; runnerAsked: boolean }): ApprovalNeed {
  if (o.danger) return 'danger';
  if (o.level === 'auto' || o.grantOk) return 'none';
  if (o.level === 'task') return 'scope';
  return o.runnerAsked ? 'none' : 'action';
}

// ---------------- screen geometry ----------------

export interface Monitor {
  index: number;
  x: number;
  y: number;
  w: number;
  h: number;
  primary: boolean;
  /** effective DPI (96 = 100%) */
  dpi: number;
}

/** A screenshot the model sees: which screen area, at which size. */
export interface ShotGeometry {
  /** screen area in physical pixels (a monitor or a zoom region) */
  x: number;
  y: number;
  w: number;
  h: number;
  /** image size */
  shotW: number;
  shotH: number;
  monitor: number;
}

/** Recommended size for computer-use models: long edge ≤ 1280 and ≤ ~1.2 MP, never upscaled. */
export function planShot(area: { x: number; y: number; w: number; h: number }, o: { maxW?: number; maxH?: number; maxPixels?: number; monitor?: number; allowUpscale?: number } = {}): ShotGeometry {
  const maxW = o.maxW ?? 1280;
  const maxH = o.maxH ?? 1280;
  const maxPixels = o.maxPixels ?? 1_228_800;
  const w = Math.max(1, Math.round(area.w));
  const h = Math.max(1, Math.round(area.h));
  let s = Math.min(maxW / w, maxH / h, Math.sqrt(maxPixels / (w * h)));
  s = Math.min(s, o.allowUpscale ?? 1);
  return { x: Math.round(area.x), y: Math.round(area.y), w, h, shotW: Math.max(1, Math.floor(w * s + 1e-6)), shotH: Math.max(1, Math.floor(h * s + 1e-6)), monitor: o.monitor ?? 0 };
}

/** Screenshot pixel -> physical screen pixel. Throws for points outside the screenshot. */
export function toScreen(g: ShotGeometry, x: number, y: number): { x: number; y: number } {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) throw new Error('Geef x en y als getallen (pixels in de laatste schermafbeelding).');
  if (nx < 0 || ny < 0 || nx > g.shotW || ny > g.shotH) throw new Error(`Punt (${Math.round(nx)}, ${Math.round(ny)}) ligt buiten de schermafbeelding (${g.shotW}×${g.shotH}).`);
  const sx = g.x + Math.min(g.w - 1, Math.floor((nx * g.w) / g.shotW));
  const sy = g.y + Math.min(g.h - 1, Math.floor((ny * g.h) / g.shotH));
  return { x: sx, y: sy };
}

/** Physical screen pixel -> screenshot pixel (null when outside the area). */
export function toShot(g: ShotGeometry, sx: number, sy: number): { x: number; y: number } | null {
  if (sx < g.x || sy < g.y || sx >= g.x + g.w || sy >= g.y + g.h) return null;
  return { x: Math.round(((sx - g.x + 0.5) * g.shotW) / g.w), y: Math.round(((sy - g.y + 0.5) * g.shotH) / g.h) };
}

/** Zoom region (in screenshot pixels of `g`) -> a screen area clipped to the monitor. */
export function zoomArea(g: ShotGeometry, r: unknown): { x: number; y: number; w: number; h: number } {
  if (!Array.isArray(r) || r.length !== 4 || r.some((n) => !Number.isFinite(Number(n)))) throw new Error('Geef region als [x1, y1, x2, y2] in pixels van de laatste schermafbeelding.');
  const [x1, y1, x2, y2] = r.map(Number);
  const a = toScreen(g, Math.max(0, Math.min(x1, x2)), Math.max(0, Math.min(y1, y2)));
  const b = toScreen(g, Math.min(g.shotW, Math.max(x1, x2)), Math.min(g.shotH, Math.max(y1, y2)));
  const w = Math.max(8, b.x - a.x + 1);
  const h = Math.max(8, b.y - a.y + 1);
  return { x: a.x, y: a.y, w: Math.min(w, g.x + g.w - a.x), h: Math.min(h, g.y + g.h - a.y) };
}

export function pickMonitor(list: Monitor[], index: number | undefined): Monitor {
  if (!list.length) throw new Error('Geen beeldscherm gevonden.');
  const i = Number.isFinite(Number(index)) ? Number(index) : 0;
  const m = list.find((x) => x.index === i);
  if (!m) throw new Error(`Beeldscherm ${i} bestaat niet (er zijn er ${list.length}: ${list.map((x) => x.index).join(', ')}).`);
  return m;
}

// ---------------- keys ----------------

export const VK: Record<string, number> = {
  ctrl: 0x11,
  shift: 0x10,
  alt: 0x12,
  win: 0x5b,
  enter: 0x0d,
  tab: 0x09,
  esc: 0x1b,
  backspace: 0x08,
  delete: 0x2e,
  insert: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  up: 0x26,
  down: 0x28,
  left: 0x25,
  right: 0x27,
  space: 0x20,
  menu: 0x5d,
  capslock: 0x14,
  printscreen: 0x2c,
  pause: 0x13,
  numlock: 0x90,
  scrolllock: 0x91,
  ';': 0xba,
  '=': 0xbb,
  ',': 0xbc,
  '-': 0xbd,
  '.': 0xbe,
  '/': 0xbf,
  '`': 0xc0,
  '[': 0xdb,
  '\\': 0xdc,
  ']': 0xdd,
  "'": 0xde,
};
for (let i = 1; i <= 24; i++) VK['f' + i] = 0x6f + i;
for (let i = 0; i <= 9; i++) VK['numpad' + i] = 0x60 + i;

const ALIAS: Record<string, string> = {
  control: 'ctrl',
  ctl: 'ctrl',
  return: 'enter',
  kp_enter: 'enter',
  escape: 'esc',
  del: 'delete',
  ins: 'insert',
  pgup: 'pageup',
  page_up: 'pageup',
  prior: 'pageup',
  pgdn: 'pagedown',
  page_down: 'pagedown',
  next: 'pagedown',
  arrowup: 'up',
  arrowdown: 'down',
  arrowleft: 'left',
  arrowright: 'right',
  spacebar: 'space',
  back_space: 'backspace',
  bksp: 'backspace',
  apps: 'menu',
  contextmenu: 'menu',
  super: 'win',
  meta: 'win',
  cmd: 'win',
  command: 'win',
  windows: 'win',
  lwin: 'win',
  rwin: 'win',
  option: 'alt',
  minus: '-',
  plus: '=',
  equal: '=',
  comma: ',',
  period: '.',
  slash: '/',
  semicolon: ';',
  print: 'printscreen',
  prtsc: 'printscreen',
};

/** One combo "ctrl+shift+t" -> ["ctrl","shift","t"] (normalised names). */
export function keyNames(combo: string): string[] {
  const raw = String(combo || '').trim();
  if (!raw) throw new Error('Geef een toets of combinatie, bijv. "enter" of "ctrl+s".');
  const parts = (raw === '+' ? ['='] : raw.split(/\+(?!$)/)).map((p) => p.trim().toLowerCase()).filter(Boolean);
  if (!parts.length || parts.length > 4) throw new Error(`Ongeldige toetscombinatie: ${raw}`);
  return parts.map((p) => {
    const n = ALIAS[p] || ALIAS[p.replace(/[\s-]/g, '_')] || p;
    if (VK[n] === undefined && !/^[a-z0-9]$/.test(n)) throw new Error(`Onbekende toets: ${p}`);
    return n;
  });
}

/** Refuse combos that could escape the allowed apps or reach Windows security. */
export function forbiddenCombo(names: string[]): string | null {
  const s = new Set(names);
  if (s.has('win')) return 'De Windows-toets is niet toegestaan voor bots';
  if (s.has('alt') && (s.has('tab') || s.has('f4') || s.has('esc'))) return 'Alt+Tab, Alt+F4 en Alt+Esc zijn niet toegestaan voor bots';
  if (s.has('ctrl') && s.has('alt') && (s.has('delete') || s.has('end'))) return 'Ctrl+Alt+Del is niet toegestaan';
  if (s.has('ctrl') && s.has('esc')) return 'Ctrl+Esc (en de noodstop Ctrl+Alt+Esc) is niet toegestaan';
  if (s.has('ctrl') && s.has('shift') && s.has('esc')) return 'Taakbeheer openen is niet toegestaan';
  if (s.has('printscreen')) return 'Print Screen is niet toegestaan (gebruik de schermafbeelding van TeamBot)';
  return null;
}

/** "ctrl+a ctrl+c" or ["ctrl+a","ctrl+c"] -> parsed combos (max 10), each checked. */
export function parseKeySequence(v: unknown): { names: string[][]; vks: number[][] } {
  const list = Array.isArray(v) ? v.map(String) : String(v ?? '').trim().split(/\s+/);
  const combos = list.map((x) => x.trim()).filter(Boolean);
  if (!combos.length) throw new Error('Geef een toets of combinatie, bijv. "enter" of "ctrl+s".');
  if (combos.length > 10) throw new Error('Maximaal 10 toetscombinaties per keer.');
  const names = combos.map(keyNames);
  for (const n of names) {
    const bad = forbiddenCombo(n);
    if (bad) throw new Error(bad);
  }
  return { names, vks: names.map((n) => n.map((k) => VK[k] ?? k.toUpperCase().charCodeAt(0))) };
}

// ---------------- user input detection ----------------

/**
 * Did the owner move the mouse since the bot's last action? Only counts while the bot is actively working (its last
 * action was recent), so a bot that starts a new task hours later is not paused by normal use in between.
 */
export function userMovedMouse(o: { last: { x: number; y: number } | null; lastAt: number; now: number; current: { x: number; y: number } | null; thresholdPx?: number; windowMs?: number }): boolean {
  if (!o.last || !o.current) return false;
  if (o.now - o.lastAt > (o.windowMs ?? 90_000)) return false;
  const d = Math.hypot(o.current.x - o.last.x, o.current.y - o.last.y);
  return d > (o.thresholdPx ?? 24);
}

/** Sliding one-minute window for the actions-per-minute safety valve. */
export class RateWindow {
  private times: number[] = [];
  constructor(private max: number) {}
  setMax(n: number) {
    this.max = n;
  }
  /** ms to wait before the next action may run (0 = now). */
  waitMs(now: number): number {
    this.times = this.times.filter((t) => now - t < 60_000);
    if (this.times.length < this.max) return 0;
    return 60_000 - (now - this.times[0]);
  }
  record(now: number) {
    this.times.push(now);
  }
}
