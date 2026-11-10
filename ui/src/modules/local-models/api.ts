import { api } from '../../lib/api';

/** Mirrors server/modules/local-models (LocalModelsView). */

export type Fit = 'fits' | 'slow' | 'too_big';
export type FitWhy = 'gpu' | 'partly_cpu' | 'no_gpu' | 'too_big' | 'loaded_gpu' | 'loaded_partly' | 'loaded_cpu';
export type ProbeVerdict = 'tools' | 'text' | 'unreliable' | 'error';
export type ProbeDetail = 'ok' | 'as_text' | 'no_call' | 'wrong_call' | 'no_tools' | 'jinja' | 'error';
export type GpuVendor = 'nvidia' | 'amd' | 'intel' | 'apple' | 'other';

export interface Gpu {
  name: string;
  vendor: GpuVendor;
  vram: number | null;
  exact: boolean;
  dedicated: boolean;
  driver?: string;
}

export interface Hardware {
  platform: string;
  ram: number;
  ramFree: number;
  cpu: string;
  cores: number;
  gpus: Gpu[];
  unified: boolean;
  sources: string[];
  checkedAt: string;
}

export interface Probe {
  verdict: ProbeVerdict;
  detail: ProbeDetail;
  message?: string;
  at: string;
  ms: number;
  where?: 'loaded' | 'gpu' | 'cpu';
}

export interface InstalledModel {
  id: string;
  size: number;
  params?: string;
  quant?: string;
  tools?: boolean;
  vision?: boolean;
  thinking?: boolean;
  context: number;
  need: number;
  fit: Fit;
  why: FitWhy;
  loaded?: { placement: 'gpu' | 'partly' | 'cpu'; context: number; size: number; sizeVram: number };
  probe: Probe | null;
  toolsKnown: 'yes' | 'no' | 'unknown';
}

export interface CatalogModel {
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

export interface PullState {
  model: string;
  status: string;
  completed: number;
  total: number;
  done: boolean;
  ok?: boolean;
  error?: string;
  cancelled?: boolean;
  startedAt: string;
}

export interface CpuWarning {
  model: string;
  gpu: string;
  vendor: GpuVendor;
  driverUrl: string | null;
}

export interface OtherServer {
  providerId: string;
  name: string;
  kind: string;
  models: { id: string; probe: Probe | null; tools?: boolean }[];
  error?: string;
}

export interface LocalModelsView {
  allowed: boolean;
  hardware: Hardware | null;
  budget: { vram: number; ram: number; gpu: string | null } | null;
  ollama: { running: boolean; base: string; version?: string; providerId: string | null; local: boolean; defaultModel?: string };
  installed: InstalledModel[];
  catalog: CatalogModel[];
  catalogChecked: string;
  catalogSource: string;
  recommended: { id: string; installed: boolean } | null;
  cpuWarning: CpuWarning | null;
  pulls: PullState[];
  others: OtherServer[];
  diskFree: number | null;
}

export const localModelsApi = {
  view: (refresh = false) => api.get<LocalModelsView>(`/local-models${refresh ? '?refresh=1' : ''}`),
  pull: (model: string) => api.post<{ started: boolean; pulls: PullState[] }>('/local-models/pull', { model }),
  cancel: (model: string) => api.post<{ cancelled: boolean }>('/local-models/pull/cancel', { model }),
  probe: (model: string, providerId?: string) => api.post<Probe>('/local-models/probe', { model, providerId }),
  use: (model: string) => api.post<{ providerId: string; model: string }>('/local-models/use', { model }),
};
