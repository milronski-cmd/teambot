import { Lightbulb, ListChecks, Repeat } from 'lucide-react';
import { t } from '../../lib/i18n';
import { MoreInfo } from '../../components/MoreInfo';
import { PageLinks } from '../../components/overview';
import { fmtDate, type Meta } from './lib';

/**
 * Where work lives: Taken (what is being done), Automatisch (what runs by itself) and Kansen (ideas the bots found,
 * for the owner to decide on; it hung under "Meer" and the owner could not find it, 15 nov). The same links on every
 * one of those pages; calendar, projects and limits stay behind the "Meer" menu of the page they belong to.
 */
export function TaskLinks({ current }: { current: 'tasks' | 'auto' | 'kansen' }) {
  return (
    <PageLinks
      label="Taken en automatisch"
      items={[
        { href: '#/tasks', label: 'Taken', icon: <ListChecks aria-hidden />, current: current === 'tasks' },
        { href: '#/m/routines/', label: 'Automatisch', icon: <Repeat aria-hidden />, current: current === 'auto' },
        { href: '#/m/routines/werk/kansen', label: 'Kansen', icon: <Lightbulb aria-hidden />, current: current === 'kansen' },
      ]}
    />
  );
}

/** When routines run at all, in one calm line; the rest on request. */
export function UptimeNote({ meta }: { meta: Meta }) {
  const desktop = meta.mode === 'desktop';
  return (
    <p className="text-[13px] leading-relaxed text-muted">
      {desktop ? 'Dit loopt alleen als TeamBot open is en je pc aan staat.' : 'Dit loopt zolang de TeamBot-server draait.'}{' '}
      <MoreInfo>
        <span className="block">Wat TeamBot miste, haalt het bij het opstarten één keer in of slaat het over; dat kies je per routine.</span>
        {desktop && (
          <span className="mt-1 block">
            De pc wakker houden terwijl routines lopen:{' '}
            <a className="underline" href="#/settings/systeem">
              Instellingen › Meer mogelijkheden › Deze computer
            </a>
            .
          </span>
        )}
        <span className="mt-1 block">{[t('TeamBot draait sinds {0}', fmtDate(meta.startedAt)), meta.lastTickAt ? t('planner laatst actief {0}', fmtDate(meta.lastTickAt)) : '', t('standaardtijdzone {0}', meta.timezone)].filter(Boolean).join(' · ')}</span>
      </MoreInfo>
    </p>
  );
}
