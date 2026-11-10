import type { Thread } from '../lib/types';

/** Per-device "last seen" marker per thread, used for unread dots. */
const KEY = 'tb_seen';
let seen: Record<string, string> = {};
try {
  seen = JSON.parse(localStorage.getItem(KEY) || '{}');
} catch {
  seen = {};
}

const listeners = new Set<() => void>();

// Another window of the app (the floating status window, a picture-in-picture window) marked a chat as seen.
if (typeof window !== 'undefined')
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    try {
      seen = JSON.parse(e.newValue || '{}');
    } catch {
      return;
    }
    for (const fn of listeners) fn();
  });

/** Called after a chat was marked as seen (e.g. to update the taskbar badge). Returns the unsubscribe function. */
export function onSeen(fn: () => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/**
 * A chat only counts as read once you could see it: while the page is hidden (the desktop window minimised or in the
 * tray, a background tab) the mark waits until the page is visible again, so the taskbar badge and the unread dots
 * also count the chat that happened to be open.
 */
const deferred = new Map<string, string>();
const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
if (typeof document !== 'undefined')
  document.addEventListener('visibilitychange', () => {
    if (hidden() || !deferred.size) return;
    const all = [...deferred];
    deferred.clear();
    for (const [id, iso] of all) markSeen(id, iso);
  });

export function markSeen(threadId: string, iso = new Date().toISOString()) {
  if ((seen[threadId] || '') >= iso) return;
  if (hidden()) {
    if ((deferred.get(threadId) || '') < iso) deferred.set(threadId, iso);
    return;
  }
  seen[threadId] = iso;
  try {
    localStorage.setItem(KEY, JSON.stringify(seen));
  } catch {
    /* ignore */
  }
  for (const fn of listeners) fn();
}

export function isUnread(t: Thread): boolean {
  if (!t.last || t.last.role === 'user') return false;
  const s = seen[t.id];
  if (!s) return Date.now() - Date.parse(t.updated_at) < 864e5; // new threads from the last day count as unread
  return t.updated_at > s;
}
