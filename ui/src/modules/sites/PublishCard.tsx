import { useEffect, useState } from 'react';
import { formatBytes } from '../../lib/format';
import { CircleAlert, Globe, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { agentById } from '../../lib/store';
import type { Approval } from '../../lib/types';
import { BotAvatar } from '../../components/BotFace';
import { MoreInfo } from '../../components/MoreInfo';
import { Button, Spinner, timeAgo } from '../../components/ui';
import { REACH, type Reach } from './api';
import { useDecide } from '../../shell/approvalDecide';

interface Preview {
  ok: boolean;
  problem: string | null;
  folder: string;
  files: number;
  bytes: number;
  skipped: number;
  skippedText: string;
  entry: string | null;
  reach: Reach;
  reachLabel: string;
  reachText: string;
  expiresDays: number;
  title: string;
  update: { id: string; title: string; state: string } | null;
  hosts: { label: string; host: string }[];
  canPublish: boolean;
}

function Row({ k, children }: { k: string; children: React.ReactNode }) {
  return (
    <div className="grid gap-0.5 sm:grid-cols-[8.5rem_1fr] sm:gap-3">
      <dt className="text-muted">{k}</dt>
      <dd className="min-w-0">{children}</dd>
    </div>
  );
}

/**
 * Approval card of site_publish: which folder, how many files and how big, the start page, who can open it (and on
 * which address), when it goes offline — and what would go wrong. Never "Altijd toestaan": publishing always asks.
 */
export function SitePublishCard({ a, showThreadLink }: { a: Approval; showThreadLink?: boolean }) {
  const agent = agentById(a.agent_id);
  const [p, setP] = useState<Preview | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { busy, decide } = useDecide(a);
  useEffect(() => {
    let alive = true;
    api
      .get<Preview>(`/sites/preview/${a.id}`)
      .then((x) => alive && setP(x))
      .catch((e) => alive && setErr(e?.message || String(e)));
    return () => {
      alive = false;
    };
  }, [a.id]);
  const reach: Reach = (p?.reach || a.input?.reach || 'local') as Reach;
  const title = p?.title || String(a.input?.title || '') || String(a.input?.path || 'Website');
  const days = p?.expiresDays ?? (Number(a.input?.expires_days) || 0);
  return (
    <div role="group" aria-label="Website publiceren" className="w-full rounded-2xl border tb-ask-danger p-4">
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <BotAvatar bot={agent || { id: a.agent_id || 'bot', name: 'bot' }} size={20} mood="waiting" />
        <span>
          <span className="font-semibold text-fg">{agent?.name || 'Bot'}</span> wil een website publiceren
        </span>
        <span aria-hidden>·</span>
        <span>{timeAgo(a.created_at)}</span>
        {showThreadLink && a.thread_id && (
          <>
            <span aria-hidden>·</span>
            <a className="font-semibold underline underline-offset-2 hover:text-fg" href={`#/t/${a.thread_id}`}>
              naar gesprek
            </a>
          </>
        )}
      </div>
      <div className="mt-3 flex items-start gap-3">
        <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-surface-3 text-fg">
          <Globe className="h-5 w-5" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="break-words text-[15px] font-bold leading-snug">{title}</div>
          <div className="text-[13px] text-muted">{p?.update ? 'Werkt de bestaande site bij; de link blijft hetzelfde.' : 'Een nieuwe site met een eigen, moeilijk te raden link.'}</div>
        </div>
      </div>
      {!p && !err ? (
        <div className="mt-3 flex items-center gap-2 text-[13px] text-muted">
          <Spinner /> Map bekijken…
        </div>
      ) : (
        <dl className="mt-3 space-y-2 rounded-xl bg-surface px-3.5 py-3 text-[13px]">
          <Row k="Map">
            <span className="break-all font-mono text-[12.5px]" translate="no">
              {p?.folder || String(a.input?.path || '.')}
            </span>
          </Row>
          {p && p.files > 0 && (
            <Row k="Inhoud">
              {t('{0, plural, one {# bestand} other {# bestanden}} · {1}', p.files, formatBytes(p.bytes))}
              {p.entry ? (
                <>
                  {' '}
                  · start: <span translate="no">{p.entry}</span>
                </>
              ) : null}
              {p.skippedText && <span className="block text-muted">Gaan niet mee: {p.skippedText}.</span>}
            </Row>
          )}
          <Row k="Wie kan erbij">
            <span className="font-semibold">{p?.reachLabel || REACH[reach].label}</span> — {p?.reachText || REACH[reach].text}
            {p && p.hosts.length > 0 && reach !== 'local' && (
              <span className="block text-muted">
                Via <span translate="no">{p.hosts.filter((h) => h.label !== 'Op deze computer').map((h) => h.host).join(', ') || p.hosts[0].host}</span>. <MoreInfo>Windows kan de eerste keer vragen of TeamBot op je netwerk mag; kies dan “Privénetwerken”.</MoreInfo>
              </span>
            )}
          </Row>
          <Row k="Offline">{days === 1 ? 'Na 1 dag' : days ? `Na ${days} dagen` : 'Niet automatisch; je stopt hem zelf op de pagina Websites'}</Row>
        </dl>
      )}
      {(p?.problem || err) && (
        <div className="mt-2 flex items-start gap-2 rounded-control bg-danger-soft px-3 py-2 text-[13px] text-danger">
          <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
          <span>{p?.problem || err}</span>
        </div>
      )}
      <div className="mt-3 flex items-start gap-2 text-[13px] text-muted">
        <ShieldCheck className="mt-0.5 h-3.5 w-3.5 shrink-0 text-fg" aria-hidden />
        <span>
          Niet op het openbare internet. <MoreInfo>De site draait afgeschermd van TeamBot. Verborgen bestanden en geheimen gaan niet mee.</MoreInfo>
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Button variant="primary" size="sm" icon={<Globe className="h-4 w-4" />} loading={busy === 'approve'} disabled={!!busy || p?.canPublish === false} onClick={() => decide('approve')}>
          Publiceren
        </Button>
        <Button size="sm" variant="ghost" loading={busy === 'deny'} disabled={!!busy} onClick={() => decide('deny')}>
          Weigeren
        </Button>
      </div>
    </div>
  );
}
