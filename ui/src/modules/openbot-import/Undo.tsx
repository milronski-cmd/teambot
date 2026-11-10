import { useEffect, useState } from 'react';
import { CheckCircle2, Undo2 } from 'lucide-react';
import { Button, Card, Modal, Spinner, toastError } from '../../components/ui';
import { useApp } from '../../lib/store';
import { t } from '../../lib/i18n';
import { type UndoPlan, type UndoResult, hermesApi, obApi } from './api';

type From = 'openbot' | 'hermes';
const apiOf = (from: From) => (from === 'hermes' ? hermesApi : obApi);

/**
 * "Import ongedaan maken": first the exact list of what goes (read from the server, nothing changes), then one button.
 * OpenBot (or Hermes Agent) itself is never touched.
 */
function UndoDialog({ onClose, onDone, from }: { onClose(): void; onDone(r: UndoResult): void; from: From }) {
  const [plan, setPlan] = useState<(UndoPlan & { memories?: number }) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    apiOf(from)
      .undoPlan()
      .then(setPlan)
      .catch((e) => setError(e?.message || String(e)));
  }, []);
  const go = async () => {
    setBusy(true);
    try {
      const r = await apiOf(from).undo();
      await useApp.getState().load();
      onDone(r);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const removed = plan?.teams.filter((x) => x.remove) || [];
  const kept = plan?.teams.filter((x) => !x.remove && x.note) || [];
  return (
    <Modal
      open
      onClose={onClose}
      title="Import ongedaan maken"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="danger" loading={busy} disabled={!plan?.available} icon={<Undo2 className="h-4 w-4" />} onClick={go}>
            Ongedaan maken
          </Button>
        </>
      }
    >
      {error ? (
        <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      ) : !plan ? (
        <Spinner />
      ) : !plan.available ? (
        <p className="text-sm text-muted">Er is niets meer om ongedaan te maken.</p>
      ) : (
        <div className="space-y-3 text-sm">
          <p>{from === 'hermes' ? 'Dit haalt weg wat de import uit Hermes Agent in TeamBot heeft gemaakt:' : 'Dit haalt weg wat de import uit OpenBot in TeamBot heeft gemaakt:'}</p>
          <ul className="list-disc space-y-1 ps-5">
            {plan.bots.length > 0 && <li>{t('{0, plural, one {# bot} other {# bots}}: {1}', plan.bots.length, plan.bots.map((b) => b.name).join(', '))}</li>}
            {removed.map((x) => (
              <li key={x.id}>{t('Het team “{0}”', x.name)}</li>
            ))}
            {plan.main && <li>{t('{0} als hoofdbot', plan.main)}</li>}
            {plan.routines > 0 && <li>{t('{0, plural, one {# routine} other {# routines}}', plan.routines)}</li>}
            {!!plan.channels?.length && <li>{t('Kanalen: {0}', plan.channels.map((c) => c.name).join(', '))}</li>}
            {plan.skills.length > 0 && <li>{t('{0, plural, one {# skill} other {# skills}}: {1}', plan.skills.length, plan.skills.map((s) => s.name).join(', '))}</li>}
            {plan.providers.length > 0 && <li>{t('Gekoppelde engines: {0}', plan.providers.map((p) => p.name).join(', '))}</li>}
            {plan.teamRows > 0 && <li>{t('{0, plural, one {# rij in de teamtabellen} other {# rijen in de teamtabellen}}', plan.teamRows)}</li>}
            {plan.tables.length > 0 && <li>{t('Tabellen die de import maakte: {0}', plan.tables.join(', '))}</li>}
            {plan.folder && <li>De teammap die de import instelde (de map zelf blijft staan)</li>}
            {!!plan.memories && <li>{t('{0, plural, one {# herinnering onder Over jou} other {# herinneringen onder Over jou}}', plan.memories)}</li>}
          </ul>
          {(kept.length > 0 || plan.keepSkills.length > 0) && (
            <ul className="space-y-1 text-xs text-muted">
              {kept.map((x) => (
                <li key={x.id}>{x.note}</li>
              ))}
              {plan.keepSkills.length > 0 && <li>{t('Blijft, omdat een andere bot hem gebruikt: {0}', plan.keepSkills.join(', '))}</li>}
            </ul>
          )}
          <ul className="space-y-1 rounded-lg bg-surface-2 px-3 py-2 text-xs text-muted">
            {plan.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        </div>
      )}
    </Modal>
  );
}

export function UndoButton({ onDone, label = 'Import ongedaan maken', from = 'openbot' }: { onDone(r: UndoResult): void; label?: string; from?: From }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="ghost" icon={<Undo2 className="h-4 w-4" />} onClick={() => setOpen(true)}>
        {label}
      </Button>
      {open && (
        <UndoDialog
          from={from}
          onClose={() => setOpen(false)}
          onDone={(r) => {
            setOpen(false);
            onDone(r);
          }}
        />
      )}
    </>
  );
}

export function UndoneCard({ r, from = 'openbot' }: { r: UndoResult & { memories?: number }; from?: From }) {
  const lines = [
    r.bots ? t('{0, plural, one {# bot verwijderd} other {# bots verwijderd}}', r.bots) : '',
    r.teams ? t('{0, plural, one {# team verwijderd} other {# teams verwijderd}}', r.teams) : '',
    r.routines ? t('{0, plural, one {# routine verwijderd} other {# routines verwijderd}}', r.routines) : '',
    r.channels ? t('{0, plural, one {# kanaal verwijderd} other {# kanalen verwijderd}}', r.channels) : '',
    r.skills ? t('{0, plural, one {# skill verwijderd} other {# skills verwijderd}}', r.skills) : '',
    r.providers ? t('{0, plural, one {# engine-koppeling verwijderd} other {# engine-koppelingen verwijderd}}', r.providers) : '',
    r.teamRows ? t('{0, plural, one {# rij uit de teamtabellen verwijderd} other {# rijen uit de teamtabellen verwijderd}}', r.teamRows) : '',
    r.memories ? t('{0, plural, one {# herinnering naar de prullenbak} other {# herinneringen naar de prullenbak}}', r.memories) : '',
  ].filter(Boolean);
  return (
    <Card className="space-y-3 p-5">
      <div className="flex items-center gap-2 text-base font-semibold">
        <CheckCircle2 className="h-5 w-5 text-ok" /> De import is ongedaan gemaakt
      </div>
      {lines.length > 0 && (
        <ul className="list-disc space-y-0.5 ps-5 text-sm">
          {lines.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ul>
      )}
      {r.notes.length > 0 && (
        <ul className="space-y-0.5 text-xs text-muted">
          {r.notes.map((n, i) => (
            <li key={i}>{n}</li>
          ))}
        </ul>
      )}
      <p className="text-sm text-muted">{from === 'hermes' ? 'Hermes Agent zelf is niet veranderd. Je kunt opnieuw inlezen wanneer je wilt.' : 'OpenBot zelf is niet veranderd. Je kunt opnieuw inlezen wanneer je wilt.'}</p>
    </Card>
  );
}
