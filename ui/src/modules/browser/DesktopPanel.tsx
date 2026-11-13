import { useMemo, useState } from 'react';
import { Bot, CircleStop, Eye, EyeOff, Hand, Monitor, PictureInPicture2, Play, RefreshCw, ShieldCheck, X } from 'lucide-react';
import { authUrl } from '../../lib/api';
import { t } from '../../lib/i18n';
import { Badge, Button, EmptyState, Modal, Spinner, Tabs, toast } from '../../components/ui';
import { computers, fmtTime, openPip, screen, useLive, type ScreenInfo } from './api';
import { LivePanel, StepList } from './LivePanel';

const DESKTOP_TOOLS = /^(desktop_|takeover|release|stop|desktop_grant)/;

function StateBadges({ s }: { s: ScreenInfo }) {
  const c = s.controller;
  return (
    <div className="flex flex-wrap items-center gap-2 text-sm">
      <Badge tone={s.level === 'auto' ? 'warn' : 'accent'}>
        <ShieldCheck className="h-3 w-3" /> {s.levelLabel}
      </Badge>
      {s.stopped ? (
        <Badge tone="danger">Gepauzeerd door noodstop</Badge>
      ) : c?.kind === 'user' ? (
        <Badge tone="warn">{s.mine ? 'Jij hebt de bediening — de bot wacht' : `Bediend door ${c.name}`}</Badge>
      ) : c?.kind === 'bot' ? (
        <Badge tone="ok">{c.name} bedient je bureaublad</Badge>
      ) : (
        <Badge>Geen bot actief</Badge>
      )}
      {c?.waiting?.length ? <Badge>Wachtend: {c.waiting.join(', ')}</Badge> : null}
      {s.options.allApps ? <Badge tone="warn">Alle apps (behalve geblokkeerde)</Badge> : <span className="text-xs text-muted">Apps: {s.apps.join(', ') || '—'}</span>}
    </div>
  );
}

/** Live view of the bot's monitor on this PC, with takeover, hand back, emergency stop and the desktop step log. */
export function DesktopPanel({ agentId, compact = false }: { agentId: string; compact?: boolean }) {
  const info = useLive(() => screen.info(agentId), ['computer.desktop', 'computer.status', 'computer.config'], [agentId]);
  const actions = useLive(() => computers.actions(agentId, 80).catch(() => []), ['computer.action'], [agentId]);
  const [watch, setWatch] = useState(true);
  const [streamKey, setStreamKey] = useState(0);
  const [confirmStop, setConfirmStop] = useState(false);
  const [busy, setBusy] = useState(false);
  const steps = useMemo(() => (actions.data || []).filter((a) => DESKTOP_TOOLS.test(a.tool)).slice(0, compact ? 30 : 60), [actions.data, compact]);
  // One signed URL per (re)connect: a re-render never restarts the stream.
  const streamSrc = useMemo(() => authUrl(`/computers/${agentId}/screen/stream?k=${streamKey}`), [agentId, streamKey]);

  if (info.loading && !info.data) return <div className="flex justify-center p-6"><Spinner /></div>;
  if (info.error) return <EmptyState title="Kon het bureaublad niet laden">{info.error}</EmptyState>;
  const s = info.data!;
  if (!s.enabled)
    return (
      <EmptyState icon={<Monitor className="h-8 w-8" />} title="Bureaubladbediening staat uit voor deze bot">
        De eigenaar zet dit per bot aan bij Bot › Computer & bestanden (modus “Mijn bureaublad”).
      </EmptyState>
    );

  const act = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    try {
      await fn();
      toast(ok, 'ok');
      info.reload();
    } catch (e: any) {
      toast(e?.message || String(e), 'danger');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <StateBadges s={s} />
      {s.grant && (
        <div className="flex flex-wrap items-center gap-2 rounded-xl border border-line bg-surface-2 px-3 py-2 text-sm">
          <ShieldCheck className="h-4 w-4 shrink-0 text-accent" aria-hidden />
          <span className="min-w-0 flex-1">
            Taaktoestemming tot {fmtTime(s.grant.until)}: {s.grant.goal || 'bureaublad bedienen'} <span className="text-xs text-muted">({t('{0, plural, one {# actie} other {# acties}}', s.grant.actions)})</span>
          </span>
          <Button size="sm" variant="ghost" icon={<X className="h-4 w-4" />} loading={busy} onClick={() => act(() => screen.revoke(agentId), 'Taaktoestemming ingetrokken')}>
            Intrekken
          </Button>
        </div>
      )}

      <div className="overflow-hidden rounded-xl border border-line bg-canvas">
        {watch ? (
          <img
            key={streamKey}
            src={streamSrc}
            alt="Live beeld van het scherm waarop de bot werkt (niet-toegestane vensters zijn donker gemaakt)"
            onError={() => setTimeout(() => setStreamKey((k) => k + 1), 3000)}
            className="block aspect-video w-full bg-surface-2 object-contain"
          />
        ) : (
          <EmptyState icon={<EyeOff className="h-8 w-8" />} title="Meekijken staat uit">
            Het beeld wordt niet ververst.
          </EmptyState>
        )}
      </div>
      <p className="text-xs text-muted">
        Je ziet wat de bot ziet: vensters die hij niet mag gebruiken zijn donker.{s.options.pauseOnInput ? ' Beweeg je zelf de muis, dan pauzeert de bot.' : ''}
        {s.hotkey ? ` Noodstop op deze pc: ${s.hotkey}.` : ''}
      </p>

      <div className="flex flex-wrap gap-2">
        {s.mine ? (
          <Button size="sm" variant="primary" icon={<Bot className="h-4 w-4" />} loading={busy} onClick={() => act(() => screen.resume(agentId), 'De bot gaat verder')}>
            Geef terug aan bot
          </Button>
        ) : (
          !s.stopped && (
            <Button size="sm" variant="soft" icon={<Hand className="h-4 w-4" />} loading={busy} onClick={() => act(() => screen.pause(agentId), 'Jij hebt de bediening; de bot wacht')}>
              Neem over
            </Button>
          )
        )}
        {s.stopped && (
          <Button size="sm" icon={<Play className="h-4 w-4" />} loading={busy} onClick={() => act(() => screen.resume(agentId), 'Bureaubladbediening hervat')}>
            Hervat
          </Button>
        )}
        <Button size="sm" variant="danger" icon={<CircleStop className="h-4 w-4" />} onClick={() => setConfirmStop(true)}>
          Noodstop bureaublad
        </Button>
        <Button size="sm" variant="ghost" icon={watch ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />} onClick={() => setWatch(!watch)}>
          {watch ? 'Niet meekijken' : 'Meekijken'}
        </Button>
        {!compact && (
          <Button size="sm" variant="ghost" icon={<PictureInPicture2 className="h-4 w-4" />} onClick={() => openPip(agentId, 'desktop')}>
            Beeld-in-beeld
          </Button>
        )}
        {watch && <Button size="sm" variant="ghost" icon={<RefreshCw className="h-4 w-4" />} aria-label="Beeld vernieuwen" onClick={() => setStreamKey((k) => k + 1)} />}
      </div>

      <StepList agentId={agentId} title="Stappen op het bureaublad" steps={steps} compact={compact} />

      <Modal
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title="Noodstop bureaublad"
        footer={
          <>
            <Button onClick={() => setConfirmStop(false)}>Annuleren</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={() =>
                act(async () => {
                  await screen.stopAll('app');
                  setConfirmStop(false);
                }, 'Bureaubladbediening gestopt')
              }
            >
              Nu stoppen
            </Button>
          </>
        }
      >
        <p className="text-sm">Elke bot die je bureaublad bedient stopt direct tot je “Hervat” kiest.</p>
      </Modal>
    </div>
  );
}

/** Live screen of a bot: its desktop (when allowed) and/or its own browser. */
export function ComputerLive({ agentId, compact = false }: { agentId: string; compact?: boolean }) {
  const info = useLive(() => screen.info(agentId).catch(() => null), ['computer.config'], [agentId]);
  const [tab, setTab] = useState<'desktop' | 'browser' | null>(null);
  const desktopOn = !!info.data?.enabled;
  const cur = tab ?? (desktopOn ? 'desktop' : 'browser');
  if (info.loading && !info.data) return <div className="flex justify-center p-6"><Spinner /></div>;
  return (
    <div className="space-y-3">
      {desktopOn && (
        <Tabs<'desktop' | 'browser'>
          tabs={[
            { id: 'desktop', label: 'Bureaublad' },
            { id: 'browser', label: 'Browser' },
          ]}
          value={cur}
          onChange={(v) => setTab(v)}
        />
      )}
      {cur === 'desktop' && desktopOn ? <DesktopPanel agentId={agentId} compact={compact} /> : <LivePanel agentId={agentId} compact={compact} />}
    </div>
  );
}
