import type React from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowDownLeft, ArrowLeft, ArrowUpRight, Bot, Copy, ExternalLink, Globe, Headset, Info, KeyRound, Mail, MessageSquare, Pause, Play, Plug, PlugZap, Plus, Reply, ShieldCheck, Trash2, Undo2, UserCheck, UserPlus } from 'lucide-react';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { Badge, Button, Card, CardHead, EmptyState, Field, Input, Modal, Page, PageHeader, Select, Spinner, Tabs, Textarea, Toggle, cx, timeAgo, toast, toastError, useAsync, copyText } from '../../components/ui';
import { MoreOptions } from '../../components/MoreOptions';
import { GUIDES } from './guides';
import { ConfigForm } from './ConfigForm';
import { PublicUrlNote, RequirementBadges, TargetSelect, targetBody, targetValue, useRooms } from './AddChannel';
import { ADAPTER_ICON, BOT_ACCESS_LABEL, BotAddresses, EngineNote, LOG_KIND, SENDER_HINT, StatusBadge, accessChoices, fmtTime, isGone, markGone, unmarkGone, type Access, type AdaptersInfo, type BindingDetail, type ConversationRow, type LogRow, type PairCodeRow } from './shared';
import { WhatsAppLink } from './WhatsAppLink';
import { HealthCard } from './HealthCard';

import { CustomerTab } from './CustomerMode';
import { t } from '../../lib/i18n';
import { Words } from '../../components/Words';
import { useFollowTeam } from '../teams/follow';
import { ComputerOnly, useIsPhoneSession } from '../../shell/computerOnly';
import { PLACE } from '../../../../shared/places.js';

type Tab = 'overview' | 'access' | 'customers' | 'conversations' | 'log' | 'settings';

export function BindingDetailPage({ id, info }: { id: string; info: AdaptersInfo | null }) {
  const [b, setB] = useState<BindingDetail | null>(null);
  const [err, setErr] = useState('');
  const [tab, setTab] = useState<Tab>('overview');
  const multiTeam = useFollowTeam().multi;
  const load = useCallback(() => (isGone(id) ? Promise.resolve() : api.get<BindingDetail>(`/channels/bindings/${id}`).then((r) => (setB(r), setErr('')), (e) => setErr(e.message))), [id]);
  useEffect(() => {
    load();
    const offs = [
      on('channels.status', (d: any) => d.id === id && setB((x) => (x ? { ...x, status: d.status, last_error: d.last_error, last_ok_at: d.last_ok_at } : x))),
      on('channels.health', (d: any) => d.id === id && setB((x) => (x ? { ...x, health: d.health } : x))),
      on('channels.updated', (v: any) => v.id === id && load()),
      on('channels.deleted', (d: any) => d.id === id && (markGone(id), navigate('/m/channels'))),
    ];
    return () => offs.forEach((f) => f());
  }, [id, load]);

  if (err)
    return (
      <EmptyState title="Koppeling niet gevonden" action={<Button onClick={() => navigate('/m/channels')}>Naar Kanalen</Button>}>
        {err}
      </EmptyState>
    );
  if (!b)
    return (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  const Icon = ADAPTER_ICON[b.adapter] || MessageSquare;
  return (
    <Page>
      <PageHeader width="4xl"
        title={
          <span className="inline-flex items-center gap-2" translate="no">
            <Icon className="h-5 w-5 text-accent" aria-hidden />
            {b.name}
          </span>
        }
        subtitle={
          <span className="inline-flex flex-wrap items-center gap-2">
            {b.adapterLabel} <StatusBadge status={b.status} enabled={b.enabled} link={b.link} health={b.health} />
            {multiTeam && b.teamName && (
              <span className="text-xs text-muted" title="Alleen bots van dit team antwoorden en versturen via dit kanaal.">
                Team <span translate="no">{b.teamName}</span>
              </span>
            )}
          </span>
        }
        actions={
          <Button variant="ghost" onClick={() => navigate('/m/channels')} icon={<ArrowLeft className="h-4 w-4" />}>
            Alle kanalen
          </Button>
        }
      />
      <div className="px-4 pt-2 sm:px-6">
        <Tabs<Tab>
          value={tab}
          onChange={setTab}
          tabs={[
            { id: 'overview', label: 'Overzicht' },
            { id: 'access', label: `Toegang (${b.senders.length})` },
            { id: 'customers', label: b.config.customer?.enabled ? 'Klanten (aan)' : 'Klanten' },
            { id: 'conversations', label: `Gesprekken (${b.counts.conversations})` },
            { id: 'log', label: 'Logboek' },
            { id: 'settings', label: 'Instellingen' },
          ]}
        />
      </div>
      <div className="mx-auto max-w-4xl space-y-4 px-4 py-4 sm:px-6">
        {tab === 'overview' && <Overview b={b} info={info} reload={load} onSettings={() => setTab('settings')} />}
        {tab === 'access' && <AccessTab b={b} reload={load} />}
        {tab === 'customers' && <CustomerTab b={b} reload={load} />}
        {tab === 'conversations' && <ConversationsTab b={b} />}
        {tab === 'log' && <LogTab b={b} reload={load} />}
        {tab === 'settings' && <SettingsTab b={b} info={info} reload={load} />}
      </div>
    </Page>
  );
}

// ------------------------------------------------------------------ overview

function Overview({ b, info, reload, onSettings }: { b: BindingDetail; info: AdaptersInfo | null; reload(): void; onSettings(): void }) {
  const agents = useApp((s) => s.agents);
  const rooms = useRooms();
  const agent = useMemo(() => agents.find((a) => a.id === b.agent_id), [agents, b.agent_id]);
  const [test, setTest] = useState<{ ok: boolean; detail: string } | null>(null);
  const [confirmDel, setConfirmDel] = useState(false);
  const act = useAsync();
  const guide = GUIDES[b.adapter];

  const runTest = () =>
    act.run(async () => {
      const r = await api.post(`/channels/bindings/${b.id}/test`);
      setTest({ ok: r.ok, detail: r.detail });
      reload();
    });
  const toggle = () =>
    act.run(async () => {
      await api.post(`/channels/bindings/${b.id}/${b.enabled ? 'disconnect' : 'connect'}`);
      reload();
    }, b.enabled ? 'Verbinding verbroken' : 'Verbinden…');
  const del = () =>
    act.run(async () => {
      const from = location.hash;
      // From here on nothing on this page asks for the binding again (it is gone in a moment).
      markGone(b.id);
      try {
        await api.del(`/channels/bindings/${b.id}`);
      } catch (e) {
        unmarkGone(b.id);
        throw e;
      }
      navigate('/m/channels', { from });
    }, 'Koppeling verwijderd');
  const setTarget = (v: string) =>
    act.run(async () => {
      await api.patch(`/channels/bindings/${b.id}`, targetBody(v));
      reload();
    }, 'Opgeslagen');

  return (
    <>
      {b.adapter === 'whatsapp-web' && <WhatsAppLink b={b} reload={reload} />}
      <HealthCard b={b} reload={reload} onSettings={onSettings} />
      {!!b.botAddresses?.length && (
        <Card className="space-y-2 p-4">
          <CardHead icon={Mail} tone="blue" title="E-mailadres per bot" />
          <BotAddresses list={b.botAddresses} />
          <p className="text-xs text-muted">
            Mail aan zo’n adres komt bij die bot. Bij Gmail voeg je het toe onder Instellingen › Accounts › Verzenden als.
          </p>
        </Card>
      )}
      <Card className="space-y-3 p-4">
        <CardHead icon={Bot} tone="teal" title="Wie antwoordt via dit kanaal?" />
        <Field label={<span className="sr-only">Wie antwoordt via dit kanaal?</span>} hint={b.room_id ? 'Een groep: de bots in die groep antwoorden volgens de werkwijze van de groep.' : 'Wissel je van bot, dan beginnen nieuwe gesprekken in een nieuw gesprek.'}>
          <TargetSelect value={targetValue(b)} onChange={setTarget} rooms={rooms} />
        </Field>
        {agent && (
          <div className="text-sm text-muted">
            {agent.name} werkt zelf met toegang <b className="text-fg">{BOT_ACCESS_LABEL[agent.access_mode] || agent.access_mode}</b>. Via dit kanaal krijgt niemand meer dan dat.{' '}
            <a className="text-accent underline" href={`#/agents/${agent.id}`}>
              Bot-instellingen
            </a>
          </div>
        )}
        {agent && <EngineNote engine={b.engine} botName={agent.name} />}
      </Card>


      {/* Rarely needed once it works: checking, disconnecting, removing and the technical ways in. Open by itself when
          the channel is off or failing, because then this is where the way back is. */}
      <MoreOptions defaultOpen={!b.enabled || b.status === 'error'}>
        <Card className="space-y-3 p-4">
          <CardHead as="h3" icon={Plug} tone="blue" title="Verbinding" hint={b.last_ok_at ? t('Verbinding laatst gemaakt {0}', timeAgo(b.last_ok_at)) : undefined} />
        {test && (
          <div className={cx('rounded-lg p-3 text-sm', test.ok ? 'bg-surface-2 text-fg' : 'bg-danger-soft text-danger')}>
            {test.detail}
            {test.ok && <div className="mt-1 text-xs text-muted">Daarmee is ontvangen nog niet getest: gebruik daarvoor “Test ontvangen en versturen”.</div>}
          </div>
        )}
        <div className="flex flex-wrap gap-2">
          <Button onClick={runTest} loading={act.busy} icon={<ShieldCheck className="h-4 w-4" />}>
            Gegevens controleren
          </Button>
          {b.enabled && b.status === 'error' && (
            <Button variant="primary" onClick={() => act.run(async () => (await api.post(`/channels/bindings/${b.id}/connect`), reload()), 'Opnieuw verbinden…')} icon={<PlugZap className="h-4 w-4" />}>
              Opnieuw verbinden
            </Button>
          )}
          <Button onClick={toggle} variant={b.enabled ? 'secondary' : 'primary'} icon={b.enabled ? <Plug className="h-4 w-4" /> : <PlugZap className="h-4 w-4" />}>
            {b.enabled ? 'Verbreken' : 'Verbinden'}
          </Button>
          <Button variant="ghost" className="text-danger" onClick={() => setConfirmDel(true)} icon={<Trash2 className="h-4 w-4" />}>
            Verwijderen
          </Button>
        </div>
        {guide && <RequirementBadges list={guide.requirements(b.config)} />}
      </Card>
        <Connect b={b} info={info} />
      </MoreOptions>


      <Modal
        open={confirmDel}
        onClose={() => setConfirmDel(false)}
        title="Koppeling verwijderen?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setConfirmDel(false)}>
              Annuleren
            </Button>
            <Button variant="danger" loading={act.busy} onClick={del}>
              Verwijderen
            </Button>
          </>
        }
      >
        {b.adapter === 'whatsapp-web' ? (
          <p className="text-sm">TeamBot ontkoppelt zich van je WhatsApp en wist de bewaarde sessie. De gesprekken blijven in TeamBot staan.</p>
        ) : (
          <p className="text-sm">
            De verbinding wordt verbroken en de opgeslagen tokens/wachtwoorden worden gewist. De gesprekken blijven in TeamBot staan. Trek de token ook in bij {b.adapterLabel} als je hem niet meer gebruikt.
          </p>
        )}
      </Modal>
    </>
  );
}

function CopyRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium text-muted">{label}</div>
      <div className="flex items-center gap-2">
        <code className="min-w-0 flex-1 truncate rounded-lg border border-line bg-canvas px-2 py-1.5 font-mono text-xs" title={value}>
          {value}
        </code>
        <Button size="icon" variant="secondary" aria-label={t('{0} kopiëren', t(label))} onClick={() => copyText(value)}>
          <Copy className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

/** How to reach the bot: links, invite URL, webhook URLs. */
function Connect({ b, info }: { b: BindingDetail; info: AdaptersInfo | null }) {
  const i = b.info || {};
  const guide = GUIDES[b.adapter];
  const items: React.ReactNode[] = [];
  if (b.adapter === 'telegram' && i.botUsername)
    items.push(
      <a key="tg" className="inline-flex items-center gap-1 text-sm text-accent underline" href={`https://t.me/${i.botUsername}`} target="_blank" rel="noreferrer noopener">
        @{i.botUsername} openen in Telegram <ExternalLink className="h-3.5 w-3.5" />
      </a>,
    );
  if (b.adapter === 'discord')
    items.push(
      i.inviteUrl ? (
        <a key="dc" className="inline-flex items-center gap-1 text-sm text-accent underline" href={i.inviteUrl} target="_blank" rel="noreferrer noopener">
          Bot uitnodigen op je server <ExternalLink className="h-3.5 w-3.5" />
        </a>
      ) : (
        <div key="dc" className="text-sm text-muted">
          Klik op “Test verbinding” om de uitnodigingslink voor je server te krijgen.
        </div>
      ),
    );
  if (b.adapter === 'slack' && i.team) items.push(<div key="sl" className="text-sm">Workspace: <b>{i.team}</b> · bot @{i.botName}</div>);
  if (b.adapter === 'whatsapp' && i.displayPhone) items.push(<div key="wa" className="text-sm">Nummer: <b>{i.displayPhone}</b> {i.verifiedName ? `(${i.verifiedName})` : ''}</div>);
  if (b.adapter === 'email') items.push(<div key="em" className="text-sm">Mail naar <b>{b.config.address}</b> (map {b.config.folder || 'INBOX'}).</div>);
  const hooks = b.webhooks.filter((w) => b.adapter !== 'telegram' || b.config.mode === 'webhook').filter((w) => b.adapter !== 'slack' || b.config.mode === 'events');
  return (
    <Card className="space-y-3 p-4">
      <CardHead icon={Globe} tone="blue" title="Bereikbaarheid" />
      {items}
      {hooks.map((w) => (
        <div key={w.kind} className="space-y-2">
          {w.url ? <CopyRow label="Webhook-URL (plak bij het platform)" value={w.url} /> : <CopyRow label="Webhook-pad (nog zonder publieke URL)" value={w.path} />}
        </div>
      ))}
      {guide && <PublicUrlNote info={info} guide={guide} config={b.config} />}
      {!items.length && !hooks.length && <div className="text-sm text-muted">Geen extra stappen nodig.</div>}
    </Card>
  );
}

// ------------------------------------------------------------------ access

function AccessTab({ b, reload }: { b: BindingDetail; reload(): void }) {
  const act = useAsync();
  const [ext, setExt] = useState('');
  const [label, setLabel] = useState('');
  const [owner, setOwner] = useState(false);
  const [code, setCode] = useState<null | { code: string; command: string; deepLink: string | null; qrSvg?: string | null; expires_at: string; is_owner: boolean }>(null);
  const [codeLabel, setCodeLabel] = useState('');
  const [codeOwner, setCodeOwner] = useState(false);
  const [minutes, setMinutes] = useState('30');
  const [cfg, setCfg] = useState(b.config);
  useEffect(() => setCfg(b.config), [b.config]);
  const supportsOwnerApproval = b.approveViaChannelSupported;
  // Marking a sender as yourself (owner of the channel) or making a pairing code for yourself hands out full say over
  // the bots: that stays on the computer (server/modules/mobile/policy.ts). The phone does the rest of this tab.
  const phone = useIsPhoneSession();
  const agents = useApp((s) => s.agents);
  const botName = agents.find((a) => a.id === b.agent_id)?.name || 'De bot';
  const others: Access = cfg.othersAccess || 'none';
  const mine: Access = cfg.ownerAccess || 'agent';
  const othersChoices = accessChoices(b.engine, others);
  const ownerChoices = accessChoices(b.engine, mine);

  const add = () =>
    act.run(async () => {
      await api.post(`/channels/bindings/${b.id}/senders`, { external_id: ext, label, is_owner: owner });
      setExt('');
      setLabel('');
      setOwner(false);
      reload();
    }, 'Toegevoegd aan de allowlist');
  const remove = (sid: string) =>
    act.run(async () => {
      await api.del(`/channels/bindings/${b.id}/senders/${sid}`);
      reload();
    }, 'Verwijderd');
  const setOwnerFlag = (sid: string, v: boolean) =>
    act.run(async () => {
      await api.patch(`/channels/bindings/${b.id}/senders/${sid}`, { is_owner: v });
      reload();
    });
  const newCode = () =>
    act.run(async () => {
      setCode(await api.post(`/channels/bindings/${b.id}/pair-codes`, { label: codeLabel, owner: codeOwner, minutes: Number(minutes) }));
      setCodeLabel('');
      reload();
    });
  const delCode = (cid: string) =>
    act.run(async () => {
      await api.del(`/channels/bindings/${b.id}/pair-codes/${cid}`);
      reload();
    });
  const saveCfg = () =>
    act.run(async () => {
      await api.patch(`/channels/bindings/${b.id}`, {
        config: { othersAccess: cfg.othersAccess, ownerAccess: cfg.ownerAccess, approveViaChannel: !!cfg.approveViaChannel, errorReply: cfg.errorReply !== false, reactions: cfg.reactions !== false, transcribeVoice: cfg.transcribeVoice !== false, maxFileMb: cfg.maxFileMb },
      });
      reload();
    }, 'Opgeslagen');
  const activeCodes = b.pairCodes.filter((c: PairCodeRow) => !c.used_at && c.expires_at > new Date().toISOString());

  return (
    <>
      <Card className="space-y-3 p-4">
        <div>
          <CardHead icon={UserCheck} tone="rose" title="Allowlist" className="mb-1" />
          <p className="text-sm text-muted">Alleen deze afzenders bereiken de bot. Berichten van anderen worden genegeerd (je ziet ze in het logboek).</p>
        </div>
        {b.senders.length === 0 ? (
          <div className="rounded-lg bg-surface-2 p-3 text-sm text-muted">Nog niemand. Maak hieronder een koppelcode — dat is het makkelijkst.</div>
        ) : (
          <ul className="divide-y divide-line">
            {b.senders.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-2 py-2">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                    {s.label}
                    {s.is_owner && (
                      <Badge tone="accent">
                        <UserCheck className="h-3 w-3" /> jij (eigenaar)
                      </Badge>
                    )}
                    {s.source === 'pair' && <Badge>via koppelcode</Badge>}
                  </div>
                  <div className="truncate font-mono text-xs text-muted">{s.external_id}</div>
                </div>
                {!phone && <Toggle checked={s.is_owner} onChange={(v) => setOwnerFlag(s.id, v)} label={<span className="text-xs">Dit ben ik</span>} />}
                <Button size="icon" variant="ghost" aria-label={t('{0} verwijderen', s.label)} onClick={() => remove(s.id)}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-end">
          <Field label="Afzender-id">
            <Input value={ext} onChange={(e) => setExt(e.target.value)} placeholder={b.adapter === 'email' ? 'naam@voorbeeld.nl' : ''} />
          </Field>
          <Field label="Naam">
            <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="bijv. Jan" />
          </Field>
          {!phone && (
            <div className="pb-2">
              <Toggle checked={owner} onChange={setOwner} label={<span className="text-sm">Dit ben ik</span>} />
            </div>
          )}
          <Button onClick={add} disabled={!ext.trim()} loading={act.busy} icon={<UserPlus className="h-4 w-4" />}>
            Toevoegen
          </Button>
        </div>
        <p className="text-xs text-muted">{SENDER_HINT[b.adapter]}</p>
        {phone && <ComputerOnly>Een afzender als jezelf markeren (“Dit ben ik”) en een koppelcode voor jezelf maken doe je op je computer.</ComputerOnly>}
      </Card>

      <Card className="space-y-3 p-4">
        <div>
          <CardHead icon={KeyRound} tone="amber" title="Koppelcode" className="mb-1" />
          <p className="text-sm text-muted">
            Eenmalige code: wie hem binnen de geldigheid naar de bot stuurt ({b.adapter === 'email' ? <>“koppel CODE” in het onderwerp</> : <code className="font-mono">/koppel CODE</code>}), komt op de allowlist.
          </p>
        </div>
        <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto_auto] sm:items-end">
          <Field label="Voor wie?">
            <Input value={codeLabel} onChange={(e) => setCodeLabel(e.target.value)} placeholder="bijv. Mijn telefoon" />
          </Field>
          <Field label="Geldig">
            <Select value={minutes} onChange={(e) => setMinutes(e.target.value)}>
              <option value="10">10 min</option>
              <option value="30">30 min</option>
              <option value="120">2 uur</option>
              <option value="1440">24 uur</option>
            </Select>
          </Field>
          {!phone && (
            <div className="pb-2">
              <Toggle checked={codeOwner} onChange={setCodeOwner} label={<span className="text-sm">Voor mezelf</span>} />
            </div>
          )}
          <Button variant="primary" onClick={newCode} loading={act.busy} icon={<Plus className="h-4 w-4" />}>
            Maak code
          </Button>
        </div>
        {activeCodes.length > 0 && (
          <ul className="space-y-1 text-sm">
            {activeCodes.map((c) => (
              <li key={c.id} className="flex items-center gap-2">
                <span className="flex-1">
                  {c.label || 'Code'} {c.is_owner && <Badge tone="accent">eigenaar</Badge>} · verloopt {fmtTime(c.expires_at)}
                </span>
                <Button size="sm" variant="ghost" onClick={() => delCode(c.id)}>
                  Intrekken
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card className="space-y-4 p-4">
        <CardHead icon={ShieldCheck} tone="rose" title="Wat mag de bot via dit kanaal?" />
        <EngineNote engine={b.engine} botName={botName} where="hieronder" />
        <Field label="Voor anderen op de allowlist" hint={othersChoices.find((o) => o.value === others)?.hint}>
          <Select value={others} onChange={(e) => setCfg({ ...cfg, othersAccess: e.target.value })} aria-label="Voor anderen op de allowlist">
            {othersChoices.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Voor jezelf (afzender gemarkeerd als “Dit ben ik”, in een privégesprek)" hint={ownerChoices.find((o) => o.value === mine)?.hint}>
          <Select value={mine} onChange={(e) => setCfg({ ...cfg, ownerAccess: e.target.value })} aria-label="Voor jezelf">
            {ownerChoices.map((o) => (
              <option key={o.value} value={o.value} disabled={o.disabled}>
                {o.label}
              </option>
            ))}
          </Select>
        </Field>
        <div>
          <Toggle
            checked={!!cfg.approveViaChannel}
            disabled={!supportsOwnerApproval}
            onChange={(v) => setCfg({ ...cfg, approveViaChannel: v })}
            label="Goedkeuren via dit kanaal"
          />
          <div className="mt-1 ps-11 text-xs text-muted">
            {supportsOwnerApproval
              ? 'Toestemmingsvragen krijg je ook hier als knoppen, alleen in jouw privégesprek.'
              : 'Niet beschikbaar voor dit kanaal; goedkeuren gaat via TeamBot of je telefoon.'}
          </div>
        </div>
        <div>
          <Toggle checked={cfg.errorReply !== false} onChange={(v) => setCfg({ ...cfg, errorReply: v })} label="Korte melding sturen als de bot vastloopt" />
        </div>
        {b.reactionsSupported && (
          <div>
            <Toggle checked={cfg.reactions !== false} onChange={(v) => setCfg({ ...cfg, reactions: v })} label="Reacties als status op berichten" />
            <div className="mt-1 ps-11 text-xs text-muted">{b.adapter === 'telegram' ? 'De bot zet 👀 op je bericht zodra hij begint, en daarna 👍 als hij klaar is of 😢 als het niet lukte.' : 'De bot zet 👀 op je bericht zodra hij begint, en daarna ✅ als hij klaar is of ❌ als het niet lukte.'}</div>
          </div>
        )}
        <div>
          <Toggle checked={cfg.transcribeVoice !== false} onChange={(v) => setCfg({ ...cfg, transcribeVoice: v })} label="Spraakberichten uitschrijven voor de bot" />
          <div className="mt-1 ps-11 text-xs text-muted">{t('Met de spraakherkenning uit {0}.', t(PLACE.voice))}</div>
        </div>
        <Field label="Maximale bestandsgrootte (MB)" hint="Grotere bijlagen worden niet opgehaald of verstuurd.">
          <Input type="number" min={1} max={50} value={cfg.maxFileMb ?? 20} onChange={(e) => setCfg({ ...cfg, maxFileMb: Number(e.target.value) })} className="max-w-32" />
        </Field>
        <div>
          <Button variant="primary" onClick={saveCfg} loading={act.busy}>
            Opslaan
          </Button>
        </div>
      </Card>

      <Modal open={!!code} onClose={() => setCode(null)} title="Koppelcode">
        {code && (
          <div className="space-y-3 text-sm">
            <div className="rounded-xl bg-surface-2 p-4 text-center font-mono text-3xl font-semibold tracking-widest">{code.code}</div>
            <p>
              Stuur {b.adapter === 'email' ? 'een mail met' : 'de bot'} <b className="font-mono">{code.command}</b> {b.adapter === 'email' ? `naar ${b.config.address}` : ''} vóór {fmtTime(code.expires_at)}. De code werkt één keer en wordt hierna niet meer getoond.
              {code.is_owner && ' Gebruik hem in een privégesprek: die afzender wordt als jou herkend.'}
            </p>
            {code.deepLink && (
              <a className="inline-flex items-center gap-1 text-accent underline" href={code.deepLink} target="_blank" rel="noreferrer noopener">
                Open in Telegram en koppel direct <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
            {code.qrSvg && (
              <div className="flex items-center gap-3">
                <img className="w-32 shrink-0 rounded-xl bg-white p-2" alt="QR-code: scan met de camera van je telefoon" src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(code.qrSvg)}`} />
                <span className="text-xs text-muted">Of scan deze code met de camera van de telefoon: Telegram opent, druk op Start.</span>
              </div>
            )}
            <Button variant="secondary" icon={<Copy className="h-4 w-4" />} onClick={() => copyText(code.deepLink || code.command)}>
              Kopiëren
            </Button>
          </div>
        )}
      </Modal>
    </>
  );
}

// ------------------------------------------------------------------ conversations

export function ReplyModal({ conversationId, open, onClose, title }: { conversationId: string; open: boolean; onClose(): void; title: string }) {
  const [text, setText] = useState('');
  const send = useAsync();
  const submit = () =>
    send.run(async () => {
      await api.post(`/channels/conversations/${conversationId}/send`, { text });
      setText('');
      onClose();
    }, 'Verstuurd');
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={<Words text="Zelf antwoorden — {0}" values={[title]} />}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant="primary" onClick={submit} loading={send.busy} disabled={!text.trim()}>
            Versturen
          </Button>
        </>
      }
    >
      <Field label="Bericht (gaat als jou naar dit gesprek)" hint="Tip: pauzeer de bot in dit gesprek als je het helemaal wilt overnemen.">
        <Textarea rows={5} value={text} onChange={(e) => setText(e.target.value)} autoFocus />
      </Field>
    </Modal>
  );
}

function ConversationsTab({ b }: { b: BindingDetail }) {
  const [rows, setRows] = useState<ConversationRow[] | null>(null);
  const [err, setErr] = useState('');
  const [reply, setReply] = useState<ConversationRow | null>(null);
  const load = useCallback(() => api.get<ConversationRow[]>(`/channels/bindings/${b.id}/conversations`).then(setRows, (e) => setErr(e.message)), [b.id]);
  useEffect(() => {
    load();
    const offs = [on('channels.log', (d: any) => d.binding_id === b.id && d.direction === 'in' && load()), on('channels.conversation', () => load())];
    return () => offs.forEach((f) => f());
  }, [b.id, load]);
  const setPaused = async (c: ConversationRow, paused: boolean) => {
    try {
      await api.patch(`/channels/conversations/${c.id}`, { paused });
      toast(paused ? 'Bot gepauzeerd in dit gesprek' : 'Bot antwoordt weer', 'ok');
      load();
    } catch (e) {
      toastError(e);
    }
  };
  const release = async (c: ConversationRow) => {
    try {
      await api.post(`/channels/conversations/${c.id}/release`);
      toast('De bot antwoordt weer in dit gesprek', 'ok');
      load();
    } catch (e) {
      toastError(e);
    }
  };
  if (err) return <div className="text-sm text-danger">{err}</div>;
  if (!rows)
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  if (!rows.length)
    return (
      <EmptyState icon={<MessageSquare className="h-8 w-8" />} title="Nog geen gesprekken">
        Zodra iemand van de allowlist de bot schrijft, verschijnt het gesprek hier.
      </EmptyState>
    );
  return (
    <Card>
      <ul className="divide-y divide-line">
        {rows.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 px-4 py-3">
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-1.5 text-sm font-medium">
                <span translate="no">{c.title}</span>
                <Badge>{c.is_private ? 'privé' : 'groep'}</Badge>
                {c.handoff ? (
                  <Badge tone="warn">
                    <Headset className="h-3 w-3" aria-hidden /> doorgezet naar jou
                  </Badge>
                ) : (
                  c.paused && <Badge tone="warn">bot gepauzeerd</Badge>
                )}
              </div>
              {c.handoff && (
                <div className="text-xs text-warn" translate="no">
                  {c.handoff.reason}
                </div>
              )}
              <div className="text-xs text-muted">
                {c.last_sender ? `${c.last_sender} · ` : ''}in {fmtTime(c.last_inbound_at)} · uit {fmtTime(c.last_outbound_at)}
              </div>
            </div>
            {c.thread_id && (
              <Button size="sm" variant="secondary" onClick={() => navigate(`/t/${c.thread_id}`)} icon={<MessageSquare className="h-3.5 w-3.5" />}>
                Meelezen
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setReply(c)} icon={<Reply className="h-3.5 w-3.5" />}>
              Zelf antwoorden
            </Button>
            {c.handoff ? (
              <Button size="sm" variant="ghost" onClick={() => release(c)} icon={<Undo2 className="h-3.5 w-3.5" />}>
                Vrijgeven
              </Button>
            ) : (
              <Button size="sm" variant="ghost" onClick={() => setPaused(c, !c.paused)} icon={c.paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />}>
                {c.paused ? 'Hervatten' : 'Pauzeren'}
              </Button>
            )}
          </li>
        ))}
      </ul>
      {reply && <ReplyModal open conversationId={reply.id} title={reply.title} onClose={() => setReply(null)} />}
    </Card>
  );
}

// ------------------------------------------------------------------ log

interface OutboxRow {
  id: string;
  kind: string;
  status: string;
  text: string | null;
  draft: string | null;
  question: string | null;
  reasons: string[];
  edited: boolean;
  error: string | null;
  conversation_ext: string | null;
  created_at: string;
  sent_at: string | null;
}

const OUT_STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  sent: { label: 'verstuurd', tone: 'ok' },
  failed: { label: 'mislukt', tone: 'danger' },
  held: { label: 'wacht op jou', tone: 'warn' },
  sending: { label: 'wordt verstuurd', tone: 'warn' },
  handoff: { label: 'niet verstuurd: doorgezet', tone: 'warn' },
  rejected: { label: 'tegengehouden door jou', tone: 'neutral' },
};
const OUT_KIND: Record<string, string> = { reply: 'antwoord van de bot', handoff: 'doorzetbericht', owner: 'jouw antwoord', system: 'systeembericht', send: 'bericht van de bot', routine: 'routine', message: 'bericht' };

/** Everything that went to customers on this channel, with the full text (the owner's record). */
function OutboxList({ b }: { b: BindingDetail }) {
  const [rows, setRows] = useState<OutboxRow[] | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    const load = () => api.get<OutboxRow[]>(`/channels/bindings/${b.id}/outbox`).then(setRows, (e) => setErr(e.message));
    load();
    return on('channels.log', (d: any) => d.binding_id === b.id && d.direction !== 'in' && load());
  }, [b.id]);
  if (err) return <div className="text-sm text-danger">{err}</div>;
  if (!rows)
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  if (!rows.length) return <EmptyState title="Nog niets verstuurd aan klanten">Elk bericht dat via dit kanaal naar een klant gaat, staat hier met de volledige tekst.</EmptyState>;
  return (
    <Card>
      <ul className="divide-y divide-line">
        {rows.map((r) => {
          const st = OUT_STATUS[r.status] || { label: r.status, tone: 'neutral' as const };
          return (
            <li key={r.id} className="space-y-1 px-4 py-3 text-sm">
              <div className="flex flex-wrap items-center gap-1.5">
                <Badge tone={st.tone}>{st.label}</Badge>
                <span className="text-xs text-muted">{OUT_KIND[r.kind] || r.kind}</span>
                {r.edited && <Badge>aangepast door jou</Badge>}
                {r.conversation_ext && <span className="font-mono text-xs text-muted">{r.conversation_ext}</span>}
                <span className="text-xs text-muted">{fmtTime(r.sent_at || r.created_at)}</span>
              </div>
              {r.text && (
                <div translate="no" className="whitespace-pre-wrap break-words">
                  {r.text}
                </div>
              )}
              {r.status === 'handoff' && r.draft && (
                <details className="text-xs text-muted">
                  <summary className="cursor-pointer">Concept van de bot (niet verstuurd)</summary>
                  <div translate="no" className="whitespace-pre-wrap break-words">
                    {r.draft}
                  </div>
                </details>
              )}
              {r.reasons.length > 0 && <div className="text-xs text-muted">{r.reasons.join(' · ')}</div>}
              {r.error && <div className="text-xs text-danger">{r.error}</div>}
            </li>
          );
        })}
      </ul>
    </Card>
  );
}

function LogTab({ b, reload }: { b: BindingDetail; reload(): void }) {
  const [view, setView] = useState<'events' | 'outbox'>('events');
  const customer = !!b.config.customer?.enabled;
  return (
    <>
      {customer && (
        <Tabs<'events' | 'outbox'>
          value={view}
          onChange={setView}
          tabs={[
            { id: 'events', label: 'Gebeurtenissen' },
            { id: 'outbox', label: 'Verstuurd aan klanten' },
          ]}
        />
      )}
      {customer && view === 'outbox' ? <OutboxList b={b} /> : <EventLog b={b} reload={reload} />}
    </>
  );
}

function EventLog({ b, reload }: { b: BindingDetail; reload(): void }) {
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [err, setErr] = useState('');
  const [more, setMore] = useState(true);
  const act = useAsync();
  useEffect(() => {
    api.get<LogRow[]>(`/channels/bindings/${b.id}/log`).then((r) => (setRows(r), setMore(r.length >= 200)), (e) => setErr(e.message));
    return on('channels.log', (d: LogRow) => d.binding_id === b.id && setRows((x) => (x ? [d, ...x].slice(0, 1000) : x)));
  }, [b.id]);
  const older = () =>
    act.run(async () => {
      const last = rows?.at(-1);
      if (!last) return;
      const r = await api.get<LogRow[]>(`/channels/bindings/${b.id}/log?before=${last.id}`);
      setRows((x) => [...(x || []), ...r]);
      setMore(r.length >= 200);
    });
  const allow = (l: LogRow) =>
    act.run(async () => {
      await api.post(`/channels/bindings/${b.id}/senders`, { external_id: l.sender_id, label: l.sender_name || l.sender_id, source: 'log' });
      reload();
    }, 'Toegevoegd aan de allowlist');
  const allowed = new Set(b.senders.map((s) => s.external_id));
  if (err) return <div className="text-sm text-danger">{err}</div>;
  if (!rows)
    return (
      <div className="flex justify-center py-8">
        <Spinner />
      </div>
    );
  if (!rows.length) return <EmptyState title="Nog niets gelogd">Berichten, geweigerde afzenders en verbindingsfouten.</EmptyState>;
  return (
    <Card>
      <ul className="divide-y divide-line">
        {rows.map((l) => {
          const DirIcon = l.direction === 'in' ? ArrowDownLeft : l.direction === 'out' ? ArrowUpRight : Info;
          const kind = LOG_KIND[l.kind] || { label: l.kind.replace(/_/g, ' ') };
          const bad = !!kind.bad;
          return (
            <li key={l.id} className="flex items-start gap-3 px-4 py-2.5 text-sm">
              <DirIcon className={cx('mt-0.5 h-4 w-4 shrink-0', bad ? 'text-danger' : 'text-muted')} aria-label={l.direction === 'in' ? 'binnen' : l.direction === 'out' ? 'uit' : 'systeem'} />
              <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-1.5">
                  <Badge tone={bad ? 'danger' : l.kind === 'message' ? 'neutral' : 'accent'}>{kind.label}</Badge>
                  {l.sender_name && (
                    <span className="font-medium" translate="no">
                      {l.sender_name}
                    </span>
                  )}
                  {l.sender_id && <span className="font-mono text-xs text-muted">{l.sender_id}</span>}
                  <span className="text-xs text-muted">{fmtTime(l.created_at)}</span>
                </div>
                <div className="break-words text-muted">{l.summary}</div>
              </div>
              {l.kind === 'blocked' && l.sender_id && !allowed.has(l.sender_id) && (
                <Button size="sm" variant="secondary" onClick={() => allow(l)} icon={<UserPlus className="h-3.5 w-3.5" />}>
                  Toestaan
                </Button>
              )}
            </li>
          );
        })}
      </ul>
      {more && (
        <div className="border-t border-line p-2 text-center">
          <Button size="sm" variant="ghost" onClick={older} loading={act.busy}>
            Oudere regels
          </Button>
        </div>
      )}
    </Card>
  );
}

// ------------------------------------------------------------------ settings

function SettingsTab({ b, info, reload }: { b: BindingDetail; info: AdaptersInfo | null; reload(): void }) {
  const guide = GUIDES[b.adapter];
  const [name, setName] = useState(b.name);
  const [config, setConfig] = useState<Record<string, any>>({ ...(guide?.defaults || {}), ...b.config });
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  const [advanced, setAdvanced] = useState(false);
  const save = useAsync();
  if (!guide) return <div className="text-sm text-muted">Voor dit kanaaltype zijn geen instellingen.</div>;
  const submit = () =>
    save.run(async () => {
      const conf = { ...config };
      for (const f of guide.fields) if (f.kind === 'secret') delete conf[f.key];
      delete conf.customer; // saved on the Klanten tab
      const s = Object.fromEntries(Object.entries(secrets).filter(([, v]) => v.trim()));
      await api.patch(`/channels/bindings/${b.id}`, { name, config: conf, secrets: s });
      setSecrets({});
      reload();
    }, 'Opgeslagen — opnieuw verbinden…');
  return (
    <Card className="space-y-4 p-4">
      <Field label="Naam">
        <Input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
      </Field>
      <ConfigForm
        guide={{ ...guide, fields: guide.fields.map((f) => (f.generate ? { ...f, generate: false } : f)) }}
        config={config}
        onConfig={setConfig}
        secrets={secrets}
        onSecrets={setSecrets}
        existingSecrets={b.secrets}
        advanced={advanced}
      />
      <PublicUrlNote info={info} guide={guide} config={config} />
      {guide.fields.some((f) => f.advanced) && <Toggle checked={advanced} onChange={setAdvanced} label="Geavanceerde instellingen tonen" />}
      <p className="text-xs text-muted">Tokens en wachtwoorden worden versleuteld opgeslagen en nooit meer getoond. Vul een veld alleen in om het te vervangen.</p>
      <Button variant="primary" onClick={submit} loading={save.busy}>
        Opslaan
      </Button>
    </Card>
  );
}
