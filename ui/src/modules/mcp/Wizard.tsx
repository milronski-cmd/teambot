import { useEffect, useRef, useState } from 'react';
import { ExternalLink } from 'lucide-react';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { Badge, Button, Field, Input, Modal, Spinner, Textarea, Toggle, toastError, cx } from '../../components/ui';
import { ConnectResult } from '../../components/ConnectCard';
import type { CatalogEntry, Conn, PolicyView } from './shared';
import { SigBadge } from './shared';

/** A connector package picked for installation (verified again by the server on create). */
export interface PackagePick {
  package: any;
  policy: PolicyView;
}

/** A server picked from the MCP Registry; the server rebuilds the template from the registry record on create. */
export interface RegistryPick {
  registry: { name: string; version: string; option: string; inputs: Record<string, string>; auth?: string };
  policy: PolicyView;
}
import { BotPicker, ConnForm, OAuthPanel, draftFromEntry, draftPayload, openLoginWindow, useInfo, type ConnDraft, type KVDraft } from './forms';
import { t, uiLocale } from '../../lib/i18n';
import { ImportedFacts, type ImportedInfo } from './Import';
import { RuntimeInstall } from './quick';

/**
 * form: what is needed (often nothing) and one button; creating → login → testing run by themselves; done or error.
 * ownapp: the service does not let TeamBot register itself, so the owner makes an own OAuth app first.
 */
type Phase = 'form' | 'creating' | 'login' | 'ownapp' | 'testing' | 'done' | 'error';

export function EntryFacts({ e }: { e: CatalogEntry }) {
  return (
    <div className="space-y-3 text-sm">
      <div className="flex flex-wrap gap-1.5">
        <SigBadge sig={e.signature} />
        <Badge tone={e.official ? 'ok' : 'neutral'}>{e.official ? `Officieel · ${e.publisher}` : e.publisher}</Badge>
        <Badge tone={e.verification === 'geverifieerd' ? 'ok' : 'warn'}>
          {e.verification === 'geverifieerd' ? `Bron geverifieerd ${new Date(e.verifiedAt).toLocaleDateString(uiLocale())}` : 'Niet geverifieerd'}
        </Badge>
        <Badge>{e.transport === 'stdio' ? 'Lokaal programma' : e.transport === 'sse' ? 'Remote (SSE)' : 'Remote (HTTP)'}</Badge>
        <Badge>{e.auth === 'oauth' ? 'OAuth-inloggen' : e.auth === 'headers' ? 'Token/sleutel' : 'Geen inlog'}</Badge>
      </div>
      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted">Gegevensstroom</dt>
        <dd>{e.dataFlow}</dd>
        {e.url && (
          <>
            <dt className="text-muted">Adres</dt>
            <dd className="break-all font-mono text-xs">{e.url}</dd>
          </>
        )}
        {e.command && (
          <>
            <dt className="text-muted">Opdracht</dt>
            <dd className="break-all font-mono text-xs">{[e.command, ...(e.args || [])].join(' ')}</dd>
          </>
        )}
        {e.requirements && (
          <>
            <dt className="text-muted">Nodig</dt>
            <dd>{e.requirements}</dd>
          </>
        )}
        {e.scopes?.length ? (
          <>
            <dt className="text-muted">Rechten</dt>
            <dd className="space-y-0.5">
              {e.scopes.map((s) => (
                <div key={s.name}>
                  <span className="font-mono text-xs">{s.name}</span> <span className="text-muted">— {s.description}</span>
                  {s.default && <Badge className="ms-1">standaard</Badge>}
                </div>
              ))}
            </dd>
          </>
        ) : null}
        {e.availability && (
          <>
            <dt className="text-muted">Beschikbaarheid</dt>
            <dd className="text-warn">{e.availability}</dd>
          </>
        )}
        <dt className="text-muted">Licentie</dt>
        <dd>{e.license}</dd>
        <dt className="text-muted">Bron</dt>
        <dd>
          {e.source ? (
            <a href={e.source} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 break-all text-accent hover:underline">
              {e.source} <ExternalLink className="h-3 w-3" />
            </a>
          ) : (
            <span className="text-muted">Niet opgegeven</span>
          )}
        </dd>
        <dt className="text-muted">Teststatus</dt>
        <dd className="text-muted">{e.testStatus}</dd>
        {e.alternatives && (
          <>
            <dt className="text-muted">Alternatief</dt>
            <dd className="break-words text-xs text-muted">{e.alternatives}</dd>
          </>
        )}
      </dl>
    </div>
  );
}

/**
 * Koppelen in one go (0.4.4): one screen with only what the app really needs (a key, a folder; often nothing) and one
 * button. TeamBot then makes the connection, opens the login of the service when there is one, runs the read test and
 * says "Verbinding werkt". Read-only until the owner switches actions on; everything else sits behind "Meer opties".
 */
export function Wizard({
  entry,
  pkg,
  reg,
  initial,
  imported,
  onClose,
  onCreated,
}: {
  entry: CatalogEntry;
  pkg?: PackagePick | null;
  reg?: RegistryPick | null;
  /** Pre-filled settings (a pasted `claude mcp add …` or MCP JSON, see Import.tsx). */
  initial?: Partial<ConnDraft>;
  imported?: ImportedInfo | null;
  onClose(): void;
  onCreated?(c: Conn): void;
}) {
  const [override, setOverride] = useState(false);
  const pick = pkg || reg || null;
  const policyBlocks = !!pick && (pick.policy.blocked || (pick.policy.needsOverride && !override));
  const info = useInfo();
  const agents = useApp((s) => s.agents);
  // TeamBot's own templates (checked and pinned) need no "do you trust this command"; anything else does.
  const simple = entry.id !== 'custom' && !pkg && !reg && !imported;
  const [d, setD] = useState<ConnDraft>(() => ({ ...draftFromEntry(entry), ...(initial || {}), ...(simple ? { trust_command: true } : {}) }));
  // "Gekoppeld" means the bots can use it: all bots, unless the owner narrows it under "Meer opties".
  const [bots, setBots] = useState<string[]>(() => agents.filter((a) => !a.archived).map((a) => a.id));
  const [conn, setConn] = useState<Conn | null>(null);
  const [phase, setPhase] = useState<Phase>('form');
  const [error, setError] = useState('');
  const [loginUrl, setLoginUrl] = useState('');
  const set = (p: Partial<ConnDraft>) => setD((x) => ({ ...x, ...p, ...(simple ? { trust_command: true } : {}) }));
  const connRef = useRef<Conn | null>(null);
  connRef.current = conn;

  const fail = (e: any) => {
    setError(String(e?.message || e));
    setPhase('error');
  };

  const test = async (c: Conn) => {
    setPhase('testing');
    try {
      const r = await api.post<{ ok: boolean; error?: string; connection: Conn }>(`/mcp/connections/${c.id}/test`, {});
      setConn(r.connection);
      if (r.ok) setPhase('done');
      else fail(r.error || 'De app gaf geen antwoord.');
    } catch (e) {
      fail(e);
    }
  };

  // The login of the service is done in the browser; the server tells us when it came back.
  useEffect(
    () =>
      on('mcp.oauth', (ev: any) => {
        const c = connRef.current;
        if (!c || ev?.id !== c.id) return;
        if (ev.ok) void test(c);
        else fail(ev.error || 'Inloggen mislukt');
      }),
    [],
  );

  const login = async (c: Conn, w: Window | null) => {
    const prep = await api.post<{ registration: string; scopes: { name: string; required: boolean; default: boolean }[] }>(`/mcp/connections/${c.id}/oauth/prepare`);
    if (prep.registration === 'missing') {
      w?.close();
      return setPhase('ownapp');
    }
    const r = await api.post<{ authorizationUrl: string }>(`/mcp/connections/${c.id}/oauth/start`, { scopes: prep.scopes.filter((s) => s.default || s.required).map((s) => s.name) });
    setLoginUrl(r.authorizationUrl);
    if (w && !w.closed) w.location.href = r.authorizationUrl;
    else window.open(r.authorizationUrl, '_blank', 'noopener');
    setPhase('login');
  };

  const connect = async () => {
    if (d.transport === 'stdio' && !d.trust_command) return toastError(new Error('Bevestig dat je de opdracht vertrouwt'));
    const missing = [...d.env, ...d.headers].find((k) => k.required && !k.value);
    if (missing) return toastError(new Error(`Vul “${missing.label || missing.name}” in`));
    // Opened inside the click, so the browser does not block it as a popup.
    const w = d.auth === 'oauth' ? openLoginWindow() : null;
    setError('');
    setPhase('creating');
    try {
      // A failed attempt is thrown away, so what was changed in the form counts and nothing half-made is left behind.
      if (conn) await api.del(`/mcp/connections/${conn.id}`).catch(() => undefined);
      const source = pkg ? { package: pkg.package, overridePolicy: override } : reg ? { registry: reg.registry, overridePolicy: override } : { catalog_id: entry.id };
      const c = await api.post<Conn>('/mcp/connections', { ...source, ...draftPayload(d, entry, true), extraArgs: undefined, agentIds: bots });
      setConn(c);
      onCreated?.(c);
      if (c.auth === 'oauth') await login(c, w);
      else await test(c);
    } catch (e) {
      w?.close();
      fail(e);
    }
  };

  /** Closing after a failure takes the half-made connection away; a login that is still open may finish later. */
  const close = () => {
    if (phase === 'error' && conn) void api.del(`/mcp/connections/${conn.id}`).catch(() => undefined);
    onClose();
  };

  const busy = phase === 'creating' || phase === 'testing';
  const kvField = (k: KVDraft, kind: 'env' | 'headers') => (
    <Field key={`${kind}-${k.name}`} label={k.label || k.name} hint={k.help}>
      <Input
        type={k.secret ? 'password' : 'text'}
        autoComplete="off"
        value={k.value}
        placeholder={k.placeholder || (k.secret ? 'Plak hier je sleutel' : '')}
        onChange={(e) => set({ [kind]: d[kind].map((x) => (x.name === k.name ? { ...x, value: e.target.value } : x)) } as Partial<ConnDraft>)}
      />
    </Field>
  );
  const required = simple ? [...d.env.filter((k) => k.required).map((k) => kvField(k, 'env')), ...d.headers.filter((k) => k.required).map((k) => kvField(k, 'headers'))] : [];
  const actionTools = (conn?.tools || []).filter((x) => x.present && x.risk !== 'read');
  const name = conn?.display || (imported && d.name ? d.name : entry.name);
  // npx/uvx missing: "Installeren" gets TeamBot's own copy (core/runtimes.ts); other programs the user installs himself.
  const [runtimeOk, setRuntimeOk] = useState(false);
  const runtime = entry.command === 'npx' ? 'node' : entry.command === 'uvx' ? 'uv' : null;
  const notFound = d.transport === 'stdio' && entry.commandFound === false && entry.command && !runtimeOk;

  return (
    <Modal
      open
      wide={!simple}
      onClose={close}
      title={t('{0} koppelen', name)}
      footer={
        phase === 'done' ? (
          <Button variant="primary" onClick={onClose}>
            Klaar
          </Button>
        ) : phase === 'login' || phase === 'ownapp' ? (
          <Button variant="ghost" onClick={onClose}>
            Later inloggen
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={close}>
              Annuleren
            </Button>
            <Button variant="primary" loading={busy} disabled={!entry.available || policyBlocks} onClick={connect} data-testid="app-connect">
              {phase === 'error' ? 'Opnieuw proberen' : 'Koppelen'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4 text-sm" data-testid="app-connect-dialog" data-phase={phase}>
        {phase === 'done' && conn ? (
          <>
            <ConnectResult ok>{t('Verbinding werkt: {0, plural, one {# tool gevonden} other {# tools gevonden}}.', conn.counts.total)}</ConnectResult>
            <p className="text-muted">Je bots kunnen {name} nu gebruiken.</p>
            {actionTools.length > 0 && (
              <Toggle
                checked={conn.allow_actions}
                onChange={async (v) => {
                  try {
                    setConn(await api.post<Conn>(`/mcp/connections/${conn.id}/actions`, { enabled: v }));
                  } catch (e) {
                    toastError(e);
                  }
                }}
                label="Mag ook iets wijzigen of versturen (vraagt je eerst om toestemming)"
              />
            )}
          </>
        ) : phase === 'ownapp' && conn ? (
          <OAuthPanel conn={conn} onDone={(ok) => ok && test(conn)} />
        ) : phase === 'login' ? (
          <div className="space-y-2 rounded-lg bg-surface-2 p-3" role="status">
            <div className="flex items-center gap-2 font-medium">
              <Spinner /> Log in in het venster dat is geopend…
            </div>
            {loginUrl && (
              <a href={loginUrl} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-xs font-medium text-fg underline">
                <ExternalLink className="h-3.5 w-3.5" /> Geen venster gezien? Open de inlogpagina
              </a>
            )}
          </div>
        ) : (
          <>
            {!simple && imported && <ImportedFacts d={d} info={imported} />}
            <p className="text-muted">{entry.description}</p>
            {!entry.available && <div className="rounded-lg bg-warn-soft p-3 text-warn">{entry.unavailableReason}</div>}
            {notFound && runtime && <RuntimeInstall id={runtime} onDone={() => setRuntimeOk(true)} />}
            {notFound && !runtime && (
              <div className="rounded-lg bg-warn-soft p-3 text-warn" data-testid="app-needs-runtime">
                {t('Deze app heeft {0} nodig en dat staat niet op deze computer.', entry.command || '')}
              </div>
            )}
            {pick && !pick.policy.allowed && pick.policy.reason && (
              <div role={pick.policy.blocked ? 'alert' : undefined} className={cx('rounded-lg p-3', pick.policy.blocked ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn')}>
                {pick.policy.reason}
              </div>
            )}
            {pick?.policy.needsOverride && (
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={override} onChange={(e) => setOverride(e.target.checked)} />
                <span>Ik sta dit pakket toch toe, buiten het uitgeversbeleid. Dit wordt vastgelegd.</span>
              </label>
            )}
            {required}
            {simple && entry.argsPrompt && !entry.argsPrompt.defaultWorkFolders && (
              <Field label={entry.argsPrompt.label} hint={entry.argsPrompt.help}>
                <Textarea rows={2} value={d.extraArgs} onChange={(e) => set({ extraArgs: e.target.value })} className="font-mono text-xs" />
              </Field>
            )}
            {simple && d.auth === 'oauth' && phase !== 'error' && <p className="text-muted">Je logt in bij de dienst zelf; TeamBot bewaart de toegang versleuteld.</p>}
            {!simple && (
              // Own server, register or import: what is needed to connect in view, the rest (bots, label, local
              // network, time-outs, the facts) under "Meer opties".
              <ConnForm
                d={d}
                set={set}
                entry={entry}
                isNew
                info={info}
                fold
                more={
                  <>
                    <Field label="Welke bots mogen deze app gebruiken?">
                      <BotPicker value={bots} onChange={setBots} />
                    </Field>
                    {entry.id !== 'custom' && <EntryFacts e={entry} />}
                  </>
                }
              />
            )}
            {busy && (
              <div className="flex items-center gap-2 text-muted" role="status">
                <Spinner /> {phase === 'creating' ? 'Koppelen…' : d.transport === 'stdio' ? 'Testen (de eerste keer kan downloaden even duren)…' : 'Testen…'}
              </div>
            )}
            {phase === 'error' && (
              <ConnectResult ok={false} next={notFound ? undefined : required.length ? 'Controleer wat je hebt ingevuld en probeer het opnieuw.' : 'Probeer het opnieuw.'}>
                {error}
              </ConnectResult>
            )}
            {simple && (
              <details className="group">
                <summary className="cursor-pointer text-xs font-medium text-muted hover:text-fg">Meer opties</summary>
                <div className="mt-3 space-y-5">
                  <Field label="Welke bots mogen deze app gebruiken?">
                    <BotPicker value={bots} onChange={setBots} />
                  </Field>
                  <ConnForm d={d} set={set} entry={entry} isNew info={info} />
                  <EntryFacts e={entry} />
                </div>
              </details>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
