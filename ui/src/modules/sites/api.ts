import { toast } from '../../components/ui';
import { formatBytes } from '../../lib/format';

export type Reach = 'local' | 'lan' | 'tailnet';

export interface SiteView {
  id: string;
  title: string;
  source: string;
  entry: string;
  reach: Reach;
  reachLabel: string;
  reachText: string;
  state: 'live' | 'stopped' | 'expired';
  urls: { url: string; label: string }[];
  files: number;
  bytes: number;
  skipped: number;
  expires_days: number;
  expires_at: string | null;
  published_at: string | null;
  views: number;
  last_view_at: string | null;
  created_at: string;
  agent: { id: string; name: string; avatar: string } | null;
  sourceExists: boolean;
}

export interface SitesInfo {
  port: number;
  listening: boolean;
  host: string | null;
  lan: string[];
  tailnet: string[];
  canPublish: boolean;
  mode: 'desktop' | 'server';
}

export const REACH: Record<Reach, { label: string; text: string }> = {
  local: { label: 'Alleen deze computer', text: 'Alleen te openen op de computer waarop TeamBot draait.' },
  lan: { label: 'Je netwerk', text: 'Iedereen op hetzelfde (wifi-)netwerk die de link heeft.' },
  tailnet: { label: 'Je tailnet', text: 'Je eigen apparaten via Tailscale die de link hebben.' },
};

export const fmtBytes = (n: number) => formatBytes(n);

/** Copy text; falls back to a hidden textarea where the clipboard API is missing (http on a phone). */
export async function copyText(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return toast('Link gekopieerd', 'ok');
    }
  } catch {
    /* fall back below */
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  toast(ok ? 'Link gekopieerd' : 'Kopiëren lukt hier niet; houd de link ingedrukt om hem te kopiëren', ok ? 'ok' : 'danger');
}
