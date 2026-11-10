import { useEffect, useState } from 'react';
import { ArrowLeft, Bot, ChevronRight, Copy, Download, Gauge, Lock, MonitorSmartphone, Search, Settings2, Sparkles, Trash2 } from 'lucide-react';
import { Activity as IcActivity, AlarmClock as IcAlarm, ArrowRightLeft as IcSwitch, Bell as IcBell, BellRing as IcBellRing, Blocks as IcBlocks, Brain as IcBrain, DatabaseBackup as IcBackup, FolderOpen as IcFolder, Gift as IcGift, Globe as IcGlobe, GraduationCap as IcGrad, HardDrive as IcDrive, Image as IcImage, KeyRound as IcKey, LayoutGrid as IcGrid, Mic as IcMic, Monitor as IcMonitor, Network as IcNetwork, NotebookPen as IcNotes, RadioTower as IcRadio, Shuffle as IcShuffle, Smartphone as IcPhone, Terminal as IcTerminal, Trash as IcTrash, UserRound as IcUser, Users as IcUsers } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { api, authUrl } from '../lib/api';
import { useApp } from '../lib/store';
import { useMedia } from '../lib/media';
import { isSubEntry, settingsNav, settingsParentOf, settingsRowOf, settingsSearch, type SettingsNavRow, type SettingsRow } from '../lib/palette';
import { MoreOptions } from '../components/MoreOptions';
import { MoreInfo } from '../components/MoreInfo';
import { uiModules } from '../modules';
import { askConfirm, Badge, Button, Card, Field, Input, Page, Spinner, cx, timeAgo, toast, toastError } from '../components/ui';
import { setAdvanced, useAdvanced } from '../shell/advanced';
import { ProvidersSettings } from './Providers';
import { TeamUsageCard } from './TeamUsage';
import { ScimCard, ScimGroupsCard, SsoCard, useScimGroupHints } from './Sso';
import { AppearanceSettings } from './Appearance';
import { ComputerOnly, useIsPhoneSession } from '../shell/computerOnly';
import { t, translate, uiLocale } from '../lib/i18n';
import { formatMoney, formatTime } from '../lib/format';
import { prettyModel } from '../lib/modelLabel';
import { Dropdown, Segmented, SettingRow, SettingsSection, SwitchRow, useSave } from '../components/SettingControls';
import { ModelChoice } from '../components/ModelPicker';
import { Listbox } from '../components/Listbox';
import type { ModelInfo } from '../lib/types';
import { BotLanguageSelect, LanguageSelect } from '../components/LanguagePicker';
import { AuditLog } from '../shell/AuditLog';
import { AppLockCard } from '../shell/AppLock';
import { KeepAwakeSetting } from '../shell/power';
import { WhatLeavesYourPc } from '../modules/network/DataPrivacy';
import { shownLanUrls } from './lanUrls';

/** Dollars with a fixed number of decimals in the reader's notation (C-17: "US$ 0,15", not "$0.15" in Dutch). */
const usdN = (n: number, d: number) => formatMoney(n || 0, 'USD', { minimumFractionDigits: d, maximumFractionDigits: d });

/** Save one or more user settings and keep the store in step. */
const putSettings = (p: Record<string, unknown>) => api.put('/settings', p).then((s) => useApp.setState({ settings: s }));

/** Daily budgets to pick from (USD); "Ander bedrag" opens a field. 0 = no limit. */
const BUDGETS = [0, 1, 2, 5, 10, 20, 50, 100];

/** The time zones this browser knows (one dropdown), with the stored one kept when it is not among them. */
function timeZones(current: string): string[] {
  let list: string[] = [];
  try {
    list = (Intl as any).supportedValuesOf?.('timeZone') || [];
  } catch {
    /* old browser: only the current one */
  }
  return [...new Set([current, ...list].filter(Boolean))].sort();
}

function General({ openMore }: { openMore?: boolean }) {
  const settings = useApp((s) => s.settings);
  const save = useSave();
  return (
    <>
      <SettingsSection title="Jij en je taal">
        <NameRow />
        <SettingRow label="Taal van de app">
          <LanguageSelect className="min-w-[12rem] sm:w-auto" aria-label="Taal van de app" />
        </SettingRow>
        <SettingRow label="Bots antwoorden in" hint="Per bot kun je dit apart instellen.">
          <BotLanguageSelect value={settings.botLanguage} onChange={(v) => void save(putSettings({ botLanguage: v }))} className="min-w-[12rem] sm:w-auto" aria-label="Bots antwoorden in" />
        </SettingRow>
      </SettingsSection>
      {/* Uiterlijk (theme, colour, figures) lives on this page; #/settings/appearance still leads here. */}
      <AppearanceSettings />
      {/* What people rarely change in one fold; the old Geavanceerd page (#/settings/advanced) opens it. */}
      <MoreOptions defaultOpen={openMore}>
        <BotDefaults />
        <KeepAwakeSetting />
        <AdvancedSection />
      </MoreOptions>
    </>
  );
}

/** "Je naam": saved when you leave the field or press Enter. */
function NameRow() {
  const me = useApp((s) => s.me);
  const [name, setName] = useState(me?.name || '');
  const save = useSave();
  const store = () => {
    const v = name.trim();
    if (!v || v === me?.name) return;
    void save(api.patch('/me', { name: v }).then((r) => useApp.setState({ me: r.user })));
  };
  return (
    <SettingRow label="Je naam">
      <Input value={name} onChange={(e) => setName(e.target.value)} onBlur={store} onKeyDown={(e) => e.key === 'Enter' && store()} aria-label="Je naam" className="w-full sm:w-64" maxLength={80} />
    </SettingRow>
  );
}

/** Standaarden voor nieuwe bots: AI, model (Automatisch or a choice), time zone and daily budget. */
function BotDefaults() {
  const settings = useApp((s) => s.settings);
  const providers = useApp((s) => s.providers);
  const save = useSave();
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [limits, setLimits] = useState<{ restricted: boolean; dailyBudgetUsd: number; policy: { dailyBudgetUsd: number } | null } | null>(null);
  const [ownBudget, setOwnBudget] = useState(false);
  const budget = Number(settings.dailyBudgetUsd ?? 0) || 0;
  const [budgetText, setBudgetText] = useState(String(budget || ''));
  useEffect(() => {
    api.get('/my-limits').then(setLimits).catch(() => {});
  }, [settings.dailyBudgetUsd]);
  const provider = settings.defaultProvider || '';
  useEffect(() => {
    setModels([]);
    if (!provider) return;
    setLoading(true);
    api
      .get<ModelInfo[]>(`/providers/${provider}/models`)
      .then(setModels, () => setModels([]))
      .finally(() => setLoading(false));
  }, [provider]);
  const tz = settings.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone;
  const custom = ownBudget || !BUDGETS.includes(budget);
  const storeBudget = () => {
    const n = Math.max(0, Number(budgetText.replace(',', '.')) || 0);
    if (n !== budget) void save(putSettings({ dailyBudgetUsd: n }));
  };
  const isDefault = !settings.defaultModel && !settings.timezone && !budget;
  return (
    <SettingsSection
      title="Standaarden voor nieuwe bots"
      isDefault={isDefault}
      onReset={() => (setOwnBudget(false), setBudgetText(''), putSettings({ defaultModel: '', timezone: '', dailyBudgetUsd: 0 }))}
    >
      <SettingRow label="Standaard-AI">
        <Dropdown
          value={provider}
          onChange={(v) => void save(putSettings({ defaultProvider: v || null, defaultModel: '' }))}
          options={[{ value: '', label: 'Geen' }, ...providers.map((p) => ({ value: p.id, label: p.name, text: p.name }))]}
        />
      </SettingRow>
      {provider && (
        <SettingRow label="Standaardmodel">
          <ModelChoice models={models} loading={loading} value={settings.defaultModel || ''} onChange={(m) => void save(putSettings({ defaultModel: m }))} label="Standaardmodel" />
        </SettingRow>
      )}
      <SettingRow label="Tijdzone" hint="Voor routines en tijden in de chat.">
        <Dropdown value={tz} onChange={(v) => void save(putSettings({ timezone: v }))} options={timeZones(tz).map((z) => ({ value: z, label: z.replace(/_/g, ' '), text: z.replace(/_/g, ' ') }))} />
      </SettingRow>
      <SettingRow
        label="Dagbudget"
        hint={limits?.restricted ? t('Op deze server is je maximum {0} per dag (nu actief: {1}).', usdN(limits.policy?.dailyBudgetUsd ?? 0, 2), usdN(limits.dailyBudgetUsd ?? 0, 2)) : 'Betaalde bots stoppen bij dit bedrag per dag.'}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Dropdown
            label="Dagbudget in USD"
            value={custom ? 'eigen' : String(budget)}
            onChange={(v) => {
              if (v === 'eigen') return setOwnBudget(true);
              setOwnBudget(false);
              setBudgetText(v === '0' ? '' : v);
              void save(putSettings({ dailyBudgetUsd: Number(v) }));
            }}
            options={[...BUDGETS.map((n) => ({ value: String(n), label: n ? usdN(n, 0) : 'Geen limiet' })), { value: 'eigen', label: 'Ander bedrag…' }]}
          />
          {custom && (
            <Input inputMode="decimal" value={budgetText} onChange={(e) => setBudgetText(e.target.value)} onBlur={storeBudget} onKeyDown={(e) => e.key === 'Enter' && storeBudget()} aria-label="Eigen bedrag per dag (USD)" placeholder="0,00" className="w-28" />
          )}
        </div>
      </SettingRow>
    </SettingsSection>
  );
}

/** Zoeken op internet: the service (saved at once), its key or address (saved when you leave the field). */
function Usage() {
  const [d, setD] = useState<any>(null);
  const [days, setDays] = useState(30);
  useEffect(() => {
    api.get(`/usage?days=${days}`).then(setD).catch(toastError);
  }, [days]);
  if (!d) return <Spinner />;
  const total = d.byDay.reduce((s: number, x: any) => s + (x.cost || 0), 0);
  const tokens = d.byDay.reduce((s: number, x: any) => s + (x.input || 0) + (x.output || 0), 0);
  const max = Math.max(0.000001, ...d.byDay.map((x: any) => x.cost || 0));
  return (
    <div className="space-y-4">
      <Segmented
        label="Periode"
        value={String(days)}
        onChange={(v) => setDays(Number(v))}
        options={[
          { value: '7', label: '7 dagen' },
          { value: '30', label: '30 dagen' },
          { value: '90', label: '90 dagen' },
        ]}
      />
      <div className="grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <div className="text-xs text-muted">Geschatte kosten</div>
          <div className="mt-1 text-2xl font-semibold">{usdN(total, 2)}</div>
        </Card>
        <Card className="p-4">
          <div className="text-xs text-muted">Verwerkte tekst (tokens)</div>
          <div className="mt-1 text-2xl font-semibold">{tokens.toLocaleString(uiLocale())}</div>
        </Card>
        <BudgetCard d={d} />
      </div>
      <Card className="p-4">
        <h2 className="mb-3 text-[15px] font-bold tracking-tight">Per dag</h2>
        {d.byDay.length === 0 ? (
          <p className="text-sm text-muted">Nog geen gebruik in deze periode.</p>
        ) : (
          <div className="flex h-32 items-end gap-1" role="img" aria-label="Kosten per dag">
            {d.byDay.map((x: any) => (
              <div key={x.day} className="flex flex-1 flex-col items-center gap-1" title={`${x.day}: ${usdN(x.cost, 4)} ·${(x.input + x.output).toLocaleString(uiLocale())} tokens`}>
                <div className="w-full rounded-t bg-accent" style={{ height: `${Math.max(2, ((x.cost || 0) / max) * 100)}%` }} />
              </div>
            ))}
          </div>
        )}
      </Card>
      <div className="grid gap-4 sm:grid-cols-2">
        <Card className="p-4">
          <h2 className="mb-2 text-[15px] font-bold tracking-tight">Per bot</h2>
          {d.byAgent.length === 0 && <p className="text-sm text-muted">Nog niets.</p>}
          {d.byAgent.map((x: any) => (
            <div key={x.agent_id || 'x'} className="flex justify-between py-1 text-sm">
              <span className="truncate">{x.name || 'Verwijderde bot'}</span>
              <span className="text-muted">{usdN(x.cost, 3)}</span>
            </div>
          ))}
        </Card>
        <Card className="p-4">
          <h2 className="mb-2 text-[15px] font-bold tracking-tight">Per model</h2>
          {d.byModel.length === 0 && <p className="text-sm text-muted">Nog niets.</p>}
          {d.byModel.map((x: any) => (
            <div key={x.model + x.provider_id} className="flex justify-between py-1 text-sm">
              <span className="truncate">{x.model ? prettyModel(x.model) : x.model}</span>
              <span className="text-muted">
                {x.calls}× · {usdN(x.cost, 3)}
              </span>
            </div>
          ))}
        </Card>
      </div>
      <p className="text-xs text-muted">Je AI-dienst stuurt zelf de rekening; TeamBot rekent niets.</p>
    </div>
  );
}

/**
 * Today against the daily budget that applies (also the admin's cap for a member). Honest when today went past it: the
 * cost of a step is only known afterwards, so the last step can cost more than what was left (B-70).
 */
function BudgetCard({ d }: { d: any }) {
  const limit: number = d.today?.limit ?? d.dailyBudgetUsd ?? 0;
  const spent: number = d.today?.spent ?? 0;
  const over = limit > 0 && spent > limit + 0.005;
  const reached = limit > 0 && spent >= limit;
  return (
    <Card className="p-4" data-testid="budget-card">
      <div className="text-xs text-muted">Dagbudget</div>
      <div className="mt-1 text-2xl font-semibold">{limit ? formatMoney(limit) : 'geen'}</div>
      {limit > 0 && <div className={cx('mt-1 text-xs', reached ? 'text-warn' : 'text-muted')}>{t('Vandaag {0} gebruikt.', usdN(spent, 2))}</div>}
      {over && (
        <p className="mt-1 text-xs text-warn">
          {t('{0} meer dan het dagbudget.', usdN(spent - limit, 2))} <MoreInfo>De laatste stap kostte meer dan er nog over was. De kosten van een stap zijn pas achteraf precies bekend.</MoreInfo>
        </p>
      )}
      {reached && d.today?.resetAt && <p className="mt-1 text-xs text-muted">{t('Om {0} begint een nieuwe dag en werken je betaalde bots weer.', formatTime(d.today.resetAt))}</p>}
      {/* The "Daglimiet bereikt" message sends people here; the field itself lives under Algemeen. */}
      {d.today?.byAdmin ? (
        <p className="mt-1 text-xs text-muted">Dit maximum stelt de beheerder in.</p>
      ) : (
        <a href="#/settings/general?meer=1" className="mt-1 inline-block text-xs text-accent underline">
          Aanpassen
        </a>
      )}
    </Card>
  );
}

const H2 = 'text-[15px] font-bold tracking-tight';

function Security() {
  const [sessions, setSessions] = useState<any[] | null>(null);
  const [secrets, setSecrets] = useState<any[] | null>(null);
  // What a stored key is for: the app it belongs to, or the name the owner gave a script key (the raw id says nothing).
  const [keyInfo, setKeyInfo] = useState<{ apps: Record<string, string>; scripts: Record<string, { name: string; label: string }> }>({ apps: {}, scripts: {} });
  // A paired phone does not manage sessions or see stored secrets (server/modules/mobile/policy.ts): say so calmly.
  const phone = useIsPhoneSession();
  const load = () => {
    if (phone) return;
    api.get('/sessions').then(setSessions).catch(toastError);
    api.get('/secrets').then(setSecrets).catch(toastError);
    Promise.all([api.get<any[]>('/mcp/connections').catch(() => []), api.get<any[]>('/script-keys').catch(() => [])]).then(([apps, keys]) =>
      setKeyInfo({
        apps: Object.fromEntries((apps || []).map((c: any) => [c.id, c.display || c.label || c.name])),
        scripts: Object.fromEntries((keys || []).map((k: any) => [k.id, { name: k.name, label: k.label || '' }])),
      }),
    );
  };
  useEffect(load, [phone]);
  return (
    <>
      <AppLockCard />
      <Card className="px-5 pb-2 pt-4">
        <h2 className={H2}>Ingelogde apparaten</h2>
        {phone ? (
          <ComputerOnly>Inlogsessies beheer je op je computer.</ComputerOnly>
        ) : !sessions ? (
          <Spinner className="my-3" />
        ) : (
          <div className="mt-1 divide-y divide-line">
            {sessions.map((s) => (
              <div key={s.id} className="flex items-center gap-3 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">{s.name || sessionKind(s.kind)}</div>
                  <div className="text-xs text-muted">
                    {s.name && s.name !== sessionKind(s.kind) ? `${sessionKind(s.kind)} · ` : ''}
                    {t('laatst gezien {0}', s.last_seen ? timeAgo(s.last_seen) : '—')}
                  </div>
                </div>
                <Button size="sm" variant="ghost" onClick={() => api.del(`/sessions/${s.id}`).then(load).catch(toastError)}>
                  Intrekken
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card className="px-5 pb-2 pt-4">
        <h2 className={H2}>Opgeslagen sleutels</h2>
        <p className="mt-0.5 text-xs text-muted">
          Welke sleutels TeamBot bewaart en waarvoor. <MoreInfo>Waarden verlaten de server nooit en komen niet in logs of chats.</MoreInfo>
        </p>
        {phone ? (
          <ComputerOnly>Opgeslagen sleutels bekijken kan alleen op je computer.</ComputerOnly>
        ) : !secrets ? (
          <Spinner className="my-3" />
        ) : secrets.length === 0 ? (
          <p className="py-3 text-sm text-muted">Nog geen sleutels opgeslagen.</p>
        ) : (
          <div className="mt-1 divide-y divide-line">
            {secrets.map((s) => (
              <div key={s.id} className="flex items-center justify-between gap-3 py-2 text-sm">
                {(() => {
                  const d = describeSecret(s.name, keyInfo);
                  return (
                    <span className="min-w-0">
                      <span className="block truncate font-medium">{d.title}</span>
                      <span className="block truncate text-xs text-muted">{d.purpose}</span>
                    </span>
                  );
                })()}
                <Button size="sm" variant="ghost" aria-label={`${s.name} wissen`} onClick={async () => (await askConfirm(`Geheim "${s.name}" wissen?`, { danger: true })) && api.del(`/secrets/${encodeURIComponent(s.name)}`).then(load).catch(toastError)}>
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
      {/* Long by nature (every action, with filters): one fold, so the page stays short. */}
      <MoreOptions label="Logboek">
        <AuditLog />
      </MoreOptions>
    </>
  );
}

/** Sessions in words: "Deze computer", "Telefoon of tablet", "Browser" (never the raw kind). */
function sessionKind(kind: string): string {
  return ({ desktop: 'Deze computer', device: 'Telefoon of tablet', web: 'Browser' } as Record<string, string>)[kind] || 'Sessie';
}

function Data() {
  return (
    <>
      <Card className="space-y-3 p-5" id="waar-staat-mijn-data">
        <h2 className={H2}>Wat staat waar</h2>
        <ul className="list-disc space-y-1 ps-5 text-sm">
          <li>Je bots, gesprekken en bestanden staan op deze computer.</li>
          <li>Een AI-dienst krijgt alleen wat een bot nodig heeft voor zijn antwoord.</li>
          <li>TeamBot stuurt zelf niets naar de makers: geen statistieken en geen foutrapporten.</li>
        </ul>
        {/* Three short lines; the details (not the same lines again) behind "Meer informatie". */}
        <MoreInfo block>
          <ul className="list-disc space-y-1.5 ps-5 text-sm">
            <li>Er is geen account bij de makers van TeamBot nodig. Je data staat in de datamap hieronder.</li>
            <li>Alleen de AI-dienst die je bij een bot kiest krijgt iets (bijvoorbeeld Claude of OpenAI). Met een lokaal model (Ollama) blijft alles op deze computer.</li>
            <li>Sleutels en geheimen staan versleuteld en komen nooit in gesprekken, logboeken of exports.</li>
            <li>Iets van internet ophalen gebeurt alleen als jij of een bot erom vraagt (een webpagina, een app uit de marktplaats, zoeken naar updates als je dat aanzet).</li>
            <li>
              Bots vragen toestemming voordat ze iets wijzigen; versturen, betalen en verwijderen wat niet terug kan, vragen altijd. Alles met gevolgen staat in het logboek onder <a className="underline hover:text-fg" href="#/settings/security">Beveiliging</a>.
            </li>
          </ul>
        </MoreInfo>
        <SystemInfo />
      </Card>
      <WhatLeavesYourPc />
      {useApp.getState().me?.role !== 'member' && !useApp.getState().device && (
        <MoreOptions>
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="min-w-0 flex-1 basis-56">
              <h2 className="text-sm font-medium">Diagnosebestand</h2>
              <p className="text-xs text-muted">Om te delen als je hulp wilt. Zonder berichten, bestanden of sleutels.</p>
            </div>
            <a href={authUrl('/admin/diagnostics')}>
              <Button icon={<Download className="h-4 w-4" />}>Downloaden</Button>
            </a>
          </div>
        </MoreOptions>
      )}
    </>
  );
}

function InfoLine({ label, children, mono }: { label: string; children: React.ReactNode; mono?: boolean }) {
  return (
    <div className="flex justify-between gap-4">
      <dt className="shrink-0 text-muted">{label}</dt>
      <dd className={cx('min-w-0 text-end', mono && 'break-all font-mono text-xs')}>{children}</dd>
    </div>
  );
}

/** Version and data folder in view; platform, modules and addresses (for support) behind "Technische gegevens". */
function SystemInfo() {
  const [s, setS] = useState<any>(null);
  useEffect(() => {
    api.get('/system').then(setS).catch(toastError);
  }, []);
  if (!s) return <Spinner />;
  return (
    <div className="space-y-1 border-t border-line pt-3">
      <dl className="space-y-1 text-sm">
        <InfoLine label="Versie">
          {s.app} {s.version}
        </InfoLine>
        {s.dataDir && (
          <InfoLine label="Datamap" mono>
            {s.dataDir}
          </InfoLine>
        )}
      </dl>
      <MoreInfo block label="Technische gegevens">
        <dl className="space-y-1 text-xs">
          <InfoLine label="Soort">{s.mode === 'desktop' ? 'desktop' : 'server'}</InfoLine>
          {/* A paired phone gets the short system info (no platform, data folder or addresses). */}
          {s.platform && (
            <InfoLine label="Platform">
              {s.platform} · Node {s.node}
            </InfoLine>
          )}
          <InfoLine label="Modules">{s.modules.map((m: any) => translate(m.label)).join(', ')}</InfoLine>
          {shownLanUrls(s).length > 0 && (
            <InfoLine label="Netwerkadressen" mono>
              {shownLanUrls(s).join(' ')}
            </InfoLine>
          )}
        </dl>
      </MoreInfo>
    </div>
  );
}

type MemberPolicy = { dailyBudgetUsd: number; maxAgents: number; allowShell: boolean; allowCloudVm: boolean };

function MemberPolicyCard() {
  const [p, setP] = useState<MemberPolicy | null>(null);
  useEffect(() => {
    api.get('/admin/member-policy').then(setP).catch(toastError);
  }, []);
  if (!p) return <Spinner />;
  return (
    <SettingsSection title="Regels voor leden" info="Bots van leden werken in hun eigen map, zonder toegang tot het interne netwerk.">
      <MemberPolicyRows p={p} setP={setP} />
    </SettingsSection>
  );
}

/** The rows (inside the section, so a change shows "Opgeslagen" there). */
function MemberPolicyRows({ p, setP }: { p: MemberPolicy; setP(p: MemberPolicy): void }) {
  const me = useApp((s) => s.me);
  const track = useSave();
  const save = (patch: Partial<MemberPolicy>) => void track(api.put('/admin/member-policy', { ...p, ...patch }).then(setP));
  return (
    <>
      <SettingRow label="Dagbudget per lid (USD)" hint="0 = geen limiet.">
        <Input className="w-28" inputMode="decimal" aria-label="Maximaal dagbudget per lid (USD)" defaultValue={String(p.dailyBudgetUsd)} onBlur={(e) => save({ dailyBudgetUsd: Number(e.target.value.replace(',', '.')) || 0 })} />
      </SettingRow>
      <SettingRow label="Aantal bots per lid" hint="0 = geen limiet.">
        <Input className="w-28" inputMode="numeric" aria-label="Maximaal aantal bots per lid" defaultValue={String(p.maxAgents)} onBlur={(e) => save({ maxAgents: Number(e.target.value) || 0 })} />
      </SettingRow>
      <SwitchRow
        label="Terminal toestaan voor leden"
        hint="Alleen voor mensen die je volledig vertrouwt."
        info="Opdrachten draaien dan met de rechten van deze server. Alleen de eigenaar kan dit aanzetten."
        checked={p.allowShell}
        disabled={me?.role !== 'owner'}
        onChange={async (on) => {
          if (!on || (await askConfirm('Leden krijgen dan een terminal die opdrachten uitvoert als de gebruiker van deze server. Alleen doen als je iedereen volledig vertrouwt. Doorgaan?', { danger: true }))) save({ allowShell: on });
        }}
      />
      <SwitchRow
        label="Cloud-VM’s toestaan voor leden"
        hint="Met hun eigen token en op hun eigen kosten."
        info="Leden kunnen hun bot dan een eigen VM bij Hetzner of DigitalOcean geven. Die VM's tellen niet mee voor het dagbudget."
        checked={!!p.allowCloudVm}
        onChange={(v) => save({ allowCloudVm: v })}
      />
    </>
  );
}

/**
 * Gebruikers (server mode): users, invites, member policy, SSO and SCIM are administration (/admin), which a paired phone
 * leaves to the computer (server/modules/mobile/policy.ts): one calm note instead of a page of failed requests.
 */
function Users() {
  if (useIsPhoneSession())
    return (
      <Card className="p-5">
        <ComputerOnly>Gebruikers, uitnodigingen en inloggen met SSO beheer je op je computer.</ComputerOnly>
      </Card>
    );
  return <UsersAdmin />;
}

const ROLE_LABEL: Record<string, string> = { owner: 'eigenaar', admin: 'beheerder', member: 'lid' };

function UsersAdmin() {
  const me = useApp((s) => s.me);
  const [users, setUsers] = useState<any[] | null>(null);
  const [invites, setInvites] = useState<any[] | null>(null);
  const [inv, setInv] = useState({ uses: '1', days: '14', role: 'member', note: '' });
  const scimGroups = useScimGroupHints();
  const load = () => {
    api.get('/admin/users').then(setUsers).catch(toastError);
    api.get('/admin/invites').then(setInvites).catch(toastError);
  };
  useEffect(load, []);
  const link = (code: string) => `${location.origin}/#/?invite=${code}`;
  return (
    <>
      <Card className="px-5 pb-2 pt-4">
        <h2 className={H2}>Gebruikers</h2>
        {!users ? (
          <Spinner className="my-3" />
        ) : (
          <div className="mt-1 divide-y divide-line">
            {users.map((u) => (
              <div key={u.id} className="flex flex-wrap items-center gap-2 py-3 text-sm">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-medium">
                    {u.name} {u.id === me?.id && <span className="text-muted">(jij)</span>}
                  </div>
                  <div className="truncate text-xs text-muted">{u.email}</div>
                  {scimGroups.get(u.id)?.length ? <div className="truncate text-xs text-muted">via SCIM: {scimGroups.get(u.id)!.join(', ')}</div> : null}
                </div>
                <Badge tone={u.role === 'owner' ? 'accent' : 'neutral'}>{ROLE_LABEL[u.role] || 'lid'}</Badge>
                {u.disabled && <Badge tone="danger">geblokkeerd</Badge>}
                {u.role !== 'owner' && u.id !== me?.id && (
                  <Button size="sm" variant="ghost" onClick={() => api.patch(`/admin/users/${u.id}`, { disabled: !u.disabled }).then(load).catch(toastError)}>
                    {u.disabled ? 'Deblokkeren' : 'Blokkeren'}
                  </Button>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
      <Card className="space-y-3 p-5">
        <div>
          <h2 className={H2}>Iemand uitnodigen</h2>
          <p className="mt-0.5 text-xs text-muted">
            Een eigen account op deze server. <MoreInfo>Met eigen bots, gesprekken en sleutels. Gedeelde providers kunnen ze gebruiken zonder de sleutel te zien.</MoreInfo>
          </p>
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          <Field label="Aantal keer">
            <Input value={inv.uses} onChange={(e) => setInv({ ...inv, uses: e.target.value })} inputMode="numeric" />
          </Field>
          <Field label="Geldig (dagen)">
            <Input value={inv.days} onChange={(e) => setInv({ ...inv, days: e.target.value })} inputMode="numeric" />
          </Field>
          <Field label="Rol">
            <Listbox value={inv.role} onChange={(v) => setInv({ ...inv, role: v })} options={[{ value: 'member', label: translate('Lid') }, ...(me?.role === 'owner' ? [{ value: 'admin', label: translate('Beheerder') }] : [])]} />
          </Field>
          <Field label="Notitie">
            <Input value={inv.note} onChange={(e) => setInv({ ...inv, note: e.target.value })} placeholder="Voor wie?" />
          </Field>
        </div>
        <Button variant="primary" onClick={() => api.post('/admin/invites', { ...inv, uses: Number(inv.uses), days: Number(inv.days) }).then(load).catch(toastError)}>
          Uitnodiging maken
        </Button>
        {invites && invites.length > 0 && (
          <div className="divide-y divide-line">
            {invites.map((i) => (
              <div key={i.code} className="flex flex-wrap items-center gap-2 py-2 text-sm">
                <code className="font-semibold">{i.code}</code>
                <Badge>{i.role === 'admin' ? 'beheerder' : 'lid'}</Badge>
                <span className="text-xs text-muted">
                  nog {i.uses_left}× · tot {new Date(i.expires_at).toLocaleDateString(uiLocale())} {i.note && `· ${i.note}`}
                </span>
                <span className="flex-1" />
                <Button size="sm" variant="ghost" icon={<Copy className="h-3.5 w-3.5" />} onClick={() => navigator.clipboard?.writeText(link(i.code)).then(() => toast('Link gekopieerd', 'ok'))}>
                  Link
                </Button>
                <Button size="sm" variant="ghost" onClick={() => api.del(`/admin/invites/${i.code}`).then(load).catch(toastError)}>
                  Intrekken
                </Button>
              </div>
            ))}
          </div>
        )}
      </Card>
      <MemberPolicyCard />
      <TeamUsageCard />
      {/* Inloggen via het bedrijf: rarely set up, and only once. */}
      <MoreOptions label="Inloggen met SSO en SCIM">
        <SsoCard />
        <ScimCard />
        <ScimGroupsCard />
      </MoreOptions>
    </>
  );
}

/** Start a download of a (signed) link without leaving the page. */
function downloadLink(href: string) {
  const a = document.createElement('a');
  a.href = href;
  a.download = '';
  a.rel = 'noopener';
  document.body.appendChild(a);
  a.click();
  a.remove();
}

/** Back-ups and the full export (also reached with Ctrl+K "back-up"). */
function Backups() {
  // One "Back-ups": the full backup settings of the backups module right here (owner and admins).
  const me = useApp((s) => s.me);
  const Full = me?.role !== 'member' ? uiModules.find((m) => m.id === 'backups')?.settingsTabs?.find((t) => t.id === 'app')?.component : undefined;
  const phone = useIsPhoneSession();
  return (
    <>
      {Full && <Full />}
      <Card className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-5">
        <div className="min-w-0 flex-1 basis-56">
          <h2 className={H2}>Alles exporteren</h2>
          <p className="mt-0.5 text-xs text-muted">
            Alles als één bestand, zonder sleutels. <MoreInfo>Al je bots, gesprekken en instellingen als één bestand, zonder sleutels.</MoreInfo>
          </p>
        </div>
        {phone ? (
          <ComputerOnly>Al je gegevens exporteren kan alleen op je computer.</ComputerOnly>
        ) : (
          // One button, not a button inside a link (a11y); the signed link is made at the click, so it never expires on
          // a page that stayed open.
          <Button icon={<Download className="h-4 w-4" />} onClick={() => downloadLink(authUrl('/export'))}>
            Exporteren
          </Button>
        )}
      </Card>
    </>
  );
}

/** "Geavanceerd tonen" (shell/advanced.ts), saved at once for this user. The old Geavanceerd page is gone; this is its switch. */
function AdvancedSection() {
  return (
    <SettingsSection title="Weergave">
      <AdvancedSwitch />
    </SettingsSection>
  );
}

function AdvancedSwitch() {
  const on = useAdvanced();
  const save = useSave();
  const [busy, setBusy] = useState(false);
  return (
    <SwitchRow
      label="Geavanceerd tonen"
      hint="Toont ook de onderdelen voor gevorderden."
      checked={on}
      disabled={busy}
      onChange={(v) => (setBusy(true), void save(setAdvanced(v)).finally(() => setBusy(false)))}
      info="Extra tabellen, technische details en zeldzame instellingen. Ctrl+K vindt alles."
    />
  );
}

// ---------------------------------------------------------------- the frame: list, page header, "Meer"

interface SettingsTab {
  id: string;
  label: string;
}

/** Wide enough for the settings list next to the page (beside the sidebar). */
const WIDE_QUERY = '(min-width: 1024px)';

const ROW_ICONS: Record<string, LucideIcon> = { Settings2, Sparkles, Gauge, Bot, MonitorSmartphone, Lock };
/** A colour per row, as on the website: the icon sits in a small soft tile, so the list reads at a glance. */
const ROW_TILE: Record<string, string> = {
  general: 'bg-[#ff9440]/15 text-[#e07a22] dark:text-[#ffab69]',
  ai: 'bg-[#8b7cf6]/15 text-[#6d5ce0] dark:text-[#b3a8ff]',
  bots: 'bg-[#35b8a6]/15 text-[#1f8f80] dark:text-[#6fdccd]',
  apps: 'bg-[#4c9bf5]/15 text-[#2f7bd6] dark:text-[#8dc0ff]',
  privacy: 'bg-[#e56b8a]/15 text-[#c94a6b] dark:text-[#ff9db5]',
  gebruik: 'bg-[#d9a520]/15 text-[#a87b0a] dark:text-[#f2c655]',
};

/** One short line under an entry in a list of links ("Meer", Bots en teams, Apps en apparaten). */
/** A stored key in plain words: what it is called and what it is for (never its value). */
function describeSecret(name: string, info: { apps: Record<string, string>; scripts: Record<string, { name: string; label: string }> }): { title: string; purpose: string } {
  const app = /^mcp:([^:]+):(?:env|header|oauth)?:?(.*)$/.exec(name);
  if (app) {
    const pretty = app[2].replace(/_/g, ' ').toLowerCase().replace(/\bapi\b/g, 'API').replace(/^./, (c) => c.toUpperCase());
    return { title: pretty || 'Sleutel', purpose: info.apps[app[1]] ? t('Voor de app {0}', info.apps[app[1]]) : 'Voor een app die niet meer gekoppeld is' };
  }
  const script = /^scriptkey:(.+)$/.exec(name);
  if (script) {
    const k = info.scripts[script[1]];
    return k ? { title: k.name, purpose: k.label || 'Sleutel voor scripts van je bots' } : { title: 'Sleutel voor scripts', purpose: 'Hoort bij geen bot meer; je kunt hem wissen' };
  }
  const ch = /^channel:([^:]+)/.exec(name);
  if (ch) return { title: 'Kanaalsleutel', purpose: 'Voor een gekoppeld kanaal (Telegram, e-mail en zo)' };
  return { title: name, purpose: 'Bewaard door TeamBot' };
}

/** A small coloured icon for every entry of a settings list ("Meer", Bots en teams, Apps en apparaten), as on the website. */
const ENTRY_ICON: Record<string, [LucideIcon, string]> = {
  'notifications-meldingen': [IcBell, 'bg-[#ff9440]/15 text-[#e07a22] dark:text-[#ffab69]'],
  'notifications/': [IcBellRing, 'bg-[#d9a520]/15 text-[#a87b0a] dark:text-[#f2c655]'],
  'voice-spraak': [IcMic, 'bg-[#8b7cf6]/15 text-[#6d5ce0] dark:text-[#b3a8ff]'],
  'voice/vergadering': [IcNotes, 'bg-[#8b7cf6]/15 text-[#6d5ce0] dark:text-[#b3a8ff]'],
  'voice/': [IcMic, 'bg-[#8b7cf6]/15 text-[#6d5ce0] dark:text-[#b3a8ff]'],
  'openbot-import-overstappen': [IcSwitch, 'bg-[#4c9bf5]/15 text-[#2f7bd6] dark:text-[#8dc0ff]'],
  'health-status': [IcActivity, 'bg-[#35b8a6]/15 text-[#1f8f80] dark:text-[#6fdccd]'],
  'network-proxy': [IcNetwork, 'bg-[#4c9bf5]/15 text-[#2f7bd6] dark:text-[#8dc0ff]'],
  'agents/': [Bot, 'bg-[#35b8a6]/15 text-[#1f8f80] dark:text-[#6fdccd]'],
  'teams-teams': [IcUsers, 'bg-[#4c9bf5]/15 text-[#2f7bd6] dark:text-[#8dc0ff]'],
  'teams/alle': [IcGrid, 'bg-[#4c9bf5]/15 text-[#2f7bd6] dark:text-[#8dc0ff]'],
  'memory/': [IcBrain, 'bg-[#8b7cf6]/15 text-[#6d5ce0] dark:text-[#b3a8ff]'],
  'specialists/': [IcGrad, 'bg-[#d9a520]/15 text-[#a87b0a] dark:text-[#f2c655]'],
  'routines-routines': [IcAlarm, 'bg-[#ff9440]/15 text-[#e07a22] dark:text-[#ffab69]'],
  'users': [IcUser, 'bg-[#e56b8a]/15 text-[#c94a6b] dark:text-[#ff9db5]'],
  'cli-agents-cli': [IcTerminal, 'bg-[#8b7cf6]/15 text-[#6d5ce0] dark:text-[#b3a8ff]'],
  'free-models-gratis': [IcGift, 'bg-[#35b8a6]/15 text-[#1f8f80] dark:text-[#6fdccd]'],
  'websearch-zoeken': [Search, 'bg-[#4c9bf5]/15 text-[#2f7bd6] dark:text-[#8dc0ff]'],
  'images-afbeeldingen': [IcImage, 'bg-[#e56b8a]/15 text-[#c94a6b] dark:text-[#ff9db5]'],
  'engine-chain-doorschakelen': [IcShuffle, 'bg-[#d9a520]/15 text-[#a87b0a] dark:text-[#f2c655]'],
  'mobile-telefoon': [IcPhone, 'bg-[#4c9bf5]/15 text-[#2f7bd6] dark:text-[#8dc0ff]'],
  'mobile/concepten': [IcPhone, 'bg-[#4c9bf5]/15 text-[#2f7bd6] dark:text-[#8dc0ff]'],
  'browser/': [IcMonitor, 'bg-[#35b8a6]/15 text-[#1f8f80] dark:text-[#6fdccd]'],
  'browser/kluis': [IcKey, 'bg-[#d9a520]/15 text-[#a87b0a] dark:text-[#f2c655]'],
  'remote-desktop/': [MonitorSmartphone, 'bg-[#35b8a6]/15 text-[#1f8f80] dark:text-[#6fdccd]'],
  'channels/': [IcRadio, 'bg-[#ff9440]/15 text-[#e07a22] dark:text-[#ffab69]'],
  'mcp/': [IcBlocks, 'bg-[#8b7cf6]/15 text-[#6d5ce0] dark:text-[#b3a8ff]'],
  'sites/': [IcGlobe, 'bg-[#4c9bf5]/15 text-[#2f7bd6] dark:text-[#8dc0ff]'],
  'folders/': [IcFolder, 'bg-[#d9a520]/15 text-[#a87b0a] dark:text-[#f2c655]'],
  'folders-teammap': [IcFolder, 'bg-[#d9a520]/15 text-[#a87b0a] dark:text-[#f2c655]'],
  'folders/prullenbak': [IcTrash, 'bg-[#e56b8a]/15 text-[#c94a6b] dark:text-[#ff9db5]'],
  'backups': [IcBackup, 'bg-[#35b8a6]/15 text-[#1f8f80] dark:text-[#6fdccd]'],
  'data': [IcDrive, 'bg-[#4c9bf5]/15 text-[#2f7bd6] dark:text-[#8dc0ff]'],
  'security': [Lock, 'bg-[#e56b8a]/15 text-[#c94a6b] dark:text-[#ff9db5]'],
  'usage': [Gauge, 'bg-[#d9a520]/15 text-[#a87b0a] dark:text-[#f2c655]'],
  'usage/': [Gauge, 'bg-[#d9a520]/15 text-[#a87b0a] dark:text-[#f2c655]'],
  'general': [Settings2, 'bg-[#ff9440]/15 text-[#e07a22] dark:text-[#ffab69]'],
  'providers': [Sparkles, 'bg-[#8b7cf6]/15 text-[#6d5ce0] dark:text-[#b3a8ff]'],
};
const ENTRY_HINT: Record<string, string> = {
  'agents/': 'Al je bots, het archief en importeren.',
  'teams-teams': 'Een eigen team per bedrijf of doel.',
  'rooms/': 'Bots die samen in één gesprek werken.',
  'memory/': 'Wat je bots over jou en je werk onthouden.',
  'specialists/': 'Vakkennis die een bot erbij leert.',
  'rooms/organisatie': 'Wie welke bot aanstuurt.',
  'teams/alle': 'Al je teams naast elkaar.',
  'routines-routines': 'Tijdzone en limieten voor terugkerende taken.',
  users: 'Mensen uitnodigen, rollen en inloggen via je bedrijf.',
  'mobile-telefoon': 'Koppel je telefoon met een QR-code.',
  'browser/': 'Waar je bots op werken: een browser, je bureaublad of een server.',
  'remote-desktop/': 'Je pc bekijken en bedienen vanaf je telefoon.',
  'mobile/concepten': 'Berichten die je zonder verbinding schreef.',
  'channels/': 'Telegram, WhatsApp, Discord, Slack en e-mail.',
  'mcp/': 'Gmail, agenda, Notion en andere apps.',
  'sites/': 'Pagina’s die je bots online zetten.',
  'folders/': 'De mappen en bestanden van je bots.',
  'folders-teammap': 'Eén map die al je bots delen.',
  'folders/prullenbak': 'Verwijderde bestanden terughalen.',
  'browser/kluis': 'Wachtwoorden en sleutels voor je bots.',
  'voice/vergadering': 'Een gesprek opnemen en laten samenvatten.',
  'voice/': 'Eerdere spraakgesprekken met je bots.',
  'voice-spraak': 'Stem, dicteren en voorlezen.',
  'openbot-import-overstappen': 'Neem je bots en gesprekken mee.',
  'health-status': 'Snelheid en storingen van TeamBot zelf.',
  'network-proxy': 'Voor een bedrijfsnetwerk met een proxy.',
  'websearch-zoeken': 'Welke zoekdienst je bots gebruiken.',
  'images-afbeeldingen': 'Met welke dienst je bots afbeeldingen maken.',
  'engine-chain-doorschakelen': 'Gratis modellen als reserve bij een limiet.',
  usage: 'Geschatte kosten per dag, bot en model.',
  'notifications/': 'Alles wat je bots je hebben gemeld.',
  data: 'Wat op deze computer blijft en wat naar een AI-dienst gaat.',
  backups: 'Elke dag een back-up, terugzetten en bijwerken.',
  'notifications-meldingen': 'Geluid, en hoeveel je van elke bot wilt horen.',
  'skills-uitgevers': 'Van wie je skills en bots vertrouwt.',
};

/** The one line under the title of a settings page (only where the title alone does not say it). */
const PAGE_HINT: Record<string, string> = {
  bots: 'Je bots, je teams en wat ze weten.',
  apps: 'Wat je aan TeamBot koppelt en waar je bots bij kunnen.',
  usage: 'Een schatting op basis van publieke prijzen.',
  security: 'Vergrendeling, ingelogde apparaten en het logboek.',
  general: 'Je naam, je taal en hoe TeamBot eruitziet.',
};

/** Every settings tab this user has (module tabs included), with its component. */
function useSettingsTabs() {
  const me = useApp((s) => s.me);
  const mode = useApp((s) => s.mode);
  const isAdmin = me?.role !== 'member';
  const modTabs = uiModules.flatMap((m) => (m.settingsTabs || []).filter((t) => !t.adminOnly || isAdmin).map((t) => ({ ...t, key: `${m.id}-${t.id}` })));
  const tabs: SettingsTab[] = [
    { id: 'general', label: 'Algemeen' },
    { id: 'providers', label: 'AI-diensten' },
    ...modTabs.map((t) => ({ id: t.key, label: t.title })),
    { id: 'usage', label: 'Kosten' },
    { id: 'security', label: 'Beveiliging' },
    { id: 'data', label: 'Waar staat mijn data?' },
    { id: 'backups', label: 'Back-ups' },
    ...(isAdmin && mode === 'server' ? [{ id: 'users', label: 'Gebruikers' }] : []),
  ];
  return { tabs, modTabs };
}

/** The rows of the list for this user, and where `current` (a tab id, an overview id or a page key) sits in them. */
function useSettings(current: string | null) {
  const { tabs, modTabs } = useSettingsTabs();
  const advanced = useAdvanced();
  const rows = settingsNav(tabs, uiModules, { advanced, current });
  const row = current ? rows.find((r) => r.id === settingsParentOf(current).id) : undefined;
  // An alias (Back-ups beheren, Limieten) shows a page of its own under the row it marks.
  const sub = !!current && !!row && row.id !== current && (isSubEntry(current) || settingsRowOf(current) !== current);
  return { tabs, modTabs, rows, row, sub };
}

/** A list of links to settings pages: a title, one short line, a chevron. */
function EntryList({ sections, label }: { sections: SettingsNavRow['more']; label?: string }) {
  return (
    <nav aria-label={label || 'Onderdelen'} className="space-y-4">
      {sections.map((s, i) => (
        <section key={s.title || i}>
          {(s.title || label) && <h2 className="mb-2 px-1 text-[13px] font-semibold text-muted">{s.title || label}</h2>}
          <ul className="divide-y divide-line overflow-hidden rounded-card border border-line bg-surface">
            {s.rows.map((r) => (
              <li key={r.key}>
                <a href={r.href} className="flex min-h-[52px] items-center gap-3 px-4 py-2 transition-colors hover:bg-surface-2">
                  {(() => {
                    const [Icon, tile] = ENTRY_ICON[r.key] || [Settings2, 'bg-surface-3 text-muted'];
                    return (
                      <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg', tile)} aria-hidden>
                        <Icon className="h-[18px] w-[18px]" />
                      </span>
                    );
                  })()}
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{r.title}</span>
                    {ENTRY_HINT[r.key] && <span className="block text-xs leading-snug text-muted">{ENTRY_HINT[r.key]}</span>}
                  </span>
                  <ChevronRight className="h-4 w-4 shrink-0 text-muted rtl-flip" aria-hidden />
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </nav>
  );
}

/**
 * The Settings list: one flat list of plain rows (lib/palette.ts SETTINGS_ROWS), and a filter that matches titles and
 * the words people use ("donker", "back-up", "telegram") and finds every entry, also those under "Meer" of a row.
 */
function SettingsNav({ rows, tabs, current, big }: { rows: SettingsNavRow[]; tabs: SettingsTab[]; current: string | null; big?: boolean }) {
  const [q, setQ] = useState('');
  const results: SettingsRow[] | null = q.trim() ? settingsSearch(tabs, uiModules, q) : null;
  const link = (key: string, href: string, on: boolean, children: React.ReactNode) => (
    <li key={key}>
      <a
        href={href}
        aria-current={on ? 'page' : undefined}
        className={cx(
          'flex items-center gap-3 text-sm transition-colors',
          big ? 'min-h-[52px] px-4 font-medium hover:bg-surface-2' : 'min-h-10 rounded-control px-2 py-1.5 coarse:min-h-11',
          !big && (on ? 'bg-surface-3 font-semibold text-fg' : 'font-medium text-muted hover:bg-surface-2 hover:text-fg'),
        )}
      >
        {children}
        {big && <ChevronRight className="h-4 w-4 shrink-0 text-muted rtl-flip" aria-hidden />}
      </a>
    </li>
  );
  const listClass = big ? 'divide-y divide-line overflow-hidden rounded-card border border-line bg-surface' : 'space-y-0.5';
  return (
    <nav aria-label="Instellingen" className="space-y-3">
      <div className="relative">
        <Search className="pointer-events-none absolute start-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={(e) => e.key === 'Escape' && setQ('')}
          placeholder="Zoek een instelling"
          aria-label="Zoek een instelling"
          className={cx('w-full rounded-control border border-transparent bg-surface-2 ps-8 pe-2 text-sm outline-none placeholder:text-muted focus:border-line-strong', big ? 'h-11 text-[15px]' : 'h-9 coarse:h-11')}
        />
      </div>
      {results ? (
        results.length === 0 ? (
          <p className="px-2 text-sm text-muted">Niets gevonden. Ctrl+K zoekt in heel TeamBot.</p>
        ) : (
          <ul className={listClass}>
            {results.map((r) =>
              link(
                r.key,
                r.href,
                false,
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-fg">{r.title}</span>
                  {r.parent && <span className="block truncate text-xs font-normal text-muted">{r.parent}</span>}
                </span>,
              ),
            )}
          </ul>
        )
      ) : (
        <ul className={listClass}>
          {rows.map((r) => {
            const Icon = ROW_ICONS[r.icon] || Settings2;
            return link(
              r.id,
              r.href,
              current === r.id,
              <>
                <span className={cx('flex shrink-0 items-center justify-center rounded-lg', big ? 'size-8' : 'size-7', ROW_TILE[r.id] || 'bg-surface-3 text-muted')} aria-hidden>
                  <Icon className={big ? 'h-[18px] w-[18px]' : 'h-4 w-4'} />
                </span>
                <span className="min-w-0 flex-1 truncate">{r.title}</span>
              </>,
            );
          })}
        </ul>
      )}
    </nav>
  );
}

/** The settings list as a column next to the page (wide screens). */
function SettingsColumn({ rows, tabs, current }: { rows: SettingsNavRow[]; tabs: SettingsTab[]; current: string | null }) {
  return (
    // Flat, like the sidebar next to it: the page's background and one thin line.
    <aside className="h-full w-[232px] shrink-0 border-e border-line">
      <div className="scroll-thin h-full overflow-y-auto px-2.5 pb-6 pt-5">
        <div className="mb-3 flex items-center gap-2 px-1.5">
          <LeaveSettings compact />
          <a href="#/settings" className="block text-lg font-bold tracking-tight hover:text-fg">
            Instellingen
          </a>
        </div>
        <SettingsNav rows={rows} tabs={tabs} current={current} />
      </div>
    </aside>
  );
}

/**
 * Where the owner was before he opened Instellingen (a chat, Taken, the start page): "back" out of the settings goes
 * there. A hashchange fires before the next page is drawn, so at that moment `inSettings` still tells what the old
 * page was.
 */
let outsideHash = '#/';
let inSettings = 0;
if (typeof window !== 'undefined')
  window.addEventListener('hashchange', (e) => {
    if (inSettings > 0) return;
    try {
      outsideHash = new URL(e.oldURL).hash || '#/';
    } catch {
      outsideHash = '#/';
    }
  });
function useInSettings() {
  useEffect(() => {
    inSettings++;
    return () => {
      inSettings--;
    };
  }, []);
}

/** The one way back, always in the same place: a round arrow you cannot miss, with where it goes. */
function BackLink({ href, label }: { href: string; label: string }) {
  return (
    <a href={href} className="group inline-flex min-h-9 items-center gap-2 text-[13px] font-medium text-muted transition-colors hover:text-fg coarse:min-h-11">
      <span className="grid h-7 w-7 place-items-center rounded-full border border-line bg-surface transition-colors group-hover:border-fg/30">
        <ArrowLeft className="h-4 w-4 rtl-flip" aria-hidden />
      </span>
      {label}
    </a>
  );
}

/** Out of Instellingen, back to where you were. */
function LeaveSettings({ compact }: { compact?: boolean }) {
  return compact ? (
    <a href={outsideHash} title={t('Terug')} aria-label={t('Terug')} className="grid h-7 w-7 shrink-0 place-items-center rounded-full border border-line bg-surface text-muted transition-colors hover:border-fg/30 hover:text-fg">
      <ArrowLeft className="h-4 w-4 rtl-flip" aria-hidden />
    </a>
  ) : (
    <BackLink href={outsideHash} label="Terug" />
  );
}

/** Where "back" goes: from an entry under "Meer" to its row; on a narrow screen from a row to the list. */
function backOf(row: SettingsNavRow | undefined, sub: boolean, wide: boolean): { href: string; label: string } | null {
  if (sub && row) return { href: row.href, label: row.title };
  return wide ? null : { href: '#/settings', label: 'Instellingen' };
}

/**
 * A page that lives under Instellingen but has its own URL (#/m/channels/, #/agents …): on wide screens next to the
 * settings list, with the way back above it (to its row, or on a narrow screen to Instellingen). `current` is its entry.
 */
export function SettingsFrame({ current, children }: { current: string; children: React.ReactNode }) {
  useInSettings();
  const wide = useMedia(WIDE_QUERY);
  const { tabs, rows, row, sub } = useSettings(current);
  const back = backOf(row, sub, wide);
  // The page of a row (Gebruik en limieten) with more under it: one scroll for the page and its "Meer".
  const more = !sub && row?.more.length ? row.more : null;
  return (
    <div className="flex h-full min-h-0">
      {wide && <SettingsColumn rows={rows} tabs={tabs} current={row?.id || null} />}
      <div className="flex h-full min-w-0 flex-1 flex-col">
        {back && (
          <div className={cx('shrink-0 px-4 sm:px-6', wide ? '-mb-4 pt-5' : 'pt-[max(0.75rem,var(--safe-top))]')}>
            <BackLink {...back} />
          </div>
        )}
        {more ? (
          <div className="scroll-thin min-h-0 flex-1 overflow-y-auto [&>.scroll-thin]:h-auto [&>.scroll-thin]:overflow-visible [&>.scroll-thin]:pb-0">
            {children}
            <div className="mx-auto max-w-5xl px-4 pb-10 pt-2 sm:px-6">
              <EntryList sections={more} label="Meer" />
            </div>
          </div>
        ) : (
          <div className="min-h-0 flex-1">{children}</div>
        )}
      </div>
    </div>
  );
}

/**
 * #/settings[/<tab>]. Wide screens: the list on the left next to the page. Narrower windows and the phone: #/settings
 * is the list, a row opens full-screen with a back link. Every page has the same layout: the title, at most one line
 * under it, cards with rows, and under the page of a row the list "Meer" with what else belongs to it. Every tab keeps
 * its own URL, and Ctrl+K finds each one.
 */
export function SettingsPage({ tab }: { tab?: string }) {
  useInSettings();
  const wide = useMedia(WIDE_QUERY);
  // The old Geavanceerd page: Algemeen with "Meer opties" open (its switch lives there now).
  const openMore = tab === 'advanced';
  const asked = openMore || tab === 'appearance' ? 'general' : tab || null;
  const all = useSettings(asked);
  const hubAsked = all.rows.find((r) => !r.hasMain && r.id === asked);
  const found = hubAsked?.id || all.tabs.find((t) => t.id === asked)?.id || null;
  const current = found || (wide ? 'general' : null);
  const { tabs, modTabs, rows, row, sub } = found && found === asked ? all : { ...all, row: all.rows.find((r) => r.id === 'general'), sub: false };

  if (!current)
    return (
      <Page>
        <div className="mx-auto max-w-xl px-4 pb-8 pt-5 sm:px-6">
          <div className="-mt-1 mb-1">
            <LeaveSettings />
          </div>
          <h1 className="mb-4 text-[22px] font-bold leading-tight tracking-tight">Instellingen</h1>
          <SettingsNav rows={rows} tabs={tabs} current={null} big />
        </div>
      </Page>
    );

  const hub = rows.find((r) => !r.hasMain && r.id === current);
  const Mod = modTabs.find((t) => t.key === current)?.component;
  const entry = row?.more.flatMap((s) => s.rows).find((r) => r.key === current);
  const title = !sub && row ? row.title : entry?.title || tabs.find((t) => t.id === current)?.label || '';
  const back = backOf(row, sub, wide);
  const page = (
    <Page>
      <div className={cx('mx-auto px-4 pb-10 pt-5 sm:px-6', wide && 'pt-8', current === 'providers' || current === 'users' ? 'max-w-4xl' : 'max-w-3xl')}>
        {back && (
          <div className="-mt-1 mb-1">
            <BackLink {...back} />
          </div>
        )}
        <h1 className="text-[22px] font-bold leading-tight tracking-tight sm:text-2xl">{title}</h1>
        {PAGE_HINT[current] && <p className="mt-1 text-sm text-muted">{PAGE_HINT[current]}</p>}
        <div className="mt-5 space-y-4">
          {current === 'general' && <General openMore={openMore} />}
          {current === 'providers' && <ProvidersSettings />}
          {current === 'usage' && <Usage />}
          {current === 'security' && <Security />}
          {current === 'data' && <Data />}
          {current === 'backups' && <Backups />}
          {current === 'users' && <Users />}
          {Mod && <Mod />}
          {hub && <EntryList sections={hub.more} />}
          {!hub && !sub && !!row?.more.length && <EntryList sections={row.more} label="Meer" />}
        </div>
      </div>
    </Page>
  );
  if (!wide) return page;
  return (
    <div className="flex h-full min-h-0">
      <SettingsColumn rows={rows} tabs={tabs} current={row?.id || null} />
      <div className="h-full min-w-0 flex-1">{page}</div>
    </div>
  );
}
