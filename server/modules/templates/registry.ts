import type { TeamPackage } from '../rooms/packages.js';
import { buildPackage } from './build.js';
import type { TemplateDef } from './types.js';
import webshop from './defs/webshop.js';
import seoEnContent from './defs/seo-en-content.js';
import advertentiesEnShopping from './defs/advertenties-en-shopping.js';
import klantcontact from './defs/klantcontact.js';
import operations from './defs/operations.js';
import softwareBouwen from './defs/software-bouwen.js';
import onderzoekEnSchrijven from './defs/onderzoek-en-schrijven.js';
import klantenservice from './defs/klantenservice.js';
import software from './defs/software.js';
import prive from './defs/prive.js';
import priveHuishouden from './defs/prive-huishouden.js';
import priveGeld from './defs/prive-geld.js';
import priveGezondheid from './defs/prive-gezondheid.js';
import reizen from './defs/reizen.js';
import lerenEnStudie from './defs/leren-en-studie.js';
import leegTeam from './defs/leeg-team.js';

/**
 * The built-in team templates, in the order the picker shows them: the teams per type of business, then the private
 * teams, then the general teams (the empty team last). One file per template in ./defs. To add one: write the file,
 * add it here, run the tests (tests/templates.test.ts validates every template and installs each one).
 */
export const TEMPLATE_DEFS: readonly TemplateDef[] = [
  webshop,
  seoEnContent,
  advertentiesEnShopping,
  klantcontact,
  operations,
  softwareBouwen,
  prive,
  priveHuishouden,
  priveGeld,
  priveGezondheid,
  reizen,
  lerenEnStudie,
  onderzoekEnSchrijven,
  klantenservice,
  software,
  leegTeam,
];

export function templateDef(id: string): TemplateDef | null {
  return TEMPLATE_DEFS.find((d) => d.id === id) || null;
}

/**
 * Registration hook for the existing template mechanism (server/modules/rooms/team-templates.ts): every template as
 * a plain team package, without a business profile or skills (those need the owner's answers and the catalogue; the
 * templates module adds them in its own preview and install).
 */
export function builtinTeamPackages(): (TeamPackage & { id: string })[] {
  return TEMPLATE_DEFS.map((d) => buildPackage(d));
}
