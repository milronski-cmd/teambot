import { useEffect, useState } from 'react';
import { AppWindow, ExternalLink, FileText, Globe, KeyRound, PencilLine, Search, SquareTerminal, Trash2 } from 'lucide-react';
import { on } from '../../lib/api';
import { agentById, useApp } from '../../lib/store';
import { Badge, Card, EmptyState, Page, PageHeader, Select, Spinner, cx, timeAgo } from '../../components/ui';
import { FilePreviewModal, type PreviewSource } from '../../components/FilePreview';
import { BotAvatar } from '../../components/BotFace';
import { folderLink, seenApi, workspacePreview, type SeenFile, type SeenItem, type SeenView } from './api';

/** Load the view and refresh it when the bot finishes a turn. */
function useSeen(agentId: string | null | undefined, o: { threadId?: string; days?: number }) {
  const [data, setData] = useState<SeenView | null>(null);
  const [error, setError] = useState('');
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (!agentId) return;
    let live = true;
    seenApi.get(agentId, o).then(
      (d) => live && (setData(d), setError('')),
      (e) => live && setError(e?.message || String(e)),
    );
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agentId, o.threadId, o.days, tick]);
  useEffect(() => {
    if (!agentId) return;
    return on('run.updated', (r: any) => r?.agent_id === agentId && ['done', 'error', 'cancelled'].includes(r.status) && setTick((x) => x + 1));
  }, [agentId]);
  return { data, error };
}

function usePreview(agentId: string) {
  const [source, setSource] = useState<PreviewSource | null>(null);
  const [loading, setLoading] = useState('');
  const open = (f: SeenFile) => {
    setLoading(f.name);
    workspacePreview(agentId, f).then((s) => (setSource(s), setLoading('')));
  };
  const modal = <FilePreviewModal source={source} onClose={() => setSource(null)} />;
  return { open, modal, loading };
}

const dirOf = (rel: string | null) => (rel && rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '');

/** One file the bot touched: click = preview (only for files in its own folders that still exist). */
function FileRow({ agentId, f, onOpen, busy }: { agentId: string; f: SeenFile; onOpen(f: SeenFile): void; busy: boolean }) {
  const can = f.exists && f.root !== null;
  const inner = (
    <>
      <FileText className="h-4 w-4 shrink-0 text-muted" />
      <span className="min-w-0 flex-1">
        <span className="block truncate" translate="no">
          {f.name}
        </span>
        <span className="block truncate text-xs text-muted" translate="no">
          {can ? dirOf(f.rel) || 'werkmap' : f.root === null && f.target.includes('/') === false && f.target.includes('\\') === false ? 'naam uit een eerdere stap' : 'niet meer aanwezig'}
        </span>
      </span>
      {busy ? <Spinner className="h-3.5 w-3.5" /> : <span className="shrink-0 text-xs text-muted">{timeAgo(f.last)}</span>}
    </>
  );
  return (
    <li className="flex items-center gap-1">
      {can ? (
        <button type="button" aria-haspopup="dialog" onClick={() => onOpen(f)} className="flex min-w-0 flex-1 items-center gap-2 rounded-lg px-2 py-1.5 text-left text-sm hover:bg-surface-2 coarse:py-2.5">
          {inner}
        </button>
      ) : (
        <div className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1.5 text-sm opacity-70">{inner}</div>
      )}
      {can && (
        <a href={folderLink(agentId, f)} className="rounded-lg p-1.5 text-muted hover:bg-surface-2 hover:text-fg coarse:p-2.5" aria-label={`${f.name} openen in Bestanden`} title="Openen in Bestanden">
          <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
    </li>
  );
}

/** Side panel › Bestanden: files the bot created or changed in this conversation, with a preview. */
export function BotFilesInThread({ agentId, threadId, bare, onCount }: { agentId: string; threadId: string; /** Only the rows: no heading, and nothing at all while there are no files (the chat's side panel). */ bare?: boolean; /** How many files there are, once known. */ onCount?(n: number): void }) {
  const { data, error } = useSeen(agentId, { threadId });
  const pv = usePreview(agentId);
  const name = agentById(agentId)?.name || 'De bot';
  const files = data ? [...data.written, ...data.deleted.filter((d) => !data.written.some((w) => w.target === d.target))] : [];
  const count = data ? files.length : -1;
  useEffect(() => {
    if (count >= 0) onCount?.(count);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [count]);
  if (bare)
    return error ? (
      <p className="text-sm text-danger">{error}</p>
    ) : files.length ? (
      <>
        <ul className="space-y-0.5" aria-label={`Gemaakt of gewijzigd door ${name}`}>
          {files.map((f) => (
            <FileRow key={f.op + f.target} agentId={agentId} f={f} onOpen={pv.open} busy={pv.loading === f.name} />
          ))}
        </ul>
        {pv.modal}
      </>
    ) : null;
  return (
    <section aria-label={`Gemaakt of gewijzigd door ${name}`}>
      <div className="mb-1.5 text-[11.5px] font-bold uppercase tracking-wider text-muted">Gemaakt of gewijzigd door {name}</div>
      {error ? (
        <p className="text-sm text-danger">{error}</p>
      ) : !data ? (
        <Spinner />
      ) : files.length === 0 ? (
        <p className="text-sm text-muted">In dit gesprek heeft {name} nog geen bestanden gemaakt of gewijzigd.</p>
      ) : (
        <ul className="space-y-0.5">
          {files.map((f) => (
            <FileRow key={f.op + f.target} agentId={agentId} f={f} onOpen={pv.open} busy={pv.loading === f.name} />
          ))}
        </ul>
      )}
      {pv.modal}
    </section>
  );
}

const STATUS: Record<string, { label: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  approved: { label: 'toegestaan', tone: 'ok' },
  answered: { label: 'beantwoord', tone: 'ok' },
  denied: { label: 'geweigerd', tone: 'danger' },
  pending: { label: 'wacht op jou', tone: 'warn' },
  expired: { label: 'verlopen', tone: 'neutral' },
  cancelled: { label: 'ingetrokken', tone: 'neutral' },
};

function Section({ icon, title, count, children, empty }: { icon: React.ReactNode; title: string; count: number; children: React.ReactNode; empty: string }) {
  return (
    <Card className="p-4">
      <h2 className="mb-2 flex items-center gap-2 text-[14px] font-bold">
        <span className="text-muted">{icon}</span>
        {title}
        {count > 0 && <Badge>{count}</Badge>}
      </h2>
      {count === 0 ? <p className="text-sm text-muted">{empty}</p> : children}
    </Card>
  );
}

function ItemRow({ x, mono, href }: { x: SeenItem; mono?: boolean; href?: string }) {
  return (
    <li className="flex items-start gap-2 py-1 text-sm">
      <span className={cx('min-w-0 flex-1 break-words', mono && 'font-mono text-[12.5px]')} translate="no">
        {href ? (
          <a href={href} target="_blank" rel="noreferrer noopener" className="hover:underline">
            {x.target}
          </a>
        ) : (
          x.target
        )}
      </span>
      <span className="shrink-0 text-xs text-muted">
        {x.count > 1 ? `${x.count}× · ` : ''}
        <a href={`#/t/${x.threadId}`} className="hover:underline" title="Naar het gesprek">
          {timeAgo(x.last)}
        </a>
      </span>
    </li>
  );
}

/** #/m/seen/<agentId> — "Wat heeft deze bot gezien en gedaan" (from the chat menu). */
export function SeenPage({ params }: { params: string[] }) {
  const agentId = params[0] || '';
  const agent = useApp((s) => s.agents.find((a) => a.id === agentId));
  const [days, setDays] = useState(30);
  const { data, error } = useSeen(agent ? agentId : null, { days });
  const pv = usePreview(agentId);
  if (!agent) return <EmptyState title="Bot niet gevonden" action={<a className="text-sm font-semibold underline" href="#/agents">Naar alle bots</a>} />;
  const files = (list: SeenFile[], empty: string, icon: React.ReactNode, title: string) => (
    <Section icon={icon} title={title} count={list.length} empty={empty}>
      <ul className="space-y-0.5">
        {list.map((f) => (
          <FileRow key={f.op + f.target} agentId={agentId} f={f} onOpen={pv.open} busy={pv.loading === f.name} />
        ))}
      </ul>
    </Section>
  );
  const nothing = data && !data.steps && !data.approvals.length;
  return (
    <Page>
      <PageHeader
        title={`Wat ${agent.name} zag en deed`}
        subtitle="Uit de stappen van zijn antwoorden en de goedkeuringen. Alleen jij ziet dit."
        back={{ href: `#/a/${agent.id}`, label: `Terug naar ${agent.name}` }}
        width="3xl"
        actions={
          <Select aria-label="Periode" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            <option value={7}>Afgelopen week</option>
            <option value={30}>Afgelopen 30 dagen</option>
            <option value={90}>Afgelopen 90 dagen</option>
            <option value={365}>Afgelopen jaar</option>
          </Select>
        }
      />
      <div className="mx-auto max-w-3xl space-y-3 px-4 pb-8 pt-2 sm:px-6">
        <div className="flex items-center gap-3 rounded-2xl bg-surface-2 p-3 text-sm text-muted">
          <BotAvatar bot={agent} size={36} />
          <span>Bestanden, webpagina's, opdrachten en apps die {agent.name} gebruikte, met wat hij jou vroeg. Klik op een bestand voor een voorbeeld; de tijd brengt je naar het gesprek.</span>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        ) : !data ? (
          <div className="flex justify-center py-10">
            <Spinner />
          </div>
        ) : nothing ? (
          <EmptyState icon={<Search className="h-6 w-6" />} title="Nog niets gezien of gedaan">
            In deze periode heeft {agent.name} geen bestanden, webpagina's, opdrachten of apps gebruikt.
          </EmptyState>
        ) : (
          <>
            {files(data.written, 'Geen bestanden geschreven of gewijzigd.', <PencilLine className="h-4 w-4" />, 'Bestanden geschreven of gewijzigd')}
            {files(data.read, 'Geen bestanden gelezen.', <FileText className="h-4 w-4" />, 'Bestanden gelezen')}
            {data.deleted.length > 0 && files(data.deleted, '', <Trash2 className="h-4 w-4" />, 'Bestanden verwijderd')}
            <Section icon={<Globe className="h-4 w-4" />} title="Webpagina's bezocht" count={data.pages.length + data.searches.length} empty="Geen webpagina's bezocht en niets opgezocht.">
              <ul className="divide-y divide-line">
                {data.pages.map((x) => (
                  <ItemRow key={x.target} x={x} href={/^https?:\/\//i.test(x.target) ? x.target : undefined} />
                ))}
                {data.searches.map((x) => (
                  <ItemRow key={'q' + x.target} x={{ ...x, target: `Gezocht: ${x.target}` }} />
                ))}
              </ul>
            </Section>
            <Section icon={<SquareTerminal className="h-4 w-4" />} title="Opdrachten uitgevoerd" count={data.commands.length} empty="Geen opdrachten uitgevoerd.">
              <ul className="divide-y divide-line">
                {data.commands.map((x) => (
                  <ItemRow key={x.target} x={x} mono />
                ))}
              </ul>
            </Section>
            <Section icon={<AppWindow className="h-4 w-4" />} title="Apps gebruikt" count={data.apps.length} empty="Geen gekoppelde apps gebruikt.">
              <ul className="divide-y divide-line">
                {data.apps.map((x) => (
                  <ItemRow key={x.target} x={x} />
                ))}
              </ul>
            </Section>
            <Section icon={<KeyRound className="h-4 w-4" />} title="Gevraagd om toestemming" count={data.approvals.length} empty="Niets gevraagd.">
              <ul className="divide-y divide-line">
                {data.approvals.map((a) => (
                  <li key={a.id} className="flex items-start gap-2 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 break-words">{a.summary}</span>
                    <Badge tone={STATUS[a.status]?.tone || 'neutral'}>{STATUS[a.status]?.label || a.status}</Badge>
                    <span className="shrink-0 text-xs text-muted">{a.threadId ? <a href={`#/t/${a.threadId}`} className="hover:underline">{timeAgo(a.at)}</a> : timeAgo(a.at)}</span>
                  </li>
                ))}
              </ul>
            </Section>
          </>
        )}
      </div>
      {pv.modal}
    </Page>
  );
}
