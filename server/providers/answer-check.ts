import { ERROR_TEXT, ProviderError, categorize, parseErrorBody, providerMessage, type ErrorCategory } from './common.js';

/**
 * Answer checks for free and flaky providers (opt-in per provider: `answerCheck` in catalog.ts).
 *
 * Free routing rarely breaks with a clean error: some gateways answer HTTP 200 with the error in the text ("not enough
 * credits, needs paid Pollen"), streams stop half-way without their end marker, or go quiet. Each of these becomes a
 * ProviderError with a category the reserve logic already understands (overloaded → outage, rate_limit/quota → limit,
 * model → unavailable), so the runner switches to a reserve instead of passing a broken answer on as "klaar".
 */

/** How long a stream may stay silent: until the first event, and between events afterwards. */
export const STALL_MS = { first: 120_000, idle: 45_000 };

/** The whole answer is a JSON error body. */
const ERROR_BODY = /^\s*\{[\s\S]*"(?:error|detail)"\s*:[\s\S]*\}\s*$/i;
/** The answer is a proxy's error page (title with a status code or error words); a page a model wrote has no such title. */
const HTML_ERROR = /^\s*(?:<!doctype html|<html[\s>])[\s\S]{0,4000}?<title>[^<]*(?:\b[45]\d\d\b|error|bad gateway|unavailable|maintenance|too many requests)[^<]*<\/title>/i;
/** Starts like an error line ("Error: …", "[error] …", "429 …"). */
const ERROR_START = /^\s*(?:error|err|fout|\[error\]|⚠️?\s*error|(?:http\s*)?[45]\d\d\b)\s*[:\-—\s]/i;
/** Provider/gateway phrases (English: that is what the services send). */
const PROVIDER_PHRASE =
  /not enough (credits?|pollen|balance)|insufficient (credits?|balance|quota|funds)|needs? (a )?paid|requires? (a )?paid (plan|tier|account)|upgrade (your|to a) (plan|paid|account)|purchase (more )?credits|add (more )?credits|out of credits|quota (exceeded|exhausted)|rate[ -]?limit(ed| exceeded| reached)?|too many requests|daily (free )?(limit|allocation|quota)|(model|provider|service|upstream|server|backend) (is )?(currently )?(unavailable|overloaded|not available|error|down)|internal server error|bad gateway|gateway time-?out|service unavailable|no endpoints found|invalid api key|api key (is )?(invalid|missing|expired)|unauthori[sz]ed/i;
/** Words an error message uses to tell you what to do. */
const ERROR_ADVICE = /please|try again|retry|upgrade|add credits|purchase|contact support|later/i;

/**
 * The category of an error that came back as the "answer" text, or null when the text is a real answer. Strict on
 * purpose: only short texts that read like a provider error, never a normal answer that happens to mention one.
 */
export function errorInAnswer(text: string): ErrorCategory | null {
  const t = String(text || '').trim();
  if (t.length < 20_000 && HTML_ERROR.test(t)) return /\b429\b|too many requests/i.test(t) ? 'rate_limit' : 'overloaded';
  if (!t || t.length > 600) return null;
  const isError = ERROR_BODY.test(t) || (ERROR_START.test(t) && PROVIDER_PHRASE.test(t)) || (t.length <= 240 && PROVIDER_PHRASE.test(t) && ERROR_ADVICE.test(t));
  if (!isError) return null;
  const { message, code } = parseErrorBody(t);
  const c = categorize(0, message, code);
  if (c !== 'other' && c !== 'bad_request' && c !== 'refusal' && c !== 'context' && c !== 'tools' && c !== 'template') return c;
  // Free gateways' own wording: no credit / paid only = this source cannot serve for now; a limit = wait.
  if (/credit|pollen|balance|paid|upgrade|purchase|quota/i.test(message)) return 'quota';
  if (/rate[ -]?limit|too many requests|daily (free )?(limit|allocation)/i.test(message)) return 'rate_limit';
  // A gateway error that names no clear cause still means: this provider did not answer.
  return 'overloaded';
}

const RETRYABLE = new Set<ErrorCategory>(['overloaded', 'network', 'rate_limit']);

/** The ProviderError for an error that arrived as answer text (status 200 stays in the message for diagnostics). */
export function answerError(label: string, category: ErrorCategory, text: string): ProviderError {
  return new ProviderError(providerMessage(label, 200, category, text), 200, RETRYABLE.has(category), text.slice(0, 2000), category);
}

/** A stream that ended without its end marker or finish reason: the answer is incomplete. */
export function truncatedError(label: string): ProviderError {
  return new ProviderError(`${label}: ${ERROR_TEXT.overloaded.title} — het antwoord brak af voordat het klaar was`, 0, true, '', 'overloaded');
}

/** "Successful" but nothing in it: no text, no tool call. */
export function emptyError(label: string): ProviderError {
  return new ProviderError(`${label}: ${ERROR_TEXT.overloaded.title} — het antwoord was leeg`, 200, true, '', 'overloaded');
}

export interface StallGuard {
  /** Pass this to fetch instead of the caller's signal (it follows the caller's signal too). */
  signal: AbortSignal;
  readonly stalled: boolean;
  /** Something arrived: restart the (shorter) idle timer. */
  touch(): void;
  done(): void;
  error(label: string): ProviderError;
}

/** Aborts a request that stays silent too long; the caller's own abort (Stop) passes through unchanged. */
export function stallGuard(parent: AbortSignal, ms: { first: number; idle: number } = STALL_MS): StallGuard {
  const ctl = new AbortController();
  const follow = () => ctl.abort(parent.reason);
  if (parent.aborted) ctl.abort(parent.reason);
  else parent.addEventListener('abort', follow, { once: true });
  let stalled = false;
  let started = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const arm = (t: number) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      stalled = true;
      ctl.abort(new Error('stalled'));
    }, t);
    (timer as any).unref?.();
  };
  arm(ms.first);
  return {
    signal: ctl.signal,
    get stalled() {
      return stalled;
    },
    touch() {
      if (stalled) return;
      started = true;
      arm(ms.idle);
    },
    done() {
      if (timer) clearTimeout(timer);
      timer = null;
      parent.removeEventListener('abort', follow);
    },
    error(label: string) {
      const secs = Math.round((started ? ms.idle : ms.first) / 1000);
      const what = started ? `het antwoord viel halverwege stil (${secs} s niets ontvangen)` : `er kwam geen antwoord binnen ${secs} s`;
      return new ProviderError(`${label}: ${ERROR_TEXT.overloaded.title} — ${what}`, 0, true, '', 'overloaded');
    },
  };
}
