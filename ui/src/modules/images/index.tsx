import { useEffect, useState } from 'react';
import { ImagePlus } from 'lucide-react';
import type { UIModule } from '../types';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Button, Card, EmptyState, Field, Input, Spinner, toastError } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { MoreInfo } from '../../components/MoreInfo';
import { Skeleton } from '../../components/overview';

/**
 * Instellingen › Geavanceerd › Meer over AI › Afbeeldingen maken: which connected AI service makes the images of the
 * tool generate_image, which model, how many per day at most, and a proof image. Data: /api/images/*.
 */

interface Status {
  settings: { provider: string; models: Record<string, string>; dailyMax: number };
  sources: { id: string; name: string; kind: string }[];
  chosen: { id: string; name: string; model: string } | null;
  models: string[];
  madeToday: number;
}

function ImageSettings() {
  const [s, setS] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [model, setModel] = useState('');
  const [max, setMax] = useState('20');
  const [busy, setBusy] = useState(false);
  const [proof, setProof] = useState<{ src: string; by: string } | null>(null);
  const take = (x: Status) => {
    setS(x);
    setModel(x.chosen?.model || '');
    setMax(String(x.settings.dailyMax));
  };
  useEffect(() => {
    api
      .get<Status>('/images/status')
      .then(take)
      .catch((e) => setError(e?.message || String(e)));
  }, []);
  const save = (patch: Record<string, unknown>) =>
    api
      .put<Status>('/images/settings', patch)
      .then(take)
      .catch(toastError);
  const test = async () => {
    setBusy(true);
    setProof(null);
    try {
      const r = await api.post<{ service: string; model: string; mime: string; data: string }>('/images/test', {});
      setProof({ src: `data:${r.mime};base64,${r.data}`, by: `${r.service} · ${r.model}` });
      take(await api.get<Status>('/images/status'));
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  if (error)
    return (
      <Card>
        <EmptyState icon={<ImagePlus />} title="De instellingen konden niet laden">
          {error}
        </EmptyState>
      </Card>
    );
  if (!s)
    return (
      <Card className="space-y-4 p-5" role="status" aria-label="Laden">
        <div className="grid gap-3 sm:grid-cols-2">
          <Skeleton className="h-14" />
          <Skeleton className="h-14" />
        </div>
        <Skeleton className="h-9 w-48" />
      </Card>
    );
  if (!s.sources.length)
    return (
      <Card>
        <EmptyState
          icon={<ImagePlus />}
          title="Nog geen dienst die afbeeldingen kan maken"
          action={
            <a href="#/settings/providers" className="inline-flex h-9 items-center rounded-control bg-accent px-4 text-sm font-semibold text-accent-fg hover:opacity-90 coarse:h-11">
              AI-dienst koppelen
            </a>
          }
        >
          Koppel een AI-dienst met een sleutel. <MoreInfo>Dat kan met OpenAI, xAI of Together. Een abonnement zoals Claude of ChatGPT kan dit niet.</MoreInfo>
        </EmptyState>
      </Card>
    );
  const custom = model && !s.models.includes(model);
  return (
    <Card className="tb-in space-y-4 p-5">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Dienst">
          <Select value={s.chosen?.id || ''} onChange={(e) => save({ provider: e.target.value })}>
            {s.sources.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Model" hint={s.models.length ? undefined : 'Typ de naam van het model op je server.'}>
          {s.models.length ? (
            <Select value={model} onChange={(e) => save({ modelFor: s.chosen?.id, model: e.target.value })}>
              {!model && <option value="">Kies een model…</option>}
              {custom && <option value={model}>{model}</option>}
              {s.models.map((m) => (
                <option key={m} value={m}>
                  {m}
                </option>
              ))}
            </Select>
          ) : (
            <Input value={model} onChange={(e) => setModel(e.target.value)} onBlur={() => model !== (s.chosen?.model || '') && save({ modelFor: s.chosen?.id, model })} />
          )}
        </Field>
        <Field label="Hoogstens per dag" hint={t('{0, plural, one {Vandaag # gemaakt.} other {Vandaag # gemaakt.}}', s.madeToday)}>
          <Input type="number" min={0} max={500} value={max} onChange={(e) => setMax(e.target.value)} onBlur={() => Number(max) !== s.settings.dailyMax && save({ dailyMax: Number(max) })} />
        </Field>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Button loading={busy} disabled={!model} onClick={test}>
          Proefafbeelding maken
        </Button>
        <span className="min-w-0 text-[13px] text-muted">
          {proof ? t('Gemaakt met {0}.', proof.by) : 'De dienst rekent elke afbeelding apart af.'} <MoreInfo>Dat valt buiten je tokenbudget. De beschrijving van de afbeelding gaat naar die dienst.</MoreInfo>
        </span>
      </div>
      {proof && <img src={proof.src} alt="Proefafbeelding" className="tb-in max-h-72 max-w-full rounded-card border border-line" />}
    </Card>
  );
}

const mod: UIModule = {
  id: 'images',
  label: 'Afbeeldingen maken',
  settingsTabs: [{ id: 'afbeeldingen', title: 'Afbeeldingen maken', component: ImageSettings }],
};

export default mod;
