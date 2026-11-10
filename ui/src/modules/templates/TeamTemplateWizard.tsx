import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { Badge, Button, Field, Input, Select, Spinner, Textarea, Toggle, cx } from '../../components/ui';
import { BotAvatar, StackedFaces } from '../../components/BotFace';

/**
 * A team from a template (package R), in three steps: pick a template, answer a few questions for the team's profile,
 * look at the preview, then one button makes the team. Self-contained, so the new "Team maken" flow and the first-run
 * screen (wave 2) can place it as is. Server: /api/team-templates (server/modules/templates).
 */

interface Question {
  key: string;
  label: string;
  hint?: string;
  placeholder?: string;
  kind: 'text' | 'textarea';
}
interface TemplateBot {
  name: string;
  role: string;
  avatar: string;
  groupRole: 'lead' | 'member';
  specialist: { field: string } | null;
}
export interface TeamTemplateSummary {
  id: string;
  name: string;
  description: string;
  note: string;
  category: 'bedrijf' | 'prive' | 'algemeen';
  minimal: boolean;
  bots: TemplateBot[];
  questions: Question[];
  examples: { task: string; done: string }[];
  routines: number;
  skills: number;
}
interface Preview {
  bots: { name: string; role: string; avatar: string; groupRole: 'lead' | 'member'; skills: { name: string; action: string }[]; routines: number }[];
  routines: number;
  profileText: string;
  note: string;
  specialists: { bot: string; field: string }[];
  needsAcknowledge: boolean;
  warnings: string[];
}
export interface TeamCreated {
  teamId: string | null;
  roomId: string;
  threadId: string;
  agents: { id: string; name: string; role: 'lead' | 'member' }[];
  warnings: string[];
}

const GROUPS: { id: TeamTemplateSummary['category']; title: string }[] = [
  { id: 'bedrijf', title: 'Voor je bedrijf' },
  { id: 'prive', title: 'Privé' },
  { id: 'algemeen', title: 'Algemeen' },
];

function Cards({ list, chosen, onChoose }: { list: TeamTemplateSummary[]; chosen: string | null; onChoose(id: string): void }) {
  return (
    <div className="space-y-4">
      {GROUPS.map((g) => {
        const items = list.filter((t) => t.category === g.id);
        if (!items.length) return null;
        return (
          <section key={g.id} className="space-y-2">
            <h3 className="text-[13px] font-semibold text-muted">{g.title}</h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="radiogroup" aria-label={g.title}>
              {items.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="radio"
                  aria-checked={chosen === t.id}
                  onClick={() => onChoose(t.id)}
                  className={cx('flex flex-col items-start gap-2 rounded-xl border p-3 text-start text-sm', chosen === t.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2')}
                >
                  <StackedFaces bots={t.bots.map((b) => ({ name: b.name, avatar: b.avatar }))} size={40} />
                  <span className="font-semibold">{t.name}</span>
                  <span className="text-xs text-muted">{t.description}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * `onCreated` gets the new team (default: open its team chat). `category` shows only one group of templates (for
 * example the first-run screen with only the business templates). `prepare` (first-run screen) connects the AI found
 * on this pc when no AI was chosen, just before the team is made.
 */
export function TeamTemplateWizard({
  category,
  onCreated,
  onCancel,
  prepare,
}: {
  category?: TeamTemplateSummary['category'];
  onCreated?(r: TeamCreated): void;
  onCancel?(): void;
  prepare?(): Promise<{ id: string } | null>;
}) {
  const providers = useApp((s) => s.providers);
  const settings = useApp((s) => s.settings);
  const [list, setList] = useState<TeamTemplateSummary[] | null>(null);
  const [err, setErr] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [step, setStep] = useState<'kies' | 'vragen' | 'overzicht'>('kies');
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [skills, setSkills] = useState(true);
  const [provider, setProvider] = useState<string>(settings.defaultProvider || providers[0]?.id || '');
  const [ack, setAck] = useState(false);
  const [pv, setPv] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<TeamTemplateSummary[]>('/team-templates')
      .then((x) => setList(category ? x.filter((t) => t.category === category) : x))
      .catch((e) => setErr(e.message));
  }, [category]);
  const tpl = useMemo(() => list?.find((t) => t.id === chosen) || null, [list, chosen]);
  const body = () => ({ answers, skills: skills && !!tpl?.skills });

  const toPreview = async () => {
    if (!tpl) return;
    setBusy(true);
    setErr('');
    try {
      setPv(await api.post<Preview>(`/team-templates/${tpl.id}/preview`, body()));
      setStep('overzicht');
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (!tpl) return;
    setBusy(true);
    setErr('');
    try {
      let prov = provider;
      if (!prov && prepare) prov = (await prepare())?.id || '';
      const r = await api.post<TeamCreated>(`/team-templates/${tpl.id}/install`, { ...body(), provider_id: prov || undefined, acknowledge: ack });
      await Promise.all([useApp.getState().refreshAgents(), useApp.getState().refreshThreads()]);
      if (onCreated) onCreated(r);
      else navigate(`/t/${r.threadId}`);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!list) return err ? <p role="alert" className="text-sm text-danger">{err}</p> : <Spinner />;

  return (
    <div className="space-y-4">
      {step === 'kies' && (
        <>
          <Cards list={list} chosen={chosen} onChoose={(id) => (setChosen(id), setAnswers({}), setPv(null))} />
          <div className="flex flex-wrap justify-end gap-2">
            {onCancel && <Button onClick={onCancel}>Annuleren</Button>}
            <Button variant="primary" disabled={!tpl} onClick={() => setStep('vragen')}>
              Verder
            </Button>
          </div>
        </>
      )}

      {step === 'vragen' && tpl && (
        <>
          <div>
            <div className="font-semibold">{tpl.name}</div>
            <p className="text-sm text-muted">Een paar vragen voor het profiel van het team. Alle bots in het team krijgen het mee. Je kunt ook iets leeg laten.</p>
          </div>
          {tpl.questions.map((q) => (
            <Field key={q.key} label={q.label} hint={q.hint}>
              {q.kind === 'textarea' ? (
                <Textarea rows={3} value={answers[q.key] || ''} placeholder={q.placeholder} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} />
              ) : (
                <Input value={answers[q.key] || ''} placeholder={q.placeholder} onChange={(e) => setAnswers({ ...answers, [q.key]: e.target.value })} />
              )}
            </Field>
          ))}
          {tpl.skills > 0 && <Toggle checked={skills} onChange={setSkills} label="Voorgestelde skills uit de catalogus meeinstalleren" />}
          <Field label="AI voor deze bots" hint="Je kunt het per bot later aanpassen.">
            <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="">Standaard (Instellingen › Algemeen)</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <div className="flex flex-wrap justify-between gap-2">
            <Button icon={<ArrowLeft className="h-4 w-4 rtl-flip" />} onClick={() => setStep('kies')}>
              Terug
            </Button>
            <Button variant="primary" loading={busy} onClick={toPreview}>
              Voorbeeld bekijken
            </Button>
          </div>
        </>
      )}

      {step === 'overzicht' && tpl && pv && (
        <>
          <div className="font-semibold">{tpl.name}</div>
          <ul className="space-y-2" aria-label="Bots in dit team">
            {pv.bots.map((b) => {
              const sp = pv.specialists.find((x) => x.bot === b.name);
              return (
                <li key={b.name} className="flex items-start gap-3 rounded-xl border border-line p-3">
                  <BotAvatar bot={{ name: b.name, avatar: b.avatar }} size={40} />
                  <div className="min-w-0 flex-1 text-sm">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <span className="font-semibold" translate="no">
                        {b.name}
                      </span>
                      {b.groupRole === 'lead' && <Badge tone="accent">teamleider</Badge>}
                      <span className="text-xs text-muted">{b.role}</span>
                    </div>
                    <div className="mt-0.5 text-xs text-muted">
                      {b.skills.length > 0 && <div>Skills: {b.skills.map((s) => s.name).join(', ')}</div>}
                      {b.routines > 0 && <div>{b.routines === 1 ? '1 routine, staat uit tot jij hem aanzet' : `${b.routines} routines, staan uit tot jij ze aanzet`}</div>}
                      {sp && <div>Vakgebied: {sp.field}</div>}
                    </div>
                  </div>
                </li>
              );
            })}
          </ul>
          {pv.profileText && <div className="whitespace-pre-wrap rounded-xl bg-surface-2 p-3 text-xs">{pv.profileText}</div>}
          <p className="text-xs text-muted">Bots starten in “vraagt toestemming”, routines staan uit. Gesprekken en sleutels komen niet mee.</p>
          {pv.note && <p className="text-xs text-muted">{pv.note}</p>}
          {pv.warnings.length > 0 && (
            <div className="space-y-1 rounded-xl bg-warn-soft p-3 text-xs text-warn" role="status">
              {pv.warnings.slice(0, 8).map((w) => (
                <div key={w} className="flex gap-1.5">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {w}
                </div>
              ))}
            </div>
          )}
          {pv.needsAcknowledge && <Toggle checked={ack} onChange={setAck} label="Ik heb de waarschuwingen bij de skills gelezen" />}
          <div className="flex flex-wrap justify-between gap-2">
            <Button icon={<ArrowLeft className="h-4 w-4 rtl-flip" />} onClick={() => setStep('vragen')}>
              Terug
            </Button>
            <Button variant="primary" loading={busy} disabled={pv.needsAcknowledge && !ack} onClick={create}>
              Team maken
            </Button>
          </div>
        </>
      )}
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
    </div>
  );
}
