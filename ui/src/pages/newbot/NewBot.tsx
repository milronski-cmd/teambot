import { useState } from 'react';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate, query } from '../../lib/router';
import { t } from '../../lib/i18n';
import type { Agent, ToolGroup } from '../../lib/types';
import { Button, Card, Field, Input, Page, PageHeader, Spinner, cx, toast, useAsync } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { MoreOptions } from '../../components/MoreOptions';
import { encodeFace, faceColor, randomTraits } from '../../lib/botface';
import { activeTeamId } from '../../modules/teams/scope';
import { NewBotTeam } from '../../modules/teams/NewBotTeam';
import { BotKindQuestion, EngineChoices, connectChoice, useEngineChoices } from './Questions';
import { DEFAULT_RULES } from './choices';
import { STARTERS } from './starters';

/** The tools a bot starts with when the list of parts cannot be read. */
const DEFAULT_TOOLS = ['files', 'web', 'shell', 'memory', 'team', 'skills', 'routines', 'channels'];
/** Parts that follow from where the bot works (set under Computer & bestanden), not from "Automatisch". */
const COMPUTER_GROUPS = new Set(['browser', 'desktop', 'rehearsal', 'container', 'remote']);

/**
 * #/agents/new: a name, a role if you like, done. The AI is the best one that is connected (to change under "Meer
 * opties", with the kind of bot); the rules, tools and rights get good defaults and are changed later on
 * the bot's own page.
 */
export function NewBot() {
  // From the first screen: the engine the person just chose (#/agents/new?ai=<provider>) is the suggestion.
  const engines = useEngineChoices(true, query().get('ai'));
  const firstBot = useApp((s) => !s.agents.some((a) => !a.archived));
  const [seed] = useState(() => 'new-' + Math.random().toString(36).slice(2));
  const [d, setD] = useState<Partial<Agent>>(() => {
    const face = randomTraits();
    return { name: '', role: '', avatar: encodeFace(face), color: faceColor('x', face), settings: activeTeamId() ? { homeTeam: activeTeamId() } : {} };
  });
  const set = (p: Partial<Agent>) => setD((x) => ({ ...x, ...p }));
  // The engine follows the suggestion until the user picks one himself.
  const [picked, setPicked] = useState('');
  const engineKey = engines.choices.some((c) => c.key === picked) ? picked : engines.choices[0]?.key || '';
  const choice = engines.choices.find((c) => c.key === engineKey);
  const [more, setMore] = useState(false);
  const save = useAsync();
  // A role picked from the examples brings its rules and tools, as long as the role is not changed by hand.
  const starter = STARTERS.find((s) => s.role === d.role?.trim());

  const pickRole = (s: (typeof STARTERS)[number]) => set({ role: s.role, ...(d.name?.trim() && !STARTERS.some((x) => x.name === d.name) ? {} : { name: s.name, avatar: s.avatar, color: s.color }) });

  const submit = () =>
    save.run(async () => {
      const name = d.name?.trim();
      if (!name) throw new Error('Geef de bot een naam');
      if (!choice) throw new Error('Koppel eerst een AI');
      // An engine that was only found on this PC is connected now (no key needed).
      const p = await connectChoice(choice);
      const role = d.role?.trim() || '';
      // "Automatisch": a new bot gets every part it can use (what it may do with them is its access level, "Vraagt
      // toestemming"); only what is needed in a turn is sent to the model (server/tools/selection.ts).
      const parts = await api
        .get<{ groups: ToolGroup[] }>('/tools')
        .then((r) => r.groups.filter((g) => !g.always && !COMPUTER_GROUPS.has(g.id.split(':')[0])).map((g) => g.id))
        .catch(() => [] as string[]);
      const a = await api.post<Agent>('/agents', {
        name,
        avatar: d.avatar,
        color: d.color,
        role,
        description: starter?.description || role,
        instructions: starter?.instructions || DEFAULT_RULES,
        provider_id: p.id,
        model: '',
        access_mode: 'ask',
        tool_groups: parts.length ? parts : DEFAULT_TOOLS,
        busy_policy: 'queue',
        settings: d.settings || {},
      });
      useApp.setState((s) => ({ agents: [...s.agents.filter((x) => x.id !== a.id), a] }));
      toast(t('{0} is aangemaakt', a.name), 'ok');
      navigate(`/a/${a.id}`);
    });

  return (
    <Page>
      <PageHeader width="xl" back={firstBot ? { href: '#/', label: 'Terug' } : { href: '#/agents', label: 'Alle bots' }} title={firstBot ? 'Je eerste bot' : 'Nieuwe bot'} subtitle="Een naam is genoeg. De rest pas je later aan." />
      <form
        className="mx-auto max-w-xl space-y-4 px-4 py-5 sm:px-6"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <Card className="space-y-5 p-5" data-testid="new-bot-questions">
          <div className="flex items-end gap-4">
            <BotAvatar bot={{ id: seed, name: d.name, avatar: d.avatar }} size={56} />
            <Field label="Naam" className="min-w-0 flex-1">
              <Input value={d.name || ''} onChange={(e) => set({ name: e.target.value })} maxLength={80} placeholder="Bijv. Mila" autoFocus autoComplete="off" />
            </Field>
          </div>
          <div className="space-y-2">
            <Field label="Rol (mag leeg blijven)">
              <Input value={d.role || ''} onChange={(e) => set({ role: e.target.value })} maxLength={120} placeholder="Bijv. Onderzoeker" autoComplete="off" />
            </Field>
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Voorbeelden">
              {STARTERS.map((s) => (
                <button
                  key={s.name}
                  type="button"
                  aria-pressed={starter === s}
                  onClick={() => pickRole(s)}
                  className={cx(
                    'inline-flex h-7 items-center rounded-full border px-3 text-[12.5px] font-semibold transition-colors coarse:h-10',
                    starter === s ? 'border-fg bg-surface-3 text-fg' : 'border-line text-muted hover:bg-surface-2 hover:text-fg',
                  )}
                >
                  {s.name}
                </button>
              ))}
            </div>
          </div>
          {/* With an AI connected this is one quiet line; without one, the ways to get one are the next step. */}
          {engines.loading ? (
            <p className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> Even kijken welke AI er op deze pc staat…
            </p>
          ) : !choice ? (
            <EngineChoices engines={engines} engineKey={engineKey} onEngine={setPicked} />
          ) : (
            !more && (
              <p className="text-xs text-muted" data-testid="new-bot-engine">
                {t('Werkt met {0}.', choice.label)}{' '}
                <button type="button" className="font-semibold text-fg underline-offset-2 hover:underline coarse:min-h-11" onClick={() => setMore(true)}>
                  Wijzigen
                </button>
              </p>
            )
          )}
          {/* With two or more teams: which team the bot lands in, and a way to pick another right here. */}
          <NewBotTeam draft={d} onChange={set} />
          <Button type="submit" variant="primary" size="lg" className="w-full justify-center" loading={save.busy} disabled={!d.name?.trim() || !choice}>
            Bot aanmaken
          </Button>
        </Card>
        {!!choice && (
          <MoreOptions key={String(more)} defaultOpen={more}>
            <fieldset>
              <legend className="text-[13px] font-semibold">Welke AI gebruikt hij?</legend>
              <EngineChoices engines={engines} engineKey={engineKey} onEngine={setPicked} />
            </fieldset>
            {!firstBot && <BotKindQuestion draft={d} set={set} />}
          </MoreOptions>
        )}
      </form>
    </Page>
  );
}
