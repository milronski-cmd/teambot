import { cx } from '../components/ui';
import type { TeamLite } from './teamFilter';

/** A team's colour as a dot (the name is always next to it: colour never carries meaning on its own). */
export function TeamDot({ color, size = 10, className }: { color: string; size?: number; className?: string }) {
  return <span aria-hidden className={cx('inline-block shrink-0 rounded-full', className)} style={{ background: color, width: size, height: size }} />;
}

/** "Alle teams": the colours of the first three teams, a little overlapping. */
export function AllTeamsDots({ teams, size = 10 }: { teams: TeamLite[]; size?: number }) {
  return (
    <span aria-hidden className="flex shrink-0 items-center">
      {teams.slice(0, 3).map((x, i) => (
        <span key={x.id} className={cx('inline-block rounded-full ring-2 ring-surface', i > 0 && '-ms-1')} style={{ background: x.color, width: size, height: size }} />
      ))}
    </span>
  );
}
