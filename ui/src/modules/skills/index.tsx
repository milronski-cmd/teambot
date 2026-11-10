import { Puzzle, Store } from 'lucide-react';
import type { UIModule } from '../types';
import { MarketPage } from './Market';
import { MySkillsPage } from './MySkills';
import { AgentSkillsSection, AgentTemplateSection, SkillDraftRenderer } from './AgentSkills';
import { PublishersSettings } from './Publishers';

/**
 * Skills & marketplace UI:
 *  #/m/skills/            Marktplaats (tabs: bots, skills, apps, bronnen, meldingen as first param)
 *  #/m/skills/mine        Mijn skills (list; /concepten = drafts; /<skillId> = detail)
 */
const mod: UIModule = {
  id: 'skills',
  label: 'Skills & marktplaats',
  pages: [
    { path: '', title: 'Marktplaats', icon: Store, nav: true, component: MarketPage },
    { path: 'mine', title: 'Mijn skills', icon: Puzzle, nav: true, component: MySkillsPage },
  ],
  agentSections: [
    { id: 'skills', title: 'Skills', component: AgentSkillsSection },
    { id: 'template', title: 'Sjabloon en delen', component: AgentTemplateSection },
  ],
  // Members see the policy read-only; owner/admin manage it (enforced server-side).
  settingsTabs: [{ id: 'uitgevers', title: 'Uitgevers en beleid', component: PublishersSettings }],
  toolRenderers: { skill_draft: SkillDraftRenderer },
};

export default mod;
