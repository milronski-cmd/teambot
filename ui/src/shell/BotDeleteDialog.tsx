import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import type { Agent } from '../lib/types';
import { Button, Field, Input, Modal, Spinner, Toggle, toast, toastError } from '../components/ui';
import { t } from '../lib/i18n';
import { isOwnWorkspace } from '../components/FolderName';

interface Preview {
  threads: number;
  messages: number;
  memories: number;
  routines: number;
  channels: number;
  groups: number;
  running: number;
  workspace: string;
  workspaceInData: boolean;
}


/**
 * "Bot verwijderen?" with exactly what goes and what stays (counts from GET /agents/:id/delete-preview). Used by the
 * bot editor and the chat menu. A cloud VM of the bot is never deleted silently: the owner chooses explicitly.
 */
export function BotDeleteDialog({ agent, open, onClose, onDeleted }: { agent: Agent | null | undefined; open: boolean; onClose(): void; onDeleted(): void }) {
  const [p, setP] = useState<Preview | null>(null);
  const [err, setErr] = useState('');
  const [deleteFiles, setDeleteFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [vmDel, setVmDel] = useState<{ vm: { id: string; name: string }; choice: 'keep' | 'delete' | null; typed: string } | null>(null);
  const id = agent?.id;
  useEffect(() => {
    if (!open || !id) return;
    let alive = true;
    setP(null);
    setErr('');
    setDeleteFiles(false);
    api
      .get<Preview>(`/agents/${id}/delete-preview`)
      .then((r) => alive && setP(r))
      .catch((e) => alive && setErr(e.message));
    api
      .get<{ vm: { id: string; name: string; status: string } | null }>(`/computers/${id}/cloud`)
      .then((r) => alive && setVmDel(r?.vm && r.vm.status !== 'deleted' && r.vm.status !== 'deleting' ? { vm: r.vm, choice: null, typed: '' } : null))
      .catch(() => alive && setVmDel(null));
    return () => {
      alive = false;
    };
  }, [open, id]);
  if (!agent) return null;
  const remove = async () => {
    setBusy(true);
    try {
      if (vmDel?.choice === 'delete') await api.post(`/computers/cloud/vms/${vmDel.vm.id}/delete`, { confirm: vmDel.typed.trim() });
      const r = await api.del<{ filesDeleted: boolean; workspace: string }>(`/agents/${agent.id}${deleteFiles ? '?deleteFiles=1' : ''}`);
      useApp.setState((s) => ({ agents: s.agents.filter((a) => a.id !== agent.id), threads: s.threads.filter((t) => t.agent_id !== agent.id || !!t.room_id) }));
      toast(r.filesDeleted ? `${agent.name} en de werkmap zijn verwijderd` : `${agent.name} is verwijderd. De werkmap met bestanden is bewaard.`, 'ok');
      onClose();
      onDeleted();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  const goes: string[] = p
    ? [
        'de bot zelf: profiel, gezicht, instellingen en geschiedenis',
        // Count and noun in one text (ICU plural forms), so every language can translate it with its own forms.
        p.threads ? t('{0, plural, one {# gesprek} other {# gesprekken}} met {1, plural, one {# bericht} other {# berichten}}', p.threads, p.messages) : 'geen gesprekken (er zijn er nog geen)',
        ...(p.memories ? [t('{0, plural, one {# herinnering} other {# herinneringen}} van alleen deze bot (naar de prullenbak in Geheugen, daar nog terug te halen)', p.memories)] : []),
        ...(p.routines ? [t('{0, plural, one {# routine} other {# routines}}', p.routines)] : []),
        ...(p.running ? [t('{0, plural, one {# lopende taak wordt} other {# lopende taken worden}} gestopt', p.running)] : []),
        ...(deleteFiles ? [isOwnWorkspace(p.workspace) ? 'de werkmap met alle bestanden' : t('de map {0} met alle bestanden', p.workspace)] : []),
      ]
    : [];
  const stays: string[] = p
    ? [
        ...(p.groups ? [t('de gesprekken in {0, plural, one {# groep} other {# groepen}} (voor de andere leden)', p.groups)] : []),
        'gedeeld geheugen en dossiers',
        ...(p.channels ? [t('{0, plural, one {# kanaalkoppeling} other {# kanaalkoppelingen}}: die worden losgekoppeld; je kiest er later een andere bot voor', p.channels)] : []),
        ...(!deleteFiles ? [isOwnWorkspace(p.workspace) ? 'de werkmap met bestanden' : t('de map {0} met bestanden', p.workspace)] : []),
      ]
    : [];
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`${agent.name} verwijderen?`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="danger" loading={busy} disabled={!p || (!!vmDel && (!vmDel.choice || (vmDel.choice === 'delete' && vmDel.typed.trim() !== vmDel.vm.name)))} onClick={remove}>
            Definitief verwijderen
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        {err ? (
          <p className="text-danger">{err}</p>
        ) : !p ? (
          <div className="flex justify-center py-4">
            <Spinner />
          </div>
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
            {p.workspaceInData ? (
              <Toggle checked={deleteFiles} onChange={setDeleteFiles} label="Ook de werkmap met bestanden verwijderen" />
            ) : (
              <p className="text-xs text-muted">De werkmap staat buiten de TeamBot-datamap en wordt nooit door TeamBot gewist.</p>
            )}
          </>
        )}
        {vmDel && (
          <fieldset className="space-y-2 rounded-lg border border-warn bg-warn-soft p-3">
            <legend className="px-1 font-medium">Cloud-VM {vmDel.vm.name}</legend>
            <p>Deze bot heeft een cloud-VM die geld kost zolang hij bestaat. Wat moet ermee gebeuren?</p>
            <label className="flex items-start gap-2">
              <input type="radio" name="vm-choice" className="mt-1" checked={vmDel.choice === 'keep'} onChange={() => setVmDel({ ...vmDel, choice: 'keep' })} />
              <span>Behouden. Hij blijft bestaan en kosten maken; je beheert of verwijdert hem later op de pagina Computers.</span>
            </label>
            <label className="flex items-start gap-2">
              <input type="radio" name="vm-choice" className="mt-1" checked={vmDel.choice === 'delete'} onChange={() => setVmDel({ ...vmDel, choice: 'delete' })} />
              <span>Ook de VM verwijderen, met alles wat erop staat.</span>
            </label>
            {vmDel.choice === 'delete' && (
              <Field label={`Typ ${vmDel.vm.name} om te bevestigen`}>
                <Input value={vmDel.typed} onChange={(e) => setVmDel({ ...vmDel, typed: e.target.value })} autoComplete="off" spellCheck={false} />
              </Field>
            )}
          </fieldset>
        )}
      </div>
    </Modal>
  );
}
