import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { t, uiLocale } from '../lib/i18n';
import { formatMoney } from '../lib/format';
import { Badge, Button, Card, Input, Spinner, toast, toastError } from '../components/ui';
import { MoreInfo } from '../components/MoreInfo';
import { Segmented } from '../components/SettingControls';

interface UsageRow {
  id: string;
  name: string;
  email: string | null;
  role: string;
  today: number;
  cost: number;
  tokens: number;
  calls: number;
  budget: number;
  budgetOverride: number | null;
  providers: { id: string; name: string; shared: boolean; cost: number; calls: number }[];
}

// In the reader's notation (C-17): "US$ 1,25" in Dutch, "$1.25" in English.
const usd = (n: number) => formatMoney(n || 0, 'USD', { minimumFractionDigits: n >= 10 ? 0 : 2, maximumFractionDigits: n >= 10 ? 0 : 2 });

/** Team usage per person (PRV-06): spend today and in the period, budget, and a personal budget for members. */
export function TeamUsageCard() {
  const [days, setDays] = useState(30);
  const [rows, setRows] = useState<UsageRow[] | null>(null);
  const [edit, setEdit] = useState<Record<string, string>>({});
  const load = () => api.get<{ users: UsageRow[] }>(`/admin/usage?days=${days}`).then((r) => setRows(r.users)).catch(toastError);
  useEffect(() => {
    void load();
  }, [days]);
  const saveBudget = async (u: UsageRow) => {
    const raw = (edit[u.id] ?? '').trim();
    try {
      await api.put(`/admin/usage/budget/${u.id}`, { dailyBudgetUsd: raw === '' ? null : Number(raw.replace(',', '.')) });
      toast(raw === '' ? 'Standaardbudget hersteld' : 'Budget opgeslagen', 'ok');
      setEdit((e) => {
        const n = { ...e };
        delete n[u.id];
        return n;
      });
      await load();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Card className="space-y-3 p-5">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="min-w-0 flex-1 text-[15px] font-bold tracking-tight">Gebruik per persoon</h2>
        <Segmented
          size="sm"
          label="Periode"
          value={String(days)}
          onChange={(v) => setDays(Number(v))}
          options={[
            { value: '7', label: '7 dagen' },
            { value: '30', label: '30 dagen' },
            { value: '90', label: '90 dagen' },
          ]}
        />
      </div>
      <p className="text-xs text-muted">
        Geschatte kosten, ook via gedeelde providers. <MoreInfo>Persoonlijk dagbudget; leeg = standaard, 0 = geen limiet.</MoreInfo>
      </p>
      {!rows ? (
        <Spinner />
      ) : (
        <div className="divide-y divide-line">
          {rows.map((u) => (
            <div key={u.id} className="space-y-1.5 py-2.5 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-medium">
                  {u.name} <span className="text-xs font-normal text-muted">{u.email}</span>
                </span>
                <Badge tone={u.role === 'member' ? 'neutral' : 'accent'}>{u.role === 'owner' ? 'eigenaar' : u.role === 'admin' ? 'beheerder' : 'lid'}</Badge>
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                <span>
                  Vandaag <b className="text-fg">{usd(u.today)}</b>
                  {u.budget ? ` van ${usd(u.budget)}` : ' (geen limiet)'}
                </span>
                <span>
                  {/* One sentence per form ("1 aanroep"; German "Aufrufe", not the verb "aufrufen"; round 5 C-17). */}
                  {t('{0, plural, one {# dag} other {# dagen}}', days)} <b className="text-fg">{usd(u.cost)}</b> · {t('{0, plural, one {# aanroep} other {# aanroepen}}', u.calls)} · {u.tokens.toLocaleString(uiLocale())} tokens
                </span>
                {u.providers.slice(0, 3).map((p) => (
                  <span key={p.id}>
                    {p.name}
                    {p.shared ? ' (gedeeld)' : ''}: {usd(p.cost)}
                  </span>
                ))}
              </div>
              {u.role === 'member' && (
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    className="w-32"
                    inputMode="decimal"
                    aria-label={`Persoonlijk dagbudget voor ${u.name}`}
                    placeholder="standaard"
                    value={edit[u.id] ?? (u.budgetOverride === null ? '' : String(u.budgetOverride))}
                    onChange={(e) => setEdit({ ...edit, [u.id]: e.target.value })}
                  />
                  <Button size="sm" onClick={() => saveBudget(u)} disabled={edit[u.id] === undefined}>
                    Budget opslaan
                  </Button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
}
