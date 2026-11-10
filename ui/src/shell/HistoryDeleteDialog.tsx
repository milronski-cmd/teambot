import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { Button, Modal, Spinner, toast, toastError } from '../components/ui';
import { t } from '../lib/i18n';
import { formatBytes } from '../lib/format';
import { isOwnWorkspace } from '../components/FolderName';

interface Counts {
  name: string;
  threads: number;
  messages: number;
  files: number;
  bytes: number;
  running: number;
  summaries: number;
  backups: number;
}
interface BotPreview extends Counts {
  stays: { memories: number; routines: number; tasks: number; groups: number; channels: number; others: number; workspace: string };
}
interface RoomPreview extends Counts {
  stays: { bots: number; tasks: number; files: number; people: number };
}

export type HistoryTarget = { kind: 'agent'; id: string; name: string } | { kind: 'room'; id: string; name: string; threadId: string };

/** On a server only the owner of the installation may delete history (the server says so too). */
export function useCanDeleteHistory(): boolean {
  return useApp((s) => s.mode !== 'server' || s.me?.role === 'owner');
}

/**
 * "Geschiedenis wissen" for one bot or one group: exactly what goes and what stays, with counts from
 * GET /agents/:id/history or /rooms/:id/history, before anything happens (like deleting a bot).
 */
export function HistoryDeleteDialog({ target, open, onClose, onDone }: { target: HistoryTarget | null; open: boolean; onClose(): void; onDone?(): void }) {
  const [p, setP] = useState<BotPreview | RoomPreview | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState(false);
  const base = target ? `/${target.kind === 'agent' ? 'agents' : 'rooms'}/${target.id}/history` : '';
  useEffect(() => {
    if (!open || !base) return;
    let alive = true;
    setP(null);
    setErr('');
    api
      .get<BotPreview | RoomPreview>(base)
      .then((r) => alive && setP(r))
      .catch((e) => alive && setErr(e.message));
    return () => {
      alive = false;
    };
  }, [open, base]);
  if (!target) return null;
  const room = target.kind === 'room';
  // Only empty conversations (a new chat): nothing worth a deletion.
  const empty = !!p && !p.messages && !p.files;

  const remove = async () => {
    setBusy(true);
    try {
      await api.del(base);
      if (target.kind === 'agent') {
        const me = useApp.getState().me?.id;
        useApp.setState((s) => ({ threads: s.threads.filter((x) => !(x.agent_id === target.id && !x.room_id && x.kind !== 'room' && x.user_id === me)) }));
        toast(`De geschiedenis van ${target.name} is gewist.`, 'ok');
      } else {
        useApp.setState((s) => ({ messages: { ...s.messages, [target.threadId]: [] } }));
        toast(`De geschiedenis van de groep ${target.name} is gewist.`, 'ok');
      }
      void useApp.getState().refreshThreads().catch(() => {});
      onClose();
      onDone?.();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  const goes: string[] = [];
  const stays: string[] = [];
  if (p) {
    if (room) {
      // Count and noun in one text (ICU plural forms), so every language can translate it with its own forms.
      goes.push(
        p.threads
          ? t('het groepsgesprek en {0, plural, one {# gesprek} other {# gesprekken}} tussen de bots, samen {1, plural, one {# bericht} other {# berichten}}', p.threads, p.messages)
          : t('het groepsgesprek met {0, plural, one {# bericht} other {# berichten}}', p.messages),
      );
    } else goes.push(p.threads ? t('{0, plural, one {# gesprek} other {# gesprekken}} met {1, plural, one {# bericht} other {# berichten}}', p.threads, p.messages) : 'geen gesprekken (er zijn er nog geen)');
    if (p.files) goes.push(t('{0, plural, one {# bestand} other {# bestanden}} uit de gesprekken, samen {1}', p.files, formatBytes(p.bytes)));
    if (p.summaries) goes.push(t('{0, plural, one {# samenvatting} other {# samenvattingen}} van de gesprekken in Geheugen', p.summaries));
    if (p.running) goes.push(t('{0, plural, one {# lopende taak wordt} other {# lopende taken worden}} gestopt', p.running));
    if (room) {
      const s = (p as RoomPreview).stays;
      stays.push('de groep zelf: naam, werkwijze, instructies en leden');
      if (s.bots) stays.push(t('{0, plural, one {# bot} other {# bots}}, met hun eigen gesprekken en geheugen', s.bots));
      if (s.tasks) stays.push(t('{0, plural, one {# taak} other {# taken}} op het takenbord', s.tasks));
      if (s.files) stays.push(t('{0, plural, one {# gedeeld bestand} other {# gedeelde bestanden}} van de groep', s.files));
      stays.push('de kosten en het activiteitenlog van de groep');
    } else {
      const s = (p as BotPreview).stays;
      stays.push('de bot zelf: profiel, gezicht, instructies en instellingen');
      if (s.memories) stays.push(t('{0, plural, one {# herinnering} other {# herinneringen}} van deze bot', s.memories));
      stays.push('gedeeld geheugen en dossiers');
      if (s.routines) stays.push(t('{0, plural, one {# routine} other {# routines}}', s.routines));
      if (s.tasks) stays.push(t('{0, plural, one {# taak} other {# taken}} op het takenbord', s.tasks));
      if (s.groups) stays.push(t('de gesprekken in {0, plural, one {# groep} other {# groepen}}', s.groups));
      if (s.channels) stays.push(t('{0, plural, one {# kanaalkoppeling} other {# kanaalkoppelingen}}; een nieuw bericht begint daar een nieuw gesprek', s.channels));
      if (s.others) stays.push(t('{0, plural, one {# gesprek} other {# gesprekken}} van teamleden met deze gedeelde bot', s.others));
      stays.push(isOwnWorkspace(s.workspace) ? 'de werkmap met bestanden' : t('de map {0} met bestanden', s.workspace));
    }
  }
  const people = room && p ? (p as RoomPreview).stays.people : 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={room ? `Geschiedenis van de groep ${target.name} wissen?` : `Geschiedenis van ${target.name} wissen?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="danger" loading={busy} disabled={!p || empty} onClick={remove}>
            Geschiedenis wissen
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm" data-testid="history-delete">
        {err ? (
          <p className="text-danger">{err}</p>
        ) : !p ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
        ) : empty ? (
          <p>Er is nog geen geschiedenis om te wissen.</p>
        ) : (
          <>
            <div>
              <h3 className="mb-1 font-semibold">Dit gaat weg</h3>
              <ul className="list-disc space-y-0.5 ps-5">
                {goes.map((x) => (
                  <li key={x}>{x}</li>
                ))}
              </ul>
            </div>
            <div>
              <h3 className="mb-1 font-semibold">Dit blijft</h3>
              <ul className="list-disc space-y-0.5 ps-5 text-muted">
                {stays.map((x) => (
                  <li key={x} className="break-words">
                    {x}
                  </li>
                ))}
              </ul>
            </div>
            {people > 0 && <p>{t('{0, plural, one {Ook # ander lid ziet} other {Ook # andere leden zien}} het groepsgesprek daarna leeg.', people)}</p>}
            {p.backups > 0 && (
              <p className="text-xs text-muted">
                {t('{0, plural, one {Er is al # back-up} other {Er zijn al # back-ups}} met deze gesprekken; zet je er een terug, dan komen ze terug.', p.backups)}
              </p>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}
