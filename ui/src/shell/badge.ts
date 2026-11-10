import { useEffect, useMemo, useRef, useState } from 'react';
import { useApp } from '../lib/store';
import { useInboxExtraCount } from '../modules';
import { isUnread, onSeen } from './unread';
import { unreadChats } from './badgeCount';

type BadgeBridge = { setBadge?: (c: { waiting: number; unread: number }) => void };
const bridge = (): BadgeBridge | null => (typeof window !== 'undefined' ? ((window as any).teambotDesktop as BadgeBridge) || null : null);

/**
 * Desktop app: tells the shell what waits for the owner, for the taskbar overlay (Windows), the dock count
 * (macOS/Linux) and the tray. "Wacht op jou" (approvals, questions, module items) plus unread chats; sent debounced
 * and only when it changed. Does nothing in a normal browser or the phone app.
 */
export function useDesktopBadge(enabled: boolean) {
  const desktop = !!bridge()?.setBadge;
  const waiting = useApp((s) => s.approvals.length) + useInboxExtraCount();
  const agents = useApp((s) => s.agents);
  const threads = useApp((s) => s.threads);
  const approvals = useApp((s) => s.approvals);
  const [tick, setTick] = useState(0);
  // Marking a chat as read, and time passing ("new" chats of the last day), change the count without a store change.
  useEffect(() => (desktop ? onSeen(() => setTick((x) => x + 1)) : undefined), [desktop]);
  useEffect(() => {
    if (!desktop) return;
    const t = setInterval(() => setTick((x) => x + 1), 60_000);
    return () => clearInterval(t);
  }, [desktop]);
  const unread = useMemo(() => (desktop ? unreadChats(agents, threads, approvals, isUnread) : 0), [desktop, agents, threads, approvals, tick]);
  const sent = useRef('');
  useEffect(() => {
    const b = bridge();
    if (!enabled || !b?.setBadge) return;
    const key = `${waiting}|${unread}`;
    if (key === sent.current) return;
    const t = setTimeout(() => {
      sent.current = key;
      b.setBadge!({ waiting, unread });
    }, 300);
    return () => clearTimeout(t);
  }, [enabled, waiting, unread]);
}
