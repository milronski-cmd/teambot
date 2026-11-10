import { useEffect, useState } from 'react';
import { AlarmClock, ArrowRight, Bot, Brain, CheckCircle2, ClipboardList, Puzzle, RefreshCw, ShieldCheck, Upload } from 'lucide-react';
import { Badge, Button, Card, Input, Select, Spinner, cx, toastError } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { formatDateTime } from '../../lib/format';
import { prettyModel } from '../../lib/modelLabel';
import { type EngineStatus, type HermesDetect, type HermesPlan, type HermesResult, type UndoResult, hermesApi } from './api';
import { AllNone, AttentionList, Check, Section } from './parts';
import { UndoButton, UndoneCard } from './Undo';

/**
 * Overstappen uit Hermes Agent: read the Hermes folder (default ~/.hermes, or a folder you type), see what comes
 * over, import, undo. Same promises as the OpenBot import: read only, no keys, routines switched off.
 */

const ENGINE_TONE: Record<EngineStatus, 'ok' | 'accent' | 'warn' | 'danger' | 'neutral'> = { ready: 'ok', connect: 'accent', reconnect: 'warn', missing: 'warn', unknown: 'danger' };
const ENGINE_LABEL: Record<EngineStatus, string> = { ready: 'gekoppeld', connect: 'wordt gekoppeld', reconnect: 'opnieuw verbinden', missing: 'niet gevonden', unknown: 'geen equivalent' };

const toggle = (set: Set<string>, key: string, on: boolean) => (on ? new Set([...set, key]) : new Set([...set].filter((k) => k !== key)));

function Summary({ r, onAgain, onUndone }: { r: HermesResult; onAgain(): void; onUndone(u: UndoResult): void }) {
  const tiles = [
    { n: r.counts.bots, label: t('{0, plural, one {bot} other {bots}}', r.counts.bots), href: '#/agents' },
    { n: r.counts.skills, label: t('{0, plural, one {skill} other {skills}}', r.counts.skills), href: '#/m/skills' },
    { n: r.counts.routines, label: t('{0, plural, one {routine (uit)} other {routines (uit)}}', r.counts.routines), href: '#/m/routines' },
    { n: r.counts.memories, label: t('{0, plural, one {herinnering} other {herinneringen}}', r.counts.memories), href: '#/m/memory' },
  ];
  const errors = [...r.bots.filter((b) => b.status === 'error').map((b) => `${b.name}: ${b.error}`), ...r.routines.filter((x) => x.status === 'error').map((x) => `${x.name}: ${x.error}`)];
  return (
    <div className="space-y-5">
      <Card className="space-y-4 p-5">
        <div className="flex items-center gap-2 text-base font-semibold">
          <CheckCircle2 className="h-5 w-5 text-ok" /> Je Hermes-bots zijn overgenomen
        </div>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {tiles.map((x) => (
            <a key={x.href} href={x.href} className="rounded-xl border border-line bg-surface-2 px-3 py-3 hover:border-accent">
              <div className="text-2xl font-semibold tabular-nums">{x.n}</div>
              <div className="text-xs text-muted">{x.label}</div>
            </a>
          ))}
        </div>
        {r.providers.length > 0 && (
          <ul className="space-y-0.5 text-sm">
            {r.providers.map((p, i) => (
              <li key={i} className="flex items-start gap-2">
                <Badge tone={p.status === 'linked' ? 'ok' : 'warn'}>{p.label}</Badge>
                <span className="text-muted">{p.note}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      {(r.attention.length > 0 || errors.length > 0) && (
        <Section icon={<ClipboardList className="h-4 w-4" />} title="Nog even regelen">
          <AttentionList items={[...errors.map((text) => ({ level: 'warn' as const, text })), ...r.attention]} />
        </Section>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Bot className="h-4 w-4" />} onClick={() => navigate('/agents')}>
          Naar je bots
        </Button>
        <Button icon={<AlarmClock className="h-4 w-4" />} onClick={() => navigate('/m/routines')}>
          Routines aanzetten
        </Button>
        <Button variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={onAgain}>
          Nogmaals inlezen
        </Button>
        {r.undo && <UndoButton from="hermes" onDone={onUndone} />}
      </div>
    </div>
  );
}

export function HermesImport() {
  const [det, setDet] = useState<HermesDetect | null>(null);
  const [folder, setFolder] = useState('');
  const [plan, setPlan] = useState<HermesPlan | null>(null);
  const [result, setResult] = useState<HermesResult | null>(null);
  const [undone, setUndone] = useState<UndoResult | null>(null);
  const [busy, setBusy] = useState<'' | 'read' | 'import'>('');
  const [error, setError] = useState('');
  const [bots, setBots] = useState<Set<string>>(new Set());
  const [routines, setRoutines] = useState<Set<string>>(new Set());
  const [skills, setSkills] = useState<Set<string>>(new Set());
  const [memories, setMemories] = useState<'active' | 'review' | 'off'>('active');
  const [ack, setAck] = useState(false);

  const loadDetect = () =>
    hermesApi
      .detect()
      .then((d) => {
        setDet(d);
        setFolder((f) => f || d.home || '');
      })
      .catch(() => setDet({ available: false, found: false }));
  useEffect(() => {
    loadDetect();
  }, []);

  const read = async () => {
    setBusy('read');
    setError('');
    setResult(null);
    setUndone(null);
    try {
      const p = await hermesApi.preview(folder.trim() && folder.trim() !== det?.home ? folder.trim() : undefined);
      setPlan(p);
      setBots(new Set(p.bots.filter((b) => b.selected).map((b) => b.key)));
      setRoutines(new Set(p.routines.filter((r) => r.selected).map((r) => r.key)));
      setSkills(new Set(p.skills.filter((s) => s.selected).map((s) => s.key)));
      setMemories(p.memories.total + p.memories.userFacts > 0 ? 'active' : 'off');
      setAck(false);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy('');
    }
  };

  const known = (key: string) => bots.has(key) || !!plan?.bots.find((b) => b.key === key)?.existing;
  const routineCount = plan ? plan.routines.filter((r) => routines.has(r.key) && known(r.botKey)).length : 0;
  const dangerSkills = plan ? plan.skills.filter((s) => skills.has(s.key) && s.scan === 'danger') : [];

  const doImport = async () => {
    if (!plan) return;
    setBusy('import');
    try {
      const r = await hermesApi.commit({ stagingId: plan.stagingId, bots: [...bots], routines: plan.routines.filter((x) => routines.has(x.key) && known(x.botKey)).map((x) => x.key), skills: [...skills], memories, acknowledgeSkills: ack });
      setResult(r);
      setPlan(null);
      await useApp.getState().load();
      window.scrollTo?.(0, 0);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy('');
    }
  };

  const afterUndo = (r: UndoResult) => {
    setUndone(r);
    setResult(null);
    setPlan(null);
    loadDetect();
    window.scrollTo?.(0, 0);
  };

  if (det && !det.available) return <p className="text-sm text-muted">Overstappen leest mappen op deze computer; dat kan alleen de eigenaar van deze installatie.</p>;

  return (
    <div className="space-y-6">
      {undone && <UndoneCard r={undone} from="hermes" />}
      {result && <Summary r={result} onAgain={read} onUndone={afterUndo} />}

      {!plan && !result && (
        <Card className="space-y-4 p-5">
          {det === null ? (
            <Spinner />
          ) : (
            <>
              <div className="flex items-start gap-3">
                <Upload className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
                <div className="space-y-1">
                  <div className="font-medium">{det.found ? 'Hermes Agent gevonden op deze computer' : 'Hermes Agent niet gevonden in de standaardmap'}</div>
                  <p className="text-sm text-muted">
                    {det.found
                      ? t('{0, plural, one {# profiel} other {# profielen}}: elk profiel wordt een bot.', det.profiles || 0)
                      : 'Staat Hermes ergens anders (bijvoorbeeld in WSL of met HERMES_HOME)? Vul hieronder de map in.'}
                  </p>
                  {det.imported && !det.imported.undone && <p className="text-sm text-muted">{t('Eerder overgenomen op {0} ({1, plural, one {# bot} other {# bots}}). Opnieuw inlezen maakt geen dubbele bots.', formatDateTime(det.imported.at), det.imported.counts.bots)}</p>}
                </div>
              </div>
              <label className="block space-y-1">
                <span className="text-sm font-medium">Hermes-map</span>
                <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\Users\jij\.hermes" spellCheck={false} />
              </label>
              <ul className="space-y-1.5 text-sm text-muted">
                <li className="flex gap-2">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> Alleen lezen: Hermes en zijn bestanden blijven precies zoals ze zijn.
                </li>
                <li className="flex gap-2">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> Geen sleutels: .env en auth.json worden niet geopend. AI-diensten die een sleutel nodig hebben, verbind je straks opnieuw.
                </li>
                <li className="flex gap-2">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> Geplande taken komen als routines die uit staan, zodat niets dubbel draait naast Hermes.
                </li>
                <li className="flex gap-2">
                  <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> Spijt? Met één knop maak je de import weer ongedaan.
                </li>
              </ul>
              <div className="flex flex-wrap items-center gap-2">
                <Button variant="primary" loading={busy === 'read'} disabled={!folder.trim()} icon={<ArrowRight className="h-4 w-4" />} onClick={read}>
                  Hermes inlezen
                </Button>
                <span className="text-xs text-muted">Je ziet eerst wat er overkomt; er wordt nog niets geïmporteerd.</span>
                {det.undoable && (
                  <span className="sm:ms-auto">
                    <UndoButton from="hermes" onDone={afterUndo} label="Eerdere import ongedaan maken" />
                  </span>
                )}
              </div>
            </>
          )}
          {error && (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </Card>
      )}

      {plan && (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
            <span>
              Ingelezen uit <code className="break-all">{plan.source.home}</code>. Dit is een voorvertoning: er is nog niets veranderd.
            </span>
            <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={busy === 'read'} onClick={read}>
              Opnieuw inlezen
            </Button>
          </div>
          <AttentionList items={plan.attention} />

          <Section icon={<Bot className="h-4 w-4" />} title="Bots" count={t('{0} van {1}', bots.size, plan.bots.length)} actions={<AllNone onAll={() => setBots(new Set(plan.bots.filter((b) => !b.existing).map((b) => b.key)))} onNone={() => setBots(new Set())} />}>
            <Card className="divide-y divide-line">
              {plan.bots.map((b) => (
                <div key={b.key} className={cx('flex items-start gap-3 px-4 py-3', !bots.has(b.key) && 'opacity-70')}>
                  <Check checked={bots.has(b.key)} disabled={!!b.existing} onChange={(v) => setBots((x) => toggle(x, b.key, v))} label={t('{0} overnemen', b.name)} />
                  <BotAvatar bot={{ id: b.key, name: b.name, avatar: b.face }} size={40} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{b.name}</span>
                      {b.profile !== 'default' && <Badge>{t('profiel {0}', b.profile)}</Badge>}
                      {b.existing && <Badge tone="ok">al overgenomen</Badge>}
                      <Badge tone={ENGINE_TONE[b.engine.status]}>
                        {b.engine.label} · {ENGINE_LABEL[b.engine.status]}
                      </Badge>
                    </div>
                    <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
                      <span>
                        Model: <span className="text-fg">{b.model ? prettyModel(b.model) : 'standaard'}</span>
                      </span>
                      <span>{b.instructions.chars ? 'instructies uit SOUL.md' : 'geen instructies'}</span>
                      <span>{t('{0, plural, one {# skill} other {# skills}}', b.skills)}</span>
                      <span>{t('{0, plural, one {# geplande taak} other {# geplande taken}}', b.routines)}</span>
                      <span>{t('{0, plural, one {# herinnering} other {# herinneringen}}', b.memories)}</span>
                    </div>
                    {(b.engine.note || b.notes.length > 0) && (
                      <ul className="list-disc space-y-0.5 ps-5 text-xs text-muted">
                        {b.engine.note && <li>{b.engine.note}</li>}
                        {b.notes.map((n, i) => (
                          <li key={i}>{n}</li>
                        ))}
                      </ul>
                    )}
                  </div>
                </div>
              ))}
            </Card>
          </Section>

          <Section icon={<Puzzle className="h-4 w-4" />} title="Skills" count={t('{0} van {1} over te nemen', skills.size, plan.skills.filter((s) => s.importable).length)} actions={<AllNone onAll={() => setSkills(new Set(plan.skills.filter((s) => s.importable).map((s) => s.key)))} onNone={() => setSkills(new Set())} />}>
            {!plan.skills.length ? (
              <p className="text-sm text-muted">Geen skills gevonden.</p>
            ) : (
              <Card className="divide-y divide-line">
                {plan.skills.map((s) => (
                  <div key={s.key} className="flex items-start gap-3 px-4 py-2.5">
                    <Check checked={skills.has(s.key)} disabled={!s.importable} onChange={(v) => setSkills((x) => toggle(x, s.key, v))} label={t('Skill {0}', s.name)} />
                    <div className="min-w-0 flex-1 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-sm font-medium">{s.name}</span>
                        <Badge tone={s.bundled ? 'neutral' : 'accent'}>{s.bundled ? 'van Hermes zelf (MIT)' : 'eigen skill'}</Badge>
                        {s.scan === 'danger' && <Badge tone="danger">waarschuwingen</Badge>}
                        {s.scan === 'warn' && <Badge tone="warn">let op</Badge>}
                        {s.action === 'unchanged' && <Badge tone="ok">staat er al</Badge>}
                      </div>
                      {s.description && <p className="line-clamp-2 text-xs text-muted">{s.description}</p>}
                      <p className="text-xs text-muted">
                        {s.reason ? `${s.reason} ` : ''}
                        {s.usedBy.length ? t('Bij: {0}.', s.usedBy.join(', ')) : ''}
                      </p>
                    </div>
                  </div>
                ))}
              </Card>
            )}
            {plan.skills.some((s) => s.bundled) && <p className="text-xs text-muted">Skills die met Hermes meekomen staan standaard uit. Vink ze aan als je ze wilt.</p>}
            {dangerSkills.length > 0 && (
              <label className="flex items-start gap-2 rounded-lg bg-danger-soft px-3 py-2 text-sm">
                <Check checked={ack} onChange={setAck} label="Waarschuwingen bekeken" />
                <span>{t('Ik heb de waarschuwingen bij {0} bekeken. Zonder dit vinkje worden ze overgeslagen.', dangerSkills.map((s) => s.name).join(', '))}</span>
              </label>
            )}
          </Section>

          <Section icon={<AlarmClock className="h-4 w-4" />} title="Geplande taken" count={t('{0} van {1}', routineCount, plan.routines.length)} actions={<AllNone onAll={() => setRoutines(new Set(plan.routines.filter((r) => r.ok && !r.existing).map((r) => r.key)))} onNone={() => setRoutines(new Set())} />}>
            <p className="text-xs text-muted">
              Ze komen binnen als routines en <strong className="text-fg">staan uit tot jij ze aanzet</strong>. Zet ze aan wanneer je Hermes stopt, anders draaien ze twee keer.
            </p>
            {plan.routines.length === 0 ? (
              <p className="text-sm text-muted">Geen geplande taken gevonden.</p>
            ) : (
              <Card className="divide-y divide-line">
                {plan.routines.map((r) => {
                  const botOff = !known(r.botKey);
                  return (
                    <div key={r.key} className={cx('flex items-start gap-3 px-4 py-2.5', (!r.ok || botOff || r.existing) && 'opacity-60')}>
                      <Check checked={routines.has(r.key) && !botOff} disabled={!r.ok || botOff || r.existing} onChange={(v) => setRoutines((x) => toggle(x, r.key, v))} label={t('Routine {0}', r.name)} />
                      <div className="min-w-0 flex-1 space-y-0.5">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="text-sm font-medium">{r.name}</span>
                          <span className="text-xs text-muted">· {r.botName}</span>
                          <Badge tone="neutral">{r.wasActive ? 'stond aan · komt uit' : 'stond uit · blijft uit'}</Badge>
                          {r.existing && <Badge tone="ok">al overgenomen</Badge>}
                        </div>
                        <p className={cx('text-xs', r.ok ? 'text-muted' : 'text-danger')}>
                          {r.schedule}
                          {botOff && r.ok ? ' · de bot wordt niet overgenomen' : ''}
                        </p>
                        {r.notes.length > 0 && <p className="text-xs text-muted">{r.notes.join(' ')}</p>}
                      </div>
                    </div>
                  );
                })}
              </Card>
            )}
          </Section>

          {plan.memories.total + plan.memories.userFacts > 0 && (
            <Section icon={<Brain className="h-4 w-4" />} title="Herinneringen">
              <Card className="space-y-2 px-4 py-3">
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <span className="text-sm">{t('{0, plural, one {# notitie van de bots} other {# notities van de bots}} en {1, plural, one {# ding over jou} other {# dingen over jou}}', plan.memories.total, plan.memories.userFacts)}</span>
                  <Select className="sm:ms-auto sm:max-w-xs" value={memories} onChange={(e) => setMemories(e.target.value as typeof memories)} aria-label="Herinneringen">
                    <option value="active">Direct gebruiken, zoals in Hermes</option>
                    <option value="review">Eerst zelf controleren</option>
                    <option value="off">Niet meenemen</option>
                  </Select>
                </div>
                <p className="text-xs text-muted">De notities komen bij de bot, wat Hermes over jou weet onder Over jou. Wachtwoorden en sleutels worden nooit opgeslagen.</p>
              </Card>
            </Section>
          )}

          <Section icon={<ClipboardList className="h-4 w-4" />} title="Komt niet mee">
            <Card className="px-4 py-3">
              <ul className="space-y-1.5 text-sm">
                {plan.notImported.map((n, i) => (
                  <li key={i}>
                    <span className="font-medium">{n.what}</span> <span className="text-muted">· {n.why}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </Section>

          <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:static sm:rounded-xl sm:border">
            <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3">
              <span className="text-sm text-muted">
                {t('{0, plural, one {# bot} other {# bots}}', bots.size)} · {t('{0, plural, one {# skill} other {# skills}}', skills.size)} · {t('{0, plural, one {# routine (uit)} other {# routines (uit)}}', routineCount)}
              </span>
              <Button className="ms-auto" variant="primary" loading={busy === 'import'} disabled={!bots.size && !skills.size} onClick={doImport} icon={<CheckCircle2 className="h-4 w-4" />}>
                Importeren
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
