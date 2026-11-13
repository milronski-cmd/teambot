import { useEffect, useState } from 'react';
import { CloudOff, Copy, Send, Trash2 } from 'lucide-react';
import { on, wsConnected } from '../../lib/api';
import { useApp } from '../../lib/store';
import { navigate } from '../../lib/router';
import { Badge, Button, Card, EmptyState, Page, PageHeader, timeAgo, toast, toastError, copyText } from '../../components/ui';
import { deliver, removeDraft, useDrafts, type Draft } from './drafts';

function useOnline() {
  const [online, setOnline] = useState(wsConnected);
  useEffect(() => {
    const off = on('ws.status', (s: any) => setOnline(!!s?.connected));
    return () => {
      off();
    };
  }, []);
  return online;
}

/** Messages that did not reach the host. Shown until the user sends or deletes them. */
export function DraftsPage() {
  const drafts = useDrafts();
  const threads = useApp((s) => s.threads);
  const online = useOnline();
  const [busy, setBusy] = useState<string | null>(null);

  const send = async (d: Draft) => {
    setBusy(d.id);
    try {
      await deliver(d);
      toast('Afgeleverd', 'ok');
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(null);
    }
  };
  const sendAll = async () => {
    for (const d of drafts) {
      setBusy(d.id);
      try {
        await deliver(d);
      } catch (e) {
        toastError(e);
        break;
      }
    }
    setBusy(null);
  };
  const title = (id: string) => threads.find((t) => t.id === id)?.title || 'Gesprek';

  return (
    <Page>
      <PageHeader width="3xl"
        title="Concepten"
        subtitle="Berichten die TeamBot nog niet hebben bereikt. Ze staan alleen op dit apparaat."
        actions={
          drafts.length > 1 ? (
            <Button variant="primary" disabled={!online || !!busy} onClick={sendAll} icon={<Send className="h-4 w-4" />}>
              Alles versturen
            </Button>
          ) : undefined
        }
      />
      <div className="mx-auto max-w-3xl space-y-3 px-4 py-4 sm:px-6">
        {!online && drafts.length > 0 && (
          <div className="flex items-center gap-2 rounded-lg bg-warn-soft px-3 py-2 text-sm text-warn">
            <CloudOff className="h-4 w-4 shrink-0" aria-hidden />
            TeamBot is nu niet bereikbaar. Versturen kan zodra de verbinding terug is.
          </div>
        )}
        {!drafts.length && (
          <EmptyState icon={<CloudOff className="h-8 w-8" />} title="Geen concepten">
            Berichten die niet aankomen, blijven hier tot je ze opnieuw verstuurt.
          </EmptyState>
        )}
        {drafts.map((d) => (
          <Card key={d.id} className="space-y-2 p-3">
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <Badge tone="warn">Nog niet afgeleverd</Badge>
              <button className="font-medium text-accent hover:underline" onClick={() => navigate(`/t/${d.threadId}`)}>
                {title(d.threadId)}
              </button>
              <span className="text-xs text-muted">{timeAgo(d.createdAt)}</span>
            </div>
            <p className="whitespace-pre-wrap break-words text-sm">{d.content}</p>
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="primary" loading={busy === d.id} disabled={!online || (!!busy && busy !== d.id)} onClick={() => send(d)} icon={<Send className="h-3.5 w-3.5" />}>
                Nu versturen
              </Button>
              <Button
                size="sm"
                variant="ghost"
                onClick={() => void copyText(d.content)}
                icon={<Copy className="h-3.5 w-3.5" />}
              >
                Kopiëren
              </Button>
              <Button size="sm" variant="ghost" onClick={() => removeDraft(d.id)} icon={<Trash2 className="h-3.5 w-3.5" />}>
                Verwijderen
              </Button>
            </div>
          </Card>
        ))}
      </div>
    </Page>
  );
}

/** Composer badge: only visible when this chat has undelivered drafts. */
export function DraftBadge({ threadId }: { threadId: string }) {
  const drafts = useDrafts(threadId);
  if (!drafts.length) return null;
  return (
    <Button size="sm" variant="ghost" className="text-warn" onClick={() => navigate('/m/mobile/concepten')} icon={<CloudOff className="h-4 w-4" />} title="Berichten die nog niet zijn afgeleverd">
      {drafts.length} niet afgeleverd
    </Button>
  );
}
