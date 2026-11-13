/**
 * Finding local model servers on their default ports. Several servers share a port (llama.cpp and LocalAI on 8080,
 * vLLM and Lemonade on 8000), so each probe checks a fingerprint endpoint that only that server answers.
 */
import { originOf } from './localmodels.js';

export interface LocalProbe {
  /** OpenAI-compatible base URL TeamBot talks to. */
  baseUrl: string;
  /** Fingerprint check; resolves with a version string when it is this server, null otherwise. */
  identify(base: string): Promise<{ version?: string } | null>;
}

async function getJson(url: string, timeoutMs = 1500): Promise<{ status: number; json: any } | null> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), redirect: 'error' });
    let json: any = null;
    try {
      json = await r.json();
    } catch {
      /* not json */
    }
    return { status: r.status, json };
  } catch {
    return null;
  }
}

const modelsOk = (r: { status: number; json: any } | null) => !!r && r.status === 200 && (Array.isArray(r.json?.data) || Array.isArray(r.json?.models) || Array.isArray(r.json));
const ownedBy = (r: { json: any } | null) => (Array.isArray(r?.json?.data) ? r!.json.data.map((m: any) => String(m?.owned_by || '')) : []);

export const LOCAL_PROBES: Record<string, LocalProbe> = {
  ollama: {
    baseUrl: 'http://127.0.0.1:11434/v1',
    async identify(base) {
      const v = await getJson(originOf(base) + '/api/version');
      return v?.status === 200 && typeof v.json?.version === 'string' ? { version: v.json.version } : null;
    },
  },
  lmstudio: {
    baseUrl: 'http://127.0.0.1:1234/v1',
    async identify(base) {
      // LM Studio's own REST API (/api/v1 since 0.4, /api/v0 before); fall back to the OpenAI list.
      for (const p of ['/api/v1/models', '/api/v0/models']) {
        const v = await getJson(originOf(base) + p);
        if (v?.status === 200 && (Array.isArray(v.json?.data) || Array.isArray(v.json?.models))) return {};
      }
      const m = await getJson(base + '/models');
      return modelsOk(m) && (!ownedBy(m).length || ownedBy(m).includes('organization_owner')) ? {} : null;
    },
  },
  llamacpp: {
    baseUrl: 'http://127.0.0.1:9931/v1',
    async identify(base) {
      const props = await getJson(originOf(base) + '/props');
      if (props?.status === 200 && props.json && ('default_generation_settings' in props.json || 'build_info' in props.json || 'n_ctx' in props.json || 'model_path' in props.json))
        return { version: typeof props.json.build_info === 'string' ? props.json.build_info : undefined };
      const m = await getJson(base + '/models');
      return modelsOk(m) && ownedBy(m).includes('llamacpp') ? {} : null;
    },
  },
  localai: {
    baseUrl: 'http://127.0.0.1:8080/v1',
    async identify(base) {
      const o = originOf(base);
      const v = await getJson(o + '/version');
      if (v?.status === 200 && /localai/i.test(JSON.stringify(v.json || ''))) return { version: String(v.json?.version || '').replace(/^LocalAI\s*/i, '') || undefined };
      const sys = await getJson(o + '/system');
      return sys?.status === 200 && sys.json && ('backends' in sys.json || 'loaded_models' in sys.json) ? {} : null;
    },
  },
  vllm: {
    baseUrl: 'http://127.0.0.1:8000/v1',
    async identify(base) {
      const m = await getJson(base + '/models');
      if (!modelsOk(m) || !ownedBy(m).includes('vllm')) return null;
      const v = await getJson(originOf(base) + '/version');
      return { version: typeof v?.json?.version === 'string' ? v.json.version : undefined };
    },
  },
  lemonade: {
    baseUrl: 'http://127.0.0.1:13305/v1',
    async identify(base) {
      const m = await getJson(base + '/models');
      if (modelsOk(m) && ownedBy(m).includes('lemonade')) return {};
      const h = await getJson(base + '/health');
      return h?.status === 200 && h.json && ('model_loaded' in h.json || 'checkpoint_loaded' in h.json || /lemonade/i.test(JSON.stringify(h.json))) ? { version: h.json.version } : null;
    },
  },
  jan: {
    baseUrl: 'http://127.0.0.1:1337/v1',
    async identify(base) {
      const m = await getJson(base + '/models');
      // Jan's local API server can require its own API key: a 401 still means Jan is running.
      return m && (modelsOk(m) || m.status === 401) ? {} : null;
    },
  },
  koboldcpp: {
    baseUrl: 'http://127.0.0.1:5001/v1',
    async identify(base) {
      const v = await getJson(originOf(base) + '/api/extra/version');
      return v?.status === 200 && /kobold/i.test(String(v.json?.result || '')) ? { version: v.json.version } : null;
    },
  },
  'textgen-webui': {
    baseUrl: 'http://127.0.0.1:5000/v1',
    async identify(base) {
      const v = await getJson(base + '/internal/model/info');
      return v?.status === 200 && v.json && 'model_name' in v.json ? {} : null;
    },
  },
  gpt4all: {
    baseUrl: 'http://127.0.0.1:4891/v1',
    async identify(base) {
      return modelsOk(await getJson(base + '/models')) ? {} : null;
    },
  },
};

/** detect() for a local kind: fingerprint at the default address, then at older default addresses. */
export function localDetect(id: string, bases: string[]) {
  const p = LOCAL_PROBES[id];
  return async (): Promise<{ installed: boolean; version?: string; detail: string; baseUrl?: string }> => {
    const list = [...new Set((bases.length ? bases : [p.baseUrl]).map((b) => b.replace(/\/+$/, '')))];
    for (const url of list) {
      const r = await p.identify(url).catch(() => null);
      if (r) return { installed: true, version: r.version, detail: `Server draait op ${url}`, baseUrl: url };
    }
    return { installed: false, detail: `Niet gevonden op ${list.join(' of ')}` };
  };
}
