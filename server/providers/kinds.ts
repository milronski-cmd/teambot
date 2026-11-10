import type { ProviderAdapter, ProviderConfig, ProviderKind } from '../core/types.js';
import { openaiCompat } from './openai-compat.js';
import { openaiResponses } from './openai-responses.js';
import { anthropicAdapter } from './anthropic.js';
import { bedrockAdapter } from './bedrock.js';
import { projectFromSecret, vertexTokenSource } from './vertex.js';
import { LOCAL_PROBES, localDetect } from './local.js';
import { llamacppAdapter, lmstudioAdapter, ollamaAdapter } from './localmodels.js';
import { ERROR_TEXT, ProviderError } from './common.js';
import { PROVIDERS, type ProviderDef } from './catalog.js';

/** ProviderKind.group (older field, still used for ranking the default engine). */
const GROUP: Record<ProviderDef['section'], NonNullable<ProviderKind['group']>> = { free: 'free', subscription: 'cli', local: 'local', key: 'cloud' };

/** Azure: accept the bare resource URL and add the v1 API path. */
export function azureBase(url: string): string {
  const u = url.trim().replace(/\/+$/, '');
  if (!u) return '';
  if (/\/openai\/v1$/i.test(u)) return u;
  if (/\/openai$/i.test(u)) return u + '/v1';
  if (/\/openai\/deployments\//i.test(u)) return u.replace(/\/openai\/deployments\/.*$/i, '/openai/v1');
  return u + '/openai/v1';
}

/** Vertex AI OpenAI-compatible endpoint for a project + location ("global" uses the global host). */
export function vertexBase(project: string, location: string): string {
  const loc = location || 'global';
  const host = loc === 'global' ? 'aiplatform.googleapis.com' : `${loc}-aiplatform.googleapis.com`;
  return `https://${host}/v1/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(loc)}/endpoints/openapi`;
}

function retiredAdapter(d: ProviderDef): ProviderAdapter {
  const msg = `${d.label} is gestopt op ${d.retired}. ${d.description}`;
  const fail = () => new ProviderError(`${d.label}: ${ERROR_TEXT.endpoint.title} — ${msg}`, 410, false, '', 'endpoint');
  return {
    kind: d.id,
    async listModels() {
      throw fail();
    },
    async test() {
      return { ok: false, detail: msg, hint: 'Ontkoppel deze provider en kies een andere; stel bij je bots een reserve-engine in.', category: 'endpoint' };
    },
    async chat() {
      throw fail();
    },
  };
}

function compatFor(d: ProviderDef, cfg: ProviderConfig, key: string | null, baseUrl: string, extra: Partial<Parameters<typeof openaiCompat>[0]> = {}): ProviderAdapter {
  return openaiCompat({
    kind: d.id,
    label: cfg.name || d.label,
    baseUrl,
    key,
    headers: { ...(d.headers || {}), ...(cfg.config?.headers || {}) },
    usageInStream: cfg.config?.usageInStream ?? d.usageInStream,
    reasoning: d.reasoning ?? (cfg.config?.reasoning ? 'effort' : null),
    modelFilter: d.modelFilter,
    staticModels: d.models,
    apiKeyHeader: cfg.config?.apiKeyHeader,
    parseModel: d.parseModel || undefined,
    listModels: d.listModels,
    keyCheck: d.keyCheck,
    publicModelList: d.publicModelList,
    replayReasoning: d.replayReasoning,
    maxCompletionTokens: d.maxCompletionTokens,
    extraBody: d.extraBody,
    keyUrl: d.keyUrl,
    answerCheck: d.answerCheck,
    ...extra,
  });
}

/** Adapter factory for one catalogue entry; `more` = extra adapter options a module adds (free-models: onResponse). */
export function createFor(d: ProviderDef, more: Partial<Parameters<typeof openaiCompat>[0]> = {}) {
  return (cfg: ProviderConfig, key: string | null): ProviderAdapter => {
    if (d.retired) return retiredAdapter(d);
    switch (d.adapter) {
      case 'anthropic':
        return anthropicAdapter({ key, baseUrl: cfg.base_url && cfg.base_url !== d.baseUrl ? cfg.base_url : undefined, label: cfg.name, refusalFallback: cfg.config?.refusalFallback, keyUrl: d.keyUrl });
      case 'bedrock':
        return bedrockAdapter({ label: cfg.name || d.label, region: String(cfg.config?.region || 'us-east-1'), secret: key, keyUrl: d.keyUrl });
      case 'azure':
        return compatFor(d, cfg, key, azureBase(cfg.base_url), { apiKeyHeader: cfg.config?.apiKeyHeader || 'api-key' });
      case 'cloudflare': {
        const account = String(cfg.config?.accountId || '').trim();
        if (!/^[a-f0-9]{32}$/i.test(account)) return badConfig(d, 'Vul je Cloudflare Account-ID in (32 tekens, staat in het dashboard bij Workers AI).');
        return compatFor(d, cfg, key, d.baseUrl.replace('{account}', account), more);
      }
      case 'vertex': {
        const project = String(cfg.config?.project || '').trim() || projectFromSecret(key) || '';
        if (!/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/.test(project)) return badConfig(d, 'Vul het Project-ID van je Google Cloud-project in (of plak een service-account-JSON waar het in staat).');
        const location = String(cfg.config?.location || 'global').trim();
        if (!/^[a-z0-9-]{2,30}$/.test(location)) return badConfig(d, 'Ongeldige Vertex-locatie (bijv. global of europe-west4).');
        let token: () => Promise<string>;
        try {
          token = vertexTokenSource(key, { label: cfg.name || d.label });
        } catch (e: any) {
          return badConfig(d, e?.message || String(e));
        }
        return compatFor(d, cfg, null, vertexBase(project, location), { key: token });
      }
      default: {
        const compat = compatFor(d, cfg, key, cfg.base_url || d.baseUrl, more);
        // OpenAI: chat via the Responses API (tools together with reasoning); config.api = "chat" forces Chat Completions.
        if (d.id === 'openai' && cfg.config?.api !== 'chat') return openaiResponses({ label: cfg.name || d.label, baseUrl: cfg.base_url || d.baseUrl, key, fallback: compat });
        // Local servers: model abilities from the server itself, and the context window per model (C-01, C-13).
        if (d.id === 'ollama') return ollamaAdapter(compat, { base: cfg.base_url || d.baseUrl, label: cfg.name || d.label, config: cfg.config });
        if (d.id === 'lmstudio') return lmstudioAdapter(compat, { base: cfg.base_url || d.baseUrl, config: cfg.config });
        if (d.id === 'llamacpp') return llamacppAdapter(compat, { base: cfg.base_url || d.baseUrl });
        return compat;
      }
    }
  };
}

/** A provider that is missing a required setting: every call explains what to fill in. */
function badConfig(d: ProviderDef, why: string): ProviderAdapter {
  const err = () => new ProviderError(`${d.label}: ${why}`, 400, false, '', 'bad_request');
  return {
    kind: d.id,
    async listModels() {
      throw err();
    },
    async test() {
      return { ok: false, detail: why, hint: 'Vul de ontbrekende instelling in via "Bewerken" en test opnieuw.', category: 'bad_request' };
    },
    async chat() {
      throw err();
    },
  };
}

export function kindFromDef(d: ProviderDef): ProviderKind {
  const probe = d.section === 'local' ? LOCAL_PROBES[d.id] : undefined;
  return {
    id: d.id,
    label: d.label,
    type: 'api',
    group: d.id === 'openai-compatible' ? 'custom' : GROUP[d.section],
    section: d.section,
    baseUrl: d.baseUrl,
    needsKey: d.needsKey,
    keyOptional: d.keyOptional,
    keyUrl: d.keyUrl,
    keyPlaceholder: d.keyPlaceholder,
    keyLabel: d.keyLabel,
    description: d.description,
    billingNote: d.billingNote,
    costNote: d.costNote,
    costCheckedAt: d.costCheckedAt,
    pricingUrl: d.pricingUrl,
    reasoningStyle: d.reasoning || null,
    fields: d.fields,
    experimental: d.experimental,
    retired: d.retired,
    billing: d.section === 'local' ? 'local' : d.section === 'free' ? 'free' : d.id === 'openai-compatible' ? undefined : 'paid',
    models: d.models,
    recommend: d.recommend,
    defaultModel: typeof d.recommend?.[0] === 'string' && d.models?.includes(d.recommend[0]) ? d.recommend[0] : undefined,
    create: createFor(d),
    detect: probe ? localDetect(d.id, [d.baseUrl, ...(d.altBases || [])]) : undefined,
  } as ProviderKind;
}

export function builtinKinds(): ProviderKind[] {
  return PROVIDERS.map(kindFromDef);
}
