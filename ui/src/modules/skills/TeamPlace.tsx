import { useState } from 'react';
import { Select } from '../../components/ui';
import { useFollowTeam } from '../teams/follow';

/** "Voor alle teams" as a choice (the server's teamId '*'). */
export const ALL = '*';

/**
 * Where a skill install goes (package B4): one team, or all teams. Starts at the team chosen in the team switcher,
 * else the first (default) team. With one team there is nothing to choose: `teamId` is '' (the server uses the
 * default team) and the picker renders nothing.
 */
export function useSkillPlace() {
  const view = useFollowTeam();
  const [chosen, setChosen] = useState('');
  const fallback = view.activeId || view.teams[0]?.id || '';
  const value = view.multi ? chosen || fallback : '';
  return {
    multi: view.multi,
    teams: view.teams,
    /** For the API: a team id, '*' for all teams, or '' (one team: the default). */
    teamId: value,
    set: setChosen,
    /** `?teamId=` for lists that show what that team has ('' with one team or for all teams). */
    query: value && value !== ALL ? `?teamId=${encodeURIComponent(value)}` : '',
  };
}

export function TeamPlacePicker({ place, label = 'Installeren voor' }: { place: ReturnType<typeof useSkillPlace>; label?: string }) {
  if (!place.multi) return null;
  return (
    <label className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-muted">{label}</span>
      <Select value={place.teamId} onChange={(e) => place.set(e.target.value)} aria-label={label} className="w-auto">
        {place.teams.map((t) => (
          <option key={t.id} value={t.id} translate="no">
            {t.name}
          </option>
        ))}
        <option value={ALL}>Alle teams</option>
      </Select>
    </label>
  );
}
