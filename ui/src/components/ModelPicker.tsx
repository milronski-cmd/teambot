import { useEffect, useState } from 'react';
import { BILLING_LABEL, type ModelInfo } from '../lib/types';
import { Input } from './ui';
import { Listbox } from './Listbox';
import { translate } from '../lib/i18n';
import { Segmented } from './SettingControls';

/**
 * The model, simple first (0.4.5): "Automatisch" (the engine or provider picks its default model, nothing stored) or
 * "Zelf kiezen", which shows the list (ModelPicker). A stored model opens on "Zelf kiezen".
 */
export function ModelChoice({ models, value, onChange, loading, label = 'Model' }: { models: ModelInfo[]; value: string; onChange(v: string): void; loading?: boolean; label?: string }) {
  const chosen = !!value && value !== 'default';
  const [own, setOwn] = useState(chosen);
  useEffect(() => {
    if (chosen) setOwn(true);
  }, [chosen]);
  return (
    <div className="space-y-2">
      <Segmented
        label={label}
        value={own ? 'own' : 'auto'}
        testId="model-choice"
        options={[
          { value: 'auto', label: 'Automatisch' },
          { value: 'own', label: 'Zelf kiezen' },
        ]}
        onChange={(v) => {
          setOwn(v === 'own');
          if (v === 'auto' && value) onChange('');
        }}
      />
      {own && <ModelPicker models={models} loading={loading} value={value} onChange={onChange} />}
    </div>
  );
}

const CUSTOM = '__custom__';

/** "Opus: altijd de nieuwste (nu Opus 5.5 · claude-opus-5-5) · abonnement" — the billing only when the label lacks it. */
export function modelOptionLabel(m: ModelInfo): string {
  const base = m.label || m.id;
  return m.billing && !base.includes(BILLING_LABEL[m.billing]) ? `${base} · ${BILLING_LABEL[m.billing]}` : base;
}

/**
 * The model of a bot: a real list from the engine (Claude Code: "standaard", the aliases and the full ids it reports;
 * Codex, OpenCode and API providers: their model lists), plus "Ander model" for an id that is not listed. Without a
 * list (still loading, or the engine gives none) it is a plain text field.
 */
export function ModelPicker({ models, value, onChange, loading, placeholder = 'bijv. gpt-5.4-mini' }: { models: ModelInfo[]; value: string; onChange(v: string): void; loading?: boolean; placeholder?: string }) {
  const hasDefault = models.some((m) => m.id === 'default');
  const shown = !value && hasDefault ? 'default' : value;
  const known = !shown || models.some((m) => m.id === shown);
  const [custom, setCustom] = useState(!known);
  useEffect(() => {
    if (known) setCustom(false);
    else if (models.length) setCustom(true);
  }, [known, models.length]);
  if (!models.length) {
    return <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder={loading ? 'Modellen laden…' : placeholder} aria-label="Model" translate="no" />;
  }
  return (
    <div className="space-y-2">
      <Listbox
        value={custom ? CUSTOM : shown}
        aria-label="Model"
        onChange={(v) => {
          if (v === CUSTOM) return setCustom(true);
          setCustom(false);
          onChange(v);
        }}
        options={[
          ...(!hasDefault ? [{ value: '', label: translate('Standaard van de engine') }] : []),
          ...models.map((m) => ({ value: m.id, label: modelOptionLabel(m) })),
          { value: CUSTOM, label: translate('Ander model (zelf invullen)…') },
        ]}
      />
      {custom && <Input value={value} onChange={(e) => onChange(e.target.value)} placeholder="Model-id, precies zoals de engine het noemt" aria-label="Eigen model-id" autoFocus translate="no" />}
    </div>
  );
}
