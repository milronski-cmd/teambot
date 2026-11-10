import { useEffect, useRef, useState } from 'react';
import { ChevronRight, File, FileAudio, FileImage, FileText, FileVideo, Folder, FolderOpen, Lock, MessageSquare } from 'lucide-react';
import { query } from '../../lib/router';
import { t } from '../../lib/i18n';
import { Badge, Button, Card, EmptyState, Modal, Spinner, cx, timeAgo } from '../../components/ui';
import { FilePreviewModal, type PreviewSource, previewKindOf } from '../../components/FilePreview';
import { CopyPath } from '../../components/FolderName';
import { Skeleton } from '../../components/overview';
import { useApp } from '../../lib/store';
import { type FolderRoot, type Listing, foldersApi, formatSize } from './api';

function FileIcon({ name }: { name: string }) {
  const k = previewKindOf(name);
  const C = k === 'pdf' || k === 'markdown' || k === 'text' ? FileText : k === 'image' ? FileImage : k === 'audio' ? FileAudio : k === 'video' ? FileVideo : File;
  return <C className="h-4 w-4 shrink-0 text-muted" />;
}

export function ModeBadge({ mode }: { mode: 'rw' | 'ro' }) {
  return <Badge tone={mode === 'ro' ? 'neutral' : 'accent'}>{mode === 'ro' ? 'alleen lezen' : 'lezen en schrijven'}</Badge>;
}

/**
 * Read-only browser for one folder of a bot (agentId) or the team folder (agentId = null). `initialPath`/`initialOpen`
 * open a subfolder and preview a file right away (links from search: #/m/folders/<id>?root=0&path=a/b&open=c.md).
 */
function RowsSkeleton() {
  return (
    <div className="divide-y divide-line" role="status" aria-label="Laden">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="flex h-11 items-center gap-3 px-4">
          <Skeleton className="h-4 w-4 shrink-0" />
          <Skeleton className={cx('h-3.5', i % 2 ? 'w-1/3' : 'w-1/2')} />
        </div>
      ))}
    </div>
  );
}

export function FolderBrowser({ agentId, root, initialPath = '', initialOpen = '' }: { agentId: string | null; root: FolderRoot; initialPath?: string; initialOpen?: string }) {
  const bot = useApp((s) => (agentId && !agentId.startsWith('team') ? s.agents.find((a) => a.id === agentId) : null));
  const [path, setPath] = useState(initialPath);
  const [data, setData] = useState<Listing | null>(null);
  const [error, setError] = useState('');
  const [preview, setPreview] = useState<PreviewSource | null>(null);
  const [previewName, setPreviewName] = useState('');
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setPath('');
  }, [agentId, root.index, root.path]);
  useEffect(() => {
    let live = true;
    setData(null);
    setError('');
    foldersApi
      .browse(agentId, root.index, path)
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e?.message || String(e)));
    return () => {
      live = false;
    };
  }, [agentId, root.index, path]);

  const crumbs = path ? path.split('/') : [];
  const open = (name: string) => {
    const rel = [path, name].filter(Boolean).join('/');
    const entry = data?.entries.find((e) => e.name === name);
    const base = {
      name,
      size: entry?.size,
      mtime: entry?.mtime || undefined,
      url: (download?: boolean) => foldersApi.rawUrl(agentId, root.index, rel, !!download),
      bytes: () => foldersApi.rawBytes(agentId, root.index, rel),
    };
    const kind = previewKindOf(name);
    setPreviewName(name);
    // Pages, pictures and players load the file itself; for text the server first checks what it is.
    if (kind === 'pdf' || kind === 'image' || kind === 'audio' || kind === 'video') return setPreview({ ...base, kind });
    setPreview(null);
    foldersApi
      .file(agentId, root.index, rel)
      .then((p) => {
        const k = p.kind || (p.binary ? 'binary' : kind === 'markdown' ? 'markdown' : 'text');
        setPreview({ ...base, kind: k, size: p.size, mtime: p.mtime, text: k === 'text' || k === 'markdown' ? p.text : undefined, truncated: p.truncated });
      })
      .catch((e) => setPreview({ ...base, kind: 'binary', error: e?.message || String(e) }));
  };
  // A link that names a file: preview it once its folder has loaded.
  const opened = useRef(false);
  useEffect(() => {
    if (opened.current || !initialOpen || !data || data.path !== initialPath.replace(/^\/+|\/+$/g, '')) return;
    opened.current = true;
    open(initialOpen);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data]);

  return (
    <Card className="overflow-hidden">
      <div className="flex min-h-11 flex-wrap items-center gap-1 border-b border-line px-4 py-1.5 text-sm">
        <button type="button" className="font-semibold hover:underline" onClick={() => setPath('')}>
          {root.label}
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className="inline-flex items-center gap-1">
            <ChevronRight className="h-3.5 w-3.5 text-muted" />
            <button type="button" className="[overflow-wrap:anywhere] hover:underline" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>
              {c}
            </button>
          </span>
        ))}
        <span className="ms-auto flex items-center gap-1.5">
          {root.mode === 'ro' && <ModeBadge mode="ro" />}
          <CopyPath path={root.path} />
        </span>
      </div>
      {error ? (
        <p role="alert" className="px-4 py-3 text-sm text-danger">
          {error}
        </p>
      ) : !data ? (
        <RowsSkeleton />
      ) : data.missing ? (
        <EmptyState icon={<FolderOpen />} title="Deze map staat niet op deze computer">
          <span translate="no">{root.path}</span>
        </EmptyState>
      ) : data.entries.length === 0 ? (
        <EmptyState
          icon={<FolderOpen />}
          title="Deze map is nog leeg"
          action={
            bot && !path ? (
              <a href={`#/a/${bot.id}`} className="inline-flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-3.5 text-sm font-semibold hover:bg-surface-2 coarse:h-11">
                <MessageSquare className="h-4 w-4" aria-hidden /> {t('Chat met {0}', bot.name)}
              </a>
            ) : undefined
          }
        >
          {bot ? t('Wat {0} maakt of bewaart, komt hier te staan.', bot.name) : 'Wat je bots hier bewaren, komt hier te staan.'}
        </EmptyState>
      ) : (
        <ul className="tb-in divide-y divide-line">
          {data.entries.map((e) => (
            <li key={e.name}>
              <button
                type="button"
                disabled={e.locked}
                onClick={() => (e.dir ? setPath([path, e.name].filter(Boolean).join('/')) : open(e.name))}
                className={cx('flex min-h-11 w-full items-center gap-3 px-4 py-2 text-start text-sm hover:bg-surface-2', e.locked && 'cursor-not-allowed opacity-60')}
              >
                {e.locked ? <Lock className="h-4 w-4 shrink-0 text-muted" /> : e.dir ? <Folder className="h-4 w-4 shrink-0 text-accent" /> : <FileIcon name={e.name} />}
                <span className="min-w-0 flex-1 [overflow-wrap:anywhere]" translate="no">
                  {e.name}
                </span>
                <span className="hidden shrink-0 text-xs text-muted sm:inline">{e.dir ? '' : formatSize(e.size)}</span>
                <span className="w-14 shrink-0 text-end text-xs text-muted">{e.mtime ? timeAgo(e.mtime) : ''}</span>
              </button>
            </li>
          ))}
          {data.truncated && <li className="px-4 py-2 text-xs text-muted">{t('… en nog {0, plural, one {# item} other {# items}}', data.total - data.entries.length)}</li>}
        </ul>
      )}
      {previewName && !preview && (
        <Modal open onClose={() => setPreviewName('')} wide title={previewName}>
          <div className="flex justify-center py-8">
            <Spinner />
          </div>
        </Modal>
      )}
      <FilePreviewModal
        source={previewName ? preview : null}
        onClose={() => {
          setPreviewName('');
          setPreview(null);
        }}
      />
    </Card>
  );
}

/** Tabs over the folders of a bot (or just the team folder) with a browser underneath. Honours ?root=&path=&open=. */
export function RootsBrowser({ agentId }: { agentId: string | null }) {
  const [roots, setRoots] = useState<FolderRoot[] | null>(null);
  const [error, setError] = useState('');
  const [init] = useState(() => {
    const q = query();
    return { root: Math.max(0, Number(q.get('root')) || 0), path: q.get('path') || '', open: q.get('open') || '' };
  });
  const [idx, setIdx] = useState(init.root);
  const botName = useApp((s) => (agentId ? s.agents.find((a) => a.id === agentId)?.name : null));
  useEffect(() => {
    setRoots(null);
    setError('');
    foldersApi
      .roots(agentId)
      .then((r) => setRoots(r.roots))
      .catch((e) => setError(e?.message || String(e)));
  }, [agentId]);
  if (error) return <EmptyState icon={<FolderOpen />} title="De mappen konden niet laden">{error}</EmptyState>;
  if (!roots)
    return (
      <Card className="overflow-hidden">
        <div className="flex h-11 items-center border-b border-line px-4">
          <Skeleton className="h-3.5 w-24" />
        </div>
        <RowsSkeleton />
      </Card>
    );
  if (!roots.length) return <EmptyState icon={<FolderOpen />} title="Nog geen mappen" />;
  const cur = roots[Math.min(idx, roots.length - 1)];
  return (
    <div className="space-y-3">
      {roots.length > 1 && (
        <div className="flex flex-wrap gap-1.5" role="group" aria-label={botName ? t('Mappen van {0}', botName) : 'Mappen'}>
          {roots.map((r, i) => (
            <Button key={r.path} size="sm" className="rounded-full" variant={r === cur ? 'soft' : 'ghost'} aria-pressed={r === cur} onClick={() => setIdx(i)}>
              {r.kind === 'workspace' ? 'Werkmap' : r.label}
              {r.mode === 'ro' && <Lock className="h-3 w-3" />}
            </Button>
          ))}
        </div>
      )}
      {roots.indexOf(cur) === init.root ? <FolderBrowser key={cur.path} agentId={agentId} root={cur} initialPath={init.path} initialOpen={init.open} /> : <FolderBrowser key={cur.path} agentId={agentId} root={cur} />}
    </div>
  );
}
