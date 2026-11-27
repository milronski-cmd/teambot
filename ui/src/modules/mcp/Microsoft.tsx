import { useEffect, useRef, useState } from 'react';
import { ExternalLink, LogIn } from 'lucide-react';
import { api, on } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { askConfirm, Button, Spinner, Toggle, toast, toastError } from '../../components/ui';
import { ConnectCard, ConnectResult, type ConnectState } from '../../components/ConnectCard';
import type { Conn } from './shared';
import { openLoginWindow } from './forms';

/** Mirror of GET /api/mcp/microsoft (server/modules/mcp/microsoft.ts). */
interface MsState {
  /** false: TeamBot runs on another address; logging in only works on its own computer. */
  local: boolean;
  email: string | null;
  status: 'off' | 'on' | 'expired';
  connection: Conn | null;
  consentUrls: { personal: string; work: string };
  accounts: { id: string; email: string; status: 'on' | 'expired' }[];
}
interface Check {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
  authRequired?: boolean;
}

function MicrosoftLogo() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden>
      <rect x="2" y="2" width="9.5" height="9.5" fill="#F25022" />
      <rect x="12.5" y="2" width="9.5" height="9.5" fill="#7FBA00" />
      <rect x="2" y="12.5" width="9.5" height="9.5" fill="#00A4EF" />
      <rect x="12.5" y="12.5" width="9.5" height="9.5" fill="#FFB900" />
    </svg>
  );
}

const NOT_LOCAL = 'Outlook koppelen kan alleen op de computer waar TeamBot draait. Open TeamBot daar (http://localhost) en koppel Outlook op die computer.';

/** One Microsoft account (Outlook.com, Hotmail, MSN or a work account): mail and agenda with one login. */
export function MicrosoftCard({ connId }: { connId?: string } = {}) {
  const q = connId ? `?conn=${encodeURIComponent(connId)}` : '';
  const [s, setS] = useState<MsState | null>(null);
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'testing'>('idle');
  const [checks, setChecks] = useState<Check[] | null>(null);
  const [err, setErr] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const live = useRef(true);

  const load = () =>
    api
      .get<MsState>(`/mcp/microsoft${q}`)
      .then((x) => live.current && setS(x))
      .catch((e) => live.current && setErr(e.message));

  const runTest = async () => {
    setPhase('testing');
    setErr('');
    try {
      const cur = await api.get<MsState>(`/mcp/microsoft${q}`);
      if (cur.connection) await api.post(`/mcp/connections/${cur.connection.id}/test`, {});
      const r = await api.post<MsState & { checks: Check[] }>('/mcp/microsoft/test', { conn: connId });
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
      // With several accounts each card only hears its own login.
      if (!ev?.microsoft || (connId && ev.id !== connId && ev.ok)) return;
      if (ev.ok) {
        toast('Outlook is gekoppeld', 'ok');
        void runTest();
      } else {
        setPhase('idle');
        setErr(ev.error || 'Inloggen bij Microsoft mislukt');
      }
    });
    return () => {
      live.current = false;
      off();
    };
  }, []);

  const login = async () => {
    if (!s) return;
    if (!s.local) return setErr(NOT_LOCAL);
    const w = openLoginWindow();
    setErr('');
    try {
      const r = await api.post<{ authorizationUrl: string }>('/mcp/microsoft/start', { conn: connId });
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
    if (!s?.connection || !(await askConfirm(t('Outlook ({0}) ontkoppelen? TeamBot wist de toegang. Bij Microsoft zelf haal je TeamBot weg via account.live.com/consent/Manage (persoonlijk account) of myapps.microsoft.com (werkaccount).', s.email || ''), { ok: 'Ontkoppelen', danger: true }))) return;
    try {
      await api.del(`/mcp/connections/${s.connection.id}`);
      setChecks(null);
      toast('Outlook is ontkoppeld', 'ok');
      load();
    } catch (e) {
      toastError(e);
    }
  };

  const failed = (checks || []).filter((c) => !c.ok);
  const working = (checks || []).filter((c) => c.ok);
  const busy = !s || phase !== 'idle';
  const state: ConnectState = busy ? 'busy' : s.status === 'expired' || (err && s.status !== 'on') || (checks && !working.length) ? 'error' : s.status === 'on' ? 'on' : 'off';

  return (
    <ConnectCard
      data-testid="microsoft-card"
      icon={<MicrosoftLogo />}
      title="Outlook"
      state={state}
      stateLabel={phase === 'waiting' ? 'wacht op inloggen' : phase === 'testing' ? 'testen' : s?.status === 'expired' ? 'opnieuw inloggen' : undefined}
      line={s?.status === 'on' && s.email ? t('Ingelogd als {0}', s.email) : 'Outlook.com, Hotmail, MSN of je werkaccount: mail en agenda met één keer inloggen.'}
      action={
        !s ? null : s.status === 'on' ? (
          <Button loading={phase === 'testing'} onClick={runTest}>
            Test
          </Button>
        ) : (
          <Button variant="primary" icon={<LogIn className="h-4 w-4" />} loading={phase !== 'idle'} onClick={login} data-testid="microsoft-login">
            {s.status === 'expired' ? 'Opnieuw inloggen' : 'Inloggen met Microsoft'}
          </Button>
        )
      }
      result={
        err ? (
          <ConnectResult ok={false} next={s?.local === false ? undefined : 'Klik opnieuw op “Inloggen met Microsoft”.'}>
            {err}
          </ConnectResult>
        ) : checks && phase === 'idle' ? (
          <div className="space-y-2">
            {working.length > 0 && <ConnectResult ok>{t('Verbinding werkt: {0}.', working.map((c) => c.name).join(', '))}</ConnectResult>}
            {failed.map((c) => (
              <ConnectResult key={c.id} ok={false} next={c.authRequired ? 'Log opnieuw in bij Microsoft.' : undefined}>
                {c.name}: {c.error}
              </ConnectResult>
            ))}
          </div>
        ) : undefined
      }
      more={
        !s || s.status === 'off' ? undefined : (
          <>
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
                label="Mag ook concepten en afspraken maken, mail ordenen en mail versturen (vraagt je eerst om toestemming)"
              />
            )}
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
      {phase === 'waiting' ? (
        <div className="space-y-1.5 rounded-lg bg-surface-2 p-3 text-sm" role="status">
          <div className="flex items-center gap-2 font-medium">
            <Spinner /> Log in bij Microsoft in het venster dat is geopend…
          </div>
          <div className="text-xs text-muted">Kies het account dat je wilt koppelen en klik op “Accepteren” om TeamBot toegang te geven tot je mail en agenda.</div>
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
      ) : s?.status === 'on' && !checks && phase === 'idle' ? (
        <div className="text-xs text-muted">Mail · Agenda</div>
      ) : null}
    </ConnectCard>
  );
}

/** Every Microsoft account its own card, and a button to add one more (a second Hotmail or MSN address). */
export function MicrosoftAccounts() {
  const [accounts, setAccounts] = useState<MsState['accounts']>([]);
  const [local, setLocal] = useState(true);
  const [adding, setAdding] = useState(false);
  const load = () =>
    api
      .get<MsState>('/mcp/microsoft')
      .then((x) => (setAccounts(x.accounts || []), setLocal(x.local)))
      .catch(() => {});
  useEffect(() => {
    load();
    const offA = on('mcp.oauth', (ev: any) => {
      if (!ev?.microsoft) return;
      setAdding(false);
      load();
    });
    const offB = on('mcp.updated', () => load());
    return () => {
      offA();
      offB();
    };
  }, []);
  const add = async () => {
    if (!local) return toastError(new Error(NOT_LOCAL));
    const w = openLoginWindow();
    try {
      const r = await api.post<{ authorizationUrl: string }>('/mcp/microsoft/start', { add: true });
      if (w && !w.closed) w.location.href = r.authorizationUrl;
      else window.open(r.authorizationUrl, '_blank', 'noopener');
      setAdding(true);
    } catch (e) {
      w?.close();
      toastError(e);
    }
  };
  return (
    <>
      {accounts.length <= 1 ? <MicrosoftCard key={accounts[0]?.id || 'none'} connId={accounts[0]?.id} /> : accounts.map((a) => <MicrosoftCard key={a.id} connId={a.id} />)}
      {accounts.length > 0 && (
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" icon={<LogIn className="h-4 w-4" />} loading={adding} onClick={add} data-testid="microsoft-add-account">
            Nog een Microsoft-account toevoegen
          </Button>
          {adding && (
            <button type="button" className="text-xs text-muted underline hover:text-fg" onClick={() => setAdding(false)}>
              Annuleren
            </button>
          )}
        </div>
      )}
    </>
  );
}
