import { useEffect, useState } from 'react';
import { Copy, Undo2 } from 'lucide-react';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatDateTime } from '../../lib/format';
import { Badge, Button, Card, Field, Select, Textarea, toast, useAsync } from '../../components/ui';
import { ALL_TEAMS, defaultTeamFor, memPath, useMemTeams, useTeamFilter } from './lib';

/**
 * "Geheugen overnemen uit ChatGPT, Claude of Gemini" (0.4.4; server/modules/memory/assistant-import.ts): the question
 * to ask there, paste the answer, a preview that writes nothing, then every new fact as a proposal (Te beoordelen),
 * and undo of the whole import.
 */

type Status = 'new' | 'duplicate' | 'repeat' | 'secret' | 'blocked' | 'rejected_before';
interface Preview {
  total: number;
  counts: Record<Status, number>;
  lines: { content: string; status: Status; instructionLike?: boolean }[];
}
interface Recent {
  batch: string;
  label: string;
  at: string;
  open: number;
  active: number;
}

const STATUS: Record<Status, { label: string; tone: 'ok' | 'neutral' | 'warn' | 'danger' }> = {
  new: { label: 'Nieuw', tone: 'ok' },
  duplicate: { label: 'Staat er al', tone: 'neutral' },
  repeat: { label: 'Dubbel in de tekst', tone: 'neutral' },
  secret: { label: 'Geheim: overgeslagen', tone: 'danger' },
  blocked: { label: 'Eerder vergeten', tone: 'warn' },
  rejected_before: { label: 'Eerder afgewezen', tone: 'warn' },
};

/** The question the owner asks in the other assistant (in his own language through the dictionaries). */
export const ASSISTANT_QUESTION =
  'Schrijf alles op wat je over mij weet uit onze gesprekken en uit je geheugen. Zet elk feit op een eigen regel die begint met "- ", kort en duidelijk, onder de kopjes Over mij, Werk, Voorkeuren, Mensen en Instructies. Laat wachtwoorden, codes en andere geheimen weg. Geef alleen de lijst, zonder inleiding of afsluiting.';

export function AssistantImport() {
  const [text, setText] = useState('');
  const [source, setSource] = useState('chatgpt');
  const [scope, setScope] = useState('about_you');
  const teams = useMemTeams();
  const [teamFilter] = useTeamFilter();
  const [teamId, setTeam] = useState('');
  const team = teamId || defaultTeamFor(teamFilter, teams);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [done, setDone] = useState<{
    batch: string;
    proposed: number;
    label: string;
  } | null>(null);
  const [recent, setRecent] = useState<Recent[]>([]);
  const { run, busy } = useAsync();
  const loadRecent = () =>
    api
      .get<Recent[]>('/memory/import/recent')
      .then(setRecent)
      .catch(() => setRecent([]));
  useEffect(() => void loadRecent(), []);
  const body = () => ({
    text,
    source,
    scope,
    ...(scope === 'shared' && teams.multi && team ? { teamId: team } : {}),
  });

  const copy = () =>
    run(async () => {
      await navigator.clipboard.writeText(t(ASSISTANT_QUESTION));
      toast('Vraag gekopieerd', 'ok');
    });
  const look = () => run(async () => setPreview(await api.post<Preview>('/memory/import/preview', body())));
  const doImport = () =>
    run(async () => {
      const r = await api.post<any>('/memory/import/assistant', body());
      setDone({ batch: r.batch, proposed: r.proposed, label: r.label });
      setPreview(null);
      setText('');
      loadRecent();
    });
  const undo = (batch: string) =>
    run(async () => {
      const r = await api.post<{ removed: number; kept: number }>(`/memory/import/${batch}/undo`, {});
      toast(
        r.kept
          ? t('{0, plural, one {# herinnering weggehaald} other {# herinneringen weggehaald}}; {1} bleven staan.', r.removed, r.kept)
          : t('{0, plural, one {# herinnering weggehaald} other {# herinneringen weggehaald}}', r.removed),
        'ok',
      );
      if (done?.batch === batch) setDone(null);
      loadRecent();
    });

  return (
    <Card className="space-y-3 p-4 lg:col-span-2">
      <h2 className="text-sm font-semibold">Geheugen overnemen uit ChatGPT, Claude of Gemini</h2>
      <ol className="list-decimal space-y-3 ps-5 text-sm">
        <li className="space-y-2">
          <span>Stel deze vraag in de andere assistent:</span>
          <blockquote className="rounded-lg border border-line bg-surface-2 px-3 py-2 text-sm">{t(ASSISTANT_QUESTION)}</blockquote>
          <Button size="sm" icon={<Copy className="h-4 w-4" />} onClick={copy}>
            Kopieer de vraag
          </Button>
        </li>
        <li className="space-y-2">
          <span>
            Plak het antwoord hieronder. Je ziet eerst een voorbeeld; daarna wordt elk nieuw feit een voorstel bij Te beoordelen. Er wordt niets direct actief, en wachtwoorden en codes worden
            overgeslagen.
          </span>
          <div className="flex flex-wrap gap-2">
            <Field label="Uit">
              <Select value={source} onChange={(e) => setSource(e.target.value)} className="w-auto" aria-label="Uit welke assistent">
                <option value="chatgpt">ChatGPT</option>
                <option value="claude">Claude</option>
                <option value="gemini">Gemini</option>
                <option value="other">Een andere assistent</option>
              </Select>
            </Field>
            <Field label="Waarheen">
              <Select value={scope} onChange={(e) => setScope(e.target.value)} className="w-auto" aria-label="Waarheen">
                <option value="about_you">Over jou</option>
                <option value="shared">{teams.multi ? 'Gedeeld met de bots van een team' : 'Gedeeld met al je bots'}</option>
              </Select>
            </Field>
            {scope === 'shared' && teams.multi && (
              <Field label="Team">
                <Select value={team} onChange={(e) => setTeam(e.target.value)} className="w-auto" aria-label="Team">
                  {teams.teams.map((x) => (
                    <option key={x.id} value={x.id} translate="no">
                      {x.name}
                    </option>
                  ))}
                  <option value={ALL_TEAMS}>Alle teams</option>
                </Select>
              </Field>
            )}
          </div>
          <Textarea
            rows={7}
            value={text}
            onChange={(e) => (setText(e.target.value), setPreview(null))}
            placeholder={'- Woont in Utrecht\n- Houdt van korte antwoorden'}
            aria-label="Antwoord van de andere assistent"
          />
          <div className="flex flex-wrap gap-2">
            <Button loading={busy} disabled={!text.trim()} onClick={look}>
              Voorbeeld bekijken
            </Button>
            {preview && (
              <Button variant="primary" loading={busy} disabled={!preview.counts.new} onClick={doImport}>
                {t('{0, plural, one {# voorstel klaarzetten} other {# voorstellen klaarzetten}}', preview.counts.new)}
              </Button>
            )}
          </div>
        </li>
      </ol>
      {preview && (
        <div className="space-y-2">
          <p className="text-sm text-muted">
            {t(
              '{0, plural, one {# regel gelezen} other {# regels gelezen}}: {1} nieuw, {2} stond er al, {3} overgeslagen.',
              preview.total,
              preview.counts.new,
              preview.counts.duplicate + preview.counts.repeat,
              preview.counts.secret + preview.counts.blocked + preview.counts.rejected_before,
            )}
          </p>
          {preview.total === 0 && <p className="text-sm text-warn">Geen feiten gevonden. Plak het antwoord van de assistent: een lijst met één feit per regel.</p>}
          <ul className="max-h-80 divide-y divide-line overflow-y-auto rounded-lg border border-line text-sm">
            {preview.lines.map((l, i) => (
              <li key={i} className="flex items-start justify-between gap-2 px-3 py-1.5">
                <span className={l.status === 'new' ? '' : 'text-muted'}>
                  {l.content}
                  {l.instructionLike && <span className="block text-xs text-warn">Leest als een opdracht; het wordt bewaard als gewone tekst.</span>}
                </span>
                <Badge tone={STATUS[l.status].tone} className="shrink-0">
                  {STATUS[l.status].label}
                </Badge>
              </li>
            ))}
          </ul>
        </div>
      )}
      {done && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg bg-surface-2 p-2 text-sm">
          <span>{t('{0, plural, one {# voorstel} other {# voorstellen}} uit {1} klaargezet.', done.proposed, done.label)}</span>
          <a className="text-accent hover:underline" href={memPath('beoordelen')}>
            Naar Te beoordelen
          </a>
          <Button size="sm" variant="ghost" icon={<Undo2 className="h-4 w-4" />} loading={busy} onClick={() => undo(done.batch)}>
            Ongedaan maken
          </Button>
        </div>
      )}
      {recent.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-semibold uppercase tracking-wide text-muted">Eerdere imports</div>
          <ul className="divide-y divide-line text-sm">
            {recent.map((r) => (
              <li key={r.batch} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                <span>
                  {r.label ? `${formatDateTime(r.at)} · ${r.label}` : formatDateTime(r.at)} · <span className="text-muted">{t('{0} te beoordelen, {1} goedgekeurd', r.open, r.active)}</span>
                </span>
                <Button size="sm" variant="ghost" icon={<Undo2 className="h-4 w-4" />} loading={busy} onClick={() => undo(r.batch)}>
                  Ongedaan maken
                </Button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </Card>
  );
}
