import { useMemo, useState } from 'react';
import { AlertTriangle, Camera, Check, ChevronDown, ChevronRight, FlaskConical, RotateCcw, Trash2, Undo2, X } from 'lucide-react';
import { api } from '../../lib/api';
import { Badge, Button, Card, cx, EmptyState, Input, Modal, Spinner, Toggle, toast, useAsync } from '../../components/ui';
import { fmtBytes, fmtTime, useLive, type FileChange, type HeldDeletion, type Rehearsal, type Snapshot } from './api';
import { lineDiff, type Piece } from '../../shell/textDiff';
import { t } from '../../lib/i18n';
import { agentById } from '../../lib/store';
import { CopyPath, folderName } from '../../components/FolderName';

const CHANGE: Record<FileChange['change'], { label: string; tone: 'ok' | 'warn' | 'danger' | 'accent' }> = {
  added: { label: 'nieuw', tone: 'ok' },
  modified: { label: 'gewijzigd', tone: 'warn' },
  deleted: { label: 'verwijderd', tone: 'danger' },
  moved: { label: 'verplaatst', tone: 'accent' },
};
/** A move with an edit on the way is "verplaatst en gewijzigd" (B-36). */
const badgeOf = (c: FileChange) => (c.change === 'moved' && c.edited ? { label: 'verplaatst en gewijzigd', tone: 'warn' as const } : CHANGE[c.change]);

/** A path that wraps after a "/" when the panel is narrow, and only mid-name when one name is too long. */
function PathText({ path }: { path: string }) {
  const parts = path.split('/');
  return (
    <>
      {parts.map((p, i) => (
        <span key={i}>
          {p}
          {i < parts.length - 1 && (
            <>
              /<wbr />
            </>
          )}
        </span>
      ))}
    </>
  );
}

export function DiffView({ text }: { text: string }) {
  const lines = text.split('\n');
  return (
    <pre className="scroll-thin max-h-96 overflow-auto rounded-lg border border-line bg-surface-2 p-2 font-mono text-xs leading-5">
      {lines.map((l, i) => (
        <div
          key={i}
          className={cx(
            'whitespace-pre-wrap break-all px-1',
            l.startsWith('+') && !l.startsWith('+++') && 'bg-ok-soft text-ok',
            l.startsWith('-') && !l.startsWith('---') && 'bg-danger-soft text-danger',
            l.startsWith('@@') && 'text-accent',
          )}
        >
          {l || ' '}
        </div>
      ))}
    </pre>
  );
}

/** Text with the removed (left) or added (right) words marked; colour is never the only signal (− / + and sr-only). */
function Side({ pieces, side }: { pieces: Piece[]; side: 'left' | 'right' }) {
  return (
    <>
      {pieces
        .filter((p) => p.kind === 'same' || (side === 'left' ? p.kind === 'del' : p.kind === 'ins'))
        .map((p, i) =>
          p.kind === 'same' ? (
            <span key={i}>{p.text}</span>
          ) : side === 'left' ? (
            <del key={i} className="rounded bg-danger-soft px-0.5 text-danger decoration-danger/60">
              <span className="sr-only">[weg: </span>
              {p.text}
              <span className="sr-only">]</span>
            </del>
          ) : (
            <ins key={i} className="rounded bg-ok-soft px-0.5 text-ok no-underline">
              <span className="sr-only">[nieuw: </span>
              {p.text}
              <span className="sr-only">]</span>
            </ins>
          ),
        )}
    </>
  );
}

/**
 * The real folder (left) next to the practice run (right), line by line: unchanged lines dimmed, long unchanged parts
 * folded, changed words marked on both sides (B-42).
 */
export function SideBySide({
  before,
  after,
  leftTitle = 'Je echte map',
  rightTitle = 'Wat de bot maakte',
  leftMissing,
  rightMissing,
  rightMissingText = 'verwijderd',
}: {
  before: string;
  after: string;
  leftTitle?: string;
  rightTitle?: string;
  leftMissing?: boolean;
  rightMissing?: boolean;
  rightMissingText?: string;
}) {
  const lines = useMemo(() => lineDiff(before, after), [before, after]);
  const cell = 'min-w-0 whitespace-pre-wrap break-words px-1.5 py-px';
  return (
    <div role="table" aria-label={`${leftTitle} naast ${rightTitle}`} className="scroll-thin max-h-[28rem] overflow-auto rounded-lg border border-line bg-canvas text-xs leading-5" data-testid="side-by-side">
      <div role="row" className="sticky top-0 z-10 grid grid-cols-2 border-b border-line bg-surface-2 font-sans text-[11.5px] font-semibold">
        <div role="columnheader" className="px-2 py-1">
          {leftTitle}
          {leftMissing && <span className="font-normal text-muted"> (bestaat niet)</span>}
        </div>
        <div role="columnheader" className="border-s border-line px-2 py-1">
          {rightTitle}
          {rightMissing && <span className="font-normal text-muted"> ({rightMissingText})</span>}
        </div>
      </div>
      <div className="font-mono">
        {lines.map((l, i) =>
          l.kind === 'skip' ? (
            <div key={i} role="row" className="border-y border-line/60 bg-surface-2/60 px-2 py-0.5 text-center font-sans text-[11px] italic text-muted">
              <span role="cell">… {l.count === 1 ? '1 ongewijzigde regel' : `${l.count} ongewijzigde regels`}</span>
            </div>
          ) : (
            <div key={i} role="row" className="grid grid-cols-2">
              <div role="cell" className={cx(cell, l.kind === 'same' ? 'text-muted' : l.kind === 'del' ? 'bg-danger-soft text-danger' : l.kind === 'change' ? 'bg-danger-soft/40' : '')}>
                {l.kind === 'same' ? l.text || ' ' : l.kind === 'del' ? (
                  <>
                    <span aria-hidden>− </span>
                    <span className="sr-only">Weg: </span>
                    {l.text || ' '}
                  </>
                ) : l.kind === 'change' ? (
                  <Side pieces={l.pieces} side="left" />
                ) : (
                  ' '
                )}
              </div>
              <div role="cell" className={cx(cell, 'border-s border-line', l.kind === 'same' ? 'text-muted' : l.kind === 'ins' ? 'bg-ok-soft text-ok' : l.kind === 'change' ? 'bg-ok-soft/40' : '')}>
                {l.kind === 'same' ? l.text || ' ' : l.kind === 'ins' ? (
                  <>
                    <span aria-hidden>+ </span>
                    <span className="sr-only">Nieuw: </span>
                    {l.text || ' '}
                  </>
                ) : l.kind === 'change' ? (
                  <Side pieces={l.pieces} side="right" />
                ) : (
                  ' '
                )}
              </div>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

type FileDiffData = { diff: string; binary: boolean; tooLarge?: boolean; added: number; removed: number; conflict: boolean; before?: string; after?: string; inOriginal?: boolean; inRehearsal?: boolean };

/** One file's change; for a moved file (`from`) the old place in the real folder against the new place. */
function FileDiff({ rehearsalId, path, from }: { rehearsalId: string; path: string; from?: string }) {
  const d = useLive(() => api.get<FileDiffData>(`/computers/rehearsals/${rehearsalId}/diff?path=${encodeURIComponent(path)}${from ? `&from=${encodeURIComponent(from)}` : ''}`), [], [rehearsalId, path, from]);
  const [inline, setInline] = useState(false);
  if (d.loading) return <Spinner />;
  if (d.error) return <p className="text-sm text-danger">{d.error}</p>;
  if (!d.data) return null;
  if (d.data.binary) return <p className="text-sm text-muted">Binair bestand: geen tekstverschil te tonen.</p>;
  if (d.data.tooLarge) return <p className="text-sm text-muted">Te groot om regel voor regel te tonen.</p>;
  const both = typeof d.data.before === 'string' && typeof d.data.after === 'string';
  return (
    <div className="space-y-1.5">
      <div className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          <span className="text-ok">+{d.data.added}</span> <span className="text-danger">−{d.data.removed}</span>
          {d.data.conflict && ' · vergeleken met jouw huidige versie'}
        </span>
        {both && (
          <button type="button" className="rounded px-1.5 py-0.5 font-semibold hover:bg-surface-2 hover:text-fg coarse:min-h-11" onClick={() => setInline(!inline)} aria-pressed={inline}>
            {inline ? 'Naast elkaar' : 'Onder elkaar'}
          </button>
        )}
      </div>
      {both && !inline ? <SideBySide before={d.data.before!} after={d.data.after!} leftMissing={d.data.inOriginal === false} rightMissing={d.data.inRehearsal === false} /> : <DiffView text={d.data.diff} />}
    </div>
  );
}

type CompareData = { binary: boolean; tooLarge?: boolean; left?: string; right?: string; inLeft: boolean; inRight: boolean; leftChanged: boolean; rightChanged: boolean; same: boolean };
type Practice = { id: string; agent: string };

/** One file from two bots' practice runs side by side, and which version goes into the real folder (B-42). */
function CompareFile({ mine, other, path, onApplied }: { mine: Practice; other: Practice; path: string; onApplied(): void }) {
  const d = useLive(() => api.get<CompareData>(`/computers/rehearsals/${mine.id}/compare?with=${encodeURIComponent(other.id)}&path=${encodeURIComponent(path)}`), ['rehearsal.updated'], [mine.id, other.id, path]);
  const { busy, run } = useAsync();
  const apply = (p: Practice) =>
    run(async () => {
      const res: any = await api.post(`/computers/rehearsals/${p.id}/apply`, { files: [path] });
      onApplied();
      if (res.conflicts?.length) toast(`Niet toegepast: ${path} is veranderd sinds ${p.agent} begon. Open het bestand om te kiezen.`, 'neutral');
      else toast(`De versie van ${p.agent} staat nu in je echte map`, 'ok');
    });
  if (d.loading && !d.data) return <Spinner />;
  if (d.error) return <p className="text-sm text-danger">{d.error}</p>;
  if (!d.data) return null;
  const x = d.data;
  return (
    <div className="space-y-2">
      {x.same ? (
        <p className="text-sm text-muted">Beide bots hebben hier hetzelfde.</p>
      ) : x.binary ? (
        <p className="text-sm text-muted">Binair bestand: geen tekstverschil te tonen.</p>
      ) : x.tooLarge ? (
        <p className="text-sm text-muted">Te groot om regel voor regel te tonen.</p>
      ) : (
        <SideBySide before={x.left || ''} after={x.right || ''} leftTitle={`Oefenronde van ${mine.agent}`} rightTitle={`Oefenronde van ${other.agent}`} leftMissing={!x.inLeft} rightMissing={!x.inRight} rightMissingText="bestaat niet" />
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={busy} disabled={!x.leftChanged} onClick={() => apply(mine)}>
          Versie van {mine.agent} toepassen
        </Button>
        <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={busy} disabled={!x.rightChanged} onClick={() => apply(other)}>
          Versie van {other.agent} toepassen
        </Button>
      </div>
    </div>
  );
}

/** "Ook bezig in deze map": per file what each bot made, side by side, and choose one to apply. */
function CompareWith({ mine, mineChanges, other, otherChanges, onApplied }: { mine: Practice; mineChanges: FileChange[]; other: Practice; otherChanges: FileChange[]; onApplied(): void }) {
  const [show, setShow] = useState(false);
  const [open, setOpen] = useState<string | null>(null);
  const files = useMemo(() => {
    const m = new Map<string, { mine: boolean; other: boolean }>();
    // A moved file touches two places; both are compared (applying either one applies the whole move).
    const paths = (c: FileChange) => (c.from ? [c.from, c.path] : [c.path]);
    for (const c of mineChanges) for (const p of paths(c)) m.set(p, { mine: true, other: false });
    for (const c of otherChanges) for (const p of paths(c)) m.set(p, { mine: m.get(p)?.mine || false, other: true });
    return [...m.entries()].sort((a, b) => Number(b[1].mine && b[1].other) - Number(a[1].mine && a[1].other) || a[0].localeCompare(b[0]));
  }, [mineChanges, otherChanges]);
  return (
    <div className="space-y-2" data-testid="compare-practice">
      <button type="button" className="flex items-center gap-1 font-semibold hover:underline coarse:min-h-11" onClick={() => setShow(!show)} aria-expanded={show}>
        {show ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        Vergelijk met de oefenronde van {other.agent}
      </button>
      {show &&
        (files.length === 0 ? (
          <p className="text-muted">Nog geen wijzigingen om te vergelijken.</p>
        ) : (
          <>
            <p className="text-muted">Kies per bestand welke versie in je echte map komt.</p>
            <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
              {files.map(([p, who]) => (
                <li key={p} className="px-2 py-1.5">
                  <button type="button" className="flex w-full min-w-0 items-center gap-2 text-start" onClick={() => setOpen(open === p ? null : p)} aria-expanded={open === p}>
                    {open === p ? <ChevronDown className="h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="h-3.5 w-3.5 shrink-0" />}
                    <span className="min-w-0 flex-1 truncate font-mono">{p}</span>
                    <Badge tone={who.mine && who.other ? 'warn' : 'neutral'}>{who.mine && who.other ? 'beide bots' : who.mine ? `alleen ${mine.agent}` : `alleen ${other.agent}`}</Badge>
                  </button>
                  {open === p && (
                    <div className="mt-2">
                      <CompareFile mine={mine} other={other} path={p} onApplied={onApplied} />
                    </div>
                  )}
                </li>
              ))}
            </ul>
          </>
        ))}
    </div>
  );
}

function RehearsalCard({ agentId, r, changes, reload }: { agentId: string; r: Rehearsal; changes: FileChange[]; reload(): void }) {
  const { busy, run } = useAsync();
  const [sel, setSel] = useState<Set<string>>(new Set());
  const [open, setOpen] = useState<string | null>(null);
  const [confirmEnd, setConfirmEnd] = useState(false);
  const compare = useLive(() => api.get<{ rehearsal: Rehearsal; agent: string; changes: FileChange[] }[]>(`/computers/${agentId}/rehearsal/compare`), ['rehearsal.updated'], [agentId]);
  const others = (compare.data || []).filter((x) => x.rehearsal.id !== r.id);
  const toggle = (p: string) => setSel((s) => {
    const n = new Set(s);
    if (n.has(p)) n.delete(p);
    else n.add(p);
    return n;
  });
  const chosen = sel.size ? [...sel] : null;
  const conflicts = changes.filter((c) => c.conflict);
  const apply = (files: string[] | null, force: string[] = []) =>
    run(async () => {
      const res = await api.post<{ applied: string[]; conflicts: string[]; held?: HeldDeletion[] }>(`/computers/rehearsals/${r.id}/apply`, { files, force });
      setSel(new Set());
      reload();
      const held = res.held || [];
      // B-36: a deletion whose content would then only be in a new file outside the real folder is not done.
      const heldText = !held.length
        ? ''
        : held.length === 1
          ? t('{0} is niet verwijderd: de inhoud staat nu in {1}. Pas ze samen toe.', held[0].path, held[0].keptFor)
          : t('{0, plural, one {# bestand is niet verwijderd: de inhoud staat in een nieuw bestand. Pas ze samen toe.} other {# bestanden zijn niet verwijderd: de inhoud staat in nieuwe bestanden. Pas ze samen toe.}}', held.length);
      const done = `${res.applied.length} toegepast${res.conflicts.length ? `, ${res.conflicts.length} overgeslagen (conflict)` : ''}`;
      // Only the held-back deletion when that was all there was to do (no "0 toegepast" in front of it).
      const text = !heldText ? done : res.applied.length || res.conflicts.length ? `${done}. ${heldText}` : heldText;
      toast(text, res.conflicts.length || held.length ? 'neutral' : 'ok');
    });
  /** Discard the bot's change to these files (the practice copy goes back to the real folder's version). */
  const revert = (files: string[]) =>
    run(async () => {
      const res = await api.post<{ kept?: { path: string; because: string }[] }>(`/computers/rehearsals/${r.id}/revert`, { files });
      setSel(new Set());
      setOpen(null);
      reload();
      const kept = res.kept || [];
      // B-36: not adding the file that replaced a deleted one keeps the deleted one, so "apply the rest" cannot lose it.
      const keptText = !kept.length
        ? ''
        : kept.length === 1
          ? t('{0} blijft ook staan, want de bot had het vervangen door {1} en dat voeg je niet toe.', kept[0].path, kept[0].because)
          : t('{0, plural, one {# verwijderd bestand blijft staan, want je voegt het nieuwe bestand niet toe.} other {# verwijderde bestanden blijven staan, want je voegt de nieuwe bestanden niet toe.}}', kept.length);
      const done = files.length === 1 ? 'Wijziging verworpen' : 'Wijzigingen verworpen';
      toast(keptText ? `${done}. ${keptText}` : done, keptText ? 'neutral' : 'ok');
    });

  return (
    <Card className="space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <FlaskConical className="h-4 w-4 text-accent" aria-hidden />
        <span className="font-medium">Repetitie</span>
        <Badge tone={r.status === 'review' ? 'accent' : 'neutral'}>{r.status === 'review' ? 'Klaar om te bekijken' : 'Bot werkt in een kopie'}</Badge>
        <span className="text-xs text-muted">sinds {fmtTime(r.created_at)}</span>
      </div>
      {r.note && <p className="text-sm">{r.note}</p>}
      <p className="flex flex-wrap items-center gap-x-1 text-xs text-muted">
        <span>{t('De bot werkt in een kopie van {0}.', folderName(r.original, agentById(r.agent_id || agentId)?.name))}</span>
        <CopyPath path={r.original} />
        <span>Niets komt in je echte map tot je het hier toepast. Bestanden die jij intussen zelf veranderde worden niet zomaar overschreven.</span>
      </p>
      {others.length > 0 && (
        <div className="space-y-2 rounded-lg bg-surface-2 p-2 text-xs">
          <div>Ook bezig in deze map: {others.map((o) => (o.changes.length === 1 ? `${o.agent} (1 bestand)` : `${o.agent} (${o.changes.length} bestanden)`)).join(', ')}</div>
          {others.map((o) => (
            <CompareWith
              key={o.rehearsal.id}
              mine={{ id: r.id, agent: compare.data?.find((x) => x.rehearsal.id === r.id)?.agent || 'deze bot' }}
              mineChanges={changes}
              other={{ id: o.rehearsal.id, agent: o.agent }}
              otherChanges={o.changes}
              onApplied={() => (reload(), compare.reload())}
            />
          ))}
        </div>
      )}
      {changes.length === 0 ? (
        <p className="text-sm text-muted">Nog geen wijzigingen.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {changes.map((c) => {
            const badge = badgeOf(c);
            const other = c.related?.[0];
            return (
              <li key={c.path} className="px-2 py-1.5" data-testid={c.change === 'moved' ? 'moved-change' : undefined}>
                <div className="flex flex-wrap items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    checked={sel.has(c.path)}
                    onChange={() => toggle(c.path)}
                    aria-label={c.from ? t('Selecteer de verplaatsing van {0} naar {1}', c.from, c.path) : `Selecteer ${c.path}`}
                    className="h-4 w-4 accent-[var(--color-accent)]"
                  />
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                  {c.conflict && (
                    <Badge tone="danger">
                      <AlertTriangle className="h-3 w-3" /> ook door jou gewijzigd
                    </Badge>
                  )}
                  {/* The whole file name, wrapped when the panel is narrow (it was cut to "n." next to the badges). A
                      moved file shows both places in one row (B-36), the old one dimmed. */}
                  <button className="flex min-w-[10rem] flex-1 items-start gap-1 text-start font-mono text-xs hover:underline" onClick={() => setOpen(open === c.path ? null : c.path)} aria-expanded={open === c.path}>
                    {open === c.path ? <ChevronDown className="mt-px h-3.5 w-3.5 shrink-0" /> : <ChevronRight className="mt-px h-3.5 w-3.5 shrink-0" />}
                    {c.from ? (
                      // Old and new place wrap as two parts ("→ new" on its own line when narrow), not mid-name. The
                      // arrow is text, so the button's name is what it shows; paths read left to right in every language.
                      <span dir="ltr" className="flex min-w-0 flex-wrap items-baseline gap-x-1">
                        <span className="min-w-0 text-muted [overflow-wrap:anywhere]">
                          <PathText path={c.from} />
                        </span>
                        <span className="min-w-0 [overflow-wrap:anywhere]">
                          → <PathText path={c.path} />
                        </span>
                      </span>
                    ) : (
                      <span className="min-w-0 [overflow-wrap:anywhere]">
                        <PathText path={c.path} />
                      </span>
                    )}
                  </button>
                </div>
                {other && <p className="ms-6 mt-0.5 text-xs text-muted [overflow-wrap:anywhere]">{c.change === 'deleted' ? t('Lijkt op het nieuwe bestand {0}.', other) : t('Lijkt op het verwijderde bestand {0}.', other)}</p>}
                {open === c.path && (
                  <div className="mt-2 space-y-2">
                    {c.change === 'moved' ? (
                      <>
                        <p className="text-sm text-muted [overflow-wrap:anywhere]">
                          {c.edited
                            ? t('De bot heeft dit bestand verplaatst van {0} naar {1} en de inhoud aangepast.', c.from || '', c.path)
                            : t('De bot heeft dit bestand verplaatst van {0} naar {1}. De inhoud is hetzelfde gebleven.', c.from || '', c.path)}
                        </p>
                        {c.edited && <FileDiff rehearsalId={r.id} path={c.path} from={c.from} />}
                      </>
                    ) : c.change !== 'deleted' ? (
                      <FileDiff rehearsalId={r.id} path={c.path} />
                    ) : (
                      <p className="text-sm text-muted">De bot heeft dit bestand verwijderd.</p>
                    )}
                    {other && (
                      <p className="text-sm text-warn [overflow-wrap:anywhere]">
                        {c.change === 'deleted'
                          ? t('De inhoud lijkt op het nieuwe {0}. Het wordt pas verwijderd als {0} ook is toegevoegd.', other)
                          : t('Dit bestand lijkt op het verwijderde {0}. Voeg je het niet toe, dan blijft {0} staan.', other)}
                      </p>
                    )}
                    <div className="flex flex-wrap gap-2">
                      {c.conflict ? (
                        <Button size="sm" variant="danger" loading={busy} onClick={() => apply([c.path], [c.path])}>
                          Toch de versie van de bot gebruiken
                        </Button>
                      ) : (
                        <Button size="sm" variant="primary" icon={<Check className="h-3.5 w-3.5" />} loading={busy} onClick={() => apply([c.path])}>
                          {c.change === 'moved' ? 'Verplaatsing toepassen' : c.change === 'deleted' ? 'Ook in je echte map verwijderen' : 'Dit bestand toepassen'}
                        </Button>
                      )}
                      <Button size="sm" icon={<Undo2 className="h-3.5 w-3.5" />} loading={busy} onClick={() => revert([c.path])}>
                        {c.change === 'moved' ? 'Niet verplaatsen' : c.change === 'added' ? 'Niet toevoegen' : 'Verwerpen'}
                      </Button>
                    </div>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="primary" icon={<Check className="h-4 w-4" />} disabled={!changes.length} loading={busy} onClick={() => apply(chosen)}>
          {chosen ? `Toepassen (${chosen.length})` : 'Alles toepassen'}
        </Button>
        <Button
          size="sm"
          icon={<Undo2 className="h-4 w-4" />}
          disabled={!sel.size}
          loading={busy}
          onClick={() => revert([...sel])}
        >
          Verwerpen
        </Button>
        <Button size="sm" variant="ghost" icon={<X className="h-4 w-4" />} loading={busy} onClick={() => (changes.length ? setConfirmEnd(true) : run(async () => (await api.post(`/computers/rehearsals/${r.id}/end`, {}), reload()), 'Repetitie afgerond'))}>
          Afronden
        </Button>
      </div>
      {conflicts.length > 0 && <p className="text-xs text-warn">{t('{0, plural, one {# bestand heb je zelf ook aangepast. Dat wordt bij "toepassen" overgeslagen; open het om te kiezen.} other {# bestanden heb je zelf ook aangepast. Die worden bij "toepassen" overgeslagen; open ze om te kiezen.}}', conflicts.length)}</p>}
      <Modal
        open={confirmEnd}
        onClose={() => setConfirmEnd(false)}
        title="Repetitie afronden"
        footer={
          <>
            <Button onClick={() => setConfirmEnd(false)}>Annuleren</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                run(async () => {
                  await api.post(`/computers/rehearsals/${r.id}/end`, { discard: true });
                  setConfirmEnd(false);
                  reload();
                }, 'Repetitie afgerond; overige wijzigingen verworpen')
              }
            >
              Verwerpen en afronden
            </Button>
          </>
        }
      >
        <p className="text-sm">{t('{0, plural, one {# wijziging is nog niet toegepast en gaat verloren.} other {# wijzigingen zijn nog niet toegepast en gaan verloren.}}', changes.length)}</p>
      </Modal>
    </Card>
  );
}

function Snapshots({ agentId }: { agentId: string }) {
  const list = useLive(() => api.get<Snapshot[]>(`/computers/${agentId}/snapshots`), ['snapshot.updated'], [agentId]);
  const { busy, run } = useAsync();
  const [label, setLabel] = useState('');
  const [restore, setRestore] = useState<Snapshot | null>(null);
  const [plan, setPlan] = useState<{ overwrite: string[]; recreate: string[]; extra: string[]; unchanged: number } | null>(null);
  const [deleteExtra, setDeleteExtra] = useState(false);
  const openRestore = async (s: Snapshot) => {
    setRestore(s);
    setPlan(null);
    setDeleteExtra(false);
    const p = await run(() => api.get(`/computers/snapshots/${s.id}/preview`));
    if (p) setPlan(p as any);
    else setRestore(null);
  };
  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-muted">
        <Camera className="h-3.5 w-3.5" /> Snapshots van de werkmap
      </div>
      <form
        className="flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          run(async () => {
            await api.post(`/computers/${agentId}/snapshots`, { label: label || 'Handmatige snapshot' });
            setLabel('');
            list.reload();
          }, 'Snapshot gemaakt');
        }}
      >
        <Input value={label} onChange={(e) => setLabel(e.target.value)} placeholder="Naam, bijv. voor de grote opruiming" aria-label="Naam van de snapshot" />
        <Button type="submit" size="sm" loading={busy} className="shrink-0 whitespace-nowrap">
          Maak snapshot
        </Button>
      </form>
      <p className="text-xs text-muted">Mappen als node_modules, .git en dist en bestanden groter dan 10 MB worden overgeslagen.</p>
      {list.loading && !list.data ? (
        <Spinner />
      ) : list.error ? (
        <p className="text-sm text-danger">{list.error}</p>
      ) : !list.data?.length ? (
        <p className="text-sm text-muted">Nog geen snapshots.</p>
      ) : (
        <ul className="divide-y divide-line rounded-lg border border-line">
          {list.data.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-2 px-2 py-1.5 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">{s.label}</div>
                <div className="text-xs text-muted">
                  {fmtTime(s.created_at)} · {s.files === 1 ? '1 bestand' : `${s.files} bestanden`} · {fmtBytes(s.bytes)}
                  {s.auto ? ' · automatisch' : ''}
                  {s.partial ? ' · alleen gewijzigde bestanden' : ''}
                </div>
              </div>
              <Button size="sm" icon={<RotateCcw className="h-4 w-4" />} onClick={() => openRestore(s)}>
                Herstel…
              </Button>
              <Button size="icon" variant="ghost" aria-label={`Verwijder snapshot ${s.label}`} onClick={() => run(async () => (await api.del(`/computers/snapshots/${s.id}`), list.reload()), 'Snapshot verwijderd')}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <Modal
        open={!!restore}
        onClose={() => setRestore(null)}
        title={`Herstellen: ${restore?.label || ''}`}
        wide
        footer={
          <>
            <Button onClick={() => setRestore(null)}>Annuleren</Button>
            <Button
              variant="danger"
              disabled={!plan}
              loading={busy}
              onClick={() =>
                run(async () => {
                  await api.post(`/computers/snapshots/${restore!.id}/restore`, { deleteExtra });
                  setRestore(null);
                  list.reload();
                }, 'Hersteld. Er is eerst een automatische snapshot gemaakt, zodat je dit kunt terugdraaien.')
              }
            >
              Herstellen
            </Button>
          </>
        }
      >
        {!plan ? (
          <Spinner />
        ) : (
          <div className="space-y-3 text-sm">
            <p>Voor het herstellen maakt TeamBot eerst een automatische snapshot van wat er verandert, zodat je terug kunt.</p>
            <PlanList title="Wordt teruggezet (nu anders)" items={plan.overwrite} />
            <PlanList title="Wordt teruggezet (nu weg)" items={plan.recreate} />
            <PlanList title={deleteExtra ? 'Later gemaakt (wordt verwijderd)' : 'Later gemaakt (blijft staan)'} items={plan.extra} />
            {plan.extra.length > 0 && <Toggle checked={deleteExtra} onChange={setDeleteExtra} label={t('{0, plural, one {Verwijder ook het later gemaakte bestand} other {Verwijder ook de # later gemaakte bestanden}}', plan.extra.length)} />}
            {/* Only when restoring really changes nothing: later-made files can still be deleted with the switch. */}
            {!plan.overwrite.length && !plan.recreate.length && !plan.extra.length && <p className="text-muted">Er is niets te herstellen: de werkmap komt overeen met deze snapshot.</p>}
          </div>
        )}
      </Modal>
    </div>
  );
}

function PlanList({ title, items }: { title: string; items: string[] }) {
  if (!items.length) return null;
  return (
    <div>
      <div className="mb-1 text-xs font-medium text-muted">
        {title} ({items.length})
      </div>
      <ul className="scroll-thin max-h-32 overflow-y-auto rounded-lg bg-surface-2 p-2 font-mono text-xs">
        {items.slice(0, 200).map((i) => (
          <li key={i} className="truncate">
            {i}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Inspector tab "Wijzigingen": rehearsal diff (apply/discard) and workspace snapshots. */
export function ChangesTab({ agentId }: { threadId: string; agentId: string | null }) {
  const data = useLive(
    () => (agentId ? api.get<{ rehearsal: Rehearsal | null; changes: FileChange[] }>(`/computers/${agentId}/rehearsal`) : Promise.resolve(null)),
    ['rehearsal.updated', 'agent.updated'],
    [agentId],
  );
  const { busy, run } = useAsync();
  const [note, setNote] = useState('');
  if (!agentId) return <EmptyState title="Geen bot gekozen">Open een gesprek met één bot om zijn wijzigingen te zien.</EmptyState>;
  if (data.loading && !data.data) return <Spinner />;
  if (data.error) return <EmptyState title="Kon wijzigingen niet laden">{data.error}</EmptyState>;
  const r = data.data?.rehearsal;
  return (
    <div className="space-y-4">
      {r ? (
        <RehearsalCard agentId={agentId} r={r} changes={data.data?.changes || []} reload={data.reload} />
      ) : (
        <Card className="space-y-2 p-3">
          <div className="flex items-center gap-2 font-medium">
            <FlaskConical className="h-4 w-4 text-accent" aria-hidden /> Repetitie
          </div>
          <p className="text-sm text-muted">Laat de bot eerst in een kopie van zijn werkmap werken. Daarna zie je per bestand wat er veranderd is en kies je wat je toepast.</p>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              run(async () => {
                await api.post(`/computers/${agentId}/rehearsal`, { note });
                setNote('');
                data.reload();
              }, 'Repetitie gestart');
            }}
          >
            <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Wat moet de bot proberen? (optioneel)" aria-label="Notitie bij de repetitie" />
            <Button type="submit" size="sm" loading={busy} className="shrink-0 whitespace-nowrap">
              Start
            </Button>
          </form>
        </Card>
      )}
      <Snapshots agentId={agentId} />
    </div>
  );
}
