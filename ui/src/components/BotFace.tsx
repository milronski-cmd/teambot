import { useId, useMemo } from 'react';
import { botSvg, isImageAvatar, parseFace, type FaceStyle, type FaceTraits, type Mood } from '../lib/botface';
import { useAgentMood, useFaceStyle } from '../lib/mood';

function cx(...c: (string | false | null | undefined)[]) {
  return c.filter(Boolean).join(' ');
}

/**
 * A bot character (decorative: aria-hidden). Always show the bot's name and, when relevant, a status text next to it.
 * The SVG comes from lib/botface, which only emits computed numbers and whitelisted values.
 */
export function BotFace({ seed, traits, mood = 'idle', size = 40, style, className }: { seed: string; traits?: Partial<FaceTraits> | null; mood?: Mood; size?: number; style?: FaceStyle; className?: string }) {
  const uid = useId();
  const globalStyle = useFaceStyle();
  const st = style || globalStyle;
  const key = traits ? JSON.stringify(traits) : '';
  const svg = useMemo(() => botSvg(seed, { traits: traits || undefined, style: st, mood, uid }), [seed, key, st, mood, uid]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <span
      aria-hidden="true"
      className={cx('tb-face inline-block shrink-0 text-fg', mood === 'working' && 'tb-bob', className)}
      style={{ width: size, height: size }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}

export interface BotLike {
  id?: string | null;
  name?: string | null;
  avatar?: string | null;
  archived?: boolean;
}

/** Seed for a bot's generated face: its id (stable across renames), else its name. */
export function botSeed(bot: BotLike | null | undefined): string {
  return bot?.id || bot?.name || 'bot';
}

/** A bot's avatar: an uploaded photo/link stays a photo; everything else is its character. */
export function BotAvatar({ bot, size = 40, mood = 'idle', className }: { bot: BotLike | null | undefined; size?: number; mood?: Mood; className?: string }) {
  if (bot?.avatar && isImageAvatar(bot.avatar)) {
    return (
      <span className={cx('relative inline-block shrink-0 overflow-hidden rounded-[32%] bg-surface-3', className)} style={{ width: size, height: size }} aria-hidden="true">
        <img src={bot.avatar} alt="" className="h-full w-full object-cover" loading="lazy" referrerPolicy="no-referrer" />
      </span>
    );
  }
  return <BotFace seed={botSeed(bot)} traits={parseFace(bot?.avatar)} mood={mood} size={size} className={className} />;
}

/** BotAvatar whose mood follows the bot's real state (working / waiting / error / paused / done). */
export function LiveBotAvatar({ bot, size = 40, className }: { bot: (BotLike & { id: string }) | null | undefined; size?: number; className?: string }) {
  const mood = useAgentMood(bot ? { id: bot.id, archived: !!bot.archived } : null);
  return <BotAvatar bot={bot} size={size} mood={mood} className={className} />;
}

/** Two or three overlapping faces for a group (room). */
export function StackedFaces({ bots, size = 46 }: { bots: BotLike[]; size?: number }) {
  const list = bots.slice(0, 3);
  if (list.length <= 1) return <BotAvatar bot={list[0] || { name: 'groep' }} size={size} />;
  const small = Math.round(size * (list.length === 2 ? 0.66 : 0.58));
  const pos =
    list.length === 2
      ? [
          { left: 0, top: 0 },
          { left: size - small, top: size - small },
        ]
      : [
          { left: (size - small) / 2, top: 0 },
          { left: 0, top: size - small },
          { left: size - small, top: size - small },
        ];
  return (
    <span className="relative inline-block shrink-0" style={{ width: size, height: size }} aria-hidden="true">
      {list.map((b, i) => (
        <span key={(b.id || b.name || '') + i} className="absolute" style={{ ...pos[i], width: small, height: small }}>
          <BotAvatar bot={b} size={small} />
        </span>
      ))}
    </span>
  );
}
