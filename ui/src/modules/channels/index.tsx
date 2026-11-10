import { RadioTower } from 'lucide-react';
import type { UIModule } from '../types';
import { ChannelsPage } from './ChannelsPage';
import { AgentChannels, ChannelHeader, DeliveryExtra } from './extras';
import { CustomerInbox, startCustomerInbox, useCustomerInboxCount } from './Inbox';

/** Kanalen: Telegram, Discord, Slack, e-mail, WhatsApp and webhooks for your bots. */
const mod: UIModule = {
  id: 'channels',
  label: 'Kanalen',
  pages: [{ path: '', title: 'Kanalen', icon: RadioTower, nav: true, component: ChannelsPage }],
  agentSections: [{ id: 'channels', title: 'Kanalen', component: AgentChannels }],
  chatHeaderActions: [ChannelHeader],
  messageExtras: [DeliveryExtra],
  // Customer replies that wait for approval and conversations handed off to the owner, in "Wacht op jou".
  inbox: { useCount: useCustomerInboxCount, component: CustomerInbox },
  init: () => startCustomerInbox(),
};

export default mod;
