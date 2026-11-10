import { useEffect, useRef } from 'react';
import { Hand, Loader2, Mic, Volume2 } from 'lucide-react';
import { cx } from '../../components/ui';
import { BotAvatar } from '../../components/BotFace';
import { t } from '../../lib/i18n';
import { type BotStatus, statusMood } from './indicator';
import { isTalkKey } from './talk';

const RING: Record<BotStatus, string> = {
  listening: 'ring-4 ring-ok',
  thinking: 'ring-2 ring-line-strong',
  speaking: 'ring-4 ring-accent',
  waiting: 'ring-4 ring-warn',
  idle: 'ring-0',
};

/** The word under a face: what this bot does right now. */
export function statusWord(s: BotStatus): string {
  switch (s) {
    case 'listening':
      return t('luistert');
    case 'thinking':
      return t('denkt na');
    case 'speaking':
      return t('spreekt');
    case 'waiting':
      return t('wacht op jou');
    default:
      return '';
  }
}

/** A bot's face with a ring and a word for what it does (listens / thinks / speaks), in every call screen. */
export function TalkFace({ bot, status, size = 48, level = 0, showWord = true }: { bot: { id?: string; name: string; avatar?: string | null }; status: BotStatus; size?: number; level?: number; showWord?: boolean }) {
  const scale = status === 'listening' ? 1 + Math.min(0.12, level * 2) : status === 'speaking' ? 1.06 : 1;
  const word = statusWord(status);
  const Icon = status === 'listening' ? Mic : status === 'speaking' ? Volume2 : status === 'thinking' ? Loader2 : status === 'waiting' ? Hand : null;
  return (
    <div className="flex flex-col items-center gap-1">
      <div className={cx('rounded-full p-1 transition-transform duration-150', RING[status], status === 'speaking' && 'motion-safe:animate-pulse')} style={{ transform: `scale(${scale})` }}>
        <BotAvatar bot={bot} size={size} mood={statusMood(status)} />
      </div>
      {showWord && (
        <span className={cx('flex h-4 items-center gap-1 text-[11px]', status === 'listening' ? 'text-ok' : status === 'waiting' ? 'text-warn' : 'text-muted')}>
          {Icon && <Icon className={cx('h-3 w-3', status === 'thinking' && 'motion-safe:animate-spin')} aria-hidden="true" />}
          {word}
        </span>
      )}
    </div>
  );
}

/**
 * Hold the space bar to talk (computer). Ignores key repeat and Space in text fields; letting go of the window
 * (Alt+Tab) counts as letting go of the key.
 */
export function useTalkKey(enabled: boolean, down: () => void, up: () => void) {
  const fns = useRef({ down, up });
  fns.current = { down, up };
  useEffect(() => {
    if (!enabled) return;
    let held = false;
    const onDown = (e: KeyboardEvent) => {
      if (!isTalkKey(e)) return;
      e.preventDefault();
      e.stopPropagation();
      if (e.repeat || held) return;
      held = true;
      fns.current.down();
    };
    const onUp = (e: KeyboardEvent) => {
      if (!isTalkKey(e) && !(held && (e.key === ' ' || e.code === 'Space'))) return;
      e.preventDefault();
      e.stopPropagation();
      if (!held) return;
      held = false;
      fns.current.up();
    };
    const onBlur = () => {
      if (!held) return;
      held = false;
      fns.current.up();
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', onBlur);
      if (held) fns.current.up();
    };
  }, [enabled]);
}

/** The big hold-to-talk button: press and hold (mouse, touch or pen) while you talk, let go when you are done. */
export function TalkButton({ holding, disabled, onPress, onRelease, keyboard }: { holding: boolean; disabled?: boolean; onPress(): void; onRelease(): void; keyboard: boolean }) {
  const label = holding ? t('Ik luister… laat los als je klaar bent') : keyboard ? t('Houd ingedrukt om te praten (of de spatiebalk)') : t('Houd ingedrukt om te praten');
  return (
    <button
      type="button"
      aria-pressed={holding}
      aria-label={label}
      title={label}
      disabled={disabled}
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.preventDefault();
        try {
          e.currentTarget.setPointerCapture(e.pointerId);
        } catch {
          /* not capturable */
        }
        onPress();
      }}
      onPointerUp={() => onRelease()}
      onPointerCancel={() => onRelease()}
      onLostPointerCapture={() => onRelease()}
      onContextMenu={(e) => e.preventDefault()}
      // Space is handled by useTalkKey (hold); a click from the keyboard (Enter) would only tap.
      onKeyDown={(e) => (e.key === ' ' || e.key === 'Enter') && e.preventDefault()}
      className={cx(
        'flex h-20 w-20 touch-none select-none items-center justify-center rounded-full border-2 transition disabled:cursor-not-allowed disabled:opacity-50',
        holding ? 'scale-105 border-ok bg-ok text-ok-fg' : 'border-line-strong bg-surface-2 text-fg hover:bg-surface-3',
      )}
    >
      <Mic className="h-8 w-8" aria-hidden="true" />
    </button>
  );
}
