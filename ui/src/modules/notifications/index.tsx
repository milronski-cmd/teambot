import { Bell } from 'lucide-react';
import type { UIModule } from '../types';
import { wireNotifications } from './api';
import { AgentNotifySection, NotificationSettings, NotificationsPage } from './parts';

/**
 * Meldingencentrum:
 *  bell (sidebar, phone chat list)   unread count + the history in a popover
 *  #/m/notifications                 the full history, read/unread, wissen
 *  Settings › Meldingen              sound, notifications without a bot, a level per bot
 *  Bot editor › Meldingen            the level for one bot (saved at once)
 * Toasts, sound and web notifications come from here (they respect the levels); the desktop app's Windows
 * notifications and phone pushes ask the server module the same question.
 */
const mod: UIModule = {
  id: 'notifications',
  label: 'Meldingen',
  pages: [{ path: '', title: 'Meldingen', icon: Bell, nav: true, component: NotificationsPage }],
  settingsTabs: [{ id: 'meldingen', title: 'Meldingen', component: NotificationSettings }],
  agentSections: [{ id: 'meldingen', title: 'Meldingen', component: AgentNotifySection }],
  init() {
    return wireNotifications();
  },
};

export default mod;
