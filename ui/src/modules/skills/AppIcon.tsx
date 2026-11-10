import { useState, type SyntheticEvent } from 'react';
import { authUrl } from '../../lib/api';
import { hash } from '../../lib/botface';
import { cx } from '../../components/ui';
import { monogram } from '../../lib/monogram';

/** Icons that turned out to be missing, this session: the card draws its monogram at once, without asking again. */
const missing = new Set<string>();

/**
 * The icon of an app from the MCP Registry. The publisher's own icon comes through TeamBot's icon route (`src` is an
 * API path; the publisher never sees the viewer). Without a usable icon the app gets a monogram in a calm colour that
 * belongs to its name, so every card looks deliberate instead of showing a broken or generic picture. A missing icon
 * comes back as a 1x1 picture (`miss=none`), not as a 404: no failed request in the console (acceptance round 6).
 */
export function AppIcon({ src, title, name, size = 32 }: { src: string | null | undefined; title: string; name: string; size?: number }) {
  const [bad, setBad] = useState(() => !!src && missing.has(src));
  const box = { width: size, height: size };
  const miss = () => {
    if (src) missing.add(src);
    setBad(true);
  };
  const loaded = (e: SyntheticEvent<HTMLImageElement>) => e.currentTarget.naturalWidth <= 1 && e.currentTarget.naturalHeight <= 1 && miss();
  if (src && !bad && src.startsWith('/mcp/registry/icon?'))
    return <img src={authUrl(`${src}&miss=none`)} alt="" width={size} height={size} style={box} loading="lazy" referrerPolicy="no-referrer" onLoad={loaded} onError={miss} className="shrink-0 rounded-lg bg-white object-contain p-0.5 ring-1 ring-line" />;
  const hue = hash(name || title) % 360;
  return (
    <span
      aria-hidden
      data-testid="app-monogram"
      style={{ ...box, ['--mono-h' as any]: hue, fontSize: Math.round(size * (monogram(title, name).length > 1 ? 0.38 : 0.46)) }}
      className={cx(
        'inline-flex shrink-0 select-none items-center justify-center rounded-lg font-bold tracking-tight ring-1 ring-black/5',
        'bg-[hsl(var(--mono-h)_70%_92%)] text-[hsl(var(--mono-h)_50%_28%)] dark:bg-[hsl(var(--mono-h)_32%_24%)] dark:text-[hsl(var(--mono-h)_75%_84%)] dark:ring-white/10',
      )}
    >
      {monogram(title, name)}
    </span>
  );
}
