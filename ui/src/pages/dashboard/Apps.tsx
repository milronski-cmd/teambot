import { useEffect, useState } from 'react';
import { Blocks, Plug } from 'lucide-react';
import { api } from '../../lib/api';
import { navigate } from '../../lib/router';
import { Button, Card, SectionTitle, cx } from '../../components/ui';
import { t } from '../../lib/i18n';
import { appsCount } from './text';

export interface AppRow {
  id: string;
  name: string;
  label?: string | null;
  enabled: boolean;
  status: string;
  last_error?: string | null;
  transport?: string;
}

/** How an app stands, in the owner's words, and its colour. An app that starts when a bot needs it is ready. */
export function appState(a: AppRow): { text: string; tone: 'ok' | 'warn' | 'off' } {
  if (!a.enabled) return { text: 'Uit', tone: 'off' };
  if (a.last_error || a.status === 'error' || a.status === 'failed') return { text: 'Werkt niet', tone: 'warn' };
  if (a.status === 'expired' || a.status === 'auth' || a.status === 'needs_auth') return { text: 'Opnieuw inloggen', tone: 'warn' };
  if (a.status === 'connected' || a.status === 'running') return { text: 'Verbonden', tone: 'ok' };
  return { text: 'Klaar voor gebruik', tone: 'ok' };
}

export const useApps = () => {
  const [apps, setApps] = useState<AppRow[] | null>(null);
  useEffect(() => {
    api
      .get<AppRow[]>('/mcp/connections')
      .then((l) => setApps(Array.isArray(l) ? l : []))
      .catch(() => setApps([]));
  }, []);
  return apps;
};

/** Every app the owner connected, as a board of tiles: its name, how it stands, one click to open it. */
export function AppsSection({ apps }: { apps: AppRow[] | null }) {
  const list = apps || [];
  return (
    <section className="space-y-2" data-testid="dashboard-apps">
      <SectionTitle
        icon={Blocks}
        tone="blue"
        action={
          <Button size="sm" variant="ghost" onClick={() => navigate('/m/mcp')}>
            Apps beheren
          </Button>
        }
      >
        Gekoppelde apps
      </SectionTitle>
      {apps !== null && !list.length ? (
        <Card className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
          <span className="min-w-0 flex-1 basis-56 text-muted">Nog geen apps gekoppeld. Koppel je mail, je bank of je webshop en je bots kunnen ermee werken.</span>
          <Button size="sm" onClick={() => navigate('/m/mcp')}>
            App koppelen
          </Button>
        </Card>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {list.map((a) => {
              const st = appState(a);
              return (
                <a
                  key={a.id}
                  href={`#/m/mcp/c/${a.id}`}
                  className="group block rounded-card transition-transform hover:-translate-y-0.5"
                  data-testid="dashboard-app"
                >
                  <Card className="flex h-full items-center gap-3 p-3 transition-colors group-hover:border-fg/30">
                    <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
                      <Plug className="h-4 w-4" aria-hidden />
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-semibold" translate="no">
                        {(a.label || a.name).replace(/\s*\([^)]*\)\s*$/, '')}
                      </span>
                      <span className="flex items-center gap-1.5 text-xs text-muted">
                        <span className={cx('h-2 w-2 shrink-0 rounded-full', st.tone === 'ok' ? 'bg-ok' : st.tone === 'warn' ? 'bg-warn' : 'bg-line')} aria-hidden />
                        {t(st.text)}
                      </span>
                    </span>
                  </Card>
                </a>
              );
            })}
          </div>
          {apps !== null && <p className="px-1 text-xs text-muted">{appsCount(list.filter((a) => appState(a).tone === 'ok').length, list.length)}</p>}
        </>
      )}
    </section>
  );
}
