import type React from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { CheckCircle2, Copy, ExternalLink, Gift, KeyRound, LogIn, Sparkles } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { tKnown } from '../../lib/format';
import type { ProviderKindView, ProviderTestResult, ProviderView } from '../../lib/types';
import { Button, Card, Input, Spinner, cx, toast, toastError, useAsync } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { FreeStartButton, JobProgress, useRuntimeJob, type RuntimeJob } from '../../modules/cli-agents/runtime';
import { LOCAL_KINDS } from '../newbot/choices';
import { OllamaInstallButton } from '../../modules/local-models/install';
import { cleanKey, guessKey, keyNoteText } from './keyFormat';
import { subscriptionReady } from './mainAction';
import { useIsPhoneSession } from '../../shell/computerOnly';

/**
 * Where the first screen goes once an AI is connected (0.4.5, like OpenBot): a ready first bot right away, with its own
 * werkplek and browser; the three questions are optional there ("Aanpassen"). See welcome/FirstBot.tsx.
 */
export const firstBotFor = (providerId: string) => `/start?ai=${encodeURIComponent(providerId)}`;

// ---------------------------------------------------------------- "Ik heb Claude of ChatGPT"

export interface SubscriptionItem {
  id: 'claude-code' | 'codex-cli';
  label: string;
  installed: boolean;
  loggedIn?: boolean;
  billing: 'subscription' | 'api' | 'unknown';
  providerId: string | null;
  runtime: { supported: boolean; pinned: string; sizeMb: number | null; installed: boolean; job: RuntimeJob | null } | null;
  loginCommand: string;
  docsUrl: string;
}

export interface SubscriptionsView {
  canUse: boolean;
  mode: 'desktop' | 'server';
  items: SubscriptionItem[];
}

/** Claude Code and Codex on this computer (GET /api/cli-agents/subscriptions). */
export function useSubscriptions() {
  const [view, setView] = useState<SubscriptionsView | null>(null);
  const [err, setErr] = useState(false);
  const load = useCallback(async (fresh?: string) => {
    try {
      const v = await api.get<SubscriptionsView>(`/cli-agents/subscriptions${fresh ? `?fresh=1&only=${encodeURIComponent(fresh)}` : ''}`);
      setView(v);
      setErr(false);
      return v;
    } catch {
      setErr(true);
      return null;
    }
  }, []);
  useEffect(() => void load(), [load]);
  return { view, err, load };
}

/** The plan names people know, and the vendor's program that brings them to TeamBot. */
const PLAN: Record<SubscriptionItem['id'], { name: string; plans: string; program: string; maker: string }> = {
  'claude-code': { name: 'Claude', plans: 'Pro of Max', program: 'Claude Code', maker: 'Anthropic' },
  'codex-cli': { name: 'ChatGPT', plans: 'Plus of Pro', program: 'Codex', maker: 'OpenAI' },
};

/** Connect a subscription engine (no key: the vendor's program keeps the login) and go to the questions. */
async function startWithSubscription(it: SubscriptionItem) {
  const from = location.hash;
  const r = await api.post<{ provider: ProviderView }>(`/cli-agents/${it.id}/connect`, {});
  await useApp.getState().refreshProviders();
  navigate(firstBotFor(r.provider.id), { from });
}

/** How long TeamBot keeps looking for a login done in the vendor's own window. */
const LOGIN_WAIT_MS = 10 * 60_000;

function SubscriptionRow({ it, primary, mode, onChanged }: { it: SubscriptionItem; primary: boolean; mode: SubscriptionsView['mode']; onChanged(fresh?: string): Promise<SubscriptionsView | null> }) {
  const plan = PLAN[it.id];
  // The vendor's login window opens on the computer TeamBot runs on: only from that computer itself (not from a phone).
  const phone = useIsPhoneSession();
  const here = mode === 'desktop' && !phone;
  const act = useAsync();
  const job = useRuntimeJob(it.id, it.runtime?.job);
  const installing = !!job && !['done', 'error'].includes(job.phase);
  const [waiting, setWaiting] = useState(false);
  const alive = useRef(true);
  useEffect(
    () => () => {
      alive.current = false;
    },
    [],
  );
  // The install ended: look again (the copy is there now, not logged in yet).
  useEffect(() => {
    if (job?.phase === 'done') void onChanged(it.id);
    if (job?.phase === 'error' && job.error) toast(job.error, 'danger');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.phase]);
  // After "Inloggen": look every few seconds; as soon as the vendor's program says it is logged in, go on by itself.
  useEffect(() => {
    if (!waiting) return;
    const end = Date.now() + LOGIN_WAIT_MS;
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const v = await onChanged(it.id);
      if (!alive.current) return;
      const now = v?.items.find((x) => x.id === it.id);
      if (now && now.installed && now.loggedIn === true) {
        setWaiting(false);
        toast(t('Ingelogd bij {0}', plan.name), 'ok');
        await startWithSubscription(now).catch(toastError);
        return;
      }
      if (Date.now() > end) return setWaiting(false);
      timer = setTimeout(tick, 4000);
    };
    timer = setTimeout(tick, 4000);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting]);

  const login = () =>
    act.run(async () => {
      // The vendor's own login: its program opens the sign-in page in the browser. TeamBot only waits for the result.
      if (here) await api.post(`/cli-agents/${it.id}/login/terminal`, {});
      setWaiting(true);
    });
  const install = () => act.run(async () => void (await api.post(`/cli-agents/runtimes/${it.id}/install`, { version: 'pinned' })));
  const copy = () => navigator.clipboard?.writeText(it.loginCommand).then(() => toast('Gekopieerd', 'ok'), () => toast('Kopiëren lukte niet', 'danger'));

  let state: React.ReactNode;
  let action: React.ReactNode = null;
  if (subscriptionReady(it)) {
    state =
      it.billing === 'api'
        ? t('{0} is ingelogd met een API-sleutel (betaal per gebruik).', plan.program)
        : it.loggedIn
          ? t('{0} staat klaar en is ingelogd.', plan.program)
          : t('{0} staat op deze pc.', plan.program);
    action = (
      <Button variant={primary ? 'primary' : 'secondary'} size="sm" loading={act.busy} onClick={() => act.run(() => startWithSubscription(it))} aria-label={t('{0} gebruiken', plan.name)}>
        Gebruiken
      </Button>
    );
  } else if (it.installed) {
    state = waiting ? (
      <span className="flex items-center gap-1.5">
        <Spinner /> {here ? t('Log in in het venster van {0}; TeamBot gaat daarna vanzelf verder.', plan.name) : 'Log in op de computer waar TeamBot draait; TeamBot gaat daarna vanzelf verder.'}
      </span>
    ) : (
      t('{0} staat op deze pc. Log één keer in bij {1}.', plan.program, plan.maker)
    );
    action = waiting ? (
      <Button variant="ghost" size="sm" onClick={() => setWaiting(false)}>
        Stoppen
      </Button>
    ) : (
      <Button variant={primary ? 'primary' : 'secondary'} size="sm" icon={<LogIn className="h-3.5 w-3.5" />} loading={act.busy} onClick={login} aria-label={t('Inloggen bij {0}', plan.name)}>
        Inloggen
      </Button>
    );
  } else if (it.runtime?.supported) {
    state = installing ? <JobProgress job={job!} label={plan.program} /> : t('TeamBot zet {0} klaar, het officiële programma van {1} (±{2} MB).', plan.program, plan.maker, it.runtime.sizeMb || 150);
    action = installing ? null : (
      <Button variant="secondary" size="sm" loading={act.busy} onClick={install} aria-label={t('{0} installeren', plan.name)}>
        Installeren
      </Button>
    );
  } else {
    state = (
      <>
        {t('Installeer {0} van {1} en kom dan terug.', plan.program, plan.maker)}{' '}
        <a className="inline-flex items-center gap-0.5 font-semibold underline hover:text-fg" href={it.docsUrl} target="_blank" rel="noreferrer">
          {t('{0} installeren', plan.program)} <ExternalLink className="h-3 w-3" aria-hidden />
        </a>
      </>
    );
  }

  return (
    <li className="flex items-center gap-3 py-2.5" data-testid={`start-${it.id}`}>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-semibold">
          {plan.name} <span className="font-normal text-muted">({plan.plans})</span>
        </div>
        <div className={cx('mt-0.5 text-[12.5px] leading-snug', subscriptionReady(it) ? 'text-ok' : 'text-muted')}>{state}</div>
        {waiting && !here && (
          <div className="mt-1.5 flex items-start gap-1.5">
            <code className="min-w-0 flex-1 break-all rounded-md bg-surface-2 px-2 py-1 font-mono text-xs" translate="no">
              {it.loginCommand}
            </code>
            <Button size="iconSm" variant="ghost" aria-label={t('Kopieer: {0}', it.loginCommand)} onClick={copy}>
              <Copy className="h-3.5 w-3.5" />
            </Button>
          </div>
        )}
      </div>
      {action}
    </li>
  );
}

export function SubscriptionCard({ view, err, primaryId, onChanged }: { view: SubscriptionsView | null; err: boolean; primaryId: string | null; onChanged(fresh?: string): Promise<SubscriptionsView | null> }) {
  return (
    <Card className="p-4" data-testid="start-subscription">
      <h2 className="flex items-center gap-2 text-[15px] font-bold tracking-tight">
        <Sparkles className="h-4 w-4 text-muted" aria-hidden /> Ik heb Claude of ChatGPT
      </h2>
      <p className="mt-0.5 text-[13px] leading-snug text-muted">
        Je abonnement werkt ook hier, zonder extra kosten. <MoreInfo>Je logt in bij de maker zelf; TeamBot ziet je wachtwoord nooit.</MoreInfo>
      </p>
      {!view && !err ? (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted">
          <Spinner /> Even kijken wat er op deze pc staat…
        </p>
      ) : !view?.canUse ? (
        <p className="mt-3 text-sm text-muted">Een abonnement gebruiken kan alleen de eigenaar van deze TeamBot. Gebruik een API-sleutel.</p>
      ) : (
        <ul className="mt-1 divide-y divide-line">
          {view.items.map((it) => (
            <SubscriptionRow key={it.id} it={it} primary={primaryId === `sub:${it.id}`} mode={view.mode} onChanged={onChanged} />
          ))}
        </ul>
      )}
    </Card>
  );
}

// ---------------------------------------------------------------- "Ik heb een API-sleutel"

type KeyState = { phase: 'idle' } | { phase: 'testing'; label: string } | { phase: 'ok'; label: string } | { phase: 'error'; text: string; hint?: string };

/**
 * One field: paste a key. TeamBot recognises the service, checks the key for free and stores it encrypted (the server
 * puts it in its Secrets store; it is never shown again). Pasting starts at once; typing ends with Enter or "Koppelen".
 */
export function KeyPaste({ kinds, onConnected, autoFocus }: { kinds: ProviderKindView[] | null; onConnected(p: ProviderView): void; autoFocus?: boolean }) {
  const [key, setKey] = useState('');
  const [st, setSt] = useState<KeyState>({ phase: 'idle' });
  const busy = st.phase === 'testing';
  const kindOf = useMemo(() => new Map((kinds || []).map((k) => [k.id, k])), [kinds]);
  const guess = useMemo(() => guessKey(key), [key]);
  const usable = (id: string) => {
    const k = kindOf.get(id);
    return !!k && k.type === 'api' && !k.retired;
  };
  const candidates = guess.kinds.filter(usable);
  const recognised = candidates.length === 1 ? kindOf.get(candidates[0])!.label : null;

  const connect = async (raw: string) => {
    const apiKey = cleanKey(raw);
    const g = guessKey(apiKey);
    const list = g.kinds.filter(usable);
    if (!apiKey) return setSt({ phase: 'error', text: 'Plak eerst je API-sleutel.' });
    if (!list.length) return setSt({ phase: 'error', text: keyNoteText(g.note === 'short' ? 'unknown' : g.note || 'unknown') || keyNoteText('unknown')! });
    let first: ProviderTestResult | null = null;
    for (const id of list) {
      const k = kindOf.get(id)!;
      setSt({ phase: 'testing', label: k.label });
      const r = await api.post<ProviderTestResult>(`/provider-kinds/${id}/check`, { apiKey }).catch((e) => ({ ok: false, detail: e?.message || String(e) }) as ProviderTestResult);
      if (!r.ok) {
        first ||= r;
        continue;
      }
      try {
        const rec = r.models?.find((m) => m.recommended)?.id;
        const p = await api.post<ProviderView>('/providers', { kind: id, name: k.label, apiKey, config: rec ? { defaultModel: rec } : undefined });
        await useApp.getState().refreshProviders();
        setKey('');
        setSt({ phase: 'ok', label: k.label });
        onConnected(p);
      } catch (e: any) {
        setSt({ phase: 'error', text: e?.message || String(e) });
      }
      return;
    }
    const names = list.map((id) => kindOf.get(id)!.label);
    setSt(
      list.length === 1
        ? { phase: 'error', text: t('Deze sleutel werkt niet bij {0}: {1}', names[0], first?.detail || ''), hint: first?.hint }
        : { phase: 'error', text: t('Deze sleutel werkt bij geen van deze diensten: {0}. Controleer hem of kies de dienst zelf.', names.join(', ')), hint: first?.hint },
    );
  };

  return (
    <form
      className="space-y-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (!busy) void connect(key);
      }}
    >
      <div className="flex gap-2">
        <Input
          type="password"
          value={key}
          onChange={(e) => (setKey(e.target.value), st.phase !== 'testing' && setSt({ phase: 'idle' }))}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            if (!text.trim() || busy) return;
            e.preventDefault();
            setKey(cleanKey(text));
            void connect(text);
          }}
          placeholder="Plak hier je sleutel"
          aria-label={t('API-sleutel')}
          autoComplete="off"
          spellCheck={false}
          autoFocus={autoFocus}
          disabled={busy}
          className={cx('min-w-0 flex-1', key && 'font-mono')}
        />
        <Button type="submit" variant="secondary" loading={busy} disabled={!key.trim()}>
          Koppelen
        </Button>
      </div>
      <div className="min-h-[18px] text-[12.5px] leading-snug" role="status" aria-live="polite">
        {st.phase === 'testing' ? (
          <span className="flex items-center gap-1.5 text-muted">
            <Spinner /> {t('{0} herkend. Sleutel testen (gratis)…', st.label)}
          </span>
        ) : st.phase === 'ok' ? (
          <span className="flex items-center gap-1.5 text-ok">
            <CheckCircle2 className="h-3.5 w-3.5" aria-hidden /> {t('{0} werkt en is versleuteld bewaard.', st.label)}
          </span>
        ) : st.phase === 'error' ? (
          <span className="block text-danger">
            {st.text}
            {st.hint && <span className="mt-0.5 block text-fg">{t('Oplossing: {0}', st.hint)}</span>}
          </span>
        ) : key.trim() && recognised ? (
          <span className="text-muted">{t('Herkend: {0}', recognised)}</span>
        ) : key.trim() && candidates.length > 1 ? (
          <span className="text-muted">TeamBot test bij welke dienst deze sleutel hoort.</span>
        ) : (
          <span className="text-muted">Bijvoorbeeld van OpenAI, Anthropic, Google, OpenRouter, Groq, Mistral of DeepSeek.</span>
        )}
      </div>
    </form>
  );
}

export function KeyCard({ kinds, connected, primaryId }: { kinds: ProviderKindView[] | null; connected: ProviderView[]; primaryId: string | null }) {
  const page = location.hash;
  return (
    <Card className="p-4" data-testid="start-key">
      <h2 className="flex items-center gap-2 text-[15px] font-bold tracking-tight">
        <KeyRound className="h-4 w-4 text-muted" aria-hidden /> Ik heb een API-sleutel
      </h2>
      <p className="mb-2.5 mt-0.5 text-[13px] leading-snug text-muted">
        Plak je sleutel; TeamBot herkent de dienst en bewaart hem versleuteld. <MoreInfo>TeamBot test de sleutel eerst gratis: het vraagt alleen de modellenlijst op, nooit een betaald antwoord.</MoreInfo>
      </p>
      {connected.length > 0 && (
        <ul className="mb-2.5 divide-y divide-line rounded-xl border border-line px-3">
          {connected.map((p) => (
            <li key={p.id} className="flex items-center gap-3 py-2">
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-semibold">{p.name}</span> <span className="text-muted">· al gekoppeld</span>
              </span>
              <Button size="sm" variant={primaryId === `p:${p.id}` ? 'primary' : 'secondary'} onClick={() => navigate(firstBotFor(p.id))} aria-label={t('{0} gebruiken', tKnown(p.name))}>
                Gebruiken
              </Button>
            </li>
          ))}
        </ul>
      )}
      <KeyPaste kinds={kinds} onConnected={(p) => setTimeout(() => navigate(firstBotFor(p.id), { from: page }), 500)} />
    </Card>
  );
}

// ---------------------------------------------------------------- "Gratis beginnen"

export interface FreeOption {
  key: string;
  label: string;
  /** Connected already (provider id), or found on this PC and connected on "Gebruiken". */
  providerId?: string;
  kind: string;
}

/** Local engines connected or found on this PC (Ollama, LM Studio …), and a connected OpenCode. */
export function freeOptions(kinds: ProviderKindView[] | null, providers: ProviderView[]): FreeOption[] {
  const out: FreeOption[] = [];
  const isLocal = (kind: string, billing?: string, group?: string) => LOCAL_KINDS.has(kind) || billing === 'local' || group === 'local';
  const kindOf = new Map((kinds || []).map((k) => [k.id, k]));
  for (const p of providers) {
    if (!p.enabled) continue;
    const k = kindOf.get(p.kind);
    if (isLocal(p.kind, p.billing || k?.billing, k?.group) || p.kind === 'opencode') out.push({ key: 'p:' + p.id, label: p.name, providerId: p.id, kind: p.kind });
  }
  for (const k of kinds || []) {
    if (!k.status?.installed || k.needsKey || k.retired || k.type === 'cli' || !isLocal(k.id, k.billing, k.group)) continue;
    if (providers.some((p) => p.kind === k.id)) continue;
    out.push({ key: 'k:' + k.id, label: k.label, kind: k.id });
  }
  return out;
}

/** Connect a free engine found on this PC (no key) and go to the questions. */
async function startFree(o: FreeOption) {
  const from = location.hash;
  let id = o.providerId;
  if (!id) {
    await api.post('/providers/autodetect');
    await useApp.getState().refreshProviders();
    id = useApp.getState().providers.find((p) => p.enabled && p.kind === o.kind)?.id;
    if (!id) throw new Error(t('{0} kon niet gekoppeld worden. Kies een andere manier om te beginnen.', o.label));
  }
  navigate(firstBotFor(id), { from });
}

/**
 * A local model when none runs on this PC yet: a choice of its own with "Installeren" (not a dead end). The click
 * installs Ollama (its official installer, silently) and connects it with a model that runs well here; then onFound
 * reloads the list, so this row becomes "Ollama gebruiken" by itself.
 */
function LocalModelMissing({ onFound }: { onFound(): void }) {
  return (
    <li className="flex flex-wrap items-center gap-3 py-2.5" data-testid="start-local-missing">
      <span className="min-w-0 flex-1 basis-48">
        <span className="block text-sm font-semibold">Ollama</span>
        <span className="block text-[12.5px] leading-snug text-muted">Met een lokaal model werkt het ook offline en zonder daglimiet. Nog niet op deze pc.</span>
      </span>
      <OllamaInstallButton variant="secondary" onDone={onFound} />
    </li>
  );
}

/**
 * "Gratis beginnen": the free engines found or connected here, OpenCode ("Gratis starten" sets it up), and a local
 * model: "Gebruiken" when one runs here, otherwise Ollama with "Installeren" (`onLocalFound` reloads the list).
 */
export function FreeCard({ options, primaryId, freeStartPrimary, localMissing, onLocalFound, children }: { options: FreeOption[]; primaryId: string | null; freeStartPrimary: boolean; localMissing: boolean; onLocalFound(): void; children?: React.ReactNode }) {
  const page = location.hash;
  const go = useAsync();
  const hasOpencode = options.some((o) => o.kind === 'opencode');
  return (
    <Card className="p-4" data-testid="start-free">
      <h2 className="flex items-center gap-2 text-[15px] font-bold tracking-tight">
        <Gift className="h-4 w-4 text-muted" aria-hidden /> Gratis beginnen
      </h2>
      <p className="mt-0.5 text-[13px] leading-snug text-muted">Zonder account of sleutel.</p>
      <ul className="mt-2 divide-y divide-line">
        {options.map((o) => (
          <li key={o.key} className="flex items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold">{o.label}</span>
              <span className="block text-[12.5px] text-muted">{o.kind === 'opencode' ? 'gratis modellen, met een daglimiet' : 'gratis, draait op deze pc'}</span>
            </span>
            <Button size="sm" variant={primaryId === o.key ? 'primary' : 'secondary'} loading={go.busy} onClick={() => go.run(() => startFree(o))} aria-label={t('{0} gebruiken', o.label)}>
              Gebruiken
            </Button>
          </li>
        ))}
        {!hasOpencode && (
          <li className="flex flex-wrap items-center gap-3 py-2.5">
            <span className="min-w-0 flex-1 basis-48">
              <span className="block text-sm font-semibold">OpenCode</span>
              <span className="block text-[12.5px] leading-snug text-muted">Gratis modellen, zonder account. TeamBot zet het zo nodig klaar (±125 MB).</span>
            </span>
            <FreeStartButton className="w-full sm:w-auto" size="sm" primary={freeStartPrimary} label="Gratis starten" onReady={(p) => navigate(firstBotFor(p.id), { from: page })} />
          </li>
        )}
        {localMissing && <LocalModelMissing onFound={onLocalFound} />}
      </ul>
      {children}
    </Card>
  );
}
