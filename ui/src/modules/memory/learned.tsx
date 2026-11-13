import React, { useState } from 'react';
import { Archive, Brain, Check, FolderOpen, GitMerge, Link2, ListChecks, MessageSquare, Pencil, Pin, PinOff, Play, RefreshCw, ShieldAlert, Sparkles, Undo2, User, X } from 'lucide-react';
import { api } from '../../lib/api';
import { navigate } from '../../lib/router';
import { Badge, Button, Card, EmptyState, Input, cx, timeAgo, toast, useAsync, CardHead, IconTile } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { Menu } from '../../components/overview';
import { ErrorBox, ForgetDialog, ItemEditor, Loading } from './parts';
import { type MemItem, engineLabel, fmtDate, memPath, SCOPE_LABEL, STATUS_LABEL, TYPE_LABEL, useMem } from './lib';
import { ownText, t, translate } from '../../lib/i18n';
import { Words } from '../../components/Words';
import { formatSeconds, formatUsd } from '../../lib/format';

/** Learned item as returned by /memory/learned, /memory/profile and the learned-map. */
export interface LearnedItem extends MemItem {
  how: string;
  changeId: string | null;
  /** A line of a dossier's text that was learned from a message (not a note of its own). */
  line?: boolean;
  replaced: { id: string; ref: string; content: string; status: string } | null;
  brief?: boolean;
  autoBrief?: boolean;
}

// ------------------------------------------------------------------ maintenance report

const LINE_ICON: Record<string, React.ReactNode> = {
  merge: <GitMerge className="h-3.5 w-3.5" />,
  supersede: <RefreshCw className="h-3.5 w-3.5" />,
  review: <ShieldAlert className="h-3.5 w-3.5" />,
  archive: <Archive className="h-3.5 w-3.5" />,
  expire: <Archive className="h-3.5 w-3.5" />,
  pin: <Pin className="h-3.5 w-3.5" />,
  unpin: <PinOff className="h-3.5 w-3.5" />,
  timeline: <FolderOpen className="h-3.5 w-3.5" />,
  decision: <Check className="h-3.5 w-3.5" />,
  action: <ListChecks className="h-3.5 w-3.5" />,
  summary: <FolderOpen className="h-3.5 w-3.5" />,
  link: <Link2 className="h-3.5 w-3.5" />,
  confirm: <Check className="h-3.5 w-3.5" />,
  refresh: <RefreshCw className="h-3.5 w-3.5" />,
  consolidate: <GitMerge className="h-3.5 w-3.5" />,
  trash: <Archive className="h-3.5 w-3.5" />,
  dossier: <FolderOpen className="h-3.5 w-3.5" />,
  size: <Brain className="h-3.5 w-3.5" />,
};

const MONTHS = ['januari', 'februari', 'maart', 'april', 'mei', 'juni', 'juli', 'augustus', 'september', 'oktober', 'november', 'december'];

function reportTitle(r: any) {
  const d = new Date(r.started_at);
  // The monthly "opruimverslag" is about the month before the one it was made in.
  if (r.trigger === 'monthly') return t('Opruimverslag van {0}', MONTHS[(d.getMonth() + 11) % 12]);
  const night = d.getHours() < 7 && r.trigger === 'nightly';
  const today = new Date().toDateString() === d.toDateString();
  if (night && today) return 'Wat ik vannacht heb bijgewerkt';
  return `Wat ik bij het onderhoud van ${fmtDate(r.started_at, true)} heb bijgewerkt`;
}

/**
 * "Wat ik vannacht heb bijgewerkt": the latest maintenance report, with undo per line and for everything. With
 * `monthly`: the latest "opruimverslag" (what was summarised, archived, refreshed or marked "te controleren" last
 * month, and how big each part is against its target), shown for a month or until it is marked as read.
 */
export function ReportCard({ monthly = false }: { monthly?: boolean }) {
  const reps = useMem<any[]>(`/memory/reports?limit=5&trigger=${monthly ? 'monthly' : 'maintenance'}`);
  const { run, busy } = useAsync();
  const [showAll, setShowAll] = useState(false);
  if (reps.error) return monthly ? null : <ErrorBox error={reps.error} retry={reps.reload} />;
  const r = reps.data?.find((x) => x.status !== 'running') || null;
  if (monthly && (!r || r.seen_at || Date.now() - Date.parse(r.started_at) > 40 * 864e5)) return null;
  const seen = () => run(async () => (await api.post(`/memory/reports/${r.id}/seen`, {}), reps.reload()));
  const runNow = () =>
    run(async () => {
      const out = await api.post<any>('/memory/maintenance', {});
      reps.reload();
      toast(out.lines?.length ? t('Onderhoud klaar: {0}', out.summary ? translate(out.summary) : t('{0, plural, one {# wijziging} other {# wijzigingen}}', out.lines.length)) : 'Onderhoud klaar: alles was al op orde', 'ok');
    });
  const undo = (index: number | null) =>
    run(async () => {
      const out = await api.post<any>(`/memory/reports/${r.id}/undo`, { index });
      reps.reload();
      if (out.errors?.length) toast(`Niet alles kon terug: ${out.errors[0]}`);
      else toast(index === null ? 'Alles van dit onderhoud is teruggedraaid' : 'Ongedaan gemaakt', 'ok');
    });
  const lines: any[] = r?.lines || [];
  const open = lines.filter((l) => !l.undone);
  const shown = showAll ? lines : lines.slice(0, 6);
  return (
    <Card className="p-4">
      <div className="flex flex-wrap items-start gap-2">
        <IconTile icon={Sparkles} tone="violet" />
        <div className="min-w-0 flex-1">
          <h2 className="text-sm font-semibold">{r ? reportTitle(r) : 'Geheugen-onderhoud'}</h2>
          <p className="text-xs text-muted">
            {r && monthly
              ? r.summary
                ? translate(r.summary)
                : translate('Niets opgeruimd; alles past binnen de doelomvang.')
              : r
              ? [
                  r.summary ? translate(r.summary) : lines.length ? t('{0, plural, one {# wijziging} other {# wijzigingen}}', lines.length) : translate('Alles was al op orde'),
                  r.engine ? t('met {0}', engineLabel(r.engine)) : translate('zonder model (vaste regels)'),
                  r.calls ? formatSeconds(r.latency_ms) : '',
                  r.cost ? formatUsd(r.cost) : translate('geen extra kosten'),
                ]
                  .filter(Boolean)
                  .join(' · ')
              : (
                <>
                  Elke nacht ruimt TeamBot je geheugen op. <MoreInfo>Ruimt het geheugen op. Alles is terug te draaien.</MoreInfo>
                </>
              )}
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {open.length > 1 && (
            <Button size="sm" variant="ghost" icon={<Undo2 className="h-3.5 w-3.5" />} loading={busy} onClick={() => undo(null)}>
              Alles ongedaan maken
            </Button>
          )}
          {monthly ? (
            <Button size="sm" variant="ghost" icon={<Check className="h-3.5 w-3.5" />} loading={busy} onClick={seen}>
              Gelezen
            </Button>
          ) : (
            <Button size="sm" icon={<Play className="h-3.5 w-3.5" />} loading={busy} onClick={runNow}>
              Nu onderhoud uitvoeren
            </Button>
          )}
        </div>
      </div>
      {lines.length > 0 && (
        <ul className="mt-3 divide-y divide-line rounded-lg border border-line">
          {shown.map((l, i) => (
            <li key={i} className={cx('flex items-start gap-2 px-3 py-2 text-sm', l.undone && 'text-muted line-through')}>
              <span className="mt-0.5 text-muted" aria-hidden>
                {LINE_ICON[l.op] || <Brain className="h-3.5 w-3.5" />}
              </span>
              <span className="min-w-0 flex-1 break-words">
                {l.text}
                {l.dossierId && (
                  <a className="ms-1 text-xs text-accent hover:underline" href={memPath(`dossiers/${l.dossierId}`)}>
                    dossier
                  </a>
                )}
              </span>
              {!l.undone && (l.changeIds?.length > 0 || l.link) && (
                <button className="inline-flex shrink-0 items-center gap-1 text-xs text-accent hover:underline" disabled={busy} onClick={() => undo(i)}>
                  <Undo2 className="h-3 w-3" /> Ongedaan maken
                </button>
              )}
              {l.undone && <span className="shrink-0 text-xs no-underline">teruggedraaid</span>}
            </li>
          ))}
        </ul>
      )}
      {lines.length > 6 && (
        <button className="mt-2 text-xs text-accent hover:underline" onClick={() => setShowAll(!showAll)}>
          {showAll ? 'Minder tonen' : `Alle ${lines.length} wijzigingen tonen`}
        </button>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ recently learned

/** One learned item with where/when/how, and one-tap "klopt niet" (edit), "vergeet" and undo. */
export function LearnedRow({ item, onChanged }: { item: LearnedItem; onChanged?(): void }) {
  const [edit, setEdit] = useState(false);
  const [forget, setForget] = useState(false);
  const { run, busy } = useAsync();
  const live = ['active', 'proposed'].includes(item.status);
  return (
    <li className="tb-in px-4 py-3">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className={cx('break-words text-sm leading-relaxed', item.status === 'superseded' && 'text-muted line-through')} translate="no">{item.content}</p>
          {item.replaced && (
            <p className="text-xs text-muted">
              vervangt <span className="line-through" translate="no">{item.replaced.content}</span>
            </p>
          )}
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
            <span>{item.scope === 'agent' ? item.agent_name || 'Bot' : item.scope === 'dossier' ? item.dossier_title || 'Dossier' : SCOPE_LABEL[item.scope]}</span>
            <span>· {timeAgo(item.created_at)}</span>
            {item.source_thread_id && (
              <a className="inline-flex items-center gap-1 underline-offset-2 hover:text-fg hover:underline" href={`#/t/${item.source_thread_id}`}>
                <MessageSquare className="h-3 w-3" aria-hidden />
                {item.source_thread_title ? `“${item.source_thread_title.slice(0, 40)}”` : 'gesprek'}
              </a>
            )}
            {item.status !== 'active' && <Badge tone={item.status === 'proposed' ? 'warn' : 'neutral'}>{STATUS_LABEL[item.status]}</Badge>}
          </div>
        </div>
        {item.status === 'proposed' && (
          <a className="inline-flex h-8 shrink-0 items-center rounded-control px-2.5 text-[13px] font-semibold hover:bg-surface-2" href={memPath('beoordelen')}>
            Beoordelen
          </a>
        )}
        <Menu
          label={t('Acties voor: {0}', item.content.slice(0, 60))}
          className="-me-2 -mt-1"
          items={[
            // A line of a dossier's text (no note of its own): changed in that dossier; undo takes it out again.
            live && !item.line && { label: 'Klopt niet, aanpassen', icon: <Pencil />, onSelect: () => setEdit(true) },
            !!item.line && { label: 'Bekijken', icon: <Pencil />, onSelect: () => navigate(memPath('dossiers/' + item.dossier_id)) },
            !!item.changeId &&
              live && {
                label: 'Ongedaan maken',
                icon: <Undo2 />,
                disabled: busy,
                onSelect: () =>
                  void run(async () => {
                    await api.post(`/memory/changes/${item.changeId}/undo`, {});
                    onChanged?.();
                  }, item.replaced ? 'Teruggezet naar de vorige versie' : 'Ongedaan gemaakt'),
              },
            item.status !== 'superseded' && !item.line && { label: 'Vergeten…', icon: <X />, danger: true, onSelect: () => setForget(true) },
          ]}
        />
      </div>
      {edit && <ItemEditor item={item} onClose={() => setEdit(false)} onSaved={() => (setEdit(false), onChanged?.())} />}
      {forget && <ForgetDialog item={item} onClose={() => setForget(false)} onDone={() => (setForget(false), onChanged?.())} />}
    </li>
  );
}

/** What was learned when and from where; open conversations that will be learned from once they are quiet. */
export function RecentLearned({ limit = 12 }: { limit?: number }) {
  const r = useMem<{ items: LearnedItem[]; pending: { threadId: string; title: string; due_at: string; status: string }[] }>(`/memory/learned?limit=${limit}`);
  // Said plainly when conversations cannot be read in the background, and why (the bots keep their dossiers anyway).
  const eng = useMem<{ blocked: string | null }>('/memory/engine');
  if (r.error) return <ErrorBox error={r.error} retry={r.reload} />;
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CardHead className="min-w-0 flex-1" icon={Brain} tone="violet" title="Recent geleerd" />
        {!!r.data?.pending.length && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <RefreshCw className="h-3 w-3" aria-hidden />
            {t('{0, plural, one {# gesprek wordt zo verwerkt} other {# gesprekken worden zo verwerkt}}', r.data.pending.length)}
          </span>
        )}
      </div>
      {eng.data?.blocked && (
        <Card className="flex items-start gap-2 border-warn/40 bg-warn-soft p-3 text-sm" role="status">
          <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <span>{t('Gesprekken worden nu niet op de achtergrond nagelezen. {0} Je bots houden hun dossiers zelf bij, en wat je met “onthoud dat …” vraagt, wordt meteen onthouden.', translate(eng.data.blocked))}</span>
        </Card>
      )}
      {!r.data ? (
        <Loading rows={4} />
      ) : (
      <Card className="overflow-hidden">
        {r.data.items.length === 0 ? (
          <EmptyState icon={<Brain />} title="Nog niets geleerd" action={<Button onClick={() => navigate('/')}>Naar je chats</Button>}>
            Vertel je bots wat ze moeten weten; na het gesprek onthouden ze het.
          </EmptyState>
        ) : (
          <ul className="divide-y divide-line">
            {r.data.items.map((i) => (
              <LearnedRow key={i.id} item={i} onChanged={r.reload} />
            ))}
          </ul>
        )}
      </Card>
      )}
    </section>
  );
}

// ------------------------------------------------------------------ "Wat ik over je weet"

function ProfileItem({ item, onChanged }: { item: LearnedItem; onChanged(): void }) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(item.content);
  const [forget, setForget] = useState(false);
  const { run, busy } = useAsync();
  const save = () =>
    run(async () => {
      if (text.trim() && text.trim() !== item.content) await api.patch(`/memory/items/${item.id}`, { content: text.trim() });
      setEditing(false);
      onChanged();
    }, 'Bijgewerkt');
  return (
    <li className="group flex flex-wrap items-start gap-2 px-3 py-2">
      <div className="min-w-0 flex-1">
        {editing ? (
          <form
            className="flex flex-wrap gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              save();
            }}
          >
            <Input className="min-w-[200px] flex-1" value={text} onChange={(e) => setText(e.target.value)} aria-label="Herinnering aanpassen" autoFocus />
            <Button size="sm" variant="primary" type="submit" loading={busy}>
              Opslaan
            </Button>
            <Button size="sm" variant="ghost" onClick={() => (setEditing(false), setText(item.content))}>
              Annuleren
            </Button>
          </form>
        ) : (
          <button className="text-start text-sm hover:underline" onClick={() => setEditing(true)} title="Klik om aan te passen">
            <span translate="no">{item.content}</span>
          </button>
        )}
        <div className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-muted">
          {item.brief && (
            <span className="inline-flex items-center gap-1 text-accent" title={item.autoBrief ? 'Automatisch in je kernprofiel: elke bot weet dit altijd' : 'Door jou vastgezet: elke bot weet dit altijd'}>
              <Pin className="h-3 w-3" /> altijd bekend
            </span>
          )}
          <span>{item.how}</span>
          <span>· {fmtDate(item.valid_from || item.created_at)}</span>
          {item.source_thread_id && (
            <a className="text-accent hover:underline" href={`#/t/${item.source_thread_id}`}>
              bron
            </a>
          )}
          {item.replaced && (
            <span>
              · <Words text="was: {0}" values={[item.replaced.content]} />
            </span>
          )}
          {item.type !== 'fact' && <span>· {TYPE_LABEL[item.type]}</span>}
        </div>
      </div>
      {!editing && (
        <div className="flex shrink-0 text-muted">
          <Button size="sm" variant="ghost" icon={<Pencil className="h-3.5 w-3.5" />} onClick={() => setEditing(true)} aria-label={t('Aanpassen: {0}', item.content)} title="Aanpassen" />
          <Button
            size="sm"
            variant="ghost"
            icon={item.brief ? <PinOff className="h-3.5 w-3.5" /> : <Pin className="h-3.5 w-3.5" />}
            loading={busy}
            // The memory as written in its label: the label is made here in the reader's language, so the page leaves it.
            translate="no"
            aria-label={item.brief ? ownText('Niet meer altijd laden: {0}', item.content) : ownText('Altijd laden: {0}', item.content)}
            title={item.brief ? t('Niet meer altijd laden') : t('Altijd laden')}
            onClick={() => run(async () => (await api.post(`/memory/items/${item.id}/${item.brief ? 'unpin' : 'pin'}`, {}), onChanged()), item.brief ? 'Niet meer altijd geladen' : 'Elke bot weet dit nu altijd')}
          />
          <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={() => setForget(true)} aria-label={t('Vergeten: {0}', item.content)} title="Vergeten" />
        </div>
      )}
      {forget && <ForgetDialog item={item} onClose={() => setForget(false)} onDone={() => (setForget(false), onChanged())} />}
    </li>
  );
}

/** Profile view of what the bots know about the owner: grouped, editable, with the always-loaded brief. */
export function ProfileView() {
  const r = useMem<{ groups: { id: string; label: string; items: LearnedItem[] }[]; total: number; proposals: number; brief: { tokens: number; budget: number; profileCap: number } }>('/memory/profile');
  if (r.error) return <ErrorBox error={r.error} retry={r.reload} />;
  if (!r.data) return <Loading />;
  const d = r.data;
  if (!d.total)
    return (
      <Card>
        <EmptyState icon={<User />} title="Je bots weten nog niets over je" action={<Button onClick={() => navigate('/')}>Naar je chats</Button>}>
          Vertel het in een gesprek (“ik woon in …”); na het gesprek onthouden ze het.
        </EmptyState>
      </Card>
    );
  return (
    <div className="space-y-4">
      <div className="grid items-start gap-3 md:grid-cols-2">
        {d.groups.map((g) => (
          <Card key={g.id} className="overflow-hidden">
            <h3 className="border-b border-line px-4 py-2.5 text-[13px] font-semibold">{g.label}</h3>
            <ul className="divide-y divide-line">
              {g.items.map((i) => (
                <ProfileItem key={i.id} item={i} onChanged={r.reload} />
              ))}
            </ul>
          </Card>
        ))}
      </div>
    </div>
  );
}
