import { useEffect, useState } from 'react';
import { CheckCircle2, CircleSlash, History, Mic, Save, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { navigate } from '../../lib/router';
import { MoreInfo } from '../../components/MoreInfo';
import { MoreOptions } from '../../components/MoreOptions';
import { useApp } from '../../lib/store';
import { askConfirm, Badge, Button, Card, EmptyState, Field, Input, Modal, PageHeader, Page, Spinner, Textarea, Toggle, cx, timeAgo, toast, toastError, useAsync } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { type CallView, type HotkeyView, type LocalModelView, type VoiceSettings, clock, money, range, saveVoice, useLocalModels, useVoice } from './api';
import { browserSttNote, browserSttSupported, micProblem } from './audio';
import { TtsFields, langName, sortVoices } from './VoiceFields';
import { LocalModelRow } from './LocalModels';
import { lastDictation } from './Dictate';
import { getLang, t, translate, uiLocale } from '../../lib/i18n';
import { formatBytes, formatSeconds, formatUsd } from '../../lib/format';
import { AUTO_APP, baseLang, isAutoLanguage, preferInstalled, sttModelLanguage, sttModelsFor, voicesFor } from './language';

const sec = (ms: number) => formatSeconds(ms);

/**
 * Downloadable free models, live progress, licences. What fits the language comes first and is marked (speech
 * models: the dictation language `lang`; voices: the interface language); speech models that do not know the
 * language say so. `auto`: the automatic choice is on (selected = what it picks).
 */
function LocalModelsPanel({ kind, selected, onSelect, auto, lang: forLang }: { kind: 'stt' | 'tts'; selected?: string; onSelect?(id: string): void; auto?: boolean; lang?: string }) {
  const { view, error, act } = useLocalModels();
  if (error) return <div className="text-xs text-danger">{error}</div>;
  if (!view) return <Spinner />;
  const lang = forLang || getLang();
  const name = langName(lang);
  let models: LocalModelView[];
  let best: string | undefined;
  const fits = new Set<string>();
  if (kind === 'stt') {
    const all = view.models.filter((m) => m.kind === 'stt');
    const ranked = sttModelsFor(lang, all);
    best = ranked[0]?.id;
    ranked.forEach((m) => fits.add(m.id));
    models = [...ranked, ...all.filter((m) => !fits.has(m.id))];
  } else {
    const voices = view.models.filter((m) => m.kind === 'tts-voice');
    const mine = voicesFor(lang, voices);
    best = mine[0]?.id;
    models = [...view.models.filter((m) => m.kind === 'tts-runtime'), ...sortVoices(voices, lang)];
  }
  const noVoice = kind === 'tts' && !best;
  return (
    <div className="space-y-2">
      {kind === 'stt' && view.runtime.sttProblem && <div className="rounded-lg bg-warn-soft p-2 text-xs text-warn">{view.runtime.sttProblem}</div>}
      {kind === 'tts' && !view.runtime.ttsSupported && (
        <div className="rounded-lg bg-warn-soft p-2 text-xs text-warn">
          {t('Voorlezen met Piper is nog niet beschikbaar voor {0}.', view.platform)}
        </div>
      )}
      {kind === 'tts' && view.runtime.vitsProblem && <div className="rounded-lg bg-warn-soft p-2 text-xs text-warn">{view.runtime.vitsProblem}</div>}
      {noVoice && (
        <div className="rounded-lg bg-surface-2 p-2 text-xs text-muted">
          Voor het {name} is er nog geen gratis lokale stem met een vrije licentie. De stem van je browser of systeem leest voor (op Windows: Instellingen › Tijd en taal › Spraak, daar kun je stemmen toevoegen).
        </div>
      )}
      {models.map((m) => (
        <LocalModelRow
          key={m.id}
          m={m}
          canManage={view.canManage}
          act={act}
          selected={onSelect ? selected === m.id : undefined}
          onSelect={onSelect && m.kind === 'stt' ? () => onSelect(m.id) : undefined}
          badge={auto && selected === m.id ? `automatisch gekozen voor ${name}` : m.id === best ? `aanbevolen voor ${name}` : undefined}
          note={kind === 'stt' && !fits.has(m.id) ? `Herkent geen ${name}.` : undefined}
        />
      ))}
      <div className="text-[11px] text-muted">
        Eén keer downloaden naar deze computer (controle met SHA-256); daarna werkt het offline en gratis. Licenties gecontroleerd {view.licencesChecked}.{!view.canManage && ' Alleen de eigenaar van deze TeamBot-computer kan downloaden.'}
      </div>
    </div>
  );
}

/** Dictate into any program (desktop app): global key combination, off until the owner turns it on. */
function HotkeyCard({ view, mode, value, saved, onChange }: { view?: HotkeyView; mode: string; value: VoiceSettings['hotkey']; saved: VoiceSettings['hotkey']; onChange(p: Partial<VoiceSettings['hotkey']>): void }) {
  const [tried, setTried] = useState('');
  if (!view?.available)
    return mode === 'desktop' ? (
      <Card className="space-y-1 p-4">
        <h2 className="text-[15px] font-bold tracking-tight">Dicteren in elk programma (sneltoets)</h2>
        <div className="text-xs text-muted">Alleen in de TeamBot-app op je computer.</div>
      </Card>
    ) : null;
  const options = view.presets.some((p) => p.accel === value.accelerator) ? view.presets : [...view.presets, { accel: value.accelerator, label: value.accelerator }];
  const label = options.find((p) => p.accel === value.accelerator)?.label || value.accelerator;
  const pending = value.enabled !== saved.enabled || value.accelerator !== saved.accelerator;
  return (
    <Card className="space-y-3 p-4">
      <h2 className="text-[15px] font-bold tracking-tight">Dicteren in elk programma (sneltoets)</h2>
      <div className="text-xs text-muted">
        Houd <b>{label}</b> ingedrukt en praat; de tekst komt in het programma waarin je typt.{' '}
        <MoreInfo>
          Ook als TeamBot in het systeemvak staat (Word, je browser, e-mail…). Kort tikken = handsfree: praat zolang je wilt en tik nog een keer als je klaar bent. <b>Esc</b> annuleert. De microfoon gaat alleen aan zolang je dicteert; een balkje onderin je
          scherm laat dat zien. Nooit in wachtwoordvelden of Windows-beveiligingsvensters; je klembord wordt na het plakken teruggezet. In programma’s die als administrator draaien kan Windows het plakken tegenhouden: de tekst staat dan op je klembord.
        </MoreInfo>
      </div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Toggle checked={value.enabled} onChange={(x) => onChange({ enabled: x })} label={<span>Sneltoets aan</span>} />
        </div>
        <Field label="Sneltoets" hint="Kies een combinatie die je andere programma’s niet gebruiken.">
          <Select value={value.accelerator} onChange={(e) => onChange({ accelerator: e.target.value })}>
            {options.map((p) => (
              <option key={p.accel} value={p.accel}>
                {p.label}
                {p.accel === 'Control+Alt+Space' ? ' (standaard)' : ''}
              </option>
            ))}
          </Select>
        </Field>
        <div className="self-end text-sm" role="status">
          {pending ? (
            <span className="text-muted">Sla op om de sneltoets {value.enabled ? 'aan te zetten' : 'uit te zetten'}.</span>
          ) : !view.enabled ? (
            <span className="text-muted">Uit.</span>
          ) : view.registered ? (
            <span className="flex items-center gap-1.5 text-ok">
              <CheckCircle2 className="h-4 w-4 shrink-0" aria-hidden /> {view.label} werkt{view.hold ? '' : ' (tikken om te starten en te stoppen)'}.
            </span>
          ) : (
            <span className="flex items-center gap-1.5 text-danger">
              <CircleSlash className="h-4 w-4 shrink-0" aria-hidden /> {view.error || 'Sneltoets niet beschikbaar.'}
            </span>
          )}
        </div>
      </div>
      {view.enabled && view.registered && !pending && (
        <Field label="Probeer het hier" hint={`Klik in dit vak, houd ${view.label} ingedrukt, zeg iets en laat los.`}>
          <Textarea rows={2} value={tried} onChange={(e) => setTried(e.target.value)} placeholder="Hier verschijnt wat je zegt…" aria-label="Proefvak voor dicteren met de sneltoets" />
        </Field>
      )}
      {!view.paste && <p className="text-xs text-muted">Op dit systeem kan TeamBot niet zelf plakken: de tekst komt op je klembord (plak met Ctrl+V).</p>}
    </Card>
  );
}

function Status({ ok, label, detail }: { ok: boolean; label: string; detail: string }) {
  return (
    <div className="flex items-start gap-2">
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> : <CircleSlash className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
      <div>
        <div className="text-sm font-medium">{label}</div>
        <div className="text-xs text-muted">{detail}</div>
      </div>
    </div>
  );
}

/** Instellingen › Spraak */
export function VoiceSettingsTab() {
  const { info, error, reload } = useVoice();
  const [d, setD] = useState<VoiceSettings | null>(null);
  const { busy, run } = useAsync();
  useEffect(() => {
    if (info && !d) setD(info.settings);
  }, [info, d]);
  if (error) return <div className="p-4 text-sm text-danger">{error}</div>;
  if (!info || !d) return <Spinner className="m-6" />;
  const { status, catalog } = info;
  const dirty = JSON.stringify(d) !== JSON.stringify(info.settings);
  const set = (p: Partial<VoiceSettings>) => setD({ ...d, ...p });
  const setStt = (p: Partial<VoiceSettings['stt']>) => setD({ ...d, stt: { ...d.stt, ...p } });
  const setTts = (p: Partial<VoiceSettings['tts']>) => setD({ ...d, tts: { ...d.tts, ...p } });
  const setRt = (p: Partial<VoiceSettings['realtime']>) => setD({ ...d, realtime: { ...d.realtime, ...p } });
  const setCall = (p: Partial<VoiceSettings['call']>) => setD({ ...d, call: { ...d.call, ...p } });
  const sttProvider = status.providers.find((p) => p.id === d.stt.providerId) || (d.stt.providerId ? undefined : status.providers.find((p) => p.kind === 'openai'));
  const openaiProviders = status.providers.filter((p) => p.kind === 'openai');
  const rtModel = catalog.realtimeModels.find((m) => m.id === d.realtime.model);
  const mic = micProblem();
  // '' = automatic: the model for the dictation language (a fixed language, or the hint of an automatic one), the
  // same rule as the server; worked out here so a change of language shows before saving.
  const sttLang = sttModelLanguage(d.stt.language, getLang());
  const sttModels = info.local.models.filter((m) => m.kind === 'stt');
  const sttFits = sttModelsFor(sttLang, sttModels);
  const sttAuto = preferInstalled(sttFits, (id) => sttModels.find((m) => m.id === id)?.status === 'installed')?.id || info.effective?.stt.localModel || '';
  const sttModel = d.stt.localModel || sttAuto;
  const sttChosen = sttModels.find((m) => m.id === sttModel);
  // The model's own name ("Whisper large-v3 turbo"), without the description after the dash.
  const sttName = sttChosen ? sttChosen.label.split(' — ')[0] : '';

  const save = () =>
    run(async () => {
      const v = await saveVoice(d);
      setD(v.settings);
    }, 'Spraakinstellingen opgeslagen');

  return (
    <div className="space-y-4 pb-20">
      <Card className="space-y-3 p-4">
        <h2 className="text-[15px] font-bold tracking-tight">Wat werkt er nu</h2>
        <div className="grid gap-3 sm:grid-cols-3">
          <Status
            ok={status.stt.ready}
            label="Dicteren"
            detail={status.stt.ready ? (status.stt.kind === 'local' ? 'Gratis op deze computer' : d.stt.engine === 'browser' ? 'Via je browser' : `Via ${status.stt.provider} (${status.stt.model})`) : status.stt.missing || 'Niet ingesteld'}
          />
          <Status
            ok={status.tts.engine !== 'off' && status.tts.engine !== 'error'}
            label="Voorlezen"
            detail={
              status.tts.engine === 'local'
                ? `Gratis op deze computer · ${status.tts.voice}`
                : status.tts.engine === 'provider'
                  ? `${status.tts.provider} · ${status.tts.model} · ${status.tts.voice}`
                  : status.tts.engine === 'browser'
                    ? `Browserstem (gratis)${status.tts.localMissing ? ` — ${status.tts.localMissing}` : ''}`
                    : status.tts.engine === 'off'
                      ? 'Uit'
                      : status.tts.error || ''
            }
          />
          <Status ok={status.stt.ready || status.realtime.ready} label="Gesprek" detail={[status.stt.ready ? translate('Gratis gesprek met elke bot') : translate('Gratis gesprek: eerst spraakherkenning'), status.realtime.ready ? t('Live (Realtime) via {0}', status.realtime.provider || 'OpenAI') : translate('Live (Realtime) vraagt een OpenAI-sleutel')].join(' · ')} />
        </div>
        {/* The pages of Spraak, one click from here (TeamBot 0.4.2: Spraakgesprekken is no longer its own row in Instellingen). */}
        <nav aria-label="Meer bij Spraak" className="flex flex-wrap gap-x-4 gap-y-1 text-[13px] font-semibold">
          <a className="text-muted hover:text-fg" href="#/m/voice/">
            Eerdere spraakgesprekken
          </a>
        </nav>
        {lastDictation && (
          <div className="text-xs text-muted">
            {t('Laatst gemeten: {0} dicteren → tekst {1} na stoppen (waarvan {2} herkenning op de pc).', sec(lastDictation.seconds * 1000), sec(lastDictation.clientMs), sec(lastDictation.finalMs))}
          </div>
        )}
        {mic && <div className="rounded-lg bg-warn-soft p-3 text-xs text-warn">{mic}</div>}
        {!status.openai && (
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 border-t border-line pt-3 text-xs">
            <div className="min-w-0 flex-1 basis-56 text-muted">
              Alles werkt gratis op deze computer.{' '}
              <MoreInfo>
                Dicteren, voorlezen en het gratis gesprek met elke bot (ook vanaf je telefoon; die stuurt de audio naar je pc). Alleen “Live (OpenAI Realtime)” en de OpenAI-stemmen hebben een OpenAI API-sleutel nodig (betaald per gebruik, los van ChatGPT
                Plus).
              </MoreInfo>
            </div>
            <Button size="sm" variant="secondary" onClick={() => navigate('/settings/providers')}>
              OpenAI-sleutel toevoegen (optioneel)
            </Button>
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-[15px] font-bold tracking-tight">Spraak naar tekst</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Herkenning door">
            <Select value={d.stt.engine} onChange={(e) => setStt({ engine: e.target.value as any })}>
              <option value="local">Lokaal op deze computer — gratis (aanbevolen)</option>
              <option value="provider">Spraakprovider (OpenAI of eigen endpoint, betaald)</option>
              <option value="browser" disabled={!browserSttSupported()}>
                Browser (gratis{browserSttSupported() ? '' : ' — niet beschikbaar in deze browser'})
              </option>
            </Select>
          </Field>
          <Field label="Taal" hint={isAutoLanguage(d.stt.language) && d.stt.language !== 'auto' ? 'TeamBot herkent de taal zelf; de taal tussen haakjes is een hint.' : undefined}>
            <Select value={d.stt.language} onChange={(e) => setStt({ language: e.target.value })}>
              {catalog.languages
                // The old default "Nederlands voorkeur" is the same as the automatic choice with a Dutch interface.
                .filter((l) => l.id !== 'auto-nl' || baseLang(getLang()) !== 'nl' || d.stt.language === 'auto-nl')
                .map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.id === AUTO_APP ? `Automatisch (voorkeur: ${langName(getLang())})` : l.label}
                  </option>
                ))}
            </Select>
          </Field>
          {d.stt.engine === 'local' ? (
            <div className="space-y-2 sm:col-span-2">
              <div className="text-xs text-muted">
                Kies het spraakmodel; niets gaat naar internet.{' '}
                <MoreInfo>
                  Parakeet zet zelf leestekens en herkent 25 Europese talen, ook door elkaar; voor Turks en Arabisch is er Whisper. Je telefoon stuurt de opname naar deze computer. Live tekst verschijnt terwijl je praat.
                  {sttModel === 'parakeet-tdt-0.6b-v3' && !isAutoLanguage(d.stt.language) ? ' (Parakeet kiest de taal zelf; de taalkeuze geldt voor Whisper.)' : ''}
                  {sttModel.startsWith('whisper') && isAutoLanguage(d.stt.language) ? ' Whisper herkent de taal zelf; kies een vaste taal als het soms een verkeerde taal hoort.' : ''}
                </MoreInfo>
              </div>
              {sttChosen && (
                <div role="status" className={cx('rounded-lg p-2 text-xs', sttFits.some((m) => m.id === sttChosen.id) ? 'bg-surface-2 text-fg' : 'bg-warn-soft text-warn')}>
                  {sttFits.some((m) => m.id === sttChosen.id)
                    ? t('Voor het {0} gebruikt TeamBot {1}.', langName(sttLang), sttName)
                    : t('{0} herkent geen {1}. Kies hieronder een model dat het {1} kent, of laat TeamBot automatisch kiezen.', sttName, langName(sttLang))}
                </div>
              )}
              {d.stt.localModel && (
                <Button size="sm" variant="ghost" onClick={() => setStt({ localModel: '' })}>
                  {t('Automatisch kiezen (aanbevolen voor het {0})', langName(sttLang))}
                </Button>
              )}
              <LocalModelsPanel kind="stt" lang={sttLang} selected={sttModel} auto={!d.stt.localModel} onSelect={(id) => setStt({ localModel: id })} />
            </div>
          ) : d.stt.engine === 'provider' ? (
            <>
              <Field label="Provider" hint="Ontvangt je audio om om te zetten naar tekst. Een lokale server houdt alles op je computer.">
                <Select value={d.stt.providerId || ''} onChange={(e) => setStt({ providerId: e.target.value || null, model: '' })}>
                  <option value="">Automatisch (OpenAI)</option>
                  {status.providers.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name} ({p.kindLabel})
                    </option>
                  ))}
                </Select>
              </Field>
              <Field label="Model" hint={sttProvider?.kind === 'openai' ? catalog.sttModels.find((m) => m.id === (d.stt.model || 'gpt-transcribe'))?.deprecatedAfter ? 'Dit model stopt binnenkort bij OpenAI; TeamBot schakelt dan automatisch over.' : undefined : 'Naam van het spraakmodel op je server (bijv. whisper-1 of Systran/faster-whisper-small).'}>
                {sttProvider?.kind === 'openai' || !sttProvider ? (
                  <Select value={d.stt.model || 'gpt-transcribe'} onChange={(e) => setStt({ model: e.target.value })}>
                    {catalog.sttModels.map((m) => (
                      <option key={m.id} value={m.id}>
                        {m.label} · {formatUsd(m.perMin, { max: 4 })}/min
                      </option>
                    ))}
                  </Select>
                ) : (
                  <Input value={d.stt.model} onChange={(e) => setStt({ model: e.target.value })} placeholder={sttProvider.kind === 'groq' ? 'whisper-large-v3-turbo' : 'whisper-1'} />
                )}
              </Field>
            </>
          ) : (
            <div className="text-xs text-muted sm:col-span-2">{browserSttNote} Spraakmemo’s (audio bewaren) vragen een spraakprovider.</div>
          )}
        </div>
      </Card>

      <HotkeyCard view={info.hotkey} mode={info.mode} value={d.hotkey} saved={info.settings.hotkey} onChange={(p) => setD({ ...d, hotkey: { ...d.hotkey, ...p } })} />

      <Card className="space-y-3 p-4">
        <h2 className="text-[15px] font-bold tracking-tight">Voorlezen</h2>
        <TtsFields
          value={d.tts}
          onChange={(p) => setTts(p as any)}
          status={status}
          catalog={catalog}
          local={info.local}
          english
          autoVoice={info.effective?.tts.localVoice ?? ''}
          previewText="Hallo! Zo klinkt het als je bots hun antwoorden voorlezen."
        />
        <div className="text-xs text-muted">Voor alle bots; per bot kun je een eigen stem kiezen.</div>
        {(d.tts.engine === 'local' || d.tts.engine === 'auto') && (
          <div>
            <Toggle checked={d.tts.streaming} onChange={(x) => setTts({ streaming: x })} label={<span>Al voorlezen terwijl de bot nog schrijft</span>} />
            <div className="mt-1 text-xs text-muted">De stem begint na de eerste zin. Werkt met de lokale stem.</div>
          </div>
        )}
        {(d.tts.engine === 'local' || d.tts.engine === 'auto') && (
          <details className="rounded-lg border border-line p-2.5 text-sm" open={!!status.tts.localMissing}>
            <summary className="cursor-pointer font-medium">Lokale stemmen downloaden of verwijderen</summary>
            <div className="mt-2">
              <LocalModelsPanel kind="tts" />
            </div>
          </details>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-[15px] font-bold tracking-tight">Gesprekken</h2>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Standaard" hint={<MoreInfo>Het gratis gesprek praat met de bot zelf. Live (OpenAI of Gemini) is vloeiender.</MoreInfo>}>
            <Select value={d.call.engine} onChange={(e) => setCall({ engine: e.target.value as any })}>
              <option value="local">Gratis gesprek (lokaal, om de beurt)</option>
              <option value="realtime" disabled={!status.realtime.ready}>
                Live via OpenAI Realtime (betaald{status.realtime.ready ? '' : ' — sleutel nodig'})
              </option>
              <option value="gemini" disabled={!status.gemini?.ready}>
                {status.gemini?.ready ? 'Live via Gemini Live (Google, spreekt Nederlands)' : 'Live via Gemini Live (Google-sleutel nodig)'}
              </option>
            </Select>
          </Field>
          <Field label="Praten" hint={<MoreInfo>Ingedrukt houden: je praat zolang je de spatiebalk of knop vasthoudt. Handsfree: een pauze beëindigt je beurt.</MoreInfo>}>
            <Select value={d.call.talk} onChange={(e) => setCall({ talk: e.target.value as VoiceSettings['call']['talk'] })}>
              <option value="auto">Automatisch (pc: ingedrukt houden, telefoon: handsfree)</option>
              <option value="hold">Ingedrukt houden om te praten</option>
              <option value="handsfree">Handsfree</option>
            </Select>
          </Field>
          <Field label={t('Wachten na je laatste woord: {0}', sec(d.call.silenceMs))}hint="Alleen bij handsfree. Korter is sneller, langer onderbreekt je minder.">
            <input type="range" min={400} max={2000} step={100} value={d.call.silenceMs} onChange={(e) => setCall({ silenceMs: Number(e.target.value) })} className="w-full accent-accent" aria-label="Wachttijd na je laatste woord" />
          </Field>
          <div className="sm:col-span-2">
            <Toggle checked={d.call.bargeIn} onChange={(x) => setCall({ bargeIn: x })} label={<span>Onderbreken door te praten</span>} />
            <div className="mt-1 text-xs text-muted">
              Bij handsfree; werkt het best met een headset. <MoreInfo>Via de luidspreker moet je iets luider praten dan de bot. Bij ingedrukt houden onderbreek je de bot door de knop in te drukken.</MoreInfo>
            </div>
          </div>
        </div>
      </Card>

      {/* Rarely changed: paid live talking, what is kept and for how long. */}
      <MoreOptions>
      <Card className="space-y-3 p-4">
        <div className="flex flex-wrap items-center gap-2">
          <h2 className="text-[15px] font-bold tracking-tight">Live praten (OpenAI Realtime)</h2>
          <Badge>prijzen gecontroleerd {catalog.pricesChecked}</Badge>
        </div>
        {!openaiProviders.length ? (
          <div className="text-sm text-muted">Vraagt een OpenAI API-sleutel (betaald per gebruik, niet je ChatGPT-abonnement).</div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="OpenAI-provider" hint="De sleutel zelf blijft op de server.">
              <Select value={d.realtime.providerId || ''} onChange={(e) => setRt({ providerId: e.target.value || null })}>
                <option value="">Automatisch</option>
                {openaiProviders.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {p.own ? '' : ' (gedeeld)'}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Spraakmodel" hint={rtModel ? range(rtModel.estimate) : undefined}>
              <Select value={d.realtime.model} onChange={(e) => setRt({ model: e.target.value })}>
                {catalog.realtimeModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Stem">
              <Select value={d.realtime.voice} onChange={(e) => setRt({ voice: e.target.value })}>
                {catalog.realtimeVoices.map((v) => (
                  // A voice's name ("echo", "sage") is a name, never translated.
                  <option key={v} value={v} translate="no">
                    {v === 'marin' || v === 'cedar' ? t('{0} (aanbevolen)', v) : v}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Ondertiteling van wat jij zegt">
              <Select value={d.realtime.transcribeModel} onChange={(e) => setRt({ transcribeModel: e.target.value })}>
                <option value="">Uit (geen ondertiteling/transcript van jouw kant)</option>
                {catalog.transcribeModels.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label} · {formatUsd(m.perMin, { max: 3 })}/min
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Standaardmodus">
              <Select value={d.realtime.mode} onChange={(e) => setRt({ mode: e.target.value as any })}>
                <option value="direct">Direct praten (persoonlijkheid van de bot, geen tools)</option>
                <option value="agent">Bot bedienen (verzoeken gaan naar de echte bot)</option>
              </Select>
            </Field>
            <Field label="Beurtwisseling" hint="Semantisch wacht tot je echt uitgepraat bent; stilte reageert sneller.">
              <Select value={d.realtime.vad} onChange={(e) => setRt({ vad: e.target.value as any })}>
                <option value="semantic">Semantisch (aanbevolen)</option>
                <option value="server">Op stilte</option>
              </Select>
            </Field>
            <Field label="Prijsplafond per gesprek (USD)" hint="Waarschuwing bij 80 %, ophangen bij 100 %.">
              <Input type="number" min={0.05} max={50} step={0.05} value={d.priceCapUsd} onChange={(e) => set({ priceCapUsd: Number(e.target.value) })} />
            </Field>
            <Field label="Maximale duur (minuten)">
              <Input type="number" min={1} max={120} value={d.maxMinutes} onChange={(e) => set({ maxMinutes: Number(e.target.value) })} />
            </Field>
            <div className="space-y-2 sm:col-span-2">
              <Toggle checked={d.realtime.sendContext} onChange={(x) => setRt({ sendContext: x })} label={<span>Laatste 10 chatberichten als context meesturen naar OpenAI</span>} />
            </div>
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-[15px] font-bold tracking-tight">Privacy en bewaren</h2>
        <Toggle checked={d.keepTranscripts} onChange={(x) => set({ keepTranscripts: x })} label={<span>Transcripten van live gesprekken standaard bewaren in het gesprek</span>} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Audio van spraakmemo’s bewaren (dagen)" hint="0 = altijd. Het transcript blijft in het gesprek staan.">
            <Input type="number" min={0} max={3650} value={d.audioDays} onChange={(e) => set({ audioDays: Number(e.target.value) })} />
          </Field>
          <Field label="Voorgelezen audio bewaren (dagen niet gebruikt)">
            <Input type="number" min={1} max={3650} value={d.ttsCacheDays} onChange={(e) => set({ ttsCacheDays: Number(e.target.value) })} />
          </Field>
        </div>
        <CacheInfo />
        <MoreInfo block>
        <ul className="list-disc space-y-1 ps-5 text-xs text-muted">
          <li>De microfoon gaat alleen aan na een tik en nooit op de achtergrond; je ziet altijd een opname-indicator.</li>
          <li>Dicteeraudio wordt na het omzetten niet bewaard. Spraakmemo’s bewaren audio + transcript in het gesprek.</li>
          <li>Met de lokale engine blijft je stem op je eigen computer (ook vanaf je telefoon: die stuurt de audio alleen naar je TeamBot-pc). Bij live praten via Realtime gaat je stem rechtstreeks naar OpenAI.</li>
          <li>Je praat altijd met een AI; stemmen zijn door AI gegenereerd.</li>
        </ul>
        </MoreInfo>
      </Card>
      </MoreOptions>

      <div className="sticky bottom-0 flex justify-end gap-2 border-t border-line bg-canvas/90 py-3 backdrop-blur">
        <Button variant="ghost" disabled={!dirty || busy} onClick={() => (setD(info.settings), reload())}>
          Ongedaan maken
        </Button>
        <Button variant="primary" icon={<Save className="h-4 w-4" />} loading={busy} disabled={!dirty} onClick={save}>
          Opslaan
        </Button>
      </div>
    </div>
  );
}

function CacheInfo() {
  const [c, setC] = useState<{ count: number; bytes: number; cost: number } | null>(null);
  const load = () => api.get('/voice/tts-cache').then(setC).catch(() => setC(null));
  useEffect(() => {
    load();
  }, []);
  const clear = async () => {
    try {
      const r = await api.del<{ deleted: number }>('/voice/tts-cache');
      toast(t('{0, plural, =0 {Geen voorgelezen bestanden verwijderd} one {# voorgelezen bestand verwijderd} other {# voorgelezen bestanden verwijderd}}', r.deleted), 'ok');
      load();
    } catch (e) {
      toastError(e);
    }
  };
  const cleanup = async () => {
    try {
      const r = await api.post<{ tts: number; audio: number }>('/voice/cleanup');
      toast(t('Opgeruimd: {0, plural, one {# voorgelezen bestand} other {# voorgelezen bestanden}}, {1, plural, one {# memo-opname} other {# memo-opnamen}}', r.tts, r.audio), 'ok');
      load();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
      <span>{c ? t('Voorgelezen audio: {0, plural, one {# bestand} other {# bestanden}}, {1}', c.count, formatBytes(c.bytes)) : 'Voorgelezen audio: …'}</span>
      <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} onClick={clear} disabled={!c?.count}>
        Cache legen
      </Button>
      <Button size="sm" variant="ghost" onClick={cleanup}>
        Nu opruimen volgens bewaartermijn
      </Button>
    </div>
  );
}

/** List of live/half-duplex calls with duration, cost and (when kept) the transcript. */
export function CallHistory({ compact }: { compact?: boolean }) {
  const agents = useApp((s) => s.agents);
  const [list, setList] = useState<CallView[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [open, setOpen] = useState<CallView | null>(null);
  const load = () =>
    api
      .get<CallView[]>('/voice/calls')
      .then((l) => (setList(l), setErr(null)))
      .catch((e) => setErr(e?.message || String(e)));
  useEffect(() => {
    load();
  }, []);
  const show = async (c: CallView) => {
    try {
      setOpen(await api.get<CallView>(`/voice/calls/${c.id}`));
    } catch (e) {
      toastError(e);
    }
  };
  const del = async (c: CallView) => {
    if (!(await askConfirm('Dit gespreksverslag verwijderen? Berichten in de chat blijven staan.', { ok: 'Verwijderen', danger: true }))) return;
    try {
      await api.del(`/voice/calls/${c.id}`);
      setOpen(null);
      load();
    } catch (e) {
      toastError(e);
    }
  };
  if (err) return <div className="text-sm text-danger">{err}</div>;
  if (!list) return <Spinner />;
  if (!list.length) return <EmptyState icon={<Mic className="h-6 w-6" />} title="Nog geen gesprekken">Start een gesprek met de telefoonknop bovenaan een chat met een bot.</EmptyState>;
  return (
    <>
      <div className={cx('divide-y divide-line', compact && 'max-h-80 overflow-y-auto')}>
        {list.map((c) => {
          const a = agents.find((x) => x.id === c.agent_id);
          return (
            <div key={c.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate font-medium">{c.mode === 'group' ? c.group || 'Groep' : a?.name || 'Verwijderde bot'}</div>
                <div className="text-xs text-muted">
                  {c.kind === 'realtime' ? `Live · ${c.mode === 'agent' ? 'bot bedienen' : 'direct'} · ${c.model}` : c.mode === 'group' ? 'Groepsgesprek' : 'Gesprek om de beurt'} · {timeAgo(c.started_at)} · {clock(c.duration_sec)}
                  {c.cost > 0 ? ` · ≈ ${money(c.cost)}` : ''}
                </div>
              </div>
              {c.status === 'failed' && <Badge tone="danger">mislukt</Badge>}
              {(c.status === 'active' || c.status === 'connecting') && <Badge tone="ok">bezig</Badge>}
              <Button size="sm" variant="ghost" onClick={() => show(c)}>
                Details
              </Button>
              <Button size="sm" variant="ghost" onClick={() => navigate(`/t/${c.thread_id}`)}>
                Naar chat
              </Button>
            </div>
          );
        })}
      </div>
      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        title="Gespreksverslag"
        footer={
          open && (
            <>
              <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => del(open)}>
                Verwijderen
              </Button>
              <Button variant="primary" onClick={() => setOpen(null)}>
                Sluiten
              </Button>
            </>
          )
        }
      >
        {open && (
          <div className="space-y-2 text-sm">
            <div className="text-muted">
              {new Date(open.started_at).toLocaleString(uiLocale())} · {clock(open.duration_sec)} · {open.cost > 0 ? `≈ ${money(open.cost)}` : 'geen spraakkosten'} · {t('{0, plural, =0 {geen verzoeken aan de bot} one {# verzoek aan de bot} other {# verzoeken aan de bot}}', open.asks || 0)}
            </div>
            {open.error && <div className="rounded-lg bg-danger-soft p-2 text-xs text-danger">{open.error}</div>}
            {open.transcript?.length ? (
              <div className="space-y-1 rounded-lg bg-surface-2 p-3">
                {open.transcript.map((l, i) => (
                  <div key={i}>
                    <span className="font-medium">{l.role === 'user' ? 'Jij' : 'AI'}: </span>
                    {l.text}
                  </div>
                ))}
              </div>
            ) : (
              <div className="text-muted">{open.kind === 'halfduplex' ? 'De berichten van dit gesprek staan in de chat.' : open.keep_transcript ? 'Geen transcript opgenomen.' : 'Transcript niet bewaard (op jouw verzoek).'}</div>
            )}
          </div>
        )}
      </Modal>
    </>
  );
}

export function CallHistoryPage() {
  return (
    <Page>
      <PageHeader width="3xl" title="Spraakgesprekken" subtitle="Live gesprekken en bellen met je bots: duur, kosten en transcript." actions={<Button onClick={() => navigate('/settings/voice-spraak')}>Spraakinstellingen</Button>} />
      <div className="mx-auto max-w-3xl px-4 py-4 sm:px-6">
        <CallHistory />
      </div>
    </Page>
  );
}
