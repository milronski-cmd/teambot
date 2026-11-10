import { query } from '../lib/router';
import { Page } from '../components/ui';
import { PaletteView } from '../shell/CommandPalette';

/**
 * #/search[?q=…] — the command palette as a page: on the phone (the search field above the chats, Meer › Zoeken) and on
 * the desktop when linked. Finds chats and messages, bots, groups, pages, settings, channels, skills, apps, routines,
 * files and memory, plus quick actions. On the desktop Ctrl+K opens the same thing as an overlay.
 */
export function SearchPage() {
  return (
    <Page>
      <div className="mx-auto max-w-3xl px-4 pb-8 pt-[max(1.25rem,var(--safe-top))] sm:px-6 sm:pt-8">
        <h1 className="mb-4 text-[22px] font-bold tracking-tight sm:text-2xl">Zoeken</h1>
        <PaletteView page initialQuery={query().get('q') || ''} />
        <p className="mt-4 px-1 text-xs text-muted">Zoekt overal in TeamBot. Op de computer: Ctrl+K.</p>
      </div>
    </Page>
  );
}
