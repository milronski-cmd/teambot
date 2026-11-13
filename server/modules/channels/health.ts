/**
 * Channel health: "verbonden" only when TeamBot has really received a message on this channel AND really sent one,
 * with the current settings. A transport that is up (polling runs, the webhook URL exists, the socket said hello)
 * is not proof that messages arrive: OpenBot showed a green tick for Slack and then "cannot receive Slack events on
 * this computer". Until both directions are proven the channel is "verbonden, nog niet getest" with a next step;
 * when we know why receiving or sending fails, the channel says exactly that.
 *
 * Evidence comes from the channel log (manager.log): every line "in" (except a rejected request or an error) means
 * the platform delivered something to TeamBot; every "out" message means the platform accepted one from us. The owner
 * can also run a test: send "test CODE" to the bot, TeamBot answers, and both directions are proven in one step.
 */
import type { AdapterDef, Binding } from './types.js';
import type { HealthEvent, HealthState, HealthView } from '../../../shared/channelHealth.js';

/** What the Kanalen page shows: shared/channelHealth.ts. */
export type { HealthView };

export interface HealthRecord {
  /** When the current connection settings took effect (evidence from before does not count). */
  since?: string;
  /** Last time the platform delivered something to TeamBot. */
  inAt?: string | null;
  /** Last time a message of ours was accepted by the platform. */
  outAt?: string | null;
  /** First proof of receiving / sending since `since`. */
  receiveOkAt?: string | null;
  sendOkAt?: string | null;
  /** The platform's own check of our webhook (Meta verify token, Slack url_verification). Not yet a message. */
  platformAt?: string | null;
  /** What we know is wrong with receiving / sending (cleared by the next success). */
  receiveProblem?: HealthEvent | null;
  sendProblem?: HealthEvent | null;
  lastError?: HealthEvent | null;
  /** A running test: the owner sends "test CODE"; only the hash is kept. */
  test?: { codeHash: string; startedAt: string; expiresAt: string } | null;
  lastTest?: { at: string; ok: boolean; text: string } | null;
}

/** Log kinds "in" that are not proof of a delivered message. */
export const NOT_RECEIVED = new Set(['rejected', 'error', 'test_failed']);
/** Log kinds that count as an error in the channel's history. */
export const ERROR_KINDS = new Set(['error', 'rejected', 'test_failed']);

const newer = (a: string | null | undefined, b: string | null | undefined) => !!a && (!b || a > b);

/** "test AB12CD", "/test AB12CD", Telegram's "/start test_AB12CD". */
export function parseTestCode(text: string): string | null {
  const m = String(text || '')
    .slice(0, 400)
    .match(/(?:^|[\s/])test[\s_:-]+([A-Za-z0-9]{6})\b/i);
  return m ? m[1].toUpperCase() : null;
}

/** Can this binding answer at all? A webhook with "geen antwoord terugsturen" only receives. */
export const sendNeeded = (b: Pick<Binding, 'adapter' | 'config'>) => !(b.adapter === 'webhook' && b.config?.replyMode === 'none');

export function computeHealth(
  b: Pick<Binding, 'adapter' | 'config' | 'enabled' | 'status' | 'last_error'> & { health?: HealthRecord | null },
  def: Pick<AdapterDef, 'label' | 'needsPublicUrl'> | undefined,
  o: { webhookUrl: string; day: { in: number; out: number; errors: number } },
): HealthView {
  const h = b.health || {};
  const needSend = sendNeeded(b);
  const base = {
    receiveOk: !!h.receiveOkAt,
    sendOk: !!h.sendOkAt,
    sendNeeded: needSend,
    inAt: h.inAt || null,
    outAt: h.outAt || null,
    platformAt: h.platformAt || null,
    lastError: h.lastError || null,
    testing: h.test && h.test.expiresAt > new Date().toISOString() ? { expiresAt: h.test.expiresAt } : null,
    lastTest: h.lastTest || null,
    day: o.day,
  };
  const v = (state: HealthState, reason: string | null = null): HealthView => ({ state, reason, ...base });
  if (!b.enabled) return v('off');
  if (b.status === 'error') return v('error', b.last_error || 'Onbekende fout');
  if (b.status !== 'connected' && b.status !== 'listening') return v('connecting');
  // Webhook channels without a public address cannot receive anything, whatever the transport says.
  if (def?.needsPublicUrl(b.config) && !o.webhookUrl) return v('receive_failed', `${def.label} kan TeamBot niet bereiken: er is geen publiek https-adres ingesteld. Vul bij Instellingen een tunnel-adres in (bijv. Cloudflare Tunnel of Tailscale Funnel).`);
  if (h.receiveProblem && newer(h.receiveProblem.at, h.inAt)) return v('receive_failed', h.receiveProblem.text);
  if (needSend && h.sendProblem && newer(h.sendProblem.at, h.outAt)) return v('send_failed', h.sendProblem.text);
  if (h.receiveOkAt && (h.sendOkAt || !needSend)) return v('ok');
  return v('untested');
}
