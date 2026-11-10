import { useCallback, useEffect, useRef, useState } from 'react';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { AUTO, MAX_RENEW, type Device, type Ticket } from './parts';

// ------------------------------------------------------------------ pairing (state shared by the card and Meer opties)

/** The last code of this page session: opening Telefoon again shows it while it is still valid (no new code each time). */
let lastTicket: { ticket: Ticket; base: string; user: string } | null = null;
const meId = () => useApp.getState().me?.id || '';

type PairStatus = 'waiting' | 'used' | 'expired' | 'cancelled';
export interface Pairing {
  ticket: Ticket | null;
  status: PairStatus;
  paired: Device | null;
  left: number;
  busy: boolean;
  error: string;
  /** The base of the current code: `AUTO` or the address chosen under Meer opties. */
  base: string;
  /** A new code: `AUTO` (TeamBot chooses, the TeamBot connection on) or an address from Meer opties. */
  make(base?: string): Promise<void>;
  /** Show the last code of this session again if it still has a minute, else make a new one. */
  start(): void;
  /** Put the code away (a phone is already connected). */
  close(): void;
}

export function usePairing(onMade: () => void): Pairing {
  const [ticket, setTicket] = useState<Ticket | null>(null);
  const [status, setStatus] = useState<PairStatus>('waiting');
  const [paired, setPaired] = useState<Device | null>(null);
  const [left, setLeft] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const base = useRef(AUTO);
  const renewals = useRef(0);
  const made = useRef(onMade);
  made.current = onMade;

  const make = useCallback(async (b: string = AUTO) => {
    base.current = b;
    setBusy(true);
    setError('');
    try {
      const tk = await api.post<Ticket>('/mobile/pair', { baseUrl: b });
      lastTicket = { ticket: tk, base: b, user: meId() };
      setTicket(tk);
      setStatus('waiting');
      setPaired(null);
      // The TeamBot connection may just have been switched on: Meer opties shows it.
      made.current();
    } catch (e: any) {
      setTicket(null);
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  const start = useCallback(() => {
    const last = lastTicket;
    // Only the signed-in person's own code (in server mode someone else may sign in on this page without a reload).
    if (last && last.user === meId() && Date.parse(last.ticket.expires_at) - Date.now() > 60_000) {
      base.current = last.base;
      setTicket(last.ticket);
      setStatus('waiting');
      setPaired(null);
      return;
    }
    void make(AUTO);
  }, [make]);

  // Countdown.
  useEffect(() => {
    if (!ticket) return;
    const tick = () => {
      const s = Math.max(0, Math.round((Date.parse(ticket.expires_at) - Date.now()) / 1000));
      setLeft(s);
      if (s === 0) setStatus((st) => (st === 'waiting' ? 'expired' : st));
    };
    tick();
    const i = setInterval(tick, 1000);
    return () => clearInterval(i);
  }, [ticket]);

  // Live: the phone claimed the code (event), with a slow poll as a fallback.
  useEffect(() => {
    if (!ticket || status !== 'waiting') return;
    const off = on('mobile.paired', (d: any) => {
      if (d?.ticket !== ticket.id) return;
      setStatus('used');
      setPaired(d.device || null);
      lastTicket = null;
    });
    const i = setInterval(() => {
      api
        .get(`/mobile/pair/${ticket.id}`)
        .then((r) => {
          if (r.status === 'waiting') return;
          setStatus(r.status);
          if (r.device) setPaired(r.device);
          if (r.status === 'used') lastTicket = null;
        })
        .catch(() => undefined);
    }, 4000);
    return () => {
      off();
      clearInterval(i);
    };
  }, [ticket, status]);

  // An expired code is renewed by itself while the page is in view (a few times), so it is ready when the app is.
  useEffect(() => {
    if (status !== 'expired' || renewals.current >= MAX_RENEW) return;
    const renew = () => {
      if (document.visibilityState !== 'visible') return false;
      renewals.current++;
      void make(base.current);
      return true;
    };
    if (renew()) return;
    const onVis = () => renew() && document.removeEventListener('visibilitychange', onVis);
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [status, make]);

  const close = useCallback(() => {
    lastTicket = null;
    setTicket(null);
    setError('');
  }, []);

  return {
    ticket,
    status,
    paired,
    left,
    busy,
    error,
    base: base.current,
    make,
    start,
    close,
  };
}

export function useDevices() {
  const [list, setList] = useState<Device[] | null>(null);
  const [err, setErr] = useState('');
  const load = useCallback(() => {
    api
      .get<Device[]>('/mobile/devices')
      .then((l) => {
        setList(l);
        setErr('');
      })
      .catch((e) => setErr(e.message));
  }, []);
  useEffect(() => {
    load();
    const a = on('mobile.devices.updated', load);
    const b = on('mobile.paired', load);
    return () => {
      a();
      b();
    };
  }, [load]);
  return { list, err, load };
}
