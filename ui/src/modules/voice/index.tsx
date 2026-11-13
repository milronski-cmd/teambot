import { Mic, NotebookPen } from 'lucide-react';
import { on } from '../../lib/api';
import { useApp } from '../../lib/store';
import type { Message } from '../../lib/types';
import type { UIModule } from '../types';
import { DictateButton } from './Dictate';
import { MessageVoice } from './MessageVoice';
import { LiveCallButton, mountCallHost } from './LiveCall';
import { CallDockAnchor } from './CallBar';
import { AgentVoiceSection } from './AgentVoice';
import { CallHistoryPage, VoiceSettingsTab } from './Settings';
import { MeetingPage } from './Meeting';
import { GroupCallButton } from './GroupCall';
import { followRunAloud, playMessage, usePlayer } from './player';
import { unlockAudio } from './capture';

/**
 * Automatic read-aloud: only for bots with "automatisch voorlezen", only for a reply that is streaming in the chat that
 * is open and visible, and never during a call (the call speaks for itself). With the local voice it starts after the
 * first sentence while the bot is still writing; otherwise when the answer is complete.
 */
function wireAutoRead(): () => void {
  const streamed = new Set<string>();
  // Per run: read live while the bot writes ('live'), or not possible ('fallback': read the finished answer).
  const runs = new Map<string, 'pending' | 'live' | 'fallback'>();
  const skipped = new Map<string, string>();
  const wanted = (m: Message) => {
    const agent = useApp.getState().agents.find((a) => a.id === m.author_id);
    if (!agent?.settings?.voice?.autoRead || agent.settings.voice.engine === 'off') return false;
    if (usePlayer.getState().inCall || document.visibilityState !== 'visible') return false;
    return location.hash.startsWith(`#/t/${m.thread_id}`);
  };
  const quietly = () => {
    /* autoplay blocked: the speaker button under the message still works */
  };
  const offs = [
    on('message.created', (m: Message) => {
      if (m.role !== 'assistant' || m.status !== 'streaming') return;
      streamed.add(m.id);
      const runId = m.run_id;
      if (!runId || runs.has(runId) || !wanted(m)) return;
      // Start reading after the first sentence (local voice); otherwise when the answer is complete.
      runs.set(runId, 'pending');
      followRunAloud(runId, m.id).then(
        (r) => {
          runs.set(runId, r === null ? 'fallback' : 'live');
          const late = skipped.get(runId);
          skipped.delete(runId);
          if (r === null && late) playMessage(late).catch(quietly);
        },
        () => runs.set(runId, 'fallback'),
      );
    }),
    on('message.updated', (m: Message) => {
      if (!streamed.has(m.id) || m.status === 'streaming') return;
      streamed.delete(m.id);
      if (m.status !== 'done' || m.role !== 'assistant' || !m.content?.trim() || m.parts?.toolCalls?.length) return;
      const mode = m.run_id ? runs.get(m.run_id) : undefined;
      if (mode === 'live') return;
      if (mode === 'pending') return void skipped.set(m.run_id!, m.id);
      if (!wanted(m)) return;
      playMessage(m.id).catch(quietly);
    }),
  ];
  return () => offs.forEach((f) => f());
}

const mod: UIModule = {
  id: 'voice',
  label: 'Spraak',
  pages: [
    { path: '', title: 'Spraakgesprekken', icon: Mic, nav: false, component: CallHistoryPage },
    { path: 'vergadering', title: 'Vergadernotities', icon: NotebookPen, nav: true, component: MeetingPage },
  ],
  agentSections: [{ id: 'voice', title: 'Spraak', component: AgentVoiceSection }],
  // CallDockAnchor shows nothing: it tells the bar of a running call where the message field is.
  composerActions: [DictateButton, CallDockAnchor],
  chatHeaderActions: [LiveCallButton, GroupCallButton],
  settingsTabs: [{ id: 'spraak', title: 'Spraak', component: VoiceSettingsTab }],
  messageExtras: [MessageVoice],
  init() {
    // iOS only lets Web Audio play after a tap: unlock on the first tap anywhere (automatic read-aloud needs it).
    const unlock = () => unlockAudio();
    window.addEventListener('pointerdown', unlock, { once: true, capture: true });
    const off = wireAutoRead();
    // A live call lives next to the app, not inside a chat: it goes on while you switch chats or pages.
    const offCall = mountCallHost();
    return () => {
      offCall();
      window.removeEventListener('pointerdown', unlock, { capture: true });
      off();
    };
  },
};

export default mod;
