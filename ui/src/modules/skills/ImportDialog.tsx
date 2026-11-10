import { useEffect, useState } from 'react';
import { ArrowLeft, FolderOpen, FolderSearch, Link2, Upload } from 'lucide-react';
import { Button, Field, Input, Modal, Tabs, Textarea, useAsync } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { api, request } from '../../lib/api';
import { useApp } from '../../lib/store';
import type { StagingView } from './api';
import { CandidatesReview } from './common';
import { TeamPlacePicker, useSkillPlace } from './TeamPlace';

type Tab = 'paste' | 'zip' | 'folder' | 'url' | 'local';

const MAX_UPLOAD = 25 * 1024 * 1024;

async function readAsBase64(f: File): Promise<string> {
  const buf = new Uint8Array(await f.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function ImportDialog({ open, onClose, initialTab = 'paste' }: { open: boolean; onClose(): void; initialTab?: Tab }) {
  const me = useApp((s) => s.me);
  const isOwner = me?.role === 'owner';
  const [tab, setTab] = useState<Tab>(initialTab);
  const [staging, setStaging] = useState<StagingView | null>(null);
  const [text, setText] = useState('');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [url, setUrl] = useState('');
  const [localPath, setLocalPath] = useState('');
  const [dirs, setDirs] = useState<{ tool: string; dir: string; exists: boolean }[] | null>(null);
  const [error, setError] = useState('');
  const [installed, setInstalled] = useState(false);
  const { busy, run } = useAsync();
  // Package B4: for which team (or all teams); the preview remembers it for the install.
  const place = useSkillPlace();
  const team = place.teamId ? { teamId: place.teamId } : {};

  useEffect(() => {
    if (!open) {
      setStaging(null);
      setError('');
    }
  }, [open]);
  // A new preview (another source) starts again with "nothing installed yet".
  useEffect(() => setInstalled(false), [staging]);
  useEffect(() => {
    if (open && tab === 'local' && isOwner && !dirs) api.get('/skills/discover/dirs').then(setDirs).catch(() => setDirs([]));
  }, [open, tab, isOwner, dirs]);

  const hasFrontmatter = /^\uFEFF?---\s*\r?\n/.test(text);

  const go = (fn: () => Promise<StagingView>) =>
    run(async () => {
      setError('');
      try {
        setStaging(await fn());
      } catch (e: any) {
        setError(e?.message || String(e));
      }
    });

  const onZip = (f: File | undefined) => {
    if (!f) return;
    if (f.size > MAX_UPLOAD) return setError('Het bestand is groter dan 25 MB.');
    go(() => request<StagingView>(`/skills/import/zip?name=${encodeURIComponent(f.name)}${place.teamId ? `&teamId=${encodeURIComponent(place.teamId)}` : ''}`, { method: 'POST', raw: f, headers: { 'content-type': 'application/zip' } }));
  };

  const onFolder = (list: FileList | null) => {
    if (!list?.length) return;
    const files = [...list];
    const total = files.reduce((n, f) => n + f.size, 0);
    if (total > MAX_UPLOAD) return setError('De map is groter dan 25 MB.');
    if (files.length > 1000) return setError('De map bevat te veel bestanden (meer dan 1000).');
    go(async () => {
      const payload = await Promise.all(files.map(async (f) => ({ path: (f as any).webkitRelativePath || f.name, base64: await readAsBase64(f) })));
      const label = String((files[0] as any).webkitRelativePath || '').split('/')[0] || 'map';
      return api.post<StagingView>('/skills/import/preview', { kind: 'files', files: payload, label, ...team });
    });
  };

  return (
    <Modal open={open} onClose={onClose} wide title={staging ? 'Controleren en installeren' : 'Skill importeren'}>
      {staging ? (
        <div className="space-y-4">
          <Button size="sm" variant="ghost" icon={<ArrowLeft className="h-4 w-4" />} onClick={() => setStaging(null)}>
            Andere bron kiezen
          </Button>
          {!installed && <p className="text-sm text-muted">Er is nog niets geïnstalleerd. Kies wat je wilt overnemen.</p>}
          <CandidatesReview staging={staging} onDone={() => setInstalled(true)} doneLabel="Klaar. Je vindt de skills onder Mijn skills." />
        </div>
      ) : (
        <div className="space-y-4">
          <p className="text-sm text-muted">
            Je ziet eerst wat erin zit, met een veiligheidsscan.{' '}
            <MoreInfo>
              Een skill is een map met een <code>SKILL.md</code>: een korte beschrijving plus instructies, eventueel met extra bestanden. Een skill van een ander is onbetrouwbare invoer; daarom installeert TeamBot niets voordat jij het hebt bekeken.
            </MoreInfo>
          </p>
          <TeamPlacePicker place={place} />
          <Tabs
            value={tab === 'folder' ? 'zip' : tab}
            onChange={(t) => (setTab(t), setError(''))}
            tabs={[
              { id: 'paste', label: 'Plakken' },
              { id: 'zip', label: 'Bestand of map' },
              { id: 'url', label: 'Link' },
              ...(isOwner ? [{ id: 'local' as Tab, label: 'Op deze computer' }] : []),
            ]}
          />
          {tab === 'paste' && (
            <div className="space-y-3">
              <Field label="Inhoud van SKILL.md" hint="Begint de tekst niet met --- (frontmatter), vul dan hieronder een naam en beschrijving in.">
                <Textarea rows={10} className="font-mono text-xs" value={text} onChange={(e) => setText(e.target.value)} placeholder={'---\nname: mijn-skill\ndescription: Wat de skill doet en wanneer de bot hem gebruikt.\n---\n\n# Werkwijze\n1. …'} />
              </Field>
              {text.trim() && !hasFrontmatter && (
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field label="Naam" hint="Kleine letters en streepjes">
                    <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="offerte-maken" />
                  </Field>
                  <Field label="Beschrijving" hint="Wanneer moet de bot deze skill gebruiken?">
                    <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Maakt een offerte op basis van…" />
                  </Field>
                </div>
              )}
              <div className="flex justify-end">
                <Button variant="primary" loading={busy} disabled={!text.trim()} onClick={() => go(() => api.post('/skills/import/preview', { kind: 'paste', text, name, description, ...team }))}>
                  Voorvertoning
                </Button>
              </div>
            </div>
          )}
          {(tab === 'zip' || tab === 'folder') && (
            <div className="tb-in space-y-2">
              <div className="grid gap-3 sm:grid-cols-2">
                <label className="flex cursor-pointer flex-col items-center gap-2 rounded-card border border-dashed border-line px-4 py-8 text-center text-sm font-medium hover:border-line-strong">
                  <Upload className="h-6 w-6 text-muted" />
                  <span>Zip-bestand kiezen</span>
                  <input type="file" accept=".zip,application/zip" className="sr-only" onChange={(e) => onZip(e.target.files?.[0])} disabled={busy} />
                </label>
                <label className="flex cursor-pointer flex-col items-center gap-2 rounded-card border border-dashed border-line px-4 py-8 text-center text-sm font-medium hover:border-line-strong">
                  <FolderOpen className="h-6 w-6 text-muted" />
                  <span>Map kiezen</span>
                  <input type="file" multiple className="sr-only" onChange={(e) => onFolder(e.target.files)} disabled={busy} {...({ webkitdirectory: '', directory: '' } as any)} />
                </label>
              </div>
              <p className="text-xs text-muted">
                Eén of meer skills, samen hooguit 25 MB.{' '}
                <MoreInfo>Een map met een SKILL.md, of meerdere mappen met elk een SKILL.md.</MoreInfo>
              </p>
            </div>
          )}
          {tab === 'url' && (
            <div className="space-y-3">
              <Field label="Adres" hint="Een GitHub-map, een link naar een SKILL.md of een .zip.">
                <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://github.com/…" inputMode="url" />
              </Field>
              <div className="flex justify-end">
                <Button variant="primary" icon={<Link2 className="h-4 w-4" />} loading={busy} disabled={!/^https?:\/\//i.test(url.trim())} onClick={() => go(() => api.post('/skills/import/preview', { kind: 'url', url: url.trim(), ...team }))}>
                  Ophalen en bekijken
                </Button>
              </div>
            </div>
          )}
          {tab === 'local' && isOwner && (
            <div className="space-y-4">
              <div className="space-y-2">
                <div className="text-sm font-medium">Skills van andere tools op deze computer</div>
                <div className="flex flex-wrap items-center gap-3">
                  <Button icon={<FolderSearch className="h-4 w-4" />} loading={busy} onClick={() => go(() => api.post('/skills/import/preview', { kind: 'discover', ...team }))}>
                    Zoeken
                  </Button>
                  <MoreInfo label="Waar wordt gezocht?">
                    Er wordt alleen gelezen; de originele mappen blijven ongewijzigd.
                    {dirs && (
                      <span className="mt-1 block space-y-0.5">
                        {dirs.map((d) => (
                          <span key={d.dir} className="block break-all">
                            {d.tool}: <code>{d.dir}</code> {d.exists ? '' : '(bestaat niet)'}
                          </span>
                        ))}
                      </span>
                    )}
                  </MoreInfo>
                </div>
              </div>
              <div className="space-y-2">
                <Field label="Of een map op deze computer" hint="Mappen met sleutels (.ssh, .aws) zijn geblokkeerd.">
                  <Input value={localPath} onChange={(e) => setLocalPath(e.target.value)} placeholder="C:\Users\…\mijn-skill" />
                </Field>
                <Button loading={busy} disabled={!localPath.trim()} onClick={() => go(() => api.post('/skills/import/preview', { kind: 'path', path: localPath.trim(), ...team }))}>
                  Map lezen
                </Button>
              </div>
            </div>
          )}
          {error && (
            <p role="alert" className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
              {error}
            </p>
          )}
        </div>
      )}
    </Modal>
  );
}
