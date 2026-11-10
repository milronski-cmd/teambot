import { useMemo } from 'react';
import { cx } from '../components/ui';
import { diffStats, lineDiff } from './textDiff';

/**
 * A readable before/after of one text: removed words struck through in red, added words in green, unchanged lines
 * dimmed and long unchanged parts folded. Colour is never the only signal: removed/added text is also marked for
 * screen readers and with − / + at the start of whole lines.
 */
export function DiffView({ before, after, label, className }: { before: string; after: string; label?: string; className?: string }) {
  const lines = useMemo(() => lineDiff(before || '', after || ''), [before, after]);
  const stats = useMemo(() => diffStats(lines), [lines]);
  const same = lines.every((l) => l.kind === 'same');
  if (same) return <p className="text-xs text-muted">Geen verschil.</p>;
  return (
    <div className={cx('space-y-1', className)}>
      <div className="text-[11.5px] text-muted" aria-live="off">
        {[stats.removed === 1 ? '1 woord weg' : stats.removed ? `${stats.removed} woorden weg` : '', stats.added === 1 ? '1 woord erbij' : stats.added ? `${stats.added} woorden erbij` : ''].filter(Boolean).join(' · ') || 'Alleen opmaak of witruimte gewijzigd'}
      </div>
      <div role="group" aria-label={label || 'Verschil'} className="scroll-thin max-h-72 overflow-auto rounded-lg border border-line bg-canvas px-2.5 py-2 text-xs leading-relaxed">
        {lines.map((l, i) =>
          l.kind === 'skip' ? (
            <div key={i} className="py-0.5 text-[11px] italic text-muted">
              … {l.count} {l.count === 1 ? 'ongewijzigde regel' : 'ongewijzigde regels'}
            </div>
          ) : l.kind === 'same' ? (
            <div key={i} className="whitespace-pre-wrap break-words text-muted">
              {l.text || ' '}
            </div>
          ) : l.kind === 'del' ? (
            <div key={i} className="whitespace-pre-wrap break-words rounded-md bg-danger-soft px-1 text-danger">
              <span aria-hidden>− </span>
              <span className="sr-only">Weggehaald: </span>
              <del className="decoration-danger/60">{l.text || ' '}</del>
            </div>
          ) : l.kind === 'ins' ? (
            <div key={i} className="whitespace-pre-wrap break-words rounded-md bg-ok-soft px-1 text-ok">
              <span aria-hidden>+ </span>
              <span className="sr-only">Toegevoegd: </span>
              <ins className="no-underline">{l.text || ' '}</ins>
            </div>
          ) : (
            <div key={i} className="whitespace-pre-wrap break-words">
              {l.pieces.map((p, j) =>
                p.kind === 'same' ? (
                  <span key={j}>{p.text}</span>
                ) : p.kind === 'del' ? (
                  <del key={j} className="rounded-md bg-danger-soft px-0.5 text-danger decoration-danger/60">
                    <span className="sr-only">[weg: </span>
                    {p.text}
                    <span className="sr-only">]</span>
                  </del>
                ) : (
                  <ins key={j} className="rounded-md bg-ok-soft px-0.5 text-ok no-underline">
                    <span className="sr-only">[nieuw: </span>
                    {p.text}
                    <span className="sr-only">]</span>
                  </ins>
                ),
              )}
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/** Legend under a diff (once per list). */
export function DiffLegend() {
  return (
    <p className="text-[11.5px] text-muted">
      <del className="rounded-md bg-danger-soft px-1 text-danger decoration-danger/60">doorgestreept</del> = weggehaald ·{' '}
      <ins className="rounded-md bg-ok-soft px-1 text-ok no-underline">groen</ins> = toegevoegd
    </p>
  );
}
