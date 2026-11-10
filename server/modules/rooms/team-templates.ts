import { builtinTeamPackages } from '../templates/registry.js';
import type { TeamPackage } from './packages.js';

/**
 * Built-in team templates (A-14). The definitions live in server/modules/templates (one data file per template, with
 * business-profile questions, suggested skills and routines); this list is the same templates as plain team packages
 * for "Nieuwe groep › Uit een sjabloon". Same format as an exported team package, so the preview, install and
 * "routines off / safe access" rules are the same.
 */
export const TEAM_TEMPLATES: (TeamPackage & { id: string })[] = builtinTeamPackages();

export function teamTemplate(id: string) {
  return TEAM_TEMPLATES.find((t) => t.id === id) || null;
}
