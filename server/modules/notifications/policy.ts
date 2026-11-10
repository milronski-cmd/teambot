/**
 * Notification policy (pure, no I/O): what counts as important, and whether a notification of a bot may alert the
 * owner (toast, sound, desktop notification, phone push) or only goes into the history quietly.
 *
 * Levels per bot: all = everything alerts; important = only questions, approvals, errors and limits alert;
 * none = nothing alerts. A muted notification is still kept in the history (marked read), and an approval still
 * waits in "Wacht op jou": muting never hides work that waits for you.
 */

export type NotifyLevel = 'all' | 'important' | 'none';

export interface NotifyPrefs {
  /** Play a sound with an alert (in the app, desktop notifications and phone pushes). */
  sound: boolean;
  /** Notifications that do not belong to one bot (limits, apps, channels, system). */
  other: NotifyLevel;
  /** Per bot; a bot without an entry gets everything. */
  bots: Record<string, NotifyLevel>;
}

export const DEFAULT_PREFS: NotifyPrefs = { sound: true, other: 'all', bots: {} };
const LEVELS = new Set<NotifyLevel>(['all', 'important', 'none']);
export const isLevel = (v: unknown): v is NotifyLevel => typeof v === 'string' && LEVELS.has(v as NotifyLevel);

/** Stored prefs → a clean object (unknown keys and values dropped). */
export function cleanPrefs(raw: any): NotifyPrefs {
  const out: NotifyPrefs = { sound: typeof raw?.sound === 'boolean' ? raw.sound : DEFAULT_PREFS.sound, other: isLevel(raw?.other) ? raw.other : DEFAULT_PREFS.other, bots: {} };
  if (raw?.bots && typeof raw.bots === 'object')
    for (const [id, v] of Object.entries(raw.bots).slice(0, 2000)) if (typeof id === 'string' && id.length <= 80 && isLevel(v) && v !== 'all') out.bots[id] = v;
  return out;
}

/** Apply a patch; `bots: { id: null | 'all' }` resets a bot to the default (everything). */
export function mergePrefs(cur: NotifyPrefs, patch: any, validBot: (id: string) => boolean = () => true): NotifyPrefs {
  const next = cleanPrefs(cur);
  if (typeof patch?.sound === 'boolean') next.sound = patch.sound;
  if (isLevel(patch?.other)) next.other = patch.other;
  if (patch?.bots && typeof patch.bots === 'object')
    for (const [id, v] of Object.entries(patch.bots)) {
      if (!validBot(id)) continue;
      if (v === null || v === 'all') delete next.bots[id];
      else if (isLevel(v)) next.bots[id] = v;
    }
  return next;
}

/** Kinds that block a bot or warn about a problem. */
const IMPORTANT_KINDS = new Set(['approval', 'question', 'warning', 'computer', 'error']);
const IMPORTANT_LEVELS = new Set(['limit', 'warn', 'error', 'important']);

export function isImportant(d: { kind?: unknown; level?: unknown; important?: unknown } | null | undefined): boolean {
  if (!d) return false;
  if (d.important === true) return true;
  if (typeof d.kind === 'string' && IMPORTANT_KINDS.has(d.kind)) return true;
  return typeof d.level === 'string' && IMPORTANT_LEVELS.has(d.level);
}

export function levelFor(prefs: NotifyPrefs, agentId: string | null | undefined): NotifyLevel {
  return agentId ? prefs.bots[agentId] || 'all' : prefs.other;
}

/** alert: may pop up / sound / push. muted: kept in the history as already read. */
export function decide(prefs: NotifyPrefs, n: { agentId?: string | null; important: boolean }): { alert: boolean; muted: boolean; level: NotifyLevel } {
  const level = levelFor(prefs, n.agentId);
  const alert = level === 'all' || (level === 'important' && n.important);
  return { alert, muted: !alert, level };
}
