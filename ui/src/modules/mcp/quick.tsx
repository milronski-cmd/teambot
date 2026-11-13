import { useEffect, useRef, useState } from 'react';
import { ExternalLink, LogIn } from 'lucide-react';
import { api, on } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { Button, Spinner, useAsync } from '../../components/ui';
import { ConnectResult } from '../../components/ConnectCard';
import type { Conn } from './shared';
import { openLoginWindow } from './forms';

/**
 * One click (POST /mcp/quick): the app is made for every bot, TeamBot's own npx/uvx is fetched when this computer has
 * none, and the read test runs, so the bots can use it from their next turn. Only the service's own login is left to
 * the user. When the app needs more (a key, an own OAuth app, a command to confirm), `onMore` opens the short form.
 */
export type QuickPhase = 'idle' | 'runtime' | 'connecting' | 'login' | 'testing' | 'done' | 'error';
export interface QuickState {
  phase: QuickPhase;
  progress?: string;
  conn?: Conn;
  error?: string;
  loginUrl?: string;
  loginServer?: string;
  /** The login window was opened in the click (catalogue apps that log in); else the user opens it with a button. */
  windowOpened?: boolean;
  needsRuntime?: 'node' | 'uv';
}

const RUNTIME_NAME = { node: 'Node.js', uv: 'Python (uv)' } as const;

function progressText(p: any): string {
  const name = RUNTIME_NAME[p?.id as 'node' | 'uv'] || 'Hulpprogramma';
  if (p?.phase === 'download' && p.total) return t('{0} ophalen… {1}%', name, Math.round(((p.received || 0) / p.total) * 100));
  if (p?.phase === 'verify' || p?.phase === 'extract') return t('{0} controleren…', name);
  return t('{0} ophalen…', name);
}

export function useQuickConnect(onMore: (needs: 'form' | 'details') => void) {
  const [s, setS] = useState<QuickState>({ phase: 'idle' });
  const connId = useRef<string | null>(null);
  const phase = useRef<QuickPhase>('idle');
  phase.current = s.phase;
  useEffect(() => {
    const offs = [
      on('mcp.runtime', (p: any) => {
        if (phase.current === 'runtime' || phase.current === 'connecting') setS((cur) => ({ ...cur, phase: 'runtime', progress: progressText(p) }));
      }),
      on('mcp.oauth', async (ev: any) => {
        const id = connId.current;
        if (!id || ev?.id !== id || phase.current !== 'login') return;
        if (!ev.ok) return setS({ phase: 'error', error: ev.error || 'Inloggen mislukt' });
        setS((cur) => ({ ...cur, phase: 'testing' }));
        try {
          const r = await api.post<{ ok: boolean; error?: string; connection: Conn }>(`/mcp/connections/${id}/test`, {});
          setS(r.ok ? { phase: 'done', conn: r.connection } : { phase: 'error', error: r.error, conn: r.connection });
        } catch (e: any) {
          setS({ phase: 'error', error: e.message });
        }
      }),
    ];
    return () => offs.forEach((f) => f());
  }, []);

  /** Call inside the click: a login window is opened right away, so the browser does not block it. */
  const start = async (body: { catalog_id: string } | { registry: { name: string; version?: string } }, o: { login?: boolean; runtime?: boolean } = {}) => {
    const w = o.login ? openLoginWindow() : null;
    connId.current = null;
    setS({ phase: o.runtime ? 'runtime' : 'connecting', progress: o.runtime ? t('Hulpprogramma ophalen…') : undefined });
    try {
      const r = await api.post<any>('/mcp/quick', body);
      if (r.needs === 'form' || r.needs === 'details') {
        w?.close();
        setS({ phase: 'idle' });
        return onMore(r.needs);
      }
      if (r.needs === 'login') {
        connId.current = r.connection.id;
        if (w && !w.closed) w.location.href = r.authorizationUrl;
        else if (o.login) window.open(r.authorizationUrl, '_blank', 'noopener');
        setS({ phase: 'login', conn: r.connection, loginUrl: r.authorizationUrl, loginServer: r.authorizationServer, windowOpened: !!o.login });
        return;
      }
      w?.close();
      setS(r.ok ? { phase: 'done', conn: r.connection } : { phase: 'error', error: r.error, conn: r.connection, needsRuntime: r.needsRuntime });
    } catch (e: any) {
      w?.close();
      setS({ phase: 'error', error: e.message });
    }
  };
  return { state: s, start, busy: s.phase === 'runtime' || s.phase === 'connecting' || s.phase === 'testing' || s.phase === 'login', reset: () => setS({ phase: 'idle' }) };
}

/** What a one-click attempt shows on its card: progress, the login, or the result. */
export function QuickStatus({ s, name, onRetry }: { s: QuickState; name: string; onRetry?(): void }) {
  if (s.phase === 'runtime' || s.phase === 'connecting' || s.phase === 'testing')
    return (
      <div className="flex items-center gap-2 text-sm text-muted" role="status">
        <Spinner /> {s.phase === 'runtime' ? s.progress : s.phase === 'testing' ? t('Testen…') : t('Koppelen…')}
      </div>
    );
  if (s.phase === 'login')
    return (
      <div className="space-y-2 rounded-lg bg-surface-2 p-3 text-sm" role="status">
        {s.windowOpened ? (
          <>
            <div className="flex items-center gap-2 font-medium">
              <Spinner /> Log in in het venster dat is geopend…
            </div>
            {s.loginUrl && (
              <a href={s.loginUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-fg underline">
                <ExternalLink className="h-3.5 w-3.5" /> Geen venster gezien? Open de inlogpagina
              </a>
            )}
          </>
        ) : (
          <>
            <div>{t('{0} vraagt om inloggen. Daarna werkt het voor al je bots.', name)}</div>
            <a href={s.loginUrl} target="_blank" rel="noopener noreferrer" className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-sm font-medium text-accent-fg hover:opacity-90" data-testid="quick-login">
              <LogIn className="h-4 w-4" aria-hidden /> {s.loginServer ? t('Inloggen bij {0}', s.loginServer) : t('Inloggen')}
            </a>
          </>
        )}
      </div>
    );
  if (s.phase === 'done' && s.conn) return <ConnectResult ok>{t('Verbinding werkt: {0, plural, one {# tool} other {# tools}}. Al je bots kunnen {1} nu gebruiken.', s.conn.counts.total, name)}</ConnectResult>;
  if (s.phase === 'error')
    return (
      <ConnectResult
        ok={false}
        next={
          s.needsRuntime && onRetry ? (
            <Button size="sm" variant="primary" onClick={onRetry}>
              Installeren
            </Button>
          ) : (
            'Probeer het opnieuw, of open Meer opties.'
          )
        }
      >
        {s.error}
      </ConnectResult>
    );
  return null;
}

/** "Installeren" for npx/uvx in the form (an app that also needs a key): TeamBot's own copy, with progress. */
export function RuntimeInstall({ id, onDone }: { id: 'node' | 'uv'; onDone(): void }) {
  const { busy, run } = useAsync();
  const [progress, setProgress] = useState('');
  useEffect(() => on('mcp.runtime', (p: any) => p?.id === id && setProgress(progressText(p))), [id]);
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg bg-warn-soft p-3 text-sm text-warn" data-testid="app-needs-runtime">
      <span className="min-w-0 flex-1 basis-56">
        {id === 'uv' ? 'Deze app heeft Python (uv) nodig en dat staat nog niet op deze computer. TeamBot haalt het zelf op (ongeveer 15 MB).' : 'Deze app heeft Node.js (npx) nodig en dat staat nog niet op deze computer. TeamBot haalt het zelf op (ongeveer 3 MB).'}
        {busy && progress ? ` ${progress}` : ''}
      </span>
      <Button
        size="sm"
        variant="primary"
        loading={busy}
        onClick={async () => {
          await run(async () => {
            await api.post(`/mcp/runtimes/${id}`, {});
            onDone();
          });
        }}
      >
        Installeren
      </Button>
    </div>
  );
}

/** "Koppelen" for a TeamBot catalogue app outside Apps (Marktplaats): one click; the short form opens in Apps when more is needed. */
export function QuickConnect({ catalogId, name, login }: { catalogId: string; name: string; login?: boolean }) {
  const q = useQuickConnect(() => navigate(`/m/mcp?app=${encodeURIComponent(catalogId)}`));
  const go = () => q.start({ catalog_id: catalogId }, { login });
  return (
    <div className="min-w-0 flex-1 space-y-2">
      {q.state.phase !== 'done' && (
        <div className="flex justify-end">
          <Button variant="primary" loading={q.busy && q.state.phase !== 'login'} disabled={q.busy} onClick={go} data-testid="quick-connect">
            Koppelen
          </Button>
        </div>
      )}
      {q.state.phase !== 'idle' && <QuickStatus s={q.state} name={name} onRetry={go} />}
    </div>
  );
}
