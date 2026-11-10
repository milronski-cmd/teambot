import type { UIModule } from '../types';
import { ProxySettings } from './ProxySettings';
import { ChatPrivacyChip } from './Privacy';

/**
 * Netwerk en proxy:
 *  Instellingen › Netwerk en proxy (owner/admin)   one HTTP(S) proxy for outgoing traffic, no-proxy list, login, test
 * Privacy (0.4, package P):
 *  chat header                                      privacy label of the bot ("Blijft op je pc", "Kan trainen", …)
 *  bot editor › AI en model                         one line: engine · label · Uitzetten (AgentPrivacyLine)
 *  "Wat verlaat je pc?" on #/settings/data          DataPrivacy.tsx (WhatLeavesYourPc), rendered by the data page
 */
const mod: UIModule = {
  id: 'network',
  label: 'Netwerk en proxy',
  settingsTabs: [{ id: 'proxy', title: 'Netwerk en proxy', adminOnly: true, component: ProxySettings }],
  chatHeaderActions: [ChatPrivacyChip],
};

export default mod;
