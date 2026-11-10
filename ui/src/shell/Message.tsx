import { memo, useEffect, useState } from 'react';
import {
  AlertTriangle, RotateCcw, AppWindow, Brain, Check, Circle, GitBranch, ChevronDown, ChevronRight, CircleSlash, Copy, CornerUpLeft, FileText, Gauge, Info, Link as LinkIcon, ListChecks, Loader2, MoreHorizontal, Pencil, Pin, Smile, Trash2, Wrench, X,
} from 'lucide-react';
import { api, fileUrl } from '../lib/api';
import { agentById, useApp } from '../lib/store';
import type { AttachmentRef, Message, PlanStep, ToolCall } from '../lib/types';
import { planProgress } from '../lib/plan';
import { uiModules } from '../modules';
import { Avatar, Badge, Button, Modal, Textarea, cx, toast, toastError } from '../components/ui';
import { MenuSeparator, Pop, menuKeys, menuRow, menuRowDanger } from '../components/Menu';
import { copyToClipboard } from '../lib/clipboard';
import { BotAvatar } from '../components/BotFace';
import { AttachmentLink } from '../components/FilePreview';
import { Markdown } from './Markdown';
import { argsPreview, plainStep, resultForDisplay, toolLabel } from './toolLabels';
import { toolStepStatus } from './toolStatus';
import { stepDetail, stripRefs } from '../lib/preview';
import { routineInputView } from './routineInput';
import { uiLocale } from '../lib/i18n';
import { formatBytes } from '../lib/format';
import { messageCostText } from '../lib/costLabel';
import { prettyModel } from '../lib/modelLabel';
import { attachmentNotice } from './attachmentNotice';
import { DiffLegend, DiffView } from './DiffView';
import { openPage, SandboxedPage } from './PagePanel';
import { useIsDesktop } from '../lib/media';
import { useAdvanced } from './advanced';

const REACTIONS = ['👍', '❤️', '😂', '🎉', '👀', '🙏'];

/**
 * The bot's engine hit its limit and no reserve took over: switch with one click to a free alternative the server
 * found (a local model, the owner's own subscription). It answers the last message right away and stays the reserve.
 */
function SwitchOffer({ m }: { m: Message }) {
  const [busy, setBusy] = useState('');
  const alts = (m.parts.switchTo as { provider_id: string; model: string; label: string; kind: string }[]).slice(0, 3);
  const go = async (a: (typeof alts)[number]) => {
    setBusy(a.provider_id + a.model);
    try {
      await api.post(`/threads/${m.thread_id}/switch-engine`, { agentId: m.author_id, providerId: a.provider_id, model: a.model });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy('');
    }
  };
  return (
    <div className="space-y-1.5 px-1" data-testid="switch-offer">
      <div className="flex flex-wrap gap-2">
        {alts.map((a) => (
          <Button key={a.provider_id + a.model} size="sm" variant={a === alts[0] ? 'primary' : 'secondary'} loading={busy === a.provider_id + a.model} disabled={!!busy} onClick={() => go(a)}>
            Verder met {a.label}
          </Button>
        ))}
      </div>
      <p className="text-[11px] text-muted">{alts[0].kind === 'local' ? 'Gratis op deze computer, zonder daglimiet. ' : ''}De bot beantwoordt je laatste bericht meteen opnieuw en houdt dit als reserve-engine.</p>
    </div>
  );
}

function fmtTime(iso: string) {
  return new Date(iso).toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });
}

const fmtSize = (n: number) => formatBytes(n);

/**
 * Interactive HTML preview (show_html, an HTML file in the chat). Same sandbox as the page panel (SandboxedPage): a
 * short-lived signed URL whose own CSP makes it an opaque, network-less page (no access to TeamBot, the token or
 * storage), in an iframe without allow-same-origin. "Naast de chat" opens it as a tab in the page panel.
 */
function HtmlPreview({ a, threadId }: { a: AttachmentRef; threadId?: string }) {
  const [open, setOpen] = useState(true);
  const desktop = useIsDesktop();
  return (
    <div className="w-full max-w-2xl overflow-hidden rounded-2xl border border-line bg-surface">
      <div className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs">
        <FileText className="h-3.5 w-3.5 shrink-0 text-muted" />
        <span className="min-w-0 flex-1 truncate font-semibold" translate="no">
          {a.name}
        </span>
        <span className="hidden text-muted sm:inline">afgeschermd · geen netwerk</span>
        {threadId && (
          <button className="inline-flex items-center gap-1 font-semibold underline coarse:min-h-11" onClick={() => openPage(threadId, { id: a.id, name: a.name })} title="Als tabblad openen in een paneel naast het gesprek">
            <AppWindow className="h-3.5 w-3.5" aria-hidden />
            {desktop ? 'Naast de chat' : 'Groot openen'}
          </button>
        )}
        <button className="font-semibold underline coarse:min-h-11" onClick={() => setOpen(!open)}>
          {open ? 'Verbergen' : 'Tonen'}
        </button>
        <a className="font-semibold underline" href={fileUrl(a.id, true)}>
          Download
        </a>
      </div>
      {open && <SandboxedPage id={a.id} name={a.name} threadId={threadId} className="h-[420px] w-full" />}
    </div>
  );
}

interface LinkInfo {
  url: string;
  title: string;
  description: string;
  image: string;
  site: string;
  error?: string;
}
const previewCache = new Map<string, Promise<LinkInfo>>();

function firstUrls(text: string, max = 2): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/https?:\/\/[^\s)<>\]"'`]+/g)) {
    const u = m[0].replace(/[.,;:!?]+$/, '');
    if (!out.includes(u)) out.push(u);
    if (out.length >= max) break;
  }
  return out;
}

/** Link preview card (title, description, site, image) fetched via the server; hidden when nothing useful comes back. */
function LinkPreview({ url }: { url: string }) {
  const [d, setD] = useState<LinkInfo | null>(null);
  useEffect(() => {
    let p = previewCache.get(url);
    if (!p) {
      p = api.get<LinkInfo>(`/link-preview?url=${encodeURIComponent(url)}`).catch(() => ({ url, title: '', description: '', image: '', site: '', error: 'x' }));
      previewCache.set(url, p);
    }
    let alive = true;
    p.then((x) => alive && setD(x));
    return () => {
      alive = false;
    };
  }, [url]);
  if (!d || d.error || (!d.title && !d.description)) return null;
  return (
    <a href={url} target="_blank" rel="noreferrer noopener" className="mt-2 flex max-w-md overflow-hidden rounded-2xl border border-line bg-surface text-start hover:bg-surface-2">
      <div className="min-w-0 flex-1 p-3">
        <div className="truncate text-[11px] text-muted">{d.site}</div>
        <div className="line-clamp-2 text-sm font-semibold text-fg">{d.title}</div>
        {d.description && <div className="mt-0.5 line-clamp-2 text-xs text-muted">{d.description}</div>}
      </div>
      {d.image && <img src={d.image} alt="" loading="lazy" referrerPolicy="no-referrer" className="h-auto w-24 shrink-0 object-cover" onError={(e) => (e.currentTarget.style.display = 'none')} />}
    </a>
  );
}

/**
 * Link previews, only after a click — also for your own messages: the server never fetches a URL from a message by
 * itself (no surprise requests to sites, no leak of what you are reading, no fetch of URLs a prompt injection chose).
 * `auto` stays for callers that really want an immediate preview.
 */
export function LinkPreviews({ text, auto = false }: { text: string; auto?: boolean }) {
  const urls = firstUrls(text);
  const [open, setOpen] = useState(false);
  if (!urls.length) return null;
  if (!auto && !open)
    return (
      <button
        type="button"
        onClick={() => setOpen(true)}
        title="TeamBot haalt de pagina pas op als je hierop klikt"
        className="mt-1 inline-flex min-h-6 items-center gap-1 text-[12px] text-muted hover:text-fg coarse:min-h-11"
      >
        <LinkIcon className="h-3 w-3" /> {urls.length === 1 ? 'Linkvoorbeeld tonen' : 'Linkvoorbeelden tonen'}
      </button>
    );
  return (
    <>
      {urls.map((u) => (
        <LinkPreview key={u} url={u} />
      ))}
    </>
  );
}

export function Attachments({ list, voice, notices, threadId }: { list: AttachmentRef[]; voice?: boolean; /** Explain what TeamBot cannot show or give to the bot (the owner's own uploads). */ notices?: boolean; /** The conversation: pages can then open next to the chat and be quoted. */ threadId?: string }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {list.map((a) =>
        a.mime === 'text/html' ? (
          <HtmlPreview key={a.id} a={a} threadId={threadId} />
        ) : a.mime.startsWith('image/') ? (
          <a key={a.id} href={fileUrl(a.id)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-2xl border border-line">
            <img src={fileUrl(a.id)} alt={a.name} className="max-h-60 max-w-[260px] object-cover" loading="lazy" />
          </a>
        ) : a.mime.startsWith('audio/') ? (
          <div key={a.id} className="space-y-1">
            <audio controls src={fileUrl(a.id)} className="h-9 max-w-[280px]" aria-label={a.name} />
            {notices && <AttachmentWarning a={a} voice={voice} />}
          </div>
        ) : (
          <div key={a.id} className="max-w-[320px] space-y-1">
            <AttachmentLink a={a} className="flex items-center gap-2.5 rounded-xl border border-line bg-surface px-3 py-2 text-left text-sm hover:bg-surface-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-surface-3">
                <FileText className="h-4 w-4 text-muted" />
              </span>
              <span className="min-w-0">
                <span className="block max-w-[200px] truncate font-semibold">{a.name}</span>
                <span className="block text-xs text-muted">{fmtSize(a.size)}</span>
              </span>
            </AttachmentLink>
            {notices && <AttachmentWarning a={a} voice={voice} />}
          </div>
        ),
      )}
    </div>
  );
}

/** One line under an attachment that TeamBot cannot show or give to the bot as content (zip, video, …). */
function AttachmentWarning({ a, voice }: { a: AttachmentRef; voice?: boolean }) {
  const n = attachmentNotice(a, { voice });
  if (!n) return null;
  return (
    <p className="flex items-start gap-1.5 rounded-lg bg-warn-soft px-2 py-1.5 text-[11.5px] leading-snug text-warn">
      <AlertTriangle className="mt-px h-3 w-3 shrink-0" aria-hidden />
      <span>
        <span className="font-semibold">{n.kind}: </span>
        {n.text}
      </span>
    </p>
  );
}

/** Earlier versions of an edited message (newest first), each compared with the version after it. */
function VersionsModal({ m, open, onClose }: { m: Message; open: boolean; onClose(): void }) {
  const versions: { content: string; at: string }[] = Array.isArray(m.parts?.versions) ? m.parts.versions : [];
  // Oldest → newest, then the current text last; shown newest first.
  const chain = [...versions, { content: m.content, at: m.edited_at || m.created_at }];
  const rows = chain.map((v, i) => ({ ...v, i, prev: i > 0 ? chain[i - 1].content : null })).reverse();
  return (
    <Modal open={open} onClose={onClose} title="Eerdere versies van dit bericht" wide>
      <div className="space-y-3 text-sm">
        {versions.length === 0 ? (
          <p className="text-muted">Dit bericht is bewerkt voordat TeamBot versies bewaarde; de vorige tekst is niet meer beschikbaar.</p>
        ) : (
          <>
            <p className="text-xs text-muted">De bot werkt met de nieuwste versie. Eerdere versies blijven zichtbaar.</p>
            <ol className="space-y-3">
              {rows.map((v) => (
                <li key={v.i} className="rounded-xl border border-line p-3">
                  <div className="mb-1.5 flex flex-wrap items-center gap-2 text-xs text-muted">
                    <span className="font-semibold text-fg">{v.i === chain.length - 1 ? 'Nu' : v.i === 0 ? 'Origineel' : `Versie ${v.i + 1}`}</span>
                    <span>{new Date(v.at).toLocaleString(uiLocale(), { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</span>
                  </div>
                  {v.prev === null ? <div className="whitespace-pre-wrap break-words">{v.content}</div> : <DiffView before={v.prev} after={v.content} label={`Wijziging in versie ${v.i + 1}`} />}
                </li>
              ))}
            </ol>
            <DiffLegend />
          </>
        )}
      </div>
    </Modal>
  );
}

function findToolRenderer(name: string) {
  for (const m of uiModules) {
    const r = m.toolRenderers;
    if (!r) continue;
    if (r[name]) return r[name];
    for (const [k, c] of Object.entries(r)) if (k.endsWith('*') && name.startsWith(k.slice(0, -1))) return c;
  }
  return null;
}

const statusIcon = (s?: ToolCall['status'], isError?: boolean) => {
  if (isError || s === 'error') return <X className="h-3.5 w-3.5 text-danger" />;
  if (s === 'denied') return <CircleSlash className="h-3.5 w-3.5 text-danger" />;
  if (s === 'running' || s === 'pending') return <Loader2 className="h-3.5 w-3.5 animate-spin text-ok" />;
  if (s === 'waiting') return <span className="tb-pulse h-2 w-2 rounded-full bg-warn" />;
  return <Check className="h-3.5 w-3.5 text-ok" strokeWidth={2.5} />;
};

/** Tools whose whole point is a file for the owner: every attachment of theirs is shown at once. */
const SHOWN_TOOLS = new Set(['share_file', 'generate_image']);

/** A tool call as a compact chip ("Zocht op internet · elektrische auto's"); click for the exact input and result. */
export function ToolCard({ call, result, message }: { call: ToolCall; result?: Message; message: Message }) {
  const [open, setOpen] = useState(false);
  // The technical tool name (e.g. "fs_write") only with "Geavanceerd tonen"; the label above says it in words.
  const advanced = useAdvanced();
  const Custom = findToolRenderer(call.name);
  const isError = result?.parts.toolResult?.isError;
  const status = toolStepStatus(call, result ? { isError: !!isError } : null);
  const running = !result && (status === 'running' || status === 'pending' || (message.status === 'streaming' && !status));
  // What the bot made for you shows right under the step, not folded away inside it: a page, a picture, and whatever
  // it hands over with share_file or generate_image. A step with its own view (the browser's screenshots) keeps its own.
  const made = (x: { mime?: string }) => x.mime === 'text/html' || (!Custom && (SHOWN_TOOLS.has(call.name) || !!x.mime?.startsWith('image/')));
  const shown = (result?.parts.attachments || []).filter(made);
  const folded = (result?.parts.attachments || []).filter((x) => !made(x));
  const detail = call.summary || argsPreview(call.args);
  const label = status === 'waiting' ? 'Wacht op jouw akkoord' : status === 'denied' ? 'Niet toegestaan' : toolLabel(call, running);
  return (
    <div className="max-w-full">
      <button
        className={cx(
          'inline-flex max-w-full items-center gap-2 rounded-control px-2.5 py-1.5 text-start text-[13px] transition-colors',
          open ? 'bg-surface-3 text-fg' : 'bg-surface-2 text-muted hover:bg-surface-3 hover:text-fg',
          status === 'waiting' && 'text-warn',
        )}
        onClick={() => setOpen(!open)}
        aria-expanded={open}
        title={advanced ? call.name : undefined}
      >
        <span className="flex h-4 w-4 shrink-0 items-center justify-center">{statusIcon(status, isError)}</span>
        <span className="min-w-0 truncate">
          <span className="font-medium">{label}</span>
          {detail && <span translate="no"> · {detail}</span>}
        </span>
        {open ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
      </button>
      {Custom && (
        <div className="mt-1.5">
          <Custom call={call} message={message} />
        </div>
      )}
      {shown.length > 0 && <Attachments list={shown} threadId={message.thread_id} />}
      {open && (
        <div className="mt-1.5 space-y-2 rounded-xl border border-line bg-surface p-3 text-xs">
          {advanced && (
            <div className="flex items-center gap-1.5 text-muted">
              <Wrench className="h-3.5 w-3.5" />
              <code translate="no">{call.name}</code>
            </div>
          )}
          <div>
            <div className="mb-1 font-semibold text-muted">Invoer</div>
            <pre className="scroll-thin max-h-60 overflow-auto rounded-lg bg-surface-2 p-2">{JSON.stringify(call.args, null, 2)}</pre>
          </div>
          {result && (
            <div>
              <div className="mb-1 font-semibold text-muted">Resultaat</div>
              <pre className={cx('scroll-thin max-h-80 overflow-auto whitespace-pre-wrap rounded-lg p-2', isError ? 'bg-danger-soft text-danger' : 'bg-surface-2')}>{resultForDisplay(result.content) || '(leeg)'}</pre>
              {/* (pages, pictures and shared files are already shown above the details) */}
              {folded.length > 0 && <Attachments list={folded} threadId={message.thread_id} />}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** The bot's plan as a checklist; it updates live while the bot works (every engine, see server/tools/builtin/plan.ts). */
export function PlanCard({ steps, live }: { steps: PlanStep[]; live: boolean }) {
  const p = planProgress(steps);
  return (
    <section className="w-full max-w-md rounded-2xl border border-line bg-surface px-3.5 py-2.5 text-[13.5px]" aria-label={`Plan: ${p.label}`} data-testid="plan-card">
      <div className="mb-1.5 flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-muted" aria-hidden />
        <span className="font-semibold">Plan</span>
        <span className="ms-auto text-xs text-muted">{p.label}</span>
      </div>
      <div className="mb-2 h-1 overflow-hidden rounded-full bg-surface-3" aria-hidden>
        <div className="h-full rounded-full bg-ok transition-[width] duration-300" style={{ width: `${p.percent}%` }} />
      </div>
      <ul className="space-y-1">
        {steps.map((s, i) => (
          <li key={i} className="flex items-start gap-2">
            <span className="mt-[3px] flex h-3.5 w-3.5 shrink-0 items-center justify-center" aria-hidden>
              {s.status === 'completed' ? <Check className="h-3.5 w-3.5 text-ok" strokeWidth={2.5} /> : s.status === 'in_progress' && live ? <Loader2 className="h-3.5 w-3.5 animate-spin text-ok" /> : <Circle className={cx('h-3 w-3', s.status === 'in_progress' ? 'fill-current text-ok' : 'text-muted')} />}
            </span>
            <span className={cx('min-w-0 break-words', s.status === 'completed' && 'text-muted line-through decoration-muted/60', s.status === 'in_progress' && 'font-medium')}>
              <span className="sr-only">{s.status === 'completed' ? 'Klaar: ' : s.status === 'in_progress' ? 'Bezig: ' : 'Nog te doen: '}</span>
              {s.text}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Collapsible({ icon, title, children, defaultOpen = false }: { icon: React.ReactNode; title: string; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    // max-w-full: the long single-line details (truncate) must not widen the card past the chat column.
    <div className="max-w-full text-[13px]">
      <button className={cx('inline-flex items-center gap-1.5 rounded-control px-2.5 py-1.5 transition-colors', open ? 'bg-surface-3 text-fg' : 'bg-surface-2 text-muted hover:text-fg')} onClick={() => setOpen(!open)} aria-expanded={open}>
        {icon}
        <span className="font-medium">{title}</span>
        {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
      </button>
      {open && <div className="mt-1.5 rounded-xl border border-line bg-surface p-3 text-muted">{children}</div>}
    </div>
  );
}

interface Props {
  m: Message;
  results: Map<string, Message>;
  compact: boolean;
  /** Show the author's name above bot messages (groups, or a different bot than the chat's own). */
  showName?: boolean;
  onReply(m: Message): void;
  onForward(m: Message): void;
}


export const MessageItem = memo(function MessageItem({ m, results, compact, showName = false, onReply, onForward }: Props) {
  const me = useApp((s) => s.me);
  const status = useApp((s) => s.status[m.id]);
  // "Claude Code", not the provider kind "claude-code"; the connection's own name ("Ollama snel"), also with two
  // connections of the same kind. Older answers only know the kind.
  const engineName = useApp((s) =>
    m.parts?.providerId
      ? s.providers.find((p) => p.id === m.parts.providerId)?.name || m.parts.providerName
      : m.parts?.provider
        ? s.providers.find((p) => p.kind === m.parts.provider)?.name
        : undefined,
  );
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(m.content);
  const [menu, setMenu] = useState(false);
  const [react, setReact] = useState(false);
  const [versions, setVersions] = useState(false);
  // The newest message of the conversation: only there "Opnieuw" (answer again) makes sense.
  const isLast = useApp((s) => {
    const list = s.messages[m.thread_id];
    return !!list && list[list.length - 1]?.id === m.id;
  });

  if (m.deleted) {
    // An empty attempt TeamBot removed itself when a reserve engine took over, or an answer that "Opnieuw" replaced:
    // nothing to show.
    if (m.parts?.switched || (m.parts as any)?.replaced) return null;
    return <div className="px-4 py-1 text-center text-xs italic text-muted">Bericht verwijderd</div>;
  }
  if (m.role === 'tool') return null;
  if (m.role === 'event' || m.role === 'system') {
    const kind = m.role === 'event' && typeof m.parts?.kind === 'string' ? m.parts.kind : '';
    const Custom = kind ? uiModules.find((x) => x.eventRenderers?.[kind])?.eventRenderers?.[kind] : undefined;
    if (Custom) return <Custom message={m} />;
    return (
      <div className="flex justify-center px-4 py-2">
        <div className="flex max-w-xl items-start gap-1.5 rounded-full bg-surface-2 px-3 py-1 text-xs text-muted">
          <Info className="mt-0.5 h-3 w-3 shrink-0" />
          <span className="whitespace-pre-wrap">{stripRefs(m.content)}</span>
        </div>
      </div>
    );
  }

  const mine = m.author_type === 'user' && m.author_id === me?.id;
  const agent = m.author_type === 'agent' ? agentById(m.author_id) : undefined;
  const streaming = m.status === 'streaming';
  const extras = uiModules.flatMap((x) => x.messageExtras || []);

  const act = async (fn: () => Promise<any>) => {
    try {
      await fn();
    } catch (e) {
      toastError(e);
    }
  };

  const actions = (
    <div
      className={cx(
        'absolute -top-4 z-10 flex items-center gap-0.5 rounded-control border border-line bg-surface p-0.5 opacity-0 shadow-pop transition-opacity duration-150 group-hover:opacity-100 focus-within:opacity-100',
        mine ? 'end-4' : 'start-14',
      )}
    >
      <Button variant="ghost" size="iconSm" aria-label="Reageren" onClick={() => setReact(!react)}>
        <Smile className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="iconSm" aria-label="Beantwoorden" onClick={() => onReply(m)}>
        <CornerUpLeft className="h-3.5 w-3.5" />
      </Button>
      <Button variant="ghost" size="iconSm" aria-label="Kopiëren" onClick={() => void copyToClipboard(m.content).then((ok) => (ok ? toast('Gekopieerd', 'ok') : toast('Kopiëren lukte niet — selecteer de tekst handmatig', 'danger')))}>
        <Copy className="h-3.5 w-3.5" />
      </Button>
      {/* The bot's newest answer in a conversation with one bot: let it answer the same message again. */}
      {isLast && !showName && m.role === 'assistant' && m.author_type === 'agent' && !streaming && (
        <Button variant="ghost" size="iconSm" aria-label="Opnieuw antwoorden" title="Opnieuw: de bot beantwoordt je laatste bericht nog een keer" onClick={() => act(() => api.post(`/threads/${m.thread_id}/regenerate`))}>
          <RotateCcw className="h-3.5 w-3.5" />
        </Button>
      )}
      <Button variant="ghost" size="iconSm" aria-label="Meer" aria-haspopup="true" aria-expanded={menu} className="aria-expanded:bg-surface-3 aria-expanded:text-fg" onClick={() => setMenu(!menu)}>
        <MoreHorizontal className="h-3.5 w-3.5" />
      </Button>
      {/* Under your own message the row hangs from the right, like the toolbar: from the left it reached the edge of a phone screen. */}
      <Pop open={react} origin={mine ? 'top right' : 'top left'} className={cx('absolute top-full z-10 mt-1 flex gap-0.5 rounded-control p-1', mine ? 'end-0' : 'start-0')}>
          {REACTIONS.map((e) => (
            <button key={e} className="rounded-md p-1 text-base transition-colors hover:bg-surface-2 active:bg-surface-3" onClick={() => (setReact(false), act(() => api.post(`/messages/${m.id}/react`, { emoji: e })))}>
              {e}
            </button>
          ))}
      </Pop>
      <Pop open={menu} origin="top right" onKeyDown={menuKeys} className="absolute end-0 top-full z-10 mt-1 w-56 p-1.5" onMouseLeave={() => setMenu(false)}>
          <button className={menuRow} onClick={() => (setMenu(false), act(() => api.post(`/messages/${m.id}/pin`)))}>
            <Pin aria-hidden /> {m.pinned ? 'Losmaken' : 'Vastpinnen'}
          </button>
          <button
            className={menuRow}
            title="Nieuw gesprek met alles tot en met dit bericht; het origineel blijft ongewijzigd"
            onClick={() =>
              (setMenu(false),
              act(async () => {
                const t = await api.post<{ id: string }>(`/threads/${m.thread_id}/fork`, { messageId: m.id });
                location.hash = `#/t/${t.id}`;
              }))
            }
          >
            <GitBranch aria-hidden /> Vanaf hier vertakken
          </button>
          <button className={menuRow} onClick={() => (setMenu(false), onForward(m))}>
            <CornerUpLeft className="rotate-180" aria-hidden /> Doorsturen
          </button>
          {mine && (
            <button className={menuRow} onClick={() => (setMenu(false), setDraft(m.content), setEditing(true))}>
              <Pencil aria-hidden /> Bewerken
            </button>
          )}
          <MenuSeparator />
          <button className={menuRowDanger} onClick={() => (setMenu(false), act(() => api.del(`/messages/${m.id}`)))}>
            <Trash2 aria-hidden /> Verwijderen
          </button>
      </Pop>
    </div>
  );

  const reactions = Object.entries(m.reactions || {});
  const body = editing ? (
    <div className="space-y-2">
      <Textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(10, draft.split('\n').length + 1)} autoFocus />
      <div className="flex flex-wrap justify-end gap-2">
        <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
          Annuleren
        </Button>
        {/* Your own message in a conversation with one bot: the bot answers the new text; what came after it goes. */}
        {mine && !showName && m.role === 'user' && (
          <Button
            size="sm"
            title="De bot antwoordt opnieuw op de nieuwe tekst; wat na dit bericht kwam, verdwijnt uit het gesprek"
            onClick={() =>
              act(async () => {
                await api.post(`/messages/${m.id}/rerun`, { content: draft });
                setEditing(false);
              })
            }
          >
            Opslaan en opnieuw versturen
          </Button>
        )}
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            act(async () => {
              await api.patch(`/messages/${m.id}`, { content: draft });
              setEditing(false);
            })
          }
        >
          Opslaan
        </Button>
      </div>
    </div>
  ) : m.content ? (
    mine ? (
      // A routine run's input carries a note meant for the bot ("(Dit is een routine-run in je hoofdchat: … ROUTINE_NO_UPDATE …)");
      // the bot still gets it, the owner only sees the routine name and the task.
      m.parts?.routine ? (
        <RoutineInput content={m.content} />
      ) : (
        <UserText text={m.content} />
      )
    ) : (
      <Markdown text={m.author_type === 'agent' ? m.content.replace(/[ \t]*\[(m|d|b|a|g|p|e|s):([a-z0-9]{4,16})\]/g, '') : m.content} />
    )
  ) : null;

  if (mine || m.author_type === 'user' || m.author_type === 'external') {
    const external = m.author_type === 'external' || (m.author_type === 'user' && !mine);
    return (
      <div id={`m-${m.id}`} className={cx('group relative flex px-4 sm:px-6', compact ? 'pt-1' : 'pt-4', external ? 'justify-start' : 'justify-end')}>
        {actions}
        <div className={cx('min-w-0 max-w-[85%] sm:max-w-[72%]', external && 'flex gap-2.5')}>
          {external && !compact && <Avatar name={m.author_name} size={30} />}
          {external && compact && <div className="w-[30px] shrink-0" />}
          <div className="min-w-0">
            {external && !compact && <div className="mb-1 text-xs font-semibold text-muted">{m.author_name}</div>}
            {m.reply_to && <ReplyQuote id={m.reply_to} threadId={m.thread_id} />}
            <div
              translate="no"
              className={cx('rounded-bubble px-3.5 py-2.5 text-[14.5px] leading-relaxed', external ? 'rounded-ss-md border border-line bg-surface' : 'rounded-ee-md bg-surface-3', m.pinned && 'ring-2 ring-warn')}
            >
              {body}
            </div>
            {m.parts.attachments?.length ? <Attachments list={m.parts.attachments} voice={!!m.parts.voice} notices={!external} threadId={m.thread_id} /> : null}
            {!editing && <LinkPreviews text={m.content} />}
            <div className={cx('mt-1 flex items-center gap-1.5 px-1 text-[11px] text-muted', external ? '' : 'justify-end')}>
              {m.parts.voice && <Badge>spraak</Badge>}
              {m.parts.steer?.runId && <Badge>meegenomen in de lopende beurt</Badge>}
              {m.parts.steer?.interrupted && <Badge>onderbrak de beurt</Badge>}
              {m.edited_at && (
                <button type="button" className="rounded-md underline-offset-2 hover:text-fg hover:underline coarse:min-h-11 coarse:px-1" onClick={() => setVersions(true)} title="Eerdere versies bekijken">
                  bewerkt{Array.isArray(m.parts?.versions) && m.parts.versions.length > 1 ? ` (${m.parts.versions.length}×)` : ''}
                </button>
              )}
              <span>{fmtTime(m.created_at)}</span>
            </div>
            {m.edited_at && versions && <VersionsModal m={m} open={versions} onClose={() => setVersions(false)} />}
            {reactions.length > 0 && <Reactions m={m} />}
            {extras.map((X, i) => (
              <X key={i} message={m} />
            ))}
          </div>
        </div>
      </div>
    );
  }

  // assistant
  // plan_update has no chip of its own: the plan card shows it.
  const calls = (m.parts.toolCalls || []).filter((c) => c.name !== 'plan_update' || c.status === 'denied' || results.get(c.id)?.parts.toolResult?.isError);
  const plan = m.parts.plan?.steps?.length ? m.parts.plan.steps : null;
  const costText = messageCostText(m.usage, uiLocale());
  const thinking = streaming && !m.content && !calls.length;
  return (
    <div id={`m-${m.id}`} className={cx('group relative flex gap-2.5 px-4 sm:px-6', compact ? 'pt-1.5' : 'pt-5')}>
      {actions}
      {compact ? <div className="w-[30px] shrink-0" /> : <BotAvatar bot={agent || { id: m.author_id, name: m.author_name }} size={30} mood={streaming ? 'working' : 'idle'} className="mt-0.5" />}
      <div className="flex min-w-0 max-w-full flex-1 flex-col items-start gap-2 sm:max-w-[85%]">
        {(showName && !compact) && (
          <div className="-mb-1 flex items-baseline gap-2 px-1">
            <span className="text-[13px] font-bold">{m.author_name}</span>
            <span className="text-[11px] text-muted">{fmtTime(m.created_at)}</span>
          </div>
        )}
        {m.reply_to && <ReplyQuote id={m.reply_to} threadId={m.thread_id} />}
        {m.parts.notice && (
          <div className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {m.parts.notice}
          </div>
        )}
        {m.parts.reasoning && (
          <Collapsible icon={<Brain className="h-3.5 w-3.5" />} title={streaming && !m.content ? 'Denkt na…' : 'Denkproces'}>
            <div className="whitespace-pre-wrap">{m.parts.reasoning}</div>
          </Collapsible>
        )}
        {m.parts.activity?.length ? (
          <Collapsible icon={<Wrench className="h-3.5 w-3.5" />} title={m.parts.activity.length === 1 ? '1 stap' : `${m.parts.activity.length} stappen`} defaultOpen={streaming}>
            <ul className="space-y-1">
              {m.parts.activity.map((a, i) => (
                <li key={i}>
                  <span className="text-fg">{plainStep(stripRefs(a.title))}</span>
                  {a.detail && <span className="block truncate">{stepDetail(a.detail)}</span>}
                </li>
              ))}
            </ul>
          </Collapsible>
        ) : null}
        {plan && <PlanCard steps={plan} live={streaming} />}
        {(body || thinking) && (
          <div className={cx('w-full max-w-full py-1 text-[14.5px] leading-relaxed', m.pinned && 'rounded-bubble px-4 py-2.5 ring-2 ring-warn')}>
            {body}
            {thinking && (
              <div className="flex items-center gap-2 text-sm text-muted" role="status">
                <span className="flex gap-1" aria-hidden>
                  <span className="tb-pulse h-1.5 w-1.5 rounded-full bg-muted" />
                  <span className="tb-pulse h-1.5 w-1.5 rounded-full bg-muted [animation-delay:.2s]" />
                  <span className="tb-pulse h-1.5 w-1.5 rounded-full bg-muted [animation-delay:.4s]" />
                </span>
                {status || 'Denkt na…'}
              </div>
            )}
          </div>
        )}
        {calls.length > 0 && (
          <div className="flex max-w-full flex-col items-start gap-1.5">
            {calls.map((c) => (
              <ToolCard key={c.id} call={c} result={results.get(c.id)} message={m} />
            ))}
          </div>
        )}
        {streaming && (m.content || calls.length > 0) && status && (
          <div className="flex items-center gap-2 px-1 text-xs text-muted" role="status">
            <Loader2 className="h-3 w-3 animate-spin text-ok" />
            {status}
          </div>
        )}
        {m.status === 'error' && m.parts.error && m.parts.budget && <BudgetStopNote m={m} />}
        {m.status === 'error' && m.parts.error && !m.parts.budget && (
          <div className="flex items-start gap-2 rounded-xl bg-danger-soft px-3 py-2 text-xs text-danger">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            <div className="min-w-0">
              <span className="whitespace-pre-wrap">{m.parts.error}</span>
              {/* A program that stopped unexpectedly: what it said, for whoever wants to find out why. */}
              {typeof m.parts.errorDetail === 'string' && m.parts.errorDetail && (
                <details className="mt-1">
                  <summary className="cursor-pointer font-medium">Details</summary>
                  <pre className="scroll-thin mt-1 max-h-48 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2 text-[11px] text-muted" translate="no" tabIndex={0}>
                    {m.parts.errorDetail}
                  </pre>
                </details>
              )}
            </div>
          </div>
        )}
        {m.status === 'error' && Array.isArray(m.parts.switchTo) && m.parts.switchTo.length > 0 && <SwitchOffer m={m} />}
        {m.status === 'cancelled' && !m.parts.switched && (
          <div className="px-1 text-xs text-muted">{m.parts.steered ? 'Onderbroken door je bijsturing; de bot begint opnieuw met je bericht' : m.parts.voiceInterrupted ? 'Onderbroken: je begon te praten' : m.parts.interrupted ? 'Onderbroken door een herstart' : 'Gestopt'}</div>
        )}
        {m.status === 'done' && !m.content?.trim() && !calls.length && !m.parts.attachments?.length && (
          <div className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn">
            <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
            {m.parts.reasoning ? 'Het model gaf geen antwoord. Probeer het opnieuw of zet het denkniveau lager.' : 'Het model gaf een leeg antwoord. Probeer het opnieuw.'}
          </div>
        )}
        {m.parts.attachments?.length ? <Attachments list={m.parts.attachments} threadId={m.thread_id} /> : null}
        {!streaming && !editing && <LinkPreviews text={m.content} />}
        {!streaming && !!m.content && (
          // The time is always there (also on a phone, which has no hover); engine, model and cost on hover/focus.
          <div className="-mt-1 px-1 text-[11px] text-muted">
            <span>{fmtTime(m.created_at)}</span>
            <span className="opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
              {[engineName || m.parts.provider, !m.parts.model || m.parts.model === 'default' ? 'standaardmodel' : prettyModel(m.parts.model), costText]
                .filter(Boolean)
                .map((x) => ` · ${x}`)
                .join('')}
            </span>
          </div>
        )}
        {reactions.length > 0 && <Reactions m={m} />}
        {extras.map((X, i) => (
          <X key={i} message={m} />
        ))}
      </div>
    </div>
  );
});

/**
 * Stopped by the daily budget (server/agent/budget.ts): a limit, not an error (acceptance round 6, B-70). The server's
 * sentences say what was reached, when the bot works again and where to raise it; the link goes straight to the field.
 */
function BudgetStopNote({ m }: { m: Message }) {
  // `cap`: the stop is the bot's own usage cap (server/modules/usage/cap.ts BotCapStop), not the owner's daily budget.
  const b = m.parts.budget! as NonNullable<Message['parts']['budget']> & { cap?: { agentId?: string } };
  return (
    <div className="flex items-start gap-2 rounded-xl bg-warn-soft px-3 py-2 text-xs text-warn" role="status" data-testid="budget-stop">
      <Gauge className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
      <div className="min-w-0 space-y-1">
        {b.midRun && <p className="font-medium">Gestopt halverwege deze beurt. Wat de bot al deed, staat hierboven.</p>}
        <p className="whitespace-pre-wrap">{m.parts.error}</p>
        {/* The bot's own usage cap (server/modules/usage/cap.ts): changed in that bot's settings. */}
        {b.cap?.agentId ? (
          <a href={`#/agents/${b.cap.agentId}`} className="inline-block font-medium underline">
            Gebruikslimiet aanpassen
          </a>
        ) : !b.byAdmin && (
          <a href="#/settings/general" className="inline-block font-medium underline">
            Dagbudget aanpassen
          </a>
        )}
      </div>
    </div>
  );
}

/** The owner's own text; leading "> " lines (a quote, e.g. from "Citeren" in a page) shown as a quote block. */
function UserText({ text }: { text: string }) {
  const lines = text.split('\n');
  let n = 0;
  while (n < lines.length && lines[n].startsWith('>')) n++;
  if (!n) return <div className="whitespace-pre-wrap break-words">{text}</div>;
  const quote = lines.slice(0, n).map((l) => l.replace(/^> ?/, '')).join('\n');
  const rest = lines.slice(n).join('\n').replace(/^\n+/, '');
  return (
    <div className="space-y-1.5">
      <blockquote className="whitespace-pre-wrap break-words border-s-2 border-line-strong ps-2.5 text-muted">{quote}</blockquote>
      {rest && <div className="whitespace-pre-wrap break-words">{rest}</div>}
    </div>
  );
}

/** A routine run's input: the head line and the task; the event's data folded away (the bot still gets everything). */
function RoutineInput({ content }: { content: string }) {
  const v = routineInputView(content);
  return (
    <div className="space-y-1.5">
      <div className="whitespace-pre-wrap break-words">{v.text}</div>
      {v.data && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted">Gegevens van de gebeurtenis</summary>
          <pre className="scroll-thin mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-words rounded-lg bg-surface p-2 text-[11.5px]" translate="no" tabIndex={0}>
            {v.data}
          </pre>
        </details>
      )}
    </div>
  );
}

function Reactions({ m }: { m: Message }) {
  const me = useApp((s) => s.me);
  return (
    <div className="mt-1 flex flex-wrap gap-1">
      {Object.entries(m.reactions).map(([e, users]) => (
        <button
          key={e}
          onClick={() => api.post(`/messages/${m.id}/react`, { emoji: e }).catch(toastError)}
          className={cx('rounded-full border px-2 py-0.5 text-xs', users.includes(me?.id || '') ? 'border-muted bg-surface-3' : 'border-line bg-surface')}
        >
          {e} {users.length}
        </button>
      ))}
    </div>
  );
}

function ReplyQuote({ id, threadId }: { id: string; threadId: string }) {
  const msg = useApp((s) => s.messages[threadId]?.find((x) => x.id === id));
  if (!msg) return null;
  return (
    <a
      href={`#m-${id}`}
      onClick={(e) => (e.preventDefault(), document.getElementById(`m-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }))}
      className="mb-1 block rounded-lg border-s-2 border-line-strong bg-surface-2 px-2.5 py-1 text-xs text-muted hover:text-fg"
    >
      <span className="font-semibold">{msg.author_name}:</span> {msg.content.slice(0, 120)}
    </a>
  );
}
