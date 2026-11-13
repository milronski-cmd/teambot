import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, ChevronDown, Copy, ExternalLink, Globe, ShieldCheck } from 'lucide-react';
import { api, on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { Badge, Button, Card, Field, Input, Modal, Select, Spinner, Toggle, cx, copyText } from '../../components/ui';
import { ConnectCard, ConnectResult, type ConnectState } from '../../components/ConnectCard';
import { MoreInfo } from '../../components/MoreInfo';
import { useIsPhoneSession } from '../../shell/computerOnly';
import { Ext, GUIDES, type Guide, type Requirement } from './guides';
import { ADAPTER_ORDER, MORE_ADAPTERS, PICK_BADGE, QR_RISK, needsRiskAck, pickerOrder } from './picker';
import { ConfigForm } from './ConfigForm';
import { PhoneLink } from './HealthCard';
import { ADAPTER_ICON, randomSecret, type AdaptersInfo, type BindingDetail, type BindingView } from './shared';
import { WhatsAppHonestNote, WhatsAppLink } from './WhatsAppLink';
import { autoChannelName } from './name';

export function RequirementBadges({ list }: { list: Requirement[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {list.map((r) => (
        <Badge key={r.text} tone={r.tone === 'ok' ? 'ok' : r.tone === 'warn' ? 'warn' : 'danger'}>
          {r.text}
        </Badge>
      ))}
    </div>
  );
}

/** Pick "agent:<id>" or "room:<id>". */
export function TargetSelect({ value, onChange, rooms }: { value: string; onChange(v: string): void; rooms: { id: string; name: string }[] }) {
  const agents = useApp((s) => s.agents);
  const active = useMemo(() => agents.filter((a) => !a.archived), [agents]);
  return (
    <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Bot of groep die antwoordt">
      <option value="">Kies een bot…</option>
      <optgroup label="Bots">
        {active.map((a) => (
          <option key={a.id} value={`agent:${a.id}`} translate="no">
            {a.name}
          </option>
        ))}
      </optgroup>
      {rooms.length > 0 && (
        <optgroup label="Groepen">
          {rooms.map((r) => (
            <option key={r.id} value={`room:${r.id}`} translate="no">
              {r.name}
            </option>
          ))}
        </optgroup>
      )}
    </Select>
  );
}

export const targetValue = (b: { agent_id: string | null; room_id: string | null }) => (b.agent_id ? `agent:${b.agent_id}` : b.room_id ? `room:${b.room_id}` : '');
export const targetBody = (v: string) => (v.startsWith('room:') ? { room_id: v.slice(5), agent_id: null } : { agent_id: v.slice(6) || null, room_id: null });

export function useRooms() {
  const [rooms, setRooms] = useState<{ id: string; name: string }[]>([]);
  useEffect(() => {
    api.get('/channels/rooms').then(setRooms, () => setRooms([]));
  }, []);
  return rooms;
}

function SlackManifest({ mode, name }: { mode: string; name: string }) {
  const [text, setText] = useState('');
  const [err, setErr] = useState('');
  useEffect(() => {
    const q = new URLSearchParams({ mode: mode || 'socket', name: name || 'TeamBot' });
    api.get(`/channels/slack-manifest?${q}`).then(
      (m) => (setText(JSON.stringify(m, null, 2)), setErr('')),
      (e) => setErr(e.message),
    );
  }, [mode, name]);
  if (err) return <div className="text-sm text-danger">{err}</div>;
  return (
    <div className="relative">
      <pre className="scroll-thin max-h-32 overflow-auto rounded-lg border border-line bg-canvas p-3 font-mono text-xs">{text || '…'}</pre>
      <Button size="sm" variant="secondary" className="absolute end-2 top-2" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copyText(text, 'Manifest gekopieerd')} disabled={!text}>
        Kopieer
      </Button>
    </div>
  );
}

export function PublicUrlNote({ info, guide, config }: { info: AdaptersInfo | null; guide: Guide; config: Record<string, any> }) {
  const needs = guide.requirements(config).some((r) => /publieke/i.test(r.text) && r.tone !== 'ok');
  if (!needs) return null;
  const base = String(config.publicBaseUrl || info?.publicUrl || '');
  return (
    <Card className={cx('flex gap-3 p-3 text-sm', base ? 'bg-surface-2' : 'bg-warn-soft')}>
      <Globe className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
      <div className="space-y-1">
        {base ? (
          <div>
            Publieke URL: <span className="font-mono">{base}</span>. Het platform stuurt berichten naar die URL; TeamBot controleert elke aanvraag met de handtekening.
          </div>
        ) : (
          <div>
            <b>Nog geen publiek adres.</b> Dit kanaal ontvangt berichten via een webhook, dus TeamBot moet via internet bereikbaar zijn op een https-adres. Vul dat adres in bij “Publieke URL voor deze koppeling” (bij een
            webhook onder de geavanceerde instellingen), bijvoorbeeld het adres van een tunnel zoals Cloudflare Tunnel of Tailscale Funnel. Draai je TeamBot op een eigen server, dan kan de beheerder één vast adres voor alle koppelingen instellen
            (zie de handleiding over zelf hosten). Zonder adres kun je opslaan, maar komen er geen berichten binnen.
          </div>
        )}
      </div>
    </Card>
  );
}

/** The warning for WhatsApp via QR code, with an explicit "I understand" before anything connects. */
function QrRiskStep({ accepted, onAccepted, onOfficial }: { accepted: boolean; onAccepted(v: boolean): void; onOfficial(): void }) {
  return (
    <div className="space-y-4">
      <WhatsAppHonestNote />
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" checked={accepted} onChange={(e) => onAccepted(e.target.checked)} className="mt-0.5 h-4 w-4 accent-[var(--color-accent)]" />
        <span>{QR_RISK.accept}</span>
      </label>
      <Card className="flex flex-wrap items-center gap-3 bg-surface-2 p-3 text-sm">
        <ShieldCheck className="h-4 w-4 shrink-0 text-ok" aria-hidden />
        <span className="min-w-0 flex-1">Voor je bedrijf zonder dit risico: WhatsApp Business (officieel), of Telegram.</span>
        <Button size="sm" variant="secondary" onClick={onOfficial}>
          Kies WhatsApp Business
        </Button>
      </Card>
    </div>
  );
}

/** The one line under the e-mail address: what this provider wants instead of the normal password. */
export function mailHint(address: string): { tone: 'info' | 'warn'; text: string; link?: { href: string; label: string } } | null {
  const d = address.trim().toLowerCase().split('@')[1] || '';
  if (/^(gmail|googlemail)\.com$/.test(d)) return { tone: 'info', text: 'Gmail vraagt een app-wachtwoord, niet je gewone wachtwoord.', link: { href: 'https://myaccount.google.com/apppasswords', label: 'App-wachtwoord maken' } };
  if (/^(outlook|hotmail|live|msn)\.(com|nl)$/.test(d)) return { tone: 'warn', text: 'Outlook.com en Hotmail staan inloggen met een wachtwoord niet meer toe. Stuur de mail door naar een ander adres en koppel dat.' };
  if (/^(icloud|me|mac)\.com$/.test(d)) return { tone: 'info', text: 'iCloud vraagt een app-specifiek wachtwoord.', link: { href: 'https://account.apple.com/account/manage', label: 'App-wachtwoord maken' } };
  if (/^(yahoo\.(com|nl)|ymail\.com)$/.test(d)) return { tone: 'info', text: 'Yahoo vraagt een app-wachtwoord.', link: { href: 'https://login.yahoo.com/account/security', label: 'App-wachtwoord maken' } };
  return null;
}

/** Channels whose token or password TeamBot tries before the channel exists ("Koppelen en testen"). */
const VERIFY = new Set(['telegram', 'discord', 'slack', 'email']);
/** Channels where the owner proves it works by sending the bot a one-time code (it also puts him on the allowlist). */
const PAIR = new Set(['telegram', 'discord', 'slack']);

interface PairStart {
  code: string;
  command: string;
  deepLink: string | null;
  qrSvg: string | null;
  expires_at: string;
}

function CopyLine({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0 text-sm">
      <div className="text-xs text-muted">{label}</div>
      <div className="flex items-center gap-2">
        <code translate="no" className="min-w-0 flex-1 break-all rounded-lg bg-surface-2 px-2 py-1.5 font-mono text-xs">
          {value}
        </code>
        <Button size="sm" variant="secondary" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => copyText(value)}>
          Kopieer
        </Button>
      </div>
    </div>
  );
}

/**
 * After "Koppelen": the channel exists; this is its last step, live. Telegram, Discord and Slack: send the bot the
 * one-time code (Telegram: one tap on a link or QR code), which proves receiving and sending and puts the owner on the
 * allowlist. WhatsApp: the QR code. E-mail: both logins were tested. Webhook: the address and the secret.
 */
function Connected({ created, tested, secret, own }: { created: BindingView; tested?: { ok: boolean; detail: string } | null; secret?: string; own?: string }) {
  const id = created.id;
  const [b, setB] = useState<BindingDetail | null>(null);
  const [pair, setPair] = useState<PairStart | null>(null);
  const [pairErr, setPairErr] = useState('');
  const asked = useRef(false);
  const phone = useIsPhoneSession();
  const load = useCallback(() => api.get<BindingDetail>(`/channels/bindings/${id}`).then(setB, () => undefined), [id]);
  useEffect(() => {
    load();
    const offs = ['channels.status', 'channels.health', 'channels.updated', 'channels.whatsapp'].map((ev) => on(ev, (d: any) => d?.id === id && load()));
    return () => offs.forEach((f) => f());
  }, [id, load]);

  const adapter = created.adapter;
  const ownerPaired = !!b?.senders.some((s) => s.is_owner);
  const up = !!b && b.enabled && (b.status === 'connected' || b.status === 'listening');
  // The one-time code, made once the bot is known (Telegram: its link needs the bot's name).
  useEffect(() => {
    if (!b || asked.current || !PAIR.has(adapter) || ownerPaired || phone) return;
    if (adapter === 'telegram' && !b.info?.botUsername) return;
    asked.current = true;
    api.post<PairStart>(`/channels/bindings/${id}/pair-codes`, { owner: true, label: 'Dit ben ik', minutes: 30 }).then(setPair, (e) => setPairErr(e.message));
  }, [b, adapter, ownerPaired, phone, id]);

  const Icon = ADAPTER_ICON[adapter];
  const failed = !!b && b.status === 'error';
  let state: ConnectState = 'busy';
  let label: string | undefined;
  if (failed) state = 'error';
  else if (adapter === 'whatsapp-web') {
    if (b?.link?.phase === 'ready') state = 'on';
    else label = b?.link?.phase === 'syncing' ? 'gegevens ophalen' : 'wacht op scannen';
  } else if (PAIR.has(adapter)) {
    if (ownerPaired || b?.health?.state === 'ok') state = 'on';
    else label = 'wacht op je bericht';
  } else if (adapter === 'webhook') {
    // No proof yet that a request arrives: never a green tick from a saved secret alone.
    state = 'off';
    label = 'klaar voor gebruik';
  } else state = 'on';

  const botName = b?.info?.botUsername ? `@${b.info.botUsername}` : b?.info?.botName || '';
  return (
    <ConnectCard
      icon={<Icon aria-hidden />}
      title={created.name}
      line={PAIR.has(adapter) && botName ? t('Token werkt: dit is {0}.', botName) : adapter === 'whatsapp-web' ? 'Scan de QR-code met WhatsApp op je telefoon.' : adapter === 'webhook' ? 'Zet dit adres en dit geheim in je integratie.' : undefined}
      state={state}
      stateLabel={label}
      data-testid="channel-connected"
      result={
        failed ? (
          <ConnectResult ok={false} next="Open de instellingen van dit kanaal om het te herstellen.">
            {b?.health?.reason || b?.last_error || 'Verbinden lukt niet'}
          </ConnectResult>
        ) : state === 'on' && adapter !== 'whatsapp-web' && adapter !== 'webhook' ? (
          <ConnectResult
            ok
            next={
              adapter === 'email'
                ? own
                  ? t('Mail je bot vanaf {0}: hij antwoordt in dezelfde draad.', own)
                  : 'Zet bij Toegang de adressen die de bot mogen mailen.'
                : 'Stuur je bot een bericht: hij antwoordt.'
            }
          >
            Verbinding werkt{tested?.detail && adapter === 'email' ? `: ${tested.detail}` : ''}
          </ConnectResult>
        ) : undefined
      }
    >
      {!b && <Spinner />}
      {b && adapter === 'whatsapp-web' && <WhatsAppLink b={b} reload={load} bare />}
      {b && PAIR.has(adapter) && state === 'busy' && (
        <div className="space-y-2">
          {pair?.deepLink ? (
            <PhoneLink link={pair.deepLink} qrSvg={pair.qrSvg} label="Open Telegram en druk op Start" />
          ) : pair ? (
            <>
              {adapter === 'discord' && b.info?.inviteUrl && (
                <a className="inline-flex items-center gap-1 text-sm font-medium text-accent underline" href={b.info.inviteUrl} target="_blank" rel="noreferrer noopener">
                  Nodig de bot uit op je server <ExternalLink className="h-3.5 w-3.5" />
                </a>
              )}
              <CopyLine label="Stuur je bot dit als privébericht" value={pair.command} />
            </>
          ) : pairErr || phone ? (
            <p className="text-sm text-muted">{phone ? 'Koppel jezelf op je computer: open de instellingen van dit kanaal en maak bij Toegang een koppelcode.' : pairErr}</p>
          ) : (
            <div className="flex items-center gap-2 text-sm text-muted">
              <Spinner /> {up ? 'Koppelcode maken…' : 'Verbinden…'}
            </div>
          )}
        </div>
      )}
      {b && adapter === 'webhook' && (
        <div className="space-y-2">
          {b.webhooks[0] && <CopyLine label="Adres (POST)" value={b.webhooks[0].url} />}
          {secret && <CopyLine label="Gedeeld geheim (TeamBot toont het hierna niet meer)" value={secret} />}
          <MoreInfo block label="Hoe stuur ik een bericht?">
            <ol className="list-decimal space-y-1 ps-4">
              {GUIDES.webhook
                .steps(b.config)
                .slice(1)
                .map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
            </ol>
          </MoreInfo>
        </div>
      )}
    </ConnectCard>
  );
}

/**
 * Kanaal toevoegen, in één keer: pick a channel, fill in the one or two things only the owner has (a token, an address
 * and password), and TeamBot tries them, connects and shows the last step live in the same dialog. Everything that has
 * a sensible default (name, mode, folders, limits) sits behind "Meer opties"; a refused token never becomes a channel.
 */
export function AddChannel({ open, onClose, info, initialAgentId, onCreated }: { open: boolean; onClose(): void; info: AdaptersInfo | null; initialAgentId?: string; onCreated(b: BindingView): void }) {
  const agents = useApp((s) => s.agents);
  const rooms = useRooms();
  const [adapter, setAdapter] = useState<string | null>(null);
  const [name, setName] = useState('');
  // The suggested name follows "Wie antwoordt?" until the owner types a name himself.
  const [nameTyped, setNameTyped] = useState(false);
  const [target, setTarget] = useState('');
  const [config, setConfig] = useState<Record<string, any>>({});
  const [secrets, setSecrets] = useState<Record<string, string>>({});
  // E-mail: the owner's own address goes on the allowlist right away, so his first mail is answered.
  const [own, setOwn] = useState('');
  // WhatsApp via QR: the warning first; the QR code only after "I understand".
  const [riskAccepted, setRiskAccepted] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<{ b: BindingView; tested?: { ok: boolean; detail: string } | null; secret?: string; own?: string } | null>(null);

  const active = useMemo(() => agents.filter((a) => !a.archived), [agents]);
  useEffect(() => {
    if (!open) return;
    setAdapter(null);
    setDone(null);
    setError('');
    setRiskAccepted(false);
    const first = initialAgentId || active[0]?.id;
    setTarget(first ? `agent:${first}` : '');
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const available = useMemo(() => pickerOrder(info ? info.adapters.map((a) => a.id) : ADAPTER_ORDER), [info]);
  const guide = adapter ? GUIDES[adapter] : null;
  const riskStep = !!adapter && needsRiskAck(adapter) && !done;

  const pick = (id: string) => {
    const g = GUIDES[id];
    setAdapter(id);
    setConfig({ ...g.defaults });
    const s: Record<string, string> = {};
    for (const f of g.fields) if (f.kind === 'secret' && f.generate) s[f.key] = randomSecret(32);
    setSecrets(s);
    setName(autoChannelName(target, g.title, agents, rooms));
    setNameTyped(false);
    setRiskAccepted(false);
    setError('');
    setOwn('');
  };

  const chooseTarget = (v: string) => {
    setTarget(v);
    if (guide && !nameTyped) setName(autoChannelName(v, guide.title, agents, rooms));
  };

  const submit = async () => {
    if (!guide || !adapter || busy) return;
    setError('');
    try {
      if (needsRiskAck(adapter) && !riskAccepted) throw new Error('Bevestig eerst dat je het risico van deze koppeling begrijpt');
      if (!target) throw new Error(active.length ? 'Kies welke bot (of groep) via dit kanaal antwoordt' : 'Maak eerst een bot; die antwoordt via dit kanaal.');
      const missing = guide.fields.filter((f) => (f.show ? f.show(config) : true) && ((f.kind === 'secret' && !secrets[f.key]?.trim()) || (f.required?.(config) && !String(config[f.key] ?? '').trim())));
      if (missing.length) throw new Error(t('Nog invullen: {0}', missing.map((f) => f.label).join(', ')));
      const conf: Record<string, any> = { ...config, ...(needsRiskAck(adapter) ? { riskAccepted: true } : {}) };
      for (const f of guide.fields) if (f.kind === 'secret') delete conf[f.key];
      setBusy(true);
      const from = location.hash;
      const b = await api.post<BindingView & { tested?: { ok: boolean; detail: string } }>('/channels/bindings', { adapter, name, ...targetBody(target), config: conf, secrets, verify: VERIFY.has(adapter) });
      const mine = adapter === 'email' ? own.trim().toLowerCase() : '';
      if (mine) await api.post(`/channels/bindings/${b.id}/senders`, { external_id: mine, label: 'Dit ben ik', is_owner: true }).catch(() => undefined);
      onCreated(b);
      // WhatsApp Business ends at Meta (webhook address, verify token): its own page shows those.
      if (!guide.quick) {
        onClose();
        navigate(`/m/channels/${b.id}`, { from });
        return;
      }
      setDone({ b, tested: b.tested, secret: adapter === 'webhook' ? secrets.signingSecret : undefined, own: mine });
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setBusy(false);
    }
  };

  const quick = guide?.quick;
  const quickGuide = guide && quick ? { ...guide, fields: guide.fields.filter((f) => quick.fields.includes(f.key)) } : null;
  const restGuide = guide && quick ? { ...guide, fields: guide.fields.filter((f) => !quick.fields.includes(f.key)) } : null;
  const manyTargets = active.length + rooms.length > 1;
  const hint = adapter === 'email' ? mailHint(String(config.address || '')) : null;
  const customerOn = !!config.customer?.enabled;
  const customer = <Toggle checked={customerOn} onChange={(v) => setConfig({ ...config, customer: { ...(config.customer || {}), enabled: v } })} label="Deze bot praat met klanten (klantenservice)" />;
  const who = (
    <Field label="Wie antwoordt?">
      <TargetSelect value={target} onChange={chooseTarget} rooms={rooms} />
    </Field>
  );
  const nameField = (
    <Field label="Naam van deze koppeling">
      <Input
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setNameTyped(true);
        }}
        maxLength={80}
      />
    </Field>
  );
  const row = (id: string) => {
    const g = GUIDES[id];
    const Icon = ADAPTER_ICON[id];
    const badge = PICK_BADGE[id];
    return (
      <button
        key={id}
        type="button"
        onClick={() => pick(id)}
        data-adapter={id}
        className="flex w-full items-center gap-3 rounded-xl border border-line bg-surface p-3 text-start transition hover:border-line-strong hover:bg-surface-2 focus-visible:border-accent"
      >
        <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-surface-2 text-muted">
          <Icon className="h-[18px] w-[18px]" aria-hidden />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2 font-medium">
            {g.title}
            {badge && <Badge tone={badge.tone}>{badge.text}</Badge>}
          </span>
          <span className="block text-sm text-muted">{g.tagline}</span>
        </span>
      </button>
    );
  };
  const more = available.filter((id) => MORE_ADAPTERS.includes(id));
  const fold = 'inline-flex cursor-pointer list-none items-center gap-1 rounded py-1 text-xs font-medium text-muted hover:text-fg [&::-webkit-details-marker]:hidden';

  return (
    <Modal
      open={open}
      onClose={onClose}
      wide
      title={done ? guide!.title : guide ? (riskStep ? 'Lees dit eerst' : t('{0} koppelen', guide.title)) : 'Kanaal toevoegen'}
      footer={
        done ? (
          <>
            <Button
              variant="ghost"
              onClick={() => {
                onClose();
                navigate(`/m/channels/${done.b.id}`);
              }}
            >
              Instellingen van dit kanaal
            </Button>
            <Button variant="primary" onClick={onClose}>
              Klaar
            </Button>
          </>
        ) : guide ? (
          <>
            <Button variant="ghost" onClick={() => setAdapter(null)} icon={<ArrowLeft className="h-4 w-4" />}>
              Terug
            </Button>
            <Button variant="primary" loading={busy} disabled={riskStep && !riskAccepted} onClick={submit}>
              {riskStep ? 'Toon de QR-code' : !quick ? 'Opslaan en verbinden' : VERIFY.has(adapter!) ? 'Koppelen en testen' : 'Koppelen'}
            </Button>
          </>
        ) : undefined
      }
    >
      {done ? (
        <Connected created={done.b} tested={done.tested} secret={done.secret} own={done.own} />
      ) : !guide ? (
        <div className="space-y-2">
          {available.filter((id) => !MORE_ADAPTERS.includes(id)).map(row)}
          {more.length > 0 && (
            <details className="group">
              <summary className={fold}>
                <ChevronDown className="h-3.5 w-3.5 transition-transform [details[open]>summary_&]:rotate-180" aria-hidden />
                Meer opties
                <span className="font-normal">· {more.map((id) => GUIDES[id].title).join(', ')}</span>
              </summary>
              <div className="mt-2 space-y-2">{more.map(row)}</div>
            </details>
          )}
        </div>
      ) : riskStep ? (
        <div className="space-y-4">
          <QrRiskStep accepted={riskAccepted} onAccepted={setRiskAccepted} onOfficial={() => pick('whatsapp')} />
          {manyTargets && who}
          {error && <ConnectResult ok={false}>{error}</ConnectResult>}
        </div>
      ) : quickGuide && restGuide ? (
        <div className="space-y-4">
          <p className="text-sm">{quick!.line}</p>
          {adapter === 'slack' && <SlackManifest mode={config.mode} name={name} />}
          <ConfigForm guide={quickGuide} config={config} onConfig={setConfig} secrets={secrets} onSecrets={setSecrets} advanced />
          {hint && (
            <p className={cx('text-sm', hint.tone === 'warn' ? 'text-warn' : 'text-muted')} data-testid="mail-hint">
              {hint.text} {hint.link && <Ext href={hint.link.href}>{hint.link.label}</Ext>}
            </p>
          )}
          {adapter === 'email' && (
            <Field label="Je eigen e-mailadres" hint="Alleen mail van dit adres beantwoordt de bot. Meer adressen voeg je later toe.">
              <Input type="email" autoComplete="email" value={own} onChange={(e) => setOwn(e.target.value)} placeholder="jij@voorbeeld.nl" />
            </Field>
          )}
          {manyTargets && who}
          {error && <ConnectResult ok={false}>{error}</ConnectResult>}
          <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
            <MoreInfo block label="Hoe kom ik hieraan?">
              <ol className="list-decimal space-y-1.5 ps-4">
                {guide.steps(config).map((s, i) => (
                  <li key={i}>{s}</li>
                ))}
              </ol>
            </MoreInfo>
          </div>
          <details className="group">
            <summary className={fold}>
              <ChevronDown className="h-3.5 w-3.5 transition-transform [details[open]>summary_&]:rotate-180" aria-hidden />
              Meer opties
            </summary>
            <div className="mt-3 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {nameField}
                {!manyTargets && who}
              </div>
              <ConfigForm guide={restGuide} config={config} onConfig={setConfig} secrets={secrets} onSecrets={setSecrets} advanced />
              <PublicUrlNote info={info} guide={guide} config={config} />
              {customer}
            </div>
          </details>
        </div>
      ) : (
        <div className="space-y-5">
          <RequirementBadges list={guide.requirements(config)} />
          <ol className="list-decimal space-y-1.5 ps-5 text-sm">
            {guide.steps(config).map((s, i) => (
              <li key={i}>{s}</li>
            ))}
          </ol>
          <PublicUrlNote info={info} guide={guide} config={config} />
          <div className="grid gap-4 sm:grid-cols-2">
            {nameField}
            {who}
          </div>
          <ConfigForm guide={guide} config={config} onConfig={setConfig} secrets={secrets} onSecrets={setSecrets} advanced />
          {customer}
          {error && <ConnectResult ok={false}>{error}</ConnectResult>}
        </div>
      )}
    </Modal>
  );
}
