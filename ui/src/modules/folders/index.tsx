import { FolderOpen, Trash2 } from 'lucide-react';
import type { UIModule } from '../types';
import { AgentFoldersSection, FoldersPage, TeamFolderSettings } from './Pages';
import { TrashPage } from './Trash';

/**
 * Folders:
 *  #/m/folders[/team|/<agentId>]   browse the team folder and every bot's folders
 *  #/m/folders/prullenbak          files bots deleted or overwrote, restorable for 30 days
 *  Settings → Teammap              one shared folder for all (or selected) bots
 *  Bot editor → Mappen             extra folders per bot, read-only or read-write
 */
const mod: UIModule = {
  id: 'folders',
  label: 'Bestanden',
  pages: [
    { path: '', title: 'Bestanden', icon: FolderOpen, nav: true, component: FoldersPage },
    { path: 'prullenbak', title: 'Prullenbak', icon: Trash2, component: TrashPage },
  ],
  agentSections: [{ id: 'folders', title: 'Mappen', component: AgentFoldersSection }],
  settingsTabs: [{ id: 'teammap', title: 'Teammap', component: TeamFolderSettings }],
};

export default mod;
