import { PLAN_WINDOW } from '../../providers/localmodels.js';
import type { Fit, FitWhy, Gpu, Hardware, ToolsKnown } from '../../../shared/localModels.js';

/**
 * Does a model fit this pc? Like LM Studio's "fits / too large" before a download, plus "works slowly" for a model
 * that only fits when part of it runs on the processor. Pure functions over the hardware and the model's size.
 *
 * Memory a model needs = its weights (≈ the download) + the KV cache for the context window TeamBot plans with
 * (16,384 tokens: below that a bot with tools and instructions runs out of room) + a small working buffer.
 */

export const GiB = 1024 ** 3;
/** The window TeamBot plans with: the one it gives a local model by itself (providers/localmodels.ts, autoWindow). */
export const PLAN_CONTEXT = PLAN_WINDOW;
/** KV-cache bytes per token when a model's layout is unknown: typical for 7–14B models with 8 kv-heads. */
export const KV_FALLBACK = 131072;

export interface Budget {
  /** The card TeamBot plans with (the one with the most memory), or null. */
  gpu: Gpu | null;
  /** Usable video memory, bytes. */
  vram: number;
  /** Working memory that can take the rest of a model (slowly), bytes. */
  ram: number;
}

/** What this pc can give a local model. */
export function budget(hw: Hardware): Budget {
  if (hw.unified) {
    // Apple silicon: macOS lets the GPU use about two thirds of the memory (three quarters above 36 GB).
    const vram = Math.max(0, hw.ram * (hw.ram > 36 * GiB ? 0.75 : 0.66) - 2 * GiB);
    return { gpu: hw.gpus[0] ?? null, vram, ram: Math.max(0, hw.ram * 0.8 - 2 * GiB - vram) };
  }
  const cards = hw.gpus.filter((g) => g.dedicated && (g.vram ?? 0) >= 1.5 * GiB).sort((a, b) => (b.vram ?? 0) - (a.vram ?? 0));
  const gpu = cards[0] ?? null;
  // The screen, the desktop and the driver keep some video memory; Windows and apps keep some working memory.
  return { gpu, vram: gpu ? Math.max(0, (gpu.vram ?? 0) - 0.5 * GiB) : 0, ram: Math.max(0, hw.ram * 0.75 - 2 * GiB) };
}

/** Bytes a model needs with a context window of `context` tokens. */
export function memoryNeed(o: { weights: number; kvPerToken?: number; context?: number }): number {
  const ctx = o.context || PLAN_CONTEXT;
  return Math.round(o.weights + (o.kvPerToken || KV_FALLBACK) * ctx + 0.25 * GiB + o.weights * 0.02);
}

export function fitFor(b: Budget, need: number): { fit: Fit; why: FitWhy } {
  if (b.vram > 0 && need <= b.vram) return { fit: 'fits', why: 'gpu' };
  if (need <= b.vram + b.ram) return { fit: 'slow', why: b.vram > 0 ? 'partly_cpu' : 'no_gpu' };
  return { fit: 'too_big', why: 'too_big' };
}

/** A model Ollama has loaded now: what it really uses beats the estimate. */
export function fitLoaded(size: number, sizeVram: number): { fit: Fit; why: FitWhy } {
  if (size > 0 && sizeVram >= size * 0.98) return { fit: 'fits', why: 'loaded_gpu' };
  return { fit: 'slow', why: sizeVram > 0 ? 'loaded_partly' : 'loaded_cpu' };
}

export interface Candidate {
  id: string;
  fit: Fit;
  tools: ToolsKnown;
  /** Weights in bytes: within what fits, bigger is smarter. */
  size: number;
  loaded?: boolean;
  /** A good all-round first bot (TeamBot's short list, catalog.ts), also when it is installed already. */
  firstBot?: boolean;
  /** Fits in video memory with room to spare (the estimate is a lower bound: Ollama needs more for its buffers). */
  roomy?: boolean;
}

/** Share of the video memory a model may take to count as running well (the rest is margin for the estimate). */
export const ROOMY = 0.85;

/** Fits on the video card with room to spare. */
export const roomyFor = (b: Budget, need: number) => b.vram > 0 && need <= b.vram * ROOMY;

/** Sizes within 2% are the same model in another wrapper (a copy under another name differs by a few bytes). */
const sizeOrder = (a: Candidate, b: Candidate) => (Math.abs(a.size - b.size) <= 0.02 * Math.max(a.size, b.size) ? 0 : b.size - a.size);

/** Biggest first; same size: the one loaded now, then a known tool user, then the shorter (plain Ollama) name. */
const byBest = (a: Candidate, b: Candidate) =>
  sizeOrder(a, b) || Number(!!b.loaded) - Number(!!a.loaded) || Number(b.tools === 'yes') - Number(a.tools === 'yes') || a.id.length - b.id.length || a.id.localeCompare(b.id);

/** The best download for this pc: the biggest first-bot model that fits; with nothing that fits the smallest one. */
export function bestDownload(catalog: Candidate[]): Candidate | null {
  const list = catalog.filter((c) => c.firstBot && c.tools !== 'no');
  const fits = list.filter((c) => c.fit === 'fits').sort(byBest);
  if (fits.length) return fits[0];
  const slow = list.filter((c) => c.fit === 'slow').sort((a, b) => a.size - b.size);
  return slow[0] ?? null;
}

/**
 * The installed model a new connection starts on: one that runs well on this pc, never the biggest by default.
 * 1. What was used last: a model Ollama runs now, all of it on the video card.
 * 2. Else one that fits in video memory with room to spare: a good all-rounder from TeamBot's list first (the biggest
 *    of those), else the biggest that fits that way.
 * 3. Else (no video card, or nothing fits with room) the smallest that runs at all, an all-rounder first: the smallest
 *    answers fastest on the processor.
 * Never a model that is too big or that cannot use tools. Null when no installed model can be used.
 */
export function pickInstalled(installed: Candidate[]): Candidate | null {
  const usable = installed.filter((c) => c.tools !== 'no' && c.fit !== 'too_big');
  const loaded = usable.filter((c) => c.loaded && c.fit === 'fits').sort(byBest);
  if (loaded.length) return loaded[0];
  const well = usable.filter((c) => c.fit === 'fits' && c.roomy).sort(byBest);
  const allround = well.filter((c) => c.firstBot);
  if (allround.length || well.length) return (allround[0] || well[0])!;
  const small = (a: Candidate, b: Candidate) => Number(!!b.firstBot) - Number(!!a.firstBot) || a.size - b.size || a.id.length - b.id.length;
  return usable.sort(small)[0] ?? null;
}

/**
 * One model for a first bot on Ollama. An installed model that runs well goes first (it answers at once, see
 * pickInstalled). Else the best download that fits. Else an installed model that runs at all, else the smallest
 * download. Never a model that is too big or that cannot use tools.
 */
export function recommend(installed: Candidate[], catalog: Candidate[]): { id: string; installed: boolean } | null {
  const pick = pickInstalled(installed);
  if (pick && pick.fit === 'fits' && (pick.loaded || pick.roomy)) return { id: pick.id, installed: true };
  const best = bestDownload(catalog.filter((c) => !installed.some((i) => i.id === c.id)));
  if (best?.fit === 'fits') return { id: best.id, installed: false };
  if (pick) return { id: pick.id, installed: true };
  return best ? { id: best.id, installed: false } : null;
}
