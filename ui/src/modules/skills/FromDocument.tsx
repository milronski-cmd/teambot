import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { navigate } from '../../lib/router';
import { Button, Field } from '../../components/ui';
import { Dropdown } from '../../components/SettingControls';
import { DraftFields, DraftLoading, DraftModal, useSkillDraft } from './SaveAsSkill';

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
  const d = useSkillDraft();

  const write = (bot?: string) => {
    setLoading(true);
    d.setError('');
    api
      .post<Draft>('/skills/from-document/draft', {
        sourceId,
        ...(bot ? { agentId: bot } : {}),
      })
      .then((x) => {
        setDraft(x);
        setAgentId(x.bot.id);
        d.fill(x);
      })
      .catch((e) => d.setError(e?.message || String(e)))
      .finally(() => setLoading(false));
  };
  useEffect(() => write(), [sourceId]);

  const bot = draft?.bots.find((b) => b.id === agentId) || draft?.bot;
  const save = async () => {
    if (!draft || !bot) return;
    const from = location.hash;
    const r = await d.save('/skills/from-document/save', { sourceId, agentId: bot.id }, bot.name);
    if (!r) return;
    onClose();
    navigate(`/m/skills/mine/${r.skillId}`, { from });
  };

  return (
    <DraftModal title="Maak een skill van dit document" d={d} ready={!!draft && !loading} onSave={save} onClose={onClose}>
      {loading && <DraftLoading>De bot schrijft een concept uit dit document…</DraftLoading>}
      {draft && !loading && (
        <div className="tb-in space-y-3">
          <p className="text-sm text-muted">
            {draft.ai ? `Concept van ${draft.bot.name}, uit “${draft.source.title}”. Lees het na en pas het aan.` : `Een opzet uit de koppen van “${draft.source.title}”. Vul de werkwijze aan.`}
            {draft.source.cut && ' Het document is lang: alleen het eerste deel is gebruikt.'}
          </p>
          <DraftFields d={d} draft={draft} botName={bot?.name || ''}>
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
          </DraftFields>
        </div>
      )}
    </DraftModal>
  );
}
