import { type ShortcutScope } from "@/lib/tauri/settings";

/** Human-readable scope names for the add/edit form and row tooltips. */
export const SCOPE_LABELS: Record<ShortcutScope, string> = {
  ssh: "SSH / WSL (Linux)",
  local: "Command Prompt / PowerShell",
  both: "Both (Linux and Windows)",
  serial: "Serial console (COM port)",
};

/** Stable DOM id for a settings section, used by the jump-to dropdown. */
export function sectionDomId(title: string): string {
  return "settings-sec-" + title.toLowerCase().replace(/[^a-z0-9]+/g, "-");
}

/** Section render order, also the jump-to dropdown list. */
export const SECTION_TITLES = [
  "Performance",
  "Network probe",
  "Destructive command guard",
  "Shortcut commands",
  "Appearance",
  "Custom terminals",
  "Grid",
  "Backup & Restore",
  "Help",
  "Audit log",
  "Security",
  "Reset",
  "Danger Zone",
];

/**
 * What each section is about, for the search box.
 *
 * The filter used to match section titles alone, which works only for someone
 * who already knows what the setting is called. Typing `git` found nothing at
 * all, even though adding Git Bash is exactly what **Custom terminals** is for,
 * and the reader is then looking at an empty page telling them no section
 * matches. Unlike Help, this page has no index of its own body text, so these
 * words are the whole index: they name the thing the reader came looking for
 * (`zoom`, `password`, `dark`), not only the wording the section happens to use.
 *
 * Keep them lowercase; the filter lowercases the query.
 */
export const SECTION_KEYWORDS: Record<string, string> = {
  Performance: "sessions limit concurrent max how many cpu cores memory ram probe suggested capacity timeout slow",
  "Network probe": "ping latency reachable test hosts responds round trip ms speed check offline",
  "Destructive command guard": "rm dangerous confirm warning block rules pattern regex mkfs dd shutdown reboot guard rails safety typed confirmation",
  "Shortcut commands": "commands dropdown one click quick canned saved snippets scope linux windows both broadcast terminals go button",
  Appearance:
    "theme dark light mode colour color font family size text bigger smaller zoom ctrl wheel scroll terminal font application font columns host table hide shells launcher local shells strict",
  "Custom terminals":
    "git bash msys msys2 cygwin add my own program exe application launcher path arguments browse posix bash-like command language family terminal application third party",
  Grid: "tiles layout columns rows tile size width height strict drag resize short last row stretch tall gaps split screen side by side",
  "Backup & Restore": "backup restore export import copy save file folder migrate move to another pc database",
  Help: "hints status bar tooltips bottom bar explanations hover guidance",
  "Audit log": "logs history record trail who what when broadcasts host keys sessions opened turn off",
  Security:
    "sudo password auto fill autofill admin lock passcode unlock protect credentials secrets argon2 privileged",
  Reset: "defaults factory restore preferences start over clear settings",
  "Danger Zone": "delete all hosts wipe destroy remove everything purge credentials",
};

// The search filter and scroll position persist across tab switches (Settings
// unmounts on navigation) but NOT across restarts, sessionStorage clears when
// the app window closes. Matches the existing rail/sort persistence pattern.
export const SEARCH_STORAGE_KEY = "settings-search";
export const SECTION_SCROLL_KEY = "settings-scroll-section";
/** Sticky-header height to discount when finding the section nearest the top
 * (matches the sections' scroll-margin-top: 4rem in index.css). */
export const STICKY_OFFSET_PX = 64;
