import { useEffect, useState } from 'react';
import { Coffee, Power } from 'lucide-react';
import { api, on } from '../lib/api';
import { useApp } from '../lib/store';
import { cx } from '../components/ui';
import { SettingsSection, SwitchRow, useSave } from '../components/SettingControls';
import { t } from '../lib/i18n';

/** "Houd de pc wakker terwijl routines of taken lopen" (A-76): state from the server's power module. */
export interface PowerState {
  available: boolean;
  enabled: boolean;
  active: boolean;
  reason: string | null;
}

export function usePowerState(): [PowerState | null, (p: PowerState) => void] {
  const [s, setS] = useState<PowerState | null>(null);
  useEffect(() => {
    let live = true;
    api
      .get<PowerState>('/power')
      .then((x) => live && setS(x))
      .catch(() => {});
    const off = on('power.state', (x: PowerState) => setS(x));
    return () => {
      live = false;
      off();
    };
  }, []);
  return [s, setS];
}

/** Settings › Algemeen: the option itself (on by default). */
export function KeepAwakeSetting() {
  const [s, setS] = usePowerState();
  if (!s) return null;
  return (
    <SettingsSection icon={Power} tone="blue" title="Pc en routines">
      <KeepAwakeRow s={s} setS={setS} />
      {s.enabled && s.available && (
        <p className={cx('flex items-center gap-1.5 py-3 text-xs font-medium', s.active ? 'text-ok' : 'text-muted')} role="status">
          <Coffee className="h-3.5 w-3.5" aria-hidden />
          {s.active ? `Nu wakker: ${s.reason}` : 'Nu niet nodig: er loopt niets en er start binnen een half uur geen routine.'}
        </p>
      )}
    </SettingsSection>
  );
}

/** The switch (inside the section, so a change shows "Opgeslagen" there). */
function KeepAwakeRow({ s, setS }: { s: PowerState; setS(p: PowerState): void }) {
  const role = useApp((x) => x.me?.role);
  const [busy, setBusy] = useState(false);
  const save = useSave();
  const canChange = s.available && (role === 'owner' || role === 'admin');
  const set = async (enabled: boolean) => {
    setBusy(true);
    await save(api.put<PowerState>('/power', { enabled }).then(setS));
    setBusy(false);
  };
  return (
    <SwitchRow
      checked={s.enabled}
      disabled={!canChange || busy}
      onChange={set}
      setting="power.enabled"
      hint={s.available ? undefined : 'Kan alleen in de desktop-app van TeamBot, op de pc waar TeamBot draait.'}
      info={s.available ? 'De pc gaat dan niet in slaapstand zolang een bot aan het werk is of een routine binnen een half uur start. Kost iets meer stroom.' : undefined}
    />
  );
}

/** Sidebar: visible while TeamBot keeps the computer awake. */
export function AwakeIndicator({ className }: { className?: string }) {
  const [s] = usePowerState();
  if (!s?.active) return null;
  return (
    <a
      href="#/settings/systeem"
      role="status"
      title={t('Pc blijft wakker: {0}. Uitzetten in Instellingen › Meer mogelijkheden › Deze computer.', t(s.reason ?? ''))}
      className={cx('flex h-8 items-center gap-2 rounded-control px-2.5 text-[12.5px] font-medium text-muted hover:bg-surface-2 hover:text-fg coarse:h-11', className)}
    >
      <Coffee className="h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />
      <span className="min-w-0 truncate">Pc blijft wakker · {s.reason}</span>
    </a>
  );
}
