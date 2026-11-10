import { useCallback, useEffect, useState } from 'react';
import { GitCompare } from 'lucide-react';
import { Button } from '../../components/ui';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatDate } from '../../lib/format';
import type { CuratedUpdate } from './api';
import { UpdateDiffModal } from './Catalog';

/**
 * PARITEIT 7.3: TeamBot's own catalogue pins every skill to one commit. When a TeamBot update brings a newer pin for a
 * skill you installed, Mijn skills and the skill itself say so calmly, with what changed. Nothing changes until you
 * click Bijwerken in the comparison (with the same checks as installing).
 */
export interface PinUpdate {
  skillId: string;
  id: string;
  name: string;
  teamName: string;
  from: string;
  to: string;
  toDate: string;
  note: string;
  changes: string[];
  changesKnown: boolean;
}

/** "SKILL.md, extra.md (nieuw)": the changed files of the skill folder, short. */
export function changedFiles(changes: string[], max = 3): string {
  const names = changes.slice(0, max).map((c) => {
    const m = /^(.*?)( \((nieuw|verwijderd)\))?$/.exec(c)!;
    const base = m[1].split('/').pop() || m[1];
    return m[3] === 'nieuw' ? t('{0} (nieuw)', base) : m[3] === 'verwijderd' ? t('{0} (verwijderd)', base) : base;
  });
  return names.join(', ') + (changes.length > max ? ' …' : '');
}

function WhatChanged({ note, changes, known }: { note: string; changes: string[]; known: boolean }) {
  return (
    <>
      {note && <span> {note}</span>}
      {known && changes.length > 0 && (
        <span className="text-muted">
          {' '}
          {t('{0, plural, one {# bestand anders} other {# bestanden anders}}', changes.length)}: <span translate="no">{changedFiles(changes)}</span>.
        </span>
      )}
    </>
  );
}

/** Mijn skills: one calm block when the TeamBot catalogue has newer versions of skills you installed. */
export function PinUpdatesBanner({ onChanged, onShowAll }: { onChanged(): void; onShowAll(): void }) {
  const [list, setList] = useState<PinUpdate[]>([]);
  const [diff, setDiff] = useState<PinUpdate | null>(null);
  const load = useCallback(() => {
    api
      .get<{ updates: PinUpdate[] }>('/skills/curated/pin-updates')
      .then((r) => {
        setList(r.updates);
        // Now that the files are known, a skill whose files did not change no longer shows "Update beschikbaar".
        onChanged();
      })
      .catch(() => setList([]));
  }, [onChanged]);
  useEffect(() => {
    load();
    return on('skills.updated', load);
  }, [load]);
  if (!list.length) return null;
  return (
    <section aria-labelledby="pin-updates-title" className="tb-in rounded-card border border-line bg-accent-soft px-4 py-3 text-sm">
      <h2 id="pin-updates-title" className="font-semibold">
        {list.length === 1 ? 'Nieuwe versie in de TeamBot-catalogus' : t('{0, plural, one {# skill heeft een nieuwe versie in de TeamBot-catalogus} other {# skills hebben een nieuwe versie in de TeamBot-catalogus}}', list.length)}
      </h2>
      <ul className="mt-2 space-y-2">
        {list.slice(0, 4).map((u) => (
          <li key={u.skillId} className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1">
              <span className="font-medium" translate="no">
                {u.name}
              </span>
              {': '}
              {t('versie van {0}.', formatDate(u.toDate, { dateStyle: 'medium' }))}
              <WhatChanged note={u.note} changes={u.changes} known={u.changesKnown} />
            </span>
            <Button size="sm" icon={<GitCompare className="h-4 w-4" />} onClick={() => setDiff(u)} aria-label={t('Bekijk wat er verandert in {0}', u.name)}>
              Bekijk wat er verandert
            </Button>
          </li>
        ))}
      </ul>
      {list.length > 4 && (
        <button type="button" className="mt-2 font-medium text-accent underline" onClick={onShowAll}>
          Alle updates tonen
        </button>
      )}
      {diff && <UpdateDiffModal skillId={diff.skillId} commit={diff.to} onClose={() => (setDiff(null), load())} />}
    </section>
  );
}

/** On the skill itself: what the newer catalogue version changes (date, the catalogue's note, the files). */
export function PinUpdateNote({ update }: { update: CuratedUpdate }) {
  if (!update.pin) return null;
  return (
    <>
      {' '}
      {t('Versie van {0}.', formatDate(update.pin.toDate, { dateStyle: 'medium' }))}
      <WhatChanged note={update.pin.note} changes={update.changes} known={update.pin.changesKnown} />
    </>
  );
}
