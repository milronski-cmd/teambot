import type { ReactNode } from 'react';
import { AlertTriangle, CheckCircle2, ChevronDown } from 'lucide-react';
import { Badge, Card, Spinner, TONE_TILE, cx, type Tone } from './ui';

/**
 * One connect pattern for everything that gets connected (AI services, channels, apps, the phone): the same card with
 * the same four states. A card shows a name, ONE short line and ONE action; the result of the test ("Verbinding
 * werkt") or the error with one next step stands under it. Everything else goes behind "Meer opties".
 */
export type ConnectState = 'off' | 'busy' | 'on' | 'error';

export const CONNECT_LABEL: Record<ConnectState, string> = { off: 'niet gekoppeld', busy: 'bezig', on: 'gekoppeld', error: 'fout' };

export function ConnectBadge({ state, label }: { state: ConnectState; label?: string }) {
  const text = label || CONNECT_LABEL[state];
  if (state === 'busy')
    return (
      <Badge>
        <Spinner className="h-3 w-3" /> {text}
      </Badge>
    );
  if (state === 'on')
    return (
      <Badge tone="ok">
        <CheckCircle2 className="h-3 w-3" aria-hidden /> {text}
      </Badge>
    );
  if (state === 'error')
    return (
      <Badge tone="danger">
        <AlertTriangle className="h-3 w-3" aria-hidden /> {text}
      </Badge>
    );
  if (state === 'off' && !label) return null;
  return <Badge>{text}</Badge>;
}

/** The outcome under a card: green "Verbinding werkt" or the error with one next step. */
export function ConnectResult({ ok, children, next }: { ok: boolean; children?: ReactNode; next?: ReactNode }) {
  return (
    <div role="status" className={cx('flex items-start gap-2 rounded-lg px-3 py-2 text-sm', ok ? 'bg-ok-soft text-ok' : 'bg-danger-soft text-danger')} data-testid={ok ? 'connect-ok' : 'connect-error'}>
      {ok ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" aria-hidden /> : <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />}
      <div className="min-w-0 space-y-0.5">
        <div className="break-words">{children || (ok ? 'Verbinding werkt' : 'Verbinding werkt niet')}</div>
        {next && <div className="text-xs text-fg">{next}</div>}
      </div>
    </div>
  );
}

export function ConnectCard({
  icon,
  tone,
  title,
  line,
  state,
  stateLabel,
  action,
  result,
  children,
  more,
  moreLabel = 'Meer opties',
  moreOpen,
  className,
  ...rest
}: {
  icon?: ReactNode;
  /** The colour of the icon tile (components/ui.tsx Tone); a brand logo keeps the neutral tile. */
  tone?: Tone;
  title: ReactNode;
  /** One short line: what this is, or what state it is in. */
  line?: ReactNode;
  state: ConnectState;
  /** Other words for the state badge (e.g. "klaar om te koppelen"). */
  stateLabel?: string;
  /** The one action of this card (a button). */
  action?: ReactNode;
  /** A <ConnectResult> after a test or a failed attempt. */
  result?: ReactNode;
  /** What the action opened: a form, a QR code, a login link. */
  children?: ReactNode;
  /** Everything a newcomer does not need. */
  more?: ReactNode;
  moreLabel?: string;
  /** Open the fold from outside (e.g. a page-wide "Meer opties"); left out, the reader opens it. */
  moreOpen?: boolean;
  className?: string;
  'data-testid'?: string;
}) {
  return (
    <Card className={cx('p-4', className)} data-connect-state={state} {...rest}>
      <div className="flex flex-wrap items-center gap-3">
        {icon && <span className={cx('flex size-8 shrink-0 items-center justify-center rounded-lg [&>svg]:h-[18px] [&>svg]:w-[18px]', TONE_TILE[tone || 'neutral'])} aria-hidden>{icon}</span>}
        <div className="min-w-0 flex-1 basis-48">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold">{title}</h3>
            <ConnectBadge state={state} label={stateLabel} />
          </div>
          {line && <p className="mt-0.5 text-sm text-muted">{line}</p>}
        </div>
        {action && <div className="flex shrink-0 flex-wrap items-center gap-2">{action}</div>}
      </div>
      {result && <div className="mt-3">{result}</div>}
      {children && <div className="mt-3">{children}</div>}
      {more && (
        <details className="group mt-3" open={moreOpen || undefined}>
          <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded text-xs font-medium text-muted hover:text-fg [&::-webkit-details-marker]:hidden">
            <ChevronDown className="h-3.5 w-3.5 transition-transform [details[open]>summary_&]:rotate-180" aria-hidden />
            {moreLabel}
          </summary>
          <div className="mt-2 space-y-3">{more}</div>
        </details>
      )}
    </Card>
  );
}
