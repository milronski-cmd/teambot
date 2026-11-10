import { LayoutGrid, Users } from 'lucide-react';
import type { UIModule } from '../types';
import { TeamsPage, TeamsSettings } from './TeamsPage';
import { AllTeamsPage } from './Overview';
import { MainBotSection } from './MainBot';
import { BotTeamsSection } from './BotTeams';
import { startTeamScope } from './scope';
import { StuckExtra } from './StuckExtra';

/**
 * Teams (0.4, packages B, C and A3):
 *  Instellingen › Bots en groepen › Teams   name, colour, lead (optional), business profile, bots, team folder, access,
 *                                            key scope
 *  #/m/teams[/<teamId>]                      the same for one team, inside Instellingen (the switcher's "Teams beheren")
 *  #/m/teams/alle                            "Alle teams": main bot, leaders, and per team what is open, waits for you,
 *                                            done or failed
 *  bot editor › Hoofdbot                     make a bot the main bot (one per owner), or a normal bot again
 *  bot editor › Teams                        home team and access to the other teams (only with two or more teams)
 *  team switcher (shell/TeamSwitcher.tsx)    top of the sidebar, the phone's Chats and Meer; state in ./scope.ts
 * With one team only that team's settings show; team choices, the switcher, access and key scope appear from the
 * second team on. The new-bot flow mounts MainBotChoice (./MainBot) for "Gewone bot of hoofdbot".
 * Under the main bot's message about stuck work: where you answer, and Opnieuw proberen (./StuckExtra).
 */
const mod: UIModule = {
  id: 'teams',
  label: 'Teams',
  pages: [
    { path: '', title: 'Teams', icon: Users, component: TeamsPage },
    { path: 'alle', title: 'Alle teams', icon: LayoutGrid, component: AllTeamsPage },
  ],
  agentSections: [
    { id: 'main', title: 'Hoofdbot', component: MainBotSection },
    { id: 'teams', title: 'Teams', component: BotTeamsSection },
  ],
  settingsTabs: [{ id: 'teams', title: 'Teams', component: TeamsSettings }],
  messageExtras: [StuckExtra],
  init: () => startTeamScope(),
};

export default mod;
