import { IS_MAC } from "@/lib/platform";
import { type ShortcutScope } from "@/lib/tauri/settings";

/** Human-readable scope names for the add/edit form and row tooltips. On a Mac
 * the local shells are zsh and bash, which speak the same language as an SSH
 * host and so share its scope, and the `local` scope is left with PowerShell
 * alone (a custom terminal there). */
export const SCOPE_LABELS: Record<ShortcutScope, string> = IS_MAC
  ? {
      ssh: "SSH / local shells (Unix)",
      local: "PowerShell",
      both: "Both (Unix and PowerShell)",
      serial: "Serial console",
    }
  : {
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
  "Startup",
  "Performance",
  "Network probe",
  "Destructive command guard",
  "Shortcut commands",
  "Appearance",
  "Custom terminals",
  "Sessions",
  "Grid",
  "Skills",
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
  Startup:
    "start startup launch open on opens on first tab home default page landing which tab when broadside starts begin boot initial terminals instead of hosts template startup greyed disabled",
  Performance: "sessions limit concurrent max how many cpu cores memory ram probe suggested capacity timeout slow confirm ask first guard threshold bulk are you sure reconnect all disconnect all close failed close all too many stop asking me",
  "Network probe": "ping latency reachable test hosts responds round trip ms speed check offline",
  "Destructive command guard": "rm dangerous confirm warning block rules pattern regex mkfs dd shutdown reboot guard rails safety typed confirmation",
  "Shortcut commands": "commands dropdown one click quick canned saved snippets scope linux windows both broadcast terminals go button",
  Appearance:
    "theme dark light mode colour color font family size text bigger smaller zoom ctrl wheel scroll terminal font application font columns host table hide shells launcher local shells strict my font is missing inter segoe ui arial proportional variable width not in the list monospace fixed width only install a font scrollback scroll back buffer history lines kept how far can i scroll up output cut off truncated lost only 1000 lines memory per pane",
  "Custom terminals":
    "git bash msys msys2 cygwin add my own program exe application launcher path arguments browse posix bash-like command language family terminal application third party colour color tab colours tint highlight powershell command prompt wsl serial which tab am i in tell tabs apart profile colour",
  Sessions:
    "session timeout idle close automatically after minutes seconds inactivity abandoned forgotten tab left open overnight keep alive keepalive nat firewall state table drop connection dies silently hangs after a while frozen unresponsive terminal packet every minute why did my terminal close by itself disable turn off never close right click right-click mouse paste twice double paste pasted twice tmux vim claude code menu shift copy controls row toolbar hide show the toolbar banner top bar tucked away slides down hover tab auto hide autohide where did the buttons go",
  Grid: "tiles layout columns rows tile size width height strict drag resize short last row stretch tall gaps split screen side by side template preview arrangement",
  Skills:
    "skill log logging record run history remote shell history bash_history up arrow recall summary itemized debug run panel step log exit codes json text output style where to log keep commands out of history audit what did the skill do",
  "Backup & Restore": "backup restore export import copy save file folder migrate move to another pc database",
  Help: "hints status bar tooltips bottom bar explanations hover guidance",
  "Audit log": "logs history record trail who what when broadcasts host keys sessions opened turn off",
  Security:
    "sudo password auto fill autofill admin lock passcode unlock protect credentials secrets argon2 privileged shell history bash_history history -d delete entry up arrow recalls a long line setup line broadside typed it not me keep my history clean histcontrol ignorespace leave my host alone do not run anything extra stop deleting dismissed warnings restore warnings do not warn me again stop asking turn warnings back on template startup export dont ask me again second instance already running another copy multiple instances open twice",
  Reset: "defaults factory restore preferences start over clear settings start page",
  "Danger Zone": "delete all hosts wipe destroy remove everything purge credentials",
};

// The words a Mac user reaches for that the lists above, written for Windows,
// do not have. Added rather than swapped in, so a search that works on Windows
// works the same here.
if (IS_MAC) {
  const more: Record<string, string> = {
    "Shortcut commands": "mac unix zsh",
    Appearance: "cmd command key wheel menlo sf mono monaco",
    "Custom terminals": "zsh fish homebrew brew opt bin nushell pwsh mac",
    Sessions: "option alt right-click copy paste",
    "Backup & Restore": "another mac keychain",
    Security: "keychain",
    "Danger Zone": "keychain",
  };
  for (const [title, words] of Object.entries(more)) {
    SECTION_KEYWORDS[title] = `${SECTION_KEYWORDS[title]} ${words}`;
  }
}

// The search filter and the section scrolled to. Settings stays mounted once it
// has been opened, so a trip to another tab keeps both without any storage;
// sessionStorage is for the reload a restore does, and it clears when the app
// window closes, so neither survives a restart. Matches the existing rail/sort
// persistence pattern.
export const SEARCH_STORAGE_KEY = "settings-search";
export const SECTION_SCROLL_KEY = "settings-scroll-section";
/** Sticky-header height to discount when finding the section nearest the top
 * (matches the sections' scroll-margin-top: 4rem in index.css). */
export const STICKY_OFFSET_PX = 64;
