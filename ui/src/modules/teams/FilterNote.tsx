import type React from 'react';
import { Button, cx } from '../../components/ui';
import { TeamDot } from '../../shell/TeamDot';
import { setActiveTeam, useTeamView } from './scope';

/**
 * One calm line on a page that follows the team switcher, while one team is chosen: which team you see, what that
 * means on this page (`children`), and a way back to *Alle teams*. Nothing with one team or with Alle teams.
 */
export function TeamFilterNote({ children, className }: { children?: React.ReactNode; className?: string }) {
  const { active } = useTeamView();
  if (!active) return null;
  return (
    <div className={cx('flex flex-wrap items-center gap-x-2 gap-y-1 text-[13px]', className)} data-testid="team-filter-note">
      <span className="flex min-w-0 items-center gap-1.5 font-semibold">
        <TeamDot color={active.color} />
        <span className="truncate" translate="no">
          {active.name}
        </span>
      </span>
      {children && <span className="text-muted">{children}</span>}
      <Button size="sm" variant="ghost" className="-my-1" onClick={() => setActiveTeam('')}>
        Alle teams tonen
      </Button>
    </div>
  );
}
