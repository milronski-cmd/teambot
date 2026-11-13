import { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink, FlaskConical, KeyRound, Send, X } from 'lucide-react';
import { api } from '../../lib/api';
import { t, uiLocale } from '../../lib/i18n';
import { Badge, Button, Card, cx, timeAgo, useAsync, copyText } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { newSecretAction, nextStep, testWhere } from './health';
import { StatusBadge, type BindingDetail } from './shared';
import { ComputerOnly, useIsPhoneSession } from '../../shell/computerOnly';

interface TestStart {
  code: string;
  text: string;
  deepLink: string | null;
  qrSvg: string | null;
  expiresAt: string;
}

interface PairStart {
  code: string;
  command: string;
  deepLink: string | null;
  qrSvg: string | null;
  expires_at: string;
}

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });

const PROOF = {
  in: { ok: 'Ontvangen werkt', no: 'Ontvangen nog niet getest', none: '' },
  out: { ok: 'Versturen werkt', no: 'Versturen nog niet getest', none: 'Versturen niet nodig' },
};

function Proof({ ok, side, none }: { ok: boolean; side: 'in' | 'out'; none?: boolean }) {
  const p = PROOF[side];
  return (
    <span className={cx('inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs', ok ? 'bg-ok-soft text-ok' : 'bg-surface-2 text-muted')}>
      {ok ? <Check className="h-3 w-3" aria-hidden /> : <span aria-hidden>·</span>}
      {none ? p.none : ok ? p.ok : p.no}
    </span>
  );
}

/** A link + QR code the owner opens on his phone (Telegram deep link). */
export function PhoneLink({ link, qrSvg, label }: { link: string; qrSvg: string | null; label: string }) {
  return (
    <div className="flex flex-col items-start gap-3 sm:flex-row sm:items-center">
      {qrSvg && <img className="w-36 max-w-full shrink-0 rounded-xl bg-white p-2" alt="QR-code: scan met de camera van je telefoon" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(qrSvg)}`} />}
      <div className="space-y-2 text-sm">
        <a className="inline-flex items-center gap-1 font-medium text-accent underline" href={link} target="_blank" rel="noreferrer noopener">
          {label} <ExternalLink className="h-3.5 w-3.5" />
        </a>
        {qrSvg && <div className="text-xs text-muted">Op de computer? Scan de code met de camera van je telefoon; Telegram opent vanzelf. Druk daar op Start.</div>}
      </div>
    </div>
  );
}

/**
 * Health of a channel: is it proven that messages arrive and leave? The next step when not yet (a test code, or for
 * Telegram one tap to pair yourself), the exact reason when it fails, and the history (last in, last out, last error).
 */
export function HealthCard({ b, reload, onSettings }: { b: BindingDetail; reload(): void; onSettings?(): void }) {
  const h = b.health;
  const [test, setTest] = useState<TestStart | null>(null);
  const [pair, setPair] = useState<PairStart | null>(null);
  const act = useAsync();
  useEffect(() => {
    if (!h?.testing) setTest(null);
  }, [h?.testing]);
  const up = b.enabled && (b.status === 'connected' || b.status === 'listening');
  const ownerPaired = b.senders.some((s) => s.is_owner);
  useEffect(() => {
    if (ownerPaired) setPair(null);
  }, [ownerPaired]);
  // Pairing your own Telegram makes you the owner of the channel: on a paired phone that stays on the computer
  // (server/modules/mobile/policy.ts), so the phone says so instead of a button the server refuses.
  const phone = useIsPhoneSession();
  const ownTelegram = b.adapter === 'telegram' && up && !ownerPaired && !!b.info?.botUsername;
  const telegramPair = ownTelegram && !phone;
  const startTest = () =>
    act.run(async () => {
      setTest(await api.post<TestStart>(`/channels/bindings/${b.id}/health-test`));
      reload();
    });
  const stopTest = () =>
    act.run(async () => {
      await api.del(`/channels/bindings/${b.id}/health-test`);
      setTest(null);
      reload();
    });
  const pairMe = () =>
    act.run(async () => {
      setPair(await api.post<PairStart>(`/channels/bindings/${b.id}/pair-codes`, { owner: true, label: 'Mijn Telegram', minutes: 30 }));
      reload();
    });
  const failing = h && (h.state === 'error' || h.state === 'receive_failed' || h.state === 'send_failed');
  // (on the phone without the "pair your own Telegram" step: the test below is the next step there)
  const step = nextStep(phone ? { ...b, senders: undefined } : b);
  const running = !!h?.testing;
  // A refused token or password: the way to a new one (the error itself only says to make one).
  const newSecret = onSettings ? newSecretAction(b) : null;

  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center gap-2">
        <StatusBadge status={b.status} enabled={b.enabled} link={b.link} health={h} />
        {h && h.state !== 'off' && (
          <>
            <Proof ok={h.receiveOk} side="in" />
            <Proof ok={h.sendOk} side="out" none={!h.sendNeeded} />
          </>
        )}
      </div>

      {failing && h?.reason && <div className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{h.reason}</div>}
      {!failing && b.last_error && <div className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{b.last_error}</div>}
      {newSecret && (
        <Button variant="primary" onClick={onSettings} icon={<KeyRound className="h-4 w-4" />}>
          {newSecret}
        </Button>
      )}
      {step && !pair && <p className="text-sm">{step}</p>}
      {ownTelegram && phone && <ComputerOnly>Je eigen Telegram koppel je op je computer. Daarna weet TeamBot dat jij het bent.</ComputerOnly>}

      {pair && pair.deepLink && (
        <div className="space-y-2 rounded-xl border border-line bg-surface-2 p-3">
          <PhoneLink link={pair.deepLink} qrSvg={pair.qrSvg} label="Open Telegram en druk op Start" />
          <div className="text-xs text-muted">{t('De link werkt één keer, tot {0}. Daarna sta jij op de allowlist als “Dit ben ik”.', hhmm(pair.expires_at))}</div>
        </div>
      )}

      {running && (
        <div className="space-y-3 rounded-xl border border-accent bg-accent-soft p-3">
          <div className="text-sm font-medium">{testWhere(b.adapter, b.config, b.info || {})}</div>
          {test && (
            <div className="flex flex-wrap items-center gap-2">
              <code translate="no" className="rounded-lg bg-surface px-3 py-2 font-mono text-xl font-semibold tracking-wider">
                {test.text}
              </code>
              <Button size="sm" variant="secondary" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copyText(test.text)}>
                Kopiëren
              </Button>
            </div>
          )}
          {test?.deepLink && <PhoneLink link={test.deepLink} qrSvg={test.qrSvg} label="Open Telegram en stuur de test" />}
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <span>{t('TeamBot wacht tot {0} op je bericht en antwoordt dan.', hhmm(h!.testing!.expiresAt))}</span>
            <Button size="sm" variant="ghost" onClick={stopTest} icon={<X className="h-3.5 w-3.5" />}>
              Stoppen
            </Button>
          </div>
        </div>
      )}

      {h?.lastTest && !running && (
        <div className={cx('flex items-start gap-1.5 text-sm', h.lastTest.ok ? 'text-ok' : 'text-danger')}>
          {h.lastTest.ok ? <Check className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <X className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
          <span>
            {t('Test van {0}:', timeAgo(h.lastTest.at))} {h.lastTest.text}
          </span>
        </div>
      )}

      {up && !running && (
        <div className="flex flex-wrap gap-2">
          {telegramPair && (
            <Button variant="primary" onClick={pairMe} loading={act.busy} icon={<Send className="h-4 w-4" />}>
              Koppel mijn Telegram
            </Button>
          )}
          <Button variant={h?.state === 'ok' || telegramPair ? 'secondary' : 'primary'} onClick={startTest} loading={act.busy} icon={<FlaskConical className="h-4 w-4" />}>
            {h?.state === 'ok' ? 'Opnieuw testen' : 'Test ontvangen en versturen'}
          </Button>
        </div>
      )}

      {/* The numbers behind the status stay out of sight until asked for; only a real error shows by itself. */}
      {h?.lastError && (
        <p className="min-w-0 break-words text-xs text-muted">
          Laatste fout: {timeAgo(h.lastError.at)} · {h.lastError.text}
        </p>
      )}
      {h && (
        <MoreInfo block>
        <dl className="grid grid-cols-1 gap-x-4 gap-y-1 text-xs sm:grid-cols-2">
          <div className="flex gap-1">
            <dt className="text-muted">Laatst ontvangen:</dt>
            <dd>{h.inAt ? timeAgo(h.inAt) : 'nog niets'}</dd>
          </div>
          <div className="flex gap-1">
            <dt className="text-muted">Laatst verstuurd:</dt>
            <dd>{h.outAt ? timeAgo(h.outAt) : 'nog niets'}</dd>
          </div>
          <div className="flex flex-wrap gap-1 sm:col-span-2">
            <dt className="text-muted">Afgelopen 24 uur:</dt>
            <dd>
              {t('{0, plural, one {# bericht binnen} other {# berichten binnen}}', h.day.in)} · {t('{0} verstuurd', h.day.out)} ·{' '}
              {h.day.errors ? <Badge tone="danger">{t('{0, plural, one {# fout} other {# fouten}}', h.day.errors)}</Badge> : t('{0, plural, one {# fout} other {# fouten}}', 0)}
            </dd>
          </div>
          {h.platformAt && (
            <div className="flex gap-1 sm:col-span-2">
              <dt className="text-muted">{t('Webhook bevestigd door {0}:', b.adapterLabel)}</dt>
              <dd>{timeAgo(h.platformAt)}</dd>
            </div>
          )}
        </dl>
        </MoreInfo>
      )}
    </Card>
  );
}
