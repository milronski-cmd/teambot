import { useCallback, useEffect, useState } from 'react';
import { Download, FileClock, MessageSquare, RotateCcw, Trash2, Undo2 } from 'lucide-react';
import { on } from '../../lib/api';
import { t } from '../../lib/i18n';
import { formatBytes, formatDateTime } from '../../lib/format';
import { useApp } from '../../lib/store';
import { askConfirm, Badge, Button, Card, EmptyState, Page, PageHeader, useAsync } from '../../components/ui';
import { MoreInfo } from '../../components/MoreInfo';
import { Menu, SkeletonRows } from '../../components/overview';
import { Dropdown } from '../../components/SettingControls';
import { type RunChange, trashApi, type TrashItem, type TrashUsage } from './api';

const daysLeft = (iso: string) => Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86_400_000));

function TrashRow({ e, onDone }: { e: TrashItem; onDone(): void }) {
  const { busy, run } = useAsync();
  const left = daysLeft(e.expires_at);
  const restore = () =>
    run(async () => {
      const r = await trashApi.restore(e.id);
      onDone();
      return r;
    }, e.exists_now ? 'Teruggezet; de versie die er stond, staat nu in de prullenbak' : 'Teruggezet');
  const purge = async () => {
    if (!(await askConfirm(`“${e.rel}” definitief verwijderen? Terughalen kan daarna niet meer.`, { ok: 'Definitief verwijderen', danger: true }))) return;
    await run(async () => {
      await trashApi.purge(e.id);
      onDone();
    }, 'Definitief verwijderd');
  };
  return (
    <li className="tb-in flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
      <FileClock className="h-4 w-4 shrink-0 text-muted" aria-hidden />
      <div className="min-w-0 flex-1 basis-56">
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="min-w-0 break-all text-sm font-medium" translate="no">
            {e.rel}
          </span>
          {e.kind !== 'deleted' && <Badge>Vorige versie</Badge>}
        </div>
        <div className="mt-0.5 text-[13px] text-muted">
          {[e.agent_name || e.root_label, formatDateTime(e.created_at), t('{0, plural, one {nog # dag bewaard} other {nog # dagen bewaard}}', left)].join(' · ')}
        </div>
        {e.note === 'too_big' && <p className="mt-1 text-xs text-warn">Te groot voor de prullenbak: hiervan is geen kopie bewaard.</p>}
        {e.has_copy && e.exists_now && e.kind === 'deleted' && <p className="mt-1 text-xs text-muted">Op die plek staat nu weer een bestand; dat gaat bij terugzetten eerst naar de prullenbak.</p>}
      </div>
      <Button size="sm" icon={<RotateCcw className="h-4 w-4" />} onClick={restore} loading={busy} disabled={!e.has_copy}>
        Terugzetten
      </Button>
      <Menu
        label={t('Meer opties voor {0}', e.rel)}
        items={[
          e.has_copy && !e.is_dir && { label: t('Downloaden ({0})', formatBytes(e.size)), icon: <Download />, href: trashApi.downloadUrl(e.id) },
          !!e.thread_id && { label: 'Gesprek openen', icon: <MessageSquare />, href: `#/t/${e.thread_id}` },
          { label: 'Definitief verwijderen', icon: <Trash2 />, danger: true, onSelect: purge, disabled: busy },
        ]}
      />
    </li>
  );
}

/** #/m/folders/prullenbak — files bots deleted or overwrote, restorable for 30 days. */
export function TrashPage() {
  const agents = useApp((s) => s.agents);
  const [agentId, setAgentId] = useState('');
  const [data, setData] = useState<{ items: TrashItem[]; usage: TrashUsage } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useAsync();
  const load = useCallback(() => {
    trashApi
      .list(agentId || undefined)
      .then((d) => (setData(d), setErr(null)))
      .catch((e) => setErr(e.message));
  }, [agentId]);
  useEffect(load, [load]);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = on('trash.updated', () => {
      if (!timer) timer = setTimeout(() => ((timer = null), load()), 500);
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [load]);
  const empty = async () => {
    if (!(await askConfirm('De hele prullenbak legen? Alle bestanden erin zijn daarna definitief weg.', { ok: 'Prullenbak legen', danger: true }))) return;
    await run(async () => {
      await trashApi.empty();
      load();
    }, 'Prullenbak geleegd');
  };
  const u = data?.usage;
  return (
    <Page>
      <PageHeader
        title="Prullenbak"
        subtitle={t('{0, plural, one {Wat je bots verwijderden of overschreven. Terughalen kan # dag lang.} other {Wat je bots verwijderden of overschreven. Terughalen kan # dagen lang.}}', u?.days ?? 30)}
        back={{ href: '#/m/folders', label: 'Bestanden' }}
        actions={data?.items.length ? <Menu label="Meer opties" items={[{ label: 'Prullenbak legen', icon: <Trash2 />, danger: true, disabled: busy, onSelect: empty }]} /> : undefined}
      />
      <div className="mx-auto max-w-4xl space-y-4 px-4 pb-8 pt-3 sm:px-6">
        {(!!data?.items.length || !!agentId) && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            <Dropdown label="Filter op bot" className="w-full sm:w-56" value={agentId} onChange={setAgentId} options={[{ value: '', label: 'Alle bots' }, ...agents.map((a) => ({ value: a.id, label: a.name }))]} />
            {u && (
              <span className="text-[13px] text-muted">
                {t('{0} van {1} gebruikt', formatBytes(u.bytes), formatBytes(u.maxBytes))} <MoreInfo>{t('Maximaal {0} per bestand. Is de prullenbak vol, dan gaan de oudste bestanden eerst weg.', formatBytes(u.maxFile))}</MoreInfo>
              </span>
            )}
          </div>
        )}
        {err && (
          <EmptyState icon={<Trash2 />} title="De prullenbak kon niet laden" action={<Button onClick={load}>Opnieuw</Button>}>
            {err}
          </EmptyState>
        )}
        {!err && !data && <SkeletonRows n={3} avatar={false} />}
        {data && !data.items.length && (
          <EmptyState
            icon={<Trash2 />}
            title="De prullenbak is leeg"
            action={
              agentId ? (
                <Button onClick={() => setAgentId('')}>Alle bots tonen</Button>
              ) : (
                <a href="#/m/folders" className="inline-flex h-9 items-center rounded-control border border-line bg-surface px-3.5 text-sm font-semibold hover:bg-surface-2 coarse:h-11">
                  Naar Bestanden
                </a>
              )
            }
          >
            Wat een bot verwijdert of overschrijft, komt hier en kun je terugzetten.
          </EmptyState>
        )}
        {data && data.items.length > 0 && (
          <Card className="overflow-visible">
            <ul className="divide-y divide-line">
              {data.items.map((e) => (
                <TrashRow key={e.id} e={e} onDone={load} />
              ))}
            </ul>
          </Card>
        )}
      </div>
    </Page>
  );
}

/**
 * The files one task (run) changed, with "Alles terugzetten": the snapshot of exactly those files from before the task.
 * Used on a routine receipt; renders nothing when the task changed no files.
 */
export function RunChanges({ runIds }: { runIds: string[] }) {
  const [changes, setChanges] = useState<(RunChange & { runId: string })[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const { busy, run } = useAsync();
  const key = runIds.join(',');
  const load = useCallback(() => {
    Promise.all(runIds.map((id) => trashApi.runChanges(id).then((r) => r.changes.map((c) => ({ ...c, runId: id })))))
      .then((all) => (setChanges(all.flat()), setErr(null)))
      .catch((e) => setErr(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
  useEffect(load, [load]);
  if (err || !changes || !changes.length) return null;
  const open = changes.filter((c) => c.restorable);
  const restoreAll = () =>
    run(async () => {
      for (const id of [...new Set(open.map((c) => c.runId))]) {
        const r = await trashApi.restoreRun(id);
        if (r.failed.length) throw new Error(r.failed.map((f) => `${f.path}: ${f.message}`).join('; '));
      }
      load();
    }, 'Bestanden teruggezet zoals ze vóór deze run waren');
  const label = (c: RunChange) => (c.restored ? 'Teruggezet' : c.kind === 'created' ? 'Nieuw' : c.kind === 'deleted' ? 'Verwijderd' : 'Gewijzigd');
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm font-medium">{t('{0, plural, one {Deze run veranderde # bestand} other {Deze run veranderde # bestanden}}', changes.length)}</span>
        {open.length > 0 && (
          <Button size="sm" icon={<Undo2 className="h-4 w-4" />} onClick={restoreAll} loading={busy}>
            Alles terugzetten
          </Button>
        )}
      </div>
      <ul className="space-y-1 rounded-control border border-line p-2 text-sm">
        {changes.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2">
            <Badge tone={c.restored ? 'ok' : c.kind === 'deleted' ? 'warn' : 'neutral'}>{label(c)}</Badge>
            <span className="min-w-0 break-all font-mono text-xs" translate="no">
              {c.rel}
            </span>
            {c.note === 'too_big' && <span className="text-xs text-warn">geen kopie (te groot)</span>}
          </li>
        ))}
      </ul>
      <p className="text-xs text-muted">Terugzetten bewaart de huidige versies eerst in de prullenbak; er gaat niets verloren.</p>
    </div>
  );
}
