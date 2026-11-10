import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { navigate } from '../../lib/router';
import { Button, Field, Input, Modal, Spinner, Textarea, toast } from '../../components/ui';
import { Dropdown } from '../../components/SettingControls';
import { Skeleton } from '../../components/overview';
import { ScopeChoice } from './SaveAsSkill';

/**
 * "Maak een skill van dit document" (0.4.4): a document in a dossier becomes a skill. The bot writes a draft from the
 * document (server/modules/skills/from-document.ts), the owner reads and edits it, chooses the bot and "only this bot"
 * or "the whole team", and only then it is saved.
 */
interface Draft {
  name: string;
  description: string;
  instructions: string;
  ai: boolean;
  note: string;
  bot: { id: string; name: string };
  bots: { id: string; name: string }[];
  team: { id: string | null; name: string; multi: boolean };
  source: { id: string; title: string; cut: boolean };
}

export function DocumentToSkillModal({ sourceId, onClose }: { sourceId: string; onClose(): void }) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [agentId, setAgentId] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [instructions, setInstructions] = useState('');
  const [scope, setScope] = useState<'bot' | 'team'>('bot');
  const [warn, setWarn] = useState<{
    error: string;
    scan: { severity: string; message: string }[];
  } | null>(null);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);

  const write = (bot?: string) => {
    setLoading(true);
    setError('');
    api
      .post<Draft>('/skills/from-document/draft', {
        sourceId,
        ...(bot ? { agentId: bot } : {}),
      })
      .then((d) => {
        setDraft(d);
        setAgentId(d.bot.id);
        setName(d.name);
        setDescription(d.description);
        setInstructions(d.instructions);
      })
      .catch((e) => setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => write(), [sourceId]);

  const bot = draft?.bots.find((b) => b.id === agentId) || draft?.bot;
  const save = async () => {
    if (!draft || !bot) return;
    setBusy(true);
    setError('');
    try {
      const r = await api.post<any>('/skills/from-document/save', {
        sourceId,
        agentId: bot.id,
        name,
        description,
        instructions,
        scope,
        acknowledge: ack,
      });
      if (r.status === 'created') {
        toast(scope === 'team' ? `Skill “${r.name}” bewaard voor het team` : `Skill “${r.name}” bewaard voor ${bot.name}`, 'ok');
        onClose();
        navigate(`/m/skills/mine/${r.skillId}`);
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
      title="Maak een skill van dit document"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="primary" loading={busy} disabled={!draft || loading || !name.trim() || !description.trim() || !instructions.trim() || (!!warn && !ack)} onClick={save}>
            Opslaan als skill
          </Button>
        </>
      }
    >
      {loading && (
        <div className="space-y-3" role="status">
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> De bot schrijft een concept uit dit document…
          </p>
          <Skeleton className="h-10 w-full rounded-control" />
          <Skeleton className="h-10 w-full rounded-control" />
          <Skeleton className="h-48 w-full rounded-control" />
        </div>
      )}
      {error && <p className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      {draft && !loading && (
        <div className="tb-in space-y-3">
          <p className="text-sm text-muted">
            {draft.ai ? `Concept van ${draft.bot.name}, uit “${draft.source.title}”. Lees het na en pas het aan.` : `Een opzet uit de koppen van “${draft.source.title}”. Vul de werkwijze aan.`}
            {draft.source.cut && ' Het document is lang: alleen het eerste deel is gebruikt.'}
          </p>
          {!draft.ai && draft.note && <p className="rounded-control bg-warn-soft px-3 py-2 text-sm text-warn">De AI schreef geen concept: {draft.note}</p>}
          <div className="flex flex-wrap items-end gap-2">
            <Field label="Voor bot">
              <Dropdown label="Bot" className="!min-w-0" value={agentId} onChange={setAgentId} options={draft.bots.map((b) => ({ value: b.id, label: b.name, attrs: { translate: 'no' } }))} />
            </Field>
            {agentId !== draft.bot.id && (
              <Button size="sm" onClick={() => write(agentId)}>
                Laat deze bot het concept schrijven
              </Button>
            )}
          </div>
          <Field label="Naam" hint="Kleine letters, cijfers en streepjes.">
            <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={64} />
          </Field>
          <Field label="Wat doet hij en wanneer gebruikt de bot hem?">
            <Input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={1024} />
          </Field>
          <Field label="Werkwijze (Markdown)">
            <Textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={12} className="font-mono text-[13px]" />
          </Field>
          <ScopeChoice value={scope} onChange={setScope} botName={bot?.name || ''} team={draft.team} />
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
