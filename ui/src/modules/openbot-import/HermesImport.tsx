import { useState } from 'react';
import { AlarmClock, Bot, Brain, CheckCircle2, ClipboardList, Puzzle } from 'lucide-react';
import { Badge, Card, Input, Select, Spinner, cx } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { t } from '../../lib/i18n';
import { prettyModel } from '../../lib/modelLabel';
import { type HermesDetect, type HermesPlan, type HermesResult, type UndoResult, hermesApi } from './api';
import { AfterImport, AllNone, Check, EngineBadge, ErrorNote, ImportBar, PlanTop, Promises, ProviderNotes, ReadRow, ResultTiles, RoutineList, Section, SourceFound, toggleIn, useImportFlow } from './parts';
import { UndoButton, UndoneCard } from './Undo';

/**
 * Overstappen uit Hermes Agent: read the Hermes folder (default ~/.hermes, or a folder you type), see what comes
 * over, import, undo. Same promises as the OpenBot import: read only, no keys, routines switched off.
 */

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
        <ResultTiles tiles={tiles} />
        <ProviderNotes providers={r.providers} />
      </Card>
      <AfterImport errors={errors} attention={r.attention} onAgain={onAgain} undo={r.undo && <UndoButton from="hermes" onDone={onUndone} />} />
    </div>
  );
}

export function HermesImport() {
  const [folder, setFolder] = useState('');
  const [bots, setBots] = useState<Set<string>>(new Set());
  const [routines, setRoutines] = useState<Set<string>>(new Set());
  const [skills, setSkills] = useState<Set<string>>(new Set());
  const [memories, setMemories] = useState<'active' | 'review' | 'off'>('active');
  const [ack, setAck] = useState(false);

  const flow = useImportFlow<HermesDetect, HermesPlan, HermesResult>({
    detect: () => hermesApi.detect().then((d) => (setFolder((f) => f || d.home || ''), d)),
    notFound: { available: false, found: false },
    preview: (det) => hermesApi.preview(folder.trim() && folder.trim() !== det?.home ? folder.trim() : undefined),
    onPlan: (p) => {
      setBots(new Set(p.bots.filter((b) => b.selected).map((b) => b.key)));
      setRoutines(new Set(p.routines.filter((r) => r.selected).map((r) => r.key)));
      setSkills(new Set(p.skills.filter((s) => s.selected).map((s) => s.key)));
      setMemories(p.memories.total + p.memories.userFacts > 0 ? 'active' : 'off');
      setAck(false);
    },
  });
  const { det, plan, result, undone, busy, error, read, afterUndo } = flow;

  const known = (key: string) => bots.has(key) || !!plan?.bots.find((b) => b.key === key)?.existing;
  const routineCount = plan ? plan.routines.filter((r) => routines.has(r.key) && known(r.botKey)).length : 0;
  const dangerSkills = plan ? plan.skills.filter((s) => skills.has(s.key) && s.scan === 'danger') : [];

  const doImport = () => plan && flow.doImport(() => hermesApi.commit({ stagingId: plan.stagingId, bots: [...bots], routines: plan.routines.filter((x) => routines.has(x.key) && known(x.botKey)).map((x) => x.key), skills: [...skills], memories, acknowledgeSkills: ack }));

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
              <SourceFound title={det.found ? 'Hermes Agent gevonden op deze computer' : 'Hermes Agent niet gevonden in de standaardmap'} imported={det.imported}>
                <p className="text-sm text-muted">
                  {det.found
                    ? t('{0, plural, one {# profiel} other {# profielen}}: elk profiel wordt een bot.', det.profiles || 0)
                    : 'Staat Hermes ergens anders (bijvoorbeeld in WSL of met HERMES_HOME)? Vul hieronder de map in.'}
                </p>
              </SourceFound>
              <label className="block space-y-1">
                <span className="text-sm font-medium">Hermes-map</span>
                <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="C:\Users\jij\.hermes" spellCheck={false} />
              </label>
              <Promises
                items={[
                  'Alleen lezen: Hermes en zijn bestanden blijven precies zoals ze zijn.',
                  'Geen sleutels: .env en auth.json worden niet geopend. AI-diensten die een sleutel nodig hebben, verbind je straks opnieuw.',
                  'Geplande taken komen als routines die uit staan, zodat niets dubbel draait naast Hermes.',
                  'Spijt? Met één knop maak je de import weer ongedaan.',
                ]}
              />
              <ReadRow reading={busy === 'read'} disabled={!folder.trim()} onRead={read} undo={det.undoable && <UndoButton from="hermes" onDone={afterUndo} label="Eerdere import ongedaan maken" />}>
                Hermes inlezen
              </ReadRow>
            </>
          )}
          <ErrorNote text={error} />
        </Card>
      )}

      {plan && (
        <>
          <PlanTop path={plan.source.home} attention={plan.attention} reading={busy === 'read'} onRead={read} />

          <Section icon={<Bot className="h-4 w-4" />} title="Bots" count={t('{0} van {1}', bots.size, plan.bots.length)} actions={<AllNone onAll={() => setBots(new Set(plan.bots.filter((b) => !b.existing).map((b) => b.key)))} onNone={() => setBots(new Set())} />}>
            <Card className="divide-y divide-line">
              {plan.bots.map((b) => (
                <div key={b.key} className={cx('flex items-start gap-3 px-4 py-3', !bots.has(b.key) && 'opacity-70')}>
                  <Check checked={bots.has(b.key)} disabled={!!b.existing} onChange={(v) => setBots((x) => toggleIn(x, b.key, v))} label={t('{0} overnemen', b.name)} />
                  <BotAvatar bot={{ id: b.key, name: b.name, avatar: b.face }} size={40} />
                  <div className="min-w-0 flex-1 space-y-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">{b.name}</span>
                      {b.profile !== 'default' && <Badge>{t('profiel {0}', b.profile)}</Badge>}
                      {b.existing && <Badge tone="ok">al overgenomen</Badge>}
                      <EngineBadge engine={b.engine} />
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
                    <Check checked={skills.has(s.key)} disabled={!s.importable} onChange={(v) => setSkills((x) => toggleIn(x, s.key, v))} label={t('Skill {0}', s.name)} />
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
            <RoutineList routines={plan.routines} chosen={routines} setChosen={setRoutines} known={known} empty="Geen geplande taken gevonden." />
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

          <ImportBar importing={busy === 'import'} disabled={!bots.size && !skills.size} onImport={doImport}>
            {t('{0, plural, one {# bot} other {# bots}}', bots.size)} · {t('{0, plural, one {# skill} other {# skills}}', skills.size)} · {t('{0, plural, one {# routine (uit)} other {# routines (uit)}}', routineCount)}
          </ImportBar>
        </>
      )}
    </div>
  );
}
