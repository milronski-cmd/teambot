import { Info, TriangleAlert } from 'lucide-react';
import { Button, cx } from '../../components/ui';
import type { Attention } from './api';

/** Small building blocks of the import page. */

export function Check({ checked, onChange, disabled, label }: { checked: boolean; onChange(v: boolean): void; disabled?: boolean; label: string }) {
  return <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)] disabled:opacity-40" />;
}

export function AttentionList({ items }: { items: Attention[] }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-1.5">
      {items.map((a, i) => (
        <li key={i} className={cx('flex items-start gap-2 rounded-lg px-3 py-2 text-sm', a.level === 'warn' ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-muted')}>
          {a.level === 'warn' ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" />}
          <span className={a.level === 'warn' ? 'text-fg' : ''}>{a.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function Section({ icon, title, count, children, actions }: { icon: React.ReactNode; title: string; count?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-accent">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
        {count && <span className="text-xs text-muted">{count}</span>}
        {actions && <div className="ms-auto flex gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function AllNone({ onAll, onNone }: { onAll(): void; onNone(): void }) {
  return (
    <>
      <Button size="sm" variant="ghost" onClick={onAll}>
        Alles
      </Button>
      <Button size="sm" variant="ghost" onClick={onNone}>
        Niets
      </Button>
    </>
  );
}
