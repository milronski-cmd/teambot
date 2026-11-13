import { useEffect, useMemo, useState } from 'react';
import { FileText, Share2 } from 'lucide-react';
import { api, upload } from '../../lib/api';
import { navigate } from '../../lib/router';
import { useApp } from '../../lib/store';
import type { Thread } from '../../lib/types';
import { Button, Card, EmptyState, Field, Page, PageHeader, Select, Spinner, Textarea, toastError } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { formatBytes } from '../../lib/format';
import { t } from '../../lib/i18n';

interface ShareMeta {
  id: string;
  created: number;
  title: string;
  text: string;
  url: string;
  files: { name: string; type: string; size: number }[];
  skipped: number;
}

const CACHE = 'tb-share';

async function loadShare(id: string): Promise<ShareMeta | null> {
  if (!/^[\w-]{6,80}$/.test(id) || !('caches' in window)) return null;
  const res = await (await caches.open(CACHE)).match(`/__share/${id}/meta`);
  return res ? ((await res.json()) as ShareMeta) : null;
}

async function dropShare(id: string) {
  if (!('caches' in window)) return;
  const c = await caches.open(CACHE);
  for (const k of await c.keys()) if (new URL(k.url).pathname.startsWith(`/__share/${id}/`)) await c.delete(k);
}

const size = (n: number) => formatBytes(n);

/**
 * "Delen" (MOB-05): what another app shared to TeamBot (Android share sheet or an installed desktop PWA). The service
 * worker keeps it on this device; here you pick a bot or conversation, add a note and send — or throw it away.
 */
export function SharePage({ params }: { params: string[] }) {
  const id = params[0] || '';
  const agents = useApp((s) => s.agents);
  const threads = useApp((s) => s.threads);
  const [meta, setMeta] = useState<ShareMeta | null | undefined>(undefined);
  const [target, setTarget] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (id === 'geen' || id === 'fout') return setMeta(null);
    loadShare(id)
      .then((m) => {
        setMeta(m);
        if (m) setNote([m.title && m.title !== m.text ? m.title : '', m.text, m.url && !m.text.includes(m.url) ? m.url : ''].filter(Boolean).join('\n'));
      })
      .catch(() => setMeta(null));
  }, [id]);
  const recent = useMemo(() => threads.filter((t: Thread) => !t.archived).slice(0, 8), [threads]);
  useEffect(() => {
    if (!target && (recent[0] || agents[0])) setTarget(recent[0] ? `t:${recent[0].id}` : `a:${agents[0].id}`);
  }, [recent, agents]);

  if (meta === undefined) return <Spinner />;
  if (!meta)
    return (
      <Page>
        <PageHeader width="xl" title="Delen" />
        <EmptyState icon={<Share2 className="h-6 w-6" />} title={id === 'fout' ? 'Delen is mislukt' : 'Niets om te delen'}>
          {id === 'geen'
            ? 'Open TeamBot eerst één keer op dit apparaat (zodat de app offline-klaar is) en deel daarna opnieuw.'
            : 'Het gedeelde is al verstuurd, verwijderd of ouder dan 24 uur. Deel het opnieuw vanuit de andere app.'}
        </EmptyState>
      </Page>
    );

  const send = async () => {
    if (!target) return;
    setBusy(true);
    const from = location.hash;
    try {
      let threadId = target.slice(2);
      if (target.startsWith('a:')) threadId = (await api.post<Thread>('/threads', { agentId: target.slice(2) })).id;
      const ids: string[] = [];
      const cache = await caches.open(CACHE);
      for (let i = 0; i < meta.files.length; i++) {
        const res = await cache.match(`/__share/${meta.id}/f${i}`);
        if (!res) continue;
        ids.push((await upload(await res.blob(), meta.files[i].name, threadId)).id);
      }
      await api.post(`/threads/${threadId}/messages`, { content: note.trim() || (ids.length ? 'Gedeeld vanuit een andere app.' : ''), attachments: ids });
      await dropShare(meta.id);
      navigate(`/t/${threadId}`, { from });
    } catch (e) {
      toastError(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Page>
      <PageHeader width="xl" title="Delen met TeamBot" subtitle="Kies waar het naartoe gaat. Tot dan blijft het op dit apparaat." />
      <div className="mx-auto max-w-xl space-y-4 p-4">
        <Card className="space-y-4 p-4">
          <Field label="Naar">
            <Select value={target} onChange={(e) => setTarget(e.target.value)}>
              {recent.length > 0 && (
                <optgroup label="Recente gesprekken">
                  {recent.map((t) => (
                    <option key={t.id} value={`t:${t.id}`}>
                      {t.title || agents.find((a) => a.id === t.agent_id)?.name || 'Gesprek'}
                    </option>
                  ))}
                </optgroup>
              )}
              <optgroup label="Nieuw gesprek met">
                {agents.map((a) => (
                  <option key={a.id} value={`a:${a.id}`}>
                    {a.name}
                  </option>
                ))}
              </optgroup>
            </Select>
          </Field>
          <Field label="Bericht" hint="Je kunt de gedeelde tekst aanpassen of een vraag toevoegen.">
            <Textarea rows={5} value={note} onChange={(e) => setNote(e.target.value)} placeholder="Bijv. vat dit samen" />
          </Field>
          {meta.files.length > 0 && (
            <ul className="space-y-1.5 text-sm" aria-label="Gedeelde bestanden">
              {meta.files.map((f, i) => (
                <li key={i} className="flex items-center gap-2 rounded-lg border border-line px-3 py-2">
                  <FileText className="h-4 w-4 shrink-0 text-muted" />
                  <span className="min-w-0 flex-1 truncate" translate="no">
                    {f.name}
                  </span>
                  <span className="text-xs text-muted">{size(f.size)}</span>
                </li>
              ))}
            </ul>
          )}
          {meta.skipped > 0 && <p className="text-xs text-warn">{t('{0, plural, one {# bestand overgeslagen} other {# bestanden overgeslagen}}: maximaal 10 bestanden en 50 MB per keer.', meta.skipped)}</p>}
          {!agents.length && <p className="text-sm text-warn">Je hebt nog geen bots. Maak eerst een bot, en deel daarna opnieuw.</p>}
          <div className="flex flex-wrap gap-2">
            <Button variant="primary" loading={busy} disabled={!target || (!note.trim() && !meta.files.length)} onClick={send}>
              Versturen
            </Button>
            <Button variant="ghost" onClick={() => {
                const from = location.hash;
                void dropShare(meta.id).then(() => navigate('/', { from }));
              }}>
              Weggooien
            </Button>
          </div>
        </Card>
        <div className="flex items-center gap-2 text-xs text-muted">
          {target.startsWith('a:') && <BotAvatar bot={agents.find((a) => a.id === target.slice(2)) || { id: target.slice(2) }} size={28} />}
          Bestanden gaan als bijlage mee; de bot ziet ze pas als je op Versturen drukt.
        </div>
      </div>
    </Page>
  );
}
