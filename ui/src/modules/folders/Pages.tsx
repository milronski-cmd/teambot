import { useEffect, useState } from 'react';
import { FolderOpen, FolderPlus, Settings, Trash2, Users } from 'lucide-react';
import { Badge, Button, Card, CardHead, EmptyState, Field, Input, Page, PageHeader, Spinner, Toggle, cx, toast, useAsync } from '../../components/ui';
import { SelectBox as Select } from '../../components/Listbox';
import { BotAvatar } from '../../components/BotFace';
import { FolderName } from '../../components/FolderName';
import { MoreInfo } from '../../components/MoreInfo';
import { Menu } from '../../components/overview';
import { Dropdown } from '../../components/SettingControls';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import type { Agent } from '../../lib/types';
import { type ExtraFolder, type FolderRoot, type TeamState, foldersApi } from './api';
import { ModeBadge, RootsBrowser } from './FolderBrowser';
import { OcrCard } from './OcrCard';
import { folderMissing } from './missing';
import { useEditorSection } from '../../lib/editorSave';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';

/** The ?query of the hash, live (a search link to another file in the same folder page re-opens the browser there). */
function useHashQuery() {
  const [q, setQ] = useState(() => location.hash.split('?')[1] || '');
  useEffect(() => {
    const f = () => setQ(location.hash.split('?')[1] || '');
    window.addEventListener('hashchange', f);
    return () => window.removeEventListener('hashchange', f);
  }, []);
  return q;
}

/** #/m/folders[/<agentId>][?root=&path=&open=] — the team folder and every bot's folders, browsable (read-only view). */
export function FoldersPage({ params }: { params: string[] }) {
  const hashQuery = useHashQuery();
  const agents = useApp((s) => s.agents).filter((a) => !a.archived);
  const [team, setTeam] = useState<TeamState | null>(null);
  // From the second team on: the folder of every team (the default team keeps the old link #/m/folders/team).
  const [teamFolders, setTeamFolders] = useState<{ key: string; label: string }[]>([]);
  useEffect(() => {
    foldersApi.team().then(setTeam).catch(() => setTeam(null));
    api
      .get<{ id: string; name: string; isDefault: boolean; folder: { label: string } | null }[]>('/teams')
      .then((ts) => setTeamFolders(ts.length > 1 ? ts.filter((x) => x.folder).map((x) => ({ key: x.isDefault ? 'team' : `team:${x.id}`, label: `${x.folder!.label} · ${x.name}` })) : []))
      .catch(() => setTeamFolders([]));
  }, []);
  const sel = params[0] || (team?.folder ? 'team' : teamFolders[0]?.key || agents[0]?.id || '');
  const pick = (id: string) => navigate(`/m/folders/${id}`);
  const shared = teamFolders.length ? teamFolders : team?.folder ? [{ key: 'team', label: team.folder.label }] : [];
  // A pill per folder while they fit on one line; with a bigger team one dropdown (a row of fifteen bots is a wall).
  const pills = shared.length + agents.length <= 5;
  return (
    <Page>
      <PageHeader
        title="Bestanden"
        subtitle="De mappen van je team en je bots."
        actions={
          <Menu
            label="Meer opties"
            items={[
              { label: 'Prullenbak', icon: <Trash2 />, href: '#/m/folders/prullenbak' },
              { label: 'Teammap instellen', icon: <Settings />, href: '#/settings/folders-teammap' },
            ]}
          />
        }
      />
      <div className="mx-auto max-w-4xl space-y-4 px-4 pb-8 pt-3 sm:px-6">
        {pills ? (
          shared.length + agents.length > 1 && (
            <div className="flex flex-wrap gap-1.5" role="group" aria-label="Map kiezen">
              {shared.map((f) => (
                <Button key={f.key} size="sm" className="rounded-full" variant={sel === f.key ? 'soft' : 'ghost'} aria-pressed={sel === f.key} icon={<Users className="h-3.5 w-3.5" />} onClick={() => pick(f.key)}>
                  {f.label}
                </Button>
              ))}
              {agents.map((a) => (
                <Button key={a.id} size="sm" className="rounded-full" variant={sel === a.id ? 'soft' : 'ghost'} aria-pressed={sel === a.id} onClick={() => pick(a.id)}>
                  <BotAvatar bot={a} size={20} />
                  {a.name}
                </Button>
              ))}
            </div>
          )
        ) : (
          <Dropdown
            label="Map kiezen"
            className="w-full sm:w-72"
            value={sel}
            onChange={pick}
            options={[...shared.map((f) => ({ value: f.key, label: f.label })), ...agents.map((a) => ({ value: a.id, label: a.name }))]}
          />
        )}
        {!sel ? (
          <EmptyState icon={<FolderOpen />} title="Nog geen mappen" action={<Button onClick={() => navigate('/settings/folders-teammap')}>Teammap instellen</Button>}>
            Stel een map in die je bots samen gebruiken.
          </EmptyState>
        ) : (
          <RootsBrowser key={`${sel}?${hashQuery}`} agentId={sel === 'team' ? null : sel} />
        )}
        <OcrCard />
      </div>
    </Page>
  );
}

/**
 * Settings → Teammap: the shared folder of a team for all (or selected) bots of that team. `teamId` fixes the team
 * (team settings); without it the default team, with a team picker from the second team on.
 */
export function TeamFolderSettings({ teamId, bare }: { teamId?: string; /** inside a fold that already carries the title */ bare?: boolean } = {}) {
  const [picked_, setPickedTeam] = useState<string | null>(teamId || null);
  const forTeam = teamId || picked_;
  const [st, setSt] = useState<TeamState | null>(null);
  const [path, setPath] = useState('');
  const [label, setLabel] = useState('Gedeelde teammap');
  const [mode, setMode] = useState<'rw' | 'ro'>('rw');
  const [all, setAll] = useState(true);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  // A folder that does not exist yet is created on save, unless the owner switches that off.
  const [create, setCreate] = useState(true);
  const [check, setCheck] = useState<{ path: string; missing: boolean; error?: string; warning?: string } | null>(null);
  // After saving or unlinking the same path is checked again (it exists now, or its warning may have changed).
  const [recheck, setRecheck] = useState(0);
  const save = useAsync();
  useEffect(() => {
    const p = path.trim();
    if (!p) return setCheck(null);
    let alive = true;
    const t = setTimeout(() => {
      foldersApi
        .check(p)
        .then((r) => alive && setCheck({ path: p, missing: !!r.missing, error: r.ok || r.missing ? undefined : r.error, warning: r.warning }))
        .catch(() => alive && setCheck(null));
    }, 300);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [path, recheck]);
  const missing = folderMissing(check, path, st?.folder?.path);
  const load = () =>
    foldersApi.team(forTeam).then((s) => {
      setSt(s);
      setPath(s.folder?.path || s.suggestion);
      setLabel(s.folder?.label || 'Gedeelde teammap');
      setMode(s.folder?.mode || 'rw');
      setAll(!s.folder || s.folder.agents === 'all');
      setPicked(new Set(s.agents.filter((a) => a.member).map((a) => a.id)));
    });
  useEffect(() => {
    load().catch(() => setSt(null));
  }, [forTeam]);
  if (!st) return <Spinner />;
  if (st.restricted) return <p className="text-sm text-muted">Elke bot werkt in zijn eigen werkmap; een gedeelde map stelt de beheerder in.</p>;
  const teams = st.teams || [];
  const multi = teams.length > 1;
  const curTeam = st.teamId || null;
  const viewHref = !curTeam || curTeam === teams[0]?.id ? '/m/folders/team' : `/m/folders/team:${curTeam}`;
  return (
    <Card className="space-y-4 p-5">
      <div>
        {!bare && (
          <CardHead className="mb-1" icon={Users} tone="amber" title={multi ? 'Teammap' : 'Gedeelde teammap'} />
        )}
        <p className="text-sm text-muted">
          {multi ? 'Een map die de bots van dit team samen gebruiken.' : 'Eén map die je bots samen gebruiken.'}{' '}
          <MoreInfo>
            {multi
              ? 'Voor dossiers, kennis en afspraken. Bots van andere teams komen er niet in, tenzij ze mogen meekijken of aansturen; dan lezen ze alleen.'
              : 'Voor dossiers, kennis en afspraken (bijvoorbeeld een LEESMIJ). Bestandstools en CLI-engines (Claude Code, Codex, OpenCode) krijgen er toegang toe binnen het toegangsniveau van de bot.'}
          </MoreInfo>
        </p>
      </div>
      {multi && !teamId && (
        <Field label="Team">
          <Select value={curTeam || ''} onChange={(e) => setPickedTeam(e.target.value || null)}>
            {teams.map((x) => (
              <option key={x.id} value={x.id}>
                {x.name}
              </option>
            ))}
          </Select>
        </Field>
      )}
      <Field label="Map" hint={<MoreInfo label="Welke map kan?">Een volledig pad op deze computer. Je hele schijf, je gebruikersmap en mappen met sleutels kunnen niet.</MoreInfo>}>
        <Input value={path} onChange={(e) => setPath(e.target.value)} className="font-mono text-xs" placeholder={st.suggestion} translate="no" />
      </Field>
      {check?.error && check.path === path.trim() && <p className="-mt-2 text-xs text-danger">{check.error}</p>}
      {check?.warning && check.path === path.trim() && <p className="-mt-2 rounded-lg bg-warn-soft px-2.5 py-1.5 text-xs text-warn">{check.warning}</p>}
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Naam voor de bots">
          <Input value={label} onChange={(e) => setLabel(e.target.value)} />
        </Field>
        <Field label="Rechten">
          <Select value={mode} onChange={(e) => setMode(e.target.value as 'rw' | 'ro')}>
            <option value="rw">Lezen en schrijven</option>
            <option value="ro">Alleen lezen</option>
          </Select>
        </Field>
      </div>
      <div className="space-y-2">
        <Toggle checked={all} onChange={setAll} label={multi ? 'Alle bots van dit team (ook nieuwe)' : 'Alle bots (ook nieuwe)'} />
        {!all && (
          <div className="flex flex-wrap gap-2">
            {st.agents.map((a) => (
              <label key={a.id} className={cx('flex cursor-pointer items-center gap-2 rounded-lg border px-2.5 py-1.5 text-sm', picked.has(a.id) ? 'border-accent bg-accent-soft' : 'border-line')}>
                <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={picked.has(a.id)} onChange={(e) => setPicked((s) => (e.target.checked ? new Set([...s, a.id]) : new Set([...s].filter((x) => x !== a.id))))} />
                <BotAvatar bot={a} size={20} />
                {a.name}
              </label>
            ))}
          </div>
        )}
      </div>
      {missing && (
        <div className="space-y-1">
          <Toggle checked={create} onChange={setCreate} label="Map aanmaken als hij nog niet bestaat" />
          <p className="text-xs text-muted">{create ? 'Deze map bestaat nog niet; TeamBot maakt hem aan als je opslaat.' : 'Deze map bestaat nog niet. Zet “Map aanmaken” aan of kies een bestaande map.'}</p>
        </div>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          variant="primary"
          loading={save.busy}
          disabled={!path.trim()}
          onClick={() => save.run(async () => (await foldersApi.setTeam({ path: path.trim(), label, mode, agents: all ? 'all' : [...picked], create, teamId: curTeam }), await load(), setRecheck((n) => n + 1)), 'Teammap opgeslagen')}
        >
          Opslaan
        </Button>
        {st.folder && (
          <>
            <Button icon={<FolderOpen className="h-4 w-4" />} onClick={() => navigate(viewHref)}>
              Bekijken
            </Button>
            <Button variant="ghost" icon={<Trash2 className="h-4 w-4" />} onClick={() => save.run(async () => (await foldersApi.removeTeam(curTeam), await load()), 'Teammap losgekoppeld (de map zelf blijft staan)')}>
              Loskoppelen
            </Button>
          </>
        )}
      </div>
    </Card>
  );
}

/** Bot editor → Mappen: extra folders (read-only or read-write) plus the team folder, all visible. */
export function AgentFoldersSection({ agent, onChange }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  const folders: ExtraFolder[] = Array.isArray(agent.settings?.folders) ? agent.settings.folders : [];
  const legacy: string[] = Array.isArray(agent.settings?.extraRoots) ? agent.settings.extraRoots : [];
  const [team, setTeam] = useState<TeamState | null>(null);
  const [path, setPath] = useState('');
  const [mode, setMode] = useState<'rw' | 'ro'>('ro');
  const check = useAsync();
  // From the second team on: the team folders this bot really gets (its own team's, and read-only ones it may look into).
  const [teamRoots, setTeamRoots] = useState<FolderRoot[] | null>(null);
  useEffect(() => {
    foldersApi.team().then(setTeam).catch(() => setTeam(null));
  }, []);
  const multiTeam = (team?.teams?.length || 0) > 1;
  useEffect(() => {
    if (!multiTeam || !agent.id) return setTeamRoots(null);
    const own = new Set([...folders.map((f) => f.path.toLowerCase()), ...legacy.map((p) => p.toLowerCase())]);
    foldersApi
      .roots(agent.id)
      .then((r) => setTeamRoots(r.roots.filter((x) => x.kind !== 'workspace' && !own.has(x.path.toLowerCase()))))
      .catch(() => setTeamRoots(null));
  }, [multiTeam, agent.id]);
  const set = (next: ExtraFolder[]) => onChange({ settings: { ...(agent.settings || {}), folders: next } });
  const add = () =>
    check.run(async () => {
      const r = await foldersApi.check(path.trim());
      if (!r.ok) throw new Error(r.error || 'Deze map kan niet');
      if (folders.some((f) => f.path.toLowerCase() === r.path!.toLowerCase())) throw new Error('Deze map staat er al bij');
      set([...folders, { path: r.path!, mode, label: r.label }]);
      setPath('');
      toast('Map toegevoegd; vergeet niet op te slaan', 'ok');
    });
  // A typed folder that was not added yet is added by the editor's main "Opslaan" (instead of being dropped silently).
  useEditorSection('folders:typed', {
    label: 'Mappen',
    dirty: () => !!path.trim(),
    prepare: async () => {
      const r = await foldersApi.check(path.trim());
      if (!r.ok) throw new Error(`Map “${path.trim()}”: ${r.error || 'deze map kan niet'}`);
      const next = folders.some((f) => f.path.toLowerCase() === r.path!.toLowerCase()) ? folders : [...folders, { path: r.path!, mode, label: r.label }];
      setPath('');
      return { settings: { folders: next } };
    },
  });
  const inTeam = !!team?.folder && !!agent.id && (team.folder.agents === 'all' || team.folder.agents.includes(agent.id));
  if (team?.restricted) return <p className="text-sm text-muted">Op deze server werkt de bot alleen in zijn eigen werkmap.</p>;
  return (
    <div className="space-y-4">
      <ul className="space-y-2 text-sm">
        <li className="flex flex-wrap items-center gap-2">
          <FolderOpen className="h-4 w-4 text-accent" />
          <span className="font-medium">Werkmap</span>
          <ModeBadge mode="rw" />
          <FolderName className="text-xs text-muted" path={agent.workspace} bot={agent.name} />
        </li>
        {teamRoots?.map((r) => (
          <li key={r.path} className="flex flex-wrap items-center gap-2">
            <Users className="h-4 w-4 text-accent" />
            <span className="font-medium">{r.label}</span>
            <ModeBadge mode={r.mode} />
            <code className="min-w-0 break-all text-xs text-muted">{r.path}</code>
            <a href="#/settings/teams-teams" className="text-xs text-accent underline">
              wijzigen
            </a>
          </li>
        ))}
        {!teamRoots && team?.folder && (
          <li className="flex flex-wrap items-center gap-2">
            <Users className="h-4 w-4 text-accent" />
            <span className="font-medium">{team.folder.label}</span>
            {inTeam ? <ModeBadge mode={team.folder.mode} /> : <Badge>niet voor deze bot</Badge>}
            <code className="min-w-0 break-all text-xs text-muted">{team.folder.path}</code>
            <a href="#/settings/folders-teammap" className="text-xs text-accent underline">
              wijzigen
            </a>
          </li>
        )}
        {legacy.map((p) => (
          <li key={p} className="flex flex-wrap items-center gap-2">
            <FolderOpen className="h-4 w-4 text-muted" />
            <code className="min-w-0 break-all text-xs">{p}</code>
            <ModeBadge mode="rw" />
          </li>
        ))}
        {folders.map((f, i) => (
          <li key={f.path} className="flex flex-wrap items-center gap-2">
            <FolderOpen className="h-4 w-4 text-muted" />
            <span className="font-medium">{f.label || f.path}</span>
            <code className="min-w-0 flex-1 break-all text-xs text-muted">{f.path}</code>
            <Select className="w-auto" value={f.mode} onChange={(e) => set(folders.map((x, j) => (j === i ? { ...x, mode: e.target.value as 'rw' | 'ro' } : x)))} aria-label={t('Rechten voor {0}', f.label || f.path)}>
              <option value="ro">Alleen lezen</option>
              <option value="rw">Lezen en schrijven</option>
            </Select>
            <Button size="icon" variant="ghost" aria-label={t('{0} verwijderen', f.label || f.path)} onClick={() => set(folders.filter((_, j) => j !== i))}>
              <Trash2 className="h-4 w-4" />
            </Button>
          </li>
        ))}
      </ul>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="C:\Users\…\Documenten\Kennis" className="font-mono text-xs sm:flex-1" aria-label="Map toevoegen" translate="no" />
        <Select className="sm:w-44" value={mode} onChange={(e) => setMode(e.target.value as 'rw' | 'ro')} aria-label="Rechten voor de nieuwe map">
          <option value="ro">Alleen lezen</option>
          <option value="rw">Lezen en schrijven</option>
        </Select>
        <Button icon={<FolderPlus className="h-4 w-4" />} loading={check.busy} disabled={!path.trim()} onClick={add}>
          Map toevoegen
        </Button>
      </div>
      <p className="text-xs text-muted">
        Bestandstools en CLI-engines (Claude Code, Codex, OpenCode) mogen in deze mappen werken, binnen het toegangsniveau van de bot. In een map met “alleen lezen” wordt schrijven geweigerd. Mappen met sleutels blijven altijd dicht.
        {agent.id && (
          <>
            {' '}
            <a className="text-accent underline" href={`#/m/folders/${agent.id}`}>
              Bestanden bekijken
            </a>
          </>
        )}
      </p>
    </div>
  );
}
