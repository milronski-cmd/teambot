import { Brain } from 'lucide-react';
import { on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { toast } from '../../components/ui';
import type { UIModule } from '../types';
import { AboutYouPage, BotsPage, ItemPage, OverviewPage, SharedPage } from './pages';
import { DossiersPage } from './dossiers';
import { HistoryPage, ReviewPage, StoragePage } from './review';
import { MemoryAgentSection, MemoryInspector, MemoryMessageExtra, MemoryToolCard } from './chat';
import { ConflictInbox, useConflictCount } from './inbox';

/** Geheugen & dossiers — visible, bounded memory with sources, review, undo and reliable forgetting. */
const mod: UIModule = {
  id: 'memory',
  label: 'Geheugen & dossiers',
  pages: [
    { path: '', title: 'Geheugen & dossiers', icon: Brain, nav: true, component: OverviewPage },
    { path: 'over-jou', title: 'Over jou', component: AboutYouPage },
    { path: 'bots', title: 'Bots', component: BotsPage },
    { path: 'dossiers', title: 'Dossiers', component: DossiersPage },
    { path: 'gedeeld', title: 'Gedeeld', component: SharedPage },
    { path: 'beoordelen', title: 'Te beoordelen', component: ReviewPage },
    { path: 'geschiedenis', title: 'Geschiedenis', component: HistoryPage },
    { path: 'opslag', title: 'Opslag', component: StoragePage },
    { path: 'item', title: 'Herinnering', component: ItemPage },
  ],
  agentSections: [{ id: 'memory', title: 'Geheugen', component: MemoryAgentSection }],
  inspectorTabs: [{ id: 'memory', title: 'Geheugen', component: MemoryInspector }],
  messageExtras: [MemoryMessageExtra],
  // "Wacht op jou": two notes that contradict each other and that TeamBot may not decide itself (one short question).
  inbox: { useCount: useConflictCount, component: ConflictInbox },
  toolRenderers: {
    memory_remember: MemoryToolCard,
    memory_update: MemoryToolCard,
    memory_forget: MemoryToolCard,
    dossier_add: MemoryToolCard,
    dossier_update: MemoryToolCard,
    dossier_note: MemoryToolCard,
  },
  init() {
    // Make bot writes visible as they happen (with a pointer to undo).
    return on('memory.updated', (d: any) => {
      if (d?.op === 'learned' && d.applied) {
        const bot = useApp.getState().agents.find((a) => a.id === d.agentId)?.name || 'je bot';
        toast(`Geheugen bijgewerkt uit je gesprek met ${bot}: ${d.applied} onthouden${d.superseded ? ` (${d.superseded} vervangen)` : ''}${d.proposed ? `, ${d.proposed} voorstel(len)` : ''}. Ongedaan maken kan onder je bericht.`);
        return;
      }
      // Automatically learned items are summarised once per batch (above), not one toast per item.
      if (d?.actor !== 'agent' || !['create', 'propose'].includes(d?.op) || ['auto', 'model'].includes(d?.origin)) return;
      const name = useApp.getState().agents.find((a) => a.id === d.actorId)?.name || 'Een bot';
      toast(d.op === 'propose' ? `${name} stelt een herinnering voor (Geheugen › Te beoordelen)` : `${name} heeft iets onthouden — ongedaan maken kan in Geheugen › Geschiedenis`);
    });
  },
};

export default mod;
