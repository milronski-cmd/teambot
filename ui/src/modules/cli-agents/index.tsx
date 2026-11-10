import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, ChevronDown, Copy, Download, ExternalLink, KeyRound, LogIn, Plug, RefreshCw, RotateCcw, Terminal, Trash2, Wallet, XCircle } from 'lucide-react';
import type { UIModule } from '../types';
import type { Agent, ProviderTestResult } from '../../lib/types';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { t, uiLocale } from '../../lib/i18n';
import { prettyModel } from '../../lib/modelLabel';
import { askConfirm, Button, Card, EmptyState, Field, Input, Spinner, Textarea, Toggle, cx, timeAgo, toast, useAsync } from '../../components/ui';
import { ConnectCard, ConnectResult, type ConnectState } from '../../components/ConnectCard';
import { MoreInfo } from '../../components/MoreInfo';
import { FreeStartButton, JobProgress, LocalModelHint, OwnCopy, freeStart, useRuntimeJob, type DeviceLoginView, type RuntimeView } from './runtime';
import { LoginBox, startLogin } from './login';
import { EngineVersionsCard } from './versions';
import { useAdvanced } from '../../shell/advanced';

// ---------------------------------------------------------------- types (mirror of /api/cli-agents/status)

interface CliItem {
  unsafe?: { at: string; kind: string; title: string };
  id: string;
  label: string;
  engine: 'claude' | 'codex' | 'acp' | 'unsupported';
  installed: boolean;
  path?: string;
  pathSource?: 'provider' | 'instelling' | 'teambot' | 'gevonden' | 'andere-app';
  pathApp?: string;
  managed?: boolean;
  deviceLogin?: boolean;
  /** The login page gives a code to paste back into TeamBot (Claude Code). */
  pasteLogin?: boolean;
  loginCommand?: string;
  runtime?: RuntimeView | null;
  loginState?: DeviceLoginView | null;
  version?: string;
  loggedIn?: boolean;
  authMethod?: string;
  billing: 'subscription' | 'api' | 'unknown';
  billingPath: string;
  detail: string;
  description: string;
  billingNote: string;
  authNote?: string;
  docsUrl: string;
  login: string;
  install: { label: string; cmd: string; note?: boolean }[];
  canInstall?: boolean;
  unsupported?: string;
  experimental?: boolean;
  custom: boolean;
}

interface StatusResponse {
  canUse: boolean;
  reason?: string;
  items: CliItem[];
  providers?: { id: string; kind: string; name: string; enabled: boolean; config: Record<string, any> }[];
  custom?: CliItem;
  platform?: string;
  mode?: 'desktop' | 'server';
  /** A local model (Ollama, LM Studio) is connected or runs on this computer. */
  localModel?: boolean;
}

const KIND_ENGINE: Record<string, 'claude' | 'codex' | 'acp'> = { 'claude-code': 'claude', 'codex-cli': 'codex' };
const engineOf = (kind: string) => KIND_ENGINE[kind] || 'acp';

/** Extra flags TeamBot accepts per CLI (mirrors server/modules/cli-agents/catalog.ts). */
const EXTRA_ARGS: Record<string, string[]> = {
  'claude-code': ['--fallback-model <model>', '--max-budget-usd <usd>', '--agent <agent>', '--autocompact <auto|tokens>', '--exclude-dynamic-system-prompt-sections'],
  'codex-cli': ['--oss', '--local-provider <lmstudio|ollama>', '--profile <naam>'],
  'gemini-cli': ['--sandbox'],
  'copilot-cli': ['--effort <low|medium|high|xhigh>'],
};

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Gekopieerd', 'ok');
  } catch {
    toast('Kopiëren lukte niet — selecteer de tekst handmatig', 'danger');
  }
}

function Cmd({ cmd, label }: { cmd: string; label?: string }) {
  return (
    <div className="min-w-0">
      {label && <div className="mb-0.5 text-xs text-muted">{label}</div>}
      <div className="flex items-start gap-1.5">
        <code className="min-w-0 flex-1 break-all rounded-md bg-surface-2 px-2 py-1.5 font-mono text-xs">{cmd}</code>
        <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label={`Kopieer: ${cmd}`} onClick={() => copy(cmd)}>
          <Copy className="h-3.5 w-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** Which copy of the CLI TeamBot runs, in words (C-07: never silently another app's copy). */
function sourceText(it: CliItem): string {
  switch (it.pathSource) {
    case 'teambot':
      return 'door TeamBot geïnstalleerd';
    case 'instelling':
      return 'zelf ingesteld';
    case 'provider':
      return 'via provider';
    case 'andere-app':
      return `uit een andere app: ${it.pathApp || 'onbekend'}`;
    default:
      return 'systeeminstallatie';
  }
}

/** The one short line of a card. */
const LINE: Record<string, string> = {
  'claude-code': 'Je Claude-abonnement (Pro of Max), via het officiële Claude Code.',
  'codex-cli': 'Je ChatGPT-abonnement, via het officiële Codex van OpenAI.',
  opencode: 'Gratis modellen zonder account, via OpenCode.',
};
const firstSentence = (s: string) => (s.match(/^.*?[.!?](?=\s|$)/)?.[0] || s).trim();

/**
 * One program (Claude Code, Codex, OpenCode …) on the shared connect card: one line and ONE button that does the next
 * step and goes on to the end by itself. Not on this pc → TeamBot installs its own checked copy, then the login starts;
 * not logged in → the login; logged in → connect and test ("Verbinding werkt"). Everything else is under "Meer opties".
 */
function CliCard({ it, provider, desktop, onChanged }: { it: CliItem; provider?: { id: string; name: string }; desktop: boolean; onChanged(): void }) {
  const [editPath, setEditPath] = useState(false);
  const [p, setP] = useState(it.pathSource === 'instelling' ? it.path || '' : '');
  const [login, setLogin] = useState<DeviceLoginView | null>(it.loginState || null);
  const [terminal, setTerminal] = useState(false);
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [chain, setChain] = useState(false);
  const job = useRuntimeJob(it.id, it.runtime?.job);
  const save = useAsync();
  const act = useAsync();
  const installing = !!job && !['done', 'error'].includes(job.phase);
  const waiting = !!login && (login.state === 'starting' || login.state === 'waiting');

  const savePath = (value: string | null) =>
    save.run(async () => {
      await api.put(`/cli-agents/paths/${it.id}`, { path: value });
      setEditPath(false);
      onChanged();
    }, value ? 'Pad opgeslagen' : 'Standaardpad hersteld');
  const doConnect = async () => {
    const r = await api.post<{ created: boolean; test?: ProviderTestResult }>(`/cli-agents/${it.id}/connect`, {});
    setResult(r.test || { ok: true, detail: '' });
    await useApp.getState().refreshProviders();
    onChanged();
  };
  const beginLogin = async () => {
    setResult(null);
    const r = await startLogin(it.id);
    if (r.mode === 'device' && r.login) setLogin(r.login);
    else setTerminal(true);
  };
  /** After an install or a login: look again and do what is still needed. */
  const advance = async () => {
    const s = await api.get<StatusResponse>('/cli-agents/status?fresh=1');
    const cur = s.items.find((x) => x.id === it.id);
    onChanged();
    if (!cur?.installed) return;
    if (cur.loggedIn === false) return beginLogin();
    return doConnect();
  };
  const fail = (e: any) => setResult({ ok: false, detail: e?.message || String(e) });
  const run = (fn: () => Promise<unknown>) => act.run(() => fn().catch(fail));
  const test = () =>
    run(async () => {
      setResult(await api.post<ProviderTestResult>(`/providers/${provider!.id}/test`));
    });
  const install = () =>
    run(async () => {
      setResult(null);
      if (it.id === 'opencode') {
        // The same one-click path as "Gratis starten": own checked copy, then connected on a free model.
        await freeStart();
        await useApp.getState().refreshProviders();
        setResult({ ok: true, detail: '' });
        return onChanged();
      }
      setChain(true);
      await api.post(`/cli-agents/runtimes/${it.id}/install`, { version: 'pinned' });
    });

  useEffect(
    () =>
      on('cli.login', (e: any) => {
        if (e?.id !== it.id) return;
        setLogin(e);
        if (e.state === 'done') void run(doConnect);
        else if (e.state === 'error') setResult({ ok: false, detail: e.error || 'Inloggen lukte niet.', hint: 'Probeer het opnieuw met “Inloggen”.' });
      }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [it.id],
  );
  useEffect(() => {
    if (!chain || !job) return;
    if (job.phase === 'done') {
      setChain(false);
      void run(advance);
    } else if (job.phase === 'error') {
      setChain(false);
      setResult({ ok: false, detail: job.error || 'Installeren lukte niet.', hint: 'Controleer je internetverbinding en probeer het opnieuw.' });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.phase, chain]);

  const canOwnCopy = !!it.runtime?.supported;
  const loggedOut = it.installed && it.loggedIn === false;
  let state: ConnectState = 'off';
  let stateLabel: string | undefined;
  let action: React.ReactNode = null;
  if (it.unsupported) stateLabel = 'niet ondersteund';
  else if (installing || act.busy) {
    state = 'busy';
    stateLabel = installing ? 'installeren' : undefined;
  } else if (waiting) {
    state = 'busy';
    stateLabel = 'wacht op inloggen';
  } else if (provider && !loggedOut && result?.ok !== false) {
    state = 'on';
    action = (
      <Button size="sm" onClick={test}>
        Test
      </Button>
    );
  } else if (!it.installed) {
    stateLabel = undefined;
    if (canOwnCopy)
      action = (
        <Button size="sm" variant="primary" icon={<Download className="h-4 w-4" />} onClick={install}>
          {it.id === 'opencode' ? 'Installeren en koppelen' : 'Installeren en inloggen'}
        </Button>
      );
  } else if (loggedOut) {
    if (provider) state = 'error';
    stateLabel = 'niet ingelogd';
    action = (
      <Button size="sm" variant="primary" icon={<LogIn className="h-4 w-4" />} onClick={() => run(beginLogin)}>
        Inloggen
      </Button>
    );
  } else if (provider) {
    state = 'error';
    action = (
      <Button size="sm" variant="primary" onClick={test}>
        Opnieuw testen
      </Button>
    );
  } else {
    stateLabel = 'staat op deze pc';
    action = (
      <Button size="sm" variant="primary" icon={<Plug className="h-4 w-4" />} onClick={() => run(doConnect)}>
        Koppelen
      </Button>
    );
  }
  const line = it.unsupported || LINE[it.id] || firstSentence(it.description);
  const billed = it.installed && it.billingPath && it.billingPath !== 'Onbekend' ? `${it.billingPath}${it.billing === 'api' ? ' — kosten tellen mee voor je daglimiet' : ''}` : '';

  return (
    <ConnectCard
      icon={<Terminal aria-hidden />}
      title={it.label}
      line={line}
      state={state}
      stateLabel={stateLabel}
      action={action}
      data-testid={`cli-${it.id}`}
      result={
        result &&
        !waiting &&
        (result.ok ? (
          <ConnectResult ok next={billed ? `Loopt via: ${billed}. Kies het bij een bot.` : 'Kies het bij een bot.'} />
        ) : (
          <ConnectResult ok={false} next={result.hint || (loggedOut || /ingelogd/i.test(result.detail) ? 'Klik op “Inloggen”.' : undefined)}>
            {result.detail}
          </ConnectResult>
        ))
      }
      more={
        !it.unsupported && (
          <>
            <div className="space-y-2 rounded-lg bg-surface-2 px-3 py-2 text-xs">
              <div className="flex items-start gap-2">
                <Wallet className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <div>
                  <div>{it.billingNote}</div>
                  {billed && <div className="mt-1 font-medium">Actief pad: {billed}</div>}
                </div>
              </div>
              {it.authNote && (
                <div className="flex items-start gap-2">
                  <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                  <div>{it.authNote}</div>
                </div>
              )}
            </div>
            <p className="text-xs text-muted">{it.description}</p>
            {it.experimental && <p className="text-xs text-muted">Niet live getest met het echte programma.</p>}
            {it.runtime && <OwnCopy rt={it.runtime} inUse={it.pathSource === 'teambot'} onChanged={onChanged} />}
            {!it.installed &&
              it.install.length > 0 &&
              (
                <div className="space-y-2">
                  <div className="flex items-center gap-1.5 text-sm font-medium">
                    <Download className="h-4 w-4" aria-hidden /> Zelf installeren (officiële opdracht)
                  </div>
                  {it.install.map((l) =>
                    l.note ? (
                      <p key={l.label + l.cmd} className="text-xs">
                        {l.cmd}
                      </p>
                    ) : (
                      <Cmd key={l.label + l.cmd} label={l.label} cmd={l.cmd} />
                    ),
                  )}
                  <p className="text-xs text-muted">Draai dit zelf in een terminal en klik daarna op “Opnieuw zoeken”.</p>
                  {it.canInstall && (
                    <Button
                      size="sm"
                      variant="secondary"
                      loading={save.busy}
                      onClick={async () =>
                        (await askConfirm(`TeamBot installeert ${it.label}. Daarna log je zelf in. Doorgaan?`)) &&
                        save.run(async () => (await api.post(`/cli-agents/${it.id}/install`, { confirm: true }), onChanged()), `${it.label} geïnstalleerd`)
                      }
                    >
                      Voor mij installeren (npm)
                    </Button>
                  )}
                </div>
              )}
            {it.installed && it.path && (
              <div className="text-xs text-muted">
                Programma: <span className="break-all font-mono">{it.path}</span> ({sourceText(it)})
              </div>
            )}
            {editPath && (
              <div className="space-y-2">
                <Field label="Volledig pad naar het programma" hint={it.id === 'claude-code' ? 'Bijv. C:\\Users\\naam\\.local\\bin\\claude.exe' : 'Bijv. C:\\Users\\naam\\AppData\\Roaming\\npm\\' + (it.id.split('-')[0] || 'cli') + '.cmd'}>
                  <Input value={p} onChange={(e) => setP(e.target.value)} placeholder="Volledig pad" aria-label={`Pad naar ${it.label}`} />
                </Field>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="primary" loading={save.busy} disabled={!p.trim()} onClick={() => savePath(p.trim())}>
                    Opslaan
                  </Button>
                  {it.pathSource === 'instelling' && (
                    <Button size="sm" onClick={() => savePath(null)} disabled={save.busy}>
                      Automatisch zoeken
                    </Button>
                  )}
                  <Button size="sm" variant="ghost" onClick={() => setEditPath(false)}>
                    Annuleren
                  </Button>
                </div>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {!editPath && (
                <Button size="sm" onClick={() => setEditPath(true)}>
                  Pad instellen
                </Button>
              )}
              {it.installed && it.loggedIn !== false && !provider && it.managed && (
                <Button size="sm" variant="ghost" onClick={() => run(beginLogin)}>
                  Met een ander account inloggen
                </Button>
              )}
              <a className="inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm text-accent hover:underline" href={it.docsUrl} target="_blank" rel="noreferrer">
                Documentatie <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </div>
          </>
        )
      }
    >
      {(installing || waiting || terminal || it.unsafe || it.pathSource === 'andere-app') && (
        <div className="space-y-3">
          {installing && job && <JobProgress job={job} label={it.label} />}
          {(waiting || terminal) && <LoginBox id={it.id} label={it.label} command={it.loginCommand || it.login} desktop={desktop} login={login} setLogin={setLogin} terminal={terminal} />}
          {it.pathSource === 'andere-app' && (
            <p className="flex items-start gap-1.5 text-xs text-warn" role="note">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
              <span>
                TeamBot gebruikt nu de kopie uit {it.pathApp || 'een andere app'}. Die app kan hem bijwerken of verwijderen.{it.runtime ? ' Onder Meer opties installeer je een eigen kopie.' : ''}
              </span>
            </p>
          )}
          {it.unsafe && (
            <div className="space-y-2 rounded-lg border border-danger bg-danger-soft p-3 text-sm text-danger" role="alert">
              <div>
                <b>Geblokkeerd voor "vraagt toestemming" en "alleen lezen".</b> {it.label} voerde op {new Date(it.unsafe.at).toLocaleString(uiLocale())} een actie uit zonder
                TeamBot om toestemming te vragen ({it.unsafe.kind}: <span translate="no">{it.unsafe.title}</span>). Controleer de instellingen van de CLI
                (bijv. automatische goedkeuring uitzetten) voordat je hem opnieuw toestaat. Bots op "automatisch" werken gewoon.
              </div>
              <Button size="sm" variant="secondary" onClick={() => save.run(async () => (await api.put(`/cli-agents/safety/${it.id}`, {}), onChanged()), 'Opnieuw toegestaan')}>
                Gecontroleerd, opnieuw toestaan
              </Button>
            </div>
          )}
        </div>
      )}
    </ConnectCard>
  );
}

function CustomAcp({ data, onChanged }: { data: StatusResponse; onChanged(): void }) {
  const [f, setF] = useState({ name: '', command: '', args: '', authMethod: '' });
  const add = useAsync();
  const del = useAsync();
  const list = (data.providers || []).filter((p) => p.kind === 'acp-custom');
  const submit = () =>
    add.run(async () => {
      if (!f.command.trim()) throw new Error('Vul het programma in');
      await api.post('/providers', {
        kind: 'acp-custom',
        name: f.name.trim() || 'Eigen ACP-agent',
        config: { command: f.command.trim(), args: f.args.trim(), authMethod: f.authMethod.trim() || undefined },
      });
      setF({ name: '', command: '', args: '', authMethod: '' });
      await useApp.getState().refreshProviders();
      onChanged();
    }, 'ACP-agent toegevoegd');
  const remove = async (id: string, name: string) => {
    if (!(await askConfirm(`"${name}" verwijderen? Bots die deze provider gebruiken hebben daarna geen provider meer.`, { ok: 'Verwijderen', danger: true }))) return;
    del.run(async () => {
      await api.del(`/providers/${id}`);
      await useApp.getState().refreshProviders();
      onChanged();
    }, 'Verwijderd');
  };
  return (
    <Card className="p-4">
      <div className="flex items-center gap-2">
        <Terminal className="h-4 w-4 text-muted" aria-hidden />
        <h3 className="font-semibold">Eigen ACP-agent</h3>
      </div>
      <p className="mt-1.5 text-sm text-muted">
        Elke agent die het Agent Client Protocol (ACP) over stdio spreekt, bijvoorbeeld een eigen runner. TeamBot opent een sessie in de werkmap van de bot, stuurt toestemmingsverzoeken naar jou en geeft alleen bestanden binnen de werkmap vrij.
      </p>
      {list.length > 0 && (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
          {list.map((p) => (
            <li key={p.id} className="flex items-center justify-between gap-2 px-3 py-2 text-sm">
              <div className="min-w-0">
                <div className="font-medium">{p.name}</div>
                <div className="break-all font-mono text-xs text-muted">
                  {p.config?.command} {(p.config?.args || []).join(' ')}
                </div>
              </div>
              <Button size="icon" variant="ghost" aria-label={`${p.name} verwijderen`} onClick={() => remove(p.id, p.name)} disabled={del.busy}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <Field label="Naam">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Mijn ACP-agent" />
        </Field>
        <Field label="Programma" hint="Volledig pad of naam in PATH">
          <Input value={f.command} onChange={(e) => setF({ ...f, command: e.target.value })} placeholder={'C:\\tools\\mijn-agent.exe'} />
        </Field>
        <Field label="Argumenten" hint="Gescheiden door spaties, bijv. --acp">
          <Input value={f.args} onChange={(e) => setF({ ...f, args: e.target.value })} placeholder="--acp" />
        </Field>
        <Field label="Inlogmethode (optioneel)" hint="Alleen als de agent een bestaande login via ACP-authenticate wil gebruiken">
          <Input value={f.authMethod} onChange={(e) => setF({ ...f, authMethod: e.target.value })} placeholder="bijv. cached_token" />
        </Field>
      </div>
      <div className="mt-3">
        <Button size="sm" variant="primary" loading={add.busy} onClick={submit}>
          Toevoegen
        </Button>
      </div>
    </Card>
  );
}

function CliSettings() {
  const appProviders = useApp((s) => s.providers);
  const advanced = useAdvanced();
  const [data, setData] = useState<StatusResponse | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const load = useCallback((fresh = false) => {
    setBusy(true);
    setErr('');
    api
      .get<StatusResponse>(`/cli-agents/status${fresh ? '?fresh=1' : ''}`)
      .then(setData)
      .catch((e) => setErr(e.message || String(e)))
      .finally(() => setBusy(false));
  }, []);
  useEffect(() => load(false), [load]);
  // Update notices for TeamBot's own copies: the newest versions come from the registry (cached on the server).
  const [latest, setLatest] = useState<Record<string, RuntimeView>>({});
  useEffect(() => {
    api
      .get<{ items: (RuntimeView | null)[] }>('/cli-agents/runtimes')
      .then((r) => setLatest(Object.fromEntries(r.items.filter((x): x is RuntimeView => !!x).map((x) => [x.id, x]))))
      .catch(() => {});
  }, [data?.items.map((i) => i.runtime?.installed?.version || '').join()]);
  if (!data && !err) {
    return (
      <div className="flex items-center gap-2 py-8 text-sm text-muted">
        <Spinner /> Even kijken welke programma's op deze computer staan…
      </div>
    );
  }
  if (err && !data) return <EmptyState icon={<XCircle className="h-8 w-8" />} title="Status ophalen mislukt" action={<Button onClick={() => load(true)}>Opnieuw proberen</Button>}>{err}</EmptyState>;
  if (!data!.canUse) return <EmptyState icon={<KeyRound className="h-8 w-8" />} title="Abonnementen zijn alleen voor de eigenaar">{data!.reason}</EmptyState>;
  const provFor = (id: string) => data!.providers?.find((p) => p.kind === id);
  // Connected, or running here ("Gratis starten" then connects it as reserve itself): no "Ollama instellen" hint.
  const hasLocal = appProviders.some((p) => p.enabled && p.billing === 'local') || !!data!.localModel;
  const supported = data!.items.filter((i) => !i.unsupported);
  const found = supported.filter((i) => i.installed);
  const sorted = [...data!.items].sort((a, b) => Number(b.installed) - Number(a.installed) || Number(!!b.runtime) - Number(!!a.runtime) || Number(!!a.unsupported) - Number(!!b.unsupported));
  // In view: what is on this pc, connected, or what TeamBot can set up itself (Claude Code, Codex, OpenCode).
  const inView = (it: CliItem) => it.installed || !!it.runtime || !!provFor(it.id);
  const main = sorted.filter(inView);
  const others = sorted.filter((it) => !inView(it));
  const card = (it: CliItem) => (
    <CliCard key={it.id} it={latest[it.id] && it.runtime ? { ...it, runtime: { ...it.runtime, latest: latest[it.id].latest, updateAvailable: latest[it.id].updateAvailable, updateKind: latest[it.id].updateKind } } : it} provider={provFor(it.id)} desktop={data!.mode === 'desktop'} onChanged={() => load(true)} />
  );
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="min-w-0 flex-1 basis-72 text-sm text-muted">
          Log in met je abonnement; je login blijft bij de maker.{' '}
          <MoreInfo>
            TeamBot start het officiële programma van de maker op deze computer, in de map van de bot, en vraagt jou om toestemming voor wat de bot wil wijzigen — ook op je telefoon. Claude Code, Codex en OpenCode zet TeamBot zelf voor je klaar: een eigen, gecontroleerde kopie, alleen voor jou. TeamBot
            leest, kopieert of deelt je login nooit, ook niet met andere gebruikers van deze server. {t("{0} van {1} programma's gevonden.", found.length, supported.length)}
          </MoreInfo>
        </p>
        <Button size="sm" icon={<RefreshCw className={cx('h-4 w-4', busy && 'animate-spin')} />} onClick={() => load(true)} disabled={busy}>
          Opnieuw zoeken
        </Button>
      </div>
      {/* Versions of the programs: for experts (Instellingen › Geavanceerd tonen). */}
      {advanced && <EngineVersionsCard />}
      {!provFor('opencode') && (
        <Card className="flex flex-wrap items-center gap-4 p-4" data-testid="free-start">
          <div className="min-w-0 flex-1 basis-64 text-sm">
            <div className="font-semibold">Gratis beginnen, zonder account</div>
            <p className="mt-0.5 text-muted">OpenCode met een gratis model, in één klik.</p>
            {!hasLocal && <LocalModelHint className="mt-1" />}
          </div>
          <FreeStartButton
            className="w-full sm:w-56"
            onReady={(_p, model, reserve) => (
              toast(`OpenCode staat klaar${model ? ` met ${prettyModel(model)}` : ''}.${reserve ? ` Nieuwe bots op OpenCode krijgen ${reserve.label} als reserve-engine.` : ''} Kies het bij een bot.`, 'ok'), load(true)
            )}
          />
        </Card>
      )}
      {err && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{err}</p>}
      {main.map(card)}
      {/* The other programs TeamBot knows (not on this pc, no copy of TeamBot's own): one click away, not in the way. */}
      {others.length > 0 && (
        <details className="group rounded-2xl border border-line bg-surface" data-testid="cli-others">
          <summary className="flex cursor-pointer list-none items-center gap-2 px-4 py-3 text-sm font-semibold">
            <ChevronDown className="h-4 w-4 text-muted transition-transform [details[open]>summary_&]:rotate-180" aria-hidden />
            {t("{0, plural, one {Nog # programma} other {Nog # programma's}}", others.length)}
            <span className="font-normal text-muted">· niet op deze pc</span>
          </summary>
          <div className="space-y-4 border-t border-line p-4">{others.map(card)}</div>
        </details>
      )}
      {advanced && <CustomAcp data={data!} onChanged={() => load(false)} />}
    </div>
  );
}

// ---------------------------------------------------------------- bot editor section

const MODE_TEXT: Record<'claude' | 'codex' | 'acp', Record<string, string>> = {
  claude: {
    chat: 'Claude Code draait zonder tools (alleen praten).',
    readonly: 'Plan-modus: Claude Code mag lezen, en niets kan worden goedgekeurd.',
    ask: 'Elke actie waarvoor Claude Code toestemming nodig heeft, komt bij jou als goedkeuring (ook op je telefoon).',
    auto: 'Werkt automatisch; acties met impact (pushen, publiceren, verwijderen, verzenden) vragen het jou.',
    full: 'Alles in de werkmap gaat zonder te vragen; verzenden naar anderen vraagt het jou nog.',
  },
  codex: {
    chat: 'Niet mogelijk: Codex kan niet zonder tools draaien. Kies “Alleen lezen”.',
    readonly: 'Alleen lezen; er kan niets worden goedgekeurd.',
    ask: 'Alleen lezen; schrijven en netwerk alleen na jouw goedkeuring.',
    auto: 'Mag schrijven in de mappen van de bot, zonder netwerk. Wat meer nodig heeft, wordt geweigerd.',
    full: 'Mag schrijven in de mappen van de bot, met netwerk, zonder te vragen.',
  },
  acp: {
    chat: 'Niet mogelijk: deze CLI kan niet zonder tools draaien. Kies “Alleen lezen”.',
    readonly: 'Plan-/alleen-lezen-modus waar de CLI die heeft; alleen leesacties worden toegestaan, schrijven geweigerd.',
    ask: 'Elk toestemmingsverzoek van de CLI komt bij jou als goedkeuring. Bestanden alleen binnen de werkmap.',
    auto: 'Werkt automatisch; acties met impact vragen het jou.',
    full: 'Alles in de werkmap zonder te vragen; versturen naar anderen vraagt het jou nog.',
  },
};

const MODE_LABEL: Record<string, string> = { chat: 'Alleen chat', readonly: 'Alleen lezen', ask: 'Vraagt toestemming', auto: 'Automatisch', full: 'Volledige toegang' };

const list = (s: string) =>
  s
    .split(/[,\n]/)
    .map((x) => x.trim())
    .filter(Boolean);

function CliAgentSection({ agent, onChange }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  const providers = useApp((s) => s.providers);
  const p = providers.find((x) => x.id === agent.provider_id);
  const cli = (agent.settings?.cli || {}) as Record<string, any>;
  const [allowed, setAllowed] = useState((cli.allowedTools || []).join(', '));
  const [denied, setDenied] = useState((cli.disallowedTools || []).join(', '));
  const [extra, setExtra] = useState((cli.extraArgs || []).join(' '));
  if (!p || p.type !== 'cli') {
    return <p className="text-sm text-muted">Geldt alleen voor bots op een programma met je eigen login (Instellingen › Abonnementen).</p>;
  }
  const engine = engineOf(p.kind);
  const set = (patch: Record<string, any>) => onChange({ settings: { ...(agent.settings || {}), cli: { ...cli, ...patch } } });
  const num = (v: string) => (v === '' ? undefined : Math.max(1, Number(v) || 1));
  return (
    <div className="space-y-4 text-sm">
      <div className="rounded-lg bg-surface-2 px-3 py-2">
        <div className="font-medium">
          {p.name} · {MODE_LABEL[agent.access_mode] || agent.access_mode}
        </div>
        <div className="mt-0.5 text-muted">{MODE_TEXT[engine][agent.access_mode] || ''}</div>
      </div>
      <div className="grid gap-3 sm:grid-cols-3">
        {engine === 'claude' && (
          <Field label="Max. stappen per beurt">
            <Input type="number" min={1} max={500} value={cli.maxTurns ?? ''} placeholder="40" onChange={(e) => set({ maxTurns: num(e.target.value) })} />
          </Field>
        )}
        <Field label="Max. duur (min)">
          <Input type="number" min={1} max={1440} value={cli.timeoutMin ?? ''} placeholder="60" onChange={(e) => set({ timeoutMin: num(e.target.value) })} />
        </Field>
        <Field label="Stoppen na stilte (min)" hint="Telt niet terwijl de bot op jou wacht">
          <Input type="number" min={1} max={240} value={cli.idleMin ?? ''} placeholder="10" onChange={(e) => set({ idleMin: num(e.target.value) })} />
        </Field>
      </div>
      {(engine === 'claude' || engine === 'codex') && (
        <div className="space-y-1">
          <Toggle checked={!!cli.useUserMcp} onChange={(v) => set({ useUserMcp: v })} label={engine === 'codex' ? 'Eigen MCP-servers, plugins en computer-/browsergebruik van Codex toestaan' : 'Eigen MCP-servers van Claude Code gebruiken'} />
          {cli.useUserMcp && (
            <p className="flex items-start gap-1.5 text-xs text-warn">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Tools van die servers volgen het beleid van de CLI zelf{engine === 'codex' ? ' en kunnen zonder goedkeuring van TeamBot handelen' : ''}.
            </p>
          )}
        </div>
      )}
      {engine === 'claude' && (
        <>
          <div className="space-y-1">
            <Toggle checked={!!cli.loadUserSettings} onChange={(v) => set({ loadUserSettings: v })} label="Mijn eigen Claude Code-instellingen laden (minder streng)" />
            {cli.loadUserSettings && (
              <p className="flex items-start gap-1.5 text-xs text-warn">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> Toestaan-regels uit je instellingen kunnen dan acties goedkeuren zonder TeamBot.
              </p>
            )}
          </div>
          <Field label="Altijd toegestane tools (vraag-/automatisch-modus)" hint='Claude Code-regels, bijv. Bash(npm test). Ze slaan de goedkeuring over.'>
            <Textarea rows={2} value={allowed} onChange={(e) => setAllowed(e.target.value)} onBlur={() => set({ allowedTools: list(allowed) })} />
          </Field>
          <Field label="Altijd geweigerde tools" hint="Bijv. WebFetch, Bash(git push:*)">
            <Textarea rows={2} value={denied} onChange={(e) => setDenied(e.target.value)} onBlur={() => set({ disallowedTools: list(denied) })} />
          </Field>
        </>
      )}
      {EXTRA_ARGS[p.kind] && (
        <Field label="Extra argumenten" hint={`Alleen toegestaan: ${EXTRA_ARGS[p.kind].join(', ')}`}>
          <Input value={extra} onChange={(e) => setExtra(e.target.value)} onBlur={() => set({ extraArgs: extra.split(/\s+/).filter(Boolean) })} placeholder={EXTRA_ARGS[p.kind][0].split(' ')[0]} />
        </Field>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- inspector tab

interface SessionRow {
  agentId: string;
  agentName: string;
  providerId: string;
  cli: string;
  label: string;
  sessionId: string;
  updatedAt: string;
}

function CliSessionsTab({ threadId }: { threadId: string; agentId: string | null }) {
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [err, setErr] = useState('');
  const reset = useAsync();
  const load = useCallback(() => {
    api
      .get<SessionRow[]>(`/cli-agents/threads/${threadId}/sessions`)
      .then((r) => {
        setRows(r);
        setErr('');
      })
      .catch((e) => setErr(e.message || String(e)));
  }, [threadId]);
  useEffect(() => {
    load();
    return on('run.updated', (r: any) => {
      if (r?.thread_id === threadId && ['done', 'error', 'cancelled'].includes(r.status)) load();
    });
  }, [load, threadId]);
  if (err) return <p className="text-sm text-danger">{err}</p>;
  if (!rows) return <Spinner />;
  if (!rows.length) return <EmptyState icon={<Terminal className="h-6 w-6" />} title="Geen CLI-sessies">Sessies van bots op een CLI-agent, per gesprek.</EmptyState>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.agentId + r.providerId} className="rounded-lg border border-line p-3 text-sm">
          <div className="font-medium">{r.agentName}</div>
          <div className="text-xs text-muted">
            {r.label} · bijgewerkt {timeAgo(r.updatedAt)}
          </div>
          <div className="mt-1 break-all font-mono text-xs" title="Sessie-id van de CLI">
            {r.sessionId}
          </div>
          <Button
            size="sm"
            className="mt-2"
            icon={<RotateCcw className="h-3.5 w-3.5" />}
            loading={reset.busy}
            onClick={() =>
              reset.run(async () => {
                await api.post(`/cli-agents/threads/${threadId}/sessions/reset`, { agentId: r.agentId });
                load();
              }, 'De volgende beurt start een nieuwe sessie')
            }
          >
            Nieuwe sessie
          </Button>
        </li>
      ))}
    </ul>
  );
}

const mod: UIModule = {
  id: 'cli-agents',
  label: 'Abonnementen',
  settingsTabs: [{ id: 'cli', title: 'Abonnementen', component: CliSettings }],
  agentSections: [{ id: 'cli', title: 'Programma', component: CliAgentSection }],
  inspectorTabs: [{ id: 'cli', title: 'CLI', component: CliSessionsTab }],
};

export default mod;

