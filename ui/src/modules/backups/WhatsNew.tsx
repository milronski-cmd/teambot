import { useEffect, useState } from 'react';
import { Sparkles } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Button, Card, EmptyState, Page, PageHeader, Spinner } from '../../components/ui';
import type { ChangeRelease, UpdatesView } from './types';
import { UpdatesCard } from './UpdatesCard';

/** How many items per group before "Alles tonen": a short list first, the rest one click away. */
const SHORT = 4;

/** The changelog of one or more versions, short (plain words, as the changelog is written). */
export function WhatsNewList({ releases }: { releases: ChangeRelease[] }) {
  const [all, setAll] = useState(false);
  const total = releases.reduce((n, r) => n + r.sections.reduce((m, s) => m + s.groups.reduce((k, g) => k + g.items.length, 0), 0), 0);
  let shown = 0;
  return (
    <div className="space-y-5">
      {releases.map((r) => (
        <section key={r.version} className="space-y-3" aria-labelledby={`rel-${r.version}`}>
          <h3 id={`rel-${r.version}`} className="text-[14px] font-bold">
            {t('Versie {0}', r.version)}
            {r.date && <span className="ms-2 font-normal text-muted">{r.date}</span>}
          </h3>
          {/* The changelog is written in Dutch only: marked as such, never half-translated by the page dictionary. */}
          {r.intro && (
            <p className="text-sm text-muted" lang="nl" translate="no">
              {r.intro}
            </p>
          )}
          {r.sections.map((s) => (
            <div key={s.title} className="space-y-2" lang="nl" translate="no">
              <div className="text-[12.5px] font-semibold uppercase tracking-wide text-muted">{s.title}</div>
              {s.groups.map((g, gi) => {
                const items = all ? g.items : g.items.slice(0, SHORT);
                shown += items.length;
                return (
                  <div key={gi}>
                    {g.title && <div className="text-[13.5px] font-semibold">{g.title}</div>}
                    <ul className="list-disc space-y-1 ps-5 text-sm">
                      {items.map((it, i) => (
                        <li key={i}>{it}</li>
                      ))}
                    </ul>
                  </div>
                );
              })}
            </div>
          ))}
        </section>
      ))}
      {!all && shown < total && (
        <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
          {t('{0, plural, one {Nog # punt tonen} other {Nog # punten tonen}}', total - shown)}
        </Button>
      )}
    </div>
  );
}

/** #/m/backups/nieuw — after an update: what is new, and (Windows app) the way back. */
export function WhatsNewPage() {
  const [v, setV] = useState<UpdatesView | null>(null);
  const [err, setErr] = useState('');
  const load = () =>
    api
      .get<UpdatesView>('/backups/updates')
      .then(setV)
      .catch((e) => setErr(e.message || String(e)));
  useEffect(() => {
    load();
    // Opened: "Wat is er nieuw" of this version counts as seen.
    api.post('/backups/updates/seen').catch(() => {});
  }, []);
  return (
    <Page>
      <PageHeader title="Wat is er nieuw" subtitle={v ? t('TeamBot {0}', v.version) : undefined} back={{ href: '#/settings/backups-app', label: 'Back-ups' }} />
      <div className="mx-auto max-w-3xl space-y-4 px-4 py-5">
        {err ? (
          <EmptyState title="Ophalen mislukt" action={<Button onClick={load}>Opnieuw proberen</Button>}>
            {err}
          </EmptyState>
        ) : !v ? (
          <Spinner />
        ) : (
          <>
            {v.last && <UpdatesCard v={v} onChanged={load} />}
            <Card className="p-5">
              {v.whatsNew.length ? (
                <WhatsNewList releases={v.whatsNew} />
              ) : (
                <EmptyState icon={<Sparkles className="h-8 w-8" />} title="Geen wijzigingslog voor deze versie">
                  Deze versie van TeamBot heeft geen beschrijving van wat er nieuw is.
                </EmptyState>
              )}
            </Card>
          </>
        )}
      </div>
    </Page>
  );
}
