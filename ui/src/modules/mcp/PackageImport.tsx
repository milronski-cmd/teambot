import { useEffect, useState } from 'react';
import { PackageOpen } from 'lucide-react';
import { api, request } from '../../lib/api';
import { Badge, Button, Modal, Spinner, cx, useAsync } from '../../components/ui';
import type { CatalogEntry, PolicyView, SigView } from './shared';
import { SigBadge } from './shared';
import type { PackagePick } from './Wizard';

interface Preview {
  entry: CatalogEntry;
  signature: SigView;
  policy: PolicyView;
  scan: { level: 'ok' | 'info' | 'warn' | 'danger'; labels: string[]; findings: { severity: string; message: string; file: string; line?: number }[]; domains: string[] };
  manifest: { name: string; version: string; license: string; teambot: string } | null;
}

const SCAN_TONE = { ok: 'ok', info: 'neutral', warn: 'warn', danger: 'danger' } as const;
const SCAN_TEXT = { ok: 'Geen bevindingen', info: 'Ter info', warn: 'Waarschuwing', danger: 'Ernstige waarschuwing' } as const;

/**
 * Install a connector package (zip from `teambot-pack zip`, or an inline `{ manifest, files }` JSON, or an item from an
 * external catalog). Shows who signed it and what the publisher policy says, then continues in the normal wizard.
 */
export function PackageImport({ catalogRef, onClose, onPick }: { catalogRef?: string | null; onClose(): void; onPick(entry: CatalogEntry, pkg: PackagePick): void }) {
  const [pkg, setPkg] = useState<any>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState('');
  const { busy, run } = useAsync();

  const inspect = async (p: any) => {
    const pv = await api.post<Preview>('/mcp/packages/preview', { package: p });
    setPkg(p);
    setPreview(pv);
  };

  useEffect(() => {
    if (!catalogRef) return;
    const [catalogId, ...rest] = catalogRef.split('/');
    run(async () => {
      try {
        const r = await api.get<{ package: any }>(`/skills/market/apps/${encodeURIComponent(catalogId)}/${encodeURIComponent(rest.join('/'))}/package`);
        await inspect(r.package);
      } catch (e: any) {
        setError(e.message);
      }
    });
  }, [catalogRef]);

  const onFile = (f?: File) => {
    if (!f) return;
    if (f.size > 25 * 1024 * 1024) return setError('Het bestand is te groot (max. 25 MB).');
    run(async () => {
      setError('');
      try {
        let p: any;
        if (/\.zip$/i.test(f.name) || f.type.includes('zip')) {
          const r = await request<{ kind: string; package: any }>('/skills/packages/unzip', { method: 'POST', raw: f, headers: { 'content-type': 'application/zip' } });
          if (r.kind !== 'connector') throw new Error(r.kind === 'bot' ? 'Dit is een bot-pakket. Importeer het via Marktplaats › Sjabloon importeren.' : 'Dit is een skillpakket. Importeer het via Mijn skills › Importeren.');
          p = r.package;
        } else {
          const j = JSON.parse(await f.text());
          if (!j?.files || typeof j.files !== 'object') throw new Error('Dit JSON-bestand is geen connectorpakket ({ manifest, files }).');
          p = j;
        }
        await inspect(p);
      } catch (e: any) {
        setError(e instanceof SyntaxError ? 'Dit is geen geldig JSON-bestand.' : e.message);
      }
    });
  };

  const sig = preview?.signature;
  const blocked = !!preview && (preview.policy.blocked || !preview.entry.available);
  return (
    <Modal
      open
      onClose={onClose}
      wide
      title="Connectorpakket installeren"
      footer={
        preview ? (
          <>
            <Button variant="ghost" onClick={onClose}>
              Annuleren
            </Button>
            <Button variant="primary" disabled={blocked} onClick={() => onPick({ ...preview.entry, signature: preview.signature }, { package: pkg, policy: preview.policy })}>
              Verder
            </Button>
          </>
        ) : undefined
      }
    >
      {busy && !preview ? (
        <div className="flex justify-center py-8">
          <Spinner />
        </div>
      ) : preview && sig ? (
        <div className="space-y-3 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{preview.entry.name}</span>
            {preview.manifest && <Badge>v{preview.manifest.version}</Badge>}
            <SigBadge sig={sig} />
            <Badge tone={SCAN_TONE[preview.scan.level]}>{SCAN_TEXT[preview.scan.level]}</Badge>
          </div>
          {preview.entry.description && <p>{preview.entry.description}</p>}
          <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-1">
            <dt className="text-muted">Uitgever</dt>
            <dd className="min-w-0 break-words">
              {sig.publisher || 'onbekend'}
              {sig.declaredPublisher && sig.publisher !== sig.declaredPublisher ? ` (noemt zich ${sig.declaredPublisher})` : ''}
            </dd>
            {sig.fingerprint && (
              <>
                <dt className="text-muted">Vingerafdruk</dt>
                <dd className="break-all font-mono text-xs">{sig.fingerprint}</dd>
              </>
            )}
            <dt className="text-muted">Verbinding</dt>
            <dd className="break-all font-mono text-xs">{preview.entry.url || [preview.entry.command, ...(preview.entry.args || [])].join(' ')}</dd>
            {preview.manifest && (
              <>
                <dt className="text-muted">Licentie</dt>
                <dd>{preview.manifest.license}</dd>
                <dt className="text-muted">Werkt met TeamBot</dt>
                <dd className="font-mono text-xs">{preview.manifest.teambot}</dd>
              </>
            )}
          </dl>
          {[...sig.errors, ...sig.incompatible].length > 0 && (
            <ul className="list-disc space-y-0.5 ps-5 text-danger">
              {[...sig.errors, ...sig.incompatible].map((e, i) => (
                <li key={i}>{e}</li>
              ))}
            </ul>
          )}
          {preview.scan.findings.filter((f) => f.severity !== 'info').length > 0 && (
            <ul className="space-y-1">
              {preview.scan.findings
                .filter((f) => f.severity !== 'info')
                .slice(0, 8)
                .map((f, i) => (
                  <li key={i} className={cx('rounded-lg px-3 py-2', f.severity === 'danger' ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn')}>
                    {f.message} {f.file && <span className="text-xs">({f.file}{f.line ? `:${f.line}` : ''})</span>}
                  </li>
                ))}
            </ul>
          )}
          {!preview.entry.available && <p className="rounded-lg bg-warn-soft px-3 py-2 text-warn">{preview.entry.unavailableReason}</p>}
          {!preview.policy.allowed && preview.policy.reason && (
            <p role={preview.policy.blocked ? 'alert' : undefined} className={cx('rounded-lg px-3 py-2', preview.policy.blocked ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn')}>
              {preview.policy.reason}
            </p>
          )}
          <p className="text-xs text-muted">Na “Verder” stel je de koppeling in zoals bij elke andere app.</p>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-sm text-muted">Kies een connectorpakket. Je ziet eerst wie het ondertekende en wat het doet.</p>
          <label className="flex cursor-pointer flex-col items-center gap-2 rounded-xl border border-dashed border-line px-4 py-8 text-center text-sm hover:border-line-strong">
            <PackageOpen className="h-6 w-6 text-muted" />
            <span>Bestand kiezen</span>
            <input type="file" accept=".zip,application/zip,.json,application/json" className="sr-only" onChange={(e) => onFile(e.target.files?.[0])} />
          </label>
        </div>
      )}
      {error && (
        <p role="alert" className="mt-3 rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {error}
        </p>
      )}
    </Modal>
  );
}
