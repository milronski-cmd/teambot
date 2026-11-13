import { useId, useState } from 'react';
import { Info } from 'lucide-react';
import { cx } from './ui';

/**
 * "Meer informatie": a longer explanation stays out of sight until asked for (0.4.4, "het moet rustig blijven"). A box
 * shows a short title and at most one short line; the rest goes in here. Inline, so it fits after a hint or a line of
 * text; the explanation opens below it. With `block` it stands on its own line and may hold lists and paragraphs (the
 * settings pages, next to "Meer opties" in components/MoreOptions.tsx).
 */
export function MoreInfo({ children, label = 'Meer informatie', className, block }: { children: React.ReactNode; label?: string; className?: string; block?: boolean }) {
  const [open, setOpen] = useState(false);
  const id = useId();
  const Outer = block ? 'div' : 'span';
  const Inner = block ? 'div' : 'span';
  return (
    <Outer className={cx(block ? 'block' : 'inline', className)}>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        onClick={() => setOpen(!open)}
        className={cx("inline-flex items-center gap-1 rounded-md align-[-1px] text-xs font-medium text-muted underline-offset-2 hover:text-fg hover:underline focus-visible:outline focus-visible:outline-2 focus-visible:outline-accent coarse:min-h-11", !block && 'coarse:-my-3')}
      >
        <Info className="h-3.5 w-3.5 shrink-0" aria-hidden />
        {open ? 'Minder informatie' : label}
      </button>
      {open && (
        <Inner id={id} className={cx('mt-1 block text-xs leading-relaxed text-muted', block && 'space-y-1.5')}>
          {children}
        </Inner>
      )}
    </Outer>
  );
}
