import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, ChevronDown, MoreHorizontal } from 'lucide-react';
import { Button, cx } from './ui';

/**
 * Parts the overview pages share (Taken, Geheugen, Marktplaats, Routines …), so they read as one calm product: a menu
 * behind "⋯" for what is rarely needed, a fold that opens to controls, placeholders while a list loads, and a quiet
 * row of links between pages that belong together. The motion lives in styles.css (tb-in, tb-pop, tb-fold, tb-skel).
 */

// ---------------------------------------------------------------- menu

export type MenuEntry =
  | { label: React.ReactNode; icon?: React.ReactNode; onSelect(): void; checked?: boolean; danger?: boolean; disabled?: boolean; href?: undefined }
  | { label: React.ReactNode; icon?: React.ReactNode; href: string; checked?: undefined; danger?: undefined; disabled?: boolean; onSelect?: undefined }
  | { heading: string }
  | 'sep'
  | false
  | null
  | undefined;

/**
 * A button that opens a small menu (role="menu"): arrow keys move, Escape closes and gives the focus back, a click
 * outside closes. The menu opens upwards when there is no room below. `checked` items form a choice (menuitemradio).
 */
export function Menu({
  label,
  items,
  icon,
  children,
  variant = 'ghost',
  size,
  align = 'end',
  className,
  testId,
}: {
  /** What the button is for; read out, and shown as its tooltip when the button is only an icon. */
  label: string;
  items: MenuEntry[];
  icon?: React.ReactNode;
  /** Text on the button; without it the button is the "⋯" icon. */
  children?: React.ReactNode;
  variant?: 'ghost' | 'secondary' | 'soft';
  size?: 'sm' | 'md' | 'icon' | 'iconSm';
  align?: 'start' | 'end';
  className?: string;
  testId?: string;
}) {
  const [open, setOpen] = useState(false);
  const [up, setUp] = useState(false);
  const box = useRef<HTMLDivElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (focus = true) => {
    setOpen(false);
    if (focus) box.current?.querySelector<HTMLElement>('button')?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (e.target instanceof Node && !box.current?.contains(e.target)) setOpen(false);
    };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  useLayoutEffect(() => {
    if (!open || !menu.current || !box.current) return;
    const b = box.current.getBoundingClientRect();
    const h = menu.current.offsetHeight;
    setUp(b.bottom + h + 12 > window.innerHeight && b.top - h - 12 > 0);
    menu.current.querySelector<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])')?.focus({ preventScroll: true });
  }, [open]);
  const key = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
      return;
    }
    const list = [...(menu.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]:not([aria-disabled="true"])') || [])];
    const at = list.indexOf(document.activeElement as HTMLElement);
    const to = e.key === 'ArrowDown' ? at + 1 : e.key === 'ArrowUp' ? at - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? list.length - 1 : null;
    if (to === null || !list.length) return;
    e.preventDefault();
    list[(to + list.length) % list.length].focus();
  };
  const row = 'flex min-h-9 w-full items-center gap-2.5 rounded-md px-2.5 py-1.5 text-start text-[13px] font-medium outline-none hover:bg-surface-2 focus-visible:bg-surface-2 coarse:min-h-11';
  return (
    <div ref={box} className={cx('relative shrink-0', className)} onKeyDown={open ? key : undefined}>
      <Button
        type="button"
        variant={variant}
        size={size || (children ? 'md' : 'icon')}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-label={children ? undefined : label}
        title={children ? undefined : label}
        data-testid={testId}
        icon={children ? icon : undefined}
        onClick={(e) => {
          e.stopPropagation();
          setOpen(!open);
        }}
      >
        {children ? (
          <>
            {children}
            <ChevronDown className={cx('h-3.5 w-3.5 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
          </>
        ) : (
          icon || <MoreHorizontal className="h-4 w-4" aria-hidden />
        )}
      </Button>
      {open && (
        <div
          ref={menu}
          role="menu"
          aria-label={label}
          className={cx('tb-pop absolute z-30 min-w-[12.5rem] max-w-[min(20rem,calc(100vw-2rem))] rounded-xl border border-line bg-surface p-1 shadow-pop', align === 'end' ? 'end-0' : 'start-0', up ? 'bottom-full mb-1' : 'top-full mt-1')}
          style={{ transformOrigin: `${up ? 'bottom' : 'top'} ${align === 'end' ? 'right' : 'left'}` }}
          onClick={(e) => e.stopPropagation()}
        >
          {items.map((it, i) => {
            if (!it) return null;
            if (it === 'sep') return <div key={i} role="separator" className="mx-1 my-1 border-t border-line" />;
            if ('heading' in it)
              return (
                <div key={i} data-i18n="label" className="px-2.5 pb-1 pt-1.5 text-[11.5px] font-semibold text-muted">
                  {it.heading}
                </div>
              );
            const inner = (
              <>
                {it.icon && <span className="flex h-4 w-4 shrink-0 items-center justify-center text-muted [&_svg]:h-4 [&_svg]:w-4">{it.icon}</span>}
                <span className="min-w-0 flex-1">{it.label}</span>
                {it.checked && <Check className="h-4 w-4 shrink-0" aria-hidden />}
              </>
            );
            if (it.href !== undefined)
              return (
                <a key={i} role="menuitem" data-i18n="label" href={it.href} className={row} onClick={() => close(false)}>
                  {inner}
                </a>
              );
            return (
              <button
                key={i}
                type="button"
                role={it.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={it.checked === undefined ? undefined : it.checked}
                aria-disabled={it.disabled || undefined}
                data-i18n="label"
                className={cx(row, it.danger && 'text-danger', it.disabled && 'cursor-not-allowed opacity-50')}
                onClick={() => {
                  if (it.disabled) return;
                  close();
                  it.onSelect();
                }}
              >
                {inner}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- fold

/**
 * A fold inside a page: one line you can open, and what opens is controls (never a block of prose). Slides open and
 * shut. `card` draws it as a card of its own (like "Meer opties"); without it, it is a quiet line inside a card.
 */
export function Fold({ title, hint, children, defaultOpen, card = true, className, testId, onOpen }: { title: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean; card?: boolean; className?: string; testId?: string; onOpen?(): void }) {
  const [open, setOpen] = useState(!!defaultOpen);
  // The content is only built once the fold has been opened (a closed fold loads nothing).
  const [seen, setSeen] = useState(!!defaultOpen);
  return (
    <details
      open={open}
      onToggle={(e) => {
        const o = e.currentTarget.open;
        setOpen(o);
        if (o && !seen) {
          setSeen(true);
          onOpen?.();
        }
      }}
      data-testid={testId}
      className={cx('tb-fold group', card && 'rounded-card border border-line bg-surface', className)}
    >
      <summary className={cx('flex min-h-11 cursor-pointer list-none items-center gap-2 text-sm font-semibold [&::-webkit-details-marker]:hidden', card ? 'rounded-card px-4 hover:bg-surface-2' : 'text-muted hover:text-fg')}>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted transition-transform duration-150 [details[open]>summary_&]:rotate-180" aria-hidden />
        <span className="min-w-0">{title}</span>
        {hint && <span className="ms-auto min-w-0 text-[13px] font-normal text-muted">{hint}</span>}
      </summary>
      <div className={cx('space-y-4', card ? 'border-t border-line p-4' : 'pb-1 pt-2')}>{seen && children}</div>
    </details>
  );
}

// ---------------------------------------------------------------- loading

/** One grey placeholder bar; give it a size with classes (h-4 w-1/2). */
export function Skeleton({ className }: { className?: string }) {
  return <div className={cx('tb-skel', className)} aria-hidden />;
}

/** Placeholder for a list of rows in a card, in the size the real rows will have (so nothing jumps when they arrive). */
export function SkeletonRows({ n = 4, avatar = true, className }: { n?: number; avatar?: boolean; className?: string }) {
  return (
    <div className={cx('divide-y divide-line rounded-card border border-line bg-surface', className)} role="status" aria-label="Laden">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="flex items-center gap-3 px-4 py-3.5">
          {avatar && <Skeleton className="h-8 w-8 shrink-0 rounded-full" />}
          <div className="min-w-0 flex-1 space-y-2">
            <Skeleton className={cx('h-3.5', i % 2 ? 'w-2/5' : 'w-1/2')} />
            <Skeleton className={cx('h-3', i % 2 ? 'w-3/4' : 'w-2/3')} />
          </div>
        </div>
      ))}
    </div>
  );
}

/** Placeholder for a grid of cards. */
export function SkeletonCards({ n = 6, className }: { n?: number; className?: string }) {
  return (
    <div className={cx('grid gap-3 sm:grid-cols-2 lg:grid-cols-3', className)} role="status" aria-label="Laden">
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="space-y-3 rounded-card border border-line bg-surface p-4">
          <Skeleton className="h-4 w-2/5" />
          <Skeleton className="h-3 w-11/12" />
          <Skeleton className="h-3 w-3/4" />
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------- links between pages that belong together

/**
 * Pages that belong together (Taken · Nu bezig · Routines · Logboek) as one row of pills: real links, so they can be
 * opened in a new window and found by a screen reader as navigation. `current` marks the page you are on.
 */
export function PageLinks({ label, items, className }: { label: string; items: ({ href: string; label: string; icon?: React.ReactNode; current?: boolean; count?: number } | false | null | undefined)[]; className?: string }) {
  return (
    <nav aria-label={label} className={cx('scroll-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1', className)}>
      {items.map(
        (it) =>
          it && (
            <a
              key={it.href}
              href={it.href}
              aria-current={it.current ? 'page' : undefined}
              data-i18n="label"
              className={cx(
                // On a phone the icons go, so four links fit the screen without scrolling sideways.
                'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full px-3 text-[13px] transition-colors coarse:h-10 sm:px-3.5 [&_svg]:hidden [&_svg]:h-3.5 [&_svg]:w-3.5 sm:[&_svg]:block',
                it.current ? 'bg-surface-3 font-semibold text-fg' : 'font-medium text-muted hover:bg-surface-2 hover:text-fg',
              )}
            >
              {it.icon}
              {it.label}
              {!!it.count && <span className="rounded-full bg-warn-soft px-1.5 text-[11.5px] font-semibold tabular-nums text-warn">{it.count}</span>}
            </a>
          ),
      )}
    </nav>
  );
}
