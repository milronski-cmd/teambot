import { useEffect, useState } from 'react';
import { WifiOff } from 'lucide-react';
import { api, connectWs, disconnectWs, ensureUrlKey, getToken, on, setToken } from './lib/api';
import { stripRefs } from './lib/preview';
import { useApp, wireEvents } from './lib/store';
import { useRoute } from './lib/router';
import { DESK_QUERY, useIsDesktop, useVisualViewportHeight } from './lib/media';
import { uiModules, useInboxExtraCount } from './modules';
import { Button, EmptyState, Spinner, Toaster, cx } from './components/ui';
import { AuthScreen } from './shell/Auth';
import { Sidebar } from './shell/Sidebar';
import { AgentChatRoute, ChatView } from './shell/ChatView';
import { applyTheme } from './shell/theme';
import { useDesktopBadge } from './shell/badge';
import { useAccentSync } from './shell/accentSync';
import { CommandPalette, openPalette } from './shell/CommandPalette';
import { Home } from './pages/Home';
import { AgentsPage } from './pages/Agents';
import { AgentEditor } from './pages/AgentEditor';
import { FirstBotPage } from './pages/welcome/FirstBot';
import { SettingsFrame, SettingsPage } from './pages/Settings';
import { InboxPage } from './pages/Inbox';
import { SearchPage } from './pages/Search';
import { MorePage } from './pages/More';
import { TasksPage } from './pages/Tasks';
import { settingsHostOf } from './lib/palette';
import { DESTINATIONS, PHONE_TABS, activePhoneTab } from './shell/nav';
import { onLanguageSave, syncLanguage } from './lib/i18n';
import { LockConfirmHost, LockScreen, useLock, useLockWatcher } from './shell/AppLock';
import { usePhoneStart } from './modules/mobile/start';

applyTheme();
// The chosen interface language is stored for the signed-in user, so the phone and other devices follow it.
onLanguageSave((language) => api.put('/settings', { language }).then((s) => useApp.setState({ settings: s })));

/** A module page (#/m/<module>/<path>/<params…>); pages that live under Instellingen are shown inside it. */
function modulePage(parts: string[]): React.ReactElement | null {
  const [, b, c] = parts;
  const mod = uiModules.find((m) => m.id === b);
  const page = mod?.pages?.find((p) => p.path === (c || '')) || (c ? mod?.pages?.find((p) => p.path === '') : mod?.pages?.[0]);
  if (!page) return null;
  const Comp = page.component;
  // Remaining path segments after the matched page path are params.
  const consumed = page.path ? page.path.split('/').length : 0;
  const el = <Comp key={parts.join('/')} params={parts.slice(2 + consumed)} />;
  const host = page.bare ? null : settingsHostOf(`${b}/${page.path}`);
  return host ? <SettingsFrame current={host}>{el}</SettingsFrame> : el;
}

function Routed({ parts }: { parts: string[] }) {
  const [a, b] = parts;
  if (!a) return <Home />;
  if (a === 't' && b) return <ChatView key={b} threadId={b} />;
  if (a === 'a' && b) return <AgentChatRoute key={b} agentId={b} />;
  if (a === 'agents' && !b)
    return (
      <SettingsFrame current="agents/">
        <AgentsPage />
      </SettingsFrame>
    );
  if (a === 'agents' && b) return <AgentEditor key={b} id={b} />;
  // First run: a ready first bot right after connecting AI, then "Koppel je telefoon" (pages/welcome/FirstBot.tsx).
  if (a === 'start') return <FirstBotPage />;
  if (a === 'settings') return <SettingsPage tab={b} />;
  if (a === 'inbox') return <InboxPage />;
  if (a === 'search') return <SearchPage />;
  // The phone's "Meer" tab; on the desktop the old link opens Instellingen.
  if (a === 'more') return <MorePage />;
  // Taken: the one task board at #/tasks (room_tasks and the team database in one view).
  if (a === 'tasks') return <TasksPage />;
  const el = a === 'm' && b ? modulePage(parts) : null;
  if (el) return el;
  return (
    <EmptyState title="Pagina niet gevonden" action={<Button onClick={() => (location.hash = '#/')}>Naar start</Button>}>
      Deze link bestaat niet (meer).
    </EmptyState>
  );
}

function OfflineBar() {
  const online = useApp((s) => s.online);
  if (online) return null;
  return (
    <div className="flex items-center justify-center gap-2 bg-warn-soft px-3 py-1.5 text-xs font-medium text-warn" role="status">
      <WifiOff className="h-3.5 w-3.5 shrink-0" /> Geen verbinding met TeamBot. Berichten worden niet live bijgewerkt; opnieuw verbinden…
    </div>
  );
}

/** Phone: the main destinations as bottom tabs, WhatsApp-style (how many: PHONE_TABS in shell/nav.tsx). */
function TabBar({ route }: { route: string[] }) {
  const approvals = useApp((s) => s.approvals.length) + useInboxExtraCount();
  const current = activePhoneTab(route);
  return (
    <nav className="safe-bottom flex shrink-0 border-t border-line bg-surface" aria-label="Hoofdmenu">
      {PHONE_TABS.map((id) => {
        const d = DESTINATIONS[id];
        const Icon = d.icon;
        const active = current === id;
        const badge = id === 'inbox' ? approvals : 0;
        return (
          <a
            key={id}
            href={d.href}
            aria-current={active ? 'page' : undefined}
            className={cx('relative flex min-h-[56px] min-w-0 flex-1 flex-col items-center justify-center gap-0.5 text-[11.5px] font-semibold', active ? 'text-fg' : 'text-muted')}
          >
            <span className={cx('relative flex h-7 w-14 items-center justify-center rounded-full', active && 'bg-surface-3')}>
              <Icon className="h-5 w-5" />
              {!!badge && (
                <span className="absolute -end-0.5 -top-1 flex h-[18px] min-w-[18px] items-center justify-center rounded-full bg-warn-strong px-1 text-[10.5px] font-bold text-warn-fg">
                  {badge}
                </span>
              )}
            </span>
            <span className="max-w-full truncate px-0.5">{d.label}</span>
          </a>
        );
      })}
    </nav>
  );
}

function Shell() {
  const parts = useRoute();
  const approvals = useApp((s) => s.approvals.length) + useInboxExtraCount();
  const desktop = useIsDesktop();
  useVisualViewportHeight();

  useEffect(() => {
    const f = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        // Desktop: the command palette over the current page; phone: the search page.
        if (window.matchMedia(DESK_QUERY).matches) openPalette();
        else location.hash = '#/search';
      }
    };
    window.addEventListener('keydown', f);
    return () => window.removeEventListener('keydown', f);
  }, []);

  useEffect(() => {
    document.title = approvals ? `(${approvals}) TeamBot` : 'TeamBot';
  }, [approvals]);

  const bare = parts[0] === 'm' && !!uiModules.find((m) => m.id === parts[1])?.pages?.find((p) => p.path === (parts[2] || ''))?.bare;
  // Desktop app: the taskbar badge counts what waits for you; small windows (status window) do not report.
  useDesktopBadge(!bare);
  // The user's accent colour (Instellingen › Uiterlijk), the same on every device.
  useAccentSync();
  // The phone opens on "Wacht op jou" when something waits, otherwise on Chats (0.4.5).
  usePhoneStart(!desktop && !bare, approvals);

  // A module page for a small desktop window (e.g. the floating status window): no sidebar or tab bar.
  if (bare) {
    return (
      <div className="h-full overflow-hidden">
        <Routed parts={parts} />
      </div>
    );
  }

  if (!desktop) {
    // Phone: list → full-screen chat (with its own back button); every other screen gets the bottom tabs.
    const inChat = parts[0] === 't' || parts[0] === 'a';
    return (
      <div className="safe-x flex h-full flex-col overflow-hidden">
        <SkipLink />
        <OfflineBar />
        <main id="inhoud" tabIndex={-1} className="relative min-h-0 flex-1 outline-none">
          <Routed parts={parts} />
        </main>
        {!inChat && <TabBar route={parts} />}
      </div>
    );
  }

  return (
    <div className="safe-x flex h-full overflow-hidden">
      <SkipLink />
      {/* The sidebar: a loose rounded panel, with a small gap to the edge of the window. */}
      <aside className="w-[300px] shrink-0 p-1.5 pe-0">
        <div className="h-full rounded-[18px] border border-line bg-surface [&>nav]:rounded-[18px]">
          <Sidebar route={parts} />
        </div>
      </aside>
      <main id="inhoud" tabIndex={-1} className="relative flex min-w-0 flex-1 flex-col outline-none">
        <OfflineBar />
        <div className="min-h-0 flex-1">
          <Routed parts={parts} />
        </div>
      </main>
      <CommandPalette />
    </div>
  );
}

/**
 * First Tab stop: "Naar de inhoud" jumps past the sidebar. In a chat it lands in the message box (the main action),
 * elsewhere at the start of the page. Not a hash link: the hash is the router.
 */
function SkipLink() {
  const go = (e: React.SyntheticEvent) => {
    e.preventDefault();
    const main = document.getElementById('inhoud');
    if (!main) return;
    const box = main.querySelector<HTMLElement>('textarea[aria-label="Bericht"]:not([disabled])');
    (box || main).focus();
  };
  return (
    <a
      href="#inhoud"
      onClick={go}
      className="sr-only z-50 rounded-lg bg-accent px-3 py-2 text-sm font-semibold text-accent-fg shadow-lg focus:not-sr-only focus:fixed focus:left-3 focus:top-3 focus:outline-2"
    >
      Naar de inhoud
    </a>
  );
}

export function App() {
  const [authed, setAuthed] = useState(!!getToken());
  const [ready, setReady] = useState(false);
  const [err, setErr] = useState('');
  // App lock (this device): nothing of the app is shown until it is unlocked; loading goes on behind it.
  const locked = useLock((s) => s.locked);
  useLockWatcher();

  useEffect(() => {
    if (!authed) return;
    let cleanups: (() => void)[] = [];
    // Cleaned up before the data came (signed out meanwhile, or React's development double start): the modules are
    // not started from this run, else their listeners would never be removed and every toast or notification came twice.
    let alive = true;
    wireEvents();
    connectWs();
    // The URL key (signed image/download/stream links) is there before the first page renders.
    Promise.all([useApp.getState().load(), ensureUrlKey()])
      .then(() => {
        if (!alive) return;
        const st = useApp.getState();
        // The user's language (chosen on any device) wins; without one this device's choice is stored for the user.
        if (syncLanguage(st.settings.language, { existingUser: st.agents.length > 0 || st.threads.length > 0 })) return;
        setReady(true);
        for (const m of uiModules) {
          try {
            const c = m.init?.();
            if (typeof c === 'function') cleanups.push(c);
          } catch (e) {
            console.error(`[module ${m.id}] init`, e);
          }
        }
      })
      .catch((e) => setErr(e.message));
    // Language changed on another device: follow it.
    cleanups.push(on('settings.updated', (s: any) => void (s?.language && syncLanguage(s.language))));
    cleanups.push(
      on('auth.lost', () => {
        disconnectWs();
        setToken(null);
        setReady(false);
        setAuthed(false);
      }),
    );
    // Toasts, sound and web notifications for `notification` events: the notifications module (respects the levels).
    if ('Notification' in window && Notification.permission === 'default') {
      const ask = () => {
        Notification.requestPermission().catch(() => {});
        window.removeEventListener('pointerdown', ask);
      };
      window.addEventListener('pointerdown', ask, { once: true });
    }
    return () => {
      alive = false;
      cleanups.forEach((c) => c());
    };
  }, [authed]);

  if (!authed)
    return (
      <>
        <AuthScreen onDone={() => setAuthed(true)} />
        <Toaster />
      </>
    );
  if (locked) return <LockScreen />;
  if (err)
    return (
      <EmptyState title="TeamBot kon niet laden" action={<Button onClick={() => location.reload()}>Opnieuw</Button>}>
        {err}
      </EmptyState>
    );
  if (!ready)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  return (
    <>
      <Shell />
      <Toaster />
      <LockConfirmHost />
    </>
  );
}
