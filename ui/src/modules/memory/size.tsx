import React, { useEffect, useState } from 'react';
import { Ruler } from 'lucide-react';
import { Card, Field, Input, Select, CardHead } from '../../components/ui';
import { t } from '../../lib/i18n';
import { ErrorBox, Loading, Meter } from './parts';
import { useMem } from './lib';

const PART_LABEL: Record<string, string> = { about_you: 'Over jou', agent: 'Per bot (per team)', shared: 'Gedeeld (per team)', dossier: 'Per dossier', client: 'Per klantdossier' };

/**
 * Opslag › Doelomvang: memory never grows without end. Each part (Over jou, the notes of one bot, the shared knowledge of
 * a team, one dossier) has a target; nightly maintenance summarises and archives what is least worth keeping to stay
 * under it. Pinned memories, what you confirmed yourself and what is used often always stay.
 */
export function SizeCard({ settings, save }: { settings: any; save(patch: any): void }) {
  const r = useMem<any>('/memory/sizes');
  const [targets, setTargets] = useState<Record<string, string>>({});
  useEffect(() => setTargets(Object.fromEntries(Object.entries(settings.targets || {}).map(([k, v]) => [k, String(v)]))), [settings.targets]);
  const commit = (k: string) => {
    const n = Math.round(Number(targets[k]));
    if (n && n !== settings.targets?.[k]) save({ targets: { [k]: n } });
  };
  return (
    <Card className="space-y-3 p-4">
      <CardHead icon={Ruler} title="Doelomvang" />
      <p className="text-xs text-muted">Wordt een deel te groot, dan gaat het minst waardevolle naar het archief; met één klik terug te zetten.</p>
      {r.error && <ErrorBox error={r.error} retry={r.reload} />}
      {!r.error && !r.data && <Loading />}
      {r.data && (
        <div className="space-y-2">
          {r.data.parts.length === 0 && <p className="text-sm text-muted">Nog niets opgeslagen.</p>}
          {r.data.parts.slice(0, 8).map((p: any) => (
            <Meter key={p.key} label={p.label} value={p.active} max={Math.max(1, p.target)} hint={p.archived ? t('{0} van {1}, {2} in het archief', p.active, p.target, p.archived) : t('{0} van {1}', p.active, p.target)} />
          ))}
        </div>
      )}
      <div className="grid gap-2 sm:grid-cols-2">
        {(['about_you', 'agent', 'shared', 'dossier', 'client'] as const).map((k) => (
          <Field key={k} label={PART_LABEL[k]}>
            <Input type="number" min={20} value={targets[k] ?? ''} onChange={(e) => setTargets({ ...targets, [k]: e.target.value })} onBlur={() => commit(k)} aria-label={t('Doelomvang: {0}', PART_LABEL[k])} />
          </Field>
        ))}
      </div>
      <p className="text-xs text-muted">Een klant zonder activiteit gaat met zijn dossier naar het archief.</p>
      <Field label="Naar het archief als het niet gebruikt is" hint="Alleen wat weinig waard is en ook niet bevestigd werd.">
        <Select value={String(settings.archiveAfterDays || 180)} onChange={(e) => save({ archiveAfterDays: Number(e.target.value) })} aria-label="Naar het archief na">
          <option value="90">Na 3 maanden</option>
          <option value="180">Na 6 maanden</option>
          <option value="365">Na een jaar</option>
          <option value="730">Na twee jaar</option>
        </Select>
      </Field>
      <Field label="Dossiers voor terugkerende klanten en projecten" hint="Een bot kan een dossier voorstellen voor een terugkerend onderwerp.">
        <Select value={settings.dossierAuto || 'propose'} onChange={(e) => save({ dossierAuto: e.target.value })} aria-label="Dossiers voor terugkerende onderwerpen">
          <option value="propose">Voorstellen (ik kies met één klik)</option>
          <option value="create">Meteen maken voor het team van de bot</option>
          <option value="off">Niet: ik maak dossiers zelf</option>
        </Select>
      </Field>
    </Card>
  );
}
