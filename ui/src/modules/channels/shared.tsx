import { Gamepad2, Hash, Info, Mail, MessageCircle, QrCode, Send, Webhook, type LucideIcon } from 'lucide-react';
import { Badge } from '../../components/ui';
import { t, uiLocale } from '../../lib/i18n';
import { healthBadge, type HealthView } from './health';

/** The address of each bot on an e-mail channel with plus addressing (P10): "Baas · jij+baas@gmail.com". */
export function BotAddresses({ list }: { list: { agentId: string; name: string; address: string }[] }) {
  return (
    <ul className="space-y-0.5 text-xs" aria-label={t('E-mailadres per bot')} data-testid="bot-addresses">
      {list.map((x) => (
        <li key={x.agentId} className="flex min-w-0 gap-1.5">
          <span className="shrink-0 font-medium" translate="no">
            {x.name}
          </span>
          <span className="min-w-0 truncate text-muted" translate="no">
            {x.address}
          </span>
        </li>
      ))}
    </ul>
  );
}

/**
 * Bindings that were deleted (or are being deleted) in this tab: their page and WhatsApp card stop asking for them, so a
 * late event never ends in a request for a binding that is gone (a console 404, acceptance round 6).
 */
const gone = new Set<string>();
export const markGone = (id: string) => void gone.add(id);
export const unmarkGone = (id: string) => void gone.delete(id);
export const isGone = (id: string) => gone.has(id);

export type Status = 'stopped' | 'connecting' | 'connected' | 'listening' | 'error';
export type Access = 'none' | 'readonly' | 'agent';

export interface BindingView {
  id: string;
  adapter: string;
  adapterLabel: string;
  name: string;
  agent_id: string | null;
  room_id: string | null;
  config: Record<string, any>;
  secrets: Record<string, boolean>;
  enabled: boolean;
  status: Status;
  running: boolean;
  last_error: string | null;
  last_ok_at: string | null;
  info: Record<string, any>;
  needsPublicUrl: boolean;
  publicBaseUrl: string;
  webhooks: { kind: string; path: string; url: string }[];
  approveViaChannelSupported: boolean;
  /** The platform has status reactions (👀, then done or error): their on/off switch is shown. */
  reactionsSupported?: boolean;
  /** Engine of the bot that answers and the access levels it can really be held to (null for a room). */
  engine?: BotEngine | null;
  /** Linked-device channels (WhatsApp QR): pairing phase, without the QR itself. */
  link?: WaLink | null;
  counts: { senders: number; conversations: number };
  /** Proof that messages really arrive and leave ("Verbonden" only with both). */
  health?: HealthView | null;
  /** Customer mode: may strangers write in a private chat on this kind of channel? (never WhatsApp via QR) */
  openDoorSupported?: boolean;
  /** The team this channel belongs to: that of its bot or group (package B4). Only that team's bots use it. */
  team_id?: string | null;
  teamName?: string;
  /** E-mail with plus addressing (0.4.4, P10): the address of each bot (you+baas@…). */
  botAddresses?: { agentId: string; name: string; tag: string; address: string; own: boolean }[];
  created_at: string;
  updated_at: string;
}

export interface WaLink {
  phase: 'starting' | 'qr' | 'code' | 'syncing' | 'ready' | 'stopped' | 'error';
  qrVersion?: number;
  code?: string;
  percent?: number;
  me?: { phone: string; name: string };
  expiresAt?: string;
  detail?: string;
}

export interface SenderRow {
  id: string;
  external_id: string;
  label: string;
  is_owner: boolean;
  source: string;
  created_at: string;
}

export interface PairCodeRow {
  id: string;
  label: string;
  is_owner: boolean;
  expires_at: string;
  used_at: string | null;
  used_by: string | null;
  created_at: string;
}

export interface BindingDetail extends BindingView {
  senders: SenderRow[];
  pairCodes: PairCodeRow[];
}

export interface ConversationRow {
  id: string;
  external_id: string;
  title: string;
  is_private: boolean;
  thread_id: string | null;
  paused: boolean;
  /** Handed off to the owner (customer mode): the bot is quiet until he replies or releases it. */
  handoff?: { at: string; reason: string; question: string } | null;
  last_sender: string | null;
  last_inbound_at: string | null;
  last_outbound_at: string | null;
}

export interface LogRow {
  id: number;
  binding_id: string;
  direction: 'in' | 'out' | 'system';
  kind: string;
  sender_id: string | null;
  sender_name: string | null;
  conversation_id: string | null;
  summary: string;
  created_at: string;
}

export interface AdaptersInfo {
  adapters: { id: string; label: string; description: string; approveViaChannel: boolean; secretFields: { key: string; label: string }[]; webhookKinds: string[] }[];
  publicUrl: string;
  mode: 'desktop' | 'server';
  role: 'owner' | 'admin' | 'member';
  emailPresets: Record<string, Record<string, any>>;
}

export const ADAPTER_ICON: Record<string, LucideIcon> = {
  telegram: Send,
  discord: Gamepad2,
  slack: Hash,
  email: Mail,
  whatsapp: MessageCircle,
  'whatsapp-web': QrCode,
  webhook: Webhook,
};

/**
 * The channel's badge. Green "Verbonden" only when TeamBot really received and sent a message with these settings;
 * a connection that is merely up says "Verbonden, nog niet getest" (no false green tick).
 */
export function StatusBadge({ status, enabled, link, health }: { status: Status; enabled?: boolean; link?: WaLink | null; health?: HealthView | null }) {
  const h = healthBadge({ status, enabled, link, health });
  const mark = h.tone === 'ok' ? '● ' : h.tone === 'danger' ? '▲ ' : h.tone === 'warn' ? '◌ ' : '';
  return (
    <Badge tone={h.tone}>
      {mark}
      {h.label}
    </Badge>
  );
}

export const ACCESS_OPTIONS: { value: Access; label: string; hint: string }[] = [
  { value: 'none', label: 'Alleen praten (geen tools)', hint: 'Veiligst: de bot antwoordt, maar gebruikt geen bestanden, internet of andere tools.' },
  { value: 'readonly', label: 'Alleen lezen', hint: 'Zoeken en lezen mag (web, bestanden in de werkmap); niets wijzigen of versturen.' },
  { value: 'agent', label: 'Zoals de bot zelf', hint: 'Alle tools van de bot. Alleen voor mensen die je volledig vertrouwt.' },
];

/** The engine behind a bot (server: channels manager `engineOf`). */
export interface BotEngine {
  type: 'api' | 'cli';
  kind: string;
  label: string;
  /** Access levels this engine really enforces for people who write through a channel. */
  levels: Access[];
}

/**
 * Same rule as the server: a CLI brings its own tools, which TeamBot cannot cap per sender. Claude Code can run
 * without any tools ("Alleen praten" works); "Alleen lezen" works on no CLI; Codex, OpenCode and other CLIs only
 * "Zoals de bot zelf".
 */
export function engineFor(agent: { provider_id: string | null } | undefined, providers: { id: string; kind: string; kindLabel: string; type: 'api' | 'cli' }[], defaultProvider?: string | null): BotEngine | null {
  if (!agent) return null;
  const p = providers.find((x) => x.id === (agent.provider_id || defaultProvider));
  if (!p) return null;
  if (p.type !== 'cli') return { type: 'api', kind: p.kind, label: p.kindLabel, levels: ['none', 'readonly', 'agent'] };
  return { type: 'cli', kind: p.kind, label: p.kindLabel, levels: p.kind === 'claude-code' ? ['none', 'agent'] : ['agent'] };
}

/** The access options for a bot's engine: what cannot work is labelled (and, when not chosen, disabled). */
export function accessChoices(engine: BotEngine | null | undefined, current: Access): { value: Access; label: string; hint: string; disabled: boolean }[] {
  return ACCESS_OPTIONS.map((o) => {
    if (!engine || engine.levels.includes(o.value)) {
      if (o.value === 'none' && engine?.type === 'cli') return { ...o, hint: `${engine.label} draait dan zonder tools: de bot antwoordt alleen met tekst.`, disabled: false };
      return { ...o, disabled: false };
    }
    // "Alleen praten" stays selectable on engines that cannot do it: it then means "don't answer others".
    if (o.value === 'none') return { value: o.value, label: `Niet beantwoorden (${engine.label} kan niet alleen praten)`, hint: `Berichten van anderen gaan niet naar de bot; jij krijgt een melding.`, disabled: false };
    return { value: o.value, label: `${o.label} — kan niet met ${engine.label}`, hint: `Kan niet met ${engine.label}. Berichten worden niet beantwoord; jij krijgt een melding.`, disabled: o.value !== current };
  });
}

/** Plain-Dutch note for a bot on a CLI engine: what people on the allowlist get, and what to do about it. */
export function EngineNote({ engine, botName, where = 'bij Toegang' }: { engine: BotEngine | null | undefined; botName: string; where?: string }) {
  if (!engine || engine.type !== 'cli') return null;
  const canTalk = engine.levels.includes('none');
  return (
    <div className="flex items-start gap-2 rounded-lg bg-surface-2 p-3 text-sm text-fg">
      <Info className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
      <div className="min-w-0">
        {canTalk ? (
          <>
            {botName} draait op {engine.label}. Anderen op de allowlist kunnen met hem praten; hij antwoordt hun dan zonder tools. “Alleen lezen” kan niet met {engine.label}.
          </>
        ) : (
          <>
            {botName} draait op {engine.label}. Die werkt altijd met zijn eigen tools en kan niet “alleen praten”. Anderen op de allowlist krijgen daarom geen antwoord (jij krijgt dan een melding), tenzij je {where} “Zoals de bot zelf”
            kiest. Wil je dat vrienden gewoon kunnen praten? Laat dan een bot met een API-model of met Claude Code antwoorden.
          </>
        )}
      </div>
    </div>
  );
}

/** What a bot itself may do (its access mode), as the bot editor names it. */
export const BOT_ACCESS_LABEL: Record<string, string> = { chat: 'Alleen chat', readonly: 'Alleen lezen', ask: 'Vraagt toestemming', auto: 'Automatisch', full: 'Volledige toegang' };

/** Log line kinds in words (Logboek). */
export const LOG_KIND: Record<string, { label: string; bad?: boolean }> = {
  message: { label: 'bericht' },
  system: { label: 'systeem' },
  blocked: { label: 'geweigerd', bad: true },
  rejected: { label: 'afgewezen', bad: true },
  refused: { label: 'niet beantwoord', bad: true },
  ignored: { label: 'genegeerd' },
  error: { label: 'fout', bad: true },
  rate_limited: { label: 'te veel berichten', bad: true },
  pair_failed: { label: 'koppelen mislukt', bad: true },
  paired: { label: 'gekoppeld' },
  approval: { label: 'goedkeuring' },
  routine: { label: 'routine' },
  connected: { label: 'verbonden' },
  test_failed: { label: 'test mislukt', bad: true },
  unlinked: { label: 'ontkoppeld', bad: true },
  verified: { label: 'geverifieerd' },
  whatsapp: { label: 'WhatsApp' },
  test_started: { label: 'test' },
  test_ok: { label: 'test geslaagd' },
  handoff: { label: 'doorgezet naar jou' },
  held: { label: 'wacht op jou' },
  blocked_reply: { label: 'niet verstuurd', bad: true },
};

/** What the external sender id looks like per adapter (for the allowlist form). */
export const SENDER_HINT: Record<string, string> = {
  telegram: 'Telegram-gebruiker-id (getal). Makkelijker: laat de persoon een koppelcode sturen.',
  discord: 'Discord-gebruiker-id (rechtsklik op de naam › ID kopiëren).',
  slack: 'Slack-gebruiker-id (begint met U, via profiel › ⋮ › Lid-ID kopiëren).',
  email: 'E-mailadres van de afzender.',
  whatsapp: 'Telefoonnummer in internationale vorm, bijv. 31612345678.',
  'whatsapp-web': 'Telefoonnummer in internationale vorm, bijv. 31612345678.',
  webhook: 'De sender.id die je integratie meestuurt.',
};

export function randomSecret(len = 32): string {
  const bytes = new Uint8Array(len);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789'[b % 57]).join('');
}

export function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(uiLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
