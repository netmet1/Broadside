/**
 * The ids of the help sections other tabs link straight to.
 *
 * Its own tiny module rather than a re-export from `./content`, because that
 * file is the whole handbook and lives in the lazily-loaded Help chunk. A page
 * that only needs to say "open Help at the Hosts section" should not drag two
 * and a half thousand lines of prose into the startup bundle to do it.
 *
 * `content.tsx` uses these constants as its own section ids, so a rename here
 * is a rename there and a link cannot quietly stop landing anywhere.
 */

export const HELP_HOSTS = "help-sec-hosts";
export const HELP_SKILLS = "help-sec-skills";
export const HELP_TEMPLATES = "help-sec-templates";

export type HelpSectionId =
  | typeof HELP_HOSTS
  | typeof HELP_SKILLS
  | typeof HELP_TEMPLATES;
