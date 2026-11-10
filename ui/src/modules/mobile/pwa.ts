import { api } from '../../lib/api';

export type Platform = 'ios' | 'android' | 'desktop';

export function platform(): Platform {
  const ua = navigator.userAgent;
  if (/iPhone|iPad|iPod/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  return 'desktop';
}
export const isStandalone = () => (typeof matchMedia === 'function' && matchMedia('(display-mode: standalone)').matches) || (navigator as any).standalone === true;
/** The native iOS companion (WKWebView) appends "TeamBotiOS/<version>" to the user agent. */
export const isNativeApp = () => /TeamBotiOS\//.test(navigator.userAgent);

/** The native shell's message channel; it only understands a few fixed words (never code or data). */
const nativeChannel = (): { postMessage(word: string): void } | null => (isNativeApp() ? (window as any).webkit?.messageHandlers?.teambot || null : null);
/** The iPhone app is new enough to have its own settings (consent, connection, unpair). */
export const hasNativeSettings = () => !!nativeChannel();
/** Ask the iPhone app to open its settings, or to check its link now (after unpairing from the web page). */
export function tellNativeApp(word: 'settings' | 'unauthorized'): boolean {
  const ch = nativeChannel();
  if (!ch) return false;
  try {
    ch.postMessage(word);
    return true;
  } catch {
    return false;
  }
}
export const pushSupported = () => typeof window !== 'undefined' && window.isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

let reg: Promise<ServiceWorkerRegistration | null> | null = null;

/** Register /sw.js (offline shell + push). Needs a secure context (https or localhost). */
export function registerSW(): Promise<ServiceWorkerRegistration | null> {
  if (typeof window === 'undefined' || !window.isSecureContext || !('serviceWorker' in navigator)) return Promise.resolve(null);
  if (!reg)
    reg = navigator.serviceWorker.register('/sw.js', { scope: '/' }).catch((e) => {
      console.warn('[mobile] service worker niet geregistreerd', e);
      return null;
    });
  return reg;
}

// ---------- install prompt (Chrome/Edge/Android) ----------
let deferred: any = null;
const installListeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferred = e;
    installListeners.forEach((f) => f());
  });
  window.addEventListener('appinstalled', () => {
    deferred = null;
    installListeners.forEach((f) => f());
  });
}
export const canPromptInstall = () => !!deferred;
export function onInstallChange(f: () => void) {
  installListeners.add(f);
  return () => installListeners.delete(f);
}
export async function promptInstall(): Promise<string> {
  const d = deferred;
  if (!d) return 'unavailable';
  deferred = null;
  await d.prompt();
  const choice = await d.userChoice.catch(() => null);
  installListeners.forEach((f) => f());
  return choice?.outcome || 'dismissed';
}

// ---------- Web Push ----------
function keyBytes(b64url: string): Uint8Array<ArrayBuffer> {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob(b64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}
function sameKey(sub: PushSubscription, publicKey: string) {
  const k = sub.options?.applicationServerKey;
  if (!k) return false;
  const a = new Uint8Array(k);
  const b = keyBytes(publicKey);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

export async function currentSubscription(): Promise<PushSubscription | null> {
  if (!pushSupported()) return null;
  const r = await registerSW();
  return r ? r.pushManager.getSubscription() : null;
}

/** Must be called from a user gesture (iOS requires it). */
export async function enablePush(publicKey: string) {
  if (!pushSupported()) throw new Error('Deze browser ondersteunt hier geen pushmeldingen');
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Meldingen zijn geblokkeerd. Zet ze aan in de instellingen van je browser of telefoon.' : 'Geen toestemming voor meldingen gekregen');
  const r = await registerSW();
  if (!r) throw new Error('Service worker niet beschikbaar (https nodig)');
  await navigator.serviceWorker.ready;
  let sub = await r.pushManager.getSubscription();
  if (sub && !sameKey(sub, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  if (!sub) sub = await r.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  await api.post('/mobile/push/subscribe', { subscription: sub.toJSON() });
}

export async function disablePush() {
  const sub = await currentSubscription().catch(() => null);
  if (sub) {
    await api.post('/mobile/push/unsubscribe', { endpoint: sub.endpoint });
    await sub.unsubscribe().catch(() => undefined);
  } else await api.post('/mobile/push/unsubscribe', {});
}

/** Keep the server's copy in sync (e.g. after the server lost it or the browser rotated the endpoint). */
export async function syncPush() {
  if (!pushSupported() || Notification.permission !== 'granted') return;
  const sub = await currentSubscription();
  if (sub) await api.post('/mobile/push/subscribe', { subscription: sub.toJSON() });
}
