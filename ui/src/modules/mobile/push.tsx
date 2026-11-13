import { useCallback, useEffect, useState } from 'react';
import { Bell, Send } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Badge, Button, Spinner, Toggle, timeAgo, toast, useAsync } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { SavedNote, SwitchRow, useSavedFlag } from '../../components/SettingControls';
import * as pwa from './pwa';
import { Note, Section, type PushInfo } from './parts';

// ------------------------------------------------------------------ push

export function usePushInfo() {
  const [info, setInfo] = useState<PushInfo | null>(null);
  const [err, setErr] = useState('');
  const [local, setLocal] = useState<boolean | null>(null);
  const load = useCallback(() => {
    api
      .get<PushInfo>('/mobile/push')
      .then((i) => {
        setInfo(i);
        setErr('');
      })
      .catch((e) => setErr(e.message));
    pwa
      .currentSubscription()
      .then((s) => setLocal(!!s))
      .catch(() => setLocal(false));
  }, []);
  useEffect(() => {
    load();
    const off = on('mobile.devices.updated', load);
    return () => {
      off();
    };
  }, [load]);
  return { info, setInfo, err, local, load };
}
export type PushState = ReturnType<typeof usePushInfo>;

/**
 * Where alerts go now, under "Altijd ook op de telefoon" (0.4.5: three minutes away from the pc, was 30 seconds): one
 * short line, and when it helps the rest behind Meer informatie.
 */
export function presenceLine(info: PushInfo): { hint: string; more?: string } {
  const mins = Math.max(1, Math.round((info.presence?.awayAfterSeconds || 180) / 60));
  if (info.prefs.alwaysPhone)
    return {
      hint: 'Meldingen gaan naar de pc én naar je telefoon, ook als je achter de pc zit.',
    };
  if (info.presence?.where === 'pc')
    return {
      hint: 'Je zit nu achter de pc: meldingen komen alleen op Windows.',
      more: t('Na {0, plural, one {# minuut} other {# minuten}} niets doen gaan ze naar je telefoon.', mins),
    };
  if (info.presence?.where === 'away')
    return {
      hint: 'Je bent nu niet achter de pc: meldingen gaan naar je telefoon.',
    };
  return {
    hint: 'Zit je achter de pc, dan komen meldingen alleen op Windows.',
    more: t('Na {0, plural, one {# minuut} other {# minuten}} niets doen gaan ze naar je telefoon.', mins),
  };
}

/** "Altijd ook op de telefoon" with where alerts go now: the one notification switch most people need. */
export function AlwaysPhone({ push, busy, setPref }: { push: PushState; busy: boolean; setPref(k: keyof PushInfo['prefs'], v: boolean): void }) {
  const info = push.info!;
  const line = presenceLine(info);
  return (
    <div data-presence={info.presence?.where || 'unknown'}>
      <SwitchRow checked={!!info.prefs.alwaysPhone} disabled={busy} onChange={(v) => setPref('alwaysPhone', v)} setting="push.alwaysPhone" hint={line.hint} info={line.more} />
    </div>
  );
}

export function usePushActions(push: PushState) {
  const { busy, run } = useAsync();
  const [perm, setPerm] = useState<string>(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
  const [results, setResults] = useState<{ label: string; ok: boolean; error?: string }[] | null>(null);
  const info = push.info;
  const active = !!push.local && !!info?.subscribed;
  const toggle = (v: boolean) =>
    run(
      async () => {
        if (v) await pwa.enablePush(info!.publicKey);
        else await pwa.disablePush();
        setPerm(typeof Notification !== 'undefined' ? Notification.permission : 'unsupported');
        push.load();
      },
      v ? 'Meldingen staan aan op dit apparaat' : 'Meldingen staan uit op dit apparaat',
    );
  // A change saves at once; "Opgeslagen" shows where it was made (Waarvoor?, or next to Altijd ook op de telefoon).
  const [saved, track] = useSavedFlag();
  const [lastPref, setLastPref] = useState<keyof PushInfo['prefs'] | ''>('');
  const setPref = (k: keyof PushInfo['prefs'], v: boolean) => {
    setLastPref(k);
    return run(() =>
      track(
        api.put('/mobile/push/prefs', { [k]: v }).then((prefs) => {
          push.setInfo((i) => (i ? { ...i, prefs } : i));
        }),
      ),
    );
  };
  const savedAlways = saved && lastPref === 'alwaysPhone';
  const savedPrefs = saved && lastPref !== 'alwaysPhone';
  const test = () =>
    run(async () => {
      const r = await api.post('/mobile/push/test', { thisDevice: active });
      setResults(r.results);
      toast(r.sent === 1 ? 'Testmelding verstuurd naar 1 apparaat' : r.sent ? t('Testmelding verstuurd naar {0} apparaten', r.sent) : 'Testmelding niet afgeleverd', r.sent ? 'ok' : 'danger');
    });
  return {
    busy,
    perm,
    results,
    active,
    toggle,
    setPref,
    test,
    savedAlways,
    savedPrefs,
  };
}
export type PushActions = ReturnType<typeof usePushActions>;

/** Web Push on this device, what alerts are for, a test, and the devices that get them. */
export function PushDetails({ push, act, isDevice }: { push: PushState; act: PushActions; isDevice: boolean }) {
  const info = push.info!;
  const plat = pwa.platform();
  const native = pwa.isNativeApp();
  const supported = pwa.pushSupported();
  const iosNeedsInstall = plat === 'ios' && !pwa.isStandalone() && !native;
  const blockers: string[] = [];
  if (native) blockers.push(`In de iPhone-app lopen meldingen via Apple (APNs): ${info.apns.detail || '…'}`);
  else if (!window.isSecureContext) blockers.push(`Meldingen werken alleen via https. Gebruik een https-adres, bijv. via Tailscale.`);
  else if (iosNeedsInstall) blockers.push('Op iPhone en iPad werken meldingen alleen in TeamBot op je beginscherm. Zie Installeren hieronder.');
  else if (!supported) blockers.push('Deze browser ondersteunt hier geen pushmeldingen.');
  if (act.perm === 'denied' && !native) blockers.push('Meldingen zijn geblokkeerd voor deze site. Zet ze aan in de instellingen van je browser of telefoon.');
  return (
    <>
      {blockers.map((b) => (
        <Note key={b} tone="warn">
          {b}
        </Note>
      ))}
      {!native && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <Toggle checked={act.active} disabled={act.busy || push.local === null || (!act.active && blockers.length > 0)} onChange={act.toggle} label="Meldingen op dit apparaat" />
          <Button size="sm" loading={act.busy} disabled={!info.subscriptions.length && !info.apns.configured} onClick={act.test} icon={<Send className="h-3.5 w-3.5" />}>
            Testmelding
          </Button>
        </div>
      )}
      {act.results && (
        <ul className="space-y-1 text-sm">
          {act.results.map((r, i) => (
            <li key={i} className={r.ok ? 'text-ok' : 'text-danger'}>
              {r.label}: {r.ok ? 'afgeleverd bij de pushdienst' : r.error}
            </li>
          ))}
        </ul>
      )}
      <div className="border-t border-line pt-3">
        <div className="flex items-center gap-3">
          <div className="min-w-0 flex-1 text-sm font-semibold">Waarvoor?</div>
          <SavedNote shown={act.savedPrefs} />
        </div>
        <div className="divide-y divide-line">
          <SwitchRow checked={info.prefs.approvals} disabled={act.busy} onChange={(v) => act.setPref('approvals', v)} setting="push.approvals" />
          <SwitchRow checked={info.prefs.agent} disabled={act.busy} onChange={(v) => act.setPref('agent', v)} setting="push.agent" />
          <SwitchRow checked={info.prefs.runDone} disabled={act.busy} onChange={(v) => act.setPref('runDone', v)} setting="push.runDone" />
          <SwitchRow checked={info.prefs.preview} disabled={act.busy} onChange={(v) => act.setPref('preview', v)} setting="push.preview" />
        </div>
      </div>
      {!isDevice && info.subscriptions.length > 0 && (
        <div className="space-y-1 border-t border-line pt-3 text-sm">
          <div className="font-medium">Apparaten met meldingen</div>
          {info.subscriptions.map((s) => (
            <div key={s.id} className="flex flex-wrap items-center gap-1.5">
              <span>{s.label}</span>
              {s.current && <Badge tone="accent">dit apparaat</Badge>}
              {s.last_error ? <span className="text-xs text-danger">{s.last_error}</span> : s.last_ok ? <span className="text-xs text-muted">laatst afgeleverd {timeAgo(s.last_ok)}</span> : null}
            </div>
          ))}
        </div>
      )}
    </>
  );
}

export const pushSubtitle = (
  <>
    Een melding opent alleen TeamBot. <MoreInfo>Goedkeuren doe je altijd zelf in de app — nooit vanuit de melding.</MoreInfo>
  </>
);

/** On a phone: the full notification settings of this device. */
export function PushSection({ push, isDevice }: { push: PushState; isDevice: boolean }) {
  const act = usePushActions(push);
  return (
    <Section icon={Bell} tone="orange" title="Pushmeldingen" subtitle={pushSubtitle} actions={<SavedNote shown={act.savedAlways} />}>
      {push.err && <Note tone="danger">{push.err}</Note>}
      {!push.info && !push.err && <Spinner />}
      {push.info && (
        <>
          <PushDetails push={push} act={act} isDevice={isDevice} />
          <div className="border-t border-line">
            <AlwaysPhone push={push} busy={act.busy} setPref={act.setPref} />
          </div>
        </>
      )}
    </Section>
  );
}
