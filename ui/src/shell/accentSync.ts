/**
 * The user's accent colour on this page: from their settings (`ui.accent`, the same on the computer, in the browser
 * and on the paired phone; a change on another device arrives with `settings.updated`) to <html data-accent>.
 */
import { useEffect } from 'react';
import { useApp } from '../lib/store';
import { accentOfSettings } from './accent';
import { setAccent } from './theme';

/** Keeps the page on the user's accent colour once their settings are loaded. */
export function useAccentSync() {
  const loaded = useApp((s) => !!s.me);
  const fromSettings = useApp((s) => accentOfSettings(s.settings));
  useEffect(() => {
    if (loaded) setAccent(fromSettings);
  }, [loaded, fromSettings]);
}
