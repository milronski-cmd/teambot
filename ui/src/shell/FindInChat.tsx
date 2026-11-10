import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { Button } from '../components/ui';

/** Text ranges in `root` that contain `query` (case-insensitive), in document order. */
export function findRanges(root: HTMLElement, query: string, max = 2000): Range[] {
  const q = query.toLocaleLowerCase();
  if (!q.trim()) return [];
  const out: Range[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => {
      const el = n.parentElement;
      if (!el || el.closest('[data-find-skip], script, style, textarea, input, button[aria-hidden="true"]')) return NodeFilter.FILTER_REJECT;
      return n.nodeValue && n.nodeValue.trim() ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let n = walker.nextNode(); n && out.length < max; n = walker.nextNode()) {
    const text = (n.nodeValue || '').toLocaleLowerCase();
    for (let i = text.indexOf(q); i >= 0 && out.length < max; i = text.indexOf(q, i + q.length)) {
      const r = document.createRange();
      r.setStart(n, i);
      r.setEnd(n, i + q.length);
      out.push(r);
    }
  }
  return out;
}

const supportsHighlights = () => typeof CSS !== 'undefined' && 'highlights' in CSS && typeof (window as any).Highlight === 'function';

let outlined: HTMLElement | null = null;

function paint(all: Range[], current: Range | null) {
  if (!supportsHighlights()) {
    // Older browsers: outline the element with the current hit.
    if (outlined) delete outlined.dataset.findCurrent;
    outlined = current ? (current.startContainer.parentElement as HTMLElement | null) : null;
    if (outlined) outlined.dataset.findCurrent = '1';
    return;
  }
  const H = (window as any).Highlight;
  const reg = (CSS as any).highlights as Map<string, unknown>;
  if (all.length) reg.set('tb-find', new H(...all));
  else reg.delete('tb-find');
  if (current) reg.set('tb-find-current', new H(current));
  else reg.delete('tb-find-current');
}

/**
 * Ctrl+F in a conversation: highlights every hit in the loaded messages (CSS Custom Highlights, the page itself is not
 * changed), "3 van 12", Enter / ↓ for the next and Shift+Enter / ↑ for the previous hit, Esc closes. Messages that
 * are not loaded yet are searched after "Oudere berichten laden"; the whole history is in Zoeken (Ctrl+K).
 */
export function FindInChat({ root, version, hasOlder, onLoadOlder, onClose }: { root: React.RefObject<HTMLElement | null>; version: unknown; hasOlder: boolean; onLoadOlder(): void; onClose(): void }) {
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<Range[]>([]);
  const [idx, setIdx] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const lastQ = useRef('');

  useEffect(() => {
    input.current?.focus();
    input.current?.select();
  }, []);

  // Search again when the query changes or new messages arrive (keep the position if the same hits are there).
  useEffect(() => {
    const t = setTimeout(() => {
      const el = root.current;
      const list = el ? findRanges(el, q) : [];
      setHits(list);
      setIdx((i) => (lastQ.current === q && i < list.length ? i : 0));
      lastQ.current = q;
    }, 120);
    return () => clearTimeout(t);
  }, [q, version, root]);

  const cur = hits.length ? hits[Math.min(idx, hits.length - 1)] : null;
  useEffect(() => {
    paint(hits, cur);
    if (cur) {
      const box = cur.getBoundingClientRect();
      const host = root.current;
      if (host) {
        const hb = host.getBoundingClientRect();
        if (box.top < hb.top + 40 || box.bottom > hb.bottom - 40) host.scrollTo({ top: host.scrollTop + box.top - hb.top - hb.height / 2, behavior: 'smooth' });
      }
    }
  }, [hits, cur, root]);
  useEffect(() => () => paint([], null), []);

  const go = (d: 1 | -1) => hits.length && setIdx((i) => (i + d + hits.length) % hits.length);

  return (
    <div role="search" data-find-skip className="flex items-center gap-1.5 border-b border-line bg-surface px-3 py-1.5 desk:px-6">
      <Search className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      <input
        ref={input}
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          } else if (e.key === 'Enter') {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault();
            go(e.key === 'ArrowDown' ? 1 : -1);
          }
        }}
        data-find-input
        placeholder="Zoeken in dit gesprek"
        aria-label="Zoeken in dit gesprek"
        className="h-9 min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted coarse:h-11"
      />
      <span className="shrink-0 text-xs tabular-nums text-muted" aria-live="polite">
        {q.trim() ? (hits.length ? `${Math.min(idx, hits.length - 1) + 1} van ${hits.length}` : 'Geen treffers') : ''}
      </span>
      {hasOlder && q.trim() && (
        <Button size="sm" variant="ghost" onClick={onLoadOlder} title="Ook in oudere berichten zoeken">
          Ouder laden
        </Button>
      )}
      <Button size="icon" variant="ghost" aria-label="Vorige treffer" disabled={!hits.length} onClick={() => go(-1)}>
        <ChevronUp className="h-4 w-4" />
      </Button>
      <Button size="icon" variant="ghost" aria-label="Volgende treffer" disabled={!hits.length} onClick={() => go(1)}>
        <ChevronDown className="h-4 w-4" />
      </Button>
      <Button size="icon" variant="ghost" aria-label="Zoeken sluiten" onClick={onClose}>
        <X className="h-4 w-4" />
      </Button>
    </div>
  );
}
