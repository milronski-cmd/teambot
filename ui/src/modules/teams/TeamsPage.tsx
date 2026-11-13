import { useEffect, useMemo, useState } from 'react';
import { Copy, LayoutTemplate, Plus, Trash2, Users, Bot } from 'lucide-react';
import { askConfirm, Badge, Button, Card, EmptyState, Field, Input, Modal, Page, PageHeader, Select, Spinner, Textarea, cx, toast, toastError, useAsync, CardHead } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatUsd } from '../../lib/format';
import { TeamFolderSettings } from '../folders/Pages';
import { TeamChainCard } from './TeamChain';
import { OwnRules } from '../botrules/OwnRules';
import { TeamTemplateWizard } from '../templates/TeamTemplateWizard';
import { MoreInfo } from '../../components/MoreInfo';
import { Fold, Menu, Skeleton, SkeletonCards } from '../../components/overview';
import { type AccessLevel, type Team, type TeamKey, type TeamProfile, TEAM_COLORS, teamsApi, useTeams } from './api';

const KIND_LABEL: Record<TeamKey['kind'], string> = { provider: 'AI-provider', app: 'App', login: 'Login', script: 'Sleutel voor scripts' };

function Dot({ color, className }: { color: string; className?: string }) {
  return <span aria-hidden className={cx('inline-block h-3 w-3 shrink-0 rounded-full', className)} style={{ background: color }} />;
}

/**
 * #/m/teams[/<teamId>]: the same settings as Instellingen › Teams, for links to one team (the team switcher's "Teams
 * beheren"). Shown inside Instellingen with Teams marked (lib/palette.ts HOSTED_DETAIL), which gives the way back.
 */
export function TeamsPage({ params }: { params: string[] }) {
  return (
    <Page>
      <PageHeader title="Teams" subtitle="Elk team werkt apart." />
      <div className="mx-auto max-w-4xl px-4 pb-8 pt-3 sm:px-6">
        <TeamsManager initial={params[0]} />
      </div>
    </Page>
  );
}

/** Instellingen › Teams. With one team only that team's settings; team choices appear from the second team on. */
export function TeamsSettings({ simple }: { simple?: boolean } = {}) {
  return <TeamsManager simple={simple} />;
}

/** `simple` (Instellingen › Bots en teams › Teams): choose a team, its name, a new team. The rest is under Geavanceerd. */
function TeamsManager({ initial, simple }: { initial?: string; simple?: boolean }) {
  const { teams, err, reload } = useTeams();
  const [sel, setSel] = useState<string | null>(initial || null);
  const [creating, setCreating] = useState(false);
  // The 15 team templates (webshop, SEO, privé …) were only on the first-run screen; here they stay reachable.
  const [fromTemplate, setFromTemplate] = useState(false);
  const copy = useAsync();
  if (!teams)
    return err ? (
      <EmptyState icon={<Users />} title="De teams konden niet laden" action={<Button onClick={reload}>Opnieuw</Button>}>
        {err}
      </EmptyState>
    ) : (
      <div className="space-y-4">
        <Skeleton className="h-9 w-64" />
        <SkeletonCards n={2} className="!grid-cols-1" />
      </div>
    );
  const multi = teams.length > 1;
  const team = teams.find((x) => x.id === sel) || teams[0] || null;
  const remove = async (team: Team) => {
    if (!(await askConfirm(`Team “${team.name}” verwijderen? Dat kan alleen zonder bots en sleutels.`, { ok: 'Verwijderen', danger: true }))) return;
    try {
      await teamsApi.remove(team.id);
      toast('Team verwijderd', 'ok');
      setSel(null);
      reload();
    } catch (e) {
      toastError(e);
    }
  };
  const duplicate = async (team: Team) => {
    if (
      !(await askConfirm(
        t('Team “{0}” dupliceren? Bots en bedrijfsprofiel worden gekopieerd; geheugen, gesprekken, sleutels en kanalen niet.', team.name),
        { ok: 'Dupliceren' },
      ))
    )
      return;
    await copy.run(async () => {
      const r = await teamsApi.duplicate(team.id);
      toast(t('Team “{0}” gemaakt', r.team.name), 'ok');
      if (r.mainSkipped) toast(t('{0} is je hoofdbot en staat boven de teams; die is niet gekopieerd.', r.mainSkipped));
      reload();
      setSel(r.team.id);
    });
  };
  return (
    <div className="space-y-4">
      {!team ? (
        <EmptyState
          icon={<Users />}
          title="Nog geen team"
          action={
            <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
              Team maken
            </Button>
          }
        >
          Je eerste team ontstaat met je eerste bot.
        </EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2">
            {multi && (
              <div className="flex min-w-0 flex-1 basis-full flex-wrap items-center gap-1.5 sm:basis-0" role="group" aria-label="Kies een team">
                {teams.map((x) => (
                  <Button key={x.id} size="sm" className="rounded-full" variant={x.id === team.id ? 'soft' : 'ghost'} aria-pressed={x.id === team.id} onClick={() => setSel(x.id)}>
                    <Dot color={x.color} />
                    {x.name}
                    <span className="text-xs font-medium text-muted">{t('{0, plural, one {# bot} other {# bots}}', x.bots.length)}</span>
                  </Button>
                ))}
              </div>
            )}
            <div className="ms-auto flex items-center gap-2">
              {!simple && <Menu
                label="Meer opties"
                items={[
                  { label: 'Team uit een sjabloon', icon: <LayoutTemplate />, onSelect: () => setFromTemplate(true) },
                  { label: 'Alle teams bekijken', icon: <Users />, href: '#/m/teams/alle' },
                  'sep',
                  { label: t('{0} dupliceren', team.name), icon: <Copy />, disabled: copy.busy, onSelect: () => void duplicate(team) },
                  multi && { label: t('{0} verwijderen', team.name), icon: <Trash2 />, danger: true, onSelect: () => void remove(team) },
                ]}
              />}
              <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
                Nieuw team
              </Button>
            </div>
          </div>
          <TeamEditor key={team.id} team={team} teams={teams} reload={reload} simple={simple} />
        </>
      )}
      <Modal open={fromTemplate} onClose={() => setFromTemplate(false)} title="Team uit een sjabloon" wide>
        {fromTemplate && <TeamTemplateWizard onCancel={() => setFromTemplate(false)} />}
      </Modal>
      <NewTeamModal
        open={creating}
        count={teams.length}
        onClose={() => setCreating(false)}
        onCreated={(id) => {
          setCreating(false);
          setSel(id);
          reload();
        }}
      />
    </div>
  );
}

/** "Nieuw team": a name, a colour of its own; the team starts empty. Also used by the team switcher. */
export function NewTeamModal({ open, count, onClose, onCreated }: { open: boolean; count: number; onClose(): void; onCreated(id: string): void }) {
  const [name, setName] = useState('');
  const save = useAsync();
  useEffect(() => {
    if (open) setName('');
  }, [open]);
  const create = () =>
    save.run(async () => {
      const team = await teamsApi.create({ name: name.trim(), color: TEAM_COLORS[count % TEAM_COLORS.length] });
      onCreated(team.id);
    }, 'Team gemaakt');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Nieuw team"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="primary" loading={save.busy} disabled={!name.trim()} onClick={create}>
            Team maken
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Naam" hint="Een team begint zonder bots. Je hoofdbot kan er meteen werk geven; andere bots alleen als je ze toegang geeft.">
          <Input value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && name.trim() && create()} autoFocus maxLength={60} placeholder="Bijvoorbeeld een bedrijf of afdeling" />
        </Field>
      </div>
    </Modal>
  );
}

/** Cards of other modules inside a fold: the fold is the card, so their own border and padding go. */
const BARE = '[&>div]:rounded-none [&>div]:border-0 [&>div]:bg-transparent [&>div]:p-0';
const GROW = '[field-sizing:content] max-h-80';

function TeamEditor({ team, teams, reload, simple }: { team: Team; teams: Team[]; reload(): void; simple?: boolean }) {
  const multi = teams.length > 1;
  const [name, setName] = useState(team.name);
  const [color, setColor] = useState(team.color);
  const [lead, setLead] = useState(team.leadAgentId || '');
  const [profile, setProfile] = useState<TeamProfile>(team.profile);
  const save = useAsync();
  const dirty = name !== team.name || color !== team.color || lead !== (team.leadAgentId || '') || (Object.keys(profile) as (keyof TeamProfile)[]).some((k) => profile[k] !== team.profile[k]);
  const setP = (k: keyof TeamProfile, v: string) => setProfile((p) => ({ ...p, [k]: v }));
  const colors = TEAM_COLORS.includes(team.color) ? TEAM_COLORS : [...TEAM_COLORS, team.color];
  const submit = () =>
    save.run(async () => {
      await teamsApi.update(team.id, { name: name.trim(), color, leadAgentId: lead || null, profile });
      reload();
    }, 'Team opgeslagen');
  const filled = (Object.keys(team.profile) as (keyof TeamProfile)[]).filter((k) => team.profile[k]).length;
  return (
    <div className="tb-in space-y-4">
      <Card className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Naam">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={60} />
          </Field>
          {!simple && (
          <Field
            label="Teamleider"
            hint={
              <>
                Niet verplicht.{' '}
                <MoreInfo>De bot met het laatste woord in dit team.</MoreInfo>
              </>
            }
          >
            <Select value={lead} onChange={(e) => setLead(e.target.value)}>
              <option value="">Geen teamleider</option>
              {team.bots.filter((b) => !b.main).map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </Select>
          </Field>
          )}
        </div>
        {!simple && (
          <>
        <fieldset>
          <legend className="mb-1.5 text-[13px] font-semibold">Kleur</legend>
          <div className="flex flex-wrap gap-2">
            {colors.map((c, i) => (
              <button
                key={c}
                type="button"
                aria-pressed={c === color}
                aria-label={t('Kleur {0}', i + 1)}
                onClick={() => setColor(c)}
                className={cx('h-8 w-8 rounded-full border-2 transition-transform focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 coarse:h-10 coarse:w-10', c === color ? 'scale-110 border-fg' : 'border-transparent')}
                style={{ background: c }}
              />
            ))}
          </div>
        </fieldset>
        <Fold card={false} title="Bedrijfsprofiel" hint={filled ? undefined : 'Nog leeg'} defaultOpen={filled > 0}>
          <Field label="Naam van het bedrijf" hint="Elke bot van dit team krijgt dit profiel mee.">
            <Input value={profile.company} onChange={(e) => setP('company', e.target.value)} maxLength={120} />
          </Field>
          <Field label="Wat het bedrijf doet">
            <Textarea rows={2} className={GROW} value={profile.about} onChange={(e) => setP('about', e.target.value)} maxLength={2000} />
          </Field>
          <Field label="Toon">
            <Input value={profile.tone} onChange={(e) => setP('tone', e.target.value)} maxLength={500} placeholder="Bijvoorbeeld: vriendelijk, kort en formeel" />
          </Field>
          <Field label="Regels">
            <Textarea rows={2} className={GROW} value={profile.rules} onChange={(e) => setP('rules', e.target.value)} maxLength={4000} placeholder="Bijvoorbeeld: noem nooit prijzen zonder overleg" />
          </Field>
        </Fold>
          </>
        )}
        <div className="flex flex-wrap gap-2">
          <Button variant="primary" loading={save.busy} disabled={!dirty || !name.trim()} onClick={submit}>
            Opslaan
          </Button>
          {dirty && (
            <Button
              variant="ghost"
              onClick={() => {
                setName(team.name);
                setColor(team.color);
                setLead(team.leadAgentId || '');
                setProfile(team.profile);
              }}
            >
              Ongedaan maken
            </Button>
          )}
        </div>
      </Card>

      {!simple && (
        <>
      <TeamBots team={team} multi={multi} reload={reload} />
      {/* What a person rarely sets: one line each, opened when needed. */}
      <Fold title="Eigen regels" testId="team-fold-rules">
        <OwnRules teamId={team.id} />
      </Fold>
      {(multi || !!team.dailyBudgetUsd) && (
        <Fold title="Dagbudget" hint={team.dailyBudgetUsd ? t('{0} per dag', formatUsd(team.dailyBudgetUsd)) : undefined}>
          <TeamBudget team={team} reload={reload} />
        </Fold>
      )}
      {multi && (
        <Fold title="Gratis doorschakelen">
          <div className={BARE}>
            <TeamChainCard teamId={team.id} />
          </div>
        </Fold>
      )}
      <Fold title="Teammap">
        <div className={BARE}>
          <TeamFolderSettings teamId={team.id} bare />
        </div>
      </Fold>
      {multi && (
        <Fold title="Toegang voor bots van andere teams">
          <TeamAccess team={team} reload={reload} />
        </Fold>
      )}
      {multi && (
        <Fold title="Sleutels en logins">
          <TeamKeys team={team} teams={teams} />
        </Fold>
      )}
        </>
      )}
    </div>
  );
}

/**
 * The team's own daily budget (package B2): what its bots may spend together per day on paid AI, on top of the
 * owner's own daily budget. Shown from the second team on (or when one is set).
 */
function TeamBudget({ team, reload }: { team: Team; reload(): void }) {
  const cur = team.dailyBudgetUsd || 0;
  const [v, setV] = useState(cur ? String(cur) : '');
  const save = useAsync();
  useEffect(() => setV(cur ? String(cur) : ''), [team.id, cur]);
  const num = Math.max(0, Number(v.replace(',', '.')) || 0);
  return (
    <div className="space-y-3">
      <p className="text-[13px] text-muted">
        Wat de bots van dit team samen per dag aan betaalde AI mogen uitgeven.{' '}
        <MoreInfo>Komt bovenop je eigen dagbudget. Leeg of 0 = geen eigen dagbudget.</MoreInfo>
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <Field label="Per dag (USD)" className="w-40">
          <Input inputMode="decimal" value={v} onChange={(e) => setV(e.target.value)} placeholder="0" />
        </Field>
        <Button
          variant="primary"
          loading={save.busy}
          disabled={num === cur}
          onClick={() =>
            save.run(async () => {
              await teamsApi.update(team.id, { dailyBudgetUsd: num });
              reload();
            }, 'Dagbudget opgeslagen')
          }
        >
          Opslaan
        </Button>
      </div>
      {cur > 0 && <p className="text-sm">{t('Vandaag gebruikt: {0} van {1}.', formatUsd(team.spentToday || 0), formatUsd(cur))}</p>}
    </div>
  );
}

function TeamBots({ team, multi, reload }: { team: Team; multi: boolean; reload(): void }) {
  const [pick, setPick] = useState('');
  const move = useAsync();
  return (
    <Card className="space-y-3 p-5">
      <CardHead icon={Bot} tone="teal" title="Bots van dit team" />
      {team.bots.length ? (
        <ul className="-mx-2 grid gap-x-2 sm:grid-cols-2">
          {team.bots.map((b) => (
            <li key={b.id}>
              <a className="flex min-h-11 items-center gap-2.5 rounded-control px-2 py-1.5 text-sm hover:bg-surface-2" href={`#/a/${b.id}`}>
                <BotAvatar bot={b} size={28} />
                <span className="min-w-0 flex-1">
                  <span className="block font-medium [overflow-wrap:anywhere]">{b.name}</span>
                  {b.role && (
                    <span className="block text-[13px] text-muted [overflow-wrap:anywhere]" translate="no">
                      {b.role}
                    </span>
                  )}
                </span>
                {b.main ? <Badge tone="accent">hoofdbot</Badge> : b.lead ? <Badge tone="accent">teamleider</Badge> : null}
              </a>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Dit team heeft nog geen bots.</p>
      )}
      {multi && team.access.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-line pt-3 sm:flex-row">
          <Select className="sm:flex-1" value={pick} onChange={(e) => setPick(e.target.value)} aria-label="Bot naar dit team verplaatsen">
            <option value="">Bot van een ander team kiezen…</option>
            {team.access.map((a) => (
              <option key={a.agentId} value={a.agentId}>
                {t('{0} (nu in {1})', a.name, a.homeTeamName)}
              </option>
            ))}
          </Select>
          <Button
            disabled={!pick}
            loading={move.busy}
            onClick={() =>
              move.run(async () => {
                await teamsApi.setHome(team.id, pick);
                setPick('');
                reload();
              }, 'Bot verplaatst')
            }
          >
            Naar dit team verplaatsen
          </Button>
        </div>
      )}

    </Card>
  );
}

const LEVELS: { id: AccessLevel; label: string }[] = [
  { id: 'none', label: 'Geen toegang' },
  { id: 'read', label: 'Meekijken' },
  { id: 'direct', label: 'Aansturen' },
];

function TeamAccess({ team, reload }: { team: Team; reload(): void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const set = async (agentId: string, level: AccessLevel) => {
    setBusy(agentId);
    try {
      await teamsApi.setAccess(team.id, agentId, level);
      reload();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[13px] text-muted">
          Standaard zien ze niets van dit team.{' '}
          <MoreInfo>
            <strong className="font-medium text-fg">Meekijken</strong>: de bot leest de teammap van dit team, maar verandert niets. <strong className="font-medium text-fg">Aansturen</strong>: de bot geeft de teamleider en de bots van dit team taken, en mag meekijken.
          </MoreInfo>
        </p>
      </div>
      {team.access.length ? (
        <ul className="divide-y divide-line">
          {team.access.map((a) => (
            <li key={a.agentId} className="flex flex-wrap items-center gap-2 py-2">
              <BotAvatar bot={{ id: a.agentId, name: a.name, avatar: a.avatar }} size={24} />
              <span className="min-w-0 flex-1 text-sm">
                <span className="font-medium">{a.name}</span> <span className="text-muted">{a.main ? 'hoofdbot, stuurt standaard alle teams aan' : t('team {0}', a.homeTeamName)}</span>
              </span>
              <Select className="w-auto" value={a.level} disabled={busy === a.agentId} onChange={(e) => set(a.agentId, e.target.value as AccessLevel)} aria-label={t('Toegang van {0} tot {1}', a.name, team.name)}>
                {LEVELS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </Select>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted">Andere teams hebben nog geen bots.</p>
      )}
    </div>
  );
}

function TeamKeys({ team, teams }: { team: Team; teams: Team[] }) {
  const [keys, setKeys] = useState<TeamKey[] | null>(null);
  const [err, setErr] = useState('');
  const load = () =>
    teamsApi
      .keys()
      .then((k) => (setKeys(k), setErr('')))
      .catch((e) => setErr(e?.message || String(e)));
  useEffect(() => {
    load();
    return on('teams.changed', () => load());
  }, []);
  const byTeam = useMemo(() => new Map(teams.map((x) => [x.id, x])), [teams]);
  const set = async (k: TeamKey, teamId: string) => {
    try {
      await teamsApi.setKeyScope(k.kind, k.id, teamId || null);
      load();
    } catch (e) {
      toastError(e);
    }
  };
  return (
    <div className="space-y-3">
      <div>
        <p className="text-[13px] text-muted">
          Standaard voor alle teams.{' '}
          <MoreInfo>
            Zet een sleutel op één team, dan kunnen bots van andere teams hem niet gebruiken, ook niet als ze dat team mogen aansturen. Nieuwe sleutels voeg je toe onder AI-diensten, bij Apps of in de Kluis; daarna kies je hier voor welk team ze zijn.
          </MoreInfo>
        </p>
      </div>
      {err ? (
        <p className="text-sm text-danger">{err}</p>
      ) : !keys ? (
        <Spinner />
      ) : !keys.length ? (
        <p className="text-sm text-muted">Je hebt nog geen sleutels, apps of logins.</p>
      ) : (
        <ul className="divide-y divide-line">
          {keys.map((k) => {
            const owner = k.teamId ? byTeam.get(k.teamId) : null;
            return (
              <li key={`${k.kind}:${k.id}`} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 text-sm">
                  <span className="font-medium">{k.name}</span> <span className="text-muted">{k.detail && k.detail !== k.name ? `${KIND_LABEL[k.kind]} · ${k.detail}` : KIND_LABEL[k.kind]}</span>
                </span>
                {owner && owner.id === team.id && <Badge tone="accent">alleen dit team</Badge>}
                <Select className="w-auto" value={k.teamId || ''} onChange={(e) => set(k, e.target.value)} aria-label={t('Welke teams {0} mogen gebruiken', k.name)}>
                  <option value="">Alle teams</option>
                  {teams.map((x) => (
                    <option key={x.id} value={x.id}>
                      {t('Alleen {0}', x.name)}
                    </option>
                  ))}
                </Select>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
