import { useEffect, useState } from 'react';
import { CircleStop, Copy, ExternalLink, Globe, House, Laptop, Link2, RefreshCw, Trash2, Wifi } from 'lucide-react';
import { api, on } from '../../lib/api';
import { BotAvatar } from '../../components/BotFace';
import { MoreInfo } from '../../components/MoreInfo';
import { Menu, SkeletonCards } from '../../components/overview';
import { askConfirm, Badge, Button, Card, EmptyState, Field, Modal, Page, PageHeader, Select, Spinner, timeAgo, toast, toastError } from '../../components/ui';
import { t, uiLocale } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { REACH, copyText, fmtBytes, type Reach, type SiteView, type SitesInfo } from './api';

const REACH_ICON: Record<Reach, typeof Laptop> = { local: Laptop, lan: Wifi, tailnet: House };
const DAYS = [0, 1, 7, 30, 90];
const daysLabel = (d: number) => (d === 1 ? '1 dag' : d ? `${d} dagen` : 'Niet');

function StateBadge({ s }: { s: SiteView }) {
  if (s.state === 'live') return <Badge tone="ok">Online</Badge>;
  if (s.state === 'expired') return <Badge tone="warn">Verlopen</Badge>;
  return <Badge>Gestopt</Badge>;
}

function expiryText(s: SiteView): string {
  if (!s.expires_at) return 'Verloopt niet.';
  const d = new Date(s.expires_at);
  const when = d.toLocaleDateString(uiLocale(), { day: 'numeric', month: 'long' }) + ' ' + d.toLocaleTimeString(uiLocale(), { hour: '2-digit', minute: '2-digit' });
  return s.state === 'expired' ? `Verlopen op ${when}.` : `Verloopt op ${when}.`;
}

/** Publish again: the folder's current content, same link; optionally another reach or expiry. */
function RepublishModal({ site, info, onClose }: { site: SiteView; info: SitesInfo; onClose(): void }) {
  const [reach, setReach] = useState<Reach>(site.reach);
  const [days, setDays] = useState<number>(site.expires_days || 0);
  const [busy, setBusy] = useState(false);
  const can: Record<Reach, boolean> = { local: true, lan: info.lan.length > 0, tailnet: info.tailnet.length > 0 };
  const go = async () => {
    setBusy(true);
    try {
      await api.post(`/sites/${site.id}/republish`, { reach, expires_days: days });
      toast(`“${site.title}” staat weer online`, 'ok');
      onClose();
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title="Opnieuw publiceren"
      footer={
        <>
          <Button onClick={onClose}>Annuleren</Button>
          <Button variant="primary" loading={busy} disabled={!site.sourceExists} onClick={go}>
            Publiceren
          </Button>
        </>
      }
    >
      <div className="space-y-4">
        <p className="text-sm text-muted">
          TeamBot neemt de huidige inhoud van de map <span className="break-all font-mono text-[12.5px] text-fg" translate="no">{site.source}</span>. De link blijft hetzelfde.
        </p>
        {!site.sourceExists && <p className="rounded-control bg-danger-soft px-3 py-2 text-sm text-danger">Deze map bestaat niet meer. Vraag de bot de site opnieuw te maken.</p>}
        <Field label="Wie kan de site openen" hint={reach !== 'local' ? 'Windows kan de eerste keer vragen of TeamBot op je netwerk mag. Kies dan “Privénetwerken”.' : REACH.local.text}>
          <Select value={reach} onChange={(e) => setReach(e.target.value as Reach)}>
            {(['local', 'lan', 'tailnet'] as Reach[]).map((r) => (
              <option key={r} value={r} disabled={!can[r]}>
                {REACH[r].label}
                {can[r] ? '' : ' (niet beschikbaar op deze computer)'}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Automatisch offline na">
          <Select value={String(days)} onChange={(e) => setDays(Number(e.target.value))}>
            {[...new Set([...DAYS, days])].sort((a, b) => a - b).map((d) => (
              <option key={d} value={d}>
                {daysLabel(d)}
              </option>
            ))}
          </Select>
        </Field>
      </div>
    </Modal>
  );
}

function SiteCard({ s, info, onRepublish }: { s: SiteView; info: SitesInfo; onRepublish(): void }) {
  const [busy, setBusy] = useState<string | null>(null);
  const live = s.state === 'live';
  const main = s.urls[0];
  const ReachIcon = REACH_ICON[s.reach];
  const act = async (key: string, fn: () => Promise<any>, ok?: string) => {
    setBusy(key);
    try {
      await fn();
      if (ok) toast(ok, 'ok');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const stop = async () => (await askConfirm(`“${s.title}” offline halen? De link werkt daarna niet meer.`, { ok: 'Stoppen', danger: true })) && act('stop', () => api.post(`/sites/${s.id}/stop`), 'Site gestopt');
  const remove = async () => (await askConfirm(`“${s.title}” uit de lijst verwijderen? De bestanden in de map van de bot blijven staan.`, { ok: 'Verwijderen', danger: true })) && act('del', () => api.del(`/sites/${s.id}`), 'Verwijderd');
  return (
    <Card className="tb-in space-y-3 p-4">
      <div className="flex items-start gap-3">
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-control bg-surface-2 text-muted">
          <Globe className="h-4 w-4" aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <h2 className="min-w-0 text-sm font-semibold [overflow-wrap:anywhere]">{s.title}</h2>
            <StateBadge s={s} />
          </div>
          <div className="mt-0.5 flex flex-wrap items-center gap-x-1.5 text-[13px] text-muted">
            {s.agent && (
              <>
                <span className="inline-flex items-center gap-1">
                  <BotAvatar bot={s.agent} size={16} /> {s.agent.name}
                </span>
                <span aria-hidden>·</span>
              </>
            )}
            <span className="inline-flex items-center gap-1" title={s.reachText}>
              <ReachIcon className="h-3.5 w-3.5" aria-hidden /> {s.reachLabel}
            </span>
            {live && s.expires_at && (
              <>
                <span aria-hidden>·</span>
                <span>{expiryText(s).replace(/\.$/, '')}</span>
              </>
            )}
          </div>
        </div>
        {live && main && (
          <Button size="sm" className="hidden sm:inline-flex" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copyText(main.url)}>
            Link kopiëren
          </Button>
        )}
        <Menu
          label={t('Meer opties voor {0}', s.title)}
          items={[
            live && !!main && { label: 'Openen', icon: <ExternalLink />, onSelect: () => void window.open(main.url, '_blank', 'noopener,noreferrer') },
            live && !!main && { label: 'Link kopiëren', icon: <Copy />, onSelect: () => void copyText(main.url) },
            info.canPublish && { label: 'Opnieuw publiceren', icon: <RefreshCw />, disabled: !!busy, onSelect: onRepublish },
            'sep',
            live ? { label: 'Stoppen', icon: <CircleStop />, danger: true, disabled: !!busy, onSelect: () => void stop() } : { label: 'Verwijderen', icon: <Trash2 />, danger: true, disabled: !!busy, onSelect: () => void remove() },
          ]}
        />
      </div>

      {live && main ? (
        <a href={main.url} target="_blank" rel="noopener noreferrer" className="flex min-h-10 min-w-0 items-center gap-2 rounded-control border border-line bg-surface-2 px-3 py-2 hover:border-line-strong" title={main.label}>
          <Link2 className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <span className="min-w-0 flex-1 break-all font-mono text-[12.5px]" translate="no">
            {main.url}
          </span>
          <ExternalLink className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
        </a>
      ) : (
        <p className="text-[13px] text-muted">{info.canPublish ? 'De link werkt niet meer. Publiceer opnieuw om dezelfde link weer aan te zetten.' : 'De link werkt niet meer.'}</p>
      )}
      <MoreInfo block label="Details">
        <span className="block">
          {[t('{0, plural, one {# bestand} other {# bestanden}} · {1}', s.files, fmtBytes(s.bytes)), s.published_at && t('gepubliceerd {0}', timeAgo(s.published_at)), s.views > 0 && t('{0}× bekeken', s.views), expiryText(s)].filter(Boolean).join(' · ')}
        </span>
        <span className="block">{s.reachText}</span>
        {live && s.urls.length > 1 && (
          <span className="block">
            Op deze computer zelf:{' '}
            <span className="break-all font-mono" translate="no">
              {s.urls[s.urls.length - 1].url}
            </span>
          </span>
        )}
        <span className="block">
          Map:{' '}
          <span className="break-all font-mono" translate="no">
            {s.source}
          </span>
          {!s.sourceExists && ' (bestaat niet meer)'}
        </span>
      </MoreInfo>
    </Card>
  );
}

/** #/m/sites — the small websites the bots published: open, copy the link, stop, publish again, delete. */
export function SitesPage() {
  const [d, setD] = useState<{ sites: SiteView[]; info: SitesInfo } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [again, setAgain] = useState<SiteView | null>(null);
  const load = () =>
    api
      .get('/sites')
      .then((x) => (setD(x), setErr(null)))
      .catch((e) => setErr(e?.message || String(e)));
  useEffect(() => {
    load();
    return on('sites.updated', () => load());
  }, []);
  const live = d?.sites.filter((s) => s.state === 'live').length || 0;
  return (
    <Page>
      <PageHeader title="Websites" subtitle="Kleine websites die je bots maakten, elk met een eigen link." />
      <div className="mx-auto max-w-4xl space-y-4 px-4 pb-8 pt-3 sm:px-6">
        {err ? (
          <EmptyState icon={<Globe />} title="De websites konden niet laden" action={<Button onClick={load}>Opnieuw</Button>}>
            {err}
          </EmptyState>
        ) : !d ? (
          <SkeletonCards n={2} className="!grid-cols-1" />
        ) : d.sites.length === 0 ? (
          <Card>
            <EmptyState icon={<Globe />} title="Nog geen websites" action={<Button onClick={() => navigate('/agents')}>Naar je bots</Button>}>
              {d.info.canPublish ? 'Vraag een bot om een kleine website te maken en te publiceren.' : 'Op deze server kan alleen de eigenaar of een beheerder websites publiceren.'}
            </EmptyState>
          </Card>
        ) : (
          <>
            <p className="px-1 text-[13px] text-muted">{t('{0} van {1} online', live, d.sites.length)}</p>
            {d.sites.map((s) => (
              <SiteCard key={s.id} s={s} info={d.info} onRepublish={() => setAgain(s)} />
            ))}
          </>
        )}
        <p className="px-1 text-[13px] text-muted">
          Alleen op deze computer of je eigen netwerk, niet op het openbare internet.{' '}
          <MoreInfo>
            <span className="block">Een site is alleen te openen op deze computer, op je eigen netwerk of via Tailscale, en alleen met de link. Wil je een site echt openbaar maken? Zet de map dan op een eigen account bij bijvoorbeeld GitHub Pages, Netlify of Cloudflare Pages.</span>
            <span className="block">Sites draaien afgeschermd van TeamBot: ze kunnen niet bij je gesprekken, bestanden of login, en niets in de browser opslaan.</span>
            {d?.info && <span className="block">{d.info.mode === 'server' ? t('Draait TeamBot in Docker of achter een firewall? Geef dan ook poort {0} door.', d.info.port) : t('De sites gebruiken poort {0}.', d.info.port)}</span>}
          </MoreInfo>
        </p>
      </div>
      {again && d && <RepublishModal site={again} info={d.info} onClose={() => setAgain(null)} />}
    </Page>
  );
}
