import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Info, Laptop, Network, Shield, ShieldAlert, ShieldCheck, ShieldQuestion } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import type { Agent } from '../../lib/types';
import { Badge, Button, Modal, cx } from '../../components/ui';
import { t, translate } from '../../lib/i18n';
import { formatDate } from '../../lib/format';
import { useAdvanced } from '../../shell/advanced';

/**
 * Privacy label per bot (0.4, package P): "Blijft op je pc", "Bewaart niets", "Traint niet", "Kan trainen", …
 * The server decides (server/modules/network/privacy.ts, privacyLabel()); this file only shows it.
 */

export type PrivacyLevel = 'local' | 'lan' | 'no-store' | 'no-train' | 'unknown' | 'may-train';

export interface PrivacyLabel {
  level: PrivacyLevel;
  label: string;
  detail: string;
  receiver: string | null;
  optOutUrl?: string;
  policyUrl?: string;
  checkedAt: string;
}

export interface EngineView {
  role: 'main' | 'reserve';
  providerId: string;
  provider: string;
  kind: string;
  kindLabel: string;
  model: string;
  privacy: PrivacyLabel;
}

export interface AgentPrivacy {
  agentId: string;
  name: string;
  engines: EngineView[];
  main: PrivacyLabel | null;
  worst: PrivacyLabel | null;
}

const LOOK: Record<PrivacyLevel, { tone: 'ok' | 'accent' | 'neutral' | 'warn'; icon: LucideIcon }> = {
  local: { tone: 'ok', icon: Laptop },
  lan: { tone: 'ok', icon: Network },
  'no-store': { tone: 'ok', icon: ShieldCheck },
  'no-train': { tone: 'accent', icon: Shield },
  unknown: { tone: 'neutral', icon: ShieldQuestion },
  'may-train': { tone: 'warn', icon: ShieldAlert },
};

/** The label as a badge (icon + short text). `compact`: icon only below the sm breakpoint. */
export function PrivacyBadge({ p, compact }: { p: PrivacyLabel; compact?: boolean }) {
  const look = LOOK[p.level] || LOOK.unknown;
  const Icon = look.icon;
  return (
    <Badge tone={look.tone}>
      <Icon className="h-3 w-3" aria-hidden />
      <span className={cx(compact && 'hidden sm:inline')}>{p.label}</span>
    </Badge>
  );
}

/** Who gets what, what they do with it, and where to turn training off. */
export function PrivacyDetail({ p }: { p: PrivacyLabel }) {
  return (
    <div className="space-y-1.5 text-sm">
      <p className="text-muted">{p.detail}</p>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {p.optOutUrl && (
          <a className="inline-flex items-center gap-1 text-accent underline" href={p.optOutUrl} target="_blank" rel="noreferrer noopener">
            Training uitzetten <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
        {p.policyUrl && p.policyUrl !== p.optOutUrl && (
          <a className="inline-flex items-center gap-1 text-muted underline hover:text-fg" href={p.policyUrl} target="_blank" rel="noreferrer noopener">
            Voorwaarden van de aanbieder <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )}
        {/* A local engine has no provider policy to check. */}
        {p.level !== 'local' && p.level !== 'lan' && <span className="text-muted">{t('Nagekeken op {0}', formatDate(p.checkedAt, { dateStyle: 'long' }))}</span>}
      </div>
    </div>
  );
}

/** Live label of one bot (refreshes when the bot changes). */
function useAgentPrivacy(agentId: string | null): AgentPrivacy | null {
  const agent = useApp((s) => (agentId ? s.agents.find((a) => a.id === agentId) : undefined));
  const [p, setP] = useState<AgentPrivacy | null>(null);
  const key = agent ? `${agent.provider_id}|${agent.model}|${JSON.stringify(agent.settings?.fallbacks ?? agent.fallback ?? null)}` : agentId || '';
  // A bot that was here and is gone was just deleted: asking the server for its label only gives a 404.
  const seen = useRef<string | null>(null);
  if (agent) seen.current = agent.id;
  const gone = !agent && seen.current === agentId;
  useEffect(() => {
    if (!agentId || gone) return setP(null);
    let alive = true;
    const load = () => api.get<AgentPrivacy>(`/privacy/agents/${agentId}`).then((r) => alive && setP(r), () => alive && setP(null));
    load();
    const off = on('agent.updated', (a: any) => a?.id === agentId && load());
    return () => {
      alive = false;
      off();
    };
  }, [agentId, key, gone]);
  return p;
}

/**
 * Chat header: the privacy label of this bot's main engine; a click shows it per engine (also its reserves). Only with
 * "Geavanceerd tonen" on: the simple chat header stays empty, and the same label sits in the bot editor and under
 * Instellingen › Privacy en gegevens.
 */
export function ChatPrivacyChip({ agentId }: { threadId: string; agentId: string | null }) {
  const p = useAgentPrivacy(agentId);
  const [open, setOpen] = useState(false);
  const advanced = useAdvanced();
  if (!advanced || !p?.main) return null;
  const worseReserve = p.worst && p.worst.level !== p.main.level ? p.worst : null;
  return (
    <>
      <button type="button" className="me-1 flex min-h-[32px] items-center justify-center rounded-full coarse:min-h-11 coarse:min-w-11" onClick={() => setOpen(true)} aria-label={t('Privacy: {0}. Wat gebeurt er met je gesprekken?', translate(p.main.label))} title={worseReserve ? t('{0} · reserve: {1}', translate(p.main.label), translate(worseReserve.label)) : p.main.label} data-testid="privacy-chip">
        <PrivacyBadge p={p.main} compact />
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Wat gebeurt er met je gesprekken?" footer={<Button onClick={() => setOpen(false)}>Sluiten</Button>}>
        <div className="space-y-2">
          <div className="divide-y divide-line">
            {p.engines.map((e, i) => (
              <EngineLine key={i} e={e} className="py-2" />
            ))}
          </div>
          <a className="inline-block text-sm text-accent underline" href="#/settings/data" onClick={() => setOpen(false)}>
            Wat verlaat je pc?
          </a>
        </div>
      </Modal>
    </>
  );
}

/**
 * One engine in one line (0.4.5, "veel te veel tekst"): who gets the conversations, the label, and where to turn
 * training off: "Claude Code · Kan trainen · Training uitzetten". The full explanation is under Instellingen › Waar staat mijn
 * data? › Wat verlaat je pc? (DataPrivacy.tsx).
 */
export function EngineLine({ e, className }: { e: Pick<EngineView, 'role' | 'provider' | 'kindLabel' | 'privacy'>; className?: string }) {
  const p = e.privacy;
  return (
    <div className={cx('flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm', className)} data-testid="privacy-line">
      {e.role === 'reserve' && <span className="text-muted">Reserve:</span>}
      <span className="min-w-0 truncate font-medium" translate="no">
        {e.provider || e.kindLabel}
      </span>
      <span className="text-muted" aria-hidden>
        ·
      </span>
      <PrivacyBadge p={p} />
      {p.optOutUrl && (
        <>
          <span className="text-muted" aria-hidden>
            ·
          </span>
          <a className="inline-flex items-center gap-1 text-accent underline" href={p.optOutUrl} target="_blank" rel="noreferrer noopener">
            Training uitzetten <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        </>
      )}
    </div>
  );
}

/**
 * Bot editor › AI en model: the privacy of the chosen engine in ONE line, also before saving, with a link to the full
 * explanation. A reserve engine that is worse than the main one gets its own short line.
 */
export function AgentPrivacyLine({ agent }: { agent: Partial<Agent> }) {
  const fallbacks: { provider_id: string; model: string }[] = Array.isArray(agent.settings?.fallbacks) ? agent.settings.fallbacks : agent.fallback ? [agent.fallback] : [];
  const engines = [{ provider_id: agent.provider_id || '', model: agent.model || '' }, ...fallbacks].filter((e) => e.provider_id);
  const key = JSON.stringify(engines);
  const [list, setList] = useState<(EngineView | null)[] | null>(null);
  useEffect(() => {
    if (!engines.length) return setList([]);
    let alive = true;
    api.post<(EngineView | null)[]>('/privacy/engines', { engines }).then((r) => alive && setList(r), () => alive && setList(null));
    return () => {
      alive = false;
    };
  }, [key]);
  const main = list?.[0];
  if (!main) return null;
  const order: PrivacyLevel[] = ['local', 'lan', 'no-store', 'no-train', 'unknown', 'may-train'];
  const worse = (list || []).slice(1).find((e) => e && order.indexOf(e.privacy.level) > order.indexOf(main.privacy.level));
  // Nothing known about this engine's privacy: no line here (hide what is unknown; "Privacy en gegevens" lists it).
  if (main.privacy.level === 'unknown' && !worse) return null;
  return (
    <div className="space-y-1" data-testid="agent-privacy">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
        <EngineLine e={{ ...main, role: 'main' }} />
        <a href="#/settings/data" className="inline-flex h-6 w-6 items-center justify-center rounded text-muted hover:text-fg coarse:h-11 coarse:w-11" aria-label="Wat verlaat je pc?" title="Wat verlaat je pc?">
          <Info className="h-3.5 w-3.5" aria-hidden />
        </a>
      </div>
      {worse && <EngineLine e={{ ...worse, role: 'reserve' }} />}
    </div>
  );
}
