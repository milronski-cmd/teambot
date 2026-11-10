import type React from 'react';
import { useMemo, useState } from 'react';
import { CheckCircle2, GitCompare, KeyRound, LayoutGrid, Plus, ShieldAlert, ShieldCheck, Users } from 'lucide-react';
import { Button, Modal, cx, toast, useAsync } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useApp } from '../../lib/store';
import type { Agent } from '../../lib/types';
import { useFollowTeam } from '../teams/follow';
import type { CuratedCard, CuratedInstallResult, RegistryCard, StagingView } from './api';
import { AppIcon } from './AppIcon';
import { OTHER_ICON, type Tile } from './marketGroups';
import { CARD, CARD_OPEN, Signal } from './marketParts';

/**
 * The plain Marktplaats: subjects as a row of pills, one search box, cards with one sentence, one signal and one button
 * "Toevoegen", then one choice: for which bot or for the whole team. The checks (licence, scan, publisher) stay as they
 * were; on the card they are one small "Gecontroleerd", and a click on it shows what was checked. Licence, platform
 * and the rest are in the details, which the card itself opens.
 */

const ACRONYM = new Set(['seo', 'ai', 'sql', 'pdf', 'docx', 'pptx', 'xlsx', 'cro', 'kb', 'geo', 'crm', 'api', 'ui', 'ux']);

/** "seo-audit" → "SEO audit": the skill's folder name, readable. The name itself is never translated. */
export function niceName(name: string) {
  const w = name.split(/[-_]+/).filter(Boolean);
  if (!w.length) return name;
  return w.map((x, i) => (ACRONYM.has(x.toLowerCase()) ? x.toUpperCase() : i === 0 ? x[0].toUpperCase() + x.slice(1) : x)).join(' ');
}

/** Subjects as one quiet row of pills: "Alles" plus every group (and own category) that has entries. */
export function CategoryTiles({ tiles, value, onChange }: { tiles: Tile[]; value: string; onChange(id: string): void }) {
  const all: Tile = { id: '', label: 'Alles', icon: OTHER_ICON, count: 0 };
  return (
    <div className="scroll-thin -mx-1 flex gap-1.5 overflow-x-auto px-1 pb-1 sm:flex-wrap sm:overflow-visible" role="group" aria-label="Onderwerpen">
      {[all, ...tiles].map((tl) => {
        const Icon = tl.id === '' ? LayoutGrid : tl.icon;
        const on = value === tl.id;
        return (
          <button
            key={tl.id || 'alles'}
            type="button"
            aria-pressed={on}
            data-tile={tl.id || 'alles'}
            onClick={() => onChange(on && tl.id ? '' : tl.id)}
            className={cx(
              'inline-flex h-8 shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full border px-3 text-[13px] transition-colors coarse:h-10',
              on ? 'border-transparent bg-surface-3 font-semibold text-fg' : 'border-line font-medium text-muted hover:border-line-strong hover:text-fg',
            )}
          >
            <Icon className="h-3.5 w-3.5 shrink-0" aria-hidden />
            <span translate={tl.own ? 'no' : undefined}>{tl.label}</span>
          </button>
        );
      })}
    </div>
  );
}

// ---------------------------------------------------------------- the one signal of a skill card: "Gecontroleerd"

const windowsWarning = (c: CuratedCard) => (c.windows?.status === 'deels' ? 'Werkt deels op Windows' : '');

/**
 * The one signal on a catalogue skill: "Gecontroleerd" (with "scripts staan uit" when it brings scripts: what it can
 * do), or a warning (publisher look-alike, works only partly on Windows). A click shows what was checked.
 */
export function CheckedBadge({ c, onDetails }: { c: CuratedCard; onDetails?: () => void }) {
  const [open, setOpen] = useState(false);
  const warn = c.publisherStatus === 'lookalike';
  const win = windowsWarning(c);
  const text = warn ? 'Let op: uitgever' : win || (c.scripts ? 'Gecontroleerd · scripts staan uit' : 'Gecontroleerd');
  return (
    <>
      <button type="button" className="relative z-10 -my-1 inline-flex min-h-8 min-w-0 items-center rounded-control hover:underline coarse:min-h-11" aria-label={`${text}. Wat is gecontroleerd?`} onClick={() => setOpen(true)}>
        <Signal tone={warn || win ? 'warn' : 'ok'} icon={warn || win ? <ShieldAlert aria-hidden /> : <ShieldCheck aria-hidden />}>
          {text}
        </Signal>
      </button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="Wat TeamBot controleert">
          <ul className="space-y-3 text-sm">
            <li className="flex gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
              <span>
                <span className="font-medium">Licentie: {c.license}.</span> Een open licentie: gratis te gebruiken. TeamBot las het licentiebestand bij de bron na op {c.verifiedAt}.
              </span>
            </li>
            <li className="flex gap-2">
              {warn ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden /> : <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />}
              <span>
                <span className="font-medium">
                  Uitgever: <span translate="no">{c.publisher}</span> (<span translate="no">{c.repo}</span>).
                </span>{' '}
                {warn ? 'De naam lijkt op die van een bekende uitgever. TeamBot vraagt bij toevoegen eerst je bevestiging.' : c.publisherStatus === 'known' ? 'Een bekende uitgever.' : 'De bron is met de hand nagekeken voor de TeamBot-catalogus.'}
              </span>
            </li>
            <li className="flex gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
              <span>
                <span className="font-medium">Veiligheidsscan.</span> Bij toevoegen zoekt TeamBot naar verborgen opdrachten, geheimen en scripts. Vindt de scan iets, dan zie je dat eerst en beslis jij.
              </span>
            </li>
            <li className="flex gap-2">
              <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
              <span>
                <span className="font-medium">Vaste versie.</span> Je krijgt precies de versie van {c.commitDate}. Een nieuwe versie zie je eerst als verschil, en je kiest zelf of je bijwerkt.
              </span>
            </li>
            {c.scripts && (
              <li className="flex gap-2">
                <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-ok" aria-hidden />
                <span>
                  <span className="font-medium">Scripts staan uit.</span> Deze skill heeft scripts. Die draaien pas als jij de skill vertrouwt, en ook dan vraagt de bot elke keer toestemming.
                </span>
              </li>
            )}
          </ul>
          {onDetails && (
            <div className="mt-4 flex justify-end border-t border-line pt-3">
              <Button size="sm" onClick={() => (setOpen(false), onDetails())}>
                Alle details
              </Button>
            </div>
          )}
        </Modal>
      )}
    </>
  );
}

// ---------------------------------------------------------------- one card

/** A catalogue skill: its name, one sentence, one signal and one button. The card itself opens the details. */
export function SkillCard({ c, onAdd, onDetails, onDiff, forBot }: { c: CuratedCard; onAdd(): void; onDetails(): void; onDiff(): void; forBot?: Agent }) {
  const added = forBot ? !!c.installed && (forBot.skills || []).includes(c.installed.skillId) : !!c.installed;
  return (
    <div data-card="curated" data-skill={c.id} className={CARD}>
      <button type="button" className={CARD_OPEN} onClick={onDetails}>
        <span className="break-words" translate="no">
          {niceName(c.name)}
        </span>
      </button>
      <p className="mt-1 line-clamp-2 flex-1 break-words text-sm text-muted">{c.note}</p>
      <div className="mt-3 flex min-h-8 items-center justify-between gap-2">
        {added ? (
          <Signal tone="ok" icon={<CheckCircle2 aria-hidden />}>
            Toegevoegd
          </Signal>
        ) : (
          <CheckedBadge c={c} onDetails={onDetails} />
        )}
        <span className="relative z-10 shrink-0">
          {!added ? (
            <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} onClick={onAdd}>
              Toevoegen
            </Button>
          ) : c.installed?.update ? (
            <Button size="sm" icon={<GitCompare className="h-4 w-4" />} onClick={onDiff}>
              Nieuwe versie
            </Button>
          ) : (
            !forBot && (
              <Button size="sm" variant="ghost" onClick={onAdd}>
                Bots kiezen
              </Button>
            )
          )}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- "Voor wie?"

type Target = { kind: 'team'; id: string } | { kind: 'bot'; id: string };

/** Own bots that can get a skill (not archived, not someone else's shared bot). */
export function useOwnBots(): Agent[] {
  const agents = useApp((s) => s.agents);
  return useMemo(() => agents.filter((a) => !a.archived && !a.shared_from), [agents]);
}

/**
 * After "Toevoegen": one choice, for the whole team or for one bot. Installs the pinned version (as before) and turns
 * it on for those bots. Something to confirm (scan warning, publisher) goes to the regular review.
 */
export function AddDialog({ c, teamId, presetBot, onClose, onReview, onDone }: { c: CuratedCard; teamId: string; presetBot?: string; onClose(): void; onReview(s: StagingView): void; onDone(): void }) {
  const bots = useOwnBots();
  const team = useFollowTeam();
  const teams = team.multi ? team.teams : [];
  const firstTeam = teamId && teamId !== '*' ? teamId : team.activeId || teams[0]?.id || '';
  const [target, setTarget] = useState<Target>(presetBot ? { kind: 'bot', id: presetBot } : { kind: 'team', id: firstTeam });
  const { busy, run } = useAsync();
  const teamOfBot = (id: string) => teams.find((x) => (x.bots || []).some((b) => b.id === id))?.id || '';
  const botsOfTeam = (id: string) => (teams.length ? bots.filter((b) => teamOfBot(b.id) === id) : bots);
  const key = (x: Target) => `${x.kind}:${x.id}`;
  const add = () =>
    run(async () => {
      const place = target.kind === 'team' ? target.id : teamOfBot(target.id);
      const enableFor = (target.kind === 'team' ? botsOfTeam(target.id) : bots.filter((b) => b.id === target.id)).map((b) => b.id);
      const r = await api.post<CuratedInstallResult>('/skills/curated/install', { id: c.id, enableFor, ...(place ? { teamId: place } : {}) });
      if (r.staging) return onReview(r.staging);
      if (!(r.status === 'created' || r.status === 'installed') || !r.skillId) throw new Error(r.error || 'Toevoegen lukte niet');
      // Already there (for this team): the server leaves the bots as they are, so turn it on for the chosen bots here.
      if (r.status === 'installed')
        for (const id of enableFor) {
          const cur = await api.get<{ enabled: string[] }>(`/skills/agents/${encodeURIComponent(id)}`);
          if (!cur.enabled.includes(r.skillId)) await api.put(`/skills/agents/${encodeURIComponent(id)}`, { skillIds: [...cur.enabled, r.skillId] });
        }
      const who = target.kind === 'bot' ? bots.find((b) => b.id === target.id)?.name || '' : '';
      const skipped = r.notEnabled?.length || 0;
      toast(who ? `${niceName(c.name)} is toegevoegd aan ${who}.` : enableFor.length ? `${niceName(c.name)} is toegevoegd aan het hele team.` : `${niceName(c.name)} is toegevoegd. Zet de skill aan bij een bot zodra je er een hebt.`, 'ok');
      if (skipped) toast(t('{0, plural, one {# bot hoort bij een ander team en kreeg de skill niet.} other {# bots horen bij een ander team en kregen de skill niet.}}', skipped), 'neutral');
      onDone();
    });
  const option = (x: Target, label: React.ReactNode, sub: React.ReactNode, icon: React.ReactNode) => (
    <li key={key(x)}>
      <label className={cx('flex min-h-12 cursor-pointer items-center gap-3 rounded-lg border px-3 py-2', key(target) === key(x) ? 'border-accent bg-accent-soft' : 'border-line hover:border-accent')}>
        <input type="radio" name="add-target" className="h-4 w-4 shrink-0" checked={key(target) === key(x)} onChange={() => setTarget(x)} />
        {icon}
        <span className="min-w-0">
          <span className="block break-words text-sm font-medium">{label}</span>
          {sub && <span className="block break-words text-xs text-muted">{sub}</span>}
        </span>
      </label>
    </li>
  );
  return (
    <Modal
      open
      onClose={onClose}
      title={`${niceName(c.name)} toevoegen`}
      footer={
        <div className="flex flex-wrap justify-end gap-2">
          <Button onClick={onClose}>Annuleren</Button>
          <Button variant="primary" loading={busy} icon={<Plus className="h-4 w-4" />} onClick={add}>
            Toevoegen
          </Button>
        </div>
      }
    >
      <p className="mb-3 text-sm text-muted">{c.note}</p>
      <fieldset>
        <legend className="mb-2 text-sm font-semibold">Voor wie?</legend>
        <ul className="space-y-2">
          {teams.length
            ? teams.map((tm) =>
                option(
                  { kind: 'team', id: tm.id },
                  <>
                    Het hele team <span translate="no">{tm.name}</span>
                  </>,
                  t('{0, plural, =0 {Nog geen bots in dit team} one {# bot} other {# bots}}', botsOfTeam(tm.id).length),
                  <Users className="h-5 w-5 shrink-0 text-muted" aria-hidden />,
                ),
              )
            : option({ kind: 'team', id: '' }, 'Het hele team', bots.length ? t('{0, plural, one {# bot} other {# bots}}', bots.length) : 'Nog geen bots: de skill staat klaar voor later', <Users className="h-5 w-5 shrink-0 text-muted" aria-hidden />)}
          {bots.map((b) =>
            option(
              { kind: 'bot', id: b.id },
              <span translate="no">{b.name}</span>,
              b.role ? <span translate="no">{b.role}</span> : null,
              <BotAvatar bot={b} size={28} />,
            ),
          )}
        </ul>
      </fieldset>
    </Modal>
  );
}

// ---------------------------------------------------------------- an app

/** An app from the MCP register, as plain as a skill card: name, one sentence, one button. */
export function AppCard({ i, onAdd }: { i: RegistryCard; onAdd(): void }) {
  const upd = i.installed.some((x) => x.version !== i.version);
  return (
    <div data-card="app" className={CARD}>
      <div className="flex min-w-0 items-start gap-3">
        <AppIcon src={i.icon} title={i.title} name={i.name} />
        <div className="min-w-0">
          {/* An app from the public registry: its name, publisher and description are the publisher's words. */}
          <button type="button" className={cx(CARD_OPEN, 'block')} onClick={onAdd}>
            <span className="break-words" translate="no">
              {i.title}
            </span>
          </button>
          <div className="text-xs text-muted [overflow-wrap:anywhere]" translate="no">
            {i.publisher}
          </div>
        </div>
      </div>
      <p className="mt-2 line-clamp-2 flex-1 break-words text-sm text-muted" translate="no">
        {i.description}
      </p>
      <div className="mt-3 flex min-h-8 items-center justify-between gap-2">
        {i.installed.length ? (
          <Signal tone="ok" icon={<CheckCircle2 aria-hidden />}>
            {upd ? 'Toegevoegd · update beschikbaar' : 'Toegevoegd'}
          </Signal>
        ) : i.status === 'deprecated' ? (
          <Signal tone="warn" icon={<ShieldAlert aria-hidden />}>
            Verouderd
          </Signal>
        ) : i.needsSecrets ? (
          <Signal icon={<KeyRound aria-hidden />}>Account of sleutel nodig</Signal>
        ) : (
          <span />
        )}
        {!i.installed.length && (
          <span className="relative z-10 shrink-0">
            <Button size="sm" variant="primary" icon={<Plus className="h-4 w-4" />} disabled={!i.installable} onClick={onAdd}>
              Toevoegen
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
