import { useEffect, useState } from 'react';
import { AlertTriangle, Box, FolderOpen, Globe, Monitor, MessageSquareOff, Server, ShieldCheck } from 'lucide-react';
import { api } from '../../lib/api';
import type { Agent } from '../../lib/types';
import { Badge, Button, cx, Field, Input, Modal, Spinner, Textarea, Toggle, toast, toastError, useAsync } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { cloud, computers, LEVELS, MODE_LABEL, screen, useLive, type ComputerConfig, type HostOptions, type ModeId } from './api';
import { RemoteSection, type RemoteCredentialDraft } from './RemoteSection';
import { CloudVmPanel } from './CloudVmSection';
import { stableJson, useEditorSection } from '../../lib/editorSave';
import { t } from '../../lib/i18n';

const ICON: Record<ModeId, React.ReactNode> = {
  none: <MessageSquareOff className="h-4 w-4" />,
  workspace: <FolderOpen className="h-4 w-4" />,
  browser: <Globe className="h-4 w-4" />,
  host: <Monitor className="h-4 w-4" />,
  container: <Box className="h-4 w-4" />,
  remote: <Server className="h-4 w-4" />,
};

const CLICK_TOOLS = ['browser_click', 'browser_type', 'browser_select', 'browser_press'];
/** Modes that need no further settings or confirmation: picking one saves it right away. */
const SIMPLE_MODES = new Set<string>(['none', 'workspace', 'browser']);
const lines = (s: string) => s.split(/[\n,]+/).map((x) => x.trim()).filter(Boolean);

interface Texts {
  allow: string;
  deny: string;
  apps: string;
  blockWords: string;
}
const textsOf = (c: ComputerConfig): Texts => ({ allow: c.allow_domains.join('\n'), deny: c.deny_domains.join('\n'), apps: c.host_apps.join(', '), blockWords: (c.host_options?.blockWords || []).join('\n') });

/** What "opslaan" sends for this section; also used to see whether the draft differs from what is stored. */
function payloadOf(c: ComputerConfig, t: Texts, hostSettings: boolean, storedAllApps: boolean) {
  return {
    mode: c.mode,
    allow_domains: lines(t.allow),
    deny_domains: lines(t.deny),
    allow_private: c.allow_private,
    host_control: c.host_control,
    host_apps: lines(t.apps),
    profile_id: c.profile_id,
    container: c.container,
    limits: c.limits,
    remote: { host: c.remote.host, port: c.remote.port, username: c.remote.username, dir: c.remote.dir, docker: c.remote.docker, limits: c.remote.limits },
    ...(hostSettings ? { host_level: c.host_level, host_options: { ...c.host_options, allApps: storedAllApps, blockWords: lines(t.blockWords) } } : {}),
  };
}

/** Bot editor section "Computer & bestanden": mode, domains, host opt-in (plain language). */
export function AgentComputerSection({ agent, onChange }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  if (!agent.id) return <p className="text-sm text-muted">Sla de bot eerst op; daarna kies je hier op welke computer hij mag werken.</p>;
  return <Inner agent={agent} onChange={onChange} />;
}

function Inner({ agent, onChange }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  const caps = useLive(() => computers.caps(), [], []);
  const cur = useLive(() => computers.get(agent.id), ['computer.config'], [agent.id]);
  const profiles = useLive(() => computers.profiles(), [], []);
  const { busy, run } = useAsync();
  const [d, setD] = useState<ComputerConfig | null>(null);
  const [allow, setAllow] = useState('');
  const [deny, setDeny] = useState('');
  const [apps, setApps] = useState('');
  const [optIn, setOptIn] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const [found, setFound] = useState<{ process: string; titles: string[] }[] | null>(null);
  const [blockWords, setBlockWords] = useState('');
  const [allAppsAsk, setAllAppsAsk] = useState(false);
  const [allAppsOk, setAllAppsOk] = useState(false);
  const scr = useLive(() => (cur.data?.config.host_control ? screen.info(agent.id).catch(() => null) : Promise.resolve(null)), ['computer.config'], [agent.id, cur.data?.config.host_control]);
  // write-only: a newly typed SSH key/password, sent once on save and then cleared
  const [cred, setCred] = useState<RemoteCredentialDraft>({ kind: 'key', value: '' });
  // a cloud VM made by TeamBot for this bot (shown whenever it exists: it costs money)
  const vmInfo = useLive(() => cloud.forAgent(agent.id).catch(() => ({ vm: null, allowed: false })), ['cloudvm.updated'], [agent.id]);
  const hasVm = !!vmInfo.data?.vm;
  const [where, setWhere] = useState<'own' | 'cloud'>('own');
  useEffect(() => {
    if (hasVm) setWhere('cloud');
  }, [hasVm]);

  const stored = cur.data?.config;
  const hostOn = !!caps.data?.isOwner && !!d && (d.host_control || d.mode === 'host');
  // Choosing "Cloud-VM laten maken" saves nothing: the VM wizard puts the bot on the VM when it is ready.
  const cloudPending = !!d && !!stored && d.mode === 'remote' && (where === 'cloud' || hasVm) && stored.mode !== 'remote';
  const texts: Texts = { allow, deny, apps, blockWords };
  const isDirty = () => {
    if (!d || !stored) return false;
    if (cred.value) return true;
    const draft = cloudPending ? { ...d, mode: stored.mode } : d;
    const allApps = !!stored.host_options?.allApps;
    return stableJson(payloadOf(draft, texts, hostOn, allApps)) !== stableJson(payloadOf(stored, textsOf(stored), hostOn, allApps));
  };
  // The editor's main "Opslaan" also saves this section; leaving with changes here warns first.
  const editor = useEditorSection('browser:computer', { label: 'Computer & bestanden', dirty: isDirty, save: () => persist() });

  useEffect(() => {
    if (!cur.data) return;
    const t = textsOf(cur.data.config);
    setD(cur.data.config);
    setAllow(t.allow);
    setDeny(t.deny);
    setApps(t.apps);
    setBlockWords(t.blockWords);
    setCred((c) => (c.value ? c : { kind: cur.data!.config.remote.auth, value: '' }));
  }, [cur.data]);

  if ((cur.loading && !cur.data) || (caps.loading && !caps.data)) return <Spinner />;
  if (cur.error || caps.error) return <p className="text-sm text-danger">{cur.error || caps.error}</p>;
  if (!d || !caps.data) return null;

  const modes = caps.data.modes;
  const set = (p: Partial<ComputerConfig>) => setD({ ...d, ...p });
  const opts: HostOptions = d.host_options;
  const setOpt = (p: Partial<HostOptions>) => set({ host_options: { ...opts, ...p } });
  const hostSettings = caps.data.isOwner && (d.host_control || d.mode === 'host');
  const askEveryClick = CLICK_TOOLS.every((t) => agent.tool_policy?.[t] === 'ask');
  const shared = (profiles.data || []).filter((p) => p.shared);

  async function persist(extra: any = {}) {
    if (!d || !cur.data) return;
    const r = await computers.save(agent.id, { ...payloadOf(cloudPending ? { ...d, mode: cur.data.config.mode } : d, texts, hostOn, !!cur.data.config.host_options.allApps), ...extra });
    // The server adjusts the bot's tool groups to the mode; that is stored already, so it is not an unsaved change.
    if (editor) editor.synced({ tool_groups: r.agent.tool_groups });
    else onChange({ tool_groups: r.agent.tool_groups });
    if (cred.value) {
      await computers.remoteCredential(agent.id, cred.kind, cred.value);
      setCred({ kind: cred.kind, value: '' });
    }
    cur.reload();
  }

  const save = (extra: any = {}) =>
    run(async () => {
      await persist(extra);
      toast('Computerinstellingen opgeslagen', 'ok');
    });

  const findApps = () =>
    run(async () => {
      const r = await api.get<{ apps: { process: string; titles: string[] }[] }>(`/computers/${agent.id}/desktop/windows`);
      setFound(r.apps);
    });

  const host = caps.data.caps.find((c) => c.id === 'host');

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">Kies het minste dat nodig is.</p>
      <div className="grid gap-2 sm:grid-cols-2" role="radiogroup" aria-label="Computermodus">
        {modes.map((m) => (
          <button
            key={m.id}
            type="button"
            role="radio"
            aria-checked={d.mode === m.id}
            disabled={!m.available && d.mode !== m.id}
            // The simple modes need nothing else, so they save at once (the editor's own "Opslaan" does not save this
            // section; before, a user who picked "Eigen browser" and clicked that button silently lost the choice).
            onClick={() => (set({ mode: m.id }), m.id !== d.mode && SIMPLE_MODES.has(m.id) && save({ mode: m.id }))}
            className={cx('rounded-xl border p-3 text-start transition disabled:cursor-not-allowed disabled:opacity-60', d.mode === m.id ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2')}
          >
            <div className="flex items-center gap-2 text-sm font-medium">
              {ICON[m.id]} {m.label}
              {!m.available && <Badge tone="warn">Niet beschikbaar</Badge>}
            </div>
            <div className="mt-1 text-xs text-muted">{m.description}</div>
            <div className="mt-1 text-xs">
              <span className="text-muted">Afscherming: </span>
              {m.isolation}
            </div>
            {!m.available && m.missing?.length ? <ul className="mt-1 list-disc ps-4 text-xs text-warn">{m.missing.map((x) => <li key={x}>{x}</li>)}</ul> : null}
          </button>
        ))}
      </div>

      {(d.mode === 'browser' || d.mode === 'host') && (
        <div className="space-y-3 rounded-xl border border-line p-3">
          <div className="text-sm font-medium">Browser</div>
          <Field label="Browserprofiel" hint="Een eigen profiel per bot is het veiligst. Een gedeeld profiel deelt cookies en logins met andere bots die je hetzelfde profiel geeft.">
            <Select value={d.profile_id || ''} onChange={(e) => set({ profile_id: e.target.value || null })}>
              <option value="">Eigen profiel van deze bot (aanbevolen)</option>
              {shared.map((p) => (
                <option key={p.id} value={p.id}>
                  Gedeeld: {p.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Alleen deze websites (optioneel)" hint="Eén domein per regel, bijv. wikipedia.org (subdomeinen tellen mee). Leeg = alle openbare websites.">
            <Textarea rows={3} value={allow} onChange={(e) => setAllow(e.target.value)} placeholder="wikipedia.org" />
          </Field>
          <Field label="Nooit deze websites" hint="Gaat altijd voor. Ook afbeeldingen en scripts van deze domeinen worden geblokkeerd.">
            <Textarea rows={2} value={deny} onChange={(e) => setDeny(e.target.value)} placeholder="facebook.com" />
          </Field>
          {caps.data.canAllowPrivate ? (
            <Toggle checked={d.allow_private} onChange={(v) => set({ allow_private: v })} label="Ook lokale adressen toestaan (je thuisnetwerk)." />
          ) : (
            <p className="text-xs text-muted">Lokale adressen zijn geblokkeerd. Alleen een beheerder kan dit toestaan.</p>
          )}
          <Toggle
            checked={askEveryClick}
            onChange={(v) => {
              const tp = { ...(agent.tool_policy || {}) };
              for (const t of CLICK_TOOLS) {
                if (v) tp[t] = 'ask';
                else if (tp[t] === 'ask') delete tp[t];
              }
              onChange({ tool_policy: tp });
            }}
            label="Elke klik en elk typwerk eerst aan mij vragen (wordt bewaard met de bot)"
          />
          <p className="text-xs text-muted">Versturen, kopen, publiceren en verwijderen vraagt altijd toestemming.</p>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Max. downloadgrootte (MB)">
              <Input type="number" min={1} max={500} value={d.limits.downloadMb} onChange={(e) => set({ limits: { ...d.limits, downloadMb: Number(e.target.value) } })} />
            </Field>
            <Field label="Browser sluiten na (minuten stilte)">
              <Input type="number" min={1} max={120} value={d.limits.idleMin} onChange={(e) => set({ limits: { ...d.limits, idleMin: Number(e.target.value) } })} />
            </Field>
          </div>
        </div>
      )}

      {(d.mode === 'host' || d.host_control) && (
        <div className="space-y-3 rounded-xl border border-warn bg-warn-soft p-3">
          <div className="flex items-center gap-2 text-sm font-medium">
            <AlertTriangle className="h-4 w-4 text-warn" /> Mijn bureaublad
          </div>
          <p className="text-sm">
            Hiermee kan deze bot je échte bureaublad zien (schermafbeeldingen) en bedienen: klikken, slepen en typen alsof jij het doet. Dat is niet afgeschermd. Daarom: alleen de apps die jij kiest, een toegangsniveau dat jij bepaalt, een
            rand op je scherm zolang een bot bezig is, muis bewegen pauzeert de bot, en een noodstop{scr.data?.hotkey ? ` (${scr.data.hotkey})` : ''}.
          </p>
          <p className="text-xs text-muted">Altijd geblokkeerd: wachtwoordvelden, wachtwoordmanagers, bank- en betaalpagina’s en TeamBot zelf.</p>
          {host?.status !== 'available' && <p className="text-sm text-danger">{host?.detail}</p>}
          {!caps.data.isOwner ? (
            <p className="text-sm text-muted">Alleen de eigenaar van deze computer kan dit aanzetten.</p>
          ) : d.host_control ? (
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone="warn">
                <ShieldCheck className="h-3 w-3" /> Aan
              </Badge>
              <Button size="sm" onClick={() => save({ host_control: false, mode: d.mode === 'host' ? 'browser' : d.mode })} loading={busy}>
                Zet uit
              </Button>
            </div>
          ) : (
            <Button size="sm" variant="secondary" disabled={host?.status !== 'available'} onClick={() => setOptIn(true)}>
              Bureaubladbediening aanzetten…
            </Button>
          )}
          {hostSettings && (
            <div className="space-y-2">
              <div className="text-sm font-medium">Toegangsniveau</div>
              <div className="grid gap-2 sm:grid-cols-3" role="radiogroup" aria-label="Toegangsniveau bureaublad">
                {LEVELS.map((l) => (
                  <button
                    key={l.id}
                    type="button"
                    role="radio"
                    aria-checked={d.host_level === l.id}
                    onClick={() => set({ host_level: l.id })}
                    className={cx('rounded-xl border p-2.5 text-start transition', d.host_level === l.id ? 'border-accent bg-accent-soft' : 'border-line bg-surface hover:bg-surface-2')}
                  >
                    <div className="text-sm font-medium">{l.label}</div>
                    <div className="mt-0.5 text-xs text-muted">{l.text}</div>
                  </button>
                ))}
              </div>
              {d.host_level !== 'every' && (
                <Field label="Taaktoestemming maximaal (minuten)" hint="Na deze tijd vraagt de bot opnieuw. Geldt ook voor “Altijd toestaan” bij één actie.">
                  <Input type="number" min={5} max={240} value={opts.taskMinutes} onChange={(e) => setOpt({ taskMinutes: Number(e.target.value) })} />
                </Field>
              )}
            </div>
          )}
          <Field label="Toegestane apps" hint="Programmanamen, met komma’s ertussen (bijv. notepad, excel).">
            <Input value={apps} onChange={(e) => setApps(e.target.value)} placeholder="notepad, excel" disabled={!!cur.data?.config.host_options.allApps} />
          </Field>
          {hostSettings && cur.data?.config.host_control && (
            <div className="flex flex-wrap items-center gap-2">
              {cur.data.config.host_options.allApps ? (
                <>
                  <Badge tone="warn">Alle apps (behalve geblokkeerde)</Badge>
                  <Button size="sm" variant="ghost" loading={busy} onClick={() => save({ host_options: { ...opts, allApps: false } })}>
                    Terug naar alleen de lijst
                  </Button>
                </>
              ) : (
                <Button size="sm" variant="ghost" onClick={() => setAllAppsAsk(true)}>
                  Alle apps toestaan…
                </Button>
              )}
            </div>
          )}
          {hostSettings && (
            <div className="space-y-2">
              <Toggle checked={opts.screen === 'full'} onChange={(v) => setOpt({ screen: v ? 'full' : 'apps' })} label="De bot mag het hele scherm zien (anders alleen toegestane apps)" />
              <Toggle checked={opts.pauseOnInput} onChange={(v) => setOpt({ pauseOnInput: v })} label="Pauzeer de bot zodra ik zelf de muis beweeg" />
              {(scr.data?.monitors?.length || 0) > 1 && (
                <Field label="Beeldscherm voor de bot">
                  <Select value={String(opts.monitor)} onChange={(e) => setOpt({ monitor: Number(e.target.value) })}>
                    {scr.data!.monitors.map((m) => (
                      <option key={m.index} value={m.index}>
                        {m.primary ? t('Scherm {0} (hoofdscherm) — {1}×{2}', m.index + 1, m.w, m.h) : t('Scherm {0} — {1}×{2}', m.index + 1, m.w, m.h)}
                      </option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Extra geblokkeerde woorden in venstertitels" hint="Eén per regel, bijv. de naam van een geheim project.">
                <Textarea rows={2} value={blockWords} onChange={(e) => setBlockWords(e.target.value)} placeholder="mijn zorgverzekeraar" />
              </Field>
            </div>
          )}
          {caps.data.isOwner && host?.status === 'available' && (
            <div className="space-y-2">
              <Button size="sm" variant="ghost" onClick={findApps} loading={busy}>
                Toon open programma’s
              </Button>
              {found && (
                <div className="flex flex-wrap gap-1.5">
                  {found.map((f) => {
                    const on = lines(apps).map((x) => x.toLowerCase()).includes(f.process);
                    return (
                      <button
                        key={f.process}
                        type="button"
                        title={f.titles.join(' · ')}
                        onClick={() => setApps((on ? lines(apps).filter((x) => x.toLowerCase() !== f.process) : [...lines(apps), f.process]).join(', '))}
                        className={cx('rounded-md border px-2 py-1 text-xs', on ? 'border-accent bg-accent-soft text-accent' : 'border-line bg-surface')}
                        aria-pressed={on}
                      >
                        {f.process}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {d.mode === 'container' && (
        <div className="space-y-3 rounded-xl border border-line p-3">
          <div className="text-sm font-medium">Container</div>
          <Field label="Image" hint="Docker-image waarin de bot werkt. De werkmap is de enige gedeelde map (/workspace).">
            <Input value={d.container.image} onChange={(e) => set({ container: { ...d.container, image: e.target.value } })} />
          </Field>
          <Toggle checked={d.container.network === 'bridge'} onChange={(v) => set({ container: { ...d.container, network: v ? 'bridge' : 'none' } })} label="Internettoegang in de container (standaard uit)" />
        </div>
      )}

      {(d.mode === 'remote' || hasVm) && cur.data && (
        <div className="space-y-3">
          {!hasVm && (
            <div className="inline-flex flex-wrap rounded-lg border border-line p-0.5" role="group" aria-label="Soort server">
              {(
                [
                  ['own', 'Mijn eigen server'],
                  ['cloud', 'Cloud-VM laten maken (Hetzner, DigitalOcean)'],
                ] as const
              ).map(([id, label]) => (
                <button key={id} type="button" aria-pressed={where === id} onClick={() => setWhere(id)} className={cx('rounded-md px-3 py-1 text-sm', where === id ? 'bg-accent-soft font-medium text-accent' : 'text-muted hover:text-fg')}>
                  {label}
                </button>
              ))}
            </div>
          )}
          {hasVm && cur.data.config.mode !== 'remote' && <p className="text-xs text-muted">Deze bot heeft een cloud-VM; zodra die klaar is, werkt de bot erop.</p>}
          {where === 'cloud' || hasVm ? (
            <CloudVmPanel agentId={agent.id} />
          ) : (
            <RemoteSection
              agentId={agent.id}
              draft={d.remote}
              stored={cur.data.config.remote}
              onChange={(remote) => set({ remote })}
              cred={cred}
              onCred={setCred}
              persist={async () => {
                try {
                  await persist();
                  return true;
                } catch (e) {
                  toastError(e);
                  return false;
                }
              }}
              reload={cur.reload}
            />
          )}
        </div>
      )}

      {cloudPending ? (
        <p className="text-xs text-muted">Opslaan is hier niet nodig: na het aanmaken van de VM zet TeamBot de bot er zelf op.</p>
      ) : (
        isDirty() && (
          <p className="rounded-lg bg-warn-soft px-3 py-2 text-xs font-medium text-warn" role="status">
            Nog niet opgeslagen. Klik op Opslaan om deze computerinstellingen te bewaren.
          </p>
        )
      )}

      <Modal
        open={optIn}
        onClose={() => setOptIn(false)}
        title="Bureaubladbediening aanzetten"
        footer={
          <>
            <Button onClick={() => setOptIn(false)}>Annuleren</Button>
            <Button
              variant="danger"
              disabled={!understood || !lines(apps).length}
              loading={busy}
              onClick={async () => {
                await save({ host_control: true, confirmHost: true, mode: 'host' });
                setOptIn(false);
              }}
            >
              {t('{0, plural, =0 {Kies eerst een app} one {Aanzetten voor # app} other {Aanzetten voor # apps}}', lines(apps).length)}
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>
            <strong>{agent.name}</strong> mag dan vensters van deze apps lezen en er na jouw goedkeuring in klikken en typen: <strong>{lines(apps).join(', ') || '(kies eerst apps)'}</strong>.
          </p>
          <ul className="list-disc space-y-1 ps-5">
            <li>Dit is je echte computer, geen afgeschermde omgeving.</li>
            <li>Standaard keur je elke klik of toetsaanslag eerst goed.</li>
            <li>Zolang een bot bezig is staat er een rand om je scherm. Beweeg je de muis, dan pauzeert hij.</li>
            <li>De noodstop (sneltoets, systeemvak, Computers, zijpaneel of telefoon) stopt alles direct.</li>
            <li>Je kunt dit altijd weer uitzetten.</li>
          </ul>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={understood} onChange={(e) => setUnderstood(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
            Ik begrijp wat dit betekent
          </label>
        </div>
      </Modal>
      <Modal
        open={allAppsAsk}
        onClose={() => setAllAppsAsk(false)}
        title="Alle apps toestaan"
        footer={
          <>
            <Button onClick={() => setAllAppsAsk(false)}>Annuleren</Button>
            <Button
              variant="danger"
              disabled={!allAppsOk}
              loading={busy}
              onClick={async () => {
                await save({ host_options: { ...opts, allApps: true, blockWords: lines(blockWords) }, confirmAllApps: true });
                setAllAppsAsk(false);
                setAllAppsOk(false);
              }}
            >
              Alle apps toestaan
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>
            <strong>{agent.name}</strong> mag dan elk programma op je bureaublad zien en bedienen, ook een terminal of Verkenner. Alleen de altijd geblokkeerde vensters blijven taboe (wachtwoordmanagers, bank- en betaalpagina’s, Windows-beveiliging, TeamBot
            zelf).
          </p>
          <p>Combineer dit met “Vraag één keer per taak”.</p>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={allAppsOk} onChange={(e) => setAllAppsOk(e.target.checked)} className="h-4 w-4 accent-[var(--color-accent)]" />
            Ik begrijp wat dit betekent
          </label>
        </div>
      </Modal>
      <p className="text-xs text-muted">Huidige modus: {MODE_LABEL[cur.data?.config.mode || 'workspace']}{cur.data?.config.derived ? ' (afgeleid van de toolgroepen; nog niet opgeslagen)' : ''}.</p>
    </div>
  );
}
