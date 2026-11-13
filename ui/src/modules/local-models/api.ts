import { api } from '../../lib/api';
import type { LocalModelsView, ProbeView, PullState } from '../../../../shared/localModels.js';

export const localModelsApi = {
  view: (refresh = false) => api.get<LocalModelsView>(`/local-models${refresh ? '?refresh=1' : ''}`),
  pull: (model: string) => api.post<{ started: boolean; pulls: PullState[] }>('/local-models/pull', { model }),
  cancel: (model: string) => api.post<{ cancelled: boolean }>('/local-models/pull/cancel', { model }),
  probe: (model: string, providerId?: string) => api.post<ProbeView>('/local-models/probe', { model, providerId }),
  use: (model: string) => api.post<{ providerId: string; model: string }>('/local-models/use', { model }),
};
