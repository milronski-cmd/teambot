import { useEffect, useState } from 'react';
import { ScanText, Trash2 } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatBytes } from '../../lib/format';
import { askConfirm, Badge, Button, Card, CardHead, toastError, useAsync } from '../../components/ui';
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
 * It is always on: the language data (Dutch and English) comes by itself the first time a bot reads a scan
 * (server/modules/folders/ocr.ts `ensure`). The card says so, can fetch it now or again after a failed try, and can
 * remove it. Nothing else leaves the computer; the explanation is behind "Meer informatie".
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
    (await askConfirm('De taaldata voor scans verwijderen? Leest een bot later weer een scan, dan haalt TeamBot hem opnieuw op.', { ok: 'Verwijderen', danger: true })) &&
    api.del<OcrView>('/ocr').then((x) => setV({ ...x, mayDownload: v.mayDownload }), toastError);
  const off = v.state === 'absent' || v.state === 'error';
  return (
    <Card className="tb-in space-y-3 p-4">
      <CardHead
        icon={ScanText}
        tone="amber"
        title="Scans en foto’s lezen"
        hint={
          <>
            Je bots lezen ook een gescande pdf of een foto van een brief.{' '}
            <MoreInfo>
              {t('Dat heet tekstherkenning en gebeurt op deze computer; er gaat niets naar internet. Alleen de taaldata voor Nederlands en Engels ({0}) wordt eenmalig opgehaald, vanzelf zodra een bot voor het eerst een scan leest. TeamBot controleert elk bestand voordat het wordt gebruikt.', size)}
            </MoreInfo>
          </>
        }
        action={
          <>
            {v.state !== 'no-runtime' && <Badge tone="ok">Staat aan</Badge>}
            {v.state === 'ready' && v.mayDownload && <Menu label="Meer opties" items={[{ label: 'Taaldata verwijderen', icon: <Trash2 />, danger: true, onSelect: remove }]} />}
            {off && v.mayDownload && (
              <Button variant="secondary" loading={a.busy} onClick={download}>
                {v.state === 'error' ? 'Opnieuw proberen' : 'Nu ophalen'}
              </Button>
            )}
          </>
        }
      />
      {v.state === 'no-runtime' && <p className="text-[13px] text-warn">Dit kan niet in deze installatie. Installeer TeamBot opnieuw.</p>}
      {v.state === 'absent' && <p className="text-[13px] text-muted">{t('De taaldata ({0}) komt vanzelf bij de eerste scan.', size)}</p>}
      {v.state === 'error' && <p className="text-[13px] text-danger">{t('Ophalen is niet gelukt: {0}. Bij de volgende scan probeert TeamBot het opnieuw.', v.error || '')}</p>}
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
