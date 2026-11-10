import { useEffect, useMemo, useRef, useState } from 'react';
import { Globe, MessageSquare, QrCode, SlidersHorizontal, Smartphone } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate, query } from '../../lib/router';
import { t, translate } from '../../lib/i18n';
import type { Agent } from '../../lib/types';
import { Button, Card, Page, Spinner, toast, useAsync } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { BotQuestions, useEngineChoices } from '../newbot/Questions';
import { STARTERS } from '../newbot/starters';
import { DEFAULT_RULES } from '../newbot/choices';
import { WerkplekLine } from '../../modules/folders/Werkplek';
import { activeTeamId } from '../../modules/teams/scope';
import { useIsPhoneSession } from '../../shell/computerOnly';

/**
 * First run, step 2 and 3 (0.4.5, "like OpenBot"): right after connecting an AI (subscription, key or free) TeamBot makes
 * a ready first bot, with its own werkplek (a folder under the team folder, made here when there is none) and its own
 * browser inside TeamBot. The three questions are optional behind "Aanpassen". The last step offers "Koppel je
 * telefoon": the phone card with the QR code (Instellingen › Telefoon), or later.
 *   #/start?ai=<provider>
 */

/** The phone card with the QR code (module mobile, Instellingen › Telefoon). */
const PHONE_CARD = '#/settings/mobile-telefoon';

/** Make the first bot (once): the team folder for its werkplek first (desktop), then the bot, then its own browser. */
async function makeFirstBot(providerId: string, desktop: boolean): Promise<Agent> {
  const st = useApp.getState();
  const mine = st.agents.filter((a) => !a.archived);
  if (mine.length) return mine[mine.length - 1];
  if (desktop) {
    // "Eigen werkplek": bot folders live under the team folder; a fresh TeamBot makes the suggested one (Documenten\TeamBot\Teammap).
    const tf = await api.get<{ folder: unknown; suggestion: string; restricted?: boolean }>('/folders/team').catch(() => null);
    if (tf && !tf.folder && !tf.restricted && tf.suggestion) await api.put('/folders/team', { path: tf.suggestion, create: true, label: translate('Teammap') }).catch(() => null);
  }
  const p = st.providers.find((x) => x.id === providerId);
  if (p?.kind === 'opencode') await api.post('/providers/free-reserve').catch(() => null);
  const s = STARTERS[0];
  const team = activeTeamId();
  const a = await api.post<Agent>('/agents', {
    name: translate('Assistent'),
    avatar: s.avatar,
    color: s.color,
    role: translate(s.role),
    description: translate(s.description),
    instructions: DEFAULT_RULES,
    // its own computer: the werkplek with files and a terminal (outside it asks first), and its own browser
    tool_groups: [...new Set([...s.tool_groups, 'shell', 'browser'])],
    provider_id: providerId || undefined,
    model: '',
    access_mode: 'ask',
    settings: team ? { homeTeam: team } : {},
  });
  // Its own browser inside TeamBot (or Edge/Chrome); without a browser on this device it keeps just the werkplek.
  await api.put(`/computers/${a.id}/config`, { mode: 'browser' }).catch(() => null);
  const fresh = await api.get<Agent>(`/agents/${a.id}`).catch(() => a);
  useApp.setState((x) => ({ agents: [...x.agents.filter((y) => y.id !== fresh.id), fresh] }));
  return fresh;
}

export function FirstBotPage() {
  const providerId = query().get('ai') || '';
  const mode = useApp((s) => s.mode);
  const phone = useIsPhoneSession();
  const [bot, setBot] = useState<Agent | null>(null);
  const [err, setErr] = useState('');
  const [step, setStep] = useState<'ready' | 'edit' | 'phone'>('ready');
  const started = useRef(false);
  const make = () => {
    setErr('');
    makeFirstBot(providerId, mode === 'desktop' && !phone)
      .then(setBot)
      .catch((e) => setErr(e?.message || String(e)));
  };
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    make();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const chat = () => bot && navigate(`/a/${bot.id}`);

  const view = err ? 'error' : bot ? step : 'making';

  return (
    <Page>
      <div className="mx-auto flex min-h-full max-w-[520px] flex-col justify-center px-5 py-10">
        {view === 'error' && <NotMade err={err} providerId={providerId} onRetry={make} />}
        {view === 'making' && <Making />}
        {view === 'phone' && bot && <PhoneStep bot={bot} onLater={chat} />}
        {view === 'edit' && bot && <EditStep bot={bot} providerId={providerId} onDone={(a) => (setBot(a), setStep('ready'))} />}
        {view === 'ready' && bot && <ReadyStep bot={bot} onTalk={() => (phone ? chat() : setStep('phone'))} onEdit={() => setStep('edit')} />}
      </div>
    </Page>
  );
}

function Making() {
  return (
    <p className="flex items-center justify-center gap-2 text-sm text-muted" role="status">
      <Spinner /> Je eerste bot wordt klaargezet…
    </p>
  );
}

function NotMade({ err, providerId, onRetry }: { err: string; providerId: string; onRetry(): void }) {
  return (
    <Card className="space-y-3 p-5" role="alert">
      <h1 className="text-lg font-bold tracking-tight">Je eerste bot is nog niet gemaakt</h1>
      <p className="text-sm text-danger">{err}</p>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" onClick={onRetry}>
          Opnieuw proberen
        </Button>
        <Button variant="ghost" onClick={() => navigate(providerId ? `/agents/new?ai=${encodeURIComponent(providerId)}` : '/agents/new')}>
          Zelf een bot maken
        </Button>
      </div>
    </Card>
  );
}

function ReadyStep({ bot, onTalk, onEdit }: { bot: Agent; onTalk(): void; onEdit(): void }) {
  const browser = (bot.tool_groups || []).includes('browser');
  return (
    <div className="space-y-5" data-testid="first-bot-ready">
      <div className="flex flex-col items-center text-center">
        <BotAvatar bot={bot} size={88} />
        <h1 className="mt-4 text-[26px] font-extrabold leading-tight tracking-tight">{t('{0} staat klaar', bot.name)}</h1>
        <p className="mt-1.5 max-w-sm text-[15px] leading-relaxed text-muted">{t('Je eerste bot. {0} vraagt toestemming voordat hij iets wijzigt.', bot.name)}</p>
      </div>
      <WerkplekLine agent={bot} />
      {browser && (
        <div className="flex items-start gap-2 rounded-2xl border border-line bg-surface px-4 py-3 text-sm">
          <Globe className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span>
            <span className="font-semibold">Eigen browser:</span> <span className="text-muted">onzichtbaar in TeamBot. Meekijken of overnemen kan altijd via de knop Browser in het gesprek.</span>
          </span>
        </div>
      )}
      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button variant="primary" size="lg" className="flex-1 justify-center" icon={<MessageSquare className="h-4 w-4" />} onClick={onTalk}>
          Begin met praten
        </Button>
        <Button size="lg" className="justify-center" icon={<SlidersHorizontal className="h-4 w-4" />} onClick={onEdit}>
          Aanpassen
        </Button>
      </div>
    </div>
  );
}

/** "Aanpassen": the three questions (name, what it does, which model), now optional, for the bot that is already there. */
function EditStep({ bot, providerId, onDone }: { bot: Agent; providerId: string; onDone(a: Agent): void }) {
  const [d, setD] = useState<Partial<Agent>>({ name: bot.name, description: bot.description, provider_id: bot.provider_id, model: bot.model });
  const engines = useEngineChoices(true, bot.provider_id || providerId);
  const engineKey = d.provider_id ? 'p:' + d.provider_id : '';
  const save = useAsync();
  const examples = useMemo(() => STARTERS.map((s) => ({ name: s.name, description: s.description })), []);
  const submit = () =>
    save.run(async () => {
      if (!d.name?.trim()) throw new Error(translate('Geef de bot een naam'));
      const s = STARTERS.find((x) => x.name === d.name && x.description === d.description);
      const patch: Partial<Agent> = { name: d.name.trim(), description: d.description || '', provider_id: d.provider_id ?? bot.provider_id, model: d.model ?? bot.model, ...(s ? { role: s.role, instructions: s.instructions, avatar: s.avatar, color: s.color } : {}) };
      let a = await api.patch<Agent>(`/agents/${bot.id}`, patch);
      // a new name: the werkplek, still empty, takes it along (Teammap\Assistent → Teammap\Mila)
      if (a.name !== bot.name) {
        const r = await api.post<{ workspace: string; moved: boolean }>(`/folders/werkplek/${bot.id}/follow-name`, {}).catch(() => null);
        if (r?.moved) a = { ...a, workspace: r.workspace };
      }
      useApp.setState((x) => ({ agents: x.agents.map((y) => (y.id === a.id ? a : y)) }));
      toast(translate('Opgeslagen'), 'ok');
      onDone(a);
    });
  return (
    <Card className="space-y-6 p-5" data-testid="first-bot-edit">
      <div>
        <h1 className="text-xl font-bold tracking-tight">Aanpassen</h1>
        <p className="mt-0.5 text-sm text-muted">Alles is optioneel. Je kunt het later altijd wijzigen.</p>
      </div>
      <BotQuestions
        draft={d}
        set={(p) => setD((x) => ({ ...x, ...p }))}
        engines={engines}
        engineKey={engineKey}
        onEngine={(key) => key.startsWith('p:') && setD((x) => ({ ...x, provider_id: key.slice(2), model: '' }))}
        examples={examples}
        onExample={(x) => setD((y) => ({ ...y, name: x.name, description: x.description }))}
        kindQuestion={false}
      />
      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button variant="primary" className="flex-1 justify-center" loading={save.busy} onClick={submit}>
          Opslaan
        </Button>
        <Button variant="ghost" className="justify-center" onClick={() => onDone(bot)}>
          Terug
        </Button>
      </div>
    </Card>
  );
}

/** The last step: the phone (the phone card in Instellingen › Telefoon has the QR code), or later. */
function PhoneStep({ bot, onLater }: { bot: Agent; onLater(): void }) {
  return (
    <div className="space-y-5" data-testid="first-bot-phone">
      <div className="flex flex-col items-center text-center">
        <span className="flex h-16 w-16 items-center justify-center rounded-3xl bg-surface-3 text-fg">
          <Smartphone className="h-8 w-8" aria-hidden />
        </span>
        <h1 className="mt-4 text-[26px] font-extrabold leading-tight tracking-tight">Koppel je telefoon</h1>
        <p className="mt-1.5 max-w-sm text-[15px] leading-relaxed text-muted">{t('Praat ook onderweg met {0}. Scan één keer een QR-code.', bot.name)}</p>
      </div>
      <div className="flex flex-col gap-2 sm:flex-row-reverse">
        <Button variant="primary" size="lg" className="flex-1 justify-center" icon={<QrCode className="h-4 w-4" />} onClick={() => navigate(PHONE_CARD)}>
          Koppel je telefoon
        </Button>
        <Button size="lg" variant="ghost" className="justify-center" onClick={onLater}>
          Later
        </Button>
      </div>
      <p className="text-center text-xs text-muted">Je vindt dit altijd terug bij Instellingen › Telefoon.</p>
    </div>
  );
}
