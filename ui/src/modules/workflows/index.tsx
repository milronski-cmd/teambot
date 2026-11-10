import { Workflow as WorkflowIcon } from 'lucide-react';
import type { UIModule } from '../types';
import type { Message, ToolCall } from '../../lib/types';
import { WorkflowApprovalCard, WorkflowEditorPage, WorkflowRunPage, WorkflowsPage } from './Pages';

/**
 * Workflows (PARITEIT 9.8):
 *  #/m/workflows            your workflows and the ready-made examples
 *  #/m/workflows/w/<id>     the steps, automatic start, runs and earlier versions (`nieuw` = a new one)
 *  #/m/workflows/run/<id>   one run, live: what every step delivered, stop, resume, your approval
 *  approval card            workflow_approval: what you approve, with the result so far
 */

/** Under a workflow_run / workflow_save tool call: where the owner follows it. */
function ToolCard({ call }: { call: ToolCall; message: Message }) {
  const a = call.args || {};
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <WorkflowIcon className="h-3.5 w-3.5 text-accent" />
      <span className="font-medium">{String(a.name || 'Workflow')}</span>
      <a href="#/m/workflows" className="ms-auto text-accent underline">
        Workflows bekijken
      </a>
    </div>
  );
}

/** Badge under the message that starts a step of a workflow run. */
function StepMessageExtra({ message }: { message: Message }) {
  const w = message.parts?.workflow as { id: string; runId: string } | undefined;
  if (!w?.runId) return null;
  return (
    <a href={`#/m/workflows/run/${w.runId}`} className="mt-1 inline-flex items-center gap-1 text-xs text-muted hover:text-accent">
      <WorkflowIcon className="h-3 w-3" /> Stap van een workflow · de hele run bekijken
    </a>
  );
}

const mod: UIModule = {
  id: 'workflows',
  label: 'Workflows',
  pages: [
    { path: '', title: 'Workflows', icon: WorkflowIcon, component: WorkflowsPage },
    { path: 'w', title: 'Workflow', component: WorkflowEditorPage },
    { path: 'run', title: 'Run van een workflow', component: WorkflowRunPage },
  ],
  approvalRenderers: { workflow_approval: WorkflowApprovalCard },
  toolRenderers: { workflow_run: ToolCard, workflow_save: ToolCard },
  messageExtras: [StepMessageExtra],
};
export default mod;
