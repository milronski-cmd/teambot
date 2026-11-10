import { useEffect, useRef, useState } from 'react';
import { ExternalLink, LogIn } from 'lucide-react';
import { api, on } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { askConfirm, Button, Field, Input, Spinner, Textarea, Toggle, toast, toastError } from '../../components/ui';
import { ConnectCard, ConnectResult, type ConnectState } from '../../components/ConnectCard';
import type { Conn } from './shared';
import { CopyField, openLoginWindow } from './forms';

/** Mirror of GET /api/mcp/google (server/modules/mcp/google.ts). */
interface GoogleState {
  client: 'teambot' | 'own' | null;
  redirectUri: string;
  clientType: 'desktop' | 'web';
  enableApisUrl: string;
  services: { id: string; name: string; line: string; on: boolean }[];
  email: string | null;
  status: 'off' | 'on' | 'expired';
  adsToken: boolean;
  adsLogin: string;
  connection: Conn | null;
}
interface Check {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
  fixUrl?: string;
  needsToken?: boolean;
  authRequired?: boolean;
}

function GoogleG() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <path fill="#4285F4" d="M22.6 12.2c0-.8-.1-1.5-.2-2.2H12v4.2h5.9a5 5 0 0 1-2.2 3.3v2.7h3.6c2.1-1.9 3.3-4.800 3.3-8z" />
      <path fill="#34A853" d="M12 23c3 0 5.500-1 7.300-2.700l-3.600-2.700c-1 .700-2.300 1.100-3.700 1.100-2.900 0-5.300-1.900-6.200-4.500H2.100V17A11 11 0 0 0 12 23z" />
      <path fill="#FBBC05" d="M5.800 14.100a6.600 6.600 0 0 1 0-4.200V7.100H2.100a11 11 0 0 0 0 9.900l3.700-2.900z" />
      <path fill="#EA4335" d="M12 5.400c1.600 0 3.100.600 4.200 1.600l3.200-3.200A11 11 0 0 0 2.100 7.100l3.700 2.800c.900-2.600 3.300-4.500 6.200-4.500z" />
    </svg>
  );
}

const Link = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <a href={href} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border border-line bg-surface px-2.5 text-sm font-medium hover:bg-surface-2">
    {children} <ExternalLink className="h-3.5 w-3.5" aria-hidden />
  </a>
);

/**
 * The one-time own Google client, when TeamBot does not ship one: three short steps with the right console page behind
 * each button, then the downloaded JSON file pasted or chosen. Saving it starts the login straight away.
 */
function OwnClient({ s, onSaved }: { s: GoogleState; onSaved(next: GoogleState): void }) {
  const [json, setJson] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async (text: string) => {
    setBusy(true);
    try {
      onSaved(await api.put<GoogleState>('/mcp/google/client', { json: text }));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const steps: { text: string; href: string; label: string }[] = [
    { text: 'Kies of maak een project en zet de API’s aan.', href: s.enableApisUrl, label: 'API’s aanzetten' },
    { text: 'Toestemmingsscherm: naam “TeamBot”, doelgroep “External”, en daarna “Publish app”.', href: 'https://console.cloud.google.com/auth/overview', label: 'Toestemmingsscherm' },
    { text: s.clientType === 'desktop' ? 'Maak een client van het type “Desktop app” en klik op “Download JSON”.' : 'Maak een client van het type “Web application” met de redirect-URL hieronder en klik op “Download JSON”.', href: 'https://console.cloud.google.com/auth/clients/create', label: 'Client maken' },
  ];
  return (
    <div className="space-y-3 rounded-lg bg-surface-2 p-3 text-sm" data-testid="google-own-client">
      <div className="font-medium">Eenmalig: je eigen Google-client (ongeveer 5 minuten)</div>
      <ol className="space-y-2">
        {steps.map((x, i) => (
          <li key={x.href} className="flex flex-wrap items-center gap-2">
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface text-xs font-semibold">{i + 1}</span>
            <span className="min-w-0 flex-1 basis-56">{x.text}</span>
            <Link href={x.href}>{x.label}</Link>
          </li>
        ))}
      </ol>
      {s.clientType === 'web' && <CopyField value={s.redirectUri} label="Redirect-URL" />}
      <Field label="Plak hier het JSON-bestand">
        <Textarea rows={3} value={json} onChange={(e) => setJson(e.target.value)} className="font-mono text-xs" placeholder='{"installed":{"client_id":"…apps.googleusercontent.com", …}}' aria-label="JSON-bestand van de Google-client" />
      </Field>
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="primary" loading={busy} disabled={!json.trim()} onClick={() => save(json)}>
          Opslaan en inloggen
        </Button>
        <label className="inline-flex h-9 cursor-pointer items-center rounded-lg px-3 text-sm font-medium text-muted hover:bg-surface hover:text-fg">
          Of kies het bestand
          <input
            type="file"
            accept="application/json,.json"
            className="sr-only"
            onChange={async (e) => {
              const f = e.target.files?.[0];
              if (f) await save(await f.text());
            }}
          />
        </label>
      </div>
    </div>
  );
}

/** Google Ads needs one thing more than the login: the developer token of the owner's own Ads account. */
function AdsToken({ onSaved }: { onSaved(): void }) {
  const [v, setV] = useState('');
  const [busy, setBusy] = useState(false);
  return (
    <div className="flex flex-wrap items-end gap-2" data-testid="google-ads-token">
      <Field label="Developer token van Google Ads" className="min-w-0 flex-1 basis-56">
        <Input type="password" autoComplete="off" value={v} onChange={(e) => setV(e.target.value)} placeholder="Plak hier je token" />
      </Field>
      <Button
        loading={busy}
        disabled={!v.trim()}
        onClick={async () => {
          setBusy(true);
          try {
            await api.put('/mcp/google/ads', { developerToken: v.trim() });
            setV('');
            onSaved();
          } catch (e) {
            toastError(e);
          } finally {
            setBusy(false);
          }
        }}
      >
        Opslaan
      </Button>
      <Link href="https://ads.google.com/aw/apicenter">Token ophalen</Link>
    </div>
  );
}

/**
 * Google in one go: one card, one button. Search Console, Merchant Center, Google Ads, Analytics, Gmail, Agenda and
 * Drive come with a single login; TeamBot tests each of them and says per service what (if anything) is still missing.
 */
export function GoogleCard() {
  const [s, setS] = useState<GoogleState | null>(null);
  const [phase, setPhase] = useState<'idle' | 'client' | 'waiting' | 'testing'>('idle');
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [err, setErr] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const [want, setWant] = useState<string[] | null>(null);
  const live = useRef(true);

  const load = () =>
    api
      .get<GoogleState>('/mcp/google')
      .then((x) => live.current && setS(x))
      .catch((e) => live.current && setErr(e.message));

  const runTest = async () => {
    setPhase('testing');
    setErr('');
    try {
      const cur = await api.get<GoogleState>('/mcp/google');
      // The ordinary read test of Apps makes the tools usable; then one real read per service.
      if (cur.connection) await api.post(`/mcp/connections/${cur.connection.id}/test`, {});
      const r = await api.post<GoogleState & { checks: Check[] }>('/mcp/google/test', {});
      if (!live.current) return;
      setChecks(r.checks);
      setS(r);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      if (live.current) setPhase('idle');
    }
  };

  useEffect(() => {
    live.current = true;
    load();
    const off = on('mcp.oauth', (ev: any) => {
      if (!ev?.google) return;
      if (ev.ok) {
        toast('Google is gekoppeld', 'ok');
        void runTest();
      } else {
        setPhase('idle');
        setErr(ev.error || 'Inloggen bij Google mislukt');
      }
    });
    return () => {
      live.current = false;
      off();
    };
  }, []);

  const services = want ?? (s?.status === 'off' ? s.services.map((x) => x.id) : (s?.services || []).filter((x) => x.on).map((x) => x.id));

  const login = async (state: GoogleState | null = s) => {
    if (!state) return;
    if (!state.client) return setPhase('client');
    const w = openLoginWindow();
    setErr('');
    try {
      const r = await api.post<{ authorizationUrl: string }>('/mcp/google/start', { services });
      setLoginUrl(r.authorizationUrl);
      if (w && !w.closed) w.location.href = r.authorizationUrl;
      else window.open(r.authorizationUrl, '_blank', 'noopener');
      setPhase('waiting');
    } catch (e: any) {
      w?.close();
      setErr(e.message);
    }
  };

  const disconnect = async () => {
    if (!s?.connection || !(await askConfirm('Google ontkoppelen? TeamBot trekt de toegang ook bij Google in.', { ok: 'Ontkoppelen', danger: true }))) return;
    try {
      await api.del(`/mcp/connections/${s.connection.id}`);
      setChecks(null);
      setWant(null);
      load();
    } catch (e) {
      toastError(e);
    }
  };

  const failed = (checks || []).filter((c) => !c.ok);
  const working = (checks || []).filter((c) => c.ok);
  const busy = !s || phase === 'waiting' || phase === 'testing';
  const state: ConnectState = busy ? 'busy' : s.status === 'expired' || (err && s.status !== 'on') || (checks && !working.length) ? 'error' : s.status === 'on' ? 'on' : 'off';
  const names = (s?.services || []).filter((x) => (s?.status === 'off' ? true : x.on)).map((x) => x.name);

  const pickServices = s && (
    <div className="space-y-1.5">
      <div className="text-xs font-medium text-muted">Wat mag TeamBot gebruiken?</div>
      <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {s.services.map((x) => (
          <label key={x.id} className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={services.includes(x.id)} onChange={(e) => setWant(e.target.checked ? [...services, x.id] : services.filter((id) => id !== x.id))} />
            <span>
              {x.name} <span className="block text-xs text-muted">{x.line}</span>
            </span>
          </label>
        ))}
      </div>
      {s.status !== 'off' && want && (
        <Button size="sm" onClick={() => login()}>
          Opnieuw inloggen met deze keuze
        </Button>
      )}
    </div>
  );

  return (
    <ConnectCard
      data-testid="google-card"
      icon={<GoogleG />}
      title="Google"
      state={state}
      stateLabel={phase === 'waiting' ? 'wacht op inloggen' : phase === 'testing' ? 'testen' : s?.status === 'expired' ? 'opnieuw inloggen' : undefined}
      line={s?.status === 'on' && s.email ? t('Ingelogd als {0}', s.email) : 'Search Console, Merchant Center, Ads, Analytics, Gmail, Agenda en Drive: één keer inloggen.'}
      action={
        !s ? null : s.status === 'on' ? (
          <Button loading={phase === 'testing'} onClick={runTest}>
            Test
          </Button>
        ) : phase === 'client' ? null : (
          <Button variant="primary" icon={<LogIn className="h-4 w-4" />} loading={phase === 'waiting' || phase === 'testing'} onClick={() => login()} data-testid="google-login">
            {s.status === 'expired' ? 'Opnieuw inloggen' : 'Inloggen met Google'}
          </Button>
        )
      }
      result={
        err ? (
          <ConnectResult ok={false} next="Klik opnieuw op “Inloggen met Google”.">
            {err}
          </ConnectResult>
        ) : checks && phase === 'idle' ? (
          <div className="space-y-2">
            {working.length > 0 && <ConnectResult ok>{t('Verbinding werkt: {0}.', working.map((c) => c.name).join(', '))}</ConnectResult>}
            {failed.map((c) => (
              <div key={c.id} className="space-y-2">
                {c.needsToken ? (
                  <AdsToken onSaved={runTest} />
                ) : (
                  <ConnectResult
                    ok={false}
                    next={
                      c.fixUrl ? (
                        <span className="inline-flex flex-wrap items-center gap-2">
                          Zet deze API aan in je Google-project en klik daarna op Test. <Link href={c.fixUrl}>API aanzetten</Link>
                        </span>
                      ) : c.authRequired ? (
                        'Log opnieuw in bij Google.'
                      ) : undefined
                    }
                  >
                    {c.name}: {c.fixUrl ? 'staat nog uit in je Google-project.' : c.error}
                  </ConnectResult>
                )}
              </div>
            ))}
          </div>
        ) : undefined
      }
      more={
        !s ? undefined : s.status === 'off' ? (
          phase === 'client' ? undefined : (
            pickServices
          )
        ) : (
          <>
            {pickServices}
            {s.connection && (
              <Toggle
                checked={s.connection.allow_actions}
                onChange={async (v) => {
                  try {
                    await api.post(`/mcp/connections/${s.connection!.id}/actions`, { enabled: v });
                    load();
                  } catch (e) {
                    toastError(e);
                  }
                }}
                label="Mag ook concepten en afspraken maken en mail versturen (vraagt je eerst om toestemming)"
              />
            )}
            {s.services.find((x) => x.id === 'ads')?.on && s.adsToken && <div className="text-xs text-muted">Google Ads: developer token opgeslagen.</div>}
            <div className="flex flex-wrap gap-2">
              {s.connection && (
                <Button size="sm" onClick={() => navigate(`/m/mcp/c/${s.connection!.id}`)}>
                  Bots en tools kiezen
                </Button>
              )}
              <Button size="sm" variant="ghost" onClick={disconnect}>
                Ontkoppelen
              </Button>
            </div>
          </>
        )
      }
    >
      {phase === 'client' && s ? (
        <OwnClient
          s={s}
          onSaved={(next) => {
            setS(next);
            setPhase('idle');
            void login(next);
          }}
        />
      ) : phase === 'waiting' ? (
        <div className="space-y-1.5 rounded-lg bg-surface-2 p-3 text-sm" role="status">
          <div className="flex items-center gap-2 font-medium">
            <Spinner /> Log in bij Google in het venster dat is geopend…
          </div>
          {s?.client === 'own' && <div className="text-xs text-muted">Zegt Google “deze app is niet geverifieerd”? Klik op “Geavanceerd” en dan op “Ga naar TeamBot”.</div>}
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
            {loginUrl && (
              <a href={loginUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-fg underline">
                <ExternalLink className="h-3.5 w-3.5" /> Geen venster gezien? Open de inlogpagina
              </a>
            )}
            <button type="button" className="text-muted underline hover:text-fg" onClick={() => setPhase('idle')}>
              Annuleren
            </button>
          </div>
        </div>
      ) : s?.status === 'off' && phase === 'idle' && !err ? null : s?.status === 'on' && !checks && phase === 'idle' ? (
        <div className="text-xs text-muted">{names.join(' · ')}</div>
      ) : null}
    </ConnectCard>
  );
}
