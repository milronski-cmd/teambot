import type { FaceColor, FaceExtra, FaceEyes, FaceMouth, FaceShape } from '../../../shared/botface.js';

/**
 * A team template as data (one file per template in ./defs). The registry turns it into a normal team package
 * (`teambot.team/v1`, server/modules/rooms/packages.ts), so preview and install follow the same rules as an imported
 * team: bots start on "vraagt toestemming", routines come in switched off, and nothing personal travels along.
 *
 * Never in a template: conversations, memory, keys or other secrets, an AI choice (provider or model), work folders.
 */

/** Where an answer lands in the team's business profile. `extra` answers are kept with their label. */
export type ProfileField = 'name' | 'business' | 'tone' | 'rules' | 'extra';

export interface ProfileQuestion {
  /** Stable key, also usable as `{key}` placeholder in routine prompts. */
  key: string;
  profile: ProfileField;
  /** The question, as the owner sees it. */
  label: string;
  /** Short help under the field. */
  hint?: string;
  /** Example answer shown in an empty field. */
  placeholder?: string;
  /** One line (text) or a few lines (textarea). */
  kind: 'text' | 'textarea';
  /** Short label for the profile overview ("Webadres"); defaults per profile field. */
  short?: string;
}

/** An example of a typical task and when it counts as done ("klaar als"). */
export interface DoneWhen {
  task: string;
  done: string;
}

/** A catalogue skill suggestion: the stable catalogue item id and, in one line, why this bot uses it. */
export interface SkillSuggestion {
  id: string;
  why: string;
}

/** A suggested routine; always installed switched off (paused) until the owner turns it on. */
export interface RoutineSuggestion {
  name: string;
  /** What the bot does on each run. `{key}` is filled from the business profile answers. */
  prompt: string;
  schedule: { kind: 'weekly'; days: string[]; times: string[] } | { kind: 'monthly'; days: (number | string)[]; times: string[]; months?: number[] };
  options?: { missedPolicy?: 'skip' | 'catchup'; maxRunsPerDay?: number; maxCostPerDayUsd?: number; timeoutMinutes?: number; notify?: 'always' | 'errors' | 'never' };
}

export interface BotDef {
  /** The team lead: one per team, has the last word, divides the work and checks it before "klaar". */
  lead?: boolean;
  /** One word (used for @naam), unique across all templates. */
  name: string;
  /** Role in a few words, e.g. "Teamleider webshop". */
  role: string;
  /** One sentence for cards and the preview. */
  description: string;
  face: { shape: FaceShape; color: FaceColor; eyes: FaceEyes; mouth: FaceMouth; extra: FaceExtra; cheeks: boolean };
  /** Tool groups (files, web, memory, skills, team, shell). */
  tools: string[];
  /**
   * Talks with customers: `direct` = answers customers itself (says it is AI, hands off when unsure),
   * `drafts` = writes answers the owner sends.
   */
  customer?: 'direct' | 'drafts';
  /** First line of the instructions: who you are and what you are for. */
  intro: string;
  /** What you do. */
  does: string[];
  /** What you may do. */
  may: string[];
  /** What you may not do. */
  mayNot: string[];
  /** When to stop and ask (the lead asks the owner, a helper tells the team lead). */
  askWhen: string[];
  /** Example "klaar als" lines for typical tasks. */
  doneWhen: DoneWhen[];
  skills?: SkillSuggestion[];
  routines?: RoutineSuggestion[];
  /**
   * Optional: this bot is a specialist in a field (package S, "specialists that learn"). Stored on the new bot as
   * `settings.specialist` and handed to `ctx.services.specialists.fromTemplate` when that exists. A learning round is
   * never switched on by a template; the owner does that.
   */
  specialist?: SpecialistSuggestion;
}

/** A field of expertise and a few public, reliable sources to learn it from (https links). */
export interface SpecialistSuggestion {
  field: string;
  suggestedSources: string[];
}

export interface TemplateDef {
  id: string;
  /** Semver of this template's content. */
  version: string;
  /** `new` in 0.4, or `refreshed` (one of the three templates of 0.3). */
  status: 'new' | 'refreshed';
  /** `bedrijf` = a team for a type of business; `prive` = for the owner's private life; `algemeen` = anything else. */
  category: 'bedrijf' | 'prive' | 'algemeen';
  /** The simplest start: only a team lead (no helpers). Every other template has a team lead and 2–4 bots. */
  minimal?: boolean;
  name: string;
  /** One or two sentences for the picker. */
  description: string;
  /** Optional tip for the owner in the picker and preview (not given to the bots). */
  note?: string;
  /** The team's goal, one sentence (first line of the team instructions). */
  goal: string;
  /** Team rules, on top of the fixed way of working. */
  rules: string[];
  /** 3–5 questions that fill the business profile. */
  questions: ProfileQuestion[];
  /** Typical first tasks with their "klaar als", for the picker and the first-run screen. */
  examples: DoneWhen[];
  bots: BotDef[];
}

/** The business profile of a team, filled from the questions. */
export interface TeamProfile {
  name: string;
  business: string;
  tone: string;
  rules: string;
  extra: { key: string; label: string; value: string }[];
}
