import { memo, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Check, Copy, ImageIcon, Table2 } from 'lucide-react';
import { shouldDrawMermaid } from '../lib/mermaidBlock';
import { MermaidDiagram } from './MermaidDiagram';
import { useHighlight } from '../lib/highlight';
import { copyToClipboard } from '../lib/clipboard';
import { toast } from '../components/ui';
import { t } from '../lib/i18n';
import { copyGrid, gridOf } from './tableCopy';
import { prepareMath, useMath } from './math';

const cx = (...c: (string | false | undefined)[]) => c.filter(Boolean).join(' ');

/** Same-origin (our own files/previews) or inline data images load directly; everything else waits for a click. */
function isLocalSrc(src: string) {
  return (src.startsWith('/') && !src.startsWith('//')) || src.startsWith('data:image/') || src.startsWith('blob:');
}

/**
 * External images in markdown are not loaded automatically: a bot (or a prompt injection in a web page or file it
 * read) could otherwise leak data by putting it in an image URL that the browser fetches. One click loads it.
 */
function SafeImage({ src, alt }: { src?: string; alt?: string }) {
  const [show, setShow] = useState(false);
  if (!src) return null;
  if (show || isLocalSrc(src)) return <img src={src} alt={alt || ''} className="max-h-80 rounded-lg" loading="lazy" referrerPolicy="no-referrer" />;
  let host = '';
  try {
    host = new URL(src).host;
  } catch {
    return null;
  }
  if (!/^https?:/i.test(src)) return null;
  return (
    <button type="button" onClick={() => setShow(true)} className="my-1 inline-flex items-center gap-1.5 rounded-lg border border-line bg-surface px-2.5 py-1.5 text-xs text-muted hover:text-fg" title={src}>
      <ImageIcon className="h-3.5 w-3.5" />
      <span>Afbeelding laden</span>
      <span translate="no" className="font-mono">{host}</span>
      {alt ? <span translate="no" className="max-w-[12rem] truncate">· {alt}</span> : null}
    </button>
  );
}

function CodeBlock({ children, className }: { children?: React.ReactNode; className?: string }) {
  const [copied, setCopied] = useState(false);
  const text = String(children ?? '').replace(/\n$/, '');
  const lang = /language-([\w+#-]+)/.exec(className || '')?.[1];
  // Colours once the (lazy) highlighter is there; a block without a tag is detected among the usual languages.
  const html = useHighlight(text, lang, { auto: true });
  return (
    <div className="group relative">
      <div className="absolute end-2 top-2 flex items-center gap-2 opacity-0 transition group-hover:opacity-100 focus-within:opacity-100">
        {lang && <span className="text-[11px] text-muted">{lang}</span>}
        <button
          type="button"
          aria-label="Code kopiëren"
          className="rounded-md border border-line bg-surface p-1 text-muted hover:text-fg"
          onClick={() => {
            void copyToClipboard(text).then((ok) => {
              if (!ok) return toast('Kopiëren lukte niet — selecteer de tekst handmatig', 'danger');
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" /> : <Copy className="h-3.5 w-3.5" />}
        </button>
      </div>
      {/* Focusable: a long line scrolls sideways, and the keyboard must be able to scroll it too. */}
      <pre translate="no" tabIndex={0}>{html ? <code className={cx('hljs', className)} dangerouslySetInnerHTML={{ __html: html }} /> : <code className={className}>{text}</code>}</pre>
    </div>
  );
}

/**
 * A table in an answer with "Kopieer tabel" under it (parity 4.6): CSV plus an HTML table on the clipboard, so it pastes
 * into Excel or Google Sheets as cells (shell/tableCopy.ts). Always in view (also on a touch screen, where nothing hovers),
 * small and muted. Texts go through t(): the page translator skips everything inside .md.
 */
function CopyableTable({ children }: { children?: React.ReactNode }) {
  const ref = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState(false);
  return (
    <div className="md-table">
      <table ref={ref}>{children}</table>
      <div className="mt-1 flex justify-end">
        <button
          type="button"
          data-testid="table-copy"
          title={t('Kopieer de tabel als CSV; plakken in Excel of Google Sheets geeft gewone cellen')}
          className="inline-flex items-center gap-1 rounded-md border border-line bg-surface px-1.5 py-0.5 text-[11.5px] text-muted hover:text-fg coarse:min-h-11 coarse:px-3 coarse:text-[13px]"
          onClick={() => {
            const table = ref.current;
            if (!table) return;
            void copyGrid(gridOf(table)).then((ok) => {
              if (!ok) return toast('Kopiëren lukte niet — selecteer de tekst handmatig', 'danger');
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            });
          }}
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden /> : <Table2 className="h-3.5 w-3.5" aria-hidden />}
          <span aria-live="polite">{copied ? t('Tabel gekopieerd') : t('Kopieer tabel')}</span>
        </button>
      </div>
    </div>
  );
}

/**
 * Safe markdown: no raw HTML (react-markdown escapes it by default); links open in a new tab without referrer. Formulas
 * ($…$, $$…$$, \(…\), \[…\] and ```math) are drawn with KaTeX once it has loaded (shell/math.ts).
 */
export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const math = useMath(text);
  const source = math ? prepareMath(text) : text;
  return (
    <div className={'md ' + (className || '')}>
      <ReactMarkdown
        remarkPlugins={math ? [remarkGfm, ...math.remark] : [remarkGfm]}
        rehypePlugins={math?.rehype}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noreferrer noopener">
              {children}
            </a>
          ),
          pre: ({ children }) => <>{children}</>,
          code: ({ className, children, node, ...p }) => {
            const inline = !String(children ?? '').includes('\n') && !className;
            if (inline) return <code {...p}>{children}</code>;
            const block = <CodeBlock className={className}>{children}</CodeBlock>;
            const code = String(children ?? '').replace(/\n$/, '');
            // A block that runs to the end of the text may still be streaming (unclosed fence): drawn once it is closed.
            const end = node?.position?.end?.offset;
            const isLastBlock = typeof end !== 'number' || end >= source.replace(/\s+$/, '').length;
            return shouldDrawMermaid({ className, code, markdown: source, isLastBlock }) ? <MermaidDiagram code={code} fallback={block} /> : block;
          },
          img: ({ src, alt }) => <SafeImage src={typeof src === 'string' ? src : undefined} alt={alt} />,
          table: ({ children }) => <CopyableTable>{children}</CopyableTable>,
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
});
