import { useEffect, useRef, useState } from 'react';
import { MessageSquare, Plus, Search, Star, Upload } from 'lucide-react';
import { api } from '../lib/api';
import { t } from '../lib/i18n';
import { upsert, useApp } from '../lib/store';
import type { Agent } from '../lib/types';
import { Badge, Button, EmptyState, Input, Page, PageHeader, Toggle, toast, toastError } from '../components/ui';
import { BotFace, LiveBotAvatar } from '../components/BotFace';
import { useAgentMood } from '../lib/mood';
import { MOOD_LABELS } from '../lib/botface';
import { botModelText } from '../lib/modelLabel';

/** The bot's state as text next to its face (the face alone never carries the status). */
function MoodBadge({ agent }: { agent: Agent }) {
  const mood = useAgentMood(agent);
  if (mood === 'idle') return null;
  // An archived (paused) bot keeps its sleeping face, and the text says why it sleeps.
  const tone = mood === 'paused' ? 'neutral' : mood === 'waiting' || mood === 'limit' ? 'warn' : mood === 'error' ? 'danger' : 'ok';
  return <Badge tone={tone}>{MOOD_LABELS[mood]}</Badge>;
}

export function AgentsPage() {
  const agents = useApp((s) => s.agents);
  const providers = useApp((s) => s.providers);
  const [q, setQ] = useState('');
  const [archived, setArchived] = useState(false);
  const [archivedList, setArchivedList] = useState<Agent[] | null>(null);
  const file = useRef<HTMLInputElement>(null);
  // The model each bot really used last ("default" on a CLI shows e.g. "Opus 5.5" instead of "default").
  const [lastModels, setLastModels] = useState<Record<string, string>>({});
  useEffect(() => {
    api
      .get<Record<string, string>>('/agents/last-models')
      .then((r) => setLastModels(r && typeof r === 'object' ? r : {}))
      .catch(() => {});
  }, []);
  const list = (archived ? archivedList || [] : agents.filter((a) => !a.archived)).filter((a) => !q || (a.name + a.role + a.description).toLowerCase().includes(q.toLowerCase()));

  const togglePin = async (a: Agent) => {
    try {
      const x = await api.patch<Agent>(`/agents/${a.id}`, { pinned: !a.pinned });
      useApp.setState((s) => ({ agents: s.agents.map((y) => (y.id === x.id ? x : y)) }));
    } catch (e) {
      toastError(e);
    }
  };

  // An archived bot comes back from its card in Archief (before, only from the menu in its chat).
  const unarchive = async (a: Agent) => {
    try {
      const x = await api.patch<Agent>(`/agents/${a.id}`, { archived: false });
      useApp.setState((s) => ({ agents: upsert(s.agents, x) }));
      setArchivedList((l) => (l || []).filter((y) => y.id !== x.id));
      toast(`${x.name} is terug uit het archief`, 'ok');
    } catch (e) {
      toastError(e);
    }
  };

  const importFile = async (f: File) => {
    try {
      const json = JSON.parse(await f.text());
      if (json.format === 'teambot.agent/v1') {
        const a = await api.post<Agent>('/agents/import', json);
        useApp.setState((s) => ({ agents: upsert(s.agents, a) }));
        toast(`${a.name} geïmporteerd`, 'ok');
      } else if (json.format === 'teambot.bot-template/v1') {
        // The file from the bot editor (Geavanceerd › Sjabloon en delen › Exporteren als bestand): install it the way
        // the marketplace does, so export → import works with the one import button people find first.
        await api.post('/skills/templates/install', { template: json });
        await useApp.getState().refreshAgents();
        toast(`${json.name || 'Bot'} geïmporteerd`, 'ok');
      } else if (json.format === 'teambot.team/v1') {
        // A whole team (bots + group): imported where groups are made, with its preview.
        toast('Dit is een teampakket. Importeer het via Groepen › Nieuwe groep › Team importeren.', 'neutral');
        location.hash = '#/m/rooms';
      } else if (Array.isArray(json.agents)) {
        const r = await api.post<{ created: number }>('/import/agents', { agents: json.agents });
        await useApp.getState().refreshAgents();
        toast(t('{0, plural, one {# bot geïmporteerd} other {# bots geïmporteerd}}', r.created), 'ok');
      } else throw new Error('Onbekend bestandsformaat');
    } catch (e) {
      toastError(e);
    }
  };

  return (
    <Page>
      <PageHeader
        title="Alle bots"
        width="4xl"
        actions={
          <>
            <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && (importFile(e.target.files[0]), (e.target.value = ''))} />
            <Button icon={<Upload className="h-4 w-4" />} onClick={() => file.current?.click()}>
              Importeren
            </Button>
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => (location.hash = '#/agents/new')}>
              Nieuwe bot
            </Button>
          </>
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 px-4 pb-8 pt-3 sm:px-6">
        <div className="flex flex-wrap items-center gap-3">
          <div className="relative min-w-0 flex-1">
            <Search className="pointer-events-none absolute start-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
            <Input className="ps-9" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Zoek bot…" aria-label="Zoek bot" />
          </div>
          <Toggle
            checked={archived}
            onChange={(v) => {
              setArchived(v);
              if (v) api.get<Agent[]>('/agents?archived=1').then((l) => setArchivedList(l.filter((a) => a.archived))).catch(toastError);
            }}
            label="Archief"
          />
        </div>
        {list.length === 0 ? (
          <EmptyState
            art={<BotFace seed="leeg" traits={{ shape: 'egg', color: 'sky', eyes: 'look', mouth: 'smile', extra: 'sprout', cheeks: true }} size={72} />}
            title={archived ? 'Het archief is leeg' : q ? 'Geen bot gevonden' : 'Nog geen bots'}
            action={!archived && !q ? <Button variant="primary" onClick={() => (location.hash = '#/agents/new')}>Maak je eerste bot</Button> : undefined}
          />
        ) : (
          // One calm list: face, name, what the bot does. Nothing technical here (the AI and model are on the bot's
          // own page, and in the tooltip of the row); only a bot without an AI says so, because then it cannot answer.
          <div className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
            {list.map((a) => {
              const provider = providers.find((p) => p.id === a.provider_id);
              return (
                <div key={a.id} className="group flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3" title={provider ? `${provider.name} · ${botModelText(a.model, lastModels[a.id])}` : undefined}>
                  <a href={`#/a/${a.id}`} tabIndex={-1} aria-hidden>
                    <LiveBotAvatar bot={a} size={40} />
                  </a>
                  <div className="min-w-0 flex-1 basis-40">
                    <div className="flex items-center gap-2">
                      <a href={`#/a/${a.id}`} className="truncate font-bold hover:underline">
                        {a.name}
                      </a>
                      <MoodBadge agent={a} />
                      {!provider && <Badge tone="warn">geen AI gekoppeld</Badge>}
                    </div>
                    <div className="truncate text-[13px] text-muted" translate={a.role || a.description ? 'no' : undefined}>
                      {a.role || a.description || 'Bot'}
                    </div>
                  </div>
                  <div className="flex shrink-0 items-center gap-1">
                    {!a.archived && (
                      <Button size="sm" variant="ghost" onClick={() => togglePin(a)} aria-pressed={a.pinned} aria-label={a.pinned ? 'Niet meer bovenaan zetten' : 'Bovenaan in je lijst zetten'} title={a.pinned ? 'Niet meer bovenaan zetten' : 'Bovenaan in je lijst zetten'}>
                        <Star className={a.pinned ? 'h-4 w-4 fill-current' : 'h-4 w-4'} aria-hidden />
                      </Button>
                    )}
                    {a.archived && (
                      <Button size="sm" variant="ghost" onClick={() => unarchive(a)}>
                        Bot uit archief halen
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" icon={<MessageSquare className="h-4 w-4" />} onClick={() => (location.hash = `#/a/${a.id}`)}>
                      Chatten
                    </Button>
                    <Button size="sm" onClick={() => (location.hash = `#/agents/${a.id}`)}>
                      Instellingen
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </Page>
  );
}
