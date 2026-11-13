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

