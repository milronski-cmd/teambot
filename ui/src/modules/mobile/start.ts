import { useEffect, useRef } from 'react';

/** The chat list: `#/` (or no hash at all). Only from here the phone moves on by itself. */
const atRoot = () => /^#?\/?$/.test(location.hash);
/** What waits may still be loading right after the start (modules add their items): this long the start may move on. */
export const START_WINDOW_MS = 4000;
/** Back in the app after this long (the same three minutes as "away from the pc"): open on what waits again. */
export const BACK_AFTER_MS = 3 * 60_000;

function goInbox() {
  // Replace, not push: "opens on Wacht op jou", so Back does not first return to an empty chat list.
  location.replace(`${location.pathname}${location.search}#/inbox`);
}

/**
 * 0.4.5: the phone opens on "Wacht op jou" when something waits for you (a question, an approval, or another item of
 * Wacht op jou), otherwise on Chats. That happens at the start of the app and when you come back to it after a few
 * minutes, and only from the chat list: a chat, a page or a notification link you opened yourself stays where it is.
 * The iPhone app also gets `home: '#/inbox'` from GET /api/mobile/status (server/modules/mobile/status.ts).
 */
export function usePhoneStart(phone: boolean, waiting: number) {
  const opened = useRef(Date.now());
  const moved = useRef(false);
  const hiddenAt = useRef<number | null>(null);
  const waits = useRef(waiting);
  waits.current = waiting;

  // Someone went somewhere else themselves: the start is over.
  useEffect(() => {
    const f = () => {
      if (!atRoot()) moved.current = true;
    };
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);

  useEffect(() => {
    if (!phone || moved.current || waiting <= 0 || !atRoot() || Date.now() - opened.current > START_WINDOW_MS) return;
    moved.current = true;
    goInbox();
  }, [phone, waiting]);

  useEffect(() => {
    if (!phone) return;
    const f = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt.current = Date.now();
        return;
      }
      const since = hiddenAt.current;
      hiddenAt.current = null;
      if (since !== null && Date.now() - since >= BACK_AFTER_MS && waits.current > 0 && atRoot()) goInbox();
    };
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, [phone]);
}
