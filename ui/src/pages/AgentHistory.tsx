import { useEffect, useState } from 'react';
import { ArrowRight, GitCompare, History, RotateCcw } from 'lucide-react';
import { api, on } from '../lib/api';
import { useApp } from '../lib/store';
import type { Agent } from '../lib/types';
import { Button, Card, Spinner, timeAgo, toast, toastError } from '../components/ui';
import { LABEL, showValue } from '../lib/historyText';
import { DiffLegend, DiffView } from '../shell/DiffView';
import { uiLocale } from '../lib/i18n';

interface Version {
  id: number;
  created_at: string;
  reason: string;
  changed: string[];
  data: Partial<Agent>;
}

/** Fields compared word by word; the others are shown as "was → werd" in plain words. */
const TEXT_FIELDS = new Set(['name', 'role', 'description', 'instructions']);
/** Fields that are part of a version (server/api/agent-versions.ts VERSIONED). */
const VERSIONED = ['name', 'avatar', 'color', 'role', 'description', 'instructions', 'provider_id', 'model', 'reasoning', 'access_mode', 'workspace', 'tool_groups', 'tool_policy', 'skills', 'fallback', 'busy_policy', 'settings'] as const;

type Names = { provider(id: string): string | undefined; group(id: string): string | undefined };

function same(a: any, b: any) {
  return JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
}

/** One field: a word diff for text, otherwise the old and new value in words. */
function FieldChange({ k, before, after, names }: { k: string; before: any; after: any; names: Names }) {
  const label = LABEL[k] || 'overig';
  return (
    <div className="rounded-lg border border-line p-2.5 text-xs">
      <div className="mb-1.5 font-semibold first-letter:uppercase">{label}</div>
      {TEXT_FIELDS.has(k) ? (
        <DiffView before={String(before ?? '')} after={String(after ?? '')} label={`Verschil in ${label}`} />
      ) : k === 'avatar' || k === 'color' ? (
        <p className="text-muted">Het gezicht is veranderd.</p>
      ) : (
        <div className="grid gap-1.5 sm:grid-cols-[1fr_auto_1fr] sm:items-start">
          <div className="min-w-0 rounded bg-danger-soft px-2 py-1.5">
            <div className="text-[11px] font-semibold text-danger">Was</div>
            <div className="whitespace-pre-wrap break-words text-fg">{showValue(k, before, names)}</div>
          </div>
          <ArrowRight className="hidden h-3.5 w-3.5 self-center text-muted sm:block" aria-hidden />
          <div className="min-w-0 rounded bg-ok-soft px-2 py-1.5">
            <div className="text-[11px] font-semibold text-ok">Werd</div>
            <div className="whitespace-pre-wrap break-words text-fg">{showValue(k, after, names)}</div>
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * Profile history (BOT-10): per saved change what changed, as a readable diff between that version and the one after
 * it; "Vergelijken met nu" shows how a version differs from the bot today; one-click restore (itself versioned).
 * `bare`: without its own card and title (inside a collapsible editor section).
 */
export function AgentHistory({ agent, onRestored, bare }: { agent: Agent; onRestored(a: Agent): void; bare?: boolean }) {
  const [list, setList] = useState<Version[] | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [compare, setCompare] = useState<number | null>(null);
  const providers = useApp((s) => s.providers);
  const current = useApp((s) => s.agents.find((a) => a.id === agent.id)) || agent;
  const [groups, setGroups] = useState<Record<string, string>>({});
  useEffect(() => {
    api.get<{ groups: { id: string; label: string }[] }>('/tools').then((r) => setGroups(Object.fromEntries(r.groups.map((g) => [g.id, g.label])))).catch(() => {});
  }, []);
  const names: Names = { provider: (id: string) => providers.find((p) => p.id === id)?.name, group: (id: string) => groups[id] };
  const load = () => api.get<Version[]>(`/agents/${agent.id}/versions`).then(setList).catch(() => setList([]));
  useEffect(() => {
    load();
    return on('agent.updated', (a: Agent) => a.id === agent.id && load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);
  const restore = async (v: Version) => {
    try {
      const a = await api.post<Agent>(`/agents/${agent.id}/versions/${v.id}/restore`);
      useApp.setState((s) => ({ agents: s.agents.map((x) => (x.id === a.id ? a : x)) }));
      onRestored(a);
      toast('Versie teruggezet (de huidige staat is als nieuwe versie bewaard)', 'ok');
    } catch (e) {
      toastError(e);
    }
  };
  const Wrap = bare ? 'div' : Card;
  return (
    <Wrap className={bare ? 'space-y-3' : 'space-y-3 p-5'}>
      {!bare && (
        <div className="flex items-center gap-2 font-semibold">
          <History className="h-4 w-4" /> Geschiedenis
        </div>
      )}
      {!list ? (
        <Spinner />
      ) : list.length === 0 ? (
        <p className="text-sm text-muted">Nog geen eerdere versies. Wat je opslaat, kun je hier later terugzetten.</p>
      ) : (
        <>
          <p className="text-xs text-muted">Klik op een wijziging om te zien wat er veranderde.</p>
          <ul className="divide-y divide-line">
            {list.map((v, i) => {
              // A version stores the profile as it was BEFORE that change; the state after it is the next newer version.
              const after: Partial<Agent> = i === 0 ? current : list[i - 1].data;
              const fields = [...new Set(v.changed)].filter((k) => !same((v.data as any)[k], (after as any)[k]));
              const nowDiff = VERSIONED.filter((k) => !same((v.data as any)[k], (current as any)[k]));
              const isOpen = open === v.id;
              const isCompare = compare === v.id;
              return (
                <li key={v.id} className="py-2 text-sm">
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <button className="min-w-0 flex-1 rounded text-start hover:underline" onClick={() => (setOpen(isOpen ? null : v.id), setCompare(null))} aria-expanded={isOpen}>
                      <span className="text-muted" title={new Date(v.created_at).toLocaleString(uiLocale())}>
                        {timeAgo(v.created_at)} ·{' '}
                      </span>
                      {v.reason === 'restore' ? 'teruggezet' : 'gewijzigd'}: {[...new Set(v.changed.map((c) => LABEL[c] || 'overig'))].join(', ')}
                    </button>
                    <Button size="sm" variant="ghost" icon={<GitCompare className="h-3.5 w-3.5" />} aria-pressed={isCompare} onClick={() => (setCompare(isCompare ? null : v.id), setOpen(null))} title="Hoe verschilt deze versie van de bot nu?">
                      Vergelijken met nu
                    </Button>
                    <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => restore(v)} title="De bot terugzetten naar hoe hij vóór deze wijziging was">
                      Terugzetten
                    </Button>
                  </div>
                  {isOpen && (
                    <div className="mt-2 space-y-2">
                                            {fields.length ? fields.map((k) => <FieldChange key={k} k={k} before={(v.data as any)[k]} after={(after as any)[k]} names={names} />) : <p className="text-xs text-muted">Deze wijziging is later weer ongedaan gemaakt; er is geen verschil meer te zien.</p>}
                      <DiffLegend />
                    </div>
                  )}
                  {isCompare && (
                    <div className="mt-2 space-y-2">
                      <p className="text-xs text-muted">Zo verschilt de versie van vóór deze wijziging van de bot nu.</p>
                      {nowDiff.length ? nowDiff.map((k) => <FieldChange key={k} k={k} before={(v.data as any)[k]} after={(current as any)[k]} names={names} />) : <p className="text-xs text-muted">Geen verschil: de bot is nu precies zo.</p>}
                      <DiffLegend />
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Wrap>
  );
}
