import { useState } from 'react';
import { MonitorSmartphone } from 'lucide-react';
import type { UIModule } from '../types';
import { useApp } from '../../lib/store';
import { EmptyState, Field, Select } from '../../components/ui';
import { ComputersPage, LivePage } from './ComputersPage';
import { ComputerLive } from './DesktopPanel';
import { AgentComputerSection } from './AgentSection';
import { ChangesTab } from './Changes';
import { BrowserToolCard, DesktopToolCard } from './ToolCards';
import { BrowserDock, BrowserDockButton, trackRunning } from './BrowserDock';
import { LoginHandoffCard, VaultLoginCard, VaultPage } from './Vault';

/** Inspector tab "Computer": live desktop and/or browser screen, step log, takeover and stop for the bot of this chat. */
function ComputerTab({ agentId }: { threadId: string; agentId: string | null }) {
  const agents = useApp((s) => s.agents);
  const [picked, setPicked] = useState<string>('');
  const id = agentId || picked;
  return (
    <div className="space-y-3">
      {!agentId && (
        <Field label="Bot">
          <Select value={picked} onChange={(e) => setPicked(e.target.value)}>
            <option value="">Kies een bot…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      {id ? <ComputerLive agentId={id} compact /> : <EmptyState title="Geen bot gekozen">Kies een bot om zijn computer te bekijken.</EmptyState>}
    </div>
  );
}

const mod: UIModule = {
  id: 'browser',
  label: 'Browser & computer',
  pages: [
    { path: '', title: 'Computers', icon: MonitorSmartphone, nav: true, component: ComputersPage },
    { path: 'live', title: 'Live scherm', component: LivePage },
    { path: 'kluis', title: 'Kluis', component: VaultPage },
  ],
  // the bot's browser next to the chat (desktop) or as a full-screen sheet (phone); a small button in the header
  chatHeaderActions: [BrowserDockButton],
  chatDocks: [BrowserDock],
  approvalRenderers: {
    browser_vault_login: VaultLoginCard,
    browser_request_login: LoginHandoffCard,
  },
  init: () => trackRunning(),
  agentSections: [{ id: 'computer', title: 'Computer & bestanden', component: AgentComputerSection }],
  inspectorTabs: [
    { id: 'computer', title: 'Computer', component: ComputerTab },
    { id: 'changes', title: 'Wijzigingen', component: ChangesTab },
  ],
  toolRenderers: {
    'browser_*': BrowserToolCard,
    'desktop_*': DesktopToolCard,
  },
};

export default mod;
