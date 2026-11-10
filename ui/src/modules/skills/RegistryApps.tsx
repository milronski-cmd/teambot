import type React from 'react';
import { useEffect, useMemo, useState } from 'react';
import { ExternalLink, Plug, ShieldCheck } from 'lucide-react';
import { Badge, Button, EmptyState, Field, Input, Modal, Select, Spinner, cx, useAsync } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { api } from '../../lib/api';
import { navigate } from '../../lib/router';
import type { RegistryCard, RegistryDetail, RegistryList, RegistryOption, StarterApp } from './api';
import { fmtDate } from './api';
import { CARD, ErrorCard, LoadingCards, Meta, RefreshNote, ReportButton, SearchBox, Signal, qs, useFillingList } from './marketParts';
import { refreshLabel } from './merge';
import { Collapse, SignatureBadge } from './common';
import { Wizard, type RegistryPick } from '../mcp/Wizard';
import { AppIcon } from './AppIcon';
import type { CatalogEntry } from '../mcp/shared';
import { AppCard, CategoryTiles } from './ClearMarket';
import { tileIdOf, tilesFor } from './marketGroups';
import { firstSentence } from '../../lib/sentence';

function useDebounced<T>(v: T, ms = 400) {
  const [d, setD] = useState(v);
  useEffect(() => {
    const t = setTimeout(() => setD(v), ms);
    return () => clearTimeout(t);
  }, [v, ms]);
  return d;
}

/**
 * Apps from the official MCP Registry: recommendations, search (by server name) and paging. The recommendations come
 * from the cache at once (checked in the background); on the very first start TeamBot's own connectors are shown while
 * the registry answers, and recommendations are added below without moving what is already there.
 */
export function RegistryApps({ onOpenCatalog, onShowCatalog, tools }: { onOpenCatalog?: (id: string) => void; onShowCatalog?: () => void; /** Shown next to the search box (the switch to TeamBot's own apps). */ tools?: React.ReactNode } = {}) {
  const [q, setQ] = useState('');
  const [tile, setTile] = useState('');
  const [more, setMore] = useState<RegistryCard[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const { busy, run } = useAsync();
  const dq = useDebounced(q.trim());
  const query = dq.length >= 3 ? dq : '';
  const path = `/mcp/registry/servers${qs({ q: query })}`;
  const { data, error, reload } = useFillingList<RegistryCard, RegistryList>(path, (i) => i.name);
  useEffect(() => {
    setMore([]);
    setCursor(null);
  }, [path]);
  useEffect(() => {
    if (data && !more.length) setCursor(data.nextCursor);
  }, [data]);
  useEffect(() => {
    // Fill the "update beschikbaar" state of installed servers (cached for an hour by the server).
    api.post('/mcp/registry/check-updates', {}).catch(() => {});
  }, []);
  // TeamBot's own connectors while nothing from the registry is in yet (first start); they stay until the next search.
  const [starter, setStarter] = useState<{ path: string; items: StarterApp[]; total: number } | null>(null);
  useEffect(() => {
    if (data?.starter?.length && (!starter || starter.path !== path)) setStarter({ path, items: data.starter, total: data.starterTotal || data.starter.length });
  }, [data]);
  const showStarter = starter?.path === path ? starter : null;
  const loadMore = () =>
    cursor &&
    run(async () => {
      const d = await api.get<RegistryList>(`/mcp/registry/servers${qs({ q: query, cursor })}`);
      setMore((m) => [...m, ...d.items]);
      setCursor(d.nextCursor);
    });
  const all = useMemo(() => [...(data?.items || []), ...more], [data, more]);
  // Subjects as tiles (the same groups as the skills), filtered here: the register itself has no categories.
  const tiles = useMemo(() => tilesFor(all, (i) => ({ category: i.category })), [all]);
  const activeTile = tiles.some((x) => x.id === tile) ? tile : '';
  const items = useMemo(() => (activeTile ? all.filter((i) => tileIdOf(i.category) === activeTile) : all), [all, activeTile]);
  const total = data?.featuredTotal || 0;
  const note = refreshLabel(data, total ? { ready: total - (data?.pending?.length || 0), total, noun: 'aanbevolen apps' } : undefined);
  const loadingRegistry = !!data && !items.length && !!(data.pending?.length || data.refreshing?.length);
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <SearchBox value={q} onChange={setQ} label="Zoek een app, bijvoorbeeld Notion" />
        {tools}
        {/* One short line next to the switch, so a note that comes and goes never moves the cards. */}
        <span className="flex min-h-5 min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
          {q.trim().length > 0 && q.trim().length < 3 ? 'Typ minstens 3 tekens.' : data?.offline ? 'Offline: wat het laatst is opgehaald.' : data?.stale ? 'Deels van eerder: de bron is nu niet bereikbaar.' : ''}
          <RefreshNote label={note} resetKey={path} />
        </span>
      </div>
      {/* The row of subjects keeps its height while the list loads. */}
      {all.length > 0 ? <CategoryTiles tiles={tiles} value={activeTile} onChange={setTile} /> : !error && (!data || loadingRegistry) && <div className="h-9 coarse:h-11" aria-hidden />}
      {showStarter && (
        <section aria-labelledby="starter-apps" className="space-y-3">
          <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
            <h2 id="starter-apps" className="text-[15px] font-bold tracking-tight">
              Van TeamBot
            </h2>
            {onShowCatalog && (
              <button type="button" className="text-sm font-medium text-accent hover:underline" onClick={onShowCatalog}>
                Alle {showStarter.total} bekijken
              </button>
            )}
          </div>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {showStarter.items.map((s) => (
              <li key={s.id} className="min-w-0">
                <button type="button" data-card="starter" className={cx(CARD, 'w-full text-start')} onClick={() => onOpenCatalog?.(s.id)}>
                  <div className="flex items-start gap-3">
                    <AppIcon src={null} title={s.title} name={s.id} />
                    <div className="min-w-0">
                      <div className="break-words font-semibold">{s.title}</div>
                      <div className="text-xs text-muted [overflow-wrap:anywhere]">{s.publisher}</div>
                    </div>
                  </div>
                  <p className="mt-2 line-clamp-1 flex-1 break-words text-sm text-muted">{firstSentence(s.description)}</p>
                  <div className="mt-3 flex min-h-8 items-center">
                    <Signal tone="ok" icon={<ShieldCheck aria-hidden />}>
                      Gecontroleerd door TeamBot
                    </Signal>
                  </div>
                </button>
              </li>
            ))}
          </ul>
          <h2 className="pt-3 text-[15px] font-bold tracking-tight">Meer apps</h2>
        </section>
      )}
      {error ? (
        <ErrorCard error={error} retry={reload} />
      ) : !data || loadingRegistry ? (
        <LoadingCards n={showStarter ? 3 : 6} />
      ) : !items.length ? (
        <EmptyState icon={<Plug />} title="Geen apps gevonden" action={(q || activeTile) && <Button onClick={() => (setQ(''), setTile(''))}>Alles tonen</Button>}>
          Probeer een ander deel van de naam, bijvoorbeeld de dienst of het bedrijf.
        </EmptyState>
      ) : (
        <>
          <ul className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {items.map((i) => (
              <li key={i.name} className="min-w-0">
                <AppCard i={i} onAdd={() => setOpen(i.name)} />
              </li>
            ))}
          </ul>
          {cursor && (
            <div className="flex justify-center">
              <Button loading={busy} onClick={loadMore}>
                Meer laden
              </Button>
            </div>
          )}
        </>
      )}
      {data?.mode === 'featured' && !!data.errors?.length && !data.pending?.length && (
        <p className="text-xs text-muted">{data.errors.length === 1 ? '1 app kon nu niet worden opgehaald.' : `${data.errors.length} apps konden nu niet worden opgehaald.`}</p>
      )}
      {open && <RegistryDetailModal name={open} onClose={() => (setOpen(null), reload())} />}
    </div>
  );
}

function bestOption(opts: RegistryOption[]) {
  const ok = opts.filter((o) => o.available);
  return ok.find((o) => o.kind === 'remote' && ![...o.headers].some((h) => h.required && h.secret)) || ok.find((o) => o.commandFound !== false && o.kind !== 'remote') || ok[0] || null;
}

export function RegistryDetailModal({ name, onClose }: { name: string; onClose(): void }) {
  const [d, setD] = useState<RegistryDetail | null>(null);
  const [error, setError] = useState('');
  const [optKey, setOptKey] = useState('');
  const [inputs, setInputs] = useState<Record<string, string>>({});
  const [auth, setAuth] = useState('');
  const [wizard, setWizard] = useState<{ entry: CatalogEntry; reg: RegistryPick } | null>(null);
  const { busy, run } = useAsync();
  useEffect(() => {
    api
      .get<RegistryDetail>(`/mcp/registry/server${qs({ name })}`)
      .then((x) => {
        setD(x);
        setOptKey(bestOption(x.options)?.key || '');
      })
      .catch((e) => setError(e.message));
  }, [name]);
  const opt = d?.options.find((o) => o.key === optKey) || null;
  const prepare = () =>
    d &&
    opt &&
    run(async () => {
      const r = await api.post<{ entry: CatalogEntry; registry: RegistryPick['registry']; policy: RegistryPick['policy'] }>('/mcp/registry/entry', { name: d.name, version: d.version, option: opt.key, inputs, ...(auth ? { auth } : {}) });
      setWizard({ entry: r.entry, reg: { registry: r.registry, policy: r.policy } });
    });
  if (wizard) return <Wizard entry={wizard.entry} reg={wizard.reg} onClose={onClose} />;
  return (
    <Modal open onClose={onClose} wide title={d ? d.title : name}>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !d ? (
        <Spinner />
      ) : (
        <div className="space-y-4">
          <div className="flex items-start gap-3">
            <AppIcon src={d.icon} title={d.title} name={d.name} size={40} />
            <div className="min-w-0">
              <div className="font-mono text-xs text-muted">{d.name}</div>
              <p className="text-sm">{d.description}</p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <SignatureBadge sig={d.signature} />
            <Badge>{d.category}</Badge>
            {d.status === 'deprecated' && <Badge tone="warn">Verouderd</Badge>}
            {d.installed.length > 0 && <Badge tone="ok">Geïnstalleerd ({d.installed.map((x) => `v${x.version}`).join(', ')})</Badge>}
            {d.stale && <Badge tone="warn">uit de cache</Badge>}
          </div>
          {d.status === 'deprecated' && d.statusMessage && <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">{d.statusMessage}</p>}
          <Meta
            items={[
              [
                'Uitgever',
                <span key="p" className="inline-flex items-center gap-1">
                  {d.publisher} <ShieldCheck className="h-3.5 w-3.5 text-ok" aria-hidden />
                  <span className="text-xs text-muted">{d.publisherKind === 'github' ? 'GitHub-account geverifieerd door het register' : 'domein geverifieerd door het register'}</span>
                </span>,
              ],
              ['Versie', `${d.version}${d.publishedAt ? ` · gepubliceerd ${fmtDate(d.publishedAt)}` : ''}`],
              ['Licentie', d.license ? `${d.license}${d.licenseSource ? ` (volgens ${d.licenseSource})` : ''}` : 'Onbekend; zie de bron'],
              [
                'Bron',
                d.repository ? (
                  <a key="r" className="inline-flex items-center gap-1 break-all text-accent underline" href={d.repository} target="_blank" rel="noopener noreferrer">
                    {d.repository}
                    {d.subfolder ? ` (${d.subfolder})` : ''} <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  ''
                ),
              ],
              [
                'Website',
                d.websiteUrl ? (
                  <a key="w" className="inline-flex items-center gap-1 break-all text-accent underline" href={d.websiteUrl} target="_blank" rel="noopener noreferrer">
                    {d.websiteUrl} <ExternalLink className="h-3 w-3" />
                  </a>
                ) : (
                  ''
                ),
              ],
            ]}
          />
          <section className="space-y-2">
            <div className="text-sm font-semibold">Installatievorm</div>
            <ul className="space-y-2">
              {d.options.map((o) => (
                <li key={o.key}>
                  <label className={cx('flex cursor-pointer items-start gap-3 rounded-lg border p-3 text-sm', optKey === o.key ? 'border-accent' : 'border-line', !o.available && 'cursor-not-allowed opacity-70')}>
                    <input type="radio" name="opt" className="mt-1" disabled={!o.available} checked={optKey === o.key} onChange={() => (setOptKey(o.key), setInputs({}))} />
                    <div className="min-w-0 flex-1 space-y-1">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="font-medium">{o.label}</span>
                        {o.kind !== 'remote' && o.commandFound === false && <Badge tone="warn">{o.runtime} niet gevonden op deze computer</Badge>}
                      </div>
                      <div className="break-all font-mono text-xs text-muted">{o.preview}</div>
                      {(o.env.length > 0 || o.headers.length > 0) && (
                        <div className="text-xs text-muted">
                          {o.kind === 'remote' ? 'Headers' : 'Omgevingsvariabelen'}:{' '}
                          {[...o.env, ...o.headers].map((f) => `${f.name}${f.required ? ' (verplicht)' : ''}${f.secret ? ' (geheim)' : ''}`).join(', ')}
                        </div>
                      )}
                      {!o.available && <div className="text-xs text-warn">{o.unavailableReason || o.reason}</div>}
                    </div>
                  </label>
                </li>
              ))}
            </ul>
          </section>
          {opt && opt.inputs.length > 0 && (
            <section className="space-y-2">
              <div className="text-sm font-semibold">Instellingen van de uitgever</div>
              {opt.inputs.map((f) => (
                <Field key={f.name} label={`${f.label}${f.required ? ' *' : ''}`} hint={f.help}>
                  {f.choices?.length ? (
                    <Select value={inputs[f.name] ?? f.default ?? ''} onChange={(e) => setInputs((x) => ({ ...x, [f.name]: e.target.value }))}>
                      {!f.required && <option value="">(standaard)</option>}
                      {f.choices.map((c) => (
                        <option key={c} value={c}>
                          {c}
                        </option>
                      ))}
                    </Select>
                  ) : (
                    <Input value={inputs[f.name] ?? ''} placeholder={f.default} onChange={(e) => setInputs((x) => ({ ...x, [f.name]: e.target.value }))} />
                  )}
                </Field>
              ))}
            </section>
          )}
          {opt?.kind === 'remote' && (
            <Field label="Inloggen" hint="Automatisch: TeamBot vraagt de server (zonder gegevens) of hij om inloggen vraagt.">
              <Select value={auth} onChange={(e) => setAuth(e.target.value)}>
                <option value="">Automatisch</option>
                <option value="none">Geen</option>
                <option value="headers">Token of sleutel in een header</option>
                <option value="oauth">OAuth (inloggen bij de dienst)</option>
              </Select>
            </Field>
          )}
          {d.versions.length > 1 && (
            <Collapse title={`Versies (${d.versions.length})`}>
              <ul className="space-y-0.5 text-sm">
                {d.versions.map((v) => (
                  <li key={v.version}>
                    <span className="font-medium">{v.version}</span> {v.publishedAt && <span className="text-muted">({fmtDate(v.publishedAt)})</span>} {v.isLatest && <Badge tone="ok">nieuwste</Badge>} {v.status !== 'active' && <Badge tone="warn">{v.status}</Badge>}
                  </li>
                ))}
              </ul>
            </Collapse>
          )}
          {d.installed.length > 0 && (
            <div className="space-y-1 text-sm">
              <div className="font-semibold">Al gekoppeld</div>
              {d.installed.map((x) => (
                <button key={x.id} className="block text-accent underline" onClick={() => (onClose(), navigate(`/m/mcp/c/${x.id}`))}>
                  {x.display} (v{x.version})
                </button>
              ))}
            </div>
          )}
          <p className="rounded-control bg-surface-2 px-3 py-2 text-xs text-muted">
            Niet door TeamBot getest.{' '}
            <MoreInfo>
              Uit het officiële MCP-register en niet ondertekend. Bij koppelen bevestig je de opdracht of het adres, sla je sleutels op in de kluis en doet TeamBot eerst een leestest. Acties staan pas aan als jij dat kiest.
            </MoreInfo>
          </p>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-3">
            <div className="flex flex-wrap items-center gap-2">
              <ReportButton type="app" catalogId="mcp-registry" itemId={d.name} itemName={d.title} />
              <a className="inline-flex items-center gap-1 text-xs text-muted underline" href={d.registryUrl} target="_blank" rel="noopener noreferrer">
                Registergegevens <ExternalLink className="h-3 w-3" />
              </a>
            </div>
            <Button variant="primary" loading={busy} disabled={!opt || d.policy.blocked} onClick={prepare}>
              Toevoegen…
            </Button>
          </div>
        </div>
      )}
    </Modal>
  );
}
