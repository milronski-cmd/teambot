import { useEffect, useMemo, useState } from 'react';
import { Blocks, Download, Globe, Plus, Search, Terminal } from 'lucide-react';
import { api } from '../../lib/api';
import { navigate, query } from '../../lib/router';
import { t } from '../../lib/i18n';
import { useApp } from '../../lib/store';
import { Button, EmptyState, Input, Page, PageHeader, Spinner } from '../../components/ui';
import { ConnectCard, ConnectResult, type ConnectState } from '../../components/ConnectCard';
import { MoreOptions } from '../../components/MoreOptions';
import { AppMark, hasAppMark } from '../../components/AppMark';
import type { CatalogEntry, Conn } from './shared';
import { useConnections } from './shared';
import { Wizard, type PackagePick } from './Wizard';
import { PackageImport } from './PackageImport';
import { ImportDialog, type ImportedInfo } from './Import';
import type { ConnDraft } from './forms';
import { GoogleCard } from './Google';
import { ServerTab } from './ServerTab';
import { firstSentence } from '../../lib/sentence';

/** What a newcomer most often wants, first (the rest follows by name). */
const FIRST = ['github-readonly', 'notion', 'slack', 'email-imap', 'stripe', 'mollie', 'shopify', 'woocommerce', 'duckduckgo', 'fetch', 'filesystem'];

/** A connected app: the same card and states as every other connection, with a test. */
function ConnCard({ c }: { c: Conn }) {
  const agents = useApp((s) => s.agents);
  const names = c.agents.map((id) => agents.find((a) => a.id === id)?.name).filter(Boolean);
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ ok: boolean; error?: string } | null>(null);
  const failing = c.runtime.state === 'error' || c.runtime.state === 'backoff' || c.runtime.state === 'auth_required' || c.oauth?.status === 'expired';
  const state: ConnectState = busy || c.runtime.state === 'starting' ? 'busy' : failing || res?.ok === false ? 'error' : c.verified_at && c.enabled ? 'on' : 'off';
  const needsLogin = c.runtime.state === 'auth_required' || (c.auth === 'oauth' && c.oauth?.status !== 'connected');
  const open = () => navigate(`/m/mcp/c/${c.id}`);
  const test = async () => {
    setBusy(true);
    setRes(null);
    try {
      const r = await api.post<{ ok: boolean; error?: string }>(`/mcp/connections/${c.id}/test`, {});
      setRes({ ok: r.ok, error: r.error });
    } catch (e: any) {
      setRes({ ok: false, error: e.message });
    } finally {
      setBusy(false);
    }
  };
  const error = res?.ok === false ? res.error : failing ? c.runtime.lastError || c.last_error : null;
  return (
    <ConnectCard
      data-testid="app-card"
      icon={c.catalog_id && hasAppMark(c.catalog_id) ? <AppMark id={c.catalog_id} /> : c.transport === 'stdio' ? <Terminal /> : <Globe />}
      title={c.display}
      state={state}
      stateLabel={!c.enabled ? 'uit' : state === 'off' ? 'nog niet getest' : undefined}
      line={`${t('{0, plural, one {# tool} other {# tools}}', c.counts.usable)} · ${names.length ? names.join(', ') : 'nog aan geen bot gekoppeld'}${c.allow_actions ? '' : ' · alleen lezen'}`}
      action={
        <>
          {needsLogin ? (
            <Button variant="primary" onClick={open}>
              Inloggen
            </Button>
          ) : (
            <Button loading={busy} onClick={test}>
              Test
            </Button>
          )}
          <Button variant="ghost" onClick={open}>
            Beheren
          </Button>
        </>
      }
      result={
        res?.ok ? (
          <ConnectResult ok />
        ) : error ? (
          <ConnectResult ok={false} next={needsLogin ? 'Log opnieuw in.' : 'Klik op Test om het opnieuw te proberen.'}>
            {error}
          </ConnectResult>
        ) : undefined
      }
    />
  );
}

/** One app from the catalogue: its name, one line and "Koppelen". */
function CatalogCard({ e, onPick }: { e: CatalogEntry; onPick(): void }) {
  return (
    <ConnectCard
      data-testid="catalog-card"
      icon={hasAppMark(e.id) ? <AppMark id={e.id} /> : e.transport === 'stdio' ? <Terminal /> : <Globe />}
      title={e.name}
      state="off"
      stateLabel={e.commandFound === false ? (e.command === 'uvx' ? 'Python nodig' : 'Node.js nodig') : undefined}
      line={<span className="line-clamp-1">{firstSentence(e.description)}</span>}
      action={
        <Button variant={e.available ? 'soft' : 'secondary'} disabled={!e.available} title={e.unavailableReason} icon={<Plus className="h-4 w-4" />} onClick={onPick}>
          {e.available ? 'Koppelen' : 'Niet beschikbaar'}
        </Button>
      }
    />
  );
}

export function MainPage() {
  const { list, error, reload } = useConnections();
  const [catalog, setCatalog] = useState<CatalogEntry[] | null>(null);
  const [q, setQ] = useState('');
  const [all, setAll] = useState(false);
  const [pick, setPick] = useState<CatalogEntry | null>(null);
  const [pkg, setPkg] = useState<PackagePick | null>(null);
  // #/m/mcp?package=<catalogId>/<itemId> opens a connector package from an external catalog (Marktplaats › Apps).
  const [importing, setImporting] = useState<{ ref: string | null } | null>(() => (query().get('package') ? { ref: query().get('package') } : null));
  // "Importeren": paste a command/config or take over servers from this computer
  const [importer, setImporter] = useState<'paste' | 'local' | null>(null);
  const [prefill, setPrefill] = useState<{ initial: Partial<ConnDraft>; info: ImportedInfo } | null>(null);
  useEffect(() => {
    api
      .get<CatalogEntry[]>('/mcp/catalog')
      .then(setCatalog)
      .catch(() => setCatalog([]));
  }, []);
  const custom = catalog?.find((e) => e.id === 'custom') || null;
  // Google is one card of its own (Google.tsx); its connection is not listed a second time.
  const mine = (list || []).filter((c) => c.catalog_id !== 'google');
  const shown = useMemo(() => {
    const rank = (e: CatalogEntry) => (FIRST.indexOf(e.id) + 1 || 99) as number;
    const l = (catalog || []).filter((e) => e.id !== 'custom' && (q ? `${e.name} ${e.description} ${e.publisher}`.toLowerCase().includes(q.toLowerCase()) : !e.advanced));
    return l.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
  }, [catalog, q]);
  const visible = q || all ? shown : shown.slice(0, 8);
  const start = (e: CatalogEntry) => (setPkg(null), setPrefill(null), setPick(e));

  return (
    <Page>
      <PageHeader
        width="5xl"
        title={
          <span className="flex items-center gap-2">
            <Blocks className="h-5 w-5" /> Apps
          </span>
        }
        subtitle="Geef je bots toegang tot je diensten."
        actions={
          <Button icon={<Download className="h-4 w-4" />} onClick={() => setImporter('paste')}>
            Importeren
          </Button>
        }
      />
      <div className="mx-auto max-w-5xl space-y-6 p-4 sm:p-6">
        <div className="space-y-3" data-testid="apps-connected">
          <GoogleCard />
          {error && (
            <EmptyState title="Laden mislukt" action={<Button onClick={reload}>Opnieuw</Button>}>
              {error}
            </EmptyState>
          )}
          {mine.map((c) => (
            <ConnCard key={c.id} c={c} />
          ))}
        </div>

        <section className="space-y-3" aria-labelledby="apps-meer">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h2 id="apps-meer" className="font-semibold">
              Meer apps
            </h2>
            <div className="relative w-full sm:w-72">
              <Search className="pointer-events-none absolute start-2.5 top-2.5 h-4 w-4 text-muted" />
              <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoek een app…" className="ps-8" aria-label="Zoeken in catalogus" />
            </div>
          </div>
          {!catalog ? (
            <div className="flex justify-center p-6">
              <Spinner />
            </div>
          ) : (
            <>
              {!visible.length && <div className="p-6 text-center text-sm text-muted">Niets gevonden. Onder Meer opties koppel je elke andere MCP-server.</div>}
              <div className="grid gap-3 md:grid-cols-2">
                {visible.map((e) => (
                  <CatalogCard key={e.id} e={e} onPick={() => start(e)} />
                ))}
              </div>
              {!q && !all && shown.length > visible.length && (
                <Button variant="ghost" onClick={() => setAll(true)} data-testid="catalog-all">
                  {t('{0, plural, one {Toon # app} other {Toon alle # apps}}', shown.length)}
                </Button>
              )}
            </>
          )}
        </section>

        <MoreOptions>
          <div className="flex flex-wrap gap-2">
            {custom && (
              <Button icon={<Plus className="h-4 w-4" />} onClick={() => start(custom)}>
                Eigen server
              </Button>
            )}
            <Button icon={<Download className="h-4 w-4" />} onClick={() => setImporter('local')}>
              Overnemen uit Claude, Codex of Cursor
            </Button>
          </div>
          <ServerTab />
        </MoreOptions>
      </div>
      {pick && <Wizard entry={pick} pkg={pkg} initial={prefill?.initial} imported={prefill?.info} onClose={() => (setPick(null), setPkg(null), setPrefill(null), reload())} />}
      {importer && (
        <ImportDialog
          start={importer}
          onClose={() => setImporter(null)}
          onPackage={() => (setImporter(null), setImporting({ ref: null }))}
          onWizard={(initial, info) => {
            setImporter(null);
            if (!custom) return;
            setPkg(null);
            setPrefill({ initial, info });
            setPick(custom);
          }}
        />
      )}
      {importing && (
        <PackageImport
          catalogRef={importing.ref}
          onClose={() => (setImporting(null), importing.ref && navigate('/m/mcp'))}
          onPick={(entry, p) => (setImporting(null), setPkg(p), setPrefill(null), setPick(entry))}
        />
      )}
    </Page>
  );
}
