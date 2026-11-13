import React, { useEffect, useState } from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { create } from 'zustand';
import { ArrowLeft, ExternalLink, X, Loader2 } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { translate, uiLocale } from '../lib/i18n';
import { useIsDesktop } from '../lib/media';
import { listTimeIn, shortAgo } from '../lib/format';
import { copyToClipboard } from '../lib/clipboard';
import { BotAvatar } from './BotFace';

/**
 * Shared UI primitives. Every page and module uses these so the app looks like one product: calm surfaces, one accent
 * colour (the user's, shell/accent.ts), rounded corners from one scale (styles.css: controls 8, cards 14, groups 16,
 * dialogs 24), 16/20 px icons, depth from borders and surface steps (a shadow only on what floats: menus, popovers,
 * toasts).
 */

export function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

/** Default width class unless the caller sets its own width (w-*), so className="w-auto" etc. actually works. */
const fullWidth = (className?: string) => (/(^|\s)(w-|max-w-|min-w-|flex-1)/.test(className || '') ? '' : 'w-full');

type BtnProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'soft';
  size?: 'sm' | 'md' | 'lg' | 'icon' | 'iconSm';
  loading?: boolean;
  icon?: React.ReactNode;
  /** The button element itself (a menu puts the focus back on the button that opened it). */
  ref?: React.Ref<HTMLButtonElement>;
};
export function Button({ variant = 'secondary', size = 'md', loading, icon, className, children, disabled, type, ...p }: BtnProps) {
  // Disabled: a primary button turns into a calm grey surface (a half-transparent accent was a glaring grey-white disc
  // in the dark theme, e.g. the send button of an empty chat bar); the others fade.
  const v = {
    primary: 'bg-btn text-btn-fg hover:opacity-90 disabled:bg-surface-3 disabled:text-muted disabled:hover:opacity-100',
    secondary: 'border border-line-strong bg-surface text-fg hover:bg-surface-2 disabled:opacity-45',
    ghost: 'text-muted hover:bg-surface-2 hover:text-fg disabled:opacity-45',
    danger: 'bg-danger text-danger-fg hover:opacity-90 disabled:opacity-45',
    soft: 'bg-surface-3 text-fg hover:bg-line disabled:opacity-45',
  }[variant];
  const s = {
    // On a touch screen every button is at least 44 px high (Apple/Google touch-target guidance; checklist A-26, A-87).
    sm: 'h-8 px-3 text-[13px] gap-1.5 coarse:h-11',
    md: 'h-9 px-3.5 text-sm gap-2 coarse:h-11',
    lg: 'h-11 px-5 text-[15px] gap-2',
    icon: 'h-9 w-9 justify-center coarse:h-11 coarse:w-11',
    // Small icon-only button (message toolbar). 'sm' + "h-7 w-7 p-0" kept px-3 (Tailwind v4 does not resolve conflicts
    // by class order), which squeezed the icon to 4 px.
    iconSm: 'h-7 w-7 justify-center coarse:h-11 coarse:w-11',
  }[size];
  // The control radius (8 px) unless the caller sets its own (rounded-full for a round send button): the same
  // reason as above, two radius classes do not resolve by order.
  const radius = /(^|\s)rounded(-|\s|$)/.test(className || '') ? '' : 'rounded-control';
  return (
    <button
      type={type}
      {...p}
      disabled={disabled || loading}
      className={cx('inline-flex shrink-0 select-none items-center font-medium transition-[background-color,opacity] disabled:cursor-not-allowed', v, s, radius, className)}
    >
      {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : icon}
      {children}
    </button>
  );
}

const control = 'rounded-control border border-line-strong bg-surface text-sm text-fg outline-none transition-colors placeholder:text-muted hover:border-line-strong focus:border-muted focus:bg-surface';

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(function Input({ className, ...p }, ref) {
  return <input ref={ref} {...p} className={cx('h-9 px-3 coarse:h-11', control, fullWidth(className), className)} />;
});

export const Textarea = React.forwardRef<HTMLTextAreaElement, React.TextareaHTMLAttributes<HTMLTextAreaElement>>(function Textarea({ className, ...p }, ref) {
  return <textarea ref={ref} {...p} className={cx('px-3 py-2 leading-relaxed', control, fullWidth(className), className)} />;
});

export function Select({ className, children, ...p }: React.SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...p} className={cx('h-9 px-2.5 coarse:h-11', control, fullWidth(className), className)}>
      {children}
    </select>
  );
}

export function Toggle({ checked, onChange, label, disabled }: { checked: boolean; onChange(v: boolean): void; label?: React.ReactNode; disabled?: boolean }) {
  // Disabled: the switch is dimmed, the label turns muted (still readable: AA contrast, which half opacity was not).
  return (
    <label className={cx('inline-flex items-center gap-2.5 text-sm', disabled ? 'text-muted' : 'cursor-pointer')}>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={disabled}
        onClick={() => onChange(!checked)}
        className={cx('relative h-[22px] w-[38px] shrink-0 rounded-full transition-colors disabled:opacity-50', checked ? 'bg-accent' : 'bg-line-strong')}
      >
        <span className={cx('absolute top-[3px] h-4 w-4 rounded-full shadow-sm transition-all', checked ? 'start-[19px] bg-accent-fg' : 'start-[3px] bg-surface')} />
      </button>
      {label}
    </label>
  );
}

const FORM_TAGS = new Set(['input', 'select', 'textarea']);
const FORM_COMPONENTS = new Set<any>();
/** Let <Field> bind its label to a custom control component (it must pass `id` and `aria-describedby` on). */
export const registerFormControl = (c: any) => void FORM_COMPONENTS.add(c);

/**
 * Label + control + hint. The label is a real <label for> bound to the first form control inside, and the hint is
 * linked via aria-describedby, so screen readers announce both (WCAG 1.3.1 / 4.1.2).
 */
export function Field({ label, hint, children, className }: { label: React.ReactNode; hint?: React.ReactNode; children: React.ReactNode; className?: string }) {
  const auto = React.useId();
  const hintId = hint ? `${auto}-hint` : undefined;
  let controlId: string | undefined;
  let bound = false;
  const kids = React.Children.map(children, (child) => {
    if (bound || !React.isValidElement(child)) return child;
    const isControl = (typeof child.type === 'string' && FORM_TAGS.has(child.type)) || FORM_COMPONENTS.has(child.type);
    if (!isControl) return child;
    bound = true;
    const props: any = child.props;
    controlId = props.id || auto;
    return React.cloneElement(child as React.ReactElement<any>, { id: controlId, 'aria-describedby': [props['aria-describedby'], hintId].filter(Boolean).join(' ') || undefined });
  });
  return (
    <div className={cx('space-y-1.5', className)}>
      {/* data-i18n="label": interface text, translated also when a bot has the same name (lib/i18n.ts). */}
      {bound ? (
        <label htmlFor={controlId} data-i18n="label" className="block text-[13px] font-semibold">
          {label}
        </label>
      ) : (
        <div data-i18n="label" className="text-[13px] font-semibold">
          {label}
        </div>
      )}
      {kids}
      {hint && (
        <div id={hintId} className="text-xs leading-relaxed text-muted">
          {hint}
        </div>
      )}
    </div>
  );
}

export function Card({ className, children, ...p }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...p} className={cx('rounded-card border border-line bg-surface', className)}>
      {children}
    </div>
  );
}

/**
 * The icon tiles (the settings list, every card head) have one quiet look: a grey tile with the icon in the muted text
 * colour. The tone names are still accepted from callers, but they all draw the same.
 */
export type Tone = 'orange' | 'violet' | 'teal' | 'blue' | 'rose' | 'amber' | 'neutral';
const TILE = 'bg-surface-3 text-muted';
export const TONE_TILE: Record<Tone, string> = { orange: TILE, violet: TILE, teal: TILE, blue: TILE, rose: TILE, amber: TILE, neutral: TILE };

/** The icon of a card, a row or a page. `sm` (a row of a menu) is the bare icon; the others sit in a quiet grey tile. Decorative. */
export function IconTile({ icon: Icon, tone = 'neutral', size = 'md', className }: { icon: LucideIcon; tone?: Tone; size?: 'sm' | 'md' | 'lg' | 'xl'; className?: string }) {
  // xl: the tile next to a page title (the same 40 px tile as the settings pages).
  return (
    <span className={cx('flex shrink-0 items-center justify-center', size === 'xl' ? 'size-10 rounded-xl' : 'rounded-lg', size === 'sm' ? 'size-5 text-muted' : size === 'lg' ? 'size-9' : size === 'xl' ? '' : 'size-8', size !== 'sm' && TONE_TILE[tone], className)} aria-hidden>
      <Icon className={size === 'sm' ? 'h-4 w-4' : size === 'lg' ? 'h-5 w-5' : size === 'xl' ? 'h-[22px] w-[22px]' : 'h-[18px] w-[18px]'} />
    </span>
  );
}

/**
 * The head of a card: the icon tile, the title and (optional) one short line under it and something on the right.
 * RULE: every card on a settings page starts with this (or with SettingsSection, which uses it), always with an icon,
 * so a page reads at a glance. `as` is the heading level (h2 on a page, h3 inside another section).
 */
export function CardHead({ icon, tone, title, hint, action, className, id, as: H = 'h2' }: { icon: LucideIcon; tone?: Tone; title: React.ReactNode; hint?: React.ReactNode; action?: React.ReactNode; className?: string; id?: string; as?: 'h2' | 'h3' }) {
  return (
    <div className={cx('flex flex-wrap items-center gap-x-3 gap-y-1', className)}>
      <IconTile icon={icon} tone={tone} />
      <div className="min-w-[min(100%,9rem)] flex-1">
        <H id={id} className="text-[15px] font-bold leading-snug tracking-tight [overflow-wrap:anywhere]">
          {title}
        </H>
        {hint && <p className="text-xs leading-relaxed text-muted">{hint}</p>}
      </div>
      {action}
    </div>
  );
}

/** Small section title inside a page or card (with `icon`: the same icon tile as a card head). */
export function SectionTitle({ children, action, className, icon, tone }: { children: React.ReactNode; action?: React.ReactNode; className?: string; icon?: LucideIcon; tone?: Tone }) {
  return (
    <div className={cx('flex flex-wrap items-center justify-between gap-x-3 gap-y-2', className)}>
      <div className="flex min-w-0 items-center gap-3">
        {icon && <IconTile icon={icon} tone={tone} />}
        <h2 className="text-[15px] font-bold leading-snug tracking-tight">{children}</h2>
      </div>
      {action}
    </div>
  );
}

export function Badge({ tone = 'neutral', children, className }: { tone?: 'neutral' | 'accent' | 'ok' | 'warn' | 'danger'; children: React.ReactNode; className?: string }) {
  const t = {
    neutral: 'bg-surface-3 text-muted',
    accent: 'bg-surface-3 text-fg',
    ok: 'bg-ok-soft text-ok',
    warn: 'bg-warn-soft text-warn',
    danger: 'bg-danger-soft text-danger',
  }[tone];
  return <span className={cx('inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2 py-0.5 text-[11.5px] font-semibold', t, className)}>{children}</span>;
}

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cx('h-4 w-4 animate-spin text-muted', className)} />;
}

export function EmptyState({ icon, art, title, children, action, compact }: { icon?: React.ReactNode; art?: React.ReactNode; title: string; children?: React.ReactNode; action?: React.ReactNode; /** Inside a card: less air around it. */ compact?: boolean }) {
  return (
    <div className={cx('flex flex-col items-center justify-center gap-3 text-center', compact ? 'px-4 py-6' : 'px-6 py-14')}>
      {art && <div className="mb-1">{art}</div>}
      {icon && !art && <div className="mb-1 flex h-12 w-12 items-center justify-center rounded-2xl bg-surface-2 text-muted [&_svg]:h-5 [&_svg]:w-5">{icon}</div>}
      <div className="text-base font-bold tracking-tight">{title}</div>
      {/* overflow-wrap: a long folder path in the text wraps instead of making the page scroll sideways on a phone. */}
      {children && <div className="max-w-sm text-sm leading-relaxed text-muted [overflow-wrap:anywhere]">{children}</div>}
      {action && <div className="mt-1">{action}</div>}
    </div>
  );
}

// ---- dialogs (Radix Dialog, MIT): focus stays inside, comes back afterwards, the page behind does not take part ----

/**
 * Radix hides everything outside an open dialog from screen readers (aria-hidden, marked with data-aria-hidden). Make
 * those parts inert too, so nothing there can be focused or clicked (and axe sees no focusable content inside
 * aria-hidden). Rendered inside the dialog content; Radix marks the page in an effect of a parent of this component,
 * which runs after this one, hence the microtask. Each dialog removes only the inert it added.
 */
function InertOutside() {
  useEffect(() => {
    let live = true;
    let mine: HTMLElement[] = [];
    queueMicrotask(() => {
      if (!live) return;
      mine = [...document.querySelectorAll<HTMLElement>('[data-aria-hidden="true"]')].filter((el) => !el.hasAttribute('inert'));
      for (const el of mine) el.setAttribute('inert', '');
    });
    return () => {
      live = false;
      mine.forEach((el) => el.removeAttribute('inert'));
    };
  }, []);
  return null;
}

/**
 * Where the focus goes when a dialog opens (a field with autoFocus keeps it): the first text field of the body; on a
 * touch screen, or without a field, the dialog itself, so a screen reader starts at the title and no keyboard pops up.
 */
function focusOnOpen(e: Event, body: HTMLElement | null, dialog: HTMLElement | null) {
  e.preventDefault();
  const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
  const field = touch ? null : body?.querySelector<HTMLElement>('input:not([type="hidden"]):not([disabled]):not([readonly]), textarea:not([disabled]):not([readonly]), select:not([disabled])');
  (field && field.getClientRects().length ? field : dialog)?.focus({ preventScroll: true });
}

/**
 * Focus back after closing: to the last element that had the focus and still exists. Mostly the button that opened the
 * dialog; when that was an item of a menu that has closed since, the button that opened the menu.
 */
let focusTrail: WeakRef<HTMLElement>[] | null = null;
function trackFocus() {
  if (focusTrail || typeof document === 'undefined') return;
  focusTrail = [];
  document.addEventListener(
    'focusin',
    (e) => {
      if (!(e.target instanceof HTMLElement) || e.target === document.body) return;
      focusTrail!.push(new WeakRef(e.target));
      if (focusTrail!.length > 30) focusTrail!.shift();
    },
    true,
  );
}
function returnFocus(e: Event) {
  e.preventDefault();
  for (let i = (focusTrail?.length || 0) - 1; i >= 0; i--) {
    const el = focusTrail![i].deref();
    if (!el || !el.isConnected || el.closest('[inert],[aria-hidden="true"]') || !el.getClientRects().length) continue;
    el.focus({ preventScroll: true });
    if (document.activeElement === el) return;
  }
}

/**
 * Escape: when the focus is inside the dialog, the dialog's own onKeyDown closes it, so a control inside that handles
 * Escape itself (stopPropagation) keeps the dialog open, and only the topmost of nested dialogs closes. Otherwise
 * Radix closes it (onOpenChange).
 */
function escapeInside(e: KeyboardEvent, dialog: HTMLElement | null) {
  if (dialog && e.target instanceof Node && dialog.contains(e.target)) e.preventDefault();
}

export function Modal({ open, onClose, title, children, footer, wide }: { open: boolean; onClose(): void; title: React.ReactNode; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean }) {
  const overlay = React.useRef<HTMLDivElement>(null);
  const dialog = React.useRef<HTMLDivElement>(null);
  const body = React.useRef<HTMLDivElement>(null);
  trackFocus();
  return (
    <DialogPrimitive.Root open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogPrimitive.Overlay ref={overlay} className="tb-overlay fixed inset-0 z-50 m-0 flex items-end justify-center bg-black/55 p-0 backdrop-blur-[2px] sm:items-center sm:p-4">
        <DialogPrimitive.Content
          ref={dialog}
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => focusOnOpen(e, body.current, dialog.current)}
          onCloseAutoFocus={returnFocus}
          onEscapeKeyDown={(e) => escapeInside(e, dialog.current)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
            e.stopPropagation();
            onClose();
          }}
          // Only a press on the dimmed backdrop closes it (not one on a toast).
          onPointerDownOutside={(e) => {
            if (!(e.target instanceof Node && overlay.current?.contains(e.target))) e.preventDefault();
          }}
          className={cx('safe-bottom flex max-h-[92vh] w-full flex-col rounded-t-dialog border border-line bg-surface outline-none sm:rounded-dialog', wide ? 'sm:max-w-3xl' : 'sm:max-w-lg')}
        >
          <div className="flex items-center justify-between gap-3 px-5 pb-1 pt-4">
            <InertOutside />
            <DialogPrimitive.Title asChild>
              <div className="min-w-0 text-base font-bold tracking-tight">{title}</div>
            </DialogPrimitive.Title>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Sluiten" className="-me-2">
              <X className="h-4 w-4" />
            </Button>
          </div>
          <div ref={body} className="scroll-thin overflow-y-auto px-5 py-3">
            {children}
          </div>
          {footer && <div className="flex flex-wrap justify-end gap-2 px-5 pb-4 pt-2">{footer}</div>}
        </DialogPrimitive.Content>
      </DialogPrimitive.Overlay>
    </DialogPrimitive.Root>
  );
}

export function Tabs<T extends string>({ tabs, value, onChange }: { tabs: { id: T; label: React.ReactNode }[]; value: T; onChange(v: T): void }) {
  return (
    <div className="scroll-thin -mx-1 flex gap-1 overflow-x-auto px-1 pb-1" role="tablist">
      {tabs.map((t) => (
        <button
          key={t.id}
          type="button"
          role="tab"
          aria-selected={value === t.id}
          onClick={() => onChange(t.id)}
          className={cx(
            'h-8 shrink-0 whitespace-nowrap rounded-full px-3.5 text-[13px] transition-colors coarse:h-11',
            value === t.id ? 'bg-surface-3 font-semibold text-fg' : 'font-medium text-muted hover:bg-surface-2 hover:text-fg',
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

/** Avatar for a person (initials) or an image. Bots use BotAvatar (their character); `face:` avatars are routed there. */
export function Avatar({ name, avatar, size = 32 }: { name: string; avatar?: string; color?: string; size?: number }) {
  if (avatar?.startsWith('face:')) return <BotAvatar bot={{ name, avatar }} size={size} />;
  const isImage = !!avatar && /^https?:|^data:image\/|^\/(?!\/)/.test(avatar);
  const isEmoji = !!avatar && !isImage;
  return (
    <div
      className="flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-surface-3 font-semibold text-fg"
      style={{ width: size, height: size, fontSize: size * (isEmoji ? 0.55 : 0.4) }}
      aria-hidden
    >
      {isImage ? <img src={avatar} alt="" className="h-full w-full object-cover" /> : isEmoji ? avatar : (name || '?').slice(0, 1).toUpperCase()}
    </div>
  );
}

const WIDTH = { xl: 'max-w-xl', '2xl': 'max-w-2xl', '3xl': 'max-w-3xl', '4xl': 'max-w-4xl', '5xl': 'max-w-5xl', '6xl': 'max-w-6xl', full: '' } as const;
export type PageWidth = keyof typeof WIDTH;

/** Page title area: big title, calm subtitle, actions on the right. `width` matches the page body below it. */
export function PageHeader({ title, subtitle, actions, back: given, width = '4xl', icon, tone }: { title: React.ReactNode; subtitle?: React.ReactNode; actions?: React.ReactNode; back?: { href: string; label: string }; width?: PageWidth; /** The page's icon tile, as on the settings pages. */ icon?: LucideIcon; tone?: Tone }) {
  // On the phone every page has a way back: a page that names none (Taken, Marktplaats, Automatisch … are reached from
  // the "Meer" tab there, and have no sidebar next to them) goes back to Meer. The tabs themselves need none.
  const desktop = useIsDesktop();
  const tabRoot = /^#?\/?(inbox|more|start)?\/?(\?.*)?$/.test(typeof location === 'undefined' ? '' : location.hash);
  const back = given || (!desktop && !tabRoot ? { href: '#/more', label: translate('Meer') } : undefined);
  return (
    <div className={cx('mx-auto px-4 pb-2 pt-5 sm:px-6 sm:pt-8', WIDTH[width])}>
      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="min-w-0">
          {back && (
            // The same round arrow as the way back in Instellingen (pages/Settings.tsx BackLink): one look for "back".
            <a href={back.href} className="group mb-2 inline-flex min-h-9 items-center gap-2 text-[13px] font-medium text-muted transition-colors hover:text-fg coarse:min-h-11">
              <span className="grid h-7 w-7 place-items-center rounded-full border border-line bg-surface transition-colors group-hover:border-fg/30">
                <ArrowLeft className="h-4 w-4 rtl-flip" aria-hidden />
              </span>
              {back.label}
            </a>
          )}
          <div className="flex items-center gap-3">
            {icon && <IconTile icon={icon} tone={tone} size="xl" />}
            <div className="min-w-0">
              <h1 className="text-xl font-bold leading-tight tracking-tight sm:text-[22px]">{title}</h1>
              {subtitle && <p className="mt-1 max-w-2xl text-[13px] leading-snug text-muted">{subtitle}</p>}
            </div>
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
    </div>
  );
}

/** Page body wrapper with consistent padding and scroll. */
export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cx('scroll-thin h-full overflow-y-auto pb-[calc(env(safe-area-inset-bottom)+1rem)]', className)}>{children}</div>;
}

// ---- toasts ----
interface Toast {
  id: number;
  text: string;
  tone: 'ok' | 'danger' | 'neutral';
}
const useToasts = create<{ list: Toast[] }>(() => ({ list: [] }));
let toastId = 0;
export function toast(text: string, tone: Toast['tone'] = 'neutral') {
  const id = ++toastId;
  useToasts.setState((s) => ({ list: [...s.list, { id, text, tone }] }));
  setTimeout(() => useToasts.setState((s) => ({ list: s.list.filter((t) => t.id !== id) })), 4500);
}
export function toastError(e: any) {
  // "This stays on the computer" (a paired phone, 403 mobile_denied) is a calm reason, not a red error.
  toast(e?.message || String(e), e?.code === 'mobile_denied' ? 'neutral' : 'danger');
}
/** Copy text (also over plain http on a phone) and say so ("Gekopieerd", or `ok`); when it cannot, say how by hand (`fail`). */
export async function copyText(text: string, ok = 'Gekopieerd', fail = 'Kopiëren lukt hier niet; selecteer de tekst en kopieer handmatig'): Promise<void> {
  if (await copyToClipboard(text)) toast(ok, 'ok');
  else toast(fail, 'danger');
}
/**
 * A toast that says something is running and is then replaced by its outcome: one message, not two (it stays until
 * `done`, then 4.5 s like any toast).
 */
export function toastProgress(text: string): { done(text: string, tone?: Toast['tone']): void } {
  const id = ++toastId;
  useToasts.setState((s) => ({ list: [...s.list, { id, text, tone: 'neutral' }] }));
  return {
    done(t, tone = 'neutral') {
      useToasts.setState((s) => ({ list: s.list.some((x) => x.id === id) ? s.list.map((x) => (x.id === id ? { ...x, text: t, tone } : x)) : [...s.list, { id, text: t, tone }] }));
      setTimeout(() => useToasts.setState((s) => ({ list: s.list.filter((x) => x.id !== id) })), 4500);
    },
  };
}
// ---- confirmations in the app's own style (never the browser's confirm()) ----
interface Ask {
  id: number;
  text: string;
  ok: string;
  danger: boolean;
  resolve(v: boolean): void;
}
const useAsk = create<{ cur: Ask | null }>(() => ({ cur: null }));
let askId = 0;
/**
 * Asks the user to confirm in an in-app dialog (role="alertdialog"); resolves true on "Doorgaan"/`ok`, false on
 * "Annuleren", Escape or a click outside. A new question replaces (and cancels) one that is still open.
 */
export function askConfirm(text: string, opts: { ok?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    useAsk.getState().cur?.resolve(false);
    useAsk.setState({ cur: { id: ++askId, text, ok: opts.ok || 'Doorgaan', danger: !!opts.danger, resolve } });
  });
}
function ConfirmHost() {
  const cur = useAsk((s) => s.cur);
  const overlay = React.useRef<HTMLDivElement>(null);
  const dialog = React.useRef<HTMLDivElement>(null);
  const done = React.useCallback((v: boolean) => {
    const c = useAsk.getState().cur;
    if (!c) return;
    useAsk.setState({ cur: null });
    c.resolve(v);
  }, []);
  trackFocus();
  return (
    <DialogPrimitive.Root open={!!cur} onOpenChange={(o) => !o && done(false)}>
      <DialogPrimitive.Overlay ref={overlay} className="tb-overlay fixed inset-0 z-[70] m-0 flex items-end justify-center bg-black/55 p-0 backdrop-blur-[2px] sm:items-center sm:p-4">
        {/* The question itself names the dialog (aria-labelledby), as before it described it. */}
        <DialogPrimitive.Content
          ref={dialog}
          role="alertdialog"
          aria-describedby={undefined}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            dialog.current?.querySelector<HTMLElement>("[data-confirm-ok]")?.focus({ preventScroll: true });
          }}
          onCloseAutoFocus={returnFocus}
          onEscapeKeyDown={(e) => escapeInside(e, dialog.current)}
          onKeyDown={(e) => {
            if (e.key !== 'Escape' || e.nativeEvent.isComposing) return;
            e.stopPropagation();
            done(false);
          }}
          onPointerDownOutside={(e) => {
            if (!(e.target instanceof Node && overlay.current?.contains(e.target))) e.preventDefault();
          }}
          className="w-full overflow-y-auto rounded-t-dialog border border-line bg-surface p-5 pb-[max(1.25rem,var(--safe-bottom))] outline-none sm:max-w-md sm:rounded-dialog"
        >
          {cur && (
            <>
              <InertOutside />
              <DialogPrimitive.Title asChild>
                <p className="whitespace-pre-wrap text-[15px] font-normal leading-relaxed">{cur.text}</p>
              </DialogPrimitive.Title>
              <div className="mt-5 flex flex-wrap justify-end gap-2">
                <Button onClick={() => done(false)}>Annuleren</Button>
                <Button data-confirm-ok variant={cur.danger ? 'danger' : 'primary'} onClick={() => done(true)}>
                  {cur.ok}
                </Button>
              </div>
            </>
          )}
        </DialogPrimitive.Content>
      </DialogPrimitive.Overlay>
    </DialogPrimitive.Root>
  );
}

export function Toaster() {
  const list = useToasts((s) => s.list);
  return (
    <>
    <ConfirmHost />
    <div className="pointer-events-none fixed bottom-[calc(env(safe-area-inset-bottom)+5rem)] left-1/2 z-[60] flex w-[min(92vw,440px)] -translate-x-1/2 flex-col items-center gap-2 desk:bottom-6" aria-live="polite">
      {list.map((t) => (
        <div
          key={t.id}
          // Light: a dark pill; dark: a raised surface with a border instead of a white slab.
          className={cx(
            'pointer-events-auto flex items-center gap-2 rounded-card px-4 py-2.5 text-sm font-medium shadow-pop',
            t.tone === 'danger' ? 'bg-danger text-danger-fg' : 'bg-fg text-canvas dark:border dark:border-line-strong dark:bg-surface-3 dark:text-fg',
          )}
        >
          {t.tone === 'ok' && <span className="h-2 w-2 shrink-0 rounded-full bg-ok" aria-hidden />}
          {t.text}
        </div>
      ))}
    </div>
    </>
  );
}

/** A link that opens in the browser, underlined, with the small "opens elsewhere" arrow. */
export function ExtLink({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <a className="inline-flex items-center gap-0.5 underline" href={href} target="_blank" rel="noreferrer">
      {children}
      <ExternalLink className="h-3 w-3 rtl-keep" aria-hidden />
    </a>
  );
}

/** Small async helper for buttons: runs fn, shows errors as toast. */
export function useAsync() {
  const [busy, setBusy] = useState(false);
  const run = async <T,>(fn: () => Promise<T>, ok?: string): Promise<T | undefined> => {
    setBusy(true);
    try {
      const r = await fn();
      if (ok) toast(ok, 'ok');
      return r;
    } catch (e) {
      toastError(e);
      return undefined;
    } finally {
      setBusy(false);
    }
  };
  return { busy, run };
}

/** Compact age: "zojuist", "5 min", "3 uur", "2 dagen", else the date — in the interface language (Intl). */
export function timeAgo(iso: string): string {
  return shortAgo(iso, Date.now(), uiLocale());
}

/** Chat-list style time: today → 14:05, yesterday → "gisteren", this week → weekday, else → 3 nov. */
export function listTime(iso: string): string {
  return listTimeIn(iso, Date.now(), uiLocale());
}

/** A day heading above messages or log rows: "Vandaag", "Gisteren", else the weekday and date (the year when it is another year). */
export function dayLabel(iso: string): string {
  const d = new Date(iso);
  const today = new Date();
  const y = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'Vandaag';
  if (d.toDateString() === y.toDateString()) return 'Gisteren';
  return d.toLocaleDateString(uiLocale(), { weekday: 'long', day: 'numeric', month: 'long', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

FORM_COMPONENTS.add(Input);
FORM_COMPONENTS.add(Textarea);
FORM_COMPONENTS.add(Select);
