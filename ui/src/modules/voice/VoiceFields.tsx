import { useEffect, useState } from 'react';
import { Loader2, Volume2 } from 'lucide-react';
import { Button, Field, Input, Textarea, toastError } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import type { Catalog, LocalModelView, LocalView, VoiceStatus } from './api';
import { browserTtsSupported, browserVoices, onVoicesChanged } from './audio';
import { previewVoice, usePlayer } from './player';
import { getLang, t, translate } from '../../lib/i18n';
import { formatNumber, formatUsd } from '../../lib/format';

/** Reading speed in the reader's notation: "1,00" (nl), "1.00" (en). */
const speedText = (v: number | undefined) => formatNumber(v ?? 1, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
import { languageName } from '../../lib/languages';
import { baseLang } from './language';

/** Name of a language in the interface language ("Duits" in Dutch). */
export const langName = (code: string) => languageName(baseLang(code), getLang());

/** Browser voices, the interface language first; updates when the browser finishes loading them. */
export function useBrowserVoices() {
  const [list, setList] = useState<SpeechSynthesisVoice[]>(() => browserVoices());
  useEffect(() => onVoicesChanged(() => setList(browserVoices())), []);
  const mine = (v: SpeechSynthesisVoice) => Number(baseLang(v.lang) === baseLang(getLang()));
  return [...list].sort((a, b) => mine(b) - mine(a) || a.name.localeCompare(b.name));
}

/** The options of an OpenAI voice list (speech and live calls); marin and cedar are the recommended ones. */
export const openaiVoiceOptions = (voices: string[]) =>
  voices.map((v) => (
    // A voice's name ("echo", "sage") is a name, never translated.
    <option key={v} value={v} translate="no">
      {v === 'marin' || v === 'cedar' ? t('{0} (aanbevolen)', v) : v}
    </option>
  ));

/** Local voices in the order a picker shows them: the interface language first, then English, then the rest. */
export function sortVoices(models: LocalModelView[], lang = getLang()): LocalModelView[] {
  const rank = (m: LocalModelView) => (baseLang(m.lang) === baseLang(lang) ? 0 : m.lang === 'en' ? 1 : 2);
  return models
    .map((m, i) => ({ m, i }))
    .sort((a, b) => rank(a.m) - rank(b.m) || a.i - b.i)
    .map((x) => x.m);
}

export interface TtsValue {
  engine?: string;
  providerId?: string | null;
  model?: string;
  voice?: string;
  speed?: number;
  instructions?: string;
  browserVoice?: string;
  localVoice?: string;
  localSpeaker?: number;
  localVoiceEn?: string;
}

/**
 * Shared editor for a text-to-speech configuration (used for the user default and per bot).
 * `inherit` adds a "Standaard" choice that falls back to the user default.
 */
export function TtsFields({
  value,
  onChange,
  status,
  catalog,
  inherit,
  previewText,
  agentId,
  local,
  english,
  autoVoice,
  part,
}: {
  value: TtsValue;
  onChange(p: TtsValue): void;
  status: VoiceStatus;
  catalog: Catalog;
  inherit?: boolean;
  previewText: string;
  agentId?: string | null;
  /** Downloadable local voices (Piper). */
  local?: LocalView;
  /** Also choose the voice used for English text (user default only). */
  english?: boolean;
  /**
   * User default only: the voice an empty choice ("Automatisch") stands for — the voice for the interface language,
   * '' when there is none for it yet. Without this prop there is no automatic choice.
   */
  autoVoice?: string;
  /**
   * Instellingen › Meer mogelijkheden › Spraak shows this editor in two places: 'main' is the voice, the speed and "Laat horen" (the first
   * view), 'more' is the rest (which engine, provider, model, style, the voice for English; behind "Meer opties").
   * Without it everything shows together (the bot editor).
   */
  part?: 'main' | 'more';
}) {
  const main = part !== 'more';
  const more = part !== 'main';
  const voices = useBrowserVoices();
  const phase = usePlayer((s) => (s.messageId === 'preview' ? s.phase : 'idle'));
  const engine = value.engine || (inherit ? 'default' : 'auto');
  const provider = status.providers.find((p) => p.id === value.providerId) || (value.providerId ? undefined : status.providers.find((p) => p.kind === 'openai'));
  const isOpenAI = provider?.kind === 'openai';
  const model = catalog.ttsModels.find((m) => m.id === value.model) || (isOpenAI ? catalog.ttsModels[0] : undefined);
  const showProvider = engine === 'provider' || (engine === 'auto' && !!status.openai);
  const showLocal = !!local && (engine === 'local' || engine === 'auto' || (inherit && engine === 'default'));
  const voicesLocal = sortVoices((local?.models || []).filter((m) => m.kind === 'tts-voice' && m.status !== 'unsupported'));
  const auto = !inherit && autoVoice !== undefined;
  const autoModel = auto ? voicesLocal.find((m) => m.id === autoVoice) : undefined;
  const chosenLocal = voicesLocal.find((m) => m.id === value.localVoice) || (auto && !value.localVoice ? autoModel : undefined);
  const lv = (m: (typeof voicesLocal)[number]) => (m.status === 'installed' ? translate(m.label) : `${translate(m.label)} — ${translate('nog downloaden')}`);
  const showBrowser = engine === 'browser' || ((engine === 'auto' || engine === 'local') && !!status.tts.localMissing) || (inherit && engine === 'default' && !local);
  const appLang = langName(getLang());

  const preview = async () => {
    try {
      // The automatic voice is previewed as itself (not switched to a voice for the language of the sample text).
      const localVoice = value.localVoice || (auto ? autoVoice : undefined) || undefined;
      await previewVoice(previewText, agentId || null, { ...value, localVoice, engine: engine === 'default' ? undefined : engine });
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <div className="space-y-3">
      {more && (
      <Field label="Voorlezen met">
        <Select value={engine} onChange={(e) => onChange({ engine: e.target.value })}>
          {inherit && <option value="default">Standaard (Instellingen › Meer mogelijkheden › Spraak)</option>}
          <option value="local">Lokale stem op deze computer — gratis (aanbevolen)</option>
          <option value="auto">Automatisch: lokale stem, anders OpenAI-stem, anders browserstem</option>
          <option value="provider">Stem van een provider (OpenAI of eigen endpoint, betaald)</option>
          <option value="browser" disabled={!browserTtsSupported()}>
            Browserstem — gratis, lokaal
          </option>
          <option value="off">Uit</option>
        </Select>
      </Field>
      )}

      {showLocal && (main || english) && (
        <div className="grid gap-3 sm:grid-cols-2">
          {main && (
          <Field
            label="Lokale stem"
            hint={
              auto && !value.localVoice && !autoModel
                ? `Er is nog geen gratis lokale stem voor het ${appLang}; de browserstem leest voor.`
                : chosenLocal && chosenLocal.status !== 'installed'
                  ? 'Nog niet gedownload: tot dan leest de browserstem voor.'
                  : chosenLocal && more
                    ? `Licentie ${chosenLocal.licence}`
                    : undefined
            }
          >
            <Select value={value.localVoice || ''} onChange={(e) => onChange({ localVoice: e.target.value || (auto ? '' : undefined), localSpeaker: undefined })}>
              {inherit && <option value="">Standaard (Instellingen › Meer mogelijkheden › Spraak)</option>}
              {auto && <option value="">{autoModel ? `Automatisch: ${lv(autoModel)}` : `Automatisch (geen lokale stem voor het ${appLang})`}</option>}
              {voicesLocal.map((m) => (
                <option key={m.id} value={m.id}>
                  {lv(m)}
                </option>
              ))}
            </Select>
          </Field>
          )}
          {main && chosenLocal?.speakers?.length ? (
            <Field label="Spreker">
              <Select value={String(value.localSpeaker ?? chosenLocal.speakers[0].id)} onChange={(e) => onChange({ localSpeaker: Number(e.target.value) })}>
                {chosenLocal.speakers.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.label}
                  </option>
                ))}
              </Select>
            </Field>
          ) : null}
          {english && more && (
            <Field label="Engelse tekst voorlezen met" hint="TeamBot herkent de taal van een antwoord en leest Engels met deze stem voor. Andere talen: met een gedownloade stem voor die taal.">
              <Select value={value.localVoiceEn ?? ''} onChange={(e) => onChange({ localVoiceEn: e.target.value })}>
                <option value="">Dezelfde stem</option>
                {voicesLocal
                  .filter((m) => m.lang === 'en')
                  .map((m) => (
                    <option key={m.id} value={m.id}>
                      {lv(m)}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
          {!showProvider && main && (
            <Field label={t('Snelheid: {0}×', speedText(value.speed))}>
              <input type="range" min={0.5} max={2}step={0.05} value={value.speed ?? 1} onChange={(e) => onChange({ speed: Number(e.target.value) })} className="w-full accent-accent" aria-label="Snelheid" />
            </Field>
          )}
        </div>
      )}

      {/* The licence of the chosen voice: with the voice in the bot editor, here when the voice is in the first view. */}
      {part === 'more' && showLocal && chosenLocal?.status === 'installed' && <div className="text-xs text-muted">{`Licentie ${chosenLocal.licence}`}</div>}

      {showProvider && (
        <div className="grid gap-3 sm:grid-cols-2">
          {more && (
          <Field label="Provider" hint={!status.providers.length ? 'Nog geen provider: voeg OpenAI of een eigen endpoint toe bij Providers.' : undefined}>
            <Select value={value.providerId || ''} onChange={(e) => onChange({ providerId: e.target.value || null })}>
              <option value="">Automatisch (OpenAI)</option>
              {status.providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.kindLabel})
                </option>
              ))}
            </Select>
          </Field>
          )}
          {more && (
          <Field
            label="Model"
            hint={
              // The price always shows for a paid voice; a model that OpenAI stops adds a line (it used to hide the price).
              model?.perMinEstimate || model?.deprecatedAfter ? (
                <>
                  {model.perMinEstimate ? <span className="block">{t('≈ {0} per minuut spraak', formatUsd(model.perMinEstimate, { max: 3 }))}</span> : null}
                  {model.deprecatedAfter ? <span className="block">{`OpenAI stopt hiermee op ${model.deprecatedAfter}; daarna schakelt TeamBot automatisch over.`}</span> : null}
                </>
              ) : undefined
            }
          >
            {isOpenAI || !provider ? (
              <Select value={model?.id || ''} onChange={(e) => onChange({ model: e.target.value })}>
                {catalog.ttsModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            ) : (
              <Input value={value.model || ''} onChange={(e) => onChange({ model: e.target.value })} placeholder="bijv. kokoro of tts-1" />
            )}
          </Field>
          )}
          {main && (
          <Field label="Stem">
            {model ? (
              <Select value={model.voices.includes(value.voice || '') ? value.voice : model.voices[0]} onChange={(e) => onChange({ voice: e.target.value })}>
                {openaiVoiceOptions(model.voices)}
              </Select>
            ) : (
              <Input value={value.voice || ''} onChange={(e) => onChange({ voice: e.target.value })} placeholder="naam van de stem" />
            )}
          </Field>
          )}
          {main && (
          <Field label={t('Snelheid: {0}×', speedText(value.speed))}>
            <input type="range" min={0.5} max={Math.min(2, model?.maxSpeed || 2)} step={0.05} value={value.speed ?? 1} onChange={(e) => onChange({ speed: Number(e.target.value) })} className="w-full accent-accent" aria-label="Snelheid" />
          </Field>
          )}
          {more && (!model || model.instructions) && (
            <Field label="Stijl (optioneel)" className="sm:col-span-2" hint="Bijv. “rustig en vriendelijk, Nederlandse uitspraak”. Alleen voor modellen die stijl-instructies ondersteunen.">
              <Textarea rows={2} value={value.instructions || ''} onChange={(e) => onChange({ instructions: e.target.value })} maxLength={1000} />
            </Field>
          )}
        </div>
      )}

      {main && showBrowser && browserTtsSupported() && (
        <Field label="Browserstem" hint={engine === 'auto' || engine === 'local' ? 'Gebruikt zolang er (nog) geen lokale stem is gedownload.' : 'Gratis en lokaal; welke stemmen er zijn hangt af van je apparaat.'}>
          <Select value={value.browserVoice || ''} onChange={(e) => onChange({ browserVoice: e.target.value })}>
            <option value="">Automatisch (passend bij de taal van de tekst)</option>
            {voices.map((v) => (
              <option key={v.name} value={v.name}>
                {v.name} ({v.lang}){v.localService ? '' : ' · online'}
              </option>
            ))}
          </Select>
        </Field>
      )}

      {main && engine !== 'off' && (
        <Button size="sm" variant="secondary" onClick={preview} icon={phase === 'loading' ? <Loader2 className="h-4 w-4 animate-spin" /> : <Volume2 className="h-4 w-4" />}>
          {phase === 'playing' ? 'Speelt af…' : 'Laat horen'}
        </Button>
      )}
    </div>
  );
}
