import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Button, Field, Input, Modal, Spinner, Textarea, toast } from '../../components/ui';
import { Segmented } from '../../components/SettingControls';
import { Skeleton } from '../../components/overview';

/**
 * "Bewaar als skill" (parity 7.5): the bot writes a draft from this conversation (server/modules/skills/from-chat.ts),
 * the owner reads and edits it, chooses "only this bot" or "the whole team", and only then it is saved as a skill.
 */
interface Draft {
  name: string;
  description: string;
  instructions: string;
  ai: boolean;
  note: string;
  bot: { id: string; name: string };
  team: { id: string | null; name: string; multi: boolean };
}

/** "Bewaren voor": only this bot, or every bot of the team (shared with "Maak een skill van dit document"). */
export function ScopeChoice({ value, onChange, botName, team }: { value: 'bot' | 'team'; onChange(v: 'bot' | 'team'): void; botName: string; team: { name: string; multi: boolean } }) {
  return (
    <div className="space-y-1.5">
      <div className="text-[13px] font-semibold">Bewaren voor</div>
      <Segmented<'bot' | 'team'>
        label="Bewaren voor"
        value={value}
        onChange={onChange}
        options={[
          { value: 'bot', label: `Alleen ${botName}` },
          { value: 'team', label: team.multi && team.name ? `Alle bots van team ${team.name}` : 'Alle bots van het team' },
        ]}
      />
    </div>
  );
}

export function SaveAsSkillModal({ threadId, messageId, onClose }: { threadId: string; messageId?: string; onClose(): void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [scope, setScope] = useState<'bot' | 'team'>('bot');
  const [warn, setWarn] = useState<{ error: string; scan: { severity: string; message: string }[] } | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let live = true;
    api
      .post<Draft>('/skills/from-chat/draft', { threadId, messageId })
      .then((d) => {
        if (!live) return;
        setDraft(d);
        setName(d.name);
        setDescription(d.description);
        setInstructions(d.instructions);
      })
      .catch((e) => live && setError(e?.message || String(e)));
    return () => {
      live = false;
    };
  }, [threadId, messageId]);

  const save = async () => {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.post<any>('/skills/from-chat/save', { threadId, agentId: draft.bot.id, name, description, instructions, scope, acknowledge: ack });
      if (r.status === 'created') {
        toast(scope === 'team' ? `Skill “${r.name}” bewaard voor het team` : `Skill “${r.name}” bewaard voor ${draft.bot.name}`, 'ok');
        onClose();
        return;
      }
      setWarn({ error: r.error || 'Niet opgeslagen.', scan: r.scan || [] });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Bewaar als skill"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="primary" loading={busy} disabled={!draft || !name.trim() || !description.trim() || !instructions.trim() || (!!warn && !ack)} onClick={save}>
            Opslaan als skill
          </Button>
        </>
      }
    >
      {!draft && !error && (
        <div className="space-y-3" role="status">
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> De bot schrijft een concept uit dit gesprek…
          </p>
          <Skeleton className="h-10 w-full rounded-control" />
          <Skeleton className="h-10 w-full rounded-control" />
          <Skeleton className="h-48 w-full rounded-control" />
        </div>
      )}
      {error && <p className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      {draft && (
        <div className="tb-in space-y-3">
          <p className="text-sm text-muted">{draft.ai ? `Concept van ${draft.bot.name}, uit dit gesprek. Lees het na en pas het aan.` : 'Een opzet uit het gesprek zelf. Vul de werkwijze aan.'}</p>
          {!draft.ai && draft.note && <p className="rounded-control bg-warn-soft px-3 py-2 text-sm text-warn">De AI schreef geen concept: {draft.note}</p>}
          <Field label="Naam" hint="Kleine letters, cijfers en streepjes.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          </Field>
          <Field label="Wat doet hij en wanneer gebruikt de bot hem?">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1024} />
          </Field>
          <Field label="Werkwijze (Markdown)">
            <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={12} className="font-mono text-[13px]" />
          </Field>
          <ScopeChoice value={scope} onChange={setScope} botName={draft.bot.name} team={draft.team} />
          {warn && (
            <div className="tb-in space-y-2 rounded-control bg-warn-soft px-3 py-2 text-sm">
              <p className="text-warn">{warn.error}</p>
              {warn.scan.length > 0 && (
                <ul className="list-disc ps-5">
                  {warn.scan.map((f, i) => (
                    <li key={i}>{f.message}</li>
                  ))}
                </ul>
              )}
              <label className="flex items-start gap-2">
                <input type="checkbox" className="mt-0.5 h-4 w-4" checked={ack} onChange={(e) => setAck(e.target.checked)} />
                <span>Ik heb de waarschuwingen gelezen en wil de skill toch bewaren.</span>
              </label>
            </div>
          )}
        </div>
      )}
    </Modal>
  );
}
