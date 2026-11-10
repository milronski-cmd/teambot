import { useEffect, useState } from 'react';
import { AlertTriangle, Brain, Eye, Gauge, MemoryStick, Wallet, Wrench } from 'lucide-react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { t, translate, uiLocale } from '../lib/i18n';
import { formatCompact, formatMoney } from '../lib/format';
import type { ModelInfo, ProviderView } from '../lib/types';
import { toastError } from './ui';
import { Listbox } from './Listbox';
import { MoreInfo } from './MoreInfo';

/** Thinking levels in words (C-11); the server says which ones a model takes. */
export const REASONING_LABELS: Record<string, string> = {
  none: 'Uit (niet nadenken)',
  minimal: 'Minimaal',
  low: 'Laag (snel, goedkoop)',
  medium: 'Middel',
  on: 'Aan',
  high: 'Hoog (grondig)',
  xhigh: 'Extra hoog',
  max: 'Maximaal (traagst, duurst)',
};

/** Levels to offer: the model's own list; unknown → the common three. */
export function levelsFor(m: ModelInfo | undefined): { levels: string[]; known: boolean } {
  if (m && Array.isArray(m.reasoningLevels)) return { levels: m.reasoningLevels, known: true };
  return { levels: ['low', 'medium', 'high'], known: false };
}

/** The model a bot really runs on: its own choice, else the provider's or engine's default. */
export function effectiveModel(models: ModelInfo[], model: string | undefined, provider?: ProviderView): ModelInfo | undefined {
  const id = model || provider?.config?.defaultModel || (models.some((m) => m.id === 'default') ? 'default' : models.find((m) => m.recommended)?.id) || '';
  return models.find((m) => m.id === id);
}

/** Context sizes are powers of two: 16384 tokens reads "16K" (nl), "16k" (en), in the reader's notation. */
const fmtTokens = (n: number) => formatCompact(n >= 1_000_000 ? n : n >= 1000 ? Math.round(n / 1024) * 1000 : n);
const fmtDate = (iso?: string) => {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(uiLocale(), { day: 'numeric', month: 'short', year: 'numeric' });
  } catch {
    return iso;
  }
};
// In the reader's own notation: "US$ 1,25" in Dutch, "$1.25" in English (C-17).
const fmtPrice = (n: number) => {
  const d = n >= 0.1 ? 2 : 3;
  return formatMoney(n, 'USD', { minimumFractionDigits: d, maximumFractionDigits: d });
};
// t(): single lowercase words are only extracted from explicit calls ("Tools: ja" stayed Dutch in English).
const yes = (v: boolean | undefined) => (v === undefined ? '' : v ? t('ja') : t('nee'));

const PRICE_SOURCE: Record<string, string> = { lijst: 'modellenlijst van de provider', tabel: 'prijspagina van de provider', catalogus: 'models.dev', eigen: 'je eigen prijs', gratis: 'gratis' };

/**
 * What the chosen model can do (C-01): tools, images, context window, price with where it comes from and how recent.
 * Only what is known is shown (never a guess, and no rows of "onbekend"); with nothing known the block stays away.
 */
export function ModelFacts({ m, provider, loading }: { m: ModelInfo | undefined; provider?: ProviderView; loading?: boolean }) {
  if (!provider) return null;
  if (loading && !m)
    return (
      <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px] text-muted" data-testid="model-facts-loading" role="status">
        Modelgegevens laden…
      </div>
    );
  // A CLI bot without its own model runs on the engine's default ("Standaard van Claude Code (nu Opus 5.5)"): say who
  // picks the model, and which one it is now when the engine told us (acceptance round 5, C-01).
  const engineDefault = provider.type === 'cli' && m?.id === 'default';
  const nowModel = engineDefault ? /\(nu ([^()]+)\)\s*$/.exec(m?.label || '')?.[1] : undefined;
  const engineName = provider.kindLabel || provider.name;
  const chooser = !engineDefault ? '' : nowModel ? t('{0} kiest zelf het model; nu is dat {1}.', engineName, nowModel) : t('{0} kiest zelf welk model het gebruikt.', engineName);
  // A price the owner set himself (Providers › Prijzen) is what TeamBot counts, also on a local engine or an own
  // endpoint: show it with that source (acceptance round 5, C-12: "Prijs: onbekend" with an own price).
  const own = m?.priceSource === 'eigen' && !!m.price;
  const sub = !own && provider.type === 'cli' && provider.billing !== 'free' && m?.billing !== 'paid';
  const local = !own && provider.billing === 'local';
  // A free model (OpenCode's "big-pickle", ":free" models) says so in its list entry as billing "free".
  const free = !own && (!!m?.free || m?.billing === 'free');
  const ownSource = provider.own === false ? 'eigen prijs, ingesteld door de eigenaar van deze provider' : PRICE_SOURCE.eigen;
  const sourceOf = (s?: string) => (s === 'eigen' ? ownSource : PRICE_SOURCE[s || ''] || '');
  const price = free || local ? 'gratis' : sub ? 'via je abonnement' : m?.price ? `${fmtPrice(m.price[0])} in / ${fmtPrice(m.price[1])} uit per 1M tokens` : '';
  const priceSrc = free || local ? (local ? 'draait op je eigen computer' : '') : sub ? '' : m?.price ? [sourceOf(m.priceSource) ? translate(sourceOf(m.priceSource)) : '', m.priceChecked ? t('stand {0}', fmtDate(m.priceChecked)) : ''].filter(Boolean).join(', ') : '';
  const all: { icon: React.ReactNode; label: string; value: string; note?: string }[] = [
    { icon: <Wrench className="h-3.5 w-3.5" />, label: 'Tools', value: yes(m?.tools) },
    { icon: <Eye className="h-3.5 w-3.5" />, label: 'Afbeeldingen', value: yes(m?.vision) },
    { icon: <Gauge className="h-3.5 w-3.5" />, label: 'Context', value: m?.context ? `${m.context.toLocaleString(uiLocale())} tokens` : '', note: m?.loadedContext ? `nu geladen met ${fmtTokens(m.loadedContext)}` : undefined },
    { icon: <Brain className="h-3.5 w-3.5" />, label: 'Denkniveaus', value: !m || !Array.isArray(m.reasoningLevels) ? '' : m.reasoningLevels.length ? m.reasoningLevels.map((l) => translate(REASONING_LABELS[l] || l).replace(/ \(.*\)$/, '').toLocaleLowerCase(uiLocale())).join(', ') : 'geen' },
    { icon: <Wallet className="h-3.5 w-3.5" />, label: 'Prijs', value: price, note: priceSrc || undefined },
  ];
  const from = m?.capSource ? (/^https?:/.test(m.capSource) ? translate('documentatie van de maker') : m.capSource) : '';
  const source = m?.capSource ? (m.capChecked ? t('Gegevens: {0}, gecontroleerd {1}.', from, fmtDate(m.capChecked)) : t('Gegevens: {0}.', from)) : '';
  const rows = all.filter((r) => r.value);
  if (!rows.length && !chooser) return null;
  return (
    <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-[13px]" data-testid="model-facts">
      {chooser && <p className="mb-1.5 font-medium">{chooser}</p>}
      <dl className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
        {rows.map((r) => (
          <div key={r.label} className="flex min-w-0 items-start gap-1.5">
            <span className="mt-0.5 shrink-0 text-muted" aria-hidden>
              {r.icon}
            </span>
            <dt className="shrink-0 text-muted">{r.label}:</dt>
            <dd className="min-w-0 font-medium">
              {r.value}
              {r.note && <span className="block text-[11.5px] font-normal text-muted">{r.note}</span>}
            </dd>
          </div>
        ))}
      </dl>
      {source && <p className="mt-1.5 text-[11.5px] text-muted">{source}</p>}
    </div>
  );
}

const STEPS = [4096, 8192, 16384, 32768, 65536, 131072, 262144];
const RECOMMENDED = 16384;
const gb = (bytes: number) => (bytes / 1e9).toLocaleString(uiLocale(), { maximumFractionDigits: bytes < 1e9 ? 2 : 1 });

/**
 * Context window for a local model (C-13): Ollama per chat, LM Studio when it loads the model; llama.cpp fixes it at
 * start. Saved right away for this model on this computer, with an estimate of the extra memory and a warning.
 */
export function ContextWindowField({ provider, m }: { provider: ProviderView; m: ModelInfo | undefined }) {
  const saved: number | undefined = m ? provider.config?.contextWindows?.[m.id] : undefined;
  const [value, setValue] = useState<number | ''>(saved ?? '');
  useEffect(() => setValue(saved ?? ''), [saved, m?.id]);
  if (provider.kind === 'llamacpp') {
    return (
      <div className="rounded-xl border border-line px-3 py-2.5 text-[13px]" data-testid="context-window">
        <div className="font-medium">Contextvenster</div>
        <p className="mt-0.5 text-muted">
          llama.cpp kiest het contextvenster bij het starten van de server{m?.loadedContext ? ` (nu ${m.loadedContext.toLocaleString(uiLocale())} tokens)` : ''}. Wil je een ander venster, start de server dan opnieuw met bijvoorbeeld <code translate="no">-c 32768</code>. Een groter venster gebruikt meer geheugen.
        </p>
      </div>
    );
  }
  if (provider.kind !== 'ollama' && provider.kind !== 'lmstudio') return null;
  const max = m?.context;
  const options = STEPS.filter((n) => !max || n <= max);
  if (max && !options.includes(max) && max <= 4_194_304) options.push(max);
  const per = m?.memPerToken;
  const extra = (n: number) => (per ? ` · ±${gb(n * per)} GB geheugen` : '');
  const chosen = typeof value === 'number' ? value : undefined;
  const big = chosen !== undefined && ((per && chosen * per > 4e9) || chosen > 65536);
  const small = chosen !== undefined && chosen < 8192;
  const save = async (n: number | '') => {
    if (!m) return;
    const prev = value;
    setValue(n);
    try {
      await api.put(`/providers/${provider.id}/context-window`, { model: m.id, tokens: n === '' ? null : n });
      await useApp.getState().refreshProviders();
    } catch (e) {
      setValue(prev);
      toastError(e);
    }
  };
  return (
    <div className="space-y-1.5 rounded-xl border border-line px-3 py-2.5 text-[13px]" data-testid="context-window">
      <div className="flex flex-wrap items-center gap-2">
        <span className="flex items-center gap-1.5 font-medium">
          <MemoryStick className="h-3.5 w-3.5 text-muted" aria-hidden /> Contextvenster
        </span>
        <Listbox
          className="h-8 min-w-0 flex-1 basis-56"
          value={value === '' ? '' : String(value)}
          disabled={!m}
          onChange={(v) => save(v ? Number(v) : '')}
          aria-label="Contextvenster"
          options={[
            { value: '', label: translate(provider.kind === 'ollama' ? 'Instelling van Ollama' : 'Instelling van LM Studio') + (m?.loadedContext ? ` (${t('nu {0}', fmtTokens(m.loadedContext))})` : '') },
            ...options.map((n) => ({ value: String(n), label: `${fmtTokens(n)} tokens${n === RECOMMENDED ? ` ${translate('(aanbevolen)')}` : ''}${n === max ? ` ${translate('(maximum)')}` : ''}${extra(n)}` })),
          ]}
        />
      </div>
      <p className="text-[12px] text-muted">
        Hoeveel tekst het model tegelijk onthoudt.{' '}
        <MoreInfo>
          Instructies, tools en gesprek samen. Voor bots met tools is {fmtTokens(RECOMMENDED)} een goed begin. Geldt voor dit model op deze computer{provider.kind === 'lmstudio' ? '; LM Studio laadt het model dan opnieuw' : ''}.
        </MoreInfo>
      </p>
      {(big || small) && (
        <p className="flex items-start gap-1.5 text-[12px] text-warn" role="note">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          {big
            ? `Een groot venster gebruikt veel extra geheugen${per && chosen ? ` (±${gb(chosen * per)} GB bovenop het model)` : ''}. Is dat meer dan je computer vrij heeft, dan wordt het model traag of laadt het niet.`
            : 'Een klein venster is snel, maar de bot vergeet dan sneller het begin van het gesprek en lange instructies.'}
        </p>
      )}
    </div>
  );
}
