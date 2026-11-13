import { useMemo, useState } from 'react';
import { CheckCircle2, GitCompare, KeyRound, LayoutGrid, Plus, ShieldAlert, ShieldCheck, Star } from 'lucide-react';
import { Button, Modal, cx, toast } from '../../components/ui';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { t, translate } from '../../lib/i18n';
import type { Agent } from '../../lib/types';
import type { CuratedCard, CuratedInstallResult, RegistryCard, StagingView } from './api';
import { AppIcon } from './AppIcon';
import { GROUPS, OTHER_ICON, groupIdOf, type Tile } from './marketGroups';
import { CARD, CARD_OPEN, Signal } from './marketParts';
import { starsText } from '../../../../shared/skills.js';

/**
 * The plain Marktplaats: subjects as a row of pills, one search box, cards with an icon, a name, one sentence, where the
 * skill comes from (stars on GitHub, repository) and one button "Toevoegen" that adds it for the whole team at once.
 * The checks (licence, scan, publisher) are one small "Gecontroleerd"; a click shows what was checked.
 */

const ACRONYM = new Set(['seo', 'ai', 'sql', 'pdf', 'docx', 'pptx', 'xlsx', 'cro', 'kb', 'geo', 'crm', 'api', 'ui', 'ux', 'tdd']);

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
      <button type="button" className="relative z-10 -my-1 inline-flex min-h-8 min-w-0 items-center rounded-control hover:underline coarse:min-h-11" aria-label={t('{0}. Wat is gecontroleerd?', translate(text))} onClick={() => setOpen(true)}>
        <Signal tone={warn || win ? 'warn' : 'ok'} icon={warn || win ? <ShieldAlert aria-hidden /> : <ShieldCheck aria-hidden />}>
          {text}
        </Signal>
      </button>
      {open && (
        <Modal open onClose={() => setOpen(false)} title="Wat TeamBot controleert">
          <ul className="space-y-3 text-sm">
            {c.stars ? (
              <li className="flex gap-2">
                <Star className="mt-0.5 h-4 w-4 shrink-0 fill-current text-warn" aria-hidden />
                <span>
                  <span className="font-medium">Sterren op GitHub: {starsText(c.stars)}.</span> Zoveel mensen gaven <span translate="no">{c.repo}</span> een ster (geteld op {c.verifiedAt}). De marktplaats zet de skills met de meeste sterren bovenaan.
                </span>
              </li>
            ) : null}
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
                  <span className="font-medium">Met scripts.</span> Deze skill heeft scripts. Na toevoegen werken ze meteen; of de bot eerst vraagt, hangt af van zijn toegang, zoals bij elke opdracht.
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

/** The icon of a skill: that of its subject (Marketing en SEO, Bouwen en data, …). */
export function SkillIcon({ c, size = 'md' }: { c: Pick<CuratedCard, 'category' | 'pack'>; size?: 'md' | 'lg' }) {
  const Icon = GROUPS.find((g) => g.id === groupIdOf(c.category, c.pack))?.icon || OTHER_ICON;
  return (
    <span className={cx('grid shrink-0 place-items-center rounded-control bg-surface-2 text-muted', size === 'lg' ? 'h-12 w-12' : 'h-9 w-9')} aria-hidden>
      <Icon className={size === 'lg' ? 'h-6 w-6' : 'h-[18px] w-[18px]'} />
    </span>
  );
}

/** Where a skill comes from and why it is here: the stars of its repository on GitHub, and the repository. */
export function SourceLine({ c, className }: { c: Pick<CuratedCard, 'repo' | 'stars'>; className?: string }) {
  return (
    <span className={cx('inline-flex min-w-0 items-center gap-1 text-xs text-muted', className)}>
      {c.stars ? (
        <>
          <Star className="h-3.5 w-3.5 shrink-0 fill-current text-warn" aria-hidden />
          <span className="shrink-0 font-semibold text-fg">{starsText(c.stars)}</span>
          <span className="sr-only">sterren op GitHub</span>
          <span aria-hidden>·</span>
        </>
      ) : null}
      <span className="min-w-0 truncate" translate="no">
        {c.repo}
      </span>
    </span>
  );
}

/**
 * Add a catalogue skill with one click: the pinned version, for the whole team at once (no choice per bot: every bot
 * of the team can load it straight away). Something to confirm (scan warning, publisher) goes to the regular review.
 */
export function useAddSkill(o: { teamId?: string; onReview(s: StagingView): void; onDone(): void }) {
  const [busyId, setBusyId] = useState('');
  const add = async (c: Pick<CuratedCard, 'id' | 'name' | 'scripts'>) => {
    if (busyId) return;
    setBusyId(c.id);
    try {
      const r = await api.post<CuratedInstallResult>('/skills/curated/install', { id: c.id, ...(o.teamId ? { teamId: o.teamId } : {}) });
      if (r.staging) return o.onReview(r.staging);
      if (!(r.status === 'created' || r.status === 'installed')) throw new Error(r.error || 'Toevoegen lukte niet');
      toast(c.scripts ? `${niceName(c.name)} is toegevoegd. Je bots kunnen hem meteen gebruiken; de scripts staan uit.` : `${niceName(c.name)} is toegevoegd. Je bots kunnen hem meteen gebruiken.`, 'ok');
      o.onDone();
    } catch (e: any) {
      toast(e?.message || 'Toevoegen lukte niet', 'danger');
    } finally {
      setBusyId('');
    }
  };
  return { add, busyId };
}

/** The page of one catalogue skill. */
export const skillHref = (id: string) => `/m/skills/skill/${id.split('/').map(encodeURIComponent).join('/')}`;

/**
 * A catalogue skill: icon, name, one sentence, where it comes from (stars, repository) and one button (`adder`). The card
 * opens the details; "Nieuwe versie" asks `onDiff` to show what changed.
 */
export function SkillCard({ c, adder, onDiff }: { c: CuratedCard; adder: ReturnType<typeof useAddSkill>; onDiff(d: { skillId: string; commit: string }): void }) {
  const added = !!c.installed;
  const onDetails = () => navigate(skillHref(c.id));
  return (
    <div data-card="curated" data-skill={c.id} className={CARD}>
      <div className="flex min-w-0 items-start gap-3">
        <SkillIcon c={c} />
        <div className="min-w-0 flex-1">
          <button type="button" className={cx(CARD_OPEN, 'block')} onClick={onDetails}>
            <span className="break-words" translate="no">
              {niceName(c.name)}
            </span>
          </button>
          <SourceLine c={c} className="mt-0.5 max-w-full" />
        </div>
      </div>
      <p className="mt-2 line-clamp-2 flex-1 break-words text-sm text-muted">{c.note}</p>
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
            <Button size="sm" icon={<Plus className="h-4 w-4" />} loading={adder.busyId === c.id} onClick={() => adder.add(c)}>
              Toevoegen
            </Button>
          ) : (
            c.installed?.update && (
              <Button size="sm" icon={<GitCompare className="h-4 w-4" />} onClick={() => c.installed?.update && onDiff({ skillId: c.installed.skillId, commit: c.installed.update.to })}>
                Nieuwe versie
              </Button>
            )
          )}
        </span>
      </div>
    </div>
  );
}

/** Own bots (not archived, not someone else's shared bot). */
export function useOwnBots(): Agent[] {
  const agents = useApp((s) => s.agents);
  return useMemo(() => agents.filter((a) => !a.archived && !a.shared_from), [agents]);
}

// ---------------------------------------------------------------- an app

/** An app from the MCP register, as plain as a skill card: name, one sentence, one button. `onOpen`: the name opens the details. */
export function AppCard({ i, onAdd, onOpen, busy }: { i: RegistryCard; onAdd(): void; onOpen?(): void; busy?: boolean }) {
  const upd = i.installed.some((x) => x.version !== i.version);
  return (
    <div data-card="app" className={CARD}>
      <div className="flex min-w-0 items-start gap-3">
        <AppIcon src={i.icon} title={i.title} name={i.name} />
        <div className="min-w-0">
          {/* An app from the public registry: its name, publisher and description are the publisher's words. */}
          <button type="button" className={cx(CARD_OPEN, 'block')} onClick={onOpen || onAdd}>
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
            <Button size="sm" icon={<Plus className="h-4 w-4" />} disabled={!i.installable || busy} loading={busy} onClick={onAdd}>
              Toevoegen
            </Button>
          </span>
        )}
      </div>
    </div>
  );
}
