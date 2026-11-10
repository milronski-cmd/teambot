import { redactSecrets } from '../skills/scan.js';
import type { ProfileField, TeamProfile, TemplateDef } from './types.js';

/** Short labels in the profile overview, per profile field (a question's `short` wins; an `extra` one brings its own). */
export const PROFILE_LABEL: Record<Exclude<ProfileField, 'extra'>, string> = {
  name: 'Bedrijf',
  business: 'Wat we doen',
  tone: 'Toon',
  rules: 'Regels',
};
/** The same for a private team (household, money, health, travel, study). */
export const PRIVATE_LABEL: Record<Exclude<ProfileField, 'extra'>, string> = {
  name: 'Voor wie',
  business: 'Waar het team mee helpt',
  tone: 'Toon',
  rules: 'Afspraken',
};

function labelsFor(def?: TemplateDef | null): Record<Exclude<ProfileField, 'extra'>, string> {
  const base = { ...(def?.category === 'prive' ? PRIVATE_LABEL : PROFILE_LABEL) };
  for (const q of def?.questions || []) if (q.profile !== 'extra' && q.short) base[q.profile] = q.short;
  return base;
}

const MAX_NAME = 80;
const MAX_LINE = 400;
const MAX_TEXT = 1500;

/** One answer from an untrusted body: text only, no control characters, tidy lines, bounded. */
export function cleanAnswer(v: unknown, max: number, oneLine: boolean): string {
  if (typeof v !== 'string') return '';
  let t = v
    .replace(/\r\n?/g, '\n')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  if (oneLine) t = t.replace(/\s*\n\s*/g, ' ');
  return t.slice(0, max).trim();
}

export function emptyProfile(): TeamProfile {
  return { name: '', business: '', tone: '', rules: '', extra: [] };
}

export function isEmptyProfile(p: TeamProfile): boolean {
  return !p.name && !p.business && !p.tone && !p.rules && !p.extra.length;
}

/**
 * Fill the business profile from the owner's answers to the template's questions. Unknown keys are ignored, empty
 * answers are left out, and anything that looks like a key or password is removed (and reported): a profile is
 * read by every bot in the team, so a secret never belongs in it.
 */
export function profileFromAnswers(def: TemplateDef, answers: unknown): { profile: TeamProfile; values: Record<string, string>; warnings: string[] } {
  const a = answers && typeof answers === 'object' && !Array.isArray(answers) ? (answers as Record<string, unknown>) : {};
  const profile = emptyProfile();
  const values: Record<string, string> = {};
  let removed = 0;
  for (const q of def.questions) {
    const oneLine = q.kind === 'text' || q.profile === 'name';
    const max = q.profile === 'name' ? MAX_NAME : oneLine ? MAX_LINE : MAX_TEXT;
    const r = redactSecrets(cleanAnswer(a[q.key], max, oneLine));
    removed += r.count;
    const v = r.text.trim();
    if (!v) continue;
    values[q.key] = v;
    if (q.profile === 'extra') profile.extra.push({ key: q.key, label: q.short || q.label, value: v });
    else profile[q.profile] = v;
  }
  const warnings: string[] = [];
  if (removed) warnings.push(removed === 1 ? 'Er stond iets in dat op een wachtwoord of sleutel lijkt; dat is uit het bedrijfsprofiel gehaald.' : 'Er stonden dingen in die op wachtwoorden of sleutels lijken; die zijn uit het bedrijfsprofiel gehaald.');
  return { profile, values, warnings };
}

/** A value under a list item: continuation lines indented, so a multi-line answer stays one item. */
const item = (label: string, v: string) => `- ${label}: ${v.split('\n').join('\n  ')}`;

/** The profile as text for the team instructions; empty when nothing was filled in. */
export function profileText(p: TeamProfile, def?: TemplateDef | null): string {
  if (isEmptyProfile(p)) return '';
  const L = labelsFor(def);
  const lines = [def?.category === 'prive' ? 'Profiel van dit team (ingevuld door de eigenaar):' : 'Bedrijfsprofiel (ingevuld door de eigenaar):'];
  if (p.name) lines.push(item(L.name, p.name));
  if (p.business) lines.push(item(L.business, p.business));
  for (const x of p.extra) lines.push(item(x.label, x.value));
  if (p.tone) lines.push(item(L.tone, p.tone));
  if (p.rules) lines.push(item(L.rules, p.rules));
  lines.push('Dit zijn de feiten die de eigenaar gaf. Wat hier niet staat, weet je niet: vraag het de eigenaar en verzin het niet.');
  return lines.join('\n');
}

/**
 * The profile in the shape of a team's profile in the teams module (`{ company, about, tone, rules }`, package B):
 * extra answers (web address, programs, channels) go under "about" with their label.
 */
export function teamsProfile(p: TeamProfile): { company: string; about: string; tone: string; rules: string } {
  const about = [p.business, ...p.extra.map((x) => `${x.label}: ${x.value}`)].filter(Boolean).join('\n');
  return { company: p.name, about, tone: p.tone, rules: p.rules };
}

/** Fill `{key}` placeholders (routine prompts) from the answers; a missing answer says so plainly. */
export function fillPlaceholders(text: string, values: Record<string, string>): string {
  return text.replace(/\{([a-z][a-z0-9_]*)\}/g, (_m, k: string) => (values[k] ? values[k].replace(/\s*\n\s*/g, ' ') : 'nog niet ingevuld'));
}

/** Placeholder keys used in a text. */
export function placeholdersIn(text: string): string[] {
  return [...text.matchAll(/\{([a-z][a-z0-9_]*)\}/g)].map((m) => m[1]);
}
