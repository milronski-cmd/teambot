import type { ModelInfo } from '../core/types.js';
import { catalogInfo } from './models-dev.js';

/**
 * What a model can do (C-01) and which thinking levels it takes (C-11), per engine and model. Order of trust: what the
 * engine itself reports (Codex model/list, Ollama /api/show, OpenRouter, Anthropic /v1/models) → the dated tables below
 * for Claude and OpenAI (facts from the vendor's documentation; they also carry the default thinking level and Claude
 * Code's aliases, which models.dev does not have) → the models.dev catalogue (models-dev.ts) for every other provider
 * and model → unknown, shown as "onbekend". Never a guess.
 */

/** Thinking levels, low to high. "none" = no thinking; "on" = thinking on (models with only on/off). */
export const EFFORT_ORDER = ['none', 'minimal', 'low', 'medium', 'on', 'high', 'xhigh', 'max'] as const;
export type Effort = (typeof EFFORT_ORDER)[number];

const CLAUDE_SRC = 'https://platform.claude.com/docs/en/about-claude/models/overview';
const CLAUDE_CHECKED = '2026-10-06';
const ALL5: Effort[] = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Claude models: context window and effort levels (Anthropic docs, checked 2026-10-06). */
const CLAUDE: { re: RegExp; context: number; levels: Effort[]; default: Effort }[] = [
  { re: /^claude-(fable|mythos)-5(-1)?$/, context: 1_000_000, levels: ALL5, default: 'high' },
  { re: /^claude-opus-5-5$/, context: 1_000_000, levels: ALL5, default: 'medium' },
  { re: /^claude-opus-5$/, context: 1_000_000, levels: ALL5, default: 'high' },
  { re: /^claude-opus-4-[78]$/, context: 1_000_000, levels: ALL5, default: 'high' },
  { re: /^claude-sonnet-5(-5)?$/, context: 1_000_000, levels: ALL5, default: 'high' },
  { re: /^claude-haiku-5-5$/, context: 1_000_000, levels: ALL5, default: 'medium' },
  { re: /^claude-(opus|sonnet)-4-6$/, context: 1_000_000, levels: ['low', 'medium', 'high', 'max'], default: 'high' },
  { re: /^claude-opus-4-5$/, context: 200_000, levels: ['low', 'medium', 'high'], default: 'high' },
  { re: /^claude-(haiku-4-5|sonnet-4-5|opus-4-1|opus-4|sonnet-4)$/, context: 200_000, levels: [], default: 'high' },
];

/** Claude Code aliases → the model they point to now (Claude Code's own /model, checked with 2.1.319). */
const CLAUDE_ALIAS: Record<string, string> = { default: 'claude-opus-5-5', opus: 'claude-opus-5-5', sonnet: 'claude-sonnet-5-5', haiku: 'claude-haiku-5-5', fable: 'claude-fable-5-1', best: 'claude-fable-5-1', opusplan: 'claude-opus-5-5' };

/** "us.anthropic.claude-opus-5-5-v1:0", "claude-opus-5-5@20260101", "opus[1m]" → the plain Claude id. */
export function claudeId(model: string): string {
  const m = String(model || '').replace(/\[1m\]$/i, '');
  if (CLAUDE_ALIAS[m]) return CLAUDE_ALIAS[m];
  return m
    .replace(/^(us|eu|apac|global|jp|au)\./, '')
    .replace(/^anthropic[./]/, '')
    .replace(/-v\d+:\d+$/, '')
    .replace(/@\d{8}$/, '')
    .replace(/-\d{8}$/, '');
}

export function claudeInfo(model: string): (Partial<ModelInfo> & { reasoningLevels: Effort[]; defaultReasoning: Effort }) | null {
  const id = claudeId(model);
  const row = CLAUDE.find((r) => r.re.test(id));
  if (!row) return null;
  const big = /\[1m\]$/i.test(model);
  return { context: big ? 1_000_000 : row.context, vision: true, tools: true, reasoningLevels: row.levels, defaultReasoning: row.default, capSource: CLAUDE_SRC, capChecked: CLAUDE_CHECKED };
}

/** Which levels a provider's request format can carry at all (openai-compat.ts reasoningBody). */
const STYLE_LEVELS: Record<string, Effort[]> = {
  effort: ['low', 'medium', 'high'],
  openrouter: ['none', 'low', 'medium', 'high'],
  xai: ['low', 'medium', 'high'],
  deepseek: ['none', 'low', 'high', 'max'],
  zai: ['none', 'on'],
  qwen: ['none', 'on'],
};

const OPENAI_SRC = 'https://developers.openai.com/api/docs/models';
const OPENAI_CHECKED = '2026-11-07';
const N5: Effort[] = ['none', 'low', 'medium', 'high', 'xhigh'];
const N6: Effort[] = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
const PRO: Effort[] = ['medium', 'high', 'xhigh'];
/** On the model page: a reasoning model, but which reasoning.effort values it takes is not stated. */
const UNSTATED = undefined;

/**
 * OpenAI API models: context window, image input, function calling and reasoning.effort values, from each model's own
 * page on developers.openai.com (…/api/docs/models/<id>, checked 2026-11-07). Deprecated and shut-down models are in
 * too (a bot may still name them). `levels`: [] = no reasoning; undefined = the page does not list them.
 */
const OPENAI: Record<string, { context: number; vision: boolean; tools: boolean; levels: Effort[] | undefined; default?: Effort }> = {
  'gpt-6-astra': { context: 1_050_000, vision: true, tools: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'] },
  'gpt-6.1-sol': { context: 1_050_000, vision: true, tools: true, levels: ['low', 'medium', 'high', 'xhigh', 'max'], default: 'medium' },
  'gpt-6.1-terra': { context: 1_050_000, vision: true, tools: true, levels: N6, default: 'medium' },
  'gpt-6-sol': { context: 1_050_000, vision: true, tools: true, levels: N6, default: 'medium' },
  'gpt-6-luna': { context: 1_050_000, vision: true, tools: true, levels: N6, default: 'medium' },
  'gpt-5.6-sol': { context: 1_050_000, vision: true, tools: true, levels: N6, default: 'medium' },
  'gpt-5.6-terra': { context: 1_050_000, vision: true, tools: true, levels: N6, default: 'medium' },
  'gpt-5.6-luna': { context: 1_050_000, vision: true, tools: true, levels: N6, default: 'medium' },
  'gpt-5.5': { context: 1_050_000, vision: true, tools: true, levels: N5, default: 'medium' },
  'gpt-5.5-pro': { context: 1_050_000, vision: true, tools: true, levels: PRO, default: 'high' },
  'gpt-5.4': { context: 1_050_000, vision: true, tools: true, levels: N5, default: 'none' },
  'gpt-5.4-pro': { context: 1_050_000, vision: true, tools: true, levels: PRO, default: 'medium' },
  'gpt-5.4-mini': { context: 400_000, vision: true, tools: true, levels: N5, default: 'none' },
  'gpt-5.4-nano': { context: 400_000, vision: true, tools: true, levels: N5, default: 'none' },
  'gpt-5.3-codex': { context: 400_000, vision: true, tools: true, levels: ['low', 'medium', 'high', 'xhigh'] },
  'gpt-5.2': { context: 400_000, vision: true, tools: true, levels: N5, default: 'none' },
  'gpt-5.2-pro': { context: 400_000, vision: true, tools: true, levels: PRO },
  'gpt-5.1': { context: 400_000, vision: true, tools: true, levels: ['none', 'low', 'medium', 'high'], default: 'none' },
  'gpt-5': { context: 400_000, vision: true, tools: true, levels: ['minimal', 'low', 'medium', 'high'] },
  'gpt-5-mini': { context: 400_000, vision: true, tools: true, levels: UNSTATED },
  'gpt-5-nano': { context: 400_000, vision: true, tools: true, levels: UNSTATED },
  'gpt-5-pro': { context: 400_000, vision: true, tools: true, levels: ['high'], default: 'high' },
  'chat-latest': { context: 400_000, vision: true, tools: true, levels: [] },
  o3: { context: 200_000, vision: true, tools: true, levels: UNSTATED },
  'o3-pro': { context: 200_000, vision: true, tools: true, levels: UNSTATED },
  'o4-mini': { context: 200_000, vision: true, tools: true, levels: UNSTATED },
  'o3-mini': { context: 200_000, vision: false, tools: true, levels: UNSTATED },
  o1: { context: 200_000, vision: true, tools: true, levels: UNSTATED },
  'o1-mini': { context: 128_000, vision: false, tools: false, levels: UNSTATED },
  'gpt-4.1': { context: 1_047_576, vision: true, tools: true, levels: [] },
  'gpt-4.1-mini': { context: 1_047_576, vision: true, tools: true, levels: [] },
  'gpt-4.1-nano': { context: 1_047_576, vision: true, tools: true, levels: [] },
  'gpt-4o': { context: 128_000, vision: true, tools: true, levels: [] },
  'gpt-4o-mini': { context: 128_000, vision: true, tools: true, levels: [] },
  'chatgpt-4o-latest': { context: 128_000, vision: true, tools: false, levels: [] },
  'gpt-4-turbo': { context: 128_000, vision: true, tools: true, levels: [] },
};

/** "gpt-6.1-terra-2026-10-01" → the facts of gpt-6.1-terra (OpenAI snapshots carry a date). */
export function openaiInfo(model: string): (Partial<ModelInfo> & { reasoningLevels: Effort[] | undefined; defaultReasoning?: Effort }) | null {
  const id = String(model || '').replace(/^openai\//, '').replace(/-\d{4}-\d{2}-\d{2}$/, '');
  const row = Object.hasOwn(OPENAI, id) ? OPENAI[id] : null;
  if (!row) return null;
  // A level list the model page does not state: models.dev's, when it has one.
  const levels = row.levels ?? knownEfforts(catalogInfo('openai', id)?.e);
  return { context: row.context, vision: row.vision, tools: row.tools, reasoningLevels: levels, defaultReasoning: row.default, capSource: `${OPENAI_SRC}/${id}`, capChecked: OPENAI_CHECKED };
}

/** Effort values TeamBot knows, in its order; undefined when none are left. */
function knownEfforts(values: string[] | undefined, allowed?: readonly string[]): Effort[] | undefined {
  if (!values?.length) return undefined;
  const out = EFFORT_ORDER.filter((l) => values.includes(l) && (!allowed || allowed.includes(l)));
  return out.length ? out : undefined;
}

/** OpenAI's own families: reasoning models take low…high, the 4-series does not reason. */
function openaiLevels(model: string): Effort[] | undefined {
  if (/^(gpt-4|gpt-3|chatgpt-4|o1-mini)/.test(model)) return [];
  if (/^(gpt-5|gpt-6|o[1-9])/.test(model)) return ['low', 'medium', 'high'];
  return undefined;
}

/**
 * Thinking levels for one model on one engine. [] = the model cannot be steered (no choice shown); undefined =
 * unknown (TeamBot offers the common levels and drops the setting when the model refuses it).
 */
export function reasoningLevels(kind: string, style: string | null | undefined, m: ModelInfo): Effort[] | undefined {
  if (Array.isArray(m.reasoningLevels)) return m.reasoningLevels as Effort[];
  if (kind === 'claude-code' || kind === 'anthropic' || kind === 'bedrock' || kind === 'vertex' || /claude/.test(m.id)) {
    const c = claudeInfo(m.id);
    const lv = c?.reasoningLevels as Effort[] | undefined;
    if (lv) return kind === 'claude-code' || kind === 'anthropic' ? lv : lv.filter((l) => (STYLE_LEVELS[style || ''] || ALL5).includes(l));
  }
  if (!style || style === 'none') return kind === 'claude-code' ? undefined : [];
  if (m.reasoning === false) return [];
  if (kind === 'openai') {
    // The model page's own reasoning.effort values (the Responses route sends all of them, xhigh and max included).
    const t = openaiInfo(m.id)?.reasoningLevels;
    if (t) return t;
  }
  if (kind === 'openai' || kind === 'azure') {
    const o = openaiLevels(m.id);
    if (o) return o;
  }
  const base = STYLE_LEVELS[style];
  if (!base) return undefined;
  return m.reasoning === true ? base : undefined;
}

/** A level the model takes: the nearest lower one it supports (xhigh on Opus 4.6 → high), else undefined. */
export function clampEffort(levels: readonly string[] | undefined, effort: string | undefined): string | undefined {
  if (!effort || !levels) return effort;
  if (!levels.length) return undefined;
  if (levels.includes(effort)) return effort;
  const i = EFFORT_ORDER.indexOf(effort as Effort);
  for (let j = i - 1; j >= 0; j--) if (levels.includes(EFFORT_ORDER[j])) return EFFORT_ORDER[j];
  return levels[0];
}

/** Fill tools/vision/context/levels from the table where the engine's own list says nothing. */
export function withCapabilities(kind: string, style: string | null | undefined, m: ModelInfo): ModelInfo {
  const out: ModelInfo = { ...m };
  const c = kind === 'claude-code' || kind === 'anthropic' || /claude/.test(m.id) ? claudeInfo(m.id) : null;
  if (c) {
    if (out.context === undefined) out.context = c.context;
    if (out.vision === undefined) out.vision = c.vision;
    if (out.tools === undefined) out.tools = c.tools;
    if (!out.capSource) {
      out.capSource = c.capSource;
      out.capChecked = c.capChecked;
    }
    if (out.defaultReasoning === undefined) out.defaultReasoning = c.defaultReasoning;
  }
  const o = kind === 'openai' ? openaiInfo(m.id) : null;
  if (o) {
    if (out.context === undefined) out.context = o.context;
    if (out.vision === undefined) out.vision = o.vision;
    if (out.tools === undefined) out.tools = o.tools;
    if (!out.capSource) {
      out.capSource = o.capSource;
      out.capChecked = o.capChecked;
    }
    if (out.defaultReasoning === undefined && o.defaultReasoning) out.defaultReasoning = o.defaultReasoning;
    if (out.reasoning === undefined && o.reasoningLevels) out.reasoning = o.reasoningLevels.length > 0;
  }
  // models.dev for what is still unknown (its date is shown as the source when nothing else gave one).
  const cat = catalogInfo(kind, m.id);
  if (cat) {
    const before = [out.context, out.vision, out.tools, out.reasoning].filter((x) => x === undefined).length;
    if (out.context === undefined && cat.c) out.context = cat.c;
    if (out.vision === undefined && cat.v !== undefined) out.vision = cat.v;
    if (out.tools === undefined && cat.t !== undefined) out.tools = cat.t;
    if (out.reasoning === undefined && cat.r !== undefined) out.reasoning = cat.r;
    const filled = before > [out.context, out.vision, out.tools, out.reasoning].filter((x) => x === undefined).length;
    if (filled && !out.capSource) {
      out.capSource = 'models.dev';
      out.capChecked = cat.checked;
    }
  }
  let levels = reasoningLevels(kind, style, out);
  // The effort values models.dev lists, limited to what this provider's request format can carry.
  if (!levels && cat?.e && style && STYLE_LEVELS[style] && out.reasoning !== false) levels = knownEfforts(cat.e, STYLE_LEVELS[style]);
  if (levels) out.reasoningLevels = levels;
  return out;
}
