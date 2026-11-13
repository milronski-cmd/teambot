import type React from 'react';
import { formatBytes } from '../../lib/format';
import { useState } from 'react';
import { ChevronRight, CircleStop, Cloud, Cpu, Eraser, Globe, KeyRound, LogOut, MonitorPlay, Network, Plus, RefreshCw, Trash2, Users } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useIsPhoneSession } from '../../shell/computerOnly';
import { navigate } from '../../lib/router';
import { useApp } from '../../lib/store';
import { Badge, Button, Card, CardHead, cx, EmptyState, Field, Input, Modal, Page, PageHeader, Spinner, useAsync, type Tone } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { MoreInfo } from '../../components/MoreInfo';
import { Fold, Menu, Skeleton, SkeletonRows } from '../../components/overview';
import { Segmented } from '../../components/SettingControls';
import { browserApi, CAP_STATUS, cloud, computers, fmtTime, MODE_LABEL, useLive, type BrowserEngine, type ComputerStatus, type EngineView, type Profile } from './api';
import { LivePanel } from './LivePanel';
import { ComputerLive, DesktopPanel } from './DesktopPanel';
import { CloudVmList } from './CloudVmSection';

/** "Dit apparaat": one line; it opens to the browser choice and the facts of the device check. */
function DeviceCard() {
  const [refresh, setRefresh] = useState(0);
  const caps = useLive(() => computers.caps(refresh > 0), [], [refresh]);
  if (caps.loading && !caps.data) return <Skeleton className="h-11 w-full rounded-card" />;
  if (caps.error) return <Card className="p-4 text-sm text-danger">{caps.error}</Card>;
  const c = caps.data!;
  const can = c.modes.filter((m) => m.available).length;
  return (
    <Fold title="Dit apparaat" hint={<span className="hidden sm:inline">{c.osName}</span>}>
      {c.engine?.app && <EngineChoice view={c.engine} />}
      <div>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
          <h3 className="text-sm font-semibold">{t('Waar een bot hier kan werken ({0} van {1})', can, c.modes.length)}</h3>
          <Button size="sm" variant="ghost" icon={<RefreshCw className="h-4 w-4" />} loading={caps.loading} onClick={() => setRefresh((x) => x + 1)}>
            Opnieuw controleren
          </Button>
        </div>
        <ul className="divide-y divide-line rounded-control border border-line">
          {c.modes.map((m) => (
            <li key={m.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5">
              <div className="min-w-0 flex-1 basis-56">
                <div className="text-sm font-medium">{m.label}</div>
                <div className="text-[13px] text-muted">{m.description}</div>
                {!m.available && m.missing?.length ? <div className="mt-0.5 text-[13px] text-warn">{m.missing.join(' · ')}</div> : null}
              </div>
              <Badge tone={m.available ? 'ok' : 'neutral'}>{m.available ? 'Kan' : 'Kan niet'}</Badge>
            </li>
          ))}
        </ul>
      </div>
      <Fold card={false} title="Wat er op deze computer staat">
        <ul className="divide-y divide-line rounded-control border border-line">
          {c.caps.map((x) => (
            <li key={x.id} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2.5">
              <div className="min-w-0 flex-1 basis-56">
                <div className="text-sm font-medium">{x.label}</div>
                <div className="text-[13px] text-muted [overflow-wrap:anywhere]">{x.detail}</div>
                {x.howTo && x.status !== 'available' && <div className="text-[13px] text-muted">{x.howTo}</div>}
              </div>
              <Badge tone={CAP_STATUS[x.status].tone}>{CAP_STATUS[x.status].label}</Badge>
            </li>
          ))}
        </ul>
        <p className="text-[13px] text-muted">
          {t('Gecontroleerd {0}.', fmtTime(c.detectedAt))} <MoreInfo>Ontbreekt een afgeschermde omgeving, dan krijgt de bot een foutmelding.</MoreInfo>
        </p>
      </Fold>
    </Fold>
  );
}

/**
 * "Browser van de bots" (desktop app, 0.4.5): inside TeamBot (invisible tabs, nothing to install; the default) or an
 * installed Edge/Chrome. A running browser keeps its engine until it closes.
 */
function EngineChoice({ view: initial }: { view: EngineView }) {
  const save = useAsync();
  const [view, setView] = useState(initial);
  const pick = (engine: BrowserEngine) => save.run(async () => setView(await computers.setEngine(engine)));
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-semibold">Browser van de bots</h3>
      <Segmented<BrowserEngine>
        label="Browser van de bots"
        value={view.choice}
        disabled={save.busy}
        onChange={pick}
        options={[
          { value: 'app', label: t('Ingebouwd in TeamBot (aanbevolen)') },
          { value: 'external', label: view.external || t('Microsoft Edge of Google Chrome'), disabled: !view.external },
        ]}
      />
      <p className="text-[13px] text-muted">
        {view.choice === 'app' ? t('Elke bot heeft onzichtbare eigen tabbladen in de app.') : view.external ? t('TeamBot start een aparte, onzichtbare {0} per bot.', view.external) : t('Niet gevonden op deze pc.')}{' '}
        <MoreInfo>Je ziet de browser van een bot alleen als je meekijkt.</MoreInfo>
      </p>
    </div>
  );
}

type Row = { config: { mode: keyof typeof MODE_LABEL }; status: ComputerStatus };

/** The one status of a bot's computer: what is happening now, else where it works. */
function statusOf({ config, status }: Row): { tone: 'ok' | 'warn' | 'danger' | 'neutral'; text: string } {
  const r = status.remote;
  if (status.host.enabled && status.host.stopped) return { tone: 'danger', text: t('Bureaublad gepauzeerd (noodstop)') };
  if (status.controller) return status.controller.kind === 'user' ? { tone: 'warn', text: status.controller.sticky ? t('Gepauzeerd door {0}', status.controller.name) : t('Overgenomen door {0}', status.controller.name) } : { tone: 'ok', text: t('{0} bedient de browser', status.controller.name) };
  if (r?.controller) return { tone: 'ok', text: t('{0} werkt op de server', r.controller.name) };
  if (status.rehearsal) return { tone: 'ok', text: status.rehearsal.status === 'review' ? t('Repetitie klaar om te bekijken') : t('Repetitie bezig') };
  if (status.browser.running) return { tone: 'ok', text: t('Browser draait') };
  if (r) {
    const where = (r.cloud ? 'Cloud-VM ' : '') + (r.configured ? `${r.username}@${r.host}${r.port !== 22 ? `:${r.port}` : ''}` : t('Eigen server'));
    if (!r.configured) return { tone: 'warn', text: `${where} · ${t('niet ingesteld')}` };
    if (!r.hasSecret) return { tone: 'warn', text: `${where} · ${t('geen sleutel')}` };
    if (!r.trusted) return { tone: 'warn', text: `${where} · ${t('serversleutel niet vertrouwd')}` };
    return { tone: r.connected ? 'ok' : 'neutral', text: `${where} · ${r.connected ? t('verbonden') : t('klaar')}` };
  }
  if (status.host.enabled) {
    const level = status.host.level === 'auto' ? t('volledige toegang') : status.host.level === 'task' ? t('vraagt per taak') : t('vraagt per actie');
    return { tone: 'warn', text: `${MODE_LABEL.host} · ${level}` };
  }
  return { tone: 'neutral', text: MODE_LABEL[config.mode] + (status.profileShared ? ` · ${t('gedeeld profiel')}` : '') };
}

const DOT = { ok: 'bg-ok', warn: 'bg-warn', danger: 'bg-danger', neutral: '' } as const;

function Bots() {
  const list = useLive(() => computers.list(), ['computer.status', 'computer.config', 'agent.updated', 'agent.deleted'], []);
  const { busy, run } = useAsync();
  const [live, setLive] = useState<string | null>(null);
  if (list.loading && !list.data) return <SkeletonRows n={4} />;
  if (list.error) return <EmptyState icon={<Cpu />} title="De computers konden niet laden" action={<Button onClick={list.reload}>Opnieuw</Button>}>{list.error}</EmptyState>;
  if (!list.data?.length)
    return (
      <EmptyState icon={<Cpu />} title="Nog geen bots" action={<Button variant="primary" onClick={() => navigate('/agents/new')}>Maak een bot</Button>}>
        Elke bot krijgt zijn eigen plek om te werken.
      </EmptyState>
    );
  return (
    <>
      <Card className="overflow-visible">
        <ul className="divide-y divide-line">
          {list.data.map((x) => {
            const { agent, config, status } = x;
            const st = statusOf(x as Row);
            const screen = status.browser.running || status.host.enabled || config.mode === 'browser' || config.mode === 'host' || config.mode === 'container';
            const active = status.browser.running || status.controller || status.host.controller || status.remote?.connected || status.remote?.controller;
            return (
              <li key={agent.id} className="tb-in flex items-center gap-2 pe-3">
                <a href={`#/agents/${agent.id}/edit`} data-testid="computer-row" title={t('Computer van {0} instellen', agent.name)} className="flex min-w-0 flex-1 items-center gap-3 rounded-card py-3 ps-4 hover:bg-surface-2">
                  <BotAvatar bot={agent} size={32} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-semibold [overflow-wrap:anywhere]">{agent.name}</span>
                    <span className="flex items-center gap-1.5 text-[13px] text-muted">
                      {DOT[st.tone] && <span className={cx('h-1.5 w-1.5 shrink-0 rounded-full', DOT[st.tone])} aria-hidden />}
                      <span className="min-w-0 [overflow-wrap:anywhere]">{st.text}</span>
                    </span>
                  </span>
                  {!screen && !active && <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden />}
                </a>
                {screen && (
                  <Button size="sm" icon={<MonitorPlay className="h-4 w-4" />} aria-label={t('Live scherm van {0}', agent.name)} onClick={() => setLive(agent.id)}>
                    Live
                  </Button>
                )}
                {active && (
                  <Button size="sm" variant="danger" icon={<CircleStop className="h-4 w-4" />} loading={busy} onClick={() => run(() => api.post(`/computers/${agent.id}/stop`, {}), 'Gestopt')}>
                    Stop
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>
      <Modal open={!!live} onClose={() => setLive(null)} title={t('Live scherm — {0}', list.data.find((x) => x.agent.id === live)?.agent.name || '')} wide>
        {live && <ComputerLive agentId={live} compact />}
      </Modal>
    </>
  );
}

function Profiles() {
  const list = useLive(() => computers.profiles(), ['computer.status', 'computer.config'], []);
  const agents = useApp((s) => s.agents);
  const { busy, run } = useAsync();
  const [name, setName] = useState('');
  const [wipe, setWipe] = useState<Profile | null>(null);
  const [share, setShare] = useState<Profile | null>(null);
  const [sites, setSites] = useState<Profile | null>(null);
  const [proxy, setProxy] = useState<Profile | null>(null);
  const phone = useIsPhoneSession();
  const nameOf = (id: string) => agents.find((a) => a.id === id)?.name || 'verwijderde bot';
  return (
    <div className="space-y-3">
      {list.loading && !list.data ? (
        <Skeleton className="h-11 w-full" />
      ) : list.error ? (
        <p className="text-sm text-danger">{list.error}</p>
      ) : !list.data?.length ? (
        <p className="text-[13px] text-muted">Nog geen profielen. Een bot krijgt er een zodra hij zijn browser gebruikt.</p>
      ) : (
        <ul className="divide-y divide-line rounded-xl border border-line">
          {list.data.map((p) => (
            <li key={p.id} className="tb-in flex flex-wrap items-center gap-2 px-3 py-2.5 text-sm">
              <Globe className="h-4 w-4 shrink-0 text-muted" aria-hidden />
              <div className="min-w-0 flex-1">
                <div className="font-medium [overflow-wrap:anywhere]">{p.name}</div>
                <div className="text-[13px] text-muted">
                  {p.shared ? `Gedeeld${p.members.length ? ` met ${p.members.map(nameOf).join(', ')}` : ' (nog geen bots)'}` : `Eigen profiel van ${p.agent_id ? nameOf(p.agent_id) : '?'}`} · {formatBytes(p.bytes)}
                  {p.last_used_at ? ` · laatst gebruikt ${fmtTime(p.last_used_at)}` : ''}
                </div>
                {p.proxy && <div className="text-[13px] text-muted">{p.proxy.has_login ? t('Via proxy {0}, met inloggegevens', hostOf(p.proxy.url)) : t('Via proxy {0}', hostOf(p.proxy.url))}</div>}
              </div>
              {p.running && <Badge tone="ok">Actief</Badge>}
              <Menu
                label={t('Meer opties voor {0}', p.name)}
                items={[
                  // a proxy carries a login: set on the computer only (server/modules/mobile/policy.ts)
                  !phone && { label: 'Proxy…', icon: <Network />, onSelect: () => setProxy(p) },
                  { label: 'Delen met andere bots', icon: <Users />, onSelect: () => setShare(p) },
                  { label: 'Uitloggen bij een website…', icon: <LogOut />, onSelect: () => setSites(p) },
                  'sep',
                  { label: 'Alles wissen', icon: <Eraser />, danger: true, onSelect: () => setWipe(p) },
                  p.shared && { label: 'Profiel verwijderen', icon: <Trash2 />, danger: true, disabled: busy, onSelect: () => run(async () => (await api.del(`/computers/profiles/${p.id}`), list.reload()), 'Profiel verwijderd') },
                ]}
              />
            </li>
          ))}
        </ul>
      )}
      <Fold card={false} title="Gedeeld profiel maken">
      <form
        className="flex flex-wrap gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api.post('/computers/profiles', { name: name || 'Gedeelde computer' });
            setName('');
            list.reload();
          }, 'Gedeeld profiel gemaakt; ken het toe bij Bot › Computer & bestanden');
        }}
      >
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Naam, bijvoorbeeld Marketingteam" aria-label="Naam gedeeld profiel" className="min-w-0 flex-1 basis-56" />
        <Button type="submit" icon={<Plus className="h-4 w-4" />} loading={busy} className="shrink-0">
          Gedeeld profiel maken
        </Button>
      </form>
      <MoreInfo block>Elke bot heeft een eigen browserprofiel, nooit jouw eigen browser.</MoreInfo>
      </Fold>
      <Modal
        open={!!wipe}
        onClose={() => setWipe(null)}
        title={t('Profiel wissen: {0}', wipe?.name || '')}
        footer={
          <>
            <Button onClick={() => setWipe(null)}>Annuleren</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                run(async () => {
                  await api.post(`/computers/profiles/${wipe!.id}/wipe`, {});
                  setWipe(null);
                  list.reload();
                }, 'Profiel gewist')
              }
            >
              Wissen
            </Button>
          </>
        }
      >
        <p className="text-sm">Cookies, logins en geschiedenis van dit profiel worden verwijderd; de bots zijn dan overal uitgelogd.</p>
      </Modal>
      {share && <ShareModal profile={share} onClose={() => setShare(null)} onSaved={() => (setShare(null), list.reload())} />}
      {sites && <SitesModal profile={sites} onClose={() => setSites(null)} />}
      {proxy && <ProxyModal profile={proxy} onClose={() => setProxy(null)} onSaved={() => (setProxy(null), list.reload())} />}
    </div>
  );
}

/** host:port of a proxy address for the list. */
const hostOf = (url: string) => {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
};

/**
 * A proxy for one browser profile: only this profile's browser goes through it (TeamBot's own checks stay first);
 * other profiles and the rest of TeamBot keep their route. The login is write-only.
 */
function ProxyModal({ profile, onClose, onSaved }: { profile: Profile; onClose(): void; onSaved(): void }) {
  const [url, setUrl] = useState(profile.proxy?.url || '');
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [clearLogin, setClearLogin] = useState(false);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);
  const { busy, run } = useAsync();
  const [testing, setTesting] = useState(false);
  const save = (u: string) =>
    run(async () => {
      await api.put(`/computers/profiles/${profile.id}/proxy`, { url: u, username, password, clear_login: clearLogin });
      onSaved();
    }, u ? 'Proxy opgeslagen voor dit profiel' : 'Proxy weggehaald');
  const test = async () => {
    setTesting(true);
    setResult(null);
    try {
      setResult(await api.post<{ ok: boolean; message: string }>(`/computers/profiles/${profile.id}/proxy/test`, { url, username, password }));
    } catch (e: any) {
      setResult({ ok: false, message: e?.message || String(e) });
    } finally {
      setTesting(false);
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Proxy voor {0}', profile.name)}
      footer={
        <>
          {profile.proxy && (
            <Button variant="ghost" loading={busy} onClick={() => save('')} className="me-auto">
              Proxy weghalen
            </Button>
          )}
          <Button onClick={onClose}>Annuleren</Button>
          <Button variant="primary" loading={busy} disabled={!url.trim()} onClick={() => save(url.trim())}>
            Opslaan
          </Button>
        </>
      }
    >
      <form
        className="space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          if (url.trim()) save(url.trim());
        }}
      >
        <p className="text-sm text-muted">Alleen de browser van dit profiel gaat via deze proxy.</p>
        <Field label="Adres van de proxy" hint="Bijvoorbeeld http://proxy.bedrijf.nl:8080. HTTP- en HTTPS-proxy's; geen SOCKS.">
          <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="http://proxy.bedrijf.nl:8080" autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Gebruikersnaam (optioneel)" hint={profile.proxy?.has_login ? 'Er zijn inloggegevens opgeslagen. Leeg laten houdt ze.' : undefined}>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="off" spellCheck={false} />
        </Field>
        <Field label="Wachtwoord (optioneel)" hint="Versleuteld bewaard en nooit meer getoond.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" />
        </Field>
        {profile.proxy?.has_login && (
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" className="h-4 w-4" checked={clearLogin} onChange={(e) => setClearLogin(e.target.checked)} />
            <span>Opgeslagen inloggegevens weghalen</span>
          </label>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <Button size="sm" loading={testing} disabled={!url.trim()} onClick={test}>
            Testen
          </Button>
          {result && (
            <span role="status" className={cx('text-sm', result.ok ? 'text-ok' : 'text-danger')}>
              {result.message}
            </span>
          )}
        </div>
        <button type="submit" hidden />
      </form>
    </Modal>
  );
}

/** Pick the bots that use one browser profile (and so share its logins). */
function ShareModal({ profile, onClose, onSaved }: { profile: Profile; onClose(): void; onSaved(): void }) {
  const agents = useApp((s) => s.agents);
  const { busy, run } = useAsync();
  const [pick, setPick] = useState<string[]>(profile.members);
  const owner = !profile.shared ? profile.agent_id : null;
  const ownerName = agents.find((a) => a.id === owner)?.name;
  return (
    <Modal
      open
      onClose={onClose}
      title={t('Profiel delen: {0}', profile.name)}
      footer={
        <>
          <Button onClick={onClose}>Annuleren</Button>
          <Button variant="primary" loading={busy} onClick={() => run(() => browserApi.profileMembers(profile.id, pick), 'Opgeslagen').then((r) => r && onSaved())}>
            Opslaan
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">
        <p className="leading-relaxed text-muted">
          Bots met hetzelfde profiel delen cookies en logins.
          {owner ? ` Dit is het eigen profiel van ${ownerName || 'een bot'}; het wordt een gedeeld profiel en ${ownerName || 'die bot'} blijft het gebruiken.` : ''}
        </p>
        <div className="grid gap-1.5 sm:grid-cols-2">
          {agents.map((a) => {
            const fixed = a.id === owner;
            const on = fixed || pick.includes(a.id);
            return (
              <label key={a.id} className={cx('flex items-center gap-2 rounded-lg border px-2.5 py-2', on ? 'border-line-strong bg-surface-2' : 'border-line', fixed ? 'opacity-80' : 'cursor-pointer')}>
                <input type="checkbox" checked={on} disabled={fixed} onChange={(e) => setPick(e.target.checked ? [...pick, a.id] : pick.filter((x) => x !== a.id))} />
                <BotAvatar bot={a} size={22} />
                <span className="min-w-0 flex-1 truncate">{a.name}</span>
                {!a.tool_groups?.includes('browser') && <span className="text-xs text-muted">geen browser</span>}
              </label>
            );
          })}
        </div>
      </div>
    </Modal>
  );
}

/** Sites with cookies in a profile, each with "Uitloggen". */
function SitesModal({ profile, onClose }: { profile: Profile; onClose(): void }) {
  const list = useLive(() => browserApi.profileSites(profile.id), [], [profile.id]);
  const { busy, run } = useAsync();
  return (
    <Modal open onClose={onClose} title={t('Uitloggen bij een site — {0}', profile.name)}>
      <div className="space-y-3 text-sm">
        <p className="text-muted">Websites waar dit profiel cookies van heeft. Uitloggen wist alleen die site.</p>
        {list.loading && !list.data ? (
          <div className="flex items-center gap-2 text-muted">
            <Spinner /> Browser wordt even op de achtergrond gestart…
          </div>
        ) : list.error ? (
          <p className="text-danger">{list.error}</p>
        ) : !list.data?.length ? (
          <p className="text-muted">Geen cookies: dit profiel is nergens ingelogd.</p>
        ) : (
          <ul className="divide-y divide-line rounded-xl border border-line">
            {list.data.map((x) => (
              <li key={x.site} className="flex items-center gap-2 px-3 py-2">
                <Globe className="h-4 w-4 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium" translate="no">
                  {x.site}
                </span>
                <span className="text-xs text-muted">{x.cookies === 1 ? '1 cookie' : `${x.cookies} cookies`}</span>
                <Button size="sm" variant="ghost" icon={<LogOut className="h-4 w-4" />} loading={busy} onClick={() => run(() => browserApi.profileLogout(profile.id, x.site), `Uitgelogd bij ${x.site}`).then(list.reload)}>
                  Uitloggen
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Modal>
  );
}

/** A short section of the page: one line and one action. */
function Shortcut({ icon, tone, title, children, action }: { icon: LucideIcon; tone?: Tone; title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <Card className="p-4">
      <CardHead icon={icon} tone={tone} title={title} hint={children} action={action} />
    </Card>
  );
}

const linkButton = 'inline-flex h-9 shrink-0 items-center gap-2 rounded-control border border-line bg-surface px-3.5 text-sm font-semibold hover:bg-surface-2 coarse:h-11';

export function ComputersPage() {
  const vms = useLive(() => cloud.list(), ['cloudvm.updated'], []);
  return (
    <Page>
      <PageHeader title="Computers" subtitle="Waar je bots werken en wat ze nu doen." />
      <div className="mx-auto max-w-4xl space-y-4 px-4 pb-8 pt-3 sm:px-6">
        <Bots />
        {vms.data?.length ? (
          <section className="space-y-3 pt-2">
            <CardHead icon={Cloud} tone="blue" title="Cloud-VM’s" />
            <CloudVmList />
          </section>
        ) : (
          <Shortcut icon={Cloud} tone="blue" title="Cloud-VM’s">
            Een eigen computer in de cloud voor een bot. <MoreInfo>Open een bot, kies bij Computer “Eigen server” en dan “Cloud-VM laten maken”.</MoreInfo>
          </Shortcut>
        )}
        <Shortcut
          icon={KeyRound}
          tone="amber"
          title="Kluis"
          action={
            <a href="#/m/browser/kluis" className={linkButton}>
              Kluis openen
            </a>
          }
        >
          Logins waarmee je bots mogen inloggen. Een bot ziet je wachtwoord nooit.
        </Shortcut>
        <DeviceCard />
        {/* Not a fold: a fold clips the "⋯" menu of a row. */}
        <section className="space-y-3 pt-2" data-testid="browser-profiles">
          <CardHead icon={Globe} tone="blue" title="Browserprofielen" />
          <Profiles />
        </section>
      </div>
    </Page>
  );
}

/** #/m/browser/live/<agentId> — full-page live screen (linked from login requests and notifications). */
export function LivePage({ params }: { params: string[] }) {
  const agentId = params[0];
  const agent = useApp((s) => s.agents.find((a) => a.id === agentId));
  // #/m/browser/live/<id>/pip(-desktop): compact picture-in-picture window
  if (agentId && (params[1] === 'pip' || params[1] === 'pip-desktop'))
    return <div className="p-2">{params[1] === 'pip-desktop' ? <DesktopPanel agentId={agentId} compact /> : <LivePanel agentId={agentId} compact />}</div>;
  if (!agentId) return <EmptyState title="Geen bot gekozen" action={<Button onClick={() => navigate('/m/browser')}>Naar Computers</Button>} />;
  return (
    <Page>
      <PageHeader width="5xl" title={agent ? t('Live scherm — {0}', agent.name) : 'Live scherm'} subtitle="Kijk mee, neem over of log zelf in. Wat je typt gaat niet naar de bot." actions={<Button size="sm" variant="ghost" onClick={() => navigate('/m/browser')}>Alle computers</Button>} />
      <div className="mx-auto max-w-5xl p-4 sm:p-6">
        <ComputerLive agentId={agentId} />
      </div>
    </Page>
  );
}
