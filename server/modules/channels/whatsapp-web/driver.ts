/**
 * Transport for WhatsApp as a linked device ("WhatsApp Web", multi-device). The channel adapter only talks to
 * this interface, so the real implementation (whatsapp-web.js in a headless Edge/Chrome, see wwebjs.ts) can be
 * swapped for a fake socket in tests, or later for another permissive library.
 */

export type WaKind = 'text' | 'image' | 'video' | 'audio' | 'voice' | 'document' | 'sticker' | 'location' | 'contact' | 'other';

export interface WaMedia {
  name: string;
  mime: string;
  size?: number;
  fetch(): Promise<Buffer>;
}

/** One message as the driver saw it. Everything here is untrusted data from WhatsApp. */
export interface WaIncoming {
  /** Raw WhatsApp message id (unique per chat); used for dedupe and to recognise quoted replies. */
  id: string;
  /** The full (serialized) message id, for a reaction on this message; absent when the driver cannot react. */
  key?: string;
  /** Chat jid: 31612345678@c.us, 1234567890@lid, 1203…@g.us. */
  chatId: string;
  fromMe: boolean;
  /** The "message yourself" chat of the linked account. */
  selfChat: boolean;
  isGroup: boolean;
  chatTitle?: string;
  /** Phone number (digits) of the author when known; for LID-only contacts null. */
  senderPhone: string | null;
  senderJid: string;
  senderName: string;
  kind: WaKind;
  body: string;
  media?: WaMedia;
  /** Raw id of the message this one quotes (reply), if any. */
  quotedId?: string;
  /** The linked account was @mentioned (groups). */
  mentionsMe?: boolean;
  /** Epoch ms. */
  timestamp: number;
  /** Status updates, channels, broadcast lists: never routed. */
  broadcast?: boolean;
}

export interface WaMe {
  jid: string;
  phone: string;
  name: string;
}

export interface WaOutFile {
  path: string;
  name: string;
  mime: string;
}

export interface WaDriverEvents {
  qr(qr: string): void;
  code(code: string): void;
  loading(percent: number): void;
  authenticated(): void;
  ready(me: WaMe): void;
  message(m: WaIncoming): void;
  /** Connection lost. `loggedOut`: the device was unlinked (on the phone or by WhatsApp); a new QR scan is needed. */
  disconnected(reason: string, loggedOut: boolean): void;
  authFailure(message: string): void;
}

export interface WaDriver {
  on<K extends keyof WaDriverEvents>(event: K, fn: WaDriverEvents[K]): void;
  /** Launch and connect; resolves once the client is waiting for a QR scan or restoring the session. */
  start(): Promise<void>;
  /** Close the connection and keep the (encrypted) session for next time. */
  stop(): Promise<void>;
  /** Unlink this device in WhatsApp and wipe the session. */
  logout(): Promise<void>;
  /** Link with a phone number instead of a QR code ("Link with phone number"); returns the 8-character code. */
  requestPairingCode(phone: string): Promise<string>;
  sendText(chatId: string, text: string): Promise<string>;
  sendFile(chatId: string, file: WaOutFile, caption?: string): Promise<string>;
  typing(chatId: string): Promise<void>;
  /** Put an emoji reaction on a message (`WaIncoming.key`); '' removes it. */
  react?(messageKey: string, emoji: string): Promise<void>;
  /** Phone number (digits) → chat jid, or null when the number has no WhatsApp. */
  resolveNumber(phone: string): Promise<string | null>;
}

export interface DriverOptions {
  bindingId: string;
  /** Private per-binding directory (profile + encrypted session). */
  dir: string;
  /** 32-byte key for the encrypted session archive (kept in the TeamBot vault). */
  sessionKey: Buffer;
  /** Explicit browser executable (else Edge/Chrome/Chromium is detected). */
  browserPath?: string;
  /** Device name shown on the phone under "Linked devices". */
  deviceName: string;
  log(text: string): void;
}

export type DriverFactory = (o: DriverOptions) => WaDriver;

/** Digits of a phone number or a c.us jid ("+31 6-1234 5678", "31612345678@c.us" → "31612345678"). */
export function phoneDigits(v: string | null | undefined): string {
  const s = String(v || '');
  if (/@(lid|g\.us|broadcast|newsletter)$/.test(s)) return '';
  return s.replace(/@.*$/, '').replace(/[^\d]/g, '');
}

/** Small typed event hub drivers can extend. */
export class DriverEmitter {
  private handlers = new Map<string, Set<(...a: any[]) => void>>();
  on<K extends keyof WaDriverEvents>(event: K, fn: WaDriverEvents[K]) {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set());
    this.handlers.get(event)!.add(fn as any);
  }
  protected emit<K extends keyof WaDriverEvents>(event: K, ...args: Parameters<WaDriverEvents[K]>) {
    for (const fn of this.handlers.get(event) || []) {
      try {
        fn(...args);
      } catch {
        /* a listener must never break the driver */
      }
    }
  }
}
