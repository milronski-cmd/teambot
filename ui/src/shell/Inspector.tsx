import { useEffect, useMemo, useState } from 'react';
import { Check, FileText, Loader2, Square, X } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { api, on } from '../lib/api';
import { useRunning } from '../modules/browser/BrowserDock';
import { agentById, useApp } from '../lib/store';
import type { Message, Thread } from '../lib/types';
import { stripRefs } from '../lib/preview';
import { plainStep, toolLabel } from './toolLabels';
import { BotFilesInThread } from '../modules/seen/parts';
import { useAdvanced } from './advanced';
import { ContextUse } from './ContextUse';

/** Step kinds that are real work (files, web, commands, apps), not housekeeping (session, mode, notices). */
const STEP_KINDS = new Set(['tool', 'tool_error', 'files', 'denied']);
import { uiModules } from '../modules';
import { Badge, Button, Tabs, timeAgo, toastError } from '../components/ui';
import { BotAvatar } from '../components/BotFace';
import { AttachmentLink } from '../components/FilePreview';
import { t, uiLocale } from '../lib/i18n';
import { formatUsd } from '../lib/format';
import { CopyPath, isOwnWorkspace } from '../components/FolderName';
import { botModelText } from '../lib/modelLabel';

const runStatus: Record<string, string> = { queued: 'In de wachtrij', running: 'Bezig', waiting: 'Wacht op jou', done: 'Klaar', error: 'Fout', cancelled: 'Gestopt', interrupted: 'Onderbroken' };

/**
 * Right-hand panel next to a chat. For a normal user it has one purpose: the files of this conversation (no tabs). Two
 * more views join only while they have something to show: the bot's computer while it uses a browser or the screen (or
 * when the owner asked for it with the header button), and "Wijzigingen" while a rehearsal waits to be kept or undone.
 * What the bot remembers is on the bot's own page. Everything else (activity log, memory, team, CLI sessions, details)
 * is for "Geavanceerd tonen".
 */
export function Inspector({ thread, onClose, initialTab }: { thread: Thread; onClose(): void; initialTab?: string }) {
  const advanced = useAdvanced();
  const botId = thread.kind === 'room' ? null : thread.agent_id;
  const usingComputer = useRunning((s) => !!(botId && s[botId]));
  const rehearsal = useHasRehearsal(botId);
  const modTabs = uiModules.flatMap((m) => (m.inspectorTabs || []).map((t) => ({ ...t, key: `${m.id}:${t.id}` })));
  const all = [{ id: 'activity', label: 'Activiteit' }, { id: 'files', label: 'Bestanden' }, ...modTabs.map((t) => ({ id: t.key, label: t.title })), { id: 'details', label: 'Details' }];
  const simple = new Set(['files', ...(usingComputer || initialTab === 'browser:computer' ? ['browser:computer'] : []), ...(rehearsal || initialTab === 'browser:changes' ? ['browser:changes'] : [])]);
  const tabs = advanced ? all : all.filter((t) => simple.has(t.id));
  const [picked, setTab] = useState<string>(initialTab && all.some((t) => t.id === initialTab) ? initialTab : advanced ? 'activity' : 'files');
  // Switching "Geavanceerd tonen" off while an expert tab is open falls back to the first simple tab.
  const tab = tabs.some((t) => t.id === picked) ? picked : tabs[0]?.id || 'files';
  const Mod = modTabs.find((t) => t.key === tab)?.component;
  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-4 pt-3">
        <h2 className="text-[15px] font-bold tracking-tight">{tabs.length > 1 ? 'Zijpaneel' : 'Bestanden van dit gesprek'}</h2>
        <Button variant="ghost" size="icon" aria-label="Zijpaneel sluiten" onClick={onClose}>
          <X className="h-4 w-4" />
        </Button>
      </div>
      {tabs.length > 1 && (
        <div className="px-3 pt-1">
          <Tabs tabs={tabs} value={tab} onChange={setTab} />
        </div>
      )}
      <div className="scroll-thin min-h-0 flex-1 overflow-y-auto p-4">
        {tab === 'activity' && <Activity thread={thread} />}
        {tab === 'files' && <Files thread={thread} />}
        {tab === 'details' && <Details thread={thread} />}
        {Mod && <Mod threadId={thread.id} agentId={thread.agent_id} />}
      </div>
    </div>
  );
}

function Activity({ thread }: { thread: Thread }) {
  const runs = useApp(useShallow((s) => s.runs.filter((r) => r.thread_id === thread.id)));
  const messages = useApp((s) => s.messages[thread.id]) || [];
  // API bots: their tool calls. CLI bots (Claude Code, Codex, OpenCode): the steps of each answer, in words.
  const calls = useMemo(() => {
    const results = new Map(messages.filter((m) => m.role === 'tool' && m.parts.toolResult).map((m) => [m.parts.toolResult!.toolCallId, m]));
    const out: { key: string; m: Message; title: string; detail: string; state: 'ok' | 'error' | 'busy' }[] = [];
    for (const m of messages) {
      if (m.role !== 'assistant') continue;
      for (const c of m.parts.toolCalls || []) {
        const r = results.get(c.id);
        out.push({ key: c.id, m, title: toolLabel(c, false), detail: c.summary || '', state: r ? (r.parts.toolResult?.isError ? 'error' : 'ok') : m.status === 'streaming' ? 'busy' : 'ok' });
      }
      (m.parts.activity || []).forEach((a, i) => {
        // TeamBot's own tools used by a CLI only report when done ("TeamBot · …").
        if (!STEP_KINDS.has(a.kind) && !(a.kind === 'tool_result' && a.title.startsWith('TeamBot · '))) return;
        out.push({ key: `${m.id}:${i}`, m, title: plainStep(stripRefs(a.title)), detail: a.kind === 'tool_error' ? stripRefs(a.detail || '') : '', state: a.kind === 'tool_error' || a.kind === 'denied' ? 'error' : 'ok' });
      });
    }
    return out.reverse().slice(0, 100);
  }, [messages]);
  return (
    <div className="space-y-4">
      <div>
        <div className="mb-2 text-[11.5px] font-bold uppercase tracking-wider text-muted">Lopende taken</div>
        {runs.length === 0 && <p className="text-sm text-muted">Geen taak actief.</p>}
        <div className="space-y-2">
          {runs.map((r) => {
            const a = agentById(r.agent_id);
            return (
              <div key={r.id} className="flex items-center gap-2.5 rounded-xl bg-surface-2 p-2.5 text-sm">
                <BotAvatar bot={a || { id: r.agent_id }} size={24} mood="working" />
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{a?.name}</div>
                  <div className="text-xs text-muted">
                    {runStatus[r.status]} · {timeAgo(r.created_at)}
                  </div>
                </div>
                <Button size="sm" variant="ghost" aria-label="Taak stoppen" onClick={() => api.post(`/runs/${r.id}/cancel`).catch(toastError)}>
                  <Square className="h-3.5 w-3.5 fill-current" />
                </Button>
              </div>
            );
          })}
        </div>
      </div>
      <div>
        <div className="mb-2 text-[11.5px] font-bold uppercase tracking-wider text-muted">Stappen in dit gesprek</div>
        {calls.length === 0 && <p className="text-sm text-muted">Nog geen stappen.</p>}
        <ol className="space-y-1.5">
          {calls.map(({ key, m, title, detail, state }) => (
            <li key={key}>
              <a href={`#/t/${thread.id}`} onClick={(e) => (e.preventDefault(), document.getElementById(`m-${m.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))} className="flex items-start gap-2 rounded-lg px-1.5 py-1 text-xs hover:bg-surface-2">
                {state === 'error' ? <X className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" aria-label="mislukt" /> : state === 'busy' ? <Loader2 className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin text-muted" aria-label="bezig" /> : <Check className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden />}
                <div className="min-w-0 flex-1">
                  <div className="break-words font-medium">{title}</div>
                  {detail && <div className="truncate text-muted">{detail}</div>}
                </div>
                <span className="shrink-0 text-muted">{timeAgo(m.created_at)}</span>
              </a>
            </li>
          ))}
        </ol>
      </div>
    </div>
  );
}

/**
 * The panel's one purpose: the files of this conversation. What the bot made or changed here comes first (a click shows
 * it, the arrow opens its folder), then what was sent along in the chat. Nothing yet: one quiet line, no headed empty
 * boxes and no explanation of how folders work.
 */
function Files({ thread }: { thread: Thread }) {
  const messages = useApp((s) => s.messages[thread.id]) || [];
  const files = messages.flatMap((m) => (m.parts.attachments || []).map((a) => ({ a, m }))).reverse();
  const agent = agentById(thread.agent_id);
  const oneBot = !!agent && thread.kind !== 'room';
  // -1 = not known yet (the list of the bot's files is still loading).
  const [made, setMade] = useState(oneBot ? -1 : 0);
  const empty = made === 0 && files.length === 0;
  return (
    <div className="space-y-1">
      {oneBot && <BotFilesInThread bare agentId={agent.id} threadId={thread.id} onCount={setMade} />}
      {files.length > 0 && (
        <ul className="space-y-0.5" aria-label="Meegestuurd in dit gesprek">
          {files.map(({ a, m }) => (
            <li key={a.id + m.id}>
              <AttachmentLink a={a} className="flex w-full items-center gap-2 rounded-control px-2 py-1.5 text-start text-sm transition-colors hover:bg-surface-2 coarse:py-2.5">
                <FileText className="h-4 w-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                <span className="shrink-0 text-xs text-muted">{m.author_name}</span>
              </AttachmentLink>
            </li>
          ))}
        </ul>
      )}
      {empty && <p className="px-2 py-1 text-sm text-muted">{agent && oneBot ? t('Wat {0} in dit gesprek maakt of aanpast, komt hier te staan.', agent.name) : 'Nog geen bestanden in dit gesprek.'}</p>}
      {agent && made > 0 && (
        <div className="flex items-center gap-1 px-2 pt-2 text-xs text-muted">
          {t('Werkmap van {0}', agent.name)}
          <CopyPath path={agent.workspace} />
          {!isOwnWorkspace(agent.workspace) && <span className="min-w-0 truncate font-mono">{agent.workspace}</span>}
        </div>
      )}
    </div>
  );
}

/** True when this bot has a rehearsal (changes to keep or undo): only then the panel offers "Wijzigingen". */
function useHasRehearsal(agentId: string | null | undefined): boolean {
  const [has, setHas] = useState(false);
  useEffect(() => {
    if (!agentId) return setHas(false);
    let live = true;
    const load = () =>
      api
        .get<{ rehearsal: unknown | null }>(`/computers/${agentId}/rehearsal`)
        .then((d) => live && setHas(!!d?.rehearsal))
        .catch(() => live && setHas(false));
    load();
    const off = on('rehearsal.updated', load);
    return () => {
      live = false;
      off();
    };
  }, [agentId]);
  return has;
}

function Details({ thread }: { thread: Thread }) {
  const messages = useApp((s) => s.messages[thread.id]) || [];
  const agent = agentById(thread.agent_id);
  const usage = messages.reduce((acc, m) => ({ input: acc.input + (m.usage?.input || 0), output: acc.output + (m.usage?.output || 0), cost: acc.cost + (m.usage?.cost || 0) }), { input: 0, output: 0, cost: 0 });
  const rows: [string, React.ReactNode][] = [
    ['Soort', thread.kind],
    ['Aangemaakt', new Date(thread.created_at).toLocaleString(uiLocale())],
    ['Laatst actief', new Date(thread.updated_at).toLocaleString(uiLocale())],
    ['Berichten', messages.filter((m) => m.role !== 'tool').length],
    ['Tokens (in/uit)', `${usage.input.toLocaleString(uiLocale())} / ${usage.output.toLocaleString(uiLocale())}`],
    ['Geschatte kosten', usage.cost ? formatUsd(usage.cost, { max: 4 }) : '—'],
  ];
  return (
    <div className="space-y-4 text-sm">
      {agent && (
        <a href={`#/agents/${agent.id}`} className="flex items-center gap-3 rounded-2xl bg-surface-2 p-3 hover:bg-surface-3">
          <BotAvatar bot={agent} size={40} />
          <div className="min-w-0">
            <div className="font-medium">{agent.name}</div>
            <div className="truncate text-xs text-muted">{agent.role || agent.description}</div>
          </div>
          <Badge className="ms-auto">{agent.provider_id ? botModelText(agent.model) : 'geen model'}</Badge>
        </a>
      )}
      <dl className="space-y-1.5">
        {rows.map(([k, v]) => (
          <div key={k} className="flex justify-between gap-3">
            <dt className="text-muted">{k}</dt>
            <dd className="text-end">{v}</dd>
          </div>
        ))}
      </dl>
      <ContextUse thread={thread} />
      {thread.meta?.summary && (
        <details className="rounded-lg border border-line p-3 text-xs">
          <summary className="cursor-pointer font-medium">Samenvatting van het oudere deel</summary>
          <div className="mt-2 whitespace-pre-wrap text-muted">{thread.meta.summary}</div>
        </details>
      )}
      <p className="text-xs text-muted">Kosten zijn een schatting op basis van publieke prijzen; je provider factureert rechtstreeks.</p>
    </div>
  );
}
