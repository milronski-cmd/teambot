/**
 * Shared provider plumbing: one error type with a plain-language category, SSE parsing and JSON fetching.
 *
 * Every adapter turns a failed HTTP call into a ProviderError via `errorFromResponse` (or `providerErrorFrom` for
 * SDK/stream errors). The category decides three things at once: the Dutch message the user sees, the fix hint in
 * "Test verbinding", and which reserve-engine reason the runner uses (limit → reserve, auth → reserve, ...).
 */

/** What went wrong, in terms the user can act on. */
export type ErrorCategory =
  | 'auth' // key invalid or expired
  | 'forbidden' // key valid, but no access (model, region, permission)
  | 'quota' // no credit / balance / spending cap
  | 'rate_limit' // too many requests or tokens per minute/day (incl. free-tier limits)
  | 'context' // conversation too long for this model
  | 'tools' // too long, while the conversation is short: the bot's tools and instructions fill the window (set by the runner)
  | 'template' // the model's chat template refused the messages (a Jinja raise_exception in a local model)
  | 'model' // model does not exist (or not pulled/deployed)
  | 'endpoint' // wrong base URL / path
  | 'overloaded' // provider busy or down (5xx, 529)
  | 'network' // could not reach the server
  | 'refusal' // content filter / safety block
  | 'bad_request' // anything else the server refused
  | 'other';

/** Same reasons the runner understands (server/agent/fallback.ts). */
export type EngineKind = 'limit' | 'auth' | 'outage' | 'unavailable' | 'other';

export const ENGINE_KIND: Record<ErrorCategory, EngineKind> = {
  auth: 'auth',
  forbidden: 'auth',
  quota: 'limit',
  rate_limit: 'limit',
  context: 'other',
  tools: 'other',
  template: 'other',
  model: 'unavailable',
  endpoint: 'unavailable',
  overloaded: 'outage',
  network: 'outage',
  refusal: 'other',
  bad_request: 'other',
  other: 'other',
};

/** Short Dutch title + what to do about it. `{keyUrl}` is filled in when the provider has a key page. */
export const ERROR_TEXT: Record<ErrorCategory, { title: string; fix: string }> = {
  auth: { title: 'Sleutel ongeldig of verlopen', fix: 'Maak een nieuwe API-sleutel aan{keyUrl} en plak hem opnieuw via "Sleutel" (zonder spaties ervoor of erna).' },
  forbidden: { title: 'Geen toegang', fix: 'De sleutel werkt, maar dit account mag dit model of deze dienst niet gebruiken (rechten, land of verificatie). Controleer de instellingen van je account bij de provider of kies een ander model.' },
  quota: { title: 'Geen tegoed', fix: 'Je tegoed of bestedingslimiet is op. Waardeer op of zet betaling aan bij de provider, of kies een gratis model of een reserve-engine.' },
  rate_limit: { title: 'Limiet bereikt (te veel verzoeken)', fix: 'Wacht even en probeer het opnieuw. Met een reserve-engine bij de bot gaat TeamBot vanzelf verder op de reserve.' },
  context: { title: 'Gesprek te lang voor dit model', fix: 'Kies een model met een groter contextvenster, of laat het gesprek samenvatten ("Nu samenvatten").' },
  tools: { title: 'De tools en instructies van deze bot passen niet in het contextvenster', fix: 'Zet minder apps aan voor deze bot, of kies een groter contextvenster bij de provider of een model met meer context. Samenvatten helpt hier niet: het gesprek zelf is nog kort.' },
  template: { title: 'Dit model kan dit gesprek niet verwerken', fix: 'Het chatsjabloon van het model weigert de berichten in deze vorm. Dat gebeurt vaak als het gesprek met tool-uitvoer niet in het contextvenster past. Kies een groter contextvenster bij de provider, begin een nieuw gesprek met een kortere vraag of kies een ander model.' },
  model: { title: 'Model bestaat niet', fix: 'Kies een model uit de lijst van deze provider. Lokaal: download het model eerst (bijv. "ollama pull <model>") of laad het in LM Studio.' },
  endpoint: { title: 'Adres klopt niet', fix: 'Controleer de basis-URL (meestal eindigend op /v1) en of de server dit adres echt aanbiedt.' },
  overloaded: { title: 'Provider overbelast of tijdelijk onbereikbaar', fix: 'Probeer het zo opnieuw. Met een reserve-engine schakelt TeamBot vanzelf over.' },
  network: { title: 'Niet bereikbaar', fix: 'Controleer je internetverbinding. Lokaal: start de server (Ollama, LM Studio, ...) en controleer het adres en de poort.' },
  refusal: { title: 'Geweigerd door het inhoudsfilter', fix: 'De provider blokkeerde dit verzoek. Formuleer het anders of kies een ander model.' },
  bad_request: { title: 'Verzoek geweigerd', fix: 'De provider weigerde het verzoek; zie de melding hierboven.' },
  other: { title: 'Onbekende fout', fix: 'Probeer het opnieuw; blijft het misgaan, download dan het diagnosebestand bij Instellingen › Gegevens.' },
};

export class ProviderError extends Error {
  /** Plain-language category; set by errorFromResponse/categorize. */
  category?: ErrorCategory;
  /** Seconds the provider asked us to wait (Retry-After), when known. */
  retryAfter?: number;
  constructor(message: string, public status = 0, public retryable = false, public body = '', category?: ErrorCategory) {
    super(message);
    if (category) this.category = category;
  }
  /** Reserve-engine reason for the runner (undefined = let the runner decide from status/text). */
  get engineKind(): EngineKind | undefined {
    return this.category ? ENGINE_KIND[this.category] : undefined;
  }
}

/** Classify errors that justify switching to a configured backup engine. */
export function isOutage(e: any): boolean {
  if (e instanceof ProviderError) return e.retryable;
  const status = e?.status ?? e?.statusCode;
  if (typeof status === 'number') return status === 429 || status >= 500 || status === 408;
  const msg = String(e?.message || e);
  return /ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|fetch failed|network|socket hang up|overloaded/i.test(msg);
}

const QUOTA =
  /insufficient[_ ]?(quota|balance|credits?|funds)|exceeded your current quota, please check your plan and billing|credit balance is too low|(not|n't) have (any|enough) credits|no credits|credits? (are )?(exhausted|depleted)|credit limit|payment required|spending limit|billing (hard )?limit|balance is (too low|insufficient)|account balance|arrearage|overdue|余额不足|recharge|monthly included credits|exceeded_current_quota|out of credits|top up|prepaid|credit_balance_exhausted|spend_limit_exceeded|reached your specified (api )?usage limits?|billing_error|payment_required/i;
const RATE = /rate[ _-]?limit|too many requests|throttl|tokens per (minute|day)|requests per (minute|day|second)|per[_ ]?(minute|day)|free[_ ]?tier|try again in|please wait \d|RESOURCE_EXHAUSTED|capacity temporarily|concurrency|quota exceeded for (metric|quota)|daily free allocation|free-models-per-(day|min)/i;
const AUTH =
  /invalid[_ ]?(api[_ -]?key|x-api-key|authentication|token|credentials?|subscription key)|incorrect api key|pass a valid api key|api_key_invalid|api[_ -]?key (is )?(not valid|invalid|missing|required|expired)|no (api key|auth credentials)|authentication[_ ]?(error|fail|required)|unauthori[sz]ed|bad credentials|token (has )?expired|expired token|security token included in the request is invalid|UnrecognizedClient|InvalidSignature|SignatureDoesNotMatch|InvalidApiKey|login fail|令牌|user not found|missing authentication|must be authenticated|authorization (header|token) (is )?(invalid|missing|required)|access denied due to invalid|token非法|认证失败|鉴权失败/i;
const FORBIDDEN = /permission[_ ]?denied|not have (permission|access)|access ?denied|forbidden|not available in your (country|region)|unsupported_country|region (is )?not supported|must verify|organization (must be|is not) verified|not allowed to (use|access)|AccessDeniedException|permission is required/i;
const CONTEXT =
  /context[_ ]?(length|size|window)|maximum context|prompt is too long|input is too long|(exceeds?|exceeded) (the )?(model'?s? )?(maximum|max|available|allowed) (number of )?(context|tokens|input|prompt)|token limit|too large for (the )?model|reduce the length|range of input length|超长|exceed_context_size|request too large|request body too large|input token count|tokens? \+ `?max_new_tokens`? must be|maximum (input|prompt) length|longer than the model'?s/i;
const MODEL =
  /model[_ ]?not[_ ]?found|model .{0,80}(does not exist|not found|is not available|not supported|unavailable)|unknown[_ ]model|invalid model|no endpoints found|not a valid model|DeploymentNotFound|deployment .{0,60}does not exist|unable to access model|模型不存在|no models? (is |are )?loaded|try pulling it first|pull the model|model .{0,40}not (exist|found)|Function not found|The model `[^`]+` does not exist|is not a valid model ID|model_not_available|model identifier is invalid|ResourceNotFoundException/i;
const OVERLOADED = /overloaded|over capacity|service unavailable|temporarily unavailable|ServiceUnavailable|ModelNotReady|internal server error|bad gateway|gateway time-?out|upstream (error|connect)|try again later|engine is currently overloaded|high demand/i;
const NETWORK = /connection error|APIConnection|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|EAI_AGAIN|EHOSTUNREACH|fetch failed|socket hang up|network error|UND_ERR|certificate|self[- ]signed/i;
// A local model's chat template that raised (Ollama, llama.cpp and LM Studio render Jinja; vLLM and TGI too).
const TEMPLATE = /jinja|chat[_ ]?template(?![_ ]?kwargs)|prompt template|raise_exception|no user query found|conversation roles must alternate|system message must be at the beginning|error rendering prompt|(apply|render)(ing)? (the )?(chat )?template|template (error|exception)/i;
const REFUSAL = /content[_ ]?(filter|management policy|policy violation)|safety (system|settings)|blocked (by|due to) (safety|content)|responsible ?ai|flagged as/i;

/**
 * Category from HTTP status + provider message. Tested against recorded error bodies of OpenAI, Anthropic, Gemini,
 * OpenRouter, Groq, DeepSeek, Mistral, xAI, Moonshot, Z.ai, DashScope, Bedrock, Azure, Cloudflare, Hugging Face,
 * GitHub Models, Ollama, LM Studio, llama.cpp and vLLM (tests/fixtures/providers/errors.json).
 */
export function categorize(status: number, message: string, code = ''): ErrorCategory {
  const t = `${code} ${message}`;
  if (status === 402 || QUOTA.test(t) || /^(1113|1008)$/.test(code)) {
    // Gemini: "You exceeded your current quota" is also used for free-tier per-minute/per-day limits.
    if (status === 429 && RATE.test(t) && !/billing details|credit|balance|payment/i.test(t.replace(/please check your plan and billing details/i, ''))) return 'rate_limit';
    return 'quota';
  }
  if (status === 401 || AUTH.test(t) || /^(1000|1001|1003|1004|10000)$/.test(code)) return 'auth';
  // AWS "ThrottlingException: Too many tokens, please wait" is a rate limit, not a long conversation.
  if (/throttl/i.test(code)) return 'rate_limit';
  if (CONTEXT.test(t) || status === 413 || /^(1261|1039)$/.test(code)) return 'context';
  // Ollama answers a chat template that raised with a 500: no outage, and trying again gives the same error (B-18).
  if (TEMPLATE.test(t)) return 'template';
  if (code === '1305' || /engine_overloaded|server_is_overloaded/i.test(t)) return 'overloaded';
  if (status === 429 || RATE.test(t) || /^(1302|1303)$/.test(code) || /slow_down/i.test(code)) return 'rate_limit';
  // "The model `x` does not exist or you do not have access to it" (404) is about the model, not a permission.
  if ((status !== 403 && MODEL.test(t)) || code === '1211') return 'model';
  if (status === 403 || FORBIDDEN.test(t)) return 'forbidden';
  if (MODEL.test(t)) return 'model';
  if (REFUSAL.test(t)) return 'refusal';
  if (status === 404) return /model/i.test(t) ? 'model' : 'endpoint';
  if (status === 408 || status === 498 || status === 500 || status === 502 || status === 503 || status === 504 || status === 529 || code === '1305' || OVERLOADED.test(t)) return 'overloaded';
  if (NETWORK.test(t)) return 'network';
  if (status === 400 || status === 422) return 'bad_request';
  if (status >= 500) return 'overloaded';
  return 'other';
}

/** Pull the human message and a code out of the many error body shapes providers use. */
export function parseErrorBody(body: string): { message: string; code: string } {
  let j: any;
  try {
    j = JSON.parse(body);
  } catch {
    // HTML error pages (proxies, Perplexity's 401) or plain text.
    const text = body.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    return { message: text.slice(0, 400), code: '' };
  }
  if (Array.isArray(j)) j = j[0]; // Gemini's OpenAI-compatible endpoint returns [{ error: {...} }]
  const e = j?.error ?? j;
  const pick = (...vals: any[]) => vals.find((v) => typeof v === 'string' && v.trim()) as string | undefined;
  const message =
    pick(
      typeof e === 'string' ? e : undefined,
      e?.message,
      e?.msg,
      j?.message,
      j?.Message,
      j?.detail,
      typeof j?.detail === 'object' ? j?.detail?.message : undefined,
      j?.errors?.[0]?.message,
      j?.base_resp?.status_msg,
      e?.metadata?.raw,
    ) || (body.length < 400 ? body : body.slice(0, 400));
  const rawCode = e?.code ?? e?.type ?? e?.status ?? j?.code ?? j?.__type ?? j?.errors?.[0]?.code ?? j?.base_resp?.status_code ?? '';
  const code = String(typeof rawCode === 'object' ? JSON.stringify(rawCode) : rawCode).replace(/^.*#/, '');
  // OpenRouter wraps the upstream provider's error: prefer the upstream text when it says more.
  const upstream = typeof e?.metadata?.raw === 'string' ? e.metadata.raw : '';
  return { message: upstream && upstream !== message && message.length < 40 ? `${message}: ${upstream}`.slice(0, 600) : message.slice(0, 600), code };
}

function retryAfterSeconds(res: Response | null, text: string): number | undefined {
  const h = res?.headers.get('retry-after');
  if (h) {
    const n = Number(h);
    if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
    const d = Date.parse(h);
    if (!isNaN(d)) return Math.max(1, Math.ceil((d - Date.now()) / 1000));
  }
  const m = text.match(/(?:try again|retry|wait)\s+(?:in|after)?\s*(\d+(?:\.\d+)?)\s*(ms|s|sec|seconds?)\b/i);
  if (m) return Math.max(1, Math.ceil(Number(m[1]) / (m[2] === 'ms' ? 1000 : 1)));
  return undefined;
}

/** The Dutch message: "<label>: <status> <titel> — <provider-tekst>". Keeps the status number and provider text for diagnostics. */
export function providerMessage(label: string, status: number, category: ErrorCategory, providerText: string, retryAfter?: number): string {
  const title = ERROR_TEXT[category].title;
  const text = providerText.replace(/\s+/g, ' ').trim().slice(0, 400);
  const wait = retryAfter ? ` (opnieuw mogelijk over ${retryAfter} s)` : '';
  return `${label}: ${status ? status + ' ' : ''}${title}${text ? ` — ${text}` : ''}${wait}`;
}

/** Build a ProviderError from a status + body (also used for errors that arrive inside a stream). */
export function providerErrorFrom(label: string, status: number, body: string, res: Response | null = null): ProviderError {
  const { message, code } = parseErrorBody(body);
  const category = categorize(status, message, code);
  const retryAfter = retryAfterSeconds(res, message);
  const retryable = category !== 'template' && (status === 429 || status >= 500 || status === 408 || category === 'overloaded' || category === 'network' || category === 'rate_limit');
  const err = new ProviderError(providerMessage(label, status, category, message, retryAfter), status, retryable, body.slice(0, 2000), category);
  err.retryAfter = retryAfter;
  return err;
}

export async function errorFromResponse(res: Response, label: string): Promise<ProviderError> {
  let body = '';
  try {
    body = await res.text();
  } catch {
    /* ignore */
  }
  // Bedrock/AWS put the exception name in a header, not the body.
  const amz = res.headers.get('x-amzn-errortype');
  if (amz && body && !/__type/.test(body)) {
    try {
      body = JSON.stringify({ __type: amz.split(':')[0], ...JSON.parse(body) });
    } catch {
      /* keep body */
    }
  }
  return providerErrorFrom(label, res.status, body, res);
}

/** Connection failures (DNS, refused, TLS) as a ProviderError with category "network". */
export function networkError(label: string, e: any): ProviderError {
  const detail = String(e?.cause?.code || e?.cause?.message || e?.message || e);
  const err = new ProviderError(`${label}: ${ERROR_TEXT.network.title} (${detail})`, 0, true, '', 'network');
  return err;
}

/** Any thrown value as a category (ProviderError, SDK APIError with .status, network failures, plain errors). */
export function categoryOf(e: any): ErrorCategory {
  if (e instanceof ProviderError && e.category) return e.category;
  const status = typeof e?.status === 'number' ? e.status : 0;
  const msg = String(e?.error?.error?.message || e?.error?.message || e?.message || e || '');
  const code = String(e?.error?.error?.type || e?.error?.type || e?.code || '');
  if (!status && NETWORK.test(msg + ' ' + String(e?.cause?.code || ''))) return 'network';
  return categorize(status, msg, code);
}

/**
 * "1 model beschikbaar" / "47 modellen beschikbaar" for a key check: a whole text per form, so every language can
 * translate it (no Dutch plural glued to a count). `what` names the models ("Claude-modellen"). Template literals on
 * purpose: the extractor (scripts/i18n-extract.mjs) reads the branches of a choice, so the "1 …" form gets a
 * translation too (it stayed Dutch in other languages).
 */
export function modelsAvailable(n: number, what: 'modellen' | 'Claude-modellen' = 'modellen'): string {
  if (what === 'Claude-modellen') return n === 1 ? `1 Claude-model beschikbaar` : `${n} Claude-modellen beschikbaar`;
  return n === 1 ? `1 model beschikbaar` : `${n} modellen beschikbaar`;
}

/** Title + fix hint for the UI ("Test verbinding"), with the provider's key page when there is one. */
export function explain(e: any, opts: { keyUrl?: string } = {}): { category: ErrorCategory; title: string; hint: string } {
  const category = categoryOf(e);
  const t = ERROR_TEXT[category];
  return { category, title: t.title, hint: t.fix.replace('{keyUrl}', opts.keyUrl ? ` op ${opts.keyUrl}` : '') };
}

/** Parse a fetch Response body as Server-Sent Events. */
export async function* readSSE(res: Response): AsyncGenerator<{ event?: string; data: string }> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    buf = buf.replace(/\r\n/g, '\n');
    let idx: number;
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      let event: string | undefined;
      const data: string[] = [];
      for (const line of chunk.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) data.push(line.slice(5).replace(/^ /, ''));
      }
      if (data.length) yield { event, data: data.join('\n') };
    }
  }
  if (buf.trim().startsWith('data:')) yield { data: buf.trim().slice(5).trim() };
}

export function safeJson(s: string): any {
  try {
    return JSON.parse(s);
  } catch {
    return undefined;
  }
}

export async function fetchJson(url: string, init: RequestInit & { timeoutMs?: number } = {}, label = 'Provider'): Promise<any> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), init.timeoutMs ?? 15_000);
  try {
    let res: Response;
    try {
      // Provider APIs never need redirects; refusing them closes SSRF-by-redirect via a custom base URL.
      res = await fetch(url, { redirect: 'error', ...init, signal: init.signal || ctl.signal });
    } catch (e: any) {
      if (init.signal?.aborted) throw e;
      throw networkError(label, ctl.signal.aborted ? new Error('time-out') : e);
    }
    if (!res.ok) throw await errorFromResponse(res, label);
    const text = await res.text();
    const j = safeJson(text);
    if (j === undefined) throw new ProviderError(`${label}: ${ERROR_TEXT.endpoint.title} — antwoord is geen JSON`, res.status, false, text.slice(0, 500), 'endpoint');
    // MiniMax and a few others answer HTTP 200 with an error inside.
    const br = j?.base_resp;
    if (br && typeof br.status_code === 'number' && br.status_code !== 0) throw providerErrorFrom(label, 200, text);
    return j;
  } finally {
    clearTimeout(t);
  }
}
