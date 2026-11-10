import React from 'react';
import type { ProviderView } from '../lib/types';
import { LocalModelsCard } from '../modules/local-models';
import { WelcomeTeamTemplate } from '../modules/templates/WelcomeTeamTemplate';

/** Q: the compact card on the first-run screen (the pc in one sentence, the GPU warning, one button for a first bot). */
function LocalModelsWelcome() {
  return React.createElement(LocalModelsCard, { compact: true });
}

/**
 * Places on the first-run screen (pages/Home.tsx, Welcome) for work that is built in parallel (TeamBot 0.4). Each stays
 * empty (nothing rendered) until its component is set here, e.g. from the module that builds it:
 *
 *   import { welcomeSlots } from '../../pages/welcomeSlots';
 *   welcomeSlots.localModels = LocalModelsCard;
 *
 * - `localModels` (package Q): the card "Lokale modellen op deze pc", right under "Gevonden op deze pc".
 * - `teamTemplate` (package R): start from a team template. Clearly secondary: it sits under the one main button
 *   "Maak je eerste bot", as a quiet link or small button, never a second big button.
 *
 * Nothing is installed by the welcome screen itself: no bots, teams, skills or routines until the owner chooses.
 */
export interface TeamTemplateSlotProps {
  /** Connects the AI found on this PC (no keys needed) and returns the engine a first bot would use (null: none yet). */
  prepare(): Promise<ProviderView | null>;
}

export const welcomeSlots: {
  localModels: React.ComponentType | null;
  teamTemplate: React.ComponentType<TeamTemplateSlotProps> | null;
} = { localModels: LocalModelsWelcome, teamTemplate: WelcomeTeamTemplate };
