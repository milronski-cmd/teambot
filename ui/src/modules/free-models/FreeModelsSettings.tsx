import { useEffect, useState } from 'react';
import { ChevronDown, ExternalLink, RefreshCw } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatDate, formatDateTime, formatNumber, formatTime, relativeTime } from '../../lib/format';
import { Badge, Button, Card, Field, Input, Spinner, cx, toastError } from '../../components/ui';
import { ConnectCard, ConnectResult, type ConnectState } from '../../components/ConnectCard';
import { freeStart } from '../cli-agents/runtime';

type Level = 'local' | 'no-store' | 'may-train';
type Tools = 'tools' | 'text' | 'unknown';
type Status = 'off' | 'available' | 'limited' | 'key' | 'error' | 'unchecked';

interface Privacy {
  level: Level;
  note?: string;
  source?: string;
}

interface ModelRow {
  id: string;
  label: string | null;
  tools: Tools;
  privacy: Privacy;
  available: boolean;
  availableAt: number | null;
  probedAt: number | null;
}

interface Source {
  kind: string;
  label: string;
  engine: 'api' | 'cli' | 'local';
  configured: boolean;
  hasKey: boolean;
  needsKey: boolean;
  keyPlaceholder: string | null;
  fields: { key: string; label: string; placeholder: string | null; hint: string | null; value: string }[];
  signupUrl: string | null;
  on: boolean;
  status: Status;
  resetsAt: number | null;
  privacy: Privacy;
  limitNote: string;
  docs: { limits: string; terms: string; checked: string };
  remaining: { remaining: number | null; limit: number | null } | null;
  usedPercent: number | null;
  estimated: boolean;
  models: ModelRow[];
  gone: { id: string }[];
  counts: { models: number; tools: number; text: number; unknown: number };
  refreshedAt: number | null;
  extraAccounts: number;
  /** Free engines on this computer that are not connected yet: is it here, can TeamBot install it (server: EngineSetup). */
  setup?: { installed: boolean | null; canInstall: boolean; ownerOnly?: boolean; otherApp?: string; steps?: string[] } | null;
}

interface View {
  sources: Source[];
  engines: Source[];
  checked: string;
}

/** The three privacy labels (the same words everywhere in TeamBot). */
const PRIVACY: Record<Level, string> = { local: 'blijft op je pc', 'no-store': 'bewaart niets', 'may-train': 'kan trainen' };
const PRIVACY_TONE: Record<Level, 'ok' | 'warn'> = { local: 'ok', 'no-store': 'ok', 'may-train': 'warn' };
const TOOLS: Record<Tools, string> = { tools: 'tools werken', text: 'alleen tekst', unknown: 'nog niet getest' };

/** "14:05", or with the day when the reset is more than 20 hours away. */
function when(ms: number): string {
  return ms - Date.now() > 20 * 3600_000 ? formatDateTime(ms, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : formatTime(ms);
}

function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="inline-flex items-center gap-0.5 underline" href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink className="h-3 w-3 rtl-keep" aria-hidden />
    </a>
  );
}

/** The card state of a source that is on, from its last (free) check. */
function stateOf(s: Pick<Source, 'on' | 'status' | 'resetsAt'>, busy: boolean): { state: ConnectState; label?: string } {
  if (busy) return { state: 'busy' };
  if (!s.on) return { state: 'off', label: 'Uit' };
  switch (s.status) {
    case 'available':
      return { state: 'on', label: 'Beschikbaar' };
    case 'limited':
      return { state: 'on', label: s.resetsAt ? `Op tot ${when(s.resetsAt)}` : 'Limiet bereikt' };
    case 'key':
      return { state: 'error', label: 'Sleutel ongeldig' };
    case 'error':
      return { state: 'error', label: 'Niet bereikbaar' };
    default:
      return { state: 'on', label: 'Nog niet gecontroleerd' };
  }
}

/** After an action: "Verbinding werkt", or what is wrong with one next step. */
function Outcome({ s }: { s: Source }) {
  if (!s.on) return null;
  if (s.status === 'available' || s.status === 'limited') return <ConnectResult ok next={s.status === 'limited' ? 'De gratis limiet is nu bereikt; daarna gaat het vanzelf verder.' : undefined} />;
  if (s.status === 'key') return <ConnectResult ok={false} next="Plak de sleutel opnieuw, of maak een nieuwe aan.">De sleutel werkt niet.</ConnectResult>;
  if (s.status === 'error') return <ConnectResult ok={false} next="Controleer je internetverbinding en probeer het later opnieuw.">{t('{0} is nu niet bereikbaar.', s.label)}</ConnectResult>;
  return null;
}

const Privacy = ({ p }: { p: Privacy }) => <Badge tone={PRIVACY_TONE[p.level]}>{PRIVACY[p.level]}</Badge>;
const countText = (s: Source) => (s.counts.models === 1 ? '1 gratis model' : `${s.counts.models} gratis modellen`);

/** Instellingen › Gratis modellen: every free source on the shared connect card, one click (or one pasted key) each. */
export function FreeModelsSettings() {
  const [v, setV] = useState<View | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [more, setMore] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = () => {
    api.get<View>('/free-models').then(
      (x) => {
        setV(x);
        setErr(null);
      },
      (e) => setErr(e?.message || String(e)),
    );
  };
  useEffect(() => {
    load();
    return on('free-models.updated', load);
  }, []);

  if (err && !v)
    return (
      <Card className="space-y-3 p-5">
        <p className="text-sm text-danger">De gratis modellen konden niet worden geladen: {err}</p>
        <Button onClick={load}>Opnieuw proberen</Button>
      </Card>
    );
  if (!v) return <Spinner />;

  const refresh = async () => {
    setRefreshing(true);
    try {
      setV(await api.post<View>('/free-models/refresh'));
    } catch (e) {
      toastError(e);
    } finally {
      setRefreshing(false);
    }
  };

  return (
    <div className="space-y-5">
      <p className="text-sm text-muted">
        Is het model van een bot op, dan gaat TeamBot door op een gratis model dat je hier aanzet.{' '}
        <a className="font-semibold text-fg underline-offset-2 hover:underline" href="#/settings/engine-chain-doorschakelen">
          Doorschakelen instellen
        </a>
      </p>
      {v.engines.length > 0 && (
        <div className="space-y-2">
          <h2 className="text-[15px] font-bold tracking-tight">Op deze computer</h2>
          <ul className="space-y-2" data-testid="free-engines">
            {v.engines.map((e) => (
              <EngineRow key={e.kind} s={e} more={more} onView={setV} reload={load} />
            ))}
          </ul>
        </div>
      )}
      <div className="space-y-2">
        <h2 className="text-[15px] font-bold tracking-tight">Online, met een gratis account</h2>
        <ul className="space-y-2">
          {v.sources.map((s) => (
            <SourceRow key={s.kind} s={s} more={more} onView={setV} />
          ))}
        </ul>
      </div>
      <button type="button" className="inline-flex items-center gap-1 text-[13px] font-semibold text-muted hover:text-fg" aria-expanded={more} onClick={() => setMore((x) => !x)}>
        <ChevronDown className={cx('h-4 w-4 transition-transform', more && 'rotate-180')} aria-hidden />
        Meer opties
      </button>
      {more && (
        <Card className="space-y-4 p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={refreshing} onClick={refresh}>
              Lijsten nu verversen
            </Button>
            <span className="text-xs text-muted">Gratis modellen worden hooguit één keer per dag getest.</span>
          </div>
          <ul className="space-y-1.5 text-xs leading-relaxed text-muted">
            <li>Niets verlaat je pc tot je het hier aanzet.</li>
            <li>Eén account per aanbieder.</li>
            <li>De gratis modellen van OpenCode gebruikt TeamBot alleen via OpenCode zelf.</li>
            <li>Mistral, NVIDIA en Cerebras staan hier niet; koppel ze als gewone provider bij AI-diensten.</li>
            <li>Google Gemini (gratis) staat hier niet; koppel het met een betaalde sleutel als gewone provider.</li>
            <li>{`Limieten en voorwaarden nagekeken op ${formatDate(v.checked, { day: 'numeric', month: 'long', year: 'numeric' })}.`}</li>
          </ul>
        </Card>
      )}
    </div>
  );
}

/**
 * A free engine on this computer (OpenCode, Ollama …): always listed, with one clear action. Here → Aanzetten /
 * Uitzetten; not here yet → Installeren (OpenCode: TeamBot's own copy in one click) or the download page (Ollama).
 */
function EngineRow({ s, more, onView, reload }: { s: Source; more: boolean; onView(v: View): void; reload(): void }) {
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [did, setDid] = useState(false);
  const [fail, setFail] = useState('');
  const setup = s.setup;
  const put = async (on: boolean) => {
    setBusy(true);
    setFail('');
    try {
      onView(await api.put<View>(`/free-models/sources/${s.kind}`, { on }));
      setDid(on);
    } catch (e: any) {
      setFail(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  const install = async () => {
    setBusy(true);
    setFail('');
    try {
      // The same one-click path as "Gratis starten": TeamBot's own checked copy, then connected on a free model.
      await freeStart(() => setInstalling(true));
      onView(await api.put<View>(`/free-models/sources/${s.kind}`, { on: true }));
      setDid(true);
    } catch (e: any) {
      setFail(e?.message || String(e));
      reload();
    } finally {
      setInstalling(false);
      setBusy(false);
    }
  };
  const here = s.configured || !!setup?.installed;
  let action: React.ReactNode = null;
  if (s.on)
    action = (
      <Button size="sm" variant="ghost" loading={busy} onClick={() => put(false)}>
        Uitzetten
      </Button>
    );
  else if (here)
    action = (
      <Button size="sm" variant="primary" loading={busy} onClick={() => put(true)}>
        Aanzetten
      </Button>
    );
  else if (setup?.canInstall)
    action = (
      <Button size="sm" variant="primary" loading={busy} onClick={install}>
        Installeren
      </Button>
    );
  else if (s.kind === 'ollama' && !setup?.ownerOnly)
    action = (
      <>
        <a className="inline-flex h-8 items-center gap-1 rounded-lg bg-accent px-3 text-[13px] font-semibold text-accent-fg hover:opacity-90 coarse:h-11" href="https://ollama.com/download" target="_blank" rel="noreferrer">
          Ollama downloaden <ExternalLink className="h-3.5 w-3.5 rtl-keep" aria-hidden />
        </a>
        <Button size="sm" onClick={reload}>
          Opnieuw controleren
        </Button>
      </>
    );
  const st = stateOf(s, busy);
  const label = s.on || busy ? st.label : here ? (s.configured ? 'Uit' : 'Staat op deze pc') : setup?.ownerOnly ? 'Alleen voor de eigenaar' : undefined;
  const line = installing
    ? 'TeamBot downloadt en controleert zijn eigen kopie. Dat kan een paar minuten duren.'
    : s.on && s.counts.models > 0
      ? countText(s)
      : s.kind === 'opencode'
        ? 'Gratis modellen zonder account.'
        : s.kind === 'ollama'
          ? here
            ? 'Draait op je eigen computer, zonder limiet.'
            : 'Installeer Ollama; daarna zet je het hier aan.'
          : 'Gratis; draait op je eigen computer.';
  return (
    <li data-testid={`free-engine-${s.kind}`}>
      <ConnectCard
        title={
          <span className="font-semibold" translate="no">
            {s.label}
          </span>
        }
        line={
          <>
            <Privacy p={s.privacy} /> {line}
          </>
        }
        state={st.state}
        stateLabel={label}
        action={action}
        result={fail ? <ConnectResult ok={false}>{fail}</ConnectResult> : did && !busy && <Outcome s={s} />}
        moreOpen={more}
        more={
          <>
            <p className="text-xs leading-relaxed text-muted">{s.limitNote}</p>
            {!s.configured && setup?.otherApp && <p className="text-xs text-muted">{t('Nu alleen gevonden in {0}; TeamBot installeert een eigen kopie.', setup.otherApp)}</p>}
            {!s.configured && setup?.ownerOnly && <p className="text-xs text-muted">Dit draait op de eigen login van de computer waarop TeamBot staat. Alleen de eigenaar kan het aanzetten.</p>}
            {s.configured && <SourceDetails s={s} onNewKey={() => {}} />}
          </>
        }
      />
    </li>
  );
}

function SourceRow({ s, more, onView }: { s: Source; more: boolean; onView(v: View): void }) {
  const [key, setKey] = useState('');
  const [extra, setExtra] = useState<Record<string, string>>(() => Object.fromEntries(s.fields.map((f) => [f.key, f.value || ''])));
  const [busy, setBusy] = useState(false);
  const [newKey, setNewKey] = useState(false);
  const [did, setDid] = useState(false);
  const [fail, setFail] = useState('');
  const missingKey = s.needsKey && !s.hasKey;
  const fieldsOk = s.fields.every((f) => (extra[f.key] || '').trim());

  const put = async (body: Record<string, any>) => {
    setBusy(true);
    setFail('');
    try {
      onView(await api.put<View>(`/free-models/sources/${s.kind}`, body));
      setKey('');
      setNewKey(false);
      setDid(body.on !== false);
    } catch (e: any) {
      setFail(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };
  const connect = (k: string) => put({ apiKey: k.trim(), ...extra, on: true });
  const askKey = missingKey || newKey || (s.on && s.status === 'key');
  const st = stateOf(s, busy);
  return (
    <li data-free-source={s.kind}>
      <ConnectCard
        title={
          <span className="font-semibold" translate="no">
            {s.label}
          </span>
        }
        line={
          <>
            <Privacy p={s.privacy} /> {s.on && s.counts.models > 0 ? `${countText(s)} · ${s.counts.tools ? `tools werken bij ${s.counts.tools}` : 'tools nog niet getest'}` : s.needsKey ? 'Met een gratis sleutel van de aanbieder.' : 'Werkt zonder sleutel.'}
          </>
        }
        state={st.state}
        stateLabel={st.label}
        action={
          s.on ? (
            <Button size="sm" variant="ghost" loading={busy} onClick={() => put({ on: false })}>
              Uitzetten
            </Button>
          ) : (
            !missingKey && (
              <Button size="sm" variant="primary" loading={busy} onClick={() => put({ on: true })}>
                Aanzetten
              </Button>
            )
          )
        }
        result={fail ? <ConnectResult ok={false}>{fail}</ConnectResult> : did && !busy && <Outcome s={s} />}
        moreOpen={more}
        more={
          <>
            <p className="text-xs leading-relaxed text-muted">{s.limitNote}</p>
            <SourceDetails s={s} onNewKey={() => setNewKey(true)} />
          </>
        }
      >
        {askKey && (
          <form
            className="space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (key.trim() && fieldsOk && !busy) void connect(key);
            }}
          >
            {s.fields.map((f) => (
              <Field key={f.key} label={f.label} hint={f.hint || undefined}>
                <Input value={extra[f.key] || ''} onChange={(e) => { const val = e.target.value; setExtra((x) => ({ ...x, [f.key]: val })); }} placeholder={f.placeholder || undefined} spellCheck={false} translate="no" />
              </Field>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Input
                type="password"
                autoComplete="off"
                className="min-w-0 flex-1 basis-48"
                value={key}
                onChange={(e) => setKey(e.target.value)}
                onPaste={(e) => {
                  // A pasted key connects at once (nothing else to fill in).
                  const text = e.clipboardData.getData('text').trim();
                  if (!text || busy || !fieldsOk) return;
                  e.preventDefault();
                  setKey(text);
                  void connect(text);
                }}
                placeholder={s.keyPlaceholder || 'Plak hier je sleutel'}
                aria-label="API-sleutel"
              />
              <Button variant="primary" size="sm" type="submit" loading={busy} disabled={!key.trim() || !fieldsOk}>
                Koppelen
              </Button>
              {newKey && (
                <Button variant="ghost" size="sm" type="button" disabled={busy} onClick={() => setNewKey(false)}>
                  Annuleren
                </Button>
              )}
            </div>
            {s.signupUrl && (
              <p className="text-xs text-muted">
                <ExtLink href={s.signupUrl}>Gratis sleutel aanmaken</ExtLink>
              </p>
            )}
          </form>
        )}
      </ConnectCard>
    </li>
  );
}

function SourceDetails({ s, onNewKey }: { s: Source; onNewKey(): void }) {
  return (
    <div className="space-y-2.5 rounded-xl border border-line p-3 text-xs leading-relaxed">
      {s.privacy.note && <p className="text-muted">{s.privacy.note}</p>}
      {s.remaining?.remaining !== null && s.remaining?.remaining !== undefined && s.remaining.limit ? (
        <p>{`Vandaag nog ${formatNumber(s.remaining.remaining)} van ${formatNumber(s.remaining.limit)} gratis verzoeken.`}</p>
      ) : s.usedPercent !== null && s.estimated ? (
        <p>{`Dit uur ongeveer ${formatNumber(Math.round(s.usedPercent))}% van de limiet gebruikt (schatting).`}</p>
      ) : null}
      {s.models.length > 0 && (
        <ul className="space-y-1">
          {s.models.map((m) => (
            <li key={m.id} className="flex flex-wrap items-center gap-1.5">
              <span className="min-w-0 break-all font-mono text-[12px]" translate="no">
                {m.label || m.id}
              </span>
              <Badge tone={m.tools === 'tools' ? 'ok' : m.tools === 'text' ? 'warn' : 'neutral'}>{TOOLS[m.tools]}</Badge>
              {m.privacy.level !== s.privacy.level && <Badge tone={PRIVACY_TONE[m.privacy.level]}>{PRIVACY[m.privacy.level]}</Badge>}
              {!m.available && m.availableAt && <Badge tone="warn">{`Op tot ${when(m.availableAt)}`}</Badge>}
              {m.probedAt && <span className="text-muted">{`getest ${relativeTime(m.probedAt)}`}</span>}
            </li>
          ))}
        </ul>
      )}
      {s.gone.length > 0 && <p className="text-muted">{`Niet meer beschikbaar bij de aanbieder: ${s.gone.map((g) => g.id).join(', ')}`}</p>}
      {s.extraAccounts > 0 && <p className="text-warn">{`Er is meer dan één ${s.label}-koppeling. TeamBot gebruikt er één; accounts combineren mag niet.`}</p>}
      <p className="flex flex-wrap gap-x-3 gap-y-1 text-muted">
        {s.docs.limits && <ExtLink href={s.docs.limits}>Limieten</ExtLink>}
        {s.docs.terms && s.docs.terms !== s.docs.limits && <ExtLink href={s.docs.terms}>Voorwaarden</ExtLink>}
        {s.refreshedAt && <span>{`Lijst opgehaald ${relativeTime(s.refreshedAt)}`}</span>}
      </p>
      {s.engine === 'api' && s.configured && (s.hasKey || !s.needsKey) && (
        <Button size="sm" variant="ghost" onClick={onNewKey}>
          {s.hasKey ? 'Andere sleutel' : 'Eigen sleutel toevoegen (optioneel)'}
        </Button>
      )}
    </div>
  );
}
