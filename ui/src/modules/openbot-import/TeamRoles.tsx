import { Crown, ExternalLink, FolderOpen, GraduationCap, SquareKanban, Users } from 'lucide-react';
import { Badge, Card, Field, Input, Select } from '../../components/ui';
import { t, uiLocale } from '../../lib/i18n';
import { formatNumber } from '../../lib/format';
import type { Plan, PlanSpecialist } from './api';
import { Check, Section } from './parts';

/** The team the bots go into: a new one (with a name) or an existing one. */
export interface TeamPick {
  mode: 'new' | 'existing';
  id: string;
  name: string;
}

/** Main bot, team lead (OpenBot agent ids, '' = none) and the specialists. */
export interface RolePick {
  main: string;
  lead: string;
  specialists: Record<string, { selected: boolean; field: string }>;
}

const same = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/** A new team's name that is empty or already taken (the import refuses it). */
export function teamProblem(plan: Plan, team: TeamPick): string {
  if (!plan.team.available || team.mode !== 'new') return '';
  if (!team.name.trim()) return 'Geef het team een naam.';
  if (plan.team.existing.some((x) => same(x.name, team.name))) return 'Er is al een team met deze naam. Kies een andere naam, of kies dat team bij “In welk team”.';
  return '';
}

export function TeamSection({ plan, team, onTeam, shared, onShared, teamData, onTeamData }: { plan: Plan; team: TeamPick; onTeam(v: TeamPick): void; shared: boolean; onShared(v: boolean): void; teamData: boolean; onTeamData(v: boolean): void }) {
  const tp = plan.team;
  const chosen = team.mode === 'existing' ? tp.existing.find((x) => x.id === team.id) || null : null;
  const problem = teamProblem(plan, team);
  // The folder the chosen team has now (a new team has none); without teams, the single team folder.
  const current = tp.available ? chosen?.folder || null : plan.shared.current?.path || null;
  const otherFolder = !!current && !same(current, plan.shared.path);
  const rows = plan.teamData ? plan.teamData.tables.reduce((n, x) => n + x.rows, 0) : 0;
  return (
    <Section icon={<Users className="h-4 w-4" />} title="Team">
      <Card className="space-y-4 px-4 py-4">
        {!tp.available ? (
          <p className="text-sm text-muted">Teams staan in deze TeamBot niet aan: de bots komen zonder team.</p>
        ) : (
          <div className="space-y-2">
            <p className="text-sm">Je OpenBot-bots komen samen in één team, met de gedeelde map als teammap en de teamtabellen erbij.</p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="In welk team">
                <Select value={team.mode === 'new' ? '' : team.id} onChange={(e) => onTeam(e.target.value ? { ...team, mode: 'existing', id: e.target.value } : { ...team, mode: 'new' })}>
                  <option value="">Nieuw team</option>
                  {tp.existing.map((x) => (
                    <option key={x.id} value={x.id}>
                      {t('{0} ({1, plural, one {# bot} other {# bots}})', x.name, x.bots)}
                    </option>
                  ))}
                </Select>
              </Field>
              {team.mode === 'new' && (
                <Field label="Naam van het team" hint={tp.nameFromOpenBot ? 'Voorstel: de naam van je OpenBot-werkruimte.' : 'Je kunt de naam later nog wijzigen.'}>
                  <Input value={team.name} maxLength={60} onChange={(e) => onTeam({ ...team, name: e.target.value })} />
                </Field>
              )}
            </div>
            {problem && (
              <p role="alert" className="text-sm text-danger">
                {problem}
              </p>
            )}
            {chosen?.earlier && <p className="text-xs text-muted">Dit team maakte een eerdere import; nieuwe bots en rijen komen erbij.</p>}
          </div>
        )}

        {plan.shared.exists && (
          <div className="flex items-start gap-3 border-t border-line pt-3">
            <Check checked={shared} onChange={onShared} label="Gedeelde map als teammap" />
            <div className="min-w-0 space-y-1 text-sm">
              <div className="flex items-center gap-1.5 font-medium">
                <FolderOpen className="h-4 w-4 text-accent" /> Teammap
              </div>
              <div>
                De bots van het team lezen en schrijven in <code className="break-all">{plan.shared.path}</code>
              </div>
              <div className="text-xs text-muted">
                Dezelfde map als in OpenBot: er wordt niets gekopieerd en de import verandert er niets in. Inhoud: {plan.shared.entries.slice(0, 12).join(', ') || 'leeg'}
                {plan.shared.entries.length > 12 ? ', …' : ''}
              </div>
              {otherFolder && <div className="text-xs text-warn">{t('Dit team heeft al een andere teammap ({0}); die blijft staan.', current!)}</div>}
            </div>
          </div>
        )}

        {plan.teamData && plan.teamData.tables.length > 0 && (
          <div className="flex items-start gap-3 border-t border-line pt-3">
            <Check checked={teamData} disabled={!plan.teamData.available} onChange={onTeamData} label="Teamtabellen overnemen" />
            <div className="min-w-0 flex-1 space-y-1.5 text-sm">
              <div className="flex items-center gap-1.5 font-medium">
                <SquareKanban className="h-4 w-4 text-accent" /> {t('Teamtabellen · {0, plural, one {# rij} other {# rijen}}', formatNumber(rows))}
              </div>
              <div>Taken, beslissingen en tabellen uit OpenBot komen in Teamwerk.</div>
              <ul className="flex flex-wrap gap-1.5">
                {plan.teamData.tables.map((x) => (
                  <li key={x.name} className="rounded-full bg-surface-3 px-2 py-0.5 text-xs">
                    <span className="font-mono">{x.name}</span> {x.rows.toLocaleString(uiLocale())}
                    {x.imported ? <span className="text-muted"> · {t('{0} al overgenomen', x.imported.toLocaleString(uiLocale()))}</span> : null}
                  </li>
                ))}
              </ul>
              <div className="text-xs text-muted">
                {plan.teamData.perTeam || tp.tablesPerTeam ? 'Ze komen in de teamdatabase van dit team.' : 'Ze komen in de teamdatabase.'} Er wordt gekopieerd; de database van OpenBot blijft ongewijzigd. Nogmaals overnemen voegt alleen nieuwe rijen toe.
              </div>
            </div>
          </div>
        )}
      </Card>
    </Section>
  );
}

function SpecialistRow({ s, available, pick, onPick }: { s: PlanSpecialist; available: boolean; pick: { selected: boolean; field: string }; onPick(v: { selected: boolean; field: string }): void }) {
  const on = available && pick.selected;
  return (
    <div className="space-y-2 rounded-xl border border-line bg-surface-2 px-3 py-3">
      <div className="flex flex-wrap items-center gap-2">
        {available && <Check checked={pick.selected} onChange={(v) => onPick({ ...pick, selected: v })} label={`${s.name} als specialist`} />}
        <span className="text-sm font-medium">{s.name}</span>
        <Badge tone={on ? 'accent' : 'neutral'}>{on ? 'specialist' : 'gewone bot'}</Badge>
      </div>
      <p className="text-xs text-muted">{s.reason}</p>
      {on ? (
        <Field label="Vakgebied" hint="Eén zin; uit zijn instructies gehaald.">
          <Input value={pick.field} maxLength={300} onChange={(e) => onPick({ ...pick, field: e.target.value })} />
        </Field>
      ) : (
        <p className="text-xs">
          <span className="font-medium">Vakgebied:</span> {s.field || 'niet gevonden'}
        </p>
      )}
      {s.sources.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium">{t('Bronnen ({0})', s.sources.length)}</div>
          <ul className="flex flex-wrap gap-1.5">
            {s.sources.map((x) => (
              <li key={x.url || x.label} className="max-w-full truncate rounded-full bg-surface-3 px-2 py-0.5 text-xs">
                {x.url ? (
                  <a href={x.url} target="_blank" rel="noreferrer noopener" className="inline-flex items-center gap-1 hover:text-accent">
                    {x.label} <ExternalLink className="h-3 w-3" aria-hidden />
                  </a>
                ) : (
                  x.label
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
      {s.rounds.length > 0 && <p className="text-xs text-muted">{t('Leerrondes, die uit staan tot jij ze aanzet: {0}', s.rounds.join(', '))}</p>}
    </div>
  );
}

export function RolesSection({ plan, roles, onRoles, selected, team }: { plan: Plan; roles: RolePick; onRoles(v: RolePick): void; selected: Set<string>; team: TeamPick }) {
  const r = plan.roles;
  const bots = plan.bots.filter((b) => selected.has(b.key));
  const canMain = r.mainAvailable && !r.currentMain;
  const chosen = team.mode === 'existing' ? plan.team.existing.find((x) => x.id === team.id) || null : null;
  const specialists = r.specialists.filter((s) => selected.has(s.key));
  if (!r.leadAvailable && !canMain && !specialists.length) return null;
  return (
    <Section icon={<Crown className="h-4 w-4" />} title="Rollen">
      <Card className="space-y-4 px-4 py-4">
        {r.note && <p className="text-sm">{r.note}</p>}
        {r.bossReason && <p className="text-xs text-muted">{r.bossReason}</p>}
        <div className="grid gap-3 sm:grid-cols-2">
          {canMain ? (
            <Field label="Hoofdbot" hint="Je vaste aanspreekpunt boven alle teams. Er is er hoogstens één.">
              <Select value={roles.main} onChange={(e) => onRoles({ ...roles, main: e.target.value, lead: roles.lead === e.target.value ? '' : roles.lead })}>
                <option value="">Geen hoofdbot</option>
                {bots.map((b) => (
                  <option key={b.key} value={b.key}>
                    {b.name}
                  </option>
                ))}
              </Select>
            </Field>
          ) : (
            r.currentMain &&
            !r.note && (
              <div className="space-y-0.5 text-sm">
                <div className="font-medium">Hoofdbot</div>
                <p className="text-xs text-muted">{t('Je hoofdbot is {0}. Er kan er maar één zijn, dus deze import maakt geen tweede.', r.currentMain.name)}</p>
              </div>
            )
          )}
          {r.leadAvailable && (
            <Field label="Teamleider" hint={chosen?.lead ? t('{0} heeft al een teamleider ({1}); die blijft.', chosen.name, chosen.lead) : 'Heeft het laatste woord in het team.'}>
              <Select value={roles.lead} disabled={!!chosen?.lead} onChange={(e) => onRoles({ ...roles, lead: e.target.value })}>
                <option value="">Geen teamleider</option>
                {bots
                  .filter((b) => b.key !== roles.main)
                  .map((b) => (
                    <option key={b.key} value={b.key}>
                      {b.name}
                    </option>
                  ))}
              </Select>
            </Field>
          )}
        </div>
        {specialists.length > 0 && (
          <div className="space-y-2 border-t border-line pt-3">
            <div className="flex items-center gap-1.5 text-sm font-medium">
              <GraduationCap className="h-4 w-4 text-accent" /> Specialisten
            </div>
            {!r.specialistsAvailable && <p className="text-xs text-muted">{r.specialistsNote}</p>}
            {specialists.map((s) => (
              <SpecialistRow key={s.key} s={s} available={r.specialistsAvailable} pick={roles.specialists[s.key] || { selected: s.selected, field: s.field }} onPick={(v) => onRoles({ ...roles, specialists: { ...roles.specialists, [s.key]: v } })} />
            ))}
          </div>
        )}
      </Card>
    </Section>
  );
}
