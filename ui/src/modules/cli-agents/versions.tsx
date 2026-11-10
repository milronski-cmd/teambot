import { useEffect, useState } from 'react';
import { CheckCircle2, Copy, RefreshCw, ShieldCheck, XCircle } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatDateTime } from '../../lib/format';
import { askConfirm, Badge, Button, Card, toast, useAsync } from '../../components/ui';

/** Mirror of GET /api/cli-agents/versions (server/modules/cli-agents/versions.ts). */
interface EngineView {
  id: string;
  label: string;
  installed: boolean;
  version: string | null;
  path: string | null;
  source: string | null;
  tested: string;
  state: 'getest' | 'werkt' | 'nieuw' | 'mislukt' | 'akkoord' | 'onbekend' | 'ontbreekt';
  stateLabel: string;
  previous: string | null;
  changedAt: string | null;
  good: string[];
  check: { version: string; at: string; ok: boolean; ms: number; steps: { id: string; label: string; ok: boolean; optional?: boolean; detail?: string }[] } | null;
  accepted: boolean;
  rollback: { target: string; command?: string; oneClick?: 'runtime'; note: string } | null;
  newerThanTested: boolean;
}

const TONE: Record<EngineView['state'], 'ok' | 'warn' | 'danger' | 'neutral'> = { getest: 'ok', werkt: 'ok', nieuw: 'warn', onbekend: 'neutral', mislukt: 'danger', akkoord: 'warn', ontbreekt: 'neutral' };

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Gekopieerd', 'ok');
  } catch {
    toast('Kopiëren lukte niet — selecteer de tekst handmatig', 'danger');
  }
}

/**
 * Instellingen › CLI-agents › Versies van de engines: which version runs, which one TeamBot tested, a change since
 * last time, the free self-check, and the way back (a command for your own CLI, one click for TeamBot's own copy).
 */
export function EngineVersionsCard() {
  const [items, setItems] = useState<EngineView[] | null>(null);
  const [err, setErr] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const a = useAsync();
  const load = (fresh = false) =>
    api
      .get<{ items: EngineView[] }>(`/cli-agents/versions${fresh ? '?fresh=1' : ''}`)
      .then((r) => (setItems(r.items), setErr('')))
      .catch((e) => setErr(e.message || String(e)));
  useEffect(() => {
    load();
    return on('cli.versions', () => load());
  }, []);
  const shown = (items || []).filter((i) => i.installed);
  if (err) return <p className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">{err}</p>;
  if (!items) return null;
  if (!shown.length) return null;
  const check = (id: string) => {
    setBusy(id);
    return a
      .run(async () => {
        const r = await api.post<{ check: EngineView['check']; items: EngineView[] }>(`/cli-agents/versions/${id}/check`);
        setItems(r.items);
        toast(r.check?.ok ? 'Eigen test geslaagd' : 'Eigen test mislukt', r.check?.ok ? 'ok' : 'danger');
      })
      .finally(() => setBusy(null));
  };
  return (
    <Card className="space-y-3 p-4" data-testid="engine-versions">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="max-w-2xl">
          <h3 className="flex items-center gap-2 text-[15px] font-bold tracking-tight">
            <ShieldCheck className="h-4 w-4" aria-hidden /> Versies van de engines
          </h3>
          <p className="mt-1 text-sm text-muted">
            Claude Code, Codex en OpenCode werken zichzelf soms bij. TeamBot ziet dat, test een nieuwe versie kort zelf (zonder prompt, kost geen tegoed) en zegt hoe je terug kunt. Je eigen CLI verandert TeamBot nooit.
          </p>
        </div>
        <Button size="sm" icon={<RefreshCw className="h-3.5 w-3.5" />} onClick={() => load(true)}>
          Opnieuw kijken
        </Button>
      </div>
      <ul className="divide-y divide-line">
        {shown.map((e) => (
          <li key={e.id} className="space-y-2 py-3">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-semibold">{e.label}</span>
              <span className="text-sm text-muted" translate="no">
                {e.version}
              </span>
              <Badge tone={TONE[e.state]}>{e.stateLabel}</Badge>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" loading={busy === e.id} onClick={() => check(e.id)}>
                Nu testen
              </Button>
            </div>
            <div className="text-xs text-muted">
              {t('Getest met TeamBot: {0}.', e.tested)}
              {e.previous && e.changedAt ? ` ${t('Bijgewerkt van {0} op {1}.', e.previous, formatDateTime(e.changedAt))}` : ''}
              {e.check ? ` ${t('Eigen test: {0}.', formatDateTime(e.check.at))}` : ''}
            </div>
            {e.check && (
              <ul className="space-y-0.5 text-sm">
                {e.check.steps.map((s) => (
                  <li key={s.id} className="flex items-start gap-1.5">
                    {s.ok ? <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-ok" aria-hidden /> : <XCircle className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${s.optional ? 'text-warn' : 'text-danger'}`} aria-hidden />}
                    <span>
                      {s.label}
                      {s.detail && <span className="text-muted">: {s.detail}</span>}
                    </span>
                  </li>
                ))}
              </ul>
            )}
            {(e.state === 'mislukt' || e.state === 'nieuw' || e.state === 'akkoord') && e.rollback && (
              <div className="space-y-2 rounded-lg bg-surface-2 p-3 text-sm">
                <div className="font-semibold">{t('Terug naar {0}', e.rollback.target)}</div>
                <p className="text-muted">{e.rollback.note}</p>
                {e.rollback.command && (
                  <div className="flex items-start gap-1.5">
                    <code className="min-w-0 flex-1 break-all rounded-md bg-surface px-2 py-1.5 font-mono text-xs">{e.rollback.command}</code>
                    <Button size="icon" variant="ghost" className="h-7 w-7 shrink-0" aria-label={t('Kopieer: {0}', e.rollback.command)} onClick={() => copy(e.rollback!.command!)}>
                      <Copy className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                )}
                <div className="flex flex-wrap gap-2">
                  {e.rollback.oneClick === 'runtime' && (
                    <Button
                      size="sm"
                      variant="primary"
                      loading={a.busy}
                      onClick={async () =>
                        (await askConfirm(t('TeamBot installeert zijn eigen kopie van {0}, versie {1}.', e.label, e.tested), { ok: 'Installeren' })) &&
                        a.run(async () => {
                          await api.post(`/cli-agents/runtimes/${e.id}/install`, { version: 'pinned' });
                          toast(t('{0} {1} wordt geïnstalleerd.', e.label, e.tested), 'ok');
                        })
                      }
                    >
                      {t('Terug naar {0}', e.tested)}
                    </Button>
                  )}
                  {e.state === 'mislukt' && (
                    <Button size="sm" variant="ghost" onClick={() => a.run(async () => setItems((await api.post<{ items: EngineView[] }>(`/cli-agents/versions/${e.id}/accept`)).items))}>
                      Toch blijven gebruiken
                    </Button>
                  )}
                </div>
              </div>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
