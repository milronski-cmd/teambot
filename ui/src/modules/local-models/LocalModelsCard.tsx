import { useCallback, useEffect, useState } from 'react';
import { ChevronDown, Cpu, Download, ExternalLink, RefreshCw, TriangleAlert, X } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatDate, formatNumber } from '../../lib/format';
import { useApp } from '../../lib/store';
import type { ProviderTestResult } from '../../lib/types';
import { Badge, Button, Card, CardHead, Spinner, cx, useAsync } from '../../components/ui';
import { ConnectCard, ConnectResult } from '../../components/ConnectCard';
import { localModelsApi } from './api';
import type { CatalogView, Fit, FitWhy, Hardware, InstalledModel, LocalModelsView, ProbeView, PullState, ToolsKnown } from '../../../../shared/localModels.js';
import { OllamaInstallButton } from './install';

/**
 * "Lokale modellen op deze pc" (TeamBot 0.4, Q): what this pc has, which models fit, whether tools really work, a
 * warning when Ollama does not use the video card, and one-click downloads. Self-contained: the AI-provider settings
 * show it in full, the first-run screen can show it with `compact` (summary, warning and the advice only; its buttons
 * are quiet there, the first screen has one main button of its own).
 */

const GiB = 1024 ** 3;
/** Memory as the box says it: 63.1 GiB of a 64 GB pc (the rest is reserved by the hardware) reads "64 GB". */
const SIZES = [2, 3, 4, 6, 8, 10, 11, 12, 16, 20, 24, 32, 48, 64, 96, 128, 192, 256, 512];
function memGb(bytes: number): number {
  const g = bytes / GiB;
  return SIZES.find((s) => g <= s && g >= s * 0.93) ?? Math.round(g);
}
/** Download sizes as Ollama shows them (decimal GB). */
const dl = (bytes: number) => t('{0} GB', formatNumber(bytes / 1e9, { maximumFractionDigits: 1, minimumFractionDigits: bytes < 10e9 ? 1 : 0 }));
const short = (id: string) => id.replace(/:latest$/, '');

const FIT_LABEL: Record<Fit, string> = { fits: 'Past goed', slow: 'Werkt traag', too_big: 'Te groot' };
const FIT_TONE: Record<Fit, 'ok' | 'warn' | 'danger'> = { fits: 'ok', slow: 'warn', too_big: 'danger' };
const WHY_TEXT: Record<FitWhy, string> = {
  gpu: 'Past in het geheugen van de videokaart.',
  partly_cpu: 'Past niet helemaal in het geheugen van de videokaart; een deel draait op de processor.',
  no_gpu: 'Draait op de processor: deze pc heeft geen geschikte videokaart.',
  too_big: 'Te groot voor het geheugen van deze pc.',
  loaded_gpu: 'Draait nu helemaal op de videokaart.',
  loaded_partly: 'Draait nu deels op de processor: het past niet helemaal in de videokaart.',
  loaded_cpu: 'Draait nu op de processor.',
};

function FitBadge({ fit }: { fit: Fit }) {
  return <Badge tone={FIT_TONE[fit]}>{FIT_LABEL[fit]}</Badge>;
}

function ToolsBadge({ probe, known }: { probe: ProbeView | null; known?: ToolsKnown }) {
  if (probe?.verdict === 'tools') return <Badge tone="ok">Tools werken</Badge>;
  if (probe?.verdict === 'text' || (!probe && known === 'no')) return <Badge>Alleen tekst</Badge>;
  if (probe?.verdict === 'unreliable') return <Badge tone="warn">Tools onbetrouwbaar</Badge>;
  if (probe?.verdict === 'error') return <Badge tone="warn">Test mislukt</Badge>;
  return null;
}

/** "Deze pc: 64 GB werkgeheugen en een AMD Radeon RX 7800 XT met 16 GB videogeheugen." */
export function hardwareSummary(hw: Hardware, card: string | null): string {
  const ram = memGb(hw.ram);
  if (hw.unified) return t('Deze Mac: {0} GB geheugen, gedeeld door de processor en de videochip.', ram);
  const gpu = hw.gpus.find((g) => g.name === card);
  const unread = !gpu && hw.gpus.find((g) => g.dedicated && !g.vram);
  if (unread) return t('Deze pc: {0} GB werkgeheugen en een {1}.', ram, unread.name);
  if (!gpu) return t('Deze pc: {0} GB werkgeheugen, geen aparte videokaart.', ram);
  if (!gpu.exact) return t('Deze pc: {0} GB werkgeheugen en een {1} met minstens 4 GB videogeheugen.', ram, gpu.name);
  return t('Deze pc: {0} GB werkgeheugen en een {1} met {2} GB videogeheugen.', ram, gpu.name, memGb(gpu.vram || 0));
}

const VENDOR_DRIVER: Record<string, string> = {
  nvidia: 'Installeer het nieuwste stuurprogramma van NVIDIA en start Ollama daarna opnieuw.',
  amd: 'Installeer het nieuwste stuurprogramma van AMD (Adrenalin) en start Ollama daarna opnieuw.',
  intel: 'Installeer het nieuwste stuurprogramma van Intel en start Ollama daarna opnieuw.',
};

function Progress({ p, onCancel }: { p: PullState; onCancel(): void }) {
  const pct = p.total ? Math.min(100, Math.round((p.completed / p.total) * 100)) : 0;
  if (p.done)
    return p.ok ? (
      <p className="text-xs text-ok">{t('{0} is gedownload.', short(p.model))}</p>
    ) : p.cancelled ? (
      <p className="text-xs text-muted">{t('Download van {0} gestopt. Downloaden gaat later verder waar het bleef.', short(p.model))}</p>
    ) : (
      <p className="text-xs text-danger">{t('Download van {0} mislukt: {1}', short(p.model), p.error || '')}</p>
    );
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2 text-xs">
        <span className="min-w-0 truncate">{p.total ? t('{0} downloaden: {1}%', short(p.model), pct) : t('{0} downloaden: starten…', short(p.model))}</span>
        <Button size="sm" variant="ghost" icon={<X className="h-3.5 w-3.5" />} onClick={onCancel}>
          Stoppen
        </Button>
      </div>
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label={t('{0} downloaden', short(p.model))}>
        <div className="h-full rounded-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

/** What a tools test says, under the model's row: "Tools werken", or why not. */
function ProbeResult({ r }: { r: ProbeView | { failed: string } }) {
  if ('failed' in r) return <ConnectResult ok={false}>{t('De test is mislukt: {0}', r.failed)}</ConnectResult>;
  if (r.verdict === 'tools') return <ConnectResult ok>Tools werken</ConnectResult>;
  const why = DETAIL_TEXT[r.detail] || r.detail;
  if (r.verdict === 'error') return <ConnectResult ok={false}>{t('De test is mislukt: {0}', r.message || why)}</ConnectResult>;
  return (
    <ConnectResult ok={false} next="Kies voor een bot met tools een ander model; praten kan wel.">
      {r.verdict === 'unreliable' ? t('Tools werken niet altijd: {0}.', why) : t('Alleen tekst, tools werken niet: {0}.', why)}
    </ConnectResult>
  );
}

/** A download that finished, under the model's row. */
function PullResult({ p }: { p: PullState }) {
  if (p.ok) return <ConnectResult ok>{t('{0} is gedownload.', short(p.model))}</ConnectResult>;
  if (p.cancelled) return <p className="text-xs text-muted">{t('Download van {0} gestopt. Downloaden gaat later verder waar het bleef.', short(p.model))}</p>;
  return <ConnectResult ok={false}>{t('Download van {0} mislukt: {1}', short(p.model), p.error || '')}</ConnectResult>;
}

const linkAction = 'inline-flex h-8 items-center gap-1 rounded-lg bg-accent px-3 text-[13px] font-semibold text-accent-fg hover:opacity-90 coarse:h-11';

/**
 * Ollama itself, on the same row as every AI behind "AI toevoegen": not on this pc → Installeren (TeamBot installs it,
 * connects it and fetches a model that runs well here); running and not connected → Koppelen; connected → Testen,
 * with the outcome under it.
 */
function OllamaRow({ v, onChanged }: { v: LocalModelsView; onChanged(): void }) {
  const [r, setR] = useState<ProviderTestResult | null>(null);
  const a = useAsync();
  const o = v.ollama;
  const test = () =>
    a.run(async () => {
      setR(null);
      setR(await api.post<ProviderTestResult>(`/providers/${o.providerId}/test`).catch((e) => ({ ok: false, detail: e?.message || String(e) })));
    });
  if (!o.running)
    return (
      <ConnectCard
        data-testid="local-models-no-ollama"
        icon={<Cpu aria-hidden />}
        tone="violet"
        title="Ollama"
        line={o.local ? 'Met Ollama draaien modellen gratis op je eigen computer. Nog niet op deze pc.' : t('Ollama op {0} is niet bereikbaar', o.base)}
        state="off"
        stateLabel={o.local ? 'draait niet' : 'niet bereikbaar'}
        action={o.local && <OllamaInstallButton onDone={onChanged} />}
      />
    );
  return (
    <ConnectCard
      data-testid="local-models-ollama"
      icon={<Cpu aria-hidden />}
      tone="violet"
      title="Ollama"
      line={[o.version ? t('Versie {0}', o.version) : '', t('{0, plural, one {# model op deze pc} other {# modellen op deze pc}}', v.installed.length)].filter(Boolean).join(' · ')}
      state={a.busy ? 'busy' : r && !r.ok ? 'error' : o.providerId ? 'on' : 'off'}
      stateLabel={a.busy ? 'testen' : o.providerId ? undefined : 'staat op deze pc'}
      action={
        o.providerId ? (
          <Button size="sm" loading={a.busy} onClick={test}>
            Testen
          </Button>
        ) : (
          <a className={linkAction} href="#/settings/providers?koppel=ollama">
            Koppelen
          </a>
        )
      }
      result={r && (r.ok ? <ConnectResult ok /> : <ConnectResult ok={false} next={r.hint || undefined}>{r.detail}</ConnectResult>)}
    />
  );
}

export function LocalModelsCard({ compact = false, className }: { compact?: boolean; className?: string }) {
  const [v, setV] = useState<LocalModelsView | null>(null);
  const [err, setErr] = useState('');
  const [testing, setTesting] = useState<Record<string, boolean>>({});
  // The outcome of a tools test, per model (`<providerId>|<model>`), shown under its row.
  const [tested, setTested] = useState<Record<string, ProbeView | { failed: string }>>({});
  const reload = useAsync();
  const act = useAsync();

  const load = useCallback(async (refresh = false) => {
    try {
      setV(await localModelsApi.view(refresh));
      setErr('');
    } catch (e: any) {
      setErr(e?.message || String(e));
    }
  }, []);
  useEffect(() => {
    void load();
    const offPull = on('localmodels.pull', (s: PullState) => {
      setV((cur) => (cur ? { ...cur, pulls: [...cur.pulls.filter((p) => p.model !== s.model), s] } : cur));
      if (s.done && s.ok) void load();
    });
    const offProbe = on('localmodels.probe', () => void load());
    return () => {
      offPull();
      offProbe();
    };
  }, [load]);

  const test = async (model: string, providerId?: string) => {
    const k = `${providerId || ''}|${model}`;
    setTesting((x) => ({ ...x, [k]: true }));
    setTested(({ [k]: _old, ...x }) => x);
    try {
      const r = await localModelsApi.probe(model, providerId);
      setTested((x) => ({ ...x, [k]: r }));
      await load();
    } catch (e: any) {
      setTested((x) => ({ ...x, [k]: { failed: e?.message || String(e) } }));
    } finally {
      setTesting((x) => ({ ...x, [k]: false }));
    }
  };
  const pull = (model: string) =>
    act.run(async () => {
      const r = await localModelsApi.pull(model);
      setV((cur) => (cur ? { ...cur, pulls: r.pulls } : cur));
    });
  const use = (model: string) =>
    act.run(async () => {
      await localModelsApi.use(model);
      await useApp.getState().refreshProviders();
      await load();
    }, t('Nieuwe bots op Ollama gebruiken nu {0}.', short(model)));

  if (v && !v.allowed) return null;

  const title = (
    <CardHead
      icon={Cpu}
      tone="violet"
      title="Lokale modellen op deze pc"
      action={
        !compact &&
        v && (
          <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={reload.busy} onClick={() => reload.run(() => load(true))}>
            Opnieuw zoeken
          </Button>
        )
      }
    />
  );

  if (!v)
    return (
      <Card className={cx('space-y-3 p-4', className)} data-testid="local-models">
        {title}
        {err ? (
          <div className="space-y-2 text-sm">
            <p className="text-danger">{t('Kon niet kijken wat deze pc heeft: {0}', err)}</p>
            <Button size="sm" onClick={() => load()}>
              Opnieuw proberen
            </Button>
          </div>
        ) : (
          <p className="flex items-center gap-2 text-sm text-muted">
            <Spinner /> Even kijken wat deze pc heeft…
          </p>
        )}
      </Card>
    );

  const pulling = (id: string) => v.pulls.find((p) => p.model === id && !p.done);
  const rec = v.recommended;
  const recModel = rec ? (rec.installed ? v.installed.find((m) => m.id === rec.id) : v.catalog.find((c) => c.id === rec.id)) : undefined;
  const isDefault = (id: string) => !!v.ollama.defaultModel && short(v.ollama.defaultModel) === short(id);
  const downloads = v.catalog.filter((c) => !c.installed);

  return (
    <Card className={cx('space-y-4 p-4', className)} data-testid="local-models">
      {title}
      {v.hardware && <p className="text-sm">{hardwareSummary(v.hardware, v.budget?.gpu ?? null)}</p>}

      {v.cpuWarning && (
        <div className="space-y-1 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn" role="alert" data-testid="local-models-cpu-warning">
          <div className="flex items-center gap-1.5 font-semibold">
            <TriangleAlert className="h-4 w-4 shrink-0" aria-hidden /> Ollama gebruikt je videokaart niet
          </div>
          <p className="text-fg">{t('{0} draait helemaal op de processor en is daardoor traag, terwijl deze pc een {1} heeft.', short(v.cpuWarning.model), v.cpuWarning.gpu)}</p>
          <p className="text-fg">{VENDOR_DRIVER[v.cpuWarning.vendor] || 'Installeer het nieuwste stuurprogramma van je videokaart en start Ollama daarna opnieuw.'}</p>
          {v.cpuWarning.driverUrl && (
            <a className="inline-flex items-center gap-1 font-semibold underline" href={v.cpuWarning.driverUrl} target="_blank" rel="noreferrer">
              Stuurprogramma downloaden <ExternalLink className="h-3 w-3" aria-hidden />
            </a>
          )}
          <p className="text-xs text-muted">Helpt dat niet, probeer dan LM Studio.</p>
        </div>
      )}

      {(!compact || !v.ollama.running) && <OllamaRow v={v} onChanged={() => void load()} />}
      {v.ollama.running && (
        rec &&
        recModel && (
          <div className="space-y-2 rounded-lg bg-accent-soft px-3 py-2.5 text-sm" data-testid="local-models-advice">
            <div>
              <span className="font-semibold">{t('Aanrader voor je eerste bot')}: </span>
              <span className="font-semibold [overflow-wrap:anywhere]" translate="no">
                {short(rec.id)}
              </span>
            </div>
            <p className="text-muted">
              {rec.installed
                ? recModel.fit === 'fits'
                  ? t('Staat al op deze pc en past goed.')
                  : t('Staat al op deze pc, maar werkt traag: een deel draait op de processor.')
                : recModel.fit === 'fits'
                  ? t('Past goed op deze pc. Downloaden: {0}.', dl(recModel.size))
                  : t('Werkt op deze pc, maar traag. Downloaden: {0}.', dl(recModel.size))}
            </p>
            {rec.installed ? (
              isDefault(rec.id) ? (
                <Badge tone="ok">{t('Standaard voor nieuwe bots op Ollama')}</Badge>
              ) : (
                <Button size="sm" variant={compact ? 'secondary' : 'primary'} loading={act.busy} onClick={() => use(rec.id)}>
                  {t('Gebruik voor nieuwe bots')}
                </Button>
              )
            ) : pulling(rec.id) ? (
              <Progress p={pulling(rec.id)!} onCancel={() => act.run(() => localModelsApi.cancel(rec.id))} />
            ) : (
              <Button size="sm" variant={compact ? 'secondary' : 'primary'} icon={<Download className="h-3.5 w-3.5" />} loading={act.busy} onClick={() => pull(rec.id)}>
                {t('Downloaden ({0})', dl(recModel.size))}
              </Button>
            )}
          </div>
        )
      )}

      {compact ? (
        <a className="inline-block text-[13px] font-semibold text-muted hover:text-fg" href="#/settings/providers">
          {t('Alle lokale modellen')}
        </a>
      ) : (
        <>
          {/* Every model on the same row as every AI behind "AI toevoegen": what it is, one action (Downloaden or
              Testen), and the outcome under it. */}
          {v.ollama.running && (
            <section className="space-y-2" aria-labelledby="lokaal-op-pc">
              <h3 id="lokaal-op-pc" data-i18n="label" className="text-xs font-semibold uppercase tracking-wide text-muted">
                Op deze pc
              </h3>
              {v.installed.length === 0 ? (
                <p className="text-sm text-muted">Nog geen modellen in Ollama. Download hieronder een model dat past.</p>
              ) : (
                <ul className="space-y-2">
                  {v.installed.map((m) => (
                    <InstalledRow key={m.id} m={m} busy={!!testing[`|${m.id}`]} isDefault={isDefault(m.id)} onTest={() => test(m.id)} result={tested[`|${m.id}`]} pulled={v.pulls.find((p) => p.model === m.id && p.done && p.ok)} />
                  ))}
                </ul>
              )}
            </section>
          )}

          {v.ollama.running && downloads.length > 0 && (
            <section className="space-y-2" aria-labelledby="lokaal-downloaden">
              <h3 id="lokaal-downloaden" data-i18n="label" className="text-xs font-semibold uppercase tracking-wide text-muted">
                Downloaden
              </h3>
              <ul className="space-y-2">
                {downloads.map((c) => (
                  <CatalogRow key={c.id} c={c} pull={v.pulls.find((p) => p.model === c.id)} busy={act.busy} onPull={() => pull(c.id)} onCancel={() => act.run(() => localModelsApi.cancel(c.id))} />
                ))}
              </ul>
            </section>
          )}

          {v.others.length > 0 && (
            <section className="space-y-2" aria-labelledby="lokaal-anders">
              <h3 id="lokaal-anders" data-i18n="label" className="text-xs font-semibold uppercase tracking-wide text-muted">
                Andere lokale servers
              </h3>
              <ul className="space-y-2">
                {v.others.map((s) =>
                  s.error || !s.models.length ? (
                    <li key={s.providerId}>
                      <ConnectCard title={s.name} line={s.error ? t('Niet bereikbaar: {0}', s.error) : 'Geen modellen gevonden.'} state={s.error ? 'error' : 'on'} stateLabel={s.error ? 'niet bereikbaar' : undefined} />
                    </li>
                  ) : (
                    s.models.map((m) => (
                      <li key={`${s.providerId}|${m.id}`}>
                        <ConnectCard
                          title={
                            <span translate="no" className="[overflow-wrap:anywhere]">
                              {m.id}
                            </span>
                          }
                          line={
                            <>
                              {s.name} <ToolsBadge probe={m.probe} known={m.tools === false ? 'no' : undefined} />
                            </>
                          }
                          state={testing[`${s.providerId}|${m.id}`] ? 'busy' : 'off'}
                          stateLabel={testing[`${s.providerId}|${m.id}`] ? 'testen' : undefined}
                          action={
                            m.tools !== false && (
                              <Button size="sm" loading={!!testing[`${s.providerId}|${m.id}`]} onClick={() => test(m.id, s.providerId)}>
                                Testen
                              </Button>
                            )
                          }
                          result={tested[`${s.providerId}|${m.id}`] && <ProbeResult r={tested[`${s.providerId}|${m.id}`]} />}
                        />
                      </li>
                    ))
                  ),
                )}
              </ul>
            </section>
          )}

          <MoreOptions v={v} />
        </>
      )}
    </Card>
  );
}

/** A model on this pc: what it is and how it fits, and one action, "Testen" (do tools work?), with the outcome under it. */
function InstalledRow({ m, busy, isDefault, onTest, result, pulled }: { m: InstalledModel; busy: boolean; isDefault: boolean; onTest(): void; result?: ProbeView | { failed: string }; pulled?: PullState }) {
  const canTest = m.fit !== 'too_big' && m.tools !== false;
  return (
    <li data-local-model={m.id}>
      <ConnectCard
        title={
          <span translate="no" className="[overflow-wrap:anywhere]">
            {short(m.id)}
          </span>
        }
        line={
          <span className="flex flex-wrap items-center gap-1.5">
            <FitBadge fit={m.fit} />
            <ToolsBadge probe={m.probe} known={m.toolsKnown} />
            {isDefault && <Badge tone="accent">standaard</Badge>}
            <span>
              {dl(m.size)} · {WHY_TEXT[m.why]}
            </span>
          </span>
        }
        state={busy ? 'busy' : 'off'}
        stateLabel={busy ? 'testen' : undefined}
        action={
          canTest && (
            <Button size="sm" loading={busy} onClick={onTest}>
              Testen
            </Button>
          )
        }
        result={result ? <ProbeResult r={result} /> : pulled && <PullResult p={pulled} />}
      />
    </li>
  );
}

/** A model to download: what it is and whether it fits, and one action, "Downloaden"; the progress and outcome under it. */
function CatalogRow({ c, pull, busy, onPull, onCancel }: { c: CatalogView; pull?: PullState; busy: boolean; onPull(): void; onCancel(): void }) {
  const running = pull && !pull.done;
  return (
    <li data-local-download={c.id}>
      <ConnectCard
        title={
          <span translate="no" className="[overflow-wrap:anywhere]">
            {c.id}
          </span>
        }
        line={
          <span className="flex flex-wrap items-center gap-1.5">
            {c.best && <Badge tone="accent">Beste keuze voor deze pc</Badge>}
            <FitBadge fit={c.fit} />
            <span>{[NOTE[c.id] || '', `${dl(c.size)} · ${WHY_TEXT[c.why]}`].filter(Boolean).join(' ')}</span>
          </span>
        }
        state={running ? 'busy' : 'off'}
        stateLabel={running ? 'downloaden' : undefined}
        action={
          !running &&
          c.fit !== 'too_big' && (
            <Button size="sm" icon={<Download className="h-3.5 w-3.5" />} disabled={busy} onClick={onPull}>
              Downloaden
            </Button>
          )
        }
        result={pull?.done && <PullResult p={pull} />}
      >
        {running && <Progress p={pull} onCancel={onCancel} />}
      </ConnectCard>
    </li>
  );
}

/** One line per model in the download list (server/modules/local-models/catalog.ts). */
const NOTE: Record<string, string> = {
  'qwen3:1.7b': 'Heel klein en snel. Voor een pc zonder videokaart of voor eenvoudige taken.',
  'llama3.2:3b': 'Klein model van Meta.',
  'qwen3:4b': 'Klein en snel, en goed met tools.',
  'qwen3:8b': 'Goede allrounder voor een videokaart met 8 GB of meer.',
  'qwen3:14b': 'Slimmer, voor een videokaart met 12 tot 16 GB.',
  'gpt-oss:20b': 'Van OpenAI. Denkt eerst na en antwoordt daarna.',
  'qwen3:30b': 'Groot en toch vlot: per woord rekent maar een klein deel mee. Voor 24 GB of meer.',
  'qwen3.6:35b': 'Nieuwste grote Qwen, kan ook afbeeldingen lezen. Voor 24 GB of meer.',
};

const DETAIL_TEXT: Record<string, string> = {
  ok: 'riep de juiste tool aan',
  as_text: 'schreef de toolopdracht als tekst; TeamBot voert hem toch uit',
  no_call: 'antwoordde zonder tool',
  wrong_call: 'koos de verkeerde tool',
  no_tools: 'het model heeft geen tools',
  jinja: 'llama-server draait zonder --jinja',
  error: 'de test lukte niet',
};
const WHERE_TEXT: Record<string, string> = { loaded: 'zoals het nu draait', gpu: 'op de videokaart', cpu: 'op de processor, zodat het geladen model bleef staan' };

/** Technical details, folded away: windows, memory estimates, where a test ran, sources. */
function MoreOptions({ v }: { v: LocalModelsView }) {
  const gib = (b: number) => formatNumber(b / GiB, { maximumFractionDigits: 1 });
  return (
    <details className="group rounded-lg border border-line" data-testid="local-models-more">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2 text-sm font-semibold">
        <span>Meer opties</span>
        <ChevronDown className="h-4 w-4 shrink-0 text-muted transition-transform [details[open]>summary_&]:rotate-180" aria-hidden />
      </summary>
      <div className="space-y-3 border-t border-line px-3 py-2 text-xs text-muted">
        <p>
          {t(
            'Het advies rekent met een contextvenster van {0} tokens.',
            formatNumber(16384),
          )}
        </p>
        {v.budget && <p>{t('Bruikbaar videogeheugen: {0} GiB. Werkgeheugen voor de rest van een model: {1} GiB.', gib(v.budget.vram), gib(v.budget.ram))}</p>}
        {v.hardware && (
          <p>
            {t('Processor: {0} ({1} threads). Videokaarten:', v.hardware.cpu, v.hardware.cores)}{' '}
            <span translate="no">{v.hardware.gpus.map((g) => `${g.name}${g.vram ? ` (${gib(g.vram)} GiB${g.exact ? '' : '+'})` : ''}${g.dedicated ? '' : ' *'}`).join(', ') || '—'}</span>
            {v.hardware.gpus.some((g) => !g.dedicated) && <> {t('(* ingebouwd in de processor, telt niet mee)')}</>}
            {v.hardware.sources.length > 0 && <> {t('Bron: {0}.', v.hardware.sources.join(', '))}</>}
          </p>
        )}
        {v.ollama.running && (
          <p>
            {t('Ollama {0} op {1}.', v.ollama.version || '', v.ollama.base)}
            {v.diskFree !== null && <> {t('Vrije schijfruimte voor modellen: {0}.', dl(v.diskFree))}</>}
          </p>
        )}
        {v.installed.length > 0 && (
          <ul className="space-y-1">
            {v.installed.map((m) => (
              <li key={m.id}>
                <span translate="no" className="font-medium text-fg [overflow-wrap:anywhere]">
                  {short(m.id)}
                </span>
                {' — '}
                {t('nodig ongeveer {0} GiB bij {1} tokens', gib(m.need), formatNumber(m.context))}
                {m.loaded && <> · {t('nu geladen: {0} van {1} GiB op de videokaart', gib(m.loaded.sizeVram), gib(m.loaded.size))}</>}
                {m.probe && (
                  <>
                    {' · '}
                    {t('getest {0}: {1}, {2}', formatDate(m.probe.at), DETAIL_TEXT[m.probe.detail] || m.probe.detail, (m.probe.where && WHERE_TEXT[m.probe.where]) || '')}
                    {m.probe.message && m.probe.verdict === 'error' && <> ({m.probe.message})</>}
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
        <p>
          {t('Downloadgroottes uit de Ollama-bibliotheek, nagekeken op {0}.', formatDate(v.catalogChecked))}{' '}
          <span translate="no">{v.catalogSource}</span>
        </p>
      </div>
    </details>
  );
}
