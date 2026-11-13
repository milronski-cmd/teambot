import { useEffect, useRef, useState } from 'react';
import { FileUp, TriangleAlert } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { Badge, Button, Field, Select, Spinner, Toggle, cx } from '../../components/ui';
import { BotAvatar, StackedFaces } from '../../components/BotFace';
import { MoreInfo } from '../../components/MoreInfo';
import { SkeletonCards } from '../../components/overview';
import { t } from '../../lib/i18n';
import { PLACE } from '../../../../shared/places.js';

/**
 * A team from a template (A-14) or from a team package file (A-63), inside "Nieuwe groep": pick, look at the preview
 * (bots with their role in the group, the lead, the way of working, skills and routines that come in switched off),
 * choose the engine, then one button makes the bots and the group.
 */
export interface TeamTemplate {
  id: string;
  name: string;
  description: string;
  mode: string;
  bots: { name: string; role: string; avatar: string; groupRole: 'lead' | 'member' }[];
}
interface TeamPreview {
  name: string;
  description: string;
  modeLabel: string;
  instructions: string;
  lead: string | null;
  bots: { name: string; role: string; avatar: string; groupRole: 'lead' | 'member'; access_mode: string; tool_groups: string[]; skills: { name: string; action: string }[]; routines: number; instructions: string }[];
  routines: number;
  needsAcknowledge: boolean;
  warnings: string[];
}

const ACCESS: Record<string, string> = { readonly: 'alleen lezen', ask: 'vraagt toestemming', auto: 'automatisch', full: 'volledige toegang', chat: 'alleen chat' };

function Preview({ p }: { p: TeamPreview }) {
  return (
    <div className="space-y-3" aria-live="polite">
      <div className="rounded-xl bg-surface-2 p-3 text-sm">
        <div className="font-semibold">{p.name}</div>
        {p.description && <div className="text-muted">{p.description}</div>}
        <div className="mt-1 text-xs text-muted">{p.modeLabel}</div>
        {p.instructions && (
          <MoreInfo block label="Groepsinstructies" className="mt-1.5">
            <span className="block whitespace-pre-wrap">{p.instructions.slice(0, 600)}</span>
          </MoreInfo>
        )}
      </div>
      <ul className="space-y-2" aria-label="Bots in deze groep">
        {p.bots.map((b) => (
          <li key={b.name} className="flex items-start gap-3 rounded-control border border-line p-3">
            <BotAvatar bot={{ name: b.name, avatar: b.avatar }} size={32} />
            <div className="min-w-0 flex-1 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="font-semibold">{b.name}</span>
                {b.groupRole === 'lead' && <Badge tone="accent">lead</Badge>}
                <span className="text-xs text-muted" translate="no">
                  {b.role}
                </span>
              </div>
              <div className="mt-0.5 text-xs text-muted">
                {ACCESS[b.access_mode] || b.access_mode}
                {b.tool_groups.length ? ` · ${b.tool_groups.join(', ')}` : ''}
                {b.skills.length ? ` · skills: ${b.skills.map((s) => s.name + (s.action === 'use-existing' ? ' (heb je al)' : s.action === 'error' ? ' (overgeslagen)' : '')).join(', ')}` : ''}
                {b.routines ? ` · ${b.routines === 1 ? '1 routine' : `${b.routines} routines`} (staan uit)` : ''}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-muted">
        Komt niet mee: gesprekken, geheugen, sleutels en werkmappen. <MoreInfo>Ook je AI-keuze komt niet mee. Bots starten in “vraagt toestemming”; routines staan uit tot jij ze aanzet.</MoreInfo>
      </p>
      {p.warnings.length > 0 && (
        <div className="space-y-1 rounded-xl bg-warn-soft p-3 text-xs text-warn" role="status">
          {p.warnings.slice(0, 8).map((w) => (
            <div key={w} className="flex gap-1.5">
              <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {w}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** The body of "Nieuwe groep › Uit een sjabloon" or "› Importeren". `onReady` gives the modal its primary button. */
export function TeamSource({ kind, onReady }: { kind: 'template' | 'import'; onReady(b: { label: string; disabled: boolean; run(): Promise<void> } | null): void }) {
  const providers = useApp((s) => s.providers);
  const settings = useApp((s) => s.settings);
  const [templates, setTemplates] = useState<TeamTemplate[] | null>(null);
  const [chosen, setChosen] = useState<{ templateId?: string; package?: any; file?: string } | null>(null);
  const [pv, setPv] = useState<TeamPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [provider, setProvider] = useState<string>(settings.defaultProvider || providers[0]?.id || '');
  const [ack, setAck] = useState(false);
  const file = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (kind === 'template') api.get<TeamTemplate[]>('/rooms/templates').then(setTemplates).catch((e) => setErr(e.message));
  }, [kind]);
  useEffect(() => {
    setPv(null);
    setErr('');
    if (!chosen || (!chosen.templateId && !chosen.package)) return;
    let live = true;
    setBusy(true);
    api
      .post<TeamPreview>('/rooms/packages/preview', chosen.templateId ? { templateId: chosen.templateId } : { package: chosen.package })
      .then((x) => live && setPv(x))
      .catch((e) => live && setErr(e.message))
      .finally(() => live && setBusy(false));
    return () => {
      live = false;
    };
  }, [chosen]);
  useEffect(() => {
    if (!pv || !chosen) return onReady(null);
    onReady({
      label: kind === 'template' ? 'Groepschat maken' : 'Importeren',
      disabled: pv.needsAcknowledge && !ack,
      run: async () => {
        const from = location.hash;
        const r = await api.post<{ threadId: string }>('/rooms/packages/install', { ...(chosen.templateId ? { templateId: chosen.templateId } : { package: chosen.package }), provider_id: provider || undefined, acknowledge: ack });
        await Promise.all([useApp.getState().refreshAgents(), useApp.getState().refreshThreads()]);
        navigate(`/t/${r.threadId}`, { from });
      },
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pv, chosen, provider, ack]);

  const readFile = async (f: File) => {
    try {
      const json = JSON.parse(await f.text());
      setChosen({ package: json, file: f.name });
    } catch {
      setErr('Dit bestand is geen geldig teampakket (JSON).');
    }
  };

  return (
    <div className="space-y-4">
      {kind === 'template' ? (
        !templates ? (
          err ? <p className="text-sm text-danger">{err}</p> : <SkeletonCards n={3} />
        ) : (
          <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Groepssjablonen">
            {templates.map((t) => (
              <button
                key={t.id}
                type="button"
                role="radio"
                aria-checked={chosen?.templateId === t.id}
                onClick={() => setChosen({ templateId: t.id })}
                className={cx('flex flex-col items-start gap-2 rounded-xl border p-3 text-left text-sm', chosen?.templateId === t.id ? 'border-accent bg-accent-soft' : 'border-line hover:bg-surface-2')}
              >
                <StackedFaces bots={t.bots.map((b) => ({ name: b.name, avatar: b.avatar }))} size={40} />
                <span className="font-semibold">{t.name}</span>
                <span className="text-xs text-muted">{t.description}</span>
              </button>
            ))}
          </div>
        )
      ) : (
        <div className="flex flex-wrap items-center gap-3">
          <input ref={file} type="file" accept=".json,application/json" hidden onChange={(e) => e.target.files?.[0] && (readFile(e.target.files[0]), (e.target.value = ''))} />
          <Button icon={<FileUp className="h-4 w-4" />} onClick={() => file.current?.click()}>
            Teampakket kiezen
          </Button>
          <span className="min-w-0 text-[13px] text-muted [overflow-wrap:anywhere]">{chosen?.file || 'Het bestand uit “Exporteren als team” van een groep.'}</span>
        </div>
      )}
      {err && chosen && <p role="alert" className="text-sm text-danger">{err}</p>}
      {busy && <Spinner />}
      {pv && (
        <>
          <Preview p={pv} />
          <Field label="AI voor deze bots" hint="Je kunt het per bot later aanpassen.">
            <Select value={provider} onChange={(e) => setProvider(e.target.value)}>
              <option value="">{t('Standaard ({0})', t(PLACE.botDefaults))}</option>
              {providers.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </Field>
          {pv.needsAcknowledge && <Toggle checked={ack} onChange={setAck} label="Ik heb de waarschuwingen bij de skills gelezen" />}
        </>
      )}
    </div>
  );
}
