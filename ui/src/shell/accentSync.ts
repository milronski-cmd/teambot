/**
 * The user's accent colour on this page: from their settings (`ui.accent`, the same on the computer, in the browser
 * and on the paired phone; a change on another device arrives with `settings.updated`) to <html data-accent>. The
 * theme a bot set for all devices (`ui.theme` with `ui.themeAt`) is taken over here as well.
 */
import { useEffect } from 'react';
import { useApp } from '../lib/store';
import { accentOfSettings } from './accent';
import { adoptSharedTheme, setAccent } from './theme';

/** Keeps the page on the user's accent colour once their settings are loaded, and takes over a theme set for every device. */
export function useAccentSync() {
  const loaded = useApp((s) => !!s.me);
  const fromSettings = useApp((s) => accentOfSettings(s.settings));
  const theme = useApp((s) => s.settings?.ui?.theme as unknown);
  const themeAt = useApp((s) => s.settings?.ui?.themeAt as unknown);
  useEffect(() => {
    if (loaded) setAccent(fromSettings);
  }, [loaded, fromSettings]);
  useEffect(() => {
    if (loaded) adoptSharedTheme(theme, themeAt);
  }, [loaded, theme, themeAt]);
}
