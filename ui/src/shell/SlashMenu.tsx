import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Sparkles, TerminalSquare } from 'lucide-react';
import { api } from '../lib/api';
import { cx } from '../components/ui';
import { type MenuItem, type SlashToken, applyPick, filterItems, slashToken } from './slash';

/** A composer command in the "/" menu: does something real right away ("Nieuw gesprek", "Zoeken in dit gesprek"). */
export interface ComposerCommand {
  id: string;
  label: string;
  description?: string;
  keywords?: string[];
  icon?: React.ReactNode;
  run(): void;
}

interface SkillItem extends MenuItem {
  kind: 'skill';
}
interface CommandItem extends MenuItem {
  kind: 'command';
  icon?: React.ReactNode;
  run(): void;
}
type Item = SkillItem | CommandItem;

const skillCache = new Map<string, { at: number; list: SkillItem[] }>();

/** Skills this conversation's bot(s) may use (name + description), cached for a minute. */
function useMenuSkills(threadId: string, wanted: boolean) {
  const [list, setList] = useState<SkillItem[] | null>(() => skillCache.get(threadId)?.list ?? null);
  const [error, setError] = useState('');
  useEffect(() => {
    if (!wanted) return;
    const hit = skillCache.get(threadId);
    if (hit && Date.now() - hit.at < 60_000) return setList(hit.list);
    let alive = true;
    api
      .get<{ skills: { name: string; description: string; bots?: string[] }[] }>(`/skills/menu?threadId=${encodeURIComponent(threadId)}`)
      .then((r) => {
        const l: SkillItem[] = r.skills.map((s) => ({ kind: 'skill', id: 'skill:' + s.name, label: s.name, description: s.description + (s.bots?.length ? ` · ${s.bots.join(', ')}` : '') }));
        skillCache.set(threadId, { at: Date.now(), list: l });
        if (alive) setList(l);
      })
      .catch((e) => alive && (setList([]), setError(e?.message || String(e))));
    return () => {
      alive = false;
    };
  }, [threadId, wanted]);
  return { list, error };
}

/**
 * The "/" and "$" menu of the composer: search as you type, arrows + Enter/Tab (or a tap) to pick, Esc to close.
 * Returns the props the textarea needs (key handling, ARIA) and the menu element to render above the composer.
 */
export function useSlashMenu(o: { threadId: string; text: string; setText(t: string): void; textarea: React.RefObject<HTMLTextAreaElement | null>; commands: ComposerCommand[]; disabled?: boolean }) {
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const listId = useId();
  const token: SlashToken | null = o.disabled ? null : slashToken(o.text, caret);
  const key = token ? `${token.start}:${token.trigger}` : null;
  const open = !!token && dismissed !== key;
  const { list: skills, error } = useMenuSkills(o.threadId, open);
  const items: Item[] = useMemo(() => {
    if (!token) return [];
    const cmds: CommandItem[] = token.trigger === '/' ? o.commands.map((c) => ({ kind: 'command', id: 'cmd:' + c.id, label: c.label, description: c.description, keywords: c.keywords, icon: c.icon, run: c.run })) : [];
    return filterItems<Item>([...(skills || []), ...cmds], token.query);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token?.trigger, token?.query, skills, o.commands]);
  useEffect(() => setActive(0), [token?.query, token?.trigger, items.length]);
  useEffect(() => {
    if (!open) return;
    document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open, listId]);
  const lastKey = useRef(key);
  if (lastKey.current !== key) {
    lastKey.current = key;
    if (dismissed && dismissed !== key) setDismissed(null);
  }

  const pick = (it: Item) => {
    if (!token) return;
    const r = applyPick(o.text, token, it);
    pending.current = r;
    o.setText(r.text);
    setCaret(r.caret);
    if (it.kind === 'command') it.run();
  };

  // Put the caret right after the picked skill as soon as the new text is on screen, before the next key press
  // (a later timer would move it back while the user is already typing).
  const pending = useRef<{ text: string; caret: number } | null>(null);
  useLayoutEffect(() => {
    const p = pending.current;
    const el = o.textarea.current;
    if (!p || !el || el.value !== p.text) return;
    pending.current = null;
    if (document.activeElement !== el) el.focus();
    el.setSelectionRange(p.caret, p.caret);
  });

  const track = (e: { currentTarget: HTMLTextAreaElement }) => setCaret(e.currentTarget.selectionStart ?? e.currentTarget.value.length);

  /** Handle menu keys first; true = handled (the composer must not send on this Enter). */
  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>): boolean => {
    if (!open || !token) return false;
    if (e.key === 'Escape') {
      e.preventDefault();
      setDismissed(key);
      return true;
    }
    if (!items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return true;
    }
    if ((e.key === 'Enter' && !e.shiftKey) || e.key === 'Tab') {
      e.preventDefault();
      pick(items[Math.min(active, items.length - 1)]);
      return true;
    }
    return false;
  };

  const textareaProps = {
    onSelect: track,
    onClick: track,
    onKeyUp: track,
    // A textarea keeps its own role (textbox); these are the attributes ARIA allows on it for a suggestion list.
    'aria-autocomplete': 'list' as const,
    'aria-controls': open ? listId : undefined,
    'aria-activedescendant': open && items.length ? `${listId}-${Math.min(active, items.length - 1)}` : undefined,
  };

  const skillRows = items.filter((i) => i.kind === 'skill');
  const cmdRows = items.filter((i) => i.kind === 'command');
  const row = (it: Item) => {
    const i = items.indexOf(it);
    return (
      <div
        key={it.id}
        id={`${listId}-${i}`}
        role="option"
        aria-selected={i === active}
        onMouseDown={(e) => e.preventDefault()}
        onMouseEnter={() => setActive(i)}
        onClick={() => pick(it)}
        className={cx('flex cursor-pointer items-start gap-2.5 rounded-xl px-2.5 py-2 text-sm coarse:py-3', i === active ? 'bg-surface-3' : 'hover:bg-surface-2')}
      >
        <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center text-muted">{it.kind === 'skill' ? <Sparkles className="h-4 w-4 text-accent" /> : (it as CommandItem).icon || <TerminalSquare className="h-4 w-4" />}</span>
        <span className="min-w-0 flex-1">
          <span className={cx('block truncate font-semibold', it.kind === 'skill' && 'font-mono text-[13px]')} translate={it.kind === 'skill' ? 'no' : undefined}>
            {it.kind === 'skill' ? `${token?.trigger}${it.label}` : it.label}
          </span>
          {it.description && <span className="block truncate text-xs text-muted">{it.description}</span>}
        </span>
      </div>
    );
  };

  const menu = open ? (
    <div id={listId} role="listbox" aria-label={token!.trigger === '$' ? 'Skills' : 'Skills en opdrachten'} className="scroll-thin absolute bottom-full left-0 right-0 z-30 mb-2 max-h-[min(45vh,360px)] overflow-y-auto rounded-2xl border border-line bg-surface p-1.5 shadow-2xl">
      {skills === null ? (
        <div className="px-3 py-2 text-sm text-muted">Skills laden…</div>
      ) : (
        <>
          {skillRows.length > 0 && <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Skills</div>}
          {skillRows.map(row)}
          {skills.length === 0 && !token!.query && (
            <div className="px-2.5 py-2 text-xs text-muted">{error ? `Skills konden niet geladen worden: ${error}` : 'Deze bot heeft nog geen skills. Kies ze bij de bot of in de marktplaats.'}</div>
          )}
          {cmdRows.length > 0 && <div className="px-2.5 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted">Opdrachten</div>}
          {cmdRows.map(row)}
          {items.length === 0 && (skills.length > 0 || token!.query) && <div className="px-3 py-2 text-sm text-muted">Niets gevonden voor “{token!.query}”. Esc sluit dit menu.</div>}
        </>
      )}
    </div>
  ) : null;

  return { open, menu, onKeyDown, textareaProps, setCaret };
}
