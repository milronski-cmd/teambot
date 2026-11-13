import { useEffect, useState } from 'react';
import { AlarmClock, ArrowRight, Bot, CheckCircle2, ClipboardList, Info, RefreshCw, ShieldCheck, TriangleAlert, Upload } from 'lucide-react';
import { Badge, Button, Card, cx, toastError } from '../../components/ui';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { formatDateTime } from '../../lib/format';
import type { Attention, EngineStatus, UndoResult } from './api';

/** Small building blocks of the import page, shared by every source (OpenBot, Hermes Agent). */

export function Check({ checked, onChange, disabled, label }: { checked: boolean; onChange(v: boolean): void; disabled?: boolean; label: string }) {
  return <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} aria-label={label} className="mt-0.5 h-4 w-4 shrink-0 accent-[var(--color-accent)] disabled:opacity-40" />;
}

/** The set with `key` in it (on) or out of it (off). */
export const toggleIn = (set: Set<string>, key: string, on: boolean) => (on ? new Set([...set, key]) : new Set([...set].filter((k) => k !== key)));

export function AttentionList({ items }: { items: Attention[] }) {
  if (!items.length) return null;
  return (
    <ul className="space-y-1.5">
      {items.map((a, i) => (
        <li key={i} className={cx('flex items-start gap-2 rounded-lg px-3 py-2 text-sm', a.level === 'warn' ? 'bg-warn-soft text-warn' : 'bg-surface-2 text-muted')}>
          {a.level === 'warn' ? <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /> : <Info className="mt-0.5 h-4 w-4 shrink-0" />}
          <span className={a.level === 'warn' ? 'text-fg' : ''}>{a.text}</span>
        </li>
      ))}
    </ul>
  );
}

export function Section({ icon, title, count, children, actions }: { icon: React.ReactNode; title: string; count?: string; children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-accent">{icon}</span>
        <h2 className="text-sm font-semibold">{title}</h2>
        {count && <span className="text-xs text-muted">{count}</span>}
        {actions && <div className="ms-auto flex gap-1">{actions}</div>}
      </div>
      {children}
    </section>
  );
}

export function AllNone({ onAll, onNone }: { onAll(): void; onNone(): void }) {
  return (
    <>
      <Button size="sm" variant="ghost" onClick={onAll}>
        Alles
      </Button>
      <Button size="sm" variant="ghost" onClick={onNone}>
        Niets
      </Button>
    </>
  );
}

/** A plain error in the card (reading failed, undo plan failed). Nothing when there is none. */
export function ErrorNote({ text }: { text: string }) {
  if (!text) return null;
  return (
    <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
      {text}
    </p>
  );
}

const ENGINE_TONE: Record<EngineStatus, 'ok' | 'accent' | 'warn' | 'danger' | 'neutral'> = { ready: 'ok', connect: 'accent', reconnect: 'warn', missing: 'warn', unknown: 'danger' };
const ENGINE_LABEL: Record<EngineStatus, string> = { ready: 'gekoppeld', connect: 'wordt gekoppeld', reconnect: 'opnieuw verbinden', missing: 'niet gevonden', unknown: 'geen equivalent' };

/** Which AI a bot gets in TeamBot and whether that is linked yet ("Claude Code · gekoppeld"). */
export function EngineBadge({ engine }: { engine: { label: string; status: EngineStatus } }) {
  return (
    <Badge tone={ENGINE_TONE[engine.status]}>
      {engine.label} · {ENGINE_LABEL[engine.status]}
    </Badge>
  );
}

/** Before reading: what was found, and whether it was imported before. */
export function SourceFound({ title, imported, children }: { title: string; imported?: { at: string; counts: { bots: number }; undone?: string | null } | null; children: React.ReactNode }) {
  return (
    <div className="flex items-start gap-3">
      <Upload className="mt-0.5 h-5 w-5 shrink-0 text-accent" />
      <div className="space-y-1">
        <div className="font-medium">{title}</div>
        {children}
        {imported && !imported.undone && <p className="text-sm text-muted">{t('Eerder overgenomen op {0} ({1, plural, one {# bot} other {# bots}}). Opnieuw inlezen maakt geen dubbele bots.', formatDateTime(imported.at), imported.counts.bots)}</p>}
      </div>
    </div>
  );
}

/** The promises before reading (read only, no keys, routines off, undo): one line each. */
export function Promises({ items }: { items: string[] }) {
  return (
    <ul className="space-y-1.5 text-sm text-muted">
      {items.map((x) => (
        <li key={x} className="flex gap-2">
          <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-ok" /> {x}
        </li>
      ))}
    </ul>
  );
}

/** The read button (its label is the child), the note that nothing is imported yet, and undo of an earlier import. */
export function ReadRow({ reading, disabled, onRead, undo, children }: { reading: boolean; disabled?: boolean; onRead(): void; undo?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button variant="primary" loading={reading} disabled={disabled} icon={<ArrowRight className="h-4 w-4" />} onClick={onRead}>
        {children}
      </Button>
      <span className="text-xs text-muted">Je ziet eerst wat er overkomt; er wordt nog niets geïmporteerd.</span>
      {undo && <span className="sm:ms-auto">{undo}</span>}
    </div>
  );
}

/** Above the preview: where it was read from, read again, and what needs attention. */
export function PlanTop({ path, attention, reading, onRead }: { path: string; attention: Attention[]; reading: boolean; onRead(): void }) {
  return (
    <>
      <div className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <span>
          Ingelezen uit <code className="break-all">{path}</code>. Dit is een voorvertoning: er is nog niets veranderd.
        </span>
        <Button size="sm" variant="ghost" icon={<RefreshCw className="h-3.5 w-3.5" />} loading={reading} onClick={onRead}>
          Opnieuw inlezen
        </Button>
      </div>
      <AttentionList items={attention} />
    </>
  );
}

interface RoutineLike {
  key: string;
  botKey: string;
  botName: string;
  name: string;
  schedule: string;
  ok: boolean;
  wasActive: boolean;
  notes: string[];
  existing?: boolean;
  /** It answers customers (OpenBot): a warning badge and its notes in the warning colour. */
  customer?: boolean;
}

/** The scheduled tasks of a preview, each with a check box; a task of a bot that does not come over cannot be chosen. */
export function RoutineList({ routines, chosen, setChosen, known, empty }: { routines: RoutineLike[]; chosen: Set<string>; setChosen(f: (s: Set<string>) => Set<string>): void; known(botKey: string): boolean; empty: string }) {
  if (!routines.length) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <Card className="divide-y divide-line">
      {routines.map((r) => {
        const botOff = !known(r.botKey);
        return (
          <div key={r.key} className={cx('flex items-start gap-3 px-4 py-2.5', (!r.ok || botOff || r.existing) && 'opacity-60')}>
            <Check checked={chosen.has(r.key) && !botOff} disabled={!r.ok || botOff || r.existing} onChange={(v) => setChosen((x) => toggleIn(x, r.key, v))} label={t('Routine {0}', r.name)} />
            <div className="min-w-0 flex-1 space-y-0.5">
              <div className="flex flex-wrap items-center gap-1.5">
                <span className="text-sm font-medium">{r.name}</span>
                <span className="text-xs text-muted">· {r.botName}</span>
                <Badge tone="neutral">{r.wasActive ? 'stond aan · komt uit' : 'stond uit · blijft uit'}</Badge>
                {r.customer && <Badge tone="warn">klantberichten</Badge>}
                {r.existing && <Badge tone="ok">al overgenomen</Badge>}
              </div>
              <p className={cx('text-xs', r.ok ? 'text-muted' : 'text-danger')}>
                {r.schedule}
                {botOff && r.ok ? ' · de bot wordt niet overgenomen' : ''}
              </p>
              {r.notes.length > 0 && <p className={cx('text-xs', r.customer ? 'text-warn' : 'text-muted')}>{r.notes.join(' ')}</p>}
            </div>
          </div>
        );
      })}
    </Card>
  );
}

/** The bar under the preview: what will be made (the child), and the import button. */
export function ImportBar({ importing, disabled, onImport, children }: { importing: boolean; disabled: boolean; onImport(): void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-x-0 bottom-0 z-10 border-t border-line bg-surface/95 px-4 py-3 backdrop-blur sm:static sm:rounded-xl sm:border">
      <div className="mx-auto flex max-w-4xl flex-wrap items-center gap-3">
        <span className="text-sm text-muted">{children}</span>
        <Button className="ms-auto" variant="primary" loading={importing} disabled={disabled} onClick={onImport} icon={<CheckCircle2 className="h-4 w-4" />}>
          Importeren
        </Button>
      </div>
    </div>
  );
}

/** After the import: what was made, as tiles that link to where it now lives. */
export function ResultTiles({ tiles }: { tiles: { n: number; label: string; href: string }[] }) {
  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
      {tiles.map((x) => (
        <a key={x.href} href={x.href} className="rounded-xl border border-line bg-surface-2 px-3 py-3 hover:border-accent">
          <div className="text-2xl font-semibold tabular-nums">{x.n}</div>
          <div className="text-xs text-muted">{x.label}</div>
        </a>
      ))}
    </div>
  );
}

/** After the import: per AI service whether it is linked, or what to do. */
export function ProviderNotes({ providers }: { providers: { label: string; status: string; note: string }[] }) {
  if (!providers.length) return null;
  return (
    <ul className="space-y-0.5 text-sm">
      {providers.map((p, i) => (
        <li key={i} className="flex items-start gap-2">
          <Badge tone={p.status === 'linked' ? 'ok' : 'warn'}>{p.label}</Badge>
          <span className="text-muted">{p.note}</span>
        </li>
      ))}
    </ul>
  );
}

/** After the import: "Nog even regelen" (what failed, what still needs you), then where to go next. `next` sits after "Naar je bots". */
export function AfterImport({ errors, attention, onAgain, next, undo }: { errors: string[]; attention: Attention[]; onAgain(): void; next?: React.ReactNode; undo?: React.ReactNode }) {
  return (
    <>
      {(attention.length > 0 || errors.length > 0) && (
        <Section icon={<ClipboardList className="h-4 w-4" />} title="Nog even regelen">
          <AttentionList items={[...errors.map((text) => ({ level: 'warn' as const, text })), ...attention]} />
        </Section>
      )}
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" icon={<Bot className="h-4 w-4" />} onClick={() => navigate('/agents')}>
          Naar je bots
        </Button>
        {next}
        <Button icon={<AlarmClock className="h-4 w-4" />} onClick={() => navigate('/m/routines')}>
          Routines aanzetten
        </Button>
        <Button variant="ghost" icon={<RefreshCw className="h-4 w-4" />} onClick={onAgain}>
          Nogmaals inlezen
        </Button>
        {undo}
      </div>
    </>
  );
}

/**
 * The steps every import shares: find the source, read a preview (`preview` gets what was found, then `onPlan` sets
 * the choices), import (`doImport` with the source's own commit), and start over after an undo.
 */
export function useImportFlow<D, P, R>(o: { detect(): Promise<D>; notFound: D; preview(det: D | null): Promise<P>; onPlan(p: P): void }) {
  const [det, setDet] = useState<D | null>(null);
  const [plan, setPlan] = useState<P | null>(null);
  const [result, setResult] = useState<R | null>(null);
  const [undone, setUndone] = useState<UndoResult | null>(null);
  const [busy, setBusy] = useState<'' | 'read' | 'import'>('');
  const [error, setError] = useState('');

  const loadDetect = () => o.detect().then(setDet).catch(() => setDet(o.notFound));
  useEffect(() => {
    loadDetect();
  }, []);

  const read = async () => {
    setBusy('read');
    setError('');
    setResult(null);
    setUndone(null);
    try {
      const p = await o.preview(det);
      setPlan(p);
      o.onPlan(p);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy('');
    }
  };

  const doImport = async (commit: () => Promise<R>) => {
    setBusy('import');
    try {
      const r = await commit();
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

  return { det, setDet, plan, result, undone, busy, error, loadDetect, read, doImport, afterUndo };
}
