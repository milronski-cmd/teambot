import { useEffect, useState } from 'react';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { Button, Field, Input, Modal, Select, Textarea, cx, useAsync } from '../../components/ui';
import { BotPicker as SharedBotPicker } from '../../components/BotPicker';
import { Fold } from '../../components/overview';
import { TeamSource } from './teams';

export type Mode = 'lead' | 'round_robin' | 'everyone' | 'mention';
export const MODES: { id: Mode; label: string; text: string }[] = [
  { id: 'lead', label: 'Lead', text: 'Eén lead-bot antwoordt en verdeelt het werk over de anderen.' },
  { id: 'round_robin', label: 'Om de beurt', text: 'Bots antwoorden na elkaar en zien elkaars bijdragen.' },
  { id: 'everyone', label: 'Iedereen', text: 'Alle bots antwoorden tegelijk (parallel).' },
  { id: 'mention', label: 'Alleen op vermelding', text: 'Alleen bots die je met @naam aanspreekt antwoorden.' },
];

function BotPicker({ value, onChange }: { value: string[]; onChange(v: string[]): void }) {
  return <SharedBotPicker value={value} onChange={onChange} empty="Je hebt nog geen bots. Maak eerst een bot aan." />;
}

/** "Nieuwe groepschat": a name, the bots, how they work together; or a template / a team package file. */
export function NewRoomModal({ open, onClose }: { open: boolean; onClose(): void }) {
  const agents = useApp((s) => s.agents);
  const [f, setF] = useState({ name: '', agentIds: [] as string[], mode: 'lead' as Mode, leadAgentId: '', instructions: '', maxCostUsd: '0', maxTurnsPerMessage: '' });
  // Zelf samenstellen, a team template (A-14) or a team package file (A-63).
  const [source, setSource] = useState<'self' | 'template' | 'import'>('self');
  const [teamBtn, setTeamBtn] = useState<{ label: string; disabled: boolean; run(): Promise<void> } | null>(null);
  const a = useAsync();
  useEffect(() => {
    if (open) setF({ name: '', agentIds: [], mode: 'lead', leadAgentId: '', instructions: '', maxCostUsd: '0', maxTurnsPerMessage: '' });
    if (open) (setSource('self'), setTeamBtn(null));
  }, [open]);
  const create = () =>
    a.run(async () => {
      const from = location.hash;
      const r = await api.post<{ threadId: string }>('/rooms', {
        name: f.name,
        agentIds: f.agentIds,
        mode: f.mode,
        leadAgentId: f.mode === 'lead' ? f.leadAgentId || f.agentIds[0] : undefined,
        instructions: f.instructions,
        // No built-in brakes: no cost cap and the standard (generous) turn cap unless the owner fills one in.
        limits: { maxCostUsd: Number(f.maxCostUsd.replace(',', '.')) || 0, ...(Number(f.maxTurnsPerMessage) > 0 ? { maxTurnsPerMessage: Number(f.maxTurnsPerMessage) } : {}) },
      });
      await useApp.getState().refreshThreads();
      onClose();
      navigate(`/t/${r.threadId}`, { from });
    });
  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title="Nieuwe groepschat"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          {source === 'self' ? (
            <Button variant="primary" loading={a.busy} disabled={!f.name.trim() || !f.agentIds.length} onClick={create}>
              Groepschat maken
            </Button>
          ) : (
            <Button variant="primary" loading={a.busy} disabled={!teamBtn || teamBtn.disabled} onClick={() => teamBtn && a.run(async () => (await teamBtn.run(), onClose()))}>
              {teamBtn?.label || (source === 'template' ? 'Groepschat maken' : 'Importeren')}
            </Button>
          )}
        </>
      }
    >
      <div className="mb-4 flex rounded-control border border-line p-0.5" role="tablist" aria-label="Hoe maak je de groepschat?">
        {(
          [
            ['self', 'Zelf samenstellen'],
            ['template', 'Uit een sjabloon'],
            ['import', 'Importeren'],
          ] as const
        ).map(([id, label]) => (
          <button key={id} type="button" role="tab" aria-selected={source === id} onClick={() => (setSource(id), setTeamBtn(null))} className={cx('h-9 flex-1 rounded-lg px-2 text-[13px] font-semibold coarse:h-11', source === id ? 'bg-surface-3 text-fg' : 'text-muted hover:text-fg')}>
            {label}
          </button>
        ))}
      </div>
      {source !== 'self' ? (
        <TeamSource key={source} kind={source} onReady={setTeamBtn} />
      ) : (
      <div className="space-y-4">
        <Field label="Naam">
          <Input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Bijv. Marketingteam" />
        </Field>
        <div className="space-y-1.5">
          <div className="text-sm font-medium">Bots in deze groepschat</div>
          <BotPicker value={f.agentIds} onChange={(agentIds) => setF({ ...f, agentIds })} />
        </div>
        <div className="space-y-1.5">
          <div className="text-sm font-medium">Hoe werken ze samen?</div>
          <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Werkwijze">
            {MODES.map((m) => (
              <button
                key={m.id}
                type="button"
                role="radio"
                aria-checked={f.mode === m.id}
                onClick={() => setF({ ...f, mode: m.id })}
                className={cx('rounded-control border px-3 py-2 text-start text-sm transition-colors coarse:min-h-11', f.mode === m.id ? 'border-fg/40 bg-surface-3' : 'border-line hover:bg-surface-2')}
              >
                <span className="block font-semibold">{m.label}</span>
                <span className="block text-[13px] text-muted">{m.text}</span>
              </button>
            ))}
          </div>
        </div>
        {f.mode === 'lead' && f.agentIds.length > 0 && (
          <Field label="Lead-bot">
            <Select value={f.leadAgentId || f.agentIds[0]} onChange={(e) => setF({ ...f, leadAgentId: e.target.value })}>
              {f.agentIds.map((id) => (
                <option key={id} value={id}>
                  {agents.find((x) => x.id === id)?.name}
                </option>
              ))}
            </Select>
          </Field>
        )}
        <Fold card={false} title="Meer opties" hint={t('Kostenplafond ${0}', f.maxCostUsd || '0')}>
          <Field label="Groepsinstructies" hint="Doel van de groep, rolverdeling, afspraken.">
            <Textarea rows={2} className="[field-sizing:content] max-h-60" value={f.instructions} onChange={(e) => setF({ ...f, instructions: e.target.value })} />
          </Field>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Kostenplafond (USD)" hint="De groep stopt bij dit bedrag. 0 = geen plafond.">
              <Input inputMode="decimal" value={f.maxCostUsd} onChange={(e) => setF({ ...f, maxCostUsd: e.target.value })} />
            </Field>
            <Field label="Max. beurten per bericht" hint="Voorkomt eindeloze rondes tussen bots.">
              <Input inputMode="numeric" value={f.maxTurnsPerMessage} onChange={(e) => setF({ ...f, maxTurnsPerMessage: e.target.value })} />
            </Field>
          </div>
        </Fold>
      </div>
      )}
    </Modal>
  );
}

