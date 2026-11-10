/**
 * Where TeamBot finds its own updates (REL-03, parity 16.2). Two kinds, both spoken by electron-updater:
 *  - generic: a folder on a web server (https) with latest.yml, the installer and its .blockmap (`npm run release:feed`
 *    puts those three in release/feed/). The installers of earlier versions stay in that folder (the way back).
 *  - github: the GitHub Releases of a public repository (owner/repo). Every release carries latest.yml, the installer
 *    and its .blockmap; electron-builder's tag is `v<version>`.
 * The channel is set when a release is built (package.json build.publish → resources/app-update.yml, read by
 * builtInChannel) and can be overridden by what the owner types (parseChannel, Instellingen › Back-ups › Geavanceerd,
 * computer only). This file only knows channels; desktop/update-flow.ts uses them.
 * No imports at all, so a build script can load it too.
 */

export type Channel = { provider: 'generic'; url: string } | { provider: 'github'; owner: string; repo: string };

/** A GitHub account (letters, digits, hyphens) and a repository name. */
const GH_OWNER = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
const GH_REPO = /^(?!\.{1,2}$)[A-Za-z0-9._-]{1,100}$/;
/** Names that are clearly a placeholder in a config file, never a real repository. */
const GH_PLACEHOLDER = /^(owner|repo|example|placeholder|changeme|todo|your[-_]?\w*|my[-_]?(org|name|repo)|<.*>)$/i;

export function feedError(url: string): string {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return 'Ongeldig adres voor het updatekanaal';
  }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return 'Het updatekanaal moet https gebruiken';
  if (u.username || u.password) return 'Geen inloggegevens in het adres van het updatekanaal';
  return '';
}

/** What is wrong with a channel ('' = nothing). */
export function channelError(c: Channel): string {
  if (c.provider === 'generic') return feedError(c.url);
  if (!GH_OWNER.test(c.owner) || !GH_REPO.test(c.repo) || c.repo.endsWith('.git')) return 'Geef de GitHub-repository als eigenaar/naam, bijvoorbeeld teambot-app/teambot';
  return '';
}

/**
 * What the owner typed (or TEAMBOT_UPDATE_URL holds) → a channel:
 *   https://downloads.voorbeeld.nl/teambot/        a folder on a web server
 *   github:eigenaar/naam · eigenaar/naam · https://github.com/eigenaar/naam[/releases]   GitHub Releases
 * Empty input is "no channel of my own" (the built-in one applies).
 */
export function parseChannel(input: string): { channel: Channel | null; error?: string } {
  const s = String(input ?? '').trim();
  if (!s) return { channel: null };
  const gh = /^(?:github|gh):\/*([^/\s]+)\/([^/\s]+?)\/?$/i.exec(s) || /^([^/:\s]+)\/([^/:\s]+?)\/?$/.exec(s);
  // "downloads.voorbeeld.nl/teambot": an address without https:// in front, not a repository.
  if (gh && !/^(github|gh):/i.test(s) && gh[1].includes('.')) return { channel: null, error: 'Begin het adres van het updatekanaal met https://' };
  if (gh) {
    const c: Channel = { provider: 'github', owner: gh[1], repo: gh[2] };
    const error = channelError(c);
    return error ? { channel: null, error } : { channel: c };
  }
  if (/^(github|gh):/i.test(s)) return { channel: null, error: channelError({ provider: 'github', owner: '', repo: '' }) };
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return { channel: null, error: 'Ongeldig adres voor het updatekanaal' };
  }
  if (/^(www\.)?github\.com$/i.test(u.hostname)) {
    if (u.protocol !== 'https:') return { channel: null, error: 'Het updatekanaal moet https gebruiken' };
    const [owner, repo] = u.pathname.split('/').filter(Boolean);
    const c: Channel = { provider: 'github', owner: owner || '', repo: (repo || '').replace(/\.git$/, '') };
    const error = channelError(c);
    return error ? { channel: null, error } : { channel: c };
  }
  const c: Channel = { provider: 'generic', url: s.endsWith('/') ? s : `${s}/` };
  const error = channelError(c);
  return error ? { channel: null, error } : { channel: c };
}

/** The channel as the owner reads it: "github.com/eigenaar/naam" or the folder's address. */
export function channelText(c: Channel | null): string {
  if (!c) return '';
  return c.provider === 'github' ? `github.com/${c.owner}/${c.repo}` : c.url;
}

/** The channel in the form parseChannel reads back (stored in Settings, TEAMBOT_UPDATE_CHANNEL). */
export function channelInput(c: Channel | null): string {
  if (!c) return '';
  return c.provider === 'github' ? `github:${c.owner}/${c.repo}` : c.url;
}

/** One `key: value` line of a small YAML file (app-update.yml), quotes removed. */
const ymlField = (yml: string, k: string) => new RegExp(`^${k}:\\s*['"]?([^'"\\r\\n]+?)['"]?\\s*$`, 'm').exec(yml)?.[1]?.trim() || '';

/** A host that never serves updates: the placeholder on `.invalid`, example domains, this computer. */
const placeholderHost = (host: string) => /\.(invalid|example|test|localhost)$/i.test(host) || /^(example\.(com|org|net)|localhost|127\.0\.0\.1|\[::1\])$/i.test(host);

/**
 * The channel built into a release: electron-builder writes package.json build.publish into resources/app-update.yml.
 * Until the owner picks a place that is a placeholder (a `.invalid` address), and the app has no channel and says
 * nothing alarming. Once it is a real https folder or a real GitHub repository, every TeamBot built from then on uses
 * it without anyone typing it (Settings or TEAMBOT_UPDATE_URL still win).
 */
export function builtInChannel(appUpdateYml: string | null | undefined): Channel | null {
  if (!appUpdateYml) return null;
  const provider = ymlField(appUpdateYml, 'provider');
  if (provider === 'generic') {
    const url = ymlField(appUpdateYml, 'url');
    if (!url || feedError(url) || new URL(url).protocol !== 'https:' || placeholderHost(new URL(url).hostname)) return null;
    return { provider: 'generic', url };
  }
  if (provider === 'github') {
    const owner = ymlField(appUpdateYml, 'owner');
    const repo = ymlField(appUpdateYml, 'repo');
    const host = ymlField(appUpdateYml, 'host');
    // GitHub Enterprise or a private repository needs more than this flow does (a token in the app): not used.
    if (host && !/^(www\.)?github\.com$/i.test(host)) return null;
    if (/^true$/i.test(ymlField(appUpdateYml, 'private'))) return null;
    const c: Channel = { provider: 'github', owner, repo };
    if (channelError(c) || GH_PLACEHOLDER.test(owner) || GH_PLACEHOLDER.test(repo) || /^example/i.test(owner)) return null;
    return c;
  }
  return null;
}

/**
 * The options for electron-updater's setFeedURL. `githubHost` is only for tests (a local server that plays GitHub);
 * the app always talks to github.com over https.
 */
export function feedOptions(c: Channel, o: { githubHost?: string } = {}): Record<string, unknown> {
  if (c.provider === 'generic') return { provider: 'generic', url: c.url };
  return { provider: 'github', owner: c.owner, repo: c.repo, ...(o.githubHost ? { host: o.githubHost, protocol: 'http' } : {}) };
}

/**
 * Where the installer of `version` (file name `name`) lives on a channel: next to latest.yml in the folder, or as an
 * asset of the GitHub release `v<version>`. Used to keep the installer of the running version for the way back.
 */
export function installerUrl(c: Channel, version: string, name: string, o: { githubHost?: string } = {}): URL {
  if (c.provider === 'generic') return new URL(encodeURIComponent(name), c.url.endsWith('/') ? c.url : `${c.url}/`);
  const base = o.githubHost ? `http://${o.githubHost}` : 'https://github.com';
  return new URL(`/${encodeURIComponent(c.owner)}/${encodeURIComponent(c.repo)}/releases/download/v${encodeURIComponent(version)}/${encodeURIComponent(name)}`, base);
}

/** package.json build.publish for a channel (what electron-builder writes into app-update.yml). */
export function publishEntry(c: Channel): Record<string, unknown> {
  return c.provider === 'generic' ? { provider: 'generic', url: c.url } : { provider: 'github', owner: c.owner, repo: c.repo, releaseType: 'release' };
}
