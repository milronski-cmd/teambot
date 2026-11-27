import { useId } from 'react';

/**
 * TeamBot's own icons for the places in the menu (24 Nov 2026, the owner: "minder standaard AI-achtig … die standaard
 * AI icons zijn niet mooi"). Drawn in the family of the bots' faces (components/BotFace): soft, filled shapes with a
 * gentle gradient and a highlight, no thin outlines; the chat bubble has the bots' eyes. Each place keeps its colour.
 * Decorative: the link around them carries the name.
 */

type P = { size?: number; className?: string };

/** The soft body gradient of a bot: light at the top, the colour's deeper tone at the bottom. */
function Body({ id, from, to }: { id: string; from: string; to: string }) {
  return (
    <defs>
      <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
        <stop offset="0" stopColor={from} />
        <stop offset="1" stopColor={to} />
      </linearGradient>
    </defs>
  );
}

const svg = (size: number, className: string | undefined, children: React.ReactNode) => (
  <svg width={size} height={size} viewBox="0 0 24 24" className={className} aria-hidden="true">
    {children}
  </svg>
);

/** Dashboard: three chunky bars, the middle one tallest. */
export function DashboardIcon({ size = 26, className }: P) {
  const g = useId();
  return svg(
    size,
    className,
    <>
      <Body id={g} from="#ffb27a" to="#f0721f" />
      <rect x="2.5" y="11" width="5.5" height="10.5" rx="2.75" fill={`url(#${g})`} />
      <rect x="9.25" y="4.5" width="5.5" height="17" rx="2.75" fill={`url(#${g})`} />
      <rect x="16" y="13.5" width="5.5" height="8" rx="2.75" fill={`url(#${g})`} />
      <rect x="10.4" y="6" width="1.6" height="5" rx="0.8" fill="#fff" opacity="0.45" />
    </>,
  );
}

/** Chats: a speech bubble with the bots' eyes. */
export function ChatsIcon({ size = 26, className }: P) {
  const g = useId();
  return svg(
    size,
    className,
    <>
      <Body id={g} from="#8fb2ff" to="#4a76f0" />
      <path d="M12 3c5.25 0 9.5 3.4 9.5 7.6s-4.25 7.6-9.5 7.6c-.9 0-1.77-.1-2.6-.29L5.2 20.6c-.55.33-1.2-.17-1.03-.79l.86-3.15C3.47 15.3 2.5 13.05 2.5 10.6 2.5 6.4 6.75 3 12 3Z" fill={`url(#${g})`} />
      <ellipse cx="9" cy="10.4" rx="1.55" ry="2" fill="#fff" />
      <ellipse cx="15" cy="10.4" rx="1.55" ry="2" fill="#fff" />
      <circle cx="9.35" cy="10.9" r="0.85" fill="#1b2340" />
      <circle cx="15.35" cy="10.9" r="0.85" fill="#1b2340" />
      <path d="M6.2 6.6c.9-1 2.2-1.6 3.6-1.8" stroke="#fff" strokeWidth="1.3" strokeLinecap="round" fill="none" opacity="0.5" />
    </>,
  );
}

/** Wacht op jou: a round hourglass with sand in the bottom. */
export function WaitingIcon({ size = 26, className }: P) {
  const g = useId();
  return svg(
    size,
    className,
    <>
      <Body id={g} from="#ffd479" to="#eea21c" />
      <rect x="4.5" y="2" width="15" height="3.2" rx="1.6" fill={`url(#${g})`} />
      <rect x="4.5" y="18.8" width="15" height="3.2" rx="1.6" fill={`url(#${g})`} />
      <path d="M6.5 5.2h11c0 3.6-3.4 5.2-3.4 6.8s3.4 3.2 3.4 6.8h-11c0-3.6 3.4-5.2 3.4-6.8S6.5 8.8 6.5 5.2Z" fill={`url(#${g})`} opacity="0.9" />
      <path d="M8.6 18.8c.4-2 2.2-2.9 3.4-3.6 1.2.7 3 1.6 3.4 3.6Z" fill="#c9780a" />
      <circle cx="12" cy="9.2" r="1.1" fill="#c9780a" />
    </>,
  );
}

/** Taken: a clipboard with a tick. */
export function TasksIcon({ size = 26, className }: P) {
  const g = useId();
  return svg(
    size,
    className,
    <>
      <Body id={g} from="#73e2c0" to="#22a97f" />
      <rect x="3.5" y="4" width="17" height="18.5" rx="4" fill={`url(#${g})`} />
      <rect x="8" y="2" width="8" height="4.4" rx="2.2" fill="#167a5b" />
      <path d="m8 13.6 2.6 2.6 5.4-5.6" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" fill="none" />
    </>,
  );
}

/** Apps: a puzzle piece, the thing that fits into the team. */
export function AppsIcon({ size = 26, className }: P) {
  const g = useId();
  return svg(
    size,
    className,
    <>
      <Body id={g} from="#d2b8ff" to="#9a6cf2" />
      <path d="M5 7.5h3.3a2.9 2.9 0 1 1 5.4 0H17a2 2 0 0 1 2 2v3.3a2.9 2.9 0 1 1 0 5.4V20a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V9.5a2 2 0 0 1 2-2Z" fill={`url(#${g})`} />
      <path d="M5.6 10.2v3.4" stroke="#fff" strokeWidth="1.4" strokeLinecap="round" opacity="0.5" />
    </>,
  );
}

/** Marktplaats: a shopping bag that smiles. */
export function MarketIcon({ size = 26, className }: P) {
  const g = useId();
  return svg(
    size,
    className,
    <>
      <Body id={g} from="#ffa8bf" to="#ec5683" />
      <path d="M8.2 8V6.8a3.8 3.8 0 0 1 7.6 0V8" stroke="#c23d66" strokeWidth="2" strokeLinecap="round" fill="none" />
      <path d="M5.2 7.5h13.6a1.5 1.5 0 0 1 1.5 1.38l.83 10.6A2.3 2.3 0 0 1 18.84 22H5.16a2.3 2.3 0 0 1-2.29-2.52l.83-10.6A1.5 1.5 0 0 1 5.2 7.5Z" fill={`url(#${g})`} />
      <path d="M9 15c.8 1.1 1.8 1.6 3 1.6s2.2-.5 3-1.6" stroke="#fff" strokeWidth="1.8" strokeLinecap="round" fill="none" />
      <circle cx="9.3" cy="11.6" r="1" fill="#fff" />
      <circle cx="14.7" cy="11.6" r="1" fill="#fff" />
    </>,
  );
}

/** Small quiet glyphs for the foot of the menu, filled in the text colour (no thin outlines). */
export function SearchGlyph({ size = 20, className }: P) {
  return svg(
    size,
    className,
    <>
      <circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" strokeWidth="2.6" />
      <path d="m15.5 15.5 4.8 4.8" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
    </>,
  );
}

export function SettingsGlyph({ size = 20, className }: P) {
  return svg(
    size,
    className,
    <>
      <path d="M4 7h16M4 17h16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" opacity="0.55" />
      <circle cx="9" cy="7" r="3" fill="currentColor" />
      <circle cx="15" cy="17" r="3" fill="currentColor" />
    </>,
  );
}
