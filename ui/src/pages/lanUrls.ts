/**
 * "Netwerkadressen" under Instellingen › Waar staat mijn data?: only when TeamBot listens beyond this computer. The
 * desktop app listens on 127.0.0.1 only, so http://<lan-ip>:<port> does not open anywhere (practice test 0.4.4: the
 * page listed them anyway, next to "Alleen deze computer"). A phone reaches it through Instellingen › Telefoon.
 */
export function shownLanUrls(s: { host?: string | null; lanUrls?: string[] | null }): string[] {
  const urls = s.lanUrls || [];
  const h = String(s.host || '')
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h === '::1' || h.startsWith('127.') || h.startsWith('::ffff:127.')) return [];
  return urls;
}
