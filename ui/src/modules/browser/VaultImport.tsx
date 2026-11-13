import { useEffect, useMemo, useRef, useState } from 'react';
import { AlertTriangle, Check, FileUp, LockOpen, ShieldCheck } from 'lucide-react';
import { Badge, Button, cx, Modal, Spinner } from '../../components/ui';
import { t } from '../../lib/i18n';
import { MoreInfo } from '../../components/MoreInfo';
import { Fold } from '../../components/overview';
import { formatBytes } from '../../lib/format';
import { vault } from './api';
import { VAULT_IMPORT_MAX_BYTES, type VaultImportPreview, type VaultImportResult, type VaultImportRow } from '../../../../shared/vault.js';
import { hostOf, SiteMark } from './SiteMark';

/** Where each app hides its export (menu names differ a little per version and language). */
const HOWTO: { app: string; path: string }[] = [
  { app: 'Bitwarden', path: 'Extra › Kluis exporteren › bestandsindeling .csv' },
  { app: '1Password', path: 'Bestand › Exporteren › kies je account › CSV' },
  { app: 'Chrome', path: 'Instellingen › Google Wachtwoordmanager › Instellingen › Wachtwoorden exporteren' },
  { app: 'Edge', path: 'Instellingen › Wachtwoorden › ⋯ › Wachtwoorden exporteren' },
];

/**
 * "Logins importeren": pick or drop a CSV export → TeamBot recognises the app and shows what is in it (names, sites,
 * usernames — never a password) → choose rows → import → summary. The file is read here and sent once; TeamBot keeps
 * nothing of it on disk.
 */
export function VaultImportDialog({ onClose, onImported }: { onClose(): void; onImported(): void }) {
  const [preview, setPreview] = useState<VaultImportPreview | null>(null);
  const [result, setResult] = useState<VaultImportResult | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  // A file dropped next to the drop zone must not make the browser open it (it holds passwords in plain text).
  useEffect(() => {
    const stop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, []);

  const readFile = async (file: File | undefined | null) => {
    if (!file || busy) return;
    setError(null);
    if (file.size > VAULT_IMPORT_MAX_BYTES) return setError(t('Dit bestand is te groot (maximaal {0}). Splits het in kleinere bestanden.', formatBytes(VAULT_IMPORT_MAX_BYTES)));
    if (!file.size) return setError('Dit bestand is leeg.');
    setBusy(true);
    try {
      const p = await vault.importPreview(await file.text());
      setPreview(p);
      setPicked(new Set(p.rows.filter((r) => r.status === 'new').map((r) => r.index)));
    } catch (e: any) {
      setError(e?.message || 'Dit bestand kon niet gelezen worden.');
    } finally {
      setBusy(false);
      if (fileInput.current) fileInput.current.value = '';
    }
  };

  const doImport = async () => {
    if (!preview) return;
    setBusy(true);
    setError(null);
    try {
      const r = await vault.importRun(preview.handle, [...picked]);
      setResult(r);
      setPreview(null);
      if (r.imported) onImported();
    } catch (e: any) {
      // expired or used: back to the start, with the reason
      setPreview(null);
      setError(e?.message || 'Importeren is mislukt.');
    } finally {
      setBusy(false);
    }
  };

  const importable = preview?.rows.filter((r) => r.status === 'new') || [];
  const listed = preview?.rows.filter((r) => r.status !== 'skip') || [];
  const skipped = preview?.rows.filter((r) => r.status === 'skip') || [];
  const dupes = preview?.rows.filter((r) => r.status === 'duplicate').length || 0;
  const toggle = (i: number, on: boolean) => {
    const s = new Set(picked);
    if (on) s.add(i);
    else s.delete(i);
    setPicked(s);
  };

  const footer = result ? (
    <Button variant="primary" onClick={onClose}>
      Klaar
    </Button>
  ) : preview ? (
    <>
      <Button variant="ghost" onClick={() => (setPreview(null), setError(null))} disabled={busy}>
        Ander bestand
      </Button>
      <Button variant="primary" loading={busy} disabled={!picked.size} onClick={doImport}>
        {picked.size ? t('{0, plural, one {# login importeren} other {# logins importeren}}', picked.size) : 'Kies logins'}
      </Button>
    </>
  ) : (
    <Button onClick={onClose}>Annuleren</Button>
  );

  return (
    <Modal open wide onClose={onClose} title={result ? 'Klaar met importeren' : 'Logins importeren'} footer={footer}>
      {result ? (
        <ImportSummary result={result} />
      ) : preview ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
              <Badge tone="accent">{preview.format.label}</Badge>
              <span>
                {t('{0, plural, one {# nieuwe login} other {# nieuwe logins}}', importable.length)}
                {dupes ? <span className="text-muted"> · {t('{0, plural, one {# staat er al in} other {# staan er al in}}', dupes)}</span> : null}
              </span>
            </div>
            {importable.length > 0 && (
              <div className="flex gap-1">
                <Button size="sm" variant="ghost" onClick={() => setPicked(new Set(importable.map((r) => r.index)))}>
                  Alles kiezen
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setPicked(new Set())}>
                  Niets kiezen
                </Button>
              </div>
            )}
          </div>
          {listed.length ? (
            <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line" aria-label="Logins in het bestand">
              {listed.map((r) => (
                <ImportRow key={r.index} row={r} checked={picked.has(r.index)} onChange={(on) => toggle(r.index, on)} />
              ))}
            </ul>
          ) : (
            <p className="rounded-xl bg-surface-2 px-3 py-3 text-sm text-muted">Er staat geen bruikbare login in dit bestand. Hieronder zie je waarom.</p>
          )}
          {picked.size > preview.room && (
            <p role="alert" className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
              {t('{0, plural, one {Er past nog # login in de kluis.} other {Er passen nog # logins in de kluis.}} De rest wordt overgeslagen.', preview.room)}
            </p>
          )}
          {skipped.length > 0 && (
            <Fold title={t('{0, plural, one {# regel wordt overgeslagen} other {# regels worden overgeslagen}}', skipped.length)}>
              <ul className="space-y-1 text-[13px]">
                {skipped.map((r) => (
                  <li key={r.index} className="flex flex-wrap justify-between gap-x-3">
                    <span className="min-w-0 [overflow-wrap:anywhere]">{r.label || `Rij ${r.line}`}</span>
                    <span className="text-muted">{r.reason}</span>
                  </li>
                ))}
              </ul>
            </Fold>
          )}
          <p className="flex items-start gap-2 text-[13px] text-muted">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg" aria-hidden />
            <span>
              Jij keurt elk gebruik goed. <MoreInfo>Al je bots mogen om deze logins vragen; ze zien het wachtwoord nooit.</MoreInfo>
            </span>
          </p>
          {error && (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      ) : (
        <div className="space-y-4">
          <label
            className={cx(
              'flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-10 text-center text-sm transition-colors',
              dragging ? 'border-line-strong bg-surface-2' : 'border-line hover:border-line-strong',
              busy && 'pointer-events-none opacity-70',
            )}
            onDragOver={(e) => {
              e.preventDefault();
              setDragging(true);
            }}
            onDragLeave={() => setDragging(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragging(false);
              readFile(e.dataTransfer.files?.[0]);
            }}
          >
            {busy ? <Spinner className="h-6 w-6" /> : <FileUp className="h-6 w-6 text-muted" aria-hidden />}
            <span className="font-semibold">{busy ? 'Bestand lezen…' : 'Sleep je CSV-bestand hierheen of klik om te kiezen'}</span>
            <span className="text-[13px] text-muted">De export van Bitwarden, 1Password, Chrome of Edge. Je kiest daarna zelf welke logins erbij komen.</span>
            <input ref={fileInput} type="file" accept=".csv,text/csv,text/plain" className="sr-only" disabled={busy} onChange={(e) => readFile(e.target.files?.[0])} />
          </label>
          {error && (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
          <Fold title="Waar vind ik de export?">
            <dl className="space-y-2 text-[13px]">
              {HOWTO.map((h) => (
                <div key={h.app}>
                  <dt className="font-semibold">{h.app}</dt>
                  <dd className="text-muted">{h.path}</dd>
                </div>
              ))}
            </dl>
          </Fold>
          <p className="flex items-start gap-2 text-[13px] text-muted">
            <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg" aria-hidden />
            <span>
              Het bestand zelf wordt nergens bewaard. <MoreInfo>TeamBot bewaart de wachtwoorden versleuteld. Je ziet ze hier niet terug.</MoreInfo>
            </span>
          </p>
        </div>
      )}
    </Modal>
  );
}

function ImportRow({ row, checked, onChange }: { row: VaultImportRow; checked: boolean; onChange(on: boolean): void }) {
  const dup = row.status === 'duplicate';
  return (
    <li>
      <label className={cx('flex items-start gap-3 px-3.5 py-2.5', dup ? 'cursor-default' : 'cursor-pointer hover:bg-surface-2')}>
        <input type="checkbox" className="mt-2.5 shrink-0" checked={!dup && checked} disabled={dup} onChange={(e) => onChange(e.target.checked)} aria-label={t('{0} importeren', row.label)} />
        <SiteMark origin={row.origins[0]} size={32} />
        <span className="min-w-0 flex-1 space-y-0.5">
          <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span className={cx('min-w-0 font-semibold [overflow-wrap:anywhere]', dup && 'text-muted')}>{row.label}</span>
            {dup && <Badge>{row.reason}</Badge>}
            {row.has_totp && (
              <Badge tone="ok">
                <Check className="h-3 w-3" aria-hidden /> 2FA-code
              </Badge>
            )}
            {row.insecure && (
              <Badge tone="warn">
                <LockOpen className="h-3 w-3" aria-hidden /> http
              </Badge>
            )}
          </span>
          <span className="block text-[13px] text-muted [overflow-wrap:anywhere]" translate="no">
            {row.username || 'geen gebruikersnaam'}
          </span>
          <span className="flex flex-wrap gap-1">
            {row.origins.map((o) => (
              <code key={o} className="max-w-full truncate rounded-md bg-surface-2 px-1.5 py-0.5 text-[11.5px]" translate="no">
                {hostOf(o)}
              </code>
            ))}
          </span>
          {row.warning && <span className="block text-xs text-warn">{row.warning}</span>}
        </span>
      </label>
    </li>
  );
}

function ImportSummary({ result }: { result: VaultImportResult }) {
  const groups = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of result.skipped) m.set(s.reason, [...(m.get(s.reason) || []), s.label]);
    return [...m.entries()].sort((a, b) => b[1].length - a[1].length);
  }, [result]);
  return (
    <div className="space-y-4">
      <div className="flex flex-col items-center gap-2 py-3 text-center">
        <span className={cx('flex h-12 w-12 items-center justify-center rounded-2xl', result.imported ? 'bg-ok-soft text-ok' : 'bg-surface-2 text-muted')}>
          {result.imported ? <Check className="h-6 w-6" aria-hidden /> : <AlertTriangle className="h-6 w-6" aria-hidden />}
        </span>
        <div className="text-base font-bold tracking-tight">{result.imported ? t('{0, plural, one {# login geïmporteerd} other {# logins geïmporteerd}}', result.imported) : 'Niets geïmporteerd'}</div>
        <div className="text-sm text-muted">{result.skipped.length ? t('{0, plural, one {# regel overgeslagen} other {# regels overgeslagen}}', result.skipped.length) : 'Niets overgeslagen'}</div>
      </div>
      {groups.length > 0 && (
        <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line text-sm">
          {groups.map(([reason, labels]) => (
            <li key={reason} className="space-y-0.5 px-3.5 py-2.5">
              <div className="flex items-center justify-between gap-3">
                <span className="font-semibold">{reason}</span>
                <Badge>{labels.length}</Badge>
              </div>
              <div className="text-[13px] text-muted">
                {labels.slice(0, 6).join(', ')}
                {labels.length > 6 ? ` en nog ${labels.length - 6}` : ''}
              </div>
            </li>
          ))}
        </ul>
      )}
      <p className="flex items-start gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
        <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>Verwijder het CSV-bestand nu van je computer: er staan je wachtwoorden onversleuteld in.</span>
      </p>
    </div>
  );
}
