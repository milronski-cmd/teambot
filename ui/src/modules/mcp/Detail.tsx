import { useEffect, useMemo, useState } from 'react';
import { ChevronLeft, FlaskConical, LogIn, LogOut, Pencil, Power, RefreshCw, ScrollText, Square, TriangleAlert, Unplug } from 'lucide-react';
import { api, on, request } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { useApp } from '../../lib/store';
import { Badge, Button, Card, EmptyState, Modal, Page, PageHeader, Select, Spinner, Toggle, toast, toastError, useAsync, cx, timeAgo } from '../../components/ui';
import type { Conn, PolicyView, Risk, SigView, ToolView } from './shared';
import { RISK_HELP, RISK_TEXT, RiskBadge, SigBadge, StatusBadge, timeShort } from './shared';
import { BotPicker, ConnForm, OAuthPanel, draftFromConn, draftPayload, useInfo, type ConnDraft } from './forms';

const ORDER: Risk[] = ['read', 'write', 'exec', 'danger'];

function EditModal({ conn, onClose, onSaved }: { conn: Conn; onClose(): void; onSaved(c: Conn): void }) {
  const info = useInfo();
  const [d, setD] = useState<ConnDraft>(() => draftFromConn(conn));
  const { busy, run } = useAsync();
  const set = (p: Partial<ConnDraft>) => setD((x) => ({ ...x, ...p }));
  const save = () =>
    run(async () => {
      const c = await api.patch<Conn>(`/mcp/connections/${conn.id}`, draftPayload(d, null, false));
      onSaved(c);
      onClose();
    }, 'Opgeslagen');
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={`${conn.display} bewerken`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="primary" loading={busy} onClick={save}>
            Opslaan
          </Button>
        </>
      }
    >
      <div className="mb-3 rounded-lg bg-surface-2 p-3 text-xs text-muted">Wijzig je de opdracht, URL of geheimen, dan moet je de leestest opnieuw doen en acties opnieuw toestaan.</div>
      <ConnForm d={d} set={set} entry={null} isNew={false} info={info} />
    </Modal>
  );
}

function ToolRow({ conn, t, onChanged }: { conn: Conn; t: ToolView; onChanged(c: Conn): void }) {
  const [confirm, setConfirm] = useState<{ risk: Risk | null } | null>(null);
  const [open, setOpen] = useState(false);
  // TeamBot's own guess, as long as the owner did not choose a risk himself.
  const guess = !!t.guessed && !t.user_risk;
  const patch = async (body: any) => {
    try {
      onChanged(await api.patch<Conn>(`/mcp/connections/${conn.id}/tools/${encodeURIComponent(t.name)}`, body));
    } catch (e: any) {
      toastError(e);
    }
  };
  const changeRisk = (v: string) => {
    const next = (v === '' ? null : v) as Risk | null;
    const target = next || t.server_risk;
    if (ORDER.indexOf(target) < ORDER.indexOf(t.risk)) setConfirm({ risk: next });
    else patch({ risk: next });
  };
  return (
    <div className={cx('rounded-lg border p-2.5', t.usable ? 'border-line' : 'border-line bg-surface-2/60')}>
      <div className="flex flex-wrap items-center gap-2">
        <button className="min-w-0 flex-1 text-start" onClick={() => setOpen(!open)} aria-expanded={open}>
          <div className="truncate font-mono text-xs">{t.name}</div>
          {t.title && <div className="truncate text-xs text-muted">{t.title}</div>}
        </button>
        {!t.present && <Badge>verdwenen</Badge>}
        {t.changed && <Badge tone="warn">gewijzigd</Badge>}
        {!t.approved && !t.changed && t.present && <Badge tone="warn">nieuw</Badge>}
        {guess ? <Badge tone="ok">waarschijnlijk alleen lezen</Badge> : <RiskBadge risk={t.risk} />}
        <Select value={t.user_risk || ''} onChange={(e) => changeRisk(e.target.value)} className="h-8 w-auto text-xs" aria-label={`Risico van ${t.name}`}>
          <option value="">standaard ({t.guessed ? 'waarschijnlijk alleen lezen' : RISK_TEXT[t.server_risk]})</option>
          {ORDER.map((r) => (
            <option key={r} value={r}>
              {RISK_TEXT[r]}
            </option>
          ))}
        </Select>
        <Toggle checked={t.enabled} onChange={(v) => patch({ enabled: v })} label={<span className="sr-only">Tool {t.name} aan</span>} />
      </div>
      {(t.changed || (!t.approved && t.present)) && conn.verified_at && (
        <div className="mt-2 flex flex-wrap items-center gap-2 text-xs">
          <span className="text-warn">{t.changed ? 'De server heeft deze tool gewijzigd sinds jouw goedkeuring. Controleer de beschrijving.' : 'Nieuwe tool sinds de leestest.'}</span>
          <Button size="sm" onClick={() => patch({ approve: true })}>
            Goedkeuren
          </Button>
        </div>
      )}
      {open && (
        <div className="mt-2 space-y-2 text-xs">
          <div className="whitespace-pre-wrap text-muted">{t.description || '(geen beschrijving)'}</div>
          <div className="text-muted">
            Volgens de server: {Object.entries(t.annotations || {}).filter(([k]) => k.endsWith('Hint')).map(([k, v]) => `${k}=${String(v)}`).join(', ') || 'geen annotaties'} → {t.guessed ? 'waarschijnlijk alleen lezen' : RISK_TEXT[t.hint_risk]}. {RISK_HELP[t.risk]}.
          </div>
          {guess && (
            <div className="rounded-md bg-surface-2 p-2 text-muted">
              De app meldt niet of dit iets wijzigt; TeamBot behandelt het als lezen. Klopt dat niet, kies “schrijven”.
            </div>
          )}
          <details>
            <summary className="cursor-pointer text-muted">Invoerschema</summary>
            <pre className="scroll-thin mt-1 max-h-48 overflow-auto rounded bg-surface-2 p-2">{JSON.stringify(t.input_schema, null, 2)}</pre>
          </details>
          <div className="text-muted">
            Toolnaam voor de bot: <span className="font-mono">{t.exposed}</span>
          </div>
        </div>
      )}
      {confirm && (
        <Modal
          open
          onClose={() => setConfirm(null)}
          title="Minder streng maken?"
          footer={
            <>
              <Button variant="ghost" onClick={() => setConfirm(null)}>
                Annuleren
              </Button>
              <Button
                variant="danger"
                onClick={() => {
                  patch({ risk: confirm.risk, confirm: true });
                  setConfirm(null);
                }}
              >
                Ja, minder streng
              </Button>
            </>
          }
        >
          <p className="text-sm">
            Je verandert <span className="font-mono">{t.name}</span> van <b>{RISK_TEXT[t.risk]}</b> naar <b>{RISK_TEXT[confirm.risk || t.server_risk]}</b>. Daardoor vraagt de bot mogelijk geen toestemming meer voor deze actie. Dit wordt in het logboek vastgelegd.
          </p>
        </Modal>
      )}
    </div>
  );
}

function CallLog({ conn }: { conn: Conn }) {
  const [rows, setRows] = useState<any[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(true);
  const load = (before?: number) =>
    api
      .get<any[]>(`/mcp/connections/${conn.id}/calls?limit=30${before ? `&before=${before}` : ''}`)
      .then((r) => {
        setRows((cur) => (before ? [...(cur || []), ...r] : r));
        setMore(r.length === 30);
      })
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
  }, [conn.id, conn.updated_at]);
  if (err) return <div className="text-sm text-danger">{err}</div>;
  if (!rows) return <Spinner />;
  if (!rows.length) return <div className="text-sm text-muted">Nog geen gebruik.</div>;
  return (
    <div className="space-y-1">
      {rows.map((r) => (
        <div key={r.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 border-b border-line py-1.5 text-xs last:border-0">
          <span className="w-24 shrink-0 text-muted" title={r.created_at}>
            {timeShort(r.created_at)}
          </span>
          <span className={r.ok ? 'text-ok' : 'text-danger'}>{r.ok ? '✓' : '✕'}</span>
          <span className="font-mono">{r.tool}</span>
          <span className="text-muted">{r.agent_name || (r.kind === 'test' ? 'test' : '')}</span>
          <span className="text-muted">{r.duration_ms} ms</span>
          {r.summary && <span className="w-full truncate text-muted sm:w-auto sm:flex-1">{r.summary}</span>}
          {r.error && <span className="w-full break-words text-danger">{r.error}</span>}
        </div>
      ))}
      {more && (
        <Button size="sm" variant="ghost" onClick={() => load(rows[rows.length - 1]?.id)}>
          Meer laden
        </Button>
      )}
    </div>
  );
}

export function DetailPage({ id }: { id: string }) {
  const [conn, setConn] = useState<Conn | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [edit, setEdit] = useState(false);
  const [oauth, setOauth] = useState(false);
  const [del, setDel] = useState(false);
  const [deleteData, setDeleteData] = useState(false);
  const [testMsg, setTestMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const act = useAsync();
  const agents = useApp((s) => s.agents);

  const load = () =>
    api
      .get<Conn>(`/mcp/connections/${id}`)
      .then((c) => (setConn(c), setErr(null)))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    const offs = [
      on('mcp.updated', (d: any) => {
        if (d?.id !== id) return;
        if (d.deleted) setErr('Deze koppeling is verwijderd');
        else load();
      }),
      on('mcp.status', (d: any) => d?.id === id && setConn((c) => (c ? { ...c, runtime: { ...c.runtime, ...d } } : c))),
    ];
    return () => offs.forEach((f) => f());
  }, [id]);

  const tools = useMemo(() => (conn?.tools || []).slice().sort((a, b) => Number(b.present) - Number(a.present) || ORDER.indexOf(a.risk) - ORDER.indexOf(b.risk) || a.name.localeCompare(b.name)), [conn?.tools]);

  if (err && !conn) return <EmptyState title="Koppeling niet beschikbaar" action={<Button onClick={() => navigate('/m/mcp')}>Terug naar Apps</Button>}>{err}</EmptyState>;
  if (!conn)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );

  const test = () =>
    act.run(async () => {
      const r = await api.post<any>(`/mcp/connections/${id}/test`, {});
      setConn(r.connection);
      setTestMsg(r.ok ? { ok: true, text: t('Leestest geslaagd: {0, plural, one {# tool} other {# tools}}.', r.connection.counts.total) } : { ok: false, text: r.error });
    });
  const restart = () =>
    act.run(async () => {
      const r = await api.post<any>(`/mcp/connections/${id}/restart`, {});
      setConn(r.connection);
      if (!r.ok) setTestMsg({ ok: false, text: r.error });
      else toast('Opnieuw verbonden', 'ok');
    });
  const stop = () => act.run(async () => setConn(await api.post<Conn>(`/mcp/connections/${id}/stop`, {})), 'Gestopt');
  const setActions = (v: boolean) => act.run(async () => setConn(await api.post<Conn>(`/mcp/connections/${id}/actions`, { enabled: v })));
  const setEnabled = (v: boolean) => act.run(async () => setConn(await api.patch<Conn>(`/mcp/connections/${id}`, { enabled: v })));
  const setBots = (ids: string[]) => act.run(async () => setConn(await api.put<Conn>(`/mcp/connections/${id}/agents`, { agentIds: ids })));
  const revoke = () =>
    act.run(async () => {
      const r = await api.post<any>(`/mcp/connections/${id}/oauth/revoke`, {});
      setConn(r.connection);
      toast(r.detail, r.revokedAtService ? 'ok' : 'neutral');
    });
  const remove = () =>
    act.run(async () => {
      const r = await api.del<any>(`/mcp/connections/${id}${deleteData ? '?deleteData=1' : ''}`);
      toast(conn.auth === 'oauth' ? r.detail : 'Ontkoppeld', 'ok');
      navigate('/m/mcp');
    });
  const approveAll = () => act.run(async () => setConn(await api.post<Conn>(`/mcp/connections/${id}/tools/approve`, {})));

  const rt = conn.runtime;
  const needsLogin = conn.auth === 'oauth' && conn.oauth?.status !== 'connected';
  const errorText = rt.lastError || conn.last_error;

  return (
    <Page>
      <PageHeader width="4xl"
        title={
          <span className="flex flex-wrap items-center gap-2">
            <button onClick={() => navigate('/m/mcp')} className="rounded p-1 text-muted hover:bg-surface-2" aria-label="Terug">
              <ChevronLeft className="h-4 w-4" />
            </button>
            {conn.display} <StatusBadge c={conn} />
          </span>
        }
        subtitle={conn.transport === 'builtin' ? 'Ingebouwd in TeamBot · rechtstreeks naar de dienst' : conn.transport === 'stdio' ? `Lokaal programma · ${conn.command}` : `${conn.transport === 'sse' ? 'SSE' : 'Streamable HTTP'} · ${conn.host}`}
        actions={
          <>
            {needsLogin && (
              <Button variant="primary" icon={<LogIn className="h-4 w-4" />} onClick={() => setOauth(true)}>
                Inloggen
              </Button>
            )}
            <Button icon={<FlaskConical className="h-4 w-4" />} loading={act.busy} onClick={test}>
              Leestest
            </Button>
            <Button icon={<RefreshCw className="h-4 w-4" />} onClick={restart} disabled={act.busy}>
              Opnieuw verbinden
            </Button>
            {rt.state === 'ready' && (
              <Button icon={<Square className="h-4 w-4" />} onClick={stop} disabled={act.busy}>
                Stoppen
              </Button>
            )}
            <Button variant="danger" icon={<Unplug className="h-4 w-4" />} onClick={() => setDel(true)}>
              Ontkoppelen
            </Button>
          </>
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 p-4 sm:p-6">
        {testMsg && <div className={cx('rounded-lg p-3 text-sm', testMsg.ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger')}>{testMsg.text}</div>}
        {conn.signature && <PackageCard conn={conn} onUpdated={setConn} />}
        {errorText && rt.state !== 'ready' && (
          <div className="flex gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger">
            <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
            <div className="min-w-0 break-words">
              {errorText}
              {rt.state === 'backoff' && rt.nextRetryAt && <div className="mt-1 text-xs">Nieuwe poging {Date.now() - Date.parse(rt.nextRetryAt) < 60_000 ? 'zo meteen' : `om ${timeShort(rt.nextRetryAt)}`}.</div>}
            </div>
          </div>
        )}
        {!conn.verified_at && (
          <div className="rounded-lg bg-warn-soft p-3 text-sm text-warn">Nog geen geslaagde leestest: bots kunnen deze app pas gebruiken na de leestest.</div>
        )}

        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold">Status</div>
            <Toggle checked={conn.enabled} onChange={setEnabled} label="Koppeling aan" />
          </div>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[10rem_1fr]">
            <dt className="text-muted">Verbinding</dt>
            <dd>
              {
                { ready: 'verbonden', starting: 'starten…', stopped: 'gestopt (start automatisch bij gebruik)', backoff: 'gecrasht, wacht op herstart', error: 'fout', auth_required: 'inloggen nodig' }[rt.state]
              }
              {rt.pid ? ` · proces ${rt.pid}` : ''}
              {rt.restarts ? ` · ${rt.restarts}× herstart` : ''}
            </dd>
            <dt className="text-muted">Server</dt>
            <dd>{conn.server_info?.name ? `${conn.server_info.name} ${conn.server_info.version || ''}` : '—'}</dd>
            <dt className="text-muted">Leestest</dt>
            <dd>{conn.verified_at ? `geslaagd ${timeShort(conn.verified_at)}` : conn.verify_result?.error ? `mislukt: ${conn.verify_result.error}` : 'nog niet gedaan'}</dd>
            <dt className="text-muted">Laatst gebruikt</dt>
            <dd>{timeShort(rt.lastUsed)}</dd>
            {conn.auth === 'oauth' && conn.oauth && (
              <>
                <dt className="text-muted">Inloggen</dt>
                <dd>
                  {conn.oauth.status === 'connected' ? `ingelogd bij ${conn.oauth.authorization_server}` : conn.oauth.status === 'expired' ? 'verlopen' : 'niet ingelogd'}
                  {conn.oauth.granted_scope && <div className="font-mono text-xs text-muted">rechten: {conn.oauth.granted_scope}</div>}
                  {conn.oauth.expires_at && <div className="text-xs text-muted">token geldig tot {timeShort(conn.oauth.expires_at)}{conn.oauth.has_refresh ? ' (wordt automatisch vernieuwd)' : ''}</div>}
                </dd>
              </>
            )}
            {conn.dataDir && (
              <>
                <dt className="text-muted">{conn.cwd ? 'Werkmap' : 'Datamap'}</dt>
                <dd className="break-all font-mono text-xs">{conn.cwd || conn.dataDir}</dd>
              </>
            )}
          </dl>
          {conn.auth === 'oauth' && conn.oauth?.status === 'connected' && (
            <Button size="sm" icon={<LogOut className="h-4 w-4" />} onClick={revoke}>
              Toegang intrekken
            </Button>
          )}
          {!!conn.stderr?.length && (
            <details>
              <summary className="cursor-pointer text-sm text-muted">Uitvoer van het programma (laatste regels)</summary>
              <pre className="scroll-thin mt-2 max-h-56 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 text-xs">{conn.stderr.join('\n')}</pre>
            </details>
          )}
        </Card>

        <Card className={cx('space-y-3 p-4', conn.transport === 'builtin' && 'hidden')}>
          <div className="flex items-center justify-between gap-2">
            <div className="font-semibold">Instellingen</div>
            <Button size="sm" icon={<Pencil className="h-4 w-4" />} onClick={() => setEdit(true)}>
              Bewerken
            </Button>
          </div>
          <dl className="grid gap-x-4 gap-y-1.5 text-sm sm:grid-cols-[10rem_1fr]">
            {conn.transport === 'stdio' ? (
              <>
                <dt className="text-muted">Opdracht</dt>
                <dd className="break-all font-mono text-xs">{[conn.command, ...conn.args].join(' ')}</dd>
                <dt className="text-muted">Vertrouwd</dt>
                <dd>{conn.trusted ? 'ja' : <span className="text-warn">nee — bevestig via Bewerken</span>}</dd>
                <dt className="text-muted">Variabelen</dt>
                <dd className="font-mono text-xs">{conn.env.length ? conn.env.map((e) => `${e.name}=${e.secret ? '••••' : e.value}`).join('  ') : '—'}</dd>
              </>
            ) : (
              <>
                <dt className="text-muted">URL</dt>
                <dd className="break-all font-mono text-xs">{conn.url}</dd>
                <dt className="text-muted">Headers</dt>
                <dd className="font-mono text-xs">{conn.headers.length ? conn.headers.map((e) => `${e.name}: ${e.secret ? '••••' : e.value}`).join('  ') : '—'}</dd>
              </>
            )}
            <dt className="text-muted">Toolnamen</dt>
            <dd className="font-mono text-xs">mcp_{conn.slug}_…</dd>
            <dt className="text-muted">Stoppen na</dt>
            <dd>{conn.idle_minutes ? `${conn.idle_minutes} min inactiviteit` : 'nooit'}</dd>
          </dl>
        </Card>

        <Card className="space-y-3 p-4">
          <div className="font-semibold">Bots</div>
          <BotPicker value={conn.agents} onChange={setBots} />
          {conn.agents.some((a) => agents.find((x) => x.id === a)?.access_mode === 'chat') && <div className="text-xs text-muted">Bots in modus “alleen chat” gebruiken geen tools.</div>}
        </Card>

        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <div className="font-semibold">Acties</div>
              <div className="text-xs text-muted">Uit = bots gebruiken alleen leestools van deze app.</div>
            </div>
            <Toggle checked={conn.allow_actions} disabled={!conn.verified_at || act.busy} onChange={setActions} label={conn.allow_actions ? 'Acties toegestaan' : 'Alleen lezen'} />
          </div>
          <div className="flex flex-wrap gap-1.5 text-xs">
            {ORDER.map((r) => (
              <span key={r} className="inline-flex items-center gap-1">
                <RiskBadge risk={r} /> {conn.counts[r]}
              </span>
            ))}
          </div>
        </Card>

        <Card className="space-y-3 p-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="font-semibold">
              Tools <span className="text-sm font-normal text-muted">({conn.counts.usable} bruikbaar van {conn.counts.total})</span>
            </div>
            {conn.counts.pending > 0 && conn.verified_at && (
              <Button size="sm" onClick={approveAll}>
                Alles goedkeuren ({conn.counts.pending})
              </Button>
            )}
          </div>
          <div className="text-xs text-muted">Strenger maken kan altijd; minder streng vraagt bevestiging.</div>
          {tools.length ? (
            <div className="space-y-1.5">
              {tools.map((t) => (
                <ToolRow key={t.name} conn={conn} t={t} onChanged={setConn} />
              ))}
            </div>
          ) : (
            <div className="text-sm text-muted">Nog geen tools bekend. Doe de leestest.</div>
          )}
        </Card>

        <Card className="space-y-3 p-4">
          <div className="flex items-center gap-2 font-semibold">
            <ScrollText className="h-4 w-4" /> Logboek
          </div>
          <CallLog conn={conn} />
        </Card>
      </div>

      {edit && <EditModal conn={conn} onClose={() => setEdit(false)} onSaved={setConn} />}
      {oauth && (
        <Modal open onClose={() => setOauth(false)} title={`Inloggen bij ${conn.display}`}>
          <OAuthPanel
            conn={conn}
            onDone={() => {
              setOauth(false);
              load();
            }}
          />
        </Modal>
      )}
      {del && (
        <Modal
          open
          onClose={() => setDel(false)}
          title={`${conn.display} ontkoppelen?`}
          footer={
            <>
              <Button variant="ghost" onClick={() => setDel(false)}>
                Annuleren
              </Button>
              <Button variant="danger" icon={<Power className="h-4 w-4" />} loading={act.busy} onClick={remove}>
                Ontkoppelen
              </Button>
            </>
          }
        >
          <div className="space-y-3 text-sm">
            <p>Dit stopt de server, verwijdert de koppeling bij alle bots en wist opgeslagen geheimen{conn.auth === 'oauth' ? ' en tokens' : ''}.</p>
            {conn.auth === 'oauth' && <p>{conn.oauth?.can_revoke ? 'TeamBot trekt de toegang ook in bij de dienst.' : 'Deze dienst biedt geen automatische intrekking; trek de toegang zo nodig zelf in bij de dienst.'}</p>}
            {conn.catalog?.revokeHelp && <p className="text-muted">{conn.catalog.revokeHelp}</p>}
            {conn.dataDir && <Toggle checked={deleteData} onChange={setDeleteData} label="Ook de datamap van deze koppeling verwijderen" />}
            <p className="text-muted">Het logboek in Instellingen › Beveiliging blijft bewaard.</p>
          </div>
        </Modal>
      )}
    </Page>
  );
}

/** A connection installed from the MCP Registry: version, newer version check and update (trust + read-only test start over). */
function RegistryOrigin({ conn, onUpdated }: { conn: Conn; onUpdated(c: Conn): void }) {
  const r = conn.registry!;
  const [trust, setTrust] = useState(false);
  const [note, setNote] = useState('');
  const { busy, run } = useAsync();
  const check = () =>
    run(async () => {
      await api.post('/mcp/registry/check-updates', { force: true });
      onUpdated(await api.get<Conn>(`/mcp/connections/${conn.id}`));
    });
  const update = () =>
    run(async () => {
      const res = await api.post<{ connection: Conn; from: string; to: string; missing: string[]; needsTrust: boolean; unchanged: boolean }>(`/mcp/connections/${conn.id}/registry-update`, { trust_command: trust });
      onUpdated(res.connection);
      if (res.unchanged) return setNote('Je hebt de nieuwste versie al.');
      setNote(`Bijgewerkt van ${res.from} naar ${res.to}. Doe opnieuw een leestest${res.needsTrust ? ' en bevestig dat je de nieuwe opdracht vertrouwt (Bewerken)' : ''}.${res.missing.length ? ` Vul nog in: ${res.missing.join(', ')}.` : ''}`);
    });
  return (
    <div className="space-y-2">
      <p className="text-muted">
        Geïnstalleerd uit het officiële MCP-register: <span className="font-mono text-xs">{r.name}</span> versie {r.version}
        {r.identifier ? ` (${r.kind} ${r.identifier})` : ''}.
      </p>
      {r.updateAvailable ? (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <div>
            Nieuwere versie in het register: <span className="font-medium">{r.latest}</span>
          </div>
          {conn.transport === 'stdio' && <Toggle checked={trust} onChange={setTrust} label="Ik vertrouw de opdracht van de nieuwe versie" />}
          <p className="text-xs text-muted">Na het bijwerken staan acties weer uit tot een nieuwe leestest is gelukt.</p>
          <div className="flex justify-end">
            <Button variant="primary" size="sm" loading={busy} onClick={update}>
              Bijwerken naar {r.latest}
            </Button>
          </div>
        </div>
      ) : (
        <Button size="sm" variant="ghost" loading={busy} onClick={check}>
          Controleren op een nieuwere versie
        </Button>
      )}
      {note && <p className="text-sm text-ok">{note}</p>}
    </div>
  );
}

/** Where this connection's template came from (built-in, package or hand-made), and updating a package to a new version. */
function PackageCard({ conn, onUpdated }: { conn: Conn; onUpdated(c: Conn): void }) {
  const [next, setNext] = useState<{ package: any; signature: SigView; policy: PolicyView; version: string | null } | null>(null);
  const [override, setOverride] = useState(false);
  const [publisherMsg, setPublisherMsg] = useState('');
  const [publisherOk, setPublisherOk] = useState(false);
  const [error, setError] = useState('');
  const { busy, run } = useAsync();
  const sig = conn.signature!;
  const pick = (f?: File) => {
    if (!f) return;
    run(async () => {
      setError('');
      setPublisherMsg('');
      try {
        const r = await request<{ kind: string; package: any }>('/skills/packages/unzip', { method: 'POST', raw: f, headers: { 'content-type': 'application/zip' } });
        if (r.kind !== 'connector') throw new Error('Dit is geen connectorpakket.');
        const pv = await api.post<any>('/mcp/packages/preview', { package: r.package });
        setNext({ package: r.package, signature: pv.signature, policy: pv.policy, version: pv.manifest?.version || null });
      } catch (e: any) {
        setError(e.message);
      }
    });
  };
  const apply = () =>
    run(async () => {
      if (!next) return;
      try {
        const c = await api.post<Conn>(`/mcp/connections/${conn.id}/package`, { package: next.package, overridePolicy: override, confirmPublisherChange: publisherOk });
        onUpdated(c);
        setNext(null);
        toast('Nieuwe versie geïnstalleerd. Doe opnieuw een leestest.', 'ok');
      } catch (e: any) {
        // 409 "Andere uitgever …": ask for an explicit confirmation and try again.
        if (e?.status === 409 && /Andere uitgever/.test(e.message)) setPublisherMsg(e.message);
        else setError(e.message);
      }
    });
  return (
    <Card className="space-y-2 p-4 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold">Herkomst</span>
        <SigBadge sig={sig} />
        {conn.package?.version && <Badge>v{conn.package.version}</Badge>}
      </div>
      {conn.registry ? (
        <RegistryOrigin conn={conn} onUpdated={onUpdated} />
      ) : conn.package ? (
        <p className="text-muted">
          Geïnstalleerd uit pakket {conn.package.name || ''}
          {conn.package.fingerprint ? ` · vingerafdruk ${conn.package.fingerprint}` : ''}
        </p>
      ) : (
        <p className="text-muted">{sig.state === 'builtin' ? 'Sjabloon uit de ingebouwde TeamBot-catalogus.' : 'Zelf ingestelde koppeling (geen uitgever).'}</p>
      )}
      {conn.package && !next && (
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg border border-line px-3 py-1.5 hover:bg-surface-2">
          <span>{busy ? 'Bezig…' : 'Nieuwe pakketversie installeren…'}</span>
          <input type="file" accept=".zip,application/zip" className="sr-only" onChange={(e) => pick(e.target.files?.[0])} />
        </label>
      )}
      {next && (
        <div className="space-y-2 rounded-lg border border-line p-3">
          <div className="flex flex-wrap items-center gap-2">
            <span>Nieuwe versie {next.version ? `v${next.version}` : ''}</span>
            <SigBadge sig={next.signature} />
          </div>
          {!next.policy.allowed && next.policy.reason && <p className={cx('rounded-lg px-3 py-2', next.policy.blocked ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn')}>{next.policy.reason}</p>}
          {next.policy.needsOverride && (
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={override} onChange={(e) => setOverride(e.target.checked)} />
              <span>Ik sta dit pakket als eigenaar of beheerder toch toe, buiten het uitgeversbeleid (wordt vastgelegd).</span>
            </label>
          )}
          {publisherMsg && (
            <label className="flex items-start gap-2 text-warn">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={publisherOk} onChange={(e) => setPublisherOk(e.target.checked)} />
              <span>{publisherMsg}</span>
            </label>
          )}
          <p className="text-xs text-muted">Na het bijwerken staan acties weer uit tot een nieuwe leestest is gelukt.</p>
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="ghost" onClick={() => (setNext(null), setPublisherMsg(''), setOverride(false), setPublisherOk(false))}>
              Annuleren
            </Button>
            <Button variant="primary" loading={busy} disabled={next.policy.blocked || (next.policy.needsOverride && !override) || (!!publisherMsg && !publisherOk)} onClick={apply}>
              Bijwerken
            </Button>
          </div>
        </div>
      )}
      {error && (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-danger">
          {error}
        </p>
      )}
    </Card>
  );
}
