import { api } from '../lib/api';
import { useApp } from '../lib/store';

/**
 * "Geavanceerd tonen" (Instellingen › Geavanceerd): off by default, so TeamBot stays simple. When on, the expert
 * panels show too: the decisions, events, experiments and tables of Taken (Teamwerk), the activity, team, CLI
 * and details tabs of the side panel next to a chat, technical step names, and the expert settings (network proxy,
 * publishers). Nothing is removed while it is off: deep links and Ctrl+K still open every page.
 * Stored for the signed-in user (settings.ui.advanced), so every device follows the same choice.
 */
export function useAdvanced(): boolean {
  return useApp((s) => s.settings?.ui?.advanced === true);
}

/** The current choice outside React (event handlers, initial state). */
export function isAdvanced(): boolean {
  return useApp.getState().settings?.ui?.advanced === true;
}

export async function setAdvanced(on: boolean): Promise<void> {
  const ui = useApp.getState().settings?.ui || {};
  const st = await api.put('/settings', { ui: { ...ui, advanced: on } });
  useApp.setState({ settings: st });
}
