import { useEffect, useState } from 'react';

/** Phone layout below this width (WhatsApp-style: list → full-screen chat, bottom tabs). Matches the `desk:` breakpoint. */
export const DESK_QUERY = '(min-width: 760px)';

export function useMedia(query: string): boolean {
  const [match, setMatch] = useState(() => (typeof window !== 'undefined' ? window.matchMedia(query).matches : true));
  useEffect(() => {
    const mq = window.matchMedia(query);
    const f = () => setMatch(mq.matches);
    f();
    mq.addEventListener('change', f);
    return () => mq.removeEventListener('change', f);
  }, [query]);
  return match;
}

export const useIsDesktop = () => useMedia(DESK_QUERY);

/**
 * iOS Safari keeps the layout viewport when the on-screen keyboard opens, so a bottom composer would hide behind it.
 * Follow the visual viewport's height in --app-h (Android/Chrome already resizes thanks to interactive-widget).
 * The keyboard can also move the visible part down (visualViewport.offsetTop: the iPhone app's web view scrolls the
 * page up to reveal the field). The app then sits exactly on the visible part (--vv-top, styles.css): shrinking it
 * and being scrolled up as well put the composer in the middle of the screen (owner, 0.4.3).
 *
 * The app only follows; it never scrolls the page itself while the keyboard is open. It used to call
 * window.scrollTo(0, 0) on every resize and scroll event of the visual viewport, also when nothing had changed, and
 * in the same breath placed itself on the offsetTop of before that scroll: two ways of doing the same thing that can
 * work against each other and against the web view's own reveal scroll (owner, 0.4.4: typing behaves strangely).
 * Now: one update per frame, and only when the height or the offset really changed.
 */
export function useVisualViewportHeight() {
  useEffect(() => {
    const vv = window.visualViewport;
    const root = document.getElementById('root');
    if (!vv || !root) return;
    const html = document.documentElement;
    /** What is applied now: "<height>:<top>" while the keyboard is open, '' otherwise. */
    let applied = '';
    let frame = 0;
    const apply = () => {
      frame = 0;
      // In layout pixels: a pinch-zoom (scale > 1) shrinks the visual viewport too, but is not a keyboard.
      const h = Math.round(vv.height * (vv.scale || 1));
      // Only when the keyboard actually shrinks the view; otherwise let CSS (100%) decide.
      const keyboard = window.innerHeight - h > 80;
      const top = keyboard ? Math.max(0, Math.round(vv.offsetTop || 0)) : 0;
      const next = keyboard ? `${h}:${top}` : '';
      if (next === applied) return;
      const wasOpen = !!applied;
      applied = next;
      // .tb-keyboard: for dialogs and sheets (styles.css: .tb-keyboard .tb-overlay) and the safe area under the composer.
      html.classList.toggle('tb-keyboard', keyboard);
      if (keyboard) {
        root.style.setProperty('--app-h', `${h}px`);
        html.style.setProperty('--vv-h', `${h}px`);
        html.style.setProperty('--vv-top', `${top}px`);
        // The app just got smaller: a field lower on a page (a form, a tall dialog) may now lie behind the keyboard,
        // and the web view does not reveal it again by itself until the first letter is typed.
        const el = document.activeElement;
        if (el instanceof HTMLElement && el.matches('input, textarea, select, [contenteditable]')) {
          const r = el.getBoundingClientRect();
          if (r.bottom > top + h || r.top < top) el.scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      root.style.removeProperty('--app-h');
      html.style.removeProperty('--vv-h');
      html.style.removeProperty('--vv-top');
      // The keyboard is gone. A page that was left scrolled (older iOS web views do that) goes back once, here only:
      // never while typing.
      if (wasOpen && (window.scrollY > 0 || window.scrollX > 0)) window.scrollTo(0, 0);
    };
    // The events come in bursts (the keyboard sliding in, the suggestion bar changing height, the reveal scroll):
    // read the end state once, in the next frame.
    const f = () => {
      if (!frame) frame = requestAnimationFrame(apply);
    };
    vv.addEventListener('resize', f);
    // offsetTop changes without a resize (the reveal scroll comes after the keyboard): follow it too.
    vv.addEventListener('scroll', f);
    return () => {
      vv.removeEventListener('resize', f);
      vv.removeEventListener('scroll', f);
      if (frame) cancelAnimationFrame(frame);
      root.style.removeProperty('--app-h');
      html.classList.remove('tb-keyboard');
      html.style.removeProperty('--vv-h');
      html.style.removeProperty('--vv-top');
    };
  }, []);
}
