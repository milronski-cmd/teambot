import { AlarmClock, CalendarClock, Hourglass } from 'lucide-react';
import type { UIModule } from '../types';
import type { Message, ToolCall } from '../../lib/types';
import { t } from '../../lib/i18n';
import { formatDateTime } from '../../lib/format';
import { AgentRoutinesSection, GlobalLimits, RoutineDetailPage, RoutinesPage } from './Pages';
import { UptimeNote } from './Head';
import { useMeta } from './lib';
import { CalendarPage } from './Calendar';
import { KansenInbox, WerkPage, initKansen, useKansenCount } from './Werk';

import { everyText } from './days';

/** Compact card under a routine_create tool call: what the bot proposes, with a link. */
function RoutineCreateCard({ call }: { call: ToolCall; message: Message }) {
  const a = call.args || {};
  const when =
    a.schedule_kind === 'once'
      ? `eenmalig op ${formatDateTime(String(a.at || '')) || String(a.at || '').replace('T', ' ')}`
      : a.schedule_kind === 'interval'
        ? t('{0, plural, one {elke minuut} other {elke # minuten}}', Number(a.every_minutes) || 0)
        : a.schedule_kind === 'cron'
          ? `cron ${a.cron}`
          : // Day codes in any spelling a model uses (MO, Mon, ma, 1) in Dutch words, as the server reads them.
            `${a.schedule_kind === 'daily' || !Array.isArray(a.days) ? 'elke dag' : everyText(a.days)} om ${(a.times || []).join(', ')}`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <CalendarClock className="h-3.5 w-3.5 text-accent" />
      <span className="font-medium">{String(a.name || 'Routine')}</span>
      <span className="text-muted">{when}</span>
      <a href="#/m/routines" className="ms-auto text-accent underline">
        Routines bekijken
      </a>
    </div>
  );
}

/** Compact card under a wait_for tool call: what the bot waits for, with a link to the waitpoint. */
function WaitForCard({ call }: { call: ToolCall; message: Message }) {
  const a = call.args || {};
  const what = a.event === 'file' ? `een bestand${a.pattern ? ` “${a.pattern}”` : ''}${a.path && a.path !== '.' ? ` in ${a.path}` : ''}` : a.event === 'message' ? `een chatbericht${a.text ? ` met “${a.text}”` : ''}` : a.event === 'webhook' ? 'een webhook' : `${String(a.at || '').replace('T', ' ')}`;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <Hourglass className="h-3.5 w-3.5 text-accent" />
      <span className="font-medium">{a.event === 'time' ? 'Wachtpunt' : 'Wacht op'}</span>
      <span className="text-muted">{what}</span>
      <a href="#/m/routines/kalender" className="ml-auto text-accent underline">
        Kalender
      </a>
    </div>
  );
}

/** Badge under the input message of a routine run. */
function RoutineMessageExtra({ message }: { message: Message }) {
  const r = message.parts?.routine as { id: string; runId: string; trigger: string } | undefined;
  if (!r?.id) return null;
  return (
    <a href={`#/m/routines/r/${r.id}?tab=history`} className="mt-1 inline-flex items-center gap-1 text-xs text-muted hover:text-accent">
      <AlarmClock className="h-3 w-3" /> Routine-run · bonnetje bekijken
    </a>
  );
}

function SettingsTab() {
  const { meta } = useMeta();
  return (
    <div className="space-y-4">
      {meta && <UptimeNote meta={meta} />}
      <GlobalLimits />
    </div>
  );
}

const mod: UIModule = {
  id: 'routines',
  label: 'Routines & triggers',
  pages: [
    { path: '', title: 'Routines', icon: AlarmClock, nav: true, component: RoutinesPage },
    { path: 'r', title: 'Routine', component: RoutineDetailPage },
    { path: 'kalender', title: 'Kalender', component: CalendarPage },
    // What the team does by itself: vaste taken, projecten, kansen and the budget for proactive work.
    { path: 'werk', title: 'Werk', component: WerkPage },
  ],
  // Opportunities of the week wait for the owner's yes or no under "Wacht op jou".
  inbox: { useCount: useKansenCount, component: KansenInbox },
  init: () => initKansen(),
  agentSections: [{ id: 'routines', title: 'Routines', component: AgentRoutinesSection }],
  settingsTabs: [{ id: 'routines', title: 'Routines', component: SettingsTab }],
  toolRenderers: { routine_create: RoutineCreateCard, wait_for: WaitForCard },
  messageExtras: [RoutineMessageExtra],
};
export default mod;
