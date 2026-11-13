import { useEffect, useRef, useState } from 'react';
import { formatBytes } from '../../lib/format';
import { Download, FileText, Trash2, Upload } from 'lucide-react';
import { api, authUrl, getBytes, getToken, on } from '../../lib/api';
import { askConfirm, Button, Card, EmptyState, Spinner, timeAgo, toast, toastError, useAsync } from '../../components/ui';
import { FilePreviewModal, previewKindOf, type PreviewSource } from '../../components/FilePreview';
import { MoreInfo } from '../../components/MoreInfo';
import { t } from '../../lib/i18n';

/**
 * Group files (A-60): one shared folder per group. People in the group add, open and remove files here; bots read
 * and write them with room_file_read / room_file_write (if their group permission allows it). Changes show live.
 */
interface RoomFile {
  path: string;
  size: number;
  modified: string;
}

const q = (p: string) => encodeURIComponent(p);

export function useRoomFiles(roomId: string) {
  const [files, setFiles] = useState<RoomFile[] | null>(null);
  const [err, setErr] = useState('');
  const load = () =>
    api
      .get<RoomFile[]>(`/rooms/${roomId}/files`)
      .then((f) => (setFiles(f), setErr('')))
      .catch((e) => setErr(e.message));
  useEffect(() => {
    load();
    return on('rooms.files', (d: { roomId: string }) => d?.roomId === roomId && load());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);
  return { files, err, load };
}

function source(roomId: string, f: RoomFile): PreviewSource {
  return {
    name: f.path.split('/').pop() || f.path,
    kind: previewKindOf(f.path),
    size: f.size,
    mtime: f.modified,
    url: (download) => authUrl(`/rooms/${roomId}/files/raw?path=${q(f.path)}${download ? '&download=1' : ''}`),
    bytes: () => getBytes(`/rooms/${roomId}/files/raw?path=${q(f.path)}`),
  };
}

/** The list with preview; `manage` adds upload and delete (group settings › Bestanden). */
export function RoomFiles({ roomId, manage }: { roomId: string; manage?: boolean }) {
  const { files, err, load } = useRoomFiles(roomId);
  const [open, setOpen] = useState<PreviewSource | null>(null);
  const { busy, run } = useAsync();
  const input = useRef<HTMLInputElement>(null);
  const upload = async (list: FileList) => {
    await run(async () => {
      for (const f of Array.from(list).slice(0, 20)) {
        const res = await fetch(`/api/rooms/${roomId}/files?path=${q(f.name)}`, { method: 'POST', headers: { authorization: `Bearer ${getToken()}`, 'content-type': 'application/octet-stream' }, body: f });
        if (!res.ok) throw new Error((await res.json().catch(() => ({})))?.error || `Uploaden mislukt (${res.status})`);
      }
      toast(list.length === 1 ? 'Bestand toegevoegd' : `${list.length} bestanden toegevoegd`, 'ok');
      load();
    });
  };
  const remove = async (f: RoomFile) => {
    if (!(await askConfirm(`${f.path} verwijderen uit de groepsmap? Bots en mensen in de groep kunnen het dan niet meer openen.`, { ok: 'Verwijderen', danger: true }))) return;
    api
      .del(`/rooms/${roomId}/files?path=${q(f.path)}`)
      .then(load)
      .catch(toastError);
  };
  return (
    <Card className="space-y-3 p-4">
      {manage && (
        <div className="flex flex-wrap items-center justify-between gap-2">
          <p className="min-w-0 flex-1 basis-56 text-[13px] text-muted">
            De gedeelde map van de groep. <MoreInfo>Een bot leest of schrijft hier als dat bij hem aan staat (tabblad Bots).</MoreInfo>
          </p>
          <input ref={input} type="file" multiple hidden onChange={(e) => e.target.files?.length && (upload(e.target.files), (e.target.value = ''))} aria-label="Bestanden kiezen" />
          <Button icon={<Upload className="h-4 w-4" />} loading={busy} onClick={() => input.current?.click()}>
            Bestand toevoegen
          </Button>
        </div>
      )}
      {err ? (
        <p role="alert" className="text-sm text-danger">
          {err}
        </p>
      ) : !files ? (
        <Spinner />
      ) : files.length === 0 ? (
        <EmptyState icon={<FileText />} title="Nog geen groepsbestanden">
          {manage ? 'Voeg een bestand toe, of laat een bot er een maken.' : 'Bestanden die de groep deelt, verschijnen hier.'}
        </EmptyState>
      ) : (
        <ul className="tb-in divide-y divide-line" aria-label="Groepsbestanden">
          {files.map((f) => (
            <li key={f.path} className="flex items-center gap-1">
              <button type="button" aria-haspopup="dialog" onClick={() => setOpen(source(roomId, f))} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-2 text-left text-sm hover:bg-surface-2 coarse:py-3">
                <FileText className="h-4 w-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]" translate="no">
                  {f.path}
                </span>
                <span className="hidden shrink-0 text-xs text-muted sm:inline">{formatBytes(f.size)}</span>
                <span className="shrink-0 text-xs text-muted">{timeAgo(f.modified)}</span>
              </button>
              <a href={authUrl(`/rooms/${roomId}/files/raw?path=${q(f.path)}&download=1`)} className="rounded-lg p-2 text-muted hover:bg-surface-2 hover:text-fg" aria-label={t('{0} downloaden', f.path)} title="Downloaden">
                <Download className="h-4 w-4" />
              </a>
              {manage && (
                <Button size="iconSm" variant="ghost" className="coarse:h-11 coarse:w-11" aria-label={t('{0} verwijderen', f.path)} onClick={() => remove(f)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      <FilePreviewModal source={open} onClose={() => setOpen(null)} />
    </Card>
  );
}
