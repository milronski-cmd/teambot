import React, { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown } from 'lucide-react';
import { cx, registerFormControl } from './ui';

export interface ListboxOption {
  value: string;
  /** Plain text: shown in the button and the list, and what typing a letter searches. */
  label: string;
  disabled?: boolean;
  /** A small title above the first option of a group ("Altijd in één taal"). */
  group?: string;
  /** For a name in its own language ("Deutsch"): pronounced right and never translated. */
  lang?: string;
  dir?: string;
  noTranslate?: boolean;
  /** Extra attributes on the option (e.g. data-accent-choice). */
  attrs?: Record<string, string>;
}

/**
 * TeamBot's own dropdown (instead of the system's <select>, which looks different on every computer): a button that
 * shows the choice and opens a list in the app's style. For keyboard and screen reader it is a "select-only combobox"
 * (WAI-ARIA): Enter, Space or the arrows open it, the arrows / Home / End / typing a letter move through the options,
 * Enter or Space chooses, Escape closes and keeps the old choice, Tab chooses and moves on. The focus stays on the
 * button (aria-activedescendant says which option is marked). The list floats above the page (also above a card that
 * cuts off its content) and opens upwards when there is no room below. Options carry `data-value`.
 */
export function Listbox({
  value,
  options,
  onChange,
  disabled,
  className,
  id,
  placeholder,
  'aria-label': ariaLabel,
  'aria-labelledby': ariaLabelledby,
  'aria-describedby': ariaDescribedby,
  'data-testid': testId,
  translate,
}: {
  value: string;
  options: ListboxOption[];
  onChange(v: string): void;
  disabled?: boolean;
  className?: string;
  id?: string;
  /** Shown when `value` is not one of the options. */
  placeholder?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'data-testid'?: string;
  translate?: 'no';
}) {
  const auto = useId();
  const listId = `${auto}-list`;
  const valueId = `${auto}-value`;
  const btn = useRef<HTMLButtonElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [pos, setPos] = useState({ left: 0, top: 0, bottom: 0, up: false, minWidth: 0, maxWidth: 0, maxHeight: 0 });
  // Inside a dialog the list lives in that dialog (the page behind a dialog cannot be clicked), else on the page.
  const [host, setHost] = useState<HTMLElement | null>(null);
  const typed = useRef({ text: '', at: 0 });
  const current = options.findIndex((o) => o.value === value);
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

  const place = () => {
    const b = btn.current?.getBoundingClientRect();
    if (!b) return;
    const below = window.innerHeight - b.bottom - 12;
    const above = b.top - 12;
    const up = below < 180 && above > below;
    setPos({ left: Math.max(8, Math.min(b.left, window.innerWidth - Math.max(b.width, 176) - 8)), top: b.top, bottom: b.bottom, up, minWidth: b.width, maxWidth: window.innerWidth - 16, maxHeight: Math.min(320, Math.max(120, up ? above : below)) });
  };
  const show = (at = current) => {
    if (disabled) return;
    place();
    setHost((btn.current?.closest('[role="dialog"]') as HTMLElement | null) || document.body);
    setActive(at >= 0 && !options[at]?.disabled ? at : (enabled[0] ?? -1));
    setOpen(true);
  };
  const close = () => setOpen(false);
  const choose = (i: number) => {
    const o = options[i];
    if (!o || o.disabled) return;
    close();
    if (o.value !== value) onChange(o.value);
  };

  // Open: follow the button when the page scrolls or the window changes, close on a click elsewhere.
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent | TouchEvent) => {
      const t = e.target as Node;
      if (!btn.current?.contains(t) && !list.current?.contains(t)) close();
    };
    const move = (e: Event) => (e.target instanceof Node && list.current?.contains(e.target) ? undefined : place());
    // Escape closes the list only, not the dialog or page around it (before anything else hears the key).
    const esc = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopPropagation();
      close();
    };
    window.addEventListener('keydown', esc, true);
    document.addEventListener('mousedown', away);
    document.addEventListener('touchstart', away);
    window.addEventListener('scroll', move, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('keydown', esc, true);
      document.removeEventListener('mousedown', away);
      document.removeEventListener('touchstart', away);
      window.removeEventListener('scroll', move, true);
      window.removeEventListener('resize', place);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Put the list under (or above) the button. Measured, so it also lands right inside a dialog that is moved with a
  // transform (there "fixed" counts from the dialog, not from the window).
  useLayoutEffect(() => {
    const el = list.current;
    if (!open || !el) return;
    el.style.transform = '';
    const r = el.getBoundingClientRect();
    const y = pos.up ? pos.top - 4 - r.height : pos.bottom + 4;
    el.style.transform = `translate(${Math.round(pos.left - r.left)}px, ${Math.round(y - r.top)}px)`;
  }, [open, pos, host, options.length]);
  // Keep the marked option in view.
  useLayoutEffect(() => {
    if (open && active >= 0) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [open, active]);

  const step = (d: 1 | -1) => {
    if (!enabled.length) return;
    const at = enabled.indexOf(active);
    setActive(enabled[Math.max(0, Math.min(enabled.length - 1, at < 0 ? (d > 0 ? 0 : enabled.length - 1) : at + d))]);
  };
  /** Typing letters jumps to the first option that starts with them (a closed dropdown chooses it, as a select does). */
  const typeAhead = (ch: string) => {
    const now = Date.now();
    const t = typed.current;
    t.text = now - t.at > 700 ? ch : t.text + ch;
    t.at = now;
    const from = open && t.text.length === 1 ? enabled.indexOf(active) + 1 : 0;
    const order = [...enabled.slice(from), ...enabled.slice(0, from)];
    const hit = order.find((i) => options[i].label.toLocaleLowerCase().startsWith(t.text.toLocaleLowerCase()));
    if (hit === undefined) return;
    if (open) setActive(hit);
    else if (options[hit].value !== value) onChange(options[hit].value);
  };
  const onKey = (e: React.KeyboardEvent) => {
    if (disabled || e.ctrlKey || e.metaKey || e.altKey) {
      if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && !open) (e.preventDefault(), show());
      return;
    }
    const k = e.key;
    if (!open) {
      if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') (e.preventDefault(), show());
      else if (k === 'Home' || k === 'End') (e.preventDefault(), show(k === 'Home' ? enabled[0] : enabled[enabled.length - 1]));
      else if (k.length === 1) typeAhead(k);
      return;
    }
    if (k === 'ArrowDown') (e.preventDefault(), step(1));
    else if (k === 'ArrowUp') (e.preventDefault(), step(-1));
    else if (k === 'Home') (e.preventDefault(), setActive(enabled[0] ?? -1));
    else if (k === 'End') (e.preventDefault(), setActive(enabled[enabled.length - 1] ?? -1));
    else if (k === 'PageDown') (e.preventDefault(), setActive(enabled[Math.min(enabled.length - 1, Math.max(0, enabled.indexOf(active)) + 8)] ?? -1));
    else if (k === 'PageUp') (e.preventDefault(), setActive(enabled[Math.max(0, enabled.indexOf(active) - 8)] ?? -1));
    else if (k === 'Enter' || k === ' ') (e.preventDefault(), choose(active));
    else if (k === 'Tab') choose(active);
    else if (k.length === 1) typeAhead(k);
  };

  const cur = options[current];
  return (
    <>
      <button
        ref={btn}
        id={id}
        type="button"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-activedescendant={open && active >= 0 ? `${auto}-o${active}` : undefined}
        aria-label={ariaLabel}
        // Named by its label, and the chosen value is read with it ("Taal van de app, Nederlands").
        aria-labelledby={ariaLabel ? undefined : ariaLabelledby ? `${ariaLabelledby} ${valueId}` : undefined}
        aria-describedby={ariaDescribedby}
        data-testid={testId}
        data-value={value}
        disabled={disabled}
        onClick={() => (open ? close() : show())}
        onKeyDown={onKey}
        onBlur={(e) => !list.current?.contains(e.relatedTarget as Node) && close()}
        className={cx(
          'inline-flex h-9 min-w-0 max-w-full items-center justify-between gap-2 rounded-control border border-line-strong bg-surface ps-3 pe-2 text-start text-sm text-fg outline-none transition-colors hover:border-line-strong focus-visible:border-muted disabled:cursor-not-allowed disabled:opacity-50 coarse:h-11',
          open && 'border-muted bg-surface',
          className && /(^|\s)(sm:)?(w-|min-w-|flex-1|basis-)/.test(className) ? '' : 'w-full',
          className,
        )}
      >
        <span id={valueId} className={cx('min-w-0 flex-1 truncate', !cur && 'text-muted')} lang={cur?.lang} dir={cur?.dir} translate={cur?.noTranslate || translate ? 'no' : undefined}>
          {cur ? cur.label : (placeholder ?? value)}
        </span>
        <ChevronDown className={cx('h-4 w-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
      </button>
      {open &&
        host &&
        createPortal(
          <ul
            ref={list}
            id={listId}
            role="listbox"
            aria-label={ariaLabel}
            aria-labelledby={ariaLabel ? undefined : ariaLabelledby}
            tabIndex={-1}
            style={{ position: 'fixed', left: 0, top: 0, minWidth: pos.minWidth, maxWidth: pos.maxWidth, maxHeight: pos.maxHeight }}
            className="scroll-thin z-[80] overflow-y-auto rounded-card border border-line-strong bg-surface p-1 shadow-pop"
            // The focus stays on the button.
            onMouseDown={(e) => e.preventDefault()}
          >
            {options.map((o, i) => (
              <React.Fragment key={o.value}>
                {o.group && o.group !== options[i - 1]?.group && (
                  <li role="presentation" className="px-2.5 pb-1 pt-2 text-[11.5px] font-semibold text-muted">
                    {o.group}
                  </li>
                )}
                <li
                  id={`${auto}-o${i}`}
                  role="option"
                  aria-selected={i === current}
                  aria-disabled={o.disabled || undefined}
                  data-index={i}
                  data-value={o.value}
                  lang={o.lang}
                  dir={o.dir}
                  translate={o.noTranslate || translate ? 'no' : undefined}
                  {...(o.attrs || {})}
                  onMouseEnter={() => !o.disabled && setActive(i)}
                  onClick={() => choose(i)}
                  className={cx(
                    'flex min-h-8 cursor-pointer items-center gap-2 rounded-control px-2.5 py-1.5 text-sm coarse:min-h-11',
                    o.disabled ? 'cursor-not-allowed text-muted opacity-60' : i === active ? 'bg-surface-3 text-fg' : 'text-fg',
                    i === current && 'font-semibold',
                  )}
                >
                  <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{o.label}</span>
                  {i === current && <Check className="h-4 w-4 shrink-0" aria-hidden />}
                </li>
              </React.Fragment>
            ))}
          </ul>,
          host,
        )}
    </>
  );
}
registerFormControl(Listbox);

/** The text of an <option>'s children ("Parakeet", " · ", 12 → "Parakeet · 12"). */
function optionText(node: React.ReactNode): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(optionText).join('');
  if (React.isValidElement(node)) return optionText((node.props as { children?: React.ReactNode }).children);
  return '';
}

/**
 * The Listbox for code written for a <select>: the same props (`value`, `onChange` with `e.target.value`) and
 * <option> / <optgroup> children. So a settings page gets TeamBot's own dropdown by changing one import.
 */
export function SelectBox({
  value,
  onChange,
  children,
  ...rest
}: {
  value?: string | number;
  onChange?(e: { target: { value: string } }): void;
  children?: React.ReactNode;
  disabled?: boolean;
  className?: string;
  id?: string;
  'aria-label'?: string;
  'aria-labelledby'?: string;
  'aria-describedby'?: string;
  'data-testid'?: string;
}) {
  const options: ListboxOption[] = [];
  const walk = (nodes: React.ReactNode, group?: string) =>
    React.Children.forEach(nodes, (c) => {
      if (!React.isValidElement(c)) return;
      const p = c.props as { value?: string | number; label?: string; disabled?: boolean; children?: React.ReactNode; translate?: string; lang?: string; dir?: string };
      if (c.type === 'optgroup') walk(p.children, p.label);
      else if (c.type === 'option') options.push({ value: String(p.value ?? optionText(p.children)), label: optionText(p.children).trim(), disabled: p.disabled, group, noTranslate: p.translate === 'no', lang: p.lang, dir: p.dir });
      else walk(p.children, group);
    });
  walk(children);
  return <Listbox {...rest} value={String(value ?? '')} options={options} onChange={(v) => onChange?.({ target: { value: v } })} />;
}
registerFormControl(SelectBox);
