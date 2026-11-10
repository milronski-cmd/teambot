import { useEffect, useMemo, useRef, useState } from 'react';
import { create } from 'zustand';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CircleStop,
  Eraser,
  Expand,
  Globe,
  Hand,
  KeyRound,
  Keyboard,
  Lock,
  LockOpen,
  LogOut,
  MonitorUp,
  MoreVertical,
  Pause,
  PictureInPicture2,
  Play,
  Power,
  RotateCw,
  X,
} from 'lucide-react';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { useIsDesktop, useMedia } from '../../lib/media';
import { isRtl, uiLocale } from '../../lib/i18n';
import { BotAvatar } from '../../components/BotFace';
import { Badge, Button, cx, Input, Modal, Spinner, toast, useAsync } from '../../components/ui';
import { browserApi, computers, openPip, patchStatus, siteOf, useLive, type BrowserTab, type ComputerStatus } from './api';
import { LiveImage, useScreenInput } from './LiveScreen';

// ---------------- open/closed + width (per device) ----------------

const KEY = 'tb_browser_dock';
const MIN_W = 380;
const MAX_W = 960;

function readPrefs(): { open: Record<string, boolean>; width: number } {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) || '{}');
    return { open: v.open && typeof v.open === 'object' ? v.open : {}, width: Number(v.width) || 560 };
  } catch {
    return { open: {}, width: 560 };
  }
}

interface DockState {
  open: Record<string, boolean>;
  width: number;
  setOpen(agentId: string, open: boolean): void;
  setWidth(w: number): void;
}

const save = (s: { open: Record<string, boolean>; width: number }) => {
  try {
    localStorage.setItem(KEY, JSON.stringify({ open: s.open, width: s.width }));
  } catch {
    /* private mode: just not remembered */
  }
};

export const useDock = create<DockState>((set, get) => ({
  ...readPrefs(),
  setOpen(agentId, open) {
    set((s) => ({ open: { ...s.open, [agentId]: open } }));
    save(get());
  },
  setWidth(width) {
    set({ width: Math.round(Math.max(MIN_W, Math.min(MAX_W, width))) });
    save(get());
  },
}));

/** Open a bot's browser next to the chat (or as a sheet on the phone). */
export function openDock(agentId: string) {
  useDock.getState().setOpen(agentId, true);
}

/** Whether each bot's browser runs, kept up to date from live events (for the dot on the header button). */
export const useRunning = create<Record<string, boolean>>(() => ({}));
export function trackRunning(): () => void {
  // seed once (a browser may already run when the app opens); a paired phone may not list computers: then events only
  computers
    .list()
    .then((rows) => useRunning.setState(Object.fromEntries(rows.map((r) => [r.agent.id, !!r.status.browser.running]))))
    .catch(() => {});
  return on('computer.status', (st: ComputerStatus) => {
    if (st?.agentId) useRunning.setState({ [st.agentId]: !!st.browser?.running });
  });
}

// ---------------- header button (small and self-contained) ----------------

export function BrowserDockButton({ threadId, agentId }: { threadId: string; agentId: string | null }) {
  const agent = useApp((s) => (agentId ? s.agents.find((a) => a.id === agentId) : undefined));
  const isRoom = useApp((s) => s.threads.find((t) => t.id === threadId)?.kind === 'room');
  const open = useDock((s) => !!(agentId && s.open[agentId]));
  const running = useRunning((s) => !!(agentId && s[agentId]));
  if (!agent || isRoom || !agent.tool_groups?.includes('browser')) return null;
  return (
    <Button
      variant="ghost"
      size="icon"
      className="relative aria-pressed:bg-surface-3 aria-pressed:text-fg"
      aria-label={`Browser van ${agent.name}${running ? ' (actief)' : ''}`}
      title="Browser van de bot: meekijken, overnemen, inloggen"
      aria-pressed={open}
      onClick={() => useDock.getState().setOpen(agent.id, !open)}
    >
      <Globe className="h-4 w-4" />
      {running && <span className="absolute end-[7px] top-[7px] h-2 w-2 rounded-full bg-ok ring-2 ring-canvas coarse:end-2.5 coarse:top-2.5" aria-hidden />}
    </Button>
  );
}

// ---------------- the dock / sheet ----------------

/** Rendered by the chat view next to the conversation; null unless the user opened this bot's browser. */
export function BrowserDock({ agentId }: { threadId: string; agentId: string | null }) {
  const open = useDock((s) => !!(agentId && s.open[agentId]));
  const desktop = useIsDesktop();
  const wide = useMedia('(min-width: 1100px)');
  if (!agentId || !open) return null;
  const close = () => useDock.getState().setOpen(agentId, false);
  if (!desktop)
    return (
      <div className="safe-top safe-bottom safe-x fixed inset-0 z-50 flex flex-col bg-canvas" role="dialog" aria-modal="true" aria-label="Browser van de bot">
        <BrowserPanel agentId={agentId} onClose={close} variant="sheet" />
      </div>
    );
  if (!wide)
    return (
      <>
        <div className="fixed inset-0 z-30 bg-black/40" onClick={close} aria-hidden />
        <aside className="fixed inset-y-0 end-0 z-40 flex w-[min(600px,94vw)] flex-col border-s border-line bg-surface shadow-2xl" aria-label="Browser van de bot">
          <BrowserPanel agentId={agentId} onClose={close} variant="dock" />
        </aside>
      </>
    );
  return <DockedAside agentId={agentId} onClose={close} />;
}

function DockedAside({ agentId, onClose }: { agentId: string; onClose(): void }) {
  const width = useDock((s) => s.width);
  const drag = useRef<{ x: number; w: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  return (
    <aside className="relative flex h-full shrink-0 flex-col border-s border-line bg-surface" style={{ width, maxWidth: 'calc(100vw - 700px)', minWidth: 340 }} aria-label="Browser van de bot">
      <div
        role="separator"
        aria-orientation="vertical"
        aria-label="Breedte van het browserpaneel"
        aria-valuemin={MIN_W}
        aria-valuemax={MAX_W}
        aria-valuenow={width}
        tabIndex={0}
        className={cx('group absolute inset-y-0 -start-1.5 z-10 w-3 cursor-col-resize touch-none outline-none', dragging && 'cursor-col-resize')}
        onPointerDown={(e) => {
          drag.current = { x: e.clientX, w: width };
          setDragging(true);
          e.currentTarget.setPointerCapture(e.pointerId);
        }}
        // The dock sits at the end side: dragging towards the start (left, or right in RTL) makes it wider.
        onPointerMove={(e) => drag.current && useDock.getState().setWidth(drag.current.w + (drag.current.x - e.clientX) * (isRtl() ? -1 : 1))}
        onPointerUp={() => ((drag.current = null), setDragging(false))}
        onPointerCancel={() => ((drag.current = null), setDragging(false))}
        onKeyDown={(e) => {
          const wider = isRtl() ? 'ArrowRight' : 'ArrowLeft';
          if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') useDock.getState().setWidth(width + (e.key === wider ? 40 : -40));
        }}
      >
        <span className={cx('absolute inset-y-0 left-1/2 w-0.5 -translate-x-1/2 rounded-full transition-colors', dragging ? 'bg-fg/40' : 'bg-transparent group-hover:bg-line-strong group-focus-visible:bg-fg/40')} />
      </div>
      <BrowserPanel agentId={agentId} onClose={onClose} variant="dock" />
    </aside>
  );
}

function hostParts(url: string): { secure: boolean | null; host: string; rest: string } {
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return { secure: null, host: url === 'about:blank' ? 'Lege pagina' : url, rest: '' };
    return { secure: u.protocol === 'https:', host: u.host, rest: (u.pathname === '/' ? '' : u.pathname) + u.search };
  } catch {
    return { secure: null, host: url || '', rest: '' };
  }
}

function tabLabel(t: BrowserTab) {
  if (t.title) return t.title;
  const h = hostParts(t.url);
  return h.host || 'Nieuw tabblad';
}

const menuItem = 'flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-start text-sm hover:bg-surface-2 disabled:opacity-45 coarse:py-3';

/** The browser of one bot: tabs, address bar, live view, take over / give back, and a menu with the rest. */
export function BrowserPanel({ agentId, onClose, variant }: { agentId: string; onClose(): void; variant: 'dock' | 'sheet' }) {
  const me = useApp((s) => s.me);
  const agent = useApp((s) => s.agents.find((a) => a.id === agentId));
  const { data, error, loading, reload } = useLive(() => computers.get(agentId), ['computer.status', 'computer.config'], [agentId], patchStatus(agentId));
  const caps = useLive(() => computers.caps().catch(() => null), [], []);
  const last = useLive(() => computers.actions(agentId, 1).catch(() => []), ['computer.action'], [agentId]);
  const { busy, run } = useAsync();
  const [streamKey, setStreamKey] = useState(0);
  const [editing, setEditing] = useState<string | null>(null);
  const [typed, setTyped] = useState('');
  const [menu, setMenu] = useState(false);
  const [confirm, setConfirm] = useState<'stop' | 'wipe' | 'logout' | null>(null);
  const [startUrl, setStartUrl] = useState('');
  const [now, setNow] = useState(Date.now());
  const menuRef = useRef<HTMLDivElement>(null);
  const titleRef = useRef<HTMLHeadingElement>(null);

  const status = data?.status;
  const running = !!status?.browser.running;
  const controller = status?.controller || null;
  const iControl = !!(controller && controller.kind === 'user' && me && controller.userId === me.id);
  const sticky = !!controller?.sticky;
  // Whoever holds the browser can click and type, also while the bot is paused: that is exactly how you log in
  // when the bot asks for it (browser_request_login pauses the bot and hands you the browser).
  const active = iControl;
  const scr = useScreenInput(agentId, active);
  const hasBrowser = status?.mode === 'browser' || status?.mode === 'host';
  // A window on the computer's screen is opened from the computer; a paired phone takes over in the live view.
  const phone = useApp((s) => s.device);
  const visibleOk = caps.data?.caps.find((c) => c.id === 'visible')?.status === 'available' && caps.data?.isOwner && variant === 'dock' && !phone;
  const url = status?.browser.url || '';
  const parts = hostParts(url);
  const site = parts.secure !== null ? siteOf(url) : '';
  const tabs = status?.browser.tabs || [];
  const name = agent?.name || 'de bot';

  useEffect(() => titleRef.current?.focus(), []);
  // keep the human lease alive while you control the browser from this panel
  useEffect(() => {
    if (!active || sticky) return; // a pause has no heartbeat: it lasts until "Ga verder"
    const t = setInterval(() => api.post(`/computers/${agentId}/heartbeat`, {}).catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [active, sticky, agentId]);
  useEffect(() => {
    if (!menu) return;
    const f = (e: MouseEvent) => menuRef.current && !menuRef.current.contains(e.target as Node) && setMenu(false);
    const k = (e: KeyboardEvent) => e.key === 'Escape' && setMenu(false);
    document.addEventListener('mousedown', f);
    document.addEventListener('keydown', k);
    return () => (document.removeEventListener('mousedown', f), document.removeEventListener('keydown', k));
  }, [menu]);
  // the "what the bot just did" pill fades after a few seconds
  const lastAction = last.data?.[0];
  const pill = useMemo(() => (lastAction && lastAction.actor !== 'user' && now - Date.parse(lastAction.created_at) < 7000 ? lastAction : null), [lastAction, now]);
  useEffect(() => {
    if (!lastAction) return;
    setNow(Date.now());
    const t = setTimeout(() => setNow(Date.now()), 7100);
    return () => clearTimeout(t);
  }, [lastAction?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const post = (p: string, body: any = {}, ok?: string) => run(() => api.post(`/computers/${agentId}${p}`, body), ok).then((r) => (reload(), r));
  const go = (raw: string) => {
    const v = raw.trim();
    if (!v) return;
    scr.send({ type: 'navigate', url: /^https?:\/\//i.test(v) ? v : 'https://' + v });
    setEditing(null);
  };

  const sheet = variant === 'sheet';
  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* header */}
      <div className={cx('flex shrink-0 items-center gap-2.5 border-b border-line px-3', sheet ? 'h-[60px]' : 'h-14')}>
        {sheet && (
          <Button variant="ghost" size="icon" aria-label="Terug naar het gesprek" onClick={onClose} className="-ms-1">
            <ArrowLeft className="h-5 w-5" />
          </Button>
        )}
        {agent && <BotAvatar bot={agent} size={30} mood={controller?.kind === 'bot' ? 'working' : 'idle'} />}
        <div className="min-w-0 flex-1">
          <h2 ref={titleRef} tabIndex={-1} style={{ outline: 'none' }} className="truncate text-[14.5px] font-bold leading-tight tracking-tight">
            Browser van {name}
          </h2>
          <div className="truncate text-xs text-muted">
            {!status ? '…' : !hasBrowser ? 'Geen eigen browser' : !running ? 'Uit' : controller?.kind === 'bot' ? `${controller.name} bedient` : iControl ? (sticky ? 'Jij hebt de bot gepauzeerd' : 'Jij bedient — de bot wacht') : controller ? `Bediend door ${controller.name}` : status.profileShared ? `Gedeeld profiel · ${status.profileName || ''}` : 'Eigen profiel'}
          </div>
        </div>
        {running && !sheet && (
          <Button variant="ghost" size="icon" aria-label="Beeld-in-beeld" title="Beeld-in-beeld (klein venster dat bovenop blijft)" onClick={() => openPip(agentId, 'browser')}>
            <PictureInPicture2 className="h-4 w-4" />
          </Button>
        )}
        {!sheet && (
          <Button variant="ghost" size="icon" aria-label="Groot openen" title="Groot openen (live scherm met stappen)" onClick={() => navigate(`/m/browser/live/${agentId}`)}>
            <Expand className="h-4 w-4" />
          </Button>
        )}
        {!sheet && (
          <Button variant="ghost" size="icon" aria-label="Browserpaneel sluiten" onClick={onClose}>
            <X className="h-4 w-4" />
          </Button>
        )}
      </div>

      {loading && !data ? (
        <div className="flex flex-1 items-center justify-center">
          <Spinner />
        </div>
      ) : error ? (
        <div className="p-4 text-sm text-danger">{error}</div>
      ) : !status ? null : !hasBrowser ? (
        <Empty
          title={`${name} heeft geen eigen browser`}
          text="Kies bij de bot onder Computer & bestanden de modus “Eigen browser”."
          action={
            <Button size="sm" onClick={() => navigate(`/agents/${agentId}`)}>
              Naar de bot-instellingen
            </Button>
          }
        />
      ) : (
        <>
          {/* tabs */}
          {running && tabs.length > 0 && (
            <div className="scroll-thin flex shrink-0 gap-1 overflow-x-auto border-b border-line px-2 py-1.5" role="tablist" aria-label="Tabbladen">
              {tabs.map((t) => (
                <button
                  key={t.index}
                  type="button"
                  role="tab"
                  aria-selected={t.active}
                  title={iControl ? t.url : `${t.url}${t.active ? '' : ' — neem over om van tabblad te wisselen'}`}
                  disabled={!iControl && !t.active}
                  onClick={() => iControl && !t.active && scr.send({ type: 'tab', index: t.index })}
                  className={cx(
                    'flex h-8 min-w-0 max-w-[200px] shrink-0 items-center gap-1.5 rounded-lg px-2.5 text-[12.5px] transition-colors coarse:h-10',
                    t.active ? 'bg-surface-3 font-semibold text-fg' : 'text-muted hover:bg-surface-2 hover:text-fg disabled:hover:bg-transparent disabled:hover:text-muted',
                  )}
                >
                  <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden />
                  <span className="truncate">{tabLabel(t)}</span>
                </button>
              ))}
            </div>
          )}

          {/* address bar */}
          <div className="flex shrink-0 items-center gap-1 px-2 py-2">
            <Button variant="ghost" size="icon" aria-label="Terug" disabled={!active || !running} onClick={() => scr.send({ type: 'back' })}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Vooruit" disabled={!active || !running} onClick={() => scr.send({ type: 'forward' })}>
              <ArrowRight className="h-4 w-4" />
            </Button>
            <Button variant="ghost" size="icon" aria-label="Opnieuw laden" disabled={!active || !running} onClick={() => scr.send({ type: 'reload' })}>
              <RotateCw className="h-4 w-4" />
            </Button>
            {active && editing !== null ? (
              <form
                className="min-w-0 flex-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  go(editing);
                }}
              >
                <Input autoFocus value={editing} onChange={(e) => setEditing(e.target.value)} onBlur={() => setEditing(null)} onKeyDown={(e) => e.key === 'Escape' && setEditing(null)} aria-label="Adres" placeholder="Adres, bijv. example.com" className="h-9 rounded-full px-3.5" spellCheck={false} />
              </form>
            ) : (
              <button
                type="button"
                disabled={!active}
                onClick={() => setEditing(url.startsWith('http') ? url : '')}
                title={active ? 'Klik om een adres te typen' : url ? `${url}${running ? ' — neem over om zelf een adres te openen' : ''}` : undefined}
                aria-label={`Adres: ${url || 'geen pagina'}${active ? ' (klik om te wijzigen)' : ''}`}
                className={cx('flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-line bg-surface-2 px-3.5 text-start text-[13px]', active ? 'cursor-text hover:border-line-strong' : 'cursor-default')}
              >
                {parts.secure === true ? <Lock className="h-3.5 w-3.5 shrink-0 text-muted" aria-label="Beveiligde verbinding" /> : parts.secure === false ? <LockOpen className="h-3.5 w-3.5 shrink-0 text-warn" aria-label="Niet beveiligd" /> : <Globe className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />}
                <span className="min-w-0 truncate" translate="no">
                  {running ? (
                    <>
                      <span className="font-semibold text-fg">{parts.host || 'Lege pagina'}</span>
                      <span className="text-muted">{parts.rest}</span>
                    </>
                  ) : (
                    <span className="text-muted">Browser is uit</span>
                  )}
                </span>
              </button>
            )}
            <div className="relative" ref={menuRef}>
              <Button variant="ghost" size="icon" aria-label="Meer browseropties" aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(!menu)}>
                <MoreVertical className="h-4 w-4" />
              </Button>
              {menu && (
                <div role="menu" className="absolute end-0 top-11 z-30 w-72 rounded-2xl border border-line bg-surface p-1.5 shadow-2xl">
                  {running && !sheet && (
                    <button role="menuitem" className={menuItem} onClick={() => (setMenu(false), openPip(agentId, 'browser'))}>
                      <PictureInPicture2 className="h-4 w-4" /> Beeld-in-beeld
                    </button>
                  )}
                  {visibleOk && !iControl && (
                    <button role="menuitem" className={menuItem} onClick={() => (setMenu(false), post('/takeover', { visible: true }, 'Browservenster geopend op je bureaublad'))}>
                      <MonitorUp className="h-4 w-4" /> Open als venster op je bureaublad
                    </button>
                  )}
                  {running && site && (
                    <button role="menuitem" className={menuItem} onClick={() => (setMenu(false), setConfirm('logout'))}>
                      <LogOut className="h-4 w-4" /> Uitloggen bij {site}
                    </button>
                  )}
                  {status.profileId && (
                    <button role="menuitem" className={menuItem} onClick={() => (setMenu(false), setConfirm('wipe'))}>
                      <Eraser className="h-4 w-4" /> Profiel wissen (overal uitloggen)…
                    </button>
                  )}
                  <button role="menuitem" className={menuItem} onClick={() => (setMenu(false), navigate('/m/browser/kluis'))}>
                    <KeyRound className="h-4 w-4" /> Kluis met logins beheren
                  </button>
                  {running && (
                    <button role="menuitem" className={menuItem} onClick={() => (setMenu(false), run(() => browserApi.close(agentId), 'Browser gesloten').then(reload))}>
                      <Power className="h-4 w-4" /> Browser sluiten
                    </button>
                  )}
                  <div className="my-1 h-px bg-line" />
                  <button role="menuitem" className={cx(menuItem, 'text-danger hover:bg-danger-soft')} onClick={() => (setMenu(false), setConfirm('stop'))}>
                    <CircleStop className="h-4 w-4" /> Noodstop
                  </button>
                </div>
              )}
            </div>
          </div>

          {/* live view */}
          <div className={cx('min-h-0', sheet ? 'flex flex-1 flex-col justify-center bg-surface-2' : 'px-3')}>
            {running ? (
              <div className={cx('relative overflow-hidden border-line bg-surface-2', sheet ? 'border-y' : 'rounded-xl border', active && 'ring-2 ring-warn/60')}>
                <LiveImage agentId={agentId} input={scr} active={active} filling={status.browser.filling} streamKey={streamKey} onReconnect={() => setStreamKey((k) => k + 1)} label={`Live beeld van de browser van ${name}: ${parts.host || 'lege pagina'}`} />
                {pill && !status.browser.filling && (
                  <div className="pointer-events-none absolute bottom-2 start-2 flex max-w-[85%] items-center gap-1.5 rounded-full bg-black/70 px-2.5 py-1 text-xs font-medium text-white shadow-lg" aria-live="polite">
                    <Bot className="h-3.5 w-3.5 shrink-0" aria-hidden />
                    <span className="truncate">{pill.summary}</span>
                  </div>
                )}
                {status.browser.headed && (
                  <div className="pointer-events-none absolute end-2 top-2">
                    <Badge tone="accent">Ook als venster op je bureaublad</Badge>
                  </div>
                )}
              </div>
            ) : (
              <div className={cx('flex flex-col items-center justify-center gap-3 px-6 py-10 text-center', !sheet && 'rounded-xl border border-dashed border-line')}>
                <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-3 text-muted">
                  <Globe className="h-5 w-5" />
                </span>
                <div className="text-base font-bold tracking-tight">De browser van {name} is uit</div>
                <p className="max-w-sm text-sm leading-relaxed text-muted">Hij start vanzelf zodra {name} een website opent. Je kunt hem ook zelf starten, bijvoorbeeld om alvast in te loggen.</p>
                <form
                  className="flex w-full max-w-sm gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const v = startUrl.trim();
                    run(() => browserApi.start(agentId, v ? (/^https?:\/\//i.test(v) ? v : 'https://' + v) : undefined), 'Browser gestart').then(() => (setStartUrl(''), reload()));
                  }}
                >
                  <Input value={startUrl} onChange={(e) => setStartUrl(e.target.value)} placeholder="Adres (optioneel)" aria-label="Adres om mee te starten" spellCheck={false} />
                  <Button type="submit" variant="primary" size="md" icon={<Play className="h-4 w-4" />} loading={busy} className="shrink-0">
                    Start
                  </Button>
                </form>
              </div>
            )}
          </div>

          {/* controls */}
          {running && (
            <div className={cx('shrink-0 space-y-2.5 px-3 pb-3 pt-3', sheet && 'border-t border-line bg-canvas')}>
              <div className="flex flex-wrap items-center gap-2">
                {iControl ? (
                  <Button variant="primary" size={sheet ? 'lg' : 'md'} icon={sticky ? <Play className="h-4 w-4" /> : <Bot className="h-4 w-4" />} loading={busy} onClick={() => post('/release', {})} className={cx(sheet && 'flex-1 justify-center')}>
                    {sticky ? 'Ga verder' : `Geef terug aan ${name}`}
                  </Button>
                ) : (
                  <>
                    <Button variant="primary" size={sheet ? 'lg' : 'md'} icon={<Hand className="h-4 w-4" />} loading={busy} onClick={() => post('/takeover', {})} className={cx(sheet && 'flex-1 justify-center')}>
                      Neem over
                    </Button>
                    <Button variant="ghost" size={sheet ? 'lg' : 'md'} icon={<Pause className="h-4 w-4" />} loading={busy} onClick={() => post('/takeover', { pause: true })}>
                      Pauzeer
                    </Button>
                  </>
                )}
                {controller?.waiting?.length ? <Badge>Wachtend: {controller.waiting.join(', ')}</Badge> : null}
              </div>
              <p className="text-xs leading-relaxed text-muted">
                {active
                  ? (sheet
                      ? 'Tik in het beeld om te klikken en typ hieronder. Wat je typt gaat rechtstreeks naar de pagina en niet naar de bot.'
                      : 'Klik in het beeld en typ, of gebruik het veld hieronder. Wat je typt gaat niet naar de bot.') +
                    (sticky ? ' ' + `${name} wacht tot je op “Ga verder” drukt.` : '')
                  : `Je kijkt mee. Neem over om zelf te klikken en te typen; ${name} wacht dan.`}
              </p>
              {active && (
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!typed) return;
                    scr.send({ type: 'type', text: typed });
                    setTyped('');
                  }}
                >
                  <Input type="password" autoComplete="off" data-1p-ignore data-lpignore="true" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Tekst typen (ook wachtwoorden)" aria-label="Tekst typen in de pagina" />
                  <Button type="submit" size="md" icon={<Keyboard className="h-4 w-4" />} className="shrink-0">
                    Typ
                  </Button>
                  {['Enter', 'Tab'].map((k) => (
                    <Button key={k} type="button" variant="ghost" size="md" className="shrink-0 px-2.5" onClick={() => scr.send({ type: 'key', key: k })}>
                      {k}
                    </Button>
                  ))}
                </form>
              )}
            </div>
          )}

          {/* what happened lately (desktop: fills the space under the screen) */}
          {!sheet && <RecentSteps agentId={agentId} />}
        </>
      )}

      <Modal
        open={confirm === 'logout'}
        onClose={() => setConfirm(null)}
        title={`Uitloggen bij ${site}?`}
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Annuleren</Button>
            <Button variant="primary" icon={<LogOut className="h-4 w-4" />} loading={busy} onClick={() => run(() => browserApi.logoutSite(agentId, site), `Uitgelogd bij ${site}`).then(() => setConfirm(null))}>
              Uitloggen
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed">De cookies en sitegegevens van {site} in dit browserprofiel worden gewist{status?.profileShared ? '. Dit profiel is gedeeld, dus ook de andere bots met dit profiel zijn dan uitgelogd' : ''}. Andere sites blijven ingelogd.</p>
      </Modal>
      <Modal
        open={confirm === 'wipe'}
        onClose={() => setConfirm(null)}
        title="Profiel wissen?"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Annuleren</Button>
            <Button variant="danger" icon={<Eraser className="h-4 w-4" />} loading={busy} onClick={() => run(() => browserApi.wipeProfile(status!.profileId!), 'Profiel gewist').then(() => (setConfirm(null), reload()))}>
              Wissen
            </Button>
          </>
        }
      >
        <p className="text-sm leading-relaxed">Alle cookies, logins, geschiedenis en sitegegevens van {status?.profileShared ? `het gedeelde profiel “${status.profileName}”` : `het profiel van ${name}`} worden verwijderd en de browser sluit. Logins in de kluis blijven bewaard.</p>
      </Modal>
      <Modal
        open={confirm === 'stop'}
        onClose={() => setConfirm(null)}
        title="Noodstop"
        footer={
          <>
            <Button onClick={() => setConfirm(null)}>Annuleren</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                const r: any = await post('/stop');
                setConfirm(null);
                if (r) toast(r.cancelled === 1 ? 'Gestopt (1 taak)' : `Gestopt (${r.cancelled} taken)`, 'ok');
              }}
            >
              Nu stoppen
            </Button>
          </>
        }
      >
        <p className="text-sm">Alle taken van {name} stoppen direct en de browser gaat dicht. Het browserprofiel en de bestanden blijven bewaard.</p>
      </Modal>
    </div>
  );
}

function RecentSteps({ agentId }: { agentId: string }) {
  const list = useLive(() => computers.actions(agentId, 12).catch(() => []), ['computer.action'], [agentId]);
  const rows = (list.data || []).filter((a) => a.tool !== 'heartbeat');
  if (!rows.length) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col border-t border-line">
      <div className="px-4 pb-1 pt-3 text-[11.5px] font-bold uppercase tracking-wider text-muted">Laatste stappen</div>
      {/* focusable: a long list scrolls, and keyboard users must be able to scroll it too */}
      <ul className="scroll-thin min-h-0 flex-1 overflow-y-auto px-2 pb-2 outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent" tabIndex={0} aria-label="Laatste stappen">
        {rows.map((a) => (
          <li key={a.id} className="flex items-start gap-2 rounded-lg px-2 py-1.5 text-[13px]">
            {a.actor === 'user' ? <Hand className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warn" aria-label="Jij" /> : a.actor === 'system' ? <KeyRound className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" aria-label="TeamBot" /> : <Bot className="mt-0.5 h-3.5 w-3.5 shrink-0 text-muted" aria-label="Bot" />}
            <span className={cx('min-w-0 flex-1 break-words', a.status === 'error' && 'text-danger')}>{a.summary}</span>
            <span className="shrink-0 text-xs text-muted">{new Date(a.created_at).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' })}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

function Empty({ title, text, action }: { title: string; text: string; action?: React.ReactNode }) {
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-10 text-center">
      <span className="flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-3 text-muted">
        <Globe className="h-5 w-5" />
      </span>
      <div className="text-base font-bold tracking-tight">{title}</div>
      <p className="max-w-sm text-sm leading-relaxed text-muted">{text}</p>
      {action}
    </div>
  );
}

