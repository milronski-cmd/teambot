import type React from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Archive, ChevronDown, CircleAlert, Copy, MessageSquare, Sparkles, Trash2, Settings2, ShieldCheck, ScrollText } from 'lucide-react';
import { EditorSaveContext, changedFields, dirtySectionKeys, flushSections, prepareSections, unsavedLabels, type EditorSaveApi, type EditorSection } from '../lib/editorSave';
import { formatList, tText } from '../lib/format';
import { api } from '../lib/api';
import { useApp } from '../lib/store';
import { navigate, query, setLeaveGuard } from '../lib/router';
import type { Agent, ModelInfo, ProviderView, ToolGroup } from '../lib/types';
import { uiModules } from '../modules';
import { AgentHistory } from './AgentHistory';
import { askConfirm, Badge, Button, Card, EmptyState, Field, Input, Modal, Page, PageHeader, Spinner, Textarea, Toggle, cx, toast, toastError, useAsync, CardHead } from '../components/ui';
import { BUSY_POLICIES, busyPolicy } from '../shell/busyPolicy';
import { BotDeleteDialog } from '../shell/BotDeleteDialog';
import { BotAvatar } from '../components/BotFace';
import { FacePicker } from '../components/FacePicker';
import { isOwnWorkspace } from '../components/FolderName';
import { MoreInfo } from '../components/MoreInfo';
import { MoreOptions } from '../components/MoreOptions';
import { t, translate } from '../lib/i18n';
import { BotLanguageSelect } from '../components/LanguagePicker';
import { ModelChoice } from '../components/ModelPicker';
import { Dropdown, Segmented, SettingRow, SwitchRow } from '../components/SettingControls';
import { settingOptions, settingText } from '../../../shared/settings.js';
import { Listbox } from '../components/Listbox';
import { AgentPrivacyLine } from '../modules/network/Privacy';
import { ContextWindowField, ModelFacts, REASONING_LABELS, effectiveModel, hasModelFacts, levelsFor } from '../components/ModelFacts';
import { NewBot } from './newbot/NewBot';
import { MAX_RESERVES, reservesPatch } from './agentReserves';
import { EXTRA_ARGS, accessLevels, accessLine, accessOn, busyShown, changedRows, guardLine, rowWorks, stepsOf, switchAi, withSteps, withoutKeptAccess, type LevelGuard } from './agentRows';
import { useMultiTeam } from '../modules/teams/scope';
import { OwnRules } from '../modules/botrules/OwnRules';
import { WerkplekLine } from '../modules/folders/Werkplek';
import { AgentOrders } from './AgentOrders';

// (Up here, before any markup: the extractor reads text between placeholders in markup as a fragment of its own.)
/** Why a member cannot edit a bot shared with the team, with its owner's name when the list has it. */
function sharedNote(owner: string | undefined): string {
  return owner ? t('{0} deelt deze bot met het team. Alleen {1} kan hem aanpassen.', owner, owner) : 'Deze bot is gedeeld. Alleen de eigenaar kan hem aanpassen.';
}

type Draft = Partial<Agent>;

/** Which advanced sections this viewer keeps open (per browser; a convenience, so failures are ignored). */
const OPEN_KEY = 'tb.agentEditor.open';
function useOpenSections() {
  const [open, setOpen] = useState<string[]>(() => {
    try {
      const v = JSON.parse(localStorage.getItem(OPEN_KEY) || '[]');
      return Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(0, 50) : [];
    } catch {
      return [];
    }
  });
  const save = (next: string[]) => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(next));
    } catch {
      /* private mode */
    }
    return next;
  };
  return {
    open,
    toggle: (k: string) => setOpen((cur) => save(cur.includes(k) ? cur.filter((x) => x !== k) : [...cur, k])),
    set: (keys: string[]) => setOpen(save(keys)),
  };
}

/**
 * The bot page ("ik zie nog veel instellingen staan waar ik niet veel van snap"). What everyone sees is what a bot IS:
 * its face and name, its role, the AI and model it uses (with what it goes on with when that AI is used up), what it
 * must do, and what it may do. Nothing else on the first level.
 *
 * Everything optional sits in ONE clearly named fold, "Meer mogelijkheden", and there every part is the same thing:
 * one row with a title and one line that says what it is; a click opens that one part. Nothing in it has to be set:
 * the defaults work, and a bot changes its own settings when you ask it in the chat. Every section (the editor's own
 * and those of the modules) has one home:
 *  - `kan`: what the bot can use, inside the row "Onderdelen en skills", only shown with "Zelf kiezen";
 *  - `adv`: the rows of Meer mogelijkheden, in this order. A module section that is listed nowhere lands at the end.
 *
 * Per kind of AI (a model through a key, a local model, Claude Code, Codex, an ACP program): the page shows exactly
 * the rows, fields and choices that work on the AI the bot uses now. What cannot work there is not shown (never greyed
 * out with an explanation), and the same thing is the same row with the same words on every AI that has it. Which row
 * works where is one table, read from the server's code: pages/agentRows.ts. A row or field that depends on the AI
 * carries `data-row`, so the check per AI (tests/e2e/agent-page-per-ai.mjs) can read what is shown.
 */
const PLACES = {
  kan: ['core:tools', 'skills:skills'],
  adv: [
    'routines:routines',
    'channels:channels',
    'rooms:rooms',
    'core:engine',
    'core:turn',
    'core:program',
    'mcp:apps',
    'memory:memory',
    'specialists:specialist',
    'quality:quality',
    'voice:voice',
    'browser:computer',
    'core:workspace',
    'script-keys:keys',
    'usage:cap',
    'teams:main',
    'teams:teams',
    'core:sharing',
    'notifications:meldingen',
    'engine-chain:privacy',
    'skills:template',
    'core:history',
  ],
} as const;
type Place = keyof typeof PLACES;
const placeOf = (key: string): Place => (Object.keys(PLACES) as Place[]).find((x) => (PLACES[x] as readonly string[]).includes(key)) || 'adv';
/** Tool groups that follow from where the bot works (Computer & bestanden sets them): not part of "Automatisch". */
const COMPUTER_GROUPS = new Set(['browser', 'desktop', 'rehearsal', 'container', 'remote']);
/** Old links to a tab of the bot page (#/agents/<id>?tab=rechten): they open Meer mogelijkheden, where those parts live now. */
const ADVANCED_TABS = new Set(['meer', 'kunnen', 'rechten', 'instructies']);
/** One line under a closed module section, so you know what is in it without opening it. */
const SECTION_HINT: Record<string, string> = {
  'browser:computer': 'Waar de bot werkt: zijn werkmap, een browser, je bureaublad of een server',
  'channels:channels': 'Telegram, Discord, Slack, e-mail of WhatsApp',
  'mcp:apps': 'Geef je bots toegang tot je diensten.',
  'script-keys:keys': 'Geheime sleutels voor de scripts van deze bot',
  'memory:memory': 'Wat de bot onthoudt en welk geheugen hij leest',
  'rooms:rooms': 'Groepsgesprekken waar de bot in zit',
  'routines:routines': 'Terugkerende taken van deze bot',
  'skills:skills': 'Werkwijzen die de bot kan laden',
  'skills:template': 'Exporteren als bestand of delen op deze server',
  'voice:voice': 'Stem, voorlezen en live praten',
  'notifications:meldingen': 'Welke meldingen je van deze bot krijgt',
  'teams:teams': 'Thuisteam en toegang tot andere teams',
  'usage:cap': 'Hoeveel deze bot per dag of week mag gebruiken',
  'teams:main': 'De bot die alle teams werk mag geven',
  'engine-chain:privacy': 'Privé werken, en gratis modellen als reserve',
  'specialists:specialist': 'De vakkennis van deze bot',
  'quality:quality': 'Wanneer het werk van deze bot als af geldt',
};
/** Module sections that are merged into another section (folders live with the workspace). */
const SECTION_ALIAS = (k: string) => (k.startsWith('folders:') ? 'core:workspace' : k);

/**
 * One row of Meer mogelijkheden: a title, one line, and its content when opened. Its content mounts on first open and then stays mounted (hidden when closed), so a
 * section with its own unsaved state keeps it when you close it, and the main "Opslaan" still saves it.
 */
function Section({ id, title, summary, open, onToggle, dirty, children }: { id: string; title: string; summary?: React.ReactNode; open: boolean; onToggle(): void; dirty?: boolean; children: React.ReactNode }) {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) setMounted(true);
  }, [open]);
  const bodyId = `sectie-${id.replace(/[^\w-]/g, '-')}`;
  return (
    <Card className="overflow-hidden" data-section={id}>
      <h3>
        <button type="button" aria-expanded={open} aria-controls={bodyId} onClick={onToggle} className="flex w-full items-center gap-3 px-5 py-3.5 text-start transition-colors hover:bg-surface-2 coarse:py-4">
          <span className="min-w-0 flex-1">
            <span className="flex flex-wrap items-center gap-2 text-[15px] font-bold tracking-tight">
              {title}
              {dirty && (
                <Badge tone="warn">
                  <span className="h-1.5 w-1.5 rounded-full bg-warn-strong" aria-hidden /> Niet opgeslagen
                </Badge>
              )}
            </span>
            {summary && <span className="mt-0.5 block text-xs leading-snug text-muted [overflow-wrap:anywhere]">{summary}</span>}
          </span>
          <ChevronDown className={cx('h-4 w-4 shrink-0 text-muted transition-transform', open && 'rotate-180')} aria-hidden />
        </button>
      </h3>
      {mounted && (
        <div id={bodyId} hidden={!open} className="space-y-3 border-t border-line px-5 pb-5 pt-4">
          {children}
        </div>
      )}
    </Card>
  );
}

const ACCESS: { id: Agent['access_mode']; label: string; text: string }[] = [
  { id: 'chat', label: 'Alleen chat', text: 'Praat alleen; doet verder niets.' },
  { id: 'readonly', label: 'Alleen lezen', text: 'Mag lezen en zoeken, niets wijzigen.' },
  { id: 'ask', label: 'Vraagt toestemming', text: 'De bot vraagt je akkoord voordat hij iets wijzigt.' },
  { id: 'auto', label: 'Automatisch', text: 'De bot werkt zelf door. Versturen naar anderen, betalen en wat niet terug kan, vraagt hij eerst.' },
  { id: 'full', label: 'Volledige toegang', text: 'Werkt zonder te vragen op je hele computer; versturen en betalen vragen wel. Alleen voor bots die je vertrouwt.' },
];
/** A rule for one tool: follow the access level, or always allow, ask or refuse. */
const TOOL_POLICIES = [
  { value: '', label: 'Volgens modus' },
  { value: 'allow', label: 'Toestaan' },
  { value: 'ask', label: 'Altijd vragen' },
  { value: 'deny', label: 'Nooit' },
];
/** What a bot does at a usage limit (settings.onLimit): a short label and its one-line explanation. */
const ON_LIMIT: { id: string; label: string; text: string }[] = [
  { id: 'fallback', label: 'Reserves gebruiken', text: 'Overschakelen naar de reserves; zijn die op, wachten tot de limiet voorbij is en opnieuw proberen' },
  { id: 'wait', label: 'Wachten', text: 'Niet wisselen: wachten tot de limiet voorbij is en opnieuw proberen' },
  { id: 'stop', label: 'Stoppen', text: 'Stoppen en het melden' },
];

export const FULL_WARNING =
  'Volledige toegang: de bot werkt zonder te vragen op je hele computer: alle mappen, terminal, browser en bureaublad. Mappen met sleutels en wachtwoorden blijven dicht. Versturen, publiceren en betalen vragen nog toestemming. Alles wordt gelogd. Doorgaan?';

/** The warning for "Volledige toegang", honest about an engine that cannot keep reads inside the bot's folders here. */
export function fullWarning(read?: { text: string; confined: boolean } | null): string {
  if (!read || read.confined) return FULL_WARNING;
  return FULL_WARNING.replace('harde blokkades (buiten de werkmap, wachtwoordvelden, gevaarlijke opdrachten) blijven gelden', 'harde blokkades (schrijven buiten de werkmap, wachtwoordvelden, gevaarlijke opdrachten) blijven gelden').replace(' Doorgaan?', ` ${read.text} Doorgaan?`);
}

/** #/agents/new makes a bot (pages/newbot/NewBot.tsx); #/agents/<id> is the bot's own page. */
export function AgentEditor({ id }: { id: string | 'new' }) {
  return id === 'new' ? <NewBot /> : <BotPage id={id} />;
}

/**
 * The page of one bot: who it is and which AI it uses (Overzicht), what it is told (Instructies), what it can use
 * (Kunnen), when it works by itself and where you reach it (Routines en kanalen) and what it may do (Rechten).
 * What people rarely change sits in closed sections with one line that says what is in them.
 */
function BotPage({ id }: { id: string }) {
  const page = location.hash;
  const providers = useApp((s) => s.providers);
  const settings = useApp((s) => s.settings);
  // "Gedeeld met het team" (server mode; the server's owner or an admin, for his own bots): server/agent/shared.ts.
  const canShare = useApp((s) => s.mode === 'server' && (s.me?.role === 'owner' || s.me?.role === 'admin'));
  const existing = useApp((s) => s.agents.find((a) => a.id === id));
  // Beheer (the same actions as the chat menu).
  const [delBot, setDelBot] = useState(false);
  const duplicateBot = async () => {
    if (!existing) return;
    const from = location.hash;
    try {
      const a = await api.post<Agent>(`/agents/${existing.id}/duplicate`);
      useApp.setState((s) => ({ agents: [...s.agents.filter((x) => x.id !== a.id), a] }));
      toast(`Kopie gemaakt: ${a.name}. Gesprekken en geheugen gaan niet mee.`, 'ok');
      navigate(`/agents/${a.id}`, { from });
    } catch (e) {
      toastError(e);
    }
  };
  const archiveBot = async () => {
    if (!existing) return;
    const from = location.hash;
    const to = !existing.archived;
    if (to && !(await askConfirm(`${existing.name} archiveren? De bot doet niets meer tot je hem terughaalt (Alle bots › Archief).`, { ok: 'Archiveren' }))) return;
    try {
      const a = await api.patch<Agent>(`/agents/${existing.id}`, { archived: to });
      useApp.setState((s) => ({ agents: s.agents.map((x) => (x.id === a.id ? a : x)) }));
      toast(to ? `${a.name} staat in het archief` : `${a.name} is terug uit het archief`, 'ok');
      if (to) navigate('/', { from });
    } catch (e) {
      toastError(e);
    }
  };
  // A bot someone else shares with the team: its member may talk to it, not edit it (only what the list shows).
  const sharedBot = useApp((s) => s.shared.find((a) => a.id === id));
  const [missing, setMissing] = useState(false);
  const [d, setD] = useState<Draft | null>(null);
  const [groups, setGroups] = useState<ToolGroup[]>([]);
  const [tools, setTools] = useState<{ name: string; group: string; risk: string; description: string }[]>([]);
  const [models, setModels] = useState<ModelInfo[]>([]);
  const fallbacks: { provider_id: string; model: string }[] = (Array.isArray(d?.settings?.fallbacks) ? d.settings.fallbacks : d?.fallback ? [d.fallback] : []) as any;
  // All five slots are kept (it used to cut the list to three, so a fourth or fifth reserve silently fell away).
  const setFallbacks = (list: { provider_id: string; model: string }[]) => set(reservesPatch(d?.settings, list));
  const [modelsErr, setModelsErr] = useState('');
  const [modelsLoading, setModelsLoading] = useState(false);
  const [genErr, setGenErr] = useState('');
  // The engine for the profile is at its limit: a local model to try with one click, as the chat offers it.
  const [genLimited, setGenLimited] = useState(false);
  // "Zelf kiezen" under Meer mogelijkheden: null follows what the bot has (all parts on = Automatisch).
  const [ownTools, setOwnTools] = useState<boolean | null>(null);
  // Meer mogelijkheden opens by itself for an old link to a tab (#/agents/<id>?tab=rechten), also on the page that is open.
  const [advOpen, setAdvOpen] = useState(() => ADVANCED_TABS.has(query().get('tab') || ''));
  useEffect(() => {
    const f = () => ADVANCED_TABS.has(query().get('tab') || '') && setAdvOpen(true);
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  const save = useAsync();
  const gen = useAsync();
  // What the server has (the draft is compared with it for "niet opgeslagen"), and the module sections with their own state.
  const [saved, setSaved] = useState<Draft | null>(null);
  const loadAgent = (a: Draft) => (setD({ ...a }), setSaved({ ...a }));
  const regs = useRef(new Map<string, EditorSection>());
  const [, setTick] = useState(0);
  const editorApi = useMemo<EditorSaveApi>(
    () => ({
      register(key, s) {
        regs.current.set(key, s);
        setTick((n) => n + 1);
        return () => {
          if (regs.current.get(key) === s) regs.current.delete(key);
          setTick((n) => n + 1);
        };
      },
      synced(patch) {
        setD((x) => ({ ...(x || {}), ...patch }));
        setSaved((x) => (x ? { ...x, ...patch } : x));
      },
      changed: () => setTick((n) => n + 1),
    }),
    [],
  );
  // Leaving with unsaved changes asks first (hash navigation and closing the window).
  const bypass = useRef(false);
  const unsavedRef = useRef<string[]>([]);
  const [leave, setLeave] = useState<string | null>(null);
  const openSecs = useOpenSections();
  // Teams (home team, access to other teams) only with two or more teams.
  const multiTeam = useMultiTeam();
  const [faceOpen, setFaceOpen] = useState(false);
  useEffect(() => {
    // The router asks this guard before it changes the page: with unsaved changes, put the old URL back and ask.
    const offGuard = setLeaveGuard((e) => {
      if (bypass.current || !unsavedRef.current.length) return true;
      const to = location.hash;
      history.replaceState(null, '', e.oldURL);
      setLeave(to);
      return false;
    });
    const onUnload = (e: BeforeUnloadEvent) => {
      if (bypass.current || !unsavedRef.current.length) return;
      e.preventDefault();
      e.returnValue = '';
    };
    window.addEventListener('beforeunload', onUnload);
    return () => {
      offGuard();
      window.removeEventListener('beforeunload', onUnload);
    };
  }, []);
  const go = (to: string) => {
    bypass.current = true;
    navigate(to);
  };

  useEffect(() => {
    api.get<{ groups: ToolGroup[]; tools: any[] }>('/tools').then((r) => (setGroups(r.groups), setTools(r.tools))).catch(() => {});
  }, []);

  // What a CLI engine can read on this computer (Codex: checked per computer), for the access card and the warning.
  const [readAccess, setReadAccess] = useState<{ text: string; confined: boolean } | null>(null);
  // The AI the bot uses now: it decides which rows, fields and choices of this page are shown (agentRows.ts).
  const engineProv = providers.find((p) => p.id === d?.provider_id);
  const cliProvider = engineProv?.type === 'cli' ? d?.provider_id : null;
  // Per level: does TeamBot guard the hard blocks (key files, closed folders, its own data) for this bot on this AI? The
  // server says it for any AI and level (permissions.ts hardBlocks); until it has answered, nothing is said.
  const [levelGuards, setLevelGuards] = useState<Partial<Record<string, LevelGuard>> | null>(null);
  useEffect(() => {
    setLevelGuards(null);
    if (!d?.provider_id) return;
    let alive = true;
    api
      .get<{ levels?: Record<string, LevelGuard> }>(`/cli-agents/hard-blocks/${encodeURIComponent(d.provider_id)}?agentId=${encodeURIComponent(id)}`)
      .then((r) => alive && setLevelGuards(r.levels || null))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [d?.provider_id, id]);
  useEffect(() => {
    setReadAccess(null);
    if (!cliProvider) return;
    let alive = true;
    api
      .get<{ text: string; confined: boolean }>(`/cli-agents/read-access/${cliProvider}`)
      .then((r) => alive && setReadAccess(r))
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [cliProvider]);

  useEffect(() => {
    setMissing(false);
    if (existing) {
      loadAgent(existing);
    } else {
      api.get<Agent>(`/agents/${id}`).then(loadAgent).catch(() => (setD(null), setMissing(true)));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, existing?.id]);

  useEffect(() => {
    if (!d?.provider_id) return setModels([]);
    setModelsErr('');
    setModels([]);
    setModelsLoading(true);
    api
      .get<ModelInfo[]>(`/providers/${d.provider_id}/models`)
      .then(setModels)
      .catch((e) => (setModels([]), setModelsErr(e.message)))
      .finally(() => setModelsLoading(false));
  }, [d?.provider_id]);

  // A model typed by hand ("Ander model"), or the model of a CLI engine while its list still loads (Claude Code asks
  // itself per alias, which can take half a minute, and the block "Modelgegevens" stayed away meanwhile; acceptance
  // round 5, C-01): ask the server what it knows about it (table facts, levels, price). A CLI bot without a model runs
  // on the engine's own default. Other engines list quickly, with more facts than this (Ollama's context): wait.
  const [customInfo, setCustomInfo] = useState<ModelInfo | null>(null);
  const infoFor = d?.model || (cliProvider ? 'default' : '');
  useEffect(() => {
    setCustomInfo(null);
    if (!d?.provider_id || !infoFor || (modelsLoading ? !cliProvider : models.some((m) => m.id === infoFor))) return;
    const t = setTimeout(
      () => {
        api
          .get<ModelInfo>(`/providers/${d.provider_id}/model-info?model=${encodeURIComponent(infoFor)}`)
          .then(setCustomInfo)
          .catch(() => {});
      },
      modelsLoading ? 0 : 400,
    );
    return () => clearTimeout(t);
  }, [d?.provider_id, infoFor, models, modelsLoading]);

  const set = (p: Draft) => setD((x) => ({ ...(x || {}), ...p }));
  // A bot that was saved on a level its AI cannot be held to ("Alleen chat" on Codex: every turn was refused): the page
  // shows the level that works there and saves that; the level that was chosen is kept for when the bot goes back to
  // an AI that can be held to it.
  const levelOk = !d || !engineProv || accessLevels(engineProv).includes((d.access_mode || 'ask') as Agent['access_mode']);
  useEffect(() => {
    if (levelOk || !d) return;
    set({ access_mode: accessOn(engineProv, d.access_mode), settings: { ...(d.settings || {}), kept: { ...(d.settings?.kept || {}), access: d.settings?.kept?.access || d.access_mode } } });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [levelOk]);
  const sections = useMemo(() => uiModules.flatMap((m) => (m.agentSections || []).map((s) => ({ ...s, key: `${m.id}:${s.id}` }))), []);
  const regList = [...regs.current.values()];
  // The two rows about a turn and the program name themselves; what is only put aside for another AI is no change.
  const rowsChanged = changedRows(saved?.settings, d?.settings);
  const ownLabels = [rowsChanged.turn ? 'Duur van een beurt' : '', rowsChanged.program ? 'Programma' : ''].filter(Boolean);
  const unsaved = d ? unsavedLabels(changedFields(saved, d).filter((f) => !['settings.cli', 'settings.maxTurns', 'settings.kept'].includes(f)), [...ownLabels, ...regList.filter((s) => s.dirty()).map((s) => s.label)]) : [];
  unsavedRef.current = unsaved;

  if (!d) {
    // A member who opens the editor link of a shared bot (acceptance round 5, A-61: "Bot niet gevonden"): say why,
    // with the way back to the conversation. Nothing of the owner's setup is loaded or shown.
    if (sharedBot && !existing) {
      const why = sharedNote(sharedBot.shared_from?.name);
      return (
        <EmptyState
          art={<BotAvatar bot={sharedBot} size={56} />}
          title="Alleen de eigenaar kan deze bot aanpassen"
          action={
            <div className="flex flex-wrap justify-center gap-2">
              <Button variant="primary" onClick={() => navigate(`/a/${sharedBot.id}`)}>
                Naar het gesprek
              </Button>
              <Button onClick={() => navigate('/')}>Naar start</Button>
            </div>
          }
        >
          {why}
        </EmptyState>
      );
    }
    return missing ? (
      <EmptyState title="Bot niet gevonden" action={<Button onClick={() => navigate('/agents')}>Naar alle bots</Button>} />
    ) : (
      <div className="flex h-full items-center justify-center">
        <Spinner />
      </div>
    );
  }

  /** Saves the bot and every module section with unsaved changes. Resolves true when everything is stored. */
  const submit = () =>
    save.run(async () => {
      if (!d.name?.trim()) throw new Error('Geef de bot een naam');
      const secs = [...regs.current.values()];
      const payload: Draft = await prepareSections(secs, { ...d });
      if (!payload.workspace?.trim()) delete payload.workspace;
      let a = await api.patch<Agent>(`/agents/${id}`, payload);
      loadAgent(a);
      // Sections with their own settings (e.g. Computer) are stored after the bot, so their server-side changes
      // (such as tool groups for the chosen computer mode) are not overwritten by the bot's own save.
      const r = await flushSections(secs);
      if (r.saved.length) a = await api.get<Agent>(`/agents/${id}`).catch(() => a);
      loadAgent(a);
      useApp.setState((s) => ({ agents: s.agents.map((x) => (x.id === a.id ? a : x)) }));
      if (r.failed.length) {
        toast(t('Bot opgeslagen, maar {0} niet: {1}', formatList(r.failed.map((f) => translate(f.label))), r.failed[0].error), 'danger');
        return false;
      }
      toast('Opgeslagen', 'ok');
      return true;
    });

  /**
   * "Laat AI de instructies schrijven": rules from the bot's role and short description. Only the instructions change
   * (not saved until "Opslaan"). `local`: write them with this local model instead.
   */
  const generate = (local?: ProviderView) =>
    gen.run(async () => {
      setGenErr('');
      setGenLimited(false);
      // The reason stays under the button (a toast disappears after a few seconds); nothing is saved on failure.
      const r = await api.post<{ draft: Draft; model: string; provider_id: string }>('/agents/generate', { description: genFrom, provider_id: local?.id || genEngine || undefined }).catch((e) => {
        setGenErr(e?.message || String(e));
        setGenLimited(e?.code === 'limit');
        throw e;
      });
      if (r.draft.instructions) set({ instructions: r.draft.instructions });
      toast('Instructies klaar: lees ze na en sla op', 'ok');
    });

  const providerOptions = providers.filter((p) => p.enabled);
  // "Laat AI de instructies schrijven" asks an AI one loose question. The bot's own AI when it can answer one, else
  // the AI new bots get, else the first connected one that can: a program that cannot (an ACP program other than
  // OpenCode) is never asked, it could only fail. No AI that can: no button.
  const genEngine = [engineProv, providerOptions.find((p) => p.id === settings.defaultProvider), ...providerOptions].find((p) => !!p && rowWorks('writeInstructions', p))?.id;
  // A local model that is connected (not the engine that just hit its limit): free here, without a daily limit.
  const localAlt = genLimited ? providerOptions.find((p) => p.billing === 'local' && p.id !== genEngine) : undefined;

  // What "Laat AI de instructies schrijven" starts from.
  const genFrom = [d.role, d.description].map((x) => x?.trim()).filter(Boolean).join('. ');

  const riskTone: Record<string, 'neutral' | 'warn' | 'danger'> = { read: 'neutral', write: 'warn', exec: 'warn', danger: 'danger' };
  const merged = { ...(existing || {}), ...d } as Agent;
  const renderMod = (x: (typeof sections)[number]) => <x.component agent={merged} onChange={(p) => set(p)} />;
  const groupsOn = groups.filter((g) => g.always || d.tool_groups?.includes(g.id)).length;
  const ownRules = Object.keys(d.tool_policy || {}).length;
  const extraFolders = Array.isArray(d.settings?.folders) ? d.settings.folders.length : 0;
  // Thinking levels of the model the bot really uses (C-11): only the levels it takes. A model without levels, or an AI
  // that is never given one (an ACP program), has no row for it.
  const curModel = effectiveModel(models, d.model || '', engineProv) || (customInfo && customInfo.id === infoFor ? customInfo : undefined);
  const { levels, known: levelsKnown } = levelsFor(curModel);
  const showLevels = rowWorks('reasoning', engineProv) && !(levelsKnown && !levels.length);
  const busyNow = busyShown(engineProv, d.busy_policy);
  const engineSummary = [
    showLevels ? (d.reasoning ? `denkniveau ${(REASONING_LABELS[d.reasoning] || d.reasoning).replace(/ \(.*\)$/, '').toLowerCase()}` : 'denkniveau standaard') : '',
    busyNow === 'interrupt' ? 'nieuw bericht onderbreekt' : busyNow === 'steer' ? 'nieuw bericht stuurt bij' : 'nieuw bericht wacht',
  ].filter(Boolean);
  // "Hoe lang mag een beurt duren" and "Programma": which of their fields work on this AI (agentRows.ts).
  const cli = (d.settings?.cli || {}) as Record<string, any>;
  const setCli = (patch: Record<string, any>) => set({ settings: { ...(d.settings || {}), cli: { ...cli, ...patch } } });
  const num = (v: string) => (v === '' ? undefined : Math.max(1, Math.round(Number(v)) || 1));
  const turn = { steps: rowWorks('steps', engineProv), time: rowWorks('time', engineProv), silence: rowWorks('silence', engineProv) };
  const steps = stepsOf(d.settings, engineProv);
  const turnSummary = [
    turn.steps && steps ? t('max. {0, plural, one {# stap} other {# stappen}}', steps) : '',
    turn.time && Number(cli.timeoutMin) > 0 ? t('max. {0, plural, one {# minuut} other {# minuten}}', Number(cli.timeoutMin)) : '',
    turn.silence && Number(cli.idleMin) > 0 ? t('stopt na {0, plural, one {# minuut} other {# minuten}} stilte', Number(cli.idleMin)) : '',
  ].filter(Boolean);
  const prog = {
    ownApps: rowWorks('ownApps', engineProv),
    ownSettings: rowWorks('ownSettings', engineProv),
    allow: rowWorks('alwaysAllow', engineProv, { access: d.access_mode }),
    deny: rowWorks('alwaysDeny', engineProv),
    extra: rowWorks('extraArgs', engineProv),
  };
  const full = d.access_mode === 'full';
  const progSummary = formatList(
    [prog.ownApps ? translate('je eigen apps') : '', prog.ownSettings ? translate('je eigen instellingen') : '', prog.deny ? translate('vaste regels per stap') : '', prog.extra ? translate('extra argumenten') : ''].filter(Boolean),
  );
  const core: { key: string; title: string; summary?: React.ReactNode; body: React.ReactNode }[] = [
    ...(providerOptions.length
      ? [
          {
            key: 'core:engine',
            title: 'Denken en drukte',
            summary: engineSummary.join(' · '),
            body: (
              <>
                <div className="grid gap-4 sm:grid-cols-2">
                  {showLevels && (
                    <div data-row="denkniveau">
                      <Field label="Denkniveau" hint="Hoger is grondiger, maar trager en duurder.">
                        <Listbox
                          value={d.reasoning || ''}
                          onChange={(v) => set({ reasoning: v })}
                          aria-label="Denkniveau"
                          options={[
                            { value: '', label: curModel?.defaultReasoning ? t('Standaard ({0})', translate(REASONING_LABELS[curModel.defaultReasoning] || curModel.defaultReasoning).replace(/ \(.*\)$/, '').toLocaleLowerCase()) : translate('Standaard') },
                            ...levels.map((l) => ({ value: l, label: translate(REASONING_LABELS[l] || l) })),
                            ...(d.reasoning && !levels.includes(d.reasoning) ? [{ value: d.reasoning, label: t('{0} — kent dit model niet', translate(REASONING_LABELS[d.reasoning] || d.reasoning)) }] : []),
                          ]}
                        />
                      </Field>
                    </div>
                  )}
                  <div className="space-y-1.5" data-row="bezig">
                    <div className="text-[13px] font-semibold">Als de bot bezig is</div>
                    <Segmented
                      label="Als de bot bezig is"
                      value={busyNow}
                      onChange={(v) => set({ busy_policy: v })}
                      options={BUSY_POLICIES.filter((p) => p.id !== 'steer' || rowWorks('steer', engineProv)).map((p) => ({ value: p.id, label: p.label }))}
                    />
                    <p className="text-xs leading-relaxed text-muted">
                      {busyPolicy(busyNow).text} <MoreInfo>Je kiest dit ook in de chat zolang de bot werkt.</MoreInfo>
                    </p>
                  </div>
                </div>
                <div className="space-y-3">
                  <div className="space-y-1.5" data-row="gebruikslimiet">
                    <div className="text-[13px] font-semibold">Bij een gebruikslimiet</div>
                    <Segmented
                      label="Bij een gebruikslimiet"
                      value={(d.settings?.onLimit as string) || 'fallback'}
                      onChange={(v) => set({ settings: { ...(d.settings || {}), onLimit: v } })}
                      options={ON_LIMIT.map((o) => ({ value: o.id, label: o.label }))}
                    />
                    <p className="text-xs leading-relaxed text-muted">{(ON_LIMIT.find((o) => o.id === (d.settings?.onLimit || 'fallback')) || ON_LIMIT[0]).text}</p>
                  </div>
                </div>
              </>
            ),
          },
        ]
      : []),
    // How long one turn may take: the steps (TeamBot's own loop and Claude Code read one value, settings.maxTurns), and
    // for a program the time and the silence after which its run is ended (settings.cli).
    ...(engineProv && (turn.steps || turn.time || turn.silence)
      ? [
          {
            key: 'core:turn',
            title: 'Hoe lang mag een beurt duren',
            summary: turnSummary.length ? turnSummary.join(' · ') : translate('Standaard'),
            body: (
              <div className="grid gap-3 sm:grid-cols-3">
                {turn.steps && (
                  <div data-row="stappen">
                    <Field label="Max. stappen per beurt">
                      <Input type="number" min={1} max={100000} value={steps ?? ''} placeholder={full ? '10000' : '40'} onChange={(e) => set({ settings: withSteps(d.settings, num(e.target.value)) })} />
                    </Field>
                  </div>
                )}
                {turn.time && (
                  <div data-row="duur">
                    <Field label="Max. duur (min)">
                      <Input type="number" min={1} max={43200} value={cli.timeoutMin ?? ''} placeholder="4320" onChange={(e) => setCli({ timeoutMin: num(e.target.value) })} />
                    </Field>
                  </div>
                )}
                {turn.silence && (
                  <div data-row="stilte">
                    <Field label="Stoppen na stilte (min)" hint="Telt niet terwijl de bot op jou wacht">
                      <Input type="number" min={1} max={1440} value={cli.idleMin ?? ''} placeholder="30" onChange={(e) => setCli({ idleMin: num(e.target.value) })} />
                    </Field>
                  </div>
                )}
              </div>
            ),
          },
        ]
      : []),
    // What the program brings of its own (Claude Code, Codex, and the flags another program accepts): only the fields
    // that program reads; no row at all for a program that reads none of them.
    ...(engineProv && (prog.ownApps || prog.ownSettings || prog.allow || prog.deny || prog.extra)
      ? [
          {
            key: 'core:program',
            title: 'Programma',
            summary: progSummary ? t('{0} van {1}', progSummary.charAt(0).toLocaleUpperCase() + progSummary.slice(1), engineProv.name) : undefined,
            body: (
              <div className="space-y-3">
                <div className="divide-y divide-line">
                  {prog.ownApps && (
                    <div data-row="eigen-apps">
                      <SwitchRow
                        setting="agent.useUserMcp"
                        hint={(cli.useUserMcp ?? full) ? 'Tools van die apps volgen de regels van het programma zelf.' : undefined}
                        checked={cli.useUserMcp ?? full}
                        onChange={(v) => setCli({ useUserMcp: v })}
                      />
                    </div>
                  )}
                  {prog.ownSettings && (
                    <div data-row="eigen-instellingen">
                      <SwitchRow
                        setting="agent.loadUserSettings"
                        hint={(cli.loadUserSettings ?? full) ? undefined : null}
                        checked={cli.loadUserSettings ?? full}
                        onChange={(v) => setCli({ loadUserSettings: v })}
                      />
                    </div>
                  )}
                </div>
                {prog.allow && (
                  <div data-row="altijd-toegestaan">
                    <Field label="Altijd toegestane tools" hint="Regels van het programma, bijv. Bash(npm test). Ze slaan de goedkeuring over.">
                      <ListText rows={2} value={cli.allowedTools} onChange={(v) => setCli({ allowedTools: v })} />
                    </Field>
                  </div>
                )}
                {prog.deny && (
                  <div data-row="altijd-geweigerd">
                    <Field label="Altijd geweigerde tools" hint="Bijv. WebFetch, Bash(git push:*)">
                      <ListText rows={2} value={cli.disallowedTools} onChange={(v) => setCli({ disallowedTools: v })} />
                    </Field>
                  </div>
                )}
                {prog.extra && (
                  <div data-row="extra-argumenten">
                    <Field label="Extra argumenten" hint={t('Alleen toegestaan: {0}', (EXTRA_ARGS[engineProv.kind] || []).join(', '))}>
                      <ListText words value={cli.extraArgs} onChange={(v) => setCli({ extraArgs: v })} placeholder={(EXTRA_ARGS[engineProv.kind]?.[0] || '').split(' ')[0]} />
                    </Field>
                  </div>
                )}
              </div>
            ),
          },
        ]
      : []),
    {
      key: 'core:tools',
      title: 'Tools',
      // Whole sentences (one per form), so every language can translate them: "9 van 16 toolgroepen aan · 2 eigen regels per tool".
      summary: [`${groupsOn} van ${groups.length || '…'} toolgroepen aan`, ownRules ? (ownRules === 1 ? '1 eigen regel per tool' : `${ownRules} eigen regels per tool`) : ''].filter(Boolean).join(' · '),
      body: (
        <>
          <div className="-mt-3 divide-y divide-line">
            {groups.map((g) => (
              <div key={g.id} className="flex items-start justify-between gap-3 py-3">
                <div>
                  <div className="text-sm font-medium">{g.label}</div>
                  <div className="text-xs text-muted">{g.description}</div>
                </div>
                {g.always ? (
                  <Badge>altijd aan</Badge>
                ) : (
                  <Toggle
                    checked={!!d.tool_groups?.includes(g.id)}
                    onChange={(v) => set({ tool_groups: v ? [...(d.tool_groups || []), g.id] : (d.tool_groups || []).filter((x) => x !== g.id) })}
                    label={<span className="sr-only">{g.label}</span>}
                  />
                )}
              </div>
            ))}
          </div>
          <details className="text-sm">
            <summary className="cursor-pointer text-muted">Per tool instellen (strenger of losser)</summary>
            <p className="mt-2 text-xs text-muted">Acties met impact vragen altijd om akkoord, ook bij "Toestaan".</p>
            <div className="mt-2 max-h-80 space-y-1 overflow-y-auto">
              {tools
                .filter((t) => (d.tool_groups || []).includes(t.group.split(':')[0]) || groups.find((g) => g.id === t.group)?.always)
                .map((t) => (
                  <div key={t.name} className="flex items-center gap-2 rounded px-1 py-1">
                    <code className="min-w-0 flex-1 truncate text-xs">{t.name}</code>
                    <Badge tone={riskTone[t.risk] || 'neutral'}>{t.risk}</Badge>
                    <Listbox
                      className="h-8 w-40 shrink-0"
                      value={d.tool_policy?.[t.name] || ''}
                      onChange={(v) => {
                        const p = { ...(d.tool_policy || {}) };
                        if (v) p[t.name] = v as any;
                        else delete p[t.name];
                        set({ tool_policy: p });
                      }}
                      aria-label={tText('Beleid voor {0}', t.name)}
                      options={TOOL_POLICIES.map((o) => ({ value: o.value, label: translate(o.label) }))}
                    />
                  </div>
                ))}
            </div>
          </details>
        </>
      ),
    },
    {
      key: 'core:workspace',
      title: 'Werkmap en mappen',
      summary: [d.workspace?.trim() && !isOwnWorkspace(d.workspace) ? d.workspace : translate('Eigen map in de TeamBot-datamap'), extraFolders ? t('{0, plural, one {# extra map} other {# extra mappen}}', extraFolders) : ''].filter(Boolean).join(' · '),
      body: (
        <>
          <Field
            label="Map op deze computer/server"
            hint={
              <>
                Leeg = een eigen map in TeamBot.{' '}
                <MoreInfo>Hier leest en schrijft de bot bestanden. Kies een map zonder gevoelige bestanden.</MoreInfo>
              </>
            }
          >
            <Input value={d.workspace || ''} onChange={(e) => set({ workspace: e.target.value })} placeholder="Automatisch" className="font-mono text-xs" />
          </Field>
          {sections
            .filter((x) => SECTION_ALIAS(x.key) === 'core:workspace')
            .map((x) => (
              <div key={x.key} className="border-t border-line pt-4">
                {renderMod(x)}
              </div>
            ))}
        </>
      ),
    },
    ...(canShare
      ? [
          {
            key: 'core:sharing',
            title: 'Delen met het team',
            summary: d.settings?.shared ? 'Gedeeld met het team' : 'Alleen voor jou',
            body: (
              <div className="space-y-2" data-testid="share-with-team">
                <Toggle checked={!!d.settings?.shared} onChange={(v) => set({ settings: { ...(d.settings || {}), shared: v } })} label="Gedeeld met het team" />
                <p className="text-xs leading-relaxed text-muted">
                  Leden praten ermee in hun eigen gesprekken; die kun jij niet lezen.{' '}
                  <MoreInfo>
                    Leden van deze server zien deze bot onder “Gedeeld”, met jouw naam. Daar werkt de bot in een eigen map per persoon, onthoudt hij wat iemand vertelt alleen voor die persoon en vraagt hij altijd eerst toestemming aan die
                    persoon. Jouw mappen, kluis, kanalen, apps, computer en routines gebruikt hij daar niet. De engine van de bot is die van jou; per lid geldt zijn eigen dagbudget.
                  </MoreInfo>
                </p>
              </div>
            ),
          },
        ]
      : []),
    ...(existing ? [{ key: 'core:history', title: 'Geschiedenis', summary: 'Eerdere versies van deze bot bekijken en terugzetten', body: <AgentHistory bare agent={existing} onRestored={(a) => loadAgent(a)} /> }] : []),
  ];
  const mods = sections
    .filter((x) => SECTION_ALIAS(x.key) === x.key && !(x.key === 'teams:teams' && !multiTeam))
    .map((x) => ({ key: x.key, title: x.title, summary: SECTION_HINT[x.key], body: renderMod(x) }));
  const allSections = [...core, ...mods];
  const sectionsAt = (x: Place) => allSections.filter((y) => placeOf(y.key) === x).sort((a, b) => (PLACES[x] as readonly string[]).indexOf(a.key) - (PLACES[x] as readonly string[]).indexOf(b.key) || 0);
  // "Automatisch": every part a bot can use is on (what follows from where it works is set under Computer & bestanden).
  const autoGroups = groups.filter((g) => !g.always && !COMPUTER_GROUPS.has(g.id.split(':')[0])).map((g) => g.id);
  const hasGroup = (g: string) => !!d.tool_groups?.includes(g) || !!d.tool_groups?.includes(g.split(':')[0]);
  const isAuto = autoGroups.length > 0 && autoGroups.every(hasGroup) && !Object.keys(d.tool_policy || {}).length;
  const chooses = ownTools ?? (groups.length > 0 && !isAuto);
  const setChooses = (v: boolean) => {
    setOwnTools(v);
    if (!v) set({ tool_groups: [...new Set([...(d.tool_groups || []), ...autoGroups])] });
  };
  const row = (key: string, title: string, summary: React.ReactNode, body: React.ReactNode) => (
    <Section key={key} id={key} title={title} summary={summary} open={openSecs.open.includes(key)} onToggle={() => openSecs.toggle(key)} dirty={dirtyKeys.has(key)}>
      {body}
    </Section>
  );
  // (settings.cli belongs to two rows now: the length of a turn and the program; changedRows tells them apart.)
  const dirtyKeys = new Set([
    ...dirtySectionKeys(saved, d).filter((k) => k !== 'cli-agents:cli'),
    ...(rowsChanged.turn ? ['core:turn'] : []),
    ...(rowsChanged.program ? ['core:program'] : []),
    ...[...regs.current.entries()].filter(([, r]) => r.dirty()).map(([k]) => SECTION_ALIAS(k.split(':').slice(0, 2).join(':'))),
  ]);
  const sectionList = (x: Place) =>
    sectionsAt(x).map((y) => (
      <Section key={y.key} id={y.key} title={y.title} summary={y.summary} open={openSecs.open.includes(y.key)} onToggle={() => openSecs.toggle(y.key)} dirty={dirtyKeys.has(y.key)}>
        {y.body}
      </Section>
    ));
  return (
    <EditorSaveContext.Provider value={editorApi}>
    <Page>
      <PageHeader
        width="3xl"
        back={{ href: `#/a/${id}`, label: `Terug naar ${existing?.name || 'de chat'}` }}
        title={
          <span className="flex items-center gap-3">
            <BotAvatar bot={{ id, name: d.name, avatar: d.avatar }} size={40} />
            <span className="min-w-0 truncate">{d.name}</span>
            {d.archived && <Badge>gearchiveerd</Badge>}
          </span>
        }
        actions={
          <>
            <Button icon={<MessageSquare className="h-4 w-4" />} onClick={() => navigate(`/a/${id}`)}>
              Chatten
            </Button>
            <Button variant="primary" loading={save.busy} onClick={submit}>
              Opslaan
            </Button>
          </>
        }
      />
      <div className="mx-auto max-w-3xl space-y-4 px-4 pb-8 pt-3 sm:px-6">
        {/* ---------------- what everyone sees: who the bot is, its AI, what it is told, and one choice */}
        <div className="space-y-4" data-tab="overzicht">
          <Card className="space-y-4 p-5" data-row="wie">
            <div className="flex items-end gap-4">
              <button
                type="button"
                aria-expanded={faceOpen}
                aria-controls="gezicht-kiezen"
                onClick={() => setFaceOpen((x) => !x)}
                className="flex shrink-0 flex-col items-center gap-1 rounded-card p-1 text-xs font-semibold text-muted transition-colors hover:bg-surface-2 hover:text-fg"
              >
                <BotAvatar bot={{ id, name: d.name, avatar: d.avatar }} size={60} />
                <span className="flex items-center gap-0.5">
                  Gezicht <ChevronDown className={cx('h-3 w-3 transition-transform', faceOpen && 'rotate-180')} aria-hidden />
                </span>
              </button>
              <Field label="Naam" className="min-w-0 flex-1 pb-1">
                <Input value={d.name || ''} onChange={(e) => set({ name: e.target.value })} maxLength={80} />
              </Field>
            </div>
            {faceOpen && (
              <div id="gezicht-kiezen" className="rounded-card border border-line p-4">
                <FacePicker seed={id} name={d.name || ''} avatar={d.avatar || ''} onChange={(avatar, color) => set(color ? { avatar, color } : { avatar })} />
              </div>
            )}
            <Field label="Rol">
              <Input value={d.role || ''} onChange={(e) => set({ role: e.target.value })} placeholder="Bijv. Onderzoeker" />
            </Field>
          </Card>

          <Card className="space-y-4 p-5">
            <CardHead icon={Sparkles} tone="violet" title="AI en model" />
            {providerOptions.length === 0 ? (
              <EmptyLine href="#/settings/providers" action="AI koppelen">
                Er is nog geen AI gekoppeld.
              </EmptyLine>
            ) : (
              <div className="grid gap-4 sm:grid-cols-2" data-row="ai">
                <Field label="AI">
                  {/* Another AI: what does not apply there goes out of view and is kept for when the bot goes back
                      (agentRows.ts switchAi); the rows of this page follow the new AI at once. */}
                  <Listbox
                    value={d.provider_id || ''}
                    onChange={(v) => v !== (d.provider_id || '') && set(switchAi(d, engineProv, providers.find((p) => p.id === v)))}
                    placeholder={translate('Kies een AI')}
                    options={providerOptions.map((p) => ({ value: p.id, label: p.name, noTranslate: true }))}
                  />
                </Field>
                <Field label="Model" hint={modelsErr ? `Modellen ophalen mislukt: ${modelsErr}` : undefined}>
                  <ModelChoice models={models} loading={modelsLoading} value={d.model || ''} onChange={(model) => set({ model })} />
                </Field>
              </div>
            )}
            {/* One simple place for the reserve, the same for every kind of AI: when this AI is used up or down, the
                turn goes on with the next one (settings.fallbacks, in order; the chat says when it switched). It may be
                another AI, or the same one on another model. The next empty row appears once the previous one is set,
                up to five. */}
            {providerOptions.length > 0 && (
              <div className="space-y-3" data-testid="reserves" data-row="reserve">
                {Array.from({ length: MAX_RESERVES }, (_, i) => i).map((i) => {
                  const f = fallbacks[i];
                  if (i > fallbacks.length) return null;
                  return (
                    <div key={i} className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
                      <Field label={i === 0 ? 'Als deze AI op is, ga verder op' : 'En daarna op'}>
                        <Listbox
                          value={f?.provider_id || ''}
                          onChange={(v) => {
                            const next = [...fallbacks];
                            // Another AI starts on its own usual model; the same AI keeps the model it had.
                            if (v) next[i] = { provider_id: v, model: v === f?.provider_id ? f.model : '' };
                            else next.splice(i, 1);
                            setFallbacks(next);
                          }}
                          options={[{ value: '', label: translate('Geen') }, ...providerOptions.map((p) => ({ value: p.id, label: p.name, noTranslate: true }))]}
                        />
                      </Field>
                      {f && (
                        <Field label="Met welk model (leeg = het gewone)">
                          <Input value={f.model} onChange={(e) => setFallbacks(fallbacks.map((x, j) => (j === i ? { ...x, model: e.target.value } : x)))} />
                        </Field>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {engineProv && <AgentPrivacyLine agent={d} />}
          </Card>

          <Card className="space-y-3 p-5" data-row="instructies">
            <CardHead icon={ScrollText} tone="amber" title="Instructies" hint="Zeg in gewone woorden wat de bot doet. Concrete regels werken het best." />
            <Textarea
              rows={7}
              aria-label="Instructies"
              value={d.instructions || ''}
              onChange={(e) => set({ instructions: e.target.value })}
              placeholder="Bijvoorbeeld: antwoord kort, en vraag door als iets onduidelijk is."
              className="font-mono text-[13px]"
            />
            {/* What the owner told it in a conversation, in its Werknotities: here too, so all it must do is in one spot. */}
            {existing && <AgentOrders agentId={existing.id} />}
            <div className="space-y-1.5">
              <Button size="sm" icon={<Sparkles className="h-4 w-4" />} loading={gen.busy} disabled={!genFrom || !genEngine} onClick={() => generate()} title={genFrom ? undefined : 'Vul eerst een rol in'}>
                Laat AI de instructies schrijven
              </Button>
              {genErr && !gen.busy && (
                <p className="text-sm text-danger" role="alert">
                  {genErr}
                </p>
              )}
              {localAlt && !gen.busy && (
                <div className="space-y-1.5" data-testid="generate-local">
                  <Button size="sm" variant="primary" onClick={() => generate(localAlt)}>
                    Probeer met {localAlt.name}
                  </Button>
                  <p className="text-[11px] text-muted">Gratis op deze computer. De bot houdt het model dat je koos.</p>
                </div>
              )}
            </div>
          </Card>

          <Card className="space-y-3 p-5" data-row="wat-mag">
            <CardHead icon={ShieldCheck} tone="rose" title="Wat mag de bot?" />
            <AccessChoice
              value={d.access_mode || 'ask'}
              engine={providers.find((p) => p.id === d.provider_id)}
              guards={levelGuards}
              onChange={async (v) => (v !== 'full' || d.access_mode === 'full' || (await askConfirm(fullWarning(readAccess), { danger: true }))) && set({ access_mode: v, settings: withoutKeptAccess(d.settings) })}
            />
            {/* What this AI can read outside the bot's folders: a warning stays in view, here with the choice (not
                twice: where the line about the hard blocks already says the AI reads everything, that line is it). */}
            {readAccess && !readAccess.confined && !guardLine(levelGuards, accessOn(engineProv, d.access_mode)) && (
              <p className="flex items-start gap-1.5 text-xs text-warn" data-testid="read-access">
                <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden />
                <span>{readAccess.text}</span>
              </p>
            )}
          </Card>

          {existing && (
            <Card className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3 p-5" data-row="beheer">
              {/* The actions themselves: a button that only led to the chat menu was a detour (owner, 0.4.4). */}
              <CardHead className="min-w-0 flex-1 basis-40" icon={Settings2} title="Beheer" />
              <div className="flex flex-wrap gap-2">
                <Button icon={<Copy className="h-4 w-4" />} onClick={duplicateBot}>
                  Dupliceren
                </Button>
                <Button icon={<Archive className="h-4 w-4" />} onClick={archiveBot}>
                  {existing.archived ? 'Uit archief halen' : 'Archiveren'}
                </Button>
                <Button icon={<Trash2 className="h-4 w-4" />} className="!text-danger" onClick={() => setDelBot(true)}>
                  Verwijderen…
                </Button>
              </div>
              <BotDeleteDialog agent={existing} open={delBot} onClose={() => setDelBot(false)} onDeleted={() => navigate('/', { from: page })} />
            </Card>
          )}
        </div>

        {/* ---------------- everything optional: ONE fold, and in it every part is one row with one line. */}
        <div data-tab="meer" data-testid="bot-advanced">
          <MoreOptions label="Meer mogelijkheden" defaultOpen={advOpen}>
            <p className="text-xs leading-relaxed text-muted">Dit hoef je niet in te stellen: de bot werkt goed zoals hij is. Je kunt het hem ook gewoon in de chat vragen.</p>

            {row(
              'core:about',
              'Beschrijving, taal en stijl',
              'Een korte beschrijving, de taal van de antwoorden en de antwoordstijl',
              <div className="divide-y divide-line">
                <SettingRow setting="agent.description" stack>
                  <Input value={d.description || ''} onChange={(e) => set({ description: e.target.value })} aria-label={settingText('agent.description').title} />
                </SettingRow>
                <SettingRow setting="agent.language" info="Standaard antwoordt de bot in jouw taal. Kies een vaste taal als dat anders moet.">
                  <BotLanguageSelect
                    value={d.settings?.language}
                    inherit={settings.botLanguage || 'auto'}
                    onChange={(v) => set({ settings: { ...(d.settings || {}), language: v || undefined } })}
                    className="min-w-[12rem] sm:w-auto"
                    aria-label={settingText('agent.language').title}
                  />
                </SettingRow>
                {/* settings.answerStyle; unset = natural, the way bots always answered. Reaches every engine. */}
                <SettingRow setting="agent.answerStyle">
                  <Segmented
                    label={settingText('agent.answerStyle').title}
                    value={d.settings?.answerStyle === 'business' ? 'business' : 'natural'}
                    onChange={(v) => set({ settings: { ...(d.settings || {}), answerStyle: v === 'natural' ? undefined : v } })}
                    options={settingOptions<'natural' | 'business'>('agent.answerStyle')}
                  />
                </SettingRow>
              </div>,
            )}

            {row(
              'core:rights',
              'Eigen regels en rechten, precies',
              'Regels voor alleen deze bot, en wat hij zonder vragen naar anderen mag sturen',
              <>
                {d.access_mode === 'full' && (
                  <SwitchRow
                    checked={!!d.settings?.fullAccessExternal}
                    onChange={(v) => set({ settings: { ...(d.settings || {}), fullAccessExternal: v } })}
                    setting="agent.fullAccessExternal"
                  />
                )}
                {d.access_mode === 'auto' && (
                  <SwitchRow
                    checked={!!d.settings?.autoReview}
                    onChange={(v) => set({ settings: { ...(d.settings || {}), autoReview: v } })}
                    setting="agent.autoReview"
                    info="Een tweede controle kijkt mee bij elke wijzigende actie en vraagt jou bij twijfel om akkoord. Kost extra tokens."
                  />
                )}
                {readAccess?.confined && (
                  <div className="text-xs text-muted" data-testid="read-access">
                    <MoreInfo label="Wat deze AI mag lezen">{readAccess.text}</MoreInfo>
                  </div>
                )}
                {existing && <OwnRules agentId={existing.id} mode={d.access_mode} />}
              </>,
            )}

            <div data-testid="bot-can">
              {row(
                'core:can',
                'Onderdelen en skills',
                chooses ? 'Jij bepaalt welke onderdelen en skills de bot heeft' : 'Automatisch: de bot krijgt wat hij voor zijn werk nodig heeft',
                <>
                  <SwitchRow
                    setting="agent.ownTools"
                    hint={chooses ? undefined : 'Automatisch: de bot krijgt wat hij voor zijn werk nodig heeft.'}
                    checked={chooses}
                    onChange={setChooses}
                  />
                  {chooses && sectionList('kan')}
                  {/* The line under the folder follows the access level chosen on this page (also before Opslaan). */}
                  {existing && <WerkplekLine agent={{ ...existing, access_mode: d.access_mode || existing.access_mode, settings: d.settings || existing.settings }} />}
                </>,
              )}
            </div>

            {/* What is known about the model (context, price), and its context window where TeamBot can set it; no row
                when there is neither. */}
            {engineProv &&
              (hasModelFacts(curModel, engineProv) || rowWorks('contextWindow', engineProv)) &&
              row(
                'core:model',
                'Over het model',
                'Wat het model kan, hoeveel tekst het aankan en wat het kost',
                <>
                  <ModelFacts m={curModel} provider={engineProv} loading={modelsLoading} />
                  {!modelsLoading && rowWorks('contextWindow', engineProv) && (
                    <div data-row="contextvenster">
                      <ContextWindowField provider={engineProv} m={curModel} />
                    </div>
                  )}
                </>,
              )}

            {sectionList('adv')}
          </MoreOptions>
        </div>
      </div>

      {unsaved.length > 0 && (
        <div className="sticky bottom-0 z-20 px-4 pb-3 sm:px-6" role="status">
          <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-x-3 gap-y-2 rounded-card border border-line-strong bg-surface px-4 py-2.5 shadow-2xl">
            <CircleAlert className="h-4 w-4 shrink-0 text-warn" aria-hidden />
            <span className="min-w-0 flex-1 text-sm">
              <span className="font-semibold">Niet opgeslagen:</span> {formatList(unsaved.map((l) => translate(l)))}
            </span>
            <Button variant="primary" size="sm" loading={save.busy} onClick={submit}>
              Opslaan
            </Button>
          </div>
        </div>
      )}

      <Modal
        open={!!leave}
        onClose={() => setLeave(null)}
        title="Wijzigingen opslaan?"
        footer={
          <>
            <Button variant="ghost" onClick={() => setLeave(null)}>
              Annuleren
            </Button>
            <Button
              onClick={() => {
                const to = leave!;
                setLeave(null);
                go(to);
              }}
            >
              Niet opslaan
            </Button>
            <Button
              variant="primary"
              loading={save.busy}
              onClick={async () => {
                const to = leave!;
                if (!(await submit())) return;
                setLeave(null);
                go(to);
              }}
            >
              Opslaan en doorgaan
            </Button>
          </>
        }
      >
        <p className="text-sm">
          {unsaved.length
            ? t('Je hebt {0} gewijzigd maar nog niet opgeslagen. Zonder opslaan gaan die wijzigingen verloren.', formatList(unsaved.map((l) => translate(l))))
            : 'Je hebt deze bot gewijzigd maar nog niet opgeslagen. Zonder opslaan gaan die wijzigingen verloren.'}
        </p>
      </Modal>
    </Page>
    </EditorSaveContext.Provider>
  );
}

/** A calm line for something that is missing, with the one thing to do about it. */
function EmptyLine({ href, action, children }: { href: string; action: string; children: React.ReactNode }) {
  return (
    <p className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-muted">
      <span className="min-w-0 flex-1 basis-40">{children}</span>
      <a href={href} className="inline-flex h-8 items-center rounded-control border border-line bg-surface-2 px-3 text-[13px] font-semibold text-fg transition-colors hover:border-line-strong coarse:h-11">
        {action}
      </a>
    </p>
  );
}

/**
 * "Wat mag de bot?": the ONE choice for what the bot may do: five levels in one dropdown, with one line for the chosen one (or why a level cannot be
 * used with this engine). Not offered when the engine cannot enforce it (lib/access.ts).
 */
function AccessChoice({ value, engine, guards, onChange }: { value: Agent['access_mode']; engine: ProviderView | undefined; guards?: Partial<Record<string, LevelGuard>> | null; onChange(v: Agent['access_mode']): void }) {
  // Only the levels this AI can be held to are in the list (agentRows.ts): a level that cannot work is not offered.
  const levels = accessLevels(engine);
  const shown = accessOn(engine, value);
  const cur = ACCESS.find((a) => a.id === shown) || ACCESS[2];
  // Where TeamBot cannot guard the hard blocks at this level on this AI: one plain line, only there.
  const unguarded = guardLine(guards, shown);
  return (
    <div className="space-y-1.5" data-testid="access-choice">
      <Dropdown label="Wat mag de bot?" value={shown} onChange={onChange} options={ACCESS.filter((a) => levels.includes(a.id)).map((a) => ({ value: a.id, label: a.label }))} />
      <p className="text-xs leading-relaxed text-muted">{accessLine(engine, shown) || cur.text}</p>
      {unguarded && (
        <p className="text-xs leading-relaxed text-muted" data-testid="level-guard">
          {unguarded}
        </p>
      )}
    </div>
  );
}

/**
 * A list typed as text: rules separated by commas or lines, or (`words`) flags separated by spaces. Stored as a list on
 * every change; a list that changes from outside (another AI chosen) is shown again.
 */
function ListText({ value, onChange, words, rows, placeholder }: { value: unknown; onChange(v: string[] | undefined): void; words?: boolean; rows?: number; placeholder?: string }) {
  const sep = words ? ' ' : ', ';
  const parse = (s: string) =>
    s
      .split(words ? /\s+/ : /[,\n]/)
      .map((x) => x.trim())
      .filter(Boolean);
  const joined = (Array.isArray(value) ? value.filter((x): x is string => typeof x === 'string') : []).join(sep);
  const [text, setText] = useState(joined);
  useEffect(() => {
    if (parse(text).join(sep) !== joined) setText(joined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [joined]);
  const change = (s: string) => {
    setText(s);
    const list = parse(s);
    onChange(list.length ? list : undefined);
  };
  return words ? <Input value={text} onChange={(e) => change(e.target.value)} placeholder={placeholder} /> : <Textarea rows={rows} value={text} onChange={(e) => change(e.target.value)} />;
}
