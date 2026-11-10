import type { Ctx } from '../../core/types.js';
import type { MarketSkill } from '../skills/catalog.js';
import type { TemplateSkill } from '../skills/templates.js';
import type { TemplateDef } from './types.js';

/**
 * Suggested catalogue skills, by stable item id. The catalogue may not have an item (a catalogue that changed, the
 * skills module switched off, an item blocked by the admin): then the suggestion is shown as "niet beschikbaar" and
 * skipped, never an error. Only verified items with their files inline qualify; anything that needs a download or
 * comes from an unverified source goes through the Marktplaats with its own review.
 */

export interface SkillSuggestionView {
  bot: string;
  id: string;
  why: string;
  available: boolean;
  title: string;
}

/** Find an item by id (`catalogId/itemId` or a bare item id; the built-in catalogue first). */
export function findCatalogSkill(items: MarketSkill[], ref: string): MarketSkill | null {
  const ok = items.filter((i) => i.verified && i.files && typeof i.files === 'object');
  const slash = ref.indexOf('/');
  if (slash > 0) {
    const cat = ref.slice(0, slash);
    const id = ref.slice(slash + 1);
    return ok.find((i) => i.catalogId === cat && i.id === id) || null;
  }
  return ok.find((i) => i.catalogId === 'builtin' && i.id === ref) || ok.find((i) => i.id === ref) || null;
}

function catalogItems(ctx: Ctx, userId: string): MarketSkill[] {
  try {
    const list = ctx.services.skills?.catalogs?.skills?.(userId);
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

/** Which suggestions the catalogue has, and the skills to install per bot name. */
export function resolveSkills(ctx: Ctx, userId: string, def: TemplateDef): { suggestions: SkillSuggestionView[]; byBot: Record<string, TemplateSkill[]> } {
  const items = catalogItems(ctx, userId);
  const suggestions: SkillSuggestionView[] = [];
  const byBot: Record<string, TemplateSkill[]> = {};
  for (const b of def.bots) {
    for (const s of b.skills || []) {
      const it = findCatalogSkill(items, s.id);
      suggestions.push({ bot: b.name, id: s.id, why: s.why, available: !!it, title: it?.title || s.id });
      if (!it) continue;
      (byBot[b.name] ||= []).push({
        name: it.name,
        title: it.title,
        version: it.version,
        checksum: it.sha256 || '',
        license: it.license || undefined,
        files: it.files!,
        catalog: { catalogId: it.catalogId, itemId: it.id, verified: it.verified },
      });
    }
  }
  return { suggestions, byBot };
}
