import { useEffect, useLayoutEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Cpu, ExternalLink, KeyRound, Plug, Plus, RefreshCw, Search, Terminal, Trash2 } from 'lucide-react';
import { MoreOptions } from '../components/MoreOptions';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { t, translate, uiLocale } from '../lib/i18n';
import { prettyModel } from '../lib/modelLabel';
import { query } from '../lib/router';
import { formatTokens, formatUsd } from '../lib/format';
import { BILLING_LABEL, type ModelInfo, type ProviderKindView, type ProviderTestResult, type ProviderView } from '../lib/types';
import { askConfirm, Badge, Button, Card, Field, Input, Modal, Select, Spinner, Toggle, cx, toast, toastError, useAsync } from '../components/ui';
import { ProviderMark } from '../components/ProviderMark';
import { markOf } from '../modules/usage/meter';
import { Fold } from '../components/overview';
import { ConnectCard, ConnectResult } from '../components/ConnectCard';
import { LocalModelsCard } from '../modules/local-models';
import { useAdvanced } from '../shell/advanced';
import { KeyPaste } from './welcome/StartOptions';

/** The four sections of "Andere AI toevoegen". */
export const SECTIONS: { id: NonNullable<ProviderKindView['section']>; label: string; hint: string }[] = [
  { id: 'free', label: 'Gratis', hint: 'Gratis modellen of een gratis versie; meestal wel een account en sleutel nodig.' },
  { id: 'subscription', label: 'Via je abonnement', hint: 'Het officiële programma van de maker, met je eigen login.' },
  { id: 'local', label: 'Lokaal', hint: 'Draait op je eigen computer: gratis en je gegevens blijven hier.' },
  { id: 'key', label: 'Met API-sleutel', hint: 'Je betaalt de dienst rechtstreeks per gebruik.' },
];

/** Section of a kind (CLI engines have none of their own: free when the CLI has free models, else subscription). */
export function sectionOf(k: Pick<ProviderKindView, 'section' | 'type' | 'billing' | 'group'>): NonNullable<ProviderKindView['section']> {
  if (k.section) return k.section;
  if (k.type === 'cli') return k.billing === 'free' ? 'free' : 'subscription';
  return k.group === 'local' ? 'local' : k.group === 'free' ? 'free' : 'key';
}

const fmtDate = (d?: string) => {
  if (!d) return '';
  const t = Date.parse(d);
  return isNaN(t) ? d : new Date(t).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
};
const fmtPrice = (n: number) => formatUsd(n, { min: 0, max: n !== 0 && n < 0.01 ? 4 : n < 1 ? 3 : 2 });
const fmtCtx = (n?: number) => (n ? formatTokens(n) : '');

export function useProviderKinds(detect = false) {
  const [kinds, setKinds] = useState<ProviderKindView[] | null>(null);
  const [err, setErr] = useState('');
  const load = () => {
    setErr('');
    api
      .get<ProviderKindView[]>(`/provider-kinds${detect ? '?detect=1' : ''}`)
      .then(setKinds)
      .catch((e) => setErr(e.message));
  };
  useEffect(load, [detect]);
  return { kinds, err, reload: load };
}

/** Pick a model from the live list: free and recommended ones on top, price and context shown. */
function ModelPicker({ models, value, onPick }: { models: ModelInfo[]; value: string; onPick(id: string): void }) {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const f = models.filter((m) => !q || (m.id + ' ' + (m.label || '')).toLowerCase().includes(q.toLowerCase()));
    const rank = (m: ModelInfo) => (m.recommended ? 0 : m.free ? 1 : 2);
    return [...f].sort((a, b) => rank(a) - rank(b) || a.id.localeCompare(b.id)).slice(0, 200);
  }, [models, q]);
  const priced = models.filter((m) => m.price && m.priceSource === 'lijst').length;
  return (
    <div className="rounded-lg border border-line">
      <div className="flex items-center gap-2 border-b border-line px-2 py-1.5">
        <Search className="h-3.5 w-3.5 text-muted" aria-hidden />
        <input className="min-w-0 flex-1 bg-transparent text-sm outline-none" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t('{0, plural, one {Zoek in # model…} other {Zoek in # modellen…}}', models.length)} aria-label="Zoek model" />
      </div>
      <ul className="max-h-56 overflow-y-auto py-1" aria-label="Beschikbare modellen">
        {list.map((m) => (
          <li key={m.id}>
            <button type="button" onClick={() => onPick(m.id)} aria-pressed={value === m.id} className={cx('flex w-full flex-wrap items-center gap-1.5 px-2.5 py-1.5 text-left text-xs hover:bg-surface-2', value === m.id && 'bg-surface-2')}>
              <span className="min-w-0 break-all font-mono">{m.id}</span>
              {m.recommended && <Badge tone="accent">aanbevolen</Badge>}
              {m.free && <Badge tone="ok">gratis</Badge>}
              {!m.free && m.price && (
                <span className="text-muted">
                  {fmtPrice(m.price[0])} / {fmtPrice(m.price[1])} per 1M{(m.priceSource === 'tabel' || m.priceSource === 'catalogus') && m.priceChecked ? ` (stand ${fmtDate(m.priceChecked)})` : ''}
                </span>
              )}
              {!m.free && !m.price && <span className="text-muted">prijs onbekend</span>}
              <span className="text-muted">· {m.context ? `${fmtCtx(m.context)} context` : 'context onbekend'}</span>
              {m.tools !== undefined && <span className="text-muted">· {m.tools ? 'tools' : 'geen tools'}</span>}
              {m.vision !== undefined && <span className="text-muted">· {m.vision ? 'beeld' : 'geen beeld'}</span>}
            </button>
          </li>
        ))}
        {!list.length && <li className="px-2.5 py-2 text-xs text-muted">Geen model gevonden.</li>}
      </ul>
      <div className="border-t border-line px-2.5 py-1 text-[11px] text-muted">
        {priced
          ? 'Prijzen live uit de modellenlijst van de provider (USD per 1 miljoen tokens in / uit).'
          : 'Deze provider publiceert geen prijzen in zijn modellenlijst: alleen een gedateerde prijs uit de TeamBot-tabel, anders "onbekend". Eigen prijzen vul je later in bij "Prijzen".'}
      </div>
    </div>
  );
}

/** Outcome of a check or test: "Verbinding werkt", or the error with one next step. */
export function TestResult({ r }: { r: ProviderTestResult }) {
  return r.ok ? (
    <ConnectResult ok next={r.credit || undefined} />
  ) : (
    <ConnectResult ok={false} next={r.hint || r.credit || undefined}>
      {r.detail}
    </ConnectResult>
  );
}

const firstSentence = (s: string) => (s.match(/^.*?[.!?](?=\s|$)/)?.[0] || s).trim();
const failed = (e: any): ProviderTestResult => ({ ok: false, detail: e?.message || String(e) });

/**
 * The whole connection in one go: check for free (model list or credit), take the recommended model, connect, test.
 * Nothing is connected when the check fails, so a wrong key leaves nothing behind.
 */
export async function connectKind(
  kind: ProviderKindView,
  o: { apiKey?: string; base_url?: string; config?: Record<string, any>; name?: string; shared?: boolean } = {},
): Promise<{ provider?: ProviderView; test: ProviderTestResult; models?: ModelInfo[] }> {
  if (kind.type === 'cli') {
    const r = await api.post<{ provider: ProviderView; test?: ProviderTestResult }>(`/cli-agents/${kind.id}/connect`, {});
    await useApp.getState().refreshProviders();
    return { provider: r.provider, test: r.test || { ok: true, detail: '' } };
  }
  const check = await api.post<ProviderTestResult>(`/provider-kinds/${kind.id}/check`, { apiKey: o.apiKey || undefined, base_url: o.base_url, config: o.config }).catch(failed);
  if (!check.ok) return { test: check, models: [] };
  const models = check.models || [];
  const has = (id?: string) => !!id && (!models.length || models.some((m) => m.id === id));
  const model = o.config?.defaultModel || models.find((m) => m.recommended)?.id || (has(kind.defaultModel) ? kind.defaultModel : (models.find((m) => !/embed|rerank|bge-|minilm|whisper|tts/i.test(m.id)) || models[0])?.id);
  const config = { ...(o.config || {}), ...(model ? { defaultModel: model } : {}) };
  const p = await api.post<ProviderView>('/providers', { kind: kind.id, name: o.name || kind.label, base_url: o.base_url, apiKey: o.apiKey || undefined, config: Object.keys(config).length ? config : undefined, shared: o.shared });
  await useApp.getState().refreshProviders();
  useApp.getState().load();
  const test = await api.post<ProviderTestResult>(`/providers/${p.id}/test`).catch(failed);
  return { provider: p, test, models };
}

/**
 * Modal to connect one service: the key (and only what the service really needs) and ONE button that checks, takes the
 * recommended model, connects and tests. Name, address, model, costs and sharing are under "Meer opties".
 */
export function ConnectProvider({ kind, open, onClose, onDone, onRecheck }: { kind: ProviderKindView | null; open: boolean; onClose(): void; onDone?(p: ProviderView): void; onRecheck?(): void }) {
  const me = useApp((s) => s.me);
  const [f, setF] = useState({ name: '', base_url: '', apiKey: '', defaultModel: '', shared: false });
  const [extra, setExtra] = useState<Record<string, string>>({});
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const a = useAsync();
  // Before the first paint: the dialog of the next provider never shows (or keeps) the name or key of the previous one.
  useLayoutEffect(() => {
    if (kind) {
      setF({ name: kind.label, base_url: kind.status?.baseUrl || kind.baseUrl || '', apiKey: '', defaultModel: '', shared: false });
      setExtra(Object.fromEntries((kind.fields || []).filter((x) => x.options?.length).map((x) => [x.key, x.options![0].value])));
    }
    setResult(null);
    setModels([]);
  }, [kind?.id, open]);
  if (!kind) return null;
  const custom = kind.group === 'custom';
  const local = sectionOf(kind) === 'local';
  const urlField = (kind.fields || []).find((x) => x.key === 'base_url');
  const hasUrl = kind.type === 'api' && (custom || local || !!urlField);
  // The address is asked up front only when there is no default that works (own endpoint, a required address).
  const urlUpFront = hasUrl && (custom || !!urlField?.required);
  const needsKeyNow = kind.needsKey && !kind.keyOptional;
  const fields = (kind.fields || []).filter((x) => x.key !== 'base_url');
  const required = fields.filter((x) => x.required);
  const optional = fields.filter((x) => !x.required);
  const notFound = local && kind.canDetect && kind.status && !kind.status.installed;
  const config = () => {
    const out: Record<string, any> = {};
    for (const [k, v] of Object.entries(extra)) if (String(v).trim()) out[k] = String(v).trim();
    if (f.defaultModel.trim()) out.defaultModel = f.defaultModel.trim();
    return Object.keys(out).length ? out : undefined;
  };
  const missing = () => {
    if (needsKeyNow && !f.apiKey.trim()) return `Vul je ${(kind.keyLabel || 'API-sleutel').toLowerCase()} in`;
    for (const x of kind.fields || []) if (x.required && !String(x.key === 'base_url' ? f.base_url : extra[x.key] || '').trim()) return `Vul "${x.label}" in`;
    return '';
  };
  const connect = () =>
    a.run(async () => {
      const m = missing();
      if (m) return setResult({ ok: false, detail: m });
      const r = await connectKind(kind, { apiKey: f.apiKey.trim(), base_url: hasUrl ? f.base_url : undefined, config: config(), name: f.name, shared: f.shared }).catch((e) => ({ test: failed(e) }) as Awaited<ReturnType<typeof connectKind>>);
      setResult(r.test);
      if (r.models?.length) setModels(r.models);
      if (r.provider && r.test.ok) {
        toast(t('{0} gekoppeld', r.provider.name), 'ok');
        onDone?.(r.provider);
      }
    });
  const field = (x: NonNullable<ProviderKindView['fields']>[number]) => (
    <Field key={x.key} label={x.required ? x.label : `${x.label} (optioneel)`} hint={x.hint}>
      {x.options?.length ? (
        <Select value={extra[x.key] || ''} onChange={(e) => { const v = e.target.value; setExtra((o) => ({ ...o, [x.key]: v })); }} aria-label={x.label}>
          {x.options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </Select>
      ) : (
        <Input value={extra[x.key] || ''} onChange={(e) => { const v = e.target.value; setExtra((o) => ({ ...o, [x.key]: v })); }} placeholder={x.placeholder} aria-label={x.label} />
      )}
    </Field>
  );
  const urlInput = (
    <Field label={urlField?.label || 'Adres (base URL)'} hint={urlField?.hint || (kind.baseUrl ? `Standaard: ${kind.baseUrl}` : 'Bijv. https://jouw-server/v1')}>
      <Input value={f.base_url} onChange={(e) => { const v = e.target.value; setF((x) => ({ ...x, base_url: v })); }} placeholder={urlField?.placeholder || kind.baseUrl || 'https://…/v1'} />
    </Field>
  );
  const keyInput = (
    <Field
      label={`${kind.keyLabel || 'API-sleutel'}${kind.keyOptional ? ' (optioneel)' : ''}`}
      hint={
        kind.keyUrl && (
          <a className="inline-flex items-center gap-0.5 underline" href={kind.keyUrl} target="_blank" rel="noreferrer">
            Sleutel aanmaken <ExternalLink className="h-3 w-3" aria-hidden />
          </a>
        )
      }
    >
      <Input type="password" autoComplete="off" value={f.apiKey} onChange={(e) => { const v = e.target.value; setF((x) => ({ ...x, apiKey: v })); }} placeholder={kind.keyPlaceholder || 'Plak hier je sleutel'} />
    </Field>
  );
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${kind.label} koppelen`}
      footer={
        result?.ok ? (
          <Button variant="primary" onClick={onClose}>
            Klaar
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Annuleren
            </Button>
            <Button variant="primary" loading={a.busy} onClick={connect}>
              Koppelen en testen
            </Button>
          </>
        )
      }
    >
      <div className="space-y-4 text-sm">
        <p className="text-muted">{firstSentence(kind.description)}</p>
        {notFound && (
          <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 px-3 py-2" data-testid={kind.id === 'ollama' ? 'ollama-setup' : undefined}>
            <span className="min-w-0 flex-1 basis-48">{t('{0} draait nog niet op deze computer.', kind.label)}</span>
            {kind.id === 'ollama' && (
              <a className="inline-flex h-8 items-center gap-1 rounded-lg bg-accent px-3 text-[13px] font-semibold text-accent-fg hover:opacity-90 coarse:h-11" href="https://ollama.com/download" target="_blank" rel="noreferrer">
                Ollama downloaden <ExternalLink className="h-3.5 w-3.5" aria-hidden />
              </a>
            )}
            {onRecheck && (
              <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={onRecheck}>
                Opnieuw zoeken
              </Button>
            )}
          </div>
        )}
        {urlUpFront && urlInput}
        {required.map(field)}
        {needsKeyNow && keyInput}
        {result && <TestResult r={result} />}
        <details className="group rounded-xl border border-line" open={custom || undefined} data-testid="connect-more">
          <summary className="flex min-h-10 cursor-pointer list-none items-center gap-2 px-3 text-sm font-semibold [&::-webkit-details-marker]:hidden">
            <ChevronDown className="h-4 w-4 text-muted transition-transform [details[open]>summary_&]:rotate-180" aria-hidden />
            Meer opties
          </summary>
          <div className="space-y-4 border-t border-line p-3">
            <Field label="Naam">
              <Input value={f.name} onChange={(e) => { const v = e.target.value; setF((x) => ({ ...x, name: v })); }} />
            </Field>
            {hasUrl && !urlUpFront && urlInput}
            {optional.map(field)}
            {kind.keyOptional && keyInput}
            {models.length > 0 && <ModelPicker models={models} value={f.defaultModel} onPick={(id) => setF((x) => ({ ...x, defaultModel: id }))} />}
            <Field label="Standaardmodel" hint="Leeg = het aanbevolen model. Kan later per bot anders.">
              <Input list={`models-${kind.id}`} placeholder={kind.defaultModel || undefined} value={f.defaultModel} onChange={(e) => { const v = e.target.value; setF((x) => ({ ...x, defaultModel: v })); }} />
              <datalist id={`models-${kind.id}`}>
                {(models.length ? models.map((m) => m.id) : kind.models || []).map((m) => (
                  <option key={m} value={m} />
                ))}
              </datalist>
            </Field>
            {(kind.costNote || kind.billingNote) && (
              <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs">
                <div>
                  <span className="font-semibold">Kosten: </span>
                  {kind.costNote || kind.billingNote}
                  {kind.costCheckedAt && <span className="text-muted"> (gecontroleerd {fmtDate(kind.costCheckedAt)})</span>}
                </div>
                {kind.costNote && kind.billingNote && <div className="mt-1 text-muted">{kind.billingNote}</div>}
                {kind.pricingUrl && (
                  <a className="mt-1 inline-flex items-center gap-0.5 underline" href={kind.pricingUrl} target="_blank" rel="noreferrer">
                    Prijzen bij de dienst <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                )}
              </div>
            )}
            {kind.authNote && <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs">{kind.authNote}</p>}
            {kind.experimental && <p className="text-xs text-muted">Gebouwd volgens de documentatie van de maker; nog niet met de echte dienst geprobeerd.</p>}
            <p className="text-xs text-muted">Je sleutel wordt versleuteld opgeslagen en nooit getoond of gelogd. De controle is gratis: alleen de modellenlijst of het tegoed.</p>
            {me?.role !== 'member' && useApp.getState().mode === 'server' && (
              <Toggle checked={f.shared} onChange={(v) => setF((x) => ({ ...x, shared: v }))} label="Delen met alle gebruikers van deze server (zij zien de sleutel niet)" />
            )}
          </div>
        </details>
      </div>
    </Modal>
  );
}

interface CatalogView {
  fetched: string;
  refresh: boolean;
  canEdit: boolean;
}

/**
 * Modelgegevens (0.4.4): where context windows, prices and capabilities come from after the provider's own list
 * (models.dev, with its date), and the optional daily refresh (off by default: it reaches models.dev).
 */
function ModelCatalogCard() {
  const [s, setS] = useState<CatalogView | null>(null);
  const [err, setErr] = useState(false);
  useEffect(() => {
    api.get<CatalogView>('/model-catalog').then(setS, () => setErr(true));
  }, []);
  if (err) return null;
  if (!s) return <Spinner />;
  return (
    <Card className="p-4" data-testid="model-catalog">
      <h2 className="font-semibold">Modelgegevens</h2>
      <p className="mt-0.5 text-sm text-muted">{t('Contextvenster, prijs en mogelijkheden komen van de provider, aangevuld uit models.dev.', fmtDate(s.fetched))}</p>
      {s.canEdit && (
        <div className="mt-2">
          <Toggle
            checked={s.refresh}
            onChange={async (v) => {
              try {
                setS(await api.put<CatalogView>('/model-catalog', { refresh: v }));
              } catch (e) {
                toastError(e);
              }
            }}
            label="Elke dag bijwerken via models.dev"
          />
        </div>
      )}
    </Card>
  );
}

/** Found on this pc and not connected yet: one click connects and tests it. */
function FoundCard({ kind, onChanged }: { kind: ProviderKindView; onChanged(): void }) {
  const [result, setResult] = useState<ProviderTestResult | null>(null);
  const a = useAsync();
  const loggedOut = kind.type === 'cli' && kind.status?.loggedIn === false;
  const connect = () =>
    a.run(async () => {
      // Ollama: the installed model that fits this pc best (the same advice as under "Lokale modellen").
      const advice = kind.id === 'ollama' ? await api.get<{ recommended?: { id: string; installed?: boolean } | null }>('/local-models').catch(() => null) : null;
      const config = advice?.recommended?.installed ? { defaultModel: advice.recommended.id } : undefined;
      const r = await connectKind(kind, { base_url: kind.status?.baseUrl && kind.status.baseUrl !== kind.baseUrl ? kind.status.baseUrl : undefined, config }).catch((e) => ({ test: failed(e) }) as Awaited<ReturnType<typeof connectKind>>);
      setResult(r.test);
      // Connected: the card moves to "Gekoppelde AI" (which shows the test itself).
      if (r.provider) onChanged();
    });
  return (
    <ConnectCard
      data-testid={`found-${kind.id}`}
      icon={kind.type === 'cli' ? <Terminal aria-hidden /> : <Cpu aria-hidden />}
      title={kind.label}
      line={loggedOut ? 'Staat op deze pc; nog niet ingelogd.' : kind.type === 'cli' ? 'Staat op deze pc, met je eigen login.' : 'Draait op deze pc: gratis, je gegevens blijven hier.'}
      state={a.busy ? 'busy' : result && !result.ok ? 'error' : 'off'}
      stateLabel={a.busy || (result && !result.ok) ? undefined : loggedOut ? 'niet ingelogd' : 'gevonden'}
      action={
        loggedOut ? (
          <a className="inline-flex h-8 items-center rounded-lg bg-accent px-3 text-[13px] font-semibold text-accent-fg hover:opacity-90 coarse:h-11" href="#/settings/cli-agents-cli">
            Inloggen
          </a>
        ) : (
          <Button size="sm" variant="primary" icon={<Plug className="h-4 w-4" />} loading={a.busy} onClick={connect}>
            Koppelen
          </Button>
        )
      }
      result={result && !result.ok && <TestResult r={result} />}
    />
  );
}

/** A connected AI: its state comes from a (free) test, run when the page opens and on "Test". */
function ConnectedCard({ p, isDefault, justTested, onKey, onPrices, onPolicy }: { p: ProviderView; isDefault: boolean; justTested?: boolean; onKey(): void; onPrices(): void; onPolicy(): void }) {
  const [r, setR] = useState<ProviderTestResult | 'busy' | null>(null);
  const [shown, setShown] = useState(!!justTested);
  const test = async (show: boolean) => {
    setR('busy');
    const res = await api.post<ProviderTestResult>(`/providers/${p.id}/test`).catch(failed);
    setR(res);
    setShown(show || !res.ok);
  };
  useEffect(() => {
    if (p.enabled) void test(!!justTested);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [p.id]);
  const facts = [p.kindLabel !== p.name ? p.kindLabel : '', p.billing ? translate(BILLING_LABEL[p.billing]) : '', p.config?.defaultModel ? prettyModel(p.config.defaultModel) : '', isDefault ? translate('standaard') : '', p.shared ? translate('gedeeld') : ''].filter(Boolean);
  return (
    <ConnectCard
      data-testid={`connected-${p.kind}`}
      icon={(() => {
        const mark = markOf(p.kind, p.name);
        return mark ? <ProviderMark id={mark} size={18} /> : p.type === 'cli' ? <Terminal aria-hidden /> : p.billing === 'local' ? <Cpu aria-hidden /> : <KeyRound aria-hidden />;
      })()}
      title={p.name}
      line={facts.join(' · ')}
      state={!p.enabled ? 'off' : r === 'busy' ? 'busy' : r && !r.ok ? 'error' : 'on'}
      stateLabel={!p.enabled ? 'uit' : r === 'busy' ? 'testen' : undefined}
      action={
        p.own && (
          <Button size="sm" loading={r === 'busy'} onClick={() => test(true)}>
            Test
          </Button>
        )
      }
      result={shown && r && r !== 'busy' && <TestResult r={r} />}
      more={
        p.own && (
          <div className="flex flex-wrap gap-1.5">
            {!isDefault && (
              <Button size="sm" variant="ghost" onClick={() => api.put('/settings', { defaultProvider: p.id, defaultModel: p.config?.defaultModel || '' }).catch(toastError)}>
                Als standaard
              </Button>
            )}
            {p.type === 'api' && (
              <Button size="sm" variant="ghost" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={onKey}>
                Sleutel
              </Button>
            )}
            {p.type === 'api' && (
              <Button size="sm" variant="ghost" onClick={onPrices}>
                Prijzen
              </Button>
            )}
            {p.shared && (
              <Button size="sm" variant="ghost" onClick={onPolicy}>
                Beleid voor leden
              </Button>
            )}
            <Button
              size="sm"
              variant="ghost"
              icon={<Trash2 className="h-3.5 w-3.5" />}
              aria-label={`${p.name} ontkoppelen`}
              onClick={async () => {
                if (!(await askConfirm(`${p.name} ontkoppelen? De sleutel wordt gewist.`, { danger: true }))) return;
                try {
                  const res = await api.del<{ agentsWithoutProvider: string[] }>(`/providers/${p.id}`);
                  useApp.setState((s) => ({ providers: s.providers.filter((x) => x.id !== p.id) }));
                  if (res.agentsWithoutProvider.length) toast(`Let op: ${res.agentsWithoutProvider.join(', ')} heeft nu geen provider`, 'neutral');
                } catch (e) {
                  toastError(e);
                }
              }}
            >
              Ontkoppelen
            </Button>
          </div>
        )
      }
    />
  );
}

export function ProvidersSettings() {
  const providers = useApp((s) => s.providers);
  const settings = useApp((s) => s.settings);
  const advanced = useAdvanced();
  const { kinds, err, reload } = useProviderKinds(true);
  const [pickId, setPickId] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [editKey, setEditKey] = useState<ProviderView | null>(null);
  const [prices, setPrices] = useState<ProviderView | null>(null);
  const [policy, setPolicy] = useState<ProviderView | null>(null);
  const [newKey, setNewKey] = useState('');
  const [fresh, setFresh] = useState<string[]>([]);
  const pick = kinds?.find((k) => k.id === pickId) || null;

  const filtered = useMemo(() => (kinds || []).filter((k) => !k.retired && (!q || (k.label + ' ' + k.description + ' ' + (k.costNote || '')).toLowerCase().includes(q.toLowerCase()))), [kinds, q]);
  // What stands ready on this pc (a program with your login, a local model server) and is not connected yet.
  const found = useMemo(() => {
    const taken = new Set(providers.map((p) => (p.base_url || '').replace(/\/+$/, '')).filter(Boolean));
    return (kinds || []).filter((k) => !k.retired && k.status?.installed && (k.type === 'cli' || !k.needsKey) && !providers.some((p) => p.kind === k.id) && !(k.status.baseUrl && taken.has(k.status.baseUrl.replace(/\/+$/, ''))));
  }, [kinds, providers]);
  // "#/settings/providers?koppel=ollama" (the "Ollama instellen" link next to "Gratis starten") opens that dialog.
  const [linked, setLinked] = useState(false);
  useEffect(() => {
    const want = query().get('koppel');
    if (!kinds || linked || !want) return;
    setLinked(true);
    if (kinds.some((x) => x.id === want)) setPickId(want);
  }, [kinds, linked]);
  // A program with your own login is set up on its own page (install, log in, connect in one go).
  const choose = (k: ProviderKindView) => (k.type === 'cli' ? void (location.hash = '#/settings/cli-agents-cli') : setPickId(k.id));

  const [adding, setAdding] = useState(false);
  const [keyOpen, setKeyOpen] = useState(false);
  const wayClass = 'flex min-h-[52px] w-full items-center gap-3 px-4 py-2 text-start transition-colors hover:bg-surface-2';
  const way = (title: string, text: string) => (
    <>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-medium">{title}</span>
        <span className="block text-xs text-muted">{text}</span>
      </span>
      <ChevronRight className="h-4 w-4 shrink-0 text-muted rtl-flip" aria-hidden />
    </>
  );
  /** "AI toevoegen": what stands ready on this pc first, then three plain ways in. */
  const addContent = (
    <div className="space-y-4">
      {found.length > 0 && (
        <div data-testid="found-here">
          <h2 className="mb-2 text-[13px] font-semibold text-muted">Gevonden op deze pc</h2>
          <div className="space-y-2">
            {found.map((k) => (
              <FoundCard key={k.id} kind={k} onChanged={reload} />
            ))}
          </div>
        </div>
      )}
      <div className="divide-y divide-line overflow-hidden rounded-card border border-line">
        <a href="#/settings/cli-agents-cli" className={wayClass} onClick={() => setAdding(false)}>
          {way('Abonnement inloggen', 'Je abonnement van Claude of ChatGPT, zonder sleutel.')}
        </a>
        <button type="button" className={wayClass} aria-expanded={keyOpen} onClick={() => setKeyOpen(!keyOpen)}>
          {way('Sleutel plakken', 'TeamBot herkent de dienst en bewaart de sleutel versleuteld.')}
        </button>
        {keyOpen && (
          <div className="p-4" data-testid="key-paste">
            <KeyPaste kinds={kinds} onConnected={(p) => (setFresh((x) => [...x, p.id]), setAdding(false), setKeyOpen(false), toast(t('{0} gekoppeld', p.name), 'ok'))} />
          </div>
        )}
        <a href="#/settings/free-models-gratis" className={wayClass} onClick={() => setAdding(false)}>
          {way('Gratis', 'Gratis modellen, zonder abonnement of sleutel.')}
        </a>
      </div>
      <button type="button" className="inline-flex items-center gap-1.5 text-xs font-medium text-muted hover:text-fg coarse:min-h-11" onClick={reload}>
        <RefreshCw className="h-3.5 w-3.5" aria-hidden /> Opnieuw zoeken op deze pc
      </button>
    </div>
  );

  return (
    <div className="space-y-4">
      {/*
        One list: what is connected (name, state, Test), and ONE button "Toevoegen" that opens the three plain ways in
        (with what was found on this pc on top). An empty install shows those ways right here.
      */}
      {providers.length === 0 ? (
        <Card className="p-5">{addContent}</Card>
      ) : (
        <>
          <div className="space-y-2" data-testid="connected-list">
            {providers.map((p) => (
              <ConnectedCard key={p.id} p={p} isDefault={settings.defaultProvider === p.id} justTested={fresh.includes(p.id)} onKey={() => (setEditKey(p), setNewKey(''))} onPrices={() => setPrices(p)} onPolicy={() => setPolicy(p)} />
            ))}
          </div>
          <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)} data-testid="add-ai">
            Toevoegen
          </Button>
          <Modal open={adding} onClose={() => setAdding(false)} title="AI toevoegen">
            {addContent}
          </Modal>
        </>
      )}

      <MoreOptions label="Lokale modellen en andere diensten">
        {/* Closed by default: a list of local models with sizes is for whoever goes looking for it. */}
        <Fold title="Lokale modellen op deze pc">
          <LocalModelsCard />
        </Fold>

        {advanced && <ModelCatalogCard />}

        {/*
          Another service: a search field and nothing else. The catalogue (60+ services) only shows what matches, one line
          per service; what it is and what it costs is said in the connect dialog, not here.
        */}
        <div>
          <div className="relative">
            <Search className="absolute start-2.5 top-2.5 h-4 w-4 text-muted" />
            <Input className="ps-8" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoek een andere dienst, bijvoorbeeld Gemini, Groq of Mistral" aria-label="Zoek een dienst" />
          </div>
          {err && <p className="mt-2 text-sm text-danger">{err}</p>}
          {!kinds && !err && q && <Spinner />}
          {q.trim() && kinds && (
            <div className="tb-in mt-2 divide-y divide-line overflow-hidden rounded-card border border-line">
              {filtered.length === 0 && <p className="px-4 py-3 text-sm text-muted">Geen dienst gevonden met die naam.</p>}
              {filtered.slice(0, 12).map((k) => {
                const connected = providers.some((p) => p.kind === k.id);
                return (
                  <button key={k.id} type="button" onClick={() => choose(k)} className="flex min-h-11 w-full items-center gap-3 px-4 py-2 text-start text-sm transition-colors hover:bg-surface-2">
                    <span className="min-w-0 flex-1 truncate font-medium">{k.label}</span>
                    {connected ? <Badge tone="accent">gekoppeld</Badge> : k.status?.installed ? <Badge tone="ok">staat op deze pc</Badge> : null}
                    <span className="shrink-0 text-xs text-muted">{connected ? "" : "Koppelen"}</span>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </MoreOptions>

      <ConnectProvider kind={pick} open={!!pick} onClose={() => setPickId(null)} onRecheck={reload} />
      <PricesModal p={prices} onClose={() => setPrices(null)} />
      <SharedPolicyModal p={policy} onClose={() => setPolicy(null)} />
      <Modal
        open={!!editKey}
        onClose={() => setEditKey(null)}
        title={`Sleutel voor ${editKey?.name}`}
        footer={
          <Button
            variant="primary"
            disabled={!newKey.trim()}
            onClick={async () => {
              try {
                await api.patch(`/providers/${editKey!.id}`, { apiKey: newKey.trim() });
                await useApp.getState().refreshProviders();
                toast('Sleutel bijgewerkt', 'ok');
                setEditKey(null);
              } catch (e) {
                toastError(e);
              }
            }}
          >
            Opslaan
          </Button>
        }
      >
        <Field label="Nieuwe API-sleutel" hint="De oude sleutel wordt overschreven. Sleutels worden nooit getoond.">
          <Input type="password" autoComplete="off" value={newKey} onChange={(e) => setNewKey(e.target.value)} />
        </Field>
      </Modal>
    </div>
  );
}

/** What other people on this server may do with a shared provider: allowed models and a daily cap per person. */
function SharedPolicyModal({ p, onClose }: { p: ProviderView | null; onClose(): void }) {
  const [models, setModels] = useState('');
  const [cap, setCap] = useState('');
  useEffect(() => {
    setModels(((p?.config?.memberModels as string[]) || []).join(', '));
    setCap(p?.config?.memberDailyUsd ? String(p.config.memberDailyUsd) : '');
  }, [p?.id]);
  const save = async () => {
    try {
      await api.patch(`/providers/${p!.id}`, { config: { memberModels: models.split(',').map((m) => m.trim()).filter(Boolean), memberDailyUsd: Number(cap.replace(',', '.')) || 0 } });
      await useApp.getState().refreshProviders();
      toast('Beleid opgeslagen', 'ok');
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Modal open={!!p} onClose={onClose} title={`Beleid voor leden: ${p?.name}`} footer={<Button variant="primary" onClick={save}>Opslaan</Button>}>
      <div className="space-y-4 text-sm">
        <p className="text-muted">Anderen op deze server gebruiken deze provider met jouw sleutel, zonder die te zien.</p>
        <Field label="Toegestane modellen" hint="Gescheiden door komma's. Leeg = alle modellen. Een bot zonder model krijgt het eerste model uit deze lijst.">
          <Input value={models} onChange={(e) => setModels(e.target.value)} placeholder="bijv. gpt-5.4-mini, gpt-5.4-nano" />
        </Field>
        <Field label="Daglimiet per persoon (USD)" hint="Wat één persoon per dag mag uitgeven. Leeg of 0 = alleen het algemene budget.">
          <Input value={cap} onChange={(e) => setCap(e.target.value)} inputMode="decimal" placeholder="0" />
        </Field>
      </div>
    </Modal>
  );
}

/** Own prices per model (USD per 1M tokens) so cost estimates and the daily budget work for every model. */
function PricesModal({ p, onClose }: { p: ProviderView | null; onClose(): void }) {
  const [text, setText] = useState('');
  useEffect(() => {
    const pr = (p?.config?.prices || {}) as Record<string, [number, number]>;
    setText(Object.entries(pr).map(([m, [i, o]]) => `${m} = ${i} / ${o}`).join('\n'));
  }, [p?.id]);
  const save = async () => {
    const prices: Record<string, [number, number]> = {};
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line) continue;
      const m = line.match(/^(.+?)\s*=\s*([\d.,]+)\s*\/\s*([\d.,]+)$/);
      if (!m) return toast(`Ongeldige regel: "${line}" — gebruik: model = invoer / uitvoer`, 'danger');
      prices[m[1].trim()] = [Number(m[2].replace(',', '.')), Number(m[3].replace(',', '.'))];
    }
    try {
      await api.patch(`/providers/${p!.id}`, { config: { prices } });
      await useApp.getState().refreshProviders();
      toast('Prijzen opgeslagen', 'ok');
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <Modal open={!!p} onClose={onClose} title={`Prijzen voor ${p?.name}`} footer={<Button variant="primary" onClick={save}>Opslaan</Button>}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          Prijzen in USD per 1 miljoen tokens (invoer / uitvoer), zoals op de prijspagina van je provider. Eén regel per model; <code>*</code> geldt voor alle andere modellen. Hiermee kloppen de kostenschattingen en werkt het dagbudget ook voor deze provider.
        </p>
        <textarea className="h-40 w-full rounded-lg border border-line bg-surface px-3 py-2 font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={'gpt-5.4-mini = 0.25 / 2\n* = 1 / 4'} aria-label="Prijzen per model" />
      </div>
    </Modal>
  );
}
