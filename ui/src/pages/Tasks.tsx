import React, { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';
import { Activity, CircleAlert, Flag, FlaskConical, ListChecks, MessageSquare, Paperclip, Plus, Repeat, Scale, ScrollText, Table2, Trash2, Users, Waypoints } from 'lucide-react';
import { useAdvanced } from '../shell/advanced';
import { api, on } from '../lib/api';
import { useApp } from '../lib/store';
import { useIsDesktop } from '../lib/media';
import { query } from '../lib/router';
import { t as tr, uiLocale } from '../lib/i18n';
import { askConfirm, Badge, Button, EmptyState, Field, Input, Modal, Page, PageHeader, Select, cx, toast, toastError } from '../components/ui';
import { Menu, PageLinks, Skeleton } from '../components/overview';
import { teamApi, teamTaskRef, useTeamChanged, useTeamPick } from '../modules/teamdata/api';
import { BotName, Chips, Fields, Linkified, SearchBox, When, dateLabel } from '../modules/teamdata/parts';
import { type BoardTask, type ColumnId, type Place, COLUMNS, PHONE_ORDER, TEAM_STATUS_FOR, byPlace, matches, mergeTasks, timeValue } from './tasks/model';
import { CheckBadge, TaskQuality } from '../modules/quality/parts';
import type { QualityView } from '../../../shared/quality.js';
import { useTeamView } from '../modules/teams/scope';
import { CostEstimate } from '../modules/usage/Estimate';
import { TeamFilterNote } from '../modules/teams/FilterNote';
import { hiddenTaskKeys } from '../shell/teamFilter';
import { tText } from '../lib/format';

/** The task a link asks to open (`#/tasks?open=b:<id>` or `t:<id>`, as Ctrl+K gives), else null. */
function openParam(): string | null {
  const v = query().get('open');
  return v && /^[bt]:[\w:-]{1,120}$/.test(v) ? v : null;
}

/**
 * Two things a person understands, as two links under the title: Taken (this board) and Automatisch (everything that
 * runs by itself: vaste taken, routines and workflows in one list). What bots do right now is a line on the board
 * itself; the log of Teamwerk (and, with Geavanceerd tonen, its other tables) sits behind the "⋯" of the page.
 */
const TEAMWORK_LINKS = [
  { tab: 'beslissingen', label: 'Beslissingen', icon: Scale },
  { tab: 'gebeurtenissen', label: 'Gebeurtenissen', icon: Waypoints },
  { tab: 'experimenten', label: 'Experimenten', icon: FlaskConical },
  { tab: 'tabellen', label: 'Tabellen', icon: Table2 },
];

function TeamworkLinks() {
  return (
    <PageLinks
      label="Taken en automatisch werk"
      items={[
        { href: '#/tasks', label: 'Taken', icon: <ListChecks aria-hidden />, current: true },
        { href: '#/m/routines/', label: 'Automatisch', icon: <Repeat aria-hidden /> },
      ]}
    />
  );
}

/** Behind the "⋯" of the page: what is rarely needed. */
function BoardMenu() {
  const advanced = useAdvanced();
  return (
    <Menu
      label="Meer opties"
      variant="secondary"
      items={[
        { label: 'Nu bezig', icon: <Activity />, href: '#/m/usage/status' },
        { label: 'Logboek', icon: <ScrollText />, href: '#/m/teamdata/logboek' },
        ...(advanced ? TEAMWORK_LINKS.map((l) => ({ label: l.label, icon: <l.icon />, href: `#/m/teamdata/${l.tab}` })) : []),
      ]}
    />
  );
}

/**
 * "Nu bezig" as one line on the board: which bots work right now, with a way to look. Nothing when nobody works.
 * Refreshed when a run starts or ends.
 */
function WorkingNow() {
  const [names, setNames] = useState<string[]>([]);
  useEffect(() => {
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const load = () =>
      api
        .get<{ runs: { agentName: string }[] }>('/usage/status')
        .then((r) => alive && setNames([...new Set((r.runs || []).map((x) => x.agentName).filter(Boolean))]))
        .catch(() => {});
    void load();
    const off = on('run.updated', () => {
      if (timer) return;
      timer = setTimeout(() => {
        timer = null;
        void load();
      }, 1200);
    });
    return () => {
      alive = false;
      off();
      if (timer) clearTimeout(timer);
    };
  }, []);
  if (!names.length) return null;
  return (
    <a href="#/m/usage/status" data-testid="working-now" className="tb-in flex items-center gap-3 rounded-card border border-line bg-surface px-4 py-2.5 text-sm hover:border-line-strong">
      <span className="tb-pulse h-2 w-2 shrink-0 rounded-full bg-ok" aria-hidden />
      <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">
        <span className="font-semibold" translate="no">
          {names.slice(0, 3).join(', ')}
          {names.length > 3 ? ` +${names.length - 3}` : ''}
        </span>{' '}
        <span className="text-muted">{names.length === 1 ? 'is nu aan het werk' : 'zijn nu aan het werk'}</span>
      </span>
      <span className="shrink-0 font-semibold">Nu bezig</span>
    </a>
  );
}

/** A group the owner can put a task on (GET /api/rooms). */
interface GroupLite {
  id: string;
  name: string;
  invited?: boolean;
  access?: 'owner' | 'member' | 'guest' | null;
}

const STOPPED = { id: 'stopped' as const, label: 'Gestopt', hint: 'Geannuleerd of vervallen' };
const placeLabel = (p: Place) => (p === 'stopped' ? STOPPED.label : COLUMNS.find((c) => c.id === p)!.label);

/** Move a card: TeamBot's own board takes the column as status; the team database gets its own word for it. */
async function moveTask(t: BoardTask, to: ColumnId) {
  if (t.source === 'board') await api.patch(`/rooms/tasks/${t.id}`, { status: to });
  else await teamApi.setTaskStatus(Number(t.id), TEAM_STATUS_FOR[to]);
}

/** Moves a card and tells the board; a failure is said and the card stays where it was. */
async function moveAndTell(t: BoardTask, to: ColumnId, onMoved: () => void) {
  if (to === t.column) return;
  try {
    await moveTask(t, to);
    onMoved();
  } catch (err) {
    toastError(err);
  }
}

/** The status as a dropdown, in the details of a task. */
function StatusSelect({ t, onMoved, className }: { t: BoardTask; onMoved(): void; className?: string }) {
  const [busy, setBusy] = useState(false);
  return (
    <Select
      className={className}
      disabled={busy}
      value={t.column === 'stopped' ? '' : t.column}
      aria-label={tText('Status van {0}', t.title)}
      onChange={async (e) => {
        const to = e.target.value as ColumnId;
        if (!to) return;
        setBusy(true);
        await moveAndTell(t, to, onMoved);
        setBusy(false);
      }}
    >
      {t.column === 'stopped' && <option value="">{t.status.replace(/_/g, ' ') || STOPPED.label}</option>}
      {COLUMNS.map((c) => (
        <option key={c.id} value={c.id}>
          {c.label}
        </option>
      ))}
    </Select>
  );
}

/**
 * The one thing a card says about its state, most urgent first: it waits for you, what the second look said, it is
 * important, its deadline. Otherwise only when it last changed. Everything else is in the details.
 */
function CardSignal({ t }: { t: BoardTask }) {
  const check = (t.quality as QualityView | null)?.check?.state;
  if (t.waitsForYou) return <Badge tone="warn">Wacht op jou</Badge>;
  if (check && check !== 'none') return <CheckBadge state={check} />;
  if (t.important) return <Badge tone="warn">Belangrijk</Badge>;
  if (t.deadline && t.column !== 'done') return <Badge>{dateLabel(t.deadline)}</Badge>;
  return <When value={t.updated} className="text-xs text-muted" />;
}

/** The task being dragged (HTML drag and drop carries only text; the board keeps the task itself). */
let dragged: BoardTask | null = null;

/**
 * A card: what, who, and one signal. Moving goes by dragging it to another column (mouse) or through the "⋯" menu
 * (keyboard, touch, screen reader); a click opens the details.
 */
function TaskCard({ t, onOpen, onMoved }: { t: BoardTask; onOpen(): void; onMoved(): void }) {
  const [drag, setDrag] = useState(false);
  return (
    <article
      data-task-card
      aria-label={t.title}
      draggable
      onDragStart={(e) => {
        dragged = t;
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', t.title);
        setDrag(true);
      }}
      onDragEnd={() => {
        dragged = null;
        setDrag(false);
      }}
      className={cx('tb-in relative rounded-xl border border-line bg-surface text-sm transition-[opacity,border-color] duration-150 hover:border-line-strong', drag && 'opacity-40')}
    >
      <button type="button" onClick={onOpen} className="block w-full rounded-xl p-3 text-start">
        <span className="line-clamp-3 block pe-7 font-semibold leading-snug [overflow-wrap:anywhere]" translate="no">
          {t.title}
        </span>
        {t.result && (
          <span className="mt-1 line-clamp-2 block text-[13px] leading-snug text-muted [overflow-wrap:anywhere]" translate="no">
            {t.result}
          </span>
        )}
        <span className="mt-2.5 flex min-w-0 flex-wrap items-center justify-between gap-x-2 gap-y-1 text-xs text-muted">
          {t.owner ? <BotName name={t.owner} size={18} bold={false} /> : <span>Nog niemand</span>}
          <CardSignal t={t} />
        </span>
      </button>
      <Menu
        label={tr('Acties voor {0}', t.title)}
        size="iconSm"
        className="!absolute end-1.5 top-1.5"
        testId="task-menu"
        items={[
          { heading: 'Verplaatsen naar' },
          ...COLUMNS.map((c) => ({ label: c.label, checked: t.column === c.id, onSelect: () => void moveAndTell(t, c.id, onMoved) })),
          'sep',
          { label: 'Openen', onSelect: onOpen },
        ]}
      />
    </article>
  );
}

const PAGE = 25;

function Column({ id, label, hint, list, onOpen, onMoved }: { id: Place; label: string; hint: string; list: BoardTask[]; onOpen(t: BoardTask): void; onMoved(): void }) {
  const [all, setAll] = useState(false);
  const [over, setOver] = useState(false);
  const shown = all ? list : list.slice(0, PAGE);
  const droppable = id !== 'stopped';
  return (
    <div
      role="region"
      aria-label={`${label}: ${list.length}`}
      onDragOver={(e) => {
        if (!droppable || !dragged || dragged.column === id) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        setOver(true);
      }}
      onDragLeave={(e) => {
        if (!(e.relatedTarget instanceof Node) || !e.currentTarget.contains(e.relatedTarget)) setOver(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        const t = dragged;
        dragged = null;
        if (t && droppable) void moveAndTell(t, id as ColumnId, onMoved);
      }}
      className={cx('min-w-0 rounded-card border p-2 transition-colors duration-150', over ? 'border-line-strong bg-surface-3' : id === 'review' && list.length ? 'tb-ask' : 'border-transparent bg-surface-2')}
    >
      <div className="flex items-center justify-between gap-2 px-2 pb-2 pt-1">
        <h2 className="text-[13px] font-semibold">{label}</h2>
        <span className="text-xs tabular-nums text-muted">{list.length}</span>
      </div>
      <div className="space-y-2">
        {shown.map((t) => (
          <TaskCard key={t.key} t={t} onOpen={() => onOpen(t)} onMoved={onMoved} />
        ))}
        {!list.length && <p className="px-2 pb-2 text-xs text-muted">{hint}</p>}
        {list.length > shown.length && (
          <Button size="sm" variant="ghost" className="w-full justify-center" onClick={() => setAll(true)}>
            Toon alle {list.length}
          </Button>
        )}
      </div>
    </div>
  );
}

/** The board while it loads: the columns with grey cards, so nothing jumps when the tasks arrive. */
function BoardSkeleton({ desk }: { desk: boolean }) {
  return (
    <div className={cx('grid items-start gap-3', desk && 'md:grid-cols-3 xl:grid-cols-5')} role="status" aria-label="Taken laden">
      {(desk ? COLUMNS : COLUMNS.slice(0, 1)).map((c, i) => (
        <div key={c.id} className="space-y-2 rounded-card bg-surface-2 p-2">
          <Skeleton className="mx-2 my-2 h-3.5 w-20" />
          {Array.from({ length: i % 2 ? 1 : 2 }, (_, k) => (
            <div key={k} className="space-y-2.5 rounded-xl border border-line bg-surface p-3">
              <Skeleton className="h-3.5 w-4/5" />
              <Skeleton className="h-3 w-1/2" />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

/** A labelled block of longer text in the details. */
function TextBlock({ title, text }: { title: string; text: string }) {
  if (!text.trim()) return null;
  return (
    <section className="space-y-1">
      <h3 className="text-[12px] font-bold uppercase tracking-wider text-muted">{title}</h3>
      <div className="rounded-xl bg-surface-2 px-3 py-2.5 text-sm leading-relaxed">
        <Linkified text={text} />
      </div>
    </section>
  );
}

function TaskDetails({ t, onClose, onChanged }: { t: BoardTask; onClose(): void; onChanged(): void }) {
  const me = useApp((s) => s.me);
  const allAgents = useApp((s) => s.agents);
  const agents = useMemo(() => allAgents.filter((a) => !a.archived), [allAgents]);
  const [busy, setBusy] = useState(false);
  const ownerValue = t.ownerType === 'user' ? `user:${t.ownerId}` : t.ownerType === 'agent' ? `agent:${t.ownerId}` : '';
  // The quality block (C1): a board task brings its record along; a team-database task fetches its own.
  const boardQuality = t.source === 'board' && !!t.quality;
  const quality = boardQuality || t.source === 'team';
  const setOwner = async (v: string) => {
    const [ownerType, ownerId] = v ? v.split(':') : ['', ''];
    setBusy(true);
    try {
      await api.patch(`/rooms/tasks/${t.id}`, ownerId ? { ownerType, ownerId } : { ownerType: null, ownerId: '' });
      toast('Opgeslagen', 'ok');
      onChanged();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const toggleImportant = async () => {
    setBusy(true);
    try {
      await api.patch(`/rooms/tasks/${t.id}`, { important: !t.important });
      onChanged();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!(await askConfirm(`Taak “${t.title}” verwijderen?`, { danger: true, ok: 'Verwijderen' }))) return;
    try {
      await api.del(`/rooms/tasks/${t.id}`);
      onChanged();
      onClose();
    } catch (e) {
      toastError(e);
    }
  };
  const time = (s: string) => {
    const n = timeValue(s);
    if (!s) return null;
    return n && s.length > 10 ? `${dateLabel(s)} · ${new Date(n).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' })}` : dateLabel(s);
  };
  return (
    <Modal open onClose={onClose} wide title={<span translate="no">{t.title}</span>}>
      <div className="space-y-4 pb-2">
        <div className="flex flex-wrap items-end gap-3">
          <label className="min-w-[12rem] flex-1 space-y-1.5 text-[13px] font-semibold">
            <span>Status</span>
            <StatusSelect t={t} onMoved={onChanged} />
          </label>
          {t.source === 'board' && (
            <label className="min-w-[12rem] flex-1 space-y-1.5 text-[13px] font-semibold">
              <span>Wie doet het</span>
              <Select value={ownerValue} disabled={busy} onChange={(e) => setOwner(e.target.value)}>
                <option value="">Niemand</option>
                {me && <option value={`user:${me.id}`}>Ik ({me.name})</option>}
                {t.ownerType === 'user' && t.ownerId !== me?.id && <option value={ownerValue}>{t.owner}</option>}
                {agents.map((a) => (
                  <option key={a.id} value={`agent:${a.id}`}>
                    {a.name}
                  </option>
                ))}
              </Select>
            </label>
          )}
        </div>
        <Fields
          items={[
            ['Wie doet het', t.source === 'team' && t.owner ? <BotName name={t.owner} size={20} /> : null],
            ['Geclaimd door', t.claimedBy && !boardQuality ? <BotName name={t.claimedBy} size={20} /> : null],
            ['Gevraagd door', t.requestedBy ? <BotName name={t.requestedBy} size={20} /> : null],
            [
              'Groep',
              t.group ? (
                <a className="inline-flex items-center gap-1 text-accent underline" href={t.group.threadId ? `#/t/${t.group.threadId}` : '#/m/rooms/'} translate="no">
                  <Users className="h-3.5 w-3.5" aria-hidden /> {t.group.name}
                </a>
              ) : null,
            ],
            ['Site', t.site ? <span translate="no">{t.site}</span> : null],
            ['Deadline', t.deadline ? dateLabel(t.deadline) : null],
            ['Aangemaakt', time(t.created)],
            ['Bijgewerkt', t.updated && t.updated !== t.created ? time(t.updated) : null],
            ...t.extra.map(([k, v]) => [k.replace(/_/g, ' '), <Linkified text={v} />] as [string, ReactNode]),
          ]}
        />
        {/* Kosten vooraf (P3): for an important task (or a big one) of one of your own bots, before it starts. */}
        {t.source === 'board' && t.ownerType === 'agent' && t.column !== 'done' && agents.some((a) => a.id === t.ownerId) && (
          <CostEstimate
            agentId={t.ownerId}
            important={t.important}
            startLabel={tr('De bot krijgt de taak dan in zijn eigen chat, als eenmalige routine.')}
            onStartAfter={async (at) => {
              await api.post(`/rooms/tasks/${t.id}/start-after`, { at });
              toast('Ingepland', 'ok');
            }}
          />
        )}
        {!quality && <TextBlock title="Klaar als" text={t.doneWhen} />}
        <TextBlock title="Beschrijving" text={t.description} />
        <TextBlock title="Resultaat" text={t.result} />
        {/* Klaar als, who works on it, the evidence TeamBot found and the second look, with the owner's actions (C1). */}
        {quality && <TaskQuality kind={t.source === 'board' ? 'room' : 'teamdata'} refId={t.source === 'board' ? t.id : teamTaskRef(t.id)} q={t.source === 'board' ? (t.quality as QualityView) : undefined} onChanged={onChanged} />}
        {!!t.evidence.length && !boardQuality && (
          <section className="space-y-1">
            <h3 className="text-[12px] font-bold uppercase tracking-wider text-muted">Bewijs</h3>
            <ul className="space-y-1.5 rounded-xl bg-surface-2 px-3 py-2.5 text-sm leading-relaxed">
              {t.evidence.map((e, i) => (
                <li key={i} className="flex gap-2">
                  <Paperclip className="mt-1 h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                  <span className="min-w-0">
                    {e.label && <span className="font-semibold">{e.label}: </span>}
                    <Linkified text={e.text} />
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}
        {!boardQuality && <TextBlock title="Controle" text={t.check} />}
        {!t.evidence.length && t.column === 'done' && !boardQuality && (
          <p className="flex items-start gap-1.5 text-[13px] text-warn">
            <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
            Klaar zonder bewijs: vraag de bot om een link, bestand of schermafbeelding.
          </p>
        )}
        <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
          {t.sourceThreadId && (
            <Button size="sm" icon={<MessageSquare className="h-4 w-4" />} onClick={() => (location.hash = `#/t/${t.sourceThreadId}`)}>
              Naar het gesprek
            </Button>
          )}
          {t.source === 'board' && (
            <Button
              size="sm"
              variant={t.important ? 'soft' : 'ghost'}
              icon={<Flag className="h-4 w-4" />}
              aria-pressed={t.important}
              disabled={busy}
              onClick={toggleImportant}
              title={t.important ? 'Belangrijk: draait alleen op het minimumniveau en pauzeert anders tot de reset. Klik om dit uit te zetten.' : 'Belangrijk maken: draait alleen op het minimumniveau en pauzeert anders tot de reset.'}
            >
              Belangrijk
            </Button>
          )}
          {t.source === 'board' ? (
            <Button size="sm" variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={remove} className="ms-auto">
              Verwijderen
            </Button>
          ) : (
            <p className="text-xs text-muted">
              Je bots houden deze taak bij in hun gedeelde takenlijst (
              <a className="underline" href="#/m/teamdata/taken">
                Teamwerk
              </a>
              ).
            </p>
          )}
        </div>
        {t.source === 'board' && <p className="text-xs text-muted">Moet de bot er meteen iets mee? Zeg het in zijn chat.</p>}
      </div>
    </Modal>
  );
}


/** "Nieuwe taak": the title, for whom (a group, when you lead one) and optionally when it counts as done. */
function NewTask({ onAdded, onClose }: { onAdded(): void; onClose(): void }) {
  const [title, setTitle] = useState('');
  const [doneWhen, setDoneWhen] = useState('');
  const [groupId, setGroupId] = useState('');
  const [groups, setGroups] = useState<GroupLite[]>([]);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const load = () =>
      api
        .get<GroupLite[]>('/rooms')
        .then((r) => setGroups((r || []).filter((g) => !g.invited)))
        .catch(() => setGroups([]));
    load();
    return on('rooms.changed', load);
  }, []);
  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      // A task for a group lands on that group's board, where its bots pick it up (task_list / task_update).
      await api.post('/rooms/tasks', { title: title.trim(), roomId: groupId || undefined, doneWhen: doneWhen.trim() || undefined });
      onAdded();
      onClose();
    } catch (err) {
      toastError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal open onClose={onClose} title="Nieuwe taak">
      <form className="space-y-4 pb-1" onSubmit={add}>
        <Input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Wat moet er gebeuren?" aria-label="Nieuwe taak" maxLength={200} autoFocus />
        {groups.some((g) => g.access === 'owner') && (
          <Field label="Voor wie">
            <Select value={groupId} onChange={(e) => setGroupId(e.target.value)} aria-label="Voor welke groep">
              <option value="">Voor mezelf</option>
              {groups.map((g) => (
                <option key={g.id} value={g.id}>
                  {g.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Field label="Klaar als (optioneel)">
          <Input value={doneWhen} onChange={(e) => setDoneWhen(e.target.value)} maxLength={300} placeholder="Bijv. offerte als PDF in de groepsmap" aria-label="Klaar als" />
        </Field>
        <div className="flex justify-end gap-2 pt-1">
          <Button onClick={onClose}>Annuleren</Button>
          <Button type="submit" variant="primary" loading={busy} disabled={!title.trim()}>
            Toevoegen
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/**
 * Taken (#/tasks): one board for the owner with the columns Te doen, Bezig, Te controleren, Klaar and Geblokkeerd, over
 * both places bots keep tasks (TeamBot's own board and the team database; see ./tasks/model.ts). Live: a bot that adds
 * or moves a task shows up right away. On a phone one column at a time.
 */
export function TasksPage() {
  const desk = useIsDesktop();
  const meId = useApp((s) => s.me?.id);
  const agents = useApp((s) => s.agents);
  const [board, setBoard] = useState<Record<string, any>[] | null>(null);
  const [team, setTeam] = useState<Record<string, any>[] | null>(null);
  const [boardErr, setBoardErr] = useState('');
  const [teamErr, setTeamErr] = useState('');
  const [q, setQ] = useState('');
  const [stopped, setStopped] = useState(false);
  const [adding, setAdding] = useState(false);
  // #/tasks?open=b:<id> (Ctrl+K, a link): open that task. Read again when only the query changes (already on #/tasks).
  const [openKey, setOpenKeyState] = useState<string | null>(() => openParam());
  const [phoneCol, setPhoneCol] = useState<Place | null>(null);
  useEffect(() => {
    const f = () => {
      const k = openParam();
      if (k) setOpenKeyState(k);
    };
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  const setOpenKey = (k: string | null) => {
    setOpenKeyState(k);
    // Closing drops ?open= quietly, so the same search hit opens the task again next time.
    if (!k && openParam()) history.replaceState(null, '', location.hash.split('?')[0]);
  };

  const loadBoard = () =>
    api
      .get<Record<string, any>[]>('/rooms/tasks')
      .then((r) => (setBoard(r || []), setBoardErr('')))
      .catch((e) => (setBoardErr(e?.message || String(e)), setBoard((b) => b || [])));
  const loadTeam = () =>
    teamApi
      .tasks()
      .then((r) => (setTeam(r || []), setTeamErr('')))
      .catch((e) => (setTeamErr(e?.message || String(e)), setTeam((x) => x || [])));
  const reload = () => void Promise.all([loadBoard(), loadTeam()]);
  // Several task events in a row (a bot that updates three tasks) give one reload.
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    reload();
    const off = on('rooms.task', () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void loadBoard(), 250);
    });
    const offQ = on('quality.changed', () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = setTimeout(() => void reload(), 250);
    });
    return () => {
      off();
      offQ();
      if (timer.current) clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useTeamChanged(['taken'], () => void loadTeam());

  // The team chosen in the team switcher: only that team's tasks, plus the owner's own (without a team). Its team
  // database is a file of its own (B2): read it again when the team changes.
  const view = useTeamView();
  const pickedTeam = useTeamPick((s) => s.team);
  useEffect(() => void loadTeam(), [pickedTeam]); // eslint-disable-line react-hooks/exhaustive-deps
  const all = useMemo(() => {
    const names = new Map(agents.map((a) => [a.id, a.name]));
    return mergeTasks(board || [], team || [], { meId, agentName: (id) => names.get(id) });
  }, [board, team, meId, agents]);
  const tasks = useMemo(() => {
    const hidden = hiddenTaskKeys(board || [], team || [], view.activeId, view.teams);
    return all.filter((t) => !hidden.has(t.key));
  }, [all, board, team, view.activeId, view.teams]);
  const shown = useMemo(() => tasks.filter((t) => matches(t, q)), [tasks, q]);
  const places = useMemo(() => byPlace(shown), [shown]);
  // A task opened by its link also opens when the team filter hides it on the board.
  const open = openKey ? all.find((t) => t.key === openKey) || null : null;

  const loading = board === null || team === null;
  const failed = !!boardErr && !!teamErr;
  const waiting = tasks.filter((t) => t.waitsForYou).length;
  const cols = [...COLUMNS, ...(stopped ? [STOPPED] : [])];
  const phone: Place = phoneCol || PHONE_ORDER.find((c) => places[c].length) || 'todo';
  const tools = tasks.length > 8 || waiting > 0 || places.stopped.length > 0;

  return (
    <Page>
      <PageHeader
        width="full"
        title="Taken"
        subtitle="Alles wat je bots doen, op één bord."
        actions={
          <>
            <BoardMenu />
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
              Nieuwe taak
            </Button>
          </>
        }
      />
      <div className="space-y-4 px-4 pb-8 pt-2 sm:px-6">
        <TeamworkLinks />
        <WorkingNow />
        <TeamFilterNote>Je ziet de taken van dit team en je eigen taken.</TeamFilterNote>
        {loading ? (
          <BoardSkeleton desk={desk} />
        ) : failed ? (
          <EmptyState icon={<ListChecks />} title="De taken konden niet laden" action={<Button onClick={reload}>Opnieuw</Button>}>
            {boardErr}
          </EmptyState>
        ) : !tasks.length ? (
          <EmptyState
            icon={<ListChecks />}
            title="Nog geen taken"
            action={
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setAdding(true)}>
                Nieuwe taak
              </Button>
            }
          >
            Je bots zetten hier hun werk neer. Je kunt ook zelf een taak toevoegen.
          </EmptyState>
        ) : (
          <>
            {(boardErr || teamErr) && (
              <p className="flex items-start gap-1.5 text-[13px] text-warn" role="status">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                {boardErr ? `Een deel van de taken (het takenbord) kon niet laden: ${boardErr}` : `Een deel van de taken (de takenlijst van je bots) kon niet laden: ${teamErr}`}
              </p>
            )}
            {tools && (
              <div className="flex flex-wrap items-center gap-2">
                {tasks.length > 8 && <SearchBox value={q} onChange={setQ} label="Taken doorzoeken" placeholder="Zoek in taken" className="w-full sm:w-72" />}
                {waiting > 0 && <Badge tone="warn">{waiting === 1 ? 'Er wacht één taak op jou' : `Er wachten ${waiting} taken op jou`}</Badge>}
                {places.stopped.length > 0 && (
                  <Button size="sm" variant="ghost" className="ms-auto" onClick={() => setStopped(!stopped)} aria-pressed={stopped}>
                    {stopped ? 'Verberg gestopte' : `Toon gestopte (${places.stopped.length})`}
                  </Button>
                )}
              </div>
            )}

            {desk ? (
              <div className={cx('grid items-start gap-3', stopped ? 'md:grid-cols-3 xl:grid-cols-6' : 'md:grid-cols-3 xl:grid-cols-5')}>
                {cols.map((c) => (
                  <Column key={c.id} id={c.id} label={c.label} hint={c.hint} list={places[c.id]} onOpen={(t) => setOpenKey(t.key)} onMoved={reload} />
                ))}
              </div>
            ) : (
              <div className="space-y-3">
                <Chips label="Kolom" value={phone} onChange={setPhoneCol} items={cols.map((c) => ({ id: c.id, label: c.label, count: places[c.id].length }))} />
                <Column id={phone} label={placeLabel(phone)} hint={cols.find((c) => c.id === phone)?.hint || ''} list={places[phone]} onOpen={(t) => setOpenKey(t.key)} onMoved={reload} />
              </div>
            )}
          </>
        )}
      </div>
      {adding && <NewTask onAdded={() => void loadBoard()} onClose={() => setAdding(false)} />}
      {open && <TaskDetails t={open} onClose={() => setOpenKey(null)} onChanged={reload} />}
    </Page>
  );
}
