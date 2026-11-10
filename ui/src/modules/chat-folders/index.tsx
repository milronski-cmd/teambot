import type { UIModule } from '../types';
import { wireChatFolders } from './api';

/**
 * Mappen voor chats (PARITEIT 4.2): folders in the chat list per team (parts.tsx, used by shell/ChatList.tsx) and
 * "Verplaats naar map…" in a chat's menu (shell/ChatView.tsx). No page of its own; init keeps the folders live.
 */
const mod: UIModule = {
  id: 'chat-folders',
  label: 'Mappen voor chats',
  init: () => wireChatFolders(),
};

export default mod;
