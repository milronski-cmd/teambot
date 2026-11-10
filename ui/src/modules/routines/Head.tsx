import { ListChecks, Repeat } from 'lucide-react';
import { t } from '../../lib/i18n';
import { MoreInfo } from '../../components/MoreInfo';
import { PageLinks } from '../../components/overview';
import { fmtDate, type Meta } from './lib';

/**
 * The two places work lives: Taken (what is being done) and Automatisch (what runs by itself). The same two links on
 * both pages; everything else (calendar, projects, limits …) is behind the "Meer" menu of the page it belongs to.
 */
export function TaskLinks({ current }: { current: 'tasks' | 'auto' }) {
  return (
    <PageLinks
      label="Taken en automatisch"
      items={[
        { href: '#/tasks', label: 'Taken', icon: <ListChecks aria-hidden />, current: current === 'tasks' },
        { href: '#/m/routines/', label: 'Automatisch', icon: <Repeat aria-hidden />, current: current === 'auto' },
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
            <a className="underline" href="#/settings/general">
              Instellingen › Algemeen › Pc en routines
            </a>
            .
          </span>
        )}
        <span className="mt-1 block">{[t('TeamBot draait sinds {0}', fmtDate(meta.startedAt)), meta.lastTickAt ? t('planner laatst actief {0}', fmtDate(meta.lastTickAt)) : '', t('standaardtijdzone {0}', meta.timezone)].filter(Boolean).join(' · ')}</span>
      </MoreInfo>
    </p>
  );
}
