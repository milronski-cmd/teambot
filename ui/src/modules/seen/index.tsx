import type { UIModule } from '../types';
import { SeenPage } from './parts';

/**
 * "Wat heeft deze bot gezien en gedaan" (A-58):
 *  #/m/seen/<agentId>   files read and written, pages, commands, apps and approvals of one bot (from the chat menu)
 *  Side panel › Bestanden lists the bot's own files of that conversation (BotFilesInThread).
 */
const mod: UIModule = {
  id: 'seen',
  label: 'Gezien en gedaan',
  pages: [{ path: '', title: 'Gezien en gedaan', component: SeenPage }],
};

export default mod;
