import { useEffect, useState } from 'react';
import { Shuffle } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Button, Card, Field, Spinner, useAsync } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';

/** What GET /api/engine-chain/settings gives (module engine-chain, package D2; `teams` since B4). */
interface ChainInfo {
  settings: { enabled: boolean; minLevel: string; weeklyReserve: number };
  levels: { id: string; label: string }[];
  teams?: Record<string, Partial<{ enabled: boolean; minLevel: string; weeklyReserve: number }>>;
}

/** '' = follow the general setting (Instellingen › Gratis doorschakelen). */
type Choice = { enabled: '' | 'on' | 'off'; minLevel: string; weeklyReserve: string };

const RESERVES = [0, 50, 70, 85, 90, 95];

/**
 * Team settings › "Gratis doorschakelen voor dit team" (package B4; only with two or more teams): a team can switch the
 * default chain off, keep important work on another minimum level, or use another weekly reserve. Every field can
 * stay on "zoals bij alle teams". A group's team counts first, else the bot's home team.
 */
export function TeamChainCard({ teamId }: { teamId: string }) {
  const [info, setInfo] = useState<ChainInfo | null>(null);
  const [missing, setMissing] = useState(false);
  const [c, setC] = useState<Choice>({ enabled: '', minLevel: '', weeklyReserve: '' });
  const { busy, run } = useAsync();
  useEffect(() => {
    const load = () =>
      api.get<ChainInfo>('/engine-chain/settings').then(
        (r) => {
          setInfo(r);
          const o = r.teams?.[teamId] || {};
          setC({ enabled: o.enabled === undefined ? '' : o.enabled ? 'on' : 'off', minLevel: o.minLevel || '', weeklyReserve: o.weeklyReserve === undefined ? '' : String(o.weeklyReserve) });
        },
        () => setMissing(true),
      );
    load();
    return on('engine-chain.settings', load);
  }, [teamId]);
  if (missing) return null;
  if (!info) return <Spinner />;
  const g = info.settings;
  const levelName = (id: string) => info.levels.find((l) => l.id === id)?.label || id;
  const save = () =>
    run(async () => {
      const r = await api.put<{ settings: ChainInfo['settings'] }>(`/engine-chain/settings/teams/${encodeURIComponent(teamId)}`, {
        enabled: c.enabled === '' ? null : c.enabled === 'on',
        minLevel: c.minLevel || null,
        weeklyReserve: c.weeklyReserve === '' ? null : Number(c.weeklyReserve),
      });
      void r;
    }, 'Opgeslagen');
  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center gap-2 font-semibold">
        <Shuffle className="h-4 w-4 text-accent" /> Gratis doorschakelen voor dit team
      </div>
      <p className="text-sm text-muted">Wat de bots van dit team doen als hun model op is.</p>
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Doorschakelen">
          <Select value={c.enabled} onChange={(e) => setC({ ...c, enabled: e.target.value as Choice['enabled'] })}>
            <option value="">{g.enabled ? 'Zoals bij alle teams (aan)' : 'Zoals bij alle teams (uit)'}</option>
            <option value="on">Aan</option>
            <option value="off">Uit</option>
          </Select>
        </Field>
        <Field label="Belangrijk werk draait alleen op">
          <Select value={c.minLevel} onChange={(e) => setC({ ...c, minLevel: e.target.value })}>
            <option value="">{t('Zoals bij alle teams ({0})', levelName(g.minLevel))}</option>
            {info.levels.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Weekreserve">
          <Select value={c.weeklyReserve} onChange={(e) => setC({ ...c, weeklyReserve: e.target.value })}>
            <option value="">{g.weeklyReserve ? t('Zoals bij alle teams ({0}%)', g.weeklyReserve) : 'Zoals bij alle teams (uit)'}</option>
            {RESERVES.map((n) => (
              <option key={n} value={String(n)}>
                {n ? `${n}%` : 'Uit'}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="primary" onClick={save} loading={busy}>
          Opslaan
        </Button>
      </div>
    </Card>
  );
}
