import type { Agent } from '../../lib/types';
import { t } from '../../lib/i18n';
import { useApp } from '../../lib/store';
import { Field, Spinner, Toggle } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { type AgentVoice, type LocalView, useVoice } from './api';
import { botSpeechLanguage, preferInstalled, voicesFor } from './language';
import { TtsFields, langName } from './VoiceFields';

/**
 * A bot that always speaks one language (bot editor › Taal) reads aloud with a voice for that language, also in a call:
 * which one, or that there is no free voice for it (Arabic: the system voice).
 */
function BotLanguageVoice({ lang, local }: { lang: string; local: LocalView }) {
  const voices = voicesFor(lang, local.models);
  const pick = preferInstalled(voices, (id) => local.models.find((m) => m.id === id)?.status === 'installed');
  let text: string;
  if (!pick) text = t('Deze bot praat {0}. Daarvoor is er nog geen gratis lokale stem: de stem van je browser of systeem leest voor.', langName(lang));
  else if (pick.status === 'installed') text = t('Deze bot praat {0}: hij leest voor met de gratis stem {1} op je pc, ook in een gesprek.', langName(lang), pick.label);
  else text = t('Deze bot praat {0}. Download de stem {1} bij Instellingen › Meer mogelijkheden › Spraak.', langName(lang), pick.label);
  return (
    <div className="rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted" role="status">
      {text}
    </div>
  );
}

/** Bot editor section "Spraak": the bot's own voice, automatic read-aloud and live-call defaults. */
export function AgentVoiceSection({ agent, onChange }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  const { info, error } = useVoice();
  const userBotLang = useApp((s) => (s.settings as any)?.botLanguage);
  const v: AgentVoice = agent.settings?.voice || {};
  const set = (p: Partial<AgentVoice>) => onChange({ settings: { ...(agent.settings || {}), voice: { ...v, ...p } } });
  if (error) return <div className="text-sm text-danger">{error}</div>;
  if (!info) return <Spinner />;
  // The voice follows the bot's language, unless the bot has a voice of its own or does not use the local voice.
  const lang = botSpeechLanguage(agent.settings?.language, userBotLang);
  const engine = v.engine && v.engine !== 'default' ? v.engine : info.settings.tts.engine;
  const followsLanguage = !!lang && !v.localVoice && (engine === 'local' || engine === 'auto');
  return (
    <div className="space-y-4">
      {followsLanguage && <BotLanguageVoice lang={lang!} local={info.local} />}
      <TtsFields
        value={{ engine: v.engine || 'default', providerId: v.providerId, model: v.model, voice: v.voice, speed: v.speed, instructions: v.instructions, browserVoice: v.browserVoice, localVoice: v.localVoice, localSpeaker: v.localSpeaker }}
        onChange={(p) => set(p as Partial<AgentVoice>)}
        status={info.status}
        catalog={info.catalog}
        inherit
        local={info.local}
        agentId={agent.id || null}
        previewText={`Hallo, ik ben ${agent.name || 'je bot'}. Zo klink ik als ik je antwoorden voorlees.`}
      />
      <Toggle checked={!!v.autoRead} onChange={(x) => set({ autoRead: x })} label={<span>Antwoorden automatisch voorlezen (alleen in het geopende gesprek)</span>} />
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Stem bij live praten" hint="OpenAI Realtime-stem voor deze bot.">
          <Select value={v.realtimeVoice || ''} onChange={(e) => set({ realtimeVoice: e.target.value || undefined })}>
            <option value="">Standaard ({info.settings.realtime.voice})</option>
            {info.catalog.realtimeVoices.map((x) => (
              // A voice's name ("echo", "sage") is a name, never translated.
              <option key={x} value={x} translate="no">
                {x}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Live praten start in" hint="Je kunt dit per gesprek wijzigen. Bij direct praten antwoordt het spraakmodel van OpenAI.">
          <Select value={v.liveMode || 'default'} onChange={(e) => set({ liveMode: e.target.value as AgentVoice['liveMode'] })}>
            <option value="default">Standaard ({info.settings.realtime.mode === 'agent' ? 'bot bedienen' : 'direct praten'})</option>
            <option value="agent">Bot bedienen (echte bot: zijn eigen model, tools en goedkeuringen)</option>
            <option value="direct">Direct praten (spraakmodel van OpenAI, geen tools)</option>
          </Select>
        </Field>
      </div>
      <div className="text-xs text-muted">Voorgelezen tekst is een AI-stem. Bij een provider-stem gaat de tekst naar die provider.</div>
    </div>
  );
}
