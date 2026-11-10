import React, { createContext, useContext, useEffect, useId, useRef, useState } from 'react';
import { Check, RotateCcw } from 'lucide-react';
import { isRtl } from '../lib/i18n';
import { Button, Card, Toggle, cx, toast, toastError } from './ui';
import { Listbox } from './Listbox';
import { MoreInfo } from './MoreInfo';

/**
 * Settings controls (0.4.5, "meer keuzemenu's, heel simpel en duidelijk"). One way to show a setting everywhere:
 *  - on/off is a switch (SwitchRow, the Toggle of components/ui.tsx);
 *  - 2–4 options is a segmented control (Segmented);
 *  - more options is a dropdown (Dropdown); Choice picks between the two by the number of options;
 *  - a change saves at once: wrap the save in `useSave()` and the section shows a small "Opgeslagen";
 *  - per section "Standaard terugzetten" where there is a clear default (SettingsSection `onReset`).
 * A row has a short label and at most one short line; a longer explanation goes behind MoreInfo (`info`).
 */

// ---------------------------------------------------------------- saving

type Track = (p: Promise<unknown>) => Promise<boolean>;
const SaveContext = createContext<Track | null>(null);

/**
 * The "Opgeslagen" state of one section: shown for a moment after a save that succeeded. For a layout of its own: put
 * `<SavedNote shown={saved} />` where it belongs and save with `track(promise)`.
 */
export function useSavedFlag(): [boolean, Track] {
  const [saved, setSaved] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const track: Track = async (p) => {
    try {
      await p;
      setSaved(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setSaved(false), 2200);
      return true;
    } catch (e) {
      toastError(e);
      return false;
    }
  };
  return [saved, track];
}

/**
 * Save a change at once: `const save = useSave(); save(api.put(...))`. Inside a SettingsSection its header shows
 * "Opgeslagen" for a moment; elsewhere a short toast says so. Errors become an error toast; resolves true on success.
 */
export function useSave(): Track {
  const ctx = useContext(SaveContext);
  return (
    ctx ||
    (async (p) => {
      try {
        await p;
        toast('Opgeslagen', 'ok');
        return true;
      } catch (e) {
        toastError(e);
        return false;
      }
    })
  );
}

/** The small "Opgeslagen" with a tick; always in the page (aria-live), visible only right after a save. */
export function SavedNote({ shown, className }: { shown: boolean; className?: string }) {
  return (
    <span role="status" aria-live="polite" className={cx('inline-flex min-w-0 items-center gap-1 text-xs font-medium text-ok', className)} data-testid="saved-note">
      {shown && (
        <>
          <Check className="h-3.5 w-3.5 shrink-0" aria-hidden />
          Opgeslagen
        </>
      )}
    </span>
  );
}

// ---------------------------------------------------------------- section and rows

/**
 * A settings section: a card with a short title, the "Opgeslagen" note and (optional) "Standaard terugzetten", then
 * its rows. `onReset` puts the section's settings back to their defaults (saved at once); `isDefault` hides nothing but
 * disables the button when there is nothing to reset.
 */
export function SettingsSection({
  title,
  icon,
  hint,
  info,
  onReset,
  isDefault,
  actions,
  children,
  className,
  id,
  ...rest
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  hint?: React.ReactNode;
  info?: React.ReactNode;
  onReset?: () => Promise<unknown> | void;
  isDefault?: boolean;
  actions?: React.ReactNode;
  children?: React.ReactNode;
  className?: string;
  id?: string;
} & Omit<React.HTMLAttributes<HTMLElement>, 'title'>) {
  const auto = useId();
  const titleId = `${auto}-title`;
  const [saved, track] = useSavedFlag();
  const [busy, setBusy] = useState(false);
  const reset = async () => {
    if (!onReset) return;
    setBusy(true);
    try {
      await track(Promise.resolve(onReset()));
    } finally {
      setBusy(false);
    }
  };
  return (
    <SaveContext.Provider value={track}>
      <Card className={cx('px-5 pb-2 pt-4', className)} id={id} {...(rest as React.HTMLAttributes<HTMLDivElement>)}>
        <section aria-labelledby={titleId}>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <h2 id={titleId} className="flex min-w-0 flex-1 items-center gap-2 text-[15px] font-bold tracking-tight">
              {icon && <span className="shrink-0 text-muted [&_svg]:h-4 [&_svg]:w-4" aria-hidden>{icon}</span>}
              <span className="min-w-0">{title}</span>
            </h2>
            <SavedNote shown={saved} />
            {actions}
            {onReset && (
              <Button size="sm" variant="ghost" className="-me-2" icon={<RotateCcw className="h-3.5 w-3.5" aria-hidden />} loading={busy} disabled={isDefault} onClick={reset} data-testid="reset-defaults">
                Standaard terugzetten
              </Button>
            )}
          </div>
          {(hint || info) && (
            <p className="mt-0.5 text-xs leading-relaxed text-muted">
              {hint}
              {hint && info ? ' ' : ''}
              {info && <MoreInfo>{info}</MoreInfo>}
            </p>
          )}
          <div className="mt-1 divide-y divide-line">{children}</div>
        </section>
      </Card>
    </SaveContext.Provider>
  );
}

const RowContext = createContext<{ labelId: string; hintId?: string } | null>(null);

/** The label and hint of the row a control is in (Segmented and Dropdown use it for their accessible name). */
export const useRowLabel = () => useContext(RowContext);

/**
 * One setting: a short label (and at most one short line) on the start side, the control on the end side. On a narrow
 * screen the control moves under the label. `info` is the longer explanation, behind "Meer informatie".
 */
export function SettingRow({ label, hint, info, children, stack, className, testId }: { label: React.ReactNode; hint?: React.ReactNode; info?: React.ReactNode; children?: React.ReactNode; stack?: boolean; className?: string; testId?: string }) {
  const auto = useId();
  const labelId = `${auto}-label`;
  const hintId = hint ? `${auto}-hint` : undefined;
  return (
    <RowContext.Provider value={{ labelId, hintId }}>
      <div className={cx('flex flex-wrap items-center justify-between gap-x-4 gap-y-2 py-3', stack && 'flex-col items-stretch', className)} data-testid={testId}>
        <div className={cx('min-w-0', !stack && 'flex-1 basis-56')}>
          <div id={labelId} data-i18n="label" className="text-sm font-medium">
            {label}
          </div>
          {hint && (
            <div id={hintId} className="text-xs leading-relaxed text-muted">
              {hint}
            </div>
          )}
          {info && <MoreInfo className="block">{info}</MoreInfo>}
        </div>
        {children !== undefined && <div className={cx('min-w-0', stack ? 'w-full' : 'max-w-full shrink-0')}>{children}</div>}
      </div>
    </RowContext.Provider>
  );
}

/** An on/off setting: label (and one line) with a switch. Clicking the label flips it too. */
export function SwitchRow({ label, hint, info, checked, onChange, disabled, testId }: { label: string; hint?: React.ReactNode; info?: React.ReactNode; checked: boolean; onChange(v: boolean): void; disabled?: boolean; testId?: string }) {
  return (
    <div className="flex items-center justify-between gap-4 py-3" data-testid={testId}>
      <div className="min-w-0 flex-1">
        {/* The switch carries the same label for screen readers; this copy is for the eye and the mouse. */}
        <div aria-hidden onClick={() => !disabled && onChange(!checked)} className={cx('text-sm font-medium', disabled ? 'text-muted' : 'cursor-pointer')}>
          {label}
        </div>
        {hint && <div className="text-xs leading-relaxed text-muted">{hint}</div>}
        {info && <MoreInfo className="block">{info}</MoreInfo>}
      </div>
      <Toggle checked={checked} onChange={onChange} disabled={disabled} label={<span className="sr-only">{label}</span>} />
    </div>
  );
}

// ---------------------------------------------------------------- choosing

export interface ChoiceOption<T extends string> {
  value: T;
  label: React.ReactNode;
  /** Plain text of the label, for a dropdown and for screen readers when the label is not text. */
  text?: string;
  icon?: React.ReactNode;
  disabled?: boolean;
  /** Extra attributes on the option (e.g. data-accent-choice). */
  attrs?: Record<string, string>;
}

/**
 * A segmented control for 2–4 options: a radiogroup, the arrow keys move the choice (mirrored right-to-left), one tab
 * stop. Named by `label`, else by the row it is in.
 */
export function Segmented<T extends string>({ value, options, onChange, label, disabled, size = 'md', className, testId }: { value: T; options: ChoiceOption<T>[]; onChange(v: T): void; label?: string; disabled?: boolean; size?: 'sm' | 'md'; className?: string; testId?: string }) {
  const row = useRowLabel();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const enabled = options.map((o, i) => (o.disabled || disabled ? -1 : i)).filter((i) => i >= 0);
  const move = (e: React.KeyboardEvent, i: number) => {
    const next = isRtl() ? 'ArrowLeft' : 'ArrowRight';
    const prev = isRtl() ? 'ArrowRight' : 'ArrowLeft';
    const d = e.key === next || e.key === 'ArrowDown' ? 1 : e.key === prev || e.key === 'ArrowUp' ? -1 : 0;
    if (!d || !enabled.length) return;
    e.preventDefault();
    const at = enabled.indexOf(i);
    const n = enabled[(at + d + enabled.length) % enabled.length];
    if (options[n].value !== value) onChange(options[n].value);
    refs.current[n]?.focus();
  };
  const selected = options.some((o) => o.value === value);
  return (
    <div
      role="radiogroup"
      aria-label={label}
      aria-labelledby={label ? undefined : row?.labelId}
      aria-describedby={row?.hintId}
      data-testid={testId}
      className={cx('inline-flex max-w-full shrink-0 flex-wrap rounded-full bg-surface-2 p-0.5', disabled && 'opacity-50', className)}
    >
      {options.map((o, i) => {
        const on = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => {
              refs.current[i] = el;
            }}
            type="button"
            role="radio"
            aria-checked={on}
            aria-label={o.text && typeof o.label !== 'string' ? o.text : undefined}
            tabIndex={on || (!selected && i === enabled[0]) ? 0 : -1}
            disabled={disabled || o.disabled}
            onClick={() => !on && onChange(o.value)}
            onKeyDown={(e) => move(e, i)}
            {...(o.attrs || {})}
            className={cx(
              'inline-flex items-center justify-center gap-1.5 whitespace-nowrap rounded-full disabled:cursor-not-allowed',
              size === 'sm' ? 'h-7 px-2.5 text-[12.5px] coarse:h-9' : 'h-8 px-3.5 text-[13px] coarse:h-10',
              // The chosen option is a raised pill: white on the grey track, and lighter than the track in dark mode.
              on ? 'bg-surface font-semibold text-fg shadow-sm dark:bg-line-strong' : 'font-medium text-muted hover:text-fg',
            )}
          >
            {o.icon}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** A dropdown for more than four options (TeamBot's own: components/Listbox.tsx). Named by `label`, else by the row it is in. */
export function Dropdown<T extends string>({ value, options, onChange, label, disabled, className, testId, placeholder, id }: { value: T; options: ChoiceOption<T>[]; onChange(v: T): void; label?: string; disabled?: boolean; className?: string; testId?: string; placeholder?: string; id?: string }) {
  const row = useRowLabel();
  return (
    <Listbox
      id={id}
      value={value}
      disabled={disabled}
      aria-label={label}
      aria-labelledby={label ? undefined : row?.labelId}
      aria-describedby={row?.hintId}
      data-testid={testId}
      placeholder={placeholder}
      onChange={(v) => onChange(v as T)}
      options={options.map((o) => ({ value: o.value, label: o.text ?? (typeof o.label === 'string' ? o.label : o.value), disabled: o.disabled, attrs: o.attrs }))}
      className={cx('min-w-[12rem] max-w-full sm:w-auto', className)}
    />
  );
}

/** 2–4 options: a segmented control; more: a dropdown. */
export function Choice<T extends string>(p: { value: T; options: ChoiceOption<T>[]; onChange(v: T): void; label?: string; disabled?: boolean; className?: string; testId?: string }) {
  return p.options.length <= 4 ? <Segmented {...p} /> : <Dropdown {...p} />;
}
