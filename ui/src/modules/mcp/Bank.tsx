import { useEffect, useRef, useState } from 'react';
import { ExternalLink, Landmark } from 'lucide-react';
import { api, on } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { askConfirm, Button, Field, Input, Select, Spinner, Textarea, Toggle, toast, toastError } from '../../components/ui';
import { ConnectCard, ConnectResult, type ConnectState } from '../../components/ConnectCard';
import type { Conn } from './shared';
import { CopyField, openLoginWindow } from './forms';

/** Mirror of GET /api/mcp/bank (server/modules/mcp/bank.ts). */
interface BankState {
  app: { appId: string } | null;
  ownRedirectUrl: string;
  redirectUrl: string;
  /** TeamBot's https page that hands the bank's answer on to this computer (Production takes no http address). */
  relayUrl?: string | null;
  links: { bank: string; country: string; validUntil: string; expired: boolean; accounts: { name: string; iban: string; currency: string }[] }[];
  status: 'off' | 'on' | 'expired';
  connection: Conn | null;
}
interface BankChoice {
  name: string;
  country: string;
  business: boolean;
  personal: boolean;
  days: number;
}

/** The countries a bank can be chosen from first; any other two-letter code can be typed. */
const COUNTRIES: [string, string][] = [
  ['NL', 'Nederland'],
  ['BE', 'België'],
  ['DE', 'Duitsland'],
  ['FR', 'Frankrijk'],
  ['ES', 'Spanje'],
  ['IT', 'Italië'],
  ['PT', 'Portugal'],
  ['PL', 'Polen'],
  ['AT', 'Oostenrijk'],
  ['IE', 'Ierland'],
  ['LU', 'Luxemburg'],
  ['DK', 'Denemarken'],
  ['SE', 'Zweden'],
  ['FI', 'Finland'],
  ['NO', 'Noorwegen'],
  ['GB', 'Verenigd Koninkrijk'],
];

const Link = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-sm font-medium hover:bg-surface-2">
    {children} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
  </a>
);

/**
 * Once: the owner's own application at Enable Banking (free for his own accounts). Three short steps, then the
 * application ID and the key file. Saving checks them with one real call.
 */
function AppForm({ s, onSaved }: { s: BankState; onSaved(next: BankState): void }) {
  const [appId, setAppId] = useState('');
  const [key, setKey] = useState('');
  const [other, setOther] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    try {
      onSaved(await api.put<BankState>('/mcp/bank/app', { appId, privateKey: key, redirectUrl: other }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const steps: { text: string; href?: string; label?: string }[] = [
    { text: 'Maak een gratis account bij Enable Banking en maak daar een applicatie (omgeving “Production”).', href: 'https://enablebanking.com/cp/applications', label: 'Applicaties' },
    { text: 'Zet bij “Redirect URLs” het adres hieronder, en bewaar het sleutelbestand (.pem) dat je krijgt.' },
    { text: 'Koppel in dat paneel je eigen rekeningen (“Activate by linking accounts”): voor je eigen rekeningen is het gratis.' },
  ];
  return (
    <div className="space-y-3 rounded-lg bg-surface-2 p-3 text-sm" data-testid="bank-app-form">
      <div className="font-medium">Eenmalig: je eigen applicatie bij Enable Banking (ongeveer 10 minuten)</div>
      <ol className="space-y-2">
        {steps.map((x, i) => (
          <li key={x.text} className="flex flex-wrap items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface text-xs font-semibold">{i + 1}</span>
            <span className="min-w-0 flex-1 basis-56">{x.text}</span>
            {x.href && <Link href={x.href}>{x.label}</Link>}
          </li>
        ))}
      </ol>
      <CopyField value={s.relayUrl || s.ownRedirectUrl} label="Redirect-URL" />
      {s.relayUrl && <p className="text-xs text-muted">{t('Enable Banking neemt voor echte rekeningen alleen een https-adres aan. Dit adres is een doorstuurpagina van TeamBot: zij geeft het antwoord van de bank door aan TeamBot op deze computer en bewaart niets. Voor de proefomgeving (Sandbox) kan ook {0}.', s.ownRedirectUrl)}</p>}
      <Field label="Applicatie-ID">
        <Input value={appId} onChange={(e) => setAppId(e.target.value)} placeholder="1a2b3c4d-1234-5678-9abc-1a2b3c4d5e6f" autoComplete="off" className="font-mono text-xs" />
      </Field>
      <Field label="Sleutel (de inhoud van het .pem-bestand)">
        <Textarea rows={3} value={key} onChange={(e) => setKey(e.target.value)} className="font-mono text-xs" placeholder="-----BEGIN PRIVATE KEY-----" aria-label="Sleutel van de applicatie" />
      </Field>
      <Field label="Ander terugkeeradres (alleen als je applicatie al een ander adres heeft)" hint="Laat leeg om het adres hierboven te gebruiken. Een applicatie voor echte rekeningen (Production) neemt bij Enable Banking alleen een adres aan dat met https:// begint: vul dan hier het https-adres in dat bij je applicatie staat. Kom je na het inloggen bij de bank niet vanzelf in TeamBot uit, plak dan hieronder het adres waar je uitkwam.">
        <Input value={other} onChange={(e) => setOther(e.target.value)} placeholder={s.relayUrl || 'https://…'} autoComplete="off" />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={busy} disabled={!appId.trim() || !key.trim()} onClick={save} data-testid="bank-app-save">
          Opslaan en controleren
        </Button>
        <label className="inline-flex h-9 cursor-pointer items-center rounded-lg px-3 text-sm font-medium text-muted hover:bg-surface hover:text-fg">
          Of kies het sleutelbestand
          <input
            type="file"
            accept=".pem,.key,text/plain"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (!f) return;
              setKey(await f.text());
              // Enable Banking names the key file after the application: its id is then filled in too.
              const id = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\./i.exec(f.name)?.[1];
              if (id && !appId.trim()) setAppId(id);
            }}
          />
        </label>
      </div>
    </div>
  );
}

/** Choose a bank and give permission at the bank itself. */
function LinkForm({ s, onDone, onCancel }: { s: BankState; onDone(next?: BankState): void; onCancel?(): void }) {
  const [country, setCountry] = useState('NL');
  const [banks, setBanks] = useState<BankChoice[] | null>(null);
  const [bank, setBank] = useState('');
  const [business, setBusiness] = useState(false);
  const [waiting, setWaiting] = useState('');
  const [pasted, setPasted] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const elsewhere = s.redirectUrl !== s.ownRedirectUrl;

  useEffect(() => {
    let live = true;
    setBanks(null);
    setBank('');
    api
      .get<{ banks: BankChoice[] }>(`/mcp/bank/banks?country=${country}`)
      .then((r) => live && (setBanks(r.banks), setErr('')))
      .catch((e) => live && (setBanks([]), setErr(e.message)));
    return () => {
      live = false;
    };
  }, [country]);

  const chosen = banks?.find((b) => b.name === bank);
  const start = async () => {
    const w = openLoginWindow();
    setBusy(true);
    setErr('');
    try {
      const r = await api.post<{ url: string }>('/mcp/bank/link', { bank, country, business, days: chosen?.days || undefined });
      if (w && !w.closed) w.location.href = r.url;
      else window.open(r.url, '_blank', 'noopener');
      setWaiting(r.url);
    } catch (e: any) {
      w?.close();
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const finish = async () => {
    setBusy(true);
    try {
      onDone(await api.post<BankState>('/mcp/bank/finish', { url: pasted }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  if (waiting)
    return (
      <div className="space-y-2 rounded-lg bg-surface-2 p-3 text-sm" role="status" data-testid="bank-waiting">
        <div className="flex items-center gap-2 font-medium">
          <Spinner /> Geef toestemming bij je bank in het venster dat is geopend…
        </div>
        {elsewhere && (
          <div className="space-y-2">
            <div className="text-xs text-muted">
              {s.relayUrl && s.redirectUrl === s.relayUrl
                ? t('Na je akkoord kom je vanzelf terug in TeamBot. Gebeurt dat niet, plak dan hier het adres uit de adresbalk van de pagina waar je uitkomt.')
                : t('Je applicatie stuurt je daarna naar een ander adres dan TeamBot. Plak hier het adres uit de adresbalk van de pagina waar je uitkomt (ook als die pagina niet laadt).')}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input value={pasted} onChange={(e) => setPasted(e.target.value)} placeholder="https://…?code=…" aria-label="Adres waar de bank je naartoe stuurde" className="min-w-0 flex-1 basis-56 font-mono text-xs" />
              <Button variant="primary" loading={busy} disabled={!pasted.trim()} onClick={finish}>
                Koppelen
              </Button>
            </div>
          </div>
        )}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
          <a href={waiting} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-fg underline">
            <ExternalLink className="h-3.5 w-3.5" /> Geen venster gezien? Open de pagina van de bank
          </a>
          <button type="button" className="text-muted underline hover:text-fg" onClick={() => setWaiting('')}>
            Annuleren
          </button>
        </div>
      </div>
    );

  return (
    <div className="space-y-3" data-testid="bank-link-form">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Land">
          <Select value={country} onChange={(e) => setCountry(e.target.value)}>
            {COUNTRIES.map(([code, name]) => (
              <option key={code} value={code}>
                {name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Bank">
          <Select value={bank} onChange={(e) => setBank(e.target.value)} disabled={!banks?.length} data-testid="bank-choice">
            <option value="">{!banks ? 'Laden…' : banks.length ? 'Kies je bank' : 'Geen banken gevonden'}</option>
            {(banks || []).map((b) => (
              <option key={b.name} value={b.name}>
                {b.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {chosen?.business && chosen.personal && <Toggle checked={business} onChange={setBusiness} label="Zakelijke rekening (de bank toont dan het zakelijke inlogscherm)" />}
      {chosen && chosen.days > 0 && <div className="text-xs text-muted">{t('De toestemming geldt bij deze bank hooguit {0, plural, one {# dag} other {# dagen}}; daarna geef je hem opnieuw.', Math.min(180, chosen.days))}</div>}
      {err && <ConnectResult ok={false}>{err}</ConnectResult>}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Landmark className="h-4 w-4" />} loading={busy} disabled={!bank} onClick={start} data-testid="bank-link">
          Bank koppelen
        </Button>
        {onCancel && (
          <Button variant="ghost" onClick={onCancel}>
            Annuleren
          </Button>
        )}
      </div>
    </div>
  );
}

/** The bank on the Apps page: the bots read balances and transactions of the owner's own accounts (reading only). */
export function BankCard() {
  const [s, setS] = useState<BankState | null>(null);
  const [phase, setPhase] = useState<'idle' | 'app' | 'link' | 'testing'>('idle');
  const [err, setErr] = useState('');
  const [ok, setOk] = useState('');
  const live = useRef(true);

  const load = () =>
    api
      .get<BankState>('/mcp/bank')
      .then((x) => live.current && setS(x))
      .catch((e) => live.current && setErr(e.message));

  useEffect(() => {
    live.current = true;
    load();
    const off = on('mcp.oauth', (ev: any) => {
      if (!ev?.bank) return;
      if (ev.ok) {
        toast('De bank is gekoppeld', 'ok');
        setPhase('idle');
        setErr('');
        load();
      } else setErr(ev.error || 'Bank koppelen mislukt');
    });
    return () => {
      live.current = false;
      off();
    };
  }, []);

  const test = async () => {
    if (!s?.connection) return;
    setPhase('testing');
    setErr('');
    setOk('');
    try {
      const r = await api.post<any>(`/mcp/connections/${s.connection.id}/test`, { tool: 'bank_balances', args: {} });
      const text = JSON.stringify(r);
      if (/De bank gaf een fout/.test(text) || /\\"error\\"/.test(text)) setErr(text.match(/De bank gaf een fout: ([^"\\]+)/)?.[1] || 'De bank gaf geen saldo terug.');
      else setOk('Verbinding werkt: het saldo is gelezen.');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      if (live.current) setPhase('idle');
    }
  };

  const unlink = async (bank: string, country: string) => {
    const question = t('{0} ontkoppelen? TeamBot beëindigt de toestemming ook bij de bank.', bank);
    if (!(await askConfirm(question, { ok: 'Ontkoppelen', danger: true }))) return;
    try {
      setS(await api.post<BankState>('/mcp/bank/unlink', { bank, country }));
    } catch (e) {
      toastError(e);
    }
  };

  const remove = async () => {
    if (!(await askConfirm('De bank helemaal weghalen? Je applicatie-ID en sleutel worden ook vergeten.', { ok: 'Weghalen', danger: true }))) return;
    try {
      if (s?.connection) await api.del(`/mcp/connections/${s.connection.id}`);
      await api.put('/mcp/bank/app', { forget: true });
      setPhase('idle');
      load();
    } catch (e) {
      toastError(e);
    }
  };

  const state: ConnectState = !s || phase === 'testing' ? 'busy' : s.status === 'expired' || (err && s.status !== 'on') ? 'error' : s.status === 'on' ? 'on' : 'off';
  const accounts = (s?.links || []).reduce((n, l) => n + l.accounts.length, 0);

  return (
    <ConnectCard
      data-testid="bank-card"
      icon={<Landmark />}
      tone="teal"
      title="Bank"
      state={state}
      stateLabel={phase === 'testing' ? 'testen' : s?.status === 'expired' ? 'toestemming verlopen' : undefined}
      line={s?.status === 'on' ? t('{0, plural, one {# rekening} other {# rekeningen}} bij {1}: je bots lezen saldo en mutaties.', accounts, s.links.map((l) => l.bank).join(', ')) : 'Saldo en mutaties van je eigen rekeningen, voor je bots en je dashboard. Alleen lezen, nooit betalen.'}
      action={
        !s || phase === 'app' || phase === 'link' ? null : s.status === 'on' ? (
          <Button loading={phase === 'testing'} onClick={test}>
            Test
          </Button>
        ) : (
          <Button variant="primary" icon={<Landmark className="h-4 w-4" />} onClick={() => setPhase(s.app ? 'link' : 'app')} data-testid="bank-start">
            {s.status === 'expired' ? 'Opnieuw toestemming geven' : 'Bank koppelen'}
          </Button>
        )
      }
      result={err ? <ConnectResult ok={false}>{err}</ConnectResult> : ok ? <ConnectResult ok>{ok}</ConnectResult> : undefined}
      more={
        !s || !s.app ? undefined : (
          <>
            <div className="text-xs text-muted">{t('Applicatie {0} bij Enable Banking.', s.app.appId)}</div>
            <div className="flex flex-wrap gap-2">
              {s.status !== 'off' && phase !== 'link' && (
                <Button size="sm" onClick={() => setPhase('link')}>
                  Nog een bank koppelen
                </Button>
              )}
              {s.connection && (
                <Button size="sm" onClick={() => navigate(`/m/mcp/c/${s.connection!.id}`)}>
                  Bots kiezen
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={remove}>
                Bank weghalen
              </Button>
            </div>
          </>
        )
      }
    >
      {phase === 'app' && s ? (
        <AppForm
          s={s}
          onSaved={(next) => {
            setS(next);
            setPhase('link');
          }}
        />
      ) : phase === 'link' && s ? (
        <LinkForm
          s={s}
          onCancel={() => setPhase('idle')}
          onDone={(next) => {
            if (next) setS(next);
            setPhase('idle');
          }}
        />
      ) : s && s.links.length ? (
        <ul className="space-y-2 text-sm" data-testid="bank-links">
          {s.links.map((l) => (
            <li key={`${l.bank}-${l.country}`} className="flex flex-wrap items-start justify-between gap-2 rounded-lg bg-surface-2 p-3">
              <div className="min-w-0">
                <div className="font-medium">{l.bank}</div>
                {l.accounts.map((a) => (
                  <div key={a.iban} className="text-xs text-muted">
                    {a.name} · <span className="font-mono">{a.iban}</span>
                  </div>
                ))}
                <div className={l.expired ? 'text-xs font-medium text-danger' : 'text-xs text-muted'}>{l.expired ? 'De toestemming is verlopen: koppel deze bank opnieuw.' : t('Toestemming tot {0}', new Date(l.validUntil).toLocaleDateString())}</div>
              </div>
              <Button size="sm" variant="ghost" onClick={() => unlink(l.bank, l.country)}>
                Ontkoppelen
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </ConnectCard>
  );
}
