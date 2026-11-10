import { Activity, Gauge } from 'lucide-react';
import type { UIModule } from '../types';
import { wireUsageEvents } from './api';
import { FloatingStatus, StatusPage } from './StatusPage';
import { UsageLimits, UsagePage } from './UsagePage';
import { BotCapSection } from './BotCap';

/**
 * Gebruik en limieten: the usage popover in the chat header (see UsagePopover.tsx, mounted by ChatView), the limits
 * per account (Settings › Limieten), "Nu bezig" (running bots and what waits, also the desktop's floating window).
 */
const mod: UIModule = {
  id: 'usage',
  label: 'Gebruik en limieten',
  pages: [
    { path: '', title: 'Gebruik en limieten', icon: Gauge, nav: true, component: UsagePage },
    { path: 'status', title: 'Nu bezig', icon: Activity, nav: true, component: StatusPage },
    { path: 'eiland', title: 'Statusvenster', bare: true, component: FloatingStatus },
  ],
  settingsTabs: [{ id: 'limits', title: 'Limieten', component: UsageLimits }],
  // Bot editor: the bot's own usage cap (spend or tokens per day or week; server/modules/usage/cap.ts).
  agentSections: [{ id: 'cap', title: 'Gebruikslimiet', component: BotCapSection }],
  init() {
    return wireUsageEvents();
  },
};

export default mod;
