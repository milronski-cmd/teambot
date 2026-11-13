import { useState } from 'react';
import { HardDriveDownload, KeyRound, RotateCcw } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatBytes, formatDateTime } from '../../lib/format';
import { askConfirm, Button, Card, CardHead, Field, Input, Modal, Toggle, toast, toastError, useAsync } from '../../components/ui';
import type { BackupItem, OffsiteView } from './types';
import { MoreInfo } from '../../components/MoreInfo';
import { MoreOptions } from '../../components/MoreOptions';

/**
 * Back-ups › "Kopie op een tweede plek": an encrypted copy of every backup in a folder elsewhere (a USB drive, a NAS,
 * another disk), with a password the owner picks (server/modules/backups/offsite.ts). From a copy TeamBot can take a
 * backup back and restore it with the normal restore.
 * Calm: not set up yet, the card is its head with "Instellen"; set up, it shows the last copy, "Nu een kopie maken",
 * the switch and the copies, with the folder, the password and "Stoppen" behind "Meer opties".
 */
export function OffsiteCard({ v, onChanged, onRestore }: { v: OffsiteView; onChanged(v?: OffsiteView): void; onRestore(b: BackupItem): void }) {
  const [folder, setFolder] = useState(v.folder);
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [changePw, setChangePw] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const [openPw, setOpenPw] = useState('');
  const a = useAsync();
  const set = !!v.folder && v.hasPassword;
  // Not set up: the form opens with "Instellen" (at once when a folder was saved without a password).
  const [setup, setSetup] = useState(!!v.folder && !v.hasPassword);
  const askPw = !v.hasPassword || changePw;
  const pwProblem = askPw && pw ? (pw.length < 12 ? 'Minstens 12 tekens.' : pw2 && pw !== pw2 ? 'De twee wachtwoorden zijn niet gelijk.' : '') : '';
  const canSave = folder.trim() && (!askPw || (pw.length >= 12 && pw === pw2)) && (folder.trim() !== v.folder || (askPw && pw));

  const save = () =>
    a.run(async () => {
      const r = await api.put<OffsiteView>('/backups/offsite', { folder: folder.trim(), ...(askPw ? { password: pw } : {}) });
      setPw('');
      setPw2('');
      setChangePw(false);
      toast('Tweede plek opgeslagen', 'ok');
      onChanged(r);
    });

  const importAndRestore = (file: string) =>
    a.run(async () => {
      const r = await api.post<{ backup: BackupItem }>('/backups/offsite/import', { file, password: openPw });
      setOpen(null);
      setOpenPw('');
      onChanged();
      onRestore(r.backup);
    });

  const form = (
    <>
      <Field label="Map voor de kopieën" hint="Het volledige pad, bijvoorbeeld E:\Back-ups. TeamBot maakt daarin de map TeamBot-backups.">
        <Input value={folder} onChange={(e) => setFolder(e.target.value)} placeholder="E:\Back-ups" spellCheck={false} />
      </Field>
      {askPw ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Wachtwoord (minstens 12 tekens)">
            <Input type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          </Field>
          <Field label="Herhaal het wachtwoord">
            <Input type="password" autoComplete="new-password" value={pw2} onChange={(e) => setPw2(e.target.value)} />
          </Field>
          <p className="text-xs text-muted sm:col-span-2">Bewaar dit wachtwoord goed: zonder kan de kopie niet worden geopend.</p>
          {pwProblem && (
            <p className="text-xs text-danger sm:col-span-2" role="alert">
              {pwProblem}
            </p>
          )}
        </div>
      ) : (
        <Button size="sm" variant="ghost" icon={<KeyRound className="h-3.5 w-3.5" />} onClick={() => setChangePw(true)}>
          Wachtwoord wijzigen
        </Button>
      )}
      <div className="flex flex-wrap items-center gap-3">
        <Button variant="primary" disabled={!canSave} loading={a.busy} onClick={save}>
          Opslaan
        </Button>
        {v.folder && (
          <Button
            size="sm"
            variant="ghost"
            onClick={async () =>
              (await askConfirm('Stoppen met kopiëren? De bestaande kopieën blijven staan; TeamBot vergeet het wachtwoord.', { ok: 'Stoppen' })) &&
              api.del<OffsiteView>('/backups/offsite').then((r) => (setFolder(''), onChanged(r)), toastError)
            }
          >
            Stoppen
          </Button>
        )}
      </div>
    </>
  );

  return (
    <Card className="space-y-4 p-5" aria-labelledby="offsite-title">
      <CardHead
        id="offsite-title"
        icon={HardDriveDownload}
        tone="amber"
        title="Kopie op een tweede plek"
        hint={
          <>
            Een versleutelde kopie op een USB-schijf, een NAS of een andere schijf.{' '}
            <MoreInfo>Een versleutelde kopie van je back-ups op een tweede plek, voor als de schijf kapot gaat.</MoreInfo>
          </>
        }
        action={!set && !setup ? <Button className="max-sm:w-full max-sm:justify-center" onClick={() => setSetup(true)}>Instellen</Button> : undefined}
      />
      {!set && setup && form}
      {set && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            loading={a.busy}
            onClick={() =>
              a.run(async () => {
                const r = await api.post<{ file: string; view: OffsiteView }>('/backups/offsite/copy', {});
                toast('Versleutelde kopie gemaakt', 'ok');
                onChanged(r.view);
              })
            }
          >
            Nu een kopie maken
          </Button>
        </div>
      )}
      {set && <Toggle checked={v.auto} onChange={(auto) => api.put<OffsiteView>('/backups/offsite', { auto }).then((r) => onChanged(r), toastError)} label="Na elke back-up ook een versleutelde kopie maken" />}
      {v.folder && !v.reachable && (
        <p className="text-sm text-warn" role="status">
          {t('De map {0} is nu niet bereikbaar. Is de schijf aangesloten?', v.folder)}
        </p>
      )}
      {v.lastError && <p className="text-sm text-danger">{t('Laatste kopie mislukt: {0}', v.lastError.message)}</p>}
      {v.lastCopy && !v.lastError && <p className="text-sm text-ok">{t('Laatste kopie: {0} ({1}).', formatDateTime(v.lastCopy.at), formatBytes(v.lastCopy.bytes))}</p>}
      {v.files.length > 0 && (
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">Kopieën op de tweede plek</h3>
          <ul className="divide-y divide-line">
            {v.files.map((f) => (
              <li key={f.file} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2 text-sm">
                <span className="min-w-0 flex-1 basis-56">
                  <span className="block font-medium">{f.createdAt ? formatDateTime(f.createdAt) : f.file}</span>
                  <span className="block text-xs text-muted">
                    {formatBytes(f.bytes)}
                    {f.version ? ` · TeamBot ${f.version}` : ''}
                  </span>
                </span>
                <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} onClick={() => (setOpen(f.file), setOpenPw(''))}>
                  Terugzetten
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
      {set && <MoreOptions>{form}</MoreOptions>}
      <Modal
        open={!!open}
        onClose={() => setOpen(null)}
        title="Kopie openen"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(null)}>
              Annuleren
            </Button>
            <Button variant="primary" disabled={!openPw} loading={a.busy} onClick={() => open && importAndRestore(open)}>
              Openen
            </Button>
          </>
        }
      >
        <div className="space-y-3">
          <p className="text-sm">Typ het wachtwoord van de kopie. TeamBot zet de back-up dan bij je back-ups op deze computer en vraagt daarna of je hem wilt terugzetten.</p>
          <Field label="Wachtwoord van de kopie">
            <Input type="password" autoComplete="current-password" value={openPw} onChange={(e) => setOpenPw(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && openPw && open && importAndRestore(open)} />
          </Field>
          <p className="text-xs text-muted">Op een andere computer werken opgeslagen sleutels en wachtwoorden van je bots niet meer: die voer je daar opnieuw in.</p>
        </div>
      </Modal>
    </Card>
  );
}
