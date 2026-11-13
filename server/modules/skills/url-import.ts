import path from 'node:path';
import { HttpError, bad } from '../../core/http.js';
import { type FileMap, LIMITS, filesFromZip, isBinary, stripTopFolder } from './files.js';
import { slugify } from './format.js';
import { type Fetcher, resolveGithub } from './fetch.js';
import type { Importer, Staging } from './importer.js';
import { TEMPLATE_FORMAT } from './templates.js';

/**
 * Stage a skill from an address for the regular review: a GitHub repository or folder (the whole skill folder comes
 * along: SKILL.md with its scripts and other files), a link to a SKILL.md, or a zip. Nothing is installed or run here.
 * Used by the import screen and by the bots' own `skill_install`.
 */
export async function stageUrl(importer: Importer, fetcher: Fetcher, userId: string, url: string): Promise<Staging> {
  if (!/^https?:\/\//i.test(url)) throw bad('Geef een http(s)-adres.');
  const gh = resolveGithub(url);
  const fetchIt = async (u: string) => {
    try {
      return await fetcher(u, { maxBytes: LIMITS.maxZipBytes });
    } catch (e: any) {
      throw new HttpError(422, e?.message || String(e));
    }
  };
  const unzip = (body: Buffer): FileMap => {
    try {
      return stripTopFolder(filesFromZip(body));
    } catch (e: any) {
      throw new HttpError(422, e.message);
    }
  };
  if (gh?.kind === 'zip') {
    const r = await fetchIt(gh.url);
    return importer.stageFiles(userId, unzip(r.body), { type: 'github', label: gh.label, url }, { subdir: gh.subdir || undefined, fallbackName: gh.subdir ? path.posix.basename(gh.subdir) : gh.label.split('/')[1] });
  }
  const r = await fetchIt(gh?.url || url);
  if (r.body.subarray(0, 2).toString('latin1') === 'PK') return importer.stageFiles(userId, unzip(r.body), { type: 'url', label: new URL(url).hostname, url });
  if (isBinary(r.body)) throw new HttpError(422, 'Dit adres geeft geen SKILL.md of zip-bestand terug.');
  const text = r.body.toString('utf8');
  if (/^\s*\{/.test(text)) {
    try {
      const j = JSON.parse(text);
      if (j?.format === 'teambot.catalog/v1') throw new HttpError(422, 'Dit is een catalogus. Voeg hem toe via Marktplaats › Bronnen.');
      if (j?.format === TEMPLATE_FORMAT) throw new HttpError(422, 'Dit is een bot-sjabloon. Installeer het via Marktplaats › Bots › Sjabloon importeren.');
    } catch (e) {
      if (e instanceof HttpError) throw e;
    }
  }
  if (/^\s*<(!doctype|html)\b/i.test(text)) throw new HttpError(422, 'Dit adres geeft een webpagina terug, geen skill. Gebruik het adres van de map op GitHub of van het bestand SKILL.md.');
  const base = slugify(decodeURIComponent(new URL(url).pathname.split('/').filter(Boolean).slice(-2, -1)[0] || ''));
  return importer.stage(userId, new URL(url).hostname, [{ files: new Map([['SKILL.md', r.body]]), root: '', source: { type: 'url', label: new URL(url).hostname, url }, fallbackName: base }]);
}
