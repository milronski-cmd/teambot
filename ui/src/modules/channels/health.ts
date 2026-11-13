/**
 * Channel health in words (server: server/modules/channels/health.ts). "Verbonden" only when TeamBot really received
 * a message on this channel and really sent one; until then "Verbonden, nog niet getest" with what to do next. A
 * transport that is merely up never gets a green badge.
 */

import type { HealthView } from '../../../../shared/channelHealth.js';

export type { HealthState, HealthView } from '../../../../shared/channelHealth.js';

export interface HealthBadge {
  tone: 'ok' | 'warn' | 'danger' | 'neutral';
  label: string;
}

type Status = 'stopped' | 'connecting' | 'connected' | 'listening' | 'error';

/** The one badge of a channel (list, detail, bot editor). */
export function healthBadge(b: { enabled?: boolean; status: Status; health?: HealthView | null; link?: { phase?: string } | null }): HealthBadge {
  if (b.enabled === false) return { tone: 'neutral', label: 'Uit' };
  if (b.status === 'connecting' && (b.link?.phase === 'qr' || b.link?.phase === 'code')) return { tone: 'warn', label: 'Wacht op koppelen' };
  if (b.status === 'connecting' && b.link?.phase === 'syncing') return { tone: 'warn', label: 'Gegevens ophalen…' };
  const h = b.health;
  if (!h) {
    // An older server without health: never claim more than the transport knows.
    if (b.status === 'error') return { tone: 'danger', label: 'Fout' };
    if (b.status === 'connected' || b.status === 'listening') return { tone: 'warn', label: 'Verbonden, nog niet getest' };
    return { tone: 'neutral', label: b.status === 'connecting' ? 'Verbinden…' : 'Gestopt' };
  }
  switch (h.state) {
    case 'off':
      return { tone: 'neutral', label: 'Uit' };
    case 'connecting':
      return { tone: 'warn', label: 'Verbinden…' };
    case 'error':
      return { tone: 'danger', label: 'Fout' };
    case 'receive_failed':
      return { tone: 'danger', label: 'Ontvangen lukt niet' };
    case 'send_failed':
      return { tone: 'danger', label: 'Versturen lukt niet' };
    case 'ok':
      return { tone: 'ok', label: 'Verbonden' };
    default:
      return h.testing ? { tone: 'warn', label: 'Test loopt…' } : { tone: 'warn', label: 'Verbonden, nog niet getest' };
  }
}

/** Where the owner sends the test code, per channel. */
export function testWhere(adapter: string, config: Record<string, any>, info: Record<string, any>): string {
  switch (adapter) {
    case 'telegram':
      return info.botUsername ? `Stuur de code in Telegram naar @${info.botUsername}, of tik op de link.` : 'Stuur de code in Telegram naar je bot.';
    case 'whatsapp':
      return 'Stuur de code vanaf je eigen telefoon in WhatsApp naar je bedrijfsnummer.';
    case 'whatsapp-web':
      return 'Stuur de code in WhatsApp in je chat “Bericht aan jezelf”.';
    case 'email':
      return config.address ? `Mail de code naar ${config.address} (in het onderwerp).` : 'Mail de code naar de bot (in het onderwerp).';
    case 'slack':
    case 'discord':
      return 'Stuur de bot een privébericht met de code.';
    case 'webhook':
      return 'Stuur een ondertekend verzoek met de code als tekst.';
    default:
      return 'Stuur de bot een bericht met de code.';
  }
}

/** The platform refused (or never got) the token or password: the reasons the adapters give for that. */
const SECRET_PROBLEM = /weigert de [\w -]*token|inloggen geweigerd|token[\w ()-]* ontbreekt|wachtwoord ontbreekt/i;

/**
 * The button under a refused token or password: where to put a new one (the channel's Instellingen tab), in the
 * channel's own words. Null when the error is something else.
 */
export function newSecretAction(b: { adapter: string; status: Status; enabled?: boolean; health?: HealthView | null; last_error?: string | null }): string | null {
  if (b.enabled === false) return null;
  const reason = b.health ? (b.health.state === 'error' ? b.health.reason : null) : b.status === 'error' ? b.last_error : null;
  if (!reason || !SECRET_PROBLEM.test(reason)) return null;
  return b.adapter === 'email' ? 'Ander wachtwoord invullen' : 'Nieuwe token invullen';
}

/** What to do now, in one sentence (null when the channel is fine or has its own error text). */
export function nextStep(b: { adapter: string; health?: HealthView | null; senders?: { is_owner: boolean }[] }): string | null {
  const h = b.health;
  if (!h || h.state !== 'untested' || h.testing) return null;
  if (h.receiveOk && !h.sendOk) return 'Ontvangen werkt. Versturen is nog niet getest: start de test, dan antwoordt TeamBot op je testbericht.';
  if (b.adapter === 'telegram' && b.senders && !b.senders.some((s) => s.is_owner))
    return 'Laatste stap: koppel je eigen Telegram met één tik. Dan weet TeamBot zeker dat berichten aankomen en vertrekken.';
  return 'TeamBot heeft nog geen bericht ontvangen en verstuurd via dit kanaal. Test het: stuur je bot een testcode, TeamBot antwoordt.';
}
