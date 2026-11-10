import { useEffect, useState } from 'react';
import { CheckCircle2, Gift, PackageCheck, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { api, on } from '../../lib/api';
import { formatNumber, formatPercent } from '../../lib/format';
import { useApp } from '../../lib/store';
import type { ProviderView } from '../../lib/types';
import { askConfirm, Badge, Button, cx, toast, toastError, useAsync } from '../../components/ui';

/** Mirror of the server's runtimes.ts status (TeamBot's own copy of Claude Code, Codex or OpenCode). */
export interface RuntimeView {
  id: string;
  label: string;
  /** npm: the vendor's signed npm package; github: the vendor's GitHub release (OpenCode 2.x). */
  source?: 'npm' | 'github';
  supported: boolean;
  pinned: string;
  sizeMb: number | null;
  installed: { version: string; pinned: boolean; installedAt: string; path: string } | null;
  latest: string | null;
  updateAvailable: boolean;
  /** pinned: the update is the version TeamBot tested (its own checksum); latest: a newer one (the source's own checks). */
  updateKind?: 'pinned' | 'latest' | null;
  job: RuntimeJob | null;
}

export interface RuntimeJob {
  phase: 'metadata' | 'download' | 'verify' | 'extract' | 'check' | 'done' | 'error';
  version: string;
  received?: number;
  total?: number;
  error?: string;
}

export interface DeviceLoginView {
  state: 'starting' | 'waiting' | 'done' | 'error' | 'cancelled';
  url?: string;
  code?: string;
  /** The sign-in page gives a code to paste back here (Claude Code). */
  needsCode?: boolean;
  checking?: boolean;
  error?: string;
}

/** Decimal megabytes as the package registry gives them ("125 MB"), in the interface locale. */
const mb = (n?: number) => formatNumber(Math.round((n || 0) / 1e6), { style: 'unit', unit: 'megabyte', unitDisplay: 'short' });
/** a > b for plain x.y.z versions. */
const newerThan = (a: string, b: string) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) > (pb[i] || 0);
  return false;
};
const busyPhase = (j?: RuntimeJob | null) => !!j && !['done', 'error'].includes(j.phase);

/** Live progress of installing a CLI copy (server events "cli.runtime"). */
export function useRuntimeJob(id: string, initial?: RuntimeJob | null) {
  const [job, setJob] = useState<RuntimeJob | null>(initial || null);
  useEffect(() => setJob(initial || null), [initial?.phase, initial?.version]);
  useEffect(() => on('cli.runtime', (e: any) => e?.id === id && setJob(e)), [id]);
  return job;
}

export function JobProgress({ job, label }: { job: RuntimeJob; label: string }) {
  const pct = job.total ? Math.min(100, Math.round((100 * (job.received || 0)) / job.total)) : 0;
  const text =
    job.phase === 'metadata'
      ? 'Versie en handtekening ophalen…'
      : job.phase === 'download'
        ? job.total
          ? `Downloaden: ${mb(job.received)} van ${mb(job.total)} (${formatPercent(pct)})`
          : `Downloaden: ${mb(job.received)}`
        : job.phase === 'extract'
          ? 'Gecontroleerd. Uitpakken…'
          : job.phase === 'check'
            ? 'Proberen of het programma start…'
            : '';
  return (
    <div className="space-y-1" aria-live="polite">
      <div className="h-1.5 overflow-hidden rounded-full bg-surface-2" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={job.phase === 'download' ? pct : job.phase === 'metadata' ? 0 : 100} aria-label={`${label} installeren`}>
        <div className="h-full rounded-full bg-accent transition-[width] duration-300" style={{ width: `${job.phase === 'download' ? pct : job.phase === 'metadata' ? 3 : 100}%` }} />
      </div>
      <div className="text-[11px] text-muted">{text}</div>
    </div>
  );
}

/**
 * TeamBot's own copy of this CLI: install (pinned, verified), update notice, update, remove. Shown on the CLI's card.
 */
export function OwnCopy({ rt, inUse, onChanged }: { rt: RuntimeView; inUse: boolean; onChanged(): void }) {
  const job = useRuntimeJob(rt.id, rt.job);
  const act = useAsync();
  useEffect(() => {
    if (job?.phase === 'done') onChanged();
    if (job?.phase === 'error' && job.error) toast(job.error, 'danger');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.phase]);
  const install = (version: 'pinned' | 'latest') => act.run(async () => void (await api.post(`/cli-agents/runtimes/${rt.id}/install`, { version })));
  const remove = async () => {
    if (!(await askConfirm(`TeamBot's eigen kopie van ${rt.label} verwijderen? Je login blijft bewaard.`, { ok: 'Verwijderen', danger: true }))) return;
    act.run(async () => (await api.del(`/cli-agents/runtimes/${rt.id}`), onChanged()), 'Eigen kopie verwijderd');
  };
  if (!rt.supported) return null;
  return (
    <div className="mt-3 space-y-2 rounded-lg border border-line p-3 text-sm" data-testid={`own-copy-${rt.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <PackageCheck className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="font-medium">Kopie die TeamBot beheert</span>
        {rt.installed ? (
          <Badge tone="ok">
            <CheckCircle2 className="h-3 w-3" /> versie {rt.installed.version}
            {inUse ? ' · in gebruik' : ''}
          </Badge>
        ) : null}
        {rt.updateAvailable && rt.latest && <Badge tone="accent">update {rt.latest} beschikbaar</Badge>}
      </div>
      <p className="flex items-start gap-1.5 text-xs text-muted">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
        <span>
          {rt.source === 'github'
            ? `Het officiële programma van ${rt.label}, alleen voor jou en gecontroleerd na het downloaden.`
            : 'Het officiële pakket, alleen voor jou. Het wordt alleen bijgewerkt als jij dat kiest.'}
        </span>
      </p>
      {job && busyPhase(job) ? (
        <JobProgress job={job} label={rt.label} />
      ) : (
        <div className="flex flex-wrap gap-2">
          {!rt.installed && (
            <Button size="sm" variant={inUse ? 'secondary' : 'primary'} loading={act.busy} onClick={() => install('pinned')}>
              Installeren (versie {rt.pinned}{rt.sizeMb ? `, ±${mb(rt.sizeMb * 1e6)}` : ''})
            </Button>
          )}
          {rt.installed && rt.updateAvailable && rt.latest && (
            <Button
              size="sm"
              variant="primary"
              icon={<RefreshCw className="h-3.5 w-3.5" />}
              loading={act.busy}
              onClick={() => install(rt.updateKind === 'pinned' ? 'pinned' : 'latest')}
              title={rt.updateKind === 'pinned' ? 'De versie waarmee TeamBot getest is' : 'Nieuwer dan de versie waarmee TeamBot getest is; ook deze wordt gecontroleerd'}
            >
              Bijwerken naar {rt.latest}
            </Button>
          )}
          {rt.installed && (
            <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} disabled={act.busy} onClick={remove}>
              Verwijderen
            </Button>
          )}
        </div>
      )}
      {rt.installed && !rt.installed.pinned && (
        <p className="text-xs text-muted">{newerThan(rt.installed.version, rt.pinned) ? `Bijgewerkt na de versie waarmee TeamBot getest is (${rt.pinned}).` : `Ouder dan de versie waarmee TeamBot getest is (${rt.pinned}).`}</p>
      )}
    </div>
  );
}

/** A local model that "Gratis starten" set up as reserve engine for bots on OpenCode (server: agent/alternatives.ts). */
export interface FreeReserve {
  provider_id: string;
  model: string;
  label: string;
}

/**
 * Start "Gratis starten" and wait until OpenCode is ready (also when TeamBot first installs it). Independent of the
 * button: the page may re-render (OpenCode appears as connected) before the end arrives. `reserve`: the local model
 * that new bots on OpenCode get as reserve engine, when one runs on this computer.
 */
export function freeStart(onInstalling?: () => void): Promise<{ provider: ProviderView; model: string; reserve: FreeReserve | null }> {
  return new Promise((resolve, reject) => {
    const offs: (() => void)[] = [];
    const done = (fn: () => void) => {
      for (const o of offs) o();
      fn();
    };
    offs.push(on('cli.freestart', (e: any) => done(() => (e?.status === 'ready' ? resolve({ provider: e.provider, model: e.model || '', reserve: e.reserve || null }) : reject(new Error(e?.error || 'Gratis starten lukte niet'))))));
    offs.push(on('cli.runtime', (e: any) => e?.id === 'opencode' && e.phase === 'error' && done(() => reject(new Error(e.error || 'Installeren lukte niet')))));
    api
      .post<{ status: 'ready' | 'installing'; provider?: ProviderView; model?: string; reserve?: FreeReserve | null }>('/cli-agents/free-start', {})
      .then((r) => (r.status === 'ready' && r.provider ? done(() => resolve({ provider: r.provider!, model: r.model || '', reserve: r.reserve || null })) : onInstalling?.()))
      .catch((e) => done(() => reject(e)));
  });
}

/**
 * One plain line next to "Gratis starten" when no local model runs here: OpenCode's free models stop at a daily
 * limit, a local model does not. Links to the Ollama setup in TeamBot (TeamBot itself cannot download a model).
 */
export function LocalModelHint({ className }: { className?: string }) {
  return (
    <p className={cx('text-[12px] leading-relaxed text-muted', className)} data-testid="local-model-hint">
      Met een lokaal model (Ollama) werkt het ook offline en zonder daglimiet.{' '}
      <a className="font-semibold underline hover:text-fg" href="#/settings/providers?koppel=ollama">
        Ollama instellen
      </a>
    </p>
  );
}

/**
 * "Gratis starten": OpenCode with a free model, no account, in one click. Installs TeamBot's own OpenCode when there
 * is none (with progress) and connects it; `onReady` gets the provider (and the local reserve, if any).
 */
export function FreeStartButton({ onReady, className, size = 'md', label = 'Gratis starten', primary = true }: { onReady(p: ProviderView, model: string, reserve: FreeReserve | null): void; className?: string; size?: 'sm' | 'md' | 'lg'; label?: string; /** false: a quiet button, when another choice is the recommended one */ primary?: boolean }) {
  const [busy, setBusy] = useState(false);
  const [installing, setInstalling] = useState(false);
  const job = useRuntimeJob('opencode');
  const start = async () => {
    setBusy(true);
    try {
      const r = await freeStart(() => setInstalling(true));
      await useApp.getState().refreshProviders();
      onReady(r.provider, r.model, r.reserve);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
      setInstalling(false);
    }
  };
  return (
    <div className={cx('space-y-2', className)}>
      <Button variant={primary ? 'primary' : 'secondary'} size={size} className="w-full justify-center" icon={<Gift className="h-4 w-4" />} loading={busy} onClick={start}>
        {label}
      </Button>
      {installing && job && busyPhase(job) && <JobProgress job={job} label="OpenCode" />}
      {installing && (!job || job.phase === 'metadata') && <p className="text-center text-[11px] text-muted">OpenCode wordt voor je geïnstalleerd (±125 MB, eenmalig).</p>}
    </div>
  );
}
