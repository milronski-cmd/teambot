import { useEffect, useState } from 'react';
import { Landmark, RefreshCw } from 'lucide-react';
import { api } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { Button, Card, SectionTitle, Spinner } from '../../components/ui';

interface Overview {
  status: 'off' | 'on' | 'expired';
  from?: string;
  to?: string;
  accounts: { bank: string; name: string; iban: string; currency: string; balances?: { name: string; amount: number; currency: string }[]; at?: string; error?: string }[];
  transactions: { date: string | null; amount: number | null; currency: string; counterparty: string | null; description: string; status: string; account: string }[];
}

export const money = (n: number, currency = 'EUR') => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format(n);
  } catch {
    // An unknown currency code: the amount as the browser writes a number, with the code behind it.
    return `${new Intl.NumberFormat(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(n)} ${currency}`;
  }
};

/** The owner's money on the dashboard: balances and the latest transactions, straight from the bank app. */
export function MoneySection() {
  const [o, setO] = useState<Overview | null>(null);
  const [err, setErr] = useState('');
  const load = () =>
    api.get<Overview>('/mcp/bank/overview').then(
      (r) => (setO(r), setErr('')),
      (e) => (setO({ status: 'off', accounts: [], transactions: [] }), setErr(String(e?.message || e))),
    );
  useEffect(() => {
    void load();
  }, []);

  const total = (o?.accounts || []).reduce((s, a) => s + (a.balances?.[0]?.amount ?? 0), 0);
  const mixed = new Set((o?.accounts || []).map((a) => a.balances?.[0]?.currency).filter(Boolean)).size > 1;

  return (
    <section className="space-y-2" data-testid="dashboard-money">
      <SectionTitle
        icon={Landmark}
        tone="teal"
        action={
          o?.status === 'on' && (
            <Button size="sm" variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={() => (setO(null), void load())}>
              Verversen
            </Button>
          )
        }
      >
        Geld
      </SectionTitle>
      <Card className="p-0">
        {o === null ? (
          <div className="flex justify-center p-6">
            <Spinner />
          </div>
        ) : o.status !== 'on' ? (
          <div className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
            <span className="min-w-0 flex-1 basis-56 text-muted">{err || (o.status === 'expired' ? 'De toestemming bij je bank is verlopen. Geef hem opnieuw bij Apps › Bank.' : 'Koppel je bank en je ziet hier je saldo en je af- en bijschrijvingen. Alleen lezen, nooit betalen.')}</span>
            <Button size="sm" onClick={() => navigate('/m/mcp')}>
              {o.status === 'expired' ? 'Opnieuw koppelen' : 'Bank koppelen'}
            </Button>
          </div>
        ) : (
          <div className="divide-y divide-line">
            <div className="grid grid-cols-1 gap-3 p-4 sm:grid-cols-2">
              {o.accounts.length > 1 && !mixed && (
                <div className="rounded-lg bg-surface-2 p-3">
                  <div className="text-[13px] font-medium text-muted">Samen</div>
                  <div className="text-xl font-bold tracking-tight tabular-nums">{money(total, o.accounts[0].balances?.[0]?.currency)}</div>
                </div>
              )}
              {o.accounts.map((a) => (
                <div key={a.iban} className="rounded-lg bg-surface-2 p-3" data-testid="dashboard-account">
                  <div className="truncate text-[13px] font-medium text-muted" translate="no">
                    {a.name} · {a.bank}
                  </div>
                  {a.balances?.length ? (
                    <div className="text-xl font-bold tracking-tight tabular-nums">{money(a.balances[0].amount, a.balances[0].currency)}</div>
                  ) : (
                    <div className="text-sm text-danger">{a.error || t('Geen saldo ontvangen')}</div>
                  )}
                  <div className="font-mono text-[12px] text-muted">{a.iban}</div>
                </div>
              ))}
            </div>
            {o.transactions.length > 0 ? (
              <ul className="divide-y divide-line" data-testid="dashboard-transactions">
                {o.transactions.slice(0, 12).map((x, i) => (
                  <li key={i} className="flex items-baseline gap-3 px-4 py-2 text-sm">
                    <span className="w-20 shrink-0 text-xs tabular-nums text-muted">{x.date || ''}</span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium" translate="no">
                        {x.counterparty || x.description || '–'}
                      </span>
                      {x.counterparty && x.description && (
                        <span className="block truncate text-xs text-muted" translate="no">
                          {x.description}
                        </span>
                      )}
                    </span>
                    <span className={`shrink-0 font-semibold tabular-nums ${(x.amount ?? 0) < 0 ? '' : 'text-ok'}`}>{x.amount === null ? '' : money(x.amount, x.currency)}</span>
                  </li>
                ))}
              </ul>
            ) : (
              <div className="p-4 text-sm text-muted">{t('Geen af- of bijschrijvingen tussen {0} en {1}.', o.from || '', o.to || '')}</div>
            )}
          </div>
        )}
      </Card>
    </section>
  );
}
