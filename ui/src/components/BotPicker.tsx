import type React from 'react';
import { useMemo } from 'react';
import { Check, Users } from 'lucide-react';
import { useApp } from '../lib/store';
import type { Agent } from '../lib/types';
import { BotAvatar } from './BotFace';
import { cx } from './ui';
import { toggleAll, toggleOne } from '../lib/botPick';

function Tick({ on }: { on: boolean }) {
  return (
    <span aria-hidden className={cx('flex h-[18px] w-[18px] shrink-0 items-center justify-center rounded-md border transition-colors', on ? 'border-accent bg-accent text-accent-fg' : 'border-line-strong bg-surface')}>
      {on && <Check className="h-3 w-3" strokeWidth={3} />}
    </span>
  );
}

const tile = (on: boolean) =>
  cx('flex min-h-10 w-full items-center gap-2.5 rounded-xl border px-2.5 py-1.5 text-start text-sm transition-colors coarse:min-h-11 disabled:cursor-not-allowed disabled:opacity-50', on ? 'border-fg/40 bg-surface-3' : 'border-line bg-surface hover:bg-surface-2');

/**
 * The one way to choose bots (skills, apps, tokens, groups): a tile per bot with its face and name, and "Alle bots"
 * on top. Archived bots are left out. `value` is a list of bot ids; `onChange` gets the new list.
 */
export function BotPicker({
  value,
  onChange,
  label,
  hint,
  allOption = true,
  single = false,
  disabled = false,
  empty = 'Je hebt nog geen bots.',
  badge,
}: {
  value: string[];
  onChange(ids: string[]): void;
  label?: React.ReactNode;
  hint?: React.ReactNode;
  /** Show "Alle bots" (not with `single`). */
  allOption?: boolean;
  single?: boolean;
  disabled?: boolean;
  empty?: React.ReactNode;
  /** Small extra per bot, e.g. "alleen chat". */
  badge?: (a: Agent) => React.ReactNode;
}) {
  const agents = useApp((s) => s.agents);
  const list = useMemo(() => agents.filter((a) => !a.archived), [agents]);
  if (!list.length) return <p className="text-sm text-muted">{empty}</p>;
  const ids = list.map((a) => a.id);
  const allOn = ids.every((id) => value.includes(id));
  const count = ids.filter((id) => value.includes(id)).length;
  return (
    <fieldset className="min-w-0 space-y-1.5" disabled={disabled}>
      {label && (
        <legend className="mb-1.5 flex w-full items-center justify-between gap-2 text-sm font-medium">
          <span>{label}</span>
          {!single && <span className="text-xs font-normal text-muted">{count ? `${count} van ${list.length} gekozen` : 'Geen gekozen'}</span>}
        </legend>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {allOption && !single && list.length > 1 && (
          <button type="button" aria-pressed={allOn} onClick={() => onChange(toggleAll(value, ids))} className={tile(allOn)}>
            <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-surface-3 text-muted" aria-hidden>
              <Users className="h-3.5 w-3.5" />
            </span>
            <span className="min-w-0 flex-1 truncate font-semibold">Alle bots</span>
            <span className="text-xs tabular-nums text-muted">{list.length}</span>
            <Tick on={allOn} />
          </button>
        )}
        {list.map((a) => {
          const on = value.includes(a.id);
          return (
            <button key={a.id} type="button" aria-pressed={on} onClick={() => onChange(toggleOne(value, a.id, single))} className={tile(on)}>
              <BotAvatar bot={a} size={24} />
              <span className="min-w-0 flex-1 truncate">{a.name}</span>
              {badge?.(a)}
              <Tick on={on} />
            </button>
          );
        })}
      </div>
      {hint && <div className="text-xs leading-relaxed text-muted">{hint}</div>}
    </fieldset>
  );
}
