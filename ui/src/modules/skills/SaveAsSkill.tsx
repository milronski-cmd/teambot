import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { Button, Field, Input, Modal, Spinner, Textarea, toast } from '../../components/ui';
import { Segmented } from '../../components/SettingControls';
import { Skeleton } from '../../components/overview';

/**
 * "Bewaar als skill" (parity 7.5): the bot writes a draft from this conversation (server/modules/skills/from-chat.ts),
 * the owner reads and edits it, chooses "only this bot" or "the whole team", and only then it is saved as a skill.
 * The draft, its fields and how it is saved are shared with "Maak een skill van dit document" (FromDocument.tsx).
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

/** "Bewaren voor": only this bot, or every bot of the team. */
function ScopeChoice({ value, onChange, botName, team }: { value: 'bot' | 'team'; onChange(v: 'bot' | 'team'): void; botName: string; team: { name: string; multi: boolean } }) {
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

/** A draft skill being edited: its fields, "Bewaren voor", the scan warning, and saving it. */
export function useSkillDraft() {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [scope, setScope] = useState<'bot' | 'team'>('bot');
  const [warn, setWarn] = useState<{ error: string; scan: { severity: string; message: string }[] } | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const fill = (d: { name: string; description: string; instructions: string }) => {
    setName(d.name);
    setDescription(d.description);
    setInstructions(d.instructions);
  };
  /** Saves at `url` with the edited fields; the new skill when it was made (with a toast), null when it was not. */
  const save = async (url: string, body: Record<string, unknown>, botName: string): Promise<{ skillId: string } | null> => {
    setBusy(true);
    setError('');
    try {
      const r = await api.post<any>(url, { ...body, name, description, instructions, scope, acknowledge: ack });
      if (r.status === 'created') {
        toast(scope === 'team' ? `Skill “${r.name}” bewaard voor het team` : `Skill “${r.name}” bewaard voor ${botName}`, 'ok');
        return r;
      }
      setWarn({ error: r.error || 'Niet opgeslagen.', scan: r.scan || [] });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
    return null;
  };
  const filled = !!name.trim() && !!description.trim() && !!instructions.trim() && (!warn || ack);
  return { name, setName, description, setDescription, instructions, setInstructions, scope, setScope, warn, ack, setAck, busy, error, setError, fill, save, filled };
}

type SkillDraft = ReturnType<typeof useSkillDraft>;

/** The modal around a draft: "Opslaan als skill" works once there is a complete draft (`ready`). */
export function DraftModal({ title, d, ready, onSave, onClose, children }: { title: string; d: SkillDraft; ready: boolean; onSave(): void; onClose(): void; children: React.ReactNode }) {
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="primary" loading={d.busy} disabled={!ready || !d.filled} onClick={onSave}>
            Opslaan als skill
          </Button>
        </>
      }
    >
      {/* Never at the same time as the loading state: an error ends it. */}
      {d.error && <p className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">{d.error}</p>}
      {children}
    </Modal>
  );
}

/** While the bot writes the draft (the sentence is the child). */
export function DraftLoading({ children }: { children: React.ReactNode }) {
  return (
    <div className="space-y-3" role="status">
      <p className="flex items-center gap-2 text-sm text-muted">
        <Spinner /> {children}
      </p>
      <Skeleton className="h-10 w-full rounded-control" />
      <Skeleton className="h-10 w-full rounded-control" />
      <Skeleton className="h-48 w-full rounded-control" />
    </div>
  );
}

/** The draft itself: why it is only an outline (no AI), the fields, "Bewaren voor" and the scan warning. */
export function DraftFields({ d, draft, botName, children }: { d: SkillDraft; draft: { ai: boolean; note: string; team: { name: string; multi: boolean } }; botName: string; children?: React.ReactNode }) {
  return (
    <>
      {!draft.ai && draft.note && <p className="rounded-control bg-warn-soft px-3 py-2 text-sm text-warn">De AI schreef geen concept: {draft.note}</p>}
      {children}
      <Field label="Naam" hint="Kleine letters, cijfers en streepjes.">
        <Input value={d.name} onChange={(e) => d.setName(e.target.value)} maxLength={64} />
      </Field>
      <Field label="Wat doet hij en wanneer gebruikt de bot hem?">
        <Input value={d.description} onChange={(e) => d.setDescription(e.target.value)} maxLength={1024} />
      </Field>
      <Field label="Werkwijze (Markdown)">
        <Textarea value={d.instructions} onChange={(e) => d.setInstructions(e.target.value)} rows={12} className="font-mono text-[13px]" />
      </Field>
      <ScopeChoice value={d.scope} onChange={d.setScope} botName={botName} team={draft.team} />
      {d.warn && (
        <div className="tb-in space-y-2 rounded-control bg-warn-soft px-3 py-2 text-sm">
          <p className="text-warn">{d.warn.error}</p>
          {d.warn.scan.length > 0 && (
            <ul className="list-disc ps-5">
              {d.warn.scan.map((f, i) => (
                <li key={i}>{f.message}</li>
              ))}
            </ul>
          )}
          <label className="flex items-start gap-2">
            <input type="checkbox" className="mt-0.5 h-4 w-4" checked={d.ack} onChange={(e) => d.setAck(e.target.checked)} />
            <span>Ik heb de waarschuwingen gelezen en wil de skill toch bewaren.</span>
          </label>
        </div>
      )}
    </>
  );
}

export function SaveAsSkillModal({ threadId, messageId, onClose }: { threadId: string; messageId?: string; onClose(): void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const d = useSkillDraft();

  useEffect(() => {
    let live = true;
    api
      .post<Draft>('/skills/from-chat/draft', { threadId, messageId })
      .then((x) => {
        if (!live) return;
        setDraft(x);
        d.fill(x);
      })
      .catch((e) => live && d.setError(e?.message || String(e)));
    return () => {
      live = false;
    };
  }, [threadId, messageId]);

  const save = async () => {
    if (!draft) return;
    if (await d.save('/skills/from-chat/save', { threadId, agentId: draft.bot.id }, draft.bot.name)) onClose();
  };

  return (
    <DraftModal title="Bewaar als skill" d={d} ready={!!draft} onSave={save} onClose={onClose}>
      {!draft && !d.error && <DraftLoading>De bot schrijft een concept uit dit gesprek…</DraftLoading>}
      {draft && (
        <div className="tb-in space-y-3">
          <p className="text-sm text-muted">{draft.ai ? `Concept van ${draft.bot.name}, uit dit gesprek. Lees het na en pas het aan.` : 'Een opzet uit het gesprek zelf. Vul de werkwijze aan.'}</p>
          <DraftFields d={d} draft={draft} botName={draft.bot.name} />
        </div>
      )}
    </DraftModal>
  );
}
