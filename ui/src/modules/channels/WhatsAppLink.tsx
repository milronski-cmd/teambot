import { useCallback, useEffect, useState } from 'react';
import { Link2, Link2Off, QrCode, ShieldAlert, Smartphone } from 'lucide-react';
import { api, on } from '../../lib/api';
import { uiLocale } from '../../lib/i18n';
import { Badge, Button, Card, CardHead, Field, Input, Modal, Spinner, useAsync } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { isGone, type BindingDetail, type WaLink } from './shared';
import { QR_RISK } from './picker';

interface WaState extends WaLink {
  qrSvg: string | null;
  status: string;
  enabled: boolean;
  last_error: string | null;
  info: { phone?: string; name?: string; linkedAt?: string };
}

/** The honest warning: shown before connecting (Kanaal toevoegen) and on the channel itself. */
export function WhatsAppHonestNote({ compact }: { compact?: boolean }) {
  return (
    <Card className="flex gap-3 border-danger bg-danger-soft p-3 text-sm" role="note">
      <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" aria-hidden />
      <div className="space-y-1">
        <div className="font-semibold text-danger">{QR_RISK.title}</div>
        {(compact ? QR_RISK.lines.slice(0, 2) : QR_RISK.lines).map((l) => (
          <div key={l}>{l}</div>
        ))}
        {!compact && <div className="text-muted">Ontkoppelen kan altijd: hier, of op je telefoon bij Gekoppelde apparaten.</div>}
      </div>
    </Card>
  );
}

const PHASE_TEXT: Record<WaLink['phase'], string> = {
  starting: 'WhatsApp Web starten…',
  qr: 'Scan de QR-code met je telefoon',
  code: 'Voer de code in op je telefoon',
  syncing: 'Gekoppeld — berichten en contacten ophalen…',
  ready: 'Gekoppeld',
  stopped: 'Niet verbonden',
  error: 'Probleem met de verbinding',
};

/** Pairing card for WhatsApp (QR): QR code or pairing code, linked account, unlink. Works on the phone too. */
export function WhatsAppLink({ b, reload, bare }: { b: Pick<BindingDetail, 'id' | 'config'>; reload(): void; bare?: boolean }) {
  const [st, setSt] = useState<WaState | null>(null);
  const [phone, setPhone] = useState(b.config.ownerPhone || '');
  const [askPhone, setAskPhone] = useState(false);
  const [confirmOff, setConfirmOff] = useState(false);
  const act = useAsync();
  const load = useCallback(() => (isGone(b.id) ? Promise.resolve() : api.get<WaState>(`/channels/bindings/${b.id}/whatsapp`).then(setSt, () => setSt(null))), [b.id]);
  useEffect(() => {
    load();
    const offs = [
      on('channels.whatsapp', (d: any) => d.id === b.id && load()),
      on('channels.status', (d: any) => d.id === b.id && load()),
    ];
    return () => offs.forEach((f) => f());
  }, [b.id, load]);

  const link = () =>
    act.run(async () => {
      await api.post(`/channels/bindings/${b.id}/whatsapp/link`);
      await load();
      reload();
    }, 'Koppelen gestart…');
  const pairPhone = () =>
    act.run(async () => {
      if (!st || (st.phase !== 'qr' && st.phase !== 'code')) await api.post(`/channels/bindings/${b.id}/whatsapp/link`);
      // WhatsApp Web needs a moment before it accepts a phone number.
      for (let i = 0; i < 20; i++) {
        const cur = await api.get<WaState>(`/channels/bindings/${b.id}/whatsapp`);
        if (cur.phase === 'qr' || cur.phase === 'code') break;
        await new Promise((r) => setTimeout(r, 1500));
      }
      await api.post(`/channels/bindings/${b.id}/whatsapp/pair-phone`, { phone });
      setAskPhone(false);
      await load();
    });
  const logout = () =>
    act.run(async () => {
      await api.post(`/channels/bindings/${b.id}/whatsapp/logout`);
      setConfirmOff(false);
      await load();
      reload();
    }, 'Ontkoppeld');

  if (!st)
    return (
      <Card className="flex justify-center p-6">
        <Spinner />
      </Card>
    );
  const linked = st.phase === 'ready' || !!st.info?.phone;
  const waiting = st.phase === 'qr' || st.phase === 'code' || st.phase === 'starting';
  return (
    <>
      <Card className={bare ? 'space-y-4 border-0 p-0' : 'space-y-4 p-4'} data-testid="wa-link" data-phase={st.phase}>
        {!bare && (
          <CardHead
            icon={QrCode}
            tone="blue"
            title="Koppelen met je telefoon"
            action={<Badge tone={st.phase === 'ready' ? 'ok' : st.phase === 'error' ? 'danger' : waiting || st.phase === 'syncing' ? 'warn' : 'neutral'}>{PHASE_TEXT[st.phase] || st.phase}</Badge>}
          />
        )}

        {st.phase === 'ready' && st.me && (
          <div className="rounded-lg bg-ok-soft p-3 text-sm text-ok">
            Gekoppeld als <b>+{st.me.phone}</b>
            {st.me.name ? ` (${st.me.name})` : ''}. Stuur in WhatsApp in je chat <b>“Bericht aan jezelf”</b> een bericht, bijvoorbeeld “@Baas hoe staat het ervoor?”.
          </div>
        )}
        {st.phase === 'syncing' && <div className="text-sm text-muted">Je telefoon is gekoppeld. WhatsApp haalt je gesprekken op{st.percent ? ` (${st.percent}%)` : ''}; dit duurt meestal minder dan een minuut.</div>}

        {st.phase === 'qr' && st.qrSvg && (
          <div className="flex flex-col items-center gap-3 sm:flex-row sm:items-start">
            {/* Rendered by our own server from WhatsApp's pairing data; never sent anywhere else. */}
            <img className="w-56 max-w-full shrink-0 rounded-xl bg-white p-2" alt="QR-code om WhatsApp te koppelen" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(st.qrSvg)}`} />
            <ol className="list-decimal space-y-1.5 ps-5 text-sm">
              <li>Open WhatsApp op je telefoon.</li>
              <li>
                Ga naar <b>Instellingen</b> (iPhone) of <b>⋮</b> (Android) › <b>Gekoppelde apparaten</b> › <b>Apparaat koppelen</b>.
              </li>
              <li>Richt de camera op deze code. De code ververst vanzelf.</li>
              <li className="text-muted">
                Bekijk je dit op je telefoon zelf? Gebruik dan{' '}
                <button type="button" className="font-medium text-accent underline" onClick={() => setAskPhone(true)}>
                  koppelen met telefoonnummer
                </button>
                .
              </li>
            </ol>
          </div>
        )}
        {st.phase === 'code' && st.code && (
          <div className="space-y-2 text-sm">
            <div className="rounded-xl bg-surface-2 p-4 text-center font-mono text-3xl font-semibold tracking-[0.3em]">{st.code.replace(/(.{4})/, '$1-')}</div>
            <p>
              Op je telefoon: WhatsApp › <b>Gekoppelde apparaten</b> › <b>Apparaat koppelen</b> › <b>Koppelen met telefoonnummer</b>, en voer deze code in. WhatsApp stuurt je ook een melding.
            </p>
          </div>
        )}
        {st.phase === 'starting' && st.enabled && (
          <div className="flex items-center gap-2 text-sm text-muted">
            <Spinner className="h-4 w-4" /> {st.detail === 'Sessie herstellen' ? 'Bewaarde sessie herstellen…' : 'Onzichtbaar WhatsApp Web starten (tot een halve minuut)…'}
          </div>
        )}
        {st.expiresAt && waiting && <div className="text-xs text-muted">Koppelen kan tot {new Date(st.expiresAt).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' })}; daarna stopt TeamBot de browser weer.</div>}
        {!waiting && st.phase !== 'ready' && st.phase !== 'syncing' && st.last_error && <div className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{st.last_error}</div>}

        <div className="flex flex-wrap gap-2">
          {st.phase !== 'ready' && st.phase !== 'syncing' && (
            <Button variant="primary" onClick={link} loading={act.busy} icon={<Link2 className="h-4 w-4" />}>
              {linked ? 'Opnieuw verbinden' : waiting ? 'Nieuwe QR-code' : 'Koppelen'}
            </Button>
          )}
          {st.phase !== 'ready' && st.phase !== 'syncing' && (
            <Button variant="secondary" onClick={() => setAskPhone(true)} icon={<Smartphone className="h-4 w-4" />}>
              Koppelen met telefoonnummer
            </Button>
          )}
          {(linked || st.phase === 'syncing') && (
            <Button variant="ghost" className="text-danger" onClick={() => setConfirmOff(true)} icon={<Link2Off className="h-4 w-4" />}>
              Ontkoppelen
            </Button>
          )}
        </div>
        <MoreInfo block label="Wat leest TeamBot?">
          De sessie wordt versleuteld bewaard in je TeamBot-map (sleutel in de TeamBot-kluis). Zolang de verbinding loopt draait er een onzichtbare Edge/Chrome; TeamBot leest alleen je chat “Bericht aan
          jezelf” en berichten van nummers op de allowlist, nooit je andere gesprekken.
        </MoreInfo>
      </Card>
      {!bare && <WhatsAppHonestNote />}

      <Modal
        open={askPhone}
        onClose={() => setAskPhone(false)}
        title="Koppelen met telefoonnummer"
        footer={
          <>
            <Button variant="ghost" onClick={() => setAskPhone(false)}>
              Annuleren
            </Button>
            <Button variant="primary" loading={act.busy} disabled={phone.replace(/\D/g, '').length < 8} onClick={pairPhone}>
              Code maken
            </Button>
          </>
        }
      >
        <Field label="Jouw WhatsApp-nummer" hint="In internationale vorm, zonder + of 0 vooraan, bijv. 31612345678.">
          <Input inputMode="tel" autoComplete="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="31612345678" />
        </Field>
      </Modal>

      <Modal
        open={confirmOff}
        onClose={() => setConfirmOff(false)}
        title="WhatsApp ontkoppelen?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmOff(false)}>
              Annuleren
            </Button>
            <Button variant="danger" loading={act.busy} onClick={logout}>
              Ontkoppelen
            </Button>
          </>
        }
      >
        <p className="text-sm">TeamBot verdwijnt van de lijst Gekoppelde apparaten op je telefoon en de bewaarde sessie wordt gewist. De gesprekken blijven in TeamBot staan. Opnieuw koppelen kan met een nieuwe QR-code.</p>
      </Modal>
    </>
  );
}
