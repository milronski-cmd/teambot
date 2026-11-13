import { useEffect, useId, useRef, useState } from 'react';
import { AlarmClock, AppWindow, Bell, BellOff, Bot, Brain, CheckCheck, Gauge, MessageCircleQuestion, MessagesSquare, Monitor, Settings, ShieldCheck, Sparkles, Store, Trash2, TriangleAlert, Users, X } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { useIsDesktop } from '../../lib/media';
import { uiLocale } from '../../lib/i18n';
import type { Agent } from '../../lib/types';
import { BotAvatar } from '../../components/BotFace';
import { Button, EmptyState, Modal, Page, PageHeader, Spinner, cx, listTime, toast, toastError } from '../../components/ui';
import {
  KIND_LABEL,
  LEVEL_LABEL,
  clearNotifications,
  levelOf,
  loadMoreNotifications,
  loadNotifications,
  loadPrefs,
  markAllRead,
  markRead,
  savePrefs,
  useNotifications,
  type NotificationItem,
  type NotifyFilter,
  type NotifyLevel,
  type NotifyPrefs,
} from './api';
import { Segmented, SettingRow, SettingsSection, SwitchRow, useSave } from '../../components/SettingControls';
import { settingText } from '../../../../shared/settings.js';
import { MoreInfo } from '../../components/MoreInfo';
import { useDismiss } from '../../components/Menu';
import { Menu, Skeleton } from '../../components/overview';

const KIND_ICON: Record<string, LucideIcon> = {
  approval: ShieldCheck,
  question: MessageCircleQuestion,
  run: Bot,
  routine: AlarmClock,
  limit: Gauge,
  channel: MessagesSquare,
  team: Users,
  memory: Brain,
  mcp: AppWindow,
  skill: Sparkles,
  warning: TriangleAlert,
  computer: Monitor,
  report: Store,
};

const SETTINGS_HREF = '#/settings/notifications-meldingen';

/** "Vandaag", "Gisteren", else a date. */
function dayLabel(iso: string) {
  const d = new Date(iso);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return 'Vandaag';
  if (d.toDateString() === new Date(now.getTime() - 864e5).toDateString()) return 'Gisteren';
  return d.toLocaleDateString(uiLocale(), { weekday: 'long', day: 'numeric', month: 'long' });
}

function Row({ n, onOpen }: { n: NotificationItem; onOpen(n: NotificationItem): void }) {
  const agent = useApp((s) => (n.agent_id ? s.agents.find((a) => a.id === n.agent_id) : undefined));
  const Icon = KIND_ICON[n.kind] || Bell;
  const unread = !n.read_at;
  const kind = KIND_LABEL[n.kind] || 'Melding';
  return (
    <li className="tb-in group relative">
      <button
        type="button"
        onClick={() => onOpen(n)}
        className={cx('flex w-full items-start gap-3 rounded-xl px-3 py-2.5 text-start hover:bg-surface-2', unread && 'bg-surface-2/60')}
      >
        {unread && <span className="sr-only">Ongelezen: </span>}
        <span className="relative mt-0.5 shrink-0">
          {agent ? (
            <BotAvatar bot={agent} size={34} />
          ) : (
            <span className={cx('flex h-[34px] w-[34px] items-center justify-center rounded-full', n.important ? 'bg-warn-soft text-warn' : 'bg-surface-3 text-fg')}>
              <Icon className="h-[17px] w-[17px]" aria-hidden />
            </span>
          )}
          {agent && (
            <span className={cx('absolute -bottom-1 -end-1 flex h-[18px] w-[18px] items-center justify-center rounded-full ring-2 ring-surface', n.important ? 'bg-warn-strong text-warn-fg' : 'bg-surface-3 text-fg')} aria-hidden>
              <Icon className="h-[11px] w-[11px]" />
            </span>
          )}
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-start gap-2">
            <span className={cx('min-w-0 flex-1 text-[13.5px] leading-snug [overflow-wrap:anywhere]', unread ? 'font-bold' : 'font-semibold text-fg/90')}>{n.title}</span>
            {n.count > 1 && <span className="shrink-0 rounded-full bg-surface-3 px-1.5 text-[11px] font-bold tabular-nums text-muted">×{n.count}</span>}
          </span>
          {n.body && <span className="mt-0.5 line-clamp-2 block text-[13px] leading-snug text-muted">{n.body}</span>}
          <span className="mt-1 flex items-center gap-1.5 text-[11.5px] text-muted">
            <span>{kind}</span>
            <span aria-hidden>·</span>
            <span>{listTime(n.updated_at)}</span>
            {n.muted && (
              <span className="inline-flex items-center gap-1" title="Stil door je meldingsinstelling voor deze bot">
                <span aria-hidden>·</span>
                <BellOff className="h-3 w-3" aria-hidden /> stil
              </span>
            )}
          </span>
        </span>
        {unread && <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-warn-strong" aria-hidden />}
      </button>
    </li>
  );
}

const FILTERS: { id: NotifyFilter; label: string }[] = [
  { id: 'all', label: 'Alles' },
  { id: 'unread', label: 'Ongelezen' },
  { id: 'important', label: 'Belangrijk' },
];

/** The history with filters, grouped by day. Used in the bell's popover and on the Meldingen page. */
export function NotificationList({ compact, onNavigate }: { compact?: boolean; onNavigate?(): void }) {
  const items = useNotifications((s) => s.items);
  const filter = useNotifications((s) => s.filter);
  const more = useNotifications((s) => s.more);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    loadNotifications().catch(() => {});
  }, []);
  const open = (n: NotificationItem) => {
    if (!n.read_at) markRead([n.id]).catch(() => {});
    onNavigate?.();
    if (n.link) navigate(n.link);
  };
  const list = items ? (compact ? items.slice(0, 30) : items) : null;
  const days: { label: string; items: NotificationItem[] }[] = [];
  for (const n of list || []) {
    const label = dayLabel(n.updated_at);
    const last = days[days.length - 1];
    if (last?.label === label) last.items.push(n);
    else days.push({ label, items: [n] });
  }
  return (
    <div className="space-y-2">
      <div className="flex gap-1" role="group" aria-label="Welke meldingen">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            type="button"
            aria-pressed={filter === f.id}
            onClick={() => loadNotifications(f.id).catch(toastError)}
            className={cx('h-8 rounded-full px-3 text-[13px] coarse:h-10', filter === f.id ? 'bg-surface-3 font-semibold text-fg' : 'font-medium text-muted hover:bg-surface-2 hover:text-fg')}
          >
            {f.label}
          </button>
        ))}
      </div>
      {!list ? (
        <div className="space-y-0.5" role="status" aria-label="Laden">
          {[0, 1, 2, 3].map((i) => (
            <div key={i} className="flex items-start gap-3 px-3 py-2.5">
              <Skeleton className="h-[34px] w-[34px] shrink-0 rounded-full" />
              <div className="min-w-0 flex-1 space-y-2 pt-0.5">
                <Skeleton className={cx('h-3.5', i % 2 ? 'w-2/5' : 'w-3/5')} />
                <Skeleton className="h-3 w-4/5" />
              </div>
            </div>
          ))}
        </div>
      ) : list.length === 0 ? (
        <EmptyState
          icon={<Bell />}
          title={filter === 'unread' ? 'Alles gelezen' : filter === 'important' ? 'Niets belangrijks' : 'Nog geen meldingen'}
          action={filter !== 'all' ? <Button onClick={() => loadNotifications('all').catch(toastError)}>Alle meldingen tonen</Button> : undefined}
        >
          {filter === 'all' ? 'Wat je bots je laten weten, komt hier te staan.' : undefined}
        </EmptyState>
      ) : (
        days.map((d) => (
          <section key={d.label} aria-label={d.label}>
            <h3 className="px-3 pb-1 pt-2 text-[11.5px] font-bold uppercase tracking-wider text-muted">{d.label}</h3>
            <ul className="space-y-0.5">
              {d.items.map((n) => (
                <Row key={n.id} n={n} onOpen={open} />
              ))}
            </ul>
          </section>
        ))
      )}
      {!compact && more && (
        <div className="flex justify-center pt-2">
          <Button size="sm" loading={busy} onClick={() => (setBusy(true), loadMoreNotifications().catch(toastError).finally(() => setBusy(false)))}>
            Oudere meldingen
          </Button>
        </div>
      )}
    </div>
  );
}

/** The bell: unread count; on wide screens a popover with the history, on the phone a link to the Meldingen page. */
export function NotificationBell({ className, size = 'md' }: { className?: string; size?: 'md' | 'lg' }) {
  const unread = useNotifications((s) => s.unread);
  const open = useNotifications((s) => s.panelOpen);
  const desktop = useIsDesktop();
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const setOpen = (v: boolean) => useNotifications.setState({ panelOpen: v });
  useDismiss(open, ref, () => setOpen(false));
  useEffect(() => {
    if (!desktop && open) setOpen(false);
  }, [desktop, open]);
  const label = unread ? `Meldingen, ${unread} ongelezen` : 'Meldingen';
  const btn = cx('relative flex items-center justify-center text-muted hover:bg-surface-2 hover:text-fg', size === 'lg' ? 'h-11 w-11 rounded-full bg-surface-2 text-fg' : 'h-9 w-9 rounded-control coarse:h-11 coarse:w-11', className);
  const badge = !!unread && (
    <span className={cx('absolute flex h-[17px] min-w-[17px] items-center justify-center rounded-full bg-warn-strong px-1 text-[10.5px] font-bold tabular-nums text-warn-fg', size === 'lg' ? '-end-0.5 -top-0.5' : '-end-1 -top-1')} aria-hidden>
      {unread > 99 ? '99+' : unread}
    </span>
  );
  if (!desktop)
    return (
      <a href="#/m/notifications/" className={btn} aria-label={label} title="Meldingen">
        <Bell className="h-5 w-5" aria-hidden />
        {badge}
      </a>
    );
  return (
    <div className="relative" ref={ref}>
      <button type="button" className={btn} aria-label={label} title="Meldingen" aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <Bell className="size-icon-lg" aria-hidden />
        {badge}
      </button>
      {open && (
        <div role="dialog" aria-labelledby={titleId} className="absolute start-0 top-10 z-40 flex max-h-[min(640px,calc(100vh-80px))] w-[min(420px,calc(100vw-24px))] flex-col rounded-2xl border border-line bg-surface shadow-2xl">
          <div className="flex items-center gap-1 px-4 pb-1 pt-3">
            <h2 id={titleId} className="min-w-0 flex-1 text-[15px] font-bold tracking-tight">
              Meldingen
            </h2>
            <Button variant="ghost" size="icon" aria-label="Alles als gelezen markeren" title="Alles gelezen" disabled={!unread} onClick={() => markAllRead().catch(toastError)}>
              <CheckCheck className="h-4 w-4" />
            </Button>
            <a href={SETTINGS_HREF} onClick={() => setOpen(false)} className="flex h-9 w-9 items-center justify-center rounded-[10px] text-muted hover:bg-surface-2 hover:text-fg" aria-label="Meldingen instellen" title="Meldingen instellen">
              <Settings className="h-4 w-4" />
            </a>
            <Button variant="ghost" size="icon" aria-label="Sluiten" className="-me-2" onClick={() => setOpen(false)}>
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto px-1.5 pb-2">
            <NotificationList compact onNavigate={() => setOpen(false)} />
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-line px-4 py-2.5 text-[13px] font-semibold">
            <a href="#/m/notifications/" onClick={() => setOpen(false)} className="hover:underline">
              Alle meldingen
            </a>
            <a href={SETTINGS_HREF} onClick={() => setOpen(false)} className="text-muted hover:text-fg hover:underline">
              Per bot instellen
            </a>
          </div>
        </div>
      )}
    </div>
  );
}

/** Alles / Alleen belangrijk / Niets as one segmented control (components/SettingControls.tsx). */
export function LevelPicker({ value, onChange, label, disabled }: { value: NotifyLevel; onChange(v: NotifyLevel): void; label: string; disabled?: boolean }) {
  const opts: NotifyLevel[] = ['all', 'important', 'none'];
  return (
    <Segmented
      size="sm"
      label={label}
      value={value}
      disabled={disabled}
      onChange={onChange}
      options={opts.map((o) => ({
        value: o,
        text: LEVEL_LABEL[o],
        label:
          o === 'important' ? (
            <>
              <span className="sm:hidden">Belangrijk</span>
              <span className="hidden sm:inline">{LEVEL_LABEL[o]}</span>
            </>
          ) : (
            LEVEL_LABEL[o]
          ),
      }))}
    />
  );
}

const LEVEL_HINT = 'Alleen belangrijk: vragen, goedkeuringen, fouten en limieten.';

function usePrefs() {
  const prefs = useNotifications((s) => s.prefs);
  useEffect(() => {
    loadPrefs().catch(() => {});
  }, []);
  return prefs;
}

/** Settings › Meldingen: sound, notifications without a bot, and a level per bot. Every change saves at once. */
export function NotificationSettings({ simple }: { simple?: boolean } = {}) {
  const prefs = usePrefs();
  const agents = useApp((s) => s.agents).filter((a) => !a.archived);
  if (!prefs) return <Spinner />;
  // The short page (Instellingen › Meldingen): the sound, nothing else. Levels per bot are under Geavanceerd.
  if (simple)
    return (
      <SettingsSection title="Meldingen" icon={Bell} tone="amber" hint="Geldt overal: in TeamBot, op je computer en op je telefoon.">
        <SoundRow prefs={prefs} />
      </SettingsSection>
    );
  const isDefault = prefs.sound && prefs.other === 'all' && Object.values(prefs.bots).every((l) => l === 'all');
  return (
    <div className="space-y-4">
      <SettingsSection
        title="Meldingen"
        icon={Bell}
        tone="orange"
        hint="Geldt overal: in TeamBot, op je computer en op je telefoon."
        isDefault={isDefault}
        onReset={() => savePrefs({ sound: true, other: 'all', bots: Object.fromEntries(Object.keys(prefs.bots).map((id) => [id, null])) })}
      >
        <NotifyRows prefs={prefs} />
      </SettingsSection>
      <SettingsSection title="Per bot" icon={Bot} tone="teal" hint="Hoeveel je van elke bot wilt horen." info={LEVEL_HINT}>
        {agents.length === 0 ? (
          <p className="py-3 text-sm text-muted">Nog geen bots.</p>
        ) : (
          agents.map((a) => <BotLevelRow key={a.id} agent={a} level={levelOf(prefs, a.id)} />)
        )}
      </SettingsSection>
      <p className="px-1 text-xs text-muted">
        <a className="underline" href="#/settings/mobile-telefoon">
          Telefoon
        </a>{' '}
        ·{' '}
        <a className="underline" href="#/settings/usage-limits">
          Limieten
        </a>
      </p>
    </div>
  );
}

function SoundRow({ prefs }: { prefs: NotifyPrefs }) {
  const save = useSave();
  return <SwitchRow checked={prefs.sound} onChange={(v) => void save(savePrefs({ sound: v }))} setting="notifications.sound" />;
}

function NotifyRows({ prefs }: { prefs: NotifyPrefs }) {
  const save = useSave();
  return (
    <>
      <SoundRow prefs={prefs} />
      <SettingRow setting="notifications.other">
        <LevelPicker label={settingText('notifications.other').title} value={prefs.other} onChange={(v) => void save(savePrefs({ other: v }))} />
      </SettingRow>
    </>
  );
}

function BotLevelRow({ agent, level }: { agent: Agent; level: NotifyLevel }) {
  const save = useSave();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2 py-2.5">
      <BotAvatar bot={agent} size={32} />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-sm font-semibold">{agent.name}</span>
        {agent.role && (
          <span className="block truncate text-xs text-muted" translate="no">
            {agent.role}
          </span>
        )}
      </span>
      <LevelPicker label={`Meldingen van ${agent.name}`} value={level} onChange={(v) => void save(savePrefs({ bots: { [agent.id]: v } }))} />
    </div>
  );
}

/** Bot editor › Meldingen: the level for this bot. Saves at once (not part of the editor's Opslaan). */
export function AgentNotifySection({ agent }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  const prefs = usePrefs();
  if (!agent.id) return <p className="text-sm text-muted">Stel dit in nadat de bot is aangemaakt.</p>;
  if (!prefs) return <Spinner />;
  const v = levelOf(prefs, agent.id);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <span className="text-sm">Hoeveel wil je horen van {agent.name || 'deze bot'}?</span>
        <LevelPicker
          label={`Meldingen van ${agent.name || 'deze bot'}`}
          value={v}
          onChange={(level) =>
            savePrefs({ bots: { [agent.id]: level } })
              .then(() => toast(`Meldingen van ${agent.name}: ${LEVEL_LABEL[level].toLowerCase()} (opgeslagen)`, 'ok'))
              .catch(toastError)
          }
        />
      </div>
      <p className="text-xs leading-relaxed text-muted">
        Wordt direct opgeslagen.{' '}
        <a className="underline" href={SETTINGS_HREF}>
          Alle bots en geluid
        </a>{' '}
        <MoreInfo>{LEVEL_HINT}</MoreInfo>
      </p>
    </div>
  );
}

/** #/m/notifications — the full history (also the phone's bell). */
export function NotificationsPage() {
  const unread = useNotifications((s) => s.unread);
  const count = useNotifications((s) => s.items?.length || 0);
  const [confirm, setConfirm] = useState(false);
  return (
    <Page>
      <PageHeader
        title="Meldingen"
        subtitle="Wat je bots je lieten weten."
        width="3xl"
        actions={
          <>
            <Menu
              label="Meer opties"
              items={[
                { label: 'Meldingen instellen', icon: <Settings />, href: SETTINGS_HREF },
                { label: 'Geschiedenis wissen', icon: <Trash2 />, danger: true, disabled: !count, onSelect: () => setConfirm(true) },
              ]}
            />
            <Button icon={<CheckCheck className="h-4 w-4" />} disabled={!unread} onClick={() => markAllRead().then(() => toast('Alles gelezen', 'ok'), toastError)}>
              Alles gelezen
            </Button>
          </>
        }
      />
      <div className="mx-auto max-w-3xl px-2.5 pb-8 pt-3 sm:px-4">
        <NotificationList />
      </div>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Geschiedenis wissen?"
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Annuleren</Button>
            <Button variant="danger" onClick={() => clearNotifications().then(() => (setConfirm(false), toast('Meldingen gewist', 'ok')), toastError)}>
              Wissen
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed text-muted">Alle meldingen verdwijnen uit deze lijst. Vragen blijven in Wacht op jou.</p>
      </Modal>
    </Page>
  );
}
