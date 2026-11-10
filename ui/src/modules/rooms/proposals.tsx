import { useEffect, useState } from 'react';
import { ChevronDown, ChevronRight, MessageCircle, UserPlus } from 'lucide-react';
import { create } from 'zustand';
import { api, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import type { Message } from '../../lib/types';
import { BotAvatar } from '../../components/BotFace';
import { Badge, Button, Spinner, cx, timeAgo, toast, toastError } from '../../components/ui';

/**
 * Hire proposals of a group's lead ("stel een nieuw lid voor", server: rooms/board.ts propose/decide).
 * One card, three places: Wacht op jou, the group chat (as the proposal event) and the Groepen page.
 * Nothing changes before the owner approves; the card says so.
 */

export interface Proposal {
  id: string;
  room_id: string | null;
  roomName: string | null;
  roomThreadId: string | null;
  kind: 'new' | 'existing';
  agent_id: string | null;
  profile: { name: string; role: string; description: string; instructions: string };
  reason: string;
  status: 'pending' | 'approved' | 'denied';
  proposer_agent_id: string;
  proposerName: string;
  proposerAvatar: string;
  ownerName: string;
  canDecide: boolean;
  decidedByName: string | null;
  decided_at: string | null;
  result_agent_id: string | null;
  resultName: string | null;
  created_at: string;
}

// ---------------------------------------------------------------- shared store (inbox count + cards)

interface ProposalState {
  /** Open proposals of the signed-in owner (for Wacht op jou and the badge). */
  pending: Proposal[];
  loaded: boolean;
  /** Every proposal a card has looked at, by id (also decided ones, also from someone else's group). */
  byId: Record<string, Proposal>;
}

export const useProposals = create<ProposalState>(() => ({ pending: [], loaded: false, byId: {} }));

let timer: ReturnType<typeof setTimeout> | null = null;

function loadPending() {
  api
    .get<Proposal[]>('/rooms/proposals')
    .then((l) => {
      const list = Array.isArray(l) ? l : [];
      useProposals.setState((s) => ({ pending: list.filter((p) => p.status === 'pending'), loaded: true, byId: { ...s.byId, ...Object.fromEntries(list.map((p) => [p.id, p])) } }));
    })
    .catch(() => useProposals.setState({ loaded: true }));
}

async function loadOne(id: string): Promise<Proposal | null> {
  try {
    const p = await api.get<Proposal>(`/rooms/proposals/${id}`);
    useProposals.setState((s) => ({ byId: { ...s.byId, [id]: p }, pending: p.canDecide ? upsert(s.pending, p) : s.pending.filter((x) => x.id !== id) }));
    return p;
  } catch {
    return null;
  }
}

function upsert(list: Proposal[], p: Proposal) {
  return list.some((x) => x.id === p.id) ? list.map((x) => (x.id === p.id ? p : x)) : [p, ...list];
}

function remember(p: Proposal) {
  useProposals.setState((s) => ({ byId: { ...s.byId, [p.id]: p }, pending: p.status === 'pending' && p.canDecide ? upsert(s.pending, p) : s.pending.filter((x) => x.id !== p.id) }));
}

/** Subscribe once after login: open proposals stay live (new proposal, decided here or on another device). */
export function initProposals() {
  loadPending();
  const a = on('rooms.proposal', (d: { id?: string }) => {
    if (d?.id) void loadOne(d.id);
    if (timer) clearTimeout(timer);
    timer = setTimeout(loadPending, 300);
  });
  return () => a();
}

export function useProposalCount() {
  return useProposals((s) => s.pending.length);
}

async function decide(p: Proposal, approve: boolean) {
  const r = await api.post<Proposal>(`/rooms/proposals/${p.id}`, { decision: approve ? 'approve' : 'deny' });
  remember({ ...p, ...r, canDecide: false });
  if (approve) {
    await useApp.getState().refreshAgents();
    toast(p.kind === 'new' ? `${p.profile.name} is aangemaakt en doet mee in de groep` : `${p.profile.name} doet mee in de groep`, 'ok');
  } else toast('Voorstel afgewezen; er is niets veranderd', 'neutral');
}

// ---------------------------------------------------------------- the card

export function ProposalCard({ p, showRoom, className }: { p: Proposal; showRoom?: boolean; className?: string }) {
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const [open, setOpen] = useState(false);
  const pending = p.status === 'pending';
  const name = p.profile.name || 'Nieuw lid';
  const act = async (approve: boolean) => {
    setBusy(approve ? 'approve' : 'deny');
    try {
      await decide(p, approve);
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const room = p.roomName ? `“${p.roomName}”` : 'de groep';
  return (
    <div role="group" aria-label={`Voorstel: ${name} toevoegen aan ${p.roomName || 'de groep'}`} className={cx('w-full rounded-2xl border p-4', pending ? 'tb-ask' : 'border-line bg-surface', className)}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
        <BotAvatar bot={{ id: p.proposer_agent_id, name: p.proposerName, avatar: p.proposerAvatar }} size={20} mood={pending ? 'waiting' : 'idle'} />
        <span>
          <span className="font-semibold text-fg">{p.proposerName}</span> stelt een nieuw lid voor
        </span>
        <span aria-hidden>·</span>
        <span>{timeAgo(p.created_at)}</span>
        {showRoom && p.roomThreadId && (
          // The dot travels with the link, so a narrow screen never ends a line on a lone "·".
          <span className="whitespace-nowrap">
            <span aria-hidden>· </span>
            <a className="font-semibold underline underline-offset-2 hover:text-fg" href={`#/t/${p.roomThreadId}`}>
              naar {p.roomName ? `groep ${p.roomName}` : 'de groep'}
            </a>
          </span>
        )}
      </div>
      <div className="mt-2 flex items-start gap-2">
        <span className={cx('mt-[7px] h-2 w-2 shrink-0 rounded-full', pending ? 'bg-warn' : p.status === 'approved' ? 'bg-ok' : 'bg-muted')} aria-hidden />
        <div className="min-w-0 flex-1">
          <div className="break-words text-[15px] font-bold leading-snug">
            {name}
            {p.profile.role ? <span className="font-semibold text-muted"> · {p.profile.role}</span> : null} toevoegen aan {room}
          </div>
          <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[13px] text-muted">
            <Badge tone={p.kind === 'new' ? 'accent' : 'neutral'}>{p.kind === 'new' ? 'Nieuwe bot' : 'Bestaande bot'}</Badge>
            {pending && (
              <span>
                {p.kind === 'new'
                  ? `Bestaat pas na jouw akkoord. Krijgt dezelfde AI als ${p.proposerName}.`
                  : `${name} doet pas mee na jouw akkoord.`}
              </span>
            )}
          </div>
          {p.reason && (
            <p className="mt-2 whitespace-pre-wrap break-words text-[13.5px]">
              <span className="font-semibold">Waarom: </span>
              {p.reason}
            </p>
          )}
        </div>
      </div>
      {p.kind === 'new' && (p.profile.instructions || p.profile.description) && (
        <>
          <button className="mt-2 inline-flex min-h-8 items-center gap-1 text-xs font-semibold text-muted hover:text-fg coarse:min-h-11" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            {open ? 'Profiel verbergen' : 'Voorgesteld profiel bekijken'}
          </button>
          {open && (
            <div className="scroll-thin mt-1 max-h-60 space-y-1.5 overflow-auto rounded-xl bg-surface-2 p-3 text-[13px]">
              {p.profile.description && <p className="whitespace-pre-wrap break-words">{p.profile.description}</p>}
              {p.profile.instructions && (
                <p className="whitespace-pre-wrap break-words text-muted">
                  <span className="font-semibold text-fg">Instructies: </span>
                  {p.profile.instructions}
                </p>
              )}
            </div>
          )}
        </>
      )}
      {pending ? (
        p.canDecide ? (
          <div className="mt-3 flex flex-wrap gap-2">
            <Button variant="primary" size="sm" icon={<UserPlus className="h-3.5 w-3.5" />} loading={busy === 'approve'} disabled={!!busy} onClick={() => act(true)}>
              Goedkeuren
            </Button>
            <Button size="sm" variant="ghost" loading={busy === 'deny'} disabled={!!busy} onClick={() => act(false)}>
              Afwijzen
            </Button>
          </div>
        ) : (
          <p className="mt-3 text-[13px] text-muted">Wacht op goedkeuring van {p.ownerName}.</p>
        )
      ) : (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[13px]">
          <Badge tone={p.status === 'approved' ? 'ok' : 'neutral'}>{p.status === 'approved' ? 'Goedgekeurd' : 'Afgewezen'}</Badge>
          <span className="text-muted">
            {p.status === 'approved'
              ? `${p.decidedByName || p.ownerName} keurde het goed${p.decided_at ? ` (${timeAgo(p.decided_at)})` : ''}: ${p.resultName || name} doet mee.`
              : `${p.decidedByName || p.ownerName} wees het af${p.decided_at ? ` (${timeAgo(p.decided_at)})` : ''}. Er is niets veranderd.`}
          </span>
          {p.status === 'approved' && p.result_agent_id && (
            <a href={`#/a/${p.result_agent_id}`} className="inline-flex min-h-8 items-center gap-1 font-semibold underline underline-offset-2 coarse:min-h-11">
              <MessageCircle className="h-3.5 w-3.5" aria-hidden /> Chat met {p.resultName || name}
            </a>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------- the three places

/** In the group chat: the lead's proposal event becomes the card (approve/decline right there). */
export function ProposalEvent({ message }: { message: Message }) {
  const id = String(message.parts?.proposalId || '');
  const p = useProposals((s) => (id ? s.byId[id] : undefined));
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    if (!id) return;
    let alive = true;
    loadOne(id).then((r) => alive && !r && setMissing(true));
    return () => {
      alive = false;
    };
  }, [id]);
  if (!id || missing)
    return (
      <div className="flex justify-center px-4 py-2">
        <div className="max-w-xl rounded-full bg-surface-2 px-3 py-1 text-xs text-muted">{message.content}</div>
      </div>
    );
  return (
    <div className="px-4 py-2 sm:px-6">
      <div className="mx-auto max-w-xl">{p ? <ProposalCard p={p} /> : <div className="flex justify-center py-2"><Spinner /></div>}</div>
    </div>
  );
}

/** Section in "Wacht op jou": the owner's open proposals, across groups. */
export function ProposalsInbox() {
  const list = useProposals((s) => s.pending);
  if (!list.length) return null;
  return (
    <section aria-labelledby="inbox-proposals" className="space-y-3">
      <div className="flex items-end justify-between gap-3 pt-2">
        <h2 id="inbox-proposals" className="flex items-center gap-2 text-[15px] font-bold tracking-tight">
          <UserPlus className="h-4 w-4 text-muted" aria-hidden /> Nieuwe teamleden <span className="font-semibold tabular-nums text-muted">{list.length}</span>
        </h2>
        <a href="#/m/rooms/" className="text-[13px] font-semibold text-muted underline-offset-2 hover:text-fg hover:underline">
          Alle groepen
        </a>
      </div>
      {list.map((p) => (
        <ProposalCard key={p.id} p={p} showRoom />
      ))}
    </section>
  );
}

/** On the Groepen page: the same open proposals above the list of groups. */
export function ProposalsOnRoomsPage() {
  const list = useProposals((s) => s.pending);
  const loaded = useProposals((s) => s.loaded);
  useEffect(() => {
    if (!loaded) loadPending();
  }, [loaded]);
  if (!list.length) return null;
  return (
    <section aria-label="Voorstellen voor nieuwe teamleden" className="space-y-3">
      <h2 className="text-sm font-semibold">Voorstellen voor nieuwe teamleden</h2>
      {list.map((p) => (
        <ProposalCard key={p.id} p={p} showRoom />
      ))}
    </section>
  );
}
