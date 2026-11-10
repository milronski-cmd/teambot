import { useEffect, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import type { ReactNode } from 'react';
import { query } from '../lib/router';

/**
 * Settings pages, 0.4.4 ("het moet simpel zijn"): the two to four things people change sit on top; everything else
 * goes into ONE "Meer opties" fold at the bottom of the page. Folded, never removed: Ctrl+K and deep links still work,
 * and a link with `?meer=1` (e.g. "Aanpassen" at the daily budget) opens the fold right away. A longer explanation of
 * one box goes behind "Meer informatie" (components/MoreInfo.tsx).
 */
export function MoreOptions({ children, label = 'Meer opties', defaultOpen }: { children: ReactNode; label?: string; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(() => !!defaultOpen || query().has('meer'));
  useEffect(() => {
    if (defaultOpen) setOpen(true);
  }, [defaultOpen]);
  // Also when the link leads to the page that is already open.
  useEffect(() => {
    const f = () => query().has('meer') && setOpen(true);
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return (
    <details open={open} onToggle={(e) => setOpen(e.currentTarget.open)} className="group rounded-card border border-line bg-surface" data-testid="more-options">
      <summary className="flex min-h-11 cursor-pointer list-none items-center gap-2 rounded-card px-4 text-sm font-semibold transition-colors hover:bg-surface-2 [&::-webkit-details-marker]:hidden">
        <ChevronDown className="h-4 w-4 shrink-0 text-muted transition-transform [details[open]>summary_&]:rotate-180" aria-hidden />
        {label}
      </summary>
      <div className="space-y-4 border-t border-line p-4">{children}</div>
    </details>
  );
}
