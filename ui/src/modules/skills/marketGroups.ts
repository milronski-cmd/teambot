import type { LucideIcon } from 'lucide-react';
import { Briefcase, Code2, Headset, Megaphone, PenLine, Puzzle, Search } from 'lucide-react';

/**
 * The Marktplaats tiles (0.4.5, "de marktplaats moet duidelijk zijn"): every entry of the catalogue, of any pack or
 * category (other files add their own), lands in one plain group. A category or pack that matches no group gets a tile
 * of its own, so nothing new is ever hidden. Matching is by word start on the category first, then the pack.
 * The same words match a bot's name, role and description for "Aanbevolen voor je bots".
 */
export interface MarketGroup {
  id: string;
  label: string;
  icon: LucideIcon;
  /** Word starts (lowercase, without accents). */
  words: string[];
}

export const GROUPS: MarketGroup[] = [
  { id: 'marketing', label: 'Marketing en SEO', icon: Megaphone, words: ['marketing', 'seo', 'advertent', 'ads', 'adverteer', 'social', 'content', 'merk', 'brand', 'campagne', 'nieuwsbrief', 'copy', 'tekstschrijver', 'reclame', 'vindbaar'] },
  { id: 'service', label: 'Klantenservice en verkoop', icon: Headset, words: ['klantenservice', 'klant', 'support', 'helpdesk', 'verkoop', 'verkoper', 'sales', 'crm', 'webshop', 'winkel', 'shop', 'ecommerce', 'lead', 'offerte', 'service'] },
  { id: 'build', label: 'Bouwen en data', icon: Code2, words: ['ontwikkel', 'developer', 'programm', 'code', 'coder', 'software', 'data', 'analyse', 'analist', 'sql', 'database', 'dev', 'devops', 'cloud', 'bouwen', 'bouwer', 'git', 'github', 'test', 'beveilig', 'security', 'website'] },
  { id: 'office', label: 'Kantoor en ontwerp', icon: Briefcase, words: ['kantoor', 'office', 'document', 'ontwerp', 'design', 'designer', 'media', 'operations', 'financ', 'boekhoud', 'factu', 'juridisch', 'jurist', 'communicatie', 'administrat', 'secretar', 'assistent', 'agenda', 'productiviteit', 'presentatie', 'spreadsheet', 'excel', 'mail'] },
  { id: 'search', label: 'Zoeken', icon: Search, words: ['zoek', 'search', 'research', 'onderzoek', 'kennis', 'browser', 'automatiser', 'nieuws', 'web'] },
  { id: 'writing', label: 'Schrijven en plannen', icon: PenLine, words: ['schrijven', 'schrijver', 'schrijf', 'werkwijze', 'plannen', 'planning', 'planner', 'tekst', 'redact', 'vertal', 'project'] },
  // Last: the catalogues' own "Overig" (other) lands here, as a tile that is translated like the others.
  { id: 'other', label: 'Overig', icon: Puzzle, words: ['overig', 'other', 'misc'] },
];

export const OTHER_ICON = Puzzle;

const fold = (s: string) =>
  s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');

/** The words of a text (lowercase, no accents; "Data & analyse" → data, analyse). */
export const wordsOf = (s: string) => fold(s).split(/[^a-z0-9]+/).filter(Boolean);

const matches = (words: string[], g: MarketGroup) => words.some((w) => g.words.some((k) => w.startsWith(k)));

/** The group of one entry: its category first, then its pack; '' when neither fits a group. */
export function groupIdOf(category: string, pack = ''): string {
  for (const text of [category, pack]) {
    const w = wordsOf(text || '');
    if (!w.length) continue;
    const g = GROUPS.find((x) => matches(w, x));
    if (g) return g.id;
  }
  return '';
}

export interface Tile {
  /** A group id, or `cat:<category>` for a category of its own. */
  id: string;
  label: string;
  icon: LucideIcon;
  count: number;
  /** A tile named after the entry's own category (text from the catalogue). */
  own?: boolean;
}

export const tileIdOf = (category: string, pack = '') => groupIdOf(category, pack) || `cat:${category || pack || '—'}`;

/** The tiles for a list: the fixed groups that have entries (in a fixed order), then any own categories (A–Z). */
export function tilesFor<T>(items: T[], catOf: (i: T) => { category: string; pack?: string }): Tile[] {
  const counts = new Map<string, number>();
  for (const i of items) {
    const c = catOf(i);
    const id = tileIdOf(c.category, c.pack);
    counts.set(id, (counts.get(id) || 0) + 1);
  }
  const fixed = GROUPS.filter((g) => counts.has(g.id)).map((g) => ({ id: g.id, label: g.label, icon: g.icon, count: counts.get(g.id)! }));
  const own = [...counts.keys()]
    .filter((id) => id.startsWith('cat:'))
    .sort((a, b) => a.localeCompare(b))
    .map((id) => ({ id, label: id.slice(4), icon: OTHER_ICON, count: counts.get(id)!, own: true }));
  return [...fixed, ...own];
}

/** The groups a bot's name, role and description point at (a SEO bot → Marketing en SEO). */
export function botGroups(text: string): string[] {
  const w = wordsOf(text);
  return GROUPS.filter((g) => matches(w, g)).map((g) => g.id);
}

/**
 * How well an entry fits a bot: 3 for every group word in both (the bot says "SEO" and so does the skill), 1 when the
 * entry's group is one of the bot's groups. 0 = not for this bot.
 */
export function fitScore(botText: string, itemText: string, itemGroup: string): number {
  const bw = wordsOf(botText);
  const iw = wordsOf(itemText);
  let score = 0;
  const seen = new Set<string>();
  for (const g of GROUPS)
    for (const k of g.words) {
      if (seen.has(k)) continue;
      if (bw.some((w) => w.startsWith(k)) && iw.some((w) => w.startsWith(k))) {
        seen.add(k);
        score += 3;
      }
    }
  if (itemGroup && botGroups(botText).includes(itemGroup)) score += 1;
  return score;
}
