import React, { useEffect } from 'react';
import { Download, Sparkles, Trash2, Search } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Button, Card, Field, Select, Toggle, useAsync, CardHead } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { ErrorBox, Loading, Meter } from './parts';
import { useMem } from './lib';

/** The built-in model (granite-embedding since 0.4.4; ids start with "builtin:"). */
const isBuiltin = (m: string | null | undefined) => /^builtin:/.test(String(m || ''));
const modelLabel = (m: string) => (isBuiltin(m) ? `Ingebouwd zoekmodel (${m.slice('builtin:'.length)})` : m);

/**
 * Opslag › Zoeken op betekenis: on/off, which model (the built-in one, or one in Ollama on this computer), how much is
 * indexed, and the downloads (the owner's choice; afterwards everything stays on this computer).
 */
export function SemanticCard({ settings, save }: { settings: any; save(patch: any): void }) {
  const r = useMem<any>('/memory/semantic?fresh=1');
  const { run, busy } = useAsync();
  const running = r.data?.pull?.status === 'running' || r.data?.builtin?.state === 'downloading';
  // While a download runs: follow its progress.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => r.reload(), 1500);
    return () => clearInterval(id);
  }, [running]);
  const d = r.data;
  const on = settings.semantic !== 'off';
  const pct = d?.pull?.total ? Math.round((d.pull.completed / d.pull.total) * 100) : 0;
  const b = d?.builtin;
  const bpct = b?.bytes ? Math.round((b.done / b.bytes) * 100) : 0;
  const builtinAction = (action: 'enable' | 'remove') =>
    run(async () => {
      await api.post('/memory/semantic/builtin', { action });
      r.reload();
    }, action === 'enable' ? 'Het zoekmodel wordt gedownload' : 'Het ingebouwde zoekmodel is verwijderd');
  return (
    <Card className="space-y-3 p-4">
      <CardHead icon={Search} tone="violet" title="Zoeken op betekenis" />
      <p className="text-xs text-muted">Vindt ook herinneringen in andere woorden. Je geheugen gaat daarvoor niet naar internet.</p>
      <Toggle checked={on} onChange={(v) => save({ semantic: v ? 'auto' : 'off' })} label="Ook zoeken op betekenis" />
      {on && r.error && <ErrorBox error={r.error} retry={r.reload} />}
      {on && !r.error && !d && <Loading />}
      {on && d && (
        <div className="space-y-2 text-sm">
          {d.state === 'on' && (
            <>
              <p className="text-ok">{t('Aan met {0}.', modelLabel(d.model))}</p>
              <Meter progress label="Herinneringen doorzocht op betekenis" value={d.counts.items.done} max={Math.max(1, d.counts.items.total)} hint={`${d.counts.items.done} / ${d.counts.items.total}`} />
              {d.counts.chunks.total > 0 && <Meter progress label="Documentdelen doorzocht op betekenis" value={d.counts.chunks.done} max={d.counts.chunks.total} hint={`${d.counts.chunks.done} / ${d.counts.chunks.total}`} />}
              {d.models.length > 1 && (
                <Field label="Model" hint="Een ander model maakt alles opnieuw doorzoekbaar; dat gebeurt op de achtergrond.">
                  <Select value={settings.semanticModel || ''} onChange={(e) => save({ semanticModel: e.target.value || null })} aria-label="Model voor zoeken op betekenis">
                    <option value="">Automatisch (Ollama als daar een zoekmodel is, anders het ingebouwde)</option>
                    {d.models.map((m: string) => (
                      <option key={m} value={m}>
                        {modelLabel(m)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <p className="text-xs text-muted">Gevoelige herinneringen worden alleen op woorden doorzocht: daarvan maakt TeamBot geen kopie voor zoeken op betekenis. Gearchiveerde herinneringen vind je op woorden.</p>
            </>
          )}
          {/* The built-in model: the way for everyone (no Ollama needed). */}
          {b && d.state !== 'on' && b.state === 'no-runtime' && <p className="text-muted">Het ingebouwde zoekmodel kan hier niet draaien. Zoeken op woorden werkt gewoon.</p>}
          {b && d.state !== 'on' && ['absent', 'error'].includes(b.state) && (
            <div className="space-y-2 rounded-lg border border-line p-3">
              <p>{t('Ingebouwd zoekmodel: ± {0} MB, één keer downloaden, daarna draait het op je eigen computer.', b.mb)}</p>
              {b.mayEnable ? (
                <Button size="sm" icon={<Download className="h-4 w-4" />} loading={busy} onClick={() => builtinAction('enable')}>
                  Slim zoeken aanzetten
                </Button>
              ) : (
                <p className="text-xs text-muted">Alleen de beheerder van deze server kan het zoekmodel downloaden.</p>
              )}
              {b.state === 'error' && <p className="text-xs text-danger">{t('Downloaden mislukt: {0}', b.error || '')}</p>}
              <p className="text-xs text-muted">{t('Model: {0} (licentie {1}). Elk bestand wordt gecontroleerd voordat het gebruikt wordt.', b.model, b.license)}</p>
            </div>
          )}
          {b?.state === 'downloading' && <Meter progress label="Zoekmodel downloaden" value={bpct} max={100} hint={`${bpct}%`} />}
          {b?.state === 'ready' && isBuiltin(d.model) && (
            <Button size="sm" variant="ghost" icon={<Trash2 className="h-3.5 w-3.5" />} loading={busy} onClick={() => builtinAction('remove')}>
              Ingebouwd zoekmodel verwijderen
            </Button>
          )}
          {/* Ollama: an extra, for who has it. */}
          {d.state === 'remote' && <p className="text-muted">Je Ollama draait niet op deze computer.</p>}
          {d.state === 'unreachable' && (
            <div className="space-y-1">
              <p className="text-warn">Ollama reageert niet. Start Ollama; tot dan zoekt TeamBot op woorden{b?.state === 'ready' ? ' en met het ingebouwde zoekmodel' : ''}.</p>
              <Button size="sm" variant="ghost" onClick={() => r.reload()}>
                Opnieuw controleren
              </Button>
            </div>
          )}
          {(d.state === 'no-model' || d.pull?.status === 'running' || d.pull?.status === 'error') && d.state !== 'on' && (
            <div className="space-y-2">
              <p className="text-muted">{t('Met Ollama kan TeamBot ook {0} downloaden (ongeveer 1,2 GB, eenmalig).', d.suggested || '')}</p>
              {d.pull?.status === 'running' ? (
                <Meter progress label={t('{0} downloaden', d.pull.model)} value={pct} max={100} hint={`${pct}%`} />
              ) : (
                <Button size="sm" variant="ghost" icon={<Download className="h-4 w-4" />} loading={busy} onClick={() => run(async () => (await api.post('/memory/semantic/pull', { model: d.suggested }), r.reload()))}>
                  {t('{0} downloaden', d.suggested)}
                </Button>
              )}
              {d.pull?.status === 'error' && <p className="text-xs text-danger">{t('Downloaden mislukt: {0}', d.pull.error || '')}</p>}
              <p className="text-xs text-muted">{t('Of in een terminal: {0}', `ollama pull ${d.suggested || ''}`)}</p>
            </div>
          )}
        </div>
      )}
      {!on && <p className="text-xs text-muted">Uit: TeamBot zoekt alleen op woorden (met eenvoudige Nederlandse en Engelse woordvormen en synoniemen).</p>}
    </Card>
  );
}
