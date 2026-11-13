import { useEffect } from 'react';
import { loadTeams, useTeamStore, useTeamView } from './scope';

/**
 * For a page that follows the team switcher (package B4: routines, channels, usage, skills): A3's `useTeamView()`,
 * plus loading the teams once when nothing did yet (A3's teams module `init()` normally does), and the query part
 * for an API that already has other parameters.
 *
 *   const team = useFollowTeam();
 *   api.get(`/routines${team.query}`)          // '' or '?teamId=…'
 *   api.get(`/routines/runs?limit=50${team.and}`) // '' or '&teamId=…'
 *
 * With one team (or "Alle teams") `activeId` is '' and both strings are empty: nothing about teams shows.
 */
export function useFollowTeam() {
  const view = useTeamView();
  useEffect(() => {
    if (!useTeamStore.getState().loaded) void loadTeams();
  }, []);
  const id = view.activeId;
  return {
    ...view,
    query: id ? `?teamId=${encodeURIComponent(id)}` : '',
    and: id ? `&teamId=${encodeURIComponent(id)}` : '',
  };
}
