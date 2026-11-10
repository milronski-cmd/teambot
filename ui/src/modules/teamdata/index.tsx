import { SquareKanban } from 'lucide-react';
import type { UIModule } from '../types';
import { TeamworkPage } from './Page';
import { DecisionsInbox } from './Decisions';
import { initTeamSummary, useTeamSummary } from './api';

/**
 * Teamwerk (team database):
 *  #/m/teamdata/<tab>   tasks board, decisions, log, events, experiments, all tables
 *  Wacht op jou         open decisions with their options as buttons (the asking bot is woken with the answer)
 */
const mod: UIModule = {
  id: 'teamdata',
  label: 'Teamwerk',
  pages: [{ path: '', title: 'Teamwerk', icon: SquareKanban, nav: true, component: TeamworkPage }],
  inbox: {
    useCount: () => useTeamSummary((s) => s.s?.openDecisions || 0),
    component: DecisionsInbox,
  },
  init: () => initTeamSummary(),
};

export default mod;
