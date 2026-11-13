/**
 * The model switcher in the chat header, the parts without a screen: what the control says, which rows the list has
 * (grouped per connected AI), what a search finds, and which thinking level fits a newly chosen model. The list itself
 * is components/ModelPicker.tsx (ModelMenu), the control is ./ModelSwitcher.tsx. No DOM here, so it is unit-tested.
 */
import type { Billing, ModelGroup, ModelInfo } from '../../../shared/types.js';
import { isDefaultModel, prettyModel } from '../../../shared/modelLabel.js';

/** One connected AI with its models, as GET /api/model-catalog/choices gives it (shared/types.ts). */
export type { ModelGroup };

/** What a bot runs on: the AI and the model together. model '' = "Automatisch": the AI picks. */
export interface ModelPick {
  provider_id: string;
  model: string;
}

export interface ModelRow {
  /** '' = Automatisch. */
  model: string;
  name: string;
  /** Quiet words after the name: "altijd de nieuwste (nu Opus 5.5)", "vaste versie (claude-opus-5-5)". */
  hint?: string;
  /** For "Automatisch": the model the AI picks now, when known ("Opus 5.5"). */
  now?: string;
  /** What it costs, on the row itself when the models of one AI differ. */
  billing?: Billing;
  info?: ModelInfo;
}

export interface ModelSection {
  provider: ModelGroup['provider'];
  /** What it costs, when every model of this AI costs the same. */
  billing?: Billing;
  rows: ModelRow[];
  error?: string;
  pending?: boolean;
}

export const AUTO = 'Automatisch';

/** The same words as BILLING_LABEL (lib/types), to take them out of a label that already ends in them. */
const BILLING_WORDS = new Set(['gratis', 'abonnement', 'betaald', 'lokaal, gratis']);

/** "Opus · altijd de nieuwste (nu Opus 5.5)" → name "Opus", hint "altijd de nieuwste (nu Opus 5.5)"; no label → the id in words. */
export function rowText(m: ModelInfo): { name: string; hint?: string } {
  const parts = (m.label || prettyModel(m.id) || m.id).split(' · ').map((p) => p.trim()).filter(Boolean);
  const hint = parts.slice(1).filter((p) => !BILLING_WORDS.has(p)).join(' · ');
  return { name: parts[0] || m.id, hint: hint || undefined };
}

/** An AI whose model may be left to it: every CLI has its own default, an API needs a default model on the connection. */
export const canAuto = (g: ModelGroup): boolean => g.provider.type === 'cli' || !!g.provider.defaultModel;

/** The model "Automatisch" means right now, when the AI says so ("Standaard van Claude Code (nu Opus 5.5)") or the connection has one. */
export function autoNow(g: ModelGroup): string | undefined {
  const d = g.provider.defaultModel;
  if (d && !isDefaultModel(d)) return rowText(g.models.find((m) => m.id === d) || { id: d }).name;
  return /\(nu ([^()]+)\)\s*$/.exec(g.models.find((m) => m.id === 'default')?.label || '')?.[1];
}

/**
 * The list: per connected AI its rows, the AI the bot is on now first (so "Automatisch" of that AI is the first row),
 * the others in the order they were connected. The engine's own "default" entry is the "Automatisch" row. A model the
 * bot has that is not in the list (typed in on the bot's page) gets a row, so the current choice is always in view.
 */
export function modelSections(groups: ModelGroup[], value: { provider_id: string | null; model: string }): ModelSection[] {
  const out = groups.map((g): ModelSection => {
    const listed = g.models.filter((m) => m.id !== 'default');
    const own = (m: ModelInfo): Billing | undefined => m.billing || (m.free ? 'free' : undefined);
    const anyOwn = listed.some((m) => !!own(m));
    // A CLI that labels some of its models (OpenCode: free ones) says nothing about the others; else the AI's own label.
    const cost = (m: ModelInfo) => own(m) || (g.provider.type === 'cli' && anyOwn ? undefined : g.provider.billing);
    const costs = listed.map(cost);
    const same = costs.length ? costs.every((c) => c && c === costs[0]) : true;
    const billing = same ? costs[0] || g.provider.billing : undefined;
    const rows: ModelRow[] = [];
    if (canAuto(g)) rows.push({ model: '', name: AUTO, now: autoNow(g), info: g.models.find((m) => m.id === 'default') || g.models.find((m) => m.id === g.provider.defaultModel) });
    const mine = value.provider_id === g.provider.id && !isDefaultModel(value.model) && !listed.some((m) => m.id === value.model) ? value.model : '';
    if (mine) rows.push({ model: mine, name: prettyModel(mine) || mine });
    for (const m of listed) rows.push({ model: m.id, ...rowText(m), billing: same ? undefined : cost(m), info: m });
    return { provider: g.provider, billing, rows, error: g.error, pending: g.pending };
  });
  const at = out.findIndex((s) => s.provider.id === value.provider_id);
  return at > 0 ? [out[at], ...out.slice(0, at), ...out.slice(at + 1)] : out;
}

export const isCurrent = (s: ModelSection, r: ModelRow, value: { provider_id: string | null; model: string }): boolean =>
  s.provider.id === value.provider_id && (r.model ? r.model === value.model : isDefaultModel(value.model));

export const rowCount = (sections: ModelSection[]): number => sections.reduce((n, s) => n + s.rows.length, 0);

/**
 * Search: every word must be in the AI's name, the model's name, its id, its hint or what it costs ("claude son",
 * "ollama", "gratis"). Not in what "Automatisch" picks now: a search for "opus" finds the Opus rows, not that one.
 */
export function filterSections(sections: ModelSection[], query: string, words: (b: Billing) => string = (b) => b): ModelSection[] {
  const tokens = query.toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!tokens.length) return sections;
  return sections
    .map((s) => ({
      ...s,
      rows: s.rows.filter((r) => {
        const cost = r.billing || s.billing;
        const hay = [s.provider.name, s.provider.kindLabel, r.name, r.model, r.hint || '', cost ? words(cost) : ''].join(' ').toLocaleLowerCase();
        return tokens.every((t) => hay.includes(t));
      }),
    }))
    .filter((s) => s.rows.length);
}

/** What the control in the header says: the AI and the model in short words; "Automatisch" when the AI picks. */
export function controlText(agent: { provider_id: string | null; model: string }, provider?: { name: string } | null): { ai: string; model: string } {
  return { ai: provider?.name || '', model: isDefaultModel(agent.model) ? AUTO : prettyModel(agent.model) || agent.model };
}

/** From shallow to deep; "on" (a model that only thinks or not) sits with medium. */
const DEPTH: Record<string, number> = { none: 0, minimal: 1, low: 2, medium: 3, on: 3, high: 4, xhigh: 5, max: 6 };

/**
 * The thinking level a bot keeps on a new model: its own when the model takes it (or nothing is known about the
 * model), "standaard" ('') when the model has no levels, else the nearest level it does take (of two equally near,
 * the lighter one, so a switch never makes the bot think deeper than it was set to).
 */
export function fitReasoning(current: string, levels: string[] | undefined): string {
  if (!current || !Array.isArray(levels) || levels.includes(current)) return current;
  const at = DEPTH[current];
  const known = levels.filter((l) => l in DEPTH);
  if (!known.length || at === undefined) return '';
  return known.reduce((best, l) => {
    const d = Math.abs(DEPTH[l] - at);
    const b = Math.abs(DEPTH[best] - at);
    return d < b || (d === b && DEPTH[l] < DEPTH[best]) ? l : best;
  });
}

/** The thinking levels of a pick, from the list it was picked from; undefined = unknown (the bot keeps its level). */
export function levelsOfPick(groups: ModelGroup[], pick: ModelPick): string[] | undefined {
  const g = groups.find((x) => x.provider.id === pick.provider_id);
  if (!g) return undefined;
  const m = isDefaultModel(pick.model) ? g.models.find((x) => x.id === 'default') || g.models.find((x) => x.id === g.provider.defaultModel) : g.models.find((x) => x.id === pick.model);
  return m && Array.isArray(m.reasoningLevels) ? m.reasoningLevels : undefined;
}
