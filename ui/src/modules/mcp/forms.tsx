import type React from 'react';
import { useEffect, useState } from 'react';
import { ArrowLeft, ArrowRight, Check, Copy, ExternalLink, KeyRound, LogIn, Plus, ShieldAlert, Trash2 } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Badge, Button, Field, Input, Select, Textarea, Toggle, Spinner, toast, toastError, cx, copyText } from '../../components/ui';
import type { CatalogEntry, CatalogField, Conn, KVView, OAuthAppGuide } from './shared';
import { BotPicker as SharedBotPicker } from '../../components/BotPicker';

export interface KVDraft {
  name: string;
  value: string;
  secret: boolean;
  /** Existing secret kept as-is (value not sent). */
  keep?: boolean;
  prefix?: string;
  label?: string;
  help?: string;
  required?: boolean;
  placeholder?: string;
}

export function kvFromView(list: KVView[]): KVDraft[] {
  return list.map((k) => ({ name: k.name, value: k.secret ? '' : k.value || '', secret: k.secret, keep: k.secret }));
}

export function kvFromCatalog(fields: CatalogField[] | undefined): KVDraft[] {
  return (fields || []).map((f) => ({ name: f.name, value: f.default && !f.secret ? f.default : '', secret: !!f.secret, prefix: f.prefix, label: f.label, help: f.help, required: f.required, placeholder: f.placeholder }));
}

/** Payload for the API: secrets without a new value keep the stored one. */
export function kvPayload(list: KVDraft[]) {
  return list
    .filter((k) => k.name.trim() && (k.keep || k.value !== '' || !k.secret))
    .filter((k) => !(k.label && !k.required && !k.value && !k.keep))
    .map((k) => (k.secret ? { name: k.name.trim(), secret: true, ...(k.value ? { value: k.value, prefix: k.prefix } : {}) } : { name: k.name.trim(), value: k.value }));
}

export function KVEditor({ list, onChange, kind, fixed }: { list: KVDraft[]; onChange(l: KVDraft[]): void; kind: 'env' | 'header'; fixed?: boolean }) {
  const set = (i: number, p: Partial<KVDraft>) => onChange(list.map((k, j) => (j === i ? { ...k, ...p } : k)));
  return (
    <div className="space-y-2">
      {list.map((k, i) => (
        <div key={i} className="space-y-1">
          {k.label ? (
            <Field label={`${k.label}${k.required ? ' *' : ''}`} hint={k.help}>
              <Input
                type={k.secret ? 'password' : 'text'}
                autoComplete="off"
                value={k.value}
                placeholder={k.keep ? '•••••• (opgeslagen — laat leeg om te houden)' : k.placeholder}
                onChange={(e) => set(i, { value: e.target.value, keep: k.keep && !e.target.value })}
                aria-label={k.label}
              />
            </Field>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="w-full font-mono text-xs sm:w-44"
                value={k.name}
                disabled={fixed}
                placeholder={kind === 'env' ? 'NAAM' : 'Header-naam'}
                onChange={(e) => set(i, { name: e.target.value })}
                aria-label={kind === 'env' ? 'Naam variabele' : 'Naam header'}
              />
              <Input
                className="min-w-0 flex-1 font-mono text-xs"
                type={k.secret ? 'password' : 'text'}
                autoComplete="off"
                value={k.value}
                placeholder={k.keep ? '•••••• (opgeslagen)' : 'waarde'}
                onChange={(e) => set(i, { value: e.target.value, keep: k.keep && !e.target.value })}
                aria-label="Waarde"
              />
              <Toggle checked={k.secret} onChange={(v) => set(i, { secret: v, keep: false })} label="geheim" />
              {!fixed && (
                <Button size="icon" variant="ghost" onClick={() => onChange(list.filter((_, j) => j !== i))} aria-label="Verwijderen">
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          )}
        </div>
      ))}
      {!fixed && (
        <Button size="sm" variant="ghost" icon={<Plus className="h-4 w-4" />} onClick={() => onChange([...list, { name: '', value: '', secret: true }])}>
          {kind === 'env' ? 'Variabele toevoegen' : 'Header toevoegen'}
        </Button>
      )}
      <div className="text-xs text-muted">Geheime waarden worden versleuteld opgeslagen en nooit meer getoond.</div>
    </div>
  );
}

export interface ConnDraft {
  name: string;
  label: string;
  transport: 'stdio' | 'http' | 'sse';
  command: string;
  args: string;
  extraArgs: string;
  cwd: string;
  env: KVDraft[];
  url: string;
  headers: KVDraft[];
  auth: 'none' | 'headers' | 'oauth';
  allow_private: boolean;
  trust_command: boolean;
  idle_minutes: number;
  timeout_sec: number;
  oauth_client_id: string;
  oauth_client_secret: string;
  /** Reuse the own OAuth client of this other connection (same guide group, e.g. one Google client). */
  oauth_client_from: string;
}

export function draftFromEntry(e: CatalogEntry | null): ConnDraft {
  return {
    name: e && e.id !== 'custom' ? e.name : '',
    label: '',
    transport: e?.id === 'custom' ? 'stdio' : e?.transport || 'stdio',
    command: e?.command || '',
    args: (e?.args || []).join('\n'),
    extraArgs: '',
    cwd: '',
    env: kvFromCatalog(e?.env),
    url: e?.url || '',
    headers: kvFromCatalog(e?.headers),
    auth: e?.id === 'custom' ? 'none' : e?.auth || 'none',
    allow_private: false,
    trust_command: false,
    idle_minutes: 10,
    timeout_sec: 60,
    oauth_client_id: '',
    oauth_client_secret: '',
    oauth_client_from: '',
  };
}

export function draftFromConn(c: Conn): ConnDraft {
  return {
    name: c.name,
    label: c.label,
    transport: c.transport === 'builtin' ? 'http' : c.transport,
    command: c.command,
    args: (c.args || []).join('\n'),
    extraArgs: '',
    cwd: c.cwd,
    env: kvFromView(c.env),
    url: c.url,
    headers: kvFromView(c.headers),
    auth: c.auth,
    allow_private: c.allow_private,
    trust_command: c.trusted,
    idle_minutes: c.idle_minutes,
    timeout_sec: c.timeout_sec,
    oauth_client_id: c.oauth?.client_id || '',
    oauth_client_secret: '',
    oauth_client_from: '',
  };
}

const lines = (s: string) =>
  s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean);

export function draftPayload(d: ConnDraft, entry: CatalogEntry | null, isNew: boolean) {
  const p: any = { name: d.name, label: d.label, idle_minutes: d.idle_minutes, timeout_sec: d.timeout_sec };
  const custom = !entry || entry.id === 'custom';
  p.transport = d.transport;
  if (d.transport === 'stdio') {
    p.command = d.command;
    // No folders for the filesystem server: the server uses the work folders of the chosen bots (least privilege).
    const workDefault = isNew && !custom && entry?.argsPrompt?.defaultWorkFolders && !lines(d.extraArgs).length;
    p.args = workDefault ? undefined : isNew && !custom ? [...(entry?.args || []), ...lines(d.extraArgs)] : lines(d.args);
    p.cwd = d.cwd;
    p.env = kvPayload(d.env);
    if (d.trust_command) p.trust_command = true;
  } else {
    p.url = d.url;
    p.headers = kvPayload(d.headers);
    p.auth = d.auth;
    p.allow_private = d.allow_private;
    if (d.auth === 'oauth' && d.oauth_client_from) p.oauth_client_from = d.oauth_client_from;
    else if (d.auth === 'oauth' && d.oauth_client_id.trim()) {
      p.oauth_client_id = d.oauth_client_id.trim();
      if (d.oauth_client_secret) p.oauth_client_secret = d.oauth_client_secret;
    }
  }
  return p;
}

export function commandLine(d: ConnDraft, entry: CatalogEntry | null, isNew: boolean) {
  const extra = isNew && entry?.argsPrompt?.defaultWorkFolders && !lines(d.extraArgs).length ? ['<werkmap van de gekozen bots>'] : lines(d.extraArgs);
  const args = isNew && entry && entry.id !== 'custom' ? [...(entry.args || []), ...extra] : lines(d.args);
  return [d.command, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ');
}

export interface McpInfo {
  redirectUri: string;
  stdioAllowed: boolean;
  privateNetworkAllowed: boolean;
  platform: string;
  mode: string;
}

export function useInfo() {
  const [info, setInfo] = useState<McpInfo | null>(null);
  useEffect(() => {
    api.get<McpInfo>('/mcp/info').then(setInfo).catch(() => setInfo(null));
  }, []);
  return info;
}

export function CopyField({ value, label }: { value: string; label: string }) {
  return (
    <div className="flex items-center gap-2">
      <Input readOnly value={value} aria-label={label} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
      <Button
        size="icon"
        variant="ghost"
        aria-label={t('{0} kopiëren', t(label))}
        onClick={() => void copyText(value)}
      >
        <Copy className="h-4 w-4" />
      </Button>
    </div>
  );
}

/**
 * Guided setup of an own OAuth client (e.g. Google Cloud): one step at a time with the exact console pages, fields
 * and values from the catalogue, then client ID + secret. Can also reuse the client of another connection in the
 * same group (one Google client for Gmail, Agenda, Drive and Sheets).
 */
export function OwnAppGuide({
  guide,
  redirectUri,
  clientId,
  clientSecret,
  onClientId,
  onClientSecret,
  hasSecret,
  shared,
  sharedFrom,
  onUseShared,
  onSave,
}: {
  guide: OAuthAppGuide;
  redirectUri: string | null;
  clientId: string;
  clientSecret: string;
  onClientId(v: string): void;
  onClientSecret(v: string): void;
  /** A secret is already stored (edit). */
  hasSecret?: boolean;
  shared: { id: string; display: string; client_id: string }[];
  sharedFrom?: string;
  onUseShared(id: string): void;
  /** Shown on the last step (OAuth panel); in the setup form the wizard's own button saves. */
  onSave?(): void;
}) {
  const [i, setI] = useState(0);
  const n = guide.steps.length + 1;
  const last = i === guide.steps.length;
  const step = guide.steps[i];
  const fill = (v: string) => v.replace('{redirectUri}', redirectUri || '(redirect-URL wordt geladen…)');
  const badId = !!clientId.trim() && !!guide.clientIdPattern && !new RegExp(guide.clientIdPattern).test(clientId.trim());
  const reused = shared.find((s) => s.id === sharedFrom);
  return (
    <div className="space-y-3 rounded-lg border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 font-medium">
          <KeyRound className="h-4 w-4 text-accent" aria-hidden /> Eigen OAuth-client bij {guide.vendor}
        </div>
        <span className="text-xs text-muted">
          {t('Stap {0} van {1}', i + 1, n)}
        </span>
      </div>
      {shared.length > 0 && (
        <div className="space-y-2 rounded-lg bg-accent-soft p-3 text-xs">
          <div>Je hebt al een eigen client bij {guide.vendor}. Gebruik die gewoon opnieuw: zet in hetzelfde project alleen de API’s van deze dienst aan en voeg de rechten toe (stap 3 en 4).</div>
          <div className="flex flex-wrap gap-2">
            {shared.map((s) => (
              <Button key={s.id} size="sm" variant={sharedFrom === s.id ? 'primary' : 'secondary'} onClick={() => onUseShared(s.id)}>
                {sharedFrom === s.id ? 'Gekozen: ' : 'Client van '}
                {s.display}
              </Button>
            ))}
          </div>
        </div>
      )}
      {i === 0 && <p className="text-xs text-muted">{guide.intro}</p>}
      <ol className="flex flex-wrap gap-1 text-xs" aria-label="Stappen voor de eigen client">
        {[...guide.steps.map((s) => s.title), 'Gegevens invullen'].map((t, j) => (
          <li key={t}>
            <button type="button" onClick={() => setI(j)} aria-current={j === i ? 'step' : undefined} className={cx('rounded-full px-2 py-0.5', j === i ? 'bg-accent text-accent-fg' : j < i ? 'bg-accent-soft text-accent' : 'bg-surface-2 text-muted')}>
              {j < i && <Check className="me-0.5 inline h-3 w-3" aria-hidden />}
              {j + 1}. {t}
            </button>
          </li>
        ))}
      </ol>
      {!last ? (
        <div className="space-y-2">
          <div className="font-medium">{step.title}</div>
          <ul className="list-disc space-y-1 ps-5 text-xs">
            {step.lines.map((l) => (
              <li key={l}>{l}</li>
            ))}
          </ul>
          {step.copy?.map((c) => (
            <Field key={c.label} label={c.label}>
              <CopyField value={fill(c.value)} label={c.label} />
            </Field>
          ))}
          {step.links?.length ? (
            <div className="flex flex-wrap gap-2">
              {step.links.map((l) => (
                <a key={l.url} href={l.url} target="_blank" rel="noopener noreferrer" className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-line px-3 text-xs font-medium hover:bg-surface-2">
                  <ExternalLink className="h-3.5 w-3.5" aria-hidden /> {l.label}
                </a>
              ))}
            </div>
          ) : null}
        </div>
      ) : reused ? (
        <div className="text-xs">TeamBot gebruikt de client van {reused.display} (client-ID {reused.client_id}); het clientgeheim blijft in de kluis.</div>
      ) : (
        <div className="space-y-3">
          <Field label="Client ID *">
            <Input value={clientId} onChange={(e) => onClientId(e.target.value)} className="font-mono text-xs" autoComplete="off" placeholder={guide.clientIdPlaceholder} />
          </Field>
          {badId && <div className="text-xs text-warn">Dit lijkt geen client-ID van {guide.vendor}; controleer of je de “Client ID” hebt gekopieerd (niet het projectnummer of het geheim).</div>}
          <Field label={`Client secret${guide.secretRequired ? ' *' : ' (optioneel)'}`} hint={guide.secretRequired ? `${guide.vendor} vraagt het geheim altijd. Wordt versleuteld opgeslagen.` : 'Wordt versleuteld opgeslagen.'}>
            <Input type="password" value={clientSecret} onChange={(e) => onClientSecret(e.target.value)} autoComplete="off" placeholder={hasSecret ? '•••••• (opgeslagen — laat leeg om te houden)' : undefined} />
          </Field>
        </div>
      )}
      <div className="flex flex-wrap justify-between gap-2">
        <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} disabled={i === 0} onClick={() => setI(i - 1)}>
          Vorige
        </Button>
        {!last ? (
          <Button size="sm" icon={<ArrowRight className="h-4 w-4" />} onClick={() => setI(i + 1)}>
            {i === guide.steps.length - 1 ? 'Gegevens invullen' : 'Volgende'}
          </Button>
        ) : (
          onSave && (
            <Button size="sm" variant="primary" disabled={!reused && (!clientId.trim() || (guide.secretRequired && !clientSecret && !hasSecret))} onClick={onSave}>
              Opslaan
            </Button>
          )
        )}
      </div>
    </div>
  );
}

/** Own OAuth clients of the user's other connections that can be reused for a template's guide group. */
export function useSharedClients(group: string | undefined, exceptId?: string) {
  const [list, setList] = useState<{ id: string; display: string; client_id: string }[]>([]);
  useEffect(() => {
    if (!group) return;
    api
      .get<Conn[]>('/mcp/connections')
      .then((cs) => setList(cs.filter((c) => c.id !== exceptId && c.catalog?.oauthAppGuide?.group === group && c.oauth?.preregistered && c.oauth.client_id).map((c) => ({ id: c.id, display: c.display, client_id: c.oauth!.client_id! }))))
      .catch(() => setList([]));
  }, [group, exceptId]);
  return list;
}

/**
 * Connection settings form (used by the wizard and the edit dialog). `fold`: only what is needed to connect stays in
 * view (name, address or command, the confirmation of a command, a key the server asks for, the own OAuth app); every
 * other option (label, work folder, variables, local network, time-outs, and `more`) is under "Meer opties".
 */
export function ConnForm({ d, set, entry, isNew, info, fold, more }: { d: ConnDraft; set(p: Partial<ConnDraft>): void; entry: CatalogEntry | null; isNew: boolean; info: McpInfo | null; fold?: boolean; more?: React.ReactNode }) {
  const custom = !entry || entry.id === 'custom';
  const cmdLine = commandLine(d, entry, isNew);
  const guide = isNew && d.auth === 'oauth' ? entry?.oauthAppGuide : undefined;
  const shared = useSharedClients(guide?.group);
  const headersNeeded = d.auth === 'headers' || d.headers.length > 0;
  const optional = (
    <>
      <Field label="Accountlabel" hint="Optioneel, om meerdere accounts van dezelfde dienst uit elkaar te houden (bijv. Werk, Privé).">
        <Input value={d.label} onChange={(e) => set({ label: e.target.value })} placeholder="Werk" maxLength={60} />
      </Field>
      {d.transport === 'stdio' ? (
        <>
          <Field label="Werkmap" hint="Leeg = eigen map van deze koppeling in de TeamBot-datamap.">
            <Input value={d.cwd} onChange={(e) => set({ cwd: e.target.value, trust_command: false })} className="font-mono text-xs" placeholder="(automatisch)" />
          </Field>
          <Field label="Omgevingsvariabelen" hint="Alleen deze variabelen (plus een opgeschoonde basisomgeving zonder sleutels) krijgt het programma.">
            <KVEditor list={d.env} onChange={(env) => set({ env, trust_command: false })} kind="env" />
          </Field>
        </>
      ) : (
        <>
          {custom && !headersNeeded && fold && (
            <Field label="Headers">
              <KVEditor list={d.headers} onChange={(headers) => set({ headers })} kind="header" />
            </Field>
          )}
          {info?.privateNetworkAllowed && <Toggle checked={d.allow_private} onChange={(v) => set({ allow_private: v })} label="Lokaal netwerk toestaan (localhost/LAN)" />}
        </>
      )}
      <details className="text-sm">
        <summary className="cursor-pointer text-muted">Geavanceerd</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <Field label="Stoppen na inactiviteit (minuten)" hint="0 = blijft draaien">
            <Input type="number" min={0} max={1440} value={d.idle_minutes} onChange={(e) => set({ idle_minutes: Number(e.target.value) })} />
          </Field>
          <Field label="Time-out per verzoek (seconden)">
            <Input type="number" min={5} max={600} value={d.timeout_sec} onChange={(e) => set({ timeout_sec: Number(e.target.value) })} />
          </Field>
        </div>
      </details>
      {more}
    </>
  );
  return (
    <div className="space-y-4">
      {custom && (
        <Field label="Naam *" hint="Bijv. de naam van de dienst. Wordt gebruikt in toolnamen (mcp_<naam>_…).">
          <Input value={d.name} onChange={(e) => set({ name: e.target.value })} placeholder="Mijn server" />
        </Field>
      )}
      {custom && (
        <Field label="Soort server">
          <Select value={d.transport} onChange={(e) => set({ transport: e.target.value as any, auth: e.target.value === 'stdio' ? 'none' : d.auth })}>
            <option value="stdio" disabled={info ? !info.stdioAllowed : false}>
              Lokaal programma (stdio){info && !info.stdioAllowed ? ' — alleen beheerders' : ''}
            </option>
            <option value="http">Remote URL (Streamable HTTP)</option>
            <option value="sse">Remote URL (SSE, oud)</option>
          </Select>
        </Field>
      )}

      {d.transport === 'stdio' ? (
        <>
          {custom || !isNew ? (
            <>
              <Field label="Opdracht *" hint="Het programma dat de server start, bijv. npx, uvx, node of een volledig pad.">
                <Input value={d.command} onChange={(e) => set({ command: e.target.value, trust_command: false })} className="font-mono text-xs" placeholder="npx" />
              </Field>
              <Field label="Argumenten" hint="Eén argument per regel.">
                <Textarea rows={3} value={d.args} onChange={(e) => set({ args: e.target.value, trust_command: false })} className="font-mono text-xs" placeholder={'-y\n@scope/server'} />
              </Field>
            </>
          ) : (
            entry?.argsPrompt && (
              <Field label={entry.argsPrompt.label} hint={entry.argsPrompt.help}>
                <Textarea rows={3} value={d.extraArgs} onChange={(e) => set({ extraArgs: e.target.value, trust_command: false })} className="font-mono text-xs" placeholder={info?.platform === 'win32' ? 'C:\\Users\\jij\\Documents\\Project' : '/home/jij/project'} />
              </Field>
            )
          )}
          <div className="space-y-2 rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm">
            <div className="flex items-center gap-2 font-medium text-warn">
              <ShieldAlert className="h-4 w-4" /> Dit programma draait met jouw rechten op deze {info?.mode === 'server' ? 'server' : 'computer'}
            </div>
            <pre className="scroll-thin overflow-x-auto whitespace-pre-wrap break-all rounded bg-surface p-2 font-mono text-xs">{cmdLine || '(nog geen opdracht)'}</pre>
            <Toggle checked={d.trust_command} onChange={(v) => set({ trust_command: v })} label="Ik vertrouw deze opdracht en de bron ervan" />
          </div>
        </>
      ) : (
        <>
          <Field label="URL *" hint={d.transport === 'sse' ? 'Het SSE-eindpunt (meestal …/sse).' : 'Het MCP-eindpunt (meestal …/mcp).'}>
            <Input value={d.url} onChange={(e) => set({ url: e.target.value })} readOnly={isNew && entry?.id === 'registry'} className="font-mono text-xs" placeholder="https://voorbeeld.nl/mcp" inputMode="url" />
          </Field>
          {custom && (
            <Field label="Inloggen">
              <Select value={d.auth} onChange={(e) => set({ auth: e.target.value as any })}>
                <option value="none">Geen</option>
                <option value="headers">Token of sleutel in een header</option>
                <option value="oauth">OAuth (inloggen bij de dienst)</option>
              </Select>
            </Field>
          )}
          {(headersNeeded || (custom && !fold)) && (
            <Field label="Headers">
              <KVEditor list={d.headers} onChange={(headers) => set({ headers })} kind="header" />
            </Field>
          )}
          {guide ? (
            <OwnAppGuide
              guide={guide}
              redirectUri={info?.redirectUri || null}
              clientId={d.oauth_client_id}
              clientSecret={d.oauth_client_secret}
              onClientId={(v) => set({ oauth_client_id: v, oauth_client_from: '' })}
              onClientSecret={(v) => set({ oauth_client_secret: v })}
              shared={shared}
              sharedFrom={d.oauth_client_from}
              onUseShared={(id) => set({ oauth_client_from: d.oauth_client_from === id ? '' : id })}
            />
          ) : d.auth === 'oauth' && (entry?.oauthClient === 'own-app' || custom || !isNew) && (
            <div className="space-y-3 rounded-lg border border-line p-3">
              <div className="text-sm font-medium">Eigen OAuth-app {entry?.oauthClient === 'own-app' ? '(vereist)' : '(optioneel)'}</div>
              <div className="text-xs text-muted">{entry?.oauthAppHelp || 'Alleen nodig als de dienst geen automatische registratie ondersteunt.'}</div>
              {info && (
                <Field label="Redirect-URL voor je OAuth-app">
                  <CopyField value={info.redirectUri} label="Redirect-URL" />
                </Field>
              )}
              <Field label="Client-ID">
                <Input value={d.oauth_client_id} onChange={(e) => set({ oauth_client_id: e.target.value })} className="font-mono text-xs" autoComplete="off" />
              </Field>
              <Field label="Client-secret (optioneel)" hint="Wordt versleuteld opgeslagen.">
                <Input type="password" value={d.oauth_client_secret} onChange={(e) => set({ oauth_client_secret: e.target.value })} autoComplete="off" />
              </Field>
            </div>
          )}
        </>
      )}
      {fold ? (
        <details className="group">
          <summary className="cursor-pointer text-xs font-medium text-muted hover:text-fg">Meer opties</summary>
          <div className="mt-3 space-y-4">{optional}</div>
        </details>
      ) : (
        optional
      )}
    </div>
  );
}

/** Pick the bots that may use a connection (the shared bot picker, with "Alle bots"). */
export function BotPicker({ value, onChange, label }: { value: string[]; onChange(ids: string[]): void; label?: React.ReactNode }) {
  return <SharedBotPicker value={value} onChange={onChange} label={label} empty="Je hebt nog geen bots. Je kunt de app later per bot aanzetten." badge={(a) => (a.access_mode === 'chat' ? <Badge>alleen chat</Badge> : null)} />;
}

/**
 * Opens an empty window synchronously (inside the click), so the browser does not block it as a popup. Returns null
 * in the desktop app (it opens links in the system browser) or when the browser blocked it anyway.
 */
export function openLoginWindow(): Window | null {
  if ((window as any).teambotDesktop) return null;
  try {
    const w = window.open('', '_blank');
    if (!w) return null;
    // The login page must not be able to reach TeamBot through window.opener.
    w.opener = null;
    try {
      w.document.title = 'Inloggen…';
      const p = w.document.createElement('p');
      p.textContent = 'Inlogpagina openen…';
      p.style.cssText = 'font: 15px system-ui, sans-serif; color: #5d5c69; padding: 24px';
      w.document.body.appendChild(p);
    } catch {
      /* cross-origin already: fine */
    }
    return w;
  } catch {
    return null;
  }
}

interface Prep {
  authRequired: boolean;
  authorizationServer: string;
  resourceHost: string;
  scopes: { name: string; description: string; required: boolean; default: boolean }[];
  registration: 'dynamic' | 'preregistered' | 'missing';
  canRevoke: boolean;
  pkce: boolean;
  redirectUri: string;
}

/** OAuth: discovery → show scopes → open login → wait for the callback event. */
export function OAuthPanel({ conn, onDone }: { conn: Conn; onDone(ok: boolean): void }) {
  const [prep, setPrep] = useState<Prep | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [scopes, setScopes] = useState<string[]>([]);
  const [url, setUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [waiting, setWaiting] = useState(false);
  const [clientId, setClientId] = useState(conn.oauth?.client_id || '');
  const [clientSecret, setClientSecret] = useState('');

  const prepare = () => {
    setErr(null);
    setPrep(null);
    api
      .post<Prep>(`/mcp/connections/${conn.id}/oauth/prepare`)
      .then((p) => {
        setPrep(p);
        setScopes(p.scopes.filter((s) => s.default || s.required).map((s) => s.name));
      })
      .catch((e) => setErr(e.message));
  };
  useEffect(prepare, [conn.id]);
  useEffect(
    () =>
      on('mcp.oauth', (d: any) => {
        if (d?.id !== conn.id) return;
        setWaiting(false);
        if (d.ok) {
          toast('Ingelogd', 'ok');
          onDone(true);
        } else setErr(d.error || 'Inloggen mislukt');
      }),
    [conn.id],
  );

  /**
   * One click: the login window opens in the click itself (so popup blockers allow it) and is pointed at the login
   * page as soon as TeamBot has made the link. The desktop app opens it in the system browser instead.
   */
  const start = async () => {
    setBusy(true);
    setErr(null);
    const w = openLoginWindow();
    try {
      const r = await api.post<{ authorizationUrl: string }>(`/mcp/connections/${conn.id}/oauth/start`, { scopes });
      setUrl(r.authorizationUrl);
      if (w && !w.closed) w.location.href = r.authorizationUrl;
      else window.open(r.authorizationUrl, '_blank', 'noopener');
      setWaiting(true);
    } catch (e: any) {
      w?.close();
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  const [sharedFrom, setSharedFrom] = useState('');
  const saveClient = async () => {
    try {
      await api.patch(`/mcp/connections/${conn.id}`, sharedFrom ? { oauth_client_from: sharedFrom } : { oauth_client_id: clientId, ...(clientSecret ? { oauth_client_secret: clientSecret } : {}) });
      prepare();
    } catch (e) {
      toastError(e);
    }
  };
  const guide = conn.catalog?.oauthAppGuide;

  if (err && !prep)
    return (
      <div className="space-y-3">
        <div className="rounded-lg bg-danger-soft p-3 text-sm text-danger">{err}</div>
        <Button onClick={prepare}>Opnieuw proberen</Button>
      </div>
    );
  if (!prep)
    return (
      <div className="flex items-center gap-2 text-sm text-muted">
        <Spinner /> Gegevens van de dienst ophalen…
      </div>
    );
  return (
    <div className="space-y-4 text-sm">
      <div>
        Je logt in bij <b>{prep.authorizationServer}</b>; daarna praat TeamBot met <b>{prep.resourceHost}</b>. De toegangstoken wordt versleuteld opgeslagen en automatisch vernieuwd.
        {!prep.canRevoke && ' Let op: deze dienst biedt geen automatische intrekking; bij ontkoppelen wist TeamBot de tokens lokaal.'}
      </div>
      {!prep.authRequired && <div className="rounded-lg bg-surface-2 p-3 text-xs text-muted">Deze server lijkt ook zonder inloggen te werken. Inloggen kan wel extra toegang geven.</div>}
      {prep.registration === 'missing' && guide ? (
        <OwnAppGuide
          guide={guide}
          redirectUri={prep.redirectUri}
          clientId={clientId}
          clientSecret={clientSecret}
          onClientId={(v) => (setClientId(v), setSharedFrom(''))}
          onClientSecret={setClientSecret}
          hasSecret={!!conn.oauth?.has_client_secret}
          shared={conn.sharedClients || []}
          sharedFrom={sharedFrom}
          onUseShared={(id) => setSharedFrom(sharedFrom === id ? '' : id)}
          onSave={saveClient}
        />
      ) : prep.registration === 'missing' ? (
        <div className="space-y-3 rounded-lg border border-warn/40 bg-warn-soft p-3">
          <div className="font-medium text-warn">Eigen OAuth-app nodig</div>
          <div className="text-xs">
            {conn.catalog?.oauthAppHelp || 'Deze dienst ondersteunt geen automatische registratie. Maak bij de dienst een OAuth-app aan met de redirect-URL hieronder en vul de client-ID in.'}
          </div>
          <CopyField value={prep.redirectUri} label="Redirect-URL" />
          <Field label="Client-ID">
            <Input value={clientId} onChange={(e) => setClientId(e.target.value)} className="font-mono text-xs" autoComplete="off" />
          </Field>
          <Field label="Client-secret (optioneel)">
            <Input type="password" value={clientSecret} onChange={(e) => setClientSecret(e.target.value)} autoComplete="off" />
          </Field>
          <Button onClick={saveClient} disabled={!clientId.trim()}>
            Opslaan
          </Button>
        </div>
      ) : (
        <>
          <Field label="Rechten (scopes) die je toestaat" hint="Kies zo weinig mogelijk. Verplichte rechten vraagt de server zelf.">
            {prep.scopes.length ? (
              <div className="space-y-1.5">
                {prep.scopes.map((s) => (
                  <label key={s.name} className="flex items-start gap-2">
                    <input type="checkbox" className="mt-1" checked={scopes.includes(s.name)} disabled={s.required} onChange={(e) => setScopes(e.target.checked ? [...scopes, s.name] : scopes.filter((x) => x !== s.name))} />
                    <span>
                      <span className="font-mono text-xs">{s.name}</span>
                      {s.required && <Badge className="ms-1">verplicht</Badge>}
                      {s.description && <span className="block text-xs text-muted">{s.description}</span>}
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="text-xs text-muted">De dienst noemt geen aparte rechten; je krijgt de standaardtoegang die de dienst toont bij het inloggen.</div>
            )}
          </Field>
          {err && <div className="rounded-lg bg-danger-soft p-3 text-danger">{err}</div>}
          {!waiting ? (
            <Button variant="primary" icon={<LogIn className="h-4 w-4" />} loading={busy} onClick={start}>
              Inloggen bij {prep.authorizationServer}
            </Button>
          ) : (
            <div className="space-y-2 rounded-lg bg-surface-2 p-3">
              <div className="flex items-center gap-2 font-medium" role="status">
                <Spinner /> Wachten tot je bent ingelogd…
              </div>
              <div className="text-xs text-muted">
                De inlogpagina van {prep.authorizationServer} is geopend in een nieuw venster. Dit scherm werkt zichzelf bij zodra je klaar bent.
              </div>
              {url && (
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
                  <a href={url} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 font-medium text-fg underline">
                    <ExternalLink className="h-3.5 w-3.5" /> Geen venster gezien? Open de inlogpagina
                  </a>
                  <button type="button" className="text-muted underline hover:text-fg" onClick={start}>
                    Nieuwe link maken
                  </button>
                </div>
              )}
              <div className="text-xs text-muted">De link is 10 minuten geldig en werkt één keer.</div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
