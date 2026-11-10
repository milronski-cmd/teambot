import React, { useEffect, useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { cx } from './ui';

/**
 * Menus and popovers of the shell in one shape: a floating panel (16 px corners, a border, the one soft shadow) that
 * opens and closes with a short move (styles.css: tb-pop, 160 ms in, 120 ms out, none with reduced motion), rows of
 * 36 px (44 on a touch screen) with a 16 px icon, small group labels, and the destructive rows last behind a line.
 * A long menu keeps to about seven rows: what is used rarely goes into a submenu that takes the menu's place
 * (SubmenuRow / SubmenuHeader), which works the same with a mouse, the keyboard and a thumb.
 */

const EXIT_MS = 120;

/** True while `open`, and for the length of the exit animation after it. */
export function usePresence(open: boolean, ms = EXIT_MS): boolean {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) return setMounted(true);
    const timer = setTimeout(() => setMounted(false), ms);
    return () => clearTimeout(timer);
  }, [open, ms]);
  return open || mounted;
}

/**
 * Closes a menu or popover on a press outside `ref` and on Escape (which then puts the focus back on `returnTo`).
 * `ref` wraps both the button and the panel, so a press on the button is the button's own business.
 */
export function useDismiss(open: boolean, ref: React.RefObject<HTMLElement | null>, close: () => void, returnTo?: React.RefObject<HTMLElement | null>) {
  const closeRef = React.useRef(close);
  closeRef.current = close;
  useEffect(() => {
    if (!open) return;
    const away = (e: Event) => ref.current && !ref.current.contains(e.target as Node) && closeRef.current();
    const key = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      // Handled here: a dialog or page around the menu does not close as well.
      e.preventDefault();
      closeRef.current();
      returnTo?.current?.focus({ preventScroll: true });
    };
    document.addEventListener('mousedown', away);
    document.addEventListener('touchstart', away);
    document.addEventListener('keydown', key);
    return () => (document.removeEventListener('mousedown', away), document.removeEventListener('touchstart', away), document.removeEventListener('keydown', key));
  }, [open, ref, returnTo]);
}

type PopProps = React.HTMLAttributes<HTMLDivElement> & {
  open: boolean;
  /** Where it grows from: the corner of the button it belongs to. */
  origin?: 'top' | 'top left' | 'top right' | 'bottom' | 'bottom left' | 'bottom right';
};

/**
 * The floating panel itself: place it with classes (absolute, end-0, top-full …). It stays in the page for the exit
 * animation, hidden from screen readers and from the mouse and keyboard (inert) from the moment it closes.
 */
export const Pop = React.forwardRef<HTMLDivElement, PopProps>(function Pop({ open, origin = 'top', className, style, children, ...rest }, ref) {
  const show = usePresence(open);
  if (!show) return null;
  const up = origin.startsWith('bottom');
  return (
    <div
      ref={ref}
      {...rest}
      data-state={open ? 'open' : 'closed'}
      aria-hidden={open ? rest['aria-hidden'] : true}
      inert={!open}
      style={{ ['--tb-pop-origin' as any]: origin, ['--tb-pop-shift' as any]: up ? '4px' : '-4px', ...style }}
      className={cx('tb-pop border border-line bg-surface shadow-pop outline-none', /(^|\s)rounded-/.test(className || '') ? '' : 'rounded-card', className)}
    >
      {children}
    </div>
  );
});

/** Arrow keys, Home and End walk the rows of a menu (every focusable row inside the element with this handler). */
export function menuKeys(e: React.KeyboardEvent<HTMLElement>) {
  if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
  const rows = [...e.currentTarget.querySelectorAll<HTMLElement>('a[href], button:not([disabled])')].filter((el) => el.getClientRects().length);
  if (!rows.length) return;
  e.preventDefault();
  const i = rows.indexOf(document.activeElement as HTMLElement);
  const next = e.key === 'Home' ? 0 : e.key === 'End' ? rows.length - 1 : e.key === 'ArrowDown' ? (i + 1) % rows.length : (i - 1 + rows.length) % rows.length;
  rows[next].focus();
}

/** One row of a menu: 36 px (44 on touch), a 16 px icon in the muted colour, the label, and room for a hint at the end. */
export const menuRow =
  'flex min-h-9 w-full items-center gap-3 rounded-control px-2.5 py-1.5 text-start text-sm font-medium outline-none transition-colors hover:bg-surface-2 focus-visible:bg-surface-2 active:bg-surface-3 coarse:min-h-11 [&>svg]:size-icon [&>svg]:shrink-0 [&>svg]:text-muted';
/** A row that removes or wipes something: red, and its own red-tinted hover. */
export const menuRowDanger = cx(menuRow, 'text-danger hover:bg-danger-soft focus-visible:bg-danger-soft active:bg-danger-soft [&>svg]:text-danger');

/** The small heading of a group of rows ("Dit gesprek", "Deze bot"). */
export function MenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <div className="px-2.5 pb-1 pt-2 text-[12px] font-semibold text-muted" data-i18n="label">
      {children}
    </div>
  );
}

export function MenuSeparator() {
  return <div className="mx-1 my-1.5 h-px bg-line" role="separator" />;
}

/** The keyboard shortcut or another short hint at the end of a row. */
export function MenuHint({ children }: { children: React.ReactNode }) {
  return <span className="ms-auto ps-2 text-xs font-normal text-muted">{children}</span>;
}

/** A row that opens a submenu in the menu's place. */
export function SubmenuRow({ icon, children, onOpen }: { icon?: React.ReactNode; children: React.ReactNode; onOpen(): void }) {
  return (
    <button type="button" className={menuRow} aria-haspopup="true" onClick={onOpen} onKeyDown={(e) => e.key === 'ArrowRight' && (e.preventDefault(), onOpen())}>
      {icon}
      <span className="min-w-0 flex-1 truncate">{children}</span>
      <ChevronRight className="!text-muted" aria-hidden />
    </button>
  );
}

/** The first row of a submenu: back to the menu, with the submenu's name. */
export function SubmenuHeader({ children, onBack }: { children: React.ReactNode; onBack(): void }) {
  return (
    <>
      <button type="button" className={cx(menuRow, 'font-semibold')} data-submenu-back onClick={onBack}>
        <ChevronLeft aria-hidden />
        <span className="sr-only">Terug:</span>
        <span className="min-w-0 flex-1 truncate">{children}</span>
      </button>
      <MenuSeparator />
    </>
  );
}
