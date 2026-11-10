import { tr } from '../../core/i18n.js';

/**
 * What the on-screen indicator on the PC says while someone watches or controls this computer from a distance
 * (desktop/remote-indicator.ts draws it, with a Stop button). Pure, so it is unit-tested without Electron.
 */

export interface IndicatorSession {
  device: string;
  /** Sent mouse or keyboard input recently (otherwise: only watching). */
  controlling: boolean;
}

export interface IndicatorView {
  /** "iPhone van Sanne bedient deze computer" */
  title: string;
  detail: string;
  stop: string;
  /** Text for screen readers and the tray. */
  label: string;
}

export function indicatorView(sessions: IndicatorSession[], lang = 'nl'): IndicatorView | null {
  if (!sessions.length) return null;
  const controlling = sessions.some((s) => s.controlling);
  let title: string;
  if (sessions.length === 1) {
    const d = sessions[0].device || tr(lang, 'Een apparaat');
    title = controlling ? tr(lang, '{0} bedient deze computer', d) : tr(lang, '{0} kijkt mee op deze computer', d);
  } else title = tr(lang, '{0, plural, one {# apparaat kijkt mee op deze computer} other {# apparaten kijken mee op deze computer}}', sessions.length);
  const detail = tr(lang, 'Bureaublad op afstand · Stop zet het uit');
  return { title, detail, stop: tr(lang, 'Stop'), label: `${title}. ${detail}` };
}
