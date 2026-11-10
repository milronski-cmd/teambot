import { useEffect, useState } from 'react';
import { ScanText, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatBytes } from '../../lib/format';
import { askConfirm, Badge, Button, Card, toastError, useAsync } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { Menu } from '../../components/overview';

/** Mirror of GET /api/ocr (server/modules/folders/ocr.ts). */
interface OcrView {
  state: 'absent' | 'downloading' | 'ready' | 'error' | 'no-runtime';
  langs: { id: string; label: string; bytes: number; present: boolean }[];
  bytes: number;
  done: number;
  error: string | null;
  mayDownload: boolean;
}

/**
 * Bestanden › "Scans en foto's lezen": text recognition (OCR) on this computer for scanned pdf's and photos of a page.
 * The language data (Dutch and English) is downloaded only when the owner clicks; nothing else leaves the computer.
 * One line with one button; the explanation is behind "Meer informatie".
 */
export function OcrCard() {
  const [v, setV] = useState<OcrView | null>(null);
  const a = useAsync();
  const load = () =>
    api
      .get<OcrView>('/ocr')
      .then(setV)
      .catch(() => setV(null));
  useEffect(() => {
    load();
  }, []);
  // While downloading: look again every second.
  useEffect(() => {
    if (v?.state !== 'downloading') return;
    const id = setInterval(load, 1000);
    return () => clearInterval(id);
  }, [v?.state]);
  if (!v) return null;
  const pct = v.bytes ? Math.min(100, Math.round((v.done / v.bytes) * 100)) : 0;
  const size = formatBytes(v.bytes);
  const download = () => a.run(async () => setV({ ...(await api.post<OcrView>('/ocr/download')), mayDownload: v.mayDownload }));
  const remove = async () =>
    (await askConfirm('De taaldata voor scans verwijderen? Bots kunnen dan geen scans meer lezen tot je hem opnieuw downloadt.', { ok: 'Verwijderen', danger: true })) &&
    api.del<OcrView>('/ocr').then((x) => setV({ ...x, mayDownload: v.mayDownload }), toastError);
  const off = v.state === 'absent' || v.state === 'error';
  return (
    <Card className="tb-in space-y-3 p-4">
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2 sm:items-center">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-muted" aria-hidden>
          <ScanText className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1 basis-56">
          <h2 className="text-sm font-semibold">Scans en foto’s lezen</h2>
          <p className="text-[13px] text-muted">
            Je bots lezen ook een gescande pdf of een foto van een brief.{' '}
            <MoreInfo>
              {t('Dat heet tekstherkenning en gebeurt op deze computer; er gaat niets naar internet. Er is eenmalig taaldata nodig voor Nederlands en Engels ({0}). TeamBot controleert elk bestand voordat het wordt gebruikt.', size)}
            </MoreInfo>
          </p>
        </div>
        {v.state === 'ready' && (
          <>
            <Badge tone="ok">Staat aan</Badge>
            {v.mayDownload && <Menu label="Meer opties" items={[{ label: 'Taaldata verwijderen', icon: <Trash2 />, danger: true, onSelect: remove }]} />}
          </>
        )}
        {off &&
          v.mayDownload && (
            <Button variant={v.state === 'error' ? 'secondary' : 'primary'} loading={a.busy} onClick={download}>
              {v.state === 'error' ? 'Opnieuw proberen' : t('Aanzetten ({0})', size)}
            </Button>
          )}
      </div>
      {v.state === 'no-runtime' && <p className="text-[13px] text-warn">Dit kan niet in deze installatie. Installeer TeamBot opnieuw.</p>}
      {v.state === 'error' && <p className="text-[13px] text-danger">{t('Downloaden is niet gelukt: {0}', v.error || '')}</p>}
      {off && !v.mayDownload && <p className="text-[13px] text-muted">Alleen de eigenaar of een beheerder kan dit aanzetten.</p>}
      {v.state === 'downloading' && (
        <div className="space-y-1" role="status">
          <div className="h-2 overflow-hidden rounded-full bg-surface-3">
            <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
          </div>
          <div className="text-xs text-muted">{t('Taaldata downloaden… {0}%', pct)}</div>
        </div>
      )}
    </Card>
  );
}
