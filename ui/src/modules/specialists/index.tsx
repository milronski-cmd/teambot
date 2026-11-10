import { GraduationCap } from 'lucide-react';
import { Button } from '../../components/ui';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import type { UIModule } from '../types';
import { SpecialistSection } from './Card';
import { KennisbankPage } from './Kennisbank';
import { useSpecialists } from './api';

/** In the chat header of a specialist: its knowledge base, with a dot when something waits (te controleren, verslag). */
function KennisbankButton({ agentId }: { threadId: string; agentId: string | null }) {
  const list = useSpecialists();
  const s = agentId ? list.find((x) => x.agentId === agentId && x.enabled) : null;
  if (!s) return null;
  const waiting = s.counts.review + s.counts.reportsUnseen + s.counts.proposals;
  const label = waiting ? t('Kennisbank van {0} ({1} wacht op jou)', s.agentName, waiting) : t('Kennisbank van {0}', s.agentName);
  return (
    <Button variant="ghost" size="icon" aria-label={label} title={label} className="relative" onClick={() => navigate(`/m/specialists/${s.agentId}${s.counts.review ? '/controleren' : ''}`)}>
      <GraduationCap className="h-4 w-4" />
      {waiting > 0 && <span aria-hidden className="absolute end-1.5 top-1.5 h-2 w-2 rounded-full bg-warn" />}
    </Button>
  );
}

/**
 * Specialisten (0.4, package S):
 *  Bot › Specialisme          field, sources, learning round (off until you turn it on), budget, self-test
 *  #/m/specialists[/<bot>]    knowledge bases: facts with source and date, te controleren, learning goals,
 *                              learning reports with undo, skill proposals, sources
 */
const mod: UIModule = {
  id: 'specialists',
  label: 'Specialisten',
  pages: [{ path: '', title: 'Kennisbanken', icon: GraduationCap, component: KennisbankPage }],
  agentSections: [{ id: 'specialist', title: 'Specialisme', component: SpecialistSection }],
  chatHeaderActions: [KennisbankButton],
};

export default mod;
