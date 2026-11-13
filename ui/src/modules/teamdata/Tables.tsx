import { type ReactNode, useEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Table2, Upload } from 'lucide-react';
import { useApp } from '../../lib/store';
import { BotAvatar, BotFace } from '../../components/BotFace';
import { Badge, Button, Card, EmptyState, Modal, Spinner, cx, toast, toastError, useAsync } from '../../components/ui';
import { type AuditRow, type TableInfo, teamApi, useTeamChanged } from './api';
import type { ImportResult } from '../../../../shared/teamdata.js';
import { BotName, Fields, Linkified, When } from './parts';
import { t, uiLocale } from '../../lib/i18n';
import { upload } from '../../lib/api';
import { tText } from '../../lib/format';

type Page = Awaited<ReturnType<typeof teamApi.table>>;

function cell(v: any): string {
  if (v === null || v === undefined) return '';
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s.length > 140 ? s.slice(0, 140) + '…' : s;
}

/** Read-only browser of one table: newest rows first, 50 per page; a row opens with every column in full. */
function Browser({ t, onBack }: { t: TableInfo; onBack(): void }) {
  const [page, setPage] = useState<Page | null>(null);
  const [offset, setOffset] = useState(0);
  const [row, setRow] = useState<Record<string, any> | null>(null);
  const load = () =>
    teamApi
      .table(t.name, offset, 50)
      .then(setPage)
      .catch((e) => (toastError(e), onBack()));
  useEffect(() => void load(), [t.name, offset]);
  useTeamChanged([t.name], () => void load());
  const total = page?.total ?? null;
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button size="sm" variant="ghost" icon={<ChevronLeft className="h-4 w-4" />} onClick={onBack}>
          Alle tabellen
        </Button>
        <h3 className="font-mono text-sm font-bold" translate="no">
          {t.name}
        </h3>
        {total !== null && <span className="text-xs text-muted">{total.toLocaleString(uiLocale())} {total === 1 ? 'rij' : 'rijen'}</span>}
        <span className="ms-auto flex items-center gap-1">
          <Button size="icon" variant="ghost" aria-label="Vorige rijen" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs tabular-nums text-muted">
            {page?.rows.length ? `${offset + 1}–${offset + page.rows.length}` : '0'}
          </span>
          <Button size="icon" variant="ghost" aria-label="Volgende rijen" disabled={!page || page.rows.length < 50} onClick={() => setOffset(offset + 50)}>
            <ChevronRight className="h-4 w-4" />
          </Button>
        </span>
      </div>
      {!page ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : !page.rows.length ? (
        <EmptyState title="Deze tabel is leeg">Kolommen: {page.columns.join(', ') || '—'}</EmptyState>
      ) : (
        <div className="scroll-thin max-w-full overflow-x-auto rounded-2xl border border-line bg-surface" tabIndex={0} aria-label={tText('Rijen van {0}', t.name)}>
          <table className="w-full min-w-max text-start text-[13px]" translate="no">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                {page.columns.map((c) => (
                  <th key={c} scope="col" className="whitespace-nowrap px-3 py-2 font-semibold">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {page.rows.map((r, i) => (
                <tr key={i} className="cursor-pointer hover:bg-surface-2" onClick={() => setRow(r)} tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && setRow(r)}>
                  {page.columns.map((c) => (
                    <td key={c} className="max-w-[22rem] truncate px-3 py-2 align-top" title={typeof r[c] === 'string' && r[c].length > 140 ? undefined : String(r[c] ?? '')}>
                      {cell(r[c])}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <Modal open={!!row} onClose={() => setRow(null)} wide title={<span translate="no">{t.name}</span>}>
        {row && <Fields items={Object.entries(row).map(([k, v]) => [k, v === null ? <span className="text-muted">leeg</span> : <Linkified text={typeof v === 'string' ? v : JSON.stringify(v)} />] as [string, ReactNode])} />}
      </Modal>
    </div>
  );
}

const VERB: Record<string, string> = { INSERT: 'voegde toe aan', REPLACE: 'voegde toe aan', UPDATE: 'wijzigde', DELETE: 'verwijderde uit', 'CREATE TABLE': 'maakte tabel', 'CREATE INDEX': 'maakte een index op', 'CREATE VIEW': 'maakte view', 'DROP TABLE': 'verwijderde tabel', 'DROP INDEX': 'verwijderde een index', 'DROP VIEW': 'verwijderde view', 'ALTER TABLE': 'paste aan:' };

function Changes() {
  const [list, setList] = useState<AuditRow[] | null>(null);
  const agents = useApp((s) => s.agents);
  const load = () =>
    teamApi
      .audit()
      .then(setList)
      .catch(() => setList([]));
  useEffect(() => void load(), []);
  useTeamChanged([], () => void load());
  if (!list?.length) return null;
  return (
    <section aria-labelledby="td-changes" className="space-y-2">
      <h3 id="td-changes" className="text-[13px] font-bold">
        Laatste wijzigingen
      </h3>
      <ul className="divide-y divide-line overflow-hidden rounded-2xl border border-line bg-surface">
        {list.slice(0, 30).map((a) => {
          const bot = a.actor_type === 'agent' ? agents.find((x) => x.id === a.actor_id) : null;
          return (
            <li key={a.id} className="flex min-w-0 items-start gap-2.5 px-4 py-2.5 text-[13px]">
              {a.actor_type === 'agent' ? <BotAvatar bot={bot || { id: a.actor_id, name: a.actor_name }} size={22} /> : <span className="mt-0.5 h-[22px] w-[22px] shrink-0 rounded-full bg-surface-3" aria-hidden />}
              <div className="min-w-0 flex-1">
                <div className="min-w-0">
                  <span className="font-semibold" translate="no">
                    {a.actor_type === 'user' ? 'Jij' : bot?.name || a.actor_name}
                  </span>{' '}
                  {a.error ? 'probeerde' : VERB[a.verb] || a.verb.toLowerCase()}{' '}
                  <span className="font-mono" translate="no">
                    {a.table_name || ''}
                  </span>
                  {a.changes !== null && !a.error && a.verb !== 'CREATE TABLE' && <span className="text-muted"> · {a.changes} {a.changes === 1 ? 'rij' : 'rijen'}</span>}
                </div>
                {a.error && <div className="mt-0.5 text-xs text-danger">Geweigerd: {a.error}</div>}
              </div>
              <When value={a.created_at} className="shrink-0 text-xs text-muted" />
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Every table in the team database, the standard ones first, plus who changed what lately. */
/** "CSV of Excel importeren": a spreadsheet becomes a team table; the result can be undone right there. */
function ImportFile({ onDone }: { onDone(): void }) {
  const input = useRef<HTMLInputElement>(null);
  const [res, setRes] = useState<ImportResult | null>(null);
  const a = useAsync();
  const pick = (f: File | undefined) =>
    f &&
    a.run(async () => {
      const up = await upload(f, f.name);
      const r = await teamApi.importFile(up.id);
      setRes(r);
      onDone();
    });
  return (
    <Card className="flex flex-wrap items-center gap-3 p-3.5 text-sm">
      <span className="min-w-0 flex-1 basis-60">
        {res
          ? res.created
            ? t('Tabel {0} gemaakt: {1, plural, one {# rij} other {# rijen}} toegevoegd.', res.table, res.inserted)
            : t('Tabel {0} aangevuld: {1, plural, one {# rij} other {# rijen}} toegevoegd.', res.table, res.inserted)
          : 'Zet een CSV-bestand of Excel-werkmap in een tabel. De eerste rij geeft de kolomnamen.'}
      </span>
      <input ref={input} type="file" accept=".csv,.tsv,.xlsx" className="hidden" aria-label="CSV- of Excel-bestand kiezen" onChange={(e) => (pick(e.target.files?.[0]), (e.target.value = ''))} />
      {res && (
        <Button
          size="sm"
          variant="ghost"
          loading={a.busy}
          onClick={() =>
            a.run(async () => {
              await teamApi.undoImport(res.source);
              toast('Import teruggedraaid', 'ok');
              setRes(null);
              onDone();
            })
          }
        >
          Ongedaan maken
        </Button>
      )}
      <Button size="sm" icon={<Upload className="h-4 w-4" />} loading={a.busy} onClick={() => input.current?.click()}>
        CSV of Excel importeren
      </Button>
    </Card>
  );
}

export function TablesTab() {
  const [list, setList] = useState<TableInfo[] | null>(null);
  const [open, setOpen] = useState<TableInfo | null>(null);
  const load = () =>
    teamApi
      .tables()
      .then(setList)
      .catch((e) => (toastError(e), setList([])));
  useEffect(() => void load(), []);
  useTeamChanged([], () => void load());
  if (open) return <Browser t={open} onBack={() => setOpen(null)} />;
  if (!list)
    return (
      <div className="flex justify-center py-10">
        <Spinner />
      </div>
    );
  if (!list.length)
    return (
      <div className="space-y-4">
        <EmptyState icon={<Table2 />} title="Nog geen tabellen" />
        <ImportFile onDone={load} />
      </div>
    );
  return (
    <div className="space-y-5">
      <p className="max-w-2xl text-[13px] leading-relaxed text-muted">
        Je bots delen één database. De vijf vaste tabellen heeft TeamBot gemaakt; daarnaast kan elke bot eigen tabellen maken (alleen die bot kan ze aanpassen of verwijderen). Bots lezen en schrijven met hun teamtools; elke wijziging staat hieronder.
      </p>
      <ImportFile onDone={load} />
      <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
        {list.map((t) => (
          <button key={t.name} type="button" onClick={() => setOpen(t)} className="text-start">
            <Card className={cx('flex h-full min-w-0 flex-col gap-1.5 p-3.5 hover:border-line-strong hover:bg-surface-2')}>
              <div className="flex min-w-0 items-center gap-2">
                <span className="truncate font-mono text-[13.5px] font-bold" translate="no">
                  {t.name}
                </span>
                {t.type === 'view' && <Badge>view</Badge>}
                <span className="ms-auto shrink-0 text-xs tabular-nums text-muted">{t.rows === null ? '' : t.rows === 1 ? '1 rij' : `${t.rows.toLocaleString(uiLocale())} rijen`}</span>
              </div>
              {t.about && <p className="line-clamp-2 text-xs leading-snug text-muted">{t.about}</p>}
              <div className="mt-auto flex items-center gap-1.5 pt-1 text-xs text-muted">
                {t.owner.type === 'agent' ? (
                  <>
                    gemaakt door <BotName name={t.owner.name} size={16} />
                  </>
                ) : (
                  <>
                    <BotFace seed="TeamBot" traits={{ shape: 'squircle', color: 'tangerine', eyes: 'bean', mouth: 'smile', extra: 'antenna', cheeks: true }} size={16} /> vaste tabel van TeamBot
                  </>
                )}
              </div>
            </Card>
          </button>
        ))}
      </div>
      <Changes />
    </div>
  );
}
