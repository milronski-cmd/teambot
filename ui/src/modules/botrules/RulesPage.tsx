import { useEffect, useState } from 'react';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { t } from '../../lib/i18n';
import { Button, Card, EmptyState, Spinner } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { useTeams } from '../teams/api';
import { activeTeamId } from '../teams/scope';
import { OwnRules, RuleRow, type OwnRule } from './OwnRules';

/**
 * Instellingen › Regels: the owner's own rules in ONE place. A rule is a sentence in plain words ("Mail nooit naar
 * klanten zonder mij te vragen"); TeamBot shows what it makes of it and enforces it for every bot of the team. With
 * several teams you choose the team first. A rule that was made for one bot only (on that bot's page, under Meer
 * mogelijkheden) is listed below, so everything that holds is in view here and can be taken away here.
 */
export function RulesSettings() {
  const { teams, err, reload } = useTeams();
  const [sel, setSel] = useState<string>(() => activeTeamId());
  if (!teams)
    return err ? (
      <EmptyState title="De regels konden niet laden" action={<Button onClick={reload}>Opnieuw</Button>}>
        {err}
      </EmptyState>
    ) : (
      <Spinner />
    );
  const team = teams.find((x) => x.id === sel) || teams[0];
  if (!team)
    return (
      <Card className="p-5">
        <p className="text-sm text-muted">Je eerste team ontstaat met je eerste bot. Daarna schrijf je hier je regels.</p>
      </Card>
    );
  return (
    <>
      {teams.length > 1 && (
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Kies een team">
          {teams.map((x) => (
            <Button key={x.id} size="sm" className="rounded-full" variant={x.id === team.id ? 'soft' : 'ghost'} aria-pressed={x.id === team.id} onClick={() => setSel(x.id)}>
              <span className="inline-block h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: x.color }} aria-hidden />
              {x.name}
            </Button>
          ))}
        </div>
      )}
      <Card className="p-5">
        <OwnRules key={team.id} teamId={team.id} />
      </Card>
      <BotOnlyRules botIds={team.bots.map((b) => b.id)} />
    </>
  );
}

/** Rules that hold for one bot only: shown per bot, each with "Weghalen". Nothing when no bot has a rule of its own. */
function BotOnlyRules({ botIds }: { botIds: string[] }) {
  const agents = useApp((s) => s.agents);
  const device = useApp((s) => s.device);
  const [byBot, setByBot] = useState<Record<string, OwnRule[]>>({});
  const key = botIds.join(',');
  const load = () => {
    Promise.all(
      botIds.map((id) =>
        api
          .get<{ rules: OwnRule[] }>(`/bot-rules?agentId=${encodeURIComponent(id)}`)
          .then((d) => [id, d.rules || []] as const)
          .catch(() => [id, [] as OwnRule[]] as const),
      ),
    ).then((list) => setByBot(Object.fromEntries(list)));
  };
  useEffect(() => {
    load();
    return on('botrules.updated', () => load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  const withRules = botIds.filter((id) => byBot[id]?.length);
  if (!withRules.length) return null;
  return (
    <Card className="space-y-4 p-5" data-testid="bot-only-rules">
      <div>
        <h3 className="text-sm font-semibold">Regels voor één bot</h3>
        <p className="text-xs text-muted">Deze gelden alleen voor de bot die erbij staat.</p>
      </div>
      {withRules.map((id) => {
        const bot = agents.find((a) => a.id === id);
        return (
          <section key={id} className="space-y-2" aria-label={bot?.name}>
            <a href={`#/agents/${id}`} className="inline-flex items-center gap-2 text-sm font-medium hover:underline">
              {bot && <BotAvatar bot={bot} size={22} />}
              {bot?.name || t('Bot')}
            </a>
            <ul className="space-y-2">
              {byBot[id].map((r) => (
                <RuleRow key={r.id} r={r} mode={bot?.access_mode} device={device} onRemoved={load} />
              ))}
            </ul>
          </section>
        );
      })}
    </Card>
  );
}
