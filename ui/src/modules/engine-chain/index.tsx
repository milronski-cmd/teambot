import { useEffect, useState } from 'react';
import { ArrowRight, PauseCircle } from 'lucide-react';
import type { UIModule } from '../types';
import type { Agent, Message } from '../../lib/types';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatDateTime, formatTime } from '../../lib/format';
import { prettyModel } from '../../lib/modelLabel';
import { Badge, Button, Card, Field, Input, Spinner, Toggle, toastError, useAsync } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { PLACE } from '../../../../shared/places.js';

/**
 * Gratis doorschakelen (package D2): the owner's choices for the default chain (one small card in Instellingen), the
 * bot's own "Privé" and "doorschakelen" switches in the bot editor, and the calm card in the chat when important work
 * pauses (with when it goes on by itself, and "Nu doorgaan als gewoon werk" / "Niet hervatten").
 */

type Level = 'top' | 'paid' | 'free' | 'local';
interface ChainSettings {
  enabled: boolean;
  minLevel: Level;
  weeklyReserve: number;
}
interface ChainView {
  provider_id: string;
  name: string;
  model: string;
  source: 'main' | 'subscription' | 'free' | 'local';
  tier: string;
  privacy: 'local' | 'none' | 'stores' | 'train';
}

/** Choices for "Belangrijk werk draait alleen op" (whole sentences, so each language can translate them). */
const LEVELS: { id: Level; label: string }[] = [
  { id: 'top', label: 'Claude of Codex' },
  { id: 'paid', label: 'Claude, Codex of een ander abonnement of betaalde engine' },
  { id: 'free', label: 'Ook gratis modellen (niet lokaal)' },
  { id: 'local', label: 'Elk model, ook lokaal (pauzeert alleen als alles op is)' },
];
const LEVEL_SHORT: Record<Level, string> = { top: 'Claude of Codex', paid: 'een abonnement of betaalde engine', free: 'een gratis model of beter', local: 'elk model' };
const SOURCE: Record<ChainView['source'], string> = { main: 'hoofdmodel', subscription: 'abonnement', free: 'gratis', local: 'lokaal' };
const PRIVACY: Record<ChainView['privacy'], { label: string; tone: 'ok' | 'neutral' | 'warn' }> = {
  local: { label: 'blijft op je pc', tone: 'ok' },
  none: { label: 'bewaart niets', tone: 'ok' },
  stores: { label: 'bewaart gesprekken', tone: 'neutral' },
  train: { label: 'kan trainen', tone: 'warn' },
};
const engineLabel = (v: ChainView) => (v.model && v.model !== 'default' ? `${v.name} · ${prettyModel(v.model)}` : v.name);

function ChainSettingsTab() {
  const [s, setS] = useState<ChainSettings | null>(null);
  const [preview, setPreview] = useState<{ main: ChainView | null; chain: ChainView[] } | null>(null);
  const [err, setErr] = useState('');
  const { busy, run } = useAsync();
  const loadPreview = () =>
    api
      .get<{ main: ChainView | null; chain: ChainView[] }>('/engine-chain/preview')
      .then(setPreview)
      .catch(() => setPreview(null));
  useEffect(() => {
    api
      .get<{ settings: ChainSettings }>('/engine-chain/settings')
      .then((r) => setS(r.settings))
      .catch((e) => setErr(e.message));
    loadPreview();
  }, []);
  if (err)
    return (
      <div className="text-sm text-danger" role="alert">
        {err}
      </div>
    );
  if (!s) return <Spinner />;
  const save = () =>
    run(async () => {
      setS(await api.put<ChainSettings>('/engine-chain/settings', s));
      loadPreview();
    }, 'Opgeslagen');
  return (
    <Card className="space-y-4 p-4 sm:p-5">
      <div className="space-y-1">
        <p className="text-sm text-muted">
          Is een model op, dan gaat een bot vanzelf verder op een ander model: eerst je andere abonnement, dan een gratis bron (eerst een andere aanbieder), dan een lokaal model. Reserves die je per bot instelt gaan voor. De chat zegt altijd waarheen en waarom.
        </p>
      </div>
      <Toggle checked={s.enabled} onChange={(v) => setS({ ...s, enabled: v })} label="Automatisch doorschakelen naar een ander model" />
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Belangrijk werk draait alleen op" hint="Routines en taken met “Belangrijk”. Is niets beschikbaar, dan pauzeert het werk tot de reset.">
          <Select value={s.minLevel} onChange={(e) => setS({ ...s, minLevel: e.target.value as Level })} aria-label="Belangrijk werk draait alleen op">
            {LEVELS.map((l) => (
              <option key={l.id} value={l.id}>
                {l.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Weekreserve (% van de week)" hint="Vanaf dit deel van de weeklimiet gaat gewoon werk naar een ander model. 0 = uit.">
          <Input type="number" min={0} max={99} value={s.weeklyReserve} onChange={(e) => setS({ ...s, weeklyReserve: Number(e.target.value) })} aria-label="Weekreserve in procent" />
        </Field>
      </div>
      {preview?.main && (
        <div className="space-y-2">
          <div className="text-sm font-medium">{t('Volgorde nu, voor een nieuwe bot op {0}', preview.main.name)}</div>
          {s.enabled && !preview.chain.length ? (
            <p className="text-sm text-muted">Er is niets om naar door te schakelen. Koppel OpenCode of Ollama bij AI-diensten.</p>
          ) : (
            <ol className="flex flex-wrap items-center gap-1.5 text-sm">
              {[preview.main, ...(s.enabled ? preview.chain : [])].map((v, i) => (
                <li key={`${v.provider_id}-${i}`} className="flex items-center gap-1.5">
                  {i > 0 && <ArrowRight className="rtl-flip h-3.5 w-3.5 text-muted" aria-hidden />}
                  <span className="rounded-lg bg-surface-2 px-2 py-1">
                    {engineLabel(v)} <span className="text-xs text-muted">({SOURCE[v.source]})</span>
                  </span>
                  <Badge tone={PRIVACY[v.privacy]?.tone || 'neutral'}>{PRIVACY[v.privacy]?.label || v.privacy}</Badge>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
      <div className="flex justify-end">
        <Button variant="primary" onClick={save} loading={busy}>
          Opslaan
        </Button>
      </div>
    </Card>
  );
}

/** Bot editor: private work for this bot, and whether the default chain may help it. */
function AgentChainSection({ agent, onChange }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  const s = agent.settings || {};
  return (
    <div className="space-y-4">
      <div className="space-y-1">
        <Toggle checked={s.private === true} onChange={(v) => onChange({ settings: { ...s, private: v ? true : undefined } })} label="Privé: alleen een lokaal model of een bron die niets bewaart" />
        <p className="text-xs text-muted">
          Voor persoonlijke of gevoelige gegevens. Werkt het hoofdmodel van deze bot in de cloud, dan gaat het werk naar een lokaal model (bijvoorbeeld Ollama); is dat er niet, dan zegt de bot dat in plaats van iets te versturen.
        </p>
      </div>
      <div className="space-y-1">
        <Toggle checked={s.freeChain !== false} onChange={(v) => onChange({ settings: { ...s, freeChain: v ? undefined : false } })} label="Automatisch doorschakelen als het model op is" />
        <p className="text-xs text-muted">{t('Na de eigen reserves van deze bot ({0}).', t(PLACE.engineChain))}</p>
      </div>
    </div>
  );
}

/** "16:05", or with the day when it is more than 20 hours away. */
const when = (ms: number) => (ms - Date.now() > 20 * 3600_000 ? formatDateTime(ms, { weekday: 'short', hour: '2-digit', minute: '2-digit' }) : formatTime(ms));

/** The calm card in the chat when important work paused (event kind 'work_paused'). */
function PauseCard({ message }: { message: Message }) {
  const p: any = message.parts?.pause || {};
  const [busy, setBusy] = useState(false);
  const until = Date.parse(p.until || '') || 0;
  const state: string = p.state || 'waiting';
  const act = (action: 'continue' | 'cancel') => {
    setBusy(true);
    api
      .post(`/engine-chain/paused/${p.runId}`, { action })
      .catch(toastError)
      .finally(() => setBusy(false));
  };
  const line =
    state === 'resumed'
      ? 'Het werk is weer verder gegaan.'
      : state === 'continued'
        ? 'Het werk gaat nu verder als gewoon werk.'
        : state === 'cancelled'
          ? 'Dit werk wordt niet vanzelf hervat. Stuur een bericht om het opnieuw te proberen.'
          : p.known
            ? t('Gaat rond {0} vanzelf verder.', when(until))
            : t('Nog niet bekend wanneer het weer kan; TeamBot probeert het rond {0} opnieuw.', when(until));
  return (
    <div className="px-4 py-2 sm:px-6" data-testid="pause-card">
      <div className="mx-auto max-w-xl rounded-xl border border-line bg-surface p-3 text-sm">
        <div className="flex items-start gap-2.5">
          <PauseCircle className={state === 'waiting' ? 'mt-0.5 h-4 w-4 shrink-0 text-warn' : 'mt-0.5 h-4 w-4 shrink-0 text-muted'} aria-hidden />
          <div className="min-w-0 flex-1 space-y-1">
            <div className="font-semibold">{p.title ? t('Belangrijk werk gepauzeerd: {0}', p.title) : 'Belangrijk werk gepauzeerd'}</div>
            {p.reason && <div className="text-muted">{p.reason}.</div>}
            <div role="status">{line}</div>
            <div className="text-xs text-muted">{t('Belangrijk werk draait alleen op {0}; het gaat niet naar een zwakker model zonder dat jij dat kiest.', LEVEL_SHORT[p.level as Level] || LEVEL_SHORT.top)}</div>
            {state === 'waiting' &&
              (p.routineId ? (
                <a className="inline-block text-xs text-accent underline" href={`#/m/routines/r/${p.routineId}`}>
                  Naar de routine
                </a>
              ) : (
                <div className="flex flex-wrap gap-2 pt-1">
                  <Button size="sm" onClick={() => act('continue')} disabled={busy}>
                    Nu doorgaan als gewoon werk
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => act('cancel')} disabled={busy}>
                    Niet hervatten
                  </Button>
                </div>
              ))}
          </div>
        </div>
      </div>
    </div>
  );
}

const mod: UIModule = {
  id: 'engine-chain',
  label: 'Gratis doorschakelen',
  settingsTabs: [{ id: 'doorschakelen', title: 'Gratis doorschakelen', component: ChainSettingsTab }],
  agentSections: [{ id: 'privacy', title: 'Privé en doorschakelen', component: AgentChainSection }],
  eventRenderers: { work_paused: PauseCard },
};

export default mod;
