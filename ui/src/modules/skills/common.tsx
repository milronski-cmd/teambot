import React, { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { AlertTriangle, BadgeCheck, CheckCircle2, ChevronDown, ChevronRight, FileCode2, FileText, Globe, Info, KeyRound, PenLine, ShieldAlert, ShieldCheck, ShieldOff, ShieldQuestion, ShieldX, Terminal, Wrench } from 'lucide-react';
import { Badge, Button, Card, Field, Input, Modal, cx, toast, useAsync } from '../../components/ui';
import { BotPicker } from '../../components/BotPicker';
import { api } from '../../lib/api';
import { t } from '../../lib/i18n';
import { useApp } from '../../lib/store';
import type { Candidate, CommitResult, Finding, Level, PermissionDiff, Permissions, PolicyDecision, ScanFileView, SignatureView, StagingView, Substance } from './api';
import { SOURCE_TYPES, formatBytes } from './api';

// ---------------------------------------------------------------- publisher signatures

const SIG: Record<SignatureView['state'], { tone: 'ok' | 'neutral' | 'warn' | 'danger'; icon: React.ReactNode }> = {
  builtin: { tone: 'ok', icon: <BadgeCheck className="h-3.5 w-3.5" /> },
  trusted: { tone: 'ok', icon: <ShieldCheck className="h-3.5 w-3.5" /> },
  untrusted: { tone: 'warn', icon: <PenLine className="h-3.5 w-3.5" /> },
  unsigned: { tone: 'neutral', icon: <ShieldOff className="h-3.5 w-3.5" /> },
  invalid: { tone: 'danger', icon: <ShieldX className="h-3.5 w-3.5" /> },
};

/** "Ondertekend door …", "Ondertekend, onbekende uitgever", "Niet ondertekend", "Handtekening ongeldig" (+ incompatible). */
export function SignatureBadge({ sig }: { sig: SignatureView | null | undefined }) {
  if (!sig) return null;
  const s = SIG[sig.state] || SIG.unsigned;
  return (
    <>
      <Badge tone={s.tone}>
        {s.icon}
        {sig.label}
      </Badge>
      {!sig.compatible && (
        <Badge tone="danger">
          <AlertTriangle className="h-3.5 w-3.5" /> Niet compatibel met deze TeamBot-versie
        </Badge>
      )}
    </>
  );
}

/** Admins/owners can add a signing key to the trusted publishers straight from a package view. */
export function TrustPublisherButton({ sig, onDone }: { sig: SignatureView; onDone?(): void }) {
  const me = useApp((s) => s.me);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(sig.declaredPublisher || '');
  const { busy, run } = useAsync();
  if (!sig.publicKey || sig.state !== 'untrusted' || !me || me.role === 'member') return null;
  return (
    <>
      <Button size="sm" icon={<ShieldCheck className="h-4 w-4" />} onClick={() => setOpen(true)}>
        Vertrouw deze uitgever
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Uitgever vertrouwen"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Annuleren
            </Button>
            <Button variant="primary" loading={busy} disabled={!name.trim()} onClick={() => run(async () => (await api.post('/skills/publishers/trusted', { publicKey: sig.publicKey, name: name.trim(), publisherId: sig.publisherId || '' }), setOpen(false), onDone?.()), 'Uitgever vertrouwd')}>
              Vertrouwen
            </Button>
          </>
        }
      >
        <div className="space-y-3 text-sm">
          <p>Alles met deze sleutel telt daarna als “vertrouwde uitgever”. Vergelijk eerst de vingerafdruk.</p>
          <p>
            Vingerafdruk: <code className="break-all">{sig.fingerprint}</code>
          </p>
          <Field label="Naam waaronder je deze uitgever toont" hint="De naam in het pakket kiest de uitgever zelf; hier bepaal jij de naam die gebruikers zien.">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
        </div>
      </Modal>
    </>
  );
}

/** Details of a signature: who signed, key fingerprint, compatibility, and why an install is blocked. */
export function SignaturePanel({ sig, policy, onTrusted }: { sig: SignatureView | null | undefined; policy?: PolicyDecision | null; onTrusted?(): void }) {
  if (!sig) return null;
  const explain: Record<SignatureView['state'], string> = {
    builtin: 'Hoort bij TeamBot zelf en komt mee met de installatie.',
    trusted: 'De handtekening klopt en de sleutel staat in de lijst van vertrouwde uitgevers van deze installatie.',
    untrusted: 'De handtekening klopt, maar deze sleutel staat niet in de lijst van vertrouwde uitgevers.',
    unsigned: 'Er is geen handtekening: je kunt niet controleren wie dit maakte of dat het onderweg is gewijzigd.',
    invalid: 'De handtekening of de bestanden kloppen niet. Dit pakket kan niet worden geïnstalleerd.',
  };
  return (
    <div className={cx('space-y-2 rounded-lg border p-3 text-sm', sig.blocked ? 'border-danger/30 bg-danger-soft' : sig.state === 'unsigned' || sig.state === 'untrusted' ? 'border-line' : 'border-ok/30')}>
      <div className="flex flex-wrap items-center gap-2">
        <SignatureBadge sig={sig} />
        {sig.version && <span className="text-xs text-muted">pakketversie {sig.version}</span>}
      </div>
      <p className="text-muted">{explain[sig.state]}</p>
      {(sig.publicKey || sig.declaredPublisher) && sig.state !== 'builtin' && (
        <dl className="grid grid-cols-[8rem_1fr] gap-x-3 gap-y-0.5 text-xs">
          {sig.declaredPublisher && (
            <>
              <dt className="text-muted">Noemt zich</dt>
              <dd className="min-w-0 break-words">
                {sig.declaredPublisher}
                {sig.publisherId ? ` (${sig.publisherId})` : ''}
              </dd>
            </>
          )}
          {sig.fingerprint && (
            <>
              <dt className="text-muted">Vingerafdruk</dt>
              <dd className="min-w-0 break-all font-mono">{sig.fingerprint}</dd>
            </>
          )}
          {sig.teambot && (
            <>
              <dt className="text-muted">Werkt met TeamBot</dt>
              <dd className="font-mono">{sig.teambot}</dd>
            </>
          )}
          {sig.via && (
            <>
              <dt className="text-muted">Meegeleverd met</dt>
              <dd className="min-w-0 break-words">{sig.via}</dd>
            </>
          )}
        </dl>
      )}
      {sig.errors.length > 0 && (
        <ul className="list-disc space-y-0.5 ps-5 text-danger">
          {sig.errors.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {sig.incompatible.length > 0 && (
        <ul className="list-disc space-y-0.5 ps-5 text-danger">
          {sig.incompatible.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {sig.warnings.length > 0 && (
        <ul className="list-disc space-y-0.5 ps-5 text-warn">
          {sig.warnings.map((e, i) => (
            <li key={i}>{e}</li>
          ))}
        </ul>
      )}
      {policy && <PolicyNotice policy={policy} />}
      <TrustPublisherButton sig={sig} onDone={onTrusted} />
    </div>
  );
}

/** What the publisher policy says about installing this package for the current user. */
export function PolicyNotice({ policy }: { policy: PolicyDecision }) {
  if (policy.allowed || !policy.reason) return null;
  return (
    <p role={policy.blocked ? 'alert' : undefined} className={cx('rounded-lg px-3 py-2 text-sm', policy.blocked ? 'bg-danger-soft text-danger' : 'bg-warn-soft text-warn')}>
      {policy.reason}
    </p>
  );
}

/** Explicit, audited override of the publisher policy (owner/admin only; the server checks this again). */
export function PolicyOverride({ checked, onChange }: { checked: boolean; onChange(v: boolean): void }) {
  return (
    <label className="flex items-start gap-2 text-sm">
      <input type="checkbox" className="mt-0.5 h-4 w-4" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>
        <ShieldAlert className="me-1 inline h-4 w-4 text-warn" />
        Ik sta dit pakket toch toe, buiten het uitgeversbeleid. Dit wordt vastgelegd.
      </span>
    </label>
  );
}

/** Markdown preview (raw HTML is not rendered; links open safely in a new tab). */
export function Md({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx('md text-sm', className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-accent underline">
              {children}
            </a>
          ),
          img: ({ alt }) => <span className="text-muted">[afbeelding: {alt || 'zonder beschrijving'}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

/** Strip the frontmatter for previews. */
export function bodyOf(skillMd: string) {
  const m = skillMd.replace(/^﻿/, '').match(/^---[ \t]*\r?\n[\s\S]*?\r?\n?---[ \t]*(?:\r?\n|$)/);
  return m ? skillMd.slice(m[0].length) : skillMd;
}

const LEVEL: Record<Level, { label: string; tone: 'ok' | 'neutral' | 'warn' | 'danger'; icon: React.ReactNode }> = {
  ok: { label: 'Geen bevindingen', tone: 'ok', icon: <ShieldCheck className="h-3.5 w-3.5" /> },
  info: { label: 'Ter info', tone: 'neutral', icon: <Info className="h-3.5 w-3.5" /> },
  warn: { label: 'Waarschuwing', tone: 'warn', icon: <ShieldQuestion className="h-3.5 w-3.5" /> },
  danger: { label: 'Ernstige waarschuwing', tone: 'danger', icon: <ShieldAlert className="h-3.5 w-3.5" /> },
};

export function ScanBadge({ level }: { level: Level }) {
  const l = LEVEL[level] || LEVEL.info;
  return (
    <Badge tone={l.tone}>
      {l.icon}
      {l.label}
    </Badge>
  );
}

const LABELS: Record<string, { text: string; tone: 'neutral' | 'accent' | 'warn' | 'danger' | 'ok' }> = {
  'prompt-only': { text: 'Alleen instructies', tone: 'ok' },
  scripts: { text: 'Bevat scripts', tone: 'warn' },
  binary: { text: 'Bevat programma', tone: 'danger' },
  injectie: { text: 'Verdachte instructies', tone: 'danger' },
  exfiltratie: { text: 'Mogelijk datalek', tone: 'danger' },
  geheim: { text: 'Mogelijk geheim', tone: 'danger' },
  'riskante-opdracht': { text: 'Riskante opdracht', tone: 'danger' },
  netwerk: { text: 'Externe adressen', tone: 'neutral' },
};

export function LabelBadges({ labels }: { labels: string[] }) {
  return (
    <>
      {labels.map((l) => (
        <Badge key={l} tone={LABELS[l]?.tone || 'neutral'}>
          {LABELS[l]?.text || l}
        </Badge>
      ))}
    </>
  );
}

export function VerifiedBadge({ verified }: { verified: boolean }) {
  return verified ? (
    <Badge tone="ok">
      <BadgeCheck className="h-3.5 w-3.5" /> Geverifieerd
    </Badge>
  ) : (
    <Badge tone="warn">
      <ShieldQuestion className="h-3.5 w-3.5" /> Niet geverifieerd
    </Badge>
  );
}

export function FindingsList({ findings, max = 50 }: { findings: Finding[]; max?: number }) {
  const [all, setAll] = useState(false);
  if (!findings.length) return <p className="text-sm text-muted">De scan vond niets bijzonders.</p>;
  const shown = all ? findings : findings.slice(0, max);
  return (
    <ul className="space-y-1.5">
      {shown.map((f, i) => (
        <li key={i} className={cx('rounded-lg border px-3 py-2 text-sm', f.severity === 'danger' ? 'border-danger/30 bg-danger-soft' : f.severity === 'warn' ? 'border-warn/30 bg-warn-soft' : 'border-line bg-surface-2')}>
          <div className="flex items-start gap-2">
            {f.severity === 'danger' ? <ShieldAlert className="mt-0.5 h-4 w-4 shrink-0 text-danger" /> : f.severity === 'warn' ? <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-warn" /> : <Info className="mt-0.5 h-4 w-4 shrink-0 text-muted" />}
            <div className="min-w-0">
              <div>{f.message}</div>
              {(f.file || f.line) && (
                <div className="text-xs text-muted">
                  {f.file}
                  {f.line ? `:${f.line}` : ''}
                </div>
              )}
              {f.excerpt && <code className="mt-1 block whitespace-pre-wrap break-all rounded bg-canvas px-1.5 py-1 text-xs">{f.excerpt}</code>}
            </div>
          </div>
        </li>
      ))}
      {findings.length > shown.length && (
        <li>
          <Button size="sm" variant="ghost" onClick={() => setAll(true)}>
            {t('{0, plural, one {Toon # bevinding} other {Toon alle # bevindingen}}', findings.length)}
          </Button>
        </li>
      )}
    </ul>
  );
}

const GROUP_LABEL: Record<string, string> = { shell: 'Terminal', files: 'Bestanden', web: 'Internet', browser: 'Browser', mcp: 'Connectors (MCP)' };

export function PermissionsView({ p }: { p: Permissions }) {
  const none = !p.tools.length && !p.scripts.length && !p.binaries.length && !p.domains.length;
  if (none)
    return (
      <p className="flex items-center gap-2 text-sm text-muted">
        <CheckCircle2 className="h-4 w-4 text-ok" /> Alleen instructies: vraagt geen extra tools, bevat geen scripts en verwijst niet naar externe adressen.
      </p>
    );
  return (
    <div className="space-y-2 text-sm">
      {p.tools.length > 0 && (
        <Row icon={<Wrench className="h-4 w-4" />} title="Verwacht deze tools">
          <span className="break-words">{p.tools.join(', ')}</span>
          {p.groups.length > 0 && <span className="text-muted"> — {p.groups.map((g) => GROUP_LABEL[g] || g).join(', ')}</span>}
          <div className="text-xs text-muted">Een skill krijgt nooit zelf rechten.</div>
        </Row>
      )}
      {p.scripts.length > 0 && (
        <Row icon={<Terminal className="h-4 w-4" />} title="Scripts">
          {p.scripts.map((s) => s.path).join(', ')}
          <div className="text-xs text-muted">Worden nooit automatisch uitgevoerd; pas na "Vertrouw deze skill", en dan elke keer met jouw toestemming.</div>
        </Row>
      )}
      {p.binaries.length > 0 && (
        <Row icon={<ShieldAlert className="h-4 w-4 text-danger" />} title="Programma's (binair)">
          {p.binaries.join(', ')}
        </Row>
      )}
      {p.domains.length > 0 && (
        <Row icon={<Globe className="h-4 w-4" />} title="Externe adressen">
          <span className="break-words">{p.domains.join(', ')}</span>
        </Row>
      )}
    </div>
  );
}

function Row({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-2">
      <div className="mt-0.5 text-muted">{icon}</div>
      <div className="min-w-0">
        <div className="font-medium">{title}</div>
        <div>{children}</div>
      </div>
    </div>
  );
}

export function DiffView({ d }: { d: PermissionDiff }) {
  const items: [string, string[], 'add' | 'remove'][] = [
    ['Nieuwe tools', d.addedTools, 'add'],
    ['Nieuwe toolgroepen', d.addedGroups.map((g) => GROUP_LABEL[g] || g), 'add'],
    ['Nieuwe scripts', d.addedScripts, 'add'],
    ['Gewijzigde scripts', d.changedScripts, 'add'],
    ['Nieuwe programma’s', d.addedBinaries, 'add'],
    ['Nieuwe externe adressen', d.addedDomains, 'add'],
    ['Tools vervallen', d.removedTools, 'remove'],
    ['Scripts vervallen', d.removedScripts, 'remove'],
    ['Adressen vervallen', d.removedDomains, 'remove'],
  ];
  const shown = items.filter(([, v]) => v.length);
  if (!shown.length) return <p className="text-sm text-muted">Geen wijziging in rechten.</p>;
  return (
    <ul className="space-y-1 text-sm">
      {shown.map(([t, v, k]) => (
        <li key={t} className={k === 'add' ? 'text-warn' : 'text-muted'}>
          <span className="font-medium">
            {k === 'add' ? '+ ' : '− '}
            {t}:
          </span>{' '}
          <span className="break-words">{v.join(', ')}</span>
        </li>
      ))}
    </ul>
  );
}

export function FileList({ files, onOpen }: { files: ScanFileView[]; onOpen?: (path: string) => void }) {
  return (
    <ul className="divide-y divide-line rounded-lg border border-line">
      {files.map((f) => {
        const icon = f.type === 'script' || f.type === 'executable' ? <FileCode2 className="h-4 w-4 text-warn" /> : <FileText className="h-4 w-4 text-muted" />;
        const inner = (
          <>
            {icon}
            <span className="min-w-0 flex-1 truncate">{f.path}</span>
            {(f.type === 'script' || f.type === 'executable') && <Badge tone={f.type === 'executable' ? 'danger' : 'warn'}>{f.type === 'executable' ? 'programma' : 'script'}</Badge>}
            <span className="shrink-0 text-xs text-muted">{formatBytes(f.size)}</span>
          </>
        );
        return (
          <li key={f.path}>
            {onOpen ? (
              <button className="flex w-full items-center gap-2 px-3 py-2 text-start text-sm hover:bg-surface-2" onClick={() => onOpen(f.path)}>
                {inner}
              </button>
            ) : (
              <div className="flex items-center gap-2 px-3 py-2 text-sm">{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}

export function Collapse({ title, children, defaultOpen = false }: { title: React.ReactNode; children: React.ReactNode; defaultOpen?: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <button className="flex items-center gap-1 text-sm font-medium text-fg hover:text-accent" onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown className="h-4 w-4" /> : <ChevronRight className="h-4 w-4" />}
        {title}
      </button>
      {open && <div className="tb-in mt-2">{children}</div>}
    </div>
  );
}

const ACTION: Record<Candidate['action'], { text: string; tone: 'accent' | 'warn' | 'neutral' }> = {
  create: { text: 'Nieuw', tone: 'accent' },
  update: { text: 'Update', tone: 'warn' },
  unchanged: { text: 'Al geïnstalleerd (identiek)', tone: 'neutral' },
  'add-version': { text: 'Nieuwe versie (vastgepind: blijft op huidige)', tone: 'neutral' },
};

/** "Deze skill doet zelf weinig: …" — shown before installing a skill that only points to another skill or is nearly empty. */
export function ThinSkillWarning({ s }: { s?: Substance | null }) {
  if (!s?.thin || !s.message) return null;
  return (
    <p className="flex items-start gap-2 rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn" role="note">
      <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
      <span>{s.message}</span>
    </p>
  );
}

function CandidateCard({ c, selected, onToggle, result }: { c: Candidate; selected: boolean; onToggle(v: boolean): void; result?: CommitResult }) {
  const [view, setView] = useState<'none' | 'preview' | 'raw'>('none');
  const blocked = c.errors.length > 0 || c.policy.blocked;
  return (
    <Card className={cx('space-y-3 p-4', blocked && 'opacity-80')}>
      <div className="flex flex-wrap items-start gap-3">
        <label className="mt-0.5 flex items-center">
          <input type="checkbox" className="h-4 w-4 accent-[var(--color-accent)]" checked={selected && !blocked} disabled={blocked} onChange={(e) => onToggle(e.target.checked)} aria-label={`${c.name || 'skill'} selecteren`} />
        </label>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-semibold">{c.name || '(zonder naam)'}</span>
            {c.version && <Badge>v{c.version}</Badge>}
            <Badge tone={ACTION[c.action].tone}>{ACTION[c.action].text}</Badge>
            <SignatureBadge sig={c.signature} />
            <ScanBadge level={c.scan.level} />
            <LabelBadges labels={c.scan.labels} />
          </div>
          {c.description && <p className="mt-1 text-sm text-muted">{c.description}</p>}
          <div className="mt-1 flex flex-wrap gap-x-3 text-xs text-muted">
            <span>Bron: {c.source.label || SOURCE_TYPES[c.source.type] || c.source.type}</span>
            {c.license && <span>Licentie: {c.license}</span>}
            {c.author && <span>Auteur: {c.author}</span>}
            <span>
              {c.fileCount === 1 ? '1 bestand' : `${c.fileCount} bestanden`}, {formatBytes(c.size)}
            </span>
            {c.existing && <span>Nu geïnstalleerd: {c.existing.version ? 'v' + c.existing.version : 'r' + c.existing.rev}</span>}
          </div>
        </div>
      </div>
      {result && <ResultLine r={result} />}
      <ThinSkillWarning s={c.substance} />
      <SignaturePanel sig={c.signature} policy={c.policy} />
      {c.publisherChange && (
        <p className="rounded-lg border border-warn/40 bg-warn-soft px-3 py-2 text-sm text-warn">
          <ShieldAlert className="me-1 inline h-4 w-4" />
          {c.publisherChange.reason}
        </p>
      )}
      {c.errors.map((e, i) => (
        <p key={i} className="rounded-lg bg-danger-soft px-3 py-2 text-sm text-danger">
          {e}
        </p>
      ))}
      {c.warnings.length > 0 && (
        <ul className="list-disc space-y-0.5 ps-5 text-sm text-warn">
          {c.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      {(c.action === 'update' || c.action === 'add-version') && (
        <div className={cx('rounded-lg border p-3', c.diff.elevated ? 'border-warn/40 bg-warn-soft' : 'border-line')}>
          <div className="mb-1 text-sm font-medium">{c.diff.elevated ? 'Deze versie vraagt meer rechten' : 'Wijzigingen in rechten'}</div>
          <DiffView d={c.diff} />
        </div>
      )}
      <Collapse title="Rechten en externe aanroepen" defaultOpen={c.scan.level !== 'ok'}>
        <PermissionsView p={c.permissions} />
      </Collapse>
      <Collapse title={c.scan.findings.length === 1 ? 'Veiligheidsscan (1 bevinding)' : `Veiligheidsscan (${c.scan.findings.length} bevindingen)`} defaultOpen={c.scan.level === 'danger' || c.scan.level === 'warn'}>
        <FindingsList findings={c.scan.findings} />
      </Collapse>
      <Collapse title="Bestanden">
        <FileList files={c.scan.files} />
      </Collapse>
      {c.skillMd && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant={view === 'preview' ? 'soft' : 'ghost'} onClick={() => setView(view === 'preview' ? 'none' : 'preview')}>
            Voorbeeld
          </Button>
          <Button size="sm" variant={view === 'raw' ? 'soft' : 'ghost'} onClick={() => setView(view === 'raw' ? 'none' : 'raw')}>
            Brontekst
          </Button>
        </div>
      )}
      {view === 'preview' && (
        <div className="max-h-96 overflow-y-auto rounded-lg border border-line p-3">
          <Md text={bodyOf(c.skillMd)} />
        </div>
      )}
      {view === 'raw' && <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words rounded-lg border border-line bg-canvas p-3 text-xs">{c.skillMd}</pre>}
    </Card>
  );
}

const RESULT: Record<CommitResult['status'], { text: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' }> = {
  created: { text: 'Geïnstalleerd', tone: 'ok' },
  updated: { text: 'Bijgewerkt', tone: 'ok' },
  'version-added': { text: 'Nieuwe versie bewaard (vastgepind)', tone: 'ok' },
  unchanged: { text: 'Ongewijzigd', tone: 'neutral' },
  'needs-confirmation': { text: 'Bevestiging nodig', tone: 'warn' },
  'needs-acknowledge': { text: 'Bevestiging nodig', tone: 'warn' },
  'needs-policy-override': { text: 'Buiten het uitgeversbeleid', tone: 'warn' },
  'needs-publisher-confirmation': { text: 'Andere uitgever', tone: 'warn' },
  blocked: { text: 'Geweigerd', tone: 'danger' },
  error: { text: 'Mislukt', tone: 'danger' },
};

function ResultLine({ r }: { r: CommitResult }) {
  const s = RESULT[r.status];
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge tone={s.tone}>{s.text}</Badge>
      {r.error && <span className="text-muted">{r.error}</span>}
      {r.skillId && (r.status === 'created' || r.status === 'updated' || r.status === 'version-added') && (
        <a className="text-accent underline" href={`#/m/skills/mine/${r.skillId}`}>
          Bekijken
        </a>
      )}
    </div>
  );
}

/** Pick zero or more of the user's bots (the shared bot picker, with "Alle bots"). */
export function AgentPicker({ value, onChange, label = 'Direct inschakelen voor', single }: { value: string[]; onChange(v: string[]): void; label?: string; single?: boolean }) {
  return <BotPicker value={value} onChange={onChange} label={label} single={single} empty="Je hebt nog geen bots. Je kunt de skill later bij een bot inschakelen." />;
}

/** Review staged skills, choose bots, confirm risks and install. */
export function CandidatesReview({ staging, onDone, doneLabel = 'Klaar' }: { staging: StagingView; onDone?: (results: CommitResult[]) => void; doneLabel?: string }) {
  const installable = (c: Candidate) => !c.errors.length && !c.policy.blocked;
  const [sel, setSel] = useState<string[]>(() => staging.candidates.filter((c) => installable(c) && c.action !== 'unchanged').map((c) => c.key));
  const [agents, setAgents] = useState<string[]>([]);
  const [ack, setAck] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [override, setOverride] = useState(false);
  const [publisherOk, setPublisherOk] = useState(false);
  const [results, setResults] = useState<Record<string, CommitResult>>({});
  const [finished, setFinished] = useState(false);
  const { busy, run } = useAsync();
  const chosen = staging.candidates.filter((c) => sel.includes(c.key) && installable(c));
  const needAck = chosen.some((c) => c.needsAcknowledge);
  const lookalike = chosen.some((c) => c.publisherCheck?.status === 'lookalike');
  const needConfirm = chosen.some((c) => c.needsConfirmation);
  const needOverride = chosen.some((c) => c.policy.needsOverride);
  const needPublisher = chosen.some((c) => c.needsPublisherConfirmation);
  const thin = chosen.filter((c) => c.substance?.thin);
  const commit = () =>
    run(async () => {
      const r = await api.post<{ results: CommitResult[] }>('/skills/import/commit', {
        stagingId: staging.stagingId,
        keys: chosen.map((c) => c.key),
        enableFor: agents,
        acknowledge: ack,
        confirmPermissions: confirm,
        overridePolicy: override,
        confirmPublisherChange: publisherOk,
      });
      const map: Record<string, CommitResult> = { ...results };
      for (const x of r.results) map[x.key] = x;
      setResults(map);
      const pending = r.results.filter((x) => ['needs-confirmation', 'needs-acknowledge', 'needs-policy-override', 'needs-publisher-confirmation', 'error'].includes(x.status));
      const ok = r.results.filter((x) => ['created', 'updated', 'version-added'].includes(x.status));
      if (ok.length) toast(ok.length === 1 ? '1 skill geïnstalleerd' : `${ok.length} skills geïnstalleerd`, 'ok');
      if (!pending.length) {
        setFinished(true);
        onDone?.(r.results);
      }
    });
  return (
    <div className="space-y-4">
      {staging.candidates.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted">{t('{0, plural, one {# skill gevonden.} other {# skills gevonden.}}', staging.candidates.length)}</span>
          <Button size="sm" variant="ghost" onClick={() => setSel(staging.candidates.filter(installable).map((c) => c.key))}>
            Alles kiezen
          </Button>
          <Button size="sm" variant="ghost" onClick={() => setSel([])}>
            Niets kiezen
          </Button>
        </div>
      )}
      <div className="space-y-3">
        {staging.candidates.map((c) => (
          <CandidateCard key={c.key} c={c} selected={sel.includes(c.key)} onToggle={(v) => setSel((s) => (v ? [...s, c.key] : s.filter((x) => x !== c.key)))} result={results[c.key]} />
        ))}
      </div>
      {!finished && (
        <Card className="space-y-3 p-4">
          <AgentPicker value={agents} onChange={setAgents} />
          {needAck && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={ack} onChange={(e) => setAck(e.target.checked)} />
              <span>
                <KeyRound className="me-1 inline h-4 w-4 text-danger" />
                {lookalike ? 'Ik weet dat deze uitgever lijkt op een bekende naam maar die niet is, en ik vertrouw deze bron toch.' : 'Ik heb de ernstige waarschuwingen gelezen en wil deze skill toch installeren.'}
              </span>
            </label>
          )}
          {needConfirm && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={confirm} onChange={(e) => setConfirm(e.target.checked)} />
              <span>Ik heb de extra rechten bekeken en ga akkoord met de update.</span>
            </label>
          )}
          {needPublisher && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={publisherOk} onChange={(e) => setPublisherOk(e.target.checked)} />
              <span>Ik weet dat deze versie van een andere uitgever komt dan de geïnstalleerde, en vertrouw die wissel.</span>
            </label>
          )}
          {needOverride && <PolicyOverride checked={override} onChange={setOverride} />}
          {thin.length > 0 && (
            <p className="text-xs text-warn">
              Let op: {thin.length === 1 ? `“${thin[0].name}” doet` : `${thin.length} gekozen skills doen`} zelf weinig (zie hierboven). Je kunt {thin.length === 1 ? 'hem' : 'ze'} toch installeren.
            </p>
          )}
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="primary" loading={busy} disabled={!chosen.length || (needAck && !ack) || (needConfirm && !confirm) || (needOverride && !override) || (needPublisher && !publisherOk)} onClick={commit}>
              {chosen.length > 1 ? `${chosen.length} skills installeren` : 'Installeren'}
            </Button>
          </div>
        </Card>
      )}
      {finished && (
        <p className="flex items-center gap-2 text-sm text-ok">
          <CheckCircle2 className="h-4 w-4" /> {doneLabel}
        </p>
      )}
    </div>
  );
}

/** Small confirmation dialog. */
export function Confirm({ open, title, children, confirmLabel, danger, onConfirm, onClose, busy }: { open: boolean; title: string; children: React.ReactNode; confirmLabel: string; danger?: boolean; onConfirm(): void; onClose(): void; busy?: boolean }) {
  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Annuleren
          </Button>
          <Button variant={danger ? 'danger' : 'primary'} loading={busy} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        </>
      }
    >
      <div className="space-y-3 text-sm">{children}</div>
    </Modal>
  );
}

/** After "Delen op server": shared at once (owner/admin), or submitted and waiting for a reviewer (B-11). */
export function shareToast(r: { status?: string }): string {
  return r.status === 'pending' ? 'Ingediend: een beheerder bekijkt het eerst. Je krijgt bericht zodra anderen het kunnen zien.' : 'Gedeeld: andere gebruikers van deze server vinden het in de marktplaats';
}
