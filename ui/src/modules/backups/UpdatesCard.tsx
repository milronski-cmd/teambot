import { RotateCcw, Sparkles } from 'lucide-react';
import { t } from '../../lib/i18n';
import { formatBytes, formatDateTime } from '../../lib/format';
import { askConfirm, Badge, Button, Card, toast, useAsync } from '../../components/ui';
import { desktopBridge, type UpdatesView } from './types';
import { AppUpdateSection } from './AppUpdate';

/**
 * Updates of TeamBot itself: which version runs, (with `live`) what happens with new versions and the setting
 * Automatisch bijwerken, the last update (with the backup made right before it), and in the Windows app "Terug naar
 * versie x" (reinstall the previous version and put that backup back).
 */
export function UpdatesCard({ v, onChanged, showNewsLink, live }: { v: UpdatesView; onChanged(): void; showNewsLink?: boolean; live?: boolean }) {
  const a = useAsync();
  const bridge = desktopBridge();
  const last = v.last && v.last.to === v.version ? v.last : null;
  const rb = v.rollback;
  const canClick = !!rb?.available && !!bridge?.update?.rollback;
  const goBack = async () => {
    if (!rb?.to) return;
    const ok = await askConfirm(
      t(
        'TeamBot installeert versie {0} opnieuw en zet de back-up van vlak voor de update terug. Wat je sindsdien veranderde, blijft als veiligheidskopie bewaard. TeamBot start daarna opnieuw.',
        rb.to,
      ),
      { ok: t('Terug naar versie {0}', rb.to), danger: true },
    );
    if (!ok) return;
    await a.run(async () => {
      await bridge!.update!.rollback!();
      toast(t('TeamBot gaat terug naar versie {0} en start zo opnieuw.', rb.to!), 'ok');
    });
    onChanged();
  };
  return (
    <Card className="space-y-3 p-5">
      <h2 className="text-[15px] font-bold tracking-tight">Updates van TeamBot</h2>
      <p className="text-sm">
        {t('Je gebruikt TeamBot {0}.', v.version)}{' '}
        {last?.kind === 'update' && <span className="text-muted">{t('Bijgewerkt van {0} op {1}.', last.from, formatDateTime(last.at))}</span>}
        {last?.kind === 'rollback' && <span className="text-muted">{t('Teruggezet van {0} op {1}.', last.from, formatDateTime(last.at))}</span>}
      </p>
      {live && <AppUpdateSection />}
      {last?.kind === 'update' && last.backup && <p className="text-sm text-muted">Vlak voor de update is een back-up gemaakt van je database en instellingen. Die staat bij je back-ups.</p>}
      {v.failed && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
          {v.failed.kind === 'update' ? t('De update naar versie {0} is niet geïnstalleerd; er is niets veranderd.', v.failed.to) : t('Terug naar versie {0} is niet gelukt. Je gegevens van vlak voor de update zijn wel teruggezet.', v.failed.to)}
        </p>
      )}
      <p className="text-xs text-muted">Vóór elke update maakt TeamBot een back-up, zodat je terug kunt.</p>
      <div className="flex flex-wrap gap-2">
        {showNewsLink && v.whatsNew.length > 0 && (
          <a href="#/m/backups/nieuw">
            <Button icon={<Sparkles className="h-4 w-4" />}>
              Wat is er nieuw
              {!v.seen && <Badge tone="accent" className="ms-1">nieuw</Badge>}
            </Button>
          </a>
        )}
        {rb?.to && last?.kind === 'update' && (
          <Button icon={<RotateCcw className="h-4 w-4" />} disabled={!canClick} loading={a.busy} onClick={goBack}>
            {t('Terug naar versie {0}', rb.to)}
          </Button>
        )}
      </div>
      {rb?.to && last?.kind === 'update' && !canClick && (
        <p className="text-sm text-muted">{rb.available ? 'Terug naar de vorige versie kan alleen in de TeamBot-app op deze computer.' : rb.reason}</p>
      )}
      {canClick && rb?.installer && <p className="text-xs text-muted">{t('Installatiebestand van versie {0} staat klaar ({1}).', rb.installer.version, formatBytes(rb.installer.size))}</p>}
    </Card>
  );
}
