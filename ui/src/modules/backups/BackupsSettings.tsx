import { useEffect, useState } from 'react';
import { CalendarClock, DatabaseBackup, Download, History, PackageOpen, RotateCcw, Trash2 } from 'lucide-react';
import { api, authUrl, on } from '../../lib/api';
import { useApp } from '../../lib/store';
import { t } from '../../lib/i18n';
import { formatBytes, formatDateTime } from '../../lib/format';
import { askConfirm, Badge, Button, Card, CardHead, EmptyState, Spinner, Toggle, timeAgo, toast, toastError, useAsync } from '../../components/ui';
import { desktopBridge, type BackupItem, type BackupJob, type BackupsView, type UpdatesView } from './types';
import { UpdatesCard } from './UpdatesCard';
import { OffsiteCard } from './OffsiteCard';
import { useIsPhoneSession } from '../../shell/computerOnly';
import { MoreInfo } from '../../components/MoreInfo';
import { MoreOptions } from '../../components/MoreOptions';
import { Dropdown, SettingRow, SettingsSection, SwitchRow, useSave } from '../../components/SettingControls';

/** What a backup is, in words. */
function kindLabel(b: BackupItem): string {
  if (b.kind === 'auto') return 'Automatisch';
  if (b.kind === 'update') return b.update ? t('Voor de update naar {0}', b.update.to) : 'Voor een update';
  if (b.kind === 'replaced') return 'Veiligheidskopie van vóór het terugzetten';
  return 'Zelf gemaakt';
}

function contentLabel(b: BackupItem): string {
  if (b.legacy) return 'alleen de database';
  if (b.dataOnly) return 'database en instellingen';
  return b.includesWork ? 'alles, met werkmappen' : 'alles, zonder werkmappen';
}

/** The back-ups shown before "Alle … tonen". */
const FIRST = 4;

/**
 * Instellingen › Back-ups. The first view answers "is my data safe" and has one main button: the last back-up and
 * whether the next one comes by itself, "Nu een back-up maken", then the list to restore from ("Terugzetten") and the
 * daily switch. The copy on a second place and the updates of TeamBot itself are calm cards below; how many to keep,
 * work folders in the automatic back-up and what is in a back-up are behind "Meer opties".
 */
/** `simple` (Instellingen › Beveiliging en back-ups): make a back-up and put one back. The rest is the full page under Geavanceerd. */
export function BackupsSettings({ simple }: { simple?: boolean } = {}) {
  const me = useApp((s) => s.me);
  // Restoring and downloading a database are admin routes: on the computer only (server/modules/mobile/policy.ts).
  const phone = useIsPhoneSession();
  const [d, setD] = useState<BackupsView | null>(null);
  const [u, setU] = useState<UpdatesView | null>(null);
  const [err, setErr] = useState('');
  const [withWork, setWithWork] = useState(false);
  const [job, setJob] = useState<BackupJob | null>(null);
  const [all, setAll] = useState(false);
  const a = useAsync();
  const bridge = desktopBridge();
  const load = (fresh = false) =>
    Promise.all([api.get<BackupsView>(`/backups${fresh ? '?fresh=1' : ''}`), api.get<UpdatesView>('/backups/updates')])
      .then(([b, up]) => {
        setD(b);
        setU(up);
        setErr('');
        if (b.job && (b.job.phase === 'database' || b.job.phase === 'files')) setJob(b.job);
      })
      .catch((e) => setErr(e.message || String(e)));
  useEffect(() => {
    load(true);
    const offP = on('backups.progress', (j: BackupJob) => setJob(j));
    const offU = on('backups.updated', (x: { name?: string; error?: string }) => {
      setJob(null);
      if (x?.error) toast(x.error, 'danger');
      else toast('Back-up gemaakt', 'ok');
      load();
    });
    return () => {
      offP();
      offU();
    };
  }, []);

  if (err && !d) return <EmptyState title="Back-ups ophalen mislukt" action={<Button onClick={() => load(true)}>Opnieuw proberen</Button>}>{err}</EmptyState>;
  if (!d) return <Spinner />;
  const owner = me?.role === 'owner';
  const plan = d.plan;
  const sum = (kinds: string[]) => plan.filter((p) => p.exists && kinds.includes(p.kind)).reduce((n, p) => n + p.bytes, 0);
  const always = sum(['always']);
  const work = sum(['optional']);
  const busy = !!job && (job.phase === 'database' || job.phase === 'files');
  const pct = job && job.total ? Math.min(100, Math.round((job.done / job.total) * 100)) : 0;
  const last = d.items.reduce<BackupItem | null>((m, b) => (!m || b.createdAt > m.createdAt ? b : m), null);
  const shown = all ? d.items : d.items.slice(0, FIRST);
  const saveSettings = (patch: Partial<BackupsView['settings']>) =>
    api.put<BackupsView['settings']>('/backups/settings', patch).then((s) => setD((cur) => (cur ? { ...cur, settings: s } : cur)));

  const restore = async (b: BackupItem) => {
    const when = formatDateTime(b.createdAt);
    const ok = await askConfirm(
      t(
        'De back-up van {0} terugzetten? Wat sindsdien is veranderd, gaat uit TeamBot; de huidige stand wordt eerst bewaard. TeamBot start opnieuw.',
        when,
      ),
      { ok: 'Terugzetten' },
    );
    if (!ok) return;
    await a.run(async () => {
      await api.post(`/backups/${b.name}/restore`);
      if (bridge?.restart) {
        toast('TeamBot start opnieuw en zet de back-up terug…', 'ok');
        await bridge.restart();
      } else {
        toast(d.mode === 'desktop' ? 'Klaar om terug te zetten: sluit TeamBot af en start opnieuw.' : 'Klaar om terug te zetten: herstart de server.', 'ok');
        load();
      }
    });
  };

  return (
    <div className="space-y-4">
      {d.pending && (
        <Card className="flex flex-wrap items-center gap-3 border-warn bg-warn-soft p-4 text-sm text-warn">
          <span className="min-w-0 flex-1 basis-64">
            {d.mode === 'desktop' ? 'Een back-up staat klaar om terug te zetten. Dat gebeurt als TeamBot opnieuw start.' : 'Een back-up staat klaar om terug te zetten. Dat gebeurt als de server opnieuw start.'}
          </span>
          {bridge?.restart && owner && (
            <Button size="sm" variant="primary" onClick={() => a.run(async () => void (await bridge.restart!()))}>
              Nu opnieuw starten
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={() => api.del('/backups/pending').then(() => load()).catch(toastError)}>
            Annuleren
          </Button>
        </Card>
      )}

      <Card className="space-y-4 p-5">
        <CardHead
          icon={DatabaseBackup}
          tone="amber"
          title="Back-up maken"
          hint={
            <>
              {last ? t('Laatste back-up: {0}.', formatDateTime(last.createdAt)) : 'Je hebt nog geen back-up.'} {d.settings.auto ? 'Elke dag komt er vanzelf een bij.' : 'Automatische back-ups staan uit.'}{' '}
              <MoreInfo>Een back-up bevat al je gegevens en blijft op deze computer.</MoreInfo>
            </>
          }
        />
        <div className="flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            icon={<DatabaseBackup className="h-4 w-4" />}
            loading={busy}
            disabled={busy}
            onClick={() =>
              a.run(async () => {
                const r = await api.post<{ job: BackupJob }>('/backups', { includeWork: withWork });
                if (r.job) setJob(r.job);
              })
            }
          >
            Nu een back-up maken
          </Button>
          <span className="text-xs text-muted">{t('Ongeveer {0}', formatBytes(d.dbBytes + always + (withWork ? work : 0)))}</span>
        </div>
        {busy && (
          <div className="space-y-1" role="status">
            <div className="h-2 overflow-hidden rounded-full bg-surface-3">
              <div className="h-full bg-accent transition-[width]" style={{ width: `${pct}%` }} />
            </div>
            <div className="text-xs text-muted">{job!.phase === 'database' ? 'Database kopiëren…' : t('Bestanden kopiëren… {0}%', pct)}</div>
          </div>
        )}
        {!simple && <Toggle
          checked={withWork}
          onChange={setWithWork}
          label={work ? t('Ook de werkmappen van bots en de bestanden van groepen ({0})', formatBytes(work)) : 'Ook de werkmappen van bots en de bestanden van groepen'}
        />}
      </Card>

      <Card className="space-y-2 p-5">
        <CardHead icon={History} tone="amber" title="Je back-ups" />
        {d.lastRestore && (
          <p className="text-sm text-muted">
            {t('Laatst teruggezet op {0}. Vergeten herinneringen bleven vergeten en de zoekfuncties zijn opnieuw opgebouwd.', formatDateTime(d.lastRestore.appliedAt))}
          </p>
        )}
        {d.items.length === 0 ? (
          <p className="text-sm text-muted">Nog geen back-ups.</p>
        ) : (
          <ul className="divide-y divide-line">
            {shown.map((b) => (
              <li key={b.name} className="flex flex-wrap items-center gap-x-2 gap-y-1 py-2.5 text-sm">
                <span className="min-w-0 flex-1 basis-56">
                  <span className="block font-medium">
                    {formatDateTime(b.createdAt)} <span className="font-normal text-muted">· {timeAgo(b.createdAt)}</span>
                  </span>
                  <span className="block text-xs text-muted">
                    {kindLabel(b)} · {contentLabel(b)} · {formatBytes(b.bytes)}
                    {b.version ? ` · TeamBot ${b.version}` : ''}
                  </span>
                </span>
                {b.kind === 'auto' && <Badge>automatisch</Badge>}
                {owner && !phone && (
                  <Button size="sm" variant="ghost" icon={<RotateCcw className="h-3.5 w-3.5" />} loading={a.busy} onClick={() => restore(b)}>
                    Terugzetten
                  </Button>
                )}
                {!phone && (
                  <a
                    // One control: a link that looks like the small buttons next to it (no button inside a link).
                    href={authUrl(`/admin/backups/${b.name}`)}
                    aria-label="Database downloaden"
                    title="Database downloaden"
                    className="inline-flex h-8 shrink-0 items-center rounded-[9px] px-3 text-muted transition-colors hover:bg-surface-2 hover:text-fg coarse:h-11"
                  >
                    <Download className="h-3.5 w-3.5" aria-hidden />
                  </a>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  aria-label="Verwijderen"
                  onClick={async () => (await askConfirm('Deze back-up verwijderen?', { ok: 'Verwijderen', danger: true })) && api.del(`/backups/${b.name}`).then(() => load()).catch(toastError)}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </Button>
              </li>
            ))}
          </ul>
        )}
        {d.items.length > FIRST && (
          <Button size="sm" variant="ghost" aria-expanded={all} onClick={() => setAll(!all)}>
            {all ? 'Minder tonen' : t('Alle {0} tonen', d.items.length)}
          </Button>
        )}
      </Card>

      {!simple && (
        <>
      <SettingsSection icon={CalendarClock} tone="amber" title="Automatisch" info="Automatische back-ups worden gemaakt terwijl TeamBot draait.">
        <AutoSwitch settings={d.settings} save={saveSettings} />
      </SettingsSection>

      {owner && !phone && d.offsite && <OffsiteCard v={d.offsite} onChanged={(o) => (o ? setD((cur) => (cur ? { ...cur, offsite: o } : cur)) : load())} onRestore={restore} />}

      {u && <UpdatesCard v={u} onChanged={() => load()} showNewsLink live />}

      <MoreOptions>
        <SettingsSection
          icon={CalendarClock}
          tone="amber"
          title="Automatische back-ups"
          isDefault={d.settings.auto && d.settings.keep === 7 && !d.settings.includeWork}
          onReset={() => saveSettings({ auto: true, keep: 7, includeWork: false })}
        >
          <AutoRows settings={d.settings} save={saveSettings} />
        </SettingsSection>

        <Card className="space-y-3 p-5">
          <CardHead icon={PackageOpen} tone="amber" title="Wat zit erin, en wat niet" />
          <ul className="space-y-1 text-sm">
            {plan
              .filter((p) => p.exists && p.kind !== 'excluded' && !p.id.startsWith('master.key'))
              .map((p) => (
                <li key={p.id} className="flex flex-wrap justify-between gap-x-3">
                  <span>
                    {p.label}
                    {p.kind === 'optional' && <span className="text-muted"> · alleen als je dat kiest</span>}
                  </span>
                  <span className="text-muted">{formatBytes(p.bytes)}</span>
                </li>
              ))}
          </ul>
          <div className="space-y-1 text-sm">
            <div className="font-semibold">Niet in een back-up</div>
            <p className="text-xs text-muted">
              Browserprofielen, logbestanden en installatiebestanden.{' '}
              <MoreInfo block>
                <ul className="list-disc space-y-1 ps-5">
                  {plan
                    .filter((p) => p.exists && p.kind === 'excluded')
                    .map((p) => (
                      <li key={p.id}>
                        {p.label}: {p.reason}
                      </li>
                    ))}
                  <li>Mappen buiten TeamBot die je een bot hebt gegeven (bijvoorbeeld een eigen projectmap): maak daar zelf een back-up van.</li>
                </ul>
              </MoreInfo>
            </p>
          </div>
          <p className="rounded-lg bg-surface-2 px-3 py-2 text-sm">{d.keys.text}</p>
        </Card>
      </MoreOptions>
        </>
      )}
    </div>
  );
}

/** The daily automatic back-up on or off (saved at once); the rest of it is under "Meer opties" (AutoRows). */
function AutoSwitch({ settings, save: put }: { settings: BackupsView['settings']; save(p: Partial<BackupsView['settings']>): Promise<unknown> }) {
  const save = useSave();
  return <SwitchRow checked={settings.auto} onChange={(v) => void save(put({ auto: v }))} setting="backups.auto" />;
}

/** Automatic back-ups, the rarely changed part: how many to keep, with or without work folders. Every change saves at once. */
function AutoRows({ settings, save: put }: { settings: BackupsView['settings']; save(p: Partial<BackupsView['settings']>): Promise<unknown> }) {
  const save = useSave();
  return (
    <>
      <SettingRow setting="backups.keep">
        <Dropdown
          id="backup-keep"
          value={String(settings.keep)}
          disabled={!settings.auto}
          onChange={(v) => void save(put({ keep: Number(v) }))}
          options={[3, 5, 7, 14, 30].map((n) => ({ value: String(n), label: t('{0, plural, one {# back-up} other {# back-ups}}', n) }))}
        />
      </SettingRow>
      <SwitchRow checked={settings.includeWork} disabled={!settings.auto} onChange={(v) => void save(put({ includeWork: v }))} setting="backups.includeWork" />
    </>
  );
}
