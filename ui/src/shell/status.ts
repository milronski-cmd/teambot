import { useEffect, useState } from 'react';
import { useApp } from '../lib/store';
import { useInboxExtraCount } from '../modules';
import { useUsage } from '../modules/usage/api';

/**
 * The state of the whole thing in a few numbers, shared by the menu bar at the top of the app (shell/TopBar.tsx) and
 * the dashboard's widgets: the bots at work, what waits for you, the fullest usage window, and the time.
 */

/** The time on this computer, to the minute. */
export function useClock(): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = window.setInterval(() => setNow(new Date()), 20_000);
    return () => window.clearInterval(id);
  }, []);
  return now;
}

/** Every bot, and the ones with a turn that runs or waits in line. */
export function useBusy() {
  const agents = useApp((s) => s.agents);
  const runs = useApp((s) => s.runs);
  return { agents, busy: agents.filter((a) => runs.some((r) => r.agent_id === a.id && (r.status === 'running' || r.status === 'queued'))) };
}

/** What waits for you: approvals and decisions, and what the modules count (useInboxExtraCount). */
export function useWaiting(): number {
  return useApp((s) => s.approvals).length + useInboxExtraCount();
}

/** The fullest window of the AI subscriptions in use (one ring says whether there is room to work), or null. */
export function useWorstUsage() {
  const engines = useUsage((s) => s.engines);
  const loadUsage = useUsage((s) => s.load);
  useEffect(() => {
    if (engines === null) void loadUsage().catch(() => {});
  }, []);
  return (engines || []).filter((e) => e.enabled && e.worst && typeof e.worst.usedPercent === 'number').sort((a, b) => (b.worst!.usedPercent || 0) - (a.worst!.usedPercent || 0))[0]?.worst || null;
}
