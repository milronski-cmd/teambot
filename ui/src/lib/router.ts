import { useEffect, useState } from 'react';

/** Hash routes: #/t/<thread>, #/a/<agent>, #/agents/new, #/agents/<id>/edit, #/inbox, #/settings/<tab>, #/m/<module>/<page>, #/search */
export function parseHash(h = location.hash): string[] {
  return h.replace(/^#\/?/, '').split('?')[0].split('/').filter(Boolean).map(decodeURIComponent);
}

export function query(): URLSearchParams {
  return new URLSearchParams(location.hash.split('?')[1] || '');
}

/**
 * A page with unsaved changes (the bot editor) can hold a navigation: the guard sees the hashchange before the route
 * changes and returns false to keep the current page (it puts the old URL back itself and asks). One guard at a time.
 */
type LeaveGuard = (e: HashChangeEvent) => boolean;
let guard: LeaveGuard | null = null;
let decided: { e: Event; ok: boolean } | null = null;
export function setLeaveGuard(g: LeaveGuard): () => void {
  guard = g;
  return () => {
    if (guard === g) guard = null;
  };
}
/** Several route listeners see the same event: the guard decides once per event. */
function allowed(e: Event): boolean {
  if (!guard || !(e instanceof HashChangeEvent)) return true;
  if (decided?.e !== e) decided = { e, ok: guard(e) };
  return decided.ok;
}

export function useRoute(): string[] {
  const [parts, setParts] = useState(parseHash());
  useEffect(() => {
    const f = (e?: Event) => {
      if (e && !allowed(e)) return;
      setParts((cur) => {
        const next = parseHash();
        return next.join('/') === cur.join('/') ? cur : next;
      });
    };
    window.addEventListener('hashchange', f);
    // Child effects run before this one: a page that redirected with replaceState on its first render (Home,
    // AgentChatRoute) fired its hashchange before we listened, so sync once now.
    f();
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return parts;
}

/**
 * Go to `to`.
 * - `from`: only while the user is still on that page (its query, such as an open dialog, does not count). Code that
 *   moves the user once an answer arrives passes the page it started on (`location.hash` before the request): whoever
 *   went elsewhere in the meantime stays where they went.
 * - `replace`: in place of the current page, without a step in the history (a link that stands for another page, such
 *   as #/a/<bot> for that bot's chat).
 */
export function navigate(to: string, { from, replace }: { from?: string; replace?: boolean } = {}) {
  if (from !== undefined && parseHash().join('/') !== parseHash(from).join('/')) return;
  const h = to.startsWith('#') ? to : '#' + (to.startsWith('/') ? to : '/' + to);
  if (location.hash === h) return;
  if (!replace) {
    location.hash = h;
    return;
  }
  history.replaceState(null, '', h);
  dispatchEvent(new HashChangeEvent('hashchange'));
}
