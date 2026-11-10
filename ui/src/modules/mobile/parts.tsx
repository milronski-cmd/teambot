import type React from 'react';
import { Copy } from 'lucide-react';
import { Button, Card, cx, toast } from '../../components/ui';

export interface Candidate {
  kind: string;
  url: string;
  label: string;
  secure: boolean;
  ready: boolean;
  note: string;
}
export interface Reach {
  mode: 'desktop' | 'server';
  isAdmin: boolean;
  server: {
    host?: string;
    port: number;
    listensOnAll?: boolean;
    loopbackOnly?: boolean;
  };
  gateway: {
    enabled?: boolean;
    bind?: 'all' | 'tailscale' | 'loopback';
    port?: number | null;
    defaultPort?: number;
    running: boolean;
    address?: string | null;
    error?: string | null;
  };
  tailscale: {
    installed: boolean;
    running: boolean;
    ips: string[];
    dnsName: string | null;
    detail: string;
  } | null;
  lan: { address: string; iface: string }[];
  candidates: Candidate[];
  tunnelTarget: string | null;
  policyActive: boolean;
  /** The TeamBot connection (iroh): reachable at home and away without Tailscale. */
  iroh: {
    available: boolean;
    enabled?: boolean;
    running: boolean;
    id?: string | null;
    relay?: { own: string | null; home: string | null; online: boolean };
    error?: string | null;
    phones?: number;
    last?: {
      at: string;
      path: 'direct' | 'relay' | null;
      rttMs: number | null;
    } | null;
    /** Switched off on purpose: the card does not switch it on again by itself. */
    offOnPurpose?: boolean;
  };
  /** Where to get the iPhone app (TEAMBOT_IOS_APP_URL); null: through TestFlight. */
  app?: { ios: string | null };
}
export interface Device {
  id: string;
  name: string;
  platform: 'ios' | 'android' | 'other';
  client: string;
  created_at: string;
  last_seen: string | null;
  status: 'active' | 'revoked';
  push: boolean;
  apns: boolean;
  current: boolean;
}
export interface Ticket {
  id: string;
  url: string;
  code: string;
  qr: string;
  base_url: string;
  expires_at: string;
  ttl: number;
  /** 'iroh': only through the TeamBot connection (the iPhone app scans it); 'both': the address plus that. */
  via?: 'iroh' | 'both' | 'address';
  /** What TeamBot chose by itself (baseUrl 'auto', 0.4.5). */
  auto?: { kind: string; label: string };
}
export interface PushInfo {
  publicKey: string;
  prefs: {
    approvals: boolean;
    agent: boolean;
    runDone: boolean;
    preview: boolean;
    alwaysPhone: boolean;
  };
  subscriptions: {
    id: string;
    label: string;
    created_at: string;
    last_ok: string | null;
    last_error: string | null;
    current: boolean;
  }[];
  subscribed: boolean;
  apns: { configured: boolean; detail: string };
  device: boolean;
  /** Where the owner is, as the desktop app reports it (0.4.4, P8; 0.4.5: away after 3 minutes). */
  presence?: {
    where: 'pc' | 'away' | 'unknown';
    locked: boolean;
    awayAfterSeconds: number;
  };
}

/** POST /mobile/pair with this base: TeamBot picks how the phone reaches this computer (the TeamBot connection first). */
export const AUTO = 'auto';
/** The TestFlight app in the App Store (Apple's own app for test versions). */
export const TESTFLIGHT_APP = 'https://apps.apple.com/app/testflight/id899247664';
/** A code that expired while the page was open is renewed by itself this many times (5 minutes each), then a button. */
export const MAX_RENEW = 6;

export const platformLabel = (p: string) => (p === 'ios' ? 'iPhone/iPad' : p === 'android' ? 'Android' : 'Telefoon');
export const clientLabel = (c: string) => (c === 'ios-app' ? 'iPhone-app' : c === 'pwa' ? 'app op beginscherm' : 'browser');
export const isLoopbackUrl = (u: string) => {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h.startsWith('127.') || h === '[::1]';
  } catch {
    return false;
  }
};
export const linkButton = 'inline-flex h-9 shrink-0 items-center gap-2 rounded-[10px] border border-line bg-surface-2 px-3.5 text-sm font-semibold text-fg hover:bg-surface-3 coarse:h-11';

export function Section({ icon, title, subtitle, children, actions, testId }: { icon: React.ReactNode; title: string; subtitle?: React.ReactNode; children: React.ReactNode; actions?: React.ReactNode; testId?: string }) {
  return (
    <Card className="overflow-hidden" data-testid={testId}>
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div className="flex min-w-0 items-start gap-2.5">
          <div className="mt-0.5 text-accent">{icon}</div>
          <div className="min-w-0">
            <h2 className="font-semibold">{title}</h2>
            {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
          </div>
        </div>
        {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
      </div>
      <div className="space-y-3 px-4 py-4">{children}</div>
    </Card>
  );
}

export function Note({ tone = 'neutral', children }: { tone?: 'neutral' | 'warn' | 'danger' | 'ok'; children: React.ReactNode }) {
  const t = {
    neutral: 'bg-surface-2 text-muted',
    warn: 'bg-warn-soft text-warn',
    danger: 'bg-danger-soft text-danger',
    ok: 'bg-ok-soft text-ok',
  }[tone];
  return <div className={cx('rounded-lg px-3 py-2 text-sm', t)}>{children}</div>;
}

export async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Gekopieerd', 'ok');
  } catch {
    toast('Kopiëren lukt hier niet; selecteer de tekst en kopieer handmatig', 'danger');
  }
}

export function Command({ text }: { text: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-line bg-surface-2 px-2 py-1.5">
      <code className="min-w-0 flex-1 overflow-x-auto whitespace-nowrap font-mono text-xs">{text}</code>
      <Button size="sm" variant="ghost" onClick={() => copy(text)} aria-label="Kopieer opdracht" icon={<Copy className="h-3.5 w-3.5" />} />
    </div>
  );
}
