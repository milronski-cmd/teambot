import { useMemo, useState } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Bot, CircleStop, Globe, Hand, History, Keyboard, MonitorUp, Pause, PictureInPicture2, Play, Power, RefreshCw, User } from 'lucide-react';
import { authUrl } from '../../lib/api';
import { useApp } from '../../lib/store';
import { t } from '../../lib/i18n';
import { Badge, Button, cx, EmptyState, Input, Modal, Spinner, toast } from '../../components/ui';
import { computers, fmtTime, openPip, useLive, type Action, type ComputerStatus } from './api';
import { LiveImage, useComputerControl } from './LiveScreen';

export function ControllerBadge({ status, meId }: { status: ComputerStatus; meId?: string }) {
  const c = status.controller;
  if (!status.browser.running && !c) return <Badge>Uit</Badge>;
  if (!c) return <Badge tone="accent">Vrij</Badge>;
  if (c.kind === 'user') return <Badge tone="warn">{c.sticky ? 'Gepauzeerd door ' : 'Bediend door '}{c.userId === meId ? 'jou' : c.name}</Badge>;
  return <Badge tone="ok">{c.name} bedient</Badge>;
}

/** The steps on a bot's computer, newest first: who did it, what, when, and the screen after a step when there is one. */
export function StepList({ agentId, title, steps, compact }: { agentId: string; title: string; steps: Action[]; compact?: boolean }) {
  const [frame, setFrame] = useState<Action | null>(null);
  return (
    <>
      <div>
        <div className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-muted">{title}</div>
        {!steps.length ? (
          <p className="text-sm text-muted">Nog geen stappen.</p>
        ) : (
          <ul className={cx('divide-y divide-line rounded-xl border border-line', compact && 'max-h-80 overflow-y-auto')}>
            {steps.map((a) => (
              <li key={a.id} className="flex items-start gap-2 px-3 py-2 text-sm">
                {a.actor === 'user' ? <User className="mt-0.5 h-4 w-4 shrink-0 text-warn" aria-label="Gebruiker" /> : <Bot className="mt-0.5 h-4 w-4 shrink-0 text-muted" aria-label="Bot" />}
                <div className="min-w-0 flex-1">
                  <div className={cx('break-words', (a.status === 'error' || a.status === 'denied') && 'text-danger')}>{a.summary}</div>
                  <div className="truncate text-xs text-muted">{fmtTime(a.created_at)}{a.url ? ` · ${a.url}` : ''}</div>
                </div>
                {a.frame && (
                  <button className="shrink-0 overflow-hidden rounded border border-line" onClick={() => setFrame(a)} aria-label="Bekijk scherm bij deze stap">
                    <img src={authUrl(`/computers/${agentId}/actions/${a.id}/frame`)} alt="" loading="lazy" className="h-9 w-14 object-cover" />
                  </button>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>

      <Modal open={!!frame} onClose={() => setFrame(null)} title={frame?.summary || 'Stap'} wide>
        {frame && <img src={authUrl(`/computers/${agentId}/actions/${frame.id}/frame`)} alt={frame.summary} className="w-full rounded-lg border border-line" />}
      </Modal>
    </>
  );
}

/** Live screen of a bot's browser with takeover, pause, emergency stop and the step log. */
export function LivePanel({ agentId, compact = false }: { agentId: string; compact?: boolean }) {
  const { data, error, loading, reload, me, status, iControl, sticky, scr, busy, run, post } = useComputerControl(agentId);
  const caps = useLive(() => computers.caps(), [], []);
  const actions = useLive(() => computers.actions(agentId, 60), ['computer.action'], [agentId]);
  const [streamKey, setStreamKey] = useState(0);
  const [typed, setTyped] = useState('');
  const [url, setUrl] = useState('');
  const [confirmStop, setConfirmStop] = useState(false);
  const [rewind, setRewind] = useState<number | null>(null);

  const running = !!status?.browser.running;
  // A window on the computer's screen is opened from the computer; a paired phone takes over in the live view.
  const phone = useApp((s) => s.device);
  const visibleOk = caps.data?.caps.find((c) => c.id === 'visible')?.status === 'available' && caps.data?.isOwner && !phone;


  const framed = useMemo(() => (actions.data || []).filter((a) => a.frame).reverse(), [actions.data]);

  if (loading && !data) return <div className="flex justify-center p-6"><Spinner /></div>;
  if (error) return <EmptyState title="Kon de computer niet laden">{error}</EmptyState>;
  if (!status) return null;

  const input = scr.send;

  const showing = rewind !== null && framed[rewind] ? framed[rewind] : null;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <ControllerBadge status={status} meId={me?.id} />
        {running && status.browser.headed && <Badge tone="accent">Zichtbaar venster</Badge>}
        {/* the in-app browser: invisible tabs inside TeamBot, with what its own processes use */}
        {running && !status.browser.headed && status.browser.engine === 'app' && (
          <span title={t('Onzichtbare tabbladen in de TeamBot-app; je ziet ze alleen hier.')}>
            <Badge>{status.browser.memoryMb ? t('In TeamBot · {0} MB', status.browser.memoryMb) : t('In TeamBot')}</Badge>
          </span>
        )}
        {status.host.enabled && status.host.stopped && <Badge tone="danger">Bureaublad gepauzeerd (noodstop)</Badge>}
        {status.controller?.waiting?.length ? <Badge>Wachtend: {status.controller.waiting.join(', ')}</Badge> : null}
        {running && <span className="min-w-0 flex-1 truncate text-xs text-muted" title={status.browser.url}>{status.browser.url}</span>}
      </div>

      {/* screen */}
      <div className="overflow-hidden rounded-xl border border-line bg-canvas">
        {showing ? (
          <div className="relative">
            <img src={authUrl(`/computers/${agentId}/actions/${showing.id}/frame`)} alt={`Scherm bij stap: ${showing.summary}`} className="block w-full" />
            <div className="absolute start-2 top-2 rounded-md bg-black/70 px-2 py-1 text-xs text-white">Terugkijken · {fmtTime(showing.created_at)} · {showing.summary}</div>
          </div>
        ) : running ? (
          <LiveImage agentId={agentId} input={scr} active={iControl} filling={status.browser.filling} streamKey={streamKey} onReconnect={() => setStreamKey((k) => k + 1)} label="Live scherm van de bot-browser" />
        ) : (
          <EmptyState icon={<Globe className="h-8 w-8" />} title="De browser van deze bot is niet actief">
            Hij start vanzelf zodra de bot een website opent{status.mode !== 'browser' && status.mode !== 'host' ? ', maar deze bot heeft nu geen eigen browser (zie Bot › Computer & bestanden)' : ''}.
          </EmptyState>
        )}
      </div>

      {framed.length > 0 && (
        <div className="flex items-center gap-2">
          <History className="h-4 w-4 shrink-0 text-muted" aria-hidden />
          <label className="sr-only" htmlFor={`rw-${agentId}`}>Terugkijken</label>
          <input
            id={`rw-${agentId}`}
            type="range"
            min={0}
            max={framed.length}
            value={rewind === null ? framed.length : rewind}
            onChange={(e) => setRewind(Number(e.target.value) >= framed.length ? null : Number(e.target.value))}
            className="w-full accent-[var(--color-accent)]"
          />
          <span className="w-16 shrink-0 text-end text-xs text-muted">{rewind === null ? 'Live' : `${rewind + 1}/${framed.length}`}</span>
        </div>
      )}

      {/* controls */}
      <div className="flex flex-wrap gap-2">
        {!iControl && running && (
          <Button size="sm" variant="soft" icon={<Hand className="h-4 w-4" />} loading={busy} onClick={() => post('/takeover', {}, 'Jij hebt nu de bediening; de bot wacht')}>
            Neem over
          </Button>
        )}
        {!iControl && visibleOk && (
          <Button size="sm" icon={<MonitorUp className="h-4 w-4" />} loading={busy} onClick={() => post('/takeover', { visible: true }, 'Browservenster geopend op je bureaublad')}>
            Open als venster
          </Button>
        )}
        {!iControl && (status.mode === 'browser' || status.mode === 'host') && (
          <Button size="sm" icon={<Pause className="h-4 w-4" />} loading={busy} onClick={() => post('/takeover', { pause: true }, 'Bot gepauzeerd')}>
            Pauzeer bot
          </Button>
        )}
        {iControl && (
          <Button size="sm" variant="primary" icon={sticky ? <Play className="h-4 w-4" /> : <Bot className="h-4 w-4" />} loading={busy} onClick={() => post('/release', {}, 'De bot gaat verder')}>
            {sticky ? 'Ga verder' : 'Geef terug aan bot'}
          </Button>
        )}
        {status.host.enabled && status.host.stopped && (
          <Button size="sm" icon={<Play className="h-4 w-4" />} onClick={() => post('/resume-host', {}, 'Bureaubladbediening hervat')}>
            Hervat bureaublad
          </Button>
        )}
        {running && (
          <Button size="sm" variant="ghost" icon={<Power className="h-4 w-4" />} loading={busy} onClick={() => post('/browser/close', {}, 'Browser gesloten')}>
            Sluit browser
          </Button>
        )}
        <Button size="sm" variant="danger" icon={<CircleStop className="h-4 w-4" />} onClick={() => setConfirmStop(true)}>
          Noodstop
        </Button>
        {running && !compact && (
          <Button size="sm" variant="ghost" icon={<PictureInPicture2 className="h-4 w-4" />} onClick={() => openPip(agentId, 'browser')}>
            Beeld-in-beeld
          </Button>
        )}
        {running && !showing && (
          <Button size="sm" variant="ghost" icon={<RefreshCw className="h-4 w-4" />} aria-label="Beeld vernieuwen" onClick={() => setStreamKey((k) => k + 1)} />
        )}
      </div>

      {iControl && running && (
        <div className="space-y-2 rounded-xl border border-line p-3">
          <div className="text-xs text-muted">Klik in het beeld om te klikken; typen en scrollen werkt daarna ook. Wat je typt gaat niet naar de bot.</div>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!url.trim()) return;
              input({ type: 'navigate', url: /^https?:\/\//.test(url) ? url : 'https://' + url });
            }}
          >
            <Button type="button" size="icon" variant="ghost" aria-label="Terug" onClick={() => input({ type: 'back' })}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <Input value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Adres, bijv. example.com" aria-label="Adres" />
            <Button type="submit" size="sm" className="shrink-0">Ga</Button>
          </form>
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (!typed) return;
              input({ type: 'type', text: typed });
              setTyped('');
            }}
          >
            <Input type="password" autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Tekst typen (ook wachtwoorden)" aria-label="Tekst typen" />
            <Button type="submit" size="sm" icon={<Keyboard className="h-4 w-4" />} className="shrink-0">Typ</Button>
          </form>
          <div className="flex flex-wrap gap-1.5">
            {['Enter', 'Tab', 'Backspace', 'Escape'].map((k) => (
              <Button key={k} size="sm" variant="ghost" onClick={() => input({ type: 'key', key: k })}>{k === 'Backspace' ? '⌫' : k === 'Escape' ? 'Esc' : k}</Button>
            ))}
            <Button size="sm" variant="ghost" aria-label="Omhoog scrollen" onClick={() => input({ type: 'scroll', dy: -600 })}><ArrowUp className="h-4 w-4" /></Button>
            <Button size="sm" variant="ghost" aria-label="Omlaag scrollen" onClick={() => input({ type: 'scroll', dy: 600 })}><ArrowDown className="h-4 w-4" /></Button>
          </div>
        </div>
      )}

      {/* step log */}
      <StepList agentId={agentId} title="Stappen" steps={(actions.data || []).slice(0, compact ? 40 : 60)} compact={compact} />

      <Modal
        open={confirmStop}
        onClose={() => setConfirmStop(false)}
        title="Noodstop"
        footer={
          <>
            <Button onClick={() => setConfirmStop(false)}>Annuleren</Button>
            <Button
              variant="danger"
              loading={busy}
              onClick={async () => {
                const r: any = await post('/stop');
                setConfirmStop(false);
                if (r) toast(r.cancelled === 1 ? 'Gestopt (1 taak)' : `Gestopt (${r.cancelled} taken)`, 'ok');
              }}
            >
              Nu stoppen
            </Button>
          </>
        }
      >
        <p className="text-sm">Alle taken van deze bot stoppen direct, zijn browser gaat dicht{status.host.enabled ? ' en bureaubladbediening wordt gepauzeerd tot je hervat' : ''}. Bestanden en het browserprofiel blijven bewaard.</p>
      </Modal>
    </div>
  );
}
