import { useMemo, useState } from 'react';
import { Download, Eye, Puzzle, Share2, Store, Upload } from 'lucide-react';
import { Badge, Button, Modal, Spinner, Toggle, toast, useAsync } from '../../components/ui';
import { api, authUrl } from '../../lib/api';
import { navigate } from '../../lib/router';
import { t } from '../../lib/i18n';
import type { Agent, Message, ToolCall } from '../../lib/types';
import { ScanBadge, shareToast } from './common';
import { ImportDialog } from './ImportDialog';
import { useSkills } from './MySkills';
import { useTeamStore } from '../teams/scope';
import { homeMap } from '../../shell/teamFilter';
import { firstSentence } from '../../lib/sentence';

/** Bot editor section: enable/disable skills per bot (saved together with the bot). */
export function AgentSkillsSection({ agent, onChange }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  const { list, error, reload } = useSkills();
  const [importing, setImporting] = useState(false);
  const enabled = agent.skills || [];
  // Package B4: from two teams on, the skills of the bot's own team and those for all teams (one it already has from
  // another team stays visible with that team's name; the server only lets it read such a skill with meekijken).
  const teams = useTeamStore((s) => s.teams);
  const home = teams.length > 1 ? (agent.id ? homeMap(teams).get(agent.id) : undefined) || (agent as any).settings?.homeTeam || teams[0]?.id : undefined;
  const usable = useMemo(() => (list || []).filter((s) => s.status !== 'draft' && (!home || s.allTeams || !s.teamId || s.teamId === home || enabled.includes(s.id))), [list, home, enabled]);
  const toggle = (id: string, on: boolean) => onChange({ skills: on ? [...new Set([...enabled, id])] : enabled.filter((x) => x !== id) });
  const groupOff = !(agent.tool_groups || []).includes('skills');

  if (error)
    return (
      <div className="text-sm text-danger">
        Kon skills niet laden: {error}{' '}
        <Button size="sm" variant="ghost" onClick={reload}>
          Opnieuw
        </Button>
      </div>
    );
  if (!list) return <Spinner />;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        De bot laadt de instructies van een skill pas als een taak erom vraagt. Wijzigingen worden bewaard met opslaan.
      </p>
      {groupOff && enabled.length > 0 && (
        <p className="rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">De toolgroep “Skills” staat uit voor deze bot; alle instructies komen dan in de prompt (meer tokens).</p>
      )}
      {!usable.length ? (
        <div className="rounded-xl border border-dashed border-line px-4 py-6 text-center text-sm">
          <Puzzle className="mx-auto mb-2 h-6 w-6 text-muted" />
          <p className="text-muted">Je hebt nog geen skills.</p>
          <div className="mt-3 flex flex-wrap justify-center gap-2">
            <Button size="sm" variant="primary" icon={<Store className="h-4 w-4" />} onClick={() => navigate('/m/skills/skills')}>
              Marktplaats
            </Button>
            <Button size="sm" icon={<Upload className="h-4 w-4" />} onClick={() => setImporting(true)}>
              Importeren
            </Button>
          </div>
        </div>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {usable.map((s) => {
            const on = enabled.includes(s.id);
            return (
              <li key={s.id} className="flex items-start gap-3 px-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-1.5 text-sm">
                    <span className="font-medium">{s.name}</span>
                    {s.version && <Badge>v{s.version}</Badge>}
                    {s.status === 'disabled' && <Badge>Uitgeschakeld</Badge>}
                    {home && s.teamId && s.teamId !== home && (
                      <Badge tone="warn">
                        <span translate="no">{s.teamName}</span>
                      </Badge>
                    )}
                    {s.kind === 'scripts' && <Badge tone={s.trusted ? 'ok' : 'warn'}>{s.trusted ? 'Scripts vertrouwd' : 'Scripts geblokkeerd'}</Badge>}
                    {(s.scanLevel === 'warn' || s.scanLevel === 'danger') && <ScanBadge level={s.scanLevel} />}
                  </div>
                  <p className="line-clamp-1 text-xs text-muted">{firstSentence(s.description)}</p>
                </div>
                <a href={`#/m/skills/mine/${s.id}`} className="mt-0.5 rounded p-1 text-muted hover:text-fg" aria-label={`${s.name} bekijken`} title="Bekijken">
                  <Eye className="h-4 w-4" />
                </a>
                <Toggle checked={on} disabled={s.status !== 'active'} onChange={(v) => toggle(s.id, v)} label={<span className="sr-only">{`${s.name} ${on ? 'uitschakelen' : 'inschakelen'}`}</span>} />
              </li>
            );
          })}
        </ul>
      )}
      {usable.length > 0 && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="ghost" icon={<Store className="h-4 w-4" />} onClick={() => navigate('/m/skills/skills')}>
            Meer skills
          </Button>
          <Button size="sm" variant="ghost" icon={<Upload className="h-4 w-4" />} onClick={() => setImporting(true)}>
            Importeren
          </Button>
        </div>
      )}
      <ImportDialog open={importing} onClose={() => setImporting(false)} />
    </div>
  );
}

/** Bot editor section: export the bot as a template file or share it on this server. */
export function AgentTemplateSection({ agent }: { agent: Agent; onChange(patch: Partial<Agent>): void }) {
  const [preview, setPreview] = useState<null | { template: any; warnings: string[] }>(null);
  const { busy, run } = useAsync();
  if (!agent.id) return <p className="text-sm text-muted">Sla de bot eerst op; daarna kun je hem als sjabloon exporteren of delen.</p>;
  return (
    <div className="space-y-3">
      <p className="text-sm text-muted">
        Een sjabloon bevat instructies, rol, uiterlijk, toolgroepen, toegangsmodus, ingeschakelde skills en (als die module er is) routinedefinities. Nooit mee: gesprekken, geheugen, bestanden in de werkmap, sleutels en de provider/het model.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button size="sm" icon={<Download className="h-4 w-4" />} loading={busy} onClick={() => run(async () => setPreview(await api.get(`/skills/templates/export/${agent.id}?preview=1`)))}>
          Exporteren als bestand
        </Button>
        <Button size="sm" icon={<Share2 className="h-4 w-4" />} loading={busy} onClick={() => run(async () => toast(shareToast(await api.post<{ status: string }>('/skills/shares', { type: 'bot', agentId: agent.id })), 'ok'))}>
          Delen op deze server
        </Button>
      </div>
      <Modal
        open={!!preview}
        onClose={() => setPreview(null)}
        title="Sjabloon exporteren"
        footer={
          <a
            className="inline-flex h-9 items-center gap-2 rounded-lg bg-accent px-3.5 text-sm font-medium text-accent-fg hover:opacity-90"
            href={authUrl(`/skills/templates/export/${agent.id}`)}
            onClick={() => {
              toast('Download gestart', 'ok');
              setPreview(null);
            }}
          >
            <Download className="h-4 w-4" /> Downloaden
          </a>
        }
      >
        {preview && (
          <div className="space-y-2 text-sm">
            <p>
              <span className="font-medium">{preview.template.name}</span>{' '}
              {preview.template.routines?.length
                ? t('met {0, plural, one {# skill} other {# skills}} en {1, plural, one {# routine} other {# routines}}.', preview.template.skills.length, preview.template.routines.length)
                : t('met {0, plural, one {# skill} other {# skills}}.', preview.template.skills.length)}
            </p>
            {preview.warnings.length > 0 ? (
              <ul className="list-disc ps-5 text-warn">
                {preview.warnings.map((w, i) => (
                  <li key={i}>{w}</li>
                ))}
              </ul>
            ) : (
              <p className="text-muted">Geen geheimen gevonden in de instructies of skills.</p>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}

/** Extra content under a skill_draft tool card in the chat. */
export function SkillDraftRenderer({ call }: { call: ToolCall; message: Message }) {
  if (call.status !== 'done') return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span>
        Skillconcept <span className="font-medium">{String(call.args?.name || '')}</span> wacht op jouw beoordeling.
      </span>
      <a href="#/m/skills/mine/concepten" className="font-medium text-accent underline">
        Beoordelen
      </a>
    </div>
  );
}
