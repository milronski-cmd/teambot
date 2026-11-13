import { useEffect, useState } from 'react';
import { ArrowRight, Undo2, Upload } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatDateTime, formatList } from '../../lib/format';
import { Badge, Button, Card, Modal, Spinner, toast, useAsync } from '../../components/ui';
import { toggleIn } from './parts';

/**
 * "Overstappen uit OpenClaw" (0.4.4; server/modules/openbot-import/openclaw.ts): a card under Instellingen ›
 * Overstappen. Read OpenClaw (read only, without keys) → preview with what comes over → import → summary, and undo.
 */

interface Detect {
  available: boolean;
  found: boolean;
  dir?: string;
  imported?: {
    at: string;
    counts: {
      bots: number;
      routines: number;
      skills: number;
      memories: number;
    };
  } | null;
  undoable?: boolean;
}
interface Plan {
  stagingId: string;
  dir: string;
  bots: {
    key: string;
    name: string;
    emoji: string;
    model: string;
    engine: { label: string; linked: boolean; note: string };
    workspace: string;
    workspaceExists: boolean;
    instructions: { chars: number; files: string[] };
    memories: number;
    dailyLogs: number;
    skills: string[];
    routines: number;
    existing: { id: string; name: string } | null;
    selected: boolean;
  }[];
  aboutYou: number;
  skills: {
    name: string;
    shared: boolean;
    bots: string[];
    scan: string;
    errors: string[];
    selected: boolean;
  }[];
  routines: {
    key: string;
    name: string;
    bot: string;
    wasOn: boolean;
    schedule: string;
    prompt: string;
    error: string;
    selected: boolean;
  }[];
  notImported: string[];
  warnings: string[];
  memoryAvailable: boolean;
}
interface Result {
  counts: { bots: number; routines: number; skills: number; memories: number };
  bots: { name: string; status: string; error?: string; note?: string }[];
  attention: string[];
}

function Check({ checked, onChange, disabled, children }: { checked: boolean; onChange(v: boolean): void; disabled?: boolean; children: React.ReactNode }) {
  return (
    <label className="flex items-start gap-2 py-1 text-sm">
      <input type="checkbox" className="mt-0.5 h-4 w-4" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
      <span className="min-w-0 flex-1">{children}</span>
    </label>
  );
}

function PreviewModal({ onClose, onDone }: { onClose(): void; onDone(r: Result): void }) {
  const [plan, setPlan] = useState<Plan | null>(null);
  const [error, setError] = useState('');
  const [bots, setBots] = useState<Set<string>>(new Set());
  const [skills, setSkills] = useState<Set<string>>(new Set());
  const [routines, setRoutines] = useState<Set<string>>(new Set());
  const [memories, setMemories] = useState(true);
  const { busy, run } = useAsync();
  useEffect(() => {
    api
      .post<Plan>('/openbot-import/openclaw/preview', {})
      .then((p) => {
        setPlan(p);
        setBots(new Set(p.bots.filter((b) => b.selected).map((b) => b.key)));
        setSkills(new Set(p.skills.filter((s) => s.selected).map((s) => s.name)));
        setRoutines(new Set(p.routines.filter((r) => r.selected).map((r) => r.key)));
      })
      .catch((e) => setError(e.message));
  }, []);
  const toggle = (set: Set<string>, put: (s: Set<string>) => void, k: string, v: boolean) => put(toggleIn(set, k, v));
  const commit = () =>
    run(async () => {
      const r = await api.post<Result>('/openbot-import/openclaw/commit', {
        stagingId: plan!.stagingId,
        bots: [...bots],
        skills: [...skills],
        routines: [...routines],
        memories: memories ? 'review' : 'off',
      });
      toast('Overgenomen uit OpenClaw', 'ok');
      onDone(r);
    });
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Overstappen uit OpenClaw"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="primary" loading={busy} disabled={!plan || (!bots.size && !skills.size && !routines.size)} onClick={commit}>
            Importeren
          </Button>
        </>
      }
    >
      {error && <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{error}</p>}
      {!plan && !error && (
        <p className="flex items-center gap-2 text-sm text-muted">
          <Spinner /> OpenClaw inlezen (alleen lezen)…
        </p>
      )}
      {plan && (
        <div className="space-y-4">
          <p className="break-all text-sm text-muted">{t('Gelezen uit {0}. Er is nog niets veranderd, in TeamBot en in OpenClaw.', plan.dir)}</p>
          {plan.warnings.map((w) => (
            <p key={w} className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
              {w}
            </p>
          ))}
          <section>
            <h3 className="text-sm font-semibold">Bots</h3>
            {plan.bots.map((b) => (
              <Check key={b.key} checked={bots.has(b.key)} disabled={!!b.existing} onChange={(v) => toggle(bots, setBots, b.key, v)}>
                <span className="font-medium" translate="no">
                  {b.emoji ? `${b.emoji} ` : ''}
                  {b.name}
                </span>
                {b.existing && <Badge className="ms-2">Al overgenomen</Badge>}
                <span className="block text-xs text-muted">
                  {[
                    b.model || 'geen model',
                    b.engine.note,
                    b.instructions.files.length ? t('instructies uit {0}', formatList(b.instructions.files)) : 'geen instructies',
                    t('{0, plural, one {# herinnering} other {# herinneringen}}', b.memories),
                    t('{0, plural, one {# routine} other {# routines}}', b.routines),
                  ].join(' · ')}
                </span>
              </Check>
            ))}
          </section>
          {plan.skills.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold">Skills (gecontroleerd, staan daarna uit)</h3>
              {plan.skills.map((s) => (
                <Check key={s.name} checked={skills.has(s.name)} disabled={!!s.errors.length} onChange={(v) => toggle(skills, setSkills, s.name, v)}>
                  <span translate="no">{s.name}</span>
                  {s.scan === 'danger' && (
                    <Badge tone="danger" className="ms-2">
                      Ernstige waarschuwing
                    </Badge>
                  )}
                  {s.scan === 'warn' && (
                    <Badge tone="warn" className="ms-2">
                      Waarschuwing
                    </Badge>
                  )}
                  <span className="block text-xs text-muted">{s.errors[0] || (s.shared ? 'Gedeeld met alle agents in OpenClaw' : t('Van {0}', s.bots.join(', ')))}</span>
                </Check>
              ))}
            </section>
          )}
          {plan.routines.length > 0 && (
            <section>
              <h3 className="text-sm font-semibold">Routines (staan daarna uit)</h3>
              {plan.routines.map((r) => (
                <Check key={r.key} checked={routines.has(r.key)} disabled={!!r.error} onChange={(v) => toggle(routines, setRoutines, r.key, v)}>
                  <span>{r.name}</span>
                  <span className="block text-xs text-muted">{r.error ? t('Kan niet mee: {0}', r.error) : `${r.bot} · ${r.schedule}`}</span>
                </Check>
              ))}
            </section>
          )}
          {plan.memoryAvailable && (
            <section>
              <h3 className="text-sm font-semibold">Geheugen</h3>
              <Check checked={memories} onChange={setMemories}>
                {t('Herinneringen komen als voorstel onder Geheugen › Te beoordelen.', plan.aboutYou)}
              </Check>
            </section>
          )}
          <section>
            <h3 className="text-sm font-semibold">Wat niet meekomt</h3>
            <ul className="list-disc space-y-0.5 ps-5 text-sm text-muted">
              {plan.notImported.map((x) => (
                <li key={x}>{x}</li>
              ))}
            </ul>
          </section>
        </div>
      )}
    </Modal>
  );
}

function UndoOpenClaw({ onDone }: { onDone(): void }) {
  const [plan, setPlan] = useState<{
    bots: string[];
    routines: number;
    skills: string[];
    memories: number;
  } | null>(null);
  const { busy, run } = useAsync();
  return (
    <>
      <Button icon={<Undo2 className="h-4 w-4" />} loading={busy} onClick={() => run(async () => setPlan(await api.get('/openbot-import/openclaw/undo')))}>
        Import ongedaan maken
      </Button>
      {plan && (
        <Modal
          open
          onClose={() => setPlan(null)}
          title="Import uit OpenClaw ongedaan maken?"
          footer={
            <>
              <Button variant="ghost" onClick={() => setPlan(null)}>
                Annuleren
              </Button>
              <Button
                variant="danger"
                loading={busy}
                onClick={() =>
                  run(async () => {
                    await api.post('/openbot-import/openclaw/undo', {});
                    setPlan(null);
                    toast('Import ongedaan gemaakt', 'ok');
                    onDone();
                  })
                }
              >
                Ongedaan maken
              </Button>
            </>
          }
        >
          <p className="text-sm">Dit gaat weg:</p>
          <ul className="list-disc space-y-0.5 ps-5 text-sm">
            <li>{plan.bots.length ? t('de bots {0} (met hun gesprekken in TeamBot);', plan.bots.join(', ')) : 'geen bots;'}</li>
            <li>{t('{0, plural, one {# routine;} other {# routines;}}', plan.routines)}</li>
            <li>{t('{0, plural, one {# skill;} other {# skills;}}', plan.skills.length)}</li>
            <li>{t('{0, plural, one {# herinnering.} other {# herinneringen.}}', plan.memories)}</li>
          </ul>
          <p className="mt-2 text-sm text-muted">OpenClaw zelf en zijn werkmappen blijven zoals ze zijn.</p>
        </Modal>
      )}
    </>
  );
}

/**
 * `embedded`: shown inside the "Uit een andere app" part of the Overstappen card (Banner.tsx), so no card of its
 * own; the content and the preview/undo are the same.
 */
export function OpenClawCard({ embedded = false }: { embedded?: boolean } = {}) {
  const [d, setD] = useState<Detect | null>(null);
  const [open, setOpen] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const load = () =>
    api
      .get<Detect>('/openbot-import/openclaw/detect')
      .then(setD)
      .catch(() => setD({ available: false, found: false }));
  useEffect(() => void load(), []);
  if (!d?.available) return null;
  const Wrap = embedded ? EmbeddedBox : Card;
  return (
    <Wrap className={embedded ? 'space-y-2' : 'space-y-3 p-5'}>
      <div className={embedded ? 'flex items-center gap-2 text-sm font-medium' : 'flex items-center gap-2 font-medium'}>
        <Upload className="h-4 w-4 text-accent" aria-hidden /> Overstappen uit OpenClaw
      </div>
      <p className="text-sm text-muted">
        Leest OpenClaw op deze computer (alleen lezen, zonder sleutels) en maakt van elke agent een bot: instructies, persoonlijkheid, herinneringen als voorstel, skills en geplande taken. Skills en
        routines komen uitgeschakeld binnen.
      </p>
      <p className="break-all text-sm">{d.found ? t('Gevonden: {0}', d.dir || '') : t('Niet gevonden (gezocht in {0}).', d.dir || '')}</p>
      {d.imported && (
        <p className="text-sm text-muted">
          {t(
            'Laatst overgenomen op {0}: {1, plural, one {# bot} other {# bots}}, {2, plural, one {# routine} other {# routines}}, {3, plural, one {# skill} other {# skills}}.',
            formatDateTime(d.imported.at),
            d.imported.counts.bots,
            d.imported.counts.routines,
            d.imported.counts.skills,
          )}
        </p>
      )}
      {result && (
        <div className="space-y-1 rounded-lg bg-surface-2 p-3 text-sm">
          <div className="font-medium">
            {t(
              'Overgenomen: {0, plural, one {# bot} other {# bots}}, {1, plural, one {# routine} other {# routines}} (uit), {2, plural, one {# skill} other {# skills}} (uit), {3, plural, one {# herinnering} other {# herinneringen}} ter controle.',
              result.counts.bots,
              result.counts.routines,
              result.counts.skills,
              result.counts.memories,
            )}
          </div>
          {result.attention.map((a) => (
            <p key={a} className="text-warn">
              {a}
            </p>
          ))}
          {result.bots
            .filter((b) => b.status === 'error')
            .map((b) => (
              <p key={b.name} className="text-danger">
                {b.name}: {b.error}
              </p>
            ))}
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={!d.found} icon={<ArrowRight className="h-4 w-4" />} onClick={() => setOpen(true)}>
          {d.imported ? 'Opnieuw inlezen' : 'OpenClaw inlezen'}
        </Button>
        {d.undoable && <UndoOpenClaw onDone={() => (setResult(null), load())} />}
      </div>
      {open && (
        <PreviewModal
          onClose={() => setOpen(false)}
          onDone={(r) => {
            setOpen(false);
            setResult(r);
            load();
          }}
        />
      )}
    </Wrap>
  );
}

function EmbeddedBox({ className, children }: { className?: string; children?: React.ReactNode }) {
  return <div className={className}>{children}</div>;
}
