import type { UIModule } from '../types';
import { initQuality, useQualityCount } from './api';
import { LoopStopEvent, ReviewInbox } from './parts';
import { QualityAgentSection } from './AgentSection';

/**
 * Werk dat af is (server: modules/quality):
 *  Wacht op jou        tasks to check ("te controleren", "kon niet") and skill suggestions, with approve / send back
 *  chat                the card when a bot stopped itself in a loop
 *  Bot › Werk dat af is  second look on/off and its engine, loop guard, learning from corrections
 * The task pieces (CheckBadge, ClaimBadge, EvidenceList, DoneWhenField, TaskQuality, TaskQualityLine) are exported from
 * ./parts for every task list (the task board, the team database, the single board at #/tasks).
 */
const mod: UIModule = {
  id: 'quality',
  label: 'Werk dat af is',
  agentSections: [{ id: 'quality', title: 'Werk dat af is', component: QualityAgentSection }],
  eventRenderers: { loop_stop: LoopStopEvent },
  inbox: { useCount: useQualityCount, component: ReviewInbox },
  init: () => initQuality(),
};

export default mod;
