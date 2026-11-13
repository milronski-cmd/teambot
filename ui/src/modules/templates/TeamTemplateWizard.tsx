import { useEffect, useMemo, useState } from 'react';
import { ArrowLeft, TriangleAlert } from 'lucide-react';
import { api } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { Badge, Button, Spinner, Toggle, cx } from '../../components/ui';
import { BotAvatar, StackedFaces } from '../../components/BotFace';
import { loadTeams } from '../teams/scope';

/**
 * A team from a template (package R): pick a template, see in one screen what you get (the bots, one line each, and
 * who leads), and one button makes the team at once. No form: the profile starts empty and your main bot (hoofdbot,
 * made in the same step when you have none) asks the template's questions in the chat, where you land afterwards.
 * Self-contained, so "Team uit een sjabloon" and the first-run screen place it as is. Server: /api/team-templates
 * (server/modules/templates).
 */

interface TemplateBot {
  name: string;
  role: string;
  description: string;
  avatar: string;
  groupRole: 'lead' | 'member';
  specialist: { field: string } | null;
}
export interface TeamTemplateSummary {
  id: string;
  name: string;
  description: string;
  note: string;
  category: 'bedrijf' | 'prive' | 'algemeen';
  minimal: boolean;
  bots: TemplateBot[];
  examples: { task: string; done: string }[];
  routines: number;
  skills: number;
}
/** Only what the one screen needs from the preview: skill warnings that must be read before installing. */
interface Preview {
  needsAcknowledge: boolean;
  warnings: string[];
  /** The access level each bot really starts with (server: ownStartAccess). */
  bots: { name: string; access_mode: string }[];
}

/** What the bots of the new team may do by themselves, in one plain sentence. */
function accessLine(bots: Preview['bots']): string {
  const working = bots.filter((b) => b.access_mode !== 'readonly' && b.access_mode !== 'chat');
  if (!working.length) return '';
  if (working.every((b) => b.access_mode === 'full')) return 'De bots doen hun werk zelf, ook versturen en publiceren. Alleen bij geld en belangrijke berichten vragen ze het je eerst.';
  if (working.every((b) => b.access_mode === 'auto' || b.access_mode === 'full')) return 'De bots doen hun gewone werk zelf. Voor versturen, publiceren en betalen vragen ze het je eerst.';
  return 'De bots vragen je toestemming voordat ze iets wijzigen of versturen.';
}
export interface TeamCreated {
  teamId: string | null;
  roomId: string;
  /** The chat to open: the main bot's chat, where it starts with its questions; without a main bot the team chat. */
  threadId: string;
  /** The team's own group chat. */
  roomThreadId: string;
  agents: { id: string; name: string; role: 'lead' | 'member' }[];
  lead: { id: string; name: string } | null;
  /** The owner's main bot; `created` when it was made together with this team. */
  main: { id: string; name: string; created: boolean } | null;
  warnings: string[];
}

const GROUPS: { id: TeamTemplateSummary['category']; title: string }[] = [
  { id: 'bedrijf', title: 'Voor je bedrijf' },
  { id: 'prive', title: 'Privé' },
  { id: 'algemeen', title: 'Algemeen' },
];

function Cards({ list, onChoose }: { list: TeamTemplateSummary[]; onChoose(id: string): void }) {
  return (
    <div className="space-y-4">
      {GROUPS.map((g) => {
        const items = list.filter((t) => t.category === g.id);
        if (!items.length) return null;
        return (
          <section key={g.id} className="space-y-2">
            <h3 className="text-[13px] font-semibold text-muted">{g.title}</h3>
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3" role="list" aria-label={g.title}>
              {items.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="listitem"
                  data-testid={`team-template-${t.id}`}
                  onClick={() => onChoose(t.id)}
                  className={cx('flex flex-col items-start gap-2 rounded-xl border border-line p-3 text-start text-sm hover:bg-surface-2')}
                >
                  <StackedFaces bots={t.bots.map((b) => ({ name: b.name, avatar: b.avatar }))} size={40} />
                  <span className="font-semibold">{t.name}</span>
                  <span className="text-xs text-muted">{t.description}</span>
                </button>
              ))}
            </div>
          </section>
        );
      })}
    </div>
  );
}

/**
 * `onCreated` gets the new team; `threadId` in it is the chat to open (default: open it). `category` shows only one
 * group of templates (for example the first-run screen with only the business templates). `prepare` (first-run
 * screen) connects the AI found on this pc when no AI was chosen, just before the team is made.
 */
export function TeamTemplateWizard({
  category,
  onCreated,
  onCancel,
  prepare,
}: {
  category?: TeamTemplateSummary['category'];
  onCreated?(r: TeamCreated): void;
  onCancel?(): void;
  prepare?(): Promise<{ id: string } | null>;
}) {
  const providers = useApp((s) => s.providers);
  const settings = useApp((s) => s.settings);
  const [list, setList] = useState<TeamTemplateSummary[] | null>(null);
  const [err, setErr] = useState('');
  const [chosen, setChosen] = useState<string | null>(null);
  const [ack, setAck] = useState(false);
  const [pv, setPv] = useState<Preview | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<TeamTemplateSummary[]>('/team-templates')
      .then((x) => setList(category ? x.filter((t) => t.category === category) : x))
      .catch((e) => setErr(e.message));
  }, [category]);
  const tpl = useMemo(() => list?.find((t) => t.id === chosen) || null, [list, chosen]);
  // The suggested catalogue skills come along; only a warning about one of them asks for a tick first.
  const withSkills = !!tpl?.skills;

  const choose = (id: string) => {
    setChosen(id);
    setPv(null);
    setAck(false);
    setErr('');
    const t = list?.find((x) => x.id === id);
    api
      .post<Preview>(`/team-templates/${id}/preview`, { skills: !!t?.skills })
      .then((x) => setPv(x))
      .catch(() => undefined);
  };
  const create = async () => {
    if (!tpl) return;
    setBusy(true);
    setErr('');
    const from = location.hash;
    try {
      let prov = settings.defaultProvider || providers[0]?.id || '';
      if (!prov && prepare) prov = (await prepare())?.id || '';
      // `intake`: the main bot starts in its own chat with the questions of this template.
      const r = await api.post<Omit<TeamCreated, 'roomThreadId'> & { chat: { threadId: string } | null }>(`/team-templates/${tpl.id}/install`, { skills: withSkills, provider_id: prov || undefined, acknowledge: ack, intake: true });
      await Promise.all([useApp.getState().refreshAgents(), useApp.getState().refreshThreads(), loadTeams()]);
      const made: TeamCreated = { ...r, roomThreadId: r.threadId, threadId: r.chat?.threadId || r.threadId };
      if (onCreated) onCreated(made);
      else navigate(`/t/${made.threadId}`, { from });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!list) return err ? <p role="alert" className="text-sm text-danger">{err}</p> : <Spinner />;

  return (
    <div className="space-y-4">
      {!tpl && (
        <>
          <Cards list={list} onChoose={choose} />
          {onCancel && (
            <div className="flex flex-wrap justify-end gap-2">
              <Button onClick={onCancel}>Annuleren</Button>
            </div>
          )}
        </>
      )}

      {tpl && (
        <>
          <div>
            <div className="font-semibold">{tpl.name}</div>
            <p className="text-sm text-muted">{tpl.description}</p>
          </div>
          <ul className="space-y-2" aria-label="Bots in dit team" data-testid="team-template-bots">
            {tpl.bots.map((b) => (
              <li key={b.name} className="flex items-start gap-3 rounded-xl border border-line p-3">
                <BotAvatar bot={{ name: b.name, avatar: b.avatar }} size={40} />
                <div className="min-w-0 flex-1 text-sm">
                  <div className="flex flex-wrap items-center gap-1.5">
                    <span className="font-semibold" translate="no">
                      {b.name}
                    </span>
                    {b.groupRole === 'lead' && <Badge tone="accent">teamleider</Badge>}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">{b.description || b.role}</div>
                </div>
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted">
            Je hoeft niets in te vullen. Je hoofdbot stelt je daarna in de chat een paar korte vragen over dit team.
            {tpl.routines > 0 && ' Routines staan uit tot jij ze aanzet.'}
          </p>
          {pv && accessLine(pv.bots) && (
            <p className="text-xs text-muted" data-testid="team-template-access">
              {accessLine(pv.bots)}
            </p>
          )}
          {tpl.note && <p className="text-xs text-muted">{tpl.note}</p>}
          {pv && pv.warnings.length > 0 && (
            <div className="space-y-1 rounded-xl bg-warn-soft p-3 text-xs text-warn" role="status">
              {pv.warnings.slice(0, 8).map((w) => (
                <div key={w} className="flex gap-1.5">
                  <TriangleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden /> {w}
                </div>
              ))}
            </div>
          )}
          {pv?.needsAcknowledge && <Toggle checked={ack} onChange={setAck} label="Ik heb de waarschuwingen bij de skills gelezen" />}
          <div className="flex flex-wrap justify-between gap-2">
            <Button icon={<ArrowLeft className="h-4 w-4 rtl-flip" />} onClick={() => setChosen(null)}>
              Terug
            </Button>
            <Button variant="primary" loading={busy} disabled={!!pv?.needsAcknowledge && !ack} onClick={create} data-testid="team-template-create">
              Team maken
            </Button>
          </div>
        </>
      )}
      {err && <p role="alert" className="text-sm text-danger">{err}</p>}
    </div>
  );
}
