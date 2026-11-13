import React, { useEffect, useState } from 'react';
import { Building2, CalendarClock, CheckSquare, Copy, Download, ExternalLink, History, FileText, FolderOpen, Gavel, Link as LinkIcon, Milestone, Plus, Square, Trash2, Upload, UserRound, FolderPlus, BarChart3, Users } from 'lucide-react';
import { api, authUrl, upload } from '../../lib/api';
import { t } from '../../lib/i18n';
import { navigate } from '../../lib/router';
import { useApp } from '../../lib/store';
import { Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Tabs, Textarea, Toggle, cx, timeAgo, toast, useAsync, CardHead } from '../../components/ui';
import { ChangeRow, ErrorBox, ForgetDialog, ItemList, Loading, TeamBadge } from './parts';
import { Words } from '../../components/Words';
import { Menu } from '../../components/overview';
import { MemoryShell } from './pages';
import { DocumentToSkillModal } from '../skills/FromDocument';
import { ALL_TEAMS, type Change, type Dossier, type DossierRecord, DOSSIER_KIND_LABEL, defaultTeamFor, fmtDate, fromDateInput, memPath, RECORD_LABEL, teamQuery, toDateInput, useMem, useMemTeams, useTeamFilter } from './lib';

export function DossiersPage({ params }: { params: string[] }) {
  return (
    <MemoryShell tab="dossiers" noTeamFilter={!!params[0]}>
      {params[0] ? <DossierDetail id={params[0]} /> : <DossierList />}
    </MemoryShell>
  );
}

/**
 * Proposed dossiers: a client, project or subject that came back in more conversations without a dossier. One click
 * makes it (for the team of the bot that saw it, for every bot of that team); notes bots wrote meanwhile go in.
 */
function DossierProposals({ onMade }: { onMade(): void }) {
  const r = useMem<any[]>('/memory/dossier-proposals');
  const { run, busy } = useAsync();
  if (!r.data?.length) return null;
  return (
    <Card className="space-y-2 p-3">
      <CardHead icon={FolderPlus} tone="amber" title={t('{0, plural, one {Voorgesteld dossier} other {Voorgestelde dossiers}}', r.data.length)} />
      <ul className="space-y-2">
        {r.data.map((p: any) => (
          <li key={p.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-line p-2 text-sm">
            <FolderOpen className="h-4 w-4 shrink-0 text-muted" aria-hidden />
            <span className="min-w-[12rem] flex-1">
              <span className="font-medium" translate="no">{p.name}</span>
              <span className="block text-xs text-muted">
                {[
                  t('{0, plural, one {kwam in # gesprek voor} other {kwam in # gesprekken voor}}', p.threads),
                  p.agent ? t('voorgesteld door {0}', p.agent.name) : '',
                  p.pending ? t('{0, plural, one {# notitie wacht} other {# notities wachten}}', p.pending) : '',
                  p.team ? t('team {0}', p.team.name) : '',
                ]
                  .filter(Boolean)
                  .join(' · ')}
              </span>
            </span>
            <Button size="sm" variant="ghost" loading={busy} onClick={() => run(async () => (await api.post(`/memory/dossier-proposals/${p.id}/dismiss`, {}), r.reload()), 'Wordt niet meer voorgesteld')}>
              Niet nodig
            </Button>
            <Button size="sm" variant="primary" icon={<Plus className="h-3.5 w-3.5" />} loading={busy} onClick={() => run(async () => (await api.post(`/memory/dossier-proposals/${p.id}/accept`, {}), r.reload(), onMade()), t('Dossier “{0}” aangemaakt', p.name))}>
              Aanmaken
            </Button>
          </li>
        ))}
      </ul>
    </Card>
  );
}

const STATUS_VIEWS: [string, string][] = [
  ['active', 'Actief'],
  ['closed', 'Afgesloten'],
  ['archived', 'Gearchiveerd'],
  ['trashed', 'Prullenbak'],
];

function DossierList() {
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('active');
  const [creating, setCreating] = useState(false);
  const [importing, setImporting] = useState(false);
  const [copying, setCopying] = useState(false);
  const [team] = useTeamFilter();
  const teams = useMemTeams();
  const r = useMem<Dossier[]>(`/memory/dossiers?status=${status}${q.trim() ? `&q=${encodeURIComponent(q.trim())}` : ''}${teamQuery(team)}`, [q, status, team]);
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input className="min-w-[180px] flex-1" placeholder="Zoek in dossiers" value={q} onChange={(e) => setQ(e.target.value)} aria-label="Zoek dossiers" />
        {/* Which dossiers you see, and the two ways to bring dossiers in: rarely needed, so behind one button. */}
        <Menu
          label="Meer acties bij dossiers"
          variant="secondary"
          items={[
            { heading: 'Tonen' },
            ...STATUS_VIEWS.map(([id, label]) => ({ label, checked: status === id, onSelect: () => setStatus(id) })),
            'sep',
            { label: 'Importeren uit Markdown', icon: <Upload />, onSelect: () => setImporting(true) },
            teams.multi && { label: 'Vakkennis kopiëren', icon: <Copy />, onSelect: () => setCopying(true) },
          ]}
        />
        <Button variant="primary" icon={<Plus className="h-4 w-4" />} onClick={() => setCreating(true)}>
          Nieuw dossier
        </Button>
      </div>
      {status !== 'active' && <p className="text-[13px] text-muted">{t('Je ziet: {0}', STATUS_VIEWS.find(([id]) => id === status)?.[1] || status)}</p>}
      {status === 'active' && <DossierProposals onMade={r.reload} />}
      {r.error ? (
        <ErrorBox error={r.error} retry={r.reload} />
      ) : !r.data ? (
        <Loading />
      ) : r.data.length === 0 ? (
        <Card>
          <EmptyState
            icon={<FolderOpen />}
            title={q || status !== 'active' ? 'Geen dossier gevonden' : 'Nog geen dossiers'}
          >
            {q || status !== 'active' ? 'Probeer een ander woord.' : 'Een dossier bundelt alles over een project, klant of onderwerp. Je bots houden het bij.'}
          </EmptyState>
        </Card>
      ) : (
        <div className="grid gap-2 md:grid-cols-2">
          {r.data.map((d) => (
            <a key={d.id} href={memPath(`dossiers/${d.id}`)} className="tb-in block rounded-card border border-line bg-surface p-4 transition-colors hover:border-line-strong">
              <div className="flex items-start gap-2.5">
                <FolderOpen className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 flex-1 font-semibold leading-snug [overflow-wrap:anywhere]" translate="no">{d.title}</span>
                {/* One signal: what is still open. */}
                {d.open_actions > 0 && <Badge tone="warn">{t('{0, plural, one {# open actie} other {# open acties}}', d.open_actions)}</Badge>}
              </div>
              {d.summary && <p className="mt-1.5 line-clamp-2 text-sm text-muted" translate="no">{d.summary}</p>}
              <div className="mt-2 flex flex-wrap gap-x-2 gap-y-1 text-xs text-muted">
                <span>{DOSSIER_KIND_LABEL[d.kind] || d.kind}</span>
                {d.team && <span>· {d.team.id === ALL_TEAMS ? 'Alle teams' : d.team.name}</span>}
                {d.role !== 'owner' && (
                <span>
                  · <Words text="van {0}" values={[d.owner_name || '']} />
                </span>
              )}
                <span>· bijgewerkt {timeAgo(d.last_activity_at)}</span>
              </div>
            </a>
          ))}
        </div>
      )}
      {creating && <CreateDossier onClose={() => setCreating(false)} />}
      {importing && <ImportMarkdown onClose={() => setImporting(false)} onDone={r.reload} />}
      {copying && <CopyKnowledge onClose={() => setCopying(false)} onDone={r.reload} />}
    </div>
  );
}

/**
 * "Vakkennis kopiëren": a team's dossiers and shared knowledge into another team (a copy, not a link). Never what is
 * about you, a bot's own notes, conversation summaries or anything personal or sensitive.
 */
function CopyKnowledge({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const teams = useMemTeams();
  const [filter] = useTeamFilter();
  const first = filter && filter !== ALL_TEAMS ? filter : teams.teams[0]?.id || '';
  const [from, setFrom] = useState(first);
  const [to, setTo] = useState(teams.teams.find((x) => x.id !== first)?.id || '');
  const [result, setResult] = useState<string | null>(null);
  const { run, busy } = useAsync();
  return (
    <Modal
      open
      onClose={result ? () => (onDone(), onClose()) : onClose}
      title="Vakkennis kopiëren"
      footer={
        result ? (
          <Button variant="primary" onClick={() => (onDone(), onClose())}>
            Klaar
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Annuleren
            </Button>
            <Button
              variant="primary"
              loading={busy}
              disabled={!from || !to || from === to}
              onClick={() =>
                run(async () => {
                  const r = await api.post('/memory/teams/copy', { fromTeamId: from, toTeamId: to });
                  setResult(
                    [
                      t('Gekopieerd: {0, plural, one {# dossier} other {# dossiers}} en {1, plural, one {# herinnering} other {# herinneringen}}.', r.dossiers, r.items),
                      r.skipped?.existing ? t('{0, plural, one {# onderdeel stond er al.} other {# onderdelen stonden er al.}}', r.skipped.existing) : '',
                      r.skipped?.quota ? t('{0, plural, one {# onderdeel paste niet meer (geheugen vol).} other {# onderdelen pasten niet meer (geheugen vol).}}', r.skipped.quota) : '',
                      r.skipped?.personal ? t('{0, plural, one {# persoonlijk of gevoelig onderdeel bleef achter.} other {# persoonlijke of gevoelige onderdelen bleven achter.}}', r.skipped.personal) : '',
                    ]
                      .filter(Boolean)
                      .join(' '),
                  );
                })
              }
            >
              Kopiëren
            </Button>
          </>
        )
      }
    >
      {result ? (
        <p className="text-sm">{result}</p>
      ) : (
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            Kopieert de dossiers (met besluiten, acties, bronnen en documenten) en de gedeelde kennis van het ene team naar het andere. Het andere team krijgt een eigen kopie; wijzigingen gaan daarna niet over en weer. Vergeet je later iets, dan verdwijnt het in beide teams.
          </p>
          <ul className="list-disc space-y-1 ps-5 text-muted">
            <li>Nooit wat over jou gaat, eigen notities van bots of gesprekssamenvattingen.</li>
            <li>Nooit iets dat persoonlijk of gevoelig is. Sleutels en wachtwoorden staan nooit in het geheugen.</li>
          </ul>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Van team">
              <Select value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Van team">
                {teams.teams.map((x) => (
                  <option key={x.id} value={x.id} translate="no">
                    {x.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Naar team">
              <Select value={to} onChange={(e) => setTo(e.target.value)} aria-label="Naar team">
                {teams.teams.map((x) => (
                  <option key={x.id} value={x.id} translate="no">
                    {x.name}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          {from && from === to && <p className="text-warn">Kies twee verschillende teams.</p>}
        </div>
      )}
    </Modal>
  );
}

/** "Team" for a dossier (two or more teams): one team, or all teams. */
function TeamPicker({ value, onChange }: { value: string; onChange(v: string): void }) {
  const teams = useMemTeams();
  if (!teams.multi) return null;
  return (
    <Field label="Team" hint="De bots van dit team gebruiken het dossier. Een ander team ziet het niet.">
      <Select value={value} onChange={(e) => onChange(e.target.value)} aria-label="Team">
        {teams.teams.map((x) => (
          <option key={x.id} value={x.id} translate="no">
            {x.name}
          </option>
        ))}
        <option value={ALL_TEAMS}>Alle teams</option>
      </Select>
    </Field>
  );
}

// ------------------------------------------------------------------ Markdown import (A-49)

interface ImportLine {
  name: string;
  title: string;
  summary: string;
  chars: number;
  status: 'new' | 'renamed' | 'duplicate' | 'rejected' | 'blocked' | 'empty' | 'too_big' | 'not_markdown' | 'created' | 'failed';
  message: string;
  warning?: string;
  dossierId?: string;
}
const IMPORT_STATUS: Record<ImportLine['status'], { label: string; tone: 'neutral' | 'ok' | 'warn' | 'danger' | 'accent' }> = {
  new: { label: 'Nieuw', tone: 'accent' },
  renamed: { label: 'Nieuwe naam', tone: 'warn' },
  duplicate: { label: 'Bestaat al', tone: 'neutral' },
  rejected: { label: 'Geweigerd', tone: 'danger' },
  blocked: { label: 'Vergeten', tone: 'neutral' },
  empty: { label: 'Leeg', tone: 'neutral' },
  too_big: { label: 'Te groot', tone: 'danger' },
  not_markdown: { label: 'Geen .md', tone: 'neutral' },
  created: { label: 'Geïmporteerd', tone: 'ok' },
  failed: { label: 'Mislukt', tone: 'danger' },
};
const MD_FILE = /\.(md|markdown|mdown)$/i;
const MAX_FILE_BYTES = 1_600_000;

/** Choose .md files (or a folder of them), see what will happen, then import: each file becomes a dossier. */
function ImportMarkdown({ onClose, onDone }: { onClose(): void; onDone(): void }) {
  const [files, setFiles] = useState<{ name: string; text: string }[]>([]);
  const [local, setLocal] = useState<ImportLine[]>([]);
  const [skippedOther, setSkippedOther] = useState(0);
  const [dups, setDups] = useState<'skip' | 'rename'>('skip');
  const [lines, setLines] = useState<ImportLine[] | null>(null);
  const [done, setDone] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const { run, busy } = useAsync();
  const filesRef = React.useRef<HTMLInputElement>(null);
  const folderRef = React.useRef<HTMLInputElement>(null);
  const folderOk = React.useMemo(() => typeof document !== 'undefined' && 'webkitdirectory' in document.createElement('input'), []);

  const preview = (fs: { name: string; text: string }[], d: 'skip' | 'rename') =>
    run(async () => {
      setErr(null);
      if (!fs.length) return setLines([]);
      try {
        const r = await api.post<{ lines: ImportLine[] }>('/memory/dossiers/import', { files: fs, dryRun: true, duplicates: d });
        setLines(r.lines);
      } catch (e: any) {
        setLines(null);
        setErr(e?.message || String(e));
      }
    });
  const pick = async (list: FileList | null) => {
    if (!list?.length) return;
    const all = Array.from(list);
    const md = all.filter((f) => MD_FILE.test(f.name));
    setSkippedOther(all.length - md.length);
    const big = md.filter((f) => f.size > MAX_FILE_BYTES);
    const ok = md.filter((f) => f.size <= MAX_FILE_BYTES);
    const read = await Promise.all(ok.map(async (f) => ({ name: f.name, text: await f.text() })));
    setLocal(big.map((f) => ({ name: f.name, title: f.name.replace(MD_FILE, ''), summary: '', chars: f.size, status: 'too_big', message: 'Te groot (maximaal 400 kB tekst per bestand).' })));
    setFiles(read);
    setDone(false);
    preview(read, dups);
  };
  const doImport = () =>
    run(async () => {
      setErr(null);
      try {
        const r = await api.post<{ lines: ImportLine[]; created: number }>('/memory/dossiers/import', { files, duplicates: dups });
        setLines(r.lines);
        setDone(true);
        onDone();
        toast(r.created === 1 ? '1 dossier geïmporteerd' : r.created ? `${r.created} dossiers geïmporteerd` : 'Niets geïmporteerd', r.created ? 'ok' : 'neutral');
      } catch (e: any) {
        setErr(e?.message || String(e));
      }
    });
  const shown = [...(lines || []), ...local];
  const count = (lines || []).filter((l) => l.status === 'new' || l.status === 'renamed').length;
  const hasDup = (lines || []).some((l) => l.status === 'duplicate' || l.status === 'renamed');
  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Importeren uit Markdown"
      footer={
        done ? (
          <Button variant="primary" onClick={onClose}>
            Klaar
          </Button>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose}>
              Annuleren
            </Button>
            <Button variant="primary" loading={busy} disabled={!count} onClick={doImport}>
              {count ? `Importeren (${count})` : 'Importeren'}
            </Button>
          </>
        )
      }
    >
      <div className="space-y-3 text-sm">
        <p className="text-muted">
          Elk Markdown-bestand (.md) wordt een eigen dossier: de eerste kop wordt de titel, de eerste alinea de samenvatting en de hele tekst de bron (“Geïmporteerd uit …”), doorzoekbaar voor jou en je bots. Bestanden met een wachtwoord of sleutel worden geweigerd. Je ziet eerst wat er gebeurt.
        </p>
        {!done && (
          <div className="flex flex-wrap gap-2">
            <input ref={filesRef} type="file" multiple accept=".md,.markdown,.mdown,text/markdown" hidden onChange={(e) => (pick(e.target.files), (e.target.value = ''))} aria-label="Markdown-bestanden kiezen" />
            <input ref={folderRef} type="file" multiple hidden onChange={(e) => (pick(e.target.files), (e.target.value = ''))} aria-label="Map met Markdown-bestanden kiezen" {...({ webkitdirectory: '', directory: '' } as any)} />
            <Button icon={<FileText className="h-4 w-4" />} onClick={() => filesRef.current?.click()}>
              Bestanden kiezen
            </Button>
            {folderOk && (
              <Button icon={<FolderOpen className="h-4 w-4" />} onClick={() => folderRef.current?.click()}>
                Map kiezen
              </Button>
            )}
          </div>
        )}
        {!done && hasDup && (
          <Field label="Als er al een dossier met dezelfde titel is">
            <Select
              value={dups}
              onChange={(e) => {
                const d = e.target.value as 'skip' | 'rename';
                setDups(d);
                preview(files, d);
              }}
              aria-label="Als er al een dossier met dezelfde titel is"
            >
              <option value="skip">Overslaan</option>
              <option value="rename">Toch toevoegen, met een nieuwe naam (bijv. “Titel (2)”)</option>
            </Select>
          </Field>
        )}
        {err && <ErrorBox error={err} />}
        {busy && !lines && <Loading />}
        {shown.length > 0 && (
          <ul className="divide-y divide-line overflow-hidden rounded-xl border border-line" aria-label={done ? 'Resultaat van de import' : 'Voorbeeld van de import'}>
            {shown.map((l, i) => {
              const st = IMPORT_STATUS[l.status];
              return (
                <li key={`${l.name}-${i}`} className="flex items-start gap-2.5 px-3 py-2.5">
                  <FileText className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-hidden />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      {l.status === 'created' && l.dossierId ? (
                        <a className="truncate font-semibold text-accent hover:underline" href={memPath(`dossiers/${l.dossierId}`)} onClick={onClose} translate="no">
                          {l.title}
                        </a>
                      ) : (
                        <span className="truncate font-semibold" translate="no">{l.title || l.name}</span>
                      )}
                      <Badge tone={st.tone}>{st.label}</Badge>
                    </div>
                    <div className="truncate text-xs text-muted" translate="no">{l.name}</div>
                    {l.summary && ['new', 'renamed', 'created'].includes(l.status) && <p className="mt-0.5 line-clamp-2 text-xs text-muted" translate="no">{l.summary}</p>}
                    {!['new', 'created'].includes(l.status) && <p className={cx('mt-0.5 text-xs', l.status === 'rejected' || l.status === 'failed' || l.status === 'too_big' ? 'text-danger' : 'text-muted')}>{l.message}</p>}
                    {l.warning && <p className="mt-0.5 text-xs text-warn">{l.warning}</p>}
                  </div>
                </li>
              );
            })}
          </ul>
        )}
        {skippedOther > 0 && <p className="text-xs text-muted">{skippedOther} {skippedOther === 1 ? 'ander bestand' : 'andere bestanden'} (geen .md) overgeslagen.</p>}
        {lines && !shown.length && <p className="text-muted">Geen Markdown-bestanden gevonden.</p>}
      </div>
    </Modal>
  );
}

function CreateDossier({ onClose }: { onClose(): void }) {
  const allAgents = useApp((s) => s.agents);
  const teams = useMemTeams();
  const [filter] = useTeamFilter();
  const [teamId, setTeamId] = useState('');
  const team = teamId || defaultTeamFor(filter, teams);
  const agents = teamBots(allAgents, teams, team);
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('project');
  const [summary, setSummary] = useState('');
  const [all, setAll] = useState(true);
  const [chosen, setChosen] = useState<string[]>([]);
  const { run, busy } = useAsync();
  return (
    <Modal
      open
      onClose={onClose}
      title="Nieuw dossier"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={!title.trim()}
            onClick={() =>
              run(async () => {
                const from = location.hash;
                const r = await api.post('/memory/dossiers', { title, kind, summary, agentIds: all ? null : chosen.filter((id) => agents.some((a) => a.id === id)), ...(teams.multi && team ? { teamId: team } : {}) });
                if (r.existed) toast('Er bestond al een dossier met die titel', 'neutral');
                onClose();
                navigate(memPath(`dossiers/${r.dossier.id}`), { from });
              })
            }
          >
            Aanmaken
          </Button>
        </>
      }
    >
      <div className="space-y-3">
        <Field label="Titel">
          <Input value={title} onChange={(e) => setTitle(e.target.value)} autoFocus maxLength={120} />
        </Field>
        <Field label="Soort">
          <Select value={kind} onChange={(e) => setKind(e.target.value)}>
            {Object.entries(DOSSIER_KIND_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Samenvatting (optioneel)">
          <Textarea rows={3} value={summary} onChange={(e) => setSummary(e.target.value)} />
        </Field>
        <TeamPicker value={team} onChange={setTeamId} />
        <BotAccess all={all} setAll={setAll} chosen={chosen} setChosen={setChosen} agents={agents} multi={teams.multi} />
      </div>
    </Modal>
  );
}

/**
 * The bots a dossier of this team can be for: the team's own bots (another team's bots cannot reach it anyway,
 * except by meekijken, which reads every dossier of the team). All bots with one team or for "Alle teams".
 */
function teamBots<T extends { id: string }>(agents: T[], teams: ReturnType<typeof useMemTeams>, team: string): T[] {
  const ids = teams.teams.find((x) => x.id === team)?.bots;
  if (!teams.multi || !ids) return agents;
  return agents.filter((a) => ids.includes(a.id));
}

function BotAccess({ all, setAll, chosen, setChosen, agents, multi }: { all: boolean; setAll(v: boolean): void; chosen: string[]; setChosen(v: string[]): void; agents: { id: string; name: string }[]; multi?: boolean }) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-sm font-medium">Welke bots mogen dit dossier gebruiken?</legend>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" checked={all} onChange={() => setAll(true)} /> {multi ? 'Alle bots van het team' : 'Al mijn bots'}
      </label>
      <label className="flex items-center gap-2 text-sm">
        <input type="radio" checked={!all} onChange={() => setAll(false)} /> Alleen gekozen bots
      </label>
      {!all && (
        <div className="flex flex-wrap gap-2 ps-6">
          {agents.length === 0 && <span className="text-sm text-muted">Nog geen bots.</span>}
          {agents.map((a) => (
            <label key={a.id} className="flex items-center gap-1.5 rounded-lg border border-line px-2 py-1 text-sm">
              <input type="checkbox" checked={chosen.includes(a.id)} onChange={(e) => setChosen(e.target.checked ? [...chosen, a.id] : chosen.filter((x) => x !== a.id))} />
              <span translate="no">{a.name}</span>
            </label>
          ))}
        </div>
      )}
    </fieldset>
  );
}

const SUBTABS = [
  { id: 'overzicht', label: 'Overzicht' },
  { id: 'tijdlijn', label: 'Tijdlijn' },
  { id: 'besluiten', label: 'Besluiten' },
  { id: 'acties', label: 'Acties' },
  { id: 'personen', label: 'Personen & organisaties' },
  { id: 'bronnen', label: 'Bronnen' },
  { id: 'notities', label: 'Notities' },
  { id: 'toegang', label: 'Toegang' },
  { id: 'geschiedenis', label: 'Geschiedenis' },
];

const RARE_TABS = ['toegang', 'geschiedenis'];

const IDENTITY_STRENGTH: Record<string, string> = { channel: 'herkend aan het kanaal', 'email-auth': 'e-mail met geslaagde afzendercontrole', owner: 'door jou gekoppeld' };

/**
 * A customer dossier (0.4.5): who the customer is on which channel, and one line with what the bot knows about him.
 * The bot in his conversations reads only this dossier.
 */
function CustomerIdentity({ info }: { info: { identities: any[]; knows: { facts: number; fromCustomer: number; actions: number; episodes: number; lastUsed: string | null } } }) {
  const k = info.knows;
  return (
    <Card className="space-y-1.5 p-3 text-sm">
      <div className="flex flex-wrap gap-1.5">
        {info.identities.map((i) => (
          <span key={i.id} title={IDENTITY_STRENGTH[i.strength] ? t(IDENTITY_STRENGTH[i.strength]) : undefined}>
            <Badge tone="accent">{t('{0} via {1}', i.label, i.bindingName || i.adapter)}</Badge>
          </span>
        ))}
      </div>
      <p className="text-muted">
        {t('Wat de bot over deze klant weet: {0}, {1}, {2}.', t('{0, plural, one {# feit} other {# feiten}}', k.facts), t('{0, plural, one {# open actie} other {# open acties}}', k.actions), t('{0, plural, one {# eerder gesprek} other {# eerdere gesprekken}}', k.episodes))}
        {k.lastUsed ? ` ${t('Laatst gebruikt {0}.', timeAgo(k.lastUsed))}` : ''}
      </p>
    </Card>
  );
}

function DossierDetail({ id }: { id: string }) {
  const page = location.hash;
  const r = useMem<any>(`/memory/dossiers/${id}`);
  const [tab, setTab] = useState('overzicht');
  const [forget, setForget] = useState(false);
  const { run, busy } = useAsync();
  if (r.error) return <ErrorBox error={r.error} retry={r.reload} />;
  if (!r.data) return <Loading />;
  const full = r.data;
  const d: Dossier = full.dossier;
  const canEdit = d.role === 'owner' || d.role === 'edit';
  const patch = (p: any, ok?: string) =>
    run(async () => {
      await api.patch(`/memory/dossiers/${id}`, p);
      r.reload();
    }, ok);
  return (
    <div className="space-y-3">
      <div>
        <Button size="sm" variant="ghost" onClick={() => navigate(memPath('dossiers'))}>
          ← Alle dossiers
        </Button>
      </div>
      <div className="flex flex-wrap items-start gap-2">
        <div className="min-w-[12rem] flex-1">
          <h2 className="text-lg font-semibold" translate="no">{d.title}</h2>
          <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted">
            <Badge>{DOSSIER_KIND_LABEL[d.kind] || d.kind}</Badge>
            <Badge tone={d.status === 'active' ? 'ok' : 'neutral'}>{({ active: 'Actief', closed: 'Afgesloten', archived: 'Gearchiveerd', trashed: 'Prullenbak' } as any)[d.status] || d.status}</Badge>
            <TeamBadge team={d.team} />
            {d.role !== 'owner' && (
            <Badge tone="accent">
              {d.role === 'edit' ? 'Je mag bewerken' : 'Alleen lezen'} · <Words text="van {0}" values={[d.owner_name || '']} />
            </Badge>
          )}
            <span>laatst bijgewerkt {timeAgo(d.last_activity_at)}</span>
          </div>
        </div>
        {/* One quiet menu for what you rarely do with a dossier: its status, a copy to keep, forgetting it. */}
        <Menu
          label="Meer opties"
          variant="secondary"
          items={[
            ...(d.role === 'owner'
              ? ([
                  { heading: 'Status van het dossier' },
                  ...(['active', 'closed', 'archived', 'trashed'] as const).map((st) => ({
                    label: { active: 'Actief', closed: 'Afgesloten', archived: 'Gearchiveerd', trashed: 'Prullenbak' }[st],
                    checked: d.status === st,
                    disabled: busy,
                    onSelect: () => void (d.status !== st && patch({ status: st }, 'Status bijgewerkt')),
                  })),
                  'sep',
                ] as const)
              : []),
            { label: 'Toegang', icon: <Users />, onSelect: () => setTab('toegang') },
            { label: 'Geschiedenis', icon: <History />, onSelect: () => setTab('geschiedenis') },
            'sep',
            { label: 'Export (MD)', icon: <Download />, href: authUrl(`/memory/dossiers/${id}/export?format=md`) },
            { label: 'Export (JSON)', icon: <Download />, href: authUrl(`/memory/dossiers/${id}/export?format=json`) },
            d.role === 'owner' && 'sep',
            d.role === 'owner' && { label: 'Vergeten…', icon: <Trash2 />, danger: true, onSelect: () => setForget(true) },
          ]}
        />
      </div>
      {full.customer && <CustomerIdentity info={full.customer} />}
      {/* Seven tabs fit; who may read it and the history are rarely needed: in the menu, and a tab while open. */}
      <Tabs tabs={SUBTABS.filter((x) => !RARE_TABS.includes(x.id) || x.id === tab)} value={tab} onChange={setTab} />
      <div className="pt-1">
        {tab === 'overzicht' && <Overview full={full} canEdit={canEdit} onSave={(summary: string) => patch({ summary }, 'Samenvatting opgeslagen')} onSaveBody={(body: string) => patch({ body }, 'Dossier opgeslagen')} go={setTab} />}
        {tab === 'tijdlijn' && <Timeline full={full} canEdit={canEdit} reload={r.reload} />}
        {tab === 'besluiten' && <Records kind="decision" list={full.decisions} dossierId={id} canEdit={canEdit} reload={r.reload} />}
        {tab === 'acties' && <Records kind="action" list={full.actions} dossierId={id} canEdit={canEdit} reload={r.reload} />}
        {tab === 'personen' && <Records kind="entity" list={full.entities} dossierId={id} canEdit={canEdit} reload={r.reload} />}
        {tab === 'bronnen' && <Sources full={full} canEdit={canEdit} reload={r.reload} />}
        {tab === 'notities' && (
          <ItemList base={{ scope: 'dossier', dossierId: id }} hideScope addDefaults={canEdit ? { scope: 'dossier', dossierId: id } : undefined} empty={<EmptyState title="Nog geen notities in dit dossier" />} />
        )}
        {tab === 'toegang' && <Access full={full} reload={r.reload} />}
        {tab === 'geschiedenis' && (
          <Card className="divide-y divide-line">
            {full.changes.length === 0 ? <p className="p-3 text-sm text-muted">Nog geen wijzigingen.</p> : full.changes.map((c: Change) => <ChangeRow key={c.id} c={c} onUndone={r.reload} />)}
          </Card>
        )}
      </div>
      {forget && <ForgetDialog title={<Words text="Het hele dossier “{0}” met alle notities, besluiten, acties, personen en bronnen." values={[d.title]} />} endpoint={`/memory/dossiers/${id}/forget`} onClose={() => setForget(false)} onDone={() => navigate(memPath('dossiers'), { from: page })} />}
    </div>
  );
}

/**
 * The text of a dossier: what the bots always read and keep up to date themselves, and the owner can change here. Also
 * shown in Geheugen with the place it belongs to (about you, one bot, a team): pages.tsx.
 */
export function DossierText({ saved, limit, canEdit, onSave, title, className }: { saved: string; limit: number; canEdit: boolean; onSave(s: string): void; title?: string; className?: string }) {
  const [body, setBody] = useState(saved);
  useEffect(() => setBody(saved), [saved]);
  return (
    <Card className={cx('space-y-2 p-3', className)}>
      {title ? (
        <h3 className="text-sm font-semibold" translate="no">
          {title}
        </h3>
      ) : (
        <CardHead as="h3" icon={FileText} tone="amber" title="Tekst van het dossier" />
      )}
      <p className="text-xs text-muted">Dit lezen je bots. Ze houden het zelf bij; jij kunt het hier aanpassen.</p>
      {canEdit ? (
        <>
          <Textarea rows={title ? 8 : 14} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Tekst van het dossier" placeholder="Nog leeg. Je bots vullen dit zodra ze iets weten dat hier hoort." />
          <div className="flex items-center gap-3">
            <Button size="sm" disabled={body === saved || body.trim().length > limit} onClick={() => onSave(body)}>
              Opslaan
            </Button>
            <span className={`text-xs ${body.trim().length > limit ? 'text-danger' : 'text-muted'}`}>
              {body.trim().length > limit ? t('{0} van {1} tekens: maak het korter', body.trim().length, limit) : t('{0} van {1} tekens', body.trim().length, limit)}
            </span>
          </div>
        </>
      ) : (
        <p className="whitespace-pre-wrap text-sm">{saved || <span className="text-muted">Nog leeg.</span>}</p>
      )}
    </Card>
  );
}

function Overview({ full, canEdit, onSave, onSaveBody, go }: { full: any; canEdit: boolean; onSave(s: string): void; onSaveBody(s: string): void; go(t: string): void }) {
  const [summary, setSummary] = useState(full.dossier.summary || '');
  const saved: string = full.dossier.body || '';
  const limit: number = full.dossier.body_limit || 8000;
  const open = full.actions.filter((a: DossierRecord) => a.status === 'open');
  const decisions = full.decisions.filter((x: DossierRecord) => x.status === 'active').slice(0, 3);
  const activeDecisions = full.decisions.filter((x: any) => x.status === 'active').length;
  const counts: { n: number; tab: string; text: string }[] = [
    { n: open.length, tab: 'acties', text: t('{0, plural, one {# open actie} other {# open acties}}', open.length) },
    { n: activeDecisions, tab: 'besluiten', text: t('{0, plural, one {# besluit} other {# besluiten}}', activeDecisions) },
    { n: full.events.length, tab: 'tijdlijn', text: t('{0, plural, one {# gebeurtenis} other {# gebeurtenissen}}', full.events.length) },
    { n: full.entities.length, tab: 'personen', text: t('{0, plural, one {# persoon/organisatie} other {# personen/organisaties}}', full.entities.length) },
    { n: full.sources.length, tab: 'bronnen', text: t('{0, plural, one {# bron} other {# bronnen}}', full.sources.length) },
    { n: full.items.length, tab: 'notities', text: t('{0, plural, one {# notitie} other {# notities}}', full.items.length) },
  ];
  return (
    <div className="grid gap-3 lg:grid-cols-3">
      <DossierText className="lg:col-span-2" saved={saved} limit={limit} canEdit={canEdit} onSave={onSaveBody} />
      {!saved && (full.dossier.summary || canEdit) && (
      <Card className="space-y-2 p-3 lg:col-span-2">
        <CardHead as="h3" icon={FileText} tone="amber" title="Samenvatting" />
        {canEdit ? (
          <>
            <Textarea rows={5} value={summary} onChange={(e) => setSummary(e.target.value)} aria-label="Samenvatting" placeholder="Waar gaat dit dossier over? Doelen, stand van zaken…" />
            <Button size="sm" disabled={summary === (full.dossier.summary || '')} onClick={() => onSave(summary)}>
              Opslaan
            </Button>
          </>
        ) : (
          <p className="whitespace-pre-wrap text-sm">{full.dossier.summary ? <span translate="no">{full.dossier.summary}</span> : <span className="text-muted">Geen samenvatting.</span>}</p>
        )}
      </Card>
      )}
      {/* What is in the dossier: only what is there, each line the way to it (no row of zeros). */}
      <Card className="space-y-2 p-3">
        <CardHead as="h3" icon={BarChart3} title="In cijfers" />
        {counts.some((c) => c.n > 0) ? (
          <ul className="space-y-1 text-sm">
            {counts
              .filter((c) => c.n > 0)
              .map((c) => (
                <li key={c.tab + c.text}>
                  <button type="button" className="text-start hover:underline" onClick={() => go(c.tab)}>
                    {c.text}
                  </button>
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-sm text-muted">Nog leeg.</p>
        )}
      </Card>
      <Card className="space-y-2 p-3 lg:col-span-2">
        <CardHead
          as="h3"
          icon={CheckSquare}
          tone="orange"
          title="Open acties"
          action={
            <button className="text-sm text-accent hover:underline" onClick={() => go('acties')}>
              Alle acties
            </button>
          }
        />
        {open.length === 0 ? (
          <p className="text-sm text-muted">Geen open acties.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {open.slice(0, 6).map((a: DossierRecord) => (
              <li key={a.id} className="flex flex-wrap gap-x-2">
                <span className="min-w-0 flex-1" translate="no">{a.title}</span>
                <span className="text-xs text-muted">
                  {a.owner || 'geen eigenaar'}
                  {a.due_at ? ` · uiterlijk ${fmtDate(a.due_at)}` : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>
      <Card className="space-y-2 p-3">
        <CardHead as="h3" icon={Gavel} title="Laatste besluiten" />
        {decisions.length === 0 ? (
          <p className="text-sm text-muted">Nog geen besluiten.</p>
        ) : (
          <ul className="space-y-1 text-sm">
            {decisions.map((x: DossierRecord) => (
              <li key={x.id}>
                <span translate="no">{x.title}</span> <span className="text-xs text-muted">· {fmtDate(x.occurred_at)}</span>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  );
}

const KIND_ICON: Record<string, React.ReactNode> = {
  event: <Milestone className="h-4 w-4" />,
  decision: <Gavel className="h-4 w-4" />,
  action: <CalendarClock className="h-4 w-4" />,
  entity: <UserRound className="h-4 w-4" />,
};

function Timeline({ full, canEdit, reload }: { full: any; canEdit: boolean; reload(): void }) {
  return (
    <div className="space-y-3">
      {canEdit && <AddRecord kind="event" dossierId={full.dossier.id} onDone={reload} />}
      {full.timeline.length === 0 ? (
        <Card>
          <EmptyState title="Nog geen tijdlijn">Gebeurtenissen, besluiten en acties verschijnen hier op datum.</EmptyState>
        </Card>
      ) : (
        <ol className="relative space-y-3 border-s border-line ps-4">
          {full.timeline.map((x: any) => (
            <li key={x.id} className="relative">
              <span className="absolute -start-[1.4rem] top-0.5 flex h-5 w-5 items-center justify-center rounded-full bg-surface text-muted ring-1 ring-line">{KIND_ICON[x.kind]}</span>
              <div className="text-xs text-muted">
                {fmtDate(x.at)} · {RECORD_LABEL[x.kind]} · <bdi translate="no">{x.author_name}</bdi>
              </div>
              <div className={cx('text-sm', ['superseded', 'cancelled', 'revoked'].includes(x.status) && 'text-muted line-through')} translate="no">{x.title}</div>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function RecordRow({ r, canEdit, reload }: { r: DossierRecord; canEdit: boolean; reload(): void }) {
  const { run, busy } = useAsync();
  const [forget, setForget] = useState(false);
  const [edit, setEdit] = useState(false);
  const [title, setTitle] = useState(r.title);
  const [owner, setOwner] = useState(r.owner || '');
  const [due, setDue] = useState(toDateInput(r.due_at));
  const [body, setBody] = useState(r.body || '');
  const upd = (p: any, ok?: string) =>
    run(async () => {
      await api.patch(`/memory/records/${r.id}`, p);
      reload();
    }, ok);
  const done = r.status === 'done';
  return (
    <Card className="p-3">
      <div className="flex flex-wrap items-start gap-2">
        {r.kind === 'action' && canEdit ? (
          <button className="mt-0.5 text-muted hover:text-fg" aria-label={done ? 'Weer openzetten' : 'Afronden'} onClick={() => upd({ status: done ? 'open' : 'done' }, done ? 'Weer open' : 'Afgerond')} disabled={busy}>
            {done ? <CheckSquare className="h-4 w-4 text-ok" /> : <Square className="h-4 w-4" />}
          </button>
        ) : (
          <span className="mt-0.5 text-muted">{KIND_ICON[r.kind]}</span>
        )}
        <div className="min-w-[12rem] flex-1">
          {edit ? (
            <div className="space-y-2">
              <Input value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Titel" />
              <Textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} aria-label="Toelichting" placeholder="Toelichting" />
              {r.kind === 'action' && (
                <div className="flex flex-wrap gap-2">
                  <Input className="w-auto flex-1" value={owner} onChange={(e) => setOwner(e.target.value)} placeholder="Eigenaar" aria-label="Eigenaar" />
                  <Input style={{ width: 'auto' }} type="date" value={due} onChange={(e) => setDue(e.target.value)} aria-label="Deadline" />
                </div>
              )}
              <div className="flex gap-2">
                <Button size="sm" variant="primary" loading={busy} onClick={() => upd({ title, body, ...(r.kind === 'action' ? { owner, due_at: fromDateInput(due) } : {}) }, 'Opgeslagen').then(() => setEdit(false))}>
                  Opslaan
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setEdit(false)}>
                  Annuleren
                </Button>
              </div>
            </div>
          ) : (
            <>
              <div className={cx('text-sm', (done || ['superseded', 'cancelled', 'revoked'].includes(r.status)) && 'text-muted line-through')} translate="no">{r.title}</div>
              {r.data?.question && (
                <div className="text-xs text-muted">
                  <Words text="Vraag: {0}" values={[r.data.question]} />
                </div>
              )}
              {r.body && <div className="whitespace-pre-wrap text-xs text-muted" translate="no">{r.body}</div>}
              <div className="mt-1 flex flex-wrap gap-x-2 text-xs text-muted">
                {r.kind === 'entity' && <span>{r.data?.entity_kind === 'organization' ? 'Organisatie' : r.data?.entity_kind === 'person' ? 'Persoon' : r.data?.entity_kind}</span>}
                {r.data?.aliases?.length > 0 && <span>ook: {r.data.aliases.join(', ')}</span>}
                {r.owner && <span>{r.kind === 'action' ? 'Eigenaar' : 'Door'}: {r.owner}</span>}
                {r.due_at && <span className={cx(!done && r.due_at < new Date().toISOString() && 'text-danger')}>uiterlijk {fmtDate(r.due_at)}</span>}
                {r.occurred_at && r.kind !== 'action' && <span>{fmtDate(r.occurred_at)}</span>}
                {r.status !== 'active' && r.status !== 'open' && <Badge tone={r.status === 'proposed' ? 'warn' : 'neutral'}>{({ proposed: 'Voorstel', superseded: 'Vervangen', done: 'Klaar', cancelled: 'Geannuleerd', revoked: 'Herroepen' } as any)[r.status] || r.status}</Badge>}
                <span>
                  · <bdi translate="no">{r.author_name}</bdi>
                </span>
                {r.sources?.filter((s) => s.kind === 'thread' && s.ref).slice(0, 1).map((s) => (
                  <a key={s.ref} className="inline-flex items-center gap-0.5 text-accent hover:underline" href={`#/t/${s.ref}`}>
                    <LinkIcon className="h-3 w-3" /> bron
                  </a>
                ))}
              </div>
            </>
          )}
        </div>
        {canEdit && !edit && (
          <div className="flex shrink-0 gap-1">
            {r.kind === 'decision' && r.status === 'proposed' && (
              <>
                <Button size="sm" variant="primary" loading={busy} onClick={() => upd({ status: 'active' }, 'Besluit goedgekeurd')}>
                  Goedkeuren
                </Button>
                <Button size="sm" onClick={() => upd({ status: 'trashed' }, 'Weggegooid')}>
                  Weigeren
                </Button>
              </>
            )}
            {r.kind === 'action' && r.status === 'open' && (
              <Button size="sm" variant="ghost" onClick={() => upd({ status: 'cancelled' }, 'Geannuleerd')}>
                Annuleren
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setEdit(true)}>
              Bewerken
            </Button>
            <Button size="icon" variant="ghost" aria-label="Naar prullenbak" onClick={() => upd({ status: 'trashed' }, 'Naar prullenbak')}>
              <Trash2 className="h-4 w-4" />
            </Button>
            <Button size="sm" variant="ghost" className="text-danger" onClick={() => setForget(true)}>
              Vergeten
            </Button>
          </div>
        )}
      </div>
      {forget && <ForgetDialog title={<Words text="{0}: {1}" values={[{ text: RECORD_LABEL[r.kind] || r.kind }, r.title]} />} endpoint={`/memory/records/${r.id}/forget`} onClose={() => setForget(false)} onDone={() => (setForget(false), reload())} />}
    </Card>
  );
}

function Records({ kind, list, dossierId, canEdit, reload }: { kind: 'decision' | 'action' | 'entity'; list: DossierRecord[]; dossierId: string; canEdit: boolean; reload(): void }) {
  const empty = { decision: 'Nog geen besluiten', action: 'Nog geen acties', entity: 'Nog geen personen of organisaties' }[kind];
  return (
    <div className="space-y-2">
      {canEdit && <AddRecord kind={kind} dossierId={dossierId} onDone={reload} />}
      {list.length === 0 ? (
        <Card>
          <EmptyState title={empty} />
        </Card>
      ) : (
        list.map((r) => <RecordRow key={r.id} r={r} canEdit={canEdit} reload={reload} />)
      )}
    </div>
  );
}

function AddRecord({ kind, dossierId, onDone }: { kind: 'event' | 'decision' | 'action' | 'entity'; dossierId: string; onDone(): void }) {
  const [open, setOpen] = useState(false);
  const [f, setF] = useState<any>({ entity_kind: 'person' });
  const { run, busy } = useAsync();
  const label = { event: 'Gebeurtenis toevoegen', decision: 'Besluit vastleggen', action: 'Actie toevoegen', entity: 'Persoon of organisatie toevoegen' }[kind];
  if (!open)
    return (
      <Button size="sm" icon={<Plus className="h-4 w-4" />} onClick={() => setOpen(true)}>
        {label}
      </Button>
    );
  const submit = () =>
    run(async () => {
      const body: any = { kind, title: f.title, body: f.body };
      if (kind === 'event') body.occurred_at = fromDateInput(f.date);
      if (kind === 'decision') Object.assign(body, { question: f.question, occurred_at: fromDateInput(f.date), owner: f.owner });
      if (kind === 'action') Object.assign(body, { owner: f.owner, due_at: fromDateInput(f.due) });
      if (kind === 'entity') Object.assign(body, { entity_kind: f.entity_kind, aliases: String(f.aliases || '').split(',').map((s: string) => s.trim()).filter(Boolean) });
      const r = await api.post(`/memory/dossiers/${dossierId}/records`, body);
      toast(r.existed ? 'Stond er al in (samengevoegd)' : 'Toegevoegd', 'ok');
      setF({ entity_kind: 'person' });
      setOpen(false);
      onDone();
    });
  const set = (k: string) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>) => setF({ ...f, [k]: e.target.value });
  return (
    <Card className="space-y-2 p-3">
      <div className="text-sm font-semibold">{label}</div>
      <Input placeholder={kind === 'decision' ? 'Het besluit' : kind === 'entity' ? 'Naam' : kind === 'action' ? 'Wat moet er gebeuren?' : 'Wat gebeurde er?'} value={f.title || ''} onChange={set('title')} autoFocus aria-label="Titel" />
      {kind === 'decision' && <Input placeholder="Welke vraag beantwoordt dit? (optioneel)" value={f.question || ''} onChange={set('question')} aria-label="Vraag" />}
      <Textarea rows={2} placeholder={kind === 'decision' ? 'Waarom? (optioneel)' : kind === 'entity' ? 'Rol of beschrijving (optioneel)' : 'Toelichting (optioneel)'} value={f.body || ''} onChange={set('body')} aria-label="Toelichting" />
      <div className="flex flex-wrap gap-2">
        {(kind === 'action' || kind === 'decision') && <Input className="w-auto flex-1" placeholder={kind === 'action' ? 'Eigenaar' : 'Genomen door'} value={f.owner || ''} onChange={set('owner')} aria-label="Eigenaar" />}
        {kind === 'action' && <Input style={{ width: 'auto' }} type="date" value={f.due || ''} onChange={set('due')} aria-label="Deadline" />}
        {(kind === 'event' || kind === 'decision') && <Input style={{ width: 'auto' }} type="date" value={f.date || ''} onChange={set('date')} aria-label="Datum" />}
        {kind === 'entity' && (
          <>
            <Select style={{ width: 'auto' }} value={f.entity_kind} onChange={set('entity_kind')} aria-label="Soort">
              <option value="person">Persoon</option>
              <option value="organization">Organisatie</option>
              <option value="place">Plaats</option>
              <option value="product">Product</option>
              <option value="other">Anders</option>
            </Select>
            <Input className="w-auto flex-1" placeholder="Ook bekend als (komma’s)" value={f.aliases || ''} onChange={set('aliases')} aria-label="Aliassen" />
          </>
        )}
      </div>
      <div className="flex gap-2">
        <Button size="sm" variant="primary" loading={busy} disabled={!f.title?.trim()} onClick={submit}>
          Toevoegen
        </Button>
        <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
          Annuleren
        </Button>
      </div>
    </Card>
  );
}

function Sources({ full, canEdit, reload }: { full: any; canEdit: boolean; reload(): void }) {
  const [mode, setMode] = useState<'url' | 'note' | null>(null);
  const [title, setTitle] = useState('');
  const [target, setTarget] = useState('');
  const [text, setText] = useState('');
  const [forget, setForget] = useState<any>(null);
  const [toSkill, setToSkill] = useState<string | null>(null);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const { run, busy } = useAsync();
  const add = () =>
    run(async () => {
      const s = await api.post(`/memory/dossiers/${full.dossier.id}/sources`, { kind: mode, title, target, text });
      toast(s.chunks ? `Toegevoegd en doorzoekbaar (${s.chunks} delen)` : 'Bron toegevoegd', 'ok');
      setMode(null);
      setTitle('');
      setTarget('');
      setText('');
      reload();
    });
  // A pdf, Word or text file: uploaded, its text read on the server, then chunked and searchable.
  const addFile = (f: File | undefined) =>
    f &&
    run(async () => {
      const a = await upload(f, f.name);
      const s = await api.post(`/memory/dossiers/${full.dossier.id}/sources`, { attachmentId: a.id, title: f.name });
      toast(s.chunks ? t('{0} toegevoegd en doorzoekbaar ({1, plural, one {# deel} other {# delen}})', f.name, s.chunks) : t('{0} toegevoegd (geen tekst om te doorzoeken)', f.name), 'ok');
      reload();
    });
  return (
    <div className="space-y-2">
      {canEdit && !mode && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" icon={<LinkIcon className="h-4 w-4" />} onClick={() => setMode('url')}>
            Link toevoegen
          </Button>
          <Button size="sm" icon={<Upload className="h-4 w-4" />} loading={busy} onClick={() => fileRef.current?.click()}>
            Bestand toevoegen (pdf, Office, foto of tekst)
          </Button>
          <input ref={fileRef} type="file" hidden accept=".pdf,.docx,.xlsx,.pptx,.png,.jpg,.jpeg,.txt,.md,.markdown,.csv,.json,.html,.htm,application/pdf,application/vnd.openxmlformats-officedocument.wordprocessingml.document,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet,application/vnd.openxmlformats-officedocument.presentationml.presentation,image/png,image/jpeg,text/*" onChange={(e) => (addFile(e.target.files?.[0]), (e.target.value = ''))} aria-label="Bestand kiezen" />
          <Button size="sm" icon={<FileText className="h-4 w-4" />} onClick={() => setMode('note')}>
            Tekst plakken (doorzoekbaar)
          </Button>
        </div>
      )}
      {mode && (
        <Card className="space-y-2 p-3">
          <Input placeholder="Titel" value={title} onChange={(e) => setTitle(e.target.value)} aria-label="Titel" />
          {mode === 'url' && <Input placeholder="https://…" value={target} onChange={(e) => setTarget(e.target.value)} aria-label="URL" />}
          <Textarea rows={mode === 'note' ? 8 : 3} placeholder={mode === 'url' ? 'Optioneel: relevante tekst van de pagina (wordt doorzoekbaar)' : 'Plak hier de tekst. Die wordt in stukken geïndexeerd zodat bots erin kunnen zoeken.'} value={text} onChange={(e) => setText(e.target.value)} aria-label="Tekst" />
          <p className="text-xs text-muted">TeamBot haalt links niet zelf op. Tekst met wachtwoorden of sleutels wordt geweigerd.</p>
          <div className="flex gap-2">
            <Button size="sm" variant="primary" loading={busy} disabled={mode === 'url' ? !target.trim() : !text.trim()} onClick={add}>
              Toevoegen
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setMode(null)}>
              Annuleren
            </Button>
          </div>
        </Card>
      )}
      {full.sources.length === 0 ? (
        <Card>
          <EmptyState title="Nog geen bronnen">Links, documenten en gesprekken die bij dit dossier horen.</EmptyState>
        </Card>
      ) : (
        <Card className="divide-y divide-line">
          {full.sources.map((s: any) => (
            <div key={s.id} className="flex items-start gap-2 px-3 py-2 text-sm">
              {s.kind === 'url' ? <ExternalLink className="mt-0.5 h-4 w-4 text-muted" /> : s.kind === 'thread' ? <LinkIcon className="mt-0.5 h-4 w-4 text-muted" /> : <FileText className="mt-0.5 h-4 w-4 text-muted" />}
              <div className="min-w-0 flex-1">
                {s.kind === 'url' ? (
                  <a className="break-all text-accent hover:underline" href={s.target} target="_blank" rel="noreferrer noopener" translate="no">
                    {s.title || s.target}
                  </a>
                ) : (
                  <span translate="no">{s.title}</span>
                )}
                <div className="text-xs text-muted">
                  {fmtDate(s.created_at)}
                  {s.chunks ? ` · ${s.chunks} delen doorzoekbaar` : ''}
                </div>
                {s.excerpt && <p className="mt-0.5 line-clamp-2 text-xs text-muted" translate="no">{s.excerpt}</p>}
              </div>
              {s.chunks > 0 && s.kind !== 'thread' && (
                <Button size="sm" variant="ghost" onClick={() => setToSkill(s.id)} title="Maak een skill van dit document">
                  Maak een skill
                </Button>
              )}
              {canEdit && (
                <Button size="sm" variant="ghost" className="text-danger" onClick={() => setForget(s)}>
                  Vergeten
                </Button>
              )}
            </div>
          ))}
        </Card>
      )}
      {toSkill && <DocumentToSkillModal sourceId={toSkill} onClose={() => setToSkill(null)} />}
      {forget && <ForgetDialog title={<Words text="Bron: {0}" values={[forget.title]} />} endpoint={`/memory/sources/${forget.id}/forget`} onClose={() => setForget(null)} onDone={() => (setForget(null), reload())} />}
    </div>
  );
}

function Access({ full, reload }: { full: any; reload(): void }) {
  const d: Dossier = full.dossier;
  const allAgents = useApp((s) => s.agents);
  const teams = useMemTeams();
  const [team, setTeam] = useState(d.team?.id || '');
  const agents = teamBots(allAgents, teams, team);
  const [all, setAll] = useState(d.agent_ids === null);
  const [chosen, setChosen] = useState<string[]>(d.agent_ids || []);
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('read');
  const { run, busy } = useAsync();
  if (d.role !== 'owner')
    return (
      <Card className="space-y-2 p-3 text-sm">
        <p>
          Dit dossier is van <bdi translate="no">{d.owner_name}</bdi>. Je hebt {d.role === 'edit' ? 'bewerkrechten' : 'leesrechten'}. Je bots kunnen het lezen als hun instelling “gedeeld geheugen lezen” aan staat.
        </p>
        <Button
          size="sm"
          onClick={() =>
            run(async () => {
              const from = location.hash;
              await api.post(`/memory/dossiers/${d.id}/leave`, {});
              navigate(memPath('dossiers'), { from });
            }, 'Je hebt het dossier verlaten')
          }
        >
          Dossier verlaten
        </Button>
      </Card>
    );
  return (
    <div className="space-y-3">
      <Card className="space-y-3 p-3">
        {teams.multi && team && <TeamPicker value={team} onChange={setTeam} />}
        <BotAccess all={all} setAll={setAll} chosen={chosen} setChosen={setChosen} agents={agents} multi={teams.multi} />
        <Button
          size="sm"
          variant="primary"
          loading={busy}
          onClick={() =>
            run(async () => (await api.patch(`/memory/dossiers/${d.id}`, { agentIds: all ? null : chosen.filter((id) => agents.some((a) => a.id === id)), ...(teams.multi && team && team !== d.team?.id ? { teamId: team } : {}) }), reload()), 'Toegang voor bots opgeslagen')
          }
        >
          Opslaan
        </Button>
      </Card>
      <Card className="space-y-3 p-3">
        <CardHead as="h3" icon={Users} tone="rose" title="Mensen op deze server" hint="Gedeelde personen en hun bots kunnen dit dossier lezen. Je persoonlijke geheugen blijft privé." />
        {full.acl.length === 0 ? (
          <p className="text-sm text-muted">Nog met niemand gedeeld.</p>
        ) : (
          <ul className="divide-y divide-line text-sm">
            {full.acl.map((a: any) => (
              <li key={a.user_id} className="flex flex-wrap items-center gap-2 py-2">
                <span className="min-w-0 flex-1 truncate">
                  <span translate="no">{a.name}</span>{' '}
                  <span className="text-xs text-muted" translate="no">
                    {a.email}
                  </span>
                </span>
                <Badge>{a.role === 'edit' ? 'Bewerken' : 'Lezen'}</Badge>
                <Button size="sm" variant="ghost" onClick={() => run(async () => (await api.post(`/memory/dossiers/${d.id}/share`, { userId: a.user_id, revoke: true }), reload()), 'Toegang ingetrokken')}>
                  Intrekken
                </Button>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            run(async () => {
              await api.post(`/memory/dossiers/${d.id}/share`, { email, role });
              setEmail('');
              reload();
            }, 'Gedeeld');
          }}
        >
          <Input className="min-w-[200px] flex-1" type="email" placeholder="E-mailadres van een gebruiker op deze server" value={email} onChange={(e) => setEmail(e.target.value)} aria-label="E-mailadres" />
          <Select style={{ width: 'auto' }} value={role} onChange={(e) => setRole(e.target.value)} aria-label="Rechten">
            <option value="read">Lezen</option>
            <option value="edit">Bewerken</option>
          </Select>
          <Button type="submit" disabled={!email.includes('@')} loading={busy}>
            Delen
          </Button>
        </form>
      </Card>
      <Toggle checked={!!d.pinned} onChange={(v) => run(async () => (await api.patch(`/memory/dossiers/${d.id}`, { pinned: v }), reload()))} label="Bovenaan zetten" />
    </div>
  );
}

