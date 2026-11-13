import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Download, ExternalLink, FileQuestion, Maximize2, Minimize2 } from 'lucide-react';
import { Button, Modal, Spinner, Tabs, timeAgo } from './ui';
import { Markdown } from '../shell/Markdown';
import { fileUrl, getBytes } from '../lib/api';
import type { AttachmentRef } from '../lib/types';
import { langForFile, useHighlight } from '../lib/highlight';
import { formatBytes } from '../lib/format';

const PdfView = lazy(() => import('./PdfView'));

/** What a preview shows: pdf pages, a picture, a player, formatted text, plain text, or nothing (download only). */
export type PreviewKind = 'pdf' | 'image' | 'audio' | 'video' | 'markdown' | 'text' | 'binary';

const ext = (name: string) => (/\.[a-z0-9]+$/i.exec(name)?.[0] || '').toLowerCase();
const IMAGE = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.avif', '.bmp', '.svg', '.ico']);
const AUDIO = new Set(['.mp3', '.m4a', '.aac', '.wav', '.ogg', '.oga', '.opus', '.flac', '.weba']);
const VIDEO = new Set(['.mp4', '.m4v', '.webm', '.ogv', '.mov']);
const TEXT = new Set(['.txt', '.csv', '.tsv', '.json', '.log', '.xml', '.yaml', '.yml', '.ini', '.toml', '.html', '.htm', '.css', '.js', '.ts', '.tsx', '.jsx', '.py', '.sh', '.ps1', '.sql', '.vtt', '.srt']);

/** The kind of preview for a file by its name and (when known) its content type. */
export function previewKindOf(name: string, mime = ''): PreviewKind {
  const e = ext(name);
  const m = mime.toLowerCase();
  if (m === 'application/pdf' || e === '.pdf') return 'pdf';
  if (m.startsWith('image/') || IMAGE.has(e)) return 'image';
  if (VIDEO.has(e) || m.startsWith('video/')) return 'video';
  if (m.startsWith('audio/') || AUDIO.has(e)) return 'audio';
  if (e === '.md' || e === '.markdown' || m === 'text/markdown') return 'markdown';
  if (m.startsWith('text/') || m === 'application/json' || TEXT.has(e)) return 'text';
  return 'binary';
}

export interface PreviewSource {
  name: string;
  kind: PreviewKind;
  size?: number;
  mtime?: string;
  /** Signed URL of the file itself (`download`: always a download). */
  url(download?: boolean): string;
  /** The file's bytes with the token in the header (pdf pages, svg, text of an attachment). */
  bytes(): Promise<ArrayBuffer>;
  /** Text that is already there (folder preview); otherwise it is read from bytes(). */
  text?: string;
  truncated?: boolean;
  /** Whether the browser may show the file itself in a new tab ("Openen"); false = only download. */
  openable?: boolean;
  /** A reason the file can't be shown (e.g. a load error). */
  error?: string;
}

/** Content types the attachment route shows inline (everything else is always a download there). */
const ATTACHMENT_INLINE = /^(image\/(png|jpeg|gif|webp|avif)|audio\/(mpeg|mp4|wav|webm|ogg)|video\/(mp4|webm)|text\/plain)$/;

/** Preview source for a chat attachment. */
export function attachmentSource(a: AttachmentRef): PreviewSource {
  return {
    name: a.name,
    kind: previewKindOf(a.name, a.mime),
    size: a.size,
    url: (download) => fileUrl(a.id, !!download),
    bytes: () => getBytes(`/attachments/${a.id}`),
    openable: ATTACHMENT_INLINE.test((a.mime || '').toLowerCase()),
  };
}

/**
 * A chat attachment that opens the preview (pdf, text, markdown, video, …) when clicked; a file without a preview
 * (zip, docx, …) stays a plain download link.
 */
export function AttachmentLink({ a, className, children }: { a: AttachmentRef; className: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const source = useMemo(() => attachmentSource(a), [a.id, a.name, a.mime, a.size]);
  if (source.kind === 'binary')
    return (
      <a href={fileUrl(a.id, true)} className={className}>
        {children}
      </a>
    );
  return (
    <>
      <button type="button" className={className} aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {children}
      </button>
      {open && <FilePreviewModal source={source} onClose={() => setOpen(false)} />}
    </>
  );
}

const MAX_PDF = 60 * 1024 * 1024;
const MAX_TEXT = 256 * 1024;

/**
 * Preview of one file in a dialog: pdf pages (pdf.js), pictures, audio and video players, markdown or plain text, with
 * "Openen" (the browser shows the file itself in a new tab, as a script-less sandbox) and "Downloaden". Works the same
 * for a file in a bot's folder and for an attachment in a chat; on a phone it is a full-width sheet.
 */
export function FilePreviewModal({ source, onClose }: { source: PreviewSource | null; onClose(): void }) {
  const box = useRef<HTMLDivElement>(null);
  const [full, setFull] = useState(false);
  useEffect(() => {
    const f = () => setFull(!!document.fullscreenElement);
    document.addEventListener('fullscreenchange', f);
    return () => document.removeEventListener('fullscreenchange', f);
  }, []);
  if (!source) return null;
  const s = source;
  const canFull = typeof document !== 'undefined' && !!document.fullscreenEnabled && (s.kind === 'pdf' || s.kind === 'image' || s.kind === 'video');
  const openable = s.openable ?? (s.kind !== 'pdf' && s.kind !== 'binary' && ext(s.name) !== '.svg');
  const toggleFull = () => {
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    else void box.current?.requestFullscreen?.().catch(() => {});
  };
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title={
        <span className="block truncate" translate="no">
          {s.name}
        </span>
      }
      footer={
        <>
          {canFull && (
            <Button variant="ghost" icon={full ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />} onClick={toggleFull}>
              {full ? 'Klein' : 'Volledig scherm'}
            </Button>
          )}
          {openable && (
            <a href={s.url()} target="_blank" rel="noreferrer noopener" className="inline-flex h-9 items-center gap-2 rounded-control border border-line bg-surface px-4 text-sm font-semibold hover:bg-surface-3 coarse:h-11">
              <ExternalLink className="h-4 w-4" />
              Openen
            </a>
          )}
          <a href={s.url(true)} download={s.name} className="inline-flex h-9 items-center gap-2 rounded-control bg-accent px-4 text-sm font-semibold text-accent-fg hover:opacity-90 coarse:h-11">
            <Download className="h-4 w-4" />
            Downloaden
          </a>
        </>
      }
    >
      <div className="space-y-2">
        {(s.size != null || s.mtime) && (
          <p className="text-xs text-muted">
            {s.size != null ? formatBytes(s.size) : ''}
            {s.mtime ? ` · gewijzigd ${timeAgo(s.mtime)}` : ''}
          </p>
        )}
        <div ref={box} className={full ? 'flex h-full flex-col bg-canvas p-3' : ''}>
          {s.error ? (
            <p role="alert" className="text-sm text-danger">
              {s.error}
            </p>
          ) : (
            <PreviewBody s={s} full={full} />
          )}
        </div>
      </div>
    </Modal>
  );
}

function useBytes(s: PreviewSource, want: boolean, max: number) {
  const [st, setSt] = useState<{ data?: ArrayBuffer; error?: string }>({});
  useEffect(() => {
    if (!want) return;
    if (s.size != null && s.size > max) return setSt({ error: `Dit bestand is te groot voor een voorbeeld (${formatBytes(s.size)}). Download het om het te openen.` });
    let alive = true;
    setSt({});
    s.bytes().then(
      (data) => alive && setSt({ data }),
      (e) => alive && setSt({ error: e?.message || 'Het bestand kon niet geladen worden.' }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [s, want]);
  return st;
}

function NoPreview({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-2 py-8 text-center text-sm text-muted">
      <FileQuestion className="h-8 w-8" />
      <p>{children || 'Van dit soort bestand kan TeamBot geen voorbeeld tonen. Download het om het te openen.'}</p>
    </div>
  );
}

/** Plain text of a file; a code file (by its extension) gets syntax colours. */
function CodeText({ text, name }: { text: string; name: string }) {
  const lang = langForFile(name);
  const html = useHighlight(text, lang, { off: !lang });
  return (
    <pre tabIndex={0} className="scroll-thin max-h-[60vh] overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface-2 p-3 text-xs" translate="no" data-lang={html ? lang || undefined : undefined}>
      {html ? <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} /> : text}
    </pre>
  );
}

function PreviewBody({ s, full }: { s: PreviewSource; full: boolean }) {
  const svg = s.kind === 'image' && ext(s.name) === '.svg';
  const needText = (s.kind === 'text' || s.kind === 'markdown') && s.text == null;
  const bytes = useBytes(s, s.kind === 'pdf' || svg || needText, s.kind === 'pdf' ? MAX_PDF : svg ? 5 * 1024 * 1024 : Number.MAX_SAFE_INTEGER);
  const [view, setView] = useState<'nice' | 'plain'>('nice');
  const [svgUrl, setSvgUrl] = useState('');
  useEffect(() => {
    if (!svg || !bytes.data) return;
    // An svg is shown as a picture from a blob: inside <img> a script in it can never run.
    const u = URL.createObjectURL(new Blob([bytes.data], { type: 'image/svg+xml' }));
    setSvgUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [svg, bytes.data]);

  const loading = <div className="flex justify-center py-10"><Spinner /></div>;
  if (bytes.error) return <NoPreview>{bytes.error}</NoPreview>;

  switch (s.kind) {
    case 'pdf':
      if (!bytes.data) return loading;
      return (
        <div className={full ? 'h-full' : 'h-[min(70vh,900px)]'}>
          <Suspense fallback={loading}>
            <PdfView data={bytes.data} name={s.name} />
          </Suspense>
        </div>
      );
    case 'image':
      if (svg && !svgUrl) return loading;
      return <img src={svg ? svgUrl : s.url()} alt={s.name} className={full ? 'mx-auto h-full max-w-full object-contain' : 'mx-auto max-h-[65vh] max-w-full rounded-lg object-contain'} />;
    case 'audio':
      return <audio controls preload="metadata" src={s.url()} className="w-full" aria-label={s.name} />;
    case 'video':
      return <video controls playsInline preload="metadata" src={s.url()} className={full ? 'h-full w-full bg-black' : 'max-h-[65vh] w-full rounded-lg bg-black'} aria-label={s.name} />;
    case 'markdown':
    case 'text': {
      let text = s.text;
      let truncated = !!s.truncated;
      if (text == null) {
        if (!bytes.data) return loading;
        const buf = new Uint8Array(bytes.data);
        if (buf.subarray(0, 8000).includes(0)) return <NoPreview />;
        truncated = buf.length > MAX_TEXT;
        text = new TextDecoder().decode(buf.subarray(0, MAX_TEXT));
      }
      return (
        <div className="space-y-2">
          {s.kind === 'markdown' && (
            <Tabs
              tabs={[
                { id: 'nice', label: 'Opgemaakt' },
                { id: 'plain', label: 'Tekst' },
              ]}
              value={view}
              onChange={(v) => setView(v as 'nice' | 'plain')}
            />
          )}
          {truncated && <p className="text-xs text-muted">Alleen het begin wordt getoond. Download het bestand voor de rest.</p>}
          {s.kind === 'markdown' && view === 'nice' ? (
            <div className="scroll-thin max-h-[60vh] overflow-auto rounded-lg bg-surface-2 p-3 text-sm">
              <Markdown text={text} />
            </div>
          ) : (
            <CodeText text={text} name={s.name} />
          )}
        </div>
      );
    }
    default:
      return <NoPreview />;
  }
}
