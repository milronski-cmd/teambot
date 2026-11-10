import { useEffect, useState } from 'react';
import { Download, RefreshCw } from 'lucide-react';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { t, uiLocale } from '../../lib/i18n';
import { Button, Field, Input, timeAgo, useAsync } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { useAdvanced } from '../../shell/advanced';
import { ComputerOnly, useIsPhoneSession } from '../../shell/computerOnly';
import type { AppUpdateView, WaitReason } from './types';

/** A reason an update waits, in plain words (desktop/update-idle.ts reasonText says the same in the tray). */
function reasonText(r: WaitReason): string {
  switch (r.kind) {
    case 'runs':
      return t('{0, plural, one {# taak loopt} other {# taken lopen}}', r.count);
    case 'routines':
      return t('{0, plural, one {# routine loopt} other {# routines lopen}}', r.count);
    case 'routine-soon':
      return t('routine “{0}” start zo', r.name);
    case 'backup':
      return t('er wordt een back-up gemaakt');
    case 'chatting':
      return t('je schreef net nog aan een bot');
    case 'user':
      return t('je gebruikt de computer');
    default:
      return t('TeamBot start nog');
  }
}

const list = (items: string[]) => {
  try {
    return new Intl.ListFormat(uiLocale(), { type: 'conjunction' }).format(items);
  } catch {
    return items.join(', ');
  }
};

/** What happens with updates now, in one or two sentences. */
function StatusText({ v }: { v: AppUpdateView }) {
  const s = v.state;
  if (s.phase === 'off') {
    if (v.off === 'server') return <p className="text-sm text-muted">Deze TeamBot draait als server. Je werkt hem bij met de nieuwe versie van het pakket of de container.</p>;
    if (v.off === 'dev' || v.off === 'unpackaged') return <p className="text-sm text-muted">Deze TeamBot draait vanuit de broncode. Zelf bijwerken doet alleen de geïnstalleerde app.</p>;
    if (v.off === 'channel') return <p className="text-sm text-warn">{t('Het updatekanaal werkt niet: {0}', v.channel.error || s.reason)}</p>;
    return <p className="text-sm text-muted">Nieuwe versies van TeamBot krijg je met de volgende installer.</p>;
  }
  if (s.phase === 'checking') return <p className="text-sm text-muted">Zoeken naar een nieuwe versie…</p>;
  if (s.phase === 'error') return <p className="text-sm text-danger">{t('Bijwerken lukte niet: {0}', s.message)}</p>;
  if (s.phase === 'available') return <p className="text-sm">{t('Versie {0} is beschikbaar.', s.version)}</p>;
  if (s.phase === 'downloading') return <p className="text-sm">{t('Versie {0} wordt gedownload: {1}%', s.version, s.percent)}</p>;
  if (s.phase === 'ready') {
    const byItself = v.auto === 'on' && v.skipped !== s.version;
    return (
      <div className="space-y-1 text-sm">
        <p>{t('Versie {0} staat klaar.', s.version)}</p>
        {(v.soon || byItself) && v.waitingFor.length > 0 && <p className="text-muted">{t('TeamBot wacht nog, want {0}.', list(v.waitingFor.map(reasonText)))}</p>}
        {(v.soon || byItself) && v.waitingFor.length === 0 && <p className="text-muted">TeamBot werkt zichzelf zo bij en start daarna opnieuw.</p>}
        {!v.soon && !byItself && <p className="text-muted">TeamBot installeert hem als je op Nu bijwerken klikt of TeamBot afsluit.</p>}
      </div>
    );
  }
  if (v.auto === 'off') return <p className="text-sm text-muted">TeamBot kijkt niet vanzelf naar nieuwe versies.</p>;
  return (
    <p className="text-sm text-muted">
      {s.checkedAt ? t('Je hebt de nieuwste versie (gekeken {0}).', timeAgo(s.checkedAt)) : 'TeamBot kijkt eens per dag of er een nieuwe versie is.'}
    </p>
  );
}

/**
 * Automatic updates of TeamBot itself (parity 16.2, /api/app-update): what happens now, "Nu controleren", "Nu
 * bijwerken", Automatisch bijwerken (aan / alleen melden / uit) and, under Geavanceerd on the computer, the update
 * channel. Also on the phone (the channel stays on the computer).
 */
export function AppUpdateSection() {
  const me = useApp((s) => s.me);
  const phone = useIsPhoneSession();
  const advanced = useAdvanced();
  const [v, setV] = useState<AppUpdateView | null>(null);
  const [channel, setChannel] = useState('');
  const a = useAsync();
  const load = () =>
    api
      .get<AppUpdateView>('/app-update')
      .then((x) => {
        setV(x);
        return x;
      })
      .catch(() => null);
  useEffect(() => {
    load().then((x) => x && setChannel(x.channel.source === 'saved' ? x.channel.input : ''));
    return on('app-update.changed', () => void load());
  }, []);
  if (!v) return null;
  const owner = me?.role === 'owner';
  const s = v.state;
  const canAct = owner && v.managed && s.phase !== 'off';
  const busy = s.phase === 'checking' || s.phase === 'downloading';
  return (
    <div className="space-y-3" data-testid="app-update">
      <StatusText v={v} />
      {v.skipped && <p className="text-sm text-muted">{t('Je ging terug van versie {0}. Die installeert TeamBot niet vanzelf opnieuw.', v.skipped)}</p>}
      {canAct && (
        <div className="flex flex-wrap gap-2">
          {(s.phase === 'available' || s.phase === 'ready' || (s.phase === 'downloading' && !v.soon)) && (
            <Button variant="primary" icon={<Download className="h-4 w-4" />} loading={a.busy} disabled={v.soon} onClick={() => a.run(() => api.post<AppUpdateView>('/app-update/install').then(setV))}>
              Nu bijwerken
            </Button>
          )}
          {(s.phase === 'idle' || s.phase === 'error' || s.phase === 'checking') && (
            <Button icon={<RefreshCw className="h-4 w-4" />} loading={a.busy || busy} onClick={() => a.run(() => api.post<AppUpdateView>('/app-update/check').then(setV))}>
              Nu controleren
            </Button>
          )}
        </div>
      )}
      {owner && v.managed && (
        <Field label="Automatisch bijwerken" hint="Nooit tijdens een taak. Vooraf maakt TeamBot altijd een back-up.">
          <Select value={v.auto} onChange={(e) => a.run(() => api.put<AppUpdateView>('/app-update/settings', { auto: e.target.value }).then(setV), 'Opgeslagen')}>
            <option value="on">Aan: bijwerken als je even niet bezig bent</option>
            <option value="notify">Alleen melden</option>
            <option value="off">Uit</option>
          </Select>
        </Field>
      )}
      {owner && v.managed && advanced &&
        (phone ? (
          <ComputerOnly>Het updatekanaal stel je in op je computer.</ComputerOnly>
        ) : (
          <Field
            label="Updatekanaal"
            hint={
              v.channel.source === 'env'
                ? t('Ingesteld met TEAMBOT_UPDATE_CHANNEL: {0}', v.channel.text)
                : v.channel.source === 'built-in'
                  ? t('Ingebouwd in deze versie: {0}. Vul alleen iets in als je updates ergens anders vandaan wilt.', v.channel.text)
                  : 'Adres van de updatebron. Leeg = de standaardbron.'
            }
          >
            <div className="flex gap-2">
              <Input
                value={channel}
                disabled={v.channel.source === 'env'}
                aria-label="Adres van het updatekanaal"
                placeholder="https://downloads.voorbeeld.nl/teambot/"
                onChange={(e) => setChannel(e.target.value)}
              />
              <Button
                disabled={v.channel.source === 'env'}
                onClick={() =>
                  a.run(
                    () =>
                      api.put<AppUpdateView>('/app-update/channel', { channel }).then((x) => {
                        setV(x);
                        setChannel(x.channel.source === 'saved' ? x.channel.input : '');
                      }),
                    'Updatekanaal opgeslagen',
                  )
                }
              >
                Opslaan
              </Button>
            </div>
          </Field>
        ))}
    </div>
  );
}
