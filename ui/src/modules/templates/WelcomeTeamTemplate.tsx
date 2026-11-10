import { useState } from 'react';
import { Modal } from '../../components/ui';
import type { TeamTemplateSlotProps } from '../../pages/welcomeSlots';
import { TeamTemplateWizard } from './TeamTemplateWizard';

/**
 * For the first-run screen (`welcomeSlots.teamTemplate` in pages/welcomeSlots.ts): a quiet link under "Maak je eerste
 * bot" that opens the template wizard. Nothing is made until the owner presses "Team maken". Wave 2 places it with
 * `welcomeSlots.teamTemplate = WelcomeTeamTemplate`.
 */
export function WelcomeTeamTemplate({ prepare }: TeamTemplateSlotProps) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="text-sm text-accent underline-offset-2 hover:underline" onClick={() => setOpen(true)}>
        Of begin met een kant-en-klaar team
      </button>
      <Modal open={open} onClose={() => setOpen(false)} title="Team uit een sjabloon" wide>
        <TeamTemplateWizard prepare={prepare} onCancel={() => setOpen(false)} />
      </Modal>
    </>
  );
}
