import { useEffect, useMemo, useState } from 'react';
import { CircleAlert } from 'lucide-react';
import { api, on } from '../../lib/api';
import { useEditorSection } from '../../lib/editorSave';
import { t } from '../../lib/i18n';
import type { Agent } from '../../lib/types';
import { Field, Spinner } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { MoreInfo } from '../../components/MoreInfo';
import { TeamDot } from '../../shell/TeamDot';
import { type AccessLevel, teamsApi } from './api';
import { activeTeamId, useTeamView } from './scope';

/** GET /api/teams/bots/:agentId (server/modules/teams/service.ts botView). */
interface BotTeamsView {
  agentId: string;
  homeTeamId: string;
  teams: { teamId: string; name: string; color: string; reach: 'home' | AccessLevel }[];
}

const LEVELS: { id: AccessLevel; label: string }[] = [
  { id: 'none', label: 'Geen toegang' },
  { id: 'read', label: 'Meekijken' },
  { id: 'direct', label: 'Aansturen' },
];

const levelsOf = (v: BotTeamsView | null): Record<string, AccessLevel> => Object.fromEntries((v?.teams || []).filter((x) => x.reach !== 'home').map((x) => [x.teamId, x.reach as AccessLevel]));

/**
 * Bot editor › Teams (only with two or more teams; the editor leaves it out otherwise): the bot's home team, and per
 * other team *Geen toegang / Meekijken / Aansturen* (docs/modules/teams.md). Saved with the editor's own "Opslaan".
 * A new bot only gets its home team here (the team you look at in the switcher, unless you pick another); access to
 * other teams can be set once it exists.
 */
export function BotTeamsSection({ agent, onChange }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  const { teams } = useTeamView();
  const isNew = !agent.id;
  const [view, setView] = useState<BotTeamsView | null>(null);
  const [err, setErr] = useState('');
  // Only what you changed here; everything else follows the server (also when it changes elsewhere meanwhile).
  const [homeDraft, setHomeDraft] = useState<string | null>(null);
  const [levelDraft, setLevelDraft] = useState<Record<string, AccessLevel>>({});

  const load = () =>
    api
      .get<BotTeamsView>(`/teams/bots/${agent.id}`)
      .then((v) => (setView(v), setErr(''), v))
      .catch((e) => (setErr(e?.message || String(e)), null));
  useEffect(() => {
    if (isNew) return;
    void load();
    return on('teams.changed', () => void load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent.id]);

  const serverLevels = useMemo(() => levelsOf(view), [view]);
  const home = homeDraft ?? view?.homeTeamId ?? '';
  // What the server has (after a move the old home team has no access, like the server does it).
  const serverLevel = (teamId: string): AccessLevel => (teamId === view?.homeTeamId ? 'none' : serverLevels[teamId] || 'none');
  const levelOf = (teamId: string): AccessLevel => levelDraft[teamId] ?? serverLevel(teamId);
  const others = teams.filter((x) => x.id !== home);
  const moved = !!view && !!home && home !== view.homeTeamId;
  const dirty = !isNew && !!view && (moved || others.some((x) => levelOf(x.id) !== serverLevel(x.id)));

  useEditorSection('teams:teams', {
    label: 'Teams',
    dirty: () => dirty,
    async save() {
      if (isNew || !view || !dirty) return;
      // Move first (access to the new home team falls away), then the levels that differ from the server.
      if (moved) await teamsApi.setHome(home, agent.id);
      for (const x of others) if (levelOf(x.id) !== serverLevel(x.id)) await teamsApi.setAccess(x.id, agent.id, levelOf(x.id));
      setHomeDraft(null);
      setLevelDraft({});
      await load();
    },
  });

  if (isNew) {
    const chosen = (typeof agent.settings?.homeTeam === 'string' && teams.some((x) => x.id === agent.settings.homeTeam) ? agent.settings.homeTeam : '') || activeTeamId() || teams[0]?.id || '';
    return (
      <div className="space-y-3" data-testid="bot-teams">
        <Field label="Thuisteam" hint="Toegang tot andere teams kies je na het aanmaken.">
          <Select value={chosen} onChange={(e) => onChange({ settings: { ...(agent.settings || {}), homeTeam: e.target.value } })}>
            {teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    );
  }

  if (err && !view) return <p className="text-sm text-danger">{err}</p>;
  if (!view) return <Spinner />;
  const homeTeam = teams.find((x) => x.id === home);
  const name = agent.name || 'de bot';
  return (
    <div className="space-y-4" data-testid="bot-teams">
      <Field label="Thuisteam" hint="Hier werkt de bot, met de map en sleutels van dit team.">
        <Select value={home} onChange={(e) => setHomeDraft(e.target.value)}>
          {teams.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
        </Select>
      </Field>
      {moved && homeTeam && (
        <p className="flex items-start gap-1.5 text-xs leading-relaxed text-warn" role="status">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
          <span>{t('Bij opslaan verhuist {0} naar {1}. Was hij teamleider van zijn huidige team, dan niet meer.', name, homeTeam.name)}</span>
        </p>
      )}
      <fieldset className="space-y-2">
        <legend className="text-[13px] font-semibold">Toegang tot andere teams</legend>
        <ul className="divide-y divide-line rounded-xl border border-line">
          {others.map((x) => (
            <li key={x.id} className="flex flex-wrap items-center gap-x-3 gap-y-1.5 px-3 py-2">
              <span className="flex min-w-0 flex-1 items-center gap-2 text-sm font-medium">
                <TeamDot color={x.color} />
                <span className="truncate" translate="no">
                  {x.name}
                </span>
              </span>
              <Select className="w-auto" value={levelOf(x.id)} onChange={(e) => setLevelDraft((l) => ({ ...l, [x.id]: e.target.value as AccessLevel }))} aria-label={t('Toegang van {0} tot {1}', name, x.name)}>
                {LEVELS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </li>
          ))}
        </ul>
        <MoreInfo className="block">Meekijken: de bot leest de teammap, maar verandert niets. Aansturen: de bot geeft ook taken aan dat team.</MoreInfo>
      </fieldset>
    </div>
  );
}
