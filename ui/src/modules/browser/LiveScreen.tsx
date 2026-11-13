import { useEffect, useMemo, useRef, useState } from 'react';
import { KeyRound } from 'lucide-react';
import { api, authUrl } from '../../lib/api';
import { useApp } from '../../lib/store';
import { cx, Spinner, toastError, useAsync } from '../../components/ui';
import { computers, patchStatus, useLive } from './api';

/** Keys relayed to the bot's browser while you have control (the server allows exactly these). */
const KEYMAP: Record<string, string> = {
  Enter: 'Enter',
  Tab: 'Tab',
  Escape: 'Escape',
  Backspace: 'Backspace',
  Delete: 'Delete',
  ArrowUp: 'ArrowUp',
  ArrowDown: 'ArrowDown',
  ArrowLeft: 'ArrowLeft',
  ArrowRight: 'ArrowRight',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
};
const CTRL_KEYS = new Set(['a', 'c', 'v', 'x', 'z', 'y']);

/**
 * Human input for the bot's browser while you have control: click in the image, then type and scroll straight into
 * it (characters are batched, never stored or logged). `active` = you control it and the bot is not just paused.
 */
export function useScreenInput(agentId: string, active: boolean) {
  const typedBuf = useRef('');
  const typedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const wheel = useRef({ dy: 0, t: null as ReturnType<typeof setTimeout> | null });
  const send = (body: any) => api.post<{ ok: boolean; url: string }>(`/computers/${agentId}/input`, body).catch((e) => (toastError(e), null));

  const flushTyped = () => {
    if (typedTimer.current) clearTimeout(typedTimer.current);
    typedTimer.current = null;
    const text = typedBuf.current;
    typedBuf.current = '';
    if (text) send({ type: 'type', text });
  };
  useEffect(() => () => flushTyped(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const onClick = (e: React.MouseEvent<HTMLElement>) => {
    if (!active) return;
    e.currentTarget.focus();
    const r = e.currentTarget.getBoundingClientRect();
    send({ type: 'click', x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height });
  };
  const onKeyDown = (e: React.KeyboardEvent<HTMLElement>) => {
    if (!active) return;
    if (e.ctrlKey && !e.altKey && CTRL_KEYS.has(e.key.toLowerCase())) {
      e.preventDefault();
      flushTyped();
      send({ type: 'key', key: `Control+${e.key.toUpperCase()}` });
      return;
    }
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (e.key === 'Tab' && e.shiftKey) {
      e.preventDefault();
      flushTyped();
      send({ type: 'key', key: 'Shift+Tab' });
      return;
    }
    if (KEYMAP[e.key]) {
      e.preventDefault();
      flushTyped();
      send({ type: 'key', key: KEYMAP[e.key] });
      return;
    }
    if (e.key.length === 1) {
      e.preventDefault();
      typedBuf.current += e.key;
      if (typedTimer.current) clearTimeout(typedTimer.current);
      typedTimer.current = setTimeout(flushTyped, 120);
    }
  };
  const onWheel = (e: React.WheelEvent<HTMLElement>) => {
    if (!active) return;
    wheel.current.dy += e.deltaY;
    if (wheel.current.t) return;
    wheel.current.t = setTimeout(() => {
      const dy = Math.max(-3000, Math.min(3000, Math.round(wheel.current.dy)));
      wheel.current = { dy: 0, t: null };
      if (dy) send({ type: 'scroll', dy });
    }, 120);
  };
  return { send, onClick, onKeyDown, onWheel };
}

/**
 * A bot's computer as a panel shows and steers it (the browser dock and the large live view): its status, live; who
 * holds it; your clicks and typing while you hold it, with the heartbeat that keeps your hold; and `post` for an action
 * on it, after which the status is read again.
 */
export function useComputerControl(agentId: string) {
  const me = useApp((s) => s.me);
  const live = useLive(() => computers.get(agentId), ['computer.status', 'computer.config'], [agentId], patchStatus(agentId));
  const { busy, run } = useAsync();
  const status = live.data?.status;
  const controller = status?.controller || null;
  const iControl = !!(controller && controller.kind === 'user' && me && controller.userId === me.id);
  const sticky = !!controller?.sticky;
  // Whoever holds the browser can click and type, also while the bot is paused: that is exactly how you log in
  // when the bot asks for it (browser_request_login pauses the bot and hands you the browser).
  const scr = useScreenInput(agentId, iControl);
  // Keep the human lease alive while you hold the computer from this panel.
  useEffect(() => {
    if (!iControl || sticky) return; // a pause has no heartbeat: it lasts until "Ga verder"
    const t = setInterval(() => api.post(`/computers/${agentId}/heartbeat`, {}).catch(() => {}), 15_000);
    return () => clearInterval(t);
  }, [iControl, sticky, agentId]);
  const post = (p: string, body: any = {}, ok?: string) => run(() => api.post(`/computers/${agentId}${p}`, body), ok).then((r) => (live.reload(), r));
  return { ...live, me, status, controller, iControl, sticky, scr, busy, run, post };
}

/**
 * The live MJPEG view of a bot's browser (16:10). Reconnects by itself, shows a calm placeholder until the first
 * frame, and a "Kluis vult in" veil while TeamBot fills a login (the server sends no frames then).
 */
export function LiveImage({
  agentId,
  input,
  active,
  filling,
  streamKey,
  onReconnect,
  className,
  label = 'Live beeld van de browser van de bot',
}: {
  agentId: string;
  input: ReturnType<typeof useScreenInput>;
  active: boolean;
  filling?: boolean;
  streamKey: number;
  onReconnect(): void;
  className?: string;
  label?: string;
}) {
  const [loaded, setLoaded] = useState(false);
  const img = useRef<HTMLImageElement>(null);
  // One signed URL per (re)connect: a re-render never restarts the stream.
  const streamSrc = useMemo(() => authUrl(`/computers/${agentId}/stream?k=${streamKey}`), [agentId, streamKey]);
  // an MJPEG <img> does not always fire "load": watch for the first decoded frame instead
  useEffect(() => {
    setLoaded(false);
    const t = setInterval(() => {
      if (img.current && img.current.naturalWidth > 0) {
        setLoaded(true);
        clearInterval(t);
      }
    }, 150);
    return () => clearInterval(t);
  }, [streamKey, agentId]);
  return (
    <div className={cx('relative aspect-[16/10] w-full overflow-hidden bg-surface-2', className)}>
      <img
        key={`${agentId}-${streamKey}`}
        ref={img}
        src={streamSrc}
        alt={label}
        onLoad={() => setLoaded(true)}
        onClick={input.onClick}
        onKeyDown={input.onKeyDown}
        onWheel={input.onWheel}
        tabIndex={active ? 0 : -1}
        onError={() => setTimeout(onReconnect, 2000)}
        className={cx('block h-full w-full object-contain outline-none transition-opacity duration-300', loaded ? 'opacity-100' : 'opacity-0', active && 'cursor-crosshair focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent')}
      />
      {!loaded && (
        <div className="absolute inset-0 flex items-center justify-center" aria-hidden>
          <Spinner className="h-5 w-5" />
        </div>
      )}
      {filling && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-canvas/80 text-center backdrop-blur-sm" role="status">
          <span className="flex h-10 w-10 items-center justify-center rounded-full bg-surface-3">
            <KeyRound className="h-5 w-5" aria-hidden />
          </span>
          <span className="text-sm font-semibold">De kluis vult je inloggegevens in…</span>
          <span className="max-w-[260px] text-xs text-muted">Het beeld pauzeert even. De bot ziet je wachtwoord niet.</span>
        </div>
      )}
    </div>
  );
}
