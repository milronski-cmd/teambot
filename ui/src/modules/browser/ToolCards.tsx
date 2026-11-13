import { useEffect, useMemo, useState } from 'react';
import { Check, Globe, Monitor, MonitorPlay, X } from 'lucide-react';
import { api, authUrl, fileUrl } from '../../lib/api';
import { navigate } from '../../lib/router';
import { useApp } from '../../lib/store';
import type { Message, ToolCall } from '../../lib/types';
import { Button, toastError, useAsync } from '../../components/ui';
import { openDock } from './BrowserDock';
import { describeElement } from '../../shell/toolLabels';

function usePendingApproval(call: ToolCall, message: Message) {
  const approvals = useApp((s) => s.approvals);
  return useMemo(() => {
    // the runner asks before a call ("waiting"); desktop tools also ask from inside the call ("running")
    if (call.status !== 'waiting' && call.status !== 'running') return null;
    const want = JSON.stringify(call.args ?? {});
    return approvals.find((a) => a.status === 'pending' && a.thread_id === message.thread_id && a.tool === call.name && JSON.stringify(a.input ?? {}) === want) || null;
  }, [approvals, call.status, call.name, call.args, message.thread_id]);
}

function useResult(call: ToolCall, message: Message) {
  const list = useApp((s) => s.messages[message.thread_id]);
  return useMemo(() => list?.find((m) => m.role === 'tool' && m.parts.toolResult?.toolCallId === call.id) || null, [list, call.id]);
}

function Decide({ id }: { id: string }) {
  const { busy, run } = useAsync();
  return (
    <div className="flex gap-2">
      <Button size="sm" variant="primary" icon={<Check className="h-4 w-4" />} loading={busy} onClick={() => run(() => api.post(`/approvals/${id}`, { decision: 'approve' }))}>
        Toestaan
      </Button>
      <Button size="sm" variant="danger" icon={<X className="h-4 w-4" />} loading={busy} onClick={() => run(() => api.post(`/approvals/${id}`, { decision: 'deny' }))}>
        Weigeren
      </Button>
    </div>
  );
}

/** Highlight a rectangle (in source pixels) on a scaled image. */
function Highlight({ src, rect, size, alt }: { src: string; rect: { x: number; y: number; w: number; h: number } | null; size: { w: number; h: number }; alt: string }) {
  return (
    <div className="relative w-full max-w-md overflow-hidden rounded-lg border border-line">
      <img src={src} alt={alt} className="block w-full" />
      {rect && size.w > 0 && (
        <div
          className="pointer-events-none absolute rounded border-2 border-danger"
          style={{ left: `${(rect.x / size.w) * 100}%`, top: `${(rect.y / size.h) * 100}%`, width: `${(Math.max(rect.w, 8) / size.w) * 100}%`, height: `${(Math.max(rect.h, 8) / size.h) * 100}%` }}
        />
      )}
    </div>
  );
}

/** Tool card extra for browser_* : screenshot thumbnails, approval preview for submit/upload, login handoff link. */
export function BrowserToolCard({ call, message }: { call: ToolCall; message: Message }) {
  const agentId = message.author_id;
  const pending = usePendingApproval(call, message);
  const result = useResult(call, message);
  const [preview, setPreview] = useState<{ info: any; viewport: { width: number; height: number }; url: string } | null>(null);
  const [stamp] = useState(() => Date.now());
  // Any approval about an element on the page shows which one, in words and highlighted on the current page.
  const needsPreview = !!pending && !!agentId && /^e\d+$/.test(String(call.args?.ref || ''));
  useEffect(() => {
    if (!needsPreview) return;
    api.get(`/computers/${agentId}/element?ref=${encodeURIComponent(call.args.ref)}`).then(setPreview).catch(() => setPreview(null));
  }, [needsPreview, agentId, call.args?.ref]);
  const shots = (result?.parts.attachments || []).filter((a) => a.mime.startsWith('image/'));

  return (
    <div className="space-y-2 text-xs">
      {call.args?.url && (
        <div className="flex items-center gap-1.5 text-muted">
          <Globe className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">{String(call.args.url)}</span>
        </div>
      )}
      {call.name === 'browser_submit' && call.args?.description && <div className="font-medium">Wat er verstuurd wordt: {String(call.args.description)}</div>}
      {needsPreview && preview && (
        <div className="space-y-1">
          {describeElement(preview.info) && <div className="font-medium">Op de pagina: {describeElement(preview.info)}</div>}
          <Highlight src={authUrl(`/computers/${agentId}/frame.jpg?s=${stamp}`)} rect={preview.info?.rect || null} size={{ w: preview.viewport.width, h: preview.viewport.height }} alt="Huidige pagina met het element dat de bot wil gebruiken" />
          <div className="text-muted">Pagina: {preview.url}</div>
          {preview.info?.fields?.length > 0 && (
            <ul className="rounded-lg bg-surface-2 p-2 font-mono">
              {preview.info.fields.map((f: any) => (
                <li key={f.name} className="truncate">
                  {f.name}: {f.value || '(leeg)'}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      {pending && pending.kind === 'tool' && <Decide id={pending.id} />}
      {call.name === 'browser_request_login' && (call.status === 'waiting' || call.status === 'running') && agentId && (
        <Button size="sm" variant="soft" icon={<MonitorPlay className="h-4 w-4" />} onClick={() => openDock(agentId)}>
          Open de browser
        </Button>
      )}
      {shots.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {shots.map((a) => (
            <a key={a.id} href={fileUrl(a.id)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-line">
              <img src={fileUrl(a.id)} alt={a.name} loading="lazy" className="h-24 w-40 object-cover" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** desktop_computer / desktop_launch: the screen with the target marked, why it asks, approve/deny, result screenshot. */
function ScreenToolCard({ call, message }: { call: ToolCall; message: Message }) {
  const agentId = message.author_id;
  const pending = usePendingApproval(call, message);
  const result = useResult(call, message);
  const [pv, setPv] = useState<{ need: string; reason: string | null; summary: string } | null>(null);
  useEffect(() => {
    if (!pending || !agentId) return;
    api.get(`/computers/${agentId}/screen/preview/${encodeURIComponent(call.id)}`).then(setPv).catch(() => setPv(null));
  }, [pending, agentId, call.id]);
  const shots = (result?.parts.attachments || []).filter((a) => a.mime.startsWith('image/'));
  return (
    <div className="space-y-2 text-xs">
      {call.args?.external && <div className="font-medium text-danger">Gevolg buiten je computer: {String(call.args.external).slice(0, 200)}</div>}
      {call.args?.action === 'type' && <div className="font-medium">Tekst: “{String(call.args?.text || '').slice(0, 200)}”</div>}
      {pending && pv && (
        <div className="space-y-1">
          {pv.reason && <div className="font-medium text-danger">{pv.reason}</div>}
          <a href={authUrl(`/computers/${agentId}/screen/preview/${encodeURIComponent(call.id)}/image`)} target="_blank" rel="noreferrer" className="block w-full max-w-md overflow-hidden rounded-lg border border-line">
            <img src={authUrl(`/computers/${agentId}/screen/preview/${encodeURIComponent(call.id)}/image`)} alt="Je scherm met het doel van de actie rood gemarkeerd" className="block w-full" />
          </a>
        </div>
      )}
      {pending && pending.kind === 'tool' && <Decide id={pending.id} />}
      {shots.length > 0 && (
        <div className="flex flex-wrap gap-2">
          {shots.slice(0, 2).map((a) => (
            <a key={a.id} href={fileUrl(a.id)} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-lg border border-line">
              <img src={fileUrl(a.id)} alt="Scherm na deze stap" loading="lazy" className="h-24 w-40 object-cover" />
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** Tool card extra for desktop_*: preview of the window with the target highlighted + approve/deny. */
export function DesktopToolCard({ call, message }: { call: ToolCall; message: Message }) {
  if (call.name === 'desktop_computer' || call.name === 'desktop_launch') return <ScreenToolCard call={call} message={message} />;
  return <WindowToolCard call={call} message={message} />;
}

function WindowToolCard({ call, message }: { call: ToolCall; message: Message }) {
  const agentId = message.author_id;
  const pending = usePendingApproval(call, message);
  const ref = String(call.args?.ref || '');
  const [info, setInfo] = useState<{ snapshotId: string; window: any; element: any; hasPreview: boolean } | null>(null);
  const show = !!agentId && /^[0-9a-f]{6}(\.e\d+)?$/.test(ref) && (call.name === 'desktop_click' || call.name === 'desktop_type' || call.name === 'desktop_key');
  useEffect(() => {
    if (!show) return;
    api.get(`/computers/${agentId}/desktop/ref?ref=${encodeURIComponent(ref)}`).then(setInfo).catch((e) => (pending ? toastError(e) : null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [show, agentId, ref]);
  const rect = info?.element && info.window ? { x: info.element.x - info.window.x, y: info.element.y - info.window.y, w: info.element.w, h: info.element.h } : null;
  return (
    <div className="space-y-2 text-xs">
      {info?.window && (
        <div className="flex items-center gap-1.5 text-muted">
          <Monitor className="h-3.5 w-3.5 shrink-0" aria-hidden />
          <span className="truncate">
            {info.window.process} — {info.window.title}
          </span>
        </div>
      )}
      {call.name === 'desktop_type' && <div className="font-medium">Tekst: “{String(call.args?.text || '').slice(0, 200)}”</div>}
      {show && info?.hasPreview && pending && <Highlight src={authUrl(`/computers/${agentId}/desktop/preview/${info.snapshotId}`)} rect={rect} size={{ w: info.window.w, h: info.window.h }} alt="Voorbeeld van het venster met het doel van de actie" />}
      {pending && pending.kind === 'tool' && <Decide id={pending.id} />}
    </div>
  );
}
