import { useEffect, useRef, useState } from 'react';
import { KeyRound, LogIn, Smartphone, UserPlus } from 'lucide-react';
import { Mark } from './Sidebar';
import { api, setToken } from '../lib/api';
import { Button, Card, Field, Input, Spinner, Tabs } from '../components/ui';
import { LanguageCorner } from '../components/LanguagePicker';
import { authTabs, type AuthTab } from './authTabs';

interface Status {
  app: string;
  version: string;
  mode: 'desktop' | 'server';
  needsSetup: boolean;
  allowSignup: boolean;
  /** 'console': a fresh server reached over the network asks for the one-time code it printed at startup. */
  setupCode?: 'console' | 'link' | null;
}

interface SsoInfo {
  enabled: boolean;
  label: string;
  requireSso: boolean;
}

/** Reason codes from the SSO callback (never free text in the URL). */
const SSO_ERRORS: Record<string, string> = {
  state: 'Deze inlogpoging is verlopen of hoort bij een andere browser. Probeer het opnieuw.',
  provider: 'Inloggen bij je identiteitsprovider is mislukt. Probeer het opnieuw of vraag de beheerder de SSO-instellingen te controleren.',
  unverified: 'Je e-mailadres is niet bevestigd bij je identiteitsprovider.',
  noemail: 'Je identiteitsprovider gaf geen e-mailadres door.',
  domain: 'Je e-mailadres hoort niet bij een domein dat op deze server is toegestaan.',
  unknown: 'Er is nog geen account voor jouw e-mailadres. Vraag de beheerder om toegang.',
  disabled: 'Dit account is geblokkeerd. Neem contact op met de beheerder.',
  config: 'Inloggen met SSO is niet (goed) ingesteld op deze server.',
  rate: 'Te veel inlogpogingen. Wacht een minuut en probeer het opnieuw.',
  seats: 'Deze server heeft het maximale aantal gebruikers bereikt. Vraag de beheerder om ruimte te maken.',
};

/** Login / first-run owner setup / invite signup / device pairing / SSO. Calls onDone after a token is stored. */
export function AuthScreen({ onDone }: { onDone(): void }) {
  const [status, setStatus] = useState<Status | null>(null);
  const [sso, setSso] = useState<SsoInfo | null>(null);
  const [ownerLogin, setOwnerLogin] = useState(false);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const params = new URLSearchParams(location.hash.split('?')[1] || location.search);
  // null: the first tab for this kind of TeamBot (authTabs: pairing first on the desktop app).
  const [tab, setTab] = useState<AuthTab | null>(params.get('pair') ? 'pair' : params.get('invite') ? 'signup' : null);
  const [f, setF] = useState({ name: '', email: '', password: '', invite: params.get('invite') || '', code: params.get('pair') || '', deviceName: guessDevice(), setupCode: '' });
  // The SSO callback lands on #/?sso=<one-time code> (or ?sso_error=<reason>); read it once, then clean the URL.
  const ssoBack = useRef({ code: params.get('sso'), error: params.get('sso_error'), handled: false });

  useEffect(() => {
    api.get<Status>('/public/status').then(setStatus).catch((e) => setErr(e.message));
    api.get<SsoInfo>('/public/sso').then(setSso).catch(() => setSso(null));
    const back = ssoBack.current;
    if (back.handled || (!back.code && !back.error)) return;
    back.handled = true;
    history.replaceState(null, '', location.pathname + location.search + '#/');
    if (back.error) setErr(SSO_ERRORS[back.error] || SSO_ERRORS.provider);
    else if (back.code) {
      setBusy(true);
      api
        .post<{ token: string }>('/public/sso/exchange', { code: back.code })
        .then((r) => {
          setToken(r.token);
          onDone();
        })
        .catch((e) => setErr(e.message))
        .finally(() => setBusy(false));
    }
  }, []);

  const submit = async (path: string, body: any) => {
    setBusy(true);
    setErr('');
    try {
      const r = await api.post<{ token: string }>(path, body);
      setToken(r.token);
      onDone();
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!status && !err) {
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF({ ...f, [k]: e.target.value });
  const ssoOn = !!sso?.enabled && status?.mode === 'server';
  const ssoOnly = ssoOn && !!sso?.requireSso;
  const showPassword = !ssoOnly || ownerLogin;
  const { tabs: tabIds, shown: shownTab } = authTabs(status, { ssoOnly, chosen: tab });

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-10">
      <div className="w-full max-w-sm space-y-6">
        <div className="-mb-4 flex justify-end">
          <LanguageCorner />
        </div>
        <div className="flex flex-col items-center gap-2 text-center">
          <Mark size={64} />
          <h1 className="mt-2 text-2xl font-extrabold tracking-tight">{status?.app || 'TeamBot'}</h1>
          <p className="text-sm text-muted">Je eigen AI-team. Je eigen modellen. Lokaal of op je eigen server.</p>
        </div>

        {status?.needsSetup ? (
          <Card className="space-y-4 p-5">
            <div>
              <div className="font-semibold">Eigenaar-account aanmaken</div>
              <p className="mt-1 text-sm text-muted">Dit is de eerste keer dat deze server start. Jij wordt de eigenaar en kunt daarna vrienden uitnodigen.</p>
            </div>
            <form
              className="space-y-3"
              onSubmit={(e) => {
                e.preventDefault();
                submit('/public/setup', { name: f.name, email: f.email, password: f.password, setupToken: params.get('setup') || f.setupCode.trim() || undefined });
              }}
            >
              {status?.setupCode === 'console' && !params.get('setup') && (
                <Field label="Eenmalige code" hint="De code staat in het venster van de server (bij Docker: docker compose logs teambot).">
                  <Input value={f.setupCode} onChange={set('setupCode')} autoComplete="off" spellCheck={false} required />
                </Field>
              )}
              <Field label="Naam">
                <Input value={f.name} onChange={set('name')} autoComplete="name" required />
              </Field>
              <Field label="E-mail">
                <Input type="email" value={f.email} onChange={set('email')} autoComplete="email" required />
              </Field>
              <Field label="Wachtwoord" hint="Minstens 12 tekens. Een paar woorden achter elkaar is makkelijk te onthouden.">
                <Input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" minLength={12} required />
              </Field>
              {err && <p className="text-sm text-danger">{err}</p>}
              <Button variant="primary" className="w-full justify-center" loading={busy}>
                Account aanmaken
              </Button>
            </form>
          </Card>
        ) : (
          <Card className="p-0">
            <div className="px-3 pt-2">
              <Tabs
                value={shownTab}
                onChange={(v) => {
                  setTab(v);
                  setErr('');
                }}
                tabs={tabIds.map((id) => ({
                  id,
                  label:
                    id === 'login' ? (
                      <span className="inline-flex items-center gap-1.5"><KeyRound className="h-3.5 w-3.5" />Inloggen</span>
                    ) : id === 'signup' ? (
                      <span className="inline-flex items-center gap-1.5"><UserPlus className="h-3.5 w-3.5" />Account maken</span>
                    ) : (
                      <span className="inline-flex items-center gap-1.5"><Smartphone className="h-3.5 w-3.5" />Koppelen</span>
                    ),
                }))}
              />
            </div>
            <div className="p-5">
              {shownTab === 'login' && (
                <div className="space-y-4">
                  {ssoOn && (
                    <div className="space-y-2">
                      <Button
                        variant={showPassword && !ssoOnly ? 'secondary' : 'primary'}
                        className="w-full justify-center"
                        icon={<LogIn className="h-4 w-4" />}
                        loading={busy && !!ssoBack.current.code}
                        onClick={() => location.assign('/api/public/sso/start')}
                      >
                        {sso?.label || 'Inloggen met SSO'}
                      </Button>
                      {ssoOnly && !ownerLogin && err && <p className="text-sm text-danger">{err}</p>}
                      {ssoOnly && !ownerLogin && (
                        <button type="button" className="mx-auto block text-xs text-muted underline hover:text-fg" onClick={() => (setOwnerLogin(true), setErr(''))}>
                          Eigenaar? Log in met wachtwoord
                        </button>
                      )}
                    </div>
                  )}
                  {ssoOn && showPassword && (
                    <div className="flex items-center gap-3 text-xs text-muted" aria-hidden>
                      <span className="h-px flex-1 bg-line" /> of met wachtwoord <span className="h-px flex-1 bg-line" />
                    </div>
                  )}
                  {showPassword && (
                    <form
                      className="space-y-3"
                      onSubmit={(e) => {
                        e.preventDefault();
                        submit('/public/login', { email: f.email, password: f.password });
                      }}
                    >
                      {ssoOnly && <p className="text-xs text-muted">Op deze server log je in met SSO. Alleen de eigenaar kan nog met een wachtwoord inloggen (noodtoegang).</p>}
                      <Field label="E-mail">
                        <Input type="email" value={f.email} onChange={set('email')} autoComplete="email" required />
                      </Field>
                      <Field label="Wachtwoord">
                        <Input type="password" value={f.password} onChange={set('password')} autoComplete="current-password" required />
                      </Field>
                      {err && <p className="text-sm text-danger">{err}</p>}
                      <Button variant="primary" className="w-full justify-center" loading={busy}>
                        Inloggen
                      </Button>
                    </form>
                  )}
                </div>
              )}
              {shownTab === 'signup' && (
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submit('/public/signup', { name: f.name, email: f.email, password: f.password, invite: f.invite || undefined });
                  }}
                >
                  <Field label="Uitnodigingscode" hint={status?.allowSignup ? 'Optioneel op deze server.' : 'Vraag een code aan de eigenaar van deze server.'}>
                    <Input value={f.invite} onChange={set('invite')} required={!status?.allowSignup} placeholder="ABCD-EFGH-IJ" />
                  </Field>
                  <Field label="Naam">
                    <Input value={f.name} onChange={set('name')} autoComplete="name" />
                  </Field>
                  <Field label="E-mail">
                    <Input type="email" value={f.email} onChange={set('email')} autoComplete="email" required />
                  </Field>
                  <Field label="Wachtwoord" hint="Minstens 12 tekens. Een paar woorden achter elkaar is makkelijk te onthouden.">
                    <Input type="password" value={f.password} onChange={set('password')} autoComplete="new-password" minLength={12} required />
                  </Field>
                  {err && <p className="text-sm text-danger">{err}</p>}
                  <Button variant="primary" className="w-full justify-center" loading={busy}>
                    Account maken
                  </Button>
                </form>
              )}
              {shownTab === 'pair' && (
                <form
                  className="space-y-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    submit('/public/pair', { code: f.code, deviceName: f.deviceName });
                  }}
                >
                  <p className="text-sm text-muted">Open op je computer TeamBot → Instellingen → Telefoon en scan de QR-code, of typ de koppelcode hier.</p>
                  <Field label="Koppelcode">
                    <Input value={f.code} onChange={set('code')} required autoCapitalize="characters" placeholder="ABCD-EFGH" />
                  </Field>
                  <Field label="Naam van dit apparaat">
                    <Input value={f.deviceName} onChange={set('deviceName')} />
                  </Field>
                  {err && <p className="text-sm text-danger">{err}</p>}
                  <Button variant="primary" className="w-full justify-center" loading={busy}>
                    Koppelen
                  </Button>
                </form>
              )}
            </div>
          </Card>
        )}
        <p className="text-center text-xs text-muted">
          {status?.app} {status?.version} · open source (Apache-2.0)
        </p>
      </div>
    </div>
  );
}

function guessDevice() {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return 'iPhone';
  if (/iPad/.test(ua)) return 'iPad';
  if (/Android/.test(ua)) return 'Android-telefoon';
  return 'Browser';
}
