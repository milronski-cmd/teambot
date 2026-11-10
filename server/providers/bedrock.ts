import type { ChatMsg, ChatRequest, ChatResult, ModelInfo, ProviderAdapter, ProviderTestResult, StreamEvent, ToolCall } from '../core/types.js';
import { EventStreamDecoder, parseBedrockSecret, signV4 } from './aws.js';
import { ProviderError, errorFromResponse, explain, networkError, providerErrorFrom, safeJson } from './common.js';
import { rememberListPrices } from './pricing.js';
import { parseToolArgs } from './tool-args.js';

/**
 * Amazon Bedrock via the Converse / ConverseStream API (one format for Claude, Llama, Mistral, Nova, DeepSeek, Qwen,
 * gpt-oss, ...). Auth: a Bedrock API key (Bearer) or IAM access keys signed with SigV4 — no AWS SDK needed.
 */

export interface BedrockOptions {
  label: string;
  region: string;
  secret: string | null;
  /** Override the endpoints (tests). */
  runtimeUrl?: string;
  controlUrl?: string;
  keyUrl?: string;
}

const IMAGE_FORMATS: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/gif': 'gif', 'image/webp': 'webp' };

export function toConverseMessages(msgs: ChatMsg[]): any[] {
  const out: any[] = [];
  const push = (role: 'user' | 'assistant', blocks: any[]) => {
    if (!blocks.length) return;
    const last = out[out.length - 1];
    if (last && last.role === role) last.content.push(...blocks);
    else out.push({ role, content: [...blocks] });
  };
  const part = (p: any) => (p.type === 'text' ? { text: p.text || ' ' } : IMAGE_FORMATS[p.mime] ? { image: { format: IMAGE_FORMATS[p.mime], source: { bytes: p.data } } } : { text: `[afbeelding ${p.mime}]` });
  for (const m of msgs) {
    if (m.role === 'user') push('user', typeof m.content === 'string' ? (m.content ? [{ text: m.content }] : []) : m.content.map(part));
    else if (m.role === 'assistant') {
      const blocks: any[] = [];
      if (m.raw?.provider === 'bedrock' && Array.isArray(m.raw.data?.reasoning)) blocks.push(...m.raw.data.reasoning);
      const text = typeof m.content === 'string' ? m.content : m.content.map((p) => (p.type === 'text' ? p.text : '')).join('');
      if (text) blocks.push({ text });
      for (const c of m.toolCalls || []) blocks.push({ toolUse: { toolUseId: c.id, name: c.name, input: c.args ?? {} } });
      push('assistant', blocks);
    } else if (m.role === 'tool') {
      const content = typeof m.content === 'string' ? [{ text: m.content || '(leeg)' }] : m.content.map(part);
      push('user', [{ toolResult: { toolUseId: m.toolCallId, content, ...(m.isError ? { status: 'error' } : {}) } }]);
    }
  }
  if (out.length && out[0].role !== 'user') out.unshift({ role: 'user', content: [{ text: '(vervolg van eerder gesprek)' }] });
  return out;
}

export function bedrockAdapter(o: BedrockOptions): ProviderAdapter {
  const region = (o.region || 'us-east-1').trim();
  if (!/^[a-z]{2}(-gov)?-[a-z]+-\d$/.test(region)) throw new ProviderError(`${o.label}: ongeldige regio "${region}" (bijv. eu-central-1)`, 0, false, '', 'bad_request');
  const runtime = o.runtimeUrl || `https://bedrock-runtime.${region}.amazonaws.com`;
  const control = o.controlUrl || `https://bedrock.${region}.amazonaws.com`;
  const auth = o.secret ? parseBedrockSecret(o.secret) : null;

  async function request(url: string, service: string, method: string, body: any, signal?: AbortSignal): Promise<Response> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    let headers: Record<string, string> = { 'content-type': 'application/json', accept: 'application/json' };
    if (!auth) throw new ProviderError(`${o.label}: geen sleutel ingesteld`, 401, false, '', 'auth');
    if ('bearer' in auth) headers.authorization = `Bearer ${auth.bearer}`;
    else headers = signV4({ method, url, headers, body: payload }, auth.creds, region, service);
    try {
      return await fetch(url, { method, headers, body: payload, signal, redirect: 'error' });
    } catch (e: any) {
      if (signal?.aborted) throw e;
      throw networkError(o.label, e);
    }
  }

  async function getJson(url: string): Promise<any> {
    const ctl = AbortSignal.timeout(15_000);
    const res = await request(url, 'bedrock', 'GET', undefined, ctl);
    if (!res.ok) throw await errorFromResponse(res, o.label);
    return res.json();
  }

  async function listModels(): Promise<ModelInfo[]> {
    const [fm, ip] = await Promise.all([getJson(`${control}/foundation-models?byOutputModality=TEXT`), getJson(`${control}/inference-profiles?typeEquals=SYSTEM_DEFINED&maxResults=1000`).catch(() => ({ inferenceProfileSummaries: [] }))]);
    const out: ModelInfo[] = [];
    const seen = new Set<string>();
    const summaries: any[] = fm.modelSummaries || [];
    const byId = new Map(summaries.map((m) => [m.modelId, m]));
    for (const p of ip.inferenceProfileSummaries || []) {
      if (p.status && p.status !== 'ACTIVE') continue;
      const id = String(p.inferenceProfileId || '');
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const base = byId.get(String(p.models?.[0]?.modelArn || '').split('/').pop());
      out.push({ id, label: p.inferenceProfileName, vision: base ? (base.inputModalities || []).includes('IMAGE') : undefined, tools: true });
    }
    for (const m of summaries) {
      if (m.modelLifecycle?.status && m.modelLifecycle.status !== 'ACTIVE') continue;
      if (!(m.inferenceTypesSupported || []).includes('ON_DEMAND')) continue; // only reachable via an inference profile
      if (m.responseStreamingSupported === false) continue;
      if (/embed|rerank|image|canvas|reel|sonic|titan-tg1/i.test(m.modelId)) continue;
      if (seen.has(m.modelId)) continue;
      seen.add(m.modelId);
      out.push({ id: m.modelId, label: `${m.providerName ? m.providerName + ' ' : ''}${m.modelName || ''}`.trim() || undefined, vision: (m.inputModalities || []).includes('IMAGE'), tools: true });
    }
    out.sort((a, b) => a.id.localeCompare(b.id));
    rememberListPrices('bedrock', out);
    return out;
  }

  async function chat(req: ChatRequest, signal: AbortSignal, onEvent: (e: StreamEvent) => void): Promise<ChatResult> {
    const body: any = {
      messages: toConverseMessages(req.messages),
      inferenceConfig: { maxTokens: req.maxTokens ?? 8192 },
    };
    if (req.system) body.system = [{ text: req.system }];
    if (req.tools.length) body.toolConfig = { tools: req.tools.map((t) => ({ toolSpec: { name: t.name, description: t.description || t.name, inputSchema: { json: t.parameters } } })) };
    const url = `${runtime}/model/${encodeURIComponent(req.model)}/converse-stream`;
    const res = await request(url, 'bedrock', 'POST', body, signal);
    if (!res.ok) throw await errorFromResponse(res, o.label);
    if (!res.body) throw new ProviderError(`${o.label}: leeg antwoord`, res.status, true, '', 'overloaded');

    let text = '';
    let reasoning = '';
    let stopReason = '';
    const usage = { input: 0, output: 0, cacheRead: 0 };
    const blocks = new Map<number, { kind: 'text' | 'tool' | 'reasoning'; id?: string; name?: string; input?: string; text?: string; signature?: string }>();
    const dec = new EventStreamDecoder();
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      for (const msg of dec.push(value)) {
        const type = String(msg.headers[':message-type'] || 'event');
        const j = safeJson(msg.payload.toString('utf8')) || {};
        if (type === 'exception' || type === 'error') {
          const name = String(msg.headers[':exception-type'] || msg.headers[':error-code'] || 'Exception');
          const status = /throttl/i.test(name) ? 429 : /serviceUnavailable|modelNotReady/i.test(name) ? 503 : /validation/i.test(name) ? 400 : /accessDenied/i.test(name) ? 403 : 500;
          throw providerErrorFrom(o.label, status, JSON.stringify({ __type: name.replace(/^./, (c) => c.toUpperCase()), code: name, message: j.message || j.Message || msg.payload.toString('utf8') }));
        }
        const ev = String(msg.headers[':event-type'] || '');
        if (ev === 'contentBlockStart') {
          const tu = j.start?.toolUse;
          if (tu) {
            blocks.set(j.contentBlockIndex, { kind: 'tool', id: tu.toolUseId, name: tu.name, input: '' });
            onEvent({ type: 'tool_start', id: tu.toolUseId, name: tu.name });
          }
        } else if (ev === 'contentBlockDelta') {
          const d = j.delta || {};
          const idx = j.contentBlockIndex ?? 0;
          if (typeof d.text === 'string') {
            text += d.text;
            onEvent({ type: 'text', delta: d.text });
          } else if (d.toolUse) {
            const b = blocks.get(idx) || { kind: 'tool' as const, input: '' };
            b.input = (b.input || '') + (d.toolUse.input || '');
            blocks.set(idx, b);
          } else if (d.reasoningContent) {
            const b = blocks.get(idx) || { kind: 'reasoning' as const, text: '' };
            if (typeof d.reasoningContent.text === 'string') {
              b.text = (b.text || '') + d.reasoningContent.text;
              reasoning += d.reasoningContent.text;
              onEvent({ type: 'reasoning', delta: d.reasoningContent.text });
            }
            if (d.reasoningContent.signature) b.signature = d.reasoningContent.signature;
            blocks.set(idx, b);
          }
        } else if (ev === 'messageStop') stopReason = j.stopReason || '';
        else if (ev === 'metadata') {
          const u = j.usage || {};
          usage.input = (u.inputTokens || 0) + (u.cacheReadInputTokens || 0) + (u.cacheWriteInputTokens || 0);
          usage.output = u.outputTokens || 0;
          usage.cacheRead = u.cacheReadInputTokens || 0;
        }
      }
    }
    const toolCalls: ToolCall[] = [];
    const reasoningBlocks: any[] = [];
    for (const [, b] of [...blocks.entries()].sort((a, b) => a[0] - b[0])) {
      if (b.kind === 'tool' && b.name) {
        toolCalls.push({ id: b.id || `call_${toolCalls.length}`, name: b.name, args: parseToolArgs(b.input) });
      } else if (b.kind === 'reasoning' && b.text) reasoningBlocks.push({ reasoningContent: { reasoningText: { text: b.text, ...(b.signature ? { signature: b.signature } : {}) } } });
    }
    const result: ChatResult = {
      text,
      reasoning: reasoning || undefined,
      toolCalls,
      usage,
      model: req.model,
      stop: toolCalls.length ? 'tool_use' : stopReason === 'max_tokens' ? 'max_tokens' : /guardrail|content_filtered/.test(stopReason) ? 'refusal' : 'end',
    };
    // Signed reasoning goes back unchanged on the next tool turn (Claude on Bedrock requires it).
    if (reasoningBlocks.length && toolCalls.length && reasoningBlocks.every((b) => b.reasoningContent.reasoningText.signature)) result.raw = { provider: 'bedrock', data: { reasoning: reasoningBlocks } };
    return result;
  }

  return {
    kind: 'bedrock',
    listModels,
    async test(): Promise<ProviderTestResult> {
      try {
        const m = await listModels();
        // A whole text per count ("1 model", never "1 modellen").
        return { ok: true, verified: true, detail: m.length === 1 ? `Sleutel werkt — 1 model in ${region}` : `Sleutel werkt — ${m.length} modellen in ${region}` };
      } catch (e: any) {
        const x = explain(e, { keyUrl: o.keyUrl });
        return { ok: false, detail: e?.message || String(e), hint: x.category === 'forbidden' ? `${x.hint} Bedrock: geef de sleutel het recht bedrock:ListFoundationModels, of zet modeltoegang aan in de Bedrock-console.` : x.hint, category: x.category };
      }
    },
    chat,
  };
}
