import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Eye, EyeOff, HelpCircle, Keyboard, Maximize2, MousePointer2, Settings2, X, ZoomIn, ZoomOut } from 'lucide-react';
import { getToken, on } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import { Button, cx, Field, Modal, Select, Spinner, Toggle, toast } from '../../components/ui';
import { endedReason, fetchFrame, remote, type MonitorInfo, type RemoteInput, type SessionStatus } from './api';
import { PLACE } from '../../../../shared/places.js';
import { Adaptive, frameSide, fromPicture, Gestures, KEY_BUTTONS, keyInput, LEVELS, nextDelay, NO_ZOOM, panBy, toPicture, typedChange, zoomAt, type Box, type GestureOut, type QualityChoice, type View } from './logic';

type Phase = 'starting' | 'live' | 'ended' | 'failed';
const BACK = '#/m/remote-desktop';
const QKEY = 'tb_rd_quality';

const readQuality = (): QualityChoice => {
  try {
    const v = localStorage.getItem(QKEY);
    return v === 'sharp' || v === 'normal' || v === 'fast' || v === 'saver' ? v : 'auto';
  } catch {
    return 'auto';
  }
};

const LEVEL_LABEL: Record<string, string> = { sharp: 'Scherp', normal: 'Gemiddeld', fast: 'Snel', saver: 'Zuinig' };

function endText(reason: string, idleMinutes: number): string {
  switch (reason) {
    case 'stopped_here':
      return t('Gestopt op de computer. Bureaublad op afstand staat nu uit; aanzetten kan alleen weer op de computer zelf.');
    case 'off':
      return t('Bureaublad op afstand is uitgezet.');
    case 'idle':
      return t('{0, plural, one {Gestopt na # minuut zonder bediening.} other {Gestopt na # minuten zonder bediening.}}', idleMinutes);
    case 'gone':
      return t('De verbinding was te lang weg.');
    case 'unavailable':
      return t('Bureaublad op afstand is op de computer niet beschikbaar: de TeamBot-app draait daar niet.');
    case 'shutdown':
      return t('TeamBot op de computer is gestopt.');
    case 'signed_out':
      return t('Je bent uitgelogd.');
    case 'unknown':
      return t('Deze sessie bestaat niet meer.');
    default:
      return t('De sessie is beëindigd.');
  }
}
/** After these the owner chooses himself; after the others "Opnieuw verbinden" makes sense. */
const FINAL = new Set(['stopped_here', 'off', 'unavailable', 'signed_out']);

const clamp01 = (v: number) => Math.max(0, Math.min(1, v));

/** Full-screen view of the computer's desktop with touch, mouse and keyboard control (#/m/remote-desktop/live). */
export function Viewer() {
  const [phase, setPhase] = useState<Phase>('starting');
  const [problem, setProblem] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const [sid, setSid] = useState<string | null>(null);
  const [monitors, setMonitors] = useState<MonitorInfo[]>([]);
  const [monitor, setMonitor] = useState(0);
  const [control, setControl] = useState(true);
  const [viewOnly, setViewOnly] = useState(false);
  const [idleMinutes, setIdleMinutes] = useState(10);
  const [idleLeft, setIdleLeft] = useState<number | null>(null);
  const [img, setImg] = useState<string | null>(null);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [box, setBox] = useState({ cw: 0, ch: 0 });
  const [view, setView] = useState<View>(NO_ZOOM);
  const [quality, setQuality] = useState<QualityChoice>(readQuality);
  const [level, setLevel] = useState(LEVELS[1].id);
  const [fps, setFps] = useState(0);
  const [slow, setSlow] = useState(false);
  const [capture, setCapture] = useState<string | null>(null);
  const [offline, setOffline] = useState(false);
  const [keyboard, setKeyboard] = useState(false);
  const [options, setOptions] = useState(false);
  const [help, setHelp] = useState(false);
  const [mark, setMark] = useState<{ x: number; y: number; kind: 'tap' | 'press'; n: number } | null>(null);
  const [line, setLine] = useState<{ x: number; y: number; x2: number; y2: number } | null>(null);
  const [text, setText] = useState('');
  const [status, setStatus] = useState<SessionStatus | null>(null);
  const [focused, setFocused] = useState(false);
  const [attempt, setAttempt] = useState(0);

  const area = useRef<HTMLDivElement>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const viewRef = useRef(view);
  viewRef.current = view;
  const monitorRef = useRef(monitor);
  monitorRef.current = monitor;
  const viewOnlyRef = useRef(viewOnly);
  viewOnlyRef.current = viewOnly;
  const sidRef = useRef<string | null>(null);
  const adaptive = useRef(new Adaptive(quality));
  const lastInput = useRef(0);
  const chain = useRef<Promise<unknown>>(Promise.resolve());
  const scrollAcc = useRef<{ x: number; y: number; dx: number; dy: number; timer: ReturnType<typeof setTimeout> | null }>({ x: 0.5, y: 0.5, dx: 0, dy: 0, timer: null });
  const shownView = useRef(false);
  const textRef = useRef('');

  const mon = monitors.find((m) => m.index === monitor) || monitors[0];
  const pictureBox: Box = useMemo(() => ({ cw: box.cw, ch: box.ch, iw: mon?.w || 16, ih: mon?.h || 9 }), [box.cw, box.ch, mon?.w, mon?.h]);
  const monRef = useRef(mon);
  monRef.current = mon;
  const boxRef = useRef(pictureBox);
  boxRef.current = pictureBox;

  // ---------------------------------------------------------------- session start / end

  const finish = useCallback((reason: string) => {
    sidRef.current = null;
    setEnded(reason);
    setPhase('ended');
    setKeyboard(false);
  }, []);

  useEffect(() => {
    let alive = true;
    setPhase('starting');
    setEnded(null);
    setProblem(null);
    // Ask first whether it is on and possible here: no session request (and no error) while it is off.
    remote
      .state()
      .then((st) => {
        if (!st.enabled) throw new Error(t('Bureaublad op afstand staat uit. Zet het aan op de computer zelf ({0}).', t(PLACE.remoteDesktop)));
        if (!st.available) throw new Error(st.unavailable === 'platform' ? t('Bureaublad op afstand werkt alleen op Windows.') : t('Bureaublad op afstand werkt alleen in de TeamBot-app op deze computer: daar staat de stopknop op het scherm.'));
        return remote.start({ monitor: monitorRef.current });
      })
      .then((s) => {
        if (!alive) {
          void remote.end(s.id).catch(() => {});
          return;
        }
        sidRef.current = s.id;
        setSid(s.id);
        setMonitors(s.monitors);
        setMonitor(s.monitor);
        setControl(s.control);
        setViewOnly(s.view);
        setIdleMinutes(s.idleMinutes);
        setIdleLeft(s.idleLeftMs);
        setPhase('live');
      })
      .catch((e) => {
        if (!alive) return;
        setProblem(e?.message || String(e));
        setPhase('failed');
      });
    return () => {
      alive = false;
      const id = sidRef.current;
      sidRef.current = null;
      if (id) void remote.end(id).catch(() => {});
    };
  }, [attempt]);

  useEffect(
    () =>
      on('remote-desktop.ended', (d: any) => {
        if (d?.id && d.id === sidRef.current) finish(String(d.reason || 'ended'));
      }),
    [finish],
  );

  // closing the tab or the app ends the session at once (otherwise the server waits a minute)
  useEffect(() => {
    const f = () => {
      const id = sidRef.current;
      const tok = getToken();
      if (!id) return;
      try {
        void fetch(`/api/remote-desktop/sessions/${encodeURIComponent(id)}`, { method: 'DELETE', keepalive: true, headers: tok ? { authorization: `Bearer ${tok}` } : {} }).catch(() => {});
      } catch {
        /* page is going away */
      }
    };
    window.addEventListener('pagehide', f);
    return () => window.removeEventListener('pagehide', f);
  }, []);

  // what a bot on this desktop is doing (it waits when you take over)
  useEffect(() => {
    if (!sid || phase !== 'live') return;
    let alive = true;
    const load = () =>
      remote
        .status(sid)
        .then((s) => alive && setStatus(s))
        .catch((e) => {
          const r = endedReason(e);
          if (alive && r) finish(r);
        });
    load();
    const timer = setInterval(load, 8000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [sid, phase, finish]);

  // ---------------------------------------------------------------- frames

  useEffect(() => {
    if (!sid || phase !== 'live') return;
    let alive = true;
    let etag = '';
    let unchanged = 0;
    let shown: number[] = [];
    let backoff = 0;
    let prevUrl: string | null = null;
    const ac = new AbortController();
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
    (async () => {
      while (alive) {
        if (document.hidden) {
          await sleep(500);
          continue;
        }
        const lv = adaptive.current.current();
        const t0 = performance.now();
        try {
          const m = monRef.current;
          const f = await fetchFrame(sid, { monitor: monitorRef.current, side: frameSide(lv, m?.w || 16, m?.h || 9), q: lv.q, etag, signal: ac.signal });
          if (!alive) break;
          const took = performance.now() - t0;
          backoff = 0;
          setOffline(false);
          setCapture(null);
          etag = f.etag;
          setCursor(f.cursor);
          if (f.idleLeftMs !== null) setIdleLeft(f.idleLeftMs);
          if (f.blob) {
            unchanged = 0;
            const url = URL.createObjectURL(f.blob);
            setImg(url);
            if (prevUrl) {
              const old = prevUrl;
              setTimeout(() => URL.revokeObjectURL(old), 1000);
            }
            prevUrl = url;
            if (adaptive.current.record(took, Date.now())) setLevel(adaptive.current.current().id);
            const now = Date.now();
            shown = [...shown.filter((x) => now - x < 3000), now];
            setFps(Math.round((shown.length / 3) * 10) / 10);
            setSlow((adaptive.current.average() ?? 0) > 700 || adaptive.current.level >= 2);
          } else unchanged++;
          await sleep(nextDelay({ tookMs: took, unchanged, sinceInputMs: Date.now() - lastInput.current }));
        } catch (e: any) {
          if (!alive || e?.name === 'AbortError') break;
          const r = endedReason(e);
          if (r) {
            finish(r);
            break;
          }
          if (e?.code === 'remote_capture') setCapture(e.message || t('Het scherm is nu niet te zien.'));
          else if (e?.status === 0) setOffline(true);
          adaptive.current.record(2000, Date.now());
          backoff = Math.min(5000, backoff ? backoff * 2 : 800);
          await sleep(e?.status === 429 ? 200 : backoff);
        }
      }
    })();
    return () => {
      alive = false;
      ac.abort();
      if (prevUrl) {
        const old = prevUrl;
        setTimeout(() => URL.revokeObjectURL(old), 1000);
      }
    };
  }, [sid, phase, finish]);

  useEffect(() => {
    adaptive.current.choice = quality;
    setLevel(adaptive.current.current().id);
    try {
      if (quality === 'auto') localStorage.removeItem(QKEY);
      else localStorage.setItem(QKEY, quality);
    } catch {
      /* private mode */
    }
  }, [quality]);

  // ---------------------------------------------------------------- layout

  useLayoutEffect(() => {
    const el = area.current;
    if (!el) return;
    const f = () => setBox({ cw: el.clientWidth, ch: el.clientHeight });
    f();
    const ro = new ResizeObserver(f);
    ro.observe(el);
    return () => ro.disconnect();
  }, [phase]);

  // another monitor: its own picture (and aspect) from the next frame on
  useEffect(() => {
    setImg(null);
    setCursor(null);
  }, [monitor]);

  // a new monitor or a resized window: keep the picture on screen
  useEffect(() => {
    setView((v) => (shownView.current ? zoomAt(pictureBox, v, 1, 0, 0) : NO_ZOOM));
    shownView.current = true;
  }, [pictureBox]);

  // ---------------------------------------------------------------- input

  const send = useCallback(
    (i: RemoteInput) => {
      const id = sidRef.current;
      if (!id) return;
      if (viewOnlyRef.current) {
        toast(t('Alleen kijken staat aan. Zet het uit in Opties om te bedienen.'));
        return;
      }
      lastInput.current = Date.now();
      const m = monitorRef.current;
      chain.current = chain.current
        .then(() => remote.input(id, m, i))
        .then((r) => setIdleLeft(r.idleLeftMs))
        .catch((e) => {
          const r = endedReason(e);
          if (r) finish(r);
          else if (e?.status === 429) return;
          else toast(e?.message || String(e), e?.code === 'remote_refused' || e?.code === 'remote_view_only' ? 'neutral' : 'danger');
        });
    },
    [finish],
  );

  const flushScroll = useCallback(() => {
    const a = scrollAcc.current;
    a.timer = null;
    const dy = Math.trunc(a.dy);
    const dx = Math.trunc(a.dx);
    a.dy -= dy;
    a.dx -= dx;
    if (dy || dx) send({ type: 'scroll', x: a.x, y: a.y, dx: Math.max(-30, Math.min(30, dx)), dy: Math.max(-30, Math.min(30, dy)) });
  }, [send]);

  const queueScroll = useCallback(
    (p: { x: number; y: number }, dx: number, dy: number) => {
      const a = scrollAcc.current;
      a.x = p.x;
      a.y = p.y;
      a.dx += dx;
      a.dy += dy;
      if (!a.timer) a.timer = setTimeout(flushScroll, 90);
    },
    [flushScroll],
  );

  const picture = useCallback((x: number, y: number, clampIt = false) => {
    const p = toPicture(boxRef.current, viewRef.current, x, y);
    if (p || !clampIt) return p;
    // a drag that ends beside the picture ends on its edge
    const b = boxRef.current;
    const v = viewRef.current;
    const a = fromPicture(b, v, 0, 0);
    const z = fromPicture(b, v, 1, 1);
    return { x: clamp01((x - a.x) / Math.max(1, z.x - a.x)), y: clamp01((y - a.y) / Math.max(1, z.y - a.y)) };
  }, []);

  const showMark = (x: number, y: number, kind: 'tap' | 'press') => {
    const n = Date.now();
    setMark({ x, y, kind, n });
    setTimeout(() => setMark((m) => (m && m.n === n ? null : m)), 700);
  };

  const handle = useCallback(
    (outs: GestureOut[]) => {
      for (const o of outs) {
        switch (o.kind) {
          case 'click': {
            const p = picture(o.x, o.y);
            if (!p) break;
            showMark(o.x, o.y, 'tap');
            send({ type: 'click', x: p.x, y: p.y, count: o.count });
            break;
          }
          case 'right': {
            const p = picture(o.x, o.y);
            if (!p) break;
            showMark(o.x, o.y, 'press');
            send({ type: 'click', x: p.x, y: p.y, button: 'right' });
            break;
          }
          case 'drag': {
            const a = picture(o.x, o.y, true);
            const b = picture(o.x2, o.y2, true);
            if (a && b) send({ type: 'drag', x: a.x, y: a.y, x2: b.x, y2: b.y });
            break;
          }
          case 'scroll': {
            const p = picture(o.x, o.y, true);
            if (p) queueScroll(p, o.dx, o.dy);
            break;
          }
          case 'pan':
            setView((v) => panBy(boxRef.current, v, o.dx, o.dy));
            break;
          case 'zoom':
            setView((v) => zoomAt(boxRef.current, v, o.factor, o.cx, o.cy, o.dx, o.dy));
            break;
          case 'press':
            showMark(o.x, o.y, 'press');
            try {
              navigator.vibrate?.(15);
            } catch {
              /* no vibration */
            }
            break;
          case 'line':
            setLine({ x: o.x, y: o.y, x2: o.x2, y2: o.y2 });
            break;
          case 'clear':
            setLine(null);
            break;
        }
      }
    },
    [picture, send, queueScroll],
  );

  const gestures = useMemo(() => new Gestures(() => viewRef.current.z > 1.01), []);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const armPress = useCallback(() => {
    if (pressTimer.current) clearTimeout(pressTimer.current);
    const due = gestures.pressDue();
    if (due === null) return;
    pressTimer.current = setTimeout(() => handle(gestures.tick(performance.now())), Math.max(0, due - performance.now()) + 5);
  }, [gestures, handle]);

  // the mouse of a browser on another PC: click, right click, drag, hover
  const mouse = useRef<{ x: number; y: number; button: number; moved: boolean } | null>(null);
  const hover = useRef({ at: 0, x: -1, y: -1 });

  const local = (e: { clientX: number; clientY: number }) => {
    const r = area.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  const onPointerDown = (e: React.PointerEvent) => {
    if (phase !== 'live') return;
    const p = local(e);
    if (e.pointerType === 'mouse') {
      area.current?.focus({ preventScroll: true });
      mouse.current = { ...p, button: e.button, moved: false };
      (e.target as Element).setPointerCapture?.(e.pointerId);
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    handle(gestures.down(e.pointerId, p.x, p.y, performance.now()));
    armPress();
  };
  const onPointerMove = (e: React.PointerEvent) => {
    if (phase !== 'live') return;
    const p = local(e);
    if (e.pointerType === 'mouse') {
      const m = mouse.current;
      if (m && m.button === 0 && (e.buttons & 1)) {
        if (!m.moved && Math.hypot(p.x - m.x, p.y - m.y) > 5) m.moved = true;
        if (m.moved) setLine({ x: m.x, y: m.y, x2: p.x, y2: p.y });
        return;
      }
      if (m || viewOnlyRef.current || !control) return;
      const now = Date.now();
      const q = picture(p.x, p.y);
      if (!q || now - hover.current.at < 150 || (Math.abs(q.x - hover.current.x) < 0.002 && Math.abs(q.y - hover.current.y) < 0.002)) return;
      hover.current = { at: now, x: q.x, y: q.y };
      const id = sidRef.current;
      if (id) chain.current = chain.current.then(() => remote.input(id, monitorRef.current, { type: 'move', x: q.x, y: q.y })).catch(() => {});
      return;
    }
    handle(gestures.move(e.pointerId, p.x, p.y, performance.now()));
  };
  const onPointerUp = (e: React.PointerEvent) => {
    if (phase !== 'live') return;
    const p = local(e);
    if (e.pointerType === 'mouse') {
      const m = mouse.current;
      mouse.current = null;
      if (!m) return;
      setLine(null);
      if (m.button === 0 && m.moved) {
        const a = picture(m.x, m.y, true);
        const b = picture(p.x, p.y, true);
        if (a && b) send({ type: 'drag', x: a.x, y: a.y, x2: b.x, y2: b.y });
        return;
      }
      const q = picture(p.x, p.y);
      if (!q) return;
      showMark(p.x, p.y, m.button === 2 ? 'press' : 'tap');
      send({ type: 'click', x: q.x, y: q.y, button: m.button === 2 ? 'right' : m.button === 1 ? 'middle' : 'left' });
      return;
    }
    if (pressTimer.current) clearTimeout(pressTimer.current);
    handle(gestures.up(e.pointerId, p.x, p.y, performance.now()));
  };
  const onPointerCancel = (e: React.PointerEvent) => {
    if (e.pointerType === 'mouse') {
      mouse.current = null;
      setLine(null);
      return;
    }
    if (pressTimer.current) clearTimeout(pressTimer.current);
    handle(gestures.cancel(e.pointerId));
  };

  // iOS: no page zoom, no image menu, no rubber band while the fingers are on the picture; the wheel scrolls the PC
  useEffect(() => {
    const el = area.current;
    if (!el) return;
    const stop = (e: Event) => e.preventDefault();
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const p = local(e);
      if (e.ctrlKey) {
        setView((v) => zoomAt(boxRef.current, v, Math.exp(-e.deltaY / 300), p.x, p.y));
        return;
      }
      const q = picture(p.x, p.y, true);
      if (!q) return;
      const unit = e.deltaMode === 1 ? 1 / 3 : e.deltaMode === 2 ? 3 : 1 / 100;
      queueScroll(q, e.deltaX * unit, e.deltaY * unit);
    };
    el.addEventListener('touchstart', stop, { passive: false });
    el.addEventListener('touchmove', stop, { passive: false });
    el.addEventListener('gesturestart', stop as any, { passive: false } as any);
    el.addEventListener('contextmenu', stop);
    el.addEventListener('wheel', wheel, { passive: false });
    return () => {
      el.removeEventListener('touchstart', stop);
      el.removeEventListener('touchmove', stop);
      el.removeEventListener('gesturestart', stop as any);
      el.removeEventListener('contextmenu', stop);
      el.removeEventListener('wheel', wheel);
    };
  }, [phase, picture, queueScroll]);

  // a real keyboard (browser on another PC): keys go to the computer while the picture has the focus
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && e.shiftKey) {
      e.preventDefault();
      toolbar.current?.querySelector<HTMLElement>('button, select')?.focus();
      return;
    }
    const i = keyInput({ key: e.key, code: e.code, ctrlKey: e.ctrlKey, altKey: e.altKey, shiftKey: e.shiftKey, metaKey: e.metaKey, altGraph: e.getModifierState?.('AltGraph') });
    if (!i) return;
    e.preventDefault();
    send(i);
  };

  // the phone keyboard: what changed in the field is typed on the computer
  const sendKeys = (keys: string[]) => {
    for (let i = 0; i < keys.length; i += 10) send({ type: 'key', keys: keys.slice(i, i + 10).join(' ') });
  };
  const onText = (next: string) => {
    const d = typedChange(textRef.current, next);
    textRef.current = next;
    setText(next);
    if (d.backspaces) sendKeys(Array(d.backspaces).fill('backspace'));
    if (d.text) send({ type: 'type', text: d.text });
  };
  const onTextKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      send({ type: 'key', keys: 'enter' });
      textRef.current = '';
      setText('');
    } else if (e.key === 'Backspace' && !textRef.current) {
      e.preventDefault();
      send({ type: 'key', keys: 'backspace' });
    }
  };

  const toggleView = async (v: boolean) => {
    const id = sidRef.current;
    if (!id) return;
    try {
      const r = await remote.view(id, v);
      setViewOnly(r.view);
    } catch (e: any) {
      toast(e?.message || String(e), 'danger');
    }
  };
  const stillHere = async () => {
    const id = sidRef.current;
    if (!id) return;
    try {
      setIdleLeft((await remote.keepalive(id)).idleLeftMs);
    } catch (e) {
      const r = endedReason(e);
      if (r) finish(r);
    }
  };
  const giveBack = async () => {
    const a = status?.bot?.agentId;
    if (!a) return;
    try {
      await remote.giveBack(a);
      toast(t('{0} mag weer verder', status?.bot?.agentName || 'De bot'), 'ok');
      if (sidRef.current) setStatus(await remote.status(sidRef.current));
    } catch (e: any) {
      toast(e?.message || String(e), 'danger');
    }
  };
  const leave = () => navigate(BACK);
  const reconnect = () => setAttempt((n) => n + 1);

  // the server ended it because the app was in the background: connect again once it is back
  useEffect(() => {
    if (phase !== 'ended' || ended !== 'gone') return;
    const f = () => !document.hidden && reconnect();
    document.addEventListener('visibilitychange', f);
    return () => document.removeEventListener('visibilitychange', f);
  }, [phase, ended]);

  // ---------------------------------------------------------------- render

  const rect = useMemo(() => {
    const f = fromPicture(pictureBox, view, 0, 0);
    const g = fromPicture(pictureBox, view, 1, 1);
    return { x: f.x, y: f.y, w: g.x - f.x, h: g.y - f.y };
  }, [pictureBox, view]);
  const cur = cursor ? fromPicture(pictureBox, view, cursor.x, cursor.y) : null;
  const zoomed = view.z > 1.01;
  const zoomBy = (f: number) => setView((v) => zoomAt(pictureBox, v, f, box.cw / 2, box.ch / 2));
  const idleWarn = phase === 'live' && idleLeft !== null && idleLeft < 60_000;
  const bot = status?.bot;
  const levelText = quality === 'auto' ? t('Automatisch ({0})', t(LEVEL_LABEL[level] || level)) : t(LEVEL_LABEL[quality] || quality);
  const hintId = 'rd-keys-hint';
  const stateText =
    phase !== 'live' ? '' : offline ? t('Verbinding kwijt, opnieuw proberen…') : capture ? capture : viewOnly ? t('Alleen kijken') : slow ? t('Trage verbinding: lagere kwaliteit') : '';
  // a still screen sends (almost) no new pictures: that is "Live", not a slow connection
  const rateText = phase !== 'live' || offline || capture ? '' : fps >= 2 ? t('Live · {0} beelden per seconde', Math.round(fps)) : t('Live');

  return (
    <div className="dark flex h-full flex-col bg-black text-fg">
      <main className="relative flex min-h-0 flex-1 flex-col" aria-label="Bureaublad op afstand">
        <div ref={toolbar} className="safe-top safe-x flex shrink-0 items-center gap-1.5 border-b border-line bg-canvas px-2 py-1.5">
          {phase === 'live' || phase === 'starting' ? (
            <Button variant="danger" size="sm" icon={<X className="h-4 w-4" />} onClick={leave} aria-label="Stop en terug">
              Stop
            </Button>
          ) : (
            <Button size="sm" icon={<X className="h-4 w-4" />} onClick={leave}>
              Sluiten
            </Button>
          )}
          {monitors.length > 1 && (
            <Select aria-label="Scherm" value={String(monitor)} onChange={(e) => setMonitor(Number(e.target.value))} className="max-w-[8rem]">
              {monitors.map((m, i) => (
                <option key={m.index} value={m.index}>
                  {t('Scherm {0}', i + 1)}
                </option>
              ))}
            </Select>
          )}
          <div className="min-w-0 flex-1" />
          {zoomed && <Button variant="ghost" size="icon" icon={<Maximize2 className="h-4 w-4" />} onClick={() => setView(NO_ZOOM)} aria-label="Hele scherm tonen" />}
          <Button
            variant={keyboard ? 'soft' : 'ghost'}
            size="icon"
            icon={<Keyboard className="h-5 w-5" />}
            aria-label="Toetsenbord"
            aria-pressed={keyboard}
            disabled={phase !== 'live' || viewOnly}
            onClick={() => setKeyboard((k) => !k)}
          />
          <Button variant="ghost" size="icon" icon={<Settings2 className="h-5 w-5" />} aria-label="Opties" onClick={() => setOptions(true)} />
          <Button variant="ghost" size="icon" icon={<HelpCircle className="h-5 w-5" />} aria-label="Uitleg" onClick={() => setHelp(true)} />
        </div>

        {idleWarn && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 bg-warn-soft px-3 py-2 text-sm text-fg" role="alert">
            <span className="min-w-0 flex-1">{t('{0, plural, one {Stopt over # seconde omdat er niets gebeurt.} other {Stopt over # seconden omdat er niets gebeurt.}}', Math.ceil((idleLeft || 0) / 1000))}</span>
            <Button size="sm" variant="primary" onClick={stillHere}>
              Ik ben er nog
            </Button>
          </div>
        )}
        {phase === 'live' && bot && (
          <div className="flex shrink-0 flex-wrap items-center gap-2 bg-surface-2 px-3 py-1.5 text-sm">
            <span className="min-w-0 flex-1" translate="no">
              {bot.paused ? t('{0} wacht tot je de bediening teruggeeft.', bot.agentName || 'De bot') : t('{0} werkt op dit bureaublad. Zodra je iets doet, wacht de bot.', bot.agentName || 'Een bot')}
            </span>
            {bot.paused && bot.agentId && (
              <Button size="sm" onClick={giveBack}>
                Geef terug
              </Button>
            )}
          </div>
        )}

        <div className="relative min-h-0 flex-1">
          <div
            ref={area}
            role="application"
            aria-label="Bureaublad van de computer"
            aria-describedby={hintId}
            tabIndex={phase === 'live' ? 0 : -1}
            className="absolute inset-0 touch-none select-none overflow-hidden outline-none [-webkit-touch-callout:none] [-webkit-user-select:none] focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent"
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onKeyDown={onKeyDown}
            onFocus={() => setFocused(true)}
            onBlur={() => setFocused(false)}
          >
            {img && phase === 'live' && (
              <img src={img} alt="" aria-hidden draggable={false} className="pointer-events-none absolute max-w-none select-none" style={{ left: rect.x, top: rect.y, width: rect.w, height: rect.h }} data-testid="remote-frame" />
            )}
            {cur && phase === 'live' && (
              <MousePointer2 aria-hidden className="pointer-events-none absolute h-5 w-5 fill-white text-black drop-shadow" style={{ left: cur.x - 3, top: cur.y - 2 }} />
            )}
            {line && (
              <svg className="pointer-events-none absolute inset-0 h-full w-full" aria-hidden>
                <line x1={line.x} y1={line.y} x2={line.x2} y2={line.y2} stroke="#f97316" strokeWidth="3" strokeDasharray="6 4" />
                <circle cx={line.x2} cy={line.y2} r="9" fill="none" stroke="#f97316" strokeWidth="3" />
              </svg>
            )}
            {mark && (
              <span
                key={mark.n}
                aria-hidden
                className={cx('pointer-events-none absolute rounded-full border-2 motion-safe:animate-ping', mark.kind === 'press' ? 'h-14 w-14 border-warn' : 'h-9 w-9 border-accent')}
                style={{ left: mark.x - (mark.kind === 'press' ? 28 : 18), top: mark.y - (mark.kind === 'press' ? 28 : 18), animationIterationCount: 1 }}
              />
            )}
            <p id={hintId} className="sr-only">
              Tik om te klikken, houd vast voor rechtsklikken, sleep met één vinger, scroll met twee vingers en knijp om te zoomen. Met een toetsenbord gaan toetsen naar de computer zolang dit beeld de focus heeft; Shift+Esc gaat terug naar de knoppen.
            </p>
            {focused && phase === 'live' && !keyboard && (
              <div className="pointer-events-none absolute bottom-2 start-2 hidden rounded-lg bg-black/70 px-2 py-1 text-xs text-white [@media(pointer:fine)]:block">Toetsen gaan naar de computer · Shift+Esc om terug te gaan</div>
            )}
          </div>
          {phase === 'starting' || (phase === 'live' && !img) ? (
            <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center gap-3 text-sm text-muted">
              <Spinner />
              <span>{capture || t('Het bureaublad wordt geladen…')}</span>
            </div>
          ) : null}
          {phase === 'live' && img && (stateText || rateText) && (
            <div data-testid="remote-status" className="pointer-events-none absolute start-2 top-2 flex max-w-[75%] items-center gap-1.5 truncate rounded-full bg-black/75 px-2.5 py-1 text-xs text-white">
              <span className={cx('h-2 w-2 shrink-0 rounded-full', stateText ? 'bg-warn' : 'bg-ok')} aria-hidden />
              <span className="truncate">{stateText || rateText}</span>
            </div>
          )}
          <div className="sr-only" role="status" aria-live="polite">
            {phase === 'starting' ? t('Verbinden…') : stateText}
          </div>
          {(phase === 'ended' || phase === 'failed') && (
            <div className="absolute inset-0 flex items-center justify-center p-6">
              <div className="max-w-sm space-y-4 rounded-2xl border border-line bg-surface p-5 text-center">
                <p className="text-sm leading-relaxed" role="alert">
                  {phase === 'failed' ? problem : endText(ended || 'ended', idleMinutes)}
                </p>
                <div className="flex flex-wrap justify-center gap-2">
                  {(phase === 'failed' || !FINAL.has(ended || '')) && (
                    <Button variant="primary" onClick={reconnect}>
                      Opnieuw verbinden
                    </Button>
                  )}
                  <Button onClick={leave}>Terug</Button>
                </div>
              </div>
            </div>
          )}
        </div>

        {keyboard && phase === 'live' && (
          <div className="safe-bottom safe-x shrink-0 space-y-2 border-t border-line bg-canvas px-2 pt-2">
            <div className="flex items-center gap-2">
              <input
                value={text}
                onChange={(e) => onText(e.target.value)}
                onKeyDown={onTextKey}
                autoFocus
                autoCapitalize="off"
                autoCorrect="off"
                autoComplete="off"
                spellCheck={false}
                enterKeyHint="send"
                aria-label="Typ op de computer"
                placeholder="Typ hier; het verschijnt op de computer"
                className="h-11 min-w-0 flex-1 rounded-[10px] border border-line bg-surface-2 px-3 text-base text-fg outline-none placeholder:text-muted focus:border-muted"
              />
              <Button variant="ghost" size="icon" icon={<X className="h-5 w-5" />} aria-label="Toetsenbord sluiten" onClick={() => setKeyboard(false)} />
            </div>
            <div className="scroll-thin -mx-2 flex gap-1.5 overflow-x-auto px-2 pb-2" role="toolbar" aria-label="Toetsen">
              {KEY_BUTTONS.map((k) => (
                <button
                  key={k.keys}
                  type="button"
                  aria-label={k.aria}
                  onClick={() => send({ type: 'key', keys: k.keys })}
                  className="h-11 min-w-11 shrink-0 rounded-[10px] border border-line bg-surface-2 px-3 text-sm font-semibold text-fg hover:bg-surface-3"
                >
                  {k.label}
                </button>
              ))}
            </div>
          </div>
        )}
      </main>

      <Modal open={options} onClose={() => setOptions(false)} title="Opties">
        <div className="space-y-4">
          {monitors.length > 1 && (
            <Field label="Scherm">
              <Select value={String(monitor)} onChange={(e) => setMonitor(Number(e.target.value))}>
                {monitors.map((m, i) => (
                  <option key={m.index} value={m.index}>
                    {m.primary ? t('Scherm {0} · {1}×{2} · hoofdscherm', i + 1, m.w, m.h) : t('Scherm {0} · {1}×{2}', i + 1, m.w, m.h)}
                  </option>
                ))}
              </Select>
            </Field>
          )}
          <Field label="Beeldkwaliteit" hint={t('Nu: {0}. Automatisch kiest een kleiner en ruwer beeld als de verbinding traag is.', levelText)}>
            <Select value={quality} onChange={(e) => setQuality(e.target.value as QualityChoice)}>
              <option value="auto">Automatisch</option>
              <option value="sharp">Scherp</option>
              <option value="normal">Gemiddeld</option>
              <option value="fast">Snel</option>
              <option value="saver">Zuinig (trage verbinding)</option>
            </Select>
          </Field>
          <div className="space-y-1">
            <Toggle checked={viewOnly} disabled={!control} onChange={toggleView} label={<span className="inline-flex items-center gap-1.5">{viewOnly ? <EyeOff className="h-4 w-4" aria-hidden /> : <Eye className="h-4 w-4" aria-hidden />} Alleen kijken (tikken doet niets)</span>} />
            {!control && <p className="text-xs text-muted">Op de computer staat ingesteld dat je alleen kunt meekijken.</p>}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button size="sm" icon={<ZoomIn className="h-4 w-4" />} onClick={() => zoomBy(1.5)}>
              Inzoomen
            </Button>
            <Button size="sm" icon={<ZoomOut className="h-4 w-4" />} onClick={() => zoomBy(1 / 1.5)}>
              Uitzoomen
            </Button>
            <Button size="sm" icon={<Maximize2 className="h-4 w-4" />} onClick={() => setView(NO_ZOOM)}>
              Hele scherm
            </Button>
          </div>
        </div>
      </Modal>

      <Modal open={help} onClose={() => setHelp(false)} title="Zo bedien je de computer">
        <ul className="list-disc space-y-1.5 ps-5 text-sm leading-relaxed">
          <li>Tik: klikken. Twee keer snel tikken: dubbelklikken.</li>
          <li>Even vasthouden: rechtsklikken. Vasthouden en slepen: verslepen.</li>
          <li>Slepen met één vinger: als je hebt ingezoomd verschuif je het beeld, anders sleep je met de muis.</li>
          <li>Twee vingers samen schuiven: scrollen. Knijpen: in- en uitzoomen. Kort tikken met twee vingers: rechtsklikken.</li>
          <li>Toetsenbord-knop: typen en toetsen zoals Enter, Esc en Alt+Tab.</li>
          <li>Muis en toetsenbord werken gewoon: klik in het beeld om te typen (Shift+Esc om terug te gaan).</li>
          <li>Opties: ander scherm, beeldkwaliteit en alleen kijken.</li>
          <li>TeamBot zelf is in het beeld afgedekt en kun je op afstand niet bedienen. Op de computer staat een balk met Stop zolang je meekijkt.</li>
        </ul>
      </Modal>
    </div>
  );
}
