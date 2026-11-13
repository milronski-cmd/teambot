/**
 * "Lokale modellen op deze pc": the shapes the server works out (server/modules/local-models) and the card on the
 * Providers page shows (ui/src/modules/local-models). Types only.
 */

export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';

export interface Gpu {
  name: string;
  vendor: GpuVendor;
  /** Video memory in bytes; null = unknown. */
  vram: number | null;
  /** The figure is exact (nvidia-smi, the driver's 64-bit value, /sys); false = Windows' 32-bit field (at most 4 GB). */
  exact: boolean;
  /** A video card of its own, not the graphics built into the processor. */
  dedicated: boolean;
  driver?: string;
}

export interface Hardware {
  platform: string;
  /** Bytes. */
  ram: number;
  ramFree: number;
  cpu: string;
  cores: number;
  gpus: Gpu[];
  /** Apple silicon: the GPU uses the main memory. */
  unified: boolean;
  /** Where the video-card facts came from. */
  sources: string[];
  checkedAt: string;
}

export type Fit = 'fits' | 'slow' | 'too_big';
/** Why, in a code the UI turns into words. */
export type FitWhy =
  | 'gpu' // fits in the video card's memory
  | 'partly_cpu' // only with part of it on the processor
  | 'no_gpu' // no usable video card: runs on the processor
  | 'too_big' // more than video memory and working memory together
  | 'loaded_gpu' // Ollama runs it now, all of it on the video card
  | 'loaded_partly' // Ollama runs it now, partly on the processor
  | 'loaded_cpu'; // Ollama runs it now, all of it on the processor

/** Does the model really call tools: the local test said so, it failed, or nobody knows yet. */
export type ToolsKnown = 'yes' | 'no' | 'unknown';

/** tools = "tools werken"; text = "alleen tekst"; unreliable = calls a tool, but the wrong one; error = test failed. */
export type ProbeVerdict = 'tools' | 'text' | 'unreliable' | 'error';
export type ProbeDetail =
  | 'ok' // a real tool call, the right one
  | 'as_text' // the call came back as text; TeamBot turns it into a real call
  | 'no_call' // answered in words, no tool
  | 'wrong_call' // called another tool, or without the city
  | 'no_tools' // the server says the model has no tools
  | 'jinja' // llama-server without --jinja
  | 'error';

export interface ProbeOutcome {
  verdict: ProbeVerdict;
  detail: ProbeDetail;
  message?: string;
}

/** Where the tools test ran: on the model as Ollama has it loaded, on the video card, or on the processor. */
export type ProbeWhere = 'loaded' | 'gpu' | 'cpu';

export interface ProbeView extends ProbeOutcome {
  at: string;
  ms: number;
  where?: ProbeWhere;
}

/** Where Ollama runs a loaded model: `ollama ps` says "100% GPU", "48%/52% CPU/GPU" or "100% CPU". */
export type Placement = 'gpu' | 'partly' | 'cpu';

export interface CpuWarning {
  /** The model that runs on the processor. */
  model: string;
  /** The video card this pc has. */
  gpu: string;
  vendor: GpuVendor;
  /** Where the newest driver is. */
  driverUrl: string | null;
}

export interface PullState {
  model: string;
  /** Ollama's last status line ("pulling manifest", "pulling <digest>", "verifying sha256 digest", "success"). */
  status: string;
  completed: number;
  total: number;
  done: boolean;
  ok?: boolean;
  error?: string;
  cancelled?: boolean;
  startedAt: string;
}

export interface InstalledModel {
  id: string;
  size: number;
  params?: string;
  quant?: string;
  /** What Ollama says it can do (undefined = Ollama does not say). */
  tools?: boolean;
  vision?: boolean;
  thinking?: boolean;
  /** The window the advice is for: chosen, loaded now, or TeamBot's 16k. */
  context: number;
  need: number;
  fit: Fit;
  why: FitWhy;
  loaded?: { placement: Placement; context: number; size: number; sizeVram: number };
  probe: ProbeView | null;
  toolsKnown: ToolsKnown;
}

export interface CatalogView {
  id: string;
  params: string;
  size: number;
  moe?: boolean;
  vision?: boolean;
  thinking?: boolean;
  firstBot?: boolean;
  need: number;
  fit: Fit;
  why: FitWhy;
  installed: boolean;
  best?: boolean;
}

export interface OtherServer {
  providerId: string;
  name: string;
  kind: string;
  models: { id: string; probe: ProbeView | null; tools?: boolean }[];
  error?: string;
}

export interface LocalModelsView {
  allowed: boolean;
  hardware: Hardware | null;
  budget: { vram: number; ram: number; gpu: string | null } | null;
  ollama: { running: boolean; base: string; version?: string; providerId: string | null; local: boolean; defaultModel?: string };
  installed: InstalledModel[];
  catalog: CatalogView[];
  catalogChecked: string;
  catalogSource: string;
  recommended: { id: string; installed: boolean } | null;
  cpuWarning: CpuWarning | null;
  pulls: PullState[];
  others: OtherServer[];
  /** Free disk space where Ollama keeps its models (only when Ollama runs on this pc). */
  diskFree: number | null;
}
