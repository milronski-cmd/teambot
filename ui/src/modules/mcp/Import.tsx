import { useEffect, useMemo, useState } from 'react';
import { CircleAlert, CircleCheck, ClipboardPaste, FileSearch, KeyRound, LogIn, PackageOpen, ShieldAlert, TriangleAlert } from 'lucide-react';
import { api } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { Badge, Button, Modal, Spinner, Textarea, Toggle, cx } from '../../components/ui';
import type { Conn } from './shared';
import { BotPicker, type ConnDraft, type KVDraft } from './forms';

/** A server recognised in pasted text (values included: the owner pasted them). */
export interface ImportedServer {
  id: string;
  name: string;
  source: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  cwd?: string;
  env: { name: string; value: string; secret: boolean; required?: boolean; help?: string; prefix?: string }[];
  url?: string;
  headers: { name: string; value: string; secret: boolean; required?: boolean; help?: string; prefix?: string }[];
  auth: 'none' | 'headers' | 'oauth';
  oauthClientId?: string;
  enabled: boolean;
  warnings: string[];
  existing: { id: string; display: string } | null;
}

/** A server found in a config file on this computer: names only, never secret values. */
interface PreviewServer {
  id: string;
  name: string;
  source: string;
  transport: 'stdio' | 'http' | 'sse';
  command?: string;
  args?: string[];
  url?: string;
  env: { name: string; secret: boolean; missing: boolean }[];
  headers: { name: string; secret: boolean; missing: boolean }[];
  auth: 'none' | 'headers' | 'oauth';
  enabled: boolean;
  warnings: string[];
  existing: { id: string; display: string } | null;
}

interface LocalSource {
  key: string;
  label: string;
  file: string;
  found: boolean;
  error?: string;
  servers: PreviewServer[];
}

interface ApplyResult {
  id: string;
  name: string;
  ok: boolean;
  error?: string;
  connection?: Conn;
  missing?: string[];
  needsLogin?: boolean;
}

/** What the import knows about a server, shown in the wizard instead of the generic "Eigen server" text. */
export interface ImportedInfo {
  source: string;
  warnings: string[];
  existing: { id: string; display: string } | null;
}

const isLocal = (u?: string) => !!u && /^https?:\/\/(localhost|127\.|10\.|192\.168\.|\[::1\])/i.test(u);

/** Wizard draft for one pasted server: blanks (references to the environment, example values) become fields to fill in. */
export function draftFromImported(s: ImportedServer): Partial<ConnDraft> {
  const kvs = (l: ImportedServer['env']): KVDraft[] =>
    l.map((k) => (k.required && !k.value ? { name: k.name, value: '', secret: k.secret, label: k.name, required: true, help: k.help, prefix: k.prefix } : { name: k.name, value: k.value, secret: k.secret }));
  return {
    name: s.name,
    transport: s.transport,
    command: s.command || '',
    args: (s.args || []).join('\n'),
    cwd: s.cwd || '',
    env: kvs(s.env),
    url: s.url || '',
    headers: kvs(s.headers),
    auth: s.auth,
    allow_private: isLocal(s.url),
    oauth_client_id: s.oauthClientId || '',
  };
}

const TRANSPORT: Record<string, string> = { stdio: 'lokaal programma', http: 'remote (HTTP)', sse: 'remote (SSE)' };

function ServerFacts({ s }: { s: { transport: string; command?: string; args?: string[]; url?: string; env: { name: string; secret: boolean }[]; headers: { name: string; secret: boolean }[] } }) {
  const kv = [...s.env, ...s.headers];
  return (
    <>
      <div className="break-all font-mono text-xs text-muted">{s.transport === 'stdio' ? [s.command, ...(s.args || [])].join(' ') : s.url}</div>
      {kv.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1 text-xs">
          {/* secrets first; long lists (some tools pass dozens of settings) stay short */}
          {[...kv]
            .sort((a, b) => Number(b.secret) - Number(a.secret))
            .slice(0, 4)
            .map((k) => (
              <span key={k.name} className="inline-flex min-w-0 items-center gap-1 break-all rounded border border-line px-1.5 py-0.5 font-mono">
                {k.secret && <KeyRound className="h-3 w-3 shrink-0 text-muted" aria-label="geheim" />}
                {k.name}
              </span>
            ))}
          {kv.length > 4 && <span className="px-1 py-0.5 text-muted">+{kv.length - 4} {s.transport === 'stdio' ? 'variabelen' : 'headers'}</span>}
        </div>
      )}
    </>
  );
}

/** Wizard, step "Bekijken": what was recognised. */
export function ImportedFacts({ d, info }: { d: ConnDraft; info: ImportedInfo }) {
  const kv = [...d.env, ...d.headers];
  const blanks = kv.filter((k) => k.required && !k.value);
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-start gap-2 rounded-lg bg-accent-soft p-3">
        <ClipboardPaste className="mt-0.5 h-4 w-4 shrink-0 text-accent" aria-hidden />
        <div>
          Herkend uit <span className="font-medium">{info.source}</span>. Controleer bij <span className="font-medium">Instellen</span> de opdracht en de geheimen; geheimen gaan versleuteld naar de kluis van TeamBot.
        </div>
      </div>
      <dl className="grid gap-x-4 gap-y-2 sm:grid-cols-[9rem_1fr]">
        <dt className="text-muted">Naam</dt>
        <dd>{d.name}</dd>
        <dt className="text-muted">Soort</dt>
        <dd>{TRANSPORT[d.transport]}</dd>
        <dt className="text-muted">{d.transport === 'stdio' ? 'Opdracht' : 'Adres'}</dt>
        <dd className="break-all font-mono text-xs">{d.transport === 'stdio' ? [d.command, ...d.args.split('\n').filter(Boolean)].join(' ') : d.url}</dd>
        {kv.length > 0 && (
          <>
            <dt className="text-muted">{d.transport === 'stdio' ? 'Variabelen' : 'Headers'}</dt>
            <dd className="flex flex-wrap gap-1">
              {kv.map((k) => (
                <Badge key={k.name} tone={k.required && !k.value ? 'warn' : 'neutral'}>
                  {k.name}
                  {k.secret ? ' · geheim' : ''}
                  {k.required && !k.value ? ' · nog invullen' : ''}
                </Badge>
              ))}
            </dd>
          </>
        )}
        {d.transport !== 'stdio' && (
          <>
            <dt className="text-muted">Inloggen</dt>
            <dd>{d.auth === 'oauth' ? 'OAuth: je logt zo meteen in bij de dienst' : d.auth === 'headers' ? 'Met een sleutel in een header' : 'Geen'}</dd>
          </>
        )}
      </dl>
      {blanks.length > 0 && <div className="rounded-lg bg-warn-soft p-3 text-warn">Vul bij Instellen nog in: {blanks.map((k) => k.name).join(', ')}.</div>}
      {info.existing && (
        <div className="rounded-lg bg-warn-soft p-3 text-warn">
          Deze server is al gekoppeld als “{info.existing.display}”. Ga alleen door als je een tweede koppeling wilt (bijv. een ander account).
        </div>
      )}
      {info.warnings.map((w) => (
        <div key={w} className="flex items-start gap-2 text-warn">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {w}
        </div>
      ))}
      <div className="rounded-lg bg-surface-2 p-3 text-xs text-muted">
        Na het koppelen doet TeamBot eerst een leestest. Acties die iets wijzigen of versturen staan pas aan als jij dat kiest.
      </div>
    </div>
  );
}

type Mode = 'paste' | 'local';
type Row = (ImportedServer | PreviewServer) & { _missing: string[]; _secrets: number };

function rowOf(s: ImportedServer | PreviewServer): Row {
  const kv: any[] = [...s.env, ...s.headers];
  return { ...s, _missing: kv.filter((k) => k.missing || (k.required && !k.value)).map((k) => k.name), _secrets: kv.filter((k) => k.secret).length };
}

/** Selectable list of servers with the trust confirmation for local programs. */
function ServerList({ rows, chosen, setChosen, grouped }: { rows: Row[]; chosen: Set<string>; setChosen(s: Set<string>): void; grouped?: boolean }) {
  const toggle = (id: string, on: boolean) => {
    const n = new Set(chosen);
    if (on) n.add(id);
    else n.delete(id);
    setChosen(n);
  };
  return (
    <ul className="space-y-2">
      {rows.map((s) => (
        <li key={s.id}>
          <label className={cx('flex cursor-pointer items-start gap-3 rounded-lg border p-3', chosen.has(s.id) ? 'border-accent bg-accent-soft' : 'border-line')}>
            <input type="checkbox" className="mt-1 h-4 w-4 accent-[var(--color-accent)]" checked={chosen.has(s.id)} onChange={(e) => toggle(s.id, e.target.checked)} aria-label={`${s.name} importeren`} />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{s.name}</span>
                <Badge>{TRANSPORT[s.transport]}</Badge>
                {!grouped && <Badge>{s.source}</Badge>}
                {s._secrets > 0 && <Badge>{s._secrets === 1 ? '1 geheim' : `${s._secrets} geheimen`}</Badge>}
                {s.auth === 'oauth' && <Badge>inloggen nodig</Badge>}
                {!s.enabled && <Badge tone="warn">staat uit</Badge>}
                {s.existing && <Badge tone="ok">al gekoppeld</Badge>}
                {s._missing.length > 0 && <Badge tone="warn">nog invullen: {s._missing.join(', ')}</Badge>}
              </div>
              <div className="mt-1">
                <ServerFacts s={s} />
              </div>
              {s.warnings.filter((w) => !/Staat uit/.test(w)).map((w) => (
                <div key={w} className="mt-1 text-xs text-warn">
                  {w}
                </div>
              ))}
            </div>
          </label>
        </li>
      ))}
    </ul>
  );
}

/**
 * "Importeren": paste a `claude mcp add …` / `codex mcp add …` command or MCP JSON (one server → the normal wizard,
 * pre-filled; several → choose), or take over servers from Claude Code, Claude Desktop, Codex, Cursor, VS Code,
 * Windsurf or Gemini CLI on this computer (read-only; secret values never reach the browser). A signed connector
 * package is the third option. Imported apps start read-only: each one gets the usual read test.
 */
export function ImportDialog({
  onClose,
  onWizard,
  onPackage,
  start = 'paste',
}: {
  onClose(): void;
  onWizard(initial: Partial<ConnDraft>, info: ImportedInfo): void;
  onPackage(): void;
  start?: Mode;
}) {
  const [mode, setMode] = useState<Mode>(start);
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [pasted, setPasted] = useState<ImportedServer[] | null>(null);
  const [local, setLocal] = useState<LocalSource[] | null>(null);
  const [localErr, setLocalErr] = useState('');
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [trust, setTrust] = useState(false);
  const [bots, setBots] = useState<string[]>([]);
  const [results, setResults] = useState<ApplyResult[] | null>(null);
  const [tests, setTests] = useState<Record<string, { state: 'busy' | 'ok' | 'fail'; text: string }>>({});

  useEffect(() => {
    if (mode !== 'local' || local || localErr) return;
    api
      .get<{ sources: LocalSource[] }>('/mcp/import/local')
      .then((r) => {
        setLocal(r.sources);
        // pre-select what is new and switched on
        setChosen(new Set(r.sources.flatMap((s) => s.servers.filter((x) => x.enabled && !x.existing).map((x) => x.id))));
      })
      .catch((e) => setLocalErr(e.message));
  }, [mode]);

  const recognise = async () => {
    setBusy(true);
    setError('');
    setPasted(null);
    try {
      const r = await api.post<{ servers: ImportedServer[] }>('/mcp/import/parse', { text });
      if (r.servers.length === 1) {
        const s = r.servers[0];
        onWizard(draftFromImported(s), { source: s.source, warnings: s.warnings, existing: s.existing });
        return;
      }
      setPasted(r.servers);
      setChosen(new Set(r.servers.filter((s) => s.enabled && !s.existing).map((s) => s.id)));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const rows: Row[] = useMemo(() => (mode === 'paste' ? (pasted || []).map(rowOf) : (local || []).flatMap((s) => s.servers.map(rowOf))), [mode, pasted, local]);
  const picked = rows.filter((r) => chosen.has(r.id));
  const programs = picked.filter((r) => r.transport === 'stdio');

  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post<{ results: ApplyResult[] }>('/mcp/import/apply', { from: mode === 'local' ? 'local' : 'text', text: mode === 'paste' ? text : undefined, ids: picked.map((p) => p.id), trust, agentIds: bots });
      setResults(r.results);
      // the usual read test for every new connection that can run right away
      for (const x of r.results) {
        if (!x.ok || !x.connection || x.needsLogin || x.missing?.length) continue;
        setTests((t) => ({ ...t, [x.id]: { state: 'busy', text: x.connection!.transport === 'stdio' ? 'Programma starten en tools ophalen…' : 'Verbinden en tools ophalen…' } }));
        try {
          const res = await api.post<any>(`/mcp/connections/${x.connection.id}/test`, {});
          setTests((s) => ({ ...s, [x.id]: res.ok ? { state: 'ok', text: t('Leestest geslaagd · {0, plural, one {# tool} other {# tools}} · alleen lezen', res.connection.counts.total) } : { state: 'fail', text: res.error || 'Leestest mislukt' } }));
        } catch (e: any) {
          setTests((s) => ({ ...s, [x.id]: { state: 'fail', text: e.message } }));
        }
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const open = (id: string) => (onClose(), navigate(`/m/mcp/c/${id}`));

  if (results)
    return (
      <Modal open wide onClose={onClose} title="Apps importeren" footer={<Button variant="primary" onClick={onClose}>Klaar</Button>}>
        <div className="space-y-3 text-sm">
          <p className="text-muted">Nieuwe koppelingen staan op alleen lezen. Acties zet je per app aan op de pagina van de koppeling.</p>
          <ul className="space-y-2">
            {results.map((x) => {
              const t = tests[x.id];
              return (
                <li key={x.id} className="flex flex-wrap items-start justify-between gap-2 rounded-lg border border-line p-3">
                  <div className="min-w-0 flex-1">
                    <div className="font-medium">{x.name}</div>
                    {!x.ok ? (
                      <div className="mt-0.5 flex items-start gap-1.5 text-danger">
                        <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> Niet geïmporteerd: {x.error}
                      </div>
                    ) : x.needsLogin ? (
                      <div className="mt-0.5 flex items-center gap-1.5 text-muted">
                        <LogIn className="h-4 w-4" aria-hidden /> Gekoppeld; log nog in bij de dienst.
                      </div>
                    ) : x.missing?.length ? (
                      <div className="mt-0.5 flex items-center gap-1.5 text-warn">
                        <KeyRound className="h-4 w-4" aria-hidden /> Gekoppeld; vul nog in: {x.missing.join(', ')}.
                      </div>
                    ) : t ? (
                      <div className={cx('mt-0.5 flex items-start gap-1.5', t.state === 'ok' ? 'text-ok' : t.state === 'fail' ? 'text-danger' : 'text-muted')} role={t.state === 'fail' ? 'alert' : undefined}>
                        {t.state === 'busy' ? <Spinner /> : t.state === 'ok' ? <CircleCheck className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
                        <span className="break-words">{t.text}</span>
                      </div>
                    ) : (
                      <div className="mt-0.5 text-muted">Gekoppeld.</div>
                    )}
                  </div>
                  {x.connection && (
                    <Button size="sm" variant={x.needsLogin || x.missing?.length ? 'soft' : 'ghost'} onClick={() => open(x.connection!.id)}>
                      {x.needsLogin ? 'Inloggen' : x.missing?.length ? 'Invullen' : 'Openen'}
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </Modal>
    );

  const listShown = (mode === 'paste' && pasted && pasted.length > 1) || (mode === 'local' && local);
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Apps importeren"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          {mode === 'paste' && !(pasted && pasted.length > 1) ? (
            <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={recognise}>
              Herkennen
            </Button>
          ) : listShown ? (
            <Button variant="primary" loading={busy} disabled={!picked.length || (programs.length > 0 && !trust)} onClick={apply}>
              {picked.length === 1 ? '1 app importeren' : `${picked.length} apps importeren`}
            </Button>
          ) : null}
        </>
      }
    >
      <div className="space-y-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap gap-1 rounded-lg bg-surface-2 p-1 text-sm" role="tablist" aria-label="Hoe wil je importeren?">
          {(
            [
              ['paste', 'Plakken', ClipboardPaste],
              ['local', 'Van deze computer', FileSearch],
            ] as const
          ).map(([id, label, Icon]) => (
            <button
              key={id}
              role="tab"
              aria-selected={mode === id}
              className={cx('inline-flex items-center gap-1.5 rounded-md px-3 py-1.5', mode === id ? 'bg-surface font-medium shadow-sm' : 'text-muted hover:text-fg')}
              onClick={() => (setMode(id), setChosen(new Set()), setError(''))}
            >
              <Icon className="h-4 w-4" aria-hidden /> {label}
            </button>
          ))}
        </div>
          <Button size="sm" variant="ghost" icon={<PackageOpen className="h-4 w-4" />} onClick={onPackage}>
            Pakketbestand…
          </Button>
        </div>

        {mode === 'paste' && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              Plak een installatieopdracht of een stukje config uit Claude Code, Codex, Cursor, VS Code of Claude Desktop. TeamBot herkent de server en vult de koppeling voor je in; sleutels gaan versleuteld naar de kluis.
            </p>
            <Textarea
              rows={7}
              value={text}
              onChange={(e) => (setText(e.target.value), setPasted(null), setError(''))}
              className="font-mono text-xs"
              aria-label="Opdracht of config om te importeren"
              placeholder={'claude mcp add --transport http notion https://mcp.notion.com/mcp\n\nof\n\n{\n  "mcpServers": {\n    "github": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-github"] }\n  }\n}'}
              spellCheck={false}
            />
            <div className="text-xs text-muted">
              Herkent: <code>claude mcp add</code>, <code>claude mcp add-json</code>, <code>codex mcp add</code>, <code>gemini mcp add</code>, <code>code --add-mcp</code>, MCP-JSON (<code>mcpServers</code>, <code>servers</code>) en Codex-TOML (<code>[mcp_servers.…]</code>).
            </div>
            {error && (
              <div role="alert" className="flex items-start gap-2 rounded-lg bg-danger-soft p-3 text-sm text-danger">
                <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> {error}
              </div>
            )}
            {pasted && pasted.length > 1 && (
              <>
                <div className="text-sm font-medium">{t('{0, plural, one {# server herkend.} other {# servers herkend.}} Kies welke je wilt koppelen:', pasted.length)}</div>
                <ServerList rows={rows} chosen={chosen} setChosen={setChosen} grouped />
              </>
            )}
          </div>
        )}

        {mode === 'local' && (
          <div className="space-y-3">
            <p className="text-sm text-muted">
              TeamBot zoekt apps in de instellingen van andere programma’s op deze computer. Er wordt niets veranderd.
            </p>
            {localErr ? (
              <div role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">
                {localErr}
              </div>
            ) : !local ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Spinner /> Config-bestanden doorzoeken…
              </div>
            ) : (
              <>
                {local
                  .filter((s) => s.found && (s.servers.length || s.error))
                  .map((s) => (
                    <section key={s.key} className="space-y-2" aria-label={s.label}>
                      <h3 className="text-sm font-semibold">
                        {s.label} <span className="break-all font-mono text-xs font-normal text-muted">{s.file}</span>
                      </h3>
                      {s.error ? (
                        <div className="rounded-lg bg-warn-soft p-2 text-xs text-warn">{s.error}</div>
                      ) : (
                        <ServerList rows={s.servers.map(rowOf)} chosen={chosen} setChosen={setChosen} grouped />
                      )}
                    </section>
                  ))}
                {!local.some((s) => s.servers.length) && <div className="rounded-lg bg-surface-2 p-3 text-sm text-muted">Geen MCP-servers gevonden in de config-bestanden op deze computer.</div>}
                {local.some((s) => s.found && !s.servers.length && !s.error) && (
                  <div className="text-xs text-muted">
                    Gevonden zonder servers: {local.filter((s) => s.found && !s.servers.length && !s.error).map((s) => s.label).join(', ')}.
                  </div>
                )}
                <div className="text-xs text-muted">Niet gevonden: {local.filter((s) => !s.found).map((s) => s.label).join(', ') || '—'}.</div>
                {error && (
                  <div role="alert" className="rounded-lg bg-danger-soft p-3 text-sm text-danger">
                    {error}
                  </div>
                )}
              </>
            )}
          </div>
        )}

        {listShown && picked.length > 0 && (
          <div className="space-y-3 border-t border-line pt-3">
            {programs.length > 0 && (
              <div className="space-y-2 rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm">
                <div className="flex items-center gap-2 font-medium text-warn">
                  <ShieldAlert className="h-4 w-4" aria-hidden /> {programs.length === 1 ? 'Dit programma draait' : 'Deze programma’s draaien'} met jouw rechten op deze computer
                </div>
                <ul className="space-y-1">
                  {programs.map((p) => (
                    <li key={p.id} className="break-all font-mono text-xs">
                      {[p.command, ...(p.args || [])].join(' ')}
                    </li>
                  ))}
                </ul>
                <Toggle checked={trust} onChange={setTrust} label="Ik vertrouw deze opdrachten en hun bron" />
              </div>
            )}
            <details>
              <summary className="cursor-pointer text-sm text-muted">Meteen aanzetten voor bots (optioneel)</summary>
              <div className="mt-2">
                <BotPicker value={bots} onChange={setBots} />
              </div>
            </details>
          </div>
        )}
      </div>
    </Modal>
  );
}

