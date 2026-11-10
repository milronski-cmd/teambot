import { useState } from 'react';
import { Users } from 'lucide-react';
import { t } from '../../lib/i18n';
import type { Agent } from '../../lib/types';
import { Field } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { activeTeamId, useTeamView } from './scope';

/**
 * Under the questions for a new bot, with two or more teams: which team it lands in (the chosen team, else the first
 * one, as the server does it: teams service `settings.homeTeam`), and a way to pick another right there. The same
 * choice as Meer opties › Thuisteam (both write `settings.homeTeam`). With one team: nothing.
 */
export function NewBotTeam({ draft, onChange }: { draft: Partial<Agent>; onChange(patch: Partial<Agent>): void }) {
  const view = useTeamView();
  const [open, setOpen] = useState(false);
  if (!view.multi) return null;
  const own = typeof draft.settings?.homeTeam === 'string' && view.teams.some((x) => x.id === draft.settings!.homeTeam) ? draft.settings!.homeTeam : '';
  const chosen = own || activeTeamId() || view.teams[0]?.id || '';
  const team = view.teams.find((x) => x.id === chosen);
  if (!team) return null;
  return (
    <div className="space-y-2" data-testid="new-bot-team">
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
        <Users className="h-4 w-4 shrink-0" aria-hidden />
        <span>{t('Komt in team {0}.', team.name)}</span>
        {!open && (
          <button type="button" className="min-h-[32px] font-semibold text-accent hover:underline" onClick={() => setOpen(true)}>
            Ander team
          </button>
        )}
      </p>
      {open && (
        <Field label="Team">
          <Select value={chosen} onChange={(e) => onChange({ settings: { ...(draft.settings || {}), homeTeam: e.target.value } })}>
            {view.teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
    </div>
  );
}
