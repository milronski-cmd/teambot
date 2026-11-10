import { useEffect, useState } from 'react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatDateTime, formatNumber, formatUsd } from '../../lib/format';
import type { Agent } from '../../lib/types';
import { Field, Input } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';

/** GET /api/usage/bots/:id/cap (server/modules/usage/cap.ts). */
interface CapStatus {
  cap: { kind: 'usd' | 'tokens'; amount: number; period: 'day' | 'week' } | null;
  used: { usd: number; tokens: number } | null;
  resetAt: string | null;
  reached: boolean;
}

type Cap = { kind: '' | 'usd' | 'tokens'; amount: number | ''; period: 'day' | 'week' };

const capOf = (s: any): Cap => ({
  kind: s?.kind === 'usd' || s?.kind === 'tokens' ? s.kind : '',
  amount: typeof s?.amount === 'number' && s.amount > 0 ? s.amount : '',
  period: s?.period === 'week' ? 'week' : 'day',
});

/**
 * Bot editor › Gebruikslimiet: at most so much spend or so many tokens per day or week for this bot (every engine,
 * also a subscription). Reached: the bot pauses with one message until the next day or week. Saved with the editor's
 * own "Opslaan" (`settings.usageCap`); what it used so far comes from the server.
 */
export function BotCapSection({ agent, onChange }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  const cap = capOf(agent.settings?.usageCap);
  const [status, setStatus] = useState<CapStatus | null>(null);
  useEffect(() => {
    if (!agent.id) return;
    let live = true;
    const load = () => void api.get<CapStatus>(`/usage/bots/${agent.id}/cap`).then((s) => live && setStatus(s)).catch(() => {});
    load();
    // After each finished run of this bot: what it used went up.
    const off = on('run.updated', (r: any) => r?.agent_id === agent.id && ['done', 'error', 'cancelled'].includes(r.status) && load());
    return () => {
      live = false;
      off();
    };
  }, [agent.id, JSON.stringify(agent.settings?.usageCap ?? null)]);
  const set = (p: Partial<Cap>) => {
    const next = { ...cap, ...p };
    const settings = { ...(agent.settings || {}) };
    if (!next.kind) delete settings.usageCap;
    else settings.usageCap = { kind: next.kind, amount: next.amount === '' ? 0 : Number(next.amount), period: next.period };
    onChange({ settings });
  };
  const used = status?.cap && status.used ? (status.cap.kind === 'usd' ? status.used.usd : status.used.tokens) : null;
  return (
    <div className="space-y-3" data-testid="bot-cap">
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Limiet">
          <Select value={cap.kind} onChange={(e) => set({ kind: e.target.value as Cap['kind'] })}>
            <option value="">Geen limiet</option>
            <option value="usd">Kosten (US$)</option>
            <option value="tokens">Tokens</option>
          </Select>
        </Field>
        {cap.kind && (
          <Field label={cap.kind === 'usd' ? 'Hoogstens (US$)' : 'Hoogstens (tokens)'}>
            <Input type="number" inputMode="decimal" min={0} step={cap.kind === 'usd' ? 0.5 : 1000} value={cap.amount} onChange={(e) => set({ amount: e.target.value === '' ? '' : Math.max(0, Number(e.target.value)) })} />
          </Field>
        )}
        {cap.kind && (
          <Field label="Per">
            <Select value={cap.period} onChange={(e) => set({ period: e.target.value === 'week' ? 'week' : 'day' })}>
              <option value="day">Dag</option>
              <option value="week">Week (vanaf maandag)</option>
            </Select>
          </Field>
        )}
      </div>
      <p className="text-xs text-muted">Telt op elke engine. Bij de limiet pauzeert de bot tot de volgende dag of week.</p>
      {status?.cap && used !== null && (
        <p className={status.reached ? 'text-sm font-medium text-warn' : 'text-sm text-muted'} role="status">
          {status.cap.kind === 'usd'
            ? status.cap.period === 'week'
              ? t('Deze week gebruikt: {0} van {1}.', formatUsd(used), formatUsd(status.cap.amount))
              : t('Vandaag gebruikt: {0} van {1}.', formatUsd(used), formatUsd(status.cap.amount))
            : status.cap.period === 'week'
              ? t('Deze week gebruikt: {0} van {1} tokens.', formatNumber(used), formatNumber(status.cap.amount))
              : t('Vandaag gebruikt: {0} van {1} tokens.', formatNumber(used), formatNumber(status.cap.amount))}
          {status.reached && status.resetAt ? ` ${t('Gepauzeerd tot {0}.', formatDateTime(status.resetAt, { weekday: 'short', hour: '2-digit', minute: '2-digit' }))}` : ''}
        </p>
      )}
    </div>
  );
}
