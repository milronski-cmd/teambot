import { useEffect, useState } from 'react';
import { AlertTriangle, Cloud, Cpu, KeyRound, Power, PowerOff, RefreshCw, ShieldCheck, Trash2 } from 'lucide-react';
import { Badge, Button, cx, Field, Input, Modal, Spinner, Toggle, useAsync } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { MoreInfo } from '../../components/MoreInfo';
import { cloud, fmtMoney, fmtTime, useLive, VM_STATUS, type CloudEstimate, type CloudOptions, type CloudProviderInfo, type CloudVm } from './api';
import { t } from '../../lib/i18n';

/** What differs per provider in the interface (the API supplies prices, types and regions). */
const PROVIDER_TEXT: Record<string, { short: string; tokenHint: string; note?: string; gpuNote?: string }> = {
  hetzner: {
    short: 'Hetzner',
    tokenHint: 'Hetzner Console › je project › Beveiliging › API-tokens › token met lees- en schrijfrechten.',
  },
  digitalocean: {
    short: 'DigitalOcean',
    tokenHint:
      'DigitalOcean › API › Tokens › Generate New Token met Full Access.',
    note: 'Het root-wachtwoord uit de mail van DigitalOcean werkt niet; TeamBot zet het uit.',
    gpuNote:
      'GPU-droplets zijn duur en worden per uur gerekend, ook als ze uit staan. DigitalOcean moet ze vaak eerst vrijgeven.',
  },
};
const textOf = (id: string) => PROVIDER_TEXT[id] || { short: id, tokenHint: 'Maak een API-token met lees- en schrijfrechten bij je provider.' };

/**
 * "Cloud-VM" inside computer mode "Eigen server (SSH)": TeamBot creates a VM (Hetzner or DigitalOcean, incl. GPU
 * droplets) with a host key it generates itself (no "Vertrouwen" needed) and points the bot at it once it is up.
 * Costs come from the provider's API and are shown before and after.
 */
export function CloudVmPanel({ agentId }: { agentId: string }) {
  const info = useLive(() => cloud.forAgent(agentId), ['cloudvm.updated', 'computer.config'], [agentId]);
  const provs = useLive(() => cloud.providers(), [], []);
  const [provider, setProvider] = useState<string | null>(null);
  const list = provs.data || [];
  useEffect(() => {
    if (!provider && list.length) setProvider((list.find((p) => p.has_token) || list[0]).id);
  }, [list, provider]);
  if ((info.loading && !info.data) || (provs.loading && !provs.data)) return <Spinner />;
  if (info.error || provs.error) return <p className="text-sm text-danger">{info.error || provs.error}</p>;
  if (info.data?.vm) return <VmCard vm={info.data.vm} onChange={info.reload} detailed />;
  if (!info.data?.allowed || !list.length) return <p className="rounded-lg border border-line bg-surface-2 p-3 text-sm">{info.data?.reason || 'Cloud-VM’s zijn hier niet beschikbaar.'}</p>;
  const p: CloudProviderInfo = list.find((x) => x.id === provider) || list[0];
  return (
    <div className="space-y-3">
      <div className="inline-flex flex-wrap rounded-lg border border-line p-0.5" role="group" aria-label="Cloudprovider">
        {list.map((x) => (
          <button key={x.id} type="button" aria-pressed={x.id === p.id} onClick={() => setProvider(x.id)} className={cx('rounded-md px-3 py-1 text-sm', x.id === p.id ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:text-fg')}>
            {x.label}
            {x.has_token ? ' ✓' : ''}
          </button>
        ))}
      </div>
      {p.has_token ? <CreateForm key={p.id} agentId={agentId} provider={p} onCreated={info.reload} onForgetToken={provs.reload} /> : <TokenForm key={p.id} provider={p} onSaved={provs.reload} />}
    </div>
  );
}

function TokenForm({ provider, onSaved }: { provider: CloudProviderInfo; onSaved(): void }) {
  const { busy, run } = useAsync();
  const [token, setToken] = useState('');
  const tx = textOf(provider.id);
  return (
    <form
      className="space-y-3 rounded-lg border border-line p-3"
      onSubmit={(e) => {
        e.preventDefault();
        run(async () => {
          await cloud.saveToken(provider.id, token);
          setToken('');
          onSaved();
        }, 'Token opgeslagen');
      }}
    >
      <Field label={`API-token van ${provider.label}`} hint={`${tx.tokenHint} Wordt versleuteld bewaard en nooit meer getoond.`}>
        <Input type="password" value={token} onChange={(e) => setToken(e.target.value)} autoComplete="off" spellCheck={false} />
      </Field>
      <Button type="submit" size="sm" variant="primary" icon={<KeyRound className="h-4 w-4" />} loading={busy} disabled={!token.trim()}>
        Token opslaan
      </Button>
    </form>
  );
}

type ServerType = CloudOptions['types'][number];

function typeLabel(t: ServerType, loc: string, cur: string) {
  const p = t.prices[loc];
  const gpu = t.gpu ? `${t.gpu.count}× ${t.gpu.model} (${t.gpu.vramGb} GB), ` : '';
  return `${t.name} — ${gpu}${t.cores} vCPU, ${t.memoryGb} GB, ${t.diskGb} GB${t.architecture !== 'x86' ? ` (${t.architecture})` : ''} — ${fmtMoney(p.monthlyGross, cur)}/mnd`;
}

function CreateForm({ agentId, provider, onCreated, onForgetToken }: { agentId: string; provider: CloudProviderInfo; onCreated(): void; onForgetToken(): void }) {
  const opts = useLive(() => cloud.options(provider.id), [], [provider.id]);
  const { busy, run } = useAsync();
  const [loc, setLoc] = useState('');
  const [type, setType] = useState('');
  const [image, setImage] = useState('');
  const [docker, setDocker] = useState(false);
  const [est, setEst] = useState<CloudEstimate | null>(null);
  const [estErr, setEstErr] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const o = opts.data;
  const tx = textOf(provider.id);
  const label = provider.label;

  useEffect(() => {
    if (!o?.defaults || loc) return;
    setLoc(o.defaults.location);
    setType(o.defaults.serverType);
    setImage(o.defaults.image);
  }, [o, loc]);

  const types = (o?.types || []).filter((t) => t.prices[loc]).sort((a, b) => a.prices[loc].monthlyGross - b.prices[loc].monthlyGross);
  const standard = types.filter((t) => t.group !== 'gpu');
  const gpus = types.filter((t) => t.group === 'gpu');
  const gpuElsewhere = (o?.types || []).some((t) => t.group === 'gpu') && !gpus.length;
  useEffect(() => {
    if (loc && types.length && !types.some((t) => t.name === type)) setType((standard[0] || types[0]).name);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loc, o]);
  useEffect(() => {
    if (!type || !loc) return;
    let alive = true;
    setEst(null);
    setEstErr(null);
    cloud
      .estimate(provider.id, type, loc)
      .then((e) => alive && setEst(e))
      .catch((e) => alive && setEstErr(e?.message || String(e)));
    return () => {
      alive = false;
    };
  }, [type, loc, provider.id]);

  if (opts.loading && !o) return <Spinner />;
  if (opts.error || !o) return <p className="text-sm text-danger">{opts.error || 'Kon de mogelijkheden van de provider niet ophalen.'}</p>;
  const cur = o.currency;
  const tax = (e: CloudEstimate | null) => (e && !e.taxIncluded ? 'excl. btw' : 'incl. btw');
  const create = () =>
    run(async () => {
      if (!est) return;
      await cloud.create(agentId, { provider: provider.id, server_type: type, location: loc, image, docker, confirmCost: est.confirm });
      setConfirm(false);
      setUnderstood(false);
      onCreated();
    }, 'VM wordt aangemaakt; dat duurt meestal een paar minuten');

  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium">
          <Cloud className="h-4 w-4" aria-hidden /> Nieuwe cloud-VM bij {label}
        </div>
        <div className="flex items-center gap-2">
          <Badge tone="ok">
            <KeyRound className="h-3 w-3" aria-hidden /> Token opgeslagen
          </Badge>
          <Button size="sm" variant="ghost" loading={busy} onClick={() => run(async () => (await cloud.forgetToken(provider.id), onForgetToken()), 'Token vergeten')}>
            Vergeten
          </Button>
        </div>
      </div>
      <p className="text-sm text-muted">
        TeamBot maakt de VM aan, zet zelf een gebruiker <code>teambot</code> zonder sudo klaar en maakt ook de sleutel van de server zelf. Daardoor is de verbinding vanaf het begin gecontroleerd; je hoeft niets te vertrouwen. Zodra de VM klaar is,
        werkt de bot erop.
      </p>
      {tx.note && <p className="text-xs text-muted">{tx.note}</p>}
      <div className="grid gap-3 sm:grid-cols-3">
        <Field label="Locatie">
          <Select value={loc} onChange={(e) => setLoc(e.target.value)}>
            {o.locations.map((l) => (
              <option key={l.name} value={l.name}>
                {l.city || l.description} ({l.country ? `${l.country}, ` : ''}
                {l.name})
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Type" hint={gpuElsewhere ? 'GPU-types zijn er niet op deze locatie; kies een andere regio om ze te zien.' : undefined}>
          <Select value={type} onChange={(e) => setType(e.target.value)}>
            {gpus.length ? (
              <>
                <optgroup label="Standaard">
                  {standard.map((t) => (
                    <option key={t.name} value={t.name}>
                      {typeLabel(t, loc, cur)}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="GPU">
                  {gpus.map((t) => (
                    <option key={t.name} value={t.name}>
                      {typeLabel(t, loc, cur)}
                    </option>
                  ))}
                </optgroup>
              </>
            ) : (
              standard.map((t) => (
                <option key={t.name} value={t.name}>
                  {typeLabel(t, loc, cur)}
                </option>
              ))
            )}
          </Select>
        </Field>
        <Field label="Systeem">
          <Select value={image} onChange={(e) => setImage(e.target.value)}>
            {o.images.map((i) => (
              <option key={i.name} value={i.name}>
                {i.description}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      {est?.gpu && tx.gpuNote && (
        <p className="flex items-start gap-2 rounded-lg border border-warn bg-warn-soft p-3 text-sm">
          <Cpu className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
          <span>{tx.gpuNote}</span>
        </p>
      )}
      <Toggle checked={docker} onChange={setDocker} label="Docker installeren en de opdrachten van de bot in Docker draaien (zonder netwerk)" />
      <div className="rounded-lg border border-warn bg-warn-soft p-3 text-sm" aria-live="polite">
        {est ? (
          <>
            <div className="font-medium">
              Geschatte kosten: {fmtMoney(est.totalMonthlyGross, cur)} per maand ({tax(est)})
            </div>
            <div className="text-xs">
              {est.ipv4Included ? 'Inclusief een openbaar IPv4-adres' : est.ipv4MonthlyGross !== null ? `Server ${fmtMoney(est.serverMonthlyGross, cur)} + IPv4-adres ${fmtMoney(est.ipv4MonthlyGross, cur)}` : 'Excl. IPv4-adres (prijs onbekend)'} · ongeveer{' '}
              {fmtMoney(est.hourlyGross, cur)} per uur. Prijzen komen van {label}
              {est.taxIncluded ? '' : '; btw of andere belasting komt er op de factuur nog bij'}.
            </div>
          </>
        ) : estErr ? (
          <span className="text-danger">{estErr}</span>
        ) : (
          <Spinner />
        )}
        <p className="mt-1 text-xs">{label} rekent tot je de VM verwijdert, óók als hij uit staat. Je betaalt dit zelf bij {label}; het telt niet mee voor het dagbudget van je bots.</p>
      </div>
      <Button variant="primary" icon={<Cloud className="h-4 w-4" />} disabled={!est || !image} onClick={() => setConfirm(true)}>
        VM aanmaken…
      </Button>
      <Modal
        open={confirm}
        onClose={() => setConfirm(false)}
        title="Cloud-VM aanmaken"
        footer={
          <>
            <Button onClick={() => setConfirm(false)}>Annuleren</Button>
            <Button variant="primary" disabled={!understood || !est} loading={busy} onClick={create}>
              Aanmaken voor ≈ {fmtMoney(est?.totalMonthlyGross, cur)} per maand
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>
            Bij {label} wordt een server <strong>{type}</strong> in <strong>{loc}</strong> met {o.images.find((i) => i.name === image)?.description || image} aangemaakt{docker ? ', met Docker' : ''}.
          </p>
          <ul className="list-disc space-y-1 ps-5">
            <li>
              Kosten: ongeveer {fmtMoney(est?.totalMonthlyGross, cur)} per maand ({tax(est)}), tot je de VM verwijdert (ook als hij uit staat).
            </li>
            {est?.gpu && <li>Dit is een GPU-server: controleer of DigitalOcean GPU’s voor je account heeft vrijgegeven.</li>}
            <li>De bot krijgt op die VM alle rechten van de gebruiker teambot (geen sudo).</li>
            <li>Uitzetten, aanzetten en verwijderen doe je hier of op de pagina Computers.</li>
          </ul>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
            Ik begrijp dat dit ongeveer {fmtMoney(est?.totalMonthlyGross, cur)} per maand kost tot ik de VM verwijder
          </label>
        </div>
      </Modal>
    </div>
  );
}

export function VmStatusBadge({ vm }: { vm: CloudVm }) {
  const s = VM_STATUS[vm.status] || VM_STATUS.error;
  return <Badge tone={s.tone}>{s.label}</Badge>;
}

/** One VM: status, address, cost, pinned key and the actions. Used in the bot editor and on the Computers page. */
export function VmCard({ vm, onChange, detailed }: { vm: CloudVm; onChange(): void; detailed?: boolean }) {
  const cur = vm.price.currency || 'EUR';
  return (
    <div className="space-y-2 rounded-lg border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <Cloud className="h-4 w-4 shrink-0 text-muted" aria-hidden />
        <span className="font-medium">{vm.name}</span>
        <Badge>{textOf(vm.provider).short}</Badge>
        {vm.price.gpu && <Badge tone="warn">GPU</Badge>}
        <VmStatusBadge vm={vm} />
        {!detailed && <span className="text-xs text-muted">{vm.agent_id ? `bot: ${vm.agent_name}` : `bot ${vm.agent_name || ''} is verwijderd`}</span>}
      </div>
      {vm.detail && (
        <p className={vm.status === 'error' ? 'text-danger' : 'text-muted'} role={vm.status === 'error' ? 'alert' : undefined}>
          {vm.detail}
        </p>
      )}
      <div className="grid gap-x-4 gap-y-1 text-xs text-muted sm:grid-cols-2">
        <div>
          {vm.server_type} · {vm.location} · {vm.image}
          {vm.docker ? ' · Docker' : ''}
        </div>
        <div>Adres: {vm.ip || 'nog niet bekend'}</div>
        <div>
          Kosten: ≈ {fmtMoney(vm.price.totalMonthlyGross, cur)} per maand{vm.price.taxIncluded === false ? ' excl. btw' : ''} (ook als hij uit staat)
        </div>
        <div>Aangemaakt: {fmtTime(vm.created_at)}</div>
      </div>
      {detailed && (
        <div className="flex flex-wrap items-center gap-1 text-xs text-muted">
          <ShieldCheck className="h-3 w-3 text-ok" aria-hidden /> Serversleutel gemaakt en vastgezet door TeamBot: <code className="break-all font-mono text-fg">{vm.host_fingerprint}</code>
        </div>
      )}
      {(vm.status === 'creating' || vm.status === 'booting' || vm.status === 'starting') && <p className="text-xs text-muted">Dit duurt meestal 1 tot 3 minuten (met Docker iets langer). Je kunt dit venster sluiten.</p>}
      <VmActions vm={vm} onChange={onChange} />
    </div>
  );
}

export function VmActions({ vm, onChange }: { vm: CloudVm; onChange(): void }) {
  const { busy, run } = useAsync();
  const [del, setDel] = useState(false);
  const [typed, setTyped] = useState('');
  const canOff = ['running', 'booting', 'starting', 'error'].includes(vm.status);
  const canOn = vm.status === 'off' || vm.status === 'error';
  return (
    <div className="flex flex-wrap gap-2">
      {canOff && (
        <Button size="sm" icon={<PowerOff className="h-4 w-4" />} loading={busy} onClick={() => run(async () => (await cloud.powerOff(vm.id), onChange()), 'VM wordt uitgezet (kost nog steeds geld tot je hem verwijdert)')}>
          Uitzetten
        </Button>
      )}
      {canOn && (
        <Button size="sm" icon={<Power className="h-4 w-4" />} loading={busy} onClick={() => run(async () => (await cloud.powerOn(vm.id), onChange()), 'VM wordt aangezet')}>
          Aanzetten
        </Button>
      )}
      <Button size="sm" variant="ghost" icon={<RefreshCw className="h-4 w-4" />} loading={busy} onClick={() => run(async () => (await cloud.refresh(vm.id), onChange()))}>
        Vernieuwen
      </Button>
      {vm.status !== 'deleting' && (
        <Button size="sm" variant="danger" icon={<Trash2 className="h-4 w-4" />} onClick={() => (setTyped(''), setDel(true))}>
          Verwijderen…
        </Button>
      )}
      <Modal
        open={del}
        onClose={() => setDel(false)}
        title={t('VM {0} verwijderen', vm.name)}
        footer={
          <>
            <Button onClick={() => setDel(false)}>Annuleren</Button>
            <Button
              variant="danger"
              disabled={typed.trim() !== vm.name}
              loading={busy}
              onClick={() =>
                run(async () => {
                  await cloud.remove(vm.id, typed.trim());
                  setDel(false);
                  onChange();
                }, 'VM wordt verwijderd')
              }
            >
              Definitief verwijderen
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p className="flex items-start gap-2">
            <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-hidden />
            <span>De VM en alles wat erop staat (ook de map van de bot) wordt bij {textOf(vm.provider).short} verwijderd. Dat kan niet ongedaan worden gemaakt. Haal eerst op wat je wilt bewaren (bijv. met remote_download).</span>
          </p>
          <p className="text-muted">Alleen verwijderen stopt de kosten: een uitgezette VM kost nog steeds geld.</p>
          <Field label={`Typ ${vm.name} om te bevestigen`}>
            <Input value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" spellCheck={false} />
          </Field>
        </div>
      </Modal>
    </div>
  );
}

/** Computers page: every VM that still exists (also of deleted bots), with the monthly total per currency. */
export function CloudVmList() {
  const list = useLive(() => cloud.list(), ['cloudvm.updated'], []);
  if (list.loading && !list.data) return <Spinner />;
  if (list.error) return <p className="text-sm text-danger">{list.error}</p>;
  const vms = list.data || [];
  if (!vms.length) return null;
  const totals = new Map<string, number>();
  for (const v of vms) totals.set(v.price.currency || 'EUR', (totals.get(v.price.currency || 'EUR') || 0) + (v.price.totalMonthlyGross || 0));
  return (
    <div className="space-y-3">
      <p className="text-sm">
        Samen ≈ <strong>{[...totals.entries()].map(([c, n]) => fmtMoney(n, c)).join(' + ')}</strong> per maand. <MoreInfo>Dit loopt door zolang ze bestaan, ook als ze uit staan. Je betaalt bij de provider.</MoreInfo>
      </p>
      <div className="grid gap-3 lg:grid-cols-2">
        {vms.map((vm) => (
          <VmCard key={vm.id} vm={vm} onChange={list.reload} />
        ))}
      </div>
    </div>
  );
}
